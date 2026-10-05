import type { Context, Hono } from "hono";

import {
  ADMIN_MAX_COUNT,
  EMAIL_INVALID_MESSAGE,
  emailTaken,
  newAdminId,
  normalizeEmail,
  otherActiveAdminCount,
  parseName,
  parseNewAccountInput,
  requireActorInDraft,
  toPublicAdmin,
  type AdminPublic,
} from "./admins.js";
import { hashPassword, validateNewPassword } from "./auth.js";
import { ServiceError } from "./common.js";
import { readJsonObject, readString } from "./http.js";
import type { AdminAccount, SettingsStore } from "./settings-store.js";

/**
 * 管理員帳號管理 API（全部需要登入；會改動狀態的一律走 mutate()＝統一的 CSRF 檢查）：
 *
 *   GET    /api/admins                  → 所有管理員（不含密碼雜湊）
 *   POST   /api/admins                  → 新增 { name, email, password }
 *   PATCH  /api/admins/:id              → 修改 { name?, email? }
 *   POST   /api/admins/:id/password     → 重設「他人」的密碼 { newPassword }（該帳號所有登入失效）
 *   POST   /api/admins/:id/status       → 停用／啟用 { status: "active" | "disabled" }
 *   DELETE /api/admins/:id              → 刪除
 *
 * 規則：不能停用或刪除自己；不能停用或刪除最後一位啟用中的管理員；Email（不分大小寫）不可重複（409）。
 * 所有規則都在 SettingsStore.update 的鎖內重新檢查（含「發出請求的人現在還是有效的管理員」），
 * 所以兩位管理員同時互相停用、同時新增同一個 Email 這類競態不會留下壞狀態。
 */

export interface AdminRouteKit {
  settings: SettingsStore;
  now: () => number;
  requireWritable: () => void;
  /** 目前登入的管理員（沒登入丟 401）。 */
  requireActor: (c: Context) => Readonly<AdminAccount>;
  /** 跑 scrypt 的並行閘門（見 settings-routes.ts）。 */
  gated: <T>(work: () => Promise<T>) => Promise<T>;
  audit: (c: Context, actorEmail: string, action: string, targetEmail: string | null, options?: { detail?: string; failed?: boolean }) => void;
  mutate: (method: "post" | "put" | "patch" | "delete", path: string, handler: (c: Context) => Response | Promise<Response>) => void;
  allow: (path: string, methods: string) => void;
}

const ID_RE = /^[0-9a-f]{32}$/;
const EMAIL_TAKEN_MESSAGE = "這個 Email 已經是其他管理員的帳號";
const NOT_FOUND_MESSAGE = "找不到這位管理員";
const SELF_PASSWORD_MESSAGE = "要更改自己的密碼，請用「我的帳號」裡的變更密碼（需要輸入目前的密碼）";

function targetIdOf(c: Context): string {
  const id: string | undefined = c.req.param("id");
  if (!id || !ID_RE.test(id)) throw new ServiceError(404, NOT_FOUND_MESSAGE);
  return id;
}

function findTarget(draft: { admins: AdminAccount[] }, id: string): AdminAccount {
  const target = draft.admins.find((admin) => admin.id === id);
  if (!target) throw new ServiceError(404, NOT_FOUND_MESSAGE);
  return target;
}

