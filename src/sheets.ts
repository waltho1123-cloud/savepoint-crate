import {
  describeError,
  readJsonSafely,
  ServiceError,
  sleep,
  type FetchLike,
  type Logger,
} from "./common.js";
import type { GoogleTokenProvider } from "./google-auth.js";

/**
 * 關箱存檔：原 n8n 工作流「IPAS 裝箱系統 - 存入商品主檔 v2.1」的逐字移植。
 *
 *   - 「整理欄位」Code 節點 → parseSaveInput() ＋ buildMergedName() ＋ buildSaveRow()
 *   - 「存入商品主檔」Google Sheets 節點（append、依表頭名稱對應欄位）→ mapRowToHeader() ＋ SheetsClient
 *
 * 與 n8n 版的差別（刻意）：n8n 版是「整理欄位」之後同時分支去「寫試算表」與「回傳成功」，
 * 所以寫入失敗前端也看不到；這裡改成寫入成功才回 success:true，失敗回 4xx/5xx。
 */

/** 試算表表頭必須包含的 11 欄（順序不限，依表頭名稱對應）。 */
export const SAVE_COLUMNS = [
  "序號",
  "日期",
  "箱號",
  "商品編號",
  "品名",
  "性別",
  "顏色",
  "尺寸",
  "合併品名",
  "數量",
  "辨識時間",
] as const;

export type SaveColumn = (typeof SAVE_COLUMNS)[number];
export type SaveRow = Record<SaveColumn, string>;

/** 前端 POST /api/save 的內容（已通過 parseSaveInput 驗證與預設值處理）。 */
export interface SaveInput {
  seqNo: string;
  date: string;
  boxId: string;
  barcode: string;
  productName: string;
  gender: string;
  color: string;
  size: string;
  /** n8n：body.quantity || 1。保留原型別（數字或字串）。 */
  quantity: string | number;
  time: string;
}

const MAX_FIELD_LENGTH = 1000;
const TEXT_FIELDS = [
  "seqNo",
  "date",
  "boxId",
  "barcode",
  "productName",
  "gender",
  "color",
  "size",
  "time",
] as const;

function readTextField(body: Record<string, unknown>, key: string): string {
  const value = body[key] || ""; // n8n：body.x || ''
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number") text = String(value);
  else throw new ServiceError(400, `欄位 ${key} 的格式不正確`);
  if (text.length > MAX_FIELD_LENGTH) throw new ServiceError(400, `欄位 ${key} 過長`);
  return text;
}

/**
 * 驗證並整理前端送來的欄位。
 * 與 n8n 版相同：每個欄位缺少就當空字串、quantity 缺少（或為 0）就當 1。
 * 額外的防呆（n8n 版沒有）：必須是 JSON 物件、欄位只能是字串或數字、單一欄位不超過 1000 字、
 * 且 barcode 與 productName 至少要有一個（避免被公開端點塞進全空的列）。
 */
export function parseSaveInput(body: unknown): SaveInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ServiceError(400, "請求內容必須是 JSON 物件");
  }
  const record = body as Record<string, unknown>;
  const text = {} as Record<(typeof TEXT_FIELDS)[number], string>;
  for (const key of TEXT_FIELDS) text[key] = readTextField(record, key);

  const rawQuantity = record.quantity || 1; // n8n：body.quantity || 1
  let quantity: string | number;
  if (typeof rawQuantity === "number") quantity = rawQuantity;
  else if (typeof rawQuantity === "string") {
    if (rawQuantity.length > MAX_FIELD_LENGTH) throw new ServiceError(400, "欄位 quantity 過長");
    quantity = rawQuantity;
  } else throw new ServiceError(400, "欄位 quantity 的格式不正確");

  if (text.barcode === "" && text.productName === "") {
    throw new ServiceError(400, "缺少商品資料（barcode 與 productName 至少要有一個）");
  }
  return { ...text, quantity };
}

/**
 * 合併品名（逐字照抄 n8n「整理欄位」）：
 *   有 gender → 品名(性別-顏色尺寸)；沒有 gender → 品名(顏色尺寸)；都沒有 → 只有品名。
 * 注意（與 n8n 相同的行為）：有 gender 但顏色、尺寸都空時會得到「品名(男-)」。
 */
