import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { getLiveApp, type AppContextType } from "../app-context";
import type { AIMessage } from "../types";
import { buildAISnapshot } from "./data-model";
import { buildSystemPrompt } from "./system-prompt";
import { formatPlanSummary } from "../nutrition-plan";
import { AI_TOOLS, executeToolCall, type ToolResult } from "./tools";
import {
  DEFAULT_MAX_TOKENS,
  TOKENHUB_BASE_URL,
  TOKENHUB_DEFAULT_MODEL,
  normalizeBaseUrl,
} from "@/constants/ai-provider";
import {
  diagnoseNetworkError,
  fetchWithRetry,
  resolveBaseUrl,
  withProxyHeadersFor,
  describeReasoningError,
} from "./chat-network";

/**
 * AI 生成引擎：整个「识别图片 → 工具循环 → 落库回复」流程放在模块级，
 * 不依赖任何页面组件。好处：
 * - 用户离开 AI 页 / 切到别的 App，生成不会因组件卸载而中断（AppProvider 一直在）。
 * - 生成状态放在模块级 store，回到页面能立刻看到「正在生成」和已执行的工具。
 * - 结束/失败时若 App 在后台，发一条本地通知告知用户。
 */

export interface ToolActionEntry {
  name: string;
  args: Record<string, any>;
  result: ToolResult;
}

export interface GenerationJob {
  running: boolean;
  /** 本次请求对应的用户消息 id，回来后可高亮 / 定位 */
  userMessageId: string | null;
  /** 第几轮工具调用（0 = 等待首响） */
  turn: number;
  toolActions: ToolActionEntry[];
  /** 本轮开始时间 */
  startedAt: string | null;
  /** 上一轮结束后的提示（成功/失败摘要），回到页面时可展示 */
  lastResult: { ok: boolean; text: string; at: string } | null;
}

const EMPTY_JOB: GenerationJob = {
  running: false,
  userMessageId: null,
  turn: 0,
  toolActions: [],
  startedAt: null,
  lastResult: null,
};

let job: GenerationJob = { ...EMPTY_JOB };
const listeners = new Set<() => void>();
// 当前生成请求：取消时中止正在进行的网络请求，并在工具循环里检查标志。
let activeAbortController: AbortController | null = null;
let cancelRequested = false;
// 每次生成分配 token，避免「取消后立刻重发」时旧请求回来覆盖新任务状态。
let generationToken = 0;

function emit() {
  listeners.forEach((l) => l());
}

function updateJob(patch: Partial<GenerationJob>) {
  job = { ...job, ...patch };
  emit();
}

