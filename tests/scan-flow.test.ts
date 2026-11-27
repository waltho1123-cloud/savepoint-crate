import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * index.html 的 ProductFlow（商品編號 → 同箱累加／查商品總表／手動輸入 → 加入箱子）的測試。
 * 與 notify-engine.test.ts 一樣：不需要瀏覽器，直接從 index.html 取出那一段原始碼在 Node 執行（注入假的 api、askProduct、箱子）。
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  expect(start, startMarker).toBeGreaterThan(-1);
  expect(end, endMarker).toBeGreaterThan(start);
  return html.slice(start, end);
}

interface Item {
  scanId: string;
  barcode: string;
  productName: string;
  gender: string;
  color: string;
  size: string;
  qty: number;
  officialName?: string;
  catalog?: string;
}
interface Box {
  id: string;
  status: string;
  items: Item[];
}
type CacheEntry = { productName: string; gender: string; color: string; size: string; source?: string };
interface Product {
  productName: string;
  gender: string;
  color: string;
  size: string;
  officialName: string;
}
interface RunResult {
  status: string;
  item?: Item;
  catalog?: string;
  capped?: boolean;
}
interface ProductFlowLike {
  LOOKUP_URL: string;
  clampQty(value: unknown): number;
  cacheGet(cache: Record<string, CacheEntry>, code: string): CacheEntry | null;
  cacheSet(cache: Record<string, CacheEntry>, code: string, entry: CacheEntry): void;
  resetCache(state: { productCache: Record<string, CacheEntry> }): number;
  lookup(api: unknown, barcodes: string[]): Promise<{ ok: boolean; products?: Map<string, Product> }>;
  run(input: { barcode: string; qty: unknown }, deps: unknown): Promise<RunResult>;
  addOrMerge(box: Box, code: string, info: Record<string, unknown>, qty: number, deps: unknown): RunResult;
  planEdit(item: unknown, fields: Record<string, string>): { changed: boolean; cacheEntry: CacheEntry | null; catalog?: string };
}

const ProductFlow = new Function(`${sliceBetween("// ========== ProductFlow", "// ========== OuterBoxLabel")}\nreturn ProductFlow;`)() as ProductFlowLike;

const CATALOG: Record<string, Product> = {
  "1801112756": { productName: "第五代溫灸刷毛圓領發熱衣", gender: "男", color: "陶玫粉", size: "2XL", officialName: "第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)" },
};

/** 假的 api：查得到的編號在 CATALOG 裡；mode 'fail' 丟例外、'500' 回 HTTP 500、'bad' 回 success:false。 */
function makeApi(mode: "ok" | "fail" | "500" | "bad" = "ok", catalog: Record<string, Product> = CATALOG) {
  return {
    post: vi.fn(async (_url: string, payload: { barcodes: string[] }) => {
      if (mode === "fail") throw new TypeError("Failed to fetch");
      if (mode === "500") return { ok: false, status: 500, json: async () => ({}) };
      if (mode === "bad") return { ok: true, status: 200, json: async () => ({ success: false, error: "x" }) };
      const products: Record<string, Product> = {};
      const missing: string[] = [];
      for (const code of payload.barcodes) {
        if (Object.prototype.hasOwnProperty.call(catalog, code)) products[code] = catalog[code]!;
        else missing.push(code);
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { products, missing } }) };
    }),
  };
}

function makeDeps(options: { box?: Box; cache?: Record<string, CacheEntry>; api?: ReturnType<typeof makeApi>; answer?: unknown; barcodeAnswer?: string | null } = {}) {
  const box: Box = options.box ?? { id: "T1", status: "open", items: [] };
  const cache = options.cache ?? {};
  const api = options.api ?? makeApi();
  let seq = 0;
  const deps = {
    box,
    api,
    cache: () => cache,
    isBoxOpen: (b: Box) => b.status === "open",
    addItem: vi.fn((boxId: string, code: string, info: Record<string, unknown>) => {
      if (box.id !== boxId || box.status !== "open") return null;
      const item = { scanId: "s" + ++seq, barcode: code, productName: "", gender: "", color: "", size: "", qty: 1, ...info } as Item;
      box.items.push(item);
      return item;
    }),
    persist: vi.fn(),
    askBarcode: vi.fn(async () => options.barcodeAnswer ?? null),
    askProduct: vi.fn(async (_opts: unknown) => (options.answer ?? null) as unknown),
    notify: vi.fn(),
  };
  return { deps, box, cache, api };
}

