import { useState, useRef, useEffect, useMemo, useSyncExternalStore, useCallback } from "react";
import {
  Text,
  View,
  TouchableOpacity,
  TextInput,
  FlatList,
  Alert,
  ActivityIndicator,
  Platform,
  Image,
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useKeyboardOverlap } from "@/hooks/use-keyboard-overlap";
import { useApp } from "@/lib/app-context";
import type { AIMessage, AIConfig } from "@/lib/types";
import Markdown from "react-native-markdown-display";
import {
  runGeneration,
  subscribeJob,
  getJobSnapshot,
  clearJobResult,
  cancelGeneration,
  type ToolActionEntry,
} from "@/lib/ai/chat-engine";
import { persistChatImages, deleteChatImages, toDataUriForRecognition } from "@/lib/ai/chat-images";
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
  DEFAULT_MAX_TOKENS,
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

// Web 预览一律走本机代理：官方网关不给 CORS 头，自建 / EasyTier 地址多数也不处理
// OPTIONS 预检，浏览器里带 Authorization 的跨域 POST 都会被拦。真机直连用户填的地址。
const PROXY_UPSTREAM_HEADER = "X-FitLife-Upstream";

function pageHostname(): string {
  // 手机用局域网 IP 打开预览时也能连回电脑的代理；本机预览即 localhost。
  return typeof window !== "undefined" && window.location?.hostname
    ? window.location.hostname
    : "127.0.0.1";
}

function proxyBaseUrl(): string {
  return TOKENHUB_WEB_PROXY_URL.replace("127.0.0.1", pageHostname());
}

function resolveBaseUrl(url: string): string {
  const base = normalizeBaseUrl(url);
  if (Platform.OS !== "web") return base;
  return proxyBaseUrl();
}

// 代理的健康检查地址（/__health 在代理根路径，不在 /v1 下）
function proxyHealthUrl(): string {
  return proxyBaseUrl().replace(/\/v1\/?$/, "") + "/__health";
}

// 自定义地址把完整 base（含 /v1 前缀）交给代理转发；官方网关走代理的默认上游，不用带头。
function withProxyHeadersFor(baseUrl: string, init: RequestInit): RequestInit {
  const base = normalizeBaseUrl(baseUrl);
  if (Platform.OS !== "web" || !base || base === TOKENHUB_BASE_URL) return init;
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      [PROXY_UPSTREAM_HEADER]: base,
    },
  };
}

function describeCustomEndpoint(baseUrl?: string): string {
  const base = normalizeBaseUrl(baseUrl || "");
  if (!base || base === TOKENHUB_BASE_URL) return "";
  const host = base.replace(/^https?:\/\//, "").split("/")[0];
  return `\n\n自建 / 局域网地址排查：\n1) 手机必须和运行服务的机器在同一个 EasyTier 虚拟网里，电脑能 ping 通 ${host} 才算通；\n2) 服务端要监听 0.0.0.0（不是 127.0.0.1），并确认 ${base}/chat/completions 存在；\n3) http:// 明文地址在 Android release 包里默认被系统禁止，需安装带明文许可的新 APK；\n4) Web 预览已自动走本机代理绕开跨域，无需在服务端配 CORS。`;
}

function describeFailure(status: number, body: string): string {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403)
    return "Key 无效或没权限。到控制台「个人中心 → 账户管理 → 密钥管理」重新复制，别带空格/换行。";
  if (status === 429)
    return "额度用尽或触发限流。到「财务管理 → 费用中心」看余额。";
  if (status === 404)
    return "404：接口路径或模型名不对。自建/EasyTier 网关确认地址末尾带 /v1、服务确实提供 /v1/chat/completions；官方网关点「查模型名」拿真实 ID。";
  if (lower.includes("model"))
    return "模型名不对（教程里的 qwen3.7-max 只是图例）。点「查模型名」拿真实 ID 填进高级设置。";
  return `HTTP ${status}：${body.slice(0, 160)}`;
}

