import { createSign } from "node:crypto";

import { describeError, readJsonSafely, ServiceError, type FetchLike, type Logger } from "./common.js";

/**
 * Google 服務帳號授權（JWT Bearer flow，RS256）。
 *
 * 不依賴 googleapis 套件：用 node:crypto 簽 JWT、用 fetch 換 access token。
 * 改寫自 wiwi-inout-scan/src/catalog.ts 的同名實作（token 快取、憑證兩種格式）。
 */

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** 讀表頭＋append 寫入都需要試算表的讀寫權限。 */
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/** JWT 本身的有效期（Google 上限 1 小時）。 */
const JWT_TTL_SECONDS = 3600;
/** access token 在記憶體裡快取 55 分鐘（token 實際有效 60 分鐘，留 5 分鐘餘裕）。 */
export const TOKEN_CACHE_MS = 55 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tryParseCredentialsJson(text: string): ServiceAccountCredentials | null {
  try {
    const obj = JSON.parse(text.replace(/^﻿/, "")) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    const { client_email: email, private_key: key } = obj as Record<string, unknown>;
    if (typeof email === "string" && email.trim() !== "" && typeof key === "string" && key.trim() !== "") {
      // 有些部署介面會把 JSON 內的 \n 再跳脫一次，私鑰裡出現字面的「\n」兩個字元；PEM 本身不可能含反斜線，還原是安全的。
      return { client_email: email.trim(), private_key: key.replace(/\\n/g, "\n") };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 解析 `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS`：接受「原始 JSON」或「整包 JSON 的 base64」兩種格式
 * （Zeabur 上實際存的是 base64，避免多行私鑰與引號被環境變數介面弄壞）。
 * 先當 JSON 解析，失敗才當 base64 解碼後再當 JSON 解析（Node 的 base64 解碼會忽略換行與空白，
 * 也接受 base64url 字元）。只接受同時含非空 `client_email` 與 `private_key` 字串的物件，否則回 null。
 */
export function parseServiceAccountCredentials(raw: string | null | undefined): ServiceAccountCredentials | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  const direct = tryParseCredentialsJson(text);
  if (direct) return direct;
  return tryParseCredentialsJson(Buffer.from(text, "base64").toString("utf8"));
}

/**
 * 組出 RS256 簽章的 JWT（service account 的 JWT Bearer 標準格式）。
 * 回傳的字串只含 base64url 過的 header／payload／signature，不含私鑰本身。
 */
export function buildServiceAccountJwt(
  credentials: ServiceAccountCredentials,
  scope: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: credentials.client_email,
    scope,
    aud: GOOGLE_TOKEN_URL,
    exp: nowSeconds + JWT_TTL_SECONDS,
    iat: nowSeconds,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(credentials.private_key);
  return `${signingInput}.${base64url(signature)}`;
}

export interface TokenProviderOptions {
  fetchImpl: FetchLike;
  log: Logger;
  /** 目前時間（毫秒）；測試時注入以驗證快取過期。 */
  now?: () => number;
  scope?: string;
  ttlMs?: number;
  timeoutMs?: number;
}

/**
 * 取得並快取 Google access token。
 * 快取 55 分鐘；同時多個請求遇到快取過期時只會發出一次換 token 的請求。
 * 失敗一律丟 ServiceError（訊息不含任何憑證內容）。
 */
export class GoogleTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly scope: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentials: ServiceAccountCredentials,
    options: TokenProviderOptions,
  ) {
    this.fetchImpl = options.fetchImpl;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.scope = options.scope ?? SHEETS_SCOPE;
    this.ttlMs = options.ttlMs ?? TOKEN_CACHE_MS;
    this.timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.token;
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Google 回 401 時呼叫：丟掉快取，下一次 getToken 會重新換一個。 */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(): Promise<string> {
    let jwt: string;
    try {
      jwt = buildServiceAccountJwt(this.credentials, this.scope, Math.floor(this.now() / 1000));
    } catch {
      throw new ServiceError(500, "Google 服務帳號的私鑰格式不正確，無法簽發授權");
    }

    let res: Response;
    try {
      res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.log.error(`[google-auth] 換 token 連線失敗：${describeError(err)}`);
      throw new ServiceError(502, "Google 授權服務暫時無法連線，請稍後再試");
    }

    if (!res.ok) {
      const body = (await readJsonSafely(res)) as { error?: unknown; error_description?: unknown } | null;
      const error = typeof body?.error === "string" ? body.error : "";
      const description = typeof body?.error_description === "string" ? body.error_description : "";
      this.log.error(`[google-auth] 換 token 失敗：HTTP ${res.status} ${error} ${description}`.trim().slice(0, 300));
      if (res.status >= 500 || res.status === 429) {
        throw new ServiceError(502, "Google 授權服務暫時無法使用，請稍後再試");
      }
      throw new ServiceError(500, "Google 授權失敗，請檢查服務帳號憑證是否有效");
    }

    const json = (await readJsonSafely(res)) as { access_token?: unknown } | null;
    const token = json?.access_token;
    if (typeof token !== "string" || token === "") {
      this.log.error("[google-auth] 換 token 回應缺少 access_token");
      throw new ServiceError(502, "Google 授權回應格式不正確");
    }
    this.cached = { token, expiresAt: this.now() + this.ttlMs };
    return token;
  }
}
