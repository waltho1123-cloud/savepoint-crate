import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { vi } from "vitest";

import type { Logger } from "../src/common.js";
import { DEFAULT_GOOGLE_SHEET_ID } from "../src/env.js";

// ---------------------------------------------------------------------------
// 測試用的服務帳號憑證：每次測試執行時現場產生 RSA 金鑰，repo 裡不放任何金鑰內容。
// ---------------------------------------------------------------------------

export interface TestCredentials {
  email: string;
  privateKeyPem: string;
  publicKey: KeyObject;
  /** 服務帳號 JSON 原文（與 Google 下載的格式相同：含 project_id、private_key_id 等欄位）。 */
  json: string;
  /** 整包 JSON 的 base64（Zeabur 上實際存放的格式）。 */
  base64: string;
}

export function makeCredentials(email = "savepoint-test@test-project.iam.gserviceaccount.com"): TestCredentials {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const json = JSON.stringify(
    {
      type: "service_account",
      project_id: "proj-id-should-not-leak",
      private_key_id: "key-id-should-not-leak",
      private_key: privateKeyPem,
      client_email: email,
      client_id: "client-id-should-not-leak",
      token_uri: "https://oauth2.googleapis.com/token",
    },
    null,
    2,
  );
  return { email, privateKeyPem, publicKey, json, base64: Buffer.from(json, "utf8").toString("base64") };
}

// ---------------------------------------------------------------------------
// fetch mock：記錄每一次呼叫（url、method、headers、body），由 handler 決定回應。
// ---------------------------------------------------------------------------

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | null | undefined;
}

export type MockHandler = (call: RecordedCall) => Response | Promise<Response>;

export function createFetchMock(handler: MockHandler) {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const call: RecordedCall = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    return handler(call);
  });
  return { mock, calls };
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Google 假伺服器（token、讀表頭、append）。
// ---------------------------------------------------------------------------

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SHEETS_BASE = `https://sheets.googleapis.com/v4/spreadsheets/${DEFAULT_GOOGLE_SHEET_ID}`;
export const FULL_HEADER = ["序號", "日期", "箱號", "商品編號", "品名", "性別", "顏色", "尺寸", "合併品名", "數量", "辨識時間"];
export const TEST_ACCESS_TOKEN = "test-access-token";

export interface GoogleMockOptions {
  /** 試算表 ID；預設是正式的商品主檔試算表 ID。 */
  spreadsheetId?: string;
  /** 試算表第 1 列；null 代表整列是空的（API 回應沒有 values）。預設是完整的 11 欄。 */
  header?: string[] | null;
  headerStatus?: number;
  /** 所有 append 請求的回應狀態碼（預設 200）。 */
  appendStatus?: number;
  /** 依序指定每一次 append 請求的狀態碼（第 1 次用 [0]、第 2 次用 [1]…）；超出的次數改用 appendStatus。 */
  appendStatuses?: number[];
  /** append 回應的 updates.updatedRange；null 代表回應沒有 updates。 */
  updatedRange?: string | null;
  tokenStatus?: number;
}

export function createGoogleMock(options: GoogleMockOptions = {}) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${options.spreadsheetId ?? DEFAULT_GOOGLE_SHEET_ID}`;
  const header = options.header === undefined ? FULL_HEADER : options.header;
  const updatedRange = options.updatedRange === undefined ? "'商品主檔'!A125:K125" : options.updatedRange;
  let appendCount = 0;
  return createFetchMock((call) => {
    if (call.url === GOOGLE_TOKEN_URL) {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return jsonResponse({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, options.tokenStatus);
      }
      return jsonResponse({ access_token: TEST_ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" });
    }
    if (call.method === "GET" && call.url.startsWith(`${base}/values/`)) {
      if (options.headerStatus && options.headerStatus !== 200) {
        return jsonResponse({ error: { code: options.headerStatus, message: "stub error", status: "STUB" } }, options.headerStatus);
      }
      return jsonResponse(
        header === null
          ? { range: "'商品主檔'!A1:Z1", majorDimension: "ROWS" }
          : { range: `'商品主檔'!A1:${String.fromCharCode(64 + header.length)}1`, majorDimension: "ROWS", values: [header] },
      );
    }
    if (call.method === "POST" && call.url.startsWith(`${base}/values/`) && call.url.includes(":append")) {
      const appendStatus = options.appendStatuses?.[appendCount++] ?? options.appendStatus;
      if (appendStatus && appendStatus !== 200) {
        return jsonResponse({ error: { code: appendStatus, message: "stub error", status: "STUB" } }, appendStatus);
      }
      return jsonResponse({
        spreadsheetId: options.spreadsheetId ?? DEFAULT_GOOGLE_SHEET_ID,
        tableRange: "'商品主檔'!A1:K124",
        ...(updatedRange === null
          ? {}
          : { updates: { spreadsheetId: options.spreadsheetId ?? DEFAULT_GOOGLE_SHEET_ID, updatedRange, updatedRows: 1, updatedColumns: 11, updatedCells: 11 } }),
      });
    }
    throw new Error(`測試未預期的 fetch：${call.method} ${call.url}`);
  });
}

// ---------------------------------------------------------------------------
// 可記錄訊息的 logger（用來驗證 log 不含金鑰）。
// ---------------------------------------------------------------------------

export function createCapturingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => void lines.push(message),
    warn: (message) => void lines.push(message),
    error: (message) => void lines.push(message),
  };
}

/** 一張假的 JPEG data URL（內容不重要，只要格式對）。 */
export const SAMPLE_IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/";
