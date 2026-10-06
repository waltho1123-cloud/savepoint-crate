import { randomBytes } from "node:crypto";

import { validateNewPassword } from "./auth.js";
import { ServiceError } from "./common.js";
import type { Account, AccountRole, ReadonlySettings, SettingsData } from "./settings-store.js";

/**
 * 登入帳號的小工具：姓名、Email、角色的驗證／正規化、對外的檢視（絕不含密碼雜湊）、帳號統計、
 * 以及「在鎖內」重新確認操作者的檢查。
 */

export const NAME_MAX_CHARS = 50;
/** 帳號數量上限（防止被灌成無限多筆、讓整份設定檔越寫越大）。 */
export const ACCOUNT_MAX_COUNT = 200;
export const EMAIL_MAX_CHARS = 254;
const EMAIL_LOCAL_MAX_CHARS = 64;

/** 新帳號的 id：隨機 16 位元組的十六進位（32 字元）。 */
export function newAccountId(): string {
  return randomBytes(16).toString("hex");
}

// ===================================================================== Email

// 一般 RFC 5322 的寬鬆子集（ASCII）：本地部分是用「.」隔開的 atom（不可開頭／結尾／連續的點），網域至少兩段、
// 每段 1～63 字元的英數字與連字號（不可開頭或結尾是連字號），最後一段不能全是數字（擋掉 a@1.2.3.4 這種）。
const LOCAL_PART_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * 正規化並驗證 Email：trim、轉小寫；格式不合（不是字串、空、超過 254 字元、本地部分超過 64 字元、字元不合法…）回 null。
 * 回傳的字串就是要存、要拿來比對唯一性的那個。
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email === "" || email.length > EMAIL_MAX_CHARS) return null;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return null;
  const local = email.slice(0, at);
  const labels = email.slice(at + 1).split(".");
  if (local.length > EMAIL_LOCAL_MAX_CHARS || !LOCAL_PART_RE.test(local)) return null;
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL_RE.test(label))) return null;
  if (!/[a-z]/.test(labels[labels.length - 1] ?? "")) return null;
  return email;
}

/** 寫進 log 用的 Email：能正規化就用正規化後的；否則固定寫「（格式不正確）」——攻擊者填的任意字串不會原樣進 log。 */
export function emailForLog(raw: unknown): string {
  return normalizeEmail(raw) ?? "（格式不正確的 Email）";
}

// ===================================================================== 姓名

// 不能出現在姓名裡的字元：控制字元（含換行）、行／段落分隔符號、會讓文字顯示順序反轉的雙向控制字元（可以拿來偽裝成別人的名字），
// 以及零寬字元（零寬空白 U+200B、字詞連接符 U+2060、BOM U+FEFF、蒙古文元音分隔符 U+180E）——這些在姓名裡沒有正當用途，
// 只會讓兩個看起來一模一樣的名字其實不同。（零寬連字 U+200D／零寬非連字 U+200C 在表情符號與部分文字裡有正當用途，所以不擋，
// 但下面要求姓名至少有一個看得見的字元。）
const FORBIDDEN_NAME_CHARS_RE = /[\p{Cc}\p{Zl}\p{Zp}\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\u061C\u180E\uFEFF]/u;
// 看不見的字元：空白、格式字元、控制字元，以及幾個顯示成空白的填充字元（韓文填充 U+115F／U+1160／U+3164／U+FFA0、點字空白 U+2800、
// 高棉文固有母音 U+17B4／U+17B5）。姓名至少要有一個「看得見」的字元，不然管理員表格上會是一列空白的名字。
const INVISIBLE_NAME_CHAR_RE = /[\p{White_Space}\p{Cf}\p{Cc}\u115F\u1160\u3164\uFFA0\u2800\u17B4\u17B5]/u;

/** 驗證姓名：trim 後 1～50 個字元（以 Unicode 字元計，emoji 算 1 個），不可含換行、控制字元、雙向控制字元與零寬字元，且至少要有一個看得見的字元。 */
export function parseName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const error = `姓名需為 1～${NAME_MAX_CHARS} 個字元（不可含換行、控制字元或零寬字元，且要有看得見的字）`;
  if (typeof raw !== "string") return { ok: false, error };
  const name = raw.trim();
  const chars = Array.from(name);
  if (chars.length < 1 || chars.length > NAME_MAX_CHARS || FORBIDDEN_NAME_CHARS_RE.test(name)) return { ok: false, error };
  if (!chars.some((char) => !INVISIBLE_NAME_CHAR_RE.test(char))) return { ok: false, error };
  return { ok: true, value: name };
}

export const EMAIL_INVALID_MESSAGE = `Email 格式不正確（需為 name@example.com 的形式，最多 ${EMAIL_MAX_CHARS} 字元）`;

// ===================================================================== 角色

export const ROLE_INVALID_MESSAGE = "角色必須是 admin（管理員）或 user（一般使用者）";

/** 角色的顯示名稱（頁面、LINE 以外的地方用）。 */
export function roleLabel(role: AccountRole): string {
  return role === "admin" ? "管理員" : "一般使用者";
}

/** 驗證角色欄位：只接受 "admin" 或 "user"（精確比對，不分大小寫的寬鬆處理一律當錯誤）；其他回 null。 */
export function parseRole(raw: unknown): AccountRole | null {
  return raw === "admin" || raw === "user" ? raw : null;
}

