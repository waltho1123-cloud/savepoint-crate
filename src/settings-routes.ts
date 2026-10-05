import { randomBytes } from "node:crypto";
import type { Context, Hono, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  createSessionToken,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  validateNewPassword,
  verifyPassword,
  verifySessionToken,
  type SetupCodeGuard,
} from "./auth.js";
import { ServiceError, type FetchLike, type Logger } from "./common.js";
import type { AppEnv } from "./env.js";
import { isHttpsRequest, isInsecurePublicRequest, publicOrigin, readJsonObject } from "./http.js";
import { buildSettingsView, resolveLineConfig } from "./line-settings.js";
import { fetchGroupName, formatTaipeiTime, GROUP_ID_RE, pushLineText } from "./line.js";
import { ConcurrencyGate, FixedWindowLimiter, RATE_LIMIT_WINDOW_MS } from "./rate-limit.js";
import {
  pageSecurityHeaders,
  renderLoginPage,
  renderSettingsPage,
  renderSetupPage,
  renderUnavailablePage,
} from "./settings-page.js";
import { DATA_DIR_UNAVAILABLE_MESSAGE, type SettingsStore } from "./settings-store.js";

/** POST /settings/setup（用設定碼建立管理密碼）每個 IP 每分鐘的請求上限（每次嘗試都算，不論對錯）。 */
export const SETUP_RATE_LIMIT_MAX = 5;
/** POST /settings/login 與 POST /settings/password（都要驗密碼）共用的額度：每個 IP 每分鐘。 */
export const LOGIN_RATE_LIMIT_MAX = 10;
/** POST /api/settings/line/test（發測試訊息到 LINE 群組）每個 IP 每分鐘的上限，避免登入後被拿來洗版群組。 */
export const TEST_PUSH_RATE_LIMIT_MAX = 6;
/** /settings/* 與 /api/settings/* 的 JSON 內容上限（全都是很小的表單）。 */
export const SETTINGS_BODY_MAX_BYTES = 16 * 1024;
/** token／secret 的長度上限（LINE 的 channel access token 約 170 字元）。 */
export const LINE_CREDENTIAL_MAX_CHARS = 1000;
/**
 * scrypt（密碼雜湊／驗證）同時最多跑幾個、最多排幾個隊（超過回 429）。每個約 16 MiB 記憶體、數十毫秒 CPU，
 * 在 libuv 執行緒池（預設 4 條，DNS 解析與檔案 I/O 也用它）裡跑；限制並行數，公開端點被灌請求時才不會
 * 把執行緒池占滿、連帶拖慢 OCR 與存檔。
 */
export const PASSWORD_GATE_MAX_ACTIVE = 2;
export const PASSWORD_GATE_MAX_QUEUE = 16;

export interface SettingsRouteDeps {
  env: AppEnv;
  settings: SettingsStore;
  setupGuard: SetupCodeGuard;
  fetchImpl: FetchLike;
  log: Logger;
  now: () => number;
  /** 取客戶端 IP（與其他端點的限流用同一個判斷）。 */
  clientIp: (c: Context) => string;
}

// ===================================================================== 請求內容驗證

interface LinePatch {
  enabled?: boolean;
  token?: string;
  clearToken: boolean;
  secret?: string;
  clearSecret: boolean;
  groupId?: string;
}

/** 憑證欄位：沒給或空白＝不變（回 undefined）；有值要是可見的 ASCII（不含空白與控制字元）且不超過上限。 */
function readCredential(body: Record<string, unknown>, key: string, label: string): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new ServiceError(400, `${label} 必須是字串`);
  const value = raw.trim();
  if (value === "") return undefined;
  if (value.length > LINE_CREDENTIAL_MAX_CHARS || !/^[\x21-\x7E]+$/.test(value)) {
    throw new ServiceError(400, `${label} 的格式不正確`);
  }
  return value;
}

function readFlag(body: Record<string, unknown>, key: string): boolean {
  const raw = body[key];
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "boolean") throw new ServiceError(400, `${key} 必須是 true 或 false`);
  return raw;
}

