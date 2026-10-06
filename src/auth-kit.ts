import { randomBytes } from "node:crypto";
import type { Context, Hono, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { ADMIN_REQUIRED_MESSAGE } from "./accounts.js";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_TTL_MS, verifySessionToken } from "./auth.js";
import { ServiceError, type Logger } from "./common.js";
import { isHttpsRequest, isInsecurePublicRequest, publicOrigin } from "./http.js";
import { ConcurrencyGate, FixedWindowLimiter, RATE_LIMIT_WINDOW_MS } from "./rate-limit.js";
import { pageSecurityHeaders, type PageContext } from "./settings-page.js";
import { DATA_DIR_UNAVAILABLE_MESSAGE, type Account, type SettingsStore } from "./settings-store.js";

/**
 * 全站共用的登入工具（createApp 建一份，主頁、API、登入頁、設定頁、帳號頁都用同一份）：
 *   - session cookie 的簽發、清除與驗證（cookie 綁帳號 id 與 sessionVersion；帳號必須存在、啟用、sessionVersion 相符）
 *   - 角色檢查（requireAdmin）、CSRF 標頭檢查、逐 IP 的登入限流、scrypt 並行閘門
 *   - 審計 log、小表單的 body 上限、HTML 頁面的安全標頭
 *   - mutate()：所有「改動狀態」的端點一律用它註冊（資料目錄可用 → application/json → X-Requested-With）
 */

/** POST /login、/settings/upgrade（都要驗密碼）共用的額度：每個 IP 每分鐘。 */
export const LOGIN_RATE_LIMIT_MAX = 10;
/**
 * scrypt（密碼雜湊／驗證）同時最多跑幾個、最多排幾個隊（超過回 429）。每個約 16 MiB 記憶體、數十毫秒 CPU，
 * 在 libuv 執行緒池（預設 4 條，DNS 解析與檔案 I/O 也用它）裡跑；限制並行數，公開端點被灌請求時才不會
 * 把執行緒池占滿、連帶拖慢 OCR 與存檔。
 */
export const PASSWORD_GATE_MAX_ACTIVE = 2;
export const PASSWORD_GATE_MAX_QUEUE = 16;
/** /login、/logout、/settings/*、/api/settings/*、/api/accounts* 的 JSON 內容上限（全都是很小的表單）。 */
export const SETTINGS_BODY_MAX_BYTES = 16 * 1024;

/** 登入失敗一律回這個訊息：不透露是帳號不存在、已停用，還是密碼不對。 */
export const LOGIN_FAILED_MESSAGE = "帳號或密碼不正確";
export const LOGIN_REQUIRED_MESSAGE = "請先登入";
export const CSRF_HEADER_MESSAGE = "缺少必要的請求標頭";

/**
 * 登入後要回去的位置只接受「同源的相對路徑」：以 `/` 開頭、不是 `//`（協定相對網址）、不含反斜線與控制字元、長度合理。
 * 其他一律當成沒給，回 `/`。
 */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (raw.length === 0 || raw.length > 2000) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029\\]/.test(raw)) return "/"; // 控制字元（含換行、Tab、行／段落分隔符號）與反斜線（有些瀏覽器把 /\ 當成 //）
  return raw;
}

/** CSRF 防護：一定要帶 X-Requested-With: XMLHttpRequest（瀏覽器的跨站表單送不出這種標頭）。 */
export function assertXhr(c: Context): void {
  if (c.req.header("x-requested-with") !== "XMLHttpRequest") throw new ServiceError(403, CSRF_HEADER_MESSAGE);
}

/** 狀態變更端點的 CSRF 防護：只收 Content-Type: application/json，且一定要帶 X-Requested-With: XMLHttpRequest。 */
export function assertJsonXhr(c: Context): void {
  const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ServiceError(415, "Content-Type 必須是 application/json");
  assertXhr(c);
}

