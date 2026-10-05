import type { Context, Hono } from "hono";

import {
  ACCOUNT_MAX_COUNT,
  assertNotLastActiveAdmin,
  EMAIL_INVALID_MESSAGE,
  emailTaken,
  newAccountId,
  normalizeEmail,
  parseName,
  parseNewAccountInput,
  parseRole,
  requireAdminInDraft,
  ROLE_INVALID_MESSAGE,
  toPublicAccount,
  type AccountPublic,
} from "./accounts.js";
import { hashPassword, validateNewPassword } from "./auth.js";
import type { AuthKit } from "./auth-kit.js";
import { ServiceError } from "./common.js";
import { readJsonObject, readString } from "./http.js";
import type { Account, AccountRole } from "./settings-store.js";

/**
 * 帳號管理 API（全部要管理員角色；會改動狀態的一律走 kit.mutate()＝統一的 CSRF 檢查）：
 *
 *   GET    /api/accounts                  → 所有帳號（不含密碼雜湊）
 *   POST   /api/accounts                  → 新增 { name, email, password, role? }（role 預設 user）
 *   PATCH  /api/accounts/:id              → 修改 { name?, email?, role? }
 *   POST   /api/accounts/:id/password     → 重設「他人」的密碼 { newPassword }（該帳號所有登入失效）
 *   POST   /api/accounts/:id/status       → 停用／啟用 { status: "active" | "disabled" }
 *   DELETE /api/accounts/:id              → 刪除
 *
 * 規則：不能停用、刪除自己；不能把自己改成一般使用者；不能停用、刪除、降級最後一位啟用中的管理員；
 * Email（不分大小寫）不可重複（409）。重設密碼、停用、啟用、改角色都讓對方的 sessionVersion 加一（舊的登入立刻失效）。
 * 所有規則都在 SettingsStore.update 的鎖內重新檢查（含「發出請求的人現在還是有效的管理員」），
 * 所以兩位管理員同時互相停用、同時新增同一個 Email 這類競態不會留下壞狀態。
 */

const ID_RE = /^[0-9a-f]{32}$/;
const EMAIL_TAKEN_MESSAGE = "這個 Email 已經是其他帳號的登入帳號";
const NOT_FOUND_MESSAGE = "找不到這個帳號";
const SELF_PASSWORD_MESSAGE = "要更改自己的密碼，請用「我的帳號」頁的變更密碼（需要輸入目前的密碼）";
const SELF_DEMOTE_MESSAGE = "不能把自己改成一般使用者";
const CAP_MESSAGE = `帳號數量已達上限（${ACCOUNT_MAX_COUNT} 個）`;

function targetIdOf(c: Context): string {
  const id: string | undefined = c.req.param("id");
  if (!id || !ID_RE.test(id)) throw new ServiceError(404, NOT_FOUND_MESSAGE);
  return id;
}

function findTarget(draft: { accounts: Account[] }, id: string): Account {
  const target = draft.accounts.find((account) => account.id === id);
  if (!target) throw new ServiceError(404, NOT_FOUND_MESSAGE);
  return target;
}

