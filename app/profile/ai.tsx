import { useState, useRef, useEffect, useMemo } from "react";
import {
  Text,
  View,
  TouchableOpacity,
  TextInput,
  FlatList,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Image,
  Modal,
  Pressable,
  ScrollView,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useApp } from "@/lib/app-context";
import type { AIMessage, AIConfig } from "@/lib/types";
import Markdown from "react-native-markdown-display";
import { buildAISnapshot } from "@/lib/ai/data-model";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { AI_TOOLS, executeToolCall, type ToolResult } from "@/lib/ai/tools";
import {
  buildCustomNutritionPlan,
  parseNutritionPlanFromText,
  formatPlanSummary,
} from "@/lib/nutrition-plan";
import {
  TOKENHUB_BASE_URL,
  TOKENHUB_CONSOLE_URL,
  TOKENHUB_DEFAULT_MODEL,
  TOKENHUB_WEB_PROXY_URL,
  TOKENHUB_VISION_MODEL_EXAMPLE,
  normalizeBaseUrl,
} from "@/constants/ai-provider";

type AIProvider = AIConfig["provider"];

const PROVIDERS: { value: AIProvider; label: string; defaultUrl: string; defaultModel: string }[] = [
  { value: "tokenhub", label: "智云 TokenHub", defaultUrl: TOKENHUB_BASE_URL, defaultModel: TOKENHUB_DEFAULT_MODEL },
  { value: "openai", label: "OpenAI", defaultUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { value: "dashscope", label: "阿里百炼", defaultUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-turbo" },
  { value: "kimi", label: "Kimi (月之暗面)", defaultUrl: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-8k" },
  { value: "custom", label: "自定义", defaultUrl: "", defaultModel: "" },
];

// 浏览器有同源策略，网关又不给 CORS 头 → Web 走本机代理，真机直连
function resolveBaseUrl(url: string): string {
  const base = normalizeBaseUrl(url);
  if (Platform.OS !== "web" || base !== TOKENHUB_BASE_URL) return base;
  // 用页面所在主机拼代理地址：手机用局域网 IP 打开预览时也能连回电脑的代理。
  // 本机预览时 hostname 是 localhost，行为与写死 127.0.0.1 一致。
  const hostname =
    typeof window !== "undefined" && window.location?.hostname ? window.location.hostname : "127.0.0.1";
  return TOKENHUB_WEB_PROXY_URL.replace("127.0.0.1", hostname);
}

// 代理的健康检查地址（/__health 在代理根路径，不在 /v1 下）
const PROXY_HEALTH_URL = TOKENHUB_WEB_PROXY_URL.replace(/\/v1\/?$/, "") + "/__health";

function describeFailure(status: number, body: string): string {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403)
    return "Key 无效或没权限。到控制台「个人中心 → 账户管理 → 密钥管理」重新复制，别带空格/换行。";
  if (status === 429)
    return "额度用尽或触发限流。到「财务管理 → 费用中心」看余额。";
  if (status === 404 || lower.includes("model"))
    return "模型名不对（教程里的 qwen3.7-max 只是图例）。点「查模型名」拿真实 ID 填进高级设置。";
  return `HTTP ${status}：${body.slice(0, 160)}`;
}

// 只判断代理端口在不在监听；no-cors 可避开 CORS 头干扰（局域网 IP 打开时也能测）。
async function pingProxy(): Promise<boolean> {
  if (Platform.OS !== "web") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(PROXY_HEALTH_URL, { mode: "no-cors", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// 网络抖动（Failed to fetch / 超时）自动重试一次；HTTP 401/429/404 不重试，不浪费额度。
async function fetchWithRetry(url: string, init: RequestInit, retries = 1): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// 分诊：以前任何网络失败都甩「浏览器跨域/代理没启动」，真机断网也这么报，纯属误导。
async function diagnoseNetworkError(msg: string): Promise<string> {
  const networkish = /failed to fetch|network request failed|load failed|networkerror|timeout|aborted|network/i.test(msg);
  if (Platform.OS !== "web") {
    return networkish
      ? "手机连不上网关：检查联网后重试；真机直连官方域名，不需要启动本机代理。持续失败就点「测试连接」看状态码。"
      : `连接错误：${msg}`;
  }
  const alive = await pingProxy();
  if (!alive) {
    return "本机代理没启动（或已退出 / 8082 被占用）。关掉预览，重新运行 npm run dev:web 一次启动代理+预览；只用 npx expo start --web 不会有代理。";
  }
  return networkish
    ? "本机代理在线，但这次请求仍失败：多为网关偶发超时或断网（已自动重试一次）。可点「测试连接」看具体状态码；若用局域网 IP 打开预览，改用 http://localhost:8081。"
    : `连接错误：${msg}`;
}

// 待发送的图片：uri 是 data URI（base64），只放内存，不写进持久化消息。
type PendingImage = { uri: string; name?: string; mimeType: string };
// 单张图片上限，超过就提示换小图，避免请求体过大被网关/代理拒掉。
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// RN Web 的 Text 默认不可选，显式打开 user-select 才能长按/拖选。
const WEB_SELECTABLE = Platform.OS === "web" ? ({ userSelect: "text", cursor: "text" } as any) : undefined;

// Markdown 的每个文字节点都开 selectable：原生长按会弹出系统「复制 / 全选」菜单。
const SELECTABLE_MARKDOWN_RULES: any = {
  text: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => (
    <Text
      key={node.key}
      selectable
      style={[inheritedStyles, styles.text, WEB_SELECTABLE]}
    >
      {node.content}
    </Text>
  ),
  textgroup: (node: any, children: any, _parent: any, styles: any) => (
    <Text key={node.key} selectable style={[styles.textgroup, WEB_SELECTABLE]}>
      {children}
    </Text>
  ),
};

// 把选图结果统一转成 data URI。真机由 expo-image-picker 直接给 base64；
// Web 若拿不到 base64，则用 FileReader 从 blob URI 读一份。
async function toDataUri(asset: {
  uri: string;
  base64?: string | null;
  mimeType?: string;
  fileName?: string | null;
}): Promise<{ uri: string; mimeType: string; name?: string }> {
  const mimeType = asset.mimeType || "image/jpeg";
  const name = asset.fileName ?? undefined;
  if (asset.base64) {
    return { uri: `data:${mimeType};base64,${asset.base64}`, mimeType, name };
  }
  const res = await fetch(asset.uri);
  const blob = await res.blob();
  const Reader = (globalThis as any).FileReader;
  if (!Reader) throw new Error("当前环境不支持读取图片");
  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new Reader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
  return { uri: dataUri, mimeType: blob.type || mimeType, name };
}

// react-native-web 的 Alert.alert 是空函数，Web 上点了完全没反应。
// 所有反馈改成页面内可见的结果条；真机仍额外弹原生 Alert。
type Notice = { kind: "success" | "error" | "info"; title: string; text: string };
function noticeKind(title: string): Notice["kind"] {
  if (title.includes("成功")) return "success";
  if (title.includes("失败") || title.includes("错误")) return "error";
  return "info";
}

export default function AIScreen() {
  const colors = useColors();
  const router = useRouter();
  const app = useApp();
  const { state, updateAIConfig, addAIMessage, updateAIMessage, clearAIMessages, updateUserProfile } = app;
  const flatListRef = useRef<FlatList>(null);
  // 图片本体只存内存：持久化消息里只放识别文字，避免大 base64 撑爆 AsyncStorage。
  const imagePreviews = useRef<Record<string, string>>({});
  // 最新消息镜像：构建模型上下文时不再依赖渲染闭包里的旧 state。
  const messagesRef = useRef<AIMessage[]>(state.aiMessages);

  // 配置状态
  const [showConfig, setShowConfig] = useState(!state.aiConfig.isConfigured);
  const [provider, setProvider] = useState<AIProvider>(state.aiConfig.provider || "tokenhub");
  const [baseUrl, setBaseUrl] = useState(state.aiConfig.baseUrl || TOKENHUB_BASE_URL);
  const [model, setModel] = useState(state.aiConfig.model || TOKENHUB_DEFAULT_MODEL);
  const [visionModel, setVisionModel] = useState(state.aiConfig.visionModel || "");
  // 已保存的 Key 永不回显到输入框；留空表示沿用旧 Key
  const [apiKey, setApiKey] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [modelList, setModelList] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  const notify = (title: string, text: string) => {
    setNotice({ kind: noticeKind(title), title, text });
    if (Platform.OS !== "web") Alert.alert(title, text);
  };

  // 对话状态
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  // 长按气泡进入「选择文字」浮层：里面是纯文本，保证任何平台都能长按拖选片段。
  const [selectionTarget, setSelectionTarget] = useState<AIMessage | null>(null);
  // AI 本次对话实际执行的写操作（透明展示，不进持久聊天记录，保持模型上下文干净）
  const [toolActions, setToolActions] = useState<{ name: string; args: any; result: ToolResult }[]>([]);

  // 软键盘：KAV 上方固定内容的高度、键盘是否弹起、键盘占掉的高度
  const [topOffset, setTopOffset] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // Web 预览时本机代理是否在线：一眼能看出「请求失败」是不是代理没起导致的
  const [proxyAlive, setProxyAlive] = useState<boolean | null>(null);

  useEffect(() => {
    messagesRef.current = state.aiMessages;
  }, [state.aiMessages]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    let mounted = true;
    const check = () => {
      pingProxy().then((ok) => {
        if (mounted) setProxyAlive(ok);
      });
    };
    check();
    const timer = setInterval(check, 15000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // Web 没有 RN 的 Keyboard 事件，用 visualViewport 判断浏览器虚拟键盘/缩放挤占的高度
    if (Platform.OS === "web") {
      const vv = (globalThis as any).visualViewport;
      if (!vv) return;
      const onResize = () => {
        const overlap = Math.max(0, (globalThis as any).innerHeight - vv.height - vv.offsetTop);
        setKeyboardHeight(overlap > 80 ? overlap : 0);
        setKeyboardVisible(overlap > 80);
      };
      vv.addEventListener?.("resize", onResize);
      return () => vv.removeEventListener?.("resize", onResize);
    }
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      setKeyboardHeight(e.endCoordinates.height);
      setKeyboardVisible(true);
      // 键盘弹出后把最后一条消息滚到可视区，避免被键盘盖住
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 120);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
      setKeyboardVisible(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // 选图：只做本地读取，不发请求；发送时才识别
  const handlePickImage = async () => {
    try {
      if (Platform.OS !== "web") {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          notify("错误 · 无相册权限", "请在系统设置里允许 FitLife 访问相册。");
          return;
        }
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        allowsEditing: false,
        quality: 0.4,
        base64: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const picked = await toDataUri(result.assets[0]);
      const base64Part = picked.uri.split(",")[1] || "";
      if (base64Part.length * 0.75 > MAX_IMAGE_BYTES) {
        notify("错误 · 图片过大", "这张图太大，换一张小图或截图再试（建议压缩后小于 4MB）。");
        return;
      }
      setPendingImage({ uri: picked.uri, mimeType: picked.mimeType, name: picked.name });
      notify("提示 · 已选择图片", "可以补一句想问什么，直接点发送就开始识别。");
    } catch (error) {
      notify("错误 · 选图失败", error instanceof Error ? error.message : "未知错误");
    }
  };

  // 复制：AI 回复气泡下的「复制」按钮
  const handleCopy = async (text: string) => {
    try {
      await Clipboard.setStringAsync(text);
      notify("成功 · 已复制", `已复制 ${text.length} 个字符到剪贴板`);
    } catch {
      notify("错误 · 复制失败", "当前环境不允许写入剪贴板，可长按文本复制。");
    }
  };

  // 把任意一条 AI 回复里的营养参数存进「饮食 → 营养建议 → 自定义」。
  // 模型不支持工具调用、或只是纯文字给建议时，这个按钮保证建议仍能被收进自定义。
  const handleSaveNutritionFromText = async (text: string) => {
    const parsed = parseNutritionPlanFromText(text);
    if (!parsed) {
      notify(
        "提示 · 没识别到营养参数",
        "这条回复里没找到完整的「热量 + 至少两项宏量」。可以让 AI 用列表写清四个数字，或到「饮食 → 营养建议 → 自定义」手动填写。"
      );
      return;
    }
    const missing = (["protein", "carbs", "fats"] as const).filter((k) => parsed[k] === undefined);
    try {
      const plan = buildCustomNutritionPlan(
        {
          calories: parsed.calories ?? 0,
          protein: parsed.protein ?? 0,
          carbs: parsed.carbs ?? 0,
          fats: parsed.fats ?? 0,
        },
        "ai",
        "从 AI 对话回复中提取"
      );
      await updateUserProfile({ customNutritionPlan: plan });
      const suffix = missing.length
        ? `\n其中 ${missing.map((k) => ({ protein: "蛋白", carbs: "碳水", fats: "脂肪" })[k]).join("、")} 未识别，已填 0，请到自定义页补齐。`
        : "";
      notify("成功 · 已存入自定义", `${formatPlanSummary(plan)}\n已设为当前每日目标，可在「饮食 → 营养建议 → 自定义」查看/修改。${suffix}`);
    } catch (e) {
      notify("错误 · 保存失败", e instanceof Error ? e.message : "未知错误");
    }
  };

  // 粘贴：输入框旁的显式按钮；长按输入框的系统粘贴仍然可用
  const handlePaste = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (!text) {
        notify("提示", "剪贴板里没有文本");
        return;
      }
      setInputText((prev) => {
        const joined = prev ? `${prev}${prev.endsWith("\n") ? "" : "\n"}${text}` : text;
        return joined.slice(0, 1000);
      });
    } catch {
      notify("错误 · 粘贴失败", "当前环境不允许读取剪贴板，可用输入框长按粘贴。");
    }
  };

  // 当provider变化时更新默认值
  useEffect(() => {
    const providerConfig = PROVIDERS.find(p => p.value === provider);
    if (providerConfig && provider !== "custom") {
      setBaseUrl(providerConfig.defaultUrl);
      setModel(providerConfig.defaultModel);
    }
  }, [provider]);

  const generateSystemPrompt = () => buildSystemPrompt(buildAISnapshot(state));

  // 测试API连接：结果写进页面内结果条，Web 上也能看见（Alert 在 Web 是空函数）
  const handleTestConnection = async () => {
    const effectiveKey = apiKey.trim() || state.aiConfig.apiKey || "";
    if (!effectiveKey) {
      setShowConfig(true);
      notify("提示", "还没配置 API Key：在配置面板粘贴 Key 后再测（Web 预览刷新后要重新粘贴）。");
      return;
    }

    const usedModel = model || state.aiConfig.model || TOKENHUB_DEFAULT_MODEL;
    const target = `${resolveBaseUrl(baseUrl)}/chat/completions`;
    const started = Date.now();
    setIsTesting(true);
    setNotice(null);
    try {
      const response = await fetchWithRetry(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${effectiveKey}`,
        },
        body: JSON.stringify({
          model: usedModel,
          messages: [{ role: "user", content: "只回复两个字：收到" }],
          max_tokens: 10,
        }),
      });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      // 网关 401/429 返回 text/plain，json() 会失败，先按纯文本读
      const body = await response.text().catch(() => "");

      if (response.ok) {
        let reply = "";
        let servedModel = "";
        try {
          const parsed = JSON.parse(body);
          reply = String(parsed.choices?.[0]?.message?.content ?? "").trim();
          servedModel = String(parsed.model ?? "");
        } catch {
          // 非 JSON 响应也算连通
        }
        notify(
          "成功 · 测试连接通过",
          [
            `HTTP ${response.status} · 耗时 ${elapsed}s`,
            `请求地址：${target}`,
            `模型：${servedModel || usedModel}`,
            reply ? `模型回复：${reply.slice(0, 60)}` : "已收到模型响应",
          ].join("\n")
        );
      } else {
        let message: string = body;
        try {
          message = JSON.parse(body)?.error?.message || body;
        } catch {
          // 纯文本错误
        }
        notify(
          "失败 · 测试连接未通过",
          `HTTP ${response.status} · 耗时 ${elapsed}s · 模型 ${usedModel}\n${describeFailure(response.status, message || response.statusText)}`
        );
      }
    } catch (error) {
      notify("错误 · 测试连接未通过", await diagnoseNetworkError(error instanceof Error ? error.message : "未知错误"));
    } finally {
      setIsTesting(false);
    }
  };

  // 拉一次 /v1/models，拿模型广场里的真实 ID（教程图例名不一定可用）
  const handleListModels = async () => {
    const effectiveKey = apiKey.trim() || state.aiConfig.apiKey || "";
    if (!effectiveKey) {
      notify("提示", "请先粘贴 API Key");
      return;
    }
    try {
      const response = await fetchWithRetry(`${resolveBaseUrl(baseUrl)}/models`, {
        headers: { "Authorization": `Bearer ${effectiveKey}` },
      });
      const body = await response.text().catch(() => "");
      if (!response.ok) {
        notify("失败", describeFailure(response.status, body));
        return;
      }
      const ids: string[] = (JSON.parse(body)?.data ?? []).map((m: { id?: string }) => m.id || "").filter(Boolean);
      if (!ids.length) {
        notify("提示", "接口没返回模型列表，去模型广场手动复制模型名。");
        return;
      }
      setModelList(ids.slice(0, 20));
    } catch (error) {
      notify("错误", await diagnoseNetworkError(error instanceof Error ? error.message : "未知错误"));
    }
  };

  // 保存配置：其余参数已内置，用户只填 Key
  const handleSaveConfig = async () => {
    const effectiveKey = apiKey.trim() || state.aiConfig.apiKey || "";
    if (!effectiveKey) {
      notify("提示", "请先粘贴 API Key");
      return;
    }

    try {
      await updateAIConfig({
        provider,
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey: effectiveKey,
        model: model || TOKENHUB_DEFAULT_MODEL,
        visionModel: visionModel.trim() || undefined,
        isConfigured: true,
      });
      setApiKey(""); // 立刻清掉输入框，不留在屏幕上
      setShowConfig(false);
      notify("成功", "配置已保存");
    } catch {
      notify("错误", "保存失败");
    }
  };

  // 调用聊天补全（带工具）；返回解析后的响应 JSON。withTools=false 时退化为纯对话。
  const callChat = async (messages: any[], withTools = true, modelOverride?: string): Promise<any> => {
    const target = `${resolveBaseUrl(state.aiConfig.baseUrl || TOKENHUB_BASE_URL)}/chat/completions`;
    const body: Record<string, unknown> = {
      model: modelOverride || state.aiConfig.model || TOKENHUB_DEFAULT_MODEL,
      messages,
      max_tokens: 2000,
    };
    if (withTools) {
      body.tools = AI_TOOLS;
      body.tool_choice = "auto";
    }
    const response = await fetchWithRetry(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.aiConfig.apiKey || ""}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const resBody = await response.text().catch(() => "");
      let message: string = resBody;
      try {
        message = JSON.parse(resBody)?.error?.message || resBody;
      } catch {
        // 纯文本错误
      }
      throw new Error(`HTTP ${response.status}：${message || response.statusText}`);
    }
    return response.json();
  };

  // 图片识别：单独一次纯视觉请求（不带工具），拿到的文字作为上下文喂给主对话，
  // 同时写回该条用户消息的 imageAnalysis 字段，作为可持久化的「识别数据记录」。
  const recognizeImage = async (dataUri: string, question: string): Promise<string> => {
    const vision = (state.aiConfig.visionModel || "").trim();
    const messages = [
      {
        role: "system",
        content:
          "你是图片识别助手。用中文客观描述图片内容，只写看得清的内容，不要编造数字。" +
          "若是食物/餐盘：逐项列出食物、估算份量(g)、热量(kcal)与蛋白/碳水/脂肪(g)。" +
          "若是体脂秤或体测报告：逐项抄录体重、体脂率、BMI、肌肉量等数值与单位。" +
          "若是训练计划表：列出动作、组数、次数、重量。最后给一行『可记录数据：…』摘要。",
      },
      {
        role: "user",
        content: [
          { type: "text", text: question || "请识别这张图片，并把其中可记录的数据逐项列出来。" },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ];
    const data = await callChat(messages, false, vision || undefined);
    const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new Error("视觉模型没有返回识别结果");
    return text;
  };

  // 发送消息（支持图片识别 + 工具循环：模型可多次调用工具直到达成目标）
  const handleSendMessage = async () => {
    const text = inputText.trim();
    const image = pendingImage;
    if (!text && !image) return;
    if (!state.aiConfig.isConfigured) {
      notify("提示", "请先配置 API Key");
      setShowConfig(true);
      return;
    }

    // 先把用户消息落库再发请求：即使后续识别/回话失败，这条也不会消失。
    const userContent = text || "请识别这张图片并给出要点";
    const userMsg = addAIMessage({
      role: "user",
      content: userContent,
      ...(image ? { image: { name: image.name, mimeType: image.mimeType } } : {}),
    });
    if (image) imagePreviews.current[userMsg.id] = image.uri;
    messagesRef.current = [...messagesRef.current, userMsg];

    setInputText("");
    setPendingImage(null);
    setIsLoading(true);
    setToolActions([]);

    const activeCustomPlan = state.userProfile.customNutritionPlan;
    const systemPrompt =
      generateSystemPrompt() +
      "\n\n[工具] 你可以直接调用工具来操作用户的 App（记录体测、添加动作、创建训练计划、开始/结束训练、记录饮食、添加食物、创建碳循环计划、保存自定义营养方案、更新个人资料、设置当前计划、删除数据）。动手前先用一句中文说明要做什么；参数不确定的字段可省略。" +
      "\n\n[营养方案] 当用户询问饮食/营养参数建议（每日热量、蛋白、碳水、脂肪），或你主动给出一套具体数值方案时，务必调用 save_custom_nutrition_plan 把四个数值保存到「饮食 → 营养建议 → 自定义」并设为当前每日目标，回复里说明已保存；用户要求取消时可调用 clear_custom_nutrition_plan。回复里请用列表把四个数字写清楚，方便用户核对。" +
      (activeCustomPlan?.enabled
        ? `\n\n[当前自定义营养目标] ${formatPlanSummary(activeCustomPlan)}（已生效，给饮食建议时以此为准）`
        : "") +
      (image
        ? "\n\n[图片] 本轮消息里已附上「图片识别结果」。把它当作事实上下文来回答；其中若有食物热量、体测数值或训练组次，请调用对应工具保存，并在回复里说明存了什么。"
        : "");

    try {
      let contextText = userContent;

      if (image) {
        let analysis: string;
        try {
          analysis = await recognizeImage(image.uri, text);
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          const hint = /image|vision|multimodal|modal|content|不支持|模态|400|404/i.test(raw)
            ? `当前模型可能不支持图片。到「高级设置 → 视觉模型」填一个支持视觉的 ID（点「查模型名」从 /v1/models 找带 vl / vision 的，例如 ${TOKENHUB_VISION_MODEL_EXAMPLE}）再重发。`
            : await diagnoseNetworkError(raw);
          notify("失败 · 图片识别未完成", `${raw}\n${hint}`);
          addAIMessage({ role: "assistant", content: `图片识别失败：${hint}` });
          return; // 用户图片消息已保存，不会消失；finally 会收尾
        }
        // 识别结果写回这条消息 → 随聊天记录持久化/导出，就是「对应数据记录」
        updateAIMessage(userMsg.id, { imageAnalysis: analysis });
        messagesRef.current = messagesRef.current.map((m) =>
          m.id === userMsg.id ? { ...m, imageAnalysis: analysis } : m
        );
        contextText = [
          text || "请分析这张图片",
          "",
          "[图片识别结果（已保存到对话记录）]",
          analysis,
          "",
          "请基于以上识别结果回答。若其中包含可记录的数据（食物热量、体测数值、训练组次等），请调用对应工具保存，并在回复里说明存了什么。",
        ].join("\n");
      }

      const conversation: any[] = [
        { role: "system", content: systemPrompt },
        // 用最新消息镜像，避免闭包里的旧 state 丢掉刚发的消息
        ...messagesRef.current
          .slice(-12)
          .filter((m) => m.id !== userMsg.id)
          .map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: contextText },
      ];

      let finalText = "";
      let executedCount = 0;
      for (let turn = 0; turn < 6; turn++) {
        let data: any;
        try {
          data = await callChat(conversation);
        } catch (err) {
          // 首轮若因模型不支持工具而失败，自动退化为纯对话
          const msg = err instanceof Error ? err.message : String(err);
          if (turn === 0 && /tool|function|not support|unsupported|参数/i.test(msg)) {
            data = await callChat(conversation, false);
          } else {
            throw err;
          }
        }
        const msg = data?.choices?.[0]?.message;
        if (!msg) break;

        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          conversation.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
          for (const tc of msg.tool_calls) {
            let args: Record<string, any> = {};
            try {
              args = JSON.parse(tc.function.arguments || "{}");
            } catch {
              args = {};
            }
            const result = await executeToolCall(tc.function.name, args, app);
            executedCount++;
            setToolActions((prev) => [...prev, { name: tc.function.name, args, result }]);
            conversation.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(result),
            });
          }
          continue; // 带着工具结果再问一次模型
        }

        finalText = msg.content || "";
        conversation.push({ role: "assistant", content: finalText });
        break;
      }

      if (finalText) {
        addAIMessage({ role: "assistant", content: finalText });
      } else if (executedCount > 0) {
        addAIMessage({ role: "assistant", content: "（已为你执行上述操作）" });
      } else {
        addAIMessage({ role: "assistant", content: "抱歉，我暂时无法回应，请稍后再试。" });
      }
    } catch (error) {
      addAIMessage({
        role: "assistant",
        content: `请求失败：${await diagnoseNetworkError(error instanceof Error ? error.message : "未知错误")}`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // 清除对话：Web 没有原生确认弹窗，直接执行并给可见反馈；真机保留确认
  const handleClearMessages = () => {
    if (Platform.OS === "web") {
      clearAIMessages();
      notify("成功 · 已清除", "对话记录已清空");
      return;
    }
    Alert.alert("清除对话", "确定要清除所有对话记录吗？", [
      { text: "取消", style: "cancel" },
      { text: "清除", style: "destructive", onPress: clearAIMessages },
    ]);
  };

  // 滚动到底部
  useEffect(() => {
    if (state.aiMessages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [state.aiMessages.length]);

  const markdownStyles = useMemo(() => ({
    body: { color: colors.foreground, fontSize: 15, lineHeight: 22 },
    paragraph: { marginTop: 0, marginBottom: 8 },
    code_inline: {
      backgroundColor: colors.surface,
      color: colors.foreground,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 6,
      fontFamily: "Menlo",
      fontSize: 14,
    },
    code_block: {
      backgroundColor: colors.surface,
      padding: 10,
      borderRadius: 8,
      fontFamily: "Menlo",
      fontSize: 13,
    },
    fence: {
      backgroundColor: colors.surface,
      padding: 10,
      borderRadius: 8,
      fontFamily: "Menlo",
      fontSize: 13,
    },
    bullet_list: { marginBottom: 8 },
    ordered_list: { marginBottom: 8 },
    blockquote: {
      borderLeftColor: colors.border,
      borderLeftWidth: 4,
      paddingLeft: 10,
      color: colors.muted,
    },
    link: { color: colors.primary },
  }), [colors]);

  const renderMessage = ({ item }: { item: AIMessage }) => {
    const previewUri = imagePreviews.current[item.id];
    const isUser = item.role === "user";
    return (
      <View className={`mb-3 ${isUser ? "items-end" : "items-start"}`}>
        <Pressable onLongPress={() => setSelectionTarget(item)} delayLongPress={400}>
          <View
            style={WEB_SELECTABLE}
            className={`max-w-[85%] rounded-2xl px-4 py-3 ${
              isUser ? "bg-primary" : "bg-surface border border-border"
            }`}
          >
            {item.image &&
              (previewUri ? (
                <Image
                  source={{ uri: previewUri }}
                  style={{ width: 200, height: 150, borderRadius: 10, marginBottom: 8 }}
                  resizeMode="cover"
                />
              ) : (
                <View className="flex-row items-center mb-2">
                  <IconSymbol name="photo" size={16} color={isUser ? colors.background : colors.muted} />
                  <Text className={`text-xs ml-2 ${isUser ? "text-background" : "text-muted"}`} numberOfLines={1}>
                    {item.image.name || "图片（识别结果已保存）"}
                  </Text>
                </View>
              ))}
            {isUser ? (
              <Text selectable style={WEB_SELECTABLE} className="text-background">
                {item.content}
              </Text>
            ) : (
              <Markdown style={markdownStyles} rules={SELECTABLE_MARKDOWN_RULES}>
                {item.content}
              </Markdown>
            )}
            {item.imageAnalysis ? (
              <View className={`mt-2 pt-2 border-t ${isUser ? "border-background/30" : "border-border"}`}>
                <Text className={`text-xs font-semibold mb-1 ${isUser ? "text-background" : "text-muted"}`}>
                  📷 识别结果（已保存）
                </Text>
                <Text
                  selectable
                  style={WEB_SELECTABLE}
                  className={`text-xs leading-5 ${isUser ? "text-background" : "text-foreground"}`}
                  numberOfLines={6}
                >
                  {item.imageAnalysis}
                </Text>
              </View>
            ) : null}
          </View>
        </Pressable>
        <View className="flex-row items-center mt-1 px-2">
          <Text className="text-muted text-xs">
            {new Date(item.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
          </Text>
          <TouchableOpacity onPress={() => handleCopy(item.content)} className="ml-3 flex-row items-center" activeOpacity={0.7}>
            <IconSymbol name="square.on.square" size={13} color={colors.muted} />
            <Text className="text-muted text-xs ml-1">复制</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setSelectionTarget(item)} className="ml-3 flex-row items-center" activeOpacity={0.7}>
            <Text className="text-muted text-xs">选择文字</Text>
          </TouchableOpacity>
          {item.role === "assistant" && (
            <TouchableOpacity
              onPress={() => handleSaveNutritionFromText(item.content)}
              className="ml-3 flex-row items-center"
              activeOpacity={0.7}
            >
              <IconSymbol name="pencil" size={13} color={colors.muted} />
              <Text className="text-muted text-xs ml-1">存入自定义</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <ScreenContainer edges={["top", "left", "right", "bottom"]} className="flex-1">
      {/* KAV 上方的固定内容：量出高度给 iOS 的 keyboardVerticalOffset 用 */}
      <View onLayout={(e) => setTopOffset(e.nativeEvent.layout.height)}>
      {/* 头部 */}
      <View className="flex-row items-center justify-between px-5 py-4 border-b border-border">
        <TouchableOpacity onPress={() => router.back()} className="p-1">
          <IconSymbol name="chevron.left" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-foreground">AI 助手</Text>
        <View className="flex-row gap-2">
          <TouchableOpacity onPress={() => setShowConfig(!showConfig)} className="p-1">
            <IconSymbol name="gearshape.fill" size={22} color={showConfig ? colors.primary : colors.muted} />
          </TouchableOpacity>
          {state.aiMessages.length > 0 && (
            <TouchableOpacity onPress={handleClearMessages} className="p-1">
              <IconSymbol name="trash" size={22} color={colors.muted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* 常驻状态栏：不用展开配置面板也能点「测试连接」 */}
      <View className="flex-row items-center justify-between px-5 py-2 border-b border-border bg-surface">
        <View className="flex-row items-center flex-1 mr-3">
          <View
            className="w-2 h-2 rounded-full mr-2"
            style={{
              backgroundColor:
                Platform.OS === "web" && proxyAlive === false
                  ? "#ef4444"
                  : state.aiConfig.isConfigured
                  ? "#22c55e"
                  : "#f59e0b",
            }}
          />
          <Text className="text-muted text-xs" numberOfLines={1}>
            {state.aiConfig.isConfigured
              ? `已配置 · ${Platform.OS === "web"
                  ? proxyAlive === false ? "代理未启动" : proxyAlive ? "代理在线" : "代理检测中"
                  : "直连"} · ${state.aiConfig.model || TOKENHUB_DEFAULT_MODEL}`
              : "未配置 API Key"}
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleTestConnection}
          disabled={isTesting}
          className="px-3 py-1.5 rounded-lg bg-primary"
          activeOpacity={0.7}
        >
          <Text className="text-background text-xs font-medium">
            {isTesting ? "测试中…" : "测试连接"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* 代理没起时先给一条可执行的修复提示，别等请求失败才猜 */}
      {Platform.OS === "web" && proxyAlive === false && (
        <View
          className="mx-5 mt-2 rounded-lg px-3 py-2"
          style={{ backgroundColor: "rgba(239,68,68,0.10)", borderColor: "rgba(239,68,68,0.4)", borderWidth: 1 }}
        >
          <Text className="text-foreground text-xs leading-5">
            本机代理未启动：关掉预览，运行 npm run dev:web 一次启动「代理 8082 + 预览 8081」；只跑 npx expo start --web 不会有代理。
          </Text>
        </View>
      )}

      {/* 结果条：所有操作反馈都在这里可见，Web 的 Alert.alert 是空函数。
          键盘弹起时也必须保留，否则「已复制 / 已粘贴」这类反馈会看不见。 */}
      {notice && (
        <View
          className="mx-5 mt-3 rounded-xl px-4 py-3"
          style={{
            backgroundColor:
              notice.kind === "success"
                ? "rgba(34,197,94,0.12)"
                : notice.kind === "error"
                ? "rgba(239,68,68,0.12)"
                : colors.surface,
            borderColor:
              notice.kind === "success"
                ? "rgba(34,197,94,0.45)"
                : notice.kind === "error"
                ? "rgba(239,68,68,0.45)"
                : colors.border,
            borderWidth: 1,
          }}
        >
          <View className="flex-row items-start justify-between">
            <Text className="text-foreground font-semibold text-sm flex-1 mr-2">
              {notice.kind === "success" ? "✅ " : notice.kind === "error" ? "❌ " : "ℹ️ "}
              {notice.title}
            </Text>
            <TouchableOpacity onPress={() => setNotice(null)} activeOpacity={0.7}>
              <Text className="text-muted text-sm">✕</Text>
            </TouchableOpacity>
          </View>
          <Text className="text-foreground text-xs mt-2 leading-5">{notice.text}</Text>
        </View>
      )}

      {/* 配置面板 */}
      {showConfig && (
        <View className="px-5 py-4 border-b border-border bg-surface">
          <Text className="text-foreground font-semibold mb-1">智云 TokenHub</Text>
          <Text className="text-muted text-xs mb-1">
            {TOKENHUB_CONSOLE_URL} → 个人中心 → 账户管理 → 密钥管理，复制 API Key
          </Text>
          <Text className="text-muted text-xs mb-1">
            地址已内置；模型名 {TOKENHUB_DEFAULT_MODEL} 是教程图例，报「模型不存在」就点「查模型名」换成模型广场里的真实 ID。
          </Text>
          <Text className="text-muted text-xs mb-1">
            Key 只存本机加密区，不进备份、不上传；Web 预览只放内存，刷新要重新粘贴。
          </Text>
          <Text className="text-muted text-xs mb-4">
            Web 预览请用 npm run dev:web 启动（带本机代理）；手机 App 直连官方域名，不需要代理。
          </Text>

          {/* 高级设置：默认收起，日常不用碰 */}
          <TouchableOpacity
            onPress={() => setShowAdvanced(!showAdvanced)}
            className="mb-4"
            activeOpacity={0.7}
          >
            <Text className="text-muted text-sm">
              {showAdvanced ? "▾" : "▸"} 高级设置（服务商 / 地址 / 模型）
            </Text>
          </TouchableOpacity>

          {showAdvanced && (
            <>
          {/* Provider选择 */}
          <View className="mb-4">
            <Text className="text-muted text-sm mb-2">服务商</Text>
            <View className="flex-row flex-wrap gap-2">
              {PROVIDERS.map((p) => (
                <TouchableOpacity
                  key={p.value}
                  onPress={() => setProvider(p.value)}
                  className={`px-4 py-2 rounded-lg ${
                    provider === p.value ? "bg-primary" : "bg-background border border-border"
                  }`}
                  activeOpacity={0.7}
                >
                  <Text className={provider === p.value ? "text-background" : "text-foreground"}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Base URL */}
          <View className="mb-4">
            <Text className="text-muted text-sm mb-2">API Base URL</Text>
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="https://api.openai.com/v1"
              placeholderTextColor={colors.muted}
              className="bg-background rounded-xl px-4 py-3 text-foreground border border-border"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

            </>
          )}

          {/* API Key：默认隐藏，不能明文显示 */}
          <View className="mb-4">
            <Text className="text-muted text-sm mb-2">
              API Key {state.aiConfig.isConfigured ? "（已保存，留空表示不修改）" : ""}
            </Text>
            <View className="flex-row items-center gap-2">
              <TextInput
                value={apiKey}
                onChangeText={setApiKey}
                placeholder={state.aiConfig.isConfigured ? "粘贴新 Key 可替换" : "粘贴你的 API Key"}
                placeholderTextColor={colors.muted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="password"
                className="flex-1 bg-background rounded-xl px-4 py-3 text-foreground border border-border"
              />
              <TouchableOpacity
                onPress={() => setApiKey("")}
                className="p-3 bg-background rounded-xl border border-border"
              >
                <IconSymbol name="trash" size={18} color={colors.muted} />
              </TouchableOpacity>
            </View>
          </View>

          {showAdvanced && (
            <>
          {/* Model */}
          <View className="mb-4">
            <Text className="text-muted text-sm mb-2">模型（对话 / 工具调用）</Text>
            <TextInput
              value={model}
              onChangeText={setModel}
              placeholder="qwen3.7-max"
              placeholderTextColor={colors.muted}
              className="bg-background rounded-xl px-4 py-3 text-foreground border border-border"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity onPress={handleListModels} className="mt-2 self-start" activeOpacity={0.7}>
              <Text className="text-primary text-sm">查模型名（用当前 Key 拉 /v1/models）</Text>
            </TouchableOpacity>
            {modelList.length > 0 && (
              <View className="flex-row flex-wrap gap-2 mt-2">
                {modelList.map((id) => (
                  <View key={id} className="flex-row items-center rounded-lg bg-background border border-border overflow-hidden">
                    <TouchableOpacity
                      onPress={() => setModel(id)}
                      className={`px-3 py-1 ${model === id ? "bg-primary" : ""}`}
                      activeOpacity={0.7}
                    >
                      <Text className={model === id ? "text-background text-xs" : "text-foreground text-xs"}>{id}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setVisionModel(id)}
                      className="px-2 py-1 border-l border-border"
                      activeOpacity={0.7}
                    >
                      <Text className={visionModel === id ? "text-primary text-xs" : "text-muted text-xs"}>设为视觉</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* 视觉模型：图片识别专用，纯文本模型通常不支持图片 */}
          <View className="mb-4">
            <Text className="text-muted text-sm mb-2">视觉模型（图片识别，留空则用上面的模型）</Text>
            <TextInput
              value={visionModel}
              onChangeText={setVisionModel}
              placeholder={TOKENHUB_VISION_MODEL_EXAMPLE}
              placeholderTextColor={colors.muted}
              className="bg-background rounded-xl px-4 py-3 text-foreground border border-border"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text className="text-muted text-xs mt-2 leading-5">
              发图片时先用这个模型识别，再把识别结果交给主模型回答。若报「不支持图片」，点「查模型名」找带 vl / vision 的 ID 填这里。
            </Text>
          </View>

            </>
          )}

          {/* 操作按钮 */}
          <View className="flex-row gap-3">
            <TouchableOpacity
              onPress={handleTestConnection}
              disabled={isTesting}
              className="flex-1 bg-muted/20 rounded-xl py-3 items-center"
              activeOpacity={0.8}
            >
              {isTesting ? (
                <ActivityIndicator size="small" color={colors.foreground} />
              ) : (
                <Text className="text-foreground font-medium">测试连接</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSaveConfig}
              className="flex-1 bg-primary rounded-xl py-3 items-center"
              activeOpacity={0.8}
            >
              <Text className="text-background font-semibold">保存配置</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      </View>

      {/* 对话区域：KAV 只包「消息列表 + 输入区」，键盘弹出时压缩列表、顶起输入框 */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
        keyboardVerticalOffset={Platform.OS === "ios" ? topOffset : 0}
        style={Platform.OS === "web" && keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : undefined}
      >
        {/* 消息列表 */}
        <FlatList
          ref={flatListRef}
          data={state.aiMessages}
          keyExtractor={(item, index) => item.id || `msg_${item.timestamp}_${index}`}
          renderItem={renderMessage}
          contentContainerStyle={{ padding: 20, paddingBottom: 10 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "on-drag" : undefined}
          onContentSizeChange={() => {
            if (isLoading || keyboardVisible) flatListRef.current?.scrollToEnd({ animated: true });
          }}
          ListEmptyComponent={
            <View className="items-center py-10">
              <IconSymbol name="brain" size={48} color={colors.muted} />
              <Text className="text-muted mt-4 text-center">
                {state.aiConfig.isConfigured
                  ? "开始和AI助手对话吧\n我可以帮你分析训练数据、提供建议"
                  : "请先配置API Key\n点击右上角齿轮图标"
                }
              </Text>
            </View>
          }
        />

        {/* 加载指示器 */}
        {isLoading && (
          <View className="px-5 pb-2">
            <View className="bg-surface rounded-2xl px-4 py-3 self-start border border-border">
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          </View>
        )}

        {/* AI 本次对话实际执行的写操作（透明展示） */}
        {toolActions.length > 0 && (
          <View className="px-5 py-2 border-t border-border bg-surface">
            <Text className="text-muted text-xs mb-1">AI 本次操作：</Text>
            {toolActions.map((a, i) => (
              <View key={i} className="flex-row items-start mb-1">
                <Text style={{ color: a.result.ok ? "#22c55e" : "#ef4444" }} className="mr-2">
                  {a.result.ok ? "✅" : "❌"}
                </Text>
                <Text className="text-foreground text-xs" style={{ flex: 1 }}>
                  {a.result.summary}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* 待发送图片预览 */}
        {pendingImage && (
          <View className="px-5 pt-3">
            <View className="flex-row items-center rounded-xl border border-border bg-surface p-2">
              <Image
                source={{ uri: pendingImage.uri }}
                style={{ width: 56, height: 56, borderRadius: 8 }}
                resizeMode="cover"
              />
              <View className="flex-1 ml-3">
                <Text className="text-foreground text-xs" numberOfLines={1}>
                  {pendingImage.name || "已选择图片"}
                </Text>
                <Text className="text-muted text-xs mt-1">发送后由 AI 识别，结果会存进对话记录</Text>
              </View>
              <TouchableOpacity onPress={() => setPendingImage(null)} className="p-2" activeOpacity={0.7}>
                <IconSymbol name="xmark" size={18} color={colors.muted} />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* 输入区域 */}
        <View className="px-5 py-3 border-t border-border bg-background">
          <View className="flex-row items-end gap-2">
            <TouchableOpacity
              onPress={handlePickImage}
              disabled={isLoading}
              className="w-10 h-11 rounded-xl items-center justify-center bg-surface border border-border"
              activeOpacity={0.7}
            >
              <IconSymbol name="photo" size={20} color={colors.muted} />
            </TouchableOpacity>
            <TextInput
              value={inputText}
              onChangeText={setInputText}
              onFocus={() => setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 120)}
              placeholder={pendingImage ? "补充一句（可留空）..." : "输入消息..."}
              placeholderTextColor={colors.muted}
              multiline
              maxLength={1000}
              className="flex-1 bg-surface rounded-2xl px-4 py-3 text-foreground border border-border max-h-32"
              style={{ minHeight: 44 }}
            />
            <TouchableOpacity
              onPress={handlePaste}
              className="w-10 h-11 rounded-xl items-center justify-center bg-surface border border-border"
              activeOpacity={0.7}
            >
              <IconSymbol name="doc.on.clipboard" size={19} color={colors.muted} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSendMessage}
              disabled={(!inputText.trim() && !pendingImage) || isLoading}
              className={`w-11 h-11 rounded-full items-center justify-center ${
                (inputText.trim() || pendingImage) && !isLoading ? "bg-primary" : "bg-muted/30"
              }`}
              activeOpacity={0.8}
            >
              <IconSymbol
                name="paperplane.fill"
                size={20}
                color={(inputText.trim() || pendingImage) && !isLoading ? colors.background : colors.muted}
              />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* 长按气泡后的文字选择浮层：纯文本可长按拖选，复制后可直接粘回输入框 */}
      <Modal
        visible={!!selectionTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectionTarget(null)}
      >
        <Pressable
          style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0,0,0,0.5)", padding: 20 }}
          onPress={() => setSelectionTarget(null)}
        >
          <Pressable
            style={{ width: "100%", maxWidth: 520, backgroundColor: colors.background, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 20 }}
            onPress={() => {}}
          >
            <View className="flex-row items-center justify-between mb-3">
              <Text className="text-foreground font-semibold">选择文字</Text>
              <TouchableOpacity onPress={() => setSelectionTarget(null)} className="p-1">
                <IconSymbol name="xmark" size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <Text className="text-muted text-xs mb-3 leading-5">
              长按下面文字拖选片段，用系统菜单复制；复制后点「粘贴到输入框」即可接着编辑。
            </Text>
            <ScrollView style={[{ maxHeight: 300, marginBottom: 16 }, WEB_SELECTABLE]}>
              <Text selectable style={WEB_SELECTABLE} className="text-foreground text-sm leading-6">
                {selectionTarget?.content || ""}
              </Text>
            </ScrollView>
            <View className="flex-row gap-2">
              <TouchableOpacity
                onPress={() => selectionTarget && handleCopy(selectionTarget.content)}
                className="flex-1 bg-surface border border-border rounded-xl py-3 items-center"
                activeOpacity={0.7}
              >
                <Text className="text-foreground text-sm">复制全文</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setSelectionTarget(null);
                  void handlePaste();
                }}
                className="flex-1 bg-surface border border-border rounded-xl py-3 items-center"
                activeOpacity={0.7}
              >
                <Text className="text-foreground text-sm">粘贴到输入框</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </ScreenContainer>
  );
}