/** 驗證 PUT /api/settings/line 的內容；沒給的欄位維持原值，token／secret 留空也是維持原值（要清除要明確傳 clear 旗標）。 */
export function parseLinePatch(body: Record<string, unknown>): LinePatch {
  const patch: LinePatch = { clearToken: false, clearSecret: false };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new ServiceError(400, "enabled 必須是 true 或 false");
    patch.enabled = body.enabled;
  }
  const token = readCredential(body, "channelAccessToken", "Channel access token");
  if (token !== undefined) patch.token = token;
  const secret = readCredential(body, "channelSecret", "Channel secret");
  if (secret !== undefined) patch.secret = secret;
  patch.clearToken = readFlag(body, "clearChannelAccessToken");
  patch.clearSecret = readFlag(body, "clearChannelSecret");
  if (patch.token !== undefined && patch.clearToken) {
    throw new ServiceError(400, "不能同時填入新的 Channel access token 又要求清除它");
  }
  if (patch.secret !== undefined && patch.clearSecret) {
    throw new ServiceError(400, "不能同時填入新的 Channel secret 又要求清除它");
  }
  if (body.groupId !== undefined && body.groupId !== null) {
    if (typeof body.groupId !== "string") throw new ServiceError(400, "群組 ID 必須是字串");
    const groupId = body.groupId.trim();
    if (groupId !== "" && !GROUP_ID_RE.test(groupId)) throw new ServiceError(400, "群組 ID 的格式不正確（C 開頭的英數字）");
    patch.groupId = groupId; // 空字串＝清除
  }
  return patch;
}