export function subscribeJob(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getJobSnapshot(): GenerationJob {
  return job;
}

export function clearJobResult() {
  if (!job.running) updateJob({ lastResult: null });
}

/** 取消本轮生成：中止网络请求，并立即把 UI 状态恢复为可再次输入。 */
export function cancelGeneration() {
  if (!job.running) return;
  cancelRequested = true;
  generationToken++; // 让仍在跑的旧任务失效，避免它结束时覆盖「已取消」状态
  activeAbortController?.abort();
  updateJob({
    running: false,
    lastResult: {
      ok: false,
      text: "已取消本次生成（已执行的工具操作不会撤销）",
      at: new Date().toISOString(),
    },
  });
}

function assertNotCancelled() {
  if (cancelRequested) throw new Error("GENERATION_CANCELLED");
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 生成参数：配置用「已保存的 aiConfig」，保证后台运行时也能拿到 Key/模型 */
export interface GenerateParams {
  text: string;
  /** 图片 data URI（识别用），已经落盘的路径由调用方写进消息 */
  imageUris: string[];
  userMessageId: string;
  /** 最近若干条未归档消息（含刚落库的用户消息），用于拼对话上下文 */
  messagesSnapshot: AIMessage[];
  app: AppContextType;
}

function effectiveConfig(app: AppContextType) {
  const c = app.state.aiConfig;
  return {
    baseUrl: normalizeBaseUrl(c.baseUrl || TOKENHUB_BASE_URL),
    apiKey: c.apiKey || "",
    model: c.model || TOKENHUB_DEFAULT_MODEL,
    visionModel: c.visionModel || "",
    maxTokens: Math.min(32768, Math.max(512, Number(c.maxTokens) || DEFAULT_MAX_TOKENS)),
    toolsEnabled: c.toolsEnabled ?? true,
  };
}

function buildPrompt(app: AppContextType, hasImages: boolean): string {
  const base = buildSystemPrompt(buildAISnapshot(app.state));
  const activePlan = app.state.userProfile.customNutritionPlan;
  // 与页面提示词保持一致；这里只能读已保存的状态（后台运行没有表单值）。
  return (
    base +
    "\n\n[工具] 你可以直接调用工具来操作用户的 App（记录体测、添加/删除动作、创建/查看/修改训练计划、开始/结束训练、增删改查饮食记录、添加食物、创建碳循环计划、保存自定义营养方案、更新个人资料、设置当前计划、删除数据）。动手前先用一句中文说明要做什么。" +
    "\n\n[饮食记录] 用户说一餐吃了多样食物时，必须调用 log_meal 把每样食物逐项放进 items，不要合并、不要只记第一样；每项都写全 name、quantity、unit、calories、carbs、protein、fats 和 mealType。只记一样食物时用 log_nutrition。" +
    "\n\n[饮食套餐] 用户说「建个套餐/固定午餐搭配/把这套存成套餐」时调用 create_meal_combo（name + items，每项写全份量与宏量，可用 mealType 指定早中晚餐）；套餐是模板，不要先记到今天。" +
    "\n\n[删除/修改饮食记录] 用户要删记录时调用 delete_nutrition，要改克数/营养值时调用 update_nutrition（只改克数又想按比例联动就带 scaleMacros: true）。绝对不要通过再记一遍正确数据来覆盖旧记录。" +
    "\n\n[查询饮食记录] 用户问「吃了什么/某天的记录」时用 query_nutrition；要删改的记录不在今天时，先用它查到 id 再动手。" +
    "\n\n[训练方案] 查看已有方案用 query_workout_templates；改已有方案先查它拿到 ID 和下标，再调 update_workout_template。只有「新建」才用 create_workout_template。" +
    "\n\n[营养方案] 给出具体饮食数值建议时，调用 save_custom_nutrition_plan 保存四个数值并设为当前目标。" +
    (activePlan?.enabled
      ? `\n\n[当前自定义营养目标] ${formatPlanSummary(activePlan)}（已生效，给饮食建议时以此为准）`
      : "") +
    (hasImages
      ? "\n\n[图片] 本轮消息里附了图片的识别结果。把它当作事实上下文回答；若含可记录的数据（食物热量、体测数值、训练组次），请调用对应工具保存，并在回复里说明存了什么。"
      : "")
  );
}

async function callChat(
  app: AppContextType,
  cfg: ReturnType<typeof effectiveConfig>,
  messages: any[],
  withTools = true,
  modelOverride?: string,
  tokenOverride?: number
): Promise<any> {
  const target = `${resolveBaseUrl(cfg.baseUrl)}/chat/completions`;
  const baseTokens = tokenOverride ?? cfg.maxTokens;
  let lastError: Error | null = null;
  let reasoningFailure = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    const tokens = reasoningFailure
      ? Math.min(32768, Math.max(baseTokens, 8192 * attempt))
      : attempt === 0
        ? baseTokens
        : Math.min(32768, Math.max(baseTokens, 4096));
    const useTools = withTools && cfg.toolsEnabled && !reasoningFailure;
    const body: Record<string, unknown> = {
      model: modelOverride || cfg.model,
      messages,
      max_tokens: tokens,
    };
    if (useTools) {
      body.tools = AI_TOOLS;
      body.tool_choice = "auto";
    }
    const response = await fetchWithRetry(
      target,
      withProxyHeadersFor(cfg.baseUrl, {
        method: "POST",
        signal: activeAbortController?.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      })
    );
    if (!response.ok) {
      const resBody = await response.text().catch(() => "");
      let message = resBody;
      try {
        message = JSON.parse(resBody)?.error?.message || resBody;
      } catch {
        // 纯文本错误
      }
      const err = new Error(`HTTP ${response.status}：${message || response.statusText}`);
      const retryable =
        !!describeReasoningError(message) ||
        response.status === 502 || response.status === 503 || response.status === 504;
      if (retryable && attempt < 2) {
        reasoningFailure = reasoningFailure || !!describeReasoningError(message);
        lastError = err;
        await pause(700 * (attempt + 1));
        continue;
      }
      throw err;
    }
    const data = await response.json();
    const msg = data?.choices?.[0]?.message;
    const hasTools = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
    if (!String(msg?.content ?? "").trim() && !hasTools && attempt < 2) {
      reasoningFailure = true;
      lastError = new Error("模型返回了空正文（推理耗尽）");
      await pause(700 * (attempt + 1));
      continue;
    }
    return data;
  }
  throw lastError ?? new Error("请求失败：模型连续多次没有返回正文");
}

async function recognizeImages(
  cfg: ReturnType<typeof effectiveConfig>,
  dataUris: string[],
  question: string
): Promise<string> {
  const vision = cfg.visionModel.trim();
  const baseTokens = Math.max(cfg.maxTokens, 8192 + (dataUris.length - 1) * 2048);
  const systemBase =
    "你是图片识别助手。用中文客观描述图片内容，只写看得清的内容，不要编造数字。" +
    (dataUris.length > 1
      ? `本条消息共有 ${dataUris.length} 张图片，请用「图片1：」「图片2：」…分段逐张列出。`
      : "") +
    "若是食物/餐盘：逐项列出食物、估算份量(g)、热量(kcal)与蛋白/碳水/脂肪(g)。" +
    "若是体脂秤或体测报告：逐项抄录体重、体脂率、BMI、肌肉量等数值与单位。" +
    "若是训练计划表：列出动作、组数、次数、重量。最后给一行『可记录数据：…』摘要。";

  for (let attempt = 0; attempt < 3; attempt++) {
    const imageParts = dataUris.map((uri) => ({ type: "image_url", image_url: { url: uri } }));
    const messages = [
      {
        role: "system",
        content:
          systemBase +
          (attempt > 0
            ? "\n补充：图片数据已随本条消息一起发送，必须直接基于图片内容作答；禁止回答『看不到图片/无法读取图片』。"
            : ""),
      },
      {
        role: "user",
        content: [
          { type: "text", text: question || "请逐张识别这些图片，并把其中可记录的数据逐项列出来。" },
          ...imageParts,
        ],
      },
    ];
    const target = `${resolveBaseUrl(cfg.baseUrl)}/chat/completions`;
    const response = await fetchWithRetry(
      target,
      withProxyHeadersFor(cfg.baseUrl, {
        method: "POST",
        signal: activeAbortController?.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: vision || cfg.model,
          messages,
          max_tokens: baseTokens,
        }),
      })
    );
    const data = await response.json().catch(() => null);
    const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (text && !/看不到|无法(查看|看到|读取|识别)|no image|cannot see/i.test(text)) {
      return text;
    }
    await pause(600);
  }
  throw new Error("视觉模型没有返回识别结果");
}