export function registerAdminRoutes(app: Hono, kit: AdminRouteKit): void {
  const { settings, now, requireWritable, requireActor, gated, audit, mutate, allow } = kit;
  const iso = (): string => new Date(now()).toISOString();

  app.get("/api/admins", (c) => {
    requireWritable();
    requireActor(c);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ success: true, data: { admins: settings.data.admins.map(toPublicAdmin) } });
  });

  mutate("post", "/api/admins", async (c) => {
    const actor = requireActor(c);
    const input = parseNewAccountInput(await readJsonObject(c));
    if (settings.data.admins.length >= ADMIN_MAX_COUNT) throw new ServiceError(409, `管理員數量已達上限（${ADMIN_MAX_COUNT} 位）`);
    if (settings.data.admins.some((admin) => admin.email === input.email)) throw new ServiceError(409, EMAIL_TAKEN_MESSAGE); // 先擋重複，省一次 scrypt
    const passwordHash = await gated(() => hashPassword(input.password));
    const stamp = iso();
    const account: AdminAccount = {
      id: newAdminId(),
      name: input.name,
      email: input.email,
      passwordHash,
      status: "active",
      sessionVersion: 1,
      createdAt: stamp,
      updatedAt: stamp,
      lastLoginAt: null,
    };
    await settings.update((draft) => {
      requireActorInDraft(draft, actor);
      if (draft.admins.length >= ADMIN_MAX_COUNT) throw new ServiceError(409, `管理員數量已達上限（${ADMIN_MAX_COUNT} 位）`);
      if (emailTaken(draft, account.email)) throw new ServiceError(409, EMAIL_TAKEN_MESSAGE);
      draft.admins.push(account);
    });
    audit(c, actor.email, "新增管理員", account.email);
    return c.json({ success: true, data: { admin: toPublicAdmin(account) } });
  });

  mutate("patch", "/api/admins/:id", async (c) => {
    const actor = requireActor(c);
    const id = targetIdOf(c);
    const body = await readJsonObject(c);
    let name: string | undefined;
    let email: string | undefined;
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
    if (name === undefined && email === undefined) throw new ServiceError(400, "沒有要修改的欄位（name 或 email）");

    const changes: string[] = [];
    let oldEmail = "";
    let result!: AdminPublic;
    await settings.update((draft) => {
      requireActorInDraft(draft, actor);
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
      if (changes.length > 0) target.updatedAt = iso();
      result = toPublicAdmin(target);
    });
    if (changes.length > 0) audit(c, actor.email, "修改管理員", oldEmail, { detail: `（${changes.join("、")}）` });
    return c.json({ success: true, data: { admin: result } });
  });

  mutate("post", "/api/admins/:id/password", async (c) => {
    const actor = requireActor(c);
    const id = targetIdOf(c);
    if (id === actor.id) throw new ServiceError(400, SELF_PASSWORD_MESSAGE);
    const newPassword = readString(await readJsonObject(c), "newPassword");
    const problem = validateNewPassword(newPassword);
    if (problem) throw new ServiceError(400, problem);
    if (!settings.data.admins.some((admin) => admin.id === id)) throw new ServiceError(404, NOT_FOUND_MESSAGE); // 先擋不存在的，省一次 scrypt
    const passwordHash = await gated(() => hashPassword(newPassword));
    let targetEmail = "";
    await settings.update((draft) => {
      requireActorInDraft(draft, actor);
      const target = findTarget(draft, id);
      target.passwordHash = passwordHash;
      target.sessionVersion += 1; // 這個帳號所有已發出的登入 cookie 一起失效（其他管理員不受影響）
      target.updatedAt = iso();
      targetEmail = target.email;
    });
    audit(c, actor.email, "重設密碼", targetEmail);
    return c.json({ success: true });
  });

  mutate("post", "/api/admins/:id/status", async (c) => {
    const actor = requireActor(c);
    const id = targetIdOf(c);
    const status = (await readJsonObject(c)).status;
    if (status !== "active" && status !== "disabled") throw new ServiceError(400, "status 必須是 active 或 disabled");
    if (status === "disabled" && id === actor.id) throw new ServiceError(409, "不能停用自己的帳號");

    let changed = false;
    let targetEmail = "";
    let result!: AdminPublic;
    await settings.update((draft) => {
      requireActorInDraft(draft, actor);
      const target = findTarget(draft, id);
      targetEmail = target.email;
      if (target.status !== status) {
        if (status === "disabled") {
          // 下面兩條規則在正常情況下由「操作者必須是啟用中的管理員」加上「不能對自己」保證，這裡仍然明確檢查：
          // 萬一以後放寬其中一條，也不會留下沒有任何人能登入的狀態。
          if (target.id === actor.id) throw new ServiceError(409, "不能停用自己的帳號");
          if (otherActiveAdminCount(draft, target.id) === 0) throw new ServiceError(409, "不能停用最後一位啟用中的管理員");
        }
        target.status = status;
        target.sessionVersion += 1; // 停用／啟用都讓這個帳號舊的登入 cookie 失效（停用後再啟用也不會讓舊 cookie 復活）
        target.updatedAt = iso();
        changed = true;
      }
      result = toPublicAdmin(target);
    });
    if (changed) audit(c, actor.email, status === "disabled" ? "停用管理員" : "啟用管理員", targetEmail);
    return c.json({ success: true, data: { admin: result } });
  });

  mutate("delete", "/api/admins/:id", async (c) => {
    const actor = requireActor(c);
    const id = targetIdOf(c);
    if (id === actor.id) throw new ServiceError(409, "不能刪除自己的帳號");
    let targetEmail = "";
    await settings.update((draft) => {
      requireActorInDraft(draft, actor);
      const target = findTarget(draft, id);
      targetEmail = target.email;
      if (target.status === "active" && otherActiveAdminCount(draft, target.id) === 0) {
        throw new ServiceError(409, "不能刪除最後一位啟用中的管理員"); // 同上：由「不能對自己」保證，這裡是第二道防線
      }
      draft.admins.splice(draft.admins.indexOf(target), 1);
    });
    audit(c, actor.email, "刪除管理員", targetEmail);
    return c.json({ success: true });
  });

  allow("/api/admins", "GET, POST");
  allow("/api/admins/:id", "PATCH, DELETE");
  allow("/api/admins/:id/password", "POST");
  allow("/api/admins/:id/status", "POST");
}
