import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../src/common.js";
import { GoogleTokenProvider, parseServiceAccountCredentials } from "../src/google-auth.js";
import {
  APPEND_MAX_PENDING,
  APPEND_WINDOW_MAX,
  APPEND_WINDOW_MS,
  buildMergedName,
  buildSaveRow,
  HEADER_CACHE_MS,
  mapRowToHeader,
  parseSaveInput,
  quoteSheetName,
  SAVE_COLUMNS,
  SheetsClient,
  toSheetCell,
  type SaveRow,
  type SheetsClientOptions,
} from "../src/sheets.js";
import {
  createCapturingLogger,
  createGoogleMock,
  FULL_HEADER,
  GOOGLE_TOKEN_URL,
  jsonResponse,
  makeCredentials,
  SHEETS_BASE,
  TEST_ACCESS_TOKEN,
} from "./helpers.js";

const creds = makeCredentials();

describe("buildMergedName（合併品名三種分支，逐字照抄 n8n「整理欄位」）", () => {
  it("有性別：品名(性別-顏色尺寸)", () => {
    expect(buildMergedName("第五代溫灸刷毛V領發熱衣", "男", "純淨白", "S")).toBe("第五代溫灸刷毛V領發熱衣(男-純淨白S)");
    expect(buildMergedName("搖粒絨極暖衝鋒褲", "中性", "星夜黑", "L")).toBe("搖粒絨極暖衝鋒褲(中性-星夜黑L)");
  });

  it("沒有性別：品名(顏色尺寸)", () => {
    expect(buildMergedName("素面防曬排汗短版涼感衣", "", "戀愛粉", "XL")).toBe("素面防曬排汗短版涼感衣(戀愛粉XL)");
    expect(buildMergedName("A", "", "藍", "")).toBe("A(藍)");
    expect(buildMergedName("A", "", "", "M")).toBe("A(M)");
  });

  it("性別、顏色、尺寸都沒有：只有品名", () => {
    expect(buildMergedName("商品A", "", "", "")).toBe("商品A");
  });

  it("沒有品名：空字串（不管其他欄位）", () => {
    expect(buildMergedName("", "男", "藍", "M")).toBe("");
  });

  it("與 n8n 相同的邊角行為：有性別但顏色尺寸皆空 → 品名(男-)", () => {
    expect(buildMergedName("商品A", "男", "", "")).toBe("商品A(男-)");
  });
});

describe("parseSaveInput／buildSaveRow（對應 n8n「整理欄位」）", () => {
  const full = {
    seqNo: "1",
    date: "2026/03/24",
    boxId: "BOX-001",
    barcode: "18011220102",
    productName: "第五代溫灸刷毛V領發熱衣",
    gender: "男",
    color: "純淨白",
    size: "S",
    quantity: 2,
    time: "2026-03-24 17:16:53",
  };

  it("輸出 11 欄，欄名與順序固定", () => {
    expect([...SAVE_COLUMNS]).toEqual(FULL_HEADER);
    const row = buildSaveRow(parseSaveInput(full));
    expect(Object.keys(row)).toEqual(FULL_HEADER);
    expect(row).toEqual({
      序號: "1",
      日期: "2026/03/24",
      箱號: "BOX-001",
      商品編號: "18011220102",
      品名: "第五代溫灸刷毛V領發熱衣",
      性別: "男",
      顏色: "純淨白",
      尺寸: "S",
      合併品名: "第五代溫灸刷毛V領發熱衣(男-純淨白S)",
      數量: "2",
      辨識時間: "2026-03-24 17:16:53",
    });
  });

  it("quantity 缺少（或為 0）預設 1；其他缺少的欄位是空字串", () => {
    const row = buildSaveRow(parseSaveInput({ barcode: "123" }));
    expect(row.數量).toBe("1");
    expect(row.序號).toBe("");
    expect(row.品名).toBe("");
    expect(row.合併品名).toBe("");
    expect(buildSaveRow(parseSaveInput({ barcode: "123", quantity: 0 })).數量).toBe("1");
    expect(buildSaveRow(parseSaveInput({ barcode: "123", quantity: "3" })).數量).toBe("3");
  });

  it("數字型欄位（例如 seqNo: 5）轉成字串", () => {
    expect(buildSaveRow(parseSaveInput({ barcode: 123, seqNo: 5 })).商品編號).toBe("123");
    expect(buildSaveRow(parseSaveInput({ barcode: 123, seqNo: 5 })).序號).toBe("5");
  });

  it.each([
    ["不是物件", "字串"],
    ["陣列", []],
    ["null", null],
    ["欄位是物件", { barcode: "1", productName: { x: 1 } }],
    ["欄位是 true", { barcode: "1", color: true }],
    ["quantity 是物件", { barcode: "1", quantity: {} }],
    ["欄位過長", { barcode: "1", productName: "字".repeat(1001) }],
    ["全空的紀錄", {}],
    ["只有數量沒有商品", { quantity: 3, boxId: "BOX-1" }],
  ])("格式不正確回 400：%s", (_name, body) => {
    expect(() => parseSaveInput(body)).toThrowError(expect.objectContaining({ status: 400 }));
  });
});