/** 狀態變更端點的 CSRF 防護：只收 Content-Type: application/json，且一定要帶 X-Requested-With: XMLHttpRequest。 */
function assertJsonXhr(c: Context): void {
  const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ServiceError(415, "Content-Type 必須是 application/json");
  if (c.req.header("x-requested-with") !== "XMLHttpRequest") throw new ServiceError(403, "缺少必要的請求標頭");
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

// ===================================================================== 路由

/**
 * 設定頁與設定 API：
 *
 *   GET  /settings               → 設定頁（HTML）
 *   POST /settings/setup         → 用啟動 log 裡的一次性設定碼建立管理密碼（並登入）
 *   POST /settings/login         → 密碼登入（發 sp_session cookie）
 *   POST /settings/logout        → 登出（清 cookie）
 *   POST /settings/password      → 更改管理密碼（既有的登入全部失效，並重新登入目前這個瀏覽器）
 *   GET  /api/settings           → 目前設定（token／secret 只回「已設定」與尾碼）
 *   PUT  /api/settings/line      → 儲存 LINE 設定
 *   POST /api/settings/line/test → 推播一則測試訊息到已儲存的群組
 *
 * 資料目錄不可用時，全部回 503。需要登入的 API 沒登入回 401。
 * 所有會改動狀態的端點（POST／PUT）一律用下面的 mutate() 註冊：它在處理器之前統一檢查資料目錄、
 * Content-Type 與 X-Requested-With——新增端點時照這個寫法，就不會漏掉 CSRF 防護（tests/settings-auth.test.ts
 * 會走訪 app.routes，檢查每一條非 GET 的設定路由都擋得住沒帶標頭的請求）。
 */
export function registerSettingsRoutes(app: Hono, deps: SettingsRouteDeps): void {
  const { env, settings, setupGuard, fetchImpl, log, now } = deps;
  const setupLimiter = new FixedWindowLimiter(SETUP_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const loginLimiter = new FixedWindowLimiter(LOGIN_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const testPushLimiter = new FixedWindowLimiter(TEST_PUSH_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const passwordGate = new ConcurrencyGate(PASSWORD_GATE_MAX_ACTIVE, PASSWORD_GATE_MAX_QUEUE);

  const requireWritable = (): void => {
    if (!settings.writable) throw new ServiceError(503, DATA_DIR_UNAVAILABLE_MESSAGE);
  };
  const hasSession = (c: Context): boolean =>
    verifySessionToken(getCookie(c, SESSION_COOKIE_NAME), settings.data.sessionSecret, now());
  const requireSession = (c: Context): void => {
    if (!hasSession(c)) throw new ServiceError(401, "請先登入");
  };
  const issueSession = (c: Context): void => {
    setCookie(c, SESSION_COOKIE_NAME, createSessionToken(settings.data.sessionSecret, now()), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure: isHttpsRequest(c),
    });
  };
  /** 計一次額度；超過回 429 的 Response（呼叫端直接 return），沒超過回 null。 */
  const hit = (limiter: FixedWindowLimiter, c: Context): Response | null => {
    const { allowed, retryAfterSeconds } = limiter.hit(deps.clientIp(c), now());
    if (allowed) return null;
    c.header("Retry-After", String(retryAfterSeconds));
    return c.json({ success: false, error: "請求過於頻繁，請稍後再試" }, 429);
  };
  /** 跑 scrypt（雜湊或驗證）：同時進行的數量受 passwordGate 限制，排隊也滿了就回 429。 */
  const gated = async <T>(work: () => Promise<T>): Promise<T> => {
    const result = await passwordGate.run(work);
    if (!result.ok) throw new ServiceError(429, "目前驗證請求過多，請稍後再試");
    return result.value;
  };
  /** 安全相關事件的 log（來源 IP 已經過 getClientIp 驗證，只會是合法 IP 或 "unknown"）；絕不帶密碼或設定碼。 */
  const audit = (c: Context, message: string): void => log.warn(`[settings] ${message}（來源 ${deps.clientIp(c)}）`);

  const tooLarge = (c: Context) => c.json({ success: false, error: "請求內容過大" }, 413);
  app.use("/settings/*", bodyLimit({ maxSize: SETTINGS_BODY_MAX_BYTES, onError: tooLarge }));
  app.use("/api/settings/*", bodyLimit({ maxSize: SETTINGS_BODY_MAX_BYTES, onError: tooLarge }));

  /** 狀態變更端點的共用檢查：資料目錄可用 → 只收 application/json → 要有 X-Requested-With。 */
  const guardMutation = async (c: Context, next: Next): Promise<void> => {
    requireWritable();
    assertJsonXhr(c);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  };
  const mutate = (method: "post" | "put", path: string, handler: (c: Context) => Response | Promise<Response>): void => {
    app[method](path, guardMutation, handler);
  };

  // ---------------------------------------------------------------- 頁面
  const page = (c: Context) => {
    const nonce = randomBytes(16).toString("base64");
    for (const [name, value] of Object.entries(pageSecurityHeaders(nonce))) c.header(name, value);
    const ctx = { nonce, origin: publicOrigin(c), insecure: isInsecurePublicRequest(c) };
    if (!settings.writable) return c.html(renderUnavailablePage(ctx), 503);
    if (!settings.data.admin) return c.html(renderSetupPage(ctx));
    if (!hasSession(c)) return c.html(renderLoginPage(ctx));
    return c.html(renderSettingsPage(ctx, buildSettingsView(env, settings)));
  };
  app.get("/settings", page);
  app.get("/settings/", page);

  // ---------------------------------------------------------------- 建立密碼／登入／登出／改密碼
  mutate("post", "/settings/setup", async (c) => {
    const limited = hit(setupLimiter, c);
    if (limited) return limited;
    if (settings.data.admin) throw new ServiceError(409, "已經建立過管理密碼，請直接登入");
    const body = await readJsonObject(c);
    if (!setupGuard.verify(readString(body, "setupCode"))) {
      audit(c, "建立密碼失敗：設定碼不正確");
      throw new ServiceError(403, "設定碼不正確");
    }
    const password = readString(body, "password");
    const problem = validateNewPassword(password);
    if (problem) throw new ServiceError(400, problem);
    const passwordHash = await gated(() => hashPassword(password));
    await settings.update((draft) => {
      if (draft.admin) throw new ServiceError(409, "已經建立過管理密碼，請直接登入"); // 兩個請求同時進來時，後到的在這裡擋下
      draft.admin = { passwordHash, updatedAt: new Date(now()).toISOString() };
    });
    setupGuard.consume();
    issueSession(c);
    log.info("[settings] 管理密碼已建立");
    return c.json({ success: true });
  });

  mutate("post", "/settings/login", async (c) => {
    const limited = hit(loginLimiter, c);
    if (limited) return limited;
    const admin = settings.data.admin;
    if (!admin) throw new ServiceError(400, "尚未設定管理密碼，請先用設定碼建立密碼");
    const password = readString(await readJsonObject(c), "password");
    const ok = password.length <= PASSWORD_MAX_LENGTH && (await gated(() => verifyPassword(password, admin.passwordHash)));
    if (!ok) {
      audit(c, "登入失敗：密碼不正確");
      throw new ServiceError(401, "密碼不正確");
    }
    issueSession(c);
    log.info(`[settings] 登入成功（來源 ${deps.clientIp(c)}）`);
    return c.json({ success: true });
  });

  mutate("post", "/settings/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/", secure: isHttpsRequest(c) });
    return c.json({ success: true });
  });

  mutate("post", "/settings/password", async (c) => {
    requireSession(c);
    const limited = hit(loginLimiter, c);
    if (limited) return limited;
    const admin = settings.data.admin;
    if (!admin) throw new ServiceError(400, "尚未設定管理密碼");
    const body = await readJsonObject(c);
    const currentPassword = readString(body, "currentPassword");
    const newPassword = readString(body, "newPassword");
    const currentOk =
      currentPassword.length <= PASSWORD_MAX_LENGTH && (await gated(() => verifyPassword(currentPassword, admin.passwordHash)));
    if (!currentOk) {
      audit(c, "更改密碼失敗：目前的密碼不正確");
      throw new ServiceError(403, "目前的密碼不正確");
    }
    const problem = validateNewPassword(newPassword);
    if (problem) throw new ServiceError(400, problem);
    if (newPassword === currentPassword) throw new ServiceError(400, "新密碼不能和目前的密碼相同");
    const passwordHash = await gated(() => hashPassword(newPassword));
    await settings.update((draft) => {
      draft.admin = { passwordHash, updatedAt: new Date(now()).toISOString() };
      draft.sessionSecret = randomBytes(32).toString("hex"); // 換掉簽章金鑰：所有已發出的登入 cookie 一起失效
    });
    issueSession(c); // 用新的金鑰重新發給目前這個瀏覽器
    log.info("[settings] 管理密碼已更新，既有的登入已全部失效");
    return c.json({ success: true });
  });

  // ---------------------------------------------------------------- 設定 API
  app.get("/api/settings", (c) => {
    requireWritable();
    requireSession(c);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ success: true, data: buildSettingsView(env, settings) });
  });

  mutate("put", "/api/settings/line", async (c) => {
    requireSession(c);
    const patch = parseLinePatch(await readJsonObject(c));

    // 群組名稱：只有「群組 ID 或 token 變了」或「名稱還是空的」才向 LINE 查，不是每次存檔都查。
    // 查不到就用 webhook 記錄過的名稱；都沒有時：換了群組就清空（不能沿用舊群組的名稱），沒換就維持原本存的名稱
    // （例如 LINE 暫時失敗時，只是切換開關，不會把已經查到的名稱清掉）。
    const before = settings.data.line;
    const nextToken = patch.clearToken ? "" : (patch.token ?? before.channelAccessToken);
    const nextGroupId = patch.groupId ?? before.groupId;
    const groupChanged = nextGroupId !== before.groupId;
    const tokenChanged = patch.token !== undefined || patch.clearToken;
    let newName: string | undefined; // undefined＝維持原值
    if (nextGroupId === "") {
      newName = "";
    } else if (groupChanged || tokenChanged || before.groupName === "") {
      let name = nextToken !== "" ? await fetchGroupName({ fetchImpl, log, token: nextToken }, nextGroupId) : "";
      if (name === "") name = settings.data.lineCaptured.find((group) => group.groupId === nextGroupId)?.groupName ?? "";
      if (name !== "") newName = name;
      else if (groupChanged) newName = "";
    }

    await settings.update((draft) => {
      const line = draft.line;
      if (patch.enabled !== undefined) line.enabled = patch.enabled;
      if (patch.clearToken) line.channelAccessToken = "";
      else if (patch.token !== undefined) line.channelAccessToken = patch.token;
      if (patch.clearSecret) line.channelSecret = "";
      else if (patch.secret !== undefined) line.channelSecret = patch.secret;
      if (patch.groupId !== undefined) line.groupId = patch.groupId;
      if (line.groupId === "") line.groupName = "";
      // 查名稱期間若有別的請求把群組改掉了（line.groupId 不再是我們查的那個），就不要用過期的名稱覆蓋
      else if (newName !== undefined && line.groupId === nextGroupId) line.groupName = newName;
      line.updatedAt = new Date(now()).toISOString();
    });

    const changed = [
      patch.enabled !== undefined && patch.enabled !== before.enabled && "開關",
      ((patch.token !== undefined && patch.token !== before.channelAccessToken) || (patch.clearToken && before.channelAccessToken !== "")) && "token",
      ((patch.secret !== undefined && patch.secret !== before.channelSecret) || (patch.clearSecret && before.channelSecret !== "")) && "secret",
      patch.groupId !== undefined && patch.groupId !== before.groupId && "群組 ID",
    ].filter((item): item is string => typeof item === "string");
    log.info(`[settings] LINE 設定已更新（${changed.length > 0 ? changed.join("、") : "沒有欄位變更"}）`);
    return c.json({ success: true, data: buildSettingsView(env, settings) });
  });

  mutate("post", "/api/settings/line/test", async (c) => {
    requireSession(c);
    const limited = hit(testPushLimiter, c);
    if (limited) return limited;
    const line = resolveLineConfig(env, settings.data);
    if (line.token === "" || line.groupId === "") throw new ServiceError(400, "請先儲存 Channel access token 與群組 ID");
    const text = `🔔 savepoint-crate 測試通知 ${formatTaipeiTime(new Date(now()))}`;
    const result = await pushLineText({ fetchImpl, log, token: line.token }, line.groupId, text);
    if (!result.ok) throw new ServiceError(502, result.error); // 固定短句，不轉發 LINE 的原始回應
    return c.json({ success: true, notified: true });
  });

  // 其他方法一律 405（要放在上面的處理器之後）。
  const allow = (path: string, method: string): void => {
    app.all(path, (c) => {
      c.header("Allow", method);
      return c.json({ success: false, error: `此端點只接受 ${method}` }, 405);
    });
  };
  allow("/settings", "GET");
  for (const path of ["/settings/setup", "/settings/login", "/settings/logout", "/settings/password", "/api/settings/line/test"]) {
    allow(path, "POST");
  }
  allow("/api/settings", "GET");
  allow("/api/settings/line", "PUT");
}
