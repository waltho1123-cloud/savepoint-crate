import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../src/common.js";
import { GoogleTokenProvider, parseServiceAccountCredentials } from "../src/google-auth.js";
import {
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
} from "../src/sheets.js";
import {
  createCapturingLogger,
  createGoogleMock,
  FULL_HEADER,
  GOOGLE_TOKEN_URL,
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
