// 仅用于「浏览器 Web 预览」的本机反向代理。
// 原因：官方网关对 OPTIONS 预检也要求 Key 鉴权且不返回 CORS 头；
//       自建 / EasyTier 地址（如 http://10.126.126.1:3425/v1）同样是跨域，
//       多数自建服务也不处理预检，浏览器里带 Authorization 的 POST 一律被同源策略拦掉。
// 真机 App 不受 CORS 影响，直连用户填的地址。
// 安全：默认只监听 127.0.0.1；默认上游写死；自定义上游需带 X-FitLife-Upstream 头，
//       且只允许 http:// 私有网段/本机或 https:// 任意地址，防止被当成公网开放代理；
//       Key 只在内存里透传，不打印、不落盘、不写日志。
import http from "node:http";

// 默认只监听本机；需要手机走局域网预览时用 `npm run dev:lan`（TOKENHUB_PROXY_HOST=0.0.0.0）。
const HOST = process.env.TOKENHUB_PROXY_HOST || "127.0.0.1";
const LAN_MODE = HOST === "0.0.0.0";
const PORT = Number(process.env.TOKENHUB_PROXY_PORT || 8082);
const UPSTREAM = "https://aigw.telecomjs.com";
// 本机模式只放行 localhost 预览页；局域网模式额外放行私有网段，仍不放行公网。
const ALLOWED_ORIGIN = LAN_MODE
  ? /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/
  : /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// 页面里用户手填的 baseUrl 的 origin，例如 http://10.126.126.1:3425。
// 代理只用它拼上游路径（req.url 依旧是 /v1/...），不接受任意 URL 路径。
const UPSTREAM_HEADER = "x-fitlife-upstream";
const PRIVATE_HOST =
  /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

function resolveUpstream(raw) {
  // 没带头 = 官方网关，沿用写死的上游
  if (!raw) return { origin: UPSTREAM, prefix: "" };
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // 明文 http 只允许本机/私网；https 允许任意域名（用户可能用公网自建网关）。
  if (parsed.protocol === "http:" && !PRIVATE_HOST.test(parsed.hostname)) return null;
  // 保留用户地址里的路径前缀（通常是 /v1），页面请求里的 /v1 由它替换。
  return { origin: parsed.origin, prefix: parsed.pathname.replace(/\/+$/, "") };
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-FitLife-Upstream"
  );
  res.setHeader("Access-Control-Max-Age", "600");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      // 图片识别会把 base64 塞进请求体，一张压缩后的照片约 1–6MB；放宽到 20MB。
      // 上游 host 仍写死、只透传必要头，放宽体积不会扩大攻击面。
      if (size > 20 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.url === "/__health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    return;
  }

  // 只转发这三个头，避免把浏览器指纹/网关 Cookie 带出去
  const headers = {};
  for (const name of ["authorization", "content-type", "accept"]) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }

  const upstream = resolveUpstream(req.headers[UPSTREAM_HEADER]);
  if (!upstream) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            "自定义上游地址不合法：只支持 http:// 本机或私有网段（10./172.16-31./192.168.），或 https:// 地址。",
        },
      })
    );
    return;
  }

  let body;
  try {
    body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
  } catch {
    res.writeHead(413).end("body too large");
    return;
  }

  try {
    // 上游只接受校验过的 origin + 用户地址里的路径前缀；req.url 只当接口路径用，防 SSRF。
    // 页面请求固定是 /v1/chat/completions 或 /v1/models，有前缀时把开头的 /v1 换成用户前缀。
    const path = upstream.prefix ? req.url.replace(/^\/v1/, "") : req.url;
    const target = new URL(upstream.origin + upstream.prefix + path);
    const upstreamResponse = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });
    const text = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type") || "application/json";
    res.writeHead(upstreamResponse.status, { "Content-Type": contentType });
    res.end(text);
    // 日志只有方法 / 路径 / 上游主机名 / 状态码，绝对不含 Key 或正文
    console.log(`${req.method} ${req.url} -> ${new URL(upstream.origin).host} ${upstreamResponse.status}`);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `本机代理连不上上游 ${new URL(upstream.origin).host}：${err.message}。检查 EasyTier 组网是否连通、服务是否监听 0.0.0.0 而非 127.0.0.1、端口是否开放。`,
        },
      })
    );
  }
});

// 端口被占时别静默退出：concurrently 会把预览一起停掉，比「代理没了但页面还在、一直报跨域」好排查。
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用：可能另一个代理还在跑。关掉旧终端，或换端口 TOKENHUB_PROXY_PORT=8083 并同步改页面里的代理地址。`);
  } else {
    console.error(`代理启动失败：${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`本机代理已启动：http://${HOST}:${PORT}  ->  默认 ${UPSTREAM}`);
  console.log("自定义上游：X-FitLife-Upstream 头可指定 http:// 私网/本机（EasyTier 等）或 https:// 地址。");
  console.log(LAN_MODE ? "局域网模式：仅放行私有网段来源；关闭终端即停止。" : "只监听本机，不对外开放；关闭终端即停止。");
});
