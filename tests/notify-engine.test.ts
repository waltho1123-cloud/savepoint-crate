import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { createCapturingLogger, createFetchMock, jsonResponse, TEST_GROUP_ID, TEST_LINE_TOKEN } from "./helpers.js";
import { cleanupTempDirs, createAuthFixture, type AuthFixture } from "./settings-helpers.js";

/**
 * index.html 裡的前端引擎（ApiClient、OCREngine、SaveEngine、NotifyEngine、UserBar）的測試。
 * 不需要瀏覽器：直接從 index.html 把那一段原始碼取出來，在 Node 裡執行（注入假的 fetch、showToast、console、location、document），
 * 測的就是實際會送到使用者手機上的那份程式碼。
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  expect(start, startMarker).toBeGreaterThan(-1);
  expect(end, endMarker).toBeGreaterThan(start);
  return html.slice(start, end);
}

interface NotifyEngineLike {
  NOTIFY_URL: string;
  boxClosed(box: unknown, saveResult: unknown): Promise<void>;
}

type FetchFn = (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<unknown>;

/** 假的瀏覽器環境：location（登入過期時被改寫 href）、document（UserBar 用）。 */
function fakeBrowser() {
  const location = { pathname: "/", href: "" };
  const elements: Record<string, { hidden: boolean; textContent: string; handlers: Record<string, () => void>; addEventListener(type: string, handler: () => void): void }> = {};
  const element = (id: string) =>
    (elements[id] ??= {
      hidden: true,
      textContent: "",
      handlers: {},
      addEventListener(type, handler) {
        this.handlers[type] = handler;
      },
    });
  const document = { getElementById: (id: string) => element(id) };
  return { location, document, element };
}

function loadNotifyEngine(fetchOverride?: FetchFn) {
  const fetchMock = vi.fn<FetchFn>();
  const showToast = vi.fn();
  const consoleMock = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
  const browser = fakeBrowser();
  const source = `${sliceBetween("// ========== ApiClient", "// ========== OCREngine")}\n${sliceBetween("// ========== NotifyEngine", "// ========== PrintManager")}`;
  const factory = new Function("fetch", "showToast", "console", "location", `${source}\nreturn NotifyEngine;`);
  const engine = factory(fetchOverride ?? fetchMock, showToast, consoleMock, browser.location) as NotifyEngineLike;
  return { engine, fetchMock, showToast, consoleMock, location: browser.location };
}

/** ApiClient 與三個引擎、CloseFlow、UserBar 一起載入（OCREngine、SaveEngine、NotifyEngine 都靠 ApiClient 送請求）。 */
function loadEngines() {
  const fetchMock = vi.fn<FetchFn>();
  const showToast = vi.fn();
  const consoleMock = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
  const browser = fakeBrowser();
  const source = `${sliceBetween("// ========== ApiClient", "// ========== PrintManager")}\n${sliceBetween("// ========== UserBar", "document.getElementById('userbar-logout')")}`;
  const factory = new Function(
    "fetch",
    "showToast",
    "console",
    "location",
    "document",
    `${source}\nreturn { ApiClient, OCREngine, SaveEngine, NotifyEngine, CloseFlow, UserBar };`,
  );
  const engines = factory(fetchMock, showToast, consoleMock, browser.location, browser.document) as {
    ApiClient: { expired: boolean; post(url: string, payload: unknown): Promise<unknown>; get(url: string): Promise<unknown> };
    OCREngine: { recognize(image: string, boxId?: string): Promise<unknown> };
    SaveEngine: { saveBoxItems(box: unknown): Promise<{ success: boolean; total?: number; successCount?: number; failCount?: number; results?: unknown[] }> };
    NotifyEngine: NotifyEngineLike;
    CloseFlow: { sessionAlive(): Promise<boolean>; sync(box: unknown): Promise<{ proceed: boolean; saveResult: { success?: boolean; total?: number; successCount?: number; failCount?: number } | null }> };
    UserBar: { init(): Promise<void>; logout(): Promise<void> };
  };
  return { ...engines, fetchMock, showToast, consoleMock, ...browser };
}

const scanned = (overrides: Record<string, unknown> = {}) => ({
  scanId: "uuid-1",
  barcode: "1801080204",
  productName: "第五代溫灸刷毛圓領發熱衣",
  gender: "女",
  color: "經典黑",
  size: "L",
  qty: 3,
  scannedAt: "2026-10-05T07:00:00.000Z",
  ...overrides,
});

const respond = (data: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(data) });

/** 取出送給 /api/box-closed 的請求 body。 */
function sentBody(fetchMock: ReturnType<typeof loadNotifyEngine>["fetchMock"]) {
  return JSON.parse(fetchMock.mock.calls[0]![1].body!) as Record<string, unknown>;
}

