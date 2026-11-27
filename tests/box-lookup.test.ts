import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BOX_LOOKUP_RATE_LIMIT_MAX, createApp, OCR_RATE_LIMIT_MAX, PRODUCT_LOOKUP_RATE_LIMIT_MAX, SAVE_RATE_LIMIT_MAX } from "../src/app.js";
import {
  BOX_LOOKUP_MAX_ROWS,
  BOX_LOOKUP_MAX_SPAN,
  dateCellMatches,
  groupBatches,
  parseBoxLookupInput,
  qtyCellToInt,
  timeCellToText,
} from "../src/box-lookup.js";
import { loadEnv } from "../src/env.js";
import {
  createCapturingLogger,
  createFetchMock,
  FULL_HEADER,
  GOOGLE_TOKEN_URL,
  jsonResponse,
  makeCredentials,
  SHEETS_BASE,
  TEST_ACCESS_TOKEN,
  type RecordedCall,
} from "./helpers.js";
import { cleanupTempDirs, createAuthFixture, type AuthFixture } from "./settings-helpers.js";

const creds = makeCredentials();
const INDEX_HTML = "<!DOCTYPE html><html><body>測試頁</body></html>";
const SECRET_UPSTREAM = "UPSTREAM-SECRET-BODY-should-not-leak";
/** 2026/11/27 的 Google 試算表日期序號。 */
const D = 46353;

let auth: AuthFixture;
beforeAll(async () => {
  auth = await createAuthFixture();
});
afterAll(cleanupTempDirs);

// ---------------------------------------------------------------------------
// 假的「商品主檔」：header 是第 1 列，rows 是第 2 列起的資料列（儲存格可以是任何型別）。
// ---------------------------------------------------------------------------

type Row = unknown[];
/** 依 FULL_HEADER 的欄位順序組一列：序號、日期、箱號、商品編號、品名、性別、顏色、尺寸、合併品名、數量、辨識時間。 */
function r(date: unknown, box: unknown, code: unknown, name = "品", qty: unknown = 1, time: unknown = "2026-11-27 18:05:33", rest: Partial<Record<"gender" | "color" | "size" | "merged", string>> = {}): Row {
  return ["1", date, box, code, name, rest.gender ?? "", rest.color ?? "", rest.size ?? "", rest.merged ?? name, qty, time];
}

interface BackendOptions {
  header?: unknown[];
  rows?: Row[];
  /** 對特定 values 讀取（range 為解碼後的 A1 範圍）自訂回應；回 undefined 就走正常流程。 */
  override?: (range: string, call: RecordedCall, valuesReadIndex: number) => Response | undefined | Promise<Response | undefined>;
  tokenCount?: { n: number };
}