/** 驗證請求內容裡的姓名與 Email（升級舊版密碼時用，沒有新密碼）；不合法丟 400。 */
export function parseNameAndEmail(body: Record<string, unknown>): { name: string; email: string } {
  const name = parseName(body.name);
  if (!name.ok) throw new ServiceError(400, name.error);
  const email = normalizeEmail(body.email);
  if (email === null) throw new ServiceError(400, EMAIL_INVALID_MESSAGE);
  return { name: name.value, email };
}

/**
 * 驗證建立帳號的請求內容：姓名、Email、密碼（8～200 字元）、角色；不合法丟 400（姓名 → Email → 密碼 → 角色的順序）。
 * 沒給 role 時用 defaultRole（API 預設 user：最小權限）；給了就必須是 admin 或 user。
 */
export function parseNewAccountInput(
  body: Record<string, unknown>,
  defaultRole: AccountRole = "user",
): { name: string; email: string; password: string; role: AccountRole } {
  const { name, email } = parseNameAndEmail(body);
  const password = typeof body.password === "string" ? body.password : "";
  const problem = validateNewPassword(password);
  if (problem) throw new ServiceError(400, problem);
  let role = defaultRole;
  if (body.role !== undefined) {
    const parsed = parseRole(body.role);
    if (parsed === null) throw new ServiceError(400, ROLE_INVALID_MESSAGE);
    role = parsed;
  }
  return { name, email, password, role };
}

// ===================================================================== 檢視與統計

/** 對外的帳號資料：沒有密碼雜湊、沒有 sessionVersion。 */
export interface AccountPublic {
  id: string;
  name: string;
  email: string;
  role: AccountRole;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export function toPublicAccount(account: Readonly<Account>): AccountPublic {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    role: account.role,
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastLoginAt: account.lastLoginAt,
  };
}

export interface AccountSummary {
  /** 有至少一位啟用中的管理員（角色 admin），或仍有待升級的舊版單一密碼：設定頁「有人能進去」。 */
  adminConfigured: boolean;
  /** 角色是 admin 的帳號數（含停用的）。 */
  adminCount: number;
  /** 帳號總數（兩種角色、含停用的）。 */
  accountCount: number;
  /** 還有舊版的單一管理密碼沒升級成帳號。 */
  legacyAdminPending: boolean;
}

export function summarizeAccounts(data: ReadonlySettings): AccountSummary {
  const legacyAdminPending = data.admin !== null && data.accounts.length === 0;
  const hasActiveAdmin = data.accounts.some((account) => account.role === "admin" && account.status === "active");
  return {
    adminConfigured: hasActiveAdmin || legacyAdminPending,
    adminCount: data.accounts.filter((account) => account.role === "admin").length,
    accountCount: data.accounts.length,
    legacyAdminPending,
  };
}

// ===================================================================== 在鎖內重新確認

export const ADMIN_REQUIRED_MESSAGE = "需要管理員權限";

/**
 * 在 SettingsStore.update 的 mutator（也就是序列化的臨界區）裡，重新確認「發出這個請求的人」現在還是有效的帳號：
 * 帳號還在、啟用中、sessionVersion 沒變。請求進來時雖然檢查過一次，但中間可能有別的請求先把他停用、刪除、重設了密碼
 * 或改了角色（例如兩位管理員同時互相停用對方）——所有改動狀態的操作都要在鎖內再確認一次，才不會留下「沒有任何啟用中管理員」
 * 的狀態，也不會讓剛被停用的人還改得動設定。回傳 draft 裡的那個帳號物件；不符就丟 401。
 */
export function requireActorInDraft(draft: SettingsData, actor: Readonly<Pick<Account, "id" | "sessionVersion">>): Account {
  const found = draft.accounts.find((account) => account.id === actor.id);
  if (!found || found.status !== "active" || found.sessionVersion !== actor.sessionVersion) {
    throw new ServiceError(401, "請先登入");
  }
  return found;
}

/** 同上，而且操作者現在的角色還是 admin（管理員專用的操作在鎖內用這個）；角色不是 admin 丟 403。 */
export function requireAdminInDraft(draft: SettingsData, actor: Readonly<Pick<Account, "id" | "sessionVersion">>): Account {
  const found = requireActorInDraft(draft, actor);
  if (found.role !== "admin") throw new ServiceError(403, ADMIN_REQUIRED_MESSAGE);
  return found;
}

/** 除了 exceptId 這一位之外，還有幾位啟用中的管理員（停用、刪除或降級某一位之前，確認不會留下「沒有任何管理員能登入」）。 */
export function otherActiveAdminCount(draft: Pick<SettingsData, "accounts">, exceptId: string): number {
  return draft.accounts.filter((account) => account.id !== exceptId && account.role === "admin" && account.status === "active").length;
}

/**
 * 最後一位啟用中的管理員保護：要停用、刪除或降級的對象是啟用中的管理員、而且沒有其他啟用中的管理員了，就丟 409。
 * 正常情況由「操作者必須是啟用中的管理員」加上「不能對自己」保證到不了這裡；仍然明確檢查當第二道防線，
 * 萬一以後放寬其中一條，也不會留下沒有任何管理員能登入的狀態。
 */
export function assertNotLastActiveAdmin(
  draft: Pick<SettingsData, "accounts">,
  target: Readonly<Pick<Account, "id" | "role" | "status">>,
  action: "停用" | "刪除" | "降級",
): void {
  if (target.role === "admin" && target.status === "active" && otherActiveAdminCount(draft, target.id) === 0) {
    throw new ServiceError(409, `不能${action}最後一位啟用中的管理員`);
  }
}

/** 已經有人用這個 Email 了（排除自己）。 */
export function emailTaken(draft: SettingsData, email: string, exceptId?: string): boolean {
  return draft.accounts.some((account) => account.email === email && account.id !== exceptId);
}
