// 智云 TokenHub 官方接入参数（来源：附件3《4步玩转 TokenHub》）
// 地址和模型名是公开信息，可以进仓库；API Key 永远不写在这里。
export const TOKENHUB_CONSOLE_URL = "https://token.telecomjs.com/";
export const TOKENHUB_BASE_URL = "https://aigw.telecomjs.com/v1";
// 教程「模型广场」图例中的模型名，只是示例 ID；真实可用 ID 以模型广场 / GET /v1/models 为准。
export const TOKENHUB_DEFAULT_MODEL = "qwen3.7-max";
// 高级设置里「视觉模型」输入框的示例占位符，只是常见命名，不代表网关一定提供。
// 真实 ID 请用页面里的「查模型名」从 /v1/models 拉取。
export const TOKENHUB_VISION_MODEL_EXAMPLE = "qwen-vl-max";
// Web 预览专用：网关不返回 CORS 头，浏览器直连必被拦，改走本机同源代理。
// 真机 App 直连官方域名，不经过这里。
export const TOKENHUB_WEB_PROXY_URL = "http://127.0.0.1:8082/v1";

// 用户手填地址时可能带尾斜杠，代码会再拼 /chat/completions，先去掉。
export function normalizeBaseUrl(url: string): string {
  return (url || TOKENHUB_BASE_URL).trim().replace(/\/+$/, "");
}
