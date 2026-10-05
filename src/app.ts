import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import { consoleLogger, describeError, ServiceError, sleep, type FetchLike, type Logger } from "./common.js";
import type { AppEnv } from "./env.js";
import { GoogleTokenProvider, parseServiceAccountCredentials } from "./google-auth.js";
import { handleLineWebhookBody, notifyBoxClosed, parseBoxClosedInput, verifyLineSignature } from "./line.js";
import { parseImageInput, recognizeLabel } from "./ocr.js";
import { FixedWindowLimiter, getClientIp } from "./rate-limit.js";
import { buildSaveRow, parseSaveInput, SheetsClient } from "./sheets.js";

/** JSON body 上限（相機照片 base64 後約 100～300 KB，15 MB 已非常寬鬆）。 */
export const MAX_BODY_BYTES = 15 * 1024 * 1024;
/** 限流視窗：一分鐘。 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** POST /api/ocr（以及其他非 /api/save 的 /api/* 路徑，含不存在的）每個 IP 每分鐘的請求上限。 */
export const OCR_RATE_LIMIT_MAX = 60;
/**
 * POST /api/save 每個 IP 每分鐘的請求上限。關箱時前端是逐筆、循序送出，額度與拍照辨識分開計算，
 * 才不會被拍照的次數擠壓。真正決定寫入速度的是 sheets.ts 的 append 視窗配額（Google 寫入配額），不是這個數字。
 */
export const SAVE_RATE_LIMIT_MAX = 600;
/** POST /api/box-closed（關箱後的 LINE 群組通知）每個 IP 每分鐘的請求上限；有自己的額度，不佔 OCR／存檔的。 */
export const BOX_CLOSED_RATE_LIMIT_MAX = 60;
/** POST /api/line/webhook（LINE 平台打來的 webhook）每個 IP 每分鐘的請求上限；有自己的額度。 */
export const LINE_WEBHOOK_RATE_LIMIT_MAX = 120;

export interface AppDeps {
  env: AppEnv;
  /** index.html 的內容（server.ts 啟動時讀一次）。 */
  indexHtml: string;
  /** 預設用全域 fetch（每次呼叫時才取 globalThis.fetch，所以測試用 vi.stubGlobal 也攔得到）。 */
  fetchImpl?: FetchLike;
  /** OCR 重試之間、以及 Google append 視窗已滿時等名額的等待；測試時注入以免真的等待。 */
  sleep?: (ms: number) => Promise<void>;
  /** 目前時間（毫秒）；測試時注入以驗證限流視窗、快取過期與 append 視窗配額。 */
  now?: () => number;
  log?: Logger;
}

type NodeConnection = { incoming?: { socket?: { remoteAddress?: string } } };

/**
 * 客戶端 IP 的判斷方式，限流與 GET /healthz 的 clientIp 共用同一個函式（規則見 rate-limit.ts 的 getClientIp）：
 * 由右往左取 X-Forwarded-For 的第一個公開位址；沒有就退回 TCP 連線位址；再沒有就是 "unknown"。
 */
function clientIpOf(c: Context): string {
  const connection = c.env as NodeConnection | undefined;
  return getClientIp(c.req.header("x-forwarded-for"), connection?.incoming?.socket?.remoteAddress);
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new ServiceError(400, "請求內容不是有效的 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ServiceError(400, "請求內容必須是 JSON 物件");
  }
  return parsed as Record<string, unknown>;
}

/**
 * 建立 Hono app（不碰 process.env、不開 port，方便測試）。
 *
 *   GET  /, /index.html  → 原本的 index.html（no-cache）
 *   GET  /healthz        → 設定狀態與服務帳號 email（不含任何金鑰）、呼叫端 IP（限流用的同一個判斷）
 *   POST /api/ocr        → 取代 n8n webhook ipas-ocr
 *   POST /api/save       → 取代 n8n webhook ipas-save-product
 *   POST /api/box-closed → 關箱後推播到 LINE 群組（LINE 沒設定時靜默略過）
 *   POST /api/line/webhook → LINE webhook：在群組裡回覆該群組的 ID（需要 LINE_CHANNEL_SECRET）
 */
