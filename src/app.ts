import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import { summarizeAccounts } from "./accounts.js";
import { SetupCodeGuard } from "./auth.js";
import { assertXhr, createAuthKit } from "./auth-kit.js";
import { consoleLogger, describeError, ServiceError, sleep, type FetchLike, type Logger } from "./common.js";
import type { AppEnv } from "./env.js";
import { GoogleTokenProvider, parseServiceAccountCredentials } from "./google-auth.js";
import { clientIpOf, isHttpsRequest, readJsonObject } from "./http.js";
import { captureLineGroup, resolveLineConfig } from "./line-settings.js";
import { handleLineWebhookBody, notifyBoxClosed, parseBoxClosedInput, verifyLineSignature } from "./line.js";
import { registerLoginRoutes } from "./login-routes.js";
import { parseImageInput, recognizeLabel } from "./ocr.js";
import { FixedWindowLimiter, RATE_LIMIT_WINDOW_MS } from "./rate-limit.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { SettingsStore } from "./settings-store.js";
import { buildSaveRow, parseSaveInput, SheetsClient } from "./sheets.js";

export { RATE_LIMIT_WINDOW_MS };
/** JSON body 上限（相機照片 base64 後約 100～300 KB，15 MB 已非常寬鬆）。 */
export const MAX_BODY_BYTES = 15 * 1024 * 1024;
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
/** /api/settings*、/api/accounts*、/api/me（設定頁、帳號管理與目前登入者的 API）每個 IP 每分鐘的請求上限；有自己的額度。另有各自更嚴的限制，見 settings-routes.ts。 */
export const SETTINGS_API_RATE_LIMIT_MAX = 60;

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
  /**
   * 設定檔儲存（DATA_DIR 底下的 settings.json，見 settings-store.ts）。不給就當作資料目錄不可用：
   * 設定頁與設定 API 回 503，LINE 只讀環境變數。
   */
  settings?: SettingsStore;
  /** 首次設定碼（測試時注入）；不給就隨機產生一組，並在還沒有任何帳號時寫進 log。 */
  setupCode?: SetupCodeGuard;
}

/**
 * 建立 Hono app（不碰 process.env、不開 port，方便測試）。
 *
 * 全站登入：除了 /healthz、/api/line/webhook 與登入頁之外，都要先用帳號（Email＋密碼）登入。
 *
 *   GET  /, /index.html  → 原本的 index.html（no-cache）；沒登入 302 到 /login?next=/
 *   GET  /healthz        → 設定狀態與服務帳號 email（不含任何金鑰）、呼叫端 IP（限流用的同一個判斷）、資料目錄與 LINE 設定來源（公開）
 *   POST /api/ocr        → 取代 n8n webhook ipas-ocr（任一角色；要登入與 X-Requested-With）
 *   POST /api/save       → 取代 n8n webhook ipas-save-product（同上）
 *   POST /api/box-closed → 關箱後推播到 LINE 群組（同上；訊息帶操作者姓名；LINE 沒設定時靜默略過）
 *   POST /api/line/webhook → LINE webhook：在群組裡回覆該群組的 ID、記錄最近收到的群組（需要 channel secret；公開，靠簽章驗證）
 *   /login、/logout、/api/me、/account*  → 登入、登出、目前登入者、我的帳號（見 login-routes.ts）
 *   /settings、/api/settings*、/api/accounts*、POST /settings/*  → 設定頁、設定 API 與帳號管理（只有管理員；見 settings-routes.ts、account-routes.ts）
 *
 * LINE 的 token、群組 ID、secret 先看設定頁存的設定檔（settings），沒有才退回環境變數（見 line-settings.ts）。
 */