export interface AuthKitDeps {
  settings: SettingsStore;
  now: () => number;
  log: Logger;
  /** 取客戶端 IP（與其他端點的限流用同一個判斷）。 */
  clientIp: (c: Context) => string;
}

export type MutateMethod = "post" | "put" | "patch" | "delete";

export interface AuthKit {
  settings: SettingsStore;
  now: () => number;
  log: Logger;
  clientIp: (c: Context) => string;
  /** 資料目錄不可用就丟 503（沒有地方存帳號，所以沒有人登得進去）。 */
  requireWritable(): void;
  /**
   * 這個請求的登入者：cookie 簽章與到期都通過，而且帳號還在、啟用中、sessionVersion 和簽在 cookie 裡的相符。
   * 舊格式的 cookie、已被停用／刪除的帳號、重設過密碼或改過角色的帳號的舊 cookie 都回 null。
   */
  sessionAccount(c: Context): Readonly<Account> | null;
  /** 沒登入丟 401「請先登入」。 */
  requireActor(c: Context): Readonly<Account>;
  /** 沒登入丟 401；登入了但角色不是 admin 丟 403「需要管理員權限」。 */
  requireAdmin(c: Context): Readonly<Account>;
  issueSession(c: Context, account: Pick<Account, "id" | "sessionVersion">): void;
  clearSession(c: Context): void;
  /** POST /login、/settings/upgrade 共用的逐 IP 額度。 */
  loginLimiter: FixedWindowLimiter;
  /** 計一次額度；超過回 429 的 Response（呼叫端直接 return），沒超過回 null。 */
  hit(limiter: FixedWindowLimiter, c: Context): Response | null;
  /** 跑 scrypt（雜湊或驗證）：同時進行的數量受閘門限制，排隊也滿了就回 429。 */
  gated<T>(work: () => Promise<T>): Promise<T>;
  /**
   * 審計 log：`[accounts] <操作者 email> <動作> <對象 email>（來源 <ip>）`（登入這類沒有對象的事件就沒有對象那一段）。
   * email 都是驗證過格式（或固定佔位字串）的，不會把使用者填的任意字串原樣寫進 log；絕不帶密碼。失敗事件用 warn。
   */
  audit(c: Context, actorEmail: string, action: string, targetEmail: string | null, options?: { detail?: string; failed?: boolean }): void;
  /** 狀態變更端點的註冊：資料目錄可用 → application/json → X-Requested-With，再進處理器。 */
  mutate(method: MutateMethod, path: string, handler: (c: Context) => Response | Promise<Response>): void;
  /** 其他方法一律 405（要放在處理器之後註冊）。methods 是 Allow 標頭的內容，例如 "GET, POST"。 */
  allow(path: string, methods: string): void;
  /** 回傳一個 HTML 頁面：帶這次請求專屬的 CSP nonce 與安全標頭。 */
  html(c: Context, status: 200 | 403 | 503, build: (ctx: PageContext) => string): Response;
  /** 302 導向登入頁（登入後回到 next，只用固定的站內路徑）。 */
  redirectToLogin(c: Context, next: string): Response;
}

