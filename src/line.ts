import { createHmac, timingSafeEqual } from "node:crypto";

import { describeError, readJsonSafely, ServiceError, type FetchLike, type Logger } from "./common.js";
import { buildMergedName } from "./sheets.js";

/**
 * 關箱後的 LINE 群組通知（Messaging API）。
 *
 *   - POST /api/box-closed：前端關箱、逐筆同步到商品主檔之後呼叫 → 組一則文字訊息 → push 到 LINE_GROUP_ID。
 *   - POST /api/line/webhook：給使用者取得群組 ID 用（bot 被加進群組、或在群組輸入「群組ID」時回覆該群組的 ID）。
 *
 * 參考 wiwi-inout-scan/src/line.ts 的 pushLineText 與簽章驗證寫法；差異：這個專案沒有 DB、沒有後台，
 * 設定一律只讀環境變數（見 env.ts），fetch 由呼叫端注入（測試時 mock）。
 *
 * ⚠️ 安全：這個服務沒有登入機制，/api/box-closed 與其他端點一樣誰都能呼叫（只有限流與欄位長度上限）。
 * token、secret 絕不寫進 log 與回應；回給前端的失敗原因一律是這裡寫死的短句，不轉發 LINE 的原始回應。
 */

export const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
export const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";
/** 對 LINE 的每個請求最多等 10 秒；推播不重試（避免重複通知）。 */
export const LINE_REQUEST_TIMEOUT_MS = 10_000;
/** 整則訊息的字數上限（LINE 的上限是 5000，留餘裕）；超過就先砍明細行數。 */
export const LINE_MESSAGE_MAX_CHARS = 4500;
/** 訊息裡最多列出幾行明細；超過的寫成「…另有 k 種」。 */
export const BOX_CLOSED_MAX_DETAIL_LINES = 30;

export const BOX_ID_MAX_CHARS = 100;
export const BOX_CLOSED_MAX_ITEMS = 500;
export const ITEM_TEXT_MAX_CHARS = 200;
export const ITEM_QTY_MAX = 9999;
/** 一次 webhook 請求最多處理幾個事件（LINE 實際一次只會帶少數幾個；多的直接忽略）。 */
const WEBHOOK_MAX_EVENTS = 100;

// ===================================================================== 關箱通知：輸入驗證

export interface BoxClosedItem {
  barcode: string;
  productName: string;
  gender: string;
  color: string;
  size: string;
  qty: number;
}

export interface BoxClosedInput {
  boxId: string;
  /** 前端送來的關箱時間（ISO 8601，含時區）；沒送或解析不了就是 null，改用伺服器時間。 */
  closedAt: Date | null;
  items: BoxClosedItem[];
  /** 這次同步嘗試的筆數（前端逐筆送出的筆數，通常等於 items.length）。 */
  total: number;
  successCount: number;
  failedCount: number;
}

function readText(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
  else throw new ServiceError(400, `${where}.${key} 的格式不正確`);
  if (text.length > ITEM_TEXT_MAX_CHARS) {
    throw new ServiceError(400, `${where}.${key} 過長（上限 ${ITEM_TEXT_MAX_CHARS} 字）`);
  }
  return text;
}

function readQty(record: Record<string, unknown>, where: string): number {
  const value = record.qty;
  if (value === undefined || value === null) return 1; // 缺少當 1
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ITEM_QTY_MAX) {
    throw new ServiceError(400, `${where}.qty 必須是 1～${ITEM_QTY_MAX} 的整數`);
  }
  return value;
}

function readCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ServiceError(400, `${key} 必須是非負整數`);
  }
  return value;
}

/** closedAt 只接受 2000～2100 年之間的時間：太極端的值（例如西元 275760 年）加 8 小時會溢位成 NaN，年份太小也不會補零。 */
const CLOSED_AT_MIN_MS = Date.UTC(2000, 0, 1);
const CLOSED_AT_MAX_MS = Date.UTC(2101, 0, 1);

function parseClosedAt(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.length > 100) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms) || ms < CLOSED_AT_MIN_MS || ms >= CLOSED_AT_MAX_MS) return null;
  return new Date(ms);
}

