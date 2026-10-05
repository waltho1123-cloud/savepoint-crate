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
 * 來源：https://developers.google.com/workspace/sheets/api/limits ，2026-10-05 查閱）。
 * 所以整個程序的 append 請求排成一條佇列，相鄰兩次的「起始時間」至少間隔這麼久。
 * 注意：不間斷地連續寫入時，1000 ms 剛好是每分鐘 60 次，正好壓在配額邊緣；
 * 如果實際看到 Google 回 429，請把間隔調大一點（例如 1200 ms）。
 */
export const APPEND_MIN_INTERVAL_MS = 1000;
/**
 * 同時在佇列中（含正在送出）的 append 上限。正常使用時前端是逐筆等回應才送下一筆，
 * 佇列長度頂多等於同時關箱的人數（個位數）；超過上限就直接回 503，避免異常流量讓請求越積越多、等待時間失控。
 * 以每秒 1 筆計，50 筆最多等約 50 秒，仍低於一般反向代理 60 秒左右的逾時（等得比代理逾時還久，
 * 前端會先看到失敗、伺服器之後卻還是寫入了，使用者重送就會變成重複列）。
 */
export const APPEND_MAX_PENDING = 50;

export interface SheetsClientOptions {
  tokenProvider: GoogleTokenProvider;
  spreadsheetId: string;
  sheetName: string;
  fetchImpl: FetchLike;
  log: Logger;
  now?: () => number;
  /** append 配速時的等待函式；測試時注入以免真的等待（通常同時讓假時鐘前進）。 */
  sleep?: (ms: number) => Promise<void>;
  headerTtlMs?: number;
  timeoutMs?: number;
  /** 相鄰兩次 append 請求的最小起始間隔（毫秒）；預設 APPEND_MIN_INTERVAL_MS。 */
  appendMinIntervalMs?: number;
  /** 同時排隊（含正在送出）的 append 上限；預設 APPEND_MAX_PENDING。 */
  appendMaxPending?: number;
}

/** append 配速交給 request() 的兩個掛鉤。 */
interface AppendHooks {
  /** 401 之後、重送之前呼叫：重送也是一次 append 請求，同樣要等滿配速間隔。 */
  beforeRetry: () => Promise<void>;
  /** 每次 fetch 被呼叫之後、等待回應之前呼叫：記錄真正的送出時間。 */
  onSend: () => void;
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
 *   唯一的例外是 401（授權過期，請求尚未執行）：換新 token 後重送一次——重送也是一次 append 請求，
 *   同樣要等滿配速間隔才送。
 * - append 全域配速：同一個 SheetsClient 實例內（server.ts 只建一個 app，所以等於整個程序）、不分來源請求，
 *   append 一次只送一筆，且相鄰兩筆的起始時間至少間隔 appendMinIntervalMs（見 APPEND_MIN_INTERVAL_MS 的說明）。
 *   讀表頭不受這個限制。
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
  private readonly appendMinIntervalMs: number;
  private readonly appendMaxPending: number;
  /** append 佇列的尾端：下一筆 append 要等它完成（成功或失敗都會放行）才能開始。 */
  private appendTail: Promise<void> = Promise.resolve();
  /** 目前在佇列中（含正在送出）的 append 數量。 */
  private pendingAppends = 0;
  /** 最近一次「真正送出」append 請求的時間（毫秒）；null＝還沒送過。 */
  private lastAppendSentAt: number | null = null;

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
    this.appendMinIntervalMs = options.appendMinIntervalMs ?? APPEND_MIN_INTERVAL_MS;
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
    // 讀表頭（上面的 getHeader）不經過配速；只有 append 這一步排隊。
    const json = (await this.paceAppend((hooks) => this.request("POST", url, payload, hooks))) as {
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
   * append 全域配速：把所有 append 請求排成一條佇列（先進先出），一次只送一筆，且距離上一筆「真正送出」至少
   * appendMinIntervalMs；需要等的時候只補足差額。task 收到的 hooks.onSend 要在 fetch 被呼叫之後立刻呼叫，用來記錄送出時間；
   * hooks.beforeRetry 讓 401 之後的重送也遵守同樣的間隔。
   *
   * 這是一個簡單的非同步互斥鎖（promise chain）：每筆 append 先等前一筆的 promise，結束時（不論成功或失敗）
   * 在 finally 放行下一筆並歸還名額，所以前一筆失敗不會卡住後面的。送出前就失敗的（例如換不到 token）不會更新送出時間，
   * 後面的也就不必為它多等。
   */
  private async paceAppend<T>(task: (hooks: AppendHooks) => Promise<T>): Promise<T> {
    if (this.pendingAppends >= this.appendMaxPending) {
      this.log.warn(`[sheets] append 佇列已滿（${this.pendingAppends}/${this.appendMaxPending}），拒絕這次寫入`);
      throw new ServiceError(503, "目前等待寫入的筆數過多，請稍後再試");
    }
    this.pendingAppends += 1;
    const previous = this.appendTail;
    let release!: () => void;
    this.appendTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      await this.waitAppendInterval();
      return await task({
        beforeRetry: () => this.waitAppendInterval(),
        onSend: () => {
          this.lastAppendSentAt = this.now();
        },
      });
    } finally {
      this.pendingAppends -= 1;
      release();
    }
  }

  /**
   * 等到距離上一筆 append「送出」滿 appendMinIntervalMs（只補足差額）。
   * 最多只等一個間隔：萬一系統時鐘被往回調，不會因此卡住很久。
   */
  private async waitAppendInterval(): Promise<void> {
    if (this.lastAppendSentAt === null) return;
    const waitMs = Math.min(this.appendMinIntervalMs, this.lastAppendSentAt + this.appendMinIntervalMs - this.now());
    if (waitMs > 0) await this.sleepFn(waitMs);
  }

  /**
   * 送出一次 Google 請求（含 401 時換 token 重送一次）。append 會帶 hooks：onSend 在「每次 fetch 被呼叫之後、
   * 等待回應之前」立刻被呼叫，讓配速記錄真正的送出時間（換 token 所花的時間不會算進間隔裡）；
   * beforeRetry 在 401 之後換好 token、重送之前被呼叫，讓重送也等滿間隔。
   * 記錄放在 fetch 被呼叫「之後」而不是之前：這樣記錄的時間一定不早於 fetch 實際被呼叫的時間，
   * 下一筆的等待目標（記錄時間＋間隔）就一定不早於「上一筆 fetch 被呼叫的時間＋間隔」，
   * 以毫秒時鐘從外面量測相鄰兩筆 fetch 被呼叫的時間差，也不會因為毫秒進位而少 1 ms。
   */
  private async request(method: "GET" | "POST", url: string, body?: unknown, hooks?: AppendHooks): Promise<unknown> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.tokenProvider.getToken();
      if (attempt > 1) await hooks?.beforeRetry();
      let res: Response;
      try {
        const pending = this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        hooks?.onSend();
        res = await pending;
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