export function buildMergedName(productName: string, gender: string, color: string, size: string): string {
  let mergedName = productName;
  if (productName) {
    const parts: string[] = [];
    if (gender) parts.push(gender);
    const colorSize = (color || "") + (size || "");

    if (parts.length > 0 || colorSize) {
      mergedName = productName + "(";
      if (parts.length > 0) {
        mergedName += parts.join("") + "-" + colorSize;
      } else {
        mergedName += colorSize;
      }
      mergedName += ")";
    }
  }
  return mergedName;
}

/** 對應 n8n「整理欄位」輸出的 11 欄（數量一律轉字串，與 n8n 的 convertFieldsToString 相同）。 */
export function buildSaveRow(input: SaveInput): SaveRow {
  return {
    序號: input.seqNo,
    日期: input.date,
    箱號: input.boxId,
    商品編號: input.barcode,
    品名: input.productName,
    性別: input.gender,
    顏色: input.color,
    尺寸: input.size,
    合併品名: buildMergedName(input.productName, input.gender, input.color, input.size),
    數量: String(input.quantity),
    辨識時間: input.time,
  };
}

export type HeaderMapResult = { ok: true; values: string[] } | { ok: false; missing: SaveColumn[] };

/**
 * 依「表頭名稱」把 11 欄放到正確的欄位位置：
 * 表頭裡多出來的欄位（備註等）填空字串；表頭缺少任何一個必要欄位就回 ok:false 並列出缺哪些，
 * 絕不猜測位置（寧可寫入失敗，也不要默默把資料寫到錯的欄）。
 */
export function mapRowToHeader(header: readonly string[], row: SaveRow): HeaderMapResult {
  const names = header.map((cell) => String(cell ?? "").trim());
  const missing = SAVE_COLUMNS.filter((column) => !names.includes(column));
  if (missing.length > 0) return { ok: false, missing };
  const known: readonly string[] = SAVE_COLUMNS;
  return {
    ok: true,
    values: names.map((name) => (known.includes(name) ? row[name as SaveColumn] : "")),
  };
}

const FORMULA_START_RE = /^[=+\-@\t\r]/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/**
 * 寫入前的儲存格處理。valueInputOption=USER_ENTERED 會把「=、+、-、@」開頭的字串當公式執行；
 * 這個端點沒有登入機制，所以文字若以這些字元開頭就在前面加一個單引號（試算表顯示時不會出現單引號，
 * 內容仍是原本的文字）。純數字（含負數，例如數量 -1）不加。
 * ⚠️ 這是相對於 n8n 版的唯一資料層差異（n8n 版沒有這層防護）。
 */
export function toSheetCell(value: string): string {
  return FORMULA_START_RE.test(value) && !NUMERIC_RE.test(value) ? `'${value}` : value;
}

/** A1 表示法的分頁名稱：用單引號包起來，名稱內的單引號重複兩次。 */
export function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
export const HEADER_CACHE_MS = 5 * 60 * 1000;
const SHEETS_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Google Sheets API 的寫入配額是「每分鐘每使用者 60 次」（服務帳號＝一個使用者，超過回 429；
 * 來源：https://developers.google.com/workspace/sheets/api/limits ，2026-10-05 查閱），所以 append 用「滾動視窗配額」：
 * 過去 APPEND_WINDOW_MS（60 秒）內已起始的 append 少於 APPEND_WINDOW_MAX（55 次，留 5 次餘裕）就立刻送出、不等待；
 * 達到上限時依先進先出排隊，等最舊的那次起始時間離開視窗才送。
 * 所以過去 60 秒累計 55 件內全速寫入，超過才會被放慢，而不是撞到 Google 的配額而失敗。
 */
export const APPEND_WINDOW_MAX = 55;
export const APPEND_WINDOW_MS = 60_000;
/**
 * 同時排隊等名額（視窗已滿、還沒送出）的 append 上限；超過就直接回 503，避免異常流量讓請求與連線越積越多。
 * 已經拿到名額、正在送出的不算。這個上限不是等待時間的上限：排隊的人最多等約一個視窗長度（60 秒），
 * 與排在第幾個無關（每過一個視窗，最舊的那批起始會一起離開）。等得比反向代理的逾時（常見 60 秒左右）還久時，
 * 前端會先看到失敗、伺服器之後卻還是寫入了，使用者重送就會變成重複列。
 */