describe("NotifyEngine.boxClosed", () => {
  it("POST /api/box-closed：items 只帶 6 個欄位，total／successCount／failedCount 取自 saveBoxItems 的回傳（failCount → failedCount）", async () => {
    const { engine, fetchMock, showToast } = loadNotifyEngine();
    fetchMock.mockReturnValue(respond({ success: true, notified: true }));
    const box = { id: "BOX-001", status: "open", items: [scanned(), scanned({ barcode: "999", productName: "B", gender: "", color: "", size: "", qty: 2 })] };
    await engine.boxClosed(box, { success: false, total: 2, successCount: 1, failCount: 1, results: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/box-closed");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" }); // CSRF 標頭
    const body = sentBody(fetchMock);
    expect(Object.keys(body).sort()).toEqual(["boxId", "closedAt", "failedCount", "items", "successCount", "total"]);
    expect(body.boxId).toBe("BOX-001");
    expect(Number.isNaN(Date.parse(body.closedAt as string))).toBe(false); // ISO 時間
    expect(body.items).toEqual([
      { barcode: "1801080204", productName: "第五代溫灸刷毛圓領發熱衣", gender: "女", color: "經典黑", size: "L", qty: 3 },
      { barcode: "999", productName: "B", gender: "", color: "", size: "", qty: 2 },
    ]);
    expect([body.total, body.successCount, body.failedCount]).toEqual([2, 1, 1]);
    expect(showToast).not.toHaveBeenCalled(); // notified:true → 不提示
  });

  it("全部成功", async () => {
    const { engine, fetchMock } = loadNotifyEngine();
    fetchMock.mockReturnValue(respond({ success: true, notified: true }));
    await engine.boxClosed({ id: "BOX-002", items: [scanned()] }, { success: true, total: 1, successCount: 1, failCount: 0, results: [] });
    const body = sentBody(fetchMock);
    expect([body.total, body.successCount, body.failedCount]).toEqual([1, 1, 0]);
  });

  it("failedCount 取自 saveBoxItems 回傳的 failCount（有給就用它，不是自己用 total − successCount 算）", async () => {
    const { engine, fetchMock } = loadNotifyEngine();
    fetchMock.mockReturnValue(respond({ success: true, notified: true }));
    await engine.boxClosed({ id: "B", items: [scanned()] }, { total: 3, successCount: 1, failCount: 5 }); // 刻意不一致，才看得出讀的是哪個欄位
    expect(sentBody(fetchMock).failedCount).toBe(5);
  });

  it("saveBoxItems 丟了例外（saveResult 是 null）：仍然通知，成功筆數算 0、失敗筆數＝全部", async () => {
    const { engine, fetchMock } = loadNotifyEngine();
    fetchMock.mockReturnValue(respond({ success: true, notified: true }));
    await engine.boxClosed({ id: "BOX-003", items: [scanned(), scanned()] }, null);
    const body = sentBody(fetchMock);
    expect([body.total, body.successCount, body.failedCount]).toEqual([2, 0, 2]);
  });

  it("空箱子（沒有任何商品；saveBoxItems 回「無資料可儲存」）不通知：不呼叫後端、不提示、不寫 console", async () => {
    const { engine, fetchMock, showToast, consoleMock } = loadNotifyEngine();
    await engine.boxClosed({ id: "BOX-004", items: [] }, { success: false, error: "無資料可儲存" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(consoleMock.error).not.toHaveBeenCalled();
  });

  it("超過後端驗證上限的值先截斷，免得整則通知被 400 擋掉：數量 1～9999、文字 200 字、最多 500 筆", async () => {
    const { engine, fetchMock } = loadNotifyEngine();
    fetchMock.mockReturnValue(respond({ success: true, notified: true }));
    const long = "字".repeat(250);
    await engine.boxClosed(
      {
        id: "B",
        items: [
          scanned({ qty: 100000, barcode: long, productName: long, gender: long, color: long, size: long }),
          scanned({ qty: 0 }),
          scanned({ qty: -5 }),
          scanned({ qty: "7" }),
          scanned({ qty: "abc" }),
          scanned({ qty: 2.9 }),
          scanned({ qty: undefined }),
        ],
      },
      null,
    );
    const items = sentBody(fetchMock).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.qty)).toEqual([9999, 1, 1, 7, 1, 2, 1]);
    for (const key of ["barcode", "productName", "gender", "color", "size"]) expect(items[0]![key]).toBe("字".repeat(200));

    fetchMock.mockClear();
    await engine.boxClosed({ id: "B", items: Array.from({ length: 600 }, () => scanned()) }, null);
    expect((sentBody(fetchMock).items as unknown[]).length).toBe(500);
  });

  it("數字型的條碼等欄位轉成字串", async () => {
    const { engine, fetchMock } = loadNotifyEngine();
    fetchMock.mockReturnValue(respond({ success: true, notified: true }));
    await engine.boxClosed({ id: "B", items: [scanned({ barcode: 1801080204 })] }, null);
    expect((sentBody(fetchMock).items as Array<{ barcode: unknown }>)[0]!.barcode).toBe("1801080204");
  });

  it("缺少的欄位補預設：文字欄位空字串、qty 1", async () => {
    const { engine, fetchMock } = loadNotifyEngine();
    fetchMock.mockReturnValue(respond({ success: true, notified: true }));
    await engine.boxClosed({ id: "BOX-005", items: [{ barcode: "123" }] }, { total: 1, successCount: 1, failCount: 0 });
    expect(sentBody(fetchMock).items).toEqual([{ barcode: "123", productName: "", gender: "", color: "", size: "", qty: 1 }]);
  });

  it("notified:false 且 reason 是 push_failed：toast「LINE 通知失敗（不影響關箱）」", async () => {
    const { engine, fetchMock, showToast, consoleMock } = loadNotifyEngine();
    fetchMock.mockReturnValue(respond({ success: true, notified: false, reason: "push_failed", error: "LINE channel access token 無效或已過期" }));
    await engine.boxClosed({ id: "B", items: [scanned()] }, { total: 1, successCount: 1, failCount: 0 });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("LINE 通知失敗（不影響關箱）", "error");
    expect(consoleMock.error).not.toHaveBeenCalled();
  });

  it("not_configured：不提示、不寫 console", async () => {
    const { engine, fetchMock, showToast, consoleMock } = loadNotifyEngine();
    fetchMock.mockReturnValue(respond({ success: true, notified: false, reason: "not_configured" }));
    await engine.boxClosed({ id: "B", items: [scanned()] }, { total: 1, successCount: 1, failCount: 0 });
    expect(showToast).not.toHaveBeenCalled();
    expect(consoleMock.error).not.toHaveBeenCalled();
  });

  it("任何失敗都不丟例外、也不提示：網路錯誤、HTTP 錯誤、回應不是 JSON、box 資料壞掉——只寫 console.error", async () => {
    const cases: Array<[string, (f: ReturnType<typeof loadNotifyEngine>["fetchMock"]) => void, unknown]> = [
      ["網路錯誤", (f) => f.mockRejectedValue(new TypeError("Failed to fetch")), { id: "B", items: [scanned()] }],
      ["HTTP 400（輸入被伺服器拒絕）", (f) => f.mockReturnValue(respond({ success: false, error: "x" }, false, 400)), { id: "B", items: [scanned()] }],
      ["HTTP 500", (f) => f.mockReturnValue(respond({}, false, 500)), { id: "B", items: [scanned()] }],
      ["回應不是 JSON", (f) => f.mockReturnValue(Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("bad json")) })), { id: "B", items: [scanned()] }],
      ["box.items 不存在", (f) => f.mockReturnValue(respond({})), { id: "B" }],
      ["box 是 null", (f) => f.mockReturnValue(respond({})), null],
    ];
    for (const [, setup, box] of cases) {
      const { engine, fetchMock, showToast, consoleMock } = loadNotifyEngine();
      setup(fetchMock);
      await expect(engine.boxClosed(box, null)).resolves.toBeUndefined();
      expect(showToast).not.toHaveBeenCalled();
      expect(consoleMock.error).toHaveBeenCalledTimes(1);
    }
  });
});