// 校验「确实是本项目代理」：端口被 QQ 等软件占用时，no-cors 会把 404 也当成在线，
// 结果状态条显示代理在线、AI 请求却直接失败。优先读 /__health 的 {"ok":true}；
// 只有 CORS 被拦（例如用局域网 IP 打开预览）才退化成「端口在不在」的粗判。
async function pingProxy(): Promise<boolean> {
  if (Platform.OS !== "web") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  const url = proxyHealthUrl();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.ok === true;
  } catch {
    try {
      await fetch(url, { mode: "no-cors", signal: controller.signal });
      return true;
    } catch {
      return false;
    }
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

// 上游把「模型只输出 thinking、正文为空」报成 502，这跟连接无关。
// 单独识别，避免甩出自建地址 / 跨域 / 明文那一堆误导性排查。
function describeReasoningError(msg: string): string | null {
  if (!/empty reply|answered nothing|spent on reasoning|reasoning.*token|max_tokens|token.*limit|输出预算|推理.*耗/i.test(msg)) return null;
  return (
    "模型把输出预算全花在推理上，没吐出正文，上游返回了空回复。这不是连接问题，测试连接能过很正常。\n" +
    "处理：① 高级设置把「最大输出 token」调大到 8192（服务端自己也可能有上限，要在服务端一起调）；" +
    "② 换非推理型 / 普通模型；③ 关掉「工具调用」减少推理负担；④ 问题问得更具体。"
  );
}

// 分诊：以前任何网络失败都甩「浏览器跨域/代理没启动」，真机断网也这么报，纯属误导。
async function diagnoseNetworkError(msg: string, baseUrl?: string): Promise<string> {
  const reasoning = describeReasoningError(msg);
  if (reasoning) return reasoning;
  const hint = describeCustomEndpoint(baseUrl);
  const networkish = /failed to fetch|network request failed|load failed|networkerror|timeout|aborted|network|cleartext/i.test(msg);
  if (Platform.OS !== "web") {
    return networkish
      ? `手机连不上网关：检查联网后重试；真机直连你在高级设置里填的地址，不需要本机代理。若地址是 http://，多半是 Android 禁止明文流量（需重装带明文许可的新 APK）。${hint}`
      : `连接错误：${msg}${hint}`;
  }
  const alive = await pingProxy();
  if (!alive) {
    return `本机代理没启动（或已退出 / 18082 被别的软件占用）。关掉预览，重新运行 npm run dev:web 一次启动代理+预览；只用 npx expo start --web 不会有代理。${hint}`;
  }
  return networkish
    ? `本机代理在线，但这次请求仍失败：多为上游不通、网关超时或断网（已自动重试一次）。点「测试连接」看具体状态码；自定义地址也会经代理转发，请确认上游服务可达。${hint}`
    : `连接错误：${msg}${hint}`;
}

// 待发送的图片：uri 是 data URI（base64），只放内存，不写进持久化消息。
type PendingImage = { uri: string; name?: string; mimeType: string };
// 发送前拦截：消息先停在这里，用户确认后才真正让 AI 生成回复；取消则完全不发送。
type PendingSend = { text: string; images: PendingImage[]; targetId?: string };
// 一次最多选 6 张：多图一起发给视觉模型，请求体太大会被网关/代理拒掉。
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
// 代理请求体上限 20MB，base64 会再膨胀约 1/3 → 多图总量留足余量。
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
// 聊天气泡里的多图网格：等大缩略图，自动换行，不配说明文字。
const IMAGE_TILE_STYLE = {
  width: 84,
  height: 84,
  borderRadius: 10,
  marginRight: 6,
  marginBottom: 6,
} as const;
const IMAGE_PLACEHOLDER_STYLE = {
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: "rgba(127,127,127,0.18)",
};

// RN Web 的 Text 默认不可选，显式打开 user-select 才能长按/拖选。
const WEB_SELECTABLE = Platform.OS === "web" ? ({ userSelect: "text", cursor: "text" } as any) : undefined;

// Markdown 的每个文字节点都开 selectable：原生长按会弹出系统「复制 / 全选」菜单。
// style 顺序沿用库默认写法：inheritedStyles（加粗/斜体/链接）必须盖在 styles.text 上，
// 否则自定义 text rule 会把 Markdown 的行内样式抹掉。
const SELECTABLE_MARKDOWN_RULES: any = {
  text: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => (
    <Text
      key={node.key}
      selectable
      style={[styles.text, inheritedStyles, WEB_SELECTABLE]}
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
  const { state, updateAIConfig, addAIMessage, updateAIMessage, setAIMessages, updateUserProfile } = app;
  const flatListRef = useRef<FlatList>(null);
  // 图片本体落盘在文档目录，消息里存 file:// uri；内存 ref 只作刚发送时的即时预览。
  const imagePreviews = useRef<Record<string, string[]>>({});
  // 生成引擎的状态放在模块级，页面卸载也不丢；回到页面靠 useSyncExternalStore 立即同步。
  const job = useSyncExternalStore(subscribeJob, getJobSnapshot, getJobSnapshot);
  const isLoading = job.running;
  const toolActions: ToolActionEntry[] = job.toolActions;

  // 每一轮新生成重新展开操作面板；用户点 × 后本轮保持收起。
  useEffect(() => {
    if (job.startedAt) setShowToolActions(true);
  }, [job.startedAt]);

  // 配置状态
  const [showConfig, setShowConfig] = useState(!state.aiConfig.isConfigured);
  const [provider, setProvider] = useState<AIProvider>(state.aiConfig.provider || "tokenhub");
  const [baseUrl, setBaseUrl] = useState(state.aiConfig.baseUrl || TOKENHUB_BASE_URL);
  const [model, setModel] = useState(state.aiConfig.model || TOKENHUB_DEFAULT_MODEL);
  const [visionModel, setVisionModel] = useState(state.aiConfig.visionModel || "");
  const [maxTokens, setMaxTokens] = useState(String(state.aiConfig.maxTokens ?? DEFAULT_MAX_TOKENS));
  const [toolsEnabled, setToolsEnabled] = useState(state.aiConfig.toolsEnabled ?? true);
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
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  // 「AI 本次操作」面板可收起，避免长列表挡住输入区。
  const [showToolActions, setShowToolActions] = useState(true);
  // 长按气泡进入「选择文字」浮层：里面是纯文本，保证任何平台都能长按拖选片段。
  const [selectionTarget, setSelectionTarget] = useState<AIMessage | null>(null);
  // 点气泡才展开操作行，默认收起，聊天区更干净。
  const [expandedActions, setExpandedActions] = useState<string | null>(null);
  // 归档：主列表只显示未归档消息；归档内容仍留在本机，可在归档箱里删除/恢复。
  const [showArchive, setShowArchive] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const activeMessages = useMemo(
    () => state.aiMessages.filter((m) => !m.archived),
    [state.aiMessages]
  );
  const archivedMessages = useMemo(
    () => state.aiMessages.filter((m) => m.archived),
    [state.aiMessages]
  );

  // 软键盘：KAV 上方固定内容的高度；键盘高度/显隐与其它页面共用同一个 hook
  const [topOffset, setTopOffset] = useState(0);
  const { visible: keyboardVisible, keyboardHeight } = useKeyboardOverlap();
  // 配置面板是页面里唯一需要自己滚动的区域：头部/状态栏/结果条/底部按钮都常驻，
  // 只给表单区一个上限高度，避免内容把聊天区挤没、也避免超出屏幕被裁掉无法下滑。
  const { height: windowHeight } = useWindowDimensions();
  const configMaxHeight = keyboardVisible
    ? Math.max(100, Math.round((Math.max(360, windowHeight - keyboardHeight)) * 0.26))
    : Math.max(
        180,
        Math.round(windowHeight * (notice ? 0.46 : 0.54))
      );
  // Web 预览时本机代理是否在线：一眼能看出「请求失败」是不是代理没起导致的
  const [proxyAlive, setProxyAlive] = useState<boolean | null>(null);

  // 从持久化的消息里恢复图片预览 uri。这样重进页面 / 重启 App 后图片仍能显示，
  // 而不是只剩灰色占位图（旧消息只有元信息、没有 uri 时依旧显示占位）。
  useEffect(() => {
    for (const m of state.aiMessages) {
      const saved = [...(m.images ?? []), ...(m.image ? [m.image] : [])]
        .map((img) => img.uri)
        .filter((u): u is string => !!u);
      if (saved.length && !imagePreviews.current[m.id]) imagePreviews.current[m.id] = saved;
    }
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

  // 键盘弹出后把最后一条消息滚到可视区，避免被键盘盖住；收起时 KAV / padding 自动复原。
  useEffect(() => {
    if (!keyboardVisible) return;
    const timer = setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 120);
    return () => clearTimeout(timer);
  }, [keyboardVisible]);

  // 选图：一次可多选（也可分几次追加），只做本地读取，发送时才一次性识别。
  const handlePickImage = async () => {
    const room = MAX_IMAGES - pendingImages.length;
    if (room <= 0) {
      notify("提示 · 已达到上限", `一次最多发送 ${MAX_IMAGES} 张图片，先删掉几张再加。`);
      return;
    }
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
        allowsMultipleSelection: true,
        selectionLimit: room,
        allowsEditing: false,
        quality: 0.4,
        base64: true,
      });
      if (result.canceled || !result.assets?.length) return;

      const accepted: PendingImage[] = [];
      let totalBytes = pendingImages.reduce((sum, img) => sum + (img.uri.split(",")[1] || "").length * 0.75, 0);
      let oversized = 0;
      for (const asset of result.assets.slice(0, room)) {
        const picked = await toDataUri(asset);
        const bytes = (picked.uri.split(",")[1] || "").length * 0.75;
        if (bytes > MAX_IMAGE_BYTES || totalBytes + bytes > MAX_TOTAL_IMAGE_BYTES) {
          oversized++;
          continue;
        }
        totalBytes += bytes;
        accepted.push({ uri: picked.uri, mimeType: picked.mimeType, name: picked.name });
      }
      if (accepted.length) setPendingImages((prev) => [...prev, ...accepted]);
      if (oversized > 0) {
        notify("提示 · 部分图片未加入", `${oversized} 张图片太大或总量超限，已跳过；单张建议小于 4MB。`);
      }
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

  // 切换服务商时填入该服务商的默认值。
  // 注意：以前放在 useEffect([provider]) 里，页面一挂载就会把用户保存的自定义 Base URL
  // 覆盖回官方地址，导致 EasyTier / 自建地址「保存了却连不上」。改成只在点击时重置。
  const handleSelectProvider = (p: (typeof PROVIDERS)[number]) => {
    setProvider(p.value);
    if (p.value !== "custom") {
      setBaseUrl(p.defaultUrl);
      setModel(p.defaultModel);
    }
  };

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
      const response = await fetchWithRetry(
        target,
        withProxyHeadersFor(baseUrl, {
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
        })
      );
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
            `上游配置：${normalizeBaseUrl(baseUrl)}${Platform.OS === "web" ? "（经本机代理转发）" : "（直连）"}`,
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
          `HTTP ${response.status} · 耗时 ${elapsed}s · 模型 ${usedModel}\n请求地址：${target}\n上游配置：${normalizeBaseUrl(baseUrl)}\n${describeFailure(response.status, message || response.statusText)}${describeCustomEndpoint(baseUrl)}`
        );
      }
    } catch (error) {
      notify("错误 · 测试连接未通过", await diagnoseNetworkError(error instanceof Error ? error.message : "未知错误", baseUrl));
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
      const response = await fetchWithRetry(
        `${resolveBaseUrl(baseUrl)}/models`,
        withProxyHeadersFor(baseUrl, {
          headers: { "Authorization": `Bearer ${effectiveKey}` },
        })
      );
      const body = await response.text().catch(() => "");
      if (!response.ok) {
        notify("失败", `${describeFailure(response.status, body)}${describeCustomEndpoint(baseUrl)}`);
        return;
      }
      const ids: string[] = (JSON.parse(body)?.data ?? []).map((m: { id?: string }) => m.id || "").filter(Boolean);
      if (!ids.length) {
        notify("提示", "接口没返回模型列表，去模型广场手动复制模型名。");
        return;
      }
      setModelList(ids.slice(0, 20));
    } catch (error) {
      notify("错误", await diagnoseNetworkError(error instanceof Error ? error.message : "未知错误", baseUrl));
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
        maxTokens: Math.min(32768, Math.max(512, Number(maxTokens) || DEFAULT_MAX_TOKENS)),
        toolsEnabled,
        isConfigured: true,
      });
      setApiKey(""); // 立刻清掉输入框，不留在屏幕上
      setShowConfig(false);
      notify("成功", "配置已保存");
    } catch {
      notify("错误", "保存失败");
    }
  };


  // 发送消息：图片先落盘，再交给模块级引擎生成。
  // 生成流程不挂在页面上，切走页面 / 切到别的 App 都不会中断；回来靠 job 状态恢复 UI。
  const startGeneration = useCallback(async (text: string, images: PendingImage[], targetId?: string) => {
    if (!text && images.length === 0) return;
    if (!state.aiConfig.isConfigured) {
      notify("提示", "请先配置 API Key");
      setShowConfig(true);
      return;
    }

    let userMsg: AIMessage;
    let removedIds: string[] = [];
    if (!targetId) {
      // 新消息：图片先落盘拿到 file:// uri，再落库（这样重进页面图片还在）。
      const persisted = images.length
        ? await persistChatImages(`pending_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, images)
        : [];
      userMsg = addAIMessage({
        role: "user",
        content: text,
        ...(images.length ? { images: persisted } : {}),
      });
      if (images.length) imagePreviews.current[userMsg.id] = images.map((img) => img.uri);
    } else {
      // 重新生成：复用原消息，清掉它之后的旧回复与旧识别结果。
      const existing = state.aiMessages.find((m) => m.id === targetId);
      const idx = state.aiMessages.findIndex((m) => m.id === targetId);
      removedIds = state.aiMessages
        .slice(idx + 1)
        .filter((m) => m.role === "assistant" && !m.archived)
        .map((m) => m.id);
      if (removedIds.length) {
        const removeSet = new Set(removedIds);
        setAIMessages((prev) => prev.filter((m) => !removeSet.has(m.id)));
        removedIds.forEach((id) => deleteChatImages(id));
      }
      updateAIMessage(targetId, { imageAnalysis: undefined });
      userMsg = {
        ...(existing ?? { id: targetId, role: "user", timestamp: new Date().toISOString() }),
        content: text,
      };
    }

    setInputText("");
    setPendingImages([]);
    clearJobResult();

    // 自己拼上下文快照：dispatch 是异步的，此刻 state.aiMessages 还没含新消息/还没删旧回复。
    const removeSet = new Set(removedIds);
    const snapshot = state.aiMessages
      .filter((m) => !m.archived && !removeSet.has(m.id) && m.id !== userMsg.id)
      .map((m) => (m.id === targetId ? userMsg : m));
    snapshot.push(userMsg);

    // 重新生成时图片是 file:// 路径，要先读回 data URI 才能发给视觉模型。
    const recognitionUris = await Promise.all(
      images.map((img) => toDataUriForRecognition(img.uri))
    );
    await runGeneration({
      text,
      imageUris: recognitionUris,
      userMessageId: userMsg.id,
      messagesSnapshot: snapshot,
      app,
    });
  }, [state.aiConfig.isConfigured, state.aiMessages, addAIMessage, updateAIMessage, setAIMessages, app]);

  // 发送拦截：点发送后先停在确认卡片，用户可取消或改文字，确认后才真正调用 AI。
  const handleSendMessage = () => {
    if (isLoading) return;
    const text = inputText.trim();
    if (!text && pendingImages.length === 0) return;
    setPendingSend({ text, images: pendingImages });
    setInputText("");
    setPendingImages([]);
  };

  const handleConfirmPendingSend = () => {
    if (!pendingSend) return;
    const { text, images, targetId } = pendingSend;
    setPendingSend(null);
    void startGeneration(text, images, targetId);
  };

  // 取消发送：丢弃这次编辑；「取回编辑」则把文字和图片放回输入框。
  const handleCancelPendingSend = () => setPendingSend(null);

  const handleRecallPendingSend = () => {
    if (!pendingSend) return;
    setPendingSend(null);
    setInputText(pendingSend.text);
    setPendingImages(pendingSend.images);
  };

  const handleCancelGeneration = () => {
    cancelGeneration();
    setPendingSend(null);
  };



  // 清除当前对话：只清主视图，归档箱里的内容不动（要删去归档箱）。
  const handleClearMessages = () => {
    const doClear = () => {
      const ids = activeMessages.map((m) => m.id);
      setAIMessages((prev) => prev.filter((m) => m.archived));
      ids.forEach((id) => deleteChatImages(id));
      notify("成功 · 已清除", `已清空当前 ${activeMessages.length} 条消息；归档箱里 ${archivedMessages.length} 条未动`);
    };
    if (Platform.OS === "web") {
      doClear();
      return;
    }
    Alert.alert("清除当前对话", `清空当前 ${activeMessages.length} 条消息？归档箱里的内容不会删除。`, [
      { text: "取消", style: "cancel" },
      { text: "清除", style: "destructive", onPress: doClear },
    ]);
  };

  // 归档当前全部消息：只打标记，不删数据
  const handleArchiveAll = () => {
    if (activeMessages.length === 0) return;
    const ids = new Set(activeMessages.map((m) => m.id));
    setAIMessages((prev) => prev.map((m) => (ids.has(m.id) ? { ...m, archived: true } : m)));
    notify("成功 · 已归档", `${activeMessages.length} 条消息移入归档箱，主列表已清爽`);
    setAtBottom(true);
  };

  // 单条归档：翻历史时不想整批收走，可以只把这一条移进归档箱。
  const archiveOneMessage = (id: string) => {
    setAIMessages((prev) => prev.map((m) => (m.id === id ? { ...m, archived: true } : m)));
  };

  const deleteOneMessage = (id: string) => {
    setAIMessages((prev) => prev.filter((m) => m.id !== id));
    deleteChatImages(id);
  };

  // 编辑重发：把这条用户消息的文字和图片放回输入框，并移除它和它之后的回复。
  const handleEditResend = (msg: AIMessage) => {
    const idx = state.aiMessages.findIndex((m) => m.id === msg.id);
    const removeIds = state.aiMessages.slice(idx).map((m) => m.id);
    const removeSet = new Set(removeIds);
    setAIMessages((prev) => prev.filter((m) => !removeSet.has(m.id)));
    removeIds.forEach((id) => deleteChatImages(id));

    setInputText(msg.content || "");
    // 图片本体在 imagePreviews（本次会话）或消息 uri（重进页面后）里，取出来放回输入框。
    const savedUris = imagePreviews.current[msg.id] ||
      [...(msg.images ?? []), ...(msg.image ? [msg.image] : [])]
        .map((img) => img.uri)
        .filter((u): u is string => !!u);
    if (savedUris.length) {
      setPendingImages(
        savedUris.slice(0, MAX_IMAGES).map((uri, i) => ({
          uri,
          mimeType: msg.images?.[i]?.mimeType || msg.image?.mimeType || "image/jpeg",
          name: msg.images?.[i]?.name || msg.image?.name,
        }))
      );
    }
    flatListRef.current?.scrollToEnd({ animated: true });
  };

  // 重新生成：沿用这条用户消息的内容，删掉它之后的旧回复，交给引擎重新跑一轮。
  const handleRegenerate = (msg: AIMessage) => {
    const savedUris = imagePreviews.current[msg.id] ||
      [...(msg.images ?? []), ...(msg.image ? [msg.image] : [])]
        .map((img) => img.uri)
        .filter((u): u is string => !!u);
    const images: PendingImage[] = savedUris.slice(0, MAX_IMAGES).map((uri, i) => ({
      uri,
      mimeType: msg.images?.[i]?.mimeType || msg.image?.mimeType || "image/jpeg",
      name: msg.images?.[i]?.name || msg.image?.name,
    }));
    // 重新生成也走同一道拦截，用户仍可在真正请求前取消。
    setPendingSend({ text: msg.content || "", images, targetId: msg.id });
  };

  const restoreOneMessage = (id: string) => {
    setAIMessages((prev) => prev.map((m) => (m.id === id ? { ...m, archived: false } : m)));
    setAtBottom(true);
  };

  const clearArchive = () => {
    const doClear = () => {
      const ids = archivedMessages.map((m) => m.id);
      setAIMessages((prev) => prev.filter((m) => !m.archived));
      ids.forEach((id) => deleteChatImages(id));
      notify("成功 · 归档已清空", `永久删除了 ${archivedMessages.length} 条归档消息`);
    };
    if (Platform.OS === "web") {
      doClear();
      return;
    }
    Alert.alert("清空归档箱", `永久删除 ${archivedMessages.length} 条归档消息？不可恢复。`, [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: doClear },
    ]);
  };

  const scrollToBottom = () => {
    flatListRef.current?.scrollToEnd({ animated: true });
    setAtBottom(true);
  };

  // 滚动到底部（新消息 / 归档 / 恢复后）
  useEffect(() => {
    if (activeMessages.length > 0) {
      const timer = setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      return () => clearTimeout(timer);
    }
  }, [activeMessages.length]);

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
    // 图片 uri 优先取持久化消息里的 file:// 路径（重进页面 / 重启后仍在），
    // 内存 ref 只作为刚发送那一瞬间的即时预览兜底。
    const persistedUris = [...(item.images ?? []), ...(item.image ? [item.image] : [])]
      .map((img) => img.uri)
      .filter((u): u is string => !!u);
    const previewUris = persistedUris.length ? persistedUris : imagePreviews.current[item.id] || [];
    const imageCount = Math.max(previewUris.length, item.images?.length ?? 0, item.image ? 1 : 0);
    const isUser = item.role === "user";
    const expanded = expandedActions === item.id;
    const timeText = new Date(item.timestamp).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      <View className={`mb-4 flex-row items-end ${isUser ? "justify-end" : "justify-start"}`}>
        {/* AI 头像 */}
        {!isUser && (
          <View
            className="w-8 h-8 rounded-full items-center justify-center mr-2 mb-1"
            style={{ backgroundColor: colors.primary + "1F" }}
          >
            <IconSymbol name="brain" size={17} color={colors.primary} />
          </View>
        )}

        <View className={isUser ? "items-end" : "items-start"} style={{ maxWidth: "82%" }}>
          <Pressable
            onPress={() => setExpandedActions(expanded ? null : item.id)}
            onLongPress={() => setSelectionTarget(item)}
            delayLongPress={400}
          >
            <View
              style={[
                WEB_SELECTABLE,
                {
                  borderRadius: 18,
                  borderBottomRightRadius: isUser ? 5 : 18,
                  borderBottomLeftRadius: isUser ? 18 : 5,
                  shadowColor: "#000",
                  shadowOpacity: 0.04,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 2 },
                  elevation: 2,
                },
              ]}
              className={`px-4 py-3 ${isUser ? "bg-primary" : "bg-surface border border-border"}`}
            >
              {imageCount > 0 && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: item.content ? 8 : 0 }}>
                  {Array.from({ length: imageCount }, (_, index) => {
                    const uri = previewUris[index];
                    return uri ? (
                      <Image key={index} source={{ uri }} style={IMAGE_TILE_STYLE} resizeMode="cover" />
                    ) : (
                      <View key={index} style={[IMAGE_TILE_STYLE, IMAGE_PLACEHOLDER_STYLE]}>
                        <IconSymbol name="photo" size={22} color={isUser ? colors.background : colors.muted} />
                      </View>
                    );
                  })}
                </View>
              )}
              {item.content ? (
                isUser ? (
                  <Text selectable style={WEB_SELECTABLE} className="text-background leading-6">
                    {item.content}
                  </Text>
                ) : (
                  <Markdown style={markdownStyles} rules={SELECTABLE_MARKDOWN_RULES}>
                    {item.content}
                  </Markdown>
                )
              ) : null}
            </View>
          </Pressable>

          <View className="flex-row items-center mt-1.5 px-1">
            <Text className="text-muted text-[11px]">{timeText}</Text>
            {!expanded && (
              <TouchableOpacity onPress={() => setExpandedActions(item.id)} className="ml-2" activeOpacity={0.6}>
                <Text className="text-muted text-[11px]">···</Text>
              </TouchableOpacity>
            )}
          </View>

          {expanded && (
            <View
              className="mt-2 flex-row flex-wrap items-center gap-x-4 gap-y-2 px-1 py-2 rounded-xl border border-border bg-surface"
              style={{ paddingHorizontal: 10 }}
            >
              {item.content ? (
                <>
                  <TouchableOpacity onPress={() => handleCopy(item.content)} className="flex-row items-center" activeOpacity={0.7}>
                    <IconSymbol name="square.on.square" size={13} color={colors.muted} />
                    <Text className="text-muted text-xs ml-1">复制</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSelectionTarget(item)} activeOpacity={0.7}>
                    <Text className="text-muted text-xs">选择文字</Text>
                  </TouchableOpacity>
                </>
              ) : null}
              {isUser && (
                <>
                  <TouchableOpacity onPress={() => handleEditResend(item)} className="flex-row items-center" activeOpacity={0.7}>
                    <IconSymbol name="pencil" size={13} color={colors.primary} />
                    <Text className="text-primary text-xs ml-1">编辑重发</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleRegenerate(item)} className="flex-row items-center" activeOpacity={0.7}>
                    <IconSymbol name="arrow.counterclockwise" size={13} color={colors.primary} />
                    <Text className="text-primary text-xs ml-1">重新生成</Text>
                  </TouchableOpacity>
                </>
              )}
              {item.role === "assistant" && (
                <TouchableOpacity
                  onPress={() => handleSaveNutritionFromText(item.content)}
                  className="flex-row items-center"
                  activeOpacity={0.7}
                >
                  <IconSymbol name="pencil" size={13} color={colors.muted} />
                  <Text className="text-muted text-xs ml-1">存入自定义</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => archiveOneMessage(item.id)} activeOpacity={0.7}>
                <Text className="text-muted text-xs">归档</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteOneMessage(item.id)} activeOpacity={0.7}>
                <Text className="text-error text-xs">删除</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* 用户头像 */}
        {isUser && (
          <View
            className="w-8 h-8 rounded-full items-center justify-center ml-2 mb-1"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-background text-sm font-semibold">我</Text>
          </View>
        )}
      </View>
    );
  };

  // 键盘避让统一交给 ScreenContainer：Android/Web 用实测覆盖高度补 paddingBottom，iOS 用 KAV。
  // 以前 AI 页自己再套一层 KAV，两层叠加会让输入区算错高度、仍被键盘盖住。
  return (
    <ScreenContainer
      edges={["top", "left", "right", "bottom"]}
      className="flex-1"
      keyboardVerticalOffset={Platform.OS === "ios" ? topOffset : 0}
    >
      {/* KAV 上方的固定内容：量出高度给 iOS 的 keyboardVerticalOffset 用。
          flexShrink=0 保证聊天区只拿「剩余高度」，不会把配置区压扁或顶出屏幕。 */}
      <View
        onLayout={(e) => setTopOffset(e.nativeEvent.layout.height)}
        style={{ flexShrink: 0 }}
      >
      {/* 头部 */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border bg-surface">
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-9 h-9 rounded-full items-center justify-center bg-background border border-border"
          activeOpacity={0.7}
        >
          <IconSymbol name="chevron.left" size={20} color={colors.foreground} />
        </TouchableOpacity>
        <View className="items-center">
          <View className="flex-row items-center gap-1.5">
            <View className="w-6 h-6 rounded-full items-center justify-center" style={{ backgroundColor: colors.primary + "22" }}>
              <IconSymbol name="brain" size={14} color={colors.primary} />
            </View>
            <Text className="text-lg font-bold text-foreground">AI 助手</Text>
          </View>
          <Text className="text-[11px] text-muted mt-0.5">记录 · 分析 · 建议</Text>
        </View>
        <View className="flex-row gap-2">
          <TouchableOpacity
            onPress={() => setShowConfig(!showConfig)}
            className={`w-9 h-9 rounded-full items-center justify-center border ${
              showConfig ? "bg-primary border-primary" : "bg-background border-border"
            }`}
            activeOpacity={0.7}
          >
            <IconSymbol name="gearshape.fill" size={18} color={showConfig ? colors.background : colors.muted} />
          </TouchableOpacity>
          {activeMessages.length > 0 && (
            <TouchableOpacity
              onPress={handleClearMessages}
              className="w-9 h-9 rounded-full items-center justify-center bg-background border border-border"
              activeOpacity={0.7}
            >
              <IconSymbol name="trash" size={18} color={colors.muted} />
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

      {/* 消息管理：归档 / 归档箱 / 一键到底。键盘弹起时只留「到底」，给输入区腾空间 */}
      <View className="flex-row items-center gap-2 px-5 py-2 border-b border-border">
        {!keyboardVisible && activeMessages.length > 0 && (
          <TouchableOpacity
            onPress={handleArchiveAll}
            className="px-3 py-1.5 rounded-lg bg-surface border border-border"
            activeOpacity={0.7}
          >
            <Text className="text-foreground text-xs">归档当前 {activeMessages.length}</Text>
          </TouchableOpacity>
        )}
        {!keyboardVisible && (
          <TouchableOpacity
            onPress={() => setShowArchive(true)}
            className="px-3 py-1.5 rounded-lg bg-surface border border-border"
            activeOpacity={0.7}
          >
            <Text className="text-foreground text-xs">归档箱 {archivedMessages.length}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={scrollToBottom} className="px-3 py-1.5 rounded-lg bg-primary" activeOpacity={0.7}>
          <Text className="text-background text-xs">↓ 一键到底</Text>
        </TouchableOpacity>
      </View>

      {/* 代理没起时先给一条可执行的修复提示，别等请求失败才猜 */}
      {Platform.OS === "web" && proxyAlive === false && (
        <View
          className="mx-5 mt-2 rounded-lg px-3 py-2"
          style={{ backgroundColor: "rgba(239,68,68,0.10)", borderColor: "rgba(239,68,68,0.4)", borderWidth: 1 }}
        >
          <Text className="text-foreground text-xs leading-5">
            本机代理未启动：关掉预览，运行 npm run dev:web 一次启动「代理 18082 + 预览 8081」；只跑 npx expo start --web 不会有代理。
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
          {/* 诊断文本可能很长（EasyTier 排查 4 条），单独限高并允许滚动，
              否则结果条会把下面的配置面板和保存按钮一起挤出屏幕 */}
          <ScrollView
            style={{ maxHeight: keyboardVisible ? 60 : 130, flexGrow: 0, flexShrink: 0, marginTop: 8 }}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            <Text className="text-foreground text-xs leading-5">{notice.text}</Text>
          </ScrollView>
        </View>
      )}

      {/* 配置面板：表单区自己滚动（Web 滚轮 / 原生手指），操作按钮常驻底部 */}
      {showConfig && (
        <>
        <ScrollView
          style={{ maxHeight: configMaxHeight, flexGrow: 0, flexShrink: 0 }}
          contentContainerStyle={{ flexGrow: 0 }}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
        <View className="px-5 pt-4 pb-2 bg-surface">
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
                  onPress={() => handleSelectProvider(p)}
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
            <Text className="text-muted text-xs mt-2 leading-5">
              自建 / EasyTier 网关：选「自定义」后填完整地址，例如 http://10.126.126.1:3425/v1（末尾要带 /v1），再粘贴 Key 并点「保存配置」。
              {"\n"}Web 预览会自动经本机代理转发，不需要服务端配 CORS；手机 App 直连，需手机在同一 EasyTier 虚拟网内，且 http:// 明文地址要装带明文许可的新 APK。
            </Text>
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
              发图片时先用这个模型识别，再把识别结果交给主模型回答。若报「不支持图片」，点「查模型名」找带 vl / vision 的 ID 填这里。自建 / agent 类网关还得支持 OpenAI 的 image_url 数组格式，否则图片会被直接丢掉，模型只会说「看不到图片」。
            </Text>
          </View>

          {/* 最大输出 token：推理型模型需要给 thinking + 正文都留预算 */}
          <View className="mb-4">
            <Text className="text-muted text-sm mb-2">最大输出 token（推理型模型建议 8192）</Text>
            <TextInput
              value={maxTokens}
              onChangeText={setMaxTokens}
              keyboardType="numeric"
              placeholder={String(DEFAULT_MAX_TOKENS)}
              placeholderTextColor={colors.muted}
              className="bg-background rounded-xl px-4 py-3 text-foreground border border-border"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text className="text-muted text-xs mt-2 leading-5">
              报「empty reply / spent on reasoning」就是预算被推理吃光、正文一个字没剩，调大这里或换普通模型。服务端自己也可能有上限，要一起调。
            </Text>
          </View>

          {/* 工具调用开关：自建网关常不支持 tools */}
          <TouchableOpacity
            onPress={() => setToolsEnabled(!toolsEnabled)}
            className="flex-row items-center mb-4"
            activeOpacity={0.7}
          >
            <View className="flex-1 mr-3">
              <Text className="text-foreground text-sm">允许 AI 调用工具</Text>
              <Text className="text-muted text-xs mt-1 leading-5">
                关掉后只聊天、不再自动改训练/饮食/资料。自建或 agent 类网关常不支持 tools，关掉也能明显减少推理负担。
              </Text>
            </View>
            <View
              className={`w-11 h-6 rounded-full justify-center px-0.5 ${toolsEnabled ? "bg-primary items-end" : "bg-muted/30 items-start"}`}
            >
              <View className="w-5 h-5 rounded-full bg-background" />
            </View>
          </TouchableOpacity>

            </>
          )}

        </View>
        </ScrollView>
        {/* 按钮放在滚动区外：滚到模型列表深处也能直接点「保存配置」 */}
        <View className="flex-row gap-3 px-5 py-3 border-b border-border bg-surface">
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
        </>
      )}

      </View>

      {/* 对话区域只拿剩余高度；外层容器被键盘压缩后，底部输入区自然贴在键盘上沿 */}
      <View className="flex-1">
        {/* 消息列表 */}
        <FlatList
          ref={flatListRef}
          data={activeMessages}
          keyExtractor={(item, index) => item.id || `msg_${item.timestamp}_${index}`}
          renderItem={renderMessage}
          contentContainerStyle={{ padding: 20, paddingBottom: 10 }}
          onScroll={(e) => {
            const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
            const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
            setAtBottom(distance < 120);
          }}
          scrollEventThrottle={150}
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

        {/* 往上翻历史时，随时可点回到底部 */}
        {!atBottom && activeMessages.length > 0 && (
          <TouchableOpacity
            onPress={scrollToBottom}
            activeOpacity={0.8}
            className="absolute right-4 w-11 h-11 rounded-full bg-primary items-center justify-center"
            style={{ bottom: 88, zIndex: 20, elevation: 4 }}
          >
            <Text className="text-background text-lg">↓</Text>
          </TouchableOpacity>
        )}

        {/* 生成中状态卡：可直接取消，不再只是一个干巴巴的文字条 */}
        {isLoading && (
          <View className="px-5 pb-2">
            <View
              className="rounded-2xl px-4 py-3 border"
              style={{ backgroundColor: colors.primary + "12", borderColor: colors.primary + "40" }}
            >
              <View className="flex-row items-center">
                <View
                  className="w-8 h-8 rounded-full items-center justify-center mr-3"
                  style={{ backgroundColor: colors.primary + "22" }}
                >
                  <ActivityIndicator size="small" color={colors.primary} />
                </View>
                <View className="flex-1">
                  <Text className="text-foreground text-sm font-semibold">
                    {job.turn > 0 ? `AI 正在生成 · 第 ${job.turn} 轮` : "AI 正在理解你的问题"}
                  </Text>
                  <Text className="text-muted text-xs mt-0.5">
                    可以离开页面，完成后会通知你
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={handleCancelGeneration}
                  className="rounded-full px-3 py-1.5 border border-border bg-background"
                  activeOpacity={0.7}
                >
                  <Text className="text-error text-xs font-medium">取消生成</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* 上一轮生成结果摘要（含后台完成 / 失败的反馈） */}
        {!isLoading && job.lastResult && (
          <View className="px-5 pb-2">
            <View
              className={`flex-row items-center rounded-xl px-3 py-2 border ${
                job.lastResult.ok ? "bg-success/10 border-success/30" : "bg-error/10 border-error/30"
              }`}
            >
              <Text className={`flex-1 text-xs ${job.lastResult.ok ? "text-success" : "text-error"}`}>
                {job.lastResult.ok ? "✓ " : "✕ "}
                {job.lastResult.text}
              </Text>
              <TouchableOpacity onPress={clearJobResult} className="ml-2 p-1" activeOpacity={0.7}>
                <IconSymbol name="xmark" size={14} color={job.lastResult.ok ? colors.success : colors.error} />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* AI 本次对话实际执行的写操作：紧凑卡片 + 明确的关闭按钮 */}
        {toolActions.length > 0 && showToolActions && (
          <View className="px-5 pb-2">
            <View className="rounded-2xl border border-border bg-surface overflow-hidden">
              <View className="flex-row items-center px-3 py-2.5 border-b border-border">
                <View
                  className="w-6 h-6 rounded-full items-center justify-center mr-2"
                  style={{ backgroundColor: colors.primary + "20" }}
                >
                  <IconSymbol name="checkmark.circle.fill" size={14} color={colors.primary} />
                </View>
                <Text className="flex-1 text-foreground text-sm font-semibold">
                  AI 本次操作 · {toolActions.length} 项
                </Text>
                <TouchableOpacity
                  onPress={() => setShowToolActions(false)}
                  className="w-7 h-7 rounded-full items-center justify-center"
                  style={{ backgroundColor: colors.background }}
                  activeOpacity={0.7}
                  accessibilityLabel="关闭本次操作面板"
                >
                  <IconSymbol name="xmark" size={14} color={colors.muted} />
                </TouchableOpacity>
              </View>
              <ScrollView style={{ maxHeight: 132 }} contentContainerStyle={{ padding: 12 }}>
                {toolActions.map((a, i) => (
                  <View key={i} className="flex-row items-start mb-2">
                    <View
                      className="w-2 h-2 rounded-full mt-1.5 mr-2"
                      style={{ backgroundColor: a.result.ok ? colors.success : colors.error }}
                    />
                    <Text className="text-foreground text-xs flex-1 leading-5">
                      {a.result.summary}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          </View>
        )}
        {toolActions.length > 0 && !showToolActions && (
          <View className="px-5 pb-2">
            <TouchableOpacity
              onPress={() => setShowToolActions(true)}
              className="self-start rounded-full border border-border bg-surface px-3 py-1.5"
              activeOpacity={0.7}
            >
              <Text className="text-muted text-xs">查看 AI 本次操作（{toolActions.length}）</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* 发送前拦截卡：点发送后消息不会立刻进入对话，确认才发起 AI 请求 */}
        {pendingSend && (
          <View className="px-5 pt-3">
            <View
              className="rounded-2xl border p-3"
              style={{ backgroundColor: colors.primary + "12", borderColor: colors.primary + "45" }}
            >
              <View className="flex-row items-center mb-2">
                <View
                  className="w-6 h-6 rounded-full items-center justify-center mr-2"
                  style={{ backgroundColor: colors.primary + "22" }}
                >
                  <IconSymbol name="paperplane.fill" size={12} color={colors.primary} />
                </View>
                <View className="flex-1">
                  <Text className="text-foreground text-sm font-semibold">发送前确认</Text>
                  <Text className="text-muted text-xs">这条消息还没有发给 AI</Text>
                </View>
                <TouchableOpacity onPress={handleCancelPendingSend} className="p-1" activeOpacity={0.7}>
                  <IconSymbol name="xmark" size={16} color={colors.muted} />
                </TouchableOpacity>
              </View>
              <ScrollView style={{ maxHeight: 88 }} className="mb-3">
                <Text className="text-foreground text-sm leading-5">
                  {pendingSend.text || (pendingSend.images.length ? "（仅图片，无文字）" : "")}
                </Text>
                {pendingSend.images.length > 0 && (
                  <Text className="text-muted text-xs mt-1">附 {pendingSend.images.length} 张图片</Text>
                )}
              </ScrollView>
              <View className="flex-row gap-2">
                <TouchableOpacity
                  onPress={handleRecallPendingSend}
                  className="flex-1 rounded-xl border border-border bg-background py-2 items-center"
                  activeOpacity={0.7}
                >
                  <Text className="text-foreground text-xs">取回编辑</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleCancelPendingSend}
                  className="flex-1 rounded-xl border border-border bg-background py-2 items-center"
                  activeOpacity={0.7}
                >
                  <Text className="text-error text-xs">取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleConfirmPendingSend}
                  className="flex-1 rounded-xl bg-primary py-2 items-center"
                  activeOpacity={0.8}
                >
                  <Text className="text-background text-xs font-semibold">确认发送</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* 待发送图片：缩略图网格，点右上角 × 单独移除，不加说明文字 */}
        {pendingImages.length > 0 && (
          <View className="px-5 pt-3">
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {pendingImages.map((img, index) => (
                <View key={index} style={{ marginRight: 6, marginBottom: 6 }}>
                  <Image
                    source={{ uri: img.uri }}
                    style={{ width: 64, height: 64, borderRadius: 8 }}
                    resizeMode="cover"
                  />
                  <TouchableOpacity
                    onPress={() => setPendingImages((prev) => prev.filter((_, i) => i !== index))}
                    style={{
                      position: "absolute",
                      top: -6,
                      right: -6,
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      backgroundColor: colors.surface,
                      borderWidth: 1,
                      borderColor: colors.border,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    activeOpacity={0.7}
                  >
                    <IconSymbol name="xmark" size={12} color={colors.muted} />
                  </TouchableOpacity>
                </View>
              ))}
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
              placeholder={pendingImages.length ? "补充一句（可留空）..." : "输入消息..."}
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
              disabled={(!inputText.trim() && pendingImages.length === 0) || isLoading}
              className={`w-11 h-11 rounded-full items-center justify-center ${
                (inputText.trim() || pendingImages.length > 0) && !isLoading ? "bg-primary" : "bg-muted/30"
              }`}
              activeOpacity={0.8}
            >
              <IconSymbol
                name="paperplane.fill"
                size={20}
                color={(inputText.trim() || pendingImages.length > 0) && !isLoading ? colors.background : colors.muted}
              />
            </TouchableOpacity>
          </View>
        </View>
      </View>

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

      {/* 归档箱：查看 / 恢复 / 删除单条 / 清空 */}
      <Modal visible={showArchive} animationType="slide" onRequestClose={() => setShowArchive(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <View className="flex-row items-center justify-between px-5 py-4 border-b border-border">
            <Text className="text-foreground text-lg font-semibold">归档箱 · {archivedMessages.length} 条</Text>
            <TouchableOpacity onPress={() => setShowArchive(false)} className="p-1">
              <IconSymbol name="xmark" size={20} color={colors.muted} />
            </TouchableOpacity>
          </View>
          <ScrollView className="flex-1 px-5 py-3">
            {archivedMessages.length === 0 ? (
              <View className="items-center py-12">
                <Text className="text-muted text-sm text-center">
                  归档箱是空的。回主界面点「归档当前」，历史消息就会收进这里。
                </Text>
              </View>
            ) : (
              archivedMessages.map((m) => (
                <View key={m.id} className="mb-3 p-3 rounded-xl bg-surface border border-border">
                  <View className="flex-row items-center justify-between mb-2">
                    <Text className="text-muted text-xs">
                      {m.role === "user" ? "我" : "AI"} ·{" "}
                      {new Date(m.timestamp).toLocaleString("zh-CN", {
                        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
                      })}
                    </Text>
                    <View className="flex-row gap-3">
                      <TouchableOpacity onPress={() => restoreOneMessage(m.id)} activeOpacity={0.7}>
                        <Text className="text-primary text-xs">恢复</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => deleteOneMessage(m.id)} activeOpacity={0.7}>
                        <Text className="text-error text-xs">删除</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                  {m.content ? (
                    <Text selectable className="text-foreground text-xs leading-5" numberOfLines={4}>
                      {m.content}
                    </Text>
                  ) : (
                    <View className="flex-row items-center">
                      {Array.from(
                        { length: Math.max(m.images?.length ?? 0, m.image ? 1 : 0) },
                        (_, i) => (
                          <IconSymbol key={i} name="photo" size={16} color={colors.muted} />
                        )
                      )}
                    </View>
                  )}
                </View>
              ))
            )}
          </ScrollView>
          {archivedMessages.length > 0 && (
            <View className="px-5 py-3 border-t border-border flex-row gap-3">
              <TouchableOpacity
                onPress={clearArchive}
                className="flex-1 bg-error/15 border border-error/40 rounded-xl py-3 items-center"
                activeOpacity={0.7}
              >
                <Text className="text-error text-sm font-medium">清空归档箱</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setShowArchive(false)}
                className="flex-1 bg-surface border border-border rounded-xl py-3 items-center"
                activeOpacity={0.7}
              >
                <Text className="text-foreground text-sm">返回对话</Text>
              </TouchableOpacity>
            </View>
          )}
        </SafeAreaView>
      </Modal>
    </ScreenContainer>
  );
}