export const APPEND_MAX_PENDING = 50;

export interface SheetsClientOptions {
  tokenProvider: GoogleTokenProvider;
  spreadsheetId: string;
  sheetName: string;
  fetchImpl: FetchLike;
  log: Logger;
  now?: () => number;
  /** append 視窗已滿、要等名額時的等待函式；測試時注入以免真的等待（通常同時讓假時鐘前進）。 */
  sleep?: (ms: number) => Promise<void>;
  headerTtlMs?: number;
  timeoutMs?: number;
  /** 滾動視窗內最多起始幾次 append；預設 APPEND_WINDOW_MAX。 */
  appendWindowMax?: number;
  /** 滾動視窗的長度（毫秒）；預設 APPEND_WINDOW_MS。 */
  appendWindowMs?: number;
  /** 同時排隊等名額的 append 上限；預設 APPEND_MAX_PENDING。 */
  appendMaxPending?: number;
}

export interface AppendResult {
  /** Sheets API 回應的 updates.updatedRange，例如 '商品主檔'!A125:K125；拿不到時為 undefined。 */
  updatedRange?: string;
}

/** 把 Google 回應的狀態碼轉成可回給前端的錯誤（訊息不含上游內文）。 */
function mapGoogleError(status: number, sheetName: string): ServiceError {
  if (status === 401) return new ServiceError(500, "Google 授權失敗，請檢查服務帳號憑證是否有效");
  if (status === 403) {
    return new ServiceError(500, "試算表拒絕存取：請確認已把試算表分享給服務帳號並給予編輯權限");
  }
  if (status === 404) return new ServiceError(500, "找不到指定的試算表，請確認試算表 ID 與分享設定");
  if (status === 400) {
    return new ServiceError(500, `試算表請求被拒絕（HTTP 400），請確認分頁「${sheetName}」是否存在、名稱是否正確`);
  }
  if (status === 429) return new ServiceError(502, "Google 試算表暫時繁忙，請稍後再試");
  if (status >= 500) return new ServiceError(502, "Google 試算表暫時無法回應，請稍後再試");
  return new ServiceError(502, `Google 試算表操作失敗（HTTP ${status}）`);
}

/**
 * Google Sheets REST 客戶端：讀表頭（快取 5 分鐘）＋ append 一列。
 *
 * - 表頭快取 5 分鐘：改了試算表表頭後最多 5 分鐘生效；表頭缺欄位造成寫入失敗時會立刻清掉快取，
 *   修好表頭後下一筆就會重新讀取。
 * - append 不自動重試（逾時或 5xx 時無法確定有沒有寫進去，重試可能造成重複列）；
 *   唯一的例外是 401（授權過期，請求尚未執行）：換新 token 後重送一次——重送算一次新的起始，同樣受視窗限制。
 * - append 滾動視窗配額（全域）：同一個 SheetsClient 實例內（server.ts 只建一個 app，所以等於整個程序）、不分來源請求，
 *   過去 appendWindowMs 內已起始的 append 少於 appendWindowMax 次就立刻送出（不人為等待，可以同時有多筆在途）；
 *   達到上限時依先進先出排隊，等最舊的那次起始時間離開視窗才送（細節見 APPEND_WINDOW_MAX 的說明）。
 *   換不到 token 的失敗發生在取得名額之前，不佔配額；讀表頭不受這個限制。
 */
export class SheetsClient {
  private headerCache: { header: string[]; fetchedAt: number } | null = null;
  private headerInflight: Promise<string[]> | null = null;
  private readonly tokenProvider: GoogleTokenProvider;
  private readonly spreadsheetId: string;
  private readonly sheetName: string;
  private readonly fetchImpl: FetchLike;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly headerTtlMs: number;
  private readonly timeoutMs: number;
  private readonly appendWindowMax: number;
  private readonly appendWindowMs: number;
  private readonly appendMaxPending: number;
  /**
   * 滾動視窗內「已起始」的 append 的起始時間（毫秒，由舊到新）。
   * 取得名額的同一個同步步驟就記錄（檢查有沒有名額、記錄起始時間之間不讓出控制權），同時進來的請求才不會超發。
   */
  private appendStarts: number[] = [];
  /** 正在排隊等名額的 append 數量（視窗已滿時才會有）。 */
  private waitingAppends = 0;
  /** 排隊鏈的尾端：後來的 append 要等前面排的都拿到名額才輪到（先進先出）；成功或失敗都會放行下一個。 */
  private appendQueueTail: Promise<void> = Promise.resolve();

