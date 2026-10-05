import type { Hono } from "hono";

import { emailForLog, normalizeEmail, requireActorInDraft } from "./accounts.js";
import { DUMMY_PASSWORD_HASH, hashPassword, PASSWORD_MAX_LENGTH, validateNewPassword, verifyPassword } from "./auth.js";
import { LOGIN_FAILED_MESSAGE, safeNextPath, type AuthKit } from "./auth-kit.js";
import { ServiceError } from "./common.js";
import { readJsonObject, readString } from "./http.js";
import { renderAccountPage, renderLoginPage, renderNoAccountsPage, renderUnavailablePage } from "./settings-page.js";

/**
 * 登入閘門相關的路由（所有人、任一角色都用得到）：
 *
 *   GET  /login            → 登入頁（Email＋密碼）；已登入者導向 /；還沒有任何帳號時顯示「請管理員先到設定頁」
 *   POST /login            → Email＋密碼登入，發 sp_session cookie，回 { success, next }（next 只接受同源的相對路徑）
 *   POST /logout           → 登出（清 cookie；伺服器不存 session，所以只清這個瀏覽器）
 *   GET  /api/me           → 目前登入者 { id, name, email, role }
 *   GET  /account          → 我的帳號頁：姓名／Email／角色、變更我的密碼
 *   POST /account/password → 更改「自己」的密碼（任一角色；自己所有的登入全部失效，並重新登入目前這個瀏覽器）
 *
 * 狀態變更的端點一律用 kit.mutate() 註冊（資料目錄可用 → application/json → X-Requested-With）。
 */
