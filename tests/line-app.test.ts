import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BOX_CLOSED_RATE_LIMIT_MAX, createApp, LINE_WEBHOOK_RATE_LIMIT_MAX, OCR_RATE_LIMIT_MAX, SAVE_RATE_LIMIT_MAX } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import {
  createCapturingLogger,
  createFetchMock,
  jsonResponse,
  makeCredentials,
  signLineBody,
  TEST_GROUP_ID,
  TEST_LINE_SECRET,
  TEST_LINE_TOKEN,
  type MockHandler,
} from "./helpers.js";
import { cleanupTempDirs, createAuthFixture, type AuthFixture } from "./settings-helpers.js";

const creds = makeCredentials();
const LINE_ENV = {
  LINE_CHANNEL_ACCESS_TOKEN: TEST_LINE_TOKEN,
  LINE_GROUP_ID: TEST_GROUP_ID,
  LINE_CHANNEL_SECRET: TEST_LINE_SECRET,
};
const PUSH_URL = "https://api.line.me/v2/bot/message/push";
const REPLY_URL = "https://api.line.me/v2/bot/message/reply";
/** 注入的「現在」：2026-10-05 15:20（台北）。 */
const NOW_MS = Date.parse("2026-10-05T07:20:00.000Z");

// 全站登入之後，OCR／存檔／關箱通知都要登入（任一角色）：整個測試檔共用一個有一般使用者帳號的設定檔 store 與登入標頭。
// LINE webhook 仍然是公開的（靠簽章驗證），所以 post() 對它不帶登入資訊。
let auth: AuthFixture;
beforeAll(async () => {
  auth = await createAuthFixture({ name: "王小明" });
});
afterAll(cleanupTempDirs);

function makeApp(overrides: { env?: Record<string, string>; now?: () => number; noStore?: boolean } = {}) {
  const log = createCapturingLogger();
  const app = createApp({
    env: loadEnv({
      OPENAI_API_KEY: "test-openai-key-123",
      GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: creds.base64,
      ...overrides.env,
    }),
    indexHtml: "<!DOCTYPE html><html><body>測試頁</body></html>",
    log,
    sleep: vi.fn(async () => undefined),
    now: overrides.now ?? (() => NOW_MS),
    ...(overrides.noStore ? {} : { settings: auth.store }),
  });
  return { app, log };
}

type TestApp = ReturnType<typeof createApp>;

