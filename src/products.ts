import { describeError, readJsonSafely, ServiceError, type FetchLike, type Logger } from "./common.js";
import type { GoogleTokenProvider } from "./google-auth.js";
import { buildMergedName, quoteSheetName } from "./sheets.js";

/**
 * 商品總表查詢：AI 只負責讀出商品編號，品名／性別／顏色／尺寸一律用編號到 Google 試算表「WIWI商品資料庫」查。
 *
 * 資料來源（同一份試算表、兩個分頁，表頭都在第 1 列）：
 *   - 「商品總表」：`商品編號+尺寸`（10 碼，查詢鍵）、`商品名稱`、`性別`、`顏色`、`尺寸`；表頭精確比對（trim 後完全相等），
 *     因為同一列還有 `商品編號`（9 碼）與 `尺寸代號`。
 *   - 「雲端總表」：以 `商品編號` 開頭的唯一一欄＝查詢鍵、以 `商品名稱` 開頭的唯一一欄＝官方完整品名（表頭後面可能帶註記）。
 * 依表頭名稱找欄位，絕不寫死欄位字母；表頭缺欄回 500 並指出分頁與欄名。
 * 商品編號一律當文字比對：數字型別的儲存格只在安全整數時才轉成字串，不補零、不去零、不做數值運算。
 */

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const REQUEST_TIMEOUT_MS = 30_000;

/** 目錄放在記憶體的有效期：過期後下一次查詢先重抓再回答。 */
export const PRODUCT_CACHE_TTL_MS = 10 * 60 * 1000;
/** 查詢的編號有任何一個查不到時，距離上次重抓超過這段時間就重抓一次（總表每天有新品；全域最多每 60 秒因為查無而重抓一次）。 */
export const PRODUCT_MISS_REFRESH_MS = 60 * 1000;

/** 重抓失敗之後的退避：這段時間內不再打上游（有舊資料就用舊資料、沒資料就直接回上次的錯誤），免得上游掛掉時每次查詢都卡到逾時。 */
export const PRODUCT_RETRY_BACKOFF_MS = 10_000;

/** 一次查詢最多幾個編號、單一編號最長幾字。 */
export const PRODUCT_LOOKUP_MAX_BARCODES = 200;
export const PRODUCT_BARCODE_MAX_LENGTH = 64;

export const MASTER_KEY_HEADER = "商品編號+尺寸";
const MASTER_HEADERS = { key: MASTER_KEY_HEADER, name: "商品名稱", gender: "性別", color: "顏色", size: "尺寸" } as const;
const CLOUD_KEY_PREFIX = "商品編號";
const CLOUD_NAME_PREFIX = "商品名稱";

export interface ProductInfo {
  productName: string;
  gender: string;
  color: string;
  size: string;
  /** 官方完整品名（雲端總表那格；沒有就由四個欄位組出合併品名）。 */
  officialName: string;
}

export interface ProductLookupResult {
  products: Record<string, ProductInfo>;
  missing: string[];
}

/** 驗證 POST /api/products/lookup 的請求內容；回傳去重（保留順序）、trim 過的編號。 */
export function parseLookupInput(body: Record<string, unknown>): string[] {
  const raw = body.barcodes;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PRODUCT_LOOKUP_MAX_BARCODES) {
    throw new ServiceError(400, `barcodes 必須是 1～${PRODUCT_LOOKUP_MAX_BARCODES} 個項目的陣列`);
  }
  const unique = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") throw new ServiceError(400, "barcodes 的每個項目都必須是字串");
    const code = item.trim();
    if (code === "" || code.length > PRODUCT_BARCODE_MAX_LENGTH) {
      throw new ServiceError(400, `商品編號長度必須是 1～${PRODUCT_BARCODE_MAX_LENGTH} 字`);
    }
    unique.add(code);
  }
  return [...unique];
}

/** 商品編號儲存格 → 文字：字串 trim；數字只收安全整數（其餘當空）；其他型別當空。 */
export function cellToKey(cell: unknown): string {
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number" && Number.isSafeInteger(cell)) return String(cell);
  return "";
}

/** 一般文字儲存格 → 文字（trim）；空值與不認識的型別當空字串。 */
function cellToText(cell: unknown): string {
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return "";
}