const manualAnswer = (barcode: string, qty = 1) => ({ barcode, info: { productName: "手填品名", gender: "女", color: "黑", size: "L" }, qty });

describe("數量一律是 1～9999 的整數（JS 端自己擋，不靠 HTML 屬性）", () => {
  it.each([
    [0, 1],
    [-5, 1],
    [2.7, 2],
    [0.4, 1],
    [10000, 9999],
    [123456789, 9999],
    ["abc", 1],
    ["", 1],
    [null, 1],
    [undefined, 1],
    [NaN, 1],
    [Infinity, 9999],
    [-Infinity, 1],
    ["12", 12],
    ["  7 ", 7],
    [1, 1],
    [9999, 9999],
  ])("clampQty(%j) → %j", (input, expected) => {
    expect(ProductFlow.clampQty(input)).toBe(expected);
  });
});

describe("查詢商品總表 lookup", () => {
  it("POST /api/products/lookup，body 是 { barcodes }；回傳 Map，查不到的編號不在裡面", async () => {
    const api = makeApi();
    const result = await ProductFlow.lookup(api, ["1801112756", "000"]);
    expect(api.post).toHaveBeenCalledWith("/api/products/lookup", { barcodes: ["1801112756", "000"] });
    expect(result.ok).toBe(true);
    expect(result.products!.get("1801112756")).toEqual(CATALOG["1801112756"]);
    expect(result.products!.has("000")).toBe(false);
  });

  it.each(["fail", "500", "bad"] as const)("失敗（%s）回 { ok: false }，不丟例外", async (mode) => {
    await expect(ProductFlow.lookup(makeApi(mode), ["1"])).resolves.toEqual({ ok: false });
  });
});

describe("查得到：直接加入、不跳視窗", () => {
  it("商品欄位用總表的值，另存 officialName，標記 catalog:'found'", async () => {
    const { deps, box } = makeDeps();
    const result = await ProductFlow.run({ barcode: " 1801112756 ", qty: 1 }, deps);
    expect(result.status).toBe("added");
    expect(deps.askProduct).not.toHaveBeenCalled();
    expect(deps.askBarcode).not.toHaveBeenCalled();
    expect(box.items).toHaveLength(1);
    expect(box.items[0]).toMatchObject({
      barcode: "1801112756",
      productName: "第五代溫灸刷毛圓領發熱衣",
      gender: "男",
      color: "陶玫粉",
      size: "2XL",
      officialName: "第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)",
      catalog: "found",
      qty: 1,
    });
  });

  it("本次數量套用在新增的那一筆", async () => {
    const { deps, box } = makeDeps();
    await ProductFlow.run({ barcode: "1801112756", qty: 25 }, deps);
    expect(box.items[0]!.qty).toBe(25);
  });
});