async function post(app: TestApp, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(path === "/api/line/webhook" ? {} : auth.headers), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 以全域 stub 的方式 mock fetch（與正式程式碼一樣走 globalThis.fetch），回傳記錄到的呼叫。 */
function stubFetch(handler: MockHandler) {
  const { mock, calls } = createFetchMock(handler);
  vi.stubGlobal("fetch", mock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const item = (overrides: Record<string, unknown> = {}) => ({
  barcode: "1801080204",
  productName: "第五代溫灸刷毛圓領發熱衣",
  gender: "女",
  color: "經典黑",
  size: "L",
  qty: 3,
  ...overrides,
});

const boxBody = (overrides: Record<string, unknown> = {}) => ({
  boxId: "BOX-001",
  closedAt: "2026-10-05T07:20:00.000Z",
  items: [item(), item({ barcode: "1801472364", productName: "搖粒絨極暖衝鋒褲", gender: "", color: "星夜黑", size: "XL", qty: 2 })],
  total: 2,
  successCount: 2,
  failedCount: 0,
  ...overrides,
});

/** 取出推播呼叫的 body。 */
function pushed(calls: Array<{ body?: string }>) {
  return JSON.parse(calls[0]!.body!) as { to: string; messages: Array<{ type: string; text: string }> };
}

describe("POST /api/box-closed", () => {
  it("LINE 未設定：回 {success:true,notified:false,reason:'not_configured'}，不呼叫任何外部服務、不寫 log", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app, log } = makeApp();
    const res = await post(app, "/api/box-closed", boxBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, notified: false, reason: "not_configured" });
    expect(calls).toHaveLength(0);
    expect(log.lines).toEqual([]);
  });

  it.each([
    ["只有 token", { LINE_CHANNEL_ACCESS_TOKEN: TEST_LINE_TOKEN }],
    ["只有群組 ID", { LINE_GROUP_ID: TEST_GROUP_ID }],
    ["只有 secret（secret 只給 webhook 驗簽用）", { LINE_CHANNEL_SECRET: TEST_LINE_SECRET }],
  ])("設定不完整（%s）：視同未設定", async (_name, env) => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ env });
    const res = await post(app, "/api/box-closed", boxBody());
    expect(await res.json()).toEqual({ success: true, notified: false, reason: "not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("設定好：推播到群組，回 {success:true,notified:true}；請求的 URL、標頭、to 與訊息文字都正確", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app, log } = makeApp({ env: LINE_ENV });
    const res = await post(app, "/api/box-closed", boxBody());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, notified: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(PUSH_URL);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(pushed(calls)).toEqual({
      to: TEST_GROUP_ID,
      messages: [
        {
          type: "text",
          text: [
            "📦 箱號 BOX-001 已完成",
            "共 2 種商品、5 件",
            "操作：王小明", // 登入者的姓名（不是前端送的）
            "已同步 2/2 筆到商品主檔 ✓",
            "明細：",
            "1801080204 第五代溫灸刷毛圓領發熱衣(女-經典黑L) ×3",
            "1801472364 搖粒絨極暖衝鋒褲(星夜黑XL) ×2",
            "時間：2026-10-05 15:20",
          ].join("\n"),
        },
      ],
    });
    expect(log.lines).toEqual([]); // 成功時不寫 log
  });

  it("部分失敗：訊息改成警告文案", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ env: LINE_ENV });
    await post(app, "/api/box-closed", boxBody({ total: 12, successCount: 10, failedCount: 2 }));
    const lines = pushed(calls).messages[0]!.text.split("\n");
    expect(lines[2]).toBe("操作：王小明");
    expect(lines[3]).toBe("⚠️ 同步 10/12 筆，2 筆失敗，請查核商品主檔");
  });

  it("操作者來自登入的 session：前端送來的 operator／操作者欄位一律忽略；換一位登入者，訊息就換成那位的姓名；姓名裡的換行與控制字元會被壓成一行", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ env: LINE_ENV });
    await post(app, "/api/box-closed", boxBody({ operator: "假冒的人", 操作者: "另一個假冒" }));
    expect(pushed(calls).messages[0]!.text.split("\n")[2]).toBe("操作：王小明");
    expect(JSON.stringify(pushed(calls))).not.toContain("假冒");

    const other = await createAuthFixture({ name: "李\n四", email: "lee@example.test" });
    const calls2 = stubFetch(() => jsonResponse({}));
    const app2 = createApp({
      env: loadEnv({ OPENAI_API_KEY: "x", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: creds.base64, ...LINE_ENV }),
      indexHtml: "x",
      log: createCapturingLogger(),
      sleep: vi.fn(async () => undefined),
      now: () => NOW_MS,
      settings: other.store,
    });
    await post(app2, "/api/box-closed", boxBody(), other.headers);
    const lines = pushed(calls2).messages[0]!.text.split("\n");
    expect(lines[2]).toBe("操作：李 四");
    expect(lines).toHaveLength(pushed(calls).messages[0]!.text.split("\n").length); // 沒有多出一行
  });

  it("沒有 closedAt：時間用伺服器現在的台北時間（注入的 now）", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ env: LINE_ENV, now: () => Date.parse("2026-12-31T16:05:00.000Z") });
    await post(app, "/api/box-closed", boxBody({ closedAt: undefined }));
    expect(pushed(calls).messages[0]!.text.split("\n").at(-1)).toBe("時間：2027-01-01 00:05");
  });

  it("明細超過 30 種：只列 30 行，寫「…另有 k 種」", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ env: LINE_ENV });
    const items = Array.from({ length: 35 }, (_, i) => item({ barcode: `B${i + 1}`, productName: `品${i + 1}`, gender: "", color: "", size: "", qty: 1 }));
    await post(app, "/api/box-closed", boxBody({ items, total: 35, successCount: 35 }));
    const lines = pushed(calls).messages[0]!.text.split("\n");
    expect(lines.filter((l) => l.endsWith(" ×1"))).toHaveLength(30);
    expect(lines.at(-2)).toBe("…另有 5 種");
    expect(lines[1]).toBe("共 35 種商品、35 件");
  });

  it("訊息超過 4500 字：先砍明細行數，整則 ≤ 4500", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ env: LINE_ENV });
    const items = Array.from({ length: 30 }, (_, i) =>
      item({ barcode: String(i).padEnd(200, "0"), productName: "品".repeat(200), gender: "男".repeat(200), color: "色".repeat(200), size: "S".repeat(200), qty: 9999 }),
    );
    const res = await post(app, "/api/box-closed", boxBody({ items, total: 30, successCount: 30 }));
    expect(await res.json()).toEqual({ success: true, notified: true });
    const text = pushed(calls).messages[0]!.text;
    expect(text.length).toBeLessThanOrEqual(4500);
    expect(text.split("\n").at(-1)).toBe("時間：2026-10-05 15:20");
    expect(text).toMatch(/\n…另有 \d+ 種\n時間：/);
  });

  it.each([
    [401, "LINE channel access token 無效或已過期"],
    [400, "群組 ID 無效，或機器人不在該群組裡"],
    [403, "群組 ID 無效，或機器人不在該群組裡"],
    [429, "已達 LINE 推播額度或速率限制"],
    [500, "LINE 回應 HTTP 500"],
  ])("LINE 回 %i：仍回 200，notified:false／push_failed 與簡短原因；不重試；log 有狀態碼、不含 token", async (status, error) => {
    const calls = stubFetch(() => jsonResponse({ message: `LINE 的原始錯誤 ${TEST_LINE_TOKEN}` }, status));
    const { app, log } = makeApp({ env: LINE_ENV });
    const res = await post(app, "/api/box-closed", boxBody());

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ success: true, notified: false, reason: "push_failed", error });
    expect(text).not.toContain(TEST_LINE_TOKEN);
    expect(text).not.toContain("LINE 的原始錯誤");
    expect(calls).toHaveLength(1); // 不重試
    const logged = log.lines.join("\n");
    expect(logged).toContain(`HTTP ${status}`);
    expect(logged).not.toContain(TEST_LINE_TOKEN);
  });

  it("連線錯誤或逾時：仍回 200，push_failed；log 不含 token", async () => {
    const calls = stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const { app, log } = makeApp({ env: LINE_ENV });
    const res = await post(app, "/api/box-closed", boxBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, notified: false, reason: "push_failed", error: "連線 LINE 失敗或逾時" });
    expect(calls).toHaveLength(1);
    expect(log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);
  });

  it("LINE 失敗不影響存檔：同一個 app 的 /api/save 照常運作", async () => {
    stubFetch((call) => (call.url === PUSH_URL ? jsonResponse({}, 500) : jsonResponse({}, 200)));
    const { app } = makeApp({ env: LINE_ENV });
    await post(app, "/api/box-closed", boxBody());
    const saved = await post(app, "/api/save", {});
    expect(saved.status).toBe(400); // 空的存檔內容被輸入驗證擋下（與 LINE 無關），不是 5xx
  });

  const invalid: Array<[string, unknown]> = [
    ["缺少 boxId", boxBody({ boxId: undefined })],
    ["boxId 是空字串", boxBody({ boxId: "" })],
    ["boxId 超過 100 字", boxBody({ boxId: "箱".repeat(101) })],
    ["items 不是陣列", boxBody({ items: "x" })],
    ["items 超過 500 筆", boxBody({ items: Array.from({ length: 501 }, () => item()) })],
    ["文字欄位超過 200 字", boxBody({ items: [item({ productName: "字".repeat(201) })] })],
    ["qty 是 0", boxBody({ items: [item({ qty: 0 })] })],
    ["qty 超過 9999", boxBody({ items: [item({ qty: 10000 })] })],
    ["qty 不是整數", boxBody({ items: [item({ qty: 2.5 })] })],
    ["total 是負數", boxBody({ total: -1 })],
    ["successCount 不是整數", boxBody({ successCount: 1.5 })],
    ["缺少 failedCount", boxBody({ failedCount: undefined })],
    ["請求內容是陣列", []],
    ["請求內容不是 JSON", "這不是 JSON"],
  ];
  it.each(invalid)("輸入不正確回 400 {success:false,error}，不推播：%s", async (_name, body) => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ env: LINE_ENV });
    const res = await post(app, "/api/box-closed", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false });
    expect(calls).toHaveLength(0);
  });

  it("缺少 qty 當 1；items 可以是空陣列", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ env: LINE_ENV });
    await post(app, "/api/box-closed", boxBody({ items: [{ barcode: "123", productName: "A" }], total: 1, successCount: 1 }));
    expect(pushed(calls).messages[0]!.text).toContain("123 A ×1");
    const empty = await post(app, "/api/box-closed", boxBody({ items: [], total: 0, successCount: 0 }));
    expect(await empty.json()).toEqual({ success: true, notified: true });
  });

  it("GET /api/box-closed → 405", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/box-closed");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  describe("限流：每 IP 每分鐘 60 次，有自己的桶", () => {
    it("第 61 次回 429（含 Retry-After）；換 IP 不受影響", async () => {
      const { app } = makeApp();
      const ip = (address: string) => ({ "x-forwarded-for": address });
      for (let i = 0; i < BOX_CLOSED_RATE_LIMIT_MAX; i++) {
        expect((await post(app, "/api/box-closed", {}, ip("203.0.113.1"))).status).toBe(400); // 通過限流，被輸入驗證擋下
      }
      const limited = await post(app, "/api/box-closed", {}, ip("203.0.113.1"));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect(await limited.json()).toMatchObject({ success: false });
      expect((await post(app, "/api/box-closed", {}, ip("203.0.113.2"))).status).toBe(400);
      expect(BOX_CLOSED_RATE_LIMIT_MAX).toBe(60);
    });

    it("與 OCR、存檔、webhook 的額度互不影響（雙向）", async () => {
      const { app } = makeApp({ env: LINE_ENV });
      const ip = { "x-forwarded-for": "203.0.113.5" };
      // 關箱通知額度用完 → 其他三個桶都還有
      for (let i = 0; i <= BOX_CLOSED_RATE_LIMIT_MAX; i++) await post(app, "/api/box-closed", {}, ip);
      expect((await post(app, "/api/box-closed", {}, ip)).status).toBe(429);
      expect((await post(app, "/api/ocr", {}, ip)).status).toBe(400);
      expect((await post(app, "/api/save", {}, ip)).status).toBe(400);
      expect((await post(app, "/api/line/webhook", "{}", { ...ip, "x-line-signature": "x" })).status).toBe(401);

      // OCR 額度用完、存檔額度用完 → 關箱通知不受影響（另一個 IP 以便獨立計算）
      const ip2 = { "x-forwarded-for": "203.0.113.6" };
      for (let i = 0; i <= OCR_RATE_LIMIT_MAX; i++) await post(app, "/api/ocr", {}, ip2);
      for (let i = 0; i <= SAVE_RATE_LIMIT_MAX; i++) await post(app, "/api/save", {}, ip2);
      expect((await post(app, "/api/ocr", {}, ip2)).status).toBe(429);
      expect((await post(app, "/api/save", {}, ip2)).status).toBe(429);
      expect((await post(app, "/api/box-closed", {}, ip2)).status).toBe(400);
    });
  });
});