describe("整合：NotifyEngine → 後端 /api/box-closed → LINE push（前端實際送出的內容要能通過後端驗證）", () => {
  // 全站登入之後，後端的 API 要登入：瀏覽器會自動帶登入 cookie，這裡在橋接 fetch 時補上。
  let auth: AuthFixture;
  beforeAll(async () => {
    auth = await createAuthFixture({ name: "王小明" });
  });
  afterAll(cleanupTempDirs);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 把 NotifyEngine 的 fetch 接到真的 createApp（in-process），app 對 LINE 的 fetch 另外 mock。 */
  function wire(lineHandler: Parameters<typeof createFetchMock>[0], lineEnv: Record<string, string> = { LINE_CHANNEL_ACCESS_TOKEN: TEST_LINE_TOKEN, LINE_GROUP_ID: TEST_GROUP_ID }) {
    const line = createFetchMock(lineHandler);
    vi.stubGlobal("fetch", line.mock);
    const app = createApp({
      env: loadEnv(lineEnv),
      indexHtml: "",
      log: createCapturingLogger(),
      now: () => Date.parse("2026-10-05T07:20:00.000Z"),
      settings: auth.store,
    });
    const loaded = loadNotifyEngine((url, init) =>
      Promise.resolve(app.request(url, { ...(init as RequestInit), headers: { ...init.headers, cookie: auth.cookie } })),
    );
    return { ...loaded, lineCalls: line.calls };
  }
  const lineText = (calls: Array<{ body?: string }>) => (JSON.parse(calls[0]!.body!) as { messages: Array<{ text: string }> }).messages[0]!.text;
  const box = { id: "BOX-001", status: "open", items: [scanned(), scanned({ scanId: "uuid-2", barcode: "1801472364", productName: "搖粒絨極暖衝鋒褲", gender: "", color: "星夜黑", size: "XL", qty: 2 })] };

  it("saveBoxItems 全部成功 → 「已同步 2/2 筆」，明細與件數正確", async () => {
    const { engine, lineCalls, showToast } = wire(() => jsonResponse({}));
    await engine.boxClosed(box, { success: true, total: 2, successCount: 2, failCount: 0, results: [] });
    expect(lineCalls).toHaveLength(1);
    const lines = lineText(lineCalls).split("\n");
    expect(lines.slice(0, 4)).toEqual(["📦 箱號 BOX-001 已完成", "共 2 種商品、5 件", "操作：王小明", "已同步 2/2 筆到商品主檔 ✓"]);
    expect(lines.slice(4, 7)).toEqual(["明細：", "1801080204 第五代溫灸刷毛圓領發熱衣(女-經典黑L) ×3", "1801472364 搖粒絨極暖衝鋒褲(星夜黑XL) ×2"]);
    expect(lines.at(-1)).toMatch(/^時間：\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/); // 前端送來的 closedAt（瀏覽器現在時間）轉成台北時間
    expect(showToast).not.toHaveBeenCalled();
  });

  it("saveBoxItems 部分失敗（failCount）→ 警告文案", async () => {
    const { engine, lineCalls } = wire(() => jsonResponse({}));
    await engine.boxClosed(box, { success: false, total: 2, successCount: 1, failCount: 1, results: [] });
    expect(lineText(lineCalls).split("\n")[3]).toBe("⚠️ 同步 1/2 筆，1 筆失敗，請查核商品主檔");
  });

  it("saveBoxItems 丟了例外（null）→ 「同步 0/2 筆，2 筆失敗」", async () => {
    const { engine, lineCalls } = wire(() => jsonResponse({}));
    await engine.boxClosed(box, null);
    expect(lineText(lineCalls).split("\n")[3]).toBe("⚠️ 同步 0/2 筆，2 筆失敗，請查核商品主檔");
  });

  it("空箱子：不通知（不呼叫 LINE）", async () => {
    const { engine, lineCalls, consoleMock } = wire(() => jsonResponse({}));
    await engine.boxClosed({ id: "BOX-009", items: [] }, { success: false, error: "無資料可儲存" });
    expect(lineCalls).toHaveLength(0);
    expect(consoleMock.error).not.toHaveBeenCalled();
  });

  it("超過上限的資料（數量 100000、文字 250 字）被截斷後仍能通過後端驗證、照常通知", async () => {
    const { engine, lineCalls, consoleMock } = wire(() => jsonResponse({}));
    await engine.boxClosed({ id: "BOX-010", items: [scanned({ qty: 100000, productName: "品".repeat(250) })] }, { total: 1, successCount: 1, failCount: 0 });
    expect(consoleMock.error).not.toHaveBeenCalled();
    expect(lineCalls).toHaveLength(1);
    expect(lineText(lineCalls)).toContain("×9999");
  });

  it("LINE 沒設定：後端回 not_configured，前端不提示、不呼叫 LINE", async () => {
    const { engine, lineCalls, showToast, consoleMock } = wire(() => jsonResponse({}), {});
    await engine.boxClosed(box, { success: true, total: 2, successCount: 2, failCount: 0 });
    expect(lineCalls).toHaveLength(0);
    expect(showToast).not.toHaveBeenCalled();
    expect(consoleMock.error).not.toHaveBeenCalled();
  });

  it("LINE 推播失敗：後端回 push_failed，前端跳「LINE 通知失敗（不影響關箱）」", async () => {
    const { engine, showToast } = wire(() => jsonResponse({ message: "x" }, 401));
    await engine.boxClosed(box, { success: true, total: 2, successCount: 2, failCount: 0 });
    expect(showToast).toHaveBeenCalledWith("LINE 通知失敗（不影響關箱）", "error");
  });
});

