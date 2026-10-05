import { randomBytes } from "node:crypto";
import type { Context, Hono, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { registerAdminRoutes, type AdminRouteKit } from "./admin-routes.js";
import {
  emailForLog,
  newAdminId,
  normalizeEmail,
  parseNameAndEmail,
  parseNewAccountInput,
  requireActorInDraft,
  toPublicAdmin,
} from "./admins.js";
import {
  createSessionToken,
  DUMMY_PASSWORD_HASH,
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
import { isHttpsRequest, isInsecurePublicRequest, publicOrigin, readJsonObject, readString } from "./http.js";
import { buildSettingsView, resolveLineConfig } from "./line-settings.js";
import { fetchGroupName, formatTaipeiTime, GROUP_ID_RE, pushLineText } from "./line.js";
import { ConcurrencyGate, FixedWindowLimiter, RATE_LIMIT_WINDOW_MS } from "./rate-limit.js";
import {
  pageSecurityHeaders,
  renderLoginPage,
  renderSettingsPage,
  renderSetupPage,
  renderUnavailablePage,
  renderUpgradePage,
} from "./settings-page.js";
import { DATA_DIR_UNAVAILABLE_MESSAGE, type AdminAccount, type SettingsStore } from "./settings-store.js";

/** POST /settings/setup（用設定碼建立第一位管理員）每個 IP 每分鐘的請求上限（每次嘗試都算，不論對錯）。 */
export const SETUP_RATE_LIMIT_MAX = 5;
/** POST /settings/login、/settings/upgrade、/settings/password（都要驗密碼）共用的額度：每個 IP 每分鐘。 */
export const LOGIN_RATE_LIMIT_MAX = 10;
/** POST /api/settings/line/test（發測試訊息到 LINE 群組）每個 IP 每分鐘的上限，避免登入後被拿來洗版群組。 */
export const TEST_PUSH_RATE_LIMIT_MAX = 6;
/** /settings/*、/api/settings/*、/api/admins* 的 JSON 內容上限（全都是很小的表單）。 */
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

// ===================================================================== 路由

/** 登入失敗一律回這個訊息：不透露是帳號不存在、已停用，還是密碼不對。 */
const LOGIN_FAILED_MESSAGE = "帳號或密碼不正確";

/**
 * 設定頁與設定 API：
 *
 *   GET  /settings               → 設定頁（HTML）：資料目錄不可用／建立第一位管理員（設定碼）／升級舊版密碼／登入／設定
 *   POST /settings/setup         → 用啟動 log 裡的一次性設定碼建立第一位管理員（姓名、Email、密碼；並登入）
 *   POST /settings/upgrade       → 把舊版的單一管理密碼升級成第一位管理員（目前的密碼、姓名、Email；並登入）
 *   POST /settings/login         → Email＋密碼登入（發 sp_session cookie）
 *   POST /settings/logout        → 登出（清 cookie）
 *   POST /settings/password      → 更改「自己」的密碼（自己所有的登入全部失效，並重新登入目前這個瀏覽器）
 *   GET  /api/settings           → 目前設定（token／secret 只回「已設定」與尾碼；另有 me）
 *   PUT  /api/settings/line      → 儲存 LINE 設定
 *   POST /api/settings/line/test → 推播一則測試訊息到已儲存的群組
 *   /api/admins*                 → 管理員帳號管理（見 admin-routes.ts）
 *
 * 資料目錄不可用時，全部回 503。需要登入的 API 沒登入回 401。
 * 所有會改動狀態的端點（POST／PUT／PATCH／DELETE）一律用下面的 mutate() 註冊：它在處理器之前統一檢查資料目錄、
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
  /**
   * 這個請求的登入者：cookie 簽章與到期都通過，而且帳號還在、啟用中、sessionVersion 和簽在 cookie 裡的相符。
   * 舊格式的 cookie（升級前的三段式）、已被停用／刪除的帳號、重設過密碼的帳號的舊 cookie 都回 null。
   */
  const sessionAccount = (c: Context): Readonly<AdminAccount> | null => {
    const claims = verifySessionToken(getCookie(c, SESSION_COOKIE_NAME), settings.data.sessionSecret, now());
    if (!claims) return null;
    const account = settings.data.admins.find((admin) => admin.id === claims.accountId);
    if (!account || account.status !== "active" || account.sessionVersion !== claims.sessionVersion) return null;
    return account;
  };
  const requireActor = (c: Context): Readonly<AdminAccount> => {
    const account = sessionAccount(c);
    if (!account) throw new ServiceError(401, "請先登入");
    return account;
  };
  const issueSession = (c: Context, account: Pick<AdminAccount, "id" | "sessionVersion">): void => {
    setCookie(c, SESSION_COOKIE_NAME, createSessionToken(settings.data.sessionSecret, account.id, account.sessionVersion, now()), {
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
  /**
   * 審計 log：`[admins] <操作者 email> <動作> <對象 email>（來源 <ip>）`（登入這類沒有對象的事件就沒有對象那一段）。email 都是驗證過格式（或固定佔位字串）的，
   * 不會把使用者填的任意字串原樣寫進 log；絕不帶密碼。失敗事件用 warn。
   */
  const audit = (c: Context, actorEmail: string, action: string, targetEmail: string | null, options: { detail?: string; failed?: boolean } = {}): void => {
    const line = `[admins] ${actorEmail} ${action}${targetEmail === null ? "" : ` ${targetEmail}`}${options.detail ?? ""}（來源 ${deps.clientIp(c)}）`;
    if (options.failed) log.warn(line);
    else log.info(line);
  };

  const tooLarge = (c: Context) => c.json({ success: false, error: "請求內容過大" }, 413);
  for (const pattern of ["/settings/*", "/api/settings/*", "/api/admins", "/api/admins/*"]) {
    app.use(pattern, bodyLimit({ maxSize: SETTINGS_BODY_MAX_BYTES, onError: tooLarge }));
  }

  /** 狀態變更端點的共用檢查：資料目錄可用 → 只收 application/json → 要有 X-Requested-With。 */
  const guardMutation = async (c: Context, next: Next): Promise<void> => {
    requireWritable();
    assertJsonXhr(c);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  };
  const mutate = (method: "post" | "put" | "patch" | "delete", path: string, handler: (c: Context) => Response | Promise<Response>): void => {
    app[method](path, guardMutation, handler);
  };
  /** 其他方法一律 405（要放在處理器之後註冊）。methods 是 Allow 標頭的內容，例如 "GET, POST"。 */
  const allow = (path: string, methods: string): void => {
    app.all(path, (c) => {
      c.header("Allow", methods);
      return c.json({ success: false, error: `此端點只接受 ${methods}` }, 405);
    });
  };

  // ---------------------------------------------------------------- 頁面
  const page = (c: Context) => {
    const nonce = randomBytes(16).toString("base64");
    for (const [name, value] of Object.entries(pageSecurityHeaders(nonce))) c.header(name, value);
    const ctx = { nonce, origin: publicOrigin(c), insecure: isInsecurePublicRequest(c) };
    if (!settings.writable) return c.html(renderUnavailablePage(ctx), 503);
    const data = settings.data;
    if (data.admins.length === 0) return c.html(data.admin ? renderUpgradePage(ctx) : renderSetupPage(ctx));
    const me = sessionAccount(c);
    if (!me) return c.html(renderLoginPage(ctx));
    return c.html(renderSettingsPage(ctx, buildSettingsView(env, settings, me), data.admins.map(toPublicAdmin)));
  };
  app.get("/settings", page);
  app.get("/settings/", page);

  // ---------------------------------------------------------------- 建立第一位管理員／升級／登入／登出／改自己的密碼
  mutate("post", "/settings/setup", async (c) => {
    const limited = hit(setupLimiter, c);
    if (limited) return limited;
    if (settings.data.admins.length > 0) throw new ServiceError(409, "已經建立過管理員帳號，請直接登入");
    if (settings.data.admin) throw new ServiceError(409, "這裡還是舊版的單一管理密碼：請改用目前的密碼升級成管理員帳號");
    const body = await readJsonObject(c);
    if (!setupGuard.verify(readString(body, "setupCode"))) {
      audit(c, "（尚未有帳號）", "建立第一位管理員失敗：設定碼不正確", null, { failed: true });
      throw new ServiceError(403, "設定碼不正確");
    }
    const input = parseNewAccountInput(body);
    const passwordHash = await gated(() => hashPassword(input.password));
    const iso = new Date(now()).toISOString();
    const account: AdminAccount = {
      id: newAdminId(),
      name: input.name,
      email: input.email,
      passwordHash,
      status: "active",
      sessionVersion: 1,
      createdAt: iso,
      updatedAt: iso,
      lastLoginAt: iso,
    };
    await settings.update((draft) => {
      if (draft.admins.length > 0 || draft.admin) throw new ServiceError(409, "已經建立過管理員帳號，請直接登入"); // 兩個請求同時進來時，後到的在這裡擋下
      draft.admins.push(account);
    });
    setupGuard.consume();
    issueSession(c, account);
    audit(c, account.email, "建立第一位管理員", account.email);
    return c.json({ success: true });
  });

  mutate("post", "/settings/upgrade", async (c) => {
    const limited = hit(loginLimiter, c);
    if (limited) return limited;
    const legacy = settings.data.admin;
    if (!legacy || settings.data.admins.length > 0) throw new ServiceError(409, "沒有需要升級的舊版管理密碼");
    const body = await readJsonObject(c);
    const profile = parseNameAndEmail(body);
    const currentPassword = readString(body, "currentPassword");
    const passwordOk = currentPassword.length <= PASSWORD_MAX_LENGTH && (await gated(() => verifyPassword(currentPassword, legacy.passwordHash)));
    if (!passwordOk) {
      audit(c, profile.email, "升級管理員帳號失敗：目前的密碼不正確", profile.email, { failed: true });
      throw new ServiceError(401, "目前的密碼不正確");
    }
    const iso = new Date(now()).toISOString();
    // 沿用同一個密碼雜湊（不要求重設密碼）；sessionSecret、line、lineCaptured 與其他欄位完全不動
    const account: AdminAccount = {
      id: newAdminId(),
      name: profile.name,
      email: profile.email,
      passwordHash: legacy.passwordHash,
      status: "active",
      sessionVersion: 1,
      createdAt: iso,
      updatedAt: iso,
      lastLoginAt: iso,
    };
    await settings.update((draft) => {
      // 鎖內重新確認：兩個升級請求同時進來、或舊密碼在驗證期間被換掉，後到的在這裡擋下
      if (!draft.admin || draft.admins.length > 0 || draft.admin.passwordHash !== legacy.passwordHash) {
        throw new ServiceError(409, "沒有需要升級的舊版管理密碼");
      }
      draft.admins.push(account);
      draft.admin = null; // 舊的單一密碼只保留到升級完成為止
    });
    issueSession(c, account);
    audit(c, account.email, "升級為管理員帳號", account.email);
    return c.json({ success: true });
  });

  mutate("post", "/settings/login", async (c) => {
    const limited = hit(loginLimiter, c);
    if (limited) return limited;
    const data = settings.data;
    if (data.admins.length === 0) {
      if (data.admin) throw new ServiceError(409, "系統已改為管理員帳號制：請先用目前的管理密碼升級成管理員帳號");
      throw new ServiceError(400, "尚未建立管理員，請先用設定碼建立第一位管理員");
    }
    const body = await readJsonObject(c);
    const email = normalizeEmail(body.email);
    const password = readString(body, "password");
    const account = email === null ? undefined : data.admins.find((admin) => admin.email === email);
    const usable = account !== undefined && account.status === "active";
    // 一律跑一次 scrypt：查無帳號、帳號停用、Email 格式不對都拿固定的假雜湊驗，回應時間不洩漏帳號存不存在
    const passwordOk = await gated(() => verifyPassword(password, usable ? account.passwordHash : DUMMY_PASSWORD_HASH));
    if (!usable || !passwordOk || password.length > PASSWORD_MAX_LENGTH) {
      audit(c, emailForLog(body.email), "登入失敗", null, { failed: true });
      throw new ServiceError(401, LOGIN_FAILED_MESSAGE);
    }
    const iso = new Date(now()).toISOString();
    let sessionVersion = account.sessionVersion;
    try {
      await settings.update((draft) => {
        // 鎖內重新確認：驗證密碼期間帳號被停用、刪除或重設密碼，這次登入就作廢
        const live = draft.admins.find((admin) => admin.id === account.id);
        if (!live || live.status !== "active" || live.passwordHash !== account.passwordHash) {
          throw new ServiceError(401, LOGIN_FAILED_MESSAGE);
        }
        live.lastLoginAt = iso;
        sessionVersion = live.sessionVersion;
      });
    } catch (error) {
      if (!(error instanceof ServiceError) || error.status !== 500) throw error;
      // 寫檔失敗（Volume 滿了或變成唯讀）：lastLoginAt 只是方便查看的紀錄，登入本身不該因為它失敗（舊版的登入也不寫檔）。
      // 記一行警告，照樣讓這位管理員登入；記憶體裡的設定沒有被換掉，所以這裡再確認一次帳號此刻仍然有效。
      const live = settings.data.admins.find((admin) => admin.id === account.id);
      if (!live || live.status !== "active" || live.passwordHash !== account.passwordHash) throw new ServiceError(401, LOGIN_FAILED_MESSAGE);
      sessionVersion = live.sessionVersion;
      log.warn(`[admins] ${account.email} 登入成功，但無法更新最後登入時間：${error.message}`);
    }
    issueSession(c, { id: account.id, sessionVersion });
    audit(c, account.email, "登入成功", null);
    return c.json({ success: true });
  });

  mutate("post", "/settings/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/", secure: isHttpsRequest(c) });
    return c.json({ success: true });
  });

  mutate("post", "/settings/password", async (c) => {
    const actor = requireActor(c);
    const limited = hit(loginLimiter, c);
    if (limited) return limited;
    const body = await readJsonObject(c);
    const currentPassword = readString(body, "currentPassword");
    const newPassword = readString(body, "newPassword");
    const currentOk = currentPassword.length <= PASSWORD_MAX_LENGTH && (await gated(() => verifyPassword(currentPassword, actor.passwordHash)));
    if (!currentOk) {
      audit(c, actor.email, "變更自己的密碼失敗：目前的密碼不正確", actor.email, { failed: true });
      throw new ServiceError(403, "目前的密碼不正確");
    }
    const problem = validateNewPassword(newPassword);
    if (problem) throw new ServiceError(400, problem);
    if (newPassword === currentPassword) throw new ServiceError(400, "新密碼不能和目前的密碼相同");
    const passwordHash = await gated(() => hashPassword(newPassword));
    let sessionVersion = actor.sessionVersion;
    await settings.update((draft) => {
      const me = requireActorInDraft(draft, actor);
      if (me.passwordHash !== actor.passwordHash) throw new ServiceError(409, "密碼剛剛被更改過了，請重新整理後再試");
      me.passwordHash = passwordHash;
      me.sessionVersion += 1; // 這個帳號所有舊的登入 cookie 一起失效（其他管理員不受影響）
      me.updatedAt = new Date(now()).toISOString();
      sessionVersion = me.sessionVersion;
    });
    issueSession(c, { id: actor.id, sessionVersion }); // 用新的 sessionVersion 重新發給目前這個瀏覽器
    audit(c, actor.email, "變更自己的密碼", actor.email);
    return c.json({ success: true });
  });

  // ---------------------------------------------------------------- 設定 API
  app.get("/api/settings", (c) => {
    requireWritable();
    const me = requireActor(c);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ success: true, data: buildSettingsView(env, settings, me) });
  });

  mutate("put", "/api/settings/line", async (c) => {
    const actor = requireActor(c);
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
      // 讀請求內容與向 LINE 查群組名稱都要時間：這段期間操作者可能已被停用、刪除或重設密碼——和其他改動狀態的端點一樣，在鎖內重新確認
      requireActorInDraft(draft, actor);
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
    log.info(`[settings] ${actor.email} 更新了 LINE 設定（${changed.length > 0 ? changed.join("、") : "沒有欄位變更"}）`);
    return c.json({ success: true, data: buildSettingsView(env, settings, actor) });
  });

  mutate("post", "/api/settings/line/test", async (c) => {
    requireActor(c);
    const limited = hit(testPushLimiter, c);
    if (limited) return limited;
    const line = resolveLineConfig(env, settings.data);
    if (line.token === "" || line.groupId === "") throw new ServiceError(400, "請先儲存 Channel access token 與群組 ID");
    const text = `🔔 savepoint-crate 測試通知 ${formatTaipeiTime(new Date(now()))}`;
    const result = await pushLineText({ fetchImpl, log, token: line.token }, line.groupId, text);
    if (!result.ok) throw new ServiceError(502, result.error); // 固定短句，不轉發 LINE 的原始回應
    return c.json({ success: true, notified: true });
  });

  // ---------------------------------------------------------------- 管理員帳號管理（/api/admins*）
  const kit: AdminRouteKit = { settings, now, requireWritable, requireActor, gated, audit, mutate, allow };
  registerAdminRoutes(app, kit);

  // 其他方法一律 405（要放在上面的處理器之後）。
  allow("/settings", "GET");
  for (const path of ["/settings/setup", "/settings/upgrade", "/settings/login", "/settings/logout", "/settings/password", "/api/settings/line/test"]) {
    allow(path, "POST");
  }
  allow("/api/settings", "GET");
  allow("/api/settings/line", "PUT");
}