describe("查不到：跳視窗（總表查無），手動輸入後加入", () => {
  it("視窗以 reason:'missing' 開啟；確認後 catalog:'missing'、寫入記憶 source:'manual'", async () => {
    const { deps, box, cache } = makeDeps({ answer: manualAnswer("999", 3) });
    const result = await ProductFlow.run({ barcode: "999", qty: 1 }, deps);
    expect(deps.askProduct).toHaveBeenCalledTimes(1);
    expect(deps.askProduct.mock.calls[0]![0]).toMatchObject({ barcode: "999", reason: "missing", qty: 1 });
    expect(result).toMatchObject({ status: "added", catalog: "missing" });
    expect(box.items).toHaveLength(1);
    expect(box.items[0]).toMatchObject({ barcode: "999", productName: "手填品名", gender: "女", color: "黑", size: "L", qty: 3, catalog: "missing" });
    expect(box.items[0]!.officialName).toBeUndefined();
    expect(cache["999"]).toEqual({ productName: "手填品名", gender: "女", color: "黑", size: "L", source: "manual" });
    expect(deps.persist).toHaveBeenCalled();
  });

  it("視窗裡把編號改成查得到的：用新編號再查，用總表資料加入（並提示已改用總表品名），不用手填的內容", async () => {
    const { deps, box, cache, api } = makeDeps({ answer: manualAnswer("1801112756", 2) });
    const result = await ProductFlow.run({ barcode: "000", qty: 1 }, deps);
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.post.mock.calls[1]![1]).toEqual({ barcodes: ["1801112756"] });
    expect(result).toMatchObject({ status: "added", catalog: "found" });
    expect(box.items[0]).toMatchObject({ barcode: "1801112756", productName: "第五代溫灸刷毛圓領發熱衣", catalog: "found", qty: 2, officialName: "第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)" });
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("已改用總表品名"), "");
    expect(deps.askProduct).toHaveBeenCalledTimes(1); // 不會再跳第二次視窗
    expect(cache["1801112756"]).toBeUndefined(); // 總表查得到的不寫進記憶
  });

  it("改了編號但新編號仍查不到：用手動輸入的內容加入，標記 catalog:'missing'，記憶寫在新編號", async () => {
    const { deps, box, cache } = makeDeps({ answer: manualAnswer("111") });
    await ProductFlow.run({ barcode: "000", qty: 1 }, deps);
    expect(deps.askProduct).toHaveBeenCalledTimes(1);
    expect(box.items).toHaveLength(1);
    expect(box.items[0]).toMatchObject({ barcode: "111", productName: "手填品名", catalog: "missing" });
    expect(cache["111"]).toMatchObject({ source: "manual" });
    expect(cache["000"]).toBeUndefined();
  });

  it("改了編號，而新編號這一箱已經有：直接累加那一筆", async () => {
    const box: Box = { id: "T1", status: "open", items: [{ scanId: "a", barcode: "111", productName: "既有", gender: "", color: "", size: "", qty: 4 }] };
    const { deps } = makeDeps({ box, answer: manualAnswer("111", 2) });
    const result = await ProductFlow.run({ barcode: "000", qty: 1 }, deps);
    expect(result.status).toBe("merged");
    expect(box.items).toHaveLength(1);
    expect(box.items[0]!.qty).toBe(6);
  });

  it("取消視窗：什麼都不加、不寫記憶", async () => {
    const { deps, box, cache } = makeDeps({ answer: null });
    const result = await ProductFlow.run({ barcode: "999", qty: 1 }, deps);
    expect(result.status).toBe("cancelled");
    expect(box.items).toHaveLength(0);
    expect(cache).toEqual({});
  });
});

describe("查詢失敗：跳視窗（無法查詢商品總表），標記 catalog:'unverified'", () => {
  it.each(["fail", "500", "bad"] as const)("%s", async (mode) => {
    const { deps, box, cache } = makeDeps({ api: makeApi(mode), answer: manualAnswer("1801112756") });
    const result = await ProductFlow.run({ barcode: "1801112756", qty: 1 }, deps);
    expect(deps.askProduct.mock.calls[0]![0]).toMatchObject({ reason: "unverified" });
    expect(result).toMatchObject({ status: "added", catalog: "unverified" });
    expect(box.items[0]).toMatchObject({ productName: "手填品名", catalog: "unverified" });
    expect(cache["1801112756"]).toMatchObject({ source: "manual" });
  });

  it("改編號後重新查詢仍失敗：用手動輸入的內容、標記 unverified", async () => {
    const { deps, box } = makeDeps({ api: makeApi("fail"), answer: manualAnswer("222") });
    await ProductFlow.run({ barcode: "111", qty: 1 }, deps);
    expect(deps.askProduct).toHaveBeenCalledTimes(1);
    expect(box.items[0]).toMatchObject({ barcode: "222", catalog: "unverified" });
  });
});