describe("index.html 關箱流程裡的呼叫", () => {
  const start = html.indexOf("document.getElementById('btn-close-box').addEventListener('click'");
  const end = html.indexOf("// Scanner (Camera)");
  const handler = html.slice(start, end);

  it("找得到關箱事件處理", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("同步交給 CloseFlow.sync；登入過期（proceed 為 false）就在通知與鎖箱之前 return；同步結果原樣交給關箱通知，只呼叫一次", () => {
    expect(handler).toContain("const outcome = await CloseFlow.sync(box);");
    expect(handler).toContain("if (!outcome.proceed) return;");
    expect(handler).toContain("NotifyEngine.boxClosed(box, outcome.saveResult);");
    expect(handler.match(/NotifyEngine\.boxClosed\(/g)).toHaveLength(1);
    expect(handler).not.toContain("SaveEngine.saveBoxItems"); // 不能繞過 CloseFlow 自己同步
    const syncAt = handler.indexOf("await CloseFlow.sync(box)");
    const returnAt = handler.indexOf("if (!outcome.proceed) return;");
    const notifyAt = handler.indexOf("NotifyEngine.boxClosed(box, outcome.saveResult);");
    const closeAt = handler.indexOf("BoxManager.closeBox(box.id);");
    expect(syncAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(syncAt);
    expect(notifyAt).toBeGreaterThan(returnAt);
    expect(closeAt).toBeGreaterThan(notifyAt);
  });

  it("通知不 await（不能因為 LINE 慢而拖住關箱）；相機照舊在同步之前停掉", () => {
    expect(handler).not.toMatch(/await\s+NotifyEngine/);
    expect(handler.indexOf("CameraEngine.stop(")).toBeGreaterThan(-1);
    expect(handler.indexOf("CameraEngine.stop(")).toBeLessThan(handler.indexOf("await CloseFlow.sync(box)"));
  });
});

describe("CloseFlow.sync：關箱前先確認登入、登入過期時整個中止（箱子保持開啟）", () => {
  const ok = (data: unknown = { success: true }) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  const failed = (code: number) => Promise.resolve({ ok: false, status: code, json: () => Promise.resolve({ success: false }) });
  const box = { id: "BOX-001", items: [scanned(), scanned({ barcode: "999" })] };
  type Engines = ReturnType<typeof loadEngines>;
  const requests = (fetchMock: Engines["fetchMock"]) => fetchMock.mock.calls.map(([url, init]) => `${init.method ?? "GET"} ${url}`);
  const toasts = (showToast: Engines["showToast"]) => showToast.mock.calls.map((call) => call[0] as string);

  it("一切正常：先 GET /api/me 確認登入（帶標頭），再逐筆 POST /api/save；proceed:true 並交回同步結果；提示「正在同步」「已同步 2 筆」", async () => {
    const { CloseFlow, fetchMock, showToast, location } = loadEngines();
    fetchMock.mockReturnValue(ok({ success: true }));
    const outcome = await CloseFlow.sync(box);
    expect(requests(fetchMock)).toEqual(["GET /api/me", "POST /api/save", "POST /api/save"]);
    expect(fetchMock.mock.calls[0]![1]).toEqual({ headers: { "X-Requested-With": "XMLHttpRequest" } });
    expect(outcome.proceed).toBe(true);
    expect(outcome.saveResult).toMatchObject({ success: true, total: 2, successCount: 2, failCount: 0 });
    expect(toasts(showToast)).toEqual(["正在同步到商品主檔…", "已同步 2 筆到商品主檔 ✓"]);
    expect(location.href).toBe("");
  });

  it("登入已經過期（/api/me 回 401）：什麼都不送（沒有任何 /api/save）、導向 /login?next=%2F、proceed:false；沒有任何「同步」「完成」的提示", async () => {
    const { CloseFlow, ApiClient, fetchMock, showToast, location } = loadEngines();
    fetchMock.mockReturnValue(failed(401));
    const outcome = await CloseFlow.sync(box);
    expect(requests(fetchMock)).toEqual(["GET /api/me"]);
    expect(location.href).toBe("/login?next=%2F");
    expect(ApiClient.expired).toBe(true);
    expect(outcome).toEqual({ proceed: false, saveResult: null });
    expect(showToast).not.toHaveBeenCalled();
  });

  it("同步途中登入過期（確認登入時還有效、第一筆 /api/save 就 401）：proceed:false、只送了一筆；不顯示「箱號仍會完成」", async () => {
    const { CloseFlow, fetchMock, showToast, location } = loadEngines();
    fetchMock.mockReturnValueOnce(ok({ success: true, data: {} })).mockReturnValue(failed(401));
    const outcome = await CloseFlow.sync(box);
    expect(requests(fetchMock)).toEqual(["GET /api/me", "POST /api/save"]);
    expect(location.href).toBe("/login?next=%2F");
    expect(outcome.proceed).toBe(false);
    expect(outcome.saveResult).toMatchObject({ success: false, successCount: 0, failCount: 1 });
    expect(toasts(showToast)).toEqual(["正在同步到商品主檔…"]); // 沒有「同步失敗，但箱號仍會完成」：箱子其實沒有完成
  });

  it("同步到一半才過期（前兩筆成功、第三筆 401）：proceed:false（箱子保持開啟），已成功的筆數照實交回", async () => {
    const { CloseFlow, fetchMock, showToast } = loadEngines();
    fetchMock.mockReturnValueOnce(ok({})).mockReturnValueOnce(ok({ success: true })).mockReturnValueOnce(ok({ success: true })).mockReturnValue(failed(401));
    const five = { id: "B", items: Array.from({ length: 5 }, (_, i) => scanned({ barcode: `B${i}` })) };
    const outcome = await CloseFlow.sync(five);
    expect(requests(fetchMock)).toEqual(["GET /api/me", "POST /api/save", "POST /api/save", "POST /api/save"]);
    expect(outcome.proceed).toBe(false);
    expect(outcome.saveResult).toMatchObject({ successCount: 2, failCount: 1, total: 3 });
    expect(toasts(showToast)).toEqual(["正在同步到商品主檔…"]);
  });

  it("網路斷線（/api/me 與 /api/save 都 fetch 失敗）不算登入過期：照原本的流程走，proceed:true、「同步失敗，但箱號仍會完成」", async () => {
    const { CloseFlow, fetchMock, showToast, location, consoleMock } = loadEngines();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const outcome = await CloseFlow.sync(box);
    expect(requests(fetchMock)).toEqual(["GET /api/me", "POST /api/save", "POST /api/save"]);
    expect(outcome.proceed).toBe(true);
    expect(outcome.saveResult).toMatchObject({ success: false, successCount: 0, failCount: 2 });
    expect(toasts(showToast)).toEqual(["正在同步到商品主檔…", "同步失敗，但箱號仍會完成"]);
    expect(location.href).toBe("");
    expect(consoleMock.error).toHaveBeenCalled(); // 確認登入失敗與逐筆同步失敗都有留 console 紀錄
  });

  it("/api/me 回 503（資料目錄不可用）也不算登入過期：照原本的流程走（同步失敗，箱號仍會完成）", async () => {
    const { CloseFlow, fetchMock, showToast, location } = loadEngines();
    fetchMock.mockReturnValue(failed(503));
    const outcome = await CloseFlow.sync(box);
    expect(outcome.proceed).toBe(true);
    expect(toasts(showToast)).toEqual(["正在同步到商品主檔…", "同步失敗，但箱號仍會完成"]);
    expect(location.href).toBe("");
  });

  it("部分失敗（一筆成功、一筆 500）：proceed:true、「部分同步：1/2 筆成功」", async () => {
    const { CloseFlow, fetchMock, showToast } = loadEngines();
    fetchMock.mockReturnValueOnce(ok({})).mockReturnValueOnce(ok({ success: true })).mockReturnValue(failed(500));
    const outcome = await CloseFlow.sync(box);
    expect(outcome.proceed).toBe(true);
    expect(outcome.saveResult).toMatchObject({ successCount: 1, failCount: 1, total: 2 });
    expect(toasts(showToast)).toEqual(["正在同步到商品主檔…", "部分同步：1/2 筆成功"]);
  });

  it("空箱子：只確認登入、沒有 /api/save；proceed:true、「同步失敗，但箱號仍會完成」（沿用原本的提示）", async () => {
    const { CloseFlow, fetchMock, showToast } = loadEngines();
    fetchMock.mockReturnValue(ok({}));
    const outcome = await CloseFlow.sync({ id: "EMPTY", items: [] });
    expect(requests(fetchMock)).toEqual(["GET /api/me"]);
    expect(outcome.proceed).toBe(true);
    expect(outcome.saveResult).toMatchObject({ success: false });
    expect(toasts(showToast)).toEqual(["正在同步到商品主檔…", "同步失敗，但箱號仍會完成"]);
  });

  it("saveBoxItems 本身丟例外：proceed:true、saveResult 是 null（關箱通知用）、提示「同步發生錯誤：boom」", async () => {
    const { CloseFlow, fetchMock, showToast, consoleMock } = loadEngines();
    fetchMock.mockReturnValue(ok({}));
    const broken = {
      id: "B",
      get items(): never {
        throw new Error("boom");
      },
    };
    const outcome = await CloseFlow.sync(broken);
    expect(outcome).toEqual({ proceed: true, saveResult: null });
    expect(toasts(showToast)).toEqual(["正在同步到商品主檔…", "同步發生錯誤：boom"]);
    expect(consoleMock.error).toHaveBeenCalledWith("Save failed:", expect.any(Error));
  });

  it("sessionAlive：200 → true；401 → false（並導向登入頁）；網路錯誤、500 → true", async () => {
    const a = loadEngines();
    a.fetchMock.mockReturnValue(ok({}));
    expect(await a.CloseFlow.sessionAlive()).toBe(true);
    const b = loadEngines();
    b.fetchMock.mockReturnValue(failed(401));
    expect(await b.CloseFlow.sessionAlive()).toBe(false);
    expect(b.location.href).toBe("/login?next=%2F");
    const c = loadEngines();
    c.fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await c.CloseFlow.sessionAlive()).toBe(true);
    const d = loadEngines();
    d.fetchMock.mockReturnValue(failed(500));
    expect(await d.CloseFlow.sessionAlive()).toBe(true);
  });
});

describe("ApiClient：所有 /api 請求共用（帶 CSRF 標頭、登入過期導回登入頁）", () => {
  const ok = (data: unknown = { success: true }) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  const status = (code: number) => Promise.resolve({ ok: false, status: code, json: () => Promise.resolve({ success: false }) });

  it("post：POST、JSON 內容、Content-Type 與 X-Requested-With 標頭；get：只帶 X-Requested-With", async () => {
    const { ApiClient, fetchMock } = loadEngines();
    fetchMock.mockReturnValue(ok());
    await ApiClient.post("/api/x", { a: 1 });
    await ApiClient.get("/api/me");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/x");
    expect(fetchMock.mock.calls[0]![1]).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/me");
    expect(fetchMock.mock.calls[1]![1]).toEqual({ headers: { "X-Requested-With": "XMLHttpRequest" } });
  });

  it("回應 401：location.href 設成 /login?next=<目前路徑，編碼>（登入後回到這一頁），並記下 expired；回應照常交還給呼叫端", async () => {
    const { ApiClient, fetchMock, location } = loadEngines();
    location.pathname = "/index.html";
    fetchMock.mockReturnValue(status(401));
    const resp = (await ApiClient.post("/api/x", {})) as { status: number };
    expect(resp.status).toBe(401);
    expect(location.href).toBe("/login?next=%2Findex.html");
    expect(ApiClient.expired).toBe(true);
  });

  it("其他狀態（200、400、403、429、500、503）和網路錯誤都不導向登入頁", async () => {
    const { ApiClient, fetchMock, location } = loadEngines();
    for (const code of [200, 400, 403, 429, 500, 503]) {
      fetchMock.mockReturnValue(code === 200 ? ok() : status(code));
      await ApiClient.post("/api/x", {});
    }
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(ApiClient.post("/api/x", {})).rejects.toThrow("Failed to fetch");
    expect(location.href).toBe("");
    expect(ApiClient.expired).toBe(false);
  });
});

describe("OCREngine／SaveEngine／NotifyEngine 都經過 ApiClient：帶 X-Requested-With、401 導向登入頁", () => {
  const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  const unauthorized = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ success: false, error: "請先登入" }) });
  const box = { id: "BOX-001", items: [scanned(), scanned({ barcode: "999" }), scanned({ barcode: "888" })] };

  it("OCREngine.recognize：POST /api/ocr 帶標頭與內容；成功回 data", async () => {
    const { OCREngine, fetchMock } = loadEngines();
    fetchMock.mockReturnValue(ok({ success: true, data: { barcode: "1801080204" } }));
    expect(await OCREngine.recognize("data:image/jpeg;base64,AAAA", "BOX-001")).toEqual({ barcode: "1801080204" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/ocr");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" });
    expect(JSON.parse(init.body!)).toEqual({ barcode: "", boxId: "BOX-001", image: "data:image/jpeg;base64,AAAA" });
  });

  it("OCREngine.recognize：401 → 導向 /login?next=%2F，回 null（不丟例外）", async () => {
    const { OCREngine, fetchMock, location, consoleMock } = loadEngines();
    fetchMock.mockReturnValue(unauthorized());
    expect(await OCREngine.recognize("data:image/jpeg;base64,AAAA", "B")).toBeNull();
    expect(location.href).toBe("/login?next=%2F");
    expect(consoleMock.error).toHaveBeenCalledTimes(1);
  });

  it("SaveEngine.saveBoxItems：逐筆 POST /api/save，每一筆都帶標頭", async () => {
    const { SaveEngine, fetchMock } = loadEngines();
    fetchMock.mockReturnValue(ok({ success: true }));
    const result = await SaveEngine.saveBoxItems(box);
    expect(result).toMatchObject({ success: true, total: 3, successCount: 3, failCount: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("/api/save");
      expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" });
    }
  });

  it("SaveEngine.saveBoxItems：登入過期（第一筆就 401）→ 導向登入頁，並且停止，不再對後面每一筆重複送；回傳失敗", async () => {
    const { SaveEngine, fetchMock, location } = loadEngines();
    fetchMock.mockReturnValue(unauthorized());
    const result = await SaveEngine.saveBoxItems(box);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(location.href).toBe("/login?next=%2F");
    expect(result.success).toBe(false);
    expect(result.failCount).toBe(1);
  });

  it("SaveEngine.saveBoxItems：中途 401（前兩筆成功）→ 第三筆失敗後停止，已成功的筆數照實回報", async () => {
    const { SaveEngine, fetchMock, location } = loadEngines();
    fetchMock.mockReturnValueOnce(ok({ success: true })).mockReturnValueOnce(ok({ success: true })).mockReturnValue(unauthorized());
    const result = await SaveEngine.saveBoxItems({ id: "B", items: Array.from({ length: 5 }, (_, i) => scanned({ barcode: `B${i}` })) });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(location.href).toBe("/login?next=%2F");
    expect(result).toMatchObject({ success: false, successCount: 2, failCount: 1, total: 3 });
  });

  it("SaveEngine.saveBoxItems：一般失敗（500）不導向登入頁、照樣逐筆送完", async () => {
    const { SaveEngine, fetchMock, location } = loadEngines();
    fetchMock.mockReturnValue(Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    const result = await SaveEngine.saveBoxItems(box);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ success: false, failCount: 3 });
    expect(location.href).toBe("");
  });

  it("NotifyEngine.boxClosed：401 → 導向登入頁；不丟例外、不跳 LINE 失敗的提示", async () => {
    const { NotifyEngine, fetchMock, location, showToast } = loadEngines();
    fetchMock.mockReturnValue(unauthorized());
    await expect(NotifyEngine.boxClosed(box, null)).resolves.toBeUndefined();
    expect(location.href).toBe("/login?next=%2F");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("index.html 裡所有打後端的 fetch 都只有 ApiClient 一個出口（引擎不再自己 fetch）", () => {
    expect(html.match(/\bfetch\(/g)).toHaveLength(1);
    const apiClient = sliceBetween("// ========== ApiClient", "// ========== OCREngine");
    expect(apiClient).toContain("await fetch(url, init)");
    for (const section of [sliceBetween("// ========== OCREngine", "// ========== SaveEngine"), sliceBetween("// ========== SaveEngine", "// ========== NotifyEngine"), sliceBetween("// ========== NotifyEngine", "// ========== CloseFlow")]) {
      expect(section).not.toMatch(/\bfetch\(/);
      expect(section).toContain("ApiClient.post(");
    }
    const closeFlow = sliceBetween("// ========== CloseFlow", "// ========== PrintManager");
    expect(closeFlow).not.toMatch(/\bfetch\(/);
    expect(closeFlow).toContain("ApiClient.get('/api/me')");
  });
});

describe("UserBar：頂端使用者列", () => {
  const meResponse = (me: Record<string, unknown>) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: me }) });

  it("載入時呼叫一次 GET /api/me（帶標頭）：顯示「👤 姓名（角色）」；管理員才有「設定」連結", async () => {
    const admin = loadEngines();
    admin.fetchMock.mockReturnValue(meResponse({ id: "a", name: "王小明", email: "a@example.test", role: "admin" }));
    await admin.UserBar.init();
    expect(admin.fetchMock).toHaveBeenCalledTimes(1);
    expect(admin.fetchMock.mock.calls[0]![0]).toBe("/api/me");
    expect(admin.fetchMock.mock.calls[0]![1].headers).toEqual({ "X-Requested-With": "XMLHttpRequest" });
    expect(admin.element("userbar-user").textContent).toBe("👤 王小明（管理員）");
    expect(admin.element("userbar-settings").hidden).toBe(false);
    expect(admin.element("userbar").hidden).toBe(false);

    const user = loadEngines();
    user.fetchMock.mockReturnValue(meResponse({ id: "u", name: "李四", email: "u@example.test", role: "user" }));
    await user.UserBar.init();
    expect(user.element("userbar-user").textContent).toBe("👤 李四（一般使用者）");
    expect(user.element("userbar-settings").hidden).toBe(true); // 一般使用者沒有「設定」連結
    expect(user.element("userbar").hidden).toBe(false);
  });

  it("姓名一律當文字放進去（不是 HTML）", async () => {
    const { UserBar, fetchMock, element } = loadEngines();
    fetchMock.mockReturnValue(meResponse({ id: "a", name: '<img src=x onerror=alert(1)>', role: "user" }));
    await UserBar.init();
    expect(element("userbar-user").textContent).toBe("👤 <img src=x onerror=alert(1)>（一般使用者）");
  });

  it("401：導向登入頁，使用者列維持隱藏；網路錯誤或壞資料：只寫 console，不丟例外、使用者列維持隱藏", async () => {
    const expired = loadEngines();
    expired.fetchMock.mockReturnValue(Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }));
    await expired.UserBar.init();
    expect(expired.location.href).toBe("/login?next=%2F");
    expect(expired.element("userbar").hidden).toBe(true);

    const offline = loadEngines();
    offline.fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(offline.UserBar.init()).resolves.toBeUndefined();
    expect(offline.consoleMock.error).toHaveBeenCalledTimes(1);
    expect(offline.element("userbar").hidden).toBe(true);

    for (const body of [null, {}, { data: null }, { data: { role: "admin" } }]) {
      const bad = loadEngines();
      bad.fetchMock.mockReturnValue(Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }));
      await bad.UserBar.init();
      expect(bad.element("userbar").hidden).toBe(true);
    }
  });

  it("登出：POST /logout（帶標頭）之後導向 /login；登出請求失敗也一樣導向", async () => {
    const ok = loadEngines();
    ok.fetchMock.mockReturnValue(Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) }));
    await ok.UserBar.logout();
    expect(ok.fetchMock.mock.calls[0]![0]).toBe("/logout");
    expect(ok.fetchMock.mock.calls[0]![1].method).toBe("POST");
    expect(ok.fetchMock.mock.calls[0]![1].headers).toEqual({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" });
    expect(ok.location.href).toBe("/login");

    const failed = loadEngines();
    failed.fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await failed.UserBar.logout();
    expect(failed.location.href).toBe("/login");
  });
});

