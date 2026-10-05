import type { Hono } from "hono";

import { newAccountId, parseNameAndEmail, parseNewAccountInput, requireAdminInDraft, toPublicAccount } from "./accounts.js";
import { registerAccountRoutes } from "./account-routes.js";
import { PASSWORD_MAX_LENGTH, hashPassword, verifyPassword, type SetupCodeGuard } from "./auth.js";
import type { AuthKit } from "./auth-kit.js";
import { ServiceError, type FetchLike } from "./common.js";
import type { AppEnv } from "./env.js";
import { readJsonObject, readString } from "./http.js";
import { buildSettingsView, resolveLineConfig } from "./line-settings.js";
import { fetchGroupName, formatTaipeiTime, GROUP_ID_RE, pushLineText } from "./line.js";
import { FixedWindowLimiter, RATE_LIMIT_WINDOW_MS } from "./rate-limit.js";
import { renderForbiddenPage, renderSettingsPage, renderSetupPage, renderUnavailablePage, renderUpgradePage } from "./settings-page.js";
import type { Account } from "./settings-store.js";

/** POST /settings/setup（用設定碼建立第一位管理員）每個 IP 每分鐘的請求上限（每次嘗試都算，不論對錯）。 */
export const SETUP_RATE_LIMIT_MAX = 5;
/** POST /api/settings/line/test（發測試訊息到 LINE 群組）每個 IP 每分鐘的上限，避免登入後被拿來洗版群組。 */
export const TEST_PUSH_RATE_LIMIT_MAX = 6;
/** token／secret 的長度上限（LINE 的 channel access token 約 170 字元）。 */
export const LINE_CREDENTIAL_MAX_CHARS = 1000;