describe("品名記憶的優先順序", () => {
  const edit: CacheEntry = { productName: "人員修正", gender: "女", color: "白", size: "M", source: "edit" };
  const manual: CacheEntry = { productName: "手填舊值", gender: "男", color: "黑", size: "S", source: "manual" };
  const legacy: CacheEntry = { productName: "AI猜的", gender: "男", color: "灰", size: "XL" };

  it("source:'edit' 蓋過總表（查得到也一樣），不必再查總表", async () => {
    const { deps, box, api } = makeDeps({ cache: { "1801112756": edit } });
    await ProductFlow.run({ barcode: "1801112756", qty: 1 }, deps);
    expect(api.post).not.toHaveBeenCalled();
    expect(deps.askProduct).not.toHaveBeenCalled();
    expect(box.items[0]).toMatchObject({ productName: "人員修正", gender: "女", color: "白", size: "M" });
    expect(box.items[0]!.officialName).toBeUndefined();
  });

  it("source:'edit'，編號不在總表也直接用記憶內容", async () => {
    const { deps, box } = makeDeps({ cache: { "999": edit } });
    await ProductFlow.run({ barcode: "999", qty: 1 }, deps);
    expect(deps.askProduct).not.toHaveBeenCalled();
    expect(box.items[0]).toMatchObject({ barcode: "999", productName: "人員修正" });
  });

  it.each([
    ["manual", manual],
    ["沒有 source 的舊資料", legacy],
  ])("%s：總表查得到就用總表，不蓋過總表", async (_name, entry) => {
    const { deps, box } = makeDeps({ cache: { "1801112756": entry } });
    await ProductFlow.run({ barcode: "1801112756", qty: 1 }, deps);
    expect(deps.askProduct).not.toHaveBeenCalled();
    expect(box.items[0]).toMatchObject({ productName: "第五代溫灸刷毛圓領發熱衣", gender: "男", color: "陶玫粉", size: "2XL", catalog: "found" });
  });

  it.each([
    ["manual", manual],
    ["沒有 source 的舊資料", legacy],
  ])("%s：查無時只用來預填視窗（仍然要人員確認）", async (_name, entry) => {
    const { deps, box } = makeDeps({ cache: { "999": entry }, answer: manualAnswer("999") });
    await ProductFlow.run({ barcode: "999", qty: 1 }, deps);
    expect(deps.askProduct).toHaveBeenCalledTimes(1);
    expect(deps.askProduct.mock.calls[0]![0]).toMatchObject({ prefill: { productName: entry.productName, gender: entry.gender, color: entry.color, size: entry.size } });
    expect(box.items[0]).toMatchObject({ productName: "手填品名", catalog: "missing" }); // 加入的是視窗確認的內容
  });

  it.each([
    ["manual", manual],
    ["沒有 source 的舊資料", legacy],
  ])("%s：查詢失敗時一樣只預填", async (_name, entry) => {
    const { deps } = makeDeps({ api: makeApi("fail"), cache: { "999": entry }, answer: null });
    await ProductFlow.run({ barcode: "999", qty: 1 }, deps);
    expect(deps.askProduct.mock.calls[0]![0]).toMatchObject({ reason: "unverified", prefill: { productName: entry.productName } });
  });

  it("沒有記憶時預填是空的", async () => {
    const { deps } = makeDeps({ answer: null });
    await ProductFlow.run({ barcode: "999", qty: 1 }, deps);
    expect(deps.askProduct.mock.calls[0]![0]).toMatchObject({ prefill: {} });
  });

  it("記憶的 key 是 __proto__ 之類的特殊字串也不會誤判成有記憶", () => {
    expect(ProductFlow.cacheGet({}, "__proto__")).toBeNull();
    expect(ProductFlow.cacheGet({}, "constructor")).toBeNull();
    const cache: Record<string, CacheEntry> = {};
    ProductFlow.cacheSet(cache, "__proto__", manual);
    expect(Object.keys(cache)).toEqual([]);
  });
});

describe("編輯商品與記憶", () => {
  const item = (overrides: Record<string, unknown> = {}) => ({ barcode: "1801112756", productName: "A", gender: "男", color: "黑", size: "L", qty: 2, ...overrides });
  const fields = (overrides: Record<string, string> = {}) => ({ productName: "A", gender: "男", color: "黑", size: "L", ...overrides });

  it("總表查到（found）或舊資料被改：記成 source:'edit'；查無／未核對的被改：記成 'manual'", () => {
    for (const catalog of ["found", undefined, "edited"]) {
      const plan = ProductFlow.planEdit(item({ catalog }), fields({ productName: "B" }));
      expect(plan).toMatchObject({ changed: true, cacheEntry: { productName: "B", gender: "男", color: "黑", size: "L", source: "edit" } });
    }
    for (const catalog of ["missing", "unverified"]) {
      const plan = ProductFlow.planEdit(item({ catalog }), fields({ color: "白" }));
      expect(plan).toMatchObject({ changed: true, catalog, cacheEntry: { color: "白", source: "manual" } });
    }
  });

  it("舊資料被編輯後 catalog 變成 'edited'（之後列印不會再拿總表蓋過）；found 維持 found", () => {
    expect(ProductFlow.planEdit(item(), fields({ size: "XL" })).catalog).toBe("edited");
    expect(ProductFlow.planEdit(item({ catalog: "found" }), fields({ size: "XL" })).catalog).toBe("found");
  });

  it("只改數量（四個欄位沒變）不算編輯：不寫記憶", () => {
    expect(ProductFlow.planEdit(item({ catalog: "found" }), fields())).toMatchObject({ changed: false, cacheEntry: null });
  });

  it("編輯後的記憶 source:'edit' 下次掃到同編號直接用（端到端）", async () => {
    const cache: Record<string, CacheEntry> = {};
    const plan = ProductFlow.planEdit(item({ catalog: "found" }), fields({ productName: "改過的品名" }));
    ProductFlow.cacheSet(cache, "1801112756", plan.cacheEntry!);
    const { deps, box } = makeDeps({ cache });
    await ProductFlow.run({ barcode: "1801112756", qty: 1 }, deps);
    expect(box.items[0]!.productName).toBe("改過的品名");
  });

  it("重設品名記憶：只清空 productCache，箱子與商品不變，回傳清掉的筆數", () => {
    const boxes = [{ id: "T1", status: "open", items: [item()] }];
    const snapshot = JSON.stringify(boxes);
    const state = { boxes, currentBoxId: "T1", productCache: { a: { productName: "x", gender: "", color: "", size: "" }, b: { productName: "y", gender: "", color: "", size: "", source: "edit" } } };
    expect(ProductFlow.resetCache(state)).toBe(2);
    expect(state.productCache).toEqual({});
    expect(JSON.stringify(state.boxes)).toBe(snapshot);
    expect(ProductFlow.resetCache({ productCache: undefined as never })).toBe(0);
  });
});