/**
 * 驗證並整理前端送來的關箱資料。
 * boxId 必填、非空、≤ 100 字；items 是陣列、≤ 500 筆，每筆的文字欄位 ≤ 200 字（缺少當空字串）、
 * qty 為 1～9999 的整數（缺少當 1）；total、successCount、failedCount 必填、非負整數；closedAt 選填。
 */
export function parseBoxClosedInput(body: unknown): BoxClosedInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ServiceError(400, "請求內容必須是 JSON 物件");
  }
  const record = body as Record<string, unknown>;

  const rawBoxId = record.boxId;
  if (typeof rawBoxId !== "string" || rawBoxId.trim() === "") throw new ServiceError(400, "缺少 boxId");
  const boxId = rawBoxId.trim();
  if (boxId.length > BOX_ID_MAX_CHARS) throw new ServiceError(400, `boxId 過長（上限 ${BOX_ID_MAX_CHARS} 字）`);

  const rawItems = record.items;
  if (!Array.isArray(rawItems)) throw new ServiceError(400, "items 必須是陣列");
  if (rawItems.length > BOX_CLOSED_MAX_ITEMS) {
    throw new ServiceError(400, `items 過多（上限 ${BOX_CLOSED_MAX_ITEMS} 筆）`);
  }
  const items = rawItems.map((raw, index): BoxClosedItem => {
    const where = `items[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ServiceError(400, `${where} 必須是物件`);
    }
    const item = raw as Record<string, unknown>;
    return {
      barcode: readText(item, "barcode", where),
      productName: readText(item, "productName", where),
      gender: readText(item, "gender", where),
      color: readText(item, "color", where),
      size: readText(item, "size", where),
      qty: readQty(item, where),
    };
  });

  return {
    boxId,
    closedAt: parseClosedAt(record.closedAt),
    items,
    total: readCount(record, "total"),
    successCount: readCount(record, "successCount"),
    failedCount: readCount(record, "failedCount"),
  };
}

// ===================================================================== 關箱通知：組字

/** 台北時間 YYYY-MM-DD HH:mm。台灣沒有日光節約時間，固定 UTC+8。 */
export function formatTaipeiTime(date: Date): string {
  const t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/** 把控制字元與換行換成空白：欄位內容不能偽造出多餘的行，也不會把版型弄亂。 */
function oneLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim(); // 控制字元（含換行、Tab）、行分隔與段落分隔符號
}

function detailLine(item: BoxClosedItem): string {
  const merged = oneLine(buildMergedName(item.productName, item.gender, item.color, item.size));
  const label = [oneLine(item.barcode), merged].filter((part) => part !== "").join(" ");
  return `${label || "（未填）"} ×${item.qty}`;
}

/**
 * 組出關箱通知的純文字訊息（台北時間）：
 *
 *   📦 箱號 BOX-001 已完成
 *   共 12 種商品、35 件
 *   已同步 12/12 筆到商品主檔 ✓            （部分失敗：⚠️ 同步 10/12 筆，2 筆失敗，請查核商品主檔）
 *   明細：
 *   1801080204 第五代溫灸刷毛圓領發熱衣(女-經典黑L) ×3
 *   …（最多 30 行，超過寫「…另有 k 種」）
 *   時間：2026-10-05 15:20
 *
 * 整則訊息不超過 LINE_MESSAGE_MAX_CHARS 字：超過就先砍明細行數（砍掉的算進「…另有 k 種」）。
 * 明細的品名格式直接重用 sheets.ts 的 buildMergedName（與寫進商品主檔的「合併品名」一致）。
 * fallbackTime 是前端沒送（或送了解析不了）closedAt 時使用的時間，通常是伺服器現在時間。
 */
export function buildBoxClosedMessage(input: BoxClosedInput, fallbackTime: Date): string {
  const { items } = input;
  const totalQty = items.reduce((sum, item) => sum + item.qty, 0);
  const allSynced = input.failedCount === 0 && input.successCount === input.total;
  const head = [
    `📦 箱號 ${oneLine(input.boxId)} 已完成`,
    `共 ${items.length} 種商品、${totalQty} 件`,
    allSynced
      ? `已同步 ${input.successCount}/${input.total} 筆到商品主檔 ✓`
      : `⚠️ 同步 ${input.successCount}/${input.total} 筆，${input.failedCount} 筆失敗，請查核商品主檔`,
  ];
  const tail = [`時間：${formatTaipeiTime(input.closedAt ?? fallbackTime)}`];

  let text = "";
  for (let shown = Math.min(BOX_CLOSED_MAX_DETAIL_LINES, items.length); shown >= 0; shown--) {
    const lines = [...head];
    if (items.length > 0) {
      lines.push("明細：");
      for (let i = 0; i < shown; i++) lines.push(detailLine(items[i]!));
      if (items.length > shown) lines.push(`…另有 ${items.length - shown} 種`);
    }
    lines.push(...tail);
    text = lines.join("\n");
    if (text.length <= LINE_MESSAGE_MAX_CHARS) return text;
  }
  return text.slice(0, LINE_MESSAGE_MAX_CHARS); // 理論上到不了這裡（不列明細時只剩表頭與時間）
}

// ===================================================================== 推播與回覆

export interface LineClientDeps {
  fetchImpl: FetchLike;
  log: Logger;
  /** channel access token。 */
  token: string;
}

export type PushResult = { ok: true } | { ok: false; error: string };

/** 把 LINE 回應內文裡可能出現的 token 蓋掉（正常不會出現，這是多一層保險），並截短，才寫進 log。 */
function safeLogText(text: string, token: string): string {
  const redacted = token === "" ? text : text.split(token).join("***");
  return redacted.slice(0, 200);
}

async function readLineErrorMessage(res: Response, token: string): Promise<string> {
  const body = (await readJsonSafely(res)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? safeLogText(body.message, token) : "";
}

/** 回給前端的失敗原因：只用狀態碼對應的固定短句，不轉發 LINE 的原始回應。 */
function describePushFailure(status: number): string {
  if (status === 401) return "LINE channel access token 無效或已過期";
  if (status === 400 || status === 403) return "群組 ID 無效，或機器人不在該群組裡";
  if (status === 429) return "已達 LINE 推播額度或速率限制";
  return `LINE 回應 HTTP ${status}`;
}

/** 推播一則文字訊息到指定對象（群組）。10 秒 timeout、不重試；永不 throw，失敗回 { ok:false, error }。 */
export async function pushLineText(deps: LineClientDeps, to: string, text: string): Promise<PushResult> {
  try {
    const res = await deps.fetchImpl(LINE_PUSH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(LINE_REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const message = await readLineErrorMessage(res, deps.token);
    deps.log.error(`[line] 推播失敗：HTTP ${res.status}${message ? ` ${message}` : ""}`);
    return { ok: false, error: describePushFailure(res.status) };
  } catch (err) {
    deps.log.error(`[line] 推播失敗（連線錯誤或逾時）：${describeError(err, [deps.token])}`);
    return { ok: false, error: "連線 LINE 失敗或逾時" };
  }
}

/** 用 webhook 事件的 replyToken 回覆一則文字訊息。永不 throw，失敗只寫 log。 */
export async function replyLineText(deps: LineClientDeps, replyToken: string, text: string): Promise<boolean> {
  try {
    const res = await deps.fetchImpl(LINE_REPLY_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(LINE_REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return true;
    const message = await readLineErrorMessage(res, deps.token);
    deps.log.error(`[line] 回覆失敗：HTTP ${res.status}${message ? ` ${message}` : ""}`);
    return false;
  } catch (err) {
    deps.log.error(`[line] 回覆失敗（連線錯誤或逾時）：${describeError(err, [deps.token])}`);
    return false;
  }
}

export type BoxClosedOutcome =
  | { notified: true }
  | { notified: false; reason: "not_configured" }
  | { notified: false; reason: "push_failed"; error: string };

export interface NotifyBoxClosedDeps extends LineClientDeps {
  /** 目標群組 ID（C 開頭）。 */
  groupId: string;
  /** 目前時間（毫秒）；前端沒送 closedAt 時用它當關箱時間。 */
  now: () => number;
}

/**
 * 關箱通知：LINE 沒設定好（token 或群組 ID 缺少）就靜默略過（回 not_configured，不呼叫 LINE、不寫 log）；
 * 否則組字、推播。永不 throw——通知失敗不能影響關箱與存檔。
 */
export async function notifyBoxClosed(deps: NotifyBoxClosedDeps, input: BoxClosedInput): Promise<BoxClosedOutcome> {
  if (deps.token === "" || deps.groupId === "") return { notified: false, reason: "not_configured" };
  try {
    const text = buildBoxClosedMessage(input, new Date(deps.now()));
    const result = await pushLineText(deps, deps.groupId, text);
    return result.ok ? { notified: true } : { notified: false, reason: "push_failed", error: result.error };
  } catch (err) {
    deps.log.error(`[line] 關箱通知處理發生未預期的錯誤：${describeError(err, [deps.token])}`);
    return { notified: false, reason: "push_failed", error: "通知處理發生錯誤" };
  }
}

// ===================================================================== webhook：驗簽與事件處理

/**
 * 驗證 LINE webhook 的 X-Line-Signature：以 channel secret 為金鑰，對「原始 request body 的位元組」做
 * HMAC-SHA256、base64 後與標頭比對（timingSafeEqual）。必須用原始位元組，不能是 JSON 解析後再序列化的結果。
 */
export function verifyLineSignature(rawBody: Uint8Array, signature: string | undefined, secret: string): boolean {
  if (!signature || secret === "") return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("base64"));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** LINE 群組 ID：C 開頭的英數字（實際是 C＋32 位十六進位；這裡寬鬆一點，只擋掉空白、控制字元等不該出現的字元）。 */
const GROUP_ID_RE = /^C[0-9A-Za-z]{1,63}$/;

/** 文字去掉所有空白後等於「群組ID」（不分大小寫）：涵蓋「群組ID」「群組 ID」「 群組id 」等寫法。 */
function isGroupIdKeyword(text: string): boolean {
  return text.replace(/\s+/g, "").toLowerCase() === "群組id";
}

interface LineWebhookEvent {
  type?: unknown;
  replyToken?: unknown;
  source?: { type?: unknown; groupId?: unknown };
  message?: { type?: unknown; text?: unknown };
}

async function handleWebhookEvent(deps: LineClientDeps, raw: unknown): Promise<void> {
  if (typeof raw !== "object" || raw === null) return;
  const event = raw as LineWebhookEvent;
  if (event.source?.type !== "group") return;
  const groupId = event.source.groupId;
  if (typeof groupId !== "string" || !GROUP_ID_RE.test(groupId)) return;

  let reply: string | null = null;
  if (event.type === "join") {
    reply = `已加入，此群組 ID：${groupId}。請把它設定到 LINE_GROUP_ID。`;
  } else if (
    event.type === "message" &&
    event.message?.type === "text" &&
    typeof event.message.text === "string" &&
    isGroupIdKeyword(event.message.text)
  ) {
    reply = `此群組 ID：${groupId}`;
  }
  if (reply === null) return; // 其他事件一律忽略（不回覆、不寫 log，群組裡一般的聊天訊息不會洗版）

  // 處理到的事件（join、「群組ID」）把群組 ID 寫進 log：即使沒設 token、無法回覆，也能從 log 取得群組 ID。
  deps.log.info(`[line] 事件 ${event.type} 來自 group ${groupId}`);

  if (typeof event.replyToken !== "string" || event.replyToken === "") return;
  if (deps.token === "") {
    deps.log.warn("[line] 無法回覆群組 ID：LINE_CHANNEL_ACCESS_TOKEN 未設定（群組 ID 見上一行 log）");
    return;
  }
  await replyLineText(deps, event.replyToken, reply);
}

/**
 * 處理已通過簽章驗證的 webhook 內容：只處理群組來源的兩種事件——`join`（bot 被加進群組）與文字訊息
 * 「群組ID」／「群組 ID」——用 replyToken 回覆該群組的 ID；其他事件一律忽略。永不 throw。
 */
export async function handleLineWebhookBody(deps: LineClientDeps, bodyText: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    deps.log.warn("[line] webhook 內容不是有效的 JSON，已略過");
    return;
  }
  const events = (parsed as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return;
  for (const raw of events.slice(0, WEBHOOK_MAX_EVENTS)) {
    try {
      await handleWebhookEvent(deps, raw);
    } catch (err) {
      deps.log.error(`[line] 處理 webhook 事件失敗：${describeError(err, [deps.token])}`);
    }
  }
}
