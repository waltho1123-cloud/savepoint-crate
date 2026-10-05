import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp, MAX_BODY_BYTES, OCR_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, SAVE_RATE_LIMIT_MAX, SETTINGS_API_RATE_LIMIT_MAX } from "../src/app.js";
import { APPEND_WINDOW_MAX, APPEND_WINDOW_MS } from "../src/sheets.js";
import { loadEnv } from "../src/env.js";
import { buildOcrRequestBody, parseImageInput } from "../src/ocr.js";
import {
  createCapturingLogger,
  createFetchMock,
  createGoogleMock,
  FULL_HEADER,
  GOOGLE_TOKEN_URL,
  jsonResponse,
  makeCredentials,
  SAMPLE_IMAGE,
  SHEETS_BASE,
  TEST_ACCESS_TOKEN,
  type MockHandler,
} from "./helpers.js";
import { cleanupTempDirs, createAuthFixture, type AuthFixture } from "./settings-helpers.js";

const creds = makeCredentials();
const INDEX_HTML = "<!DOCTYPE html><html><head><title>IPAS 測試頁</title></head><body>原本的 index.html</body></html>";

// 全站登入之後，OCR／存檔／關箱通知都要登入（任一角色）：整個測試檔共用一個有一般使用者帳號的設定檔 store 與登入標頭。
// 不需要登入的測試（healthz 的欄位、404 等）用 makeApp({ noStore: true })：沒有資料目錄，行為和以前一樣。
let auth: AuthFixture;
beforeAll(async () => {
  auth = await createAuthFixture();
});
afterAll(cleanupTempDirs);

function makeApp(overrides: { env?: Record<string, string>; now?: () => number; sleep?: (ms: number) => Promise<void>; noStore?: boolean } = {}) {
  const log = createCapturingLogger();
  const sleep = overrides.sleep ?? vi.fn(async () => undefined);
  const app = createApp({
    env: loadEnv({
      OPENAI_API_KEY: "test-openai-key-123",
      GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: creds.base64, // Zeabur 上實際存放的格式：base64 編碼的 JSON
      ...overrides.env,
    }),
    indexHtml: INDEX_HTML,
    log,
    sleep,
    now: overrides.now,
    ...(overrides.noStore ? {} : { settings: auth.store }),
  });
  return { app, log, sleep };
}