describe("同一箱同編號累加", () => {
  it("同一箱第二次加入同編號：仍然只有一筆，數量是累加後的值，不查總表", async () => {
    const { deps, box, api } = makeDeps();
    await ProductFlow.run({ barcode: "1801112756", qty: 3 }, deps);
    expect(api.post).toHaveBeenCalledTimes(1);
    const second = await ProductFlow.run({ barcode: "1801112756", qty: 4 }, deps);
    expect(api.post).toHaveBeenCalledTimes(1); // 第二次不查詢
    expect(second.status).toBe("merged");
    expect(box.items).toHaveLength(1);
    expect(box.items[0]!.qty).toBe(7);
    expect(deps.addItem).toHaveBeenCalledTimes(1);
  });

  it("累加的上限是 9999（回報 capped）", async () => {
    const { deps, box } = makeDeps();
    await ProductFlow.run({ barcode: "1801112756", qty: 9000 }, deps);
    const result = await ProductFlow.run({ barcode: "1801112756", qty: 2000 }, deps);
    expect(box.items[0]!.qty).toBe(9999);
    expect(result.capped).toBe(true);
  });

  it("不同箱各自一筆", async () => {
    const a = makeDeps();
    const b = makeDeps();
    await ProductFlow.run({ barcode: "1801112756", qty: 1 }, a.deps);
    await ProductFlow.run({ barcode: "1801112756", qty: 1 }, b.deps);
    expect(a.box.items).toHaveLength(1);
    expect(b.box.items).toHaveLength(1);
  });

  it("本次數量也被修正到 1～9999：0／負數／小數／10000／非數字", async () => {
    for (const [input, expected] of [[0, 1], [-3, 1], [2.9, 2], [10000, 9999], ["abc", 1]] as const) {
      const { deps, box } = makeDeps();
      await ProductFlow.run({ barcode: "1801112756", qty: input }, deps);
      expect(box.items[0]!.qty).toBe(expected);
    }
  });

  it("改版前留下的同箱重複資料不合併、不改寫：新的數量累加到第一筆", async () => {
    const box: Box = {
      id: "T1",
      status: "open",
      items: [
        { scanId: "a", barcode: "1801112756", productName: "舊", gender: "", color: "", size: "", qty: 1 },
        { scanId: "b", barcode: "1801112756", productName: "舊", gender: "", color: "", size: "", qty: 5 },
      ],
    };
    const { deps } = makeDeps({ box });
    await ProductFlow.run({ barcode: "1801112756", qty: 2 }, deps);
    expect(box.items.map((i) => i.qty)).toEqual([3, 5]);
    expect(box.items).toHaveLength(2);
  });

  it("沒有 qty 欄位的舊資料當作 1", () => {
    const box = { id: "T1", status: "open", items: [{ barcode: "x" }] } as unknown as Box;
    const { deps } = makeDeps({ box });
    const result = ProductFlow.addOrMerge(box, "x", {}, 2, deps);
    expect(result.status).toBe("merged");
    expect((box.items[0] as Item).qty).toBe(3);
  });

  it("箱子已完成：不累加也不新增", async () => {
    const { deps, box } = makeDeps({ box: { id: "T1", status: "closed", items: [] } });
    const result = await ProductFlow.run({ barcode: "1801112756", qty: 1 }, deps);
    expect(result.status).toBe("closed");
    expect(box.items).toHaveLength(0);
  });

  it("等查詢回來的期間箱子被完成：不加入", async () => {
    const { deps, box } = makeDeps();
    const original = deps.api.post.getMockImplementation()!;
    deps.api.post.mockImplementation(async (url: string, payload: { barcodes: string[] }) => {
      box.status = "closed";
      return original(url, payload);
    });
    const result = await ProductFlow.run({ barcode: "1801112756", qty: 1 }, deps);
    expect(result.status).toBe("closed");
    expect(box.items).toHaveLength(0);
  });
});

