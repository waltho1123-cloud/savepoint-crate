import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp, OCR_RATE_LIMIT_MAX, PRODUCT_LOOKUP_RATE_LIMIT_MAX } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { GoogleTokenProvider } from "../src/google-auth.js";
import {
  cellToKey,
  columnLetter,
  parseLookupInput,
  ProductCatalog,
  PRODUCT_CACHE_TTL_MS,
  PRODUCT_MISS_REFRESH_MS,
  PRODUCT_RETRY_BACKOFF_MS,
} from "../src/products.js";
import {
  createCapturingLogger,
  createFetchMock,
  GOOGLE_TOKEN_URL,
  jsonResponse,
  makeCredentials,
  TEST_ACCESS_TOKEN,
  type RecordedCall,
} from "./helpers.js";
import { cleanupTempDirs, createAuthFixture, makeSettingsApp, type AuthFixture } from "./settings-helpers.js";

const PRODUCT_SHEET_ID = "1cqjAGZP53FZCbfvGg78syO979Qe5G3JrGK6S3UJQ92s";
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${PRODUCT_SHEET_ID}/values:batchGet`;
const creds = makeCredentials();
const INDEX_HTML = "<!DOCTYPE html><html><body>測試頁</body></html>";

let auth: AuthFixture;
beforeAll(async () => {
  auth = await createAuthFixture();
});
afterAll(cleanupTempDirs);
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 假的商品總表試算表：兩個分頁（表頭與資料列可在測試中改動），依 batchGet 的 ranges 回應。
// ---------------------------------------------------------------------------

const MASTER_HEADER = ["年份", "編號", "色號", "尺寸代號", "商品編號", "商品編號+尺寸", "建檔檢查", "領型(不用填寫)", "系列", "商品名稱", "性別", "顏色", "尺寸"];
const CLOUD_HEADER = ["序號", "年份", "商品編號(進倉)", "商品名稱(進倉)", "項目", "比對"];

/** 商品總表的一列。key 可以是數字（模擬儲存格是數字型別）或字串。 */
function masterRow(key: unknown, name: string, gender: string, color: string, size: string): unknown[] {
  return ["2026", "01", "R", "S", "180111275", key, "OK", "", "溫灸", name, gender, color, size];
}
function cloudRow(key: unknown, name: string): unknown[] {
  return [1, "2026", key, name, "", ""];
}

class FakeSheet {
  header: unknown[];
  rows: unknown[][];
  constructor(header: unknown[], rows: unknown[][]) {
    this.header = header;
    this.rows = rows;
  }
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function makeBackend(initial?: { master?: FakeSheet; cloud?: FakeSheet }) {
  const state = {
    master:
      initial?.master ??
      new FakeSheet(MASTER_HEADER, [
        masterRow(1801112756, "第五代溫灸刷毛圓領發熱衣", "男", "陶玫粉", "2XL"),
        masterRow("1801112757", "第五代溫灸刷毛圓領發熱衣", "女", "經典黑", "L"),
        masterRow("1801112758", "只在商品總表的品", "", "", ""),
        masterRow("", "編號空白的列要略過", "男", "黑", "M"),
      ]),
    cloud:
      initial?.cloud ??
      new FakeSheet(CLOUD_HEADER, [
        cloudRow("1801112756", "第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)"),
        cloudRow(1801112757, ""), // 官方品名那格是空的
        cloudRow(1801119999, "只在雲端總表的品"),
      ]),
    failWith: null as number | null,
    tokenFailures401: 0,
  };
  const { mock, calls } = createFetchMock((call: RecordedCall) => {
    if (call.url === GOOGLE_TOKEN_URL) return jsonResponse({ access_token: TEST_ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" });
    if (!call.url.startsWith(BASE)) throw new Error(`測試未預期的 fetch：${call.method} ${call.url}`);
    if (state.tokenFailures401 > 0) {
      state.tokenFailures401 -= 1;
      return jsonResponse({ error: { code: 401 } }, 401);
    }
    if (state.failWith !== null) return jsonResponse({ error: { message: "UPSTREAM-SECRET-DETAIL" } }, state.failWith);
    const url = new URL(call.url);
    const ranges = url.searchParams.getAll("ranges");
    const columns = url.searchParams.get("majorDimension") === "COLUMNS";
    expect(url.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    const valueRanges = ranges.map((range) => {
      const [sheetPart, area] = range.split("!") as [string, string];
      const sheet = sheetPart === "'商品總表'" ? state.master : sheetPart === "'雲端總表'" ? state.cloud : null;
      if (!sheet) throw new Error(`未知分頁 ${sheetPart}`);
      if (area === "1:1") return { range, values: [sheet.header] };
      const letters = /^([A-Z]+)2:\1$/.exec(area)?.[1];
      if (!letters || !columns) throw new Error(`測試未預期的範圍 ${range}`);
      const col = sheet.rows.map((r) => r[colIndex(letters)] ?? "");
      while (col.length > 0 && col[col.length - 1] === "") col.pop(); // Google 省略尾端空白
      return col.length > 0 ? { range, values: [col] } : { range };
    });
    return jsonResponse({ spreadsheetId: PRODUCT_SHEET_ID, valueRanges });
  });
  /** 讀表頭的請求次數＝重抓的次數（每次重抓先讀一次表頭）。 */
  const reloads = () => calls.filter((c) => c.url.startsWith(BASE) && c.url.includes("majorDimension=ROWS")).length;
  return { state, mock, calls, reloads };
}

function makeCatalog(backend: ReturnType<typeof makeBackend>, clock: { now: number }, log = createCapturingLogger()) {
  const now = () => clock.now;
  return {
    log,
    catalog: new ProductCatalog({
      tokenProvider: new GoogleTokenProvider({ client_email: creds.email, private_key: creds.privateKeyPem }, { fetchImpl: backend.mock, log, now }),
      spreadsheetId: PRODUCT_SHEET_ID,
      masterSheetName: "商品總表",
      cloudSheetName: "雲端總表",
      fetchImpl: backend.mock,
      log,
      now,
    }),
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

describe("小工具", () => {
  it("columnLetter：0→A、25→Z、26→AA、27→AB、701→ZZ、702→AAA", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("cellToKey：字串 trim、安全整數轉文字；小數、非安全整數、其他型別都是空（不補零、不去零）", () => {
    expect(cellToKey(" 1801112756 ")).toBe("1801112756");
    expect(cellToKey(1801112756)).toBe("1801112756");
    expect(cellToKey("01801112756")).toBe("01801112756");
    expect(cellToKey("1801112756.0")).toBe("1801112756.0");
    expect(cellToKey(1801112756.5)).toBe("");
    expect(cellToKey(2 ** 60)).toBe("");
    expect(cellToKey(null)).toBe("");
    expect(cellToKey(true)).toBe("");
  });

  it("parseLookupInput：去重並 trim、保留順序；格式錯誤各丟 400", () => {
    expect(parseLookupInput({ barcodes: [" 1 ", "2", "1"] })).toEqual(["1", "2"]);
    expect(parseLookupInput({ barcodes: Array.from({ length: 200 }, (_, i) => String(i)) })).toHaveLength(200);
    expect(parseLookupInput({ barcodes: ["a".repeat(64)] })).toHaveLength(1);
    const bad: unknown[] = [{}, { barcodes: "1" }, { barcodes: [] }, { barcodes: Array.from({ length: 201 }, (_, i) => String(i)) }, { barcodes: [123] }, { barcodes: [null] }, { barcodes: ["  "] }, { barcodes: [""] }, { barcodes: ["a".repeat(65)] }];
    for (const body of bad) {
      expect(() => parseLookupInput(body as Record<string, unknown>), JSON.stringify(body).slice(0, 60)).toThrowError(expect.objectContaining({ status: 400 }));
    }
  });
});

// ---------------------------------------------------------------------------
// ProductCatalog：資料合併規則與快取
// ---------------------------------------------------------------------------

describe("ProductCatalog：查詢與資料合併", () => {
  it("兩個分頁都有：欄位來自商品總表、officialName 來自雲端總表；查不到的列在 missing", async () => {
    const backend = makeBackend();
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    const result = await catalog.lookup(["1801112756", "9999999999"]);
    expect(result).toEqual({
      products: {
        "1801112756": { productName: "第五代溫灸刷毛圓領發熱衣", gender: "男", color: "陶玫粉", size: "2XL", officialName: "第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)" },
      },
      missing: ["9999999999"],
    });
  });

  it("編號儲存格是數字型別（1801112756）或字串型別都查得到；純文字比對：補零或帶小數點都查不到", async () => {
    const backend = makeBackend();
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    const result = await catalog.lookup(["1801112756", "1801112757", "01801112756", "1801112756.0"]);
    expect(Object.keys(result.products)).toEqual(["1801112756", "1801112757"]);
    expect(result.missing).toEqual(["01801112756", "1801112756.0"]);
  });

  it("雲端總表的官方品名是空的：officialName 退回由四個欄位組出的合併品名", async () => {
    const { catalog } = makeCatalog(makeBackend(), { now: 1_000_000 });
    const result = await catalog.lookup(["1801112757"]);
    expect(result.products["1801112757"]).toEqual({
      productName: "第五代溫灸刷毛圓領發熱衣",
      gender: "女",
      color: "經典黑",
      size: "L",
      officialName: "第五代溫灸刷毛圓領發熱衣(女-經典黑L)",
    });
  });

  it("只在商品總表有：officialName 用合併品名規則組（性別顏色尺寸皆空就是品名本身）", async () => {
    const { catalog } = makeCatalog(makeBackend(), { now: 1_000_000 });
    const result = await catalog.lookup(["1801112758"]);
    expect(result.products["1801112758"]).toEqual({ productName: "只在商品總表的品", gender: "", color: "", size: "", officialName: "只在商品總表的品" });
  });

  it("只在雲端總表有：productName 與 officialName 都是雲端總表那格，性別顏色尺寸是空字串", async () => {
    const { catalog } = makeCatalog(makeBackend(), { now: 1_000_000 });
    const result = await catalog.lookup(["1801119999"]);
    expect(result.products["1801119999"]).toEqual({ productName: "只在雲端總表的品", gender: "", color: "", size: "", officialName: "只在雲端總表的品" });
  });

  it("編號空白的列略過；同一編號出現多次以第一次為準，log 只記重複的筆數", async () => {
    const backend = makeBackend();
    backend.state.master.rows.push(masterRow("1801112756", "重複的第二筆（不採用）", "女", "白", "S"));
    backend.state.cloud.rows.push(cloudRow("1801119999", "重複的雲端第二筆（不採用）"));
    const { catalog, log } = makeCatalog(backend, { now: 1_000_000 });
    const result = await catalog.lookup(["1801112756", "1801119999", ""]);
    expect(result.products["1801112756"]!.productName).toBe("第五代溫灸刷毛圓領發熱衣");
    expect(result.products["1801119999"]!.productName).toBe("只在雲端總表的品");
    const text = log.lines.join("\n");
    expect(text).toContain("重複編號 2 筆");
    expect(text).not.toContain("重複的第二筆");
    expect(catalog.rowCount).toBe(4); // 1801112756、57、58、1801119999
  });

  it("商品編號叫 __proto__ 也只是一般的鍵（回應物件不會被汙染）", async () => {
    const { catalog } = makeCatalog(makeBackend(), { now: 1_000_000 });
    const result = await catalog.lookup(["__proto__", "constructor"]);
    expect(result.missing).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(result.products)).toBe(Object.prototype);
    expect(Object.keys(result.products)).toEqual([]);
  });

  it("只抓需要的欄位範圍（商品總表 5 欄、雲端總表 2 欄），欄位字母由表頭名稱決定", async () => {
    const backend = makeBackend();
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    await catalog.lookup(["1801112756"]);
    const columnCall = backend.calls.find((c) => c.url.includes("majorDimension=COLUMNS"))!;
    const ranges = new URL(columnCall.url).searchParams.getAll("ranges");
    // 商品編號+尺寸＝F、商品名稱＝J、性別＝K、顏色＝L、尺寸＝M；雲端總表 商品編號…＝C、商品名稱…＝D
    expect(ranges).toEqual(["'商品總表'!F2:F", "'商品總表'!J2:J", "'商品總表'!K2:K", "'商品總表'!L2:L", "'商品總表'!M2:M", "'雲端總表'!C2:C", "'雲端總表'!D2:D"]);
    expect(columnCall.headers.authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(columnCall.signal).toBeTruthy(); // 有 timeout
  });

  it("表頭欄位換了位置也照樣依名稱找（不寫死欄位字母）", async () => {
    const header = [...MASTER_HEADER].reverse();
    const rows = [masterRow("1801112756", "反向表頭的品", "男", "黑", "M")].map((r) => [...r].reverse());
    const backend = makeBackend({ master: new FakeSheet(header, rows) });
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    const result = await catalog.lookup(["1801112756"]);
    expect(result.products["1801112756"]!.productName).toBe("反向表頭的品");
    expect(result.products["1801112756"]!.color).toBe("黑");
  });

  it("log 只寫筆數與耗時，不寫商品內容", async () => {
    const { catalog, log } = makeCatalog(makeBackend(), { now: 1_000_000 });
    await catalog.lookup(["1801112756"]);
    const text = log.lines.join("\n");
    expect(text).toMatch(/載入商品總表 4 筆，耗時 \d+ ms/);
    expect(text).not.toContain("溫灸");
    expect(text).not.toContain("1801112756");
  });
});

describe("ProductCatalog：表頭缺欄回 500 並指出分頁與欄名", () => {
  it("商品總表缺 性別", async () => {
    const backend = makeBackend({ master: new FakeSheet(MASTER_HEADER.filter((h) => h !== "性別"), []) });
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    await expect(catalog.lookup(["1"])).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/「商品總表」.*性別/) });
  });

  it("商品總表只有 商品編號 與 尺寸代號、沒有 商品編號+尺寸：精確比對，不會誤用 商品編號", async () => {
    const backend = makeBackend({ master: new FakeSheet(MASTER_HEADER.filter((h) => h !== "商品編號+尺寸"), []) });
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    await expect(catalog.lookup(["1"])).rejects.toMatchObject({ status: 500, message: expect.stringContaining("商品編號+尺寸") });
  });

  it("雲端總表沒有任何以 商品名稱 開頭的欄", async () => {
    const backend = makeBackend({ cloud: new FakeSheet(["序號", "年份", "商品編號(進倉)", "項目"], []) });
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    await expect(catalog.lookup(["1"])).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/「雲端總表」.*商品名稱/) });
  });

  it("雲端總表有兩欄都以 商品編號 開頭", async () => {
    const backend = makeBackend({ cloud: new FakeSheet(["序號", "商品編號A", "商品編號B", "商品名稱(進倉)"], []) });
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    await expect(catalog.lookup(["1"])).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/「雲端總表」.*2 欄.*商品編號/) });
  });

  it("有舊資料時表頭被改壞：照舊資料回答並寫 warn（不是 500）", async () => {
    const backend = makeBackend();
    const clock = { now: 1_000_000 };
    const { catalog, log } = makeCatalog(backend, clock);
    await catalog.lookup(["1801112756"]);
    backend.state.master.header = MASTER_HEADER.filter((h) => h !== "性別");
    clock.now += PRODUCT_CACHE_TTL_MS;
    const result = await catalog.lookup(["1801112756"]);
    expect(Object.keys(result.products)).toEqual(["1801112756"]);
    expect(log.warns.join("\n")).toContain("沿用舊資料");
  });
});

describe("ProductCatalog：快取與重抓", () => {
  it("TTL 內第二次查詢不再呼叫 Google；過了 10 分鐘才重抓", async () => {
    const backend = makeBackend();
    const clock = { now: 1_000_000 };
    const { catalog } = makeCatalog(backend, clock);
    await catalog.lookup(["1801112756"]);
    expect(backend.reloads()).toBe(1);
    const callsAfterFirst = backend.calls.length;
    clock.now += PRODUCT_CACHE_TTL_MS - 1;
    await catalog.lookup(["1801112756"]);
    expect(backend.calls.length).toBe(callsAfterFirst);
    clock.now += 1;
    await catalog.lookup(["1801112756"]);
    expect(backend.reloads()).toBe(2);
    expect(PRODUCT_CACHE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("查無的編號：60 秒內不重複觸發重抓；超過 60 秒重抓一次，新出現的編號查得到", async () => {
    const backend = makeBackend();
    const clock = { now: 1_000_000 };
    const { catalog } = makeCatalog(backend, clock);
    expect((await catalog.lookup(["2000000001"])).missing).toEqual(["2000000001"]);
    expect(backend.reloads()).toBe(1);
    backend.state.master.rows.push(masterRow("2000000001", "新品", "男", "藍", "M"));
    clock.now += PRODUCT_MISS_REFRESH_MS - 1;
    expect((await catalog.lookup(["2000000001"])).missing).toEqual(["2000000001"]); // 還沒到 60 秒：不重抓
    expect(backend.reloads()).toBe(1);
    clock.now += 1;
    const result = await catalog.lookup(["2000000001"]);
    expect(backend.reloads()).toBe(2);
    expect(result.missing).toEqual([]);
    expect(result.products["2000000001"]!.productName).toBe("新品");
    expect(PRODUCT_MISS_REFRESH_MS).toBe(60_000);
  });

  it("全部查得到時，即使超過 60 秒也不因為「查無」而重抓", async () => {
    const backend = makeBackend();
    const clock = { now: 1_000_000 };
    const { catalog } = makeCatalog(backend, clock);
    await catalog.lookup(["1801112756"]);
    clock.now += PRODUCT_MISS_REFRESH_MS * 3;
    await catalog.lookup(["1801112756"]);
    expect(backend.reloads()).toBe(1);
  });

  it("同時進來 5 個查詢只觸發一次重抓（冷啟動與查無觸發重抓都是）", async () => {
    const backend = makeBackend();
    const clock = { now: 1_000_000 };
    const { catalog } = makeCatalog(backend, clock);
    await Promise.all(Array.from({ length: 5 }, () => catalog.lookup(["1801112756"])));
    expect(backend.reloads()).toBe(1);
    clock.now += PRODUCT_MISS_REFRESH_MS;
    await Promise.all(Array.from({ length: 5 }, () => catalog.lookup(["9999999999"])));
    expect(backend.reloads()).toBe(2);
  });

  it("重抓失敗但有舊資料：照舊資料回答並寫一行 warn（不含上游內容）", async () => {
    const backend = makeBackend();
    const clock = { now: 1_000_000 };
    const { catalog, log } = makeCatalog(backend, clock);
    await catalog.lookup(["1801112756"]);
    backend.state.failWith = 500;
    clock.now += PRODUCT_CACHE_TTL_MS;
    const result = await catalog.lookup(["1801112756", "9999999999"]);
    expect(Object.keys(result.products)).toEqual(["1801112756"]);
    expect(result.missing).toEqual(["9999999999"]);
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toContain("沿用舊資料");
    expect(log.lines.join("\n")).not.toContain("UPSTREAM-SECRET-DETAIL");
  });

  it("完全沒有資料時讀取失敗：502、訊息是固定短句，不含上游內容；恢復後下一次查詢就成功", async () => {
    const backend = makeBackend();
    backend.state.failWith = 503;
    const clock = { now: 1_000_000 };
    const { catalog } = makeCatalog(backend, clock);
    const error = await catalog.lookup(["1801112756"]).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, message: "商品總表暫時無法讀取，請稍後再試" });
    expect(String((error as Error).message)).not.toContain("UPSTREAM-SECRET-DETAIL");
    expect(catalog.rowCount).toBeNull();
    backend.state.failWith = null;
    clock.now += PRODUCT_RETRY_BACKOFF_MS; // 退避期間過了才會再試
    expect(Object.keys((await catalog.lookup(["1801112756"])).products)).toEqual(["1801112756"]);
  });

  it("退避：目錄過期＋上游失敗，之後 10 秒內完全不打上游、立刻用舊資料回答；滿 10 秒才再試；恢復後載入新資料", async () => {
    const backend = makeBackend();
    const clock = { now: 1_000_000 };
    const { catalog } = makeCatalog(backend, clock);
    await catalog.lookup(["1801112756"]);
    expect(backend.reloads()).toBe(1);
    backend.state.failWith = 500;
    clock.now += PRODUCT_CACHE_TTL_MS;
    expect(Object.keys((await catalog.lookup(["1801112756"])).products)).toEqual(["1801112756"]);
    expect(backend.reloads()).toBe(2); // 失敗的那一次
    const callsAfterFailure = backend.calls.length;
    for (const step of [1, 5_000, PRODUCT_RETRY_BACKOFF_MS - 1]) {
      clock.now = 1_000_000 + PRODUCT_CACHE_TTL_MS + step;
      const result = await catalog.lookup(["1801112756", "9999999999"]); // 含查無的編號也不重抓
      expect(Object.keys(result.products)).toEqual(["1801112756"]);
      expect(backend.calls.length).toBe(callsAfterFailure);
    }
    clock.now = 1_000_000 + PRODUCT_CACHE_TTL_MS + PRODUCT_RETRY_BACKOFF_MS;
    await catalog.lookup(["1801112756"]);
    expect(backend.reloads()).toBe(3); // 滿 10 秒再試一次（仍失敗）
    backend.state.failWith = null;
    backend.state.master.rows.push(masterRow("2000000002", "恢復後的新品", "女", "紅", "S"));
    clock.now += PRODUCT_RETRY_BACKOFF_MS;
    const recovered = await catalog.lookup(["2000000002"]);
    expect(recovered.products["2000000002"]!.productName).toBe("恢復後的新品");
    expect(PRODUCT_RETRY_BACKOFF_MS).toBe(10_000);
  });

  it("退避：完全沒資料＋上游失敗，第一次 502；10 秒內再查立刻 502 且不打上游；滿 10 秒再試", async () => {
    const backend = makeBackend();
    backend.state.failWith = 500;
    const clock = { now: 1_000_000 };
    const { catalog } = makeCatalog(backend, clock);
    await expect(catalog.lookup(["1"])).rejects.toMatchObject({ status: 502 });
    const calls = backend.calls.length;
    clock.now += PRODUCT_RETRY_BACKOFF_MS - 1;
    await expect(catalog.lookup(["1"])).rejects.toMatchObject({ status: 502, message: "商品總表暫時無法讀取，請稍後再試" });
    expect(backend.calls.length).toBe(calls);
    clock.now += 1;
    await expect(catalog.lookup(["1"])).rejects.toMatchObject({ status: 502 });
    expect(backend.calls.length).toBeGreaterThan(calls); // 滿 10 秒才再試
  });

  it("退避：沒資料時表頭錯誤在退避期間重丟同一個 500（指出分頁與欄名），不打上游", async () => {
    const backend = makeBackend({ master: new FakeSheet(MASTER_HEADER.filter((h) => h !== "性別"), []) });
    const clock = { now: 1_000_000 };
    const { catalog } = makeCatalog(backend, clock);
    await expect(catalog.lookup(["1"])).rejects.toMatchObject({ status: 500 });
    const calls = backend.calls.length;
    clock.now += 1_000;
    await expect(catalog.lookup(["1"])).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/「商品總表」.*性別/) });
    expect(backend.calls.length).toBe(calls);
  });

  it("退避不影響進行中的重抓：失敗之前同時進來的查詢仍共用同一次重抓", async () => {
    const backend = makeBackend();
    backend.state.failWith = 500;
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => catalog.lookup(["1"])));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(backend.calls.filter((c) => c.url.startsWith(BASE))).toHaveLength(1);
  });

  it("連線被拒（fetch 丟例外）也是 502 固定短句", async () => {
    const log = createCapturingLogger();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === GOOGLE_TOKEN_URL) return jsonResponse({ access_token: TEST_ACCESS_TOKEN, expires_in: 3599 });
      throw new Error("ECONNRESET secret-host.internal");
    }) as unknown as typeof fetch;
    const catalog = new ProductCatalog({
      tokenProvider: new GoogleTokenProvider({ client_email: creds.email, private_key: creds.privateKeyPem }, { fetchImpl, log }),
      spreadsheetId: PRODUCT_SHEET_ID,
      masterSheetName: "商品總表",
      cloudSheetName: "雲端總表",
      fetchImpl,
      log,
    });
    await expect(catalog.lookup(["1"])).rejects.toMatchObject({ status: 502, message: "商品總表暫時無法讀取，請稍後再試" });
  });

  it("Google 回 401：換 token 重送一次就成功", async () => {
    const backend = makeBackend();
    backend.state.tokenFailures401 = 1;
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    expect(Object.keys((await catalog.lookup(["1801112756"])).products)).toEqual(["1801112756"]);
    expect(backend.calls.filter((c) => c.url === GOOGLE_TOKEN_URL)).toHaveLength(2);
  });

  it("warm()：成功就載入；失敗只寫 warn、不丟例外", async () => {
    const backend = makeBackend();
    const ok = makeCatalog(backend, { now: 1_000_000 });
    await ok.catalog.warm();
    expect(ok.catalog.rowCount).toBe(4);

    const failing = makeBackend();
    failing.state.failWith = 500;
    const bad = makeCatalog(failing, { now: 1_000_000 });
    await expect(bad.catalog.warm()).resolves.toBeUndefined();
    expect(bad.catalog.rowCount).toBeNull();
    expect(bad.log.warns.join("\n")).toContain("預先載入商品總表失敗");
  });

  it("沒有 setInterval／setTimeout 之類的常駐計時器（查詢前後都沒有排程）", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const backend = makeBackend();
    const { catalog } = makeCatalog(backend, { now: 1_000_000 });
    await catalog.lookup(["1801112756"]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// POST /api/products/lookup（路由）
// ---------------------------------------------------------------------------

function makeApp(options: { env?: Record<string, string>; backend?: ReturnType<typeof makeBackend>; now?: () => number; warm?: boolean; store?: AuthFixture["store"] } = {}) {
  const backend = options.backend ?? makeBackend();
  const log = createCapturingLogger();
  const app = createApp({
    env: loadEnv({ OPENAI_API_KEY: "test-openai-key-123", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: creds.base64, ...options.env }),
    indexHtml: INDEX_HTML,
    log,
    sleep: async () => undefined,
    now: options.now,
    fetchImpl: backend.mock,
    settings: options.store ?? auth.store,
    ...(options.warm ? { warmProductCatalog: true } : {}),
  });
  return { app, backend, log };
}

const lookup = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = auth.headers) =>
  app.request("/api/products/lookup", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/products/lookup", () => {
  it("已登入＋XHR 標頭：回 200，products 與 missing 符合契約", async () => {
    const { app } = makeApp();
    const res = await lookup(app, { barcodes: ["1801112756", "9999999999"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: {
        products: {
          "1801112756": { productName: "第五代溫灸刷毛圓領發熱衣", gender: "男", color: "陶玫粉", size: "2XL", officialName: "第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)" },
        },
        missing: ["9999999999"],
      },
    });
  });

  it("重複與前後空白的編號先去重、trim；一般使用者與管理員都可以用", async () => {
    const { app } = makeApp();
    const body = (await (await lookup(app, { barcodes: [" 1801112756", "1801112756 ", "1801112756"] })).json()) as { data: { products: Record<string, unknown>; missing: string[] } };
    expect(Object.keys(body.data.products)).toEqual(["1801112756"]);
    const admin = await createAuthFixture({ role: "admin", email: "boss@example.test" });
    const { app: adminApp } = makeApp({ store: admin.store });
    expect((await lookup(adminApp, { barcodes: ["1801112756"] }, admin.headers)).status).toBe(200);
  });

  it("沒登入 401、已登入但缺 XHR 標頭 403（都不呼叫 Google）", async () => {
    const { app, backend } = makeApp();
    const anon = await lookup(app, { barcodes: ["1"] }, {});
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ success: false, error: "請先登入" });
    expect((await lookup(app, { barcodes: ["1"] }, { cookie: auth.cookie })).status).toBe(403);
    expect(backend.calls).toHaveLength(0);
  });

  it("資料目錄不可用 503", async () => {
    const ctx = await makeSettingsApp({ store: "unavailable" });
    const res = await ctx.app.request("/api/products/lookup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
      body: JSON.stringify({ barcodes: ["1"] }),
    });
    expect(res.status).toBe(503);
  });

  it.each(["GET", "PUT", "DELETE", "PATCH"])("%s → 405（帶 Allow: POST）", async (method) => {
    const { app } = makeApp();
    const res = await app.request("/api/products/lookup", { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it.each([
    ["不是物件（陣列）", "[]"],
    ["不是 JSON", "not json"],
    ["沒有 barcodes", "{}"],
    ["barcodes 不是陣列", '{"barcodes":"1801112756"}'],
    ["空陣列", '{"barcodes":[]}'],
    ["201 個", JSON.stringify({ barcodes: Array.from({ length: 201 }, (_, i) => String(i + 1)) })],
    ["元素是數字", '{"barcodes":[1801112756]}'],
    ["trim 後空字串", '{"barcodes":["   "]}'],
    ["超過 64 字", JSON.stringify({ barcodes: ["9".repeat(65)] })],
  ])("輸入格式錯誤 400：%s（不呼叫 Google）", async (_name, body) => {
    const { app, backend } = makeApp();
    const res = await lookup(app, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { success: boolean }).success).toBe(false);
    expect(backend.calls).toHaveLength(0);
  });

  it("200 個編號（上限）可以查", async () => {
    const { app } = makeApp();
    const res = await lookup(app, { barcodes: Array.from({ length: 200 }, (_, i) => String(3000000000 + i)) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { missing: string[] } }).data.missing).toHaveLength(200);
  });

  it("沒有服務帳號憑證：503「伺服器尚未完成商品總表設定」", async () => {
    const { app, backend } = makeApp({ env: { GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "" } });
    const res = await lookup(app, { barcodes: ["1801112756"] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: "伺服器尚未完成商品總表設定" });
    expect(backend.calls).toHaveLength(0);
  });

  it("讀總表失敗而且沒有快取：502 固定短句，回應與 log 都不含上游內容", async () => {
    const backend = makeBackend();
    backend.state.failWith = 500;
    const { app, log } = makeApp({ backend });
    const res = await lookup(app, { barcodes: ["1801112756"] });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: "商品總表暫時無法讀取，請稍後再試" });
    expect(log.lines.join("\n")).not.toContain("UPSTREAM-SECRET-DETAIL");
  });

  it("表頭缺欄：500 並指出分頁與欄名", async () => {
    const backend = makeBackend({ master: new FakeSheet(MASTER_HEADER.filter((h) => h !== "性別"), []) });
    const { app } = makeApp({ backend });
    const res = await lookup(app, { barcodes: ["1801112756"] });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/「商品總表」.*性別/);
  });

  it("使用環境變數指定的試算表 ID 與分頁名稱", async () => {
    const backend = makeBackend();
    const { app } = makeApp({ backend, env: { PRODUCT_SHEET_ID: "other-sheet-id" } });
    const res = await lookup(app, { barcodes: ["1801112756"] });
    expect(res.status).toBe(502); // 假伺服器只認預設的試算表 ID
    expect(backend.mock.mock.calls.some((c) => String(c[0]).includes("/spreadsheets/other-sheet-id/"))).toBe(true);
  });
});

describe("限流：自己的額度，不消耗 OCR 的", () => {
  it("第 121 次回 429（含 Retry-After）；打滿之後 /api/ocr 仍然不是 429；不同 IP 不受影響", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    const ip = (a: string) => ({ ...auth.headers, "x-forwarded-for": a });
    for (let i = 0; i < PRODUCT_LOOKUP_RATE_LIMIT_MAX; i++) {
      const res = await lookup(app, {}, ip("203.0.113.50"));
      if (res.status !== 400) throw new Error(`第 ${i + 1} 次預期通過限流（被輸入驗證擋成 400），實際 ${res.status}`);
    }
    const limited = await lookup(app, {}, ip("203.0.113.50"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(PRODUCT_LOOKUP_RATE_LIMIT_MAX).toBe(120);

    const ocr = await app.request("/api/ocr", { method: "POST", headers: { "content-type": "application/json", ...ip("203.0.113.50") }, body: "{}" });
    expect(ocr.status).toBe(400); // 缺 image：通過限流到達處理器
    expect((await lookup(app, {}, ip("203.0.113.51"))).status).toBe(400);
  });

  it("反過來：OCR 打滿也不影響商品查詢", async () => {
    const { app } = makeApp({ now: () => 1_000_000 });
    const headers = { ...auth.headers, "x-forwarded-for": "203.0.113.60" };
    for (let i = 0; i < OCR_RATE_LIMIT_MAX + 1; i++) {
      await app.request("/api/ocr", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    }
    expect((await lookup(app, {}, headers)).status).toBe(400);
  });
});

describe("/healthz 與背景預先載入", () => {
  const health = async (app: ReturnType<typeof createApp>) => (await (await app.request("/healthz")).json()) as Record<string, unknown>;

  it("沒有憑證：productsConfigured false、productCatalogRows null", async () => {
    const { app } = makeApp({ env: { GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "" } });
    expect(await health(app)).toMatchObject({ productsConfigured: false, productCatalogRows: null });
  });

  it("有憑證但還沒載入：true／null，而且打 /healthz 不會對 Google 發出任何請求；查詢成功後變成數字", async () => {
    const { app, backend } = makeApp();
    expect(await health(app)).toMatchObject({ productsConfigured: true, productCatalogRows: null });
    expect(await health(app)).toMatchObject({ productCatalogRows: null });
    expect(backend.calls).toHaveLength(0);
    await lookup(app, { barcodes: ["1801112756"] });
    const after = await health(app);
    expect(after.productCatalogRows).toBe(4);
    expect(typeof after.productCatalogRows).toBe("number");
    const text = JSON.stringify(after);
    expect(text).not.toContain("溫灸");
    expect(text).not.toContain(PRODUCT_SHEET_ID);
  });

  it("warmProductCatalog：建立 app 後在背景載入一次；/healthz 之後看得到筆數", async () => {
    const { app, backend } = makeApp({ warm: true });
    await vi.waitFor(async () => expect((await health(app)).productCatalogRows).toBe(4));
    expect(backend.reloads()).toBe(1);
  });

  it("warmProductCatalog 但讀取失敗：只寫 warn，服務照常、沒有未處理的 rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const backend = makeBackend();
      backend.state.failWith = 403;
      const { app, log } = makeApp({ backend, warm: true });
      await vi.waitFor(() => expect(log.warns.join("\n")).toContain("預先載入商品總表失敗"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(await health(app)).toMatchObject({ ok: true, productsConfigured: true, productCatalogRows: null });
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("沒有憑證時 warmProductCatalog 不會發出任何請求", async () => {
    const { backend } = makeApp({ env: { GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "" }, warm: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(backend.calls).toHaveLength(0);
  });

  it("預設（不給旗標）不會預先載入", async () => {
    const { backend } = makeApp();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(backend.calls).toHaveLength(0);
  });
});