export function createApp(deps: AppDeps): Hono {
  const { env, indexHtml } = deps;
  const log = deps.log ?? consoleLogger;
  const now = deps.now ?? (() => Date.now()); // 呼叫時才取 Date.now，測試用假計時器也攔得到
  const sleepFn = deps.sleep ?? sleep;
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  // 憑證只解析一次；解析失敗（缺少或格式錯誤）時 sheets 為 null，/api/save 回 503。
  const credentials = parseServiceAccountCredentials(env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
  const sheets = credentials
    ? new SheetsClient({
        tokenProvider: new GoogleTokenProvider(credentials, { fetchImpl, log, now }),
        spreadsheetId: env.GOOGLE_SHEET_ID,
        sheetName: env.GOOGLE_SHEET_NAME,
        fetchImpl,
        log,
        now,
        sleep: sleepFn,
      })
    : null;
  // OCR、存檔、關箱通知、LINE webhook 各用自己的限流額度（每 IP 每分鐘），互不擠壓。
  const ocrLimiter = new FixedWindowLimiter(OCR_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const saveLimiter = new FixedWindowLimiter(SAVE_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const boxClosedLimiter = new FixedWindowLimiter(BOX_CLOSED_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const lineWebhookLimiter = new FixedWindowLimiter(LINE_WEBHOOK_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const limiterFor = (path: string): FixedWindowLimiter => {
    if (path === "/api/save") return saveLimiter;
    if (path === "/api/box-closed") return boxClosedLimiter;
    if (path === "/api/line/webhook") return lineWebhookLimiter;
    return ocrLimiter; // /api/ocr 與其他（含不存在的）路徑
  };

  const app = new Hono();

  const serveIndex = (c: Context) => {
    c.header("Cache-Control", "no-cache");
    return c.html(indexHtml);
  };
  app.get("/", serveIndex);
  app.get("/index.html", serveIndex);

  // 健康檢查：回「有沒有設定好」、服務帳號的 email（部署後要把試算表分享給它），以及呼叫端 IP。
  // clientIp 與限流用的是同一個判斷（clientIpOf）：部署後 curl 一次，就能確認 Zeabur 反向代理的
  // X-Forwarded-For 有被正確處理（應該是呼叫端自己的對外 IP，而不是代理的內部位址或所有人共用的同一個值）。
  // lineConfigured：LINE token 與群組 ID 都有（關箱通知會推播）；lineWebhookConfigured：有 channel secret（webhook 啟用）。
  // 回應物件是逐欄位明確組出來的，不會帶出憑證的其他欄位（尤其是 private_key），也不含任何 LINE 設定的值。
  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      openaiConfigured: env.OPENAI_API_KEY !== "",
      sheetsConfigured: credentials !== null,
      serviceAccountEmail: credentials?.client_email ?? null,
      clientIp: clientIpOf(c),
      lineConfigured: env.LINE_CHANNEL_ACCESS_TOKEN !== "" && env.LINE_GROUP_ID !== "",
      lineWebhookConfigured: env.LINE_CHANNEL_SECRET !== "",
    });
  });

  // /api/* 限流（每 IP 每分鐘）：/api/save、/api/box-closed、/api/line/webhook 各用自己的額度；
  // 其餘（/api/ocr 與不存在的路徑）共用 OCR 的額度（OCR_RATE_LIMIT_MAX）。所有請求都計次，包含格式錯誤的。
  app.use("/api/*", async (c, next) => {
    const { allowed, retryAfterSeconds } = limiterFor(c.req.path).hit(clientIpOf(c), now());
    if (!allowed) {
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json({ success: false, error: "請求過於頻繁，請稍後再試" }, 429);
    }
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ success: false, error: "請求內容過大（上限 15 MB）" }, 413),
    }),
  );

  // 取代 n8n：POST /webhook/ipas-ocr。成功 {success:true,data:{barcode,productName,gender,color,size}}。
  app.post("/api/ocr", async (c) => {
    const body = await readJsonObject(c);
    const image = parseImageInput(body.image); // 缺少或格式錯誤 → 400（先驗輸入，再檢查伺服器設定）
    if (env.OPENAI_API_KEY === "") throw new ServiceError(503, "伺服器尚未設定 OCR 服務");
    const data = await recognizeLabel(
      {
        fetchImpl,
        sleep: sleepFn,
        log,
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
        model: env.OPENAI_MODEL,
      },
      image,
    );
    return c.json({ success: true, data });
  });

  // 取代 n8n：POST /webhook/ipas-save-product。成功 {success:true}，另帶 range（寫入的儲存格範圍）。
  app.post("/api/save", async (c) => {
    const input = parseSaveInput(await readJsonObject(c));
    if (!sheets) throw new ServiceError(503, "伺服器尚未完成 Google 試算表設定");
    const result = await sheets.appendRow(buildSaveRow(input));
    return c.json(result.updatedRange ? { success: true, range: result.updatedRange } : { success: true });
  });

  // 關箱後的 LINE 群組通知。回應一律 200（輸入格式錯誤除外）：LINE 沒設定好或推播失敗都不是「關箱失敗」，
  // 前端只依 notified／reason 決定要不要提示。成功 {success:true,notified:true}；
  // 失敗 {success:true,notified:false,reason:"not_configured"|"push_failed",error?}。
  app.post("/api/box-closed", async (c) => {
    const input = parseBoxClosedInput(await readJsonObject(c));
    const outcome = await notifyBoxClosed(
      { fetchImpl, log, token: env.LINE_CHANNEL_ACCESS_TOKEN, groupId: env.LINE_GROUP_ID, now },
      input,
    );
    return c.json({ success: true, ...outcome });
  });

  // 給使用者取得群組 ID 用的 LINE webhook：只有設定了 LINE_CHANNEL_SECRET 才啟用（否則 503）。
  // 一定要用「原始 body 的位元組」驗 X-Line-Signature（不能先 JSON 解析）；簽章不符回 401，驗證通過一律回 200。
  app.post("/api/line/webhook", async (c) => {
    if (env.LINE_CHANNEL_SECRET === "") throw new ServiceError(503, "LINE webhook 尚未啟用");
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    if (!verifyLineSignature(rawBody, c.req.header("x-line-signature"), env.LINE_CHANNEL_SECRET)) {
      throw new ServiceError(401, "簽章驗證失敗");
    }
    await handleLineWebhookBody({ fetchImpl, log, token: env.LINE_CHANNEL_ACCESS_TOKEN }, rawBody.toString("utf8"));
    return c.json({ success: true });
  });

  for (const path of ["/api/ocr", "/api/save", "/api/box-closed", "/api/line/webhook"]) {
    app.all(path, (c) => {
      c.header("Allow", "POST");
      return c.json({ success: false, error: "此端點只接受 POST" }, 405);
    });
  }

  app.notFound((c) =>
    c.req.path.startsWith("/api/") ? c.json({ success: false, error: "找不到此路徑" }, 404) : c.text("Not Found", 404),
  );

  app.onError((err, c) => {
    if (err instanceof ServiceError) {
      return c.json({ success: false, error: err.message }, err.status);
    }
    log.error(`[app] 未預期的錯誤：${describeError(err)}`);
    return c.json({ success: false, error: "伺服器內部錯誤" }, 500);
  });

  return app;
}