/** 0 起算的欄位位置 → A1 的欄位字母（0→A、25→Z、26→AA）。位置是依表頭名稱找出來的，不是寫死的。 */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** 表頭缺欄（或雲端總表的欄位不唯一）：500，訊息指出分頁與欄名。 */
class CatalogHeaderError extends ServiceError {
  constructor(message: string) {
    super(500, message);
  }
}

export interface ProductCatalogOptions {
  tokenProvider: GoogleTokenProvider;
  spreadsheetId: string;
  masterSheetName: string;
  cloudSheetName: string;
  fetchImpl: FetchLike;
  log: Logger;
  now?: () => number;
  ttlMs?: number;
  missRefreshMs?: number;
  retryBackoffMs?: number;
  timeoutMs?: number;
}

interface Catalog {
  products: Map<string, ProductInfo>;
}

/**
 * 商品目錄：整份放記憶體（約 2.4 萬筆）。
 *
 * - 過了 ttlMs（10 分鐘）後，下一次查詢先重抓再回答。
 * - 查詢的編號有查不到的、而且距離上次重抓嘗試超過 missRefreshMs（60 秒），就重抓一次再查。
 * - 重抓失敗後的 retryBackoffMs（10 秒）內不再打上游：有舊資料就直接用舊資料回答，沒有資料就直接丟上次的錯誤（含表頭錯誤的 500）。
 *   上一次成功時沒有退避，TTL 與查無重抓的規則照舊。
 * - 同時進來的查詢共用同一次重抓（single-flight），不受退避影響。
 * - 重抓失敗但手上有舊資料：照舊資料回答並寫一行 warn；完全沒有資料才丟錯（上游失敗 502、表頭缺欄 500）。
 * - 不用任何常駐計時器；log 只寫筆數與耗時，不寫商品內容。
 */
export class ProductCatalog {
  private catalog: Catalog | null = null;
  private loadedAt = 0;
  private lastAttemptAt: number | null = null;
  private inflight: Promise<void> | null = null;
  /** 最近一次重抓失敗的時間與錯誤；成功後清掉。 */
  private lastFailure: { at: number; error: ServiceError } | null = null;
  private readonly tokenProvider: GoogleTokenProvider;
  private readonly spreadsheetId: string;
  private readonly masterSheetName: string;
  private readonly cloudSheetName: string;
  private readonly fetchImpl: FetchLike;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly missRefreshMs: number;
  private readonly retryBackoffMs: number;
  private readonly timeoutMs: number;

  constructor(options: ProductCatalogOptions) {
    this.tokenProvider = options.tokenProvider;
    this.spreadsheetId = options.spreadsheetId;
    this.masterSheetName = options.masterSheetName;
    this.cloudSheetName = options.cloudSheetName;
    this.fetchImpl = options.fetchImpl;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now()); // 呼叫時才取 Date.now，測試用假計時器也攔得到
    this.ttlMs = options.ttlMs ?? PRODUCT_CACHE_TTL_MS;
    this.missRefreshMs = options.missRefreshMs ?? PRODUCT_MISS_REFRESH_MS;
    this.retryBackoffMs = options.retryBackoffMs ?? PRODUCT_RETRY_BACKOFF_MS;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** 最近一次成功載入的商品數；還沒成功載入過是 null。不會觸發讀取。 */
  get rowCount(): number | null {
    return this.catalog ? this.catalog.products.size : null;
  }