async function notifyIfBackground(title: string, body: string) {
  if (Platform.OS === "web") return;
  try {
    // 只有 App 不在前台时才发通知，避免前台重复打扰
    const { AppState } = await import("react-native");
    if (AppState.currentState === "active") return;
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") {
      const req = await Notifications.requestPermissionsAsync();
      if (req.status !== "granted") return;
    }
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: null,
    });
  } catch {
    // 通知失败不影响生成主流程
  }
}

/**
 * 启动一轮生成。立即返回 Promise，但调用方通常不需要 await。
 * 全流程都在模块级运行，页面卸载不影响。
 */
export async function runGeneration(params: GenerateParams): Promise<void> {
  const { text, imageUris, userMessageId, messagesSnapshot } = params;
  // 优先用 live app（每次渲染都会更新），避免生成期间工具调用拿到过期 state。
  // 页面卸载后 liveApp 仍由 AppProvider 维护，所以后台生成也能写到最新数据。
  const live = () => getLiveApp() ?? params.app;
  const cfg = effectiveConfig(live());
  const token = ++generationToken;
  cancelRequested = false;
  activeAbortController = new AbortController();

  updateJob({
    running: true,
    userMessageId,
    turn: 0,
    toolActions: [],
    startedAt: new Date().toISOString(),
    lastResult: null,
  });

  let executedCount = 0;
  try {
    let contextText = text;
    if (imageUris.length) {
      let analysis: string;
      try {
        analysis = await recognizeImages(cfg, imageUris, text);
      } catch (err) {
        if (cancelRequested || token !== generationToken) return;
        const raw = err instanceof Error ? err.message : String(err);
        const detail = await diagnoseNetworkError(raw, cfg.baseUrl);
        finish(false, `图片识别未完成：${detail}`);
        return;
      }
      live().updateAIMessage(userMessageId, { imageAnalysis: analysis });
      contextText = [
        text || "请分析这些图片",
        "",
        "[图片识别结果]",
        analysis,
        "",
        "请基于以上识别结果回答。若包含可记录的数据，请调用对应工具保存，并在回复里说明存了什么。",
      ].join("\n");
    }

    const systemPrompt = buildPrompt(live(), imageUris.length > 0);
    const conversation: any[] = [
      { role: "system", content: systemPrompt },
      ...messagesSnapshot
        .filter((m) => m.id !== userMessageId)
        .map((m) => ({
          role: m.role,
          content: m.content || (m.imageAnalysis ? `[此前图片识别结果] ${m.imageAnalysis}` : ""),
        })),
      { role: "user", content: contextText },
    ];

    let finalText = "";
    for (let turn = 0; turn < 6; turn++) {
      assertNotCancelled();
      updateJob({ turn: turn + 1 });
      let data: any;
      try {
        data = await callChat(live(), cfg, conversation);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (turn === 0 && /tool|function|not support|unsupported|参数/i.test(msg)) {
          data = await callChat(live(), cfg, conversation, false, undefined, Math.max(cfg.maxTokens, 8192));
        } else {
          throw err;
        }
      }
      const msg = data?.choices?.[0]?.message;
      if (!msg) break;

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        conversation.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
        for (const tc of msg.tool_calls) {
          assertNotCancelled();
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            args = {};
          }
          const result = await executeToolCall(tc.function.name, args, live());
          executedCount++;
          updateJob({
            toolActions: [...job.toolActions, { name: tc.function.name, args, result }],
          });
          conversation.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      finalText = String(msg.content ?? "").trim();
      if (!finalText) {
        finalText =
          "模型这次没返回正文（多半把输出预算全花在推理上）。到「高级设置 → 最大输出 token」调大到 8192，或换非推理型模型后重试。";
      }
      break;
    }

    const reply =
      finalText ||
      (executedCount > 0
        ? "（已为你执行上述操作）"
        : "连续几轮都没拿到模型正文。到「高级设置」把最大输出调到 8192，必要时关掉工具调用再试。");
    live().addAIMessage({ role: "assistant", content: reply });
    finish(true, reply.slice(0, 120));
  } catch (error) {
    // 用户点「取消生成」后：用户消息保留，但不写一条误导性的失败回复。
    if (cancelRequested || token !== generationToken) return;
    const detail = await diagnoseNetworkError(error instanceof Error ? error.message : "未知错误", cfg.baseUrl);
    // 关键：失败不再删除用户消息。消息保留，回复里说明失败原因，用户可直接「重新生成」。
    const failText = executedCount > 0
      ? `失败：${detail}\n\n本轮 AI 已执行 ${executedCount} 次写操作，为避免重复记录，请用「重新生成」前先确认。`
      : `失败：${detail}`;
    live().addAIMessage({ role: "assistant", content: failText });
    finish(false, detail);
  }

  function finish(ok: boolean, text: string) {
    if (token !== generationToken) return;
    activeAbortController = null;
    updateJob({ running: false, lastResult: { ok, text, at: new Date().toISOString() } });
    notifyIfBackground(ok ? "AI 回复已完成" : "AI 回复失败", text);
  }
}
