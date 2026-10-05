import type { Context } from "hono";

import { ServiceError } from "./common.js";
import { getClientIp } from "./rate-limit.js";

/** @hono/node-server 放在 c.env 裡的底層連線物件（取 TCP 連線位址用）。 */
type NodeConnection = { incoming?: { socket?: { remoteAddress?: string } } };

/**
 * 客戶端 IP 的判斷方式，限流與 GET /healthz 的 clientIp 共用同一個函式（規則見 rate-limit.ts 的 getClientIp）：
 * 由右往左取 X-Forwarded-For 的第一個公開位址；沒有就退回 TCP 連線位址；再沒有就是 "unknown"。
 */
export function clientIpOf(c: Context): string {
  const connection = c.env as NodeConnection | undefined;
  return getClientIp(c.req.header("x-forwarded-for"), connection?.incoming?.socket?.remoteAddress);
}

/** 讀 JSON 物件請求內容；不是合法 JSON 或不是物件一律 400。 */
export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new ServiceError(400, "請求內容不是有效的 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ServiceError(400, "請求內容必須是 JSON 物件");
  }
  return parsed as Record<string, unknown>;
}

/** 從請求內容物件取字串欄位；不是字串（含沒給）一律當空字串。 */
export function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

/** 這個請求是不是走 HTTPS（Zeabur 的反向代理終止 TLS，靠 X-Forwarded-Proto 告知；沒有這個標頭就看連線本身）。 */
export function isHttpsRequest(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

const HOST_RE = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
/** 本機與內網位址：沒有 X-Forwarded-Proto 時，這些視為 http，其餘視為 https（LINE webhook 一定要 https）。 */
const LOCAL_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\])(?::\d{1,5})?$/i;

/** 請求的主機名稱（X-Forwarded-Host 優先，其次 Host；多值取第一個）；沒有就是空字串。未驗證格式。 */
function requestHost(c: Context): string {
  return (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0]?.trim() ?? "";
}

/**
 * 這個請求是不是「公開網域上的明文 http」：連線不是 https（含代理沒送 X-Forwarded-Proto 的情況），而且主機不是本機或內網。
 * 設定頁用它顯示警告——這種情況下密碼與登入 cookie 會以明文傳送，cookie 也不會加 Secure。主機看不出來時回 false。
 */
export function isInsecurePublicRequest(c: Context): boolean {
  if (isHttpsRequest(c)) return false;
  const host = requestHost(c);
  return HOST_RE.test(host) && !LOCAL_HOST_RE.test(host);
}

/**
 * 目前請求所用的對外網址（scheme://host），給設定頁顯示 webhook 網址用。
 * host 優先取 X-Forwarded-Host，其次 Host；格式不合法（或根本沒有）時回佔位字串，不把可疑的值寫進頁面。
 */
export function publicOrigin(c: Context): string {
  const host = requestHost(c);
  if (!HOST_RE.test(host)) return "https://<網域>";
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const scheme = forwarded === "http" || forwarded === "https" ? forwarded : LOCAL_HOST_RE.test(host) ? "http" : "https";
  return `${scheme}://${host}`;
}
