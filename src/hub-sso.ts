import { createHmac, timingSafeEqual } from "node:crypto";

import { normalizeEmail } from "./accounts.js";

/**
 * 從 WIWI Hub 單一登入（SSO）：驗證 Hub 簽發的票證（JWT，HS256）。
 *
 * 票證規格（Hub 簽票：src/lib/sso.ts）：header 只有 {"alg":"HS256"}；claims 有 iss=wiwi-hub、aud=<卡片 slug>、sub、email、name、role、iat、exp（60 秒）。
 * 本檔只採信 email；name、role 一律不看，權限以本系統的帳號為準。
 *
 * verifyHubToken 對任何輸入都只回「正規化後的 email」或 null（無效），不丟例外；呼叫端不得區分失敗原因。
 */
export const HUB_SSO_AUDIENCE = "savepoint-crate";
export const HUB_SSO_ISSUER = "wiwi-hub";
export const HUB_TOKEN_MAX_LENGTH = 4096;
const CLOCK_SKEW_SECONDS = 30;
const MAX_LIFETIME_SECONDS = 600;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** 嚴格 base64url：只有合法字元、無 padding，且解碼後重新編碼要與原字串完全相同。 */
function decodeSegment(segment: string): Buffer | null {
  if (!BASE64URL_RE.test(segment)) return null;
  const bytes = Buffer.from(segment, "base64url");
  return bytes.toString("base64url") === segment ? bytes : null;
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> | null {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function verify(token: unknown, secret: string, nowMs: number): string | null {
  if (typeof token !== "string" || token.length === 0 || token.length > HUB_TOKEN_MAX_LENGTH || secret === "") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const headerBytes = decodeSegment(headerPart);
  const payloadBytes = decodeSegment(payloadPart);
  const signature = decodeSegment(signaturePart);
  if (!headerBytes || !payloadBytes || !signature) return null;

  const header = parseJsonObject(headerBytes);
  if (!header || header.alg !== "HS256") return null;

  const expected = createHmac("sha256", Buffer.from(secret, "utf8")).update(`${headerPart}.${payloadPart}`).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;

  const claims = parseJsonObject(payloadBytes);
  if (!claims) return null;
  if (claims.iss !== HUB_SSO_ISSUER || claims.aud !== HUB_SSO_AUDIENCE) return null;
  const nowSeconds = nowMs / 1000;
  const { exp, iat } = claims;
  if (!isFiniteNumber(exp) || nowSeconds > exp + CLOCK_SKEW_SECONDS) return null;
  if (iat !== undefined) {
    if (!isFiniteNumber(iat) || iat > nowSeconds + CLOCK_SKEW_SECONDS || exp - iat > MAX_LIFETIME_SECONDS) return null;
  }
  return normalizeEmail(claims.email);
}

/** 驗票：成功回正規化後的 email，任何失敗（含無法預期的例外）回 null。 */
export function verifyHubToken(token: unknown, secret: string, nowMs: number): string | null {
  try {
    return verify(token, secret, nowMs);
  } catch {
    return null;
  }
}

/** 以正規化 email 找「恰好一筆」本地帳號：資料檔裡的 email 不假設已正規化，逐一正規化後比對；多筆或查無回 undefined。 */
export function findAccountByEmail<T extends { email: string }>(accounts: readonly T[], email: string): T | undefined {
  const matches = accounts.filter((account) => normalizeEmail(account.email) === email);
  return matches.length === 1 ? matches[0] : undefined;
}

/** 登入頁 ?sso= 的提示文字（白名單查表；白名單外的值不顯示）。 */
const SSO_NOTICES: ReadonlyMap<string, string> = new Map([
  ["invalid", "WIWI Hub 單一登入失敗，請重新從 Hub 進入或改用原本的方式登入"],
  ["no_account", "WIWI Hub 單一登入失敗：此 Email 尚未在本系統建立帳號或已停用"],
]);
export function ssoNotice(code: string | undefined): string | null {
  return code === undefined ? null : (SSO_NOTICES.get(code) ?? null);
}