describe("mapRowToHeader（依表頭名稱對應欄位）", () => {
  const row: SaveRow = {
    序號: "1",
    日期: "2026/03/24",
    箱號: "BOX-001",
    商品編號: "18011220102",
    品名: "品名X",
    性別: "男",
    顏色: "藍",
    尺寸: "M",
    合併品名: "品名X(男-藍M)",
    數量: "2",
    辨識時間: "2026-03-24 17:16:53",
  };

  it("表頭順序與預設相同", () => {
    expect(mapRowToHeader(FULL_HEADER, row)).toEqual({
      ok: true,
      values: ["1", "2026/03/24", "BOX-001", "18011220102", "品名X", "男", "藍", "M", "品名X(男-藍M)", "2", "2026-03-24 17:16:53"],
    });
  });

  it("表頭順序被打亂時，值仍放在正確的欄位", () => {
    const shuffled = ["辨識時間", "數量", "合併品名", "尺寸", "顏色", "性別", "品名", "商品編號", "箱號", "日期", "序號"];
    const result = mapRowToHeader(shuffled, row);
    expect(result).toEqual({
      ok: true,
      values: ["2026-03-24 17:16:53", "2", "品名X(男-藍M)", "M", "藍", "男", "品名X", "18011220102", "BOX-001", "2026/03/24", "1"],
    });
  });

  it("表頭多出來的欄位（含中間夾的空白欄）留空，其餘位置不受影響", () => {
    const withExtras = ["序號", "備註", "日期", "", "箱號", "商品編號", "品名", "性別", "顏色", "尺寸", "合併品名", "數量", "辨識時間", "審核"];
    const result = mapRowToHeader(withExtras, row);
    expect(result).toEqual({
      ok: true,
      values: ["1", "", "2026/03/24", "", "BOX-001", "18011220102", "品名X", "男", "藍", "M", "品名X(男-藍M)", "2", "2026-03-24 17:16:53", ""],
    });
  });

  it("表頭欄名前後的空白會被忽略", () => {
    const padded = FULL_HEADER.map((name) => ` ${name} `);
    expect(mapRowToHeader(padded, row)).toMatchObject({ ok: true });
  });

  it("表頭缺任何必要欄：回 ok:false 並列出缺哪些（不猜位置）", () => {
    const missingTwo = FULL_HEADER.filter((name) => name !== "數量" && name !== "合併品名");
    expect(mapRowToHeader(missingTwo, row)).toEqual({ ok: false, missing: ["合併品名", "數量"] });
    // 舊版範本 CSV 的 9 欄表頭
    expect(mapRowToHeader(["序號", "日期", "箱號", "商品編號", "品名", "性別", "顏色", "尺寸", "辨識時間"], row)).toEqual({
      ok: false,
      missing: ["合併品名", "數量"],
    });
    expect(mapRowToHeader([], row)).toEqual({ ok: false, missing: [...SAVE_COLUMNS] });
  });
});

describe("toSheetCell／quoteSheetName", () => {
  it("以 = + - @ 開頭的文字前面加單引號，避免被當公式", () => {
    expect(toSheetCell("=IMPORTDATA(\"https://example.test\")")).toBe("'=IMPORTDATA(\"https://example.test\")");
    expect(toSheetCell("+cmd")).toBe("'+cmd");
    expect(toSheetCell("-cmd")).toBe("'-cmd");
    expect(toSheetCell("@SUM(1)")).toBe("'@SUM(1)");
  });

  it("以 Tab 或 CR 開頭的文字也加單引號", () => {
    expect(toSheetCell("\t=1+1")).toBe("'\t=1+1");
    expect(toSheetCell("\rabc")).toBe("'\rabc");
  });

  it("一般文字與純數字（含負數、小數）不變", () => {
    for (const same of ["", "品名", "18011220102", "2", "-1", "1.5", "2026/03/24", "2026-03-24 17:16:53", "男-藍M"]) {
      expect(toSheetCell(same)).toBe(same);
    }
  });

  it("分頁名稱用單引號包起來，名稱內的單引號重複兩次", () => {
    expect(quoteSheetName("商品主檔")).toBe("'商品主檔'");
    expect(quoteSheetName("Bob's sheet")).toBe("'Bob''s sheet'");
  });
});