export interface SettingsRouteDeps {
  env: AppEnv;
  setupGuard: SetupCodeGuard;
  fetchImpl: FetchLike;
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

// ===================================================================== 路由

/**
 * 設定頁與設定 API（只有管理員用得到；登入、登出、我的帳號在 login-routes.ts）：
 *
 *   GET  /settings               → 設定頁（HTML）：資料目錄不可用／建立第一位管理員（設定碼）／升級舊版密碼／
 *                                  沒登入 → 導向 /login／不是管理員 → 403 頁面／設定（LINE 設定、帳號管理）
 *   POST /settings/setup         → 用啟動 log 裡的一次性設定碼建立第一位管理員（姓名、Email、密碼；並登入）
 *   POST /settings/upgrade       → 把舊版的單一管理密碼升級成第一位管理員（目前的密碼、姓名、Email；並登入）
 *   GET  /api/settings           → 目前設定（token／secret 只回「已設定」與尾碼；另有 me）
 *   PUT  /api/settings/line      → 儲存 LINE 設定
 *   POST /api/settings/line/test → 推播一則測試訊息到已儲存的群組
 *   /api/accounts*               → 帳號管理（見 account-routes.ts）
 *
 * 資料目錄不可用時，全部回 503。沒登入回 401（頁面是 302 導向登入頁）；登入了但不是管理員回 403。
 * 所有會改動狀態的端點（POST／PUT／PATCH／DELETE）一律用 kit.mutate() 註冊：它在處理器之前統一檢查資料目錄、
 * Content-Type 與 X-Requested-With——新增端點時照這個寫法，就不會漏掉 CSRF 防護（tests/settings-auth.test.ts
 * 會走訪 app.routes，檢查每一條非 GET 的設定路由都擋得住沒帶標頭的請求）。
 */
export function registerSettingsRoutes(app: Hono, kit: AuthKit, deps: SettingsRouteDeps): void {
  const { env, setupGuard, fetchImpl } = deps;
  const { settings, now, log, mutate, allow } = kit;
  const setupLimiter = new FixedWindowLimiter(SETUP_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  const testPushLimiter = new FixedWindowLimiter(TEST_PUSH_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

  // ---------------------------------------------------------------- 頁面
  const page = (c: Parameters<AuthKit["sessionAccount"]>[0]) => {
    if (!settings.writable) return kit.html(c, 503, renderUnavailablePage);
    const data = settings.data;
    // 還沒有任何帳號：全新安裝（用設定碼建立第一位管理員）或舊版單一密碼待升級——這兩個流程各有自己的秘密（設定碼、舊密碼）擋著
    if (data.accounts.length === 0) return kit.html(c, 200, data.admin ? renderUpgradePage : renderSetupPage);
    const me = kit.sessionAccount(c);
    if (!me) return kit.redirectToLogin(c, "/settings");
    if (me.role !== "admin") return kit.html(c, 403, (ctx) => renderForbiddenPage(ctx, me));
    return kit.html(c, 200, (ctx) => renderSettingsPage(ctx, buildSettingsView(env, settings, me), data.accounts.map(toPublicAccount)));
  };
  app.get("/settings", page);
  app.get("/settings/", page);

  // ---------------------------------------------------------------- 建立第一位管理員／升級舊版密碼
  mutate("post", "/settings/setup", async (c) => {
    const limited = kit.hit(setupLimiter, c);
    if (limited) return limited;
    if (settings.data.accounts.length > 0) throw new ServiceError(409, "已經建立過帳號，請直接登入");
    if (settings.data.admin) throw new ServiceError(409, "這裡還是舊版的單一管理密碼：請改用目前的密碼升級成管理員帳號");
    const body = await readJsonObject(c);
    if (!setupGuard.verify(readString(body, "setupCode"))) {
      kit.audit(c, "（尚未有帳號）", "建立第一位管理員失敗：設定碼不正確", null, { failed: true });
      throw new ServiceError(403, "設定碼不正確");
    }
    const { role: _ignoredRole, ...withoutRole } = body; // 第一位一定是管理員：請求裡的 role（不論值）一律忽略
    const input = parseNewAccountInput(withoutRole, "admin");
    const passwordHash = await kit.gated(() => hashPassword(input.password));
    const iso = new Date(now()).toISOString();
    const account: Account = {
      id: newAccountId(),
      name: input.name,
      email: input.email,
      role: "admin", // 第一位一定是管理員（設定碼流程不接受 role 欄位）
      passwordHash,
      status: "active",
      sessionVersion: 1,
      createdAt: iso,
      updatedAt: iso,
      lastLoginAt: iso,
    };
    await settings.update((draft) => {
      if (draft.accounts.length > 0 || draft.admin) throw new ServiceError(409, "已經建立過帳號，請直接登入"); // 兩個請求同時進來時，後到的在這裡擋下
      draft.accounts.push(account);
    });
    setupGuard.consume();
    kit.issueSession(c, account);
    kit.audit(c, account.email, "建立第一位管理員", account.email);
    return c.json({ success: true });
  });

  mutate("post", "/settings/upgrade", async (c) => {
    const limited = kit.hit(kit.loginLimiter, c);
    if (limited) return limited;
    const legacy = settings.data.admin;
    if (!legacy || settings.data.accounts.length > 0) throw new ServiceError(409, "沒有需要升級的舊版管理密碼");
    const body = await readJsonObject(c);
    const profile = parseNameAndEmail(body);
    const currentPassword = readString(body, "currentPassword");
    const passwordOk = currentPassword.length <= PASSWORD_MAX_LENGTH && (await kit.gated(() => verifyPassword(currentPassword, legacy.passwordHash)));
    if (!passwordOk) {
      kit.audit(c, profile.email, "升級管理員帳號失敗：目前的密碼不正確", profile.email, { failed: true });
      throw new ServiceError(401, "目前的密碼不正確");
    }
    const iso = new Date(now()).toISOString();
    // 沿用同一個密碼雜湊（不要求重設密碼）；sessionSecret、line、lineCaptured 與其他欄位完全不動
    const account: Account = {
      id: newAccountId(),
      name: profile.name,
      email: profile.email,
      role: "admin", // 舊的單一管理密碼就是管理員
      passwordHash: legacy.passwordHash,
      status: "active",
      sessionVersion: 1,
      createdAt: iso,
      updatedAt: iso,
      lastLoginAt: iso,
    };
    await settings.update((draft) => {
      // 鎖內重新確認：兩個升級請求同時進來、或舊密碼在驗證期間被換掉，後到的在這裡擋下
      if (!draft.admin || draft.accounts.length > 0 || draft.admin.passwordHash !== legacy.passwordHash) {
        throw new ServiceError(409, "沒有需要升級的舊版管理密碼");
      }
      draft.accounts.push(account);
      draft.admin = null; // 舊的單一密碼只保留到升級完成為止
    });
    kit.issueSession(c, account);
    kit.audit(c, account.email, "升級為管理員帳號", account.email);
    return c.json({ success: true });
  });

  // ---------------------------------------------------------------- 設定 API（管理員）
  app.get("/api/settings", (c) => {
    kit.requireWritable();
    const me = kit.requireAdmin(c);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ success: true, data: buildSettingsView(env, settings, me) });
  });

  mutate("put", "/api/settings/line", async (c) => {
    const actor = kit.requireAdmin(c);
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
      requireAdminInDraft(draft, actor);
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
    kit.requireAdmin(c);
    const limited = kit.hit(testPushLimiter, c);
    if (limited) return limited;
    const line = resolveLineConfig(env, settings.data);
    if (line.token === "" || line.groupId === "") throw new ServiceError(400, "請先儲存 Channel access token 與群組 ID");
    const text = `🔔 savepoint-crate 測試通知 ${formatTaipeiTime(new Date(now()))}`;
    const result = await pushLineText({ fetchImpl, log, token: line.token }, line.groupId, text);
    if (!result.ok) throw new ServiceError(502, result.error); // 固定短句，不轉發 LINE 的原始回應
    return c.json({ success: true, notified: true });
  });

  // ---------------------------------------------------------------- 帳號管理（/api/accounts*）
  registerAccountRoutes(app, kit);

  // 其他方法一律 405（要放在上面的處理器之後）。
  allow("/settings", "GET");
  for (const path of ["/settings/setup", "/settings/upgrade", "/api/settings/line/test"]) allow(path, "POST");
  allow("/api/settings", "GET");
  allow("/api/settings/line", "PUT");
}