function backend(options: BackendOptions = {}) {
  const header = options.header ?? FULL_HEADER;
  const rows = options.rows ?? [];
  const dateIdx = header.indexOf("日期");
  let valuesReads = 0;
  const fetchMock = createFetchMock(async (call) => {
    if (call.url === GOOGLE_TOKEN_URL) {
      if (options.tokenCount) options.tokenCount.n += 1;
      return jsonResponse({ access_token: TEST_ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" });
    }
    if (call.method !== "GET" || !call.url.startsWith(`${SHEETS_BASE}/values/`)) throw new Error(`測試未預期的 fetch：${call.method} ${call.url}`);
    const [pathPart = ""] = call.url.slice(`${SHEETS_BASE}/values/`.length).split("?");
    const range = decodeURIComponent(pathPart);
    const index = valuesReads++;
    const custom = await options.override?.(range, call, index);
    if (custom) return custom;
    const spec = range.slice(range.indexOf("!") + 1);
    if (spec === "1:1") return jsonResponse({ range, majorDimension: "ROWS", values: [header] });
    const column = /^([A-Z]+)2:\1$/.exec(spec);
    if (column) {
      const values = rows.map((row) => (row[dateIdx] === undefined || row[dateIdx] === "" ? [] : [row[dateIdx]]));
      return jsonResponse({ range, majorDimension: "ROWS", ...(values.length ? { values } : {}) });
    }
    const block = /^(\d+):(\d+)$/.exec(spec);
    if (block) {
      const from = Number(block[1]);
      const to = Number(block[2]);
      return jsonResponse({ range, majorDimension: "ROWS", values: rows.slice(from - 2, to - 1) });
    }
    throw new Error(`測試未預期的範圍：${range}`);
  });
  return { ...fetchMock, valuesGets: () => fetchMock.calls.filter((c) => c.url.startsWith(`${SHEETS_BASE}/values/`)), ranges: () => fetchMock.calls.filter((c) => c.url.startsWith(`${SHEETS_BASE}/values/`)).map((c) => decodeURIComponent(c.url.slice(`${SHEETS_BASE}/values/`.length).split("?")[0]!)) };
}

function makeApp(options: BackendOptions & { env?: Record<string, string>; noCreds?: boolean; now?: () => number } = {}) {
  const be = backend(options);
  const log = createCapturingLogger();
  const app = createApp({
    env: loadEnv({ OPENAI_API_KEY: "test-openai-key-123", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: options.noCreds ? "" : creds.base64, ...options.env }),
    indexHtml: INDEX_HTML,
    log,
    fetchImpl: be.mock,
    sleep: async () => undefined,
    now: options.now,
    settings: auth.store,
  });
  return { app, log, ...be };
}

type App = ReturnType<typeof createApp>;
function lookup(app: App, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/boxes/lookup", {
    method: "POST",
    headers: { "content-type": "application/json", ...auth.headers, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function data(app: App, body: unknown = { date: "2026/11/27" }) {
  const res = await lookup(app, body);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { success: boolean; data: { date: string; boxes: Array<{ boxId: string; closedAt: string; items: Array<Record<string, unknown>> }>; rows: number; skipped: number } };
  expect(json.success).toBe(true);
  return json.data;
}

// ---------------------------------------------------------------------------
// 純函式
// ---------------------------------------------------------------------------

describe("輸入解析 parseBoxLookupInput", () => {
  it.each([
    ["2026/11/27", "2026/11/27"],
    ["2026-11-27", "2026/11/27"],
    ["  2026/11/27  ", "2026/11/27"],
    ["2026/1/5", "2026/01/05"],
    ["2026-1-5", "2026/01/05"],
    ["2000/01/01", "2000/01/01"],
    ["2100/12/31", "2100/12/31"],
    ["2024/02/29", "2024/02/29"],
  ])("合法：%s → %s", (input, expected) => {
    expect(parseBoxLookupInput({ date: input }).text).toBe(expected);
  });

  it.each([
    [undefined],
    [null],
    [20261127],
    [["2026/11/27"]],
    [""],
    ["   "],
    ["2026/13/01"],
    ["2026/00/10"],
    ["2026/02/30"],
    ["2025/02/29"],
    ["2026/11/31"],
    ["1999/12/31"],
    ["2101/01/01"],
    ["26/11/27"],
    ["2026.11.27"],
    ["2026/11-27"],
    ["2026/11/27 18:00"],
    ["2026/11/27x"],
    ["十一月"],
  ])("不合法 %j → 400", (input) => {
    try {
      parseBoxLookupInput({ date: input });
      throw new Error("應該要丟 400");
    } catch (err) {
      expect(err).toMatchObject({ status: 400 });
    }
  });

  it("日期序號：2026/11/27 是 46353", () => {
    expect(parseBoxLookupInput({ date: "2026/11/27" }).serial).toBe(46353);
    expect(parseBoxLookupInput({ date: "2000/01/01" }).serial).toBe(36526);
  });
});

describe("儲存格轉換", () => {
  const target = parseBoxLookupInput({ date: "2026/11/27" });

  it("日期欄：數字取整數部分比序號；字串只看開頭日期（後面接時間忽略），- 與 . 視同 /，月日補零", () => {
    expect(dateCellMatches(D, target)).toBe(true);
    expect(dateCellMatches(D + 0.99, target)).toBe(true);
    expect(dateCellMatches(D - 1, target)).toBe(false);
    expect(dateCellMatches(D + 1, target)).toBe(false);
    expect(dateCellMatches(Number.NaN, target)).toBe(false);
    for (const s of ["2026/11/27", " 2026/11/27 ", "2026-11-27", "2026.11.27", "2026/11/27 18:05:33", "2026-11-27T18:05:33"]) expect(dateCellMatches(s, target)).toBe(true);
    const other = parseBoxLookupInput({ date: "2026/01/05" });
    for (const s of ["2026/1/5", "2026-01-05", "2026.1.05"]) expect(dateCellMatches(s, other)).toBe(true);
    for (const s of ["", "   ", "2026/11/28", "2026/11/2", "2026/11/271", "x2026/11/27", "11/27/2026", "2026/11"]) expect(dateCellMatches(s, target)).toBe(false);
    for (const v of [undefined, null, true, {}, []]) expect(dateCellMatches(v, target)).toBe(false);
  });

  it("辨識時間：數字序號 → YYYY-MM-DD HH:MM:SS（四捨五入到秒，不受浮點誤差影響）；字串 trim 原樣；空白是空字串", () => {
    expect(timeCellToText(46353.7538541667)).toBe("2026-11-27 18:05:33");
    expect(timeCellToText(46353)).toBe("2026-11-27 00:00:00");
    expect(timeCellToText(46353.999988426)).toBe("2026-11-27 23:59:59");
    expect(timeCellToText(" 2026-11-27 18:05:33 ")).toBe("2026-11-27 18:05:33");
    expect(timeCellToText("下午六點")).toBe("下午六點");
    expect(timeCellToText(undefined)).toBe("");
    expect(timeCellToText("")).toBe("");
  });

  it("數量：1～9999 的整數；不是數字、小於 1 → 1；大於 9999 → 9999；小數取整", () => {
    expect(qtyCellToInt(3)).toBe(3);
    expect(qtyCellToInt("12")).toBe(12);
    expect(qtyCellToInt(" 7 ")).toBe(7);
    expect(qtyCellToInt(2.9)).toBe(2);
    expect(qtyCellToInt(1.5)).toBe(1);
    expect(qtyCellToInt(0.5)).toBe(1);
    expect(qtyCellToInt(0)).toBe(1);
    expect(qtyCellToInt(-5)).toBe(1);
    expect(qtyCellToInt("")).toBe(1);
    expect(qtyCellToInt("abc")).toBe(1);
    expect(qtyCellToInt(undefined)).toBe(1);
    expect(qtyCellToInt(null)).toBe(1);
    expect(qtyCellToInt(9999)).toBe(9999);
    expect(qtyCellToInt(10000)).toBe(9999);
    expect(qtyCellToInt(1e12)).toBe(9999);
    expect(qtyCellToInt(Number.POSITIVE_INFINITY)).toBe(9999);
  });

  it("分批：箱號＋辨識時間相同才算同一批，順序是第一次出現的順序", () => {
    const item = (barcode: string) => ({ barcode, productName: "", gender: "", color: "", size: "", mergedName: "", qty: 1 });
    const batches = groupBatches([
      { boxId: "B1", closedAt: "t1", item: item("a") },
      { boxId: "B1", closedAt: "t2", item: item("b") },
      { boxId: "B1", closedAt: "t1", item: item("c") },
    ]);
    expect(batches.map((b) => [b.boxId, b.closedAt, b.items.map((i) => i.barcode)])).toEqual([
      ["B1", "t1", ["a", "c"]],
      ["B1", "t2", ["b"]],
    ]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/boxes/lookup（讀取流程）
// ---------------------------------------------------------------------------

describe("POST /api/boxes/lookup：成功與資料轉換", () => {
  it("回應欄位完整；date 補零正規化；items 依列順序、不合併同編號；字串日期、數字日期、帶時間的日期都對得上，別天的與空白的不算", async () => {
    const { app } = makeApp({
      rows: [
        r("2026/11/26", "BOX-001", "111"), // 別天（第 2 列）
        r(D, "BOX-001", "1801550506", "溫灸帶", 2, 46353.7538541667, { gender: "男", color: "黑", size: "L", merged: "溫灸帶(男-黑L)" }), // 第 3 列：數字日期
        r("2026/11/27", "BOX-001", "1801550506", "溫灸帶", 1, 46353.7538541667, { gender: "男", color: "黑", size: "L", merged: "溫灸帶(男-黑L)" }), // 同編號：不合併
        r("2026-11-27 09:00:00", "BOX-001", "222", "護膝", 5, 46353.7538541667),
        r("", "BOX-001", "333"), // 日期空白
        r(D + 1, "BOX-001", "444"), // 隔天
      ],
    });
    const out = await data(app, { date: "2026-11-27" });
    expect(out).toEqual({
      date: "2026/11/27",
      boxes: [
        {
          boxId: "BOX-001",
          closedAt: "2026-11-27 18:05:33",
          items: [
            { barcode: "1801550506", productName: "溫灸帶", gender: "男", color: "黑", size: "L", mergedName: "溫灸帶(男-黑L)", qty: 2 },
            { barcode: "1801550506", productName: "溫灸帶", gender: "男", color: "黑", size: "L", mergedName: "溫灸帶(男-黑L)", qty: 1 },
            { barcode: "222", productName: "護膝", gender: "", color: "", size: "", mergedName: "護膝", qty: 5 },
          ],
        },
      ],
      rows: 3,
      skipped: 0,
    });
  });

  it("請求日期月日沒補零也可以（2026/1/5 對得上試算表裡的 2026/01/05 與 2026-1-5 與日期序號）", async () => {
    const serial = parseBoxLookupInput({ date: "2026/01/05" }).serial;
    const { app } = makeApp({ rows: [r("2026/01/05", "A", "1"), r("2026-1-5", "B", "2"), r(serial, "C", "3"), r("2026/01/06", "D", "4")] });
    const out = await data(app, { date: "2026/1/5" });
    expect(out.date).toBe("2026/01/05");
    expect(out.boxes.map((b) => b.boxId)).toEqual(["A", "B", "C"]);
  });

  it("同箱號但辨識時間不同 → 分成兩批；交錯的列也分對；批的順序是第一次出現的順序", async () => {
    const { app } = makeApp({
      rows: [
        r("2026/11/27", "BOX-001", "a1", "品", 1, "2026-11-27 10:00:00"),
        r("2026/11/27", "BOX-002", "b1", "品", 1, "2026-11-27 10:30:00"),
        r("2026/11/27", "BOX-001", "a2", "品", 1, "2026-11-27 11:00:00"), // 同箱號、另一個時間
        r("2026/11/27", "BOX-001", "a3", "品", 1, "2026-11-27 10:00:00"), // 回到第一批
        r("2026/11/27", "BOX-002", "b2", "品", 1, "2026-11-27 10:30:00"),
      ],
    });
    const out = await data(app);
    expect(out.boxes.map((b) => [b.boxId, b.closedAt, b.items.map((i) => i.barcode)])).toEqual([
      ["BOX-001", "2026-11-27 10:00:00", ["a1", "a3"]],
      ["BOX-002", "2026-11-27 10:30:00", ["b1", "b2"]],
      ["BOX-001", "2026-11-27 11:00:00", ["a2"]],
    ]);
    expect(out.rows).toBe(5);
  });

  it("辨識時間：數字序號轉字串；字串原樣（trim）；空白是空字串", async () => {
    const { app } = makeApp({
      rows: [r("2026/11/27", "N", "1", "品", 1, 46353.7538541667), r("2026/11/27", "S", "2", "品", 1, " 2026-11-27 08:00:00 "), r("2026/11/27", "E", "3", "品", 1, "")],
    });
    const out = await data(app);
    expect(out.boxes.map((b) => [b.boxId, b.closedAt])).toEqual([
      ["N", "2026-11-27 18:05:33"],
      ["S", "2026-11-27 08:00:00"],
      ["E", ""],
    ]);
  });

  it("箱號空白的列略過並計入 skipped（rows 只算有箱號的）；全是空白箱號時 boxes 是空陣列", async () => {
    const { app } = makeApp({ rows: [r("2026/11/27", "B1", "1"), r("2026/11/27", "", "2"), r("2026/11/27", "   ", "3"), r("2026/11/27", undefined, "4")] });
    const out = await data(app);
    expect(out.rows).toBe(1);
    expect(out.skipped).toBe(3);
    expect(out.boxes).toHaveLength(1);
    const { app: app2 } = makeApp({ rows: [r("2026/11/27", "", "2")] });
    expect(await data(app2)).toEqual({ date: "2026/11/27", boxes: [], rows: 0, skipped: 1 });
  });

  it("箱號與商品編號是數字型別時當文字；前導零的字串不變；商品編號可以是空字串；不是安全整數的數字當空", async () => {
    const { app } = makeApp({
      rows: [
        r("2026/11/27", 7, 1801550506),
        r("2026/11/27", "007", "0012345"),
        r("2026/11/27", " 8 ", ""),
        r("2026/11/27", "9", 1.5),
        r("2026/11/27", "10", 2 ** 60),
      ],
    });
    const out = await data(app);
    expect(out.boxes.map((b) => [b.boxId, b.items[0]!.barcode])).toEqual([["7", "1801550506"], ["007", "0012345"], ["8", ""], ["9", ""], ["10", ""]]);
  });

  it("數量與文字欄位的正規化：數量落在 1～9999 的整數；品名等欄位 trim、數字轉字串", async () => {
    const { app } = makeApp({
      rows: [
        r("2026/11/27", "B", "1", "  品名  ", 0),
        r("2026/11/27", "B", "2", "品", -3),
        r("2026/11/27", "B", "3", "品", "abc"),
        r("2026/11/27", "B", "4", "品", 12345),
        r("2026/11/27", "B", "5", "品", 2.9),
        r("2026/11/27", "B", "6", "品", "5"),
        r("2026/11/27", "B", "7", "品", undefined),
        r("2026/11/27", "B", "8", 123 as unknown as string, 1, "2026-11-27 18:05:33", { gender: " 男 ", size: "99" }),
      ],
    });
    const out = await data(app);
    expect(out.boxes[0]!.items.map((i) => i.qty)).toEqual([1, 1, 1, 9999, 2, 5, 1, 1]);
    expect(out.boxes[0]!.items[0]!.productName).toBe("品名");
    expect(out.boxes[0]!.items[7]).toMatchObject({ productName: "123", gender: "男", size: "99" });
  });

  it("欄位依表頭名稱找、不寫死位置：表頭順序不同、多了備註欄也對", async () => {
    const header = ["備註", "辨識時間", "數量", "合併品名", "尺寸", "顏色", "性別", "品名", "商品編號", "箱號", "日期", "序號"];
    const row = ["x", "T1", 4, "合併", "M", "紅", "女", "品名", "555", "BOX-9", "2026/11/27", "1"];
    const { app, ranges } = makeApp({ header, rows: [["x", "T0", 1, "", "", "", "", "", "", "BOX-0", "2026/11/26", "1"], row] });
    const out = await data(app);
    expect(out.boxes).toEqual([{ boxId: "BOX-9", closedAt: "T1", items: [{ barcode: "555", productName: "品名", gender: "女", color: "紅", size: "M", mergedName: "合併", qty: 4 }] }]);
    expect(ranges()).toEqual(["'商品主檔'!1:1", "'商品主檔'!K2:K", "'商品主檔'!3:3"]); // 日期在第 11 欄（K）
  });

  it("讀取參數：只讀日期欄＋符合列的最小～最大整塊；帶 UNFORMATTED_VALUE、SERIAL_NUMBER、ROWS；用 Bearer token；沒有任何寫入", async () => {
    const { app, ranges, valuesGets, calls } = makeApp({
      rows: [r("2026/11/26", "A", "1"), r("2026/11/27", "B", "2"), r("2026/11/26", "C", "3"), r("2026/11/27", "D", "4"), r("2026/11/28", "E", "5")],
    });
    const out = await data(app);
    expect(ranges()).toEqual(["'商品主檔'!1:1", "'商品主檔'!B2:B", "'商品主檔'!3:5"]); // 符合的是第 3、5 列
    expect(out.boxes.map((b) => b.boxId)).toEqual(["B", "D"]); // 整塊裡中間那列（別天）被日期再過濾掉
    for (const c of valuesGets().slice(1)) {
      expect(c.url).toContain("valueRenderOption=UNFORMATTED_VALUE");
      expect(c.url).toContain("dateTimeRenderOption=SERIAL_NUMBER");
      expect(c.url).toContain("majorDimension=ROWS");
      expect(c.headers.authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    }
    expect(calls.filter((c) => c.url.startsWith(SHEETS_BASE)).every((c) => c.method === "GET")).toBe(true);
  });

  it("一列都不符合：直接回空的 boxes，只有「表頭＋日期欄」兩次 values 讀取，不做第二次（整塊）讀取", async () => {
    const { app, ranges } = makeApp({ rows: [r("2026/11/26", "A", "1"), r(D + 1, "B", "2")] });
    expect(await data(app)).toEqual({ date: "2026/11/27", boxes: [], rows: 0, skipped: 0 });
    expect(ranges()).toEqual(["'商品主檔'!1:1", "'商品主檔'!B2:B"]);
  });

  it("試算表是空的（Google 回應沒有 values）：回空結果", async () => {
    const { app } = makeApp({ rows: [] });
    expect(await data(app)).toEqual({ date: "2026/11/27", boxes: [], rows: 0, skipped: 0 });
  });

  it("表頭走既有的 5 分鐘快取：第二次查詢不再讀表頭；不快取查詢結果（資料每次重讀）", async () => {
    let clock = 1_000_000;
    const rows: Row[] = [r("2026/11/27", "B1", "1")];
    const { app, ranges } = makeApp({ rows, now: () => clock });
    expect((await data(app)).boxes).toHaveLength(1);
    rows.push(r("2026/11/27", "B2", "2", "品", 1, "t2"));
    clock += 1000;
    expect((await data(app)).boxes).toHaveLength(2); // 新增的列立刻看得到
    expect(ranges().filter((x) => x.endsWith("!1:1"))).toHaveLength(1);
  });

  it("log 只寫筆數、批數與耗時，不含任何列的內容", async () => {
    const { app, log } = makeApp({ rows: [r("2026/11/27", "BOX-SECRET", "9990001112", "機密品名")] });
    await data(app);
    const text = log.lines.join("\n");
    expect(text).toContain("[box-lookup]");
    expect(text).toMatch(/符合 1 列/);
    for (const leak of ["BOX-SECRET", "9990001112", "機密品名", TEST_ACCESS_TOKEN]) expect(text).not.toContain(leak);
  });
});

describe("POST /api/boxes/lookup：錯誤", () => {
  it("輸入格式錯 → 400 {success:false,error}（不呼叫 Google）", async () => {
    const { app, calls } = makeApp();
    for (const body of [{}, { date: 1 }, { date: "2026/02/30" }, { date: "1999/01/01" }, "{壞掉的 json", "[]"]) {
      const res = await lookup(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, error: expect.any(String) });
    }
    expect(calls).toHaveLength(0);
  });

  it("表頭缺欄 → 500，訊息指出缺哪幾欄（比照存檔）；不讀日期欄", async () => {
    const { app, ranges } = makeApp({ header: FULL_HEADER.filter((n) => n !== "箱號" && n !== "辨識時間") });
    const res = await lookup(app, { date: "2026/11/27" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "試算表「商品主檔」第 1 列表頭缺少必要欄位：箱號、辨識時間" });
    expect(ranges()).toEqual(["'商品主檔'!1:1"]);
  });

  it("「序號」欄不是讀回需要的欄位：沒有序號欄也能讀", async () => {
    const { app } = makeApp({ header: FULL_HEADER.filter((n) => n !== "序號"), rows: [] });
    expect((await lookup(app, { date: "2026/11/27" })).status).toBe(200);
  });

  it.each([
    ["Google 回 500", (r: string) => (r.endsWith("!B2:B") ? jsonResponse({ error: { message: SECRET_UPSTREAM } }, 500) : undefined)],
    ["Google 回 403", (r: string) => (r.endsWith("!B2:B") ? jsonResponse({ error: { message: SECRET_UPSTREAM } }, 403) : undefined)],
    ["Google 回 429", (r: string) => (r.endsWith("!B2:B") ? jsonResponse({ error: { message: SECRET_UPSTREAM } }, 429) : undefined)],
    ["讀表頭就失敗（404）", (r: string) => (r.endsWith("!1:1") ? jsonResponse({ error: { message: SECRET_UPSTREAM } }, 404) : undefined)],
    ["整塊讀取失敗", (r: string) => (/![0-9]+:[0-9]+$/.test(r) && !r.endsWith("!1:1") ? jsonResponse({ error: { message: SECRET_UPSTREAM } }, 500) : undefined)],
  ])("上游失敗：%s → 502 固定短句，訊息與 log 都不含上游內容、token", async (_name, pick) => {
    const { app, log } = makeApp({ rows: [r("2026/11/27", "B", "1")], override: (range) => pick(range) });
    const res = await lookup(app, { date: "2026/11/27" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: "商品主檔暫時無法讀取，請稍後再試" });
    const text = log.lines.join("\n");
    expect(text).not.toContain(SECRET_UPSTREAM);
    expect(text).not.toContain(TEST_ACCESS_TOKEN);
  });

  it("連線錯誤、逾時 → 502 固定短句；回應內容不是合法 JSON 的 200 也不會變 500", async () => {
    const boom = makeApp({ override: () => { throw new TypeError(`fetch failed ${SECRET_UPSTREAM}`); } });
    const res = await lookup(boom.app, { date: "2026/11/27" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: "商品主檔暫時無法讀取，請稍後再試" });
    expect(boom.log.lines.join("\n")).not.toContain("Bearer");

    const timeout = makeApp({ override: () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); } });
    expect((await lookup(timeout.app, { date: "2026/11/27" })).status).toBe(502);

    const weird = makeApp({ rows: [r("2026/11/27", "B", "1")], override: (range) => (range.endsWith("!B2:B") ? jsonResponse({ values: "not-an-array" }) : undefined) });
    expect((await lookup(weird.app, { date: "2026/11/27" })).status).toBe(502);
  });

  it("沒有 Google 憑證 → 503（先驗輸入：日期格式錯仍是 400）", async () => {
    const { app, calls } = makeApp({ noCreds: true });
    const res = await lookup(app, { date: "2026/11/27" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: "伺服器尚未完成 Google 試算表設定" });
    expect((await lookup(app, { date: "bad" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it(`這一天符合的列超過 ${BOX_LOOKUP_MAX_ROWS} → 400，不讀整塊；剛好 ${BOX_LOOKUP_MAX_ROWS} 列可以`, async () => {
    const many = (n: number): Row[] => Array.from({ length: n }, (_, i) => r("2026/11/27", `B${i}`, "1"));
    const over = makeApp({ rows: many(BOX_LOOKUP_MAX_ROWS + 1) });
    const res = await lookup(over.app, { date: "2026/11/27" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "這一天的資料超過 5000 筆，無法一次載入" });
    expect(over.ranges()).toEqual(["'商品主檔'!1:1", "'商品主檔'!B2:B"]);

    const exact = makeApp({ rows: many(BOX_LOOKUP_MAX_ROWS) });
    const ok = await data(exact.app);
    expect(ok.rows).toBe(BOX_LOOKUP_MAX_ROWS);
    expect(BOX_LOOKUP_MAX_ROWS).toBe(5000);
  });

  it(`符合的列首尾跨度超過 ${BOX_LOOKUP_MAX_SPAN} 列 → 400，不讀整塊；剛好 ${BOX_LOOKUP_MAX_SPAN} 列可以`, async () => {
    const filler = (n: number): Row[] => Array.from({ length: n }, () => r("2026/11/20", "X", "1"));
    // 第 2 列與第 (2 + SPAN) 列：跨度 SPAN + 1 → 超過
    const over = makeApp({ rows: [r("2026/11/27", "B0", "1"), ...filler(BOX_LOOKUP_MAX_SPAN - 1), r("2026/11/27", "B1", "1")] });
    const res = await lookup(over.app, { date: "2026/11/27" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "這一天的資料在試算表裡太分散，無法載入" });
    expect(over.ranges()).toEqual(["'商品主檔'!1:1", "'商品主檔'!B2:B"]);

    // 第 2 列與第 (1 + SPAN) 列：跨度剛好 SPAN
    const exact = makeApp({ rows: [r("2026/11/27", "B0", "1"), ...filler(BOX_LOOKUP_MAX_SPAN - 2), r("2026/11/27", "B1", "1")] });
    const ok = await data(exact.app);
    expect(ok.boxes.map((b) => b.boxId)).toEqual(["B0", "B1"]);
    expect(exact.ranges()[2]).toBe(`'商品主檔'!2:${1 + BOX_LOOKUP_MAX_SPAN}`);
    expect(BOX_LOOKUP_MAX_SPAN).toBe(20000);
  });

  it("401：換新 token 後重送一次（讀取不自動重試其他狀況）；第二次還是 401 就 502", async () => {
    const tokens = { n: 0 };
    let failed = false;
    const retry = makeApp({
      rows: [r("2026/11/27", "B", "1")],
      tokenCount: tokens,
      override: (range) => {
        if (range.endsWith("!B2:B") && !failed) {
          failed = true;
          return jsonResponse({ error: { status: "UNAUTHENTICATED", message: SECRET_UPSTREAM } }, 401);
        }
        return undefined;
      },
    });
    const out = await data(retry.app);
    expect(out.boxes).toHaveLength(1);
    expect(tokens.n).toBe(2); // 第一次的 token 被作廢後重新換
    expect(retry.ranges().filter((x) => x.endsWith("!B2:B"))).toHaveLength(2); // 日期欄只重送一次

    const always = makeApp({ rows: [r("2026/11/27", "B", "1")], override: (range) => (range.endsWith("!B2:B") ? jsonResponse({}, 401) : undefined) });
    expect((await lookup(always.app, { date: "2026/11/27" })).status).toBe(502);
    expect(always.ranges().filter((x) => x.endsWith("!B2:B"))).toHaveLength(2);

    const once = makeApp({ rows: [r("2026/11/27", "B", "1")], override: (range) => (range.endsWith("!B2:B") ? jsonResponse({}, 500) : undefined) });
    await lookup(once.app, { date: "2026/11/27" });
    expect(once.ranges().filter((x) => x.endsWith("!B2:B"))).toHaveLength(1); // 500 不重試
  });
});

describe("POST /api/boxes/lookup：登入、方法與限流", () => {
  it("沒登入 → 401「請先登入」；已登入但缺 X-Requested-With → 403；兩者都不呼叫 Google", async () => {
    const { app, calls } = makeApp();
    for (const headers of [{}, { cookie: "sp_session=garbage" }] as Array<Record<string, string>>) {
      const res = await app.request("/api/boxes/lookup", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ date: "2026/11/27" }) });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, error: "請先登入" });
    }
    const noXhr = await app.request("/api/boxes/lookup", { method: "POST", headers: { "content-type": "application/json", cookie: auth.cookie }, body: JSON.stringify({ date: "2026/11/27" }) });
    expect(noXhr.status).toBe(403);
    expect(await noXhr.json()).toEqual({ success: false, error: "缺少必要的請求標頭" });
    expect(calls).toHaveLength(0);
  });

  it("任一角色都可以用（一般使用者與管理員）", async () => {
    const admin = await createAuthFixture({ role: "admin", email: "boss@example.test" });
    const be = backend({ rows: [] });
    const app = createApp({ env: loadEnv({ OPENAI_API_KEY: "k", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: creds.base64 }), indexHtml: INDEX_HTML, log: createCapturingLogger(), fetchImpl: be.mock, settings: admin.store });
    const res = await app.request("/api/boxes/lookup", { method: "POST", headers: { "content-type": "application/json", ...admin.headers }, body: JSON.stringify({ date: "2026/11/27" }) });
    expect(res.status).toBe(200);
    expect((await lookup(makeApp().app, { date: "2026/11/27" })).status).toBe(200); // 一般使用者
  });

  it("其他方法 → 405＋Allow: POST（沒登入也是 405）", async () => {
    const { app } = makeApp();
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await app.request("/api/boxes/lookup", { method, headers: auth.headers });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    expect((await app.request("/api/boxes/lookup")).status).toBe(405);
  });

  it(`限流：每 IP 每分鐘 ${BOX_LOOKUP_RATE_LIMIT_MAX} 次，第 31 次 429（含 Retry-After）；換 IP 不受影響；有自己的桶，與 OCR、存檔、商品查詢互不擠壓（雙向）`, async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    const ip = (a: string) => ({ "x-forwarded-for": a });
    expect(BOX_LOOKUP_RATE_LIMIT_MAX).toBe(30);
    for (let i = 0; i < BOX_LOOKUP_RATE_LIMIT_MAX; i++) {
      const res = await lookup(app, {}, ip("203.0.113.70"));
      if (res.status !== 400) throw new Error(`第 ${i + 1} 次預期通過限流（輸入驗證 400），實際 ${res.status}`);
    }
    const limited = await lookup(app, {}, ip("203.0.113.70"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await lookup(app, {}, ip("203.0.113.71"))).status).toBe(400);

    // 讀回用完 → 其他桶沒被吃掉
    const post = (path: string, headers: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...auth.headers, ...headers }, body: "{}" });
    expect((await post("/api/ocr", ip("203.0.113.70"))).status).toBe(400);
    expect((await post("/api/save", ip("203.0.113.70"))).status).toBe(400);
    expect((await post("/api/products/lookup", ip("203.0.113.70"))).status).toBe(400);

    // 反過來：其他桶用完 → 讀回照常
    const other = ip("203.0.113.72");
    for (let i = 0; i <= OCR_RATE_LIMIT_MAX; i++) await post("/api/ocr", other);
    for (let i = 0; i <= PRODUCT_LOOKUP_RATE_LIMIT_MAX; i++) await post("/api/products/lookup", other);
    for (let i = 0; i <= Math.min(SAVE_RATE_LIMIT_MAX, 100); i++) await post("/api/save", other);
    expect((await lookup(app, {}, other)).status).toBe(400);
  });

  it("沒登入的請求在限流之前就被 401 擋下，不吃已登入同事的額度", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    const address = { "x-forwarded-for": "203.0.113.80" };
    for (let i = 0; i < BOX_LOOKUP_RATE_LIMIT_MAX + 20; i++) {
      const res = await app.request("/api/boxes/lookup", { method: "POST", headers: { "content-type": "application/json", ...address }, body: "{}" });
      expect(res.status).toBe(401);
    }
    for (let i = 0; i < BOX_LOOKUP_RATE_LIMIT_MAX; i++) expect((await lookup(app, {}, address)).status).toBe(400);
    expect((await lookup(app, {}, address)).status).toBe(429);
  });
});