describe("index.html 的使用者列與其他約定", () => {
  it("使用者列在最上面（header 之前）、預設隱藏；有「我的帳號」(/account)、「設定」(/settings，預設隱藏)、登出按鈕；列印時不顯示（no-print）", () => {
    const bar = html.slice(html.indexOf('<div class="userbar'), html.indexOf("</div>", html.indexOf('<div class="userbar')) + 6);
    expect(bar.startsWith('<div class="userbar no-print" id="userbar" hidden>')).toBe(true); // 預設隱藏：等 /api/me 回來才顯示，沒登入時不閃一下
    expect(bar).toContain('<a href="/account">我的帳號</a>');
    expect(bar).toContain('<a href="/settings" id="userbar-settings" hidden>設定</a>');
    expect(bar).toContain('id="userbar-logout"');
    expect(html.indexOf('<div class="userbar')).toBeLessThan(html.indexOf('<header class="header">'));
    expect(html).toContain("<h1>IPAS 庫存盤點裝箱系統</h1>"); // 程式名稱不動
  });

  it("箱子資料的 localStorage 鍵與載入方式沒有被動到（登入改版不能弄丟現場的箱子資料）", () => {
    expect(html).toContain("KEY: 'ipas-state',");
    expect(html).toContain("let state = Store.loadState() || { boxes: [], currentBoxId: null, lastBoxSeq: 0, productCache: {} };");
    // 整份 index.html 對 localStorage 只有原本的三個呼叫（存、讀、清這一個鍵），登入改版沒有新增任何存取
    expect(html.match(/localStorage\.\w+\(/g)).toEqual(["localStorage.setItem(", "localStorage.getItem(", "localStorage.removeItem("]);
    expect(html).toContain("try { localStorage.setItem(this.KEY, JSON.stringify(state)); } catch(e) {}");
    expect(html).toContain("const d = localStorage.getItem(this.KEY);");
    expect(html).toContain("clearState() { localStorage.removeItem(this.KEY); }");
  });

  it("UserBar 在 script 最後、Init 之前啟動（不影響 renderAll）；登出按鈕有綁事件", () => {
    const initAt = html.indexOf("// ========== Init ==========");
    expect(html.indexOf("UserBar.init();")).toBeGreaterThan(-1);
    expect(html.indexOf("UserBar.init();")).toBeLessThan(initAt);
    expect(html).toContain("document.getElementById('userbar-logout').addEventListener('click', () => UserBar.logout());");
  });
});