  /** 背景預先載入一次（啟動時用）：失敗只寫 warn，絕不丟例外。 */
  async warm(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.log.warn(`[products] 啟動時預先載入商品總表失敗：${describeError(err)}`);
    }
  }

  async lookup(barcodes: readonly string[]): Promise<ProductLookupResult> {
    if (!this.catalog || this.now() - this.loadedAt >= this.ttlMs) {
      if (!this.inBackoff()) await this.refresh();
      else if (!this.catalog) throw this.lastFailure!.error; // 退避中而且完全沒有資料：不打上游，直接重丟上次的錯誤
    }
    let result = this.resolve(barcodes);
    if (result.missing.length > 0 && this.canRefreshForMiss()) {
      await this.refresh();
      result = this.resolve(barcodes);
    }
    return result;
  }

  private canRefreshForMiss(): boolean {
    if (this.inBackoff()) return false;
    return this.lastAttemptAt === null || this.now() - this.lastAttemptAt >= this.missRefreshMs;
  }

  /** 最近一次重抓失敗、而且還在退避期間內（正在進行中的重抓不受影響，見 refresh）。 */
  private inBackoff(): boolean {
    return this.inflight === null && this.lastFailure !== null && this.now() - this.lastFailure.at < this.retryBackoffMs;
  }

  private resolve(barcodes: readonly string[]): ProductLookupResult {
    const products = new Map<string, ProductInfo>();
    const missing: string[] = [];
    for (const code of barcodes) {
      const found = this.catalog?.products.get(code);
      if (found) products.set(code, found);
      else missing.push(code);
    }
    // fromEntries 是「定義」屬性，所以編號叫 __proto__ 也只是一般的鍵
    return { products: Object.fromEntries(products), missing };
  }

  /** 重抓一次（single-flight）。失敗但有舊資料：warn 後照舊；沒有資料：丟錯。 */
  private refresh(): Promise<void> {
    if (!this.inflight) {
      this.lastAttemptAt = this.now();
      this.inflight = this.load()
        .catch((err: unknown) => {
          const error = err instanceof CatalogHeaderError ? err : new ServiceError(502, "商品總表暫時無法讀取，請稍後再試");
          this.lastFailure = { at: this.now(), error };
          if (this.catalog) {
            this.log.warn(`[products] 重抓商品總表失敗，沿用舊資料（${this.catalog.products.size} 筆）：${describeError(err)}`);
            return;
          }
          throw error;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async load(): Promise<void> {
    const startedAt = this.now();
    const [masterHeader, cloudHeader] = await this.readHeaders();

    const masterCols = this.locateMaster(masterHeader);
    const cloudCols = this.locateCloud(cloudHeader);

    const ranges = [
      ...[masterCols.key, masterCols.name, masterCols.gender, masterCols.color, masterCols.size].map((i) => this.columnRange(this.masterSheetName, i)),
      ...[cloudCols.key, cloudCols.name].map((i) => this.columnRange(this.cloudSheetName, i)),
    ];
    const columns = await this.batchGetColumns(ranges);
    const [mKey, mName, mGender, mColor, mSize, cKey, cName] = columns;

    let duplicates = 0;
    const cloud = new Map<string, string>();
    for (let i = 0; i < (cKey?.length ?? 0); i++) {
      const key = cellToKey(cKey![i]);
      if (key === "") continue;
      if (cloud.has(key)) duplicates += 1;
      else cloud.set(key, cellToText(cName?.[i]));
    }

    const products = new Map<string, ProductInfo>();
    const seenMaster = new Set<string>();
    for (let i = 0; i < (mKey?.length ?? 0); i++) {
      const key = cellToKey(mKey![i]);
      if (key === "") continue;
      if (seenMaster.has(key)) {
        duplicates += 1;
        continue;
      }
      seenMaster.add(key);
      const productName = cellToText(mName?.[i]);
      const gender = cellToText(mGender?.[i]);
      const color = cellToText(mColor?.[i]);
      const size = cellToText(mSize?.[i]);
      const officialName = cloud.get(key) || buildMergedName(productName, gender, color, size);
      products.set(key, { productName, gender, color, size, officialName });
    }
    for (const [key, name] of cloud) {
      if (products.has(key)) continue;
      products.set(key, { productName: name, gender: "", color: "", size: "", officialName: name });
    }

    this.catalog = { products };
    this.lastFailure = null;
    this.loadedAt = this.now();
    const tail = duplicates > 0 ? `，重複編號 ${duplicates} 筆（以第一次為準）` : "";
    this.log.info(`[products] 載入商品總表 ${products.size} 筆，耗時 ${this.now() - startedAt} ms${tail}`);
  }

  private locateMaster(header: readonly unknown[]): Record<keyof typeof MASTER_HEADERS, number> {
    const names = header.map(cellToText);
    const located = {} as Record<keyof typeof MASTER_HEADERS, number>;
    for (const [field, title] of Object.entries(MASTER_HEADERS) as Array<[keyof typeof MASTER_HEADERS, string]>) {
      const index = names.indexOf(title);
      if (index < 0) throw this.headerError(this.masterSheetName, title, "缺少欄位");
      located[field] = index;
    }
    return located;
  }

  private locateCloud(header: readonly unknown[]): { key: number; name: number } {
    const names = header.map(cellToText);
    const find = (prefix: string): number => {
      const hits = names.flatMap((name, index) => (name.startsWith(prefix) ? [index] : []));
      if (hits.length === 0) throw this.headerError(this.cloudSheetName, prefix, "缺少以此開頭的欄位");
      if (hits.length > 1) throw this.headerError(this.cloudSheetName, prefix, `有 ${hits.length} 欄以此開頭，無法判斷`);
      return hits[0]!;
    };
    return { key: find(CLOUD_KEY_PREFIX), name: find(CLOUD_NAME_PREFIX) };
  }

  private headerError(sheetName: string, columnName: string, reason: string): CatalogHeaderError {
    this.log.error(`[products] 分頁「${sheetName}」表頭問題：${columnName}（${reason}）`);
    return new CatalogHeaderError(`試算表分頁「${sheetName}」第 1 列表頭${reason}：${columnName}`);
  }

  private columnRange(sheetName: string, index: number): string {
    const letter = columnLetter(index);
    return `${quoteSheetName(sheetName)}!${letter}2:${letter}`;
  }

  /** 讀兩個分頁的第 1 列（一次請求）。 */
  private async readHeaders(): Promise<[unknown[], unknown[]]> {
    const json = await this.batchGet([`${quoteSheetName(this.masterSheetName)}!1:1`, `${quoteSheetName(this.cloudSheetName)}!1:1`], "ROWS");
    const row = (i: number): unknown[] => {
      const first: unknown = json.valueRanges[i]?.values?.[0];
      return Array.isArray(first) ? first : [];
    };
    return [row(0), row(1)];
  }

  /** 讀多個「單欄」範圍（第 2 列起），回傳每一欄的儲存格陣列（尾端空白會被 Google 省略，所以各欄長度不一定相同）。 */
  private async batchGetColumns(ranges: string[]): Promise<Array<unknown[] | undefined>> {
    const json = await this.batchGet(ranges, "COLUMNS");
    return ranges.map((_, i) => {
      const first: unknown = json.valueRanges[i]?.values?.[0];
      return Array.isArray(first) ? first : undefined;
    });
  }

  private async batchGet(ranges: string[], majorDimension: "ROWS" | "COLUMNS"): Promise<{ valueRanges: Array<{ values?: unknown[][] }> }> {
    const query = [
      ...ranges.map((r) => `ranges=${encodeURIComponent(r)}`),
      "valueRenderOption=UNFORMATTED_VALUE",
      `majorDimension=${majorDimension}`,
    ].join("&");
    const url = `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values:batchGet?${query}`;
    const json = (await this.request(url)) as { valueRanges?: unknown } | null;
    if (!json || !Array.isArray(json.valueRanges) || json.valueRanges.length !== ranges.length) {
      this.log.error("[products] batchGet 回應格式不正確");
      throw new ServiceError(502, "商品總表回應格式不正確");
    }
    return { valueRanges: json.valueRanges as Array<{ values?: unknown[][] }> };
  }

  /** 送出 GET（401 時換 token 重送一次）。錯誤只記狀態碼，不記上游內文。 */
  private async request(url: string): Promise<unknown> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.tokenProvider.getToken();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        this.log.error(`[products] 讀取連線失敗或逾時：${describeError(err)}`);
        throw new ServiceError(502, "商品總表暫時無法讀取，請稍後再試");
      }
      if (res.ok) return readJsonSafely(res);
      this.log.error(`[products] 讀取失敗：HTTP ${res.status}`);
      if (res.status === 401 && attempt === 1) {
        this.tokenProvider.invalidate();
        continue;
      }
      throw new ServiceError(502, "商品總表暫時無法讀取，請稍後再試");
    }
    throw new ServiceError(502, "商品總表暫時無法讀取，請稍後再試");
  }
}
