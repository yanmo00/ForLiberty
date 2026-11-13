// 仅用于「浏览器 Web 预览」的本机反向代理。
// 原因：aigw.telecomjs.com 对 OPTIONS 预检也要求 Key 鉴权，且不返回任何 CORS 头，
//       浏览器里带 Authorization 的跨域 POST 会被同源策略拦掉（真机 App 不受影响）。
// 安全：只监听 127.0.0.1；上游 host 写死，不接受请求里的任意地址；
//       Key 只在内存里透传，不打印、不落盘、不写日志。
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.TOKENHUB_PROXY_PORT || 8082);
const UPSTREAM = "https://aigw.telecomjs.com";
// 只放行本机任意端口的预览页面，不对外开放
const ALLOWED_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
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

  let body;
  try {
    body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
  } catch {
    res.writeHead(413).end("body too large");
    return;
  }

  try {
    // 上游 host 写死，req.url 只当路径用，防 SSRF
    const target = new URL(UPSTREAM + req.url);
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });
    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json";
    res.writeHead(upstream.status, { "Content-Type": contentType });
    res.end(text);
    // 日志只有方法 / 路径 / 状态码，绝对不含 Key 或正文
    console.log(`${req.method} ${req.url} -> ${upstream.status}`);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `代理连不上智云网关：${err.message}` } }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`TokenHub 本机代理已启动：http://${HOST}:${PORT}  ->  ${UPSTREAM}`);
  console.log("只监听本机，不对外开放；关闭终端即停止。");
});
