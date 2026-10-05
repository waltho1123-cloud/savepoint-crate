/**
 * 環境變數載入。
 *
 * 設計取捨：缺少 OPENAI_API_KEY／GOOGLE_SERVICE_ACCOUNT_CREDENTIALS 時服務**仍會啟動**
 * （靜態頁與 /healthz 照常），只是對應端點回 503；這樣部署到 Zeabur 後即使金鑰還沒填，
 * 也能開 /healthz 看到「哪一項還沒設定」，不會變成反覆崩潰重啟。
 * LINE 三個變數（關箱通知）都是選填：沒設定時整個通知功能靜默略過，絕不影響關箱與存檔；
 * 它們現在是「備援」——設定頁（/settings）存在 DATA_DIR 的設定檔優先（見 line-settings.ts）。
 * 絕不在 log 或錯誤訊息裡印出任何變數的值。
 */

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
export const DEFAULT_GOOGLE_SHEET_ID = "1Wql_6lg_PQ1TT2xOF_5tv2AwA8Wy-PUWfeRPaVV-B_A";
export const DEFAULT_GOOGLE_SHEET_NAME = "商品主檔";
export const DEFAULT_PORT = 8080;
/** 本機預設的資料目錄（相對於啟動時的工作目錄）；容器裡由 Dockerfile 設成 /app/data（Zeabur 把 Volume 掛在這裡）。 */
export const DEFAULT_DATA_DIR = "./data";

export interface AppEnv {
  /** 空字串＝未設定（/api/ocr 回 503）。 */
  OPENAI_API_KEY: string;
  /** OpenAI 相容端點，已去掉尾端斜線、不含 /v1。 */
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
  /** 服務帳號金鑰 JSON 原文或其 base64；空字串＝未設定（/api/save 回 503）。 */
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: string;
  GOOGLE_SHEET_ID: string;
  GOOGLE_SHEET_NAME: string;
  /** LINE Messaging API 的 channel access token（推播與 webhook 回覆用）；空字串＝未設定。 */
  LINE_CHANNEL_ACCESS_TOKEN: string;
  /** 關箱通知的目標群組 ID（C 開頭）；空字串＝未設定。token 與群組 ID 兩者都有才會推播。 */
  LINE_GROUP_ID: string;
  /** channel secret，只用來驗證 webhook 簽章；空字串＝未設定（POST /api/line/webhook 回 503）。 */
  LINE_CHANNEL_SECRET: string;
  /** 設定頁的資料目錄（放 settings.json；Zeabur 上要掛 Volume 到這裡）。 */
  DATA_DIR: string;
  PORT: number;
}

type EnvSource = Record<string, string | undefined>;

function pick(source: EnvSource, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function parsePort(raw: string | undefined): number {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_PORT;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

export function loadEnv(source: EnvSource = process.env): AppEnv {
  return {
    OPENAI_API_KEY: pick(source, "OPENAI_API_KEY", ""),
    OPENAI_BASE_URL: pick(source, "OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, ""),
    OPENAI_MODEL: pick(source, "OPENAI_MODEL", DEFAULT_OPENAI_MODEL),
    GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: pick(source, "GOOGLE_SERVICE_ACCOUNT_CREDENTIALS", ""),
    GOOGLE_SHEET_ID: pick(source, "GOOGLE_SHEET_ID", DEFAULT_GOOGLE_SHEET_ID),
    GOOGLE_SHEET_NAME: pick(source, "GOOGLE_SHEET_NAME", DEFAULT_GOOGLE_SHEET_NAME),
    LINE_CHANNEL_ACCESS_TOKEN: pick(source, "LINE_CHANNEL_ACCESS_TOKEN", ""),
    LINE_GROUP_ID: pick(source, "LINE_GROUP_ID", ""),
    LINE_CHANNEL_SECRET: pick(source, "LINE_CHANNEL_SECRET", ""),
    DATA_DIR: pick(source, "DATA_DIR", DEFAULT_DATA_DIR),
    PORT: parsePort(source.PORT),
  };
}
