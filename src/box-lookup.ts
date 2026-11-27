import { describeError, ServiceError, type Logger } from "./common.js";
import { cellToKey, columnLetter } from "./products.js";
import { quoteSheetName, SAVE_COLUMNS, type SheetsClient } from "./sheets.js";

/**
 * 商品主檔讀回（唯讀）：依日期把已關箱的箱子從「商品主檔」讀回來，讓任何裝置都能列印外箱明細。
 *
 * 讀取步驟（每次最多兩次 values 讀取，表頭走 SheetsClient 既有的快取）：
 *   1. 表頭依欄名找欄位（絕不寫死欄位字母）。
 *   2. 只讀「日期」那一欄（第 2 列到底），找出符合日期的列；一列都沒有就直接回空，不做第二次讀取。
 *   3. 讀「最小列～最大列」整塊整列，在這一塊裡再用日期過濾一次，依表頭索引取值。
 * 日期儲存格可能是日期序號（Google 把 USER_ENTERED 的 2026/11/27 轉成日期）或純文字，兩種都比對。
 */

/** 這一天符合的列數上限、符合的列首尾跨度上限（列數）。 */
export const BOX_LOOKUP_MAX_ROWS = 5000;
export const BOX_LOOKUP_MAX_SPAN = 20000;

const UPSTREAM_ERROR = "商品主檔暫時無法讀取，請稍後再試";
const DAY_MS = 86_400_000;
/** Google 試算表日期序號 0 ＝ 1899-12-30；與 Unix epoch（1970-01-01）相差 25569 天。 */
const EPOCH_SERIAL = 25569;

const REQUIRED_COLUMNS = SAVE_COLUMNS.filter((name) => name !== "序號");

export interface BoxItem {
  barcode: string;
  productName: string;
  gender: string;
  color: string;
  size: string;
  mergedName: string;
  qty: number;
}

export interface BoxBatch {
  boxId: string;
  closedAt: string;
  items: BoxItem[];
}

export interface BoxLookupResult {
  date: string;
  boxes: BoxBatch[];
  rows: number;
  skipped: number;
}

export interface ParsedDate {
  /** 補零後的 YYYY/MM/DD。 */
  text: string;
  /** Google 試算表日期序號（整數）。 */
  serial: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function buildDate(y: number, m: number, d: number): ParsedDate | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { text: `${y}/${pad2(m)}/${pad2(d)}`, serial: ms / DAY_MS + EPOCH_SERIAL };
}

/** 驗證 POST /api/boxes/lookup 的請求內容：date 必須是字串、真實存在的日期、年份 2000～2100；接受 `/` 或 `-`，月日可不補零。 */
export function parseBoxLookupInput(body: Record<string, unknown>): ParsedDate {
  const raw = body.date;
  if (typeof raw !== "string") throw new ServiceError(400, "date 必須是字串（格式 YYYY/MM/DD）");
  const match = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/.exec(raw.trim());
  const parsed = match ? buildDate(Number(match[1]), Number(match[3]), Number(match[4])) : null;
  if (!parsed) throw new ServiceError(400, "date 必須是 2000～2100 年之間真實存在的日期（格式 YYYY/MM/DD）");
  return parsed;
}

/** 儲存格是否為目標日期：數字比序號的整數部分；字串只看開頭的日期部分（後面接時間忽略），`-`、`.` 視同 `/`，月日補零。 */
export function dateCellMatches(cell: unknown, target: ParsedDate): boolean {
  if (typeof cell === "number") return Number.isFinite(cell) && Math.floor(cell) === target.serial;
  if (typeof cell !== "string") return false;
  const match = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?!\d)/.exec(cell.trim());
  if (!match) return false;
  return `${match[1]}/${pad2(Number(match[2]))}/${pad2(Number(match[3]))}` === target.text;
}