  constructor(options: SheetsClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.spreadsheetId = options.spreadsheetId;
    this.sheetName = options.sheetName;
    this.fetchImpl = options.fetchImpl;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now()); // 呼叫時才取 Date.now，測試用假計時器也攔得到
    this.sleepFn = options.sleep ?? sleep;
    this.headerTtlMs = options.headerTtlMs ?? HEADER_CACHE_MS;
    this.timeoutMs = options.timeoutMs ?? SHEETS_REQUEST_TIMEOUT_MS;
    const windowMax = options.appendWindowMax ?? APPEND_WINDOW_MAX;
    this.appendWindowMax = windowMax >= 1 ? windowMax : 1; // 至少 1，否則永遠排不到名額
    this.appendWindowMs = options.appendWindowMs ?? APPEND_WINDOW_MS;
    this.appendMaxPending = options.appendMaxPending ?? APPEND_MAX_PENDING;
  }

  async appendRow(row: SaveRow): Promise<AppendResult> {
    const header = await this.getHeader();
    const mapped = mapRowToHeader(header, row);
    if (!mapped.ok) {
      this.headerCache = null;
      this.log.error(`[sheets] 表頭缺少必要欄位：${mapped.missing.join("、")}`);
      throw new ServiceError(
        500,
        `試算表「${this.sheetName}」第 1 列表頭缺少必要欄位：${mapped.missing.join("、")}`,
      );
    }

    const range = `${quoteSheetName(this.sheetName)}!A1`;
    const url =
      `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}:append` +
      "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";
    const payload = { majorDimension: "ROWS", values: [mapped.values.map(toSheetCell)] };
    // 讀表頭（上面的 getHeader）不受視窗限制；只有 append 這一步要先取得「起始」名額。
    const json = (await this.request("POST", url, payload, () => this.acquireAppendStart())) as {
      updates?: { updatedRange?: unknown };
    } | null;

    const updatedRange = json?.updates?.updatedRange;
    return typeof updatedRange === "string" && updatedRange !== "" ? { updatedRange } : {};
  }

  private async getHeader(): Promise<string[]> {
    if (this.headerCache && this.now() - this.headerCache.fetchedAt < this.headerTtlMs) {
      return this.headerCache.header;
    }
    if (!this.headerInflight) {
      this.headerInflight = this.fetchHeader()
        .then((header) => {
          this.headerCache = { header, fetchedAt: this.now() };
          return header;
        })
        .finally(() => {
          this.headerInflight = null;
        });
    }
    return this.headerInflight;
  }

  private async fetchHeader(): Promise<string[]> {
    const range = `${quoteSheetName(this.sheetName)}!1:1`;
    const url = `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}`;
    const json = (await this.request("GET", url)) as { values?: unknown } | null;
    const values = json?.values;
    const firstRow: unknown = Array.isArray(values) ? values[0] : undefined;
    return Array.isArray(firstRow) ? firstRow.map((cell) => String(cell ?? "")) : [];
  }

  /**
   * 取得一個 append「起始」名額（滾動視窗配額，見 APPEND_WINDOW_MAX 的說明）。
   *
   * - 快速路徑：沒有人在排隊、而且視窗內已起始的次數還沒到上限 → 當場記錄起始時間並放行，不等待、不讓出控制權
   *   （檢查與記錄是同一個同步步驟，所以同時進來的請求不會超發；也因此視窗內可以同時有多筆在途）。
   * - 慢速路徑：視窗已滿（或前面已有人在排）→ 先進先出排隊；輪到時，等最舊的那次起始時間離開視窗才記錄並放行。
   *   排隊的人數超過 appendMaxPending 就直接回 503。
   *
   * 排隊鏈是一個簡單的非同步互斥鎖（promise chain）：每個排隊的人先等前一個拿到名額，結束時（不論成功或失敗）
   * 在 finally 歸還排隊名額並放行下一個，所以任何一個失敗都不會卡住後面的。
   *
   * 注意：睡醒後不再重檢視窗，直接取得名額。所以注入的 sleep 必須真的等滿（或讓注入的時鐘前進）至少 ms 毫秒；
   * 提早返回的 sleep 會讓視窗短暫超發。正式環境用的 common.ts 的 sleep 保證至少等 ms（以 Date.now() 衡量）。
   */
  private async acquireAppendStart(): Promise<void> {
    const arrivedAt = this.now();
    this.pruneAppendStarts(arrivedAt);
    if (this.waitingAppends === 0 && this.appendStarts.length < this.appendWindowMax) {
      this.appendStarts.push(arrivedAt);
      return;
    }

    if (this.waitingAppends >= this.appendMaxPending) {
      this.log.warn(`[sheets] append 佇列已滿（${this.waitingAppends}/${this.appendMaxPending}），拒絕這次寫入`);
      throw new ServiceError(503, "目前等待寫入的筆數過多，請稍後再試");
    }
    this.waitingAppends += 1;
    const previous = this.appendQueueTail;
    let release!: () => void;
    this.appendQueueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous; // 前面排的都已拿到名額，輪到我了
      let now = this.now();
      this.pruneAppendStarts(now);
      if (this.appendStarts.length >= this.appendWindowMax) {
        // 等最舊的那次起始離開視窗。pruneAppendStarts 已把比 now 還晚的時間戳壓成 now，所以最多只等一個視窗長度。
        const waitMs = this.appendStarts[0]! + this.appendWindowMs - now;
        if (waitMs > 0) await this.sleepFn(waitMs);
        now = this.now();
        this.pruneAppendStarts(now);
      }
      this.appendStarts.push(now);
    } finally {
      this.waitingAppends -= 1;
      release();
    }
  }

  /**
   * 丟掉已經離開視窗的起始時間（年齡 ≥ appendWindowMs）。比「現在」還晚的時間戳（系統時鐘被往回調）
   * 一律當成剛剛才起始，所以時鐘往回調最多讓視窗多滿一個視窗長度，不會卡住更久。
   */
  private pruneAppendStarts(now: number): void {
    const kept: number[] = [];
    for (const started of this.appendStarts) {
      const at = Math.min(started, now);
      if (now - at < this.appendWindowMs) kept.push(at);
    }
    this.appendStarts = kept;
  }

  /**
   * 送出一次 Google 請求（含 401 時換 token 重送一次）。append 會帶 acquireStart：每次真正要送出之前先取得一個
   * 「起始」名額（可能要排隊）——首次送出與 401 之後的重送都一樣，所以重送也算一次新的起始、同樣受視窗限制。
   * 順序是先取得 token、再取得名額、取得後立刻呼叫 fetch：換不到 token 的失敗發生在取得名額之前，不佔配額。
   */
  private async request(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
    acquireStart?: () => Promise<void>,
  ): Promise<unknown> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.tokenProvider.getToken();
      await acquireStart?.();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        this.log.error(`[sheets] ${method} 連線失敗或逾時：${describeError(err)}`);
        throw new ServiceError(502, "Google 試算表連線失敗或逾時，請稍後再試");
      }

      if (res.ok) return readJsonSafely(res);

      const errorBody = (await readJsonSafely(res)) as {
        error?: { status?: unknown; message?: unknown };
      } | null;
      // 讀表頭（GET）的請求沒有使用者資料，Google 的錯誤訊息可以放心記錄（例如 Unable to parse range：分頁名稱不對）；
      // append（POST）的錯誤訊息可能回顯請求裡的欄位值（例如 Invalid values[0][4]: …），所以只記 status 代碼。
      const detail = [errorBody?.error?.status, method === "GET" ? errorBody?.error?.message : undefined]
        .filter((part): part is string => typeof part === "string")
        .join(" ");
      this.log.error(`[sheets] ${method} 失敗：HTTP ${res.status} ${detail}`.trim().slice(0, 300));

      if (res.status === 401 && attempt === 1) {
        this.tokenProvider.invalidate();
        continue;
      }
      throw mapGoogleError(res.status, this.sheetName);
    }
    throw new ServiceError(500, "Google 授權失敗，請檢查服務帳號憑證是否有效");
  }
}