/** 帶著登入 cookie 與 X-Requested-With 的 POST（要測沒登入的情況，把 cookie 與標頭蓋掉，或用 postAnonymous）。 */
async function post(app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth.headers, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function postAnonymous(app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 以全域 stub 的方式 mock fetch（與正式程式碼一樣走 globalThis.fetch）。 */
function stubFetch(handler: MockHandler) {
  const { mock, calls } = createFetchMock(handler);
  vi.stubGlobal("fetch", mock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("靜態頁", () => {
  it.each(["/", "/index.html"])("GET %s（已登入）回 index.html，Cache-Control: no-cache", async (path) => {
    const { app } = makeApp();
    const res = await app.request(path, { headers: { cookie: auth.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it.each(["/", "/index.html"])("GET %s（沒登入）302 導向 /login?next=/，不回 index.html", async (path) => {
    const { app } = makeApp();
    const res = await app.request(path);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=/");
    expect(await res.text()).not.toContain("原本的 index.html");
  });

  it("未知路徑回 404；/api/ 底下回 JSON 404", async () => {
    const { app } = makeApp();
    expect((await app.request("/nope")).status).toBe(404);
    const api = await app.request("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toMatchObject({ success: false });
  });
});

describe("GET /healthz", () => {
  it("憑證是 base64 JSON（Zeabur 實際格式）：回報已設定與服務帳號 email", async () => {
    const { app } = makeApp({ noStore: true });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      openaiConfigured: true,
      sheetsConfigured: true,
      serviceAccountEmail: creds.email,
      clientIp: "unknown", // app.request 沒有真實連線，也沒帶 X-Forwarded-For
      requestIsHttps: false, // app.request 的網址是 http://localhost，也沒帶 X-Forwarded-Proto
      dataDirWritable: false, // 沒有注入 settings store＝資料目錄不可用（設定頁相關的測試見 settings-*.test.ts）
      dataDirMounted: null,
      adminConfigured: false,
      adminCount: 0,
      accountCount: 0,
      legacyAdminPending: false,
      lineConfigured: false,
      lineWebhookConfigured: false,
      lineSource: null,
    });
  });

  it("憑證是原始 JSON：同樣解析出 email", async () => {
    const { app } = makeApp({ noStore: true, env: { GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: creds.json } });
    const body = (await (await app.request("/healthz")).json()) as { serviceAccountEmail: string | null; sheetsConfigured: boolean };
    expect(body.sheetsConfigured).toBe(true);
    expect(body.serviceAccountEmail).toBe(creds.email);
  });

  it("沒有設定憑證：serviceAccountEmail 為 null、sheetsConfigured 為 false", async () => {
    const { app } = makeApp({ noStore: true, env: { GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "" } });
    expect(await (await app.request("/healthz")).json()).toEqual({
      ok: true,
      openaiConfigured: true,
      sheetsConfigured: false,
      serviceAccountEmail: null,
      clientIp: "unknown",
      requestIsHttps: false,
      dataDirWritable: false,
      dataDirMounted: null,
      adminConfigured: false,
      adminCount: 0,
      accountCount: 0,
      legacyAdminPending: false,
      lineConfigured: false,
      lineWebhookConfigured: false,
      lineSource: null,
    });
  });

  it.each(["x", "壞掉的字串", Buffer.from("not json").toString("base64"), JSON.stringify({ client_email: "a@b.c" })])(
    "憑證解析失敗（%s）：serviceAccountEmail 為 null、sheetsConfigured 為 false",
    async (bad) => {
      const { app } = makeApp({ noStore: true, env: { GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: bad } });
      const body = (await (await app.request("/healthz")).json()) as Record<string, unknown>;
      expect(body.serviceAccountEmail).toBeNull();
      expect(body.sheetsConfigured).toBe(false);
    },
  );

  it("沒有 OpenAI 金鑰：openaiConfigured 為 false", async () => {
    const { app } = makeApp({ noStore: true, env: { OPENAI_API_KEY: "" } });
    expect(((await (await app.request("/healthz")).json()) as { openaiConfigured: boolean }).openaiConfigured).toBe(false);
  });

  describe("clientIp（與限流用的同一個判斷：X-Forwarded-For 由右往左取第一個公開位址，沒有就退回連線位址）", () => {
    const clientIp = async (app: ReturnType<typeof createApp>, headers: Record<string, string> = {}, env?: unknown) =>
      ((await (await app.request("/healthz", { headers }, env)).json()) as { clientIp: string }).clientIp;
    // @hono/node-server 會把 Node 的 IncomingMessage 放在 c.env.incoming；這裡模擬真實連線位址
    const connection = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

    it("帶 X-Forwarded-For：回公開位址（最右邊那個，左邊客戶端自填的不採信）", async () => {
      const { app } = makeApp({ noStore: true });
      expect(await clientIp(app, { "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
      expect(await clientIp(app, { "x-forwarded-for": "198.51.100.1, 203.0.113.9" })).toBe("203.0.113.9");
      // 代理鏈把內部位址附加在右邊時，略過私有位址
      expect(await clientIp(app, { "x-forwarded-for": "203.0.113.9, 10.42.0.7, 100.64.0.2" }, connection("10.0.0.1"))).toBe("203.0.113.9");
      expect(await clientIp(app, { "x-forwarded-for": "2001:db8::1" })).toBe("2001:db8::1");
    });

    it("不帶 X-Forwarded-For：回連線位址", async () => {
      const { app } = makeApp({ noStore: true });
      expect(await clientIp(app, {}, connection("198.51.100.7"))).toBe("198.51.100.7");
    });

    it("X-Forwarded-For 整串都是私有位址或格式錯誤：退回連線位址", async () => {
      const { app } = makeApp({ noStore: true });
      expect(await clientIp(app, { "x-forwarded-for": "10.0.0.5, 192.168.1.1" }, connection("172.20.0.3"))).toBe("172.20.0.3");
      expect(await clientIp(app, { "x-forwarded-for": "garbage" }, connection("172.20.0.3"))).toBe("172.20.0.3");
    });

    it("X-Forwarded-For 含 IPv6 zone id（%…）：略過，不會把客戶端給的字串回顯出來", async () => {
      const { app } = makeApp({ noStore: true });
      const forged = "2001:db8::1%aaaa-attacker.controlled:text";
      expect(await clientIp(app, { "x-forwarded-for": forged }, connection("198.51.100.7"))).toBe("198.51.100.7");
      expect(await clientIp(app, { "x-forwarded-for": forged })).toBe("unknown");
    });

    it('什麼都沒有（沒有 X-Forwarded-For、也沒有連線位址）：回 "unknown"', async () => {
      const { app } = makeApp({ noStore: true });
      expect(await clientIp(app)).toBe("unknown");
      expect(await clientIp(app, {}, {})).toBe("unknown");
    });

    it("與限流用同一個判斷：healthz 回報的 IP 就是被計次的那個 IP", async () => {
      const { app } = makeApp({ now: () => 1_000_000 });
      // 用 X-Forwarded-For「203.0.113.20」把 OCR 額度用完
      for (let i = 0; i <= OCR_RATE_LIMIT_MAX; i++) await post(app, "/api/ocr", {}, { "x-forwarded-for": "203.0.113.20" });
      expect((await post(app, "/api/ocr", {}, { "x-forwarded-for": "198.51.100.99, 203.0.113.20" })).status).toBe(429);
      // healthz 對同一組標頭回報的 IP，正是被擋下的那個
      expect(await clientIp(app, { "x-forwarded-for": "198.51.100.99, 203.0.113.20" })).toBe("203.0.113.20");
      // 換一個來源 IP：不受影響，healthz 也回報新的 IP
      expect((await post(app, "/api/ocr", {}, { "x-forwarded-for": "203.0.113.21" })).status).toBe(400);
      expect(await clientIp(app, { "x-forwarded-for": "203.0.113.21" })).toBe("203.0.113.21");
    });
  });

  it("絕不回傳 private_key 或憑證的其他欄位，也不含 OpenAI 金鑰", async () => {
    const { app } = makeApp({ noStore: true });
    const text = await (await app.request("/healthz")).text();
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      "accountCount",
      "adminConfigured",
      "adminCount",
      "clientIp",
      "dataDirMounted",
      "dataDirWritable",
      "legacyAdminPending",
      "lineConfigured",
      "lineSource",
      "lineWebhookConfigured",
      "ok",
      "openaiConfigured",
      "requestIsHttps",
      "serviceAccountEmail",
      "sheetsConfigured",
    ]);
    for (const secret of [
      creds.privateKeyPem,
      "private_key",
      "key-id-should-not-leak",
      "proj-id-should-not-leak",
      "client-id-should-not-leak",
      "test-openai-key-123",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("POST /api/ocr", () => {
  const openAiOk = (content: string) => jsonResponse({ choices: [{ message: { role: "assistant", content } }] });
  const labelJson = '{"barcode":"1801080204","productName":"第五代溫灸刷毛圓領發熱衣","gender":"男女共版","color":"經典黑","size":"L"}';

  it("缺 image → 400 {success:false,error}", async () => {
    const calls = stubFetch(() => openAiOk(labelJson));
    const { app } = makeApp();
    const res = await post(app, "/api/ocr", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "缺少 image 欄位" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["不是 JSON", "這不是 JSON"],
    ["JSON 陣列", "[]"],
    ["JSON null", "null"],
  ])("請求內容格式錯誤（%s）→ 400", async (_name, body) => {
    const { app } = makeApp();
    const res = await post(app, "/api/ocr", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false });
  });

  it("image 格式錯誤（data: 開頭但不是 base64 data URL）→ 400", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/ocr", { image: "data:image/jpeg,AAAA" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "無效的 data URL" });
  });

  it("成功：回 {success:true,data:{barcode,productName,gender,color,size}}，男女共版 → 中性", async () => {
    const calls = stubFetch(() => openAiOk(labelJson));
    const { app } = makeApp();
    const res = await post(app, "/api/ocr", { barcode: "", boxId: "BOX-001", image: SAMPLE_IMAGE });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { barcode: "1801080204", productName: "第五代溫灸刷毛圓領發熱衣", gender: "中性", color: "經典黑", size: "L" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer test-openai-key-123");
    expect(calls[0]!.body).toBe(JSON.stringify(buildOcrRequestBody(parseImageInput(SAMPLE_IMAGE), "gpt-5.6-luna")));
  });

  it("OPENAI_BASE_URL／OPENAI_MODEL 會套用到請求", async () => {
    const calls = stubFetch(() => openAiOk(labelJson));
    const { app } = makeApp({ env: { OPENAI_BASE_URL: "https://ai-hub.example.test/", OPENAI_MODEL: "custom-model" } });
    await post(app, "/api/ocr", { image: SAMPLE_IMAGE });
    expect(calls[0]!.url).toBe("https://ai-hub.example.test/v1/chat/completions");
    expect(JSON.parse(calls[0]!.body!).model).toBe("custom-model");
  });

  it("上游 5xx：重試一次（等 1 秒）後回 502 {success:false,error}", async () => {
    const calls = stubFetch(() => jsonResponse({ error: { type: "server_error", message: "upstream secret detail" } }, 503));
    const { app, sleep } = makeApp();
    const res = await post(app, "/api/ocr", { image: SAMPLE_IMAGE });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).not.toContain("upstream secret detail");
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("上游第一次失敗、第二次成功：回 200", async () => {
    let n = 0;
    const calls = stubFetch(() => (++n === 1 ? jsonResponse({}, 500) : openAiOk(labelJson)));
    const { app } = makeApp();
    const res = await post(app, "/api/ocr", { image: SAMPLE_IMAGE });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("上游回傳無法解析的內容 → 502", async () => {
    stubFetch(() => openAiOk("看不清楚"));
    const { app } = makeApp();
    const res = await post(app, "/api/ocr", { image: SAMPLE_IMAGE });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ success: false });
  });

  it("沒有設定 OPENAI_API_KEY → 503（輸入有效時）；輸入無效仍先回 400", async () => {
    const calls = stubFetch(() => openAiOk(labelJson));
    const { app } = makeApp({ env: { OPENAI_API_KEY: "" } });
    const res = await post(app, "/api/ocr", { image: SAMPLE_IMAGE });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false });
    expect((await post(app, "/api/ocr", {})).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("body 超過 15 MB → 413", async () => {
    const calls = stubFetch(() => openAiOk(labelJson));
    const { app } = makeApp();
    const huge = JSON.stringify({ image: "data:image/jpeg;base64," + "A".repeat(MAX_BODY_BYTES + 1024) });
    const res = await post(app, "/api/ocr", huge);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ success: false });
    expect(calls).toHaveLength(0);
    expect(MAX_BODY_BYTES).toBe(15 * 1024 * 1024);
  });

  it("ReDoS 攻擊字串（含換行的超長 data URL）→ 400，且在 500ms 內回應、不呼叫 OpenAI", async () => {
    const calls = stubFetch(() => openAiOk(labelJson));
    const { app } = makeApp();
    const attack = "data:" + ";base64,".repeat(30_000) + "\nx";
    const started = performance.now();
    const res = await post(app, "/api/ocr", { image: attack });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "無效的 data URL" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(0);
  });

  it("未預期的例外 → 500 通用訊息，不洩漏內部細節", async () => {
    stubFetch(() => jsonResponse({}, 500));
    const { app, log } = makeApp({
      sleep: async () => {
        throw new Error("內部爆炸細節 test-openai-key-123");
      },
    });
    const res = await post(app, "/api/ocr", { image: SAMPLE_IMAGE });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "伺服器內部錯誤" });
    expect(log.lines.join("\n")).toContain("未預期的錯誤");
  });

  it("GET /api/ocr → 405", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/ocr");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("POST /api/save", () => {
  const payload = {
    seqNo: "1",
    date: "2026/10/05",
    boxId: "BOX-001",
    barcode: "1801080204",
    productName: "第五代溫灸刷毛圓領發熱衣",
    gender: "女",
    color: "經典黑",
    size: "L",
    quantity: 2,
    time: "2026-10-05 10:00:00",
  };

  it("成功（憑證為 base64）：回 {success:true,range}，range 取自 values.append 的 updates.updatedRange", async () => {
    const google = createGoogleMock({ updatedRange: "'商品主檔'!A125:K125" });
    vi.stubGlobal("fetch", google.mock);
    const { app } = makeApp();
    const res = await post(app, "/api/save", payload);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, range: "'商品主檔'!A125:K125" });

    const urls = google.calls.map((c) => decodeURIComponent(c.url));
    expect(urls).toEqual([
      GOOGLE_TOKEN_URL,
      `${SHEETS_BASE}/values/'商品主檔'!1:1`,
      `${SHEETS_BASE}/values/'商品主檔'!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    ]);
    const append = google.calls[2]!;
    expect(append.headers.authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(JSON.parse(append.body!).values).toEqual([
      ["1", "2026/10/05", "BOX-001", "1801080204", "第五代溫灸刷毛圓領發熱衣", "女", "經典黑", "L", "第五代溫灸刷毛圓領發熱衣(女-經典黑L)", "2", "2026-10-05 10:00:00"],
    ]);
  });

  it("成功（憑證為原始 JSON）也可運作，且 token 與表頭會被快取", async () => {
    const google = createGoogleMock();
    vi.stubGlobal("fetch", google.mock);
    const { app } = makeApp({ env: { GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: creds.json } });
    expect((await post(app, "/api/save", payload)).status).toBe(200);
    expect((await post(app, "/api/save", payload)).status).toBe(200);
    expect(google.calls.filter((c) => c.url === GOOGLE_TOKEN_URL)).toHaveLength(1);
    expect(google.calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(google.calls.filter((c) => c.url.includes(":append"))).toHaveLength(2);
  });

  it("Sheets 回應拿不到 updatedRange：只回 {success:true}（不含 range 欄位）", async () => {
    vi.stubGlobal("fetch", createGoogleMock({ updatedRange: null }).mock);
    const { app } = makeApp();
    const res = await post(app, "/api/save", payload);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(body).not.toHaveProperty("range");
  });

  it("GOOGLE_SHEET_ID／GOOGLE_SHEET_NAME 會套用到請求", async () => {
    const google = createGoogleMock({ spreadsheetId: "custom-sheet-id" });
    vi.stubGlobal("fetch", google.mock);
    const { app } = makeApp({ env: { GOOGLE_SHEET_ID: "custom-sheet-id", GOOGLE_SHEET_NAME: "我的分頁" } });
    expect((await post(app, "/api/save", payload)).status).toBe(200);
    const sheetUrls = google.calls.filter((c) => c.url !== GOOGLE_TOKEN_URL).map((c) => decodeURIComponent(c.url));
    expect(sheetUrls).toHaveLength(2);
    expect(sheetUrls[0]).toContain("/spreadsheets/custom-sheet-id/values/'我的分頁'!1:1");
    expect(sheetUrls[1]).toContain("/spreadsheets/custom-sheet-id/values/'我的分頁'!A1:append");
  });

  it("表頭缺欄位 → 500 並指出缺哪欄、不寫入", async () => {
    const google = createGoogleMock({ header: FULL_HEADER.filter((name) => name !== "數量") });
    vi.stubGlobal("fetch", google.mock);
    const { app } = makeApp();
    const res = await post(app, "/api/save", payload);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("數量");
    expect(google.calls.some((c) => c.url.includes(":append"))).toBe(false);
  });

  it("表頭順序不同仍寫到正確欄位", async () => {
    const google = createGoogleMock({ header: ["辨識時間", "數量", "合併品名", "尺寸", "顏色", "性別", "品名", "商品編號", "箱號", "日期", "序號"] });
    vi.stubGlobal("fetch", google.mock);
    const { app } = makeApp();
    expect((await post(app, "/api/save", payload)).status).toBe(200);
    const append = google.calls.find((c) => c.url.includes(":append"))!;
    expect(JSON.parse(append.body!).values[0]).toEqual([
      "2026-10-05 10:00:00", "2", "第五代溫灸刷毛圓領發熱衣(女-經典黑L)", "L", "經典黑", "女", "第五代溫灸刷毛圓領發熱衣", "1801080204", "BOX-001", "2026/10/05", "1",
    ]);
  });

  it.each([
    ["不是 JSON", "壞掉"],
    ["JSON 陣列", "[]"],
    ["全空的紀錄", "{}"],
    ["欄位型別不對", JSON.stringify({ barcode: "1", productName: ["x"] })],
  ])("請求內容不正確（%s）→ 400 {success:false,error}", async (_name, body) => {
    const google = createGoogleMock();
    vi.stubGlobal("fetch", google.mock);
    const { app } = makeApp();
    const res = await post(app, "/api/save", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false });
    expect(google.calls).toHaveLength(0);
  });

  it("沒有設定憑證 → 503；憑證無法解析 → 503", async () => {
    const google = createGoogleMock();
    vi.stubGlobal("fetch", google.mock);
    for (const bad of ["", "x"]) {
      const { app } = makeApp({ env: { GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: bad } });
      const res = await post(app, "/api/save", payload);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ success: false });
    }
    expect(google.calls).toHaveLength(0);
  });

  it("Google 回 403（沒分享給服務帳號）→ 500 與可讀訊息；回 5xx → 502", async () => {
    vi.stubGlobal("fetch", createGoogleMock({ headerStatus: 403 }).mock);
    const forbidden = await post(makeApp().app, "/api/save", payload);
    expect(forbidden.status).toBe(500);
    expect(((await forbidden.json()) as { error: string }).error).toContain("分享給服務帳號");

    vi.stubGlobal("fetch", createGoogleMock({ appendStatus: 503 }).mock);
    const unavailable = await post(makeApp().app, "/api/save", payload);
    expect(unavailable.status).toBe(502);
  });

  it("body 超過 15 MB → 413（/api/save 也一樣）", async () => {
    const google = createGoogleMock();
    vi.stubGlobal("fetch", google.mock);
    const { app } = makeApp();
    const res = await post(app, "/api/save", JSON.stringify({ barcode: "1", productName: "字".repeat(MAX_BODY_BYTES) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ success: false });
    expect(google.calls).toHaveLength(0);
  });

  it("連續存檔：前 55 筆不等待，第 56 筆要等一個視窗，之後配額恢復（createApp 有把 now／sleep 傳給 SheetsClient）", async () => {
    const google = createGoogleMock();
    vi.stubGlobal("fetch", google.mock);
    let clock = 1_000_000;
    // 假 sleep 要像真的一樣：讓注入的時鐘前進 ms（睡醒後最舊的那批起始才會離開視窗）
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const { app } = makeApp({ now: () => clock, sleep });
    for (let i = 0; i < APPEND_WINDOW_MAX; i++) {
      expect((await post(app, "/api/save", payload)).status).toBe(200);
    }
    expect(sleep).not.toHaveBeenCalled(); // 55 筆以內全速、不等待

    expect((await post(app, "/api/save", payload)).status).toBe(200); // 第 56 筆：等一個視窗
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(APPEND_WINDOW_MS); // 60_000
    expect(clock).toBe(1_000_000 + APPEND_WINDOW_MS);

    expect((await post(app, "/api/save", payload)).status).toBe(200); // 第 57 筆：視窗已放出名額，不必再等
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("GET /api/save → 405", async () => {
    const { app } = makeApp();
    expect((await app.request("/api/save")).status).toBe(405);
  });
});

describe("登入閘門：OCR、存檔、關箱通知一定要登入（任一角色）並帶 CSRF 標頭；webhook 與 healthz 仍然公開", () => {
  const PROTECTED: Array<[string, unknown]> = [
    ["/api/ocr", { image: SAMPLE_IMAGE }],
    ["/api/save", { seqNo: "1", date: "2026/10/05", boxId: "B1", barcode: "123", productName: "品", quantity: 1, time: "2026-10-05 15:20:00" }],
    ["/api/box-closed", { boxId: "B1", items: [], total: 0, successCount: 0, failedCount: 0 }],
  ];

  it.each(PROTECTED)("POST %s 沒有登入 → 401「請先登入」，不呼叫任何上游服務", async (path, body) => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp();
    for (const headers of [{}, { "x-requested-with": "XMLHttpRequest" }, { cookie: "sp_session=garbage" }, { cookie: "" }] as Array<Record<string, string>>) {
      const res = await postAnonymous(app, path, body, headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(await res.json()).toEqual({ success: false, error: "請先登入" });
    }
    expect(calls).toHaveLength(0);
  });

  it.each(PROTECTED)("POST %s 已登入但沒帶 X-Requested-With（或值不對）→ 403，不呼叫任何上游服務", async (path, body) => {
    const calls = stubFetch(() => jsonResponse({}));
    const { app } = makeApp();
    for (const headers of [{ cookie: auth.cookie }, { cookie: auth.cookie, "x-requested-with": "fetch" }, { cookie: auth.cookie, "x-requested-with": "" }] as Array<Record<string, string>>) {
      const res = await postAnonymous(app, path, body, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toEqual({ success: false, error: "缺少必要的請求標頭" });
    }
    expect(calls).toHaveLength(0);
  });

  it.each(PROTECTED)("POST %s 登入＋標頭齊全就通過閘門（一般使用者與管理員都可以）", async (path, body) => {
    stubFetch((c) => (c.url.includes("api.openai.com") ? jsonResponse({ choices: [{ message: { content: '{"barcode":"1"}' } }] }) : createGoogleMock().mock(c.url, { method: c.method, body: c.body })));
    const { app } = makeApp();
    // 通過閘門之後，結果由各端點自己決定（這裡只確認不是 401／403）
    const user = await post(app, path, body);
    expect([401, 403]).not.toContain(user.status);
    const adminFixture = await createAuthFixture({ role: "admin", email: "boss@example.test" });
    const adminApp = createApp({ env: loadEnv({ OPENAI_API_KEY: "k", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: creds.base64 }), indexHtml: INDEX_HTML, log: createCapturingLogger(), settings: adminFixture.store });
    const admin = await postAnonymous(adminApp, path, body, adminFixture.headers);
    expect([401, 403]).not.toContain(admin.status);
  });

  it("cookie 無效的各種情況都是 401：竄改簽章、過期、帳號被停用、帳號被刪除、重設過密碼（sessionVersion 變了）、別的部署簽的", async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const fixture = await createAuthFixture();
    const mk = () => createApp({ env: loadEnv({ OPENAI_API_KEY: "k", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: creds.base64 }), indexHtml: INDEX_HTML, log: createCapturingLogger(), settings: fixture.store });
    const app = mk();
    const body = { image: SAMPLE_IMAGE };
    const send = (cookie: string) => postAnonymous(app, "/api/ocr", body, { cookie, "x-requested-with": "XMLHttpRequest" });
    const flipped = `${fixture.cookie.slice(0, -2)}${fixture.cookie.endsWith("A") ? "B" : "A"}x`;
    expect((await send(flipped)).status).toBe(401);
    // 簽章對、但帳號狀態變了
    await fixture.store.update((draft) => {
      draft.accounts[0]!.status = "disabled";
    });
    expect((await send(fixture.cookie)).status).toBe(401);
    await fixture.store.update((draft) => {
      draft.accounts[0]!.status = "active";
    });
    expect((await send(fixture.cookie)).status).not.toBe(401); // 啟用回來，舊 cookie 本身仍有效（sessionVersion 沒變）
    await fixture.store.update((draft) => {
      draft.accounts[0]!.sessionVersion = 2;
    });
    expect((await send(fixture.cookie)).status).toBe(401);
    await fixture.store.update((draft) => {
      draft.accounts.splice(0, 1);
    });
    expect((await send(fixture.cookie)).status).toBe(401);
    const other = await createAuthFixture();
    expect((await send(other.cookie)).status).toBe(401); // 別的部署（不同的簽章金鑰）
    expect(calls.map((c) => c.url)).toEqual(["https://api.openai.com/v1/chat/completions"]); // 只有「啟用回來之後仍有效」的那一次真的往上游走
  });

  it("沒登入的請求不會吃掉限流額度：先送一大堆沒登入的，之後登入的人照常可用", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    const ip = { "x-forwarded-for": "203.0.113.55" };
    for (let i = 0; i < OCR_RATE_LIMIT_MAX + 20; i++) expect((await postAnonymous(app, "/api/ocr", {}, ip)).status).toBe(401);
    expect((await post(app, "/api/ocr", {}, ip)).status).toBe(400); // 缺 image：通過閘門與限流，到達處理器
  });

  it("沒登入時 GET 這些端點仍然是 405（方法不對不必先登入）；不存在的 /api 路徑仍是 404", async () => {
    const { app } = makeApp();
    for (const path of ["/api/ocr", "/api/save", "/api/box-closed"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(405);
    }
    expect((await app.request("/api/nope")).status).toBe(404);
  });

  it("LINE webhook 與 /healthz 不需要登入：webhook 靠簽章（簽章不對是 401「簽章驗證失敗」，不是「請先登入」）", async () => {
    const { app } = makeApp({ env: { LINE_CHANNEL_SECRET: "test-line-channel-secret-456" } });
    const hook = await postAnonymous(app, "/api/line/webhook", "{}", { "x-line-signature": "bad" });
    expect(hook.status).toBe(401);
    expect(await hook.json()).toEqual({ success: false, error: "簽章驗證失敗" });
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("沒有資料目錄（沒有地方存帳號）：OCR、存檔、關箱通知回 503 與掛載 Volume 的說明，而不是 401", async () => {
    const { app } = makeApp({ noStore: true });
    for (const [path, body] of PROTECTED) {
      const res = await post(app, path, body);
      expect(res.status, path).toBe(503);
      expect(await res.json()).toEqual({ success: false, error: "請在 Zeabur 掛載 Volume 到 /app/data" });
    }
  });
});

describe("速率限制（OCR 每 IP 每分鐘 60 次、存檔每 IP 每分鐘 600 次，各自獨立計算）", () => {
  const ip = (address: string) => ({ "x-forwarded-for": address });

  it("OCR：第 61 次回 429（含 Retry-After），不同 IP 不受影響", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    for (let i = 0; i < OCR_RATE_LIMIT_MAX; i++) {
      const res = await post(app, "/api/ocr", {}, ip("203.0.113.1"));
      expect(res.status).toBe(400); // 通過限流，被輸入驗證擋下
    }
    const limited = await post(app, "/api/ocr", {}, ip("203.0.113.1"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toMatchObject({ success: false });

    expect((await post(app, "/api/ocr", {}, ip("203.0.113.2"))).status).toBe(400);
    expect(OCR_RATE_LIMIT_MAX).toBe(60);
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("存檔：第 601 次回 429（含 Retry-After），不同 IP 不受影響", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    for (let i = 0; i < SAVE_RATE_LIMIT_MAX; i++) {
      const res = await post(app, "/api/save", {}, ip("203.0.113.7"));
      if (res.status !== 400) throw new Error(`第 ${i + 1} 次存檔請求預期通過限流（被輸入驗證擋成 400），實際 ${res.status}`);
    }
    const limited = await post(app, "/api/save", {}, ip("203.0.113.7"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toMatchObject({ success: false });

    expect((await post(app, "/api/save", {}, ip("203.0.113.8"))).status).toBe(400);
    expect(SAVE_RATE_LIMIT_MAX).toBe(600);
  });

  it("OCR 與存檔各用自己的額度：OCR 用完不影響存檔，存檔用完也不影響 OCR", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });

    // OCR 額度用完 → 存檔不受影響
    for (let i = 0; i <= OCR_RATE_LIMIT_MAX; i++) await post(app, "/api/ocr", {}, ip("203.0.113.3"));
    expect((await post(app, "/api/ocr", {}, ip("203.0.113.3"))).status).toBe(429);
    expect((await post(app, "/api/save", {}, ip("203.0.113.3"))).status).toBe(400);

    // 存檔額度用完 → 另一個 IP 的 OCR 不受影響，同 IP 的 OCR 額度也沒被存檔吃掉
    for (let i = 0; i <= SAVE_RATE_LIMIT_MAX; i++) await post(app, "/api/save", {}, ip("203.0.113.4"));
    expect((await post(app, "/api/save", {}, ip("203.0.113.4"))).status).toBe(429);
    for (let i = 0; i < OCR_RATE_LIMIT_MAX; i++) {
      expect((await post(app, "/api/ocr", {}, ip("203.0.113.4"))).status).toBe(400);
    }
    expect((await post(app, "/api/ocr", {}, ip("203.0.113.4"))).status).toBe(429);
  });

  it("其他 /api/* 路徑（含不存在的；已登入）算進 OCR 的額度，不會吃掉存檔額度", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    const who = { ...auth.headers, ...ip("203.0.113.5") };
    for (let i = 0; i < OCR_RATE_LIMIT_MAX; i++) {
      expect((await app.request("/api/nope", { headers: who })).status).toBe(404);
    }
    expect((await app.request("/api/nope", { headers: who })).status).toBe(429);
    expect((await post(app, "/api/ocr", {}, ip("203.0.113.5"))).status).toBe(429);
    expect((await post(app, "/api/save", {}, ip("203.0.113.5"))).status).toBe(400);
  });

  it("沒登入的請求（/api/me、不存在的路徑…）有自己的「匿名」額度：灌爆它不會讓同一個出口 IP 上已登入的人被 429", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    const address = ip("203.0.113.40");
    const signedIn = { ...auth.headers, ...address };
    // 匿名：不存在的路徑（OCR 那一桶）與 /api/me（設定那一桶）各自用完自己的額度（照樣有限流，不是不設防）
    for (let i = 0; i < OCR_RATE_LIMIT_MAX; i++) expect((await app.request("/api/nope", { headers: address })).status).toBe(404);
    expect((await app.request("/api/nope", { headers: address })).status).toBe(429);
    for (let i = 0; i < SETTINGS_API_RATE_LIMIT_MAX; i++) expect((await app.request("/api/me", { headers: address })).status).toBe(401);
    expect((await app.request("/api/me", { headers: address })).status).toBe(429);
    // 同一個 IP 上已登入的人：OCR 額度與 /api/me 額度都是完整的
    for (let i = 0; i < OCR_RATE_LIMIT_MAX; i++) {
      const res = await post(app, "/api/ocr", {}, address);
      if (res.status !== 400) throw new Error(`已登入的第 ${i + 1} 次 OCR 預期通過限流（輸入驗證 400），實際 ${res.status}`);
    }
    for (let i = 0; i < SETTINGS_API_RATE_LIMIT_MAX; i++) expect((await app.request("/api/me", { headers: signedIn })).status).toBe(200);
    // 已登入的人自己的額度照樣會用完
    expect((await post(app, "/api/ocr", {}, address)).status).toBe(429);
    expect((await app.request("/api/me", { headers: signedIn })).status).toBe(429);
  });

  it("路徑變體落在哪個額度：/api/save（含查詢字串、百分比編碼）算存檔額度；其餘變體算 OCR 額度", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });

    // 其餘變體（都是不存在的路徑，回 404）：用 OCR 額度，不會吃掉存檔額度
    const others = ["/api/save/", "/api/Save", "/api/saveX", "/api/save%2F", "/api/nope"];
    for (let i = 0; i < OCR_RATE_LIMIT_MAX; i++) {
      expect((await app.request(others[i % others.length]!, { headers: { ...auth.headers, ...ip("203.0.113.30") } })).status).toBe(404);
    }
    expect((await post(app, "/api/ocr", {}, ip("203.0.113.30"))).status).toBe(429);
    expect((await post(app, "/api/save", {}, ip("203.0.113.30"))).status).toBe(400); // 存檔額度完全沒被動到

    // 指向 /api/save 的寫法：查詢字串、百分比編碼，都算存檔額度，不會吃掉 OCR 額度
    const saves = ["/api/save?x=1", "/api/%73ave", "/api/save"];
    for (let i = 0; i < SAVE_RATE_LIMIT_MAX; i++) {
      const res = await post(app, saves[i % saves.length]!, {}, ip("203.0.113.31"));
      if (res.status !== 400) throw new Error(`第 ${i + 1} 次（${saves[i % saves.length]}）預期 400，實際 ${res.status}`);
    }
    expect((await post(app, "/api/save", {}, ip("203.0.113.31"))).status).toBe(429);
    expect((await post(app, "/api/ocr", {}, ip("203.0.113.31"))).status).toBe(400); // OCR 額度完全沒被動到
  });

  it("視窗過後恢復（OCR 與存檔都是）", async () => {
    let clock = 1_000_000;
    const { app } = makeApp({ now: () => clock });
    for (let i = 0; i <= OCR_RATE_LIMIT_MAX; i++) await post(app, "/api/ocr", {}, ip("203.0.113.9"));
    for (let i = 0; i <= SAVE_RATE_LIMIT_MAX; i++) await post(app, "/api/save", {}, ip("203.0.113.9"));
    expect((await post(app, "/api/ocr", {}, ip("203.0.113.9"))).status).toBe(429);
    expect((await post(app, "/api/save", {}, ip("203.0.113.9"))).status).toBe(429);
    clock += RATE_LIMIT_WINDOW_MS;
    expect((await post(app, "/api/ocr", {}, ip("203.0.113.9"))).status).toBe(400);
    expect((await post(app, "/api/save", {}, ip("203.0.113.9"))).status).toBe(400);
  });

  it("客戶端自己偽造 X-Forwarded-For 最左邊的值，無法換到新的額度（OCR 與存檔都一樣）", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    for (let i = 0; i < OCR_RATE_LIMIT_MAX; i++) {
      await post(app, "/api/ocr", {}, ip(`198.51.100.${i % 200}, 203.0.113.10`)); // 代理附加的真實 IP 在最右邊
    }
    expect((await post(app, "/api/ocr", {}, ip("192.0.2.77, 203.0.113.10"))).status).toBe(429);

    for (let i = 0; i < SAVE_RATE_LIMIT_MAX; i++) {
      await post(app, "/api/save", {}, ip(`198.51.100.${i % 200}, 203.0.113.11`));
    }
    expect((await post(app, "/api/save", {}, ip("192.0.2.77, 203.0.113.11"))).status).toBe(429);
  });

  it("/healthz 與靜態頁不受限流影響", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    for (let i = 0; i <= OCR_RATE_LIMIT_MAX + 5; i++) await post(app, "/api/ocr", {}, ip("203.0.113.6"));
    expect((await app.request("/healthz", { headers: ip("203.0.113.6") })).status).toBe(200);
    expect((await app.request("/", { headers: { ...ip("203.0.113.6"), cookie: auth.cookie } })).status).toBe(200);
  });
});
