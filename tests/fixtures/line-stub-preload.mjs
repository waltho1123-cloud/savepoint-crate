// 測試用的 preload：被測服務（子行程）裡的 fetch 只允許打 api.line.me（回假回應並把請求記到 LINE_STUB_LOG），
// 其他任何主機一律丟錯，確保測試不會連到外網、更不會真的打 LINE。
import { appendFileSync } from "node:fs";

const logFile = process.env.LINE_STUB_LOG;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.line.me/")) throw new Error(`測試不允許連外網：${url}`);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  if (logFile) {
    appendFileSync(
      logFile,
      `${JSON.stringify({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        authorization: headers.authorization,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      })}\n`,
    );
  }
  if (url.endsWith("/summary")) {
    return new Response(JSON.stringify({ groupName: "真實行程測試群組" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