describe("SheetsClient（Google Sheets REST：讀表頭＋append）", () => {
  const row = buildSaveRow(
    parseSaveInput({
      seqNo: "1",
      date: "2026/10/05",
      boxId: "BOX-001",
      barcode: "1801080204",
      productName: "第五代溫灸刷毛圓領發熱衣",
      gender: "女",
      color: "經典黑",
      size: "L",
      quantity: 2,
      time: "2026-10-05 10:00:00",
    }),
  );

  function setup(options: Parameters<typeof createGoogleMock>[0] = {}, clockStart = 1_000_000) {
    const google = createGoogleMock(options);
    const log = createCapturingLogger();
    let clock = clockStart;
    const now = () => clock;
    const tokenProvider = new GoogleTokenProvider(parseServiceAccountCredentials(creds.base64)!, {
      fetchImpl: google.mock,
      log,
      now,
    });
    const client = new SheetsClient({
      tokenProvider,
      spreadsheetId: "1Wql_6lg_PQ1TT2xOF_5tv2AwA8Wy-PUWfeRPaVV-B_A",
      sheetName: "商品主檔",
      fetchImpl: google.mock,
      log,
      now,
    });
    return { client, calls: google.calls, log, advance: (ms: number) => void (clock += ms) };
  }

  const sheetCalls = (calls: ReturnType<typeof setup>["calls"]) => calls.filter((c) => c.url.startsWith(SHEETS_BASE));

  it("先讀表頭 '商品主檔'!1:1，再 append 到 '商品主檔'!A1（USER_ENTERED、INSERT_ROWS）", async () => {
    const { client, calls } = setup();
    const result = await client.appendRow(row);
    expect(result).toEqual({ updatedRange: "'商品主檔'!A125:K125" });

    const [token, headerGet, append, ...rest] = calls;
    expect(rest).toHaveLength(0);
    expect(token!.url).toBe(GOOGLE_TOKEN_URL);

    expect(headerGet!.method).toBe("GET");
    expect(decodeURIComponent(headerGet!.url)).toBe(`${SHEETS_BASE}/values/'商品主檔'!1:1`);
    expect(headerGet!.headers.authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);

    expect(append!.method).toBe("POST");
    expect(decodeURIComponent(append!.url)).toBe(
      `${SHEETS_BASE}/values/'商品主檔'!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    );
    expect(append!.headers.authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(append!.headers["content-type"]).toBe("application/json");
    expect(append!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(append!.body!)).toEqual({
      majorDimension: "ROWS",
      values: [["1", "2026/10/05", "BOX-001", "1801080204", "第五代溫灸刷毛圓領發熱衣", "女", "經典黑", "L", "第五代溫灸刷毛圓領發熱衣(女-經典黑L)", "2", "2026-10-05 10:00:00"]],
    });
  });

  it("表頭順序不同時，append 的值依表頭排列；多出的欄留空", async () => {
    const header = ["辨識時間", "備註", "數量", "合併品名", "尺寸", "顏色", "性別", "品名", "商品編號", "箱號", "日期", "序號"];
    const { client, calls } = setup({ header });
    await client.appendRow(row);
    const append = calls.find((c) => c.method === "POST" && c.url.includes(":append"))!;
    expect(JSON.parse(append.body!).values).toEqual([
      ["2026-10-05 10:00:00", "", "2", "第五代溫灸刷毛圓領發熱衣(女-經典黑L)", "L", "經典黑", "女", "第五代溫灸刷毛圓領發熱衣", "1801080204", "BOX-001", "2026/10/05", "1"],
    ]);
  });

  it("表頭缺欄位：丟 500 並說明缺哪欄，絕不呼叫 append", async () => {
    const { client, calls } = setup({ header: FULL_HEADER.filter((name) => name !== "數量") });
    const error = (await client.appendRow(row).catch((e: unknown) => e)) as ServiceError;
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.status).toBe(500);
    expect(error.message).toContain("數量");
    expect(error.message).toContain("商品主檔");
    expect(calls.some((c) => c.url.includes(":append"))).toBe(false);
  });

  it("表頭整列是空的：500，列出全部必要欄", async () => {
    const { client } = setup({ header: null });
    const error = (await client.appendRow(row).catch((e: unknown) => e)) as ServiceError;
    expect(error.status).toBe(500);
    for (const column of SAVE_COLUMNS) expect(error.message).toContain(column);
  });

  it("表頭讀取結果快取 5 分鐘：期間內只讀一次，過期後重新讀", async () => {
    const { client, calls, advance } = setup();
    await client.appendRow(row);
    await client.appendRow(row);
    expect(sheetCalls(calls).filter((c) => c.method === "GET")).toHaveLength(1);

    advance(HEADER_CACHE_MS - 1000);
    await client.appendRow(row);
    expect(sheetCalls(calls).filter((c) => c.method === "GET")).toHaveLength(1);

    advance(2000); // 超過 5 分鐘
    await client.appendRow(row);
    expect(sheetCalls(calls).filter((c) => c.method === "GET")).toHaveLength(2);
    expect(sheetCalls(calls).filter((c) => c.method === "POST")).toHaveLength(4);
    expect(HEADER_CACHE_MS).toBe(5 * 60 * 1000);
  });

  it("同時多筆寫入只讀一次表頭", async () => {
    const { client, calls } = setup();
    await Promise.all([client.appendRow(row), client.appendRow(row), client.appendRow(row)]);
    expect(sheetCalls(calls).filter((c) => c.method === "GET")).toHaveLength(1);
    expect(sheetCalls(calls).filter((c) => c.method === "POST")).toHaveLength(3);
  });

  it("因表頭缺欄失敗後會清掉快取：修好表頭後下一筆立刻生效", async () => {
    let header: string[] = FULL_HEADER.filter((name) => name !== "數量");
    const google = createGoogleMock();
    // 以可變的表頭覆寫 GET 回應
    const calls = google.calls;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? "GET") === "GET" && url.startsWith(`${SHEETS_BASE}/values/`)) {
        calls.push({ url, method: "GET", headers: {}, body: undefined, signal: undefined });
        return new Response(JSON.stringify({ values: [header] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return google.mock(input, init);
    };
    const log = createCapturingLogger();
    const tokenProvider = new GoogleTokenProvider(parseServiceAccountCredentials(creds.json)!, { fetchImpl, log });
    const client = new SheetsClient({ tokenProvider, spreadsheetId: "1Wql_6lg_PQ1TT2xOF_5tv2AwA8Wy-PUWfeRPaVV-B_A", sheetName: "商品主檔", fetchImpl, log });

    await expect(client.appendRow(row)).rejects.toMatchObject({ status: 500 });
    header = FULL_HEADER; // 使用者補上欄位
    await expect(client.appendRow(row)).resolves.toEqual({ updatedRange: "'商品主檔'!A125:K125" });
  });

  it("append 回應沒有 updates.updatedRange：回傳空物件", async () => {
    const { client } = setup({ updatedRange: null });
    await expect(client.appendRow(row)).resolves.toEqual({});
  });

  it("寫入前對公式字元做防護（USER_ENTERED 會執行 = 開頭的內容）", async () => {
    const { client, calls } = setup();
    await client.appendRow(buildSaveRow(parseSaveInput({ barcode: "1", productName: "=HYPERLINK(\"http://example.test\")", quantity: -1 })));
    const append = calls.find((c) => c.url.includes(":append"))!;
    const values = JSON.parse(append.body!).values[0] as string[];
    expect(values[4]).toBe("'=HYPERLINK(\"http://example.test\")");
    expect(values[9]).toBe("-1"); // 純數字不加引號
  });

  it("append 回 401：換新 token 後重送一次", async () => {
    let appendCalls = 0;
    const google = createGoogleMock();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(":append") && ++appendCalls === 1) {
        return new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED" } }), { status: 401 });
      }
      return google.mock(input, init);
    };
    const log = createCapturingLogger();
    const tokenProvider = new GoogleTokenProvider(parseServiceAccountCredentials(creds.json)!, { fetchImpl, log });
    const client = new SheetsClient({ tokenProvider, spreadsheetId: "1Wql_6lg_PQ1TT2xOF_5tv2AwA8Wy-PUWfeRPaVV-B_A", sheetName: "商品主檔", fetchImpl, log });

    await expect(client.appendRow(row)).resolves.toEqual({ updatedRange: "'商品主檔'!A125:K125" });
    expect(appendCalls).toBe(2);
    expect(google.calls.filter((c) => c.url === GOOGLE_TOKEN_URL)).toHaveLength(2); // 401 之後重新換了 token
  });

  it("append 回 5xx：丟 502，且不自動重試（避免重複寫入）", async () => {
    const { client, calls } = setup({ appendStatus: 503 });
    await expect(client.appendRow(row)).rejects.toMatchObject({ status: 502 });
    expect(calls.filter((c) => c.url.includes(":append"))).toHaveLength(1);
  });

  it("append 連線失敗或逾時：丟 502，且不自動重試", async () => {
    const google = createGoogleMock();
    let appendCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(":append")) {
        appendCalls++;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return google.mock(input, init);
    };
    const log = createCapturingLogger();
    const tokenProvider = new GoogleTokenProvider(parseServiceAccountCredentials(creds.json)!, { fetchImpl, log });
    const client = new SheetsClient({ tokenProvider, spreadsheetId: "1Wql_6lg_PQ1TT2xOF_5tv2AwA8Wy-PUWfeRPaVV-B_A", sheetName: "商品主檔", fetchImpl, log });
    await expect(client.appendRow(row)).rejects.toMatchObject({ status: 502 });
    expect(appendCalls).toBe(1);
  });

  it("讀表頭與 append 的 timeout 都是 20 秒", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const { client } = setup();
      await client.appendRow(row);
      // token（15 秒）→ 讀表頭（20 秒）→ append（20 秒）
      expect(timeoutSpy.mock.calls).toEqual([[15_000], [20_000], [20_000]]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("log：讀表頭失敗會記 Google 的錯誤訊息；append 失敗只記 status，不記可能回顯欄位值的 message", async () => {
    const header = setup({ headerStatus: 400 });
    await header.client.appendRow(row).catch(() => undefined);
    expect(header.log.lines.join("\n")).toContain("HTTP 400 STUB stub error");

    const append = setup({ appendStatus: 400 });
    await append.client.appendRow(row).catch(() => undefined);
    const appendLog = append.log.lines.join("\n");
    expect(appendLog).toContain("HTTP 400 STUB");
    expect(appendLog).not.toContain("stub error");
  });

  it.each([
    [403, 500, "分享給服務帳號"],
    [404, 500, "找不到指定的試算表"],
    [400, 500, "商品主檔"],
    [429, 502, "暫時繁忙"],
  ])("讀表頭時 Google 回 %i：轉成 %i 並給可讀訊息", async (googleStatus, ourStatus, hint) => {
    const { client, log } = setup({ headerStatus: googleStatus });
    const error = (await client.appendRow(row).catch((e: unknown) => e)) as ServiceError;
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.status).toBe(ourStatus);
    expect(error.message).toContain(hint);
    expect(error.message).not.toContain("stub error"); // 不轉發上游訊息
    expect(log.lines.join("\n")).toContain(`HTTP ${googleStatus}`);
  });
});


describe("SheetsClient：append 滾動視窗配額（過去 60 秒內最多起始 55 次，達到上限才先進先出排隊）", () => {
  const SPREADSHEET_ID = "1Wql_6lg_PQ1TT2xOF_5tv2AwA8Wy-PUWfeRPaVV-B_A";
  const rowOf = (seqNo: string) =>
    buildSaveRow(parseSaveInput({ seqNo, barcode: "1801080204", productName: "第五代溫灸刷毛圓領發熱衣", quantity: 1 }));
  const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const seqs = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
  const ok = { updatedRange: "'商品主檔'!A125:K125" };

  /**
   * 假時鐘：預設的 sleep 先讓出一個 macrotask（讓「現在就能起始」的請求把 fetch 都呼叫完），再讓假時鐘前進 ms，不真的等待。
   * sentAt 記錄每個 append／讀表頭請求「fetch 被呼叫時」的假時鐘。
   * tokenStatuses 可依序指定每一次換 token 的狀態碼（預設全部成功）。
   */
  function setupPaced(
    options: {
      google?: Parameters<typeof createGoogleMock>[0];
      client?: Partial<SheetsClientOptions>;
      tokenStatuses?: number[];
      /** 前 N 次 append 直接丟網路錯誤（模擬連線失敗／逾時）。 */
      appendThrows?: number;
      /** 覆寫假 sleep（拿到 ms 與讓假時鐘前進的函式）。 */
      sleep?: (ms: number, advance: (ms: number) => void) => Promise<void>;
    } = {},
  ) {
    const google = createGoogleMock(options.google);
    const log = createCapturingLogger();
    let clock = 5_000_000;
    const advance = (ms: number) => void (clock += ms);
    const sleeps: number[] = [];
    const sentAt = { append: [] as number[], header: [] as number[] };
    let tokenCalls = 0;
    let appendCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = urlOf(input);
      if (url === GOOGLE_TOKEN_URL) {
        const status = options.tokenStatuses?.[tokenCalls++];
        if (status && status !== 200) return jsonResponse({ error: "invalid_grant" }, status);
      } else if (url.includes(":append")) {
        sentAt.append.push(clock);
        if (++appendCalls <= (options.appendThrows ?? 0)) throw new TypeError("fetch failed");
      } else if ((init?.method ?? "GET").toUpperCase() === "GET") {
        sentAt.header.push(clock);
      }
      return google.mock(input, init);
    };
    const now = () => clock;
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      if (options.sleep) return options.sleep(ms, advance);
      await new Promise<void>((resolve) => setImmediate(resolve));
      advance(ms);
    };
    const tokenProvider = new GoogleTokenProvider(parseServiceAccountCredentials(creds.base64)!, { fetchImpl, log, now });
    const client = new SheetsClient({
      tokenProvider,
      spreadsheetId: SPREADSHEET_ID,
      sheetName: "商品主檔",
      fetchImpl,
      log,
      now,
      sleep,
      ...options.client,
    });
    /** 依 fetch 被呼叫的順序，列出各筆 append 的序號欄（表頭預設順序，序號是第 1 欄）。 */
    const appendOrder = () =>
      google.calls.filter((c) => c.url.includes(":append")).map((c) => (JSON.parse(c.body!) as { values: string[][] }).values[0]![0]!);
    return { client, google, log, sleeps, sentAt, now, tokenProvider, advance, appendOrder };
  }

  it("預設值：過去 60 秒內最多起始 55 次（Google 寫入配額每分鐘 60 次，留 5 次餘裕）", () => {
    expect(APPEND_WINDOW_MAX).toBe(55);
    expect(APPEND_WINDOW_MS).toBe(60_000);
    expect(APPEND_MAX_PENDING).toBe(50);
  });

  it("55 筆同時送出：全部立即起始（0 等待、不呼叫 sleep），依先進先出順序", async () => {
    const { client, sleeps, sentAt, now, appendOrder } = setupPaced();
    const t0 = now();
    const results = await Promise.all(seqs(55).map((n) => client.appendRow(rowOf(n))));

    expect(results).toEqual(Array(55).fill(ok));
    expect(sleeps).toEqual([]); // 沒有任何人為的等待
    expect(sentAt.append).toEqual(Array(55).fill(t0)); // 55 筆全都在同一時刻起始
    expect(appendOrder()).toEqual(seqs(55));
  });

  it("第 56 筆起要排隊：等到「第 1 筆起始時間＋60 秒」才送；依先進先出順序", async () => {
    const { client, sleeps, sentAt, now, appendOrder } = setupPaced();
    const t0 = now();
    const results = await Promise.all(seqs(60).map((n) => client.appendRow(rowOf(n))));

    expect(results).toEqual(Array(60).fill(ok));
    expect(sentAt.append).toEqual([...Array(55).fill(t0), ...Array(5).fill(t0 + 60_000)]);
    expect(sleeps).toEqual([60_000]); // 只有排在最前面的那個需要睡；視窗放行後其餘 4 筆立刻跟上
    expect(appendOrder()).toEqual(seqs(60));
  });

  it("是滾動視窗，不是整點分段：超過 55 件之後，每放行一筆只等下一個最舊的起始離開視窗", async () => {
    const { client, sleeps, sentAt, advance, now } = setupPaced();
    const t0 = now();
    for (let i = 0; i < 55; i++) {
      await client.appendRow(rowOf(String(i + 1))); // 起始時間 t0、t0+100、…、t0+5400
      advance(100);
    }
    expect(sleeps).toEqual([]); // 55 筆以內全速
    // 現在 t0+5500，視窗已滿：第 56 筆等最舊的（t0）離開視窗，也就是 t0+60000
    await client.appendRow(rowOf("56"));
    // 第 57、58 筆：下一個最舊的是 t0+100、t0+200，所以各自只需要再等 100 ms
    await client.appendRow(rowOf("57"));
    await client.appendRow(rowOf("58"));

    expect(sleeps).toEqual([54_500, 100, 100]);
    expect(sentAt.append.slice(55)).toEqual([t0 + 60_000, t0 + 60_100, t0 + 60_200]);
  });

  it("視窗過後配額恢復：差 1 ms 還要再等 1 ms，過完整個視窗後整批 55 筆又可以全速起始", async () => {
    const { client, sleeps, sentAt, advance, now } = setupPaced();
    const t0 = now();
    await Promise.all(seqs(55).map((n) => client.appendRow(rowOf(n)))); // 用完配額，全部起始於 t0

    advance(APPEND_WINDOW_MS - 1); // 差 1 ms：最舊的那批還在視窗內
    await client.appendRow(rowOf("56"));
    expect(sleeps).toEqual([1]);
    expect(sentAt.append[55]).toBe(t0 + 60_000);

    advance(APPEND_WINDOW_MS); // 視窗完全過去：配額全部恢復
    const t1 = now();
    await Promise.all(seqs(55).map((n) => client.appendRow(rowOf(n))));
    expect(sleeps).toEqual([1]); // 沒有新的等待
    expect(sentAt.append.slice(56)).toEqual(Array(55).fill(t1));
  });

  it("單筆不等待（再晚一點才來的單筆也一樣）", async () => {
    const { client, sleeps, sentAt, advance, now } = setupPaced();
    const t0 = now();
    await client.appendRow(rowOf("1"));
    expect(sleeps).toEqual([]);
    expect(sentAt.append).toEqual([t0]);

    advance(86_400_000);
    await client.appendRow(rowOf("2"));
    expect(sleeps).toEqual([]);
    expect(sentAt.append).toEqual([t0, t0 + 86_400_000]);
  });

  it("送出前就失敗（換不到 token）不佔配額：後面的不必為它多等", async () => {
    // token 呼叫順序：[1] 暖機那筆（成功）、[2] 第 1 筆（400 失敗）、[3] 之後（成功）
    const { client, sentAt, sleeps, advance, now, tokenProvider } = setupPaced({
      tokenStatuses: [200, 400, 200],
      client: { appendWindowMax: 3 },
    });
    const t0 = now();
    await client.appendRow(rowOf("0")); // 暖機：換 token、快取表頭（用掉 1 個名額）
    tokenProvider.invalidate(); // 讓接下來的 append 都要重新換 token
    advance(APPEND_WINDOW_MS); // 暖機那筆離開視窗，配額全空

    await expect(client.appendRow(rowOf("1"))).rejects.toMatchObject({ status: 500 }); // 換不到 token：沒有送出
    // 若上面那筆佔了名額，這三筆裡的第 3 筆就得等一個視窗
    const rest = await Promise.all(["2", "3", "4"].map((n) => client.appendRow(rowOf(n))));
    expect(rest).toEqual(Array(3).fill(ok));
    expect(sleeps).toEqual([]);
    expect(sentAt.append).toEqual([t0, ...Array(3).fill(t0 + 60_000)]); // 失敗的那筆沒有送出任何 append
  });

  it("已經送出但失敗（Google 回 500）的那次照樣佔配額；它也不會卡住後面的", async () => {
    const { client, sentAt, sleeps, now } = setupPaced({ google: { appendStatuses: [500] }, client: { appendWindowMax: 2 } });
    const t0 = now();
    const results = await Promise.allSettled(["1", "2", "3"].map((n) => client.appendRow(rowOf(n))));

    expect(results[0]).toMatchObject({ status: "rejected", reason: { status: 502 } });
    expect(results[1]).toEqual({ status: "fulfilled", value: ok });
    expect(results[2]).toEqual({ status: "fulfilled", value: ok }); // 排隊的第 3 筆照常送出
    expect(sentAt.append).toEqual([t0, t0, t0 + 60_000]); // 失敗的那次確實送出了，所以第 3 筆要等視窗讓出名額
    expect(sleeps).toEqual([60_000]);
  });

  it("排隊中的請求在等待時出錯（例如 sleep 丟例外）：它會歸還排隊名額，後面排隊的照常取得名額", async () => {
    let sleepCalls = 0;
    const { client, sentAt, now } = setupPaced({
      client: { appendWindowMax: 1, appendMaxPending: 2 },
      sleep: async (ms, advance) => {
        if (++sleepCalls === 1) throw new Error("sleep 壞了");
        advance(ms);
      },
    });
    const t0 = now();
    const results = await Promise.allSettled(["1", "2", "3"].map((n) => client.appendRow(rowOf(n))));

    expect(results[0]).toEqual({ status: "fulfilled", value: ok }); // 第 1 筆立刻起始
    expect(results[1]).toMatchObject({ status: "rejected", reason: { message: "sleep 壞了" } }); // 排在最前面的等待時出錯
    expect(results[2]).toEqual({ status: "fulfilled", value: ok }); // 它後面的照常
    expect(sentAt.append).toEqual([t0, t0 + 60_000]);
    // 名額有歸還：視窗仍滿著時，兩個排隊名額（appendMaxPending=2）都還能用，第 3 筆才回 503
    const next = await Promise.allSettled(["4", "5", "6"].map((n) => client.appendRow(rowOf(n))));
    expect(next.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((next[2] as PromiseRejectedResult).reason).toMatchObject({ status: 503 });
  });

  it("排隊上限：排隊等名額的請求超過 appendMaxPending 立刻回 503，不影響已排隊的；佇列清空後恢復", async () => {
    const { client, sentAt, sleeps, now, log } = setupPaced({ client: { appendWindowMax: 1, appendMaxPending: 2 } });
    const t0 = now();
    const results = await Promise.allSettled(["1", "2", "3", "4"].map((n) => client.appendRow(rowOf(n))));

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected"]);
    expect(results[3]).toMatchObject({ reason: { status: 503, message: "目前等待寫入的筆數過多，請稍後再試" } });
    expect(sentAt.append).toEqual([t0, t0 + 60_000, t0 + 120_000]); // 第 1 筆立刻，排隊的兩筆各等一個視窗
    expect(sleeps).toEqual([60_000, 60_000]);
    expect(log.lines.join("\n")).toContain("append 佇列已滿（2/2）");

    await expect(client.appendRow(rowOf("5"))).resolves.toEqual(ok); // 恢復
  });

  // 回歸測試：排隊名額一定要歸還；否則連續失敗幾次後，/api/save 會一直回 503 直到重啟。
  it.each([
    ["Google 回 500", { google: { appendStatuses: [500, 500] } }],
    ["Google 回 429", { google: { appendStatuses: [429, 429] } }],
    ["連線失敗或逾時", { appendThrows: 2 }],
    ["401 連續兩次（首次與重送都失敗）", { google: { appendStatuses: [401, 401, 401, 401] } }],
  ])("失敗之後會歸還排隊名額：%s（視窗只有 1 個名額、排隊上限 3）", async (_name, scenario) => {
    const { client } = setupPaced({ ...scenario, client: { appendWindowMax: 1, appendMaxPending: 3 } });

    const failed = await Promise.allSettled([client.appendRow(rowOf("1")), client.appendRow(rowOf("2"))]);
    expect(failed.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    for (const result of failed) expect((result as PromiseRejectedResult).reason.status).not.toBe(503); // 是上游失敗，不是佇列已滿

    // 視窗仍滿著：四筆同時進來，剛好三筆排得進去（排隊上限 3），第 4 筆回 503。若名額沒歸還，能排進去的會少於 3 筆。
    const next = await Promise.allSettled(["3", "4", "5", "6"].map((n) => client.appendRow(rowOf(n))));
    expect(next.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected"]);
    expect((next[3] as PromiseRejectedResult).reason).toMatchObject({ status: 503 });
  });

  it("401 之後的重送算一次新的起始：同樣受視窗限制（視窗已滿就等）", async () => {
    // 視窗只有 1 個名額：首次送出（401）用掉它，重送必須等一個視窗
    const { client, sentAt, sleeps, now } = setupPaced({ google: { appendStatuses: [401] }, client: { appendWindowMax: 1 } });
    const t0 = now();
    await expect(client.appendRow(rowOf("1"))).resolves.toEqual(ok);
    expect(sentAt.append).toEqual([t0, t0 + 60_000]);
    expect(sleeps).toEqual([60_000]);
  });

  it("401 連續兩次（重送也失敗）：回 500，且不卡住後面的", async () => {
    const { client, sentAt } = setupPaced({ google: { appendStatuses: [401, 401] } });
    await expect(client.appendRow(rowOf("1"))).rejects.toMatchObject({ status: 500 }); // 首次與重送都是 401
    await expect(client.appendRow(rowOf("2"))).resolves.toEqual(ok);
    expect(sentAt.append).toHaveLength(3); // 第 1 筆送了 2 次（首次＋重送），第 2 筆 1 次
  });

  it("讀表頭不受視窗限制：append 正在排隊等名額時，別的請求的表頭讀取會立刻送出", async () => {
    const google = createGoogleMock();
    const log = createCapturingLogger();
    let clock = 5_000_000;
    const gates: Array<() => void> = []; // 每個 sleep 都停在這裡，由測試手動放行
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        gates.push(() => {
          clock += ms;
          resolve();
        });
      });
    const now = () => clock;
    const headerReads = () => google.calls.filter((c) => c.method === "GET" && c.url.startsWith(SHEETS_BASE)).length;
    const appends = () => google.calls.filter((c) => c.url.includes(":append")).length;
    const tokenProvider = new GoogleTokenProvider(parseServiceAccountCredentials(creds.base64)!, { fetchImpl: google.mock, log, now });
    const client = new SheetsClient({
      tokenProvider,
      spreadsheetId: SPREADSHEET_ID,
      sheetName: "商品主檔",
      fetchImpl: google.mock,
      log,
      now,
      sleep,
      headerTtlMs: 0, // 表頭不快取：每次 appendRow 都重新讀一次
      appendWindowMax: 1, // 視窗只有 1 個名額，第 2 筆起都要排隊
    });

    const a = client.appendRow(rowOf("1"));
    await vi.waitFor(() => expect(appends()).toBe(1)); // A 立刻起始
    const b = client.appendRow(rowOf("2"));
    await vi.waitFor(() => expect(gates).toHaveLength(1)); // B 讀完表頭，視窗已滿，正在等名額
    expect(headerReads()).toBe(2);
    expect(appends()).toBe(1);

    const c = client.appendRow(rowOf("3")); // B 還在等的時候，C 的表頭讀取不該被擋住
    await vi.waitFor(() => expect(headerReads()).toBe(3));
    expect(appends()).toBe(1);

    gates.shift()!(); // 放行 B
    await b;
    await vi.waitFor(() => expect(gates).toHaveLength(1)); // 接著 C 排隊等名額
    gates.shift()!();
    await Promise.all([a, c]);
    expect(appends()).toBe(3);
  });

  it("先進先出：有人在排隊時，新來的不會插隊——即使此刻視窗剛好有名額", async () => {
    const google = createGoogleMock();
    const log = createCapturingLogger();
    let clock = 5_000_000;
    const gates: Array<() => void> = []; // 每個 sleep 都停在這裡，由測試手動放行
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        gates.push(() => {
          clock += ms;
          resolve();
        });
      });
    const now = () => clock;
    const appends = () => google.calls.filter((c) => c.url.includes(":append")).length;
    const order = () => google.calls.filter((c) => c.url.includes(":append")).map((c) => (JSON.parse(c.body!) as { values: string[][] }).values[0]![0]);
    const tokenProvider = new GoogleTokenProvider(parseServiceAccountCredentials(creds.base64)!, { fetchImpl: google.mock, log, now });
    const client = new SheetsClient({
      tokenProvider,
      spreadsheetId: SPREADSHEET_ID,
      sheetName: "商品主檔",
      fetchImpl: google.mock,
      log,
      now,
      sleep,
      appendWindowMax: 1,
    });

    const a = client.appendRow(rowOf("A"));
    await vi.waitFor(() => expect(appends()).toBe(1)); // A 立刻起始，視窗滿了
    const b = client.appendRow(rowOf("B"));
    await vi.waitFor(() => expect(gates).toHaveLength(1)); // B 排隊，正在等 A 離開視窗

    clock += APPEND_WINDOW_MS; // 時間過去一個視窗：此刻視窗其實已經有名額了，但 B 還沒被放行（它的等待還沒醒來）
    const c = client.appendRow(rowOf("C")); // 這時新來的 C 必須排在 B 後面，不能插隊
    await new Promise<void>((resolve) => setTimeout(resolve, 20)); // 給 C 足夠的時間（若它會插隊，早就送出了）
    expect(appends()).toBe(1);

    gates.shift()!(); // 放行 B
    await b;
    await vi.waitFor(() => expect(gates).toHaveLength(1)); // C 輪到後發現視窗又滿了（B 剛起始），排隊等 B 離開視窗
    gates.shift()!();
    await Promise.all([a, c]);
    expect(order()).toEqual(["A", "B", "C"]);
  });

  it("appendWindowMax／appendWindowMs 可由建構參數覆寫；appendWindowMax 小於 1 時當作 1", async () => {
    const custom = setupPaced({ client: { appendWindowMax: 2, appendWindowMs: 1000 } });
    const t0 = custom.now();
    await Promise.all(seqs(3).map((n) => custom.client.appendRow(rowOf(n))));
    expect(custom.sleeps).toEqual([1000]);
    expect(custom.sentAt.append).toEqual([t0, t0, t0 + 1000]);

    // appendWindowMax 0 當作 1：第 1 筆走快速路徑（視窗至少有 1 個名額），即使完全不允許排隊（appendMaxPending=0）也不會被擋
    const strict = setupPaced({ client: { appendWindowMax: 0, appendMaxPending: 0 } });
    await expect(strict.client.appendRow(rowOf("1"))).resolves.toEqual(ok);
    expect(strict.sleeps).toEqual([]);

    const zero = setupPaced({ client: { appendWindowMax: 0 } }); // 第 2 筆要等一個視窗，不會因此永遠排不到名額
    await Promise.all([zero.client.appendRow(rowOf("1")), zero.client.appendRow(rowOf("2"))]);
    expect(zero.sleeps).toEqual([60_000]);
  });

  it("系統時鐘被往回調時，視窗最多多滿一個視窗長度（不會因此卡很久）", async () => {
    const { client, sleeps, sentAt, advance, now } = setupPaced({ client: { appendWindowMax: 1 } });
    const t0 = now();
    await client.appendRow(rowOf("1"));
    advance(-3_600_000); // 時鐘往回調 1 小時
    await client.appendRow(rowOf("2"));
    expect(sleeps).toEqual([60_000]); // 不是 3_660_000
    expect(sentAt.append).toEqual([t0, t0 - 3_600_000 + 60_000]);
  });

  it("不注入 now／sleep（正式環境的預設值）：視窗配額同樣有效（以 vitest 假計時器驗證，不真的等待）", async () => {
    vi.useFakeTimers();
    try {
      const google = createGoogleMock();
      const log = createCapturingLogger();
      const sentAt: number[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        if (urlOf(input).includes(":append")) sentAt.push(Date.now());
        return google.mock(input, init);
      };
      const tokenProvider = new GoogleTokenProvider(parseServiceAccountCredentials(creds.base64)!, { fetchImpl, log });
      const client = new SheetsClient({ tokenProvider, spreadsheetId: SPREADSHEET_ID, sheetName: "商品主檔", fetchImpl, log }); // 沒給 now／sleep
      const t0 = Date.now();
      const all = Promise.all(seqs(56).map((n) => client.appendRow(rowOf(n))));
      await vi.advanceTimersByTimeAsync(60_000);
      await all;
      expect(sentAt).toEqual([...Array(55).fill(t0), t0 + 60_000]);
    } finally {
      vi.useRealTimers();
    }
  });
});