export function registerAccountRoutes(app: Hono, kit: AuthKit): void {
  const { settings, now, audit, mutate, allow } = kit;
  const iso = (): string => new Date(now()).toISOString();

  app.get("/api/accounts", (c) => {
    kit.requireWritable();
    kit.requireAdmin(c);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ success: true, data: { accounts: settings.data.accounts.map(toPublicAccount) } });
  });

  mutate("post", "/api/accounts", async (c) => {
    const actor = kit.requireAdmin(c);
    const input = parseNewAccountInput(await readJsonObject(c));
    if (settings.data.accounts.length >= ACCOUNT_MAX_COUNT) throw new ServiceError(409, CAP_MESSAGE);
    if (settings.data.accounts.some((account) => account.email === input.email)) throw new ServiceError(409, EMAIL_TAKEN_MESSAGE); // 先擋重複，省一次 scrypt
    const passwordHash = await kit.gated(() => hashPassword(input.password));
    const stamp = iso();
    const account: Account = {
      id: newAccountId(),
      name: input.name,
      email: input.email,
      role: input.role,
      passwordHash,
      status: "active",
      sessionVersion: 1,
      createdAt: stamp,
      updatedAt: stamp,
      lastLoginAt: null,
    };
    await settings.update((draft) => {
      requireAdminInDraft(draft, actor);
      if (draft.accounts.length >= ACCOUNT_MAX_COUNT) throw new ServiceError(409, CAP_MESSAGE);
      if (emailTaken(draft, account.email)) throw new ServiceError(409, EMAIL_TAKEN_MESSAGE);
      draft.accounts.push(account);
    });
    audit(c, actor.email, "新增帳號", account.email, { detail: `（角色 ${account.role}）` });
    return c.json({ success: true, data: { account: toPublicAccount(account) } });
  });

  mutate("patch", "/api/accounts/:id", async (c) => {
    const actor = kit.requireAdmin(c);
    const id = targetIdOf(c);
    const body = await readJsonObject(c);
    let name: string | undefined;
    let email: string | undefined;
    let role: AccountRole | undefined;
    if (body.name !== undefined) {
      const parsed = parseName(body.name);
      if (!parsed.ok) throw new ServiceError(400, parsed.error);
      name = parsed.value;
    }
    if (body.email !== undefined) {
      const normalized = normalizeEmail(body.email);
      if (normalized === null) throw new ServiceError(400, EMAIL_INVALID_MESSAGE);
      email = normalized;
    }
    if (body.role !== undefined) {
      const parsed = parseRole(body.role);
      if (parsed === null) throw new ServiceError(400, ROLE_INVALID_MESSAGE);
      role = parsed;
    }
    if (name === undefined && email === undefined && role === undefined) throw new ServiceError(400, "沒有要修改的欄位（name、email 或 role）");
    if (role === "user" && id === actor.id) throw new ServiceError(409, SELF_DEMOTE_MESSAGE);

    const changes: string[] = [];
    let oldEmail = "";
    let result!: AccountPublic;
    await settings.update((draft) => {
      requireAdminInDraft(draft, actor);
      const target = findTarget(draft, id);
      oldEmail = target.email;
      if (email !== undefined && email !== target.email && emailTaken(draft, email, id)) throw new ServiceError(409, EMAIL_TAKEN_MESSAGE);
      if (name !== undefined && name !== target.name) {
        target.name = name;
        changes.push("姓名");
      }
      if (email !== undefined && email !== target.email) {
        target.email = email;
        changes.push(`Email 改為 ${email}`);
      }
      if (role !== undefined && role !== target.role) {
        if (role === "user") {
          if (target.id === actor.id) throw new ServiceError(409, SELF_DEMOTE_MESSAGE);
          assertNotLastActiveAdmin(draft, target, "降級");
        }
        changes.push(`角色 ${target.role} → ${role}`);
        target.role = role;
        target.sessionVersion += 1; // 改角色：對方舊的登入立刻失效，重新登入後才拿到新的權限
      }
      if (changes.length > 0) target.updatedAt = iso();
      result = toPublicAccount(target);
    });
    if (changes.length > 0) audit(c, actor.email, "修改帳號", oldEmail, { detail: `（${changes.join("、")}）` });
    return c.json({ success: true, data: { account: result } });
  });

  mutate("post", "/api/accounts/:id/password", async (c) => {
    const actor = kit.requireAdmin(c);
    const id = targetIdOf(c);
    if (id === actor.id) throw new ServiceError(400, SELF_PASSWORD_MESSAGE);
    const newPassword = readString(await readJsonObject(c), "newPassword");
    const problem = validateNewPassword(newPassword);
    if (problem) throw new ServiceError(400, problem);
    if (!settings.data.accounts.some((account) => account.id === id)) throw new ServiceError(404, NOT_FOUND_MESSAGE); // 先擋不存在的，省一次 scrypt
    const passwordHash = await kit.gated(() => hashPassword(newPassword));
    let targetEmail = "";
    await settings.update((draft) => {
      requireAdminInDraft(draft, actor);
      const target = findTarget(draft, id);
      target.passwordHash = passwordHash;
      target.sessionVersion += 1; // 這個帳號所有已發出的登入 cookie 一起失效（其他帳號不受影響）
      target.updatedAt = iso();
      targetEmail = target.email;
    });
    audit(c, actor.email, "重設密碼", targetEmail);
    return c.json({ success: true });
  });

  mutate("post", "/api/accounts/:id/status", async (c) => {
    const actor = kit.requireAdmin(c);
    const id = targetIdOf(c);
    const status = (await readJsonObject(c)).status;
    if (status !== "active" && status !== "disabled") throw new ServiceError(400, "status 必須是 active 或 disabled");
    if (status === "disabled" && id === actor.id) throw new ServiceError(409, "不能停用自己的帳號");

    let changed = false;
    let targetEmail = "";
    let result!: AccountPublic;
    await settings.update((draft) => {
      requireAdminInDraft(draft, actor);
      const target = findTarget(draft, id);
      targetEmail = target.email;
      if (target.status !== status) {
        if (status === "disabled") {
          if (target.id === actor.id) throw new ServiceError(409, "不能停用自己的帳號");
          assertNotLastActiveAdmin(draft, target, "停用");
        }
        target.status = status;
        target.sessionVersion += 1; // 停用／啟用都讓這個帳號舊的登入 cookie 失效（停用後再啟用也不會讓舊 cookie 復活）
        target.updatedAt = iso();
        changed = true;
      }
      result = toPublicAccount(target);
    });
    if (changed) audit(c, actor.email, status === "disabled" ? "停用帳號" : "啟用帳號", targetEmail);
    return c.json({ success: true, data: { account: result } });
  });

  mutate("delete", "/api/accounts/:id", async (c) => {
    const actor = kit.requireAdmin(c);
    const id = targetIdOf(c);
    if (id === actor.id) throw new ServiceError(409, "不能刪除自己的帳號");
    let targetEmail = "";
    await settings.update((draft) => {
      requireAdminInDraft(draft, actor);
      const target = findTarget(draft, id);
      targetEmail = target.email;
      assertNotLastActiveAdmin(draft, target, "刪除");
      draft.accounts.splice(draft.accounts.indexOf(target), 1);
    });
    audit(c, actor.email, "刪除帳號", targetEmail);
    return c.json({ success: true });
  });

  allow("/api/accounts", "GET, POST");
  allow("/api/accounts/:id", "PATCH, DELETE");
  allow("/api/accounts/:id/password", "POST");
  allow("/api/accounts/:id/status", "POST");
}
