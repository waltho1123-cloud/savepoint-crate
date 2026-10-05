/**
 * 各模組共用的小東西：可回給前端的錯誤型別、log 介面、fetch 型別、睡眠函式。
 */

/** 全域 fetch 的型別。所有對外呼叫（OpenAI、Google）都經由注入的 FetchLike，方便測試時 mock。 */
export type FetchLike = typeof fetch;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export type ServiceErrorStatus = 400 | 413 | 429 | 500 | 502 | 503;

/**
 * 可以直接回給前端的錯誤。
 *
 * - status：HTTP 狀態碼（4xx＝呼叫端的問題，5xx＝伺服器或上游的問題）。
 * - message：給使用者看的繁中訊息。**絕對不可**放金鑰、憑證、上游原始回應內文——
 *   這個服務沒有登入機制，任何人都看得到這些訊息。
 */
export class ServiceError extends Error {
  readonly status: ServiceErrorStatus;

  constructor(status: ServiceErrorStatus, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把例外轉成一行可寫進 log 的短字串（只取名稱與訊息，截斷到 200 字，不帶 stack 與請求內容）。 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const code = cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
    return `${err.name}: ${err.message}${code}`.slice(0, 200);
  }
  return String(err).slice(0, 200);
}

/** 讀取 JSON 回應；不是合法 JSON 時回 null，不丟例外。 */
export async function readJsonSafely(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
