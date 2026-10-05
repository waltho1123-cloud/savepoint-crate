import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { createCapturingLogger, createFetchMock, jsonResponse, TEST_GROUP_ID, TEST_LINE_TOKEN } from "./helpers.js";

/**
 * index.html 裡的 NotifyEngine（關箱後通知 LINE 群組）的測試。
 * 不需要瀏覽器：直接從 index.html 把 NotifyEngine 那一段原始碼取出來，在 Node 裡執行（注入假的 fetch、showToast、console），
 * 測的就是實際會送到使用者手機上的那份程式碼。
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

interface NotifyEngineLike {
  NOTIFY_URL: string;
  boxClosed(box: unknown, saveResult: unknown): Promise<void>;
}

function loadNotifyEngine(fetchOverride?: (url: string, init: unknown) => Promise<unknown>) {
  const start = html.indexOf("// ========== NotifyEngine");
  const end = html.indexOf("// ========== PrintManager");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const fetchMock = vi.fn<(url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>>();
  const showToast = vi.fn();
  const consoleMock = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
  const factory = new Function("fetch", "showToast", "console", `${html.slice(start, end)}\nreturn NotifyEngine;`);
  const engine = factory(fetchOverride ?? fetchMock, showToast, consoleMock) as NotifyEngineLike;
  return { engine, fetchMock, showToast, consoleMock };
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
  return JSON.parse(fetchMock.mock.calls[0]![1].body) as Record<string, unknown>;
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
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
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
    });
    const loaded = loadNotifyEngine((url, init) => Promise.resolve(app.request(url, init as RequestInit)));
    return { ...loaded, lineCalls: line.calls };
  }
  const lineText = (calls: Array<{ body?: string }>) => (JSON.parse(calls[0]!.body!) as { messages: Array<{ text: string }> }).messages[0]!.text;
  const box = { id: "BOX-001", status: "open", items: [scanned(), scanned({ scanId: "uuid-2", barcode: "1801472364", productName: "搖粒絨極暖衝鋒褲", gender: "", color: "星夜黑", size: "XL", qty: 2 })] };

  it("saveBoxItems 全部成功 → 「已同步 2/2 筆」，明細與件數正確", async () => {
    const { engine, lineCalls, showToast } = wire(() => jsonResponse({}));
    await engine.boxClosed(box, { success: true, total: 2, successCount: 2, failCount: 0, results: [] });
    expect(lineCalls).toHaveLength(1);
    const lines = lineText(lineCalls).split("\n");
    expect(lines.slice(0, 3)).toEqual(["📦 箱號 BOX-001 已完成", "共 2 種商品、5 件", "已同步 2/2 筆到商品主檔 ✓"]);
    expect(lines.slice(3, 6)).toEqual(["明細：", "1801080204 第五代溫灸刷毛圓領發熱衣(女-經典黑L) ×3", "1801472364 搖粒絨極暖衝鋒褲(星夜黑XL) ×2"]);
    expect(lines.at(-1)).toMatch(/^時間：\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/); // 前端送來的 closedAt（瀏覽器現在時間）轉成台北時間
    expect(showToast).not.toHaveBeenCalled();
  });

  it("saveBoxItems 部分失敗（failCount）→ 警告文案", async () => {
    const { engine, lineCalls } = wire(() => jsonResponse({}));
    await engine.boxClosed(box, { success: false, total: 2, successCount: 1, failCount: 1, results: [] });
    expect(lineText(lineCalls).split("\n")[2]).toBe("⚠️ 同步 1/2 筆，1 筆失敗，請查核商品主檔");
  });

  it("saveBoxItems 丟了例外（null）→ 「同步 0/2 筆，2 筆失敗」", async () => {
    const { engine, lineCalls } = wire(() => jsonResponse({}));
    await engine.boxClosed(box, null);
    expect(lineText(lineCalls).split("\n")[2]).toBe("⚠️ 同步 0/2 筆，2 筆失敗，請查核商品主檔");
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

  it("saveBoxItems 的結果被保留下來（丟例外時維持 null），只呼叫一次 NotifyEngine.boxClosed", () => {
    expect(handler).toContain("let notifySaveResult = null;");
    expect(handler.indexOf("let notifySaveResult = null;")).toBeLessThan(handler.indexOf("try {"));
    expect(handler.indexOf("notifySaveResult = saveResult;")).toBeGreaterThan(handler.indexOf("await SaveEngine.saveBoxItems(box)"));
    expect(handler.match(/NotifyEngine\.boxClosed\(/g)).toHaveLength(1);
    expect(handler).toContain("NotifyEngine.boxClosed(box, notifySaveResult);");
  });

  it("通知在同步（含 catch）之後、BoxManager.closeBox 之前；不 await（不能因為 LINE 慢而拖住關箱）", () => {
    const notifyAt = handler.indexOf("NotifyEngine.boxClosed(box, notifySaveResult);");
    expect(notifyAt).toBeGreaterThan(handler.indexOf("} catch (e) {")); // 在整個 try/catch 之後
    expect(notifyAt).toBeLessThan(handler.indexOf("BoxManager.closeBox(box.id);"));
    expect(handler).not.toMatch(/await\s+NotifyEngine/);
  });
});