describe("防連點", () => {
  it("查詢尚未回來時第二次觸發被忽略：不再呼叫查詢、不會累加成兩倍；結束後恢復", async () => {
    const { deps, box, api } = makeDeps();
    let release!: () => void;
    const original = api.post.getMockImplementation()!;
    api.post.mockImplementationOnce(async (url: string, payload: { barcodes: string[] }) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return original(url, payload);
    });
    const first = ProductFlow.run({ barcode: "1801112756", qty: 100 }, deps);
    await Promise.resolve();
    const second = await ProductFlow.run({ barcode: "1801112756", qty: 100 }, deps);
    expect(second.status).toBe("busy");
    expect(api.post).toHaveBeenCalledTimes(1);
    release();
    expect((await first).status).toBe("added");
    expect(box.items).toHaveLength(1);
    expect(box.items[0]!.qty).toBe(100);
    const third = await ProductFlow.run({ barcode: "1801112756", qty: 1 }, deps);
    expect(third.status).toBe("merged"); // 結束後恢復
  });

  it("取消視窗或丟例外之後也會恢復", async () => {
    const { deps } = makeDeps({ answer: null });
    expect((await ProductFlow.run({ barcode: "999", qty: 1 }, deps)).status).toBe("cancelled");
    deps.askProduct.mockRejectedValueOnce(new Error("x"));
    await expect(ProductFlow.run({ barcode: "998", qty: 1 }, deps)).rejects.toThrow("x");
    expect((await ProductFlow.run({ barcode: "1801112756", qty: 1 }, deps)).status).toBe("added");
  });
});

