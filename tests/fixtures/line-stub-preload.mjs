// 測試用的 preload：被測服務（子行程）裡的 fetch 只允許打 api.line.me（LINE）與 api.openai.com（OCR），
// 都回假回應並把請求記到 LINE_STUB_LOG；其他任何主機一律丟錯，確保測試不會連到外網、更不會真的打 LINE 或 OpenAI。
import { appendFileSync } from "node:fs";

const logFile = process.env.LINE_STUB_LOG;

/** OCR 的假回應：OpenAI chat/completions 的格式，content 是辨識出來的欄位（JSON 字串）。 */
const OCR_REPLY = {
  choices: [
    {
      message: {
        content: JSON.stringify({ barcode: "1801080204", productName: "第五代溫灸刷毛圓領發熱衣", gender: "女", color: "經典黑", size: "L" }),
      },
    },
  ],
};

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const isLine = url.startsWith("https://api.line.me/");
  const isOpenAi = url === "https://api.openai.com/v1/chat/completions";
  if (!isLine && !isOpenAi) throw new Error(`測試不允許連外網：${url}`);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  if (logFile) {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    appendFileSync(
      logFile,
      `${JSON.stringify({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        authorization: headers.authorization,
        // OCR 請求帶整張圖片的 base64，只記模型名稱，免得 log 肥大
        body: isOpenAi ? { model: body?.model, messageCount: Array.isArray(body?.messages) ? body.messages.length : 0 } : body,
      })}\n`,
    );
  }
  if (isOpenAi) {
    return new Response(JSON.stringify(OCR_REPLY), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.endsWith("/summary")) {
    return new Response(JSON.stringify({ groupName: "真實行程測試群組" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