/** 辨識時間：數字序號 → YYYY-MM-DD HH:MM:SS（四捨五入到秒）；字串 trim 原樣；其他空字串。 */
export function timeCellToText(cell: unknown): string {
  if (typeof cell === "string") return cell.trim();
  if (typeof cell !== "number" || !Number.isFinite(cell)) return "";
  const seconds = Math.round((cell - EPOCH_SERIAL) * 86400);
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

function textCell(cell: unknown): string {
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return "";
}

/** 數量：1～9999 的整數；不是數字或小於 1 → 1；大於 9999 → 9999；小數取整。 */
export function qtyCellToInt(cell: unknown): number {
  let n = Number.NaN;
  if (typeof cell === "number") n = cell;
  else if (typeof cell === "string" && cell.trim() !== "") n = Number(cell.trim());
  if (!Number.isFinite(n)) return n === Infinity ? 9999 : 1;
  const whole = Math.floor(n);
  if (whole < 1) return 1;
  return whole > 9999 ? 9999 : whole;
}

type ColumnIndex = Record<(typeof REQUIRED_COLUMNS)[number], number>;

function locateColumns(sheetName: string, header: readonly string[], log: Logger): ColumnIndex {
  const names = header.map((cell) => String(cell ?? "").trim());
  const missing = REQUIRED_COLUMNS.filter((column) => !names.includes(column));
  if (missing.length > 0) {
    log.error(`[box-lookup] 表頭缺少必要欄位：${missing.join("、")}`);
    throw new ServiceError(500, `試算表「${sheetName}」第 1 列表頭缺少必要欄位：${missing.join("、")}`);
  }
  const index = {} as ColumnIndex;
  for (const column of REQUIRED_COLUMNS) index[column] = names.indexOf(column);
  return index;
}

/** 把已過濾、有箱號的列依「箱號＋辨識時間」分批（順序＝第一次出現的列順序）。 */
export function groupBatches(rows: ReadonlyArray<{ boxId: string; closedAt: string; item: BoxItem }>): BoxBatch[] {
  const batches = new Map<string, BoxBatch>();
  for (const row of rows) {
    const key = `${row.boxId}\u0000${row.closedAt}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { boxId: row.boxId, closedAt: row.closedAt, items: [] };
      batches.set(key, batch);
    }
    batch.items.push(row.item);
  }
  return [...batches.values()];
}

export interface BoxLookupDeps {
  sheets: SheetsClient;
  log: Logger;
  now: () => number;
}

/** 上游（Google）任何失敗、token 取得失敗一律對外 502 固定短句；訊息與 log 都不含上游內文。 */
async function upstream<T>(log: Logger, what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    log.error(`[box-lookup] 讀取${what}失敗：${describeError(err)}`);
    throw new ServiceError(502, UPSTREAM_ERROR);
  }
}

export async function lookupBoxes(deps: BoxLookupDeps, target: ParsedDate): Promise<BoxLookupResult> {
  const { sheets, log, now } = deps;
  const startedAt = now();
  const sheetName = sheets.sheetTitle;
  const quoted = quoteSheetName(sheetName);

  const header = await upstream(log, "表頭", () => sheets.readHeader());
  const cols = locateColumns(sheetName, header, log);

  const letter = columnLetter(cols["日期"]);
  const dateColumn = await upstream(log, "日期欄", () => sheets.readValues(`${quoted}!${letter}2:${letter}`));
  // 日期欄第 1 筆對應試算表第 2 列
  const matched: number[] = [];
  dateColumn.forEach((row, i) => {
    if (dateCellMatches(row[0], target)) matched.push(i + 2);
  });

  const empty = (): BoxLookupResult => ({ date: target.text, boxes: [], rows: 0, skipped: 0 });
  if (matched.length === 0) {
    log.info(`[box-lookup] 符合 0 列，耗時 ${now() - startedAt} ms`);
    return empty();
  }
  if (matched.length > BOX_LOOKUP_MAX_ROWS) {
    throw new ServiceError(400, `這一天的資料超過 ${BOX_LOOKUP_MAX_ROWS} 筆，無法一次載入`);
  }
  const first = matched[0]!;
  const last = matched[matched.length - 1]!;
  if (last - first + 1 > BOX_LOOKUP_MAX_SPAN) {
    throw new ServiceError(400, "這一天的資料在試算表裡太分散，無法載入");
  }

  const block = await upstream(log, "資料列", () => sheets.readValues(`${quoted}!${first}:${last}`));
  const kept: Array<{ boxId: string; closedAt: string; item: BoxItem }> = [];
  let skipped = 0;
  for (const row of block) {
    if (!dateCellMatches(row[cols["日期"]], target)) continue;
    const boxId = cellToKey(row[cols["箱號"]]);
    if (boxId === "") {
      skipped += 1;
      continue;
    }
    kept.push({
      boxId,
      closedAt: timeCellToText(row[cols["辨識時間"]]),
      item: {
        barcode: cellToKey(row[cols["商品編號"]]),
        productName: textCell(row[cols["品名"]]),
        gender: textCell(row[cols["性別"]]),
        color: textCell(row[cols["顏色"]]),
        size: textCell(row[cols["尺寸"]]),
        mergedName: textCell(row[cols["合併品名"]]),
        qty: qtyCellToInt(row[cols["數量"]]),
      },
    });
  }
  const boxes = groupBatches(kept);
  log.info(`[box-lookup] 符合 ${kept.length + skipped} 列（略過 ${skipped}），${boxes.length} 批，耗時 ${now() - startedAt} ms`);
  return { date: target.text, boxes, rows: kept.length, skipped };
}
