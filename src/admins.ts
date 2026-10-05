import { randomBytes } from "node:crypto";

import { validateNewPassword } from "./auth.js";
import { ServiceError } from "./common.js";
import type { AdminAccount, ReadonlySettings, SettingsData } from "./settings-store.js";

/**
 * 管理員帳號的小工具：姓名與 Email 的驗證／正規化、對外的檢視（絕不含密碼雜湊）、帳號統計、
 * 以及「在鎖內」重新確認操作者的檢查。
 */

export const NAME_MAX_CHARS = 50;
/** 管理員帳號數量上限（防止被灌成無限多筆、讓整份設定檔越寫越大）。 */
export const ADMIN_MAX_COUNT = 50;
export const EMAIL_MAX_CHARS = 254;
const EMAIL_LOCAL_MAX_CHARS = 64;

/** 新帳號的 id：隨機 16 位元組的十六進位（32 字元）。 */
export function newAdminId(): string {
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

/** 驗證請求內容裡的姓名與 Email（升級舊版密碼時用，沒有新密碼）；不合法丟 400。 */
export function parseNameAndEmail(body: Record<string, unknown>): { name: string; email: string } {
  const name = parseName(body.name);
  if (!name.ok) throw new ServiceError(400, name.error);
  const email = normalizeEmail(body.email);
  if (email === null) throw new ServiceError(400, EMAIL_INVALID_MESSAGE);
  return { name: name.value, email };
}

/** 驗證建立帳號的請求內容：姓名、Email、密碼（10～200 字元）；不合法丟 400（姓名 → Email → 密碼的順序）。 */
export function parseNewAccountInput(body: Record<string, unknown>): { name: string; email: string; password: string } {
  const { name, email } = parseNameAndEmail(body);
  const password = typeof body.password === "string" ? body.password : "";
  const problem = validateNewPassword(password);
  if (problem) throw new ServiceError(400, problem);
  return { name, email, password };
}

// ===================================================================== 檢視與統計

/** 對外的管理員資料：沒有密碼雜湊、沒有 sessionVersion。 */
export interface AdminPublic {
  id: string;
  name: string;
  email: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export function toPublicAdmin(admin: Readonly<AdminAccount>): AdminPublic {
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    status: admin.status,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
    lastLoginAt: admin.lastLoginAt,
  };
}

export interface AdminSummary {
  /** 有至少一位啟用中的管理員，或仍有待升級的舊版單一密碼：設定頁「有人能進去」。 */
  adminConfigured: boolean;
  /** 管理員帳號總數（含停用的）。 */
  adminCount: number;
  /** 還有舊版的單一管理密碼沒升級成管理員帳號。 */
  legacyAdminPending: boolean;
}

export function summarizeAdmins(data: ReadonlySettings): AdminSummary {
  const legacyAdminPending = data.admin !== null && data.admins.length === 0;
  const hasActive = data.admins.some((admin) => admin.status === "active");
  return { adminConfigured: hasActive || legacyAdminPending, adminCount: data.admins.length, legacyAdminPending };
}

// ===================================================================== 在鎖內重新確認

/**
 * 在 SettingsStore.update 的 mutator（也就是序列化的臨界區）裡，重新確認「發出這個請求的人」現在還是有效的管理員：
 * 帳號還在、啟用中、sessionVersion 沒變。請求進來時雖然檢查過一次，但中間可能有別的請求先把他停用、刪除或重設了密碼
 * （例如兩位管理員同時互相停用對方）——所有改動帳號資料的操作都要在鎖內再確認一次，才不會留下「沒有任何啟用中管理員」的狀態。
 * 回傳 draft 裡的那個帳號物件；不符就丟 401。
 */
export function requireActorInDraft(draft: SettingsData, actor: Readonly<Pick<AdminAccount, "id" | "sessionVersion">>): AdminAccount {
  const found = draft.admins.find((admin) => admin.id === actor.id);
  if (!found || found.status !== "active" || found.sessionVersion !== actor.sessionVersion) {
    throw new ServiceError(401, "請先登入");
  }
  return found;
}

/** 除了 exceptId 這一位之外，還有幾位啟用中的管理員（停用或刪除某一位之前，確認不會留下「沒有任何人能登入」）。 */
export function otherActiveAdminCount(draft: Pick<SettingsData, "admins">, exceptId: string): number {
  return draft.admins.filter((admin) => admin.id !== exceptId && admin.status === "active").length;
}

/** 已經有人用這個 Email 了（排除自己）。 */
export function emailTaken(draft: SettingsData, email: string, exceptId?: string): boolean {
  return draft.admins.some((admin) => admin.email === email && admin.id !== exceptId);
}