export function createAuthKit(app: Hono, deps: AuthKitDeps): AuthKit {
  const { settings, now, log } = deps;
  const loginLimiter = new FixedWindowLimiter(LOGIN_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const passwordGate = new ConcurrencyGate(PASSWORD_GATE_MAX_ACTIVE, PASSWORD_GATE_MAX_QUEUE);

  const requireWritable = (): void => {
    if (!settings.writable) throw new ServiceError(503, DATA_DIR_UNAVAILABLE_MESSAGE);
  };

  const sessionAccount = (c: Context): Readonly<Account> | null => {
    const claims = verifySessionToken(getCookie(c, SESSION_COOKIE_NAME), settings.data.sessionSecret, now());
    if (!claims) return null;
    const account = settings.data.accounts.find((candidate) => candidate.id === claims.accountId);
    if (!account || account.status !== "active" || account.sessionVersion !== claims.sessionVersion) return null;
    return account;
  };
  const requireActor = (c: Context): Readonly<Account> => {
    const account = sessionAccount(c);
    if (!account) throw new ServiceError(401, LOGIN_REQUIRED_MESSAGE);
    return account;
  };
  const requireAdmin = (c: Context): Readonly<Account> => {
    const account = requireActor(c);
    if (account.role !== "admin") throw new ServiceError(403, ADMIN_REQUIRED_MESSAGE);
    return account;
  };
  const issueSession = (c: Context, account: Pick<Account, "id" | "sessionVersion">): void => {
    setCookie(c, SESSION_COOKIE_NAME, createSessionToken(settings.data.sessionSecret, account.id, account.sessionVersion, now()), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure: isHttpsRequest(c),
    });
  };
  const clearSession = (c: Context): void => {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/", secure: isHttpsRequest(c) });
  };

  const hit = (limiter: FixedWindowLimiter, c: Context): Response | null => {
    const { allowed, retryAfterSeconds } = limiter.hit(deps.clientIp(c), now());
    if (allowed) return null;
    c.header("Retry-After", String(retryAfterSeconds));
    return c.json({ success: false, error: "請求過於頻繁，請稍後再試" }, 429);
  };
  const gated = async <T>(work: () => Promise<T>): Promise<T> => {
    const result = await passwordGate.run(work);
    if (!result.ok) throw new ServiceError(429, "目前驗證請求過多，請稍後再試", { retryAfterSeconds: 1 }); // scrypt 一次約幾十毫秒，過一兩秒就有空位
    return result.value;
  };
  const audit: AuthKit["audit"] = (c, actorEmail, action, targetEmail, options = {}) => {
    const line = `[accounts] ${actorEmail} ${action}${targetEmail === null ? "" : ` ${targetEmail}`}${options.detail ?? ""}（來源 ${deps.clientIp(c)}）`;
    if (options.failed) log.warn(line);
    else log.info(line);
  };

  // 小表單端點的 body 上限（/api/* 另有全站的 15 MB 上限，兩個都會套用，取比較小的）
  const tooLarge = (c: Context) => c.json({ success: false, error: "請求內容過大" }, 413);
  for (const pattern of ["/login", "/logout", "/settings/*", "/api/settings/*", "/api/accounts", "/api/accounts/*"]) {
    app.use(pattern, bodyLimit({ maxSize: SETTINGS_BODY_MAX_BYTES, onError: tooLarge }));
  }

  const guardMutation = async (c: Context, next: Next): Promise<void> => {
    requireWritable();
    assertJsonXhr(c);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  };
  const mutate: AuthKit["mutate"] = (method, path, handler) => {
    app[method](path, guardMutation, handler);
  };
  const allow: AuthKit["allow"] = (path, methods) => {
    app.all(path, (c) => {
      c.header("Allow", methods);
      return c.json({ success: false, error: `此端點只接受 ${methods}` }, 405);
    });
  };

  const html: AuthKit["html"] = (c, status, build) => {
    const nonce = randomBytes(16).toString("base64");
    for (const [name, value] of Object.entries(pageSecurityHeaders(nonce))) c.header(name, value);
    const ctx: PageContext = { nonce, origin: publicOrigin(c), insecure: isInsecurePublicRequest(c) };
    return c.html(build(ctx), status);
  };
  const redirectToLogin: AuthKit["redirectToLogin"] = (c, next) => {
    c.header("Cache-Control", "no-store");
    return c.redirect(`/login?next=${next}`, 302);
  };

  return {
    settings,
    now,
    log,
    clientIp: deps.clientIp,
    requireWritable,
    sessionAccount,
    requireActor,
    requireAdmin,
    issueSession,
    clearSession,
    loginLimiter,
    hit,
    gated,
    audit,
    mutate,
    allow,
    html,
    redirectToLogin,
  };
}