export function createApp(deps: AppDeps): Hono {
  const { env, indexHtml } = deps;
  const log = deps.log ?? consoleLogger;
  const now = deps.now ?? (() => Date.now()); // 呼叫時才取 Date.now，測試用假計時器也攔得到
  const sleepFn = deps.sleep ?? sleep;
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const settings = deps.settings ?? SettingsStore.unavailable();
  // webhook 記錄群組的節流表（每個群組最後處理的時間，記憶體內、有上限）；見 line-settings.ts 的 captureLineGroup。
  const captureThrottle = new Map<string, number>();
  // 首次設定碼：還沒有任何帳號時，每次啟動產生一組、寫進 log（設定頁的 setup 狀態要用它建立第一位管理員）。
  const announceSetupCode = (code: string): void =>
    log.info(`[settings] 尚未設定管理密碼：請開啟 /settings，用設定碼 ${code} 建立密碼`);
  const setupGuard = deps.setupCode ?? new SetupCodeGuard({ onRegenerate: announceSetupCode });
  // 全新安裝（沒有任何帳號，也沒有舊版的單一密碼等著升級）才需要設定碼
  if (settings.writable && settings.data.accounts.length === 0 && settings.data.admin === null && setupGuard.currentCode !== null) {
    announceSetupCode(setupGuard.currentCode);
  }

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
  const settingsApiLimiter = new FixedWindowLimiter(SETTINGS_API_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const limiterFor = (path: string): FixedWindowLimiter => {
    if (path === "/api/save") return saveLimiter;
    if (path === "/api/box-closed") return boxClosedLimiter;
    if (path === "/api/line/webhook") return lineWebhookLimiter;
    if (path === "/api/settings" || path.startsWith("/api/settings/")) return settingsApiLimiter;
    if (path === "/api/accounts" || path.startsWith("/api/accounts/")) return settingsApiLimiter;
    if (path === "/api/me") return settingsApiLimiter; // 每次載入主頁呼叫一次，不要吃掉 OCR 的額度
    return ocrLimiter; // /api/ocr 與其他（含不存在的）路徑
  };

  const app = new Hono();
  // 全站共用的登入工具（session、角色檢查、CSRF 標頭、登入限流、scrypt 閘門、審計 log）
  const kit = createAuthKit(app, { settings, now, log, clientIp: clientIpOf });

  // 主頁：沒有有效的登入就導向登入頁（登入後回到 /）。沒有 Volume 時沒有帳號可登入，登入頁會顯示「請掛載 Volume」。
  const serveIndex = (c: Context) => {
    if (!kit.sessionAccount(c)) return kit.redirectToLogin(c, "/");
    c.header("Cache-Control", "no-cache");
    return c.html(indexHtml);
  };
  app.get("/", serveIndex);
  app.get("/index.html", serveIndex);

  // 健康檢查：回「有沒有設定好」、服務帳號的 email（部署後要把試算表分享給它），以及呼叫端 IP。
  // clientIp 與限流用的是同一個判斷（clientIpOf）：部署後 curl 一次，就能確認 Zeabur 反向代理的
  // X-Forwarded-For 有被正確處理（應該是呼叫端自己的對外 IP，而不是代理的內部位址或所有人共用的同一個值）。
  // requestIsHttps：這個請求被判斷為 HTTPS（看 X-Forwarded-Proto；Zeabur 的反向代理要有送，登入 cookie 才會加 Secure），
  // 和 clientIp 一樣是部署後 curl 一次就能確認代理行為的診斷欄位。
  // dataDirWritable：資料目錄（Volume）可寫入，設定頁才能用；dataDirMounted：它是不是獨立掛載的磁碟（null＝判斷不出來；
  // false＝只是容器內的暫存目錄，重新部署後設定會消失）。
  // adminConfigured：有至少一位啟用中的管理員，或仍有待升級的舊版單一密碼；adminCount：角色是 admin 的帳號數（含停用的）；
  // accountCount：帳號總數；legacyAdminPending：還有舊版的單一管理密碼沒升級成帳號。
  // lineConfigured：關箱通知會推播（生效的設定裡有 token、群組 ID，且開關開著）；lineWebhookConfigured：有 channel secret
  // （webhook 啟用）；lineSource：生效的 LINE 設定來自設定頁（settings）還是環境變數（env），都沒設定是 null。
  // 回應物件是逐欄位明確組出來的，不會帶出憑證的其他欄位（尤其是 private_key），也不含任何 LINE 設定的值。
  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    const line = resolveLineConfig(env, settings.data);
    return c.json({
      ok: true,
      openaiConfigured: env.OPENAI_API_KEY !== "",
      sheetsConfigured: credentials !== null,
      serviceAccountEmail: credentials?.client_email ?? null,
      clientIp: clientIpOf(c),
      requestIsHttps: isHttpsRequest(c),
      dataDirWritable: settings.writable,
      dataDirMounted: settings.mounted,
      ...summarizeAccounts(settings.data),
      lineConfigured: line.notifyReady,
      lineWebhookConfigured: line.webhookReady,
      lineSource: line.source,
    });
  });

  // 登入閘門：裝箱程式用的三支 API（OCR、存檔、關箱通知）一定要有有效的登入 session（任一角色），並帶 CSRF 標頭
  // X-Requested-With: XMLHttpRequest。放在限流之前：沒登入的請求直接 401，不會吃掉同一個出口 IP 上其他人的限流額度。
  // 沒有登入回 401「請先登入」；已登入但缺標頭回 403；資料目錄不可用（沒有地方存帳號）回 503。
  app.on("POST", ["/api/ocr", "/api/save", "/api/box-closed"], async (c, next) => {
    kit.requireWritable();
    kit.requireActor(c);
    assertXhr(c);
    await next();
  });

  // /api/* 限流（每 IP 每分鐘）：/api/save、/api/box-closed、/api/line/webhook 各用自己的額度；
  // 其餘（/api/ocr 與不存在的路徑）共用 OCR 的額度（OCR_RATE_LIMIT_MAX）。所有請求都計次，包含格式錯誤的。
  // 沒有有效登入的請求（還沒被 401 擋下的 /api/me、/api/settings*、/api/accounts*、不存在的路徑，以及本來就不用登入的 LINE webhook）
  // 算在另一組「匿名」額度（key 加 anon: 前綴）：同一個出口 IP（整間辦公室共用）上，沒登入的雜訊不會用掉已登入同事的額度。
  app.use("/api/*", async (c, next) => {
    const ip = clientIpOf(c);
    const key = kit.sessionAccount(c) === null ? `anon:${ip}` : ip;
    const { allowed, retryAfterSeconds } = limiterFor(c.req.path).hit(key, now());
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
    const me = kit.requireActor(c); // 操作者來自登入的 session，不接受前端自己填
    const input = parseBoxClosedInput(await readJsonObject(c));
    const line = resolveLineConfig(env, settings.data); // 每次都重新解析：設定頁存檔後立刻生效，不必重啟
    const outcome = await notifyBoxClosed(
      // 設定頁的開關關著就當作沒設定群組（notifyBoxClosed 會靜默略過）
      { fetchImpl, log, token: line.token, groupId: line.enabled ? line.groupId : "", now },
      { ...input, operator: me.name },
    );
    return c.json({ success: true, ...outcome });
  });

  // 給使用者取得群組 ID 用的 LINE webhook：生效的設定裡有 channel secret 才啟用（否則 503）。
  // 一定要用「原始 body 的位元組」驗 X-Line-Signature（不能先 JSON 解析）；簽章不符回 401，驗證通過一律回 200。
  // 群組的 join／message 事件另外記錄到設定檔的「最近收到的群組」（資料目錄不可用時略過），讓設定頁一鍵帶入群組 ID。
  app.post("/api/line/webhook", async (c) => {
    const line = resolveLineConfig(env, settings.data);
    if (line.secret === "") throw new ServiceError(503, "LINE webhook 尚未啟用");
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    if (!verifyLineSignature(rawBody, c.req.header("x-line-signature"), line.secret)) {
      throw new ServiceError(401, "簽章驗證失敗");
    }
    await handleLineWebhookBody(
      {
        fetchImpl,
        log,
        token: line.token,
        onGroupEvent: (event) =>
          captureLineGroup({ store: settings, fetchImpl, log, token: line.token, now, lastHandled: captureThrottle }, event),
      },
      rawBody.toString("utf8"),
    );
    return c.json({ success: true });
  });

  registerLoginRoutes(app, kit);
  registerSettingsRoutes(app, kit, { env, setupGuard, fetchImpl });

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
      if (err.retryAfterSeconds !== undefined) c.header("Retry-After", String(err.retryAfterSeconds));
      return c.json({ success: false, error: err.message }, err.status);
    }
    log.error(`[app] 未預期的錯誤：${describeError(err)}`);
    return c.json({ success: false, error: "伺服器內部錯誤" }, 500);
  });

  return app;
}
