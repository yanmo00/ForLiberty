import { Platform } from "react-native";
import {
  TOKENHUB_BASE_URL,
  TOKENHUB_WEB_PROXY_URL,
  normalizeBaseUrl,
} from "@/constants/ai-provider";

// Web 预览一律走本机代理：官方网关不给 CORS 头，自建 / EasyTier 地址多数也不处理
// OPTIONS 预检，浏览器里带 Authorization 的跨域 POST 都会被拦。真机直连用户填的地址。
export const PROXY_UPSTREAM_HEADER = "X-FitLife-Upstream";

export function pageHostname(): string {
  return typeof window !== "undefined" && window.location?.hostname
    ? window.location.hostname
    : "127.0.0.1";
}

export function proxyBaseUrl(): string {
  return TOKENHUB_WEB_PROXY_URL.replace("127.0.0.1", pageHostname());
}

export function resolveBaseUrl(url: string): string {
  const base = normalizeBaseUrl(url);
  if (Platform.OS !== "web") return base;
  return proxyBaseUrl();
}

export function proxyHealthUrl(): string {
  return proxyBaseUrl().replace(/\/v1\/?$/, "") + "/__health";
}

export function withProxyHeadersFor(baseUrl: string, init: RequestInit): RequestInit {
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

export function describeCustomEndpoint(baseUrl?: string): string {
  const base = normalizeBaseUrl(baseUrl || "");
  if (!base || base === TOKENHUB_BASE_URL) return "";
  const host = base.replace(/^https?:\/\//, "").split("/")[0];
  return `\n\n自建 / 局域网地址排查：\n1) 手机必须和运行服务的机器在同一个 EasyTier 虚拟网里，电脑能 ping 通 ${host} 才算通；\n2) 服务端要监听 0.0.0.0（不是 127.0.0.1），并确认 ${base}/chat/completions 存在；\n3) http:// 明文地址在 Android release 包里默认被系统禁止，需安装带明文许可的新 APK；\n4) Web 预览已自动走本机代理绕开跨域，无需在服务端配 CORS。`;
}

export function describeFailure(status: number, body: string): string {
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

export async function pingProxy(): Promise<boolean> {
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
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 1
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (init.signal?.aborted) throw lastError ?? new Error("请求已取消");
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      // 用户主动取消时不要重试，否则界面已恢复、请求还在后台跑。
      if (init.signal?.aborted) throw error;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function describeReasoningError(msg: string): string | null {
  if (!/empty reply|answered nothing|spent on reasoning|reasoning.*token|max_tokens|token.*limit|输出预算|推理.*耗/i.test(msg)) return null;
  return (
    "模型把输出预算全花在推理上，没吐出正文，上游返回了空回复。这不是连接问题，测试连接能过很正常。\n" +
    "处理：① 高级设置把「最大输出 token」调大到 8192（服务端自己也可能有上限，要在服务端一起调）；" +
    "② 换非推理型 / 普通模型；③ 关掉「工具调用」减少推理负担；④ 问题问得更具体。"
  );
}

export function isVisionRefusal(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 180) return false;
  if (/图中可见|图片中|识别结果|可记录数据|kcal|热量|蛋白|碳水|脂肪|食物|体重|体脂|动作|组数|\d+\s*g/i.test(t)) return false;
  return /看不到(这张)?(图片|图)|无法(查看|看到|读取|访问|识别)(这张)?(图片|图)|读不到图片|没有收到图片|未提供图片|不支持图片|无法访问图片|cannot (see|view|access) (the )?image|no image (was )?(provided|received)|unable to (see|view|process) (the )?image/i.test(t);
}

export async function diagnoseNetworkError(msg: string, baseUrl?: string): Promise<string> {
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