describe("POST /api/line/webhook（取得群組 ID 用）", () => {
  const groupSource = { type: "group", groupId: TEST_GROUP_ID, userId: "U0123456789abcdef0123456789abcdef" };
  const events = (...list: unknown[]) => JSON.stringify({ destination: "Uxxx", events: list });
  /** 帶正確簽章送出 webhook。 */
  const send = (app: TestApp, body: string | Uint8Array, secret = TEST_LINE_SECRET) =>
    app.request("/api/line/webhook", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "x-line-signature": signLineBody(body, secret) },
      body: body as RequestInit["body"],
    });
  const replyCall = (calls: Array<{ url: string; body?: string }>) => JSON.parse(calls.find((c) => c.url === REPLY_URL)!.body!) as { replyToken: string; messages: Array<{ text: string }> };

  it("沒有設定 LINE_CHANNEL_SECRET：回 503，不處理任何事件", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ noStore: true, env: { LINE_CHANNEL_ACCESS_TOKEN: TEST_LINE_TOKEN, LINE_GROUP_ID: TEST_GROUP_ID } });
    const body = events({ type: "join", replyToken: "r", source: groupSource });
    const headerVariants: Array<Record<string, string>> = [{}, { "x-line-signature": signLineBody(body) }];
    for (const headers of headerVariants) {
      const res = await app.request("/api/line/webhook", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ success: false });
    }
    expect(calls).toHaveLength(0);
  });

  it("沒有簽章標頭：401", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ noStore: true, env: LINE_ENV });
    const res = await app.request("/api/line/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: events({ type: "join", replyToken: "r", source: groupSource }) });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ success: false });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["簽章是用別的 secret 算的", (body: string) => signLineBody(body, "another-secret")],
    ["簽章是別的內容的", () => signLineBody("別的內容")],
    ["簽章亂寫", () => "not-a-real-signature"],
    ["簽章是空字串", () => ""],
  ])("簽章錯誤回 401 且不處理事件：%s", async (_name, sign) => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ noStore: true, env: LINE_ENV });
    const body = events({ type: "join", replyToken: "r", source: groupSource });
    const res = await post(app, "/api/line/webhook", body, { "x-line-signature": sign(body) });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("簽章對、內容被改過：401", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ noStore: true, env: LINE_ENV });
    const body = events({ type: "join", replyToken: "r", source: groupSource });
    const res = await post(app, "/api/line/webhook", body + " ", { "x-line-signature": signLineBody(body) });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("正確簽章的 join 事件：回 200，並用 reply API 回覆「已加入」與正確的群組 ID（帶 token 與 replyToken），log 有一行事件記錄", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app, log } = makeApp({ noStore: true, env: LINE_ENV });
    const res = await send(app, events({ type: "join", replyToken: "reply-token-join", source: groupSource }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(REPLY_URL);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    expect(replyCall(calls)).toEqual({
      replyToken: "reply-token-join",
      messages: [{ type: "text", text: `已加入，此群組 ID：${TEST_GROUP_ID}。請到設定頁（/settings）選用這個群組，或把它設定到 LINE_GROUP_ID。` }],
    });
    expect(log.lines).toContain(`[line] 事件 join 來自 group ${TEST_GROUP_ID}`);
  });

  it.each(["群組ID", "群組 ID", "  群組ID  "])("正確簽章、群組裡有人輸入「%s」：回覆「此群組 ID：C…」", async (text) => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app, log } = makeApp({ noStore: true, env: LINE_ENV });
    const res = await send(app, events({ type: "message", replyToken: "reply-token-msg", source: groupSource, message: { type: "text", id: "1", text } }));
    expect(res.status).toBe(200);
    expect(replyCall(calls)).toEqual({ replyToken: "reply-token-msg", messages: [{ type: "text", text: `此群組 ID：${TEST_GROUP_ID}` }] });
    expect(log.lines).toContain(`[line] 事件 message 來自 group ${TEST_GROUP_ID}`);
  });

  it.each([
    ["群組裡的一般訊息", { type: "message", replyToken: "r", source: groupSource, message: { type: "text", text: "大家早安" } }],
    ["貼圖", { type: "message", replyToken: "r", source: groupSource, message: { type: "sticker" } }],
    ["leave 事件", { type: "leave", source: groupSource }],
    ["個人加好友（follow）", { type: "follow", replyToken: "r", source: { type: "user", userId: "Uabc" } }],
    ["個人對話說「群組ID」", { type: "message", replyToken: "r", source: { type: "user", userId: "Uabc" }, message: { type: "text", text: "群組ID" } }],
  ])("其他事件：回 200、不呼叫 LINE、不寫 log（%s）", async (_name, event) => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app, log } = makeApp({ noStore: true, env: LINE_ENV });
    const res = await send(app, events(event));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(calls).toHaveLength(0);
    expect(log.lines).toEqual([]);
  });

  it("LINE 設定頁的 Verify（空的 events）：200", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ noStore: true, env: LINE_ENV });
    expect((await send(app, JSON.stringify({ destination: "Uxxx", events: [] }))).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("簽章通過但內容不是 JSON：仍回 200（驗證通過一律回 200），不呼叫 LINE", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app, log } = makeApp({ noStore: true, env: LINE_ENV });
    const res = await send(app, "這不是 JSON");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(log.lines.join("\n")).toContain("不是有效的 JSON");
  });

  it("簽章是對「原始位元組」算的：JSON 的空白與鍵順序不同、或含無效 UTF-8 位元組，只要簽章對就通過（不能先解析再重新序列化）", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp({ noStore: true, env: LINE_ENV });
    // 多餘的空白與換行：重新序列化後位元組就不同了
    const spaced = `{ "events" : [ { "source" : { "groupId" : "${TEST_GROUP_ID}", "type" : "group" },\n  "type":"join", "replyToken":"rt" } ] ,\n "destination":"U" }`;
    expect((await send(app, spaced)).status).toBe(200);
    expect(replyCall(calls).replyToken).toBe("rt");

    // 含 0xFF 0xFE（不是合法的 UTF-8）：先 text() 再驗簽會因為替換字元而驗不過
    const raw = Buffer.concat([Buffer.from('{"events":[],"note":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
    expect((await send(app, raw)).status).toBe(200);
  });

  it("沒有設定 token（只有 secret）：回 200，不呼叫 LINE，但 log 有群組 ID 可以取用", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app, log } = makeApp({ noStore: true, env: { LINE_CHANNEL_SECRET: TEST_LINE_SECRET } });
    const res = await send(app, events({ type: "join", replyToken: "r", source: groupSource }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(log.lines).toContain(`[line] 事件 join 來自 group ${TEST_GROUP_ID}`);
    expect(log.lines.join("\n")).toContain("LINE channel access token 未設定");
  });

  it("回覆失敗（LINE 回 400 或連線錯誤）：仍回 200，log 不含 token", async () => {
    stubFetch(() => jsonResponse({ message: `Invalid reply token ${TEST_LINE_TOKEN}` }, 400));
    const bad = makeApp({ noStore: true, env: LINE_ENV });
    const res = await send(bad.app, events({ type: "join", replyToken: "expired", source: groupSource }));
    expect(res.status).toBe(200);
    expect(bad.log.lines.join("\n")).toContain("回覆失敗：HTTP 400");
    expect(bad.log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);

    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const down = makeApp({ noStore: true, env: LINE_ENV });
    expect((await send(down.app, events({ type: "join", replyToken: "r", source: groupSource }))).status).toBe(200);
  });

  it("GET /api/line/webhook → 405", async () => {
    const { app } = makeApp({ noStore: true, env: LINE_ENV });
    expect((await app.request("/api/line/webhook")).status).toBe(405);
  });

  describe("限流：每 IP 每分鐘 120 次，有自己的桶", () => {
    it("第 121 次回 429（含 Retry-After），不影響 OCR、存檔、關箱通知的額度", async () => {
      const { app } = makeApp({ env: LINE_ENV });
      const ip = { "x-forwarded-for": "203.0.113.9" };
      for (let i = 0; i < LINE_WEBHOOK_RATE_LIMIT_MAX; i++) {
        expect((await post(app, "/api/line/webhook", "{}", { ...ip, "x-line-signature": "x" })).status).toBe(401); // 通過限流，簽章不符
      }
      const limited = await post(app, "/api/line/webhook", "{}", { ...ip, "x-line-signature": "x" });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect((await post(app, "/api/ocr", {}, ip)).status).toBe(400);
      expect((await post(app, "/api/save", {}, ip)).status).toBe(400);
      expect((await post(app, "/api/box-closed", {}, ip)).status).toBe(400);
      expect(LINE_WEBHOOK_RATE_LIMIT_MAX).toBe(120);
    });
  });
});