export function registerLoginRoutes(app: Hono, kit: AuthKit): void {
  const { settings, now, log } = kit;

  // ---------------------------------------------------------------- 登入頁
  app.get("/login", (c) => {
    if (!settings.writable) return kit.html(c, 503, renderUnavailablePage);
    const data = settings.data;
    // 還沒有任何帳號（全新安裝、或舊版的單一密碼還沒升級）：沒有人可以登入，請管理員先到設定頁完成第一次設定
    if (data.accounts.length === 0) return kit.html(c, 200, (ctx) => renderNoAccountsPage(ctx, data.admin !== null));
    if (kit.sessionAccount(c)) {
      c.header("Cache-Control", "no-store");
      return c.redirect("/", 302);
    }
    const next = safeNextPath(c.req.query("next"));
    return kit.html(c, 200, (ctx) => renderLoginPage(ctx, next));
  });

  kit.mutate("post", "/login", async (c) => {
    const limited = kit.hit(kit.loginLimiter, c);
    if (limited) return limited;
    const data = settings.data;
    if (data.accounts.length === 0) {
      if (data.admin) throw new ServiceError(409, "系統已改為帳號制：請管理員先到設定頁（/settings），用目前的管理密碼升級成管理員帳號");
      throw new ServiceError(400, "尚未建立任何帳號：請管理員先到設定頁（/settings），用設定碼建立第一位管理員");
    }
    const body = await readJsonObject(c);
    const email = normalizeEmail(body.email);
    const password = readString(body, "password");
    const account = email === null ? undefined : data.accounts.find((candidate) => candidate.email === email);
    const usable = account !== undefined && account.status === "active";
    // 一律跑一次 scrypt：查無帳號、帳號停用、Email 格式不對都拿固定的假雜湊驗，回應時間不洩漏帳號存不存在
    const passwordOk = await kit.gated(() => verifyPassword(password, usable ? account.passwordHash : DUMMY_PASSWORD_HASH));
    if (!usable || !passwordOk || password.length > PASSWORD_MAX_LENGTH) {
      kit.audit(c, emailForLog(body.email), "登入失敗", null, { failed: true });
      throw new ServiceError(401, LOGIN_FAILED_MESSAGE);
    }
    const iso = new Date(now()).toISOString();
    let sessionVersion = account.sessionVersion;
    try {
      await settings.update((draft) => {
        // 鎖內重新確認：驗證密碼期間帳號被停用、刪除或重設密碼，這次登入就作廢
        const live = draft.accounts.find((candidate) => candidate.id === account.id);
        if (!live || live.status !== "active" || live.passwordHash !== account.passwordHash) {
          throw new ServiceError(401, LOGIN_FAILED_MESSAGE);
        }
        live.lastLoginAt = iso;
        sessionVersion = live.sessionVersion;
      });
    } catch (error) {
      if (!(error instanceof ServiceError) || error.status !== 500) throw error;
      // 寫檔失敗（Volume 滿了或變成唯讀）：lastLoginAt 只是方便查看的紀錄，登入本身不該因為它失敗。
      // 記一行警告，照樣讓這位使用者登入；記憶體裡的設定沒有被換掉，所以這裡再確認一次帳號此刻仍然有效。
      const live = settings.data.accounts.find((candidate) => candidate.id === account.id);
      if (!live || live.status !== "active" || live.passwordHash !== account.passwordHash) throw new ServiceError(401, LOGIN_FAILED_MESSAGE);
      sessionVersion = live.sessionVersion;
      log.warn(`[accounts] ${account.email} 登入成功，但無法更新最後登入時間：${error.message}`);
    }
    kit.issueSession(c, { id: account.id, sessionVersion });
    kit.audit(c, account.email, "登入成功", null);
    return c.json({ success: true, next: safeNextPath(body.next) });
  });

  kit.mutate("post", "/logout", (c) => {
    kit.clearSession(c);
    return c.json({ success: true });
  });

  // ---------------------------------------------------------------- 目前登入者
  app.get("/api/me", (c) => {
    kit.requireWritable();
    const me = kit.requireActor(c);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ success: true, data: { id: me.id, name: me.name, email: me.email, role: me.role } });
  });

  // ---------------------------------------------------------------- 我的帳號
  app.get("/account", (c) => {
    if (!settings.writable) return kit.html(c, 503, renderUnavailablePage);
    const me = kit.sessionAccount(c);
    if (!me) return kit.redirectToLogin(c, "/account");
    return kit.html(c, 200, (ctx) => renderAccountPage(ctx, me));
  });

  kit.mutate("post", "/account/password", async (c) => {
    const actor = kit.requireActor(c);
    const limited = kit.hit(kit.loginLimiter, c);
    if (limited) return limited;
    const body = await readJsonObject(c);
    const currentPassword = readString(body, "currentPassword");
    const newPassword = readString(body, "newPassword");
    const currentOk = currentPassword.length <= PASSWORD_MAX_LENGTH && (await kit.gated(() => verifyPassword(currentPassword, actor.passwordHash)));
    if (!currentOk) {
      kit.audit(c, actor.email, "變更自己的密碼失敗：目前的密碼不正確", actor.email, { failed: true });
      throw new ServiceError(403, "目前的密碼不正確");
    }
    const problem = validateNewPassword(newPassword);
    if (problem) throw new ServiceError(400, problem);
    if (newPassword === currentPassword) throw new ServiceError(400, "新密碼不能和目前的密碼相同");
    const passwordHash = await kit.gated(() => hashPassword(newPassword));
    let sessionVersion = actor.sessionVersion;
    await settings.update((draft) => {
      const me = requireActorInDraft(draft, actor);
      if (me.passwordHash !== actor.passwordHash) throw new ServiceError(409, "密碼剛剛被更改過了，請重新整理後再試");
      me.passwordHash = passwordHash;
      me.sessionVersion += 1; // 這個帳號所有舊的登入 cookie 一起失效（其他帳號不受影響）
      me.updatedAt = new Date(now()).toISOString();
      sessionVersion = me.sessionVersion;
    });
    kit.issueSession(c, { id: actor.id, sessionVersion }); // 用新的 sessionVersion 重新發給目前這個瀏覽器
    kit.audit(c, actor.email, "變更自己的密碼", actor.email);
    return c.json({ success: true });
  });

  kit.allow("/login", "GET, POST");
  kit.allow("/logout", "POST");
  kit.allow("/api/me", "GET");
  kit.allow("/account", "GET");
  kit.allow("/account/password", "POST");
}
