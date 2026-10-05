import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import { consoleLogger, describeError, ServiceError, sleep, type FetchLike, type Logger } from "./common.js";
import type { AppEnv } from "./env.js";
import { GoogleTokenProvider, parseServiceAccountCredentials } from "./google-auth.js";
import { parseImageInput, recognizeLabel } from "./ocr.js";
import { FixedWindowLimiter, getClientIp } from "./rate-limit.js";
import { buildSaveRow, parseSaveInput, SheetsClient } from "./sheets.js";

/** JSON body 上限（相機照片 base64 後約 100～300 KB，15 MB 已非常寬鬆）。 */
export const MAX_BODY_BYTES = 15 * 1024 * 1024;
/** /api/* 每個 IP 每分鐘的請求上限。 */
export const RATE_LIMIT_MAX = 60;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface AppDeps {
  env: AppEnv;
  /** index.html 的內容（server.ts 啟動時讀一次）。 */
  indexHtml: string;
  /** 預設用全域 fetch（每次呼叫時才取 globalThis.fetch，所以測試用 vi.stubGlobal 也攔得到）。 */
  fetchImpl?: FetchLike;
  /** OCR 重試之間的等待；測試時注入以免真的等 1 秒。 */
  sleep?: (ms: number) => Promise<void>;
  /** 目前時間（毫秒）；測試時注入以驗證限流視窗與快取過期。 */
  now?: () => number;
  log?: Logger;
}

type NodeConnection = { incoming?: { socket?: { remoteAddress?: string } } };

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
 *   GET  /healthz        → 設定狀態（不含任何金鑰）
 *   POST /api/ocr        → 取代 n8n webhook ipas-ocr
 *   POST /api/save       → 取代 n8n webhook ipas-save-product
 */
export function createApp(deps: AppDeps): Hono {
  const { env, indexHtml } = deps;
  const log = deps.log ?? consoleLogger;
  const now = deps.now ?? Date.now;
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
      })
    : null;
  const limiter = new FixedWindowLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

  const app = new Hono();

  const serveIndex = (c: Context) => {
    c.header("Cache-Control", "no-cache");
    return c.html(indexHtml);
  };
  app.get("/", serveIndex);
  app.get("/index.html", serveIndex);

  // 健康檢查：只回「有沒有設定好」與服務帳號的 email（部署後要把試算表分享給它）。
  // 回應物件是逐欄位明確組出來的，不會帶出憑證的其他欄位（尤其是 private_key）。
  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      openaiConfigured: env.OPENAI_API_KEY !== "",
      sheetsConfigured: credentials !== null,
      serviceAccountEmail: credentials?.client_email ?? null,
    });
  });

  // /api/* 限流：每 IP 每分鐘 60 次（所有 /api/* 請求都計次，包含格式錯誤的）。
  app.use("/api/*", async (c, next) => {
    const connection = c.env as NodeConnection | undefined;
    const ip = getClientIp(c.req.header("x-forwarded-for"), connection?.incoming?.socket?.remoteAddress);
    const { allowed, retryAfterSeconds } = limiter.hit(ip, now());
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

  for (const path of ["/api/ocr", "/api/save"]) {
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