describe("GET /healthz 的 LINE 欄位", () => {
  const health = async (env: Record<string, string>) => {
    const { app } = makeApp({ noStore: true, env });
    const res = await app.request("/healthz");
    return { text: await res.text() };
  };

  it.each([
    ["都沒設定", {}, false, false],
    ["只有 token", { LINE_CHANNEL_ACCESS_TOKEN: TEST_LINE_TOKEN }, false, false],
    ["只有群組 ID", { LINE_GROUP_ID: TEST_GROUP_ID }, false, false],
    ["token 與群組 ID 都有：lineConfigured", { LINE_CHANNEL_ACCESS_TOKEN: TEST_LINE_TOKEN, LINE_GROUP_ID: TEST_GROUP_ID }, true, false],
    ["只有 secret：lineWebhookConfigured", { LINE_CHANNEL_SECRET: TEST_LINE_SECRET }, false, true],
    ["三個都有", LINE_ENV, true, true],
  ])("%s", async (_name, env, lineConfigured, lineWebhookConfigured) => {
    const { text } = await health(env);
    expect(JSON.parse(text)).toMatchObject({ lineConfigured, lineWebhookConfigured });
  });

  it("不回傳任何 LINE 設定的值（token、secret、群組 ID）", async () => {
    const { text } = await health(LINE_ENV);
    for (const secret of [TEST_LINE_TOKEN, TEST_LINE_SECRET, TEST_GROUP_ID]) expect(text).not.toContain(secret);
  });
});