describe("清單操作後箱號列的件數會更新", () => {
  it("直接改數量、編輯商品、刪除商品都重新 render 箱號列", () => {
    const list = sliceBetween("function renderScanList", "function renderStats");
    expect(list).toMatch(/updateItem\(box\.id, input\.dataset\.scanId[\s\S]*?renderBoxTabs\(\);/);
    expect(list).toMatch(/removeItem\(box\.id, scanId\);[\s\S]*?renderBoxTabs\(\);/);
    expect(sliceBetween("// Edit item dialog", "// Manual barcode input")).toContain("renderBoxTabs();");
  });
});

describe("編號是空的（OCR 沒讀到）", () => {
  it("跳視窗讓人員輸入編號，確認後回到同一條流程（查總表）", async () => {
    const { deps, box, api } = makeDeps({ barcodeAnswer: "1801112756" });
    const result = await ProductFlow.run({ barcode: "  ", qty: 2 }, deps);
    expect(deps.askBarcode).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("added");
    expect(box.items[0]).toMatchObject({ barcode: "1801112756", qty: 2, catalog: "found" });
  });

  it("輸入的編號這一箱已有：累加", async () => {
    const box: Box = { id: "T1", status: "open", items: [{ scanId: "a", barcode: "1801112756", productName: "", gender: "", color: "", size: "", qty: 1 }] };
    const { deps, api } = makeDeps({ box, barcodeAnswer: "1801112756" });
    const result = await ProductFlow.run({ barcode: "", qty: 1 }, deps);
    expect(result.status).toBe("merged");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("取消：什麼都不做", async () => {
    const { deps, box, api } = makeDeps({ barcodeAnswer: null });
    const result = await ProductFlow.run({ barcode: "", qty: 1 }, deps);
    expect(result.status).toBe("cancelled");
    expect(api.post).not.toHaveBeenCalled();
    expect(box.items).toHaveLength(0);
  });
});

describe("index.html 的接線（原始碼層級的檢查）", () => {
  it("OCR 結果只取商品編號：拍照處理器不讀 OCR 回來的品名、性別、顏色、尺寸，也不預填視窗", () => {
    const handler = sliceBetween("// Capture photo and send to OCR", "// ========== Product Info Dialog");
    expect(handler).toContain("await scanBarcode(barcode);");
    expect(handler).not.toMatch(/result\.(productName|gender|color|size)/);
    expect(handler).not.toContain("productCache");
    const flow = sliceBetween("function scanBarcode", "function genderOptions");
    expect(flow).not.toMatch(/result\.(productName|gender|color|size)/);
  });

  it("拍照與手動輸入走同一個函式 scanBarcode（沒有各自複製貼上的流程）", () => {
    expect(html.match(/scanBarcode\(/g)!.length).toBeGreaterThanOrEqual(3); // 定義＋拍照＋手動
    const manual = sliceBetween("// Manual barcode input", "// 列印外箱明細");
    expect(manual).toContain("scanBarcode(val);");
    expect(html).not.toContain("addManualBarcode");
    expect(html).not.toContain("showProductDialog");
  });

  it("成功加入後數量重設回 1；每次加入的數量輸入框預設 1、範圍 1～9999", () => {
    expect(html).toMatch(/<input type="number" id="input-scan-qty" value="1" min="1" max="9999"/);
    const fn = sliceBetween("async function scanBarcode", "function genderOptions");
    expect(fn).toContain("document.getElementById('input-scan-qty').value = 1;");
    expect(fn).toContain("readScanQty()");
  });

  it("掃描清單的總表標記：missing 顯示「總表查無」、unverified 顯示「未核對」，沒有欄位的舊資料沒有標記", () => {
    const list = sliceBetween("function renderScanList", "function renderStats");
    expect(list).toContain("item.catalog === 'missing'");
    expect(list).toContain("總表查無");
    expect(list).toContain("item.catalog === 'unverified'");
    expect(list).toContain("未核對");
    expect(list).toContain("item-qty-input");
  });

  it("查無視窗標示「總表查無」與提示文字；查詢失敗視窗說「無法查詢商品總表」", () => {
    const dialog = sliceBetween("function askProductDialog", "// Edit item dialog");
    expect(dialog).toContain("總表查無");
    expect(dialog).toContain("請先核對商品編號，再手動輸入品名");
    expect(dialog).toContain("無法查詢商品總表");
    expect(dialog).toContain('id="dlg-qty"');
  });

  it("重設品名記憶：header 有按鈕；確認視窗的說明；只清記憶", () => {
    expect(html).toContain('id="btn-reset-product-cache">重設品名記憶</button>');
    expect(html).toContain("只清除系統記住的品名（${count} 筆），箱子與商品都不會刪除。");
    expect(html).toContain('onclick="confirmClearAll()">清除資料</button>');
  });

  it("商品總表查詢只經由 ApiClient（整份 index.html 只有一個 fetch()）", () => {
    expect(html.match(/\bfetch\(/g)).toHaveLength(1);
    expect(sliceBetween("// ========== ProductFlow", "// ========== OuterBoxLabel")).toContain("api.post(this.LOOKUP_URL");
  });

  it("SaveEngine／NotifyEngine 送出的商品欄位仍是原本那幾個（catalog、officialName 不會被送出去）", () => {
    const save = sliceBetween("// ========== SaveEngine", "// ========== NotifyEngine");
    const notify = sliceBetween("// ========== NotifyEngine", "// ========== CloseFlow");
    for (const source of [save, notify]) {
      expect(source).not.toContain("catalog");
      expect(source).not.toContain("officialName");
    }
  });

  it("統計報表：欄位不會被擠成一個字一行；手機是一筆一張卡片，CSS 的 nth-child 與 8 個欄位的順序對得上", () => {
    // CSS 用 td:nth-child 定位欄位，所以表頭與 renderStats 的欄位順序是約定的一部分
    const table = sliceBetween('<table class="stats-table" id="stats-table">', "</thead>");
    expect([...table.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual([
      "#", "商品編號", "品名", "性別", "顏色", "尺寸", "數量", "所在箱號",
    ]);
    const render = sliceBetween("function renderStats", "// ========== Dialog");
    const cells = [...render.slice(render.indexOf("aggItems.forEach")).matchAll(/<td[^>]*>\$\{([^}]*)\}/g)].map((m) => m[1]);
    expect(cells).toHaveLength(8);
    expect(cells[0]).toContain("idx + 1");
    expect(cells[1]).toContain("item.barcode");
    expect(cells[2]).toContain("item.productName");
    expect(cells[3]).toContain("item.gender");
    expect(cells[4]).toContain("item.color");
    expect(cells[5]).toContain("item.size");
    expect(cells[6]).toContain("item.totalQty");
    expect(cells[7]).toContain("item.boxes");

    // 表格模式（>= 768px）：每欄有最小寬度；不用 nowrap 撐寬（超長的編號、顏色照樣換行）；空狀態那一格（也是第 1 格）要能換行。
    // 只對 screen 生效：列印統計表不吃這些規則（它有自己的一組，見下）。
    const wide = sliceBetween("@media screen and (min-width: 768px) {", "@media screen and (min-width: 900px) {");
    expect(wide).toContain(".stats-table td:nth-child(3) { min-width: 9em; }");
    expect(wide).toContain(".stats-table td:nth-child(2) { min-width: 11ch; overflow-wrap: anywhere; }");
    // 全站是 border-box：不改成 content-box 的話，最小寬度會被左右內距吃掉，短欄照樣被擠成直的
    expect(wide).toContain(".stats-table td { box-sizing: content-box; }");
    expect(wide).toContain(".stats-table td.stats-empty { white-space: normal; }");
    expect(wide).not.toMatch(/td:nth-child\((2|3|4|5|6|8)\)[^}]*white-space: nowrap/);
    // 沒有包在 @media 裡的 nth-child 規則（那種會連列印一起影響）
    const statsCss = sliceBetween("/* ===== Stats table", "@media screen and (min-width: 768px) {");
    expect(statsCss).not.toContain("nth-child(");

    // 列印統計表：自己的一組最小寬度（只在 print-mode-stats），同樣是內容寬度、不用 nowrap 撐欄位
    const print = sliceBetween("/* ===== Print styles ===== */", "</style>");
    expect(print).toContain("body.print-mode-stats .stats-table td { box-sizing: content-box; padding-left: 8px; padding-right: 8px; }");
    expect(print).toContain("body.print-mode-stats .stats-table td:nth-child(2) { min-width: 11ch; overflow-wrap: anywhere; }");
    expect(print).toContain("body.print-mode-stats .stats-table td:nth-child(3) { min-width: 12em; }");
    expect(print).toContain("body.print-mode-stats .stats-table td.stats-empty { white-space: normal; }");
    expect(print).not.toMatch(/td:nth-child\((2|3|4|5|6|8)\)[^}]*white-space: nowrap/);
    // 列印區裡的 nth-child 規則一律掛在 print-mode-stats 底下（不可影響標籤單與外箱明細的列印）
    for (const line of print.split("\n").filter((l) => l.includes("nth-child("))) {
      expect(line.trim().startsWith("body.print-mode-stats .stats-table"), line).toBe(true);
    }

    // 窄螢幕（< 768px）：卡片；只對 screen 生效（列印統計表仍是表格）
    const mobile = sliceBetween("@media screen and (max-width: 767px) {", "/* ===== Print styles ===== */");
    expect(mobile).toMatch(/td:nth-child\(2\) \{ order: 2; flex: 1 1 0; \}/);
    expect(mobile).toContain(".stats-table thead { display: none; }");
    expect(mobile).toMatch(/\.stats-table tbody tr \{\s*display: flex; flex-wrap: wrap;/);
    expect(mobile).toMatch(/td:nth-child\(3\) \{ order: 4; flex: 0 0 100%;/);
    expect(mobile).toContain(".stats-table tbody td:nth-child(7)::before { content: '數量 '; }");
    expect(mobile).toContain(".stats-table tbody td:nth-child(4)::before { content: '性別 '; }");
    expect(mobile).toContain(".stats-table tbody td:nth-child(5)::before { content: '顏色 '; }");
    expect(mobile).toContain(".stats-table tbody td:nth-child(6)::before { content: '尺寸 '; }");
    expect(mobile).toContain(".stats-table tbody td:nth-child(8)::before { content: '箱號 '; }");
    expect(mobile).toMatch(/td\.stats-empty \{ order: 0; flex: 0 0 100%;/);
  });

  it("<style> 的大括號成對（多一個 } 會讓後面的規則整條失效，原始碼層級的其他檢查抓不到）", () => {
    const css = sliceBetween("<style>", "</style>").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css.split("{").length).toBe(css.split("}").length);
  });
});
