import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { buildMergedName } from "../src/sheets.js";

/**
 * index.html 的 OuterBoxLabel（列印外箱明細：合併、官方品名、分頁、排版）的測試。
 * 分頁是純函式（給定每列高度與半頁／整頁可用高度 → 每頁放哪些箱子的哪些列），不需要瀏覽器；
 * 量高度（measure）是唯一碰 DOM 的部分，這裡只做原始碼層級的檢查。
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  expect(start, startMarker).toBeGreaterThan(-1);
  expect(end, endMarker).toBeGreaterThan(start);
  return html.slice(start, end);
}

interface Row {
  barcode: string;
  name: string;
  qty: number;
}
interface Metrics {
  headH: number;
  contHeadH: number;
  footH: number;
  rowHs: number[];
}
interface PBox {
  id: string;
  rows: Row[];
  total: number;
  metrics: Metrics;
}
interface Slot {
  boxId: string;
  rows: Row[];
  continued: boolean;
  showFooter: boolean;
  total: number;
}
interface Page {
  full: boolean;
  slots: Slot[];
}
interface Item {
  barcode: string;
  productName?: string;
  gender?: string;
  color?: string;
  size?: string;
  qty?: number;
  officialName?: string;
  catalog?: string;
}
interface FBox {
  id: string;
  status: string;
  items: Item[];
}
type LookupResult = { ok: boolean; products?: Map<string, { productName: string; gender: string; color: string; size: string; officialName: string }> };
interface OuterBoxLike {
  buildMergedName(productName: string, gender: string, color: string, size: string): string;
  isSelectable(box: FBox): boolean;
  summarize(box: FBox): { kinds: number; pieces: number };
  defaultSelection(boxes: FBox[], mode: string, boxId?: string): string[];
  toggleOrder(order: string[], boxId: string, checked: boolean): string[];
  groupBox(box: FBox): Array<{ barcode: string; qty: number }>;
  prepare(boxes: FBox[], opts: { lookup(codes: string[]): Promise<LookupResult> }): Promise<{ boxes: Array<{ id: string; rows: Row[]; total: number }>; lookupFailed: boolean }>;
  paginate(boxes: PBox[], limits: { half: number; full: number }): Page[];
  renderTable(slot: Slot, esc: (s: unknown) => string): string;
  renderPages(pages: Page[], esc: (s: unknown) => string): string;
  taipeiToday(nowMs: number): string;
  formatClosedTime(closedAt: string): string;
  sheetKey(date: string, boxId: string, closedAt: string, seq: number): string;
  loadSheetBoxes(date: string, raw: unknown): SheetBox[];
  dropKeys(order: string[], keys: string[]): string[];
  pickAll(local: FBox[], sheet: SheetBox[], pick: string): string[];
  resolveOrder(order: string[], local: FBox[], sheet: SheetBox[]): Array<{ kind: string; box: FBox | SheetBox }>;
  fetchSheetBoxes(api: { post(url: string, payload: unknown): Promise<unknown> }, date: string): Promise<{ ok: boolean; boxes?: SheetBox[]; error?: string }>;
  sheetRowName(rep: Item & { mergedName?: string }, product: { productName: string; gender: string; color: string; size: string; officialName: string } | null | undefined): string;
  prepareSheet(boxes: SheetBox[], opts: { lookup(codes: string[]): Promise<LookupResult> }): Promise<{ boxes: Array<{ key: string; id: string; rows: Row[]; total: number }>; lookupFailed: boolean }>;
  mergePrepared<T>(chosen: Array<{ kind: string }>, local: T[], sheet: T[]): T[];
}
interface SheetBox {
  key: string;
  id: string;
  closedAt: string;
  status: string;
  items: Array<Item & { mergedName: string }>;
}

const OuterBoxLabel = new Function(`${sliceBetween("// ========== OuterBoxLabel", "// ========== UI Logic")}\nreturn OuterBoxLabel;`)() as OuterBoxLabelLike;
type OuterBoxLabelLike = OuterBoxLike;
const escHtml = new Function(`${sliceBetween("function escHtml", "// ========== UserBar")}\nreturn escHtml;`)() as (s: unknown) => string;

const item = (barcode: string, qty: number, extra: Partial<Item> = {}): Item => ({ barcode, productName: "", gender: "", color: "", size: "", qty, ...extra });
const official = (code: string, name: string) => ({ productName: "x", gender: "", color: "", size: "", officialName: name, code });

describe("商品名稱的組法與後端 buildMergedName 一致", () => {
  it("所有組合（有／無 品名、性別、顏色、尺寸）都和 src/sheets.ts 相同，含「品名(男-)」的邊角行為", () => {
    const names = ["", "第五代溫灸刷毛圓領發熱衣"];
    const genders = ["", "男", "女", "中性"];
    const colors = ["", "陶玫粉"];
    const sizes = ["", "2XL"];
    let checked = 0;
    for (const n of names) for (const g of genders) for (const c of colors) for (const s of sizes) {
      expect(OuterBoxLabel.buildMergedName(n, g, c, s), JSON.stringify([n, g, c, s])).toBe(buildMergedName(n, g, c, s));
      checked += 1;
    }
    expect(checked).toBe(32);
    expect(OuterBoxLabel.buildMergedName("衣", "男", "", "")).toBe("衣(男-)");
    expect(OuterBoxLabel.buildMergedName("第五代溫灸刷毛圓領發熱衣", "男", "陶玫粉", "2XL")).toBe("第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)");
  });
});

describe("合併：同箱同編號一列、數量加總、依編號由小到大", () => {
  it("合併與排序（含不同長度的編號要照數值排）", () => {
    const box: FBox = { id: "T1", status: "closed", items: [item("1801112756", 100), item("1801080204", 5), item("1801112756", 100), item("999", 1), item("1801080204", 2)] };
    const groups = OuterBoxLabel.groupBox(box);
    expect(groups.map((g) => [g.barcode, g.qty])).toEqual([
      ["999", 1],
      ["1801080204", 7],
      ["1801112756", 200],
    ]);
  });

  it("沒有 qty 或不合法的 qty 當 1", () => {
    const box: FBox = { id: "T1", status: "open", items: [{ barcode: "a" }, item("a", 0), item("a", 2.9)] };
    expect(OuterBoxLabel.groupBox(box)[0]!.qty).toBe(1 + 1 + 2);
  });
});

describe("prepare：商品名稱與批次查詢官方品名", () => {
  const lookupOf = (catalog: Record<string, string>) =>
    vi.fn(async (codes: string[]): Promise<LookupResult> => ({
      ok: true,
      products: new Map(codes.filter((c) => catalog[c] !== undefined).map((c) => [c, official(c, catalog[c]!)])),
    }));

  it("有 officialName 就用它（不查詢）；合計是各列數量的加總", async () => {
    const lookup = lookupOf({});
    const box: FBox = { id: "T1", status: "closed", items: [item("1801112756", 100, { officialName: "第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)", catalog: "found", productName: "別的", gender: "女" }), item("1801112756", 100, { officialName: "第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)", catalog: "found" })] };
    const { boxes, lookupFailed } = await OuterBoxLabel.prepare([box], { lookup });
    expect(lookup).not.toHaveBeenCalled();
    expect(lookupFailed).toBe(false);
    expect(boxes).toEqual([{ id: "T1", rows: [{ barcode: "1801112756", name: "第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)", qty: 200 }], total: 200 }]);
  });

  it("沒有 officialName 又沒有 catalog 的舊商品：批次查詢，用總表的官方品名；不改寫箱子裡的資料", async () => {
    const lookup = lookupOf({ "1": "官方一", "2": "官方二" });
    const boxes: FBox[] = [
      { id: "A", status: "closed", items: [item("1", 2, { productName: "舊品名", gender: "男", color: "黑", size: "L" }), item("2", 1)] },
      { id: "B", status: "closed", items: [item("1", 3)] },
    ];
    const snapshot = JSON.stringify(boxes);
    const result = await OuterBoxLabel.prepare(boxes, { lookup });
    expect(lookup).toHaveBeenCalledTimes(1); // 兩箱的編號一起查、去重
    expect(lookup).toHaveBeenCalledWith(["1", "2"]);
    expect(result.boxes[0]!.rows.map((r) => r.name)).toEqual(["官方一", "官方二"]);
    expect(result.boxes[1]!.rows[0]!.name).toBe("官方一");
    expect(JSON.stringify(boxes)).toBe(snapshot);
  });

  it("查詢失敗：退回用欄位組出來的品名，並回報 lookupFailed（呼叫端提示一次）", async () => {
    const lookup = vi.fn(async (): Promise<LookupResult> => ({ ok: false }));
    const box: FBox = { id: "A", status: "closed", items: [item("1", 2, { productName: "舊品名", gender: "男", color: "黑", size: "L" }), item("2", 1, { productName: "只有品名" })] };
    const result = await OuterBoxLabel.prepare([box], { lookup });
    expect(result.lookupFailed).toBe(true);
    expect(result.boxes[0]!.rows.map((r) => r.name)).toEqual(["舊品名(男-黑L)", "只有品名"]);
  });

  it("lookup 丟例外也一樣退回，不中斷", async () => {
    const lookup = vi.fn(async (): Promise<LookupResult> => {
      throw new Error("boom");
    });
    const result = await OuterBoxLabel.prepare([{ id: "A", status: "closed", items: [item("1", 1, { productName: "P" })] }], { lookup });
    expect(result.lookupFailed).toBe(true);
    expect(result.boxes[0]!.rows[0]!.name).toBe("P");
  });

  it("查詢回來但沒有這個編號：退回組出來的品名（不算失敗）", async () => {
    const result = await OuterBoxLabel.prepare([{ id: "A", status: "closed", items: [item("9", 1, { productName: "P", color: "紅" })] }], { lookup: lookupOf({}) });
    expect(result.lookupFailed).toBe(false);
    expect(result.boxes[0]!.rows[0]!.name).toBe("P(紅)");
  });

  it("人員編輯過的（catalog 為 edited、或 found 但官方品名已清掉）與手動輸入的（missing／unverified）不查，用修改後的欄位組品名", async () => {
    const lookup = lookupOf({ "1": "官方", "2": "官方", "3": "官方", "4": "官方" });
    const box: FBox = {
      id: "A",
      status: "closed",
      items: [
        item("1", 1, { productName: "改過", gender: "女", color: "白", size: "M", catalog: "edited" }),
        item("2", 1, { productName: "改過2", catalog: "found" }),
        item("3", 1, { productName: "手填", catalog: "missing" }),
        item("4", 1, { productName: "手填2", catalog: "unverified" }),
      ],
    };
    const result = await OuterBoxLabel.prepare([box], { lookup });
    expect(lookup).not.toHaveBeenCalled();
    expect(result.boxes[0]!.rows.map((r) => r.name)).toEqual(["改過(女-白M)", "改過2", "手填", "手填2"]);
  });

  it("一次最多 200 個編號：450 個舊商品分成 200、200、50 三批", async () => {
    const items = Array.from({ length: 450 }, (_, i) => item(String(1000 + i), 1));
    const lookup = lookupOf({});
    await OuterBoxLabel.prepare([{ id: "A", status: "closed", items }], { lookup });
    expect(lookup.mock.calls.map((c) => c[0]!.length)).toEqual([200, 200, 50]);
  });

  it("其中一批失敗：成功的批次照用，失敗的退回組出來的品名", async () => {
    const items = Array.from({ length: 250 }, (_, i) => item(String(1000 + i), 1, { productName: "舊" }));
    let call = 0;
    const lookup = vi.fn(async (codes: string[]): Promise<LookupResult> => {
      call += 1;
      return call === 1 ? { ok: true, products: new Map(codes.map((c) => [c, official(c, "官方" + c)])) } : { ok: false };
    });
    const result = await OuterBoxLabel.prepare([{ id: "A", status: "closed", items }], { lookup });
    expect(result.lookupFailed).toBe(true);
    expect(result.boxes[0]!.rows[0]!.name).toBe("官方1000");
    expect(result.boxes[0]!.rows[249]!.name).toBe("舊");
  });
});

describe("選擇視窗的預設與順序", () => {
  const boxes: FBox[] = [
    { id: "T1", status: "closed", items: [item("1", 1)] },
    { id: "T2", status: "open", items: [item("2", 2), item("2", 3), item("3", 1)] },
    { id: "T3", status: "closed", items: [] },
    { id: "T4", status: "closed", items: [item("4", 1)] },
  ];

  it("空箱不能選", () => {
    expect(boxes.map((b) => OuterBoxLabel.isSelectable(b))).toEqual([true, true, false, true]);
  });

  it("每箱摘要：幾種商品（不同編號）、幾件", () => {
    expect(OuterBoxLabel.summarize(boxes[1]!)).toEqual({ kinds: 2, pieces: 6 });
  });

  it("從某個箱號旁按進來：只勾那一箱；那一箱是空箱就不勾", () => {
    expect(OuterBoxLabel.defaultSelection(boxes, "box", "T2")).toEqual(["T2"]);
    expect(OuterBoxLabel.defaultSelection(boxes, "box", "T3")).toEqual([]);
  });

  it("從統計報表按進來：勾所有已完成的箱（不含空箱）；沒有已完成的就全勾（不含空箱）", () => {
    expect(OuterBoxLabel.defaultSelection(boxes, "stats")).toEqual(["T1", "T4"]);
    const noneClosed = boxes.map((b) => ({ ...b, status: "open" }));
    expect(OuterBoxLabel.defaultSelection(noneClosed, "stats")).toEqual(["T1", "T2", "T4"]);
  });

  it("勾選順序：勾起來排到最後，取消就移除", () => {
    let order: string[] = [];
    order = OuterBoxLabel.toggleOrder(order, "T4", true);
    order = OuterBoxLabel.toggleOrder(order, "T1", true);
    order = OuterBoxLabel.toggleOrder(order, "T2", true);
    expect(order).toEqual(["T4", "T1", "T2"]);
    expect(OuterBoxLabel.toggleOrder(order, "T1", false)).toEqual(["T4", "T2"]);
    expect(OuterBoxLabel.toggleOrder(order, "T4", true)).toEqual(["T1", "T2", "T4"]); // 重複勾不會出現兩次
  });
});

// 分頁：每列高度、半頁／整頁上限都是假的數字（單位無所謂），所以可以精準測邊界。
const LIMITS = { half: 100, full: 220 };
function pbox(id: string, rowHs: number[], overrides: Partial<Metrics> = {}): PBox {
  const rows = rowHs.map((_, i) => ({ barcode: `${id}-${String(i).padStart(3, "0")}`, name: `品名${i}`, qty: i + 1 }));
  return { id, rows, total: rows.reduce((s, r) => s + r.qty, 0), metrics: { headH: 30, contHeadH: 30, footH: 10, rowHs, ...overrides } };
}
const layout = (pages: Page[]) => pages.map((p) => p.slots.map((s) => s.boxId + (s.continued ? "(續)" : "") + (s.showFooter ? "" : "…")));
const rowsOf = (pages: Page[], boxId: string) => pages.flatMap((p) => p.slots.filter((s) => s.boxId === boxId).flatMap((s) => s.rows));

describe("paginate：分頁（純函式，用實際量到的高度）", () => {
  it("3 個放得下半頁的箱子：第 1 頁是第 1、2 箱，第 2 頁只有第 3 箱", () => {
    const pages = OuterBoxLabel.paginate([pbox("A", [10, 10]), pbox("B", [10]), pbox("C", [10, 10, 10])], LIMITS);
    expect(layout(pages)).toEqual([["A", "B"], ["C"]]);
    expect(pages.every((p) => !p.full)).toBe(true);
    for (const p of pages) for (const s of p.slots) expect(s.showFooter).toBe(true);
  });

  it("剛好等於半頁上限仍算半頁；多 1 就自己佔整頁", () => {
    const fits = pbox("A", [60]); // 30 + 60 + 10 = 100
    const over = pbox("B", [61]); // 101
    expect(layout(OuterBoxLabel.paginate([fits, pbox("C", [10])], LIMITS))).toEqual([["A", "C"]]);
    const pages = OuterBoxLabel.paginate([over, pbox("C", [10])], LIMITS);
    expect(layout(pages)).toEqual([["B"], ["C"]]);
    expect(pages[0]!.full).toBe(true);
  });

  it("一個超過半頁但放得下整頁的箱子：自己一頁（整頁），列都在、合計在", () => {
    const big = pbox("BIG", [40, 40, 40, 40]); // 30 + 160 + 10 = 200 ≤ 220
    const pages = OuterBoxLabel.paginate([big], LIMITS);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.full).toBe(true);
    expect(pages[0]!.slots).toHaveLength(1);
    expect(pages[0]!.slots[0]).toMatchObject({ boxId: "BIG", continued: false, showFooter: true, total: big.total });
    expect(pages[0]!.slots[0]!.rows).toEqual(big.rows);
  });

  it("超過整頁的箱子：跨多頁，所有頁的列加起來等於原本的列（不重複不遺漏）、接續頁標示續頁、合計只在最後一段", () => {
    const huge = pbox("HUGE", Array.from({ length: 30 }, () => 25)); // 30 + 750 + 10
    const pages = OuterBoxLabel.paginate([huge], LIMITS);
    expect(pages.length).toBeGreaterThan(2);
    expect(rowsOf(pages, "HUGE")).toEqual(huge.rows); // 順序、數量完全一致
    const slots = pages.flatMap((p) => p.slots);
    expect(slots.map((s) => s.continued)).toEqual(slots.map((_, i) => i > 0)); // 只有第一段不是續頁
    expect(slots.map((s) => s.showFooter)).toEqual(slots.map((_, i) => i === slots.length - 1)); // 合計只在最後一段
    expect(pages.every((p) => p.full && p.slots.length === 1)).toBe(true);
    // 每一頁實際用的高度（標題＋列＋合計）不超過整頁上限
    for (const s of slots) {
      const used = (s.continued ? 30 : 30) + s.rows.length * 25 + (s.showFooter ? 10 : 0);
      expect(used).toBeLessThanOrEqual(LIMITS.full);
    }
  });

  it("每列高度不等（品名換行）：用實際高度決定，不假設等高", () => {
    const tall = pbox("T", [90, 20, 20, 90, 20, 20, 90]); // 不等高
    const pages = OuterBoxLabel.paginate([tall], LIMITS);
    expect(rowsOf(pages, "T")).toEqual(tall.rows);
    for (const p of pages) {
      for (const s of p.slots) {
        const start = tall.rows.indexOf(s.rows[0]!);
        const heights = s.rows.map((_, i) => tall.metrics.rowHs[start + i]!);
        const used = 30 + heights.reduce((a, b) => a + b, 0) + (s.showFooter ? 10 : 0);
        expect(used).toBeLessThanOrEqual(LIMITS.full);
      }
    }
    expect(pages.length).toBeGreaterThan(1);
  });

  it("合計放不下時：最後一列連同合計移到下一頁，不留只有合計的一頁，也不遺漏任何一列", () => {
    // 30 + 8*23 = 214，再加合計 10 = 224 > 220
    const box = pbox("E", Array.from({ length: 8 }, () => 23));
    const pages = OuterBoxLabel.paginate([box], LIMITS);
    expect(layout(pages)).toEqual([["E…"], ["E(續)"]]);
    expect(pages[0]!.slots[0]!.rows).toHaveLength(7);
    expect(pages[1]!.slots[0]!.rows).toHaveLength(1);
    expect(rowsOf(pages, "E")).toEqual(box.rows);
  });

  it("小箱、大箱、小箱：順序不被重排，前後不補位", () => {
    const small1 = pbox("S1", [10]);
    const big = pbox("BIG", Array.from({ length: 30 }, () => 25));
    const small2 = pbox("S2", [10]);
    const small3 = pbox("S3", [10]);
    const pages = OuterBoxLabel.paginate([small1, big, small2, small3], LIMITS);
    const names = layout(pages);
    expect(names[0]).toEqual(["S1"]); // 大箱前面的小箱自己一頁，不被後面的小箱補位
    expect(names[1]![0]).toMatch(/^BIG/);
    expect(names.at(-1)).toEqual(["S2", "S3"]); // 大箱之後重新兩兩配對
    expect(names.slice(1, -1).every((p) => p[0]!.startsWith("BIG"))).toBe(true);
    expect(rowsOf(pages, "BIG")).toEqual(big.rows);
  });

  it("連續多個大箱各自分頁、互不混在同一頁", () => {
    const a = pbox("A", [60, 60, 60]); // 30+180+10 = 220 ≤ 220 → 一頁
    const b = pbox("B", [60, 60, 60, 60]); // 放不下整頁 → 兩頁
    const pages = OuterBoxLabel.paginate([a, b], LIMITS);
    expect(pages.every((p) => p.slots.length === 1)).toBe(true);
    expect(layout(pages)[0]).toEqual(["A"]);
    expect(rowsOf(pages, "B")).toEqual(b.rows);
  });

  it("接續頁的標題較高（contHeadH）也算進去", () => {
    const box = pbox("C", Array.from({ length: 12 }, () => 30), { contHeadH: 80 });
    const pages = OuterBoxLabel.paginate([box], LIMITS);
    for (const p of pages) {
      for (const s of p.slots) {
        const head = s.continued ? 80 : 30;
        const used = head + s.rows.length * 30 + (s.showFooter ? 10 : 0);
        expect(used).toBeLessThanOrEqual(LIMITS.full);
      }
    }
    expect(rowsOf(pages, "C")).toEqual(box.rows);
  });

  it("單一列比整頁還高：不截斷、不遺漏（獨佔一頁），不會無窮迴圈", () => {
    const monster = pbox("M", [10, 500, 10]);
    const pages = OuterBoxLabel.paginate([monster], LIMITS);
    expect(rowsOf(pages, "M")).toEqual(monster.rows);
    expect(pages.flatMap((p) => p.slots).at(-1)!.showFooter).toBe(true);
  });

  it("沒有任何箱子：沒有頁", () => {
    expect(OuterBoxLabel.paginate([], LIMITS)).toEqual([]);
  });

  it("隨機箱子與列高：每一列恰好出現一次、順序不變、合計只在每箱最後一段、每頁不超高（單列超高除外）", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 200; round += 1) {
      const boxes = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, b) => pbox("B" + b, Array.from({ length: 1 + Math.floor(rand() * 40) }, () => 12 + Math.floor(rand() * 60))));
      const pages = OuterBoxLabel.paginate(boxes, LIMITS);
      for (const box of boxes) {
        expect(rowsOf(pages, box.id)).toEqual(box.rows);
        const slots = pages.flatMap((p) => p.slots.filter((s) => s.boxId === box.id));
        expect(slots.filter((s) => s.showFooter)).toHaveLength(1);
        expect(slots.at(-1)!.showFooter).toBe(true);
      }
      // 順序：頁面裡箱號出現的順序與輸入相同
      const seen = pages.flatMap((p) => p.slots.map((s) => s.boxId)).filter((id, i, all) => all.indexOf(id) === i);
      expect(seen).toEqual(boxes.map((b) => b.id));
      for (const p of pages) {
        expect(p.slots.length).toBeLessThanOrEqual(p.full ? 1 : 2);
        for (const s of p.slots) {
          const box = boxes.find((b) => b.id === s.boxId)!;
          const start = box.rows.indexOf(s.rows[0]!);
          const used = box.metrics.headH + s.rows.reduce((sum, _r, i) => sum + box.metrics.rowHs[start + i]!, 0) + (s.showFooter ? box.metrics.footH : 0);
          expect(used).toBeLessThanOrEqual(p.full ? LIMITS.full : LIMITS.half);
        }
      }
    }
  });
});

describe("排版輸出（HTML）", () => {
  const slot = (overrides: Partial<Slot> = {}): Slot => ({ boxId: "T1", rows: [{ barcode: "1801112756", name: "第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)", qty: 100 }], continued: false, showFooter: true, total: 100, ...overrides });

  it("格式照 Word 範本：箱號（合併三欄的大字列）→ 商品編號／商品名稱／數量 → 商品列 → 合計：N 件", () => {
    const table = OuterBoxLabel.renderTable(slot({ total: 200 }), escHtml);
    expect(table).toContain('<tr class="ob-title"><th colspan="3">箱號：T1</th></tr>');
    expect(table).toContain('<th class="ob-code">商品編號</th><th>商品名稱</th><th class="ob-qty">數量</th>');
    expect(table).toContain('<td class="ob-code">1801112756</td><td>第五代溫灸刷毛圓領發熱衣(男-陶玫粉2XL)</td><td class="ob-qty">100</td>');
    expect(table).toContain('<tr class="ob-total"><td colspan="3">合計：200 件</td></tr>');
  });

  it("三欄寬度用 <colgroup> 明確指定（第一列是 colspan 標題，fixed 版面不會看後面的列）", () => {
    const table = OuterBoxLabel.renderTable(slot(), escHtml);
    expect(table).toContain('<colgroup><col class="ob-col-code"><col class="ob-col-name"><col class="ob-col-qty"></colgroup>');
    expect(html).toMatch(/\.ob-col-code \{ width: 24%; \}\s*\.ob-col-name \{ width: 60%; \}\s*\.ob-col-qty \{ width: 16%; \}/);
  });

  it("接續段：標題是「箱號：T1（續）」，沒有合計列", () => {
    const table = OuterBoxLabel.renderTable(slot({ continued: true, showFooter: false }), escHtml);
    expect(table).toContain("箱號：T1（續）");
    expect(table).not.toContain("ob-total");
  });

  it("所有動態內容都經 escHtml（箱號、編號、品名）", () => {
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const table = OuterBoxLabel.renderTable(slot({ boxId: evil, rows: [{ barcode: evil, name: evil, qty: 1 }] }), escHtml);
    expect(table).not.toContain("<img");
    expect(table).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;");
  });

  it("一頁上下各一箱、中間一條裁切虛線；只有一個小箱時下半頁留空；整頁大箱沒有裁切線", () => {
    const pages: Page[] = [
      { full: false, slots: [slot({ boxId: "A" }), slot({ boxId: "B" })] },
      { full: false, slots: [slot({ boxId: "C" })] },
      { full: true, slots: [slot({ boxId: "D" })] },
    ];
    const out = OuterBoxLabel.renderPages(pages, escHtml);
    expect(out.match(/<section class="ob-page">/g)).toHaveLength(3);
    expect(out.match(/class="ob-cut"/g)).toHaveLength(2);
    expect(out.match(/<table class="ob-table">/g)).toHaveLength(4);
    expect(out.indexOf("箱號：A")).toBeLessThan(out.indexOf("class=\"ob-cut\""));
    expect(out.indexOf("class=\"ob-cut\"")).toBeLessThan(out.indexOf("箱號：B"));
    expect(out.match(/ob-slot-full/g)).toHaveLength(1);
  });
});

describe("從商品主檔載入別台裝置的箱子", () => {
  const raw = (boxId: string, closedAt: string, items: Array<Record<string, unknown>>) => ({ boxId, closedAt, items });
  const sItem = (barcode: string, qty: number, extra: Record<string, unknown> = {}) => ({ barcode, productName: "", gender: "", color: "", size: "", mergedName: "", qty, ...extra });
  const prod = (extra: Partial<{ productName: string; gender: string; color: string; size: string; officialName: string }> = {}) => ({ productName: "發熱衣", gender: "男", color: "黑", size: "L", officialName: "發熱衣(男-黑L)", ...extra });
  const lookupOf = (catalog: Record<string, ReturnType<typeof prod>>) =>
    vi.fn(async (codes: string[]): Promise<LookupResult> => ({ ok: true, products: new Map(codes.filter((c) => catalog[c]).map((c) => [c, catalog[c]!])) }));
  const rep = (extra: Record<string, unknown> = {}) => ({ barcode: "1", productName: "發熱衣", gender: "男", color: "黑", size: "L", mergedName: "", ...extra });

  it("品名規則：總表查得到且四欄（trim 後）相同 → 官方品名", () => {
    expect(OuterBoxLabel.sheetRowName(rep({ mergedName: "別的", productName: " 發熱衣 ", color: "黑 " }), prod())).toBe("發熱衣(男-黑L)");
  });

  it("品名規則：四欄有任何一欄不同（人員改過）→ 這一列的 mergedName", () => {
    for (const field of ["productName", "gender", "color", "size"]) {
      expect(OuterBoxLabel.sheetRowName(rep({ [field]: "被改過", mergedName: "我改的品名" }), prod()), field).toBe("我改的品名");
    }
  });

  it("品名規則：總表查不到、商品編號空白、查詢失敗（沒有 product）→ mergedName", () => {
    expect(OuterBoxLabel.sheetRowName(rep({ mergedName: "試算表品名" }), undefined)).toBe("試算表品名");
    expect(OuterBoxLabel.sheetRowName(rep({ barcode: "", mergedName: "無編號品名" }), null)).toBe("無編號品名");
  });

  it("品名規則：mergedName 空白 → 用 buildMergedName 組", () => {
    expect(OuterBoxLabel.sheetRowName(rep({ mergedName: "  " }), undefined)).toBe("發熱衣(男-黑L)");
    expect(OuterBoxLabel.sheetRowName(rep({ gender: "", color: "", size: "", mergedName: "" }), undefined)).toBe("發熱衣");
  });

  it("prepareSheet：同編號合併、數量加總且上限 9999；查得到且四欄相同的用官方品名、被改過的用 mergedName、編號空白不查", async () => {
    const [box] = OuterBoxLabel.loadSheetBoxes("2026-11-27", [
      raw("BOX-001", "2026-11-27 18:05:33", [
        sItem("1", 9000, { productName: "發熱衣", gender: "男", color: "黑", size: "L", mergedName: "試算表舊名" }),
        sItem("1", 5000, { productName: "發熱衣", gender: "男", color: "黑", size: "L" }),
        sItem("2", 3, { productName: "改過的", gender: "男", color: "黑", size: "L", mergedName: "改過的(男-黑L)" }),
        sItem("", 2, { productName: "無編號", mergedName: "無編號品名" }),
      ]),
    ]);
    const lookup = lookupOf({ "1": prod(), "2": prod() });
    const result = await OuterBoxLabel.prepareSheet([box!], { lookup });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(["1", "2"]); // 空白編號不查
    expect(result.lookupFailed).toBe(false);
    expect(result.boxes[0]!.rows).toEqual([
      { barcode: "", name: "無編號品名", qty: 2 },
      { barcode: "1", name: "發熱衣(男-黑L)", qty: 9999 },
      { barcode: "2", name: "改過的(男-黑L)", qty: 3 },
    ]);
    expect(result.boxes[0]!.total).toBe(9999 + 3 + 2);
  });

  it("prepareSheet：查詢失敗（回 ok:false 或丟例外）不擋列印，全部退回 mergedName／組出來的品名，並回報 lookupFailed", async () => {
    const [box] = OuterBoxLabel.loadSheetBoxes("2026-11-27", [raw("B", "", [sItem("1", 1, { mergedName: "A(男-黑L)", productName: "A" }), sItem("2", 1, { productName: "只有欄位", color: "紅" })])]);
    for (const lookup of [vi.fn(async (): Promise<LookupResult> => ({ ok: false })), vi.fn(async (): Promise<LookupResult> => { throw new Error("boom"); })]) {
      const result = await OuterBoxLabel.prepareSheet([box!], { lookup });
      expect(result.lookupFailed).toBe(true);
      expect(result.boxes[0]!.rows.map((r) => r.name)).toEqual(["A(男-黑L)", "只有欄位(紅)"]);
    }
  });

  it("prepareSheet：編號一次最多 200 個，450 個分成 200、200、50", async () => {
    const items = Array.from({ length: 450 }, (_, i) => sItem(String(1000 + i), 1, { productName: "x" }));
    const [box] = OuterBoxLabel.loadSheetBoxes("2026-11-27", [raw("B", "", items)]);
    const lookup = lookupOf({});
    await OuterBoxLabel.prepareSheet([box!], { lookup });
    expect(lookup.mock.calls.map((c) => c[0]!.length)).toEqual([200, 200, 50]);
  });

  it("同一個 boxId 出現多筆：各自有不同的鍵、可各自勾選；鍵不會和本機箱號相撞", () => {
    const boxes = OuterBoxLabel.loadSheetBoxes("2026-11-27", [
      raw("BOX-001", "2026-11-27 10:00:00", [sItem("1", 1)]),
      raw("BOX-001", "2026-11-27 11:00:00", [sItem("2", 1)]),
      raw("BOX-001", "2026-11-27 11:00:00", [sItem("3", 1)]),
      raw("BOX-001", "", [sItem("4", 1)]),
    ]);
    const keys = boxes.map((b) => b.key);
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).toBe("sheet:2026-11-27|BOX-001|2026-11-27 10:00:00|0");
    expect(keys.every((k) => k.startsWith("sheet:") && k !== "BOX-001")).toBe(true);
    let order: string[] = ["BOX-001"]; // 本機也有一箱叫 BOX-001
    for (const k of keys) order = OuterBoxLabel.toggleOrder(order, k, true);
    expect(order).toHaveLength(5);
    order = OuterBoxLabel.toggleOrder(order, keys[1]!, false);
    expect(order).toEqual(["BOX-001", keys[0], keys[2], keys[3]]);
  });

  it("loadSheetBoxes：數量夾在 1～9999、沒有商品的箱子與壞資料略過、不改動輸入", () => {
    const input = [raw("A", "", [sItem("1", 0), sItem("2", 123456), sItem("3", 2.9)]), raw("B", "", []), null, { boxId: "C" }];
    const snapshot = JSON.stringify(input);
    const boxes = OuterBoxLabel.loadSheetBoxes("2026-11-27", input);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.items.map((i) => i.qty)).toEqual([1, 9999, 2]);
    expect(OuterBoxLabel.summarize(boxes[0]!)).toEqual({ kinds: 3, pieces: 1 + 9999 + 2 });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(OuterBoxLabel.loadSheetBoxes("d", undefined)).toEqual([]);
  });

  it("重新載入會取代舊的一批：舊的從勾選順序拿掉，本機箱子的勾選不受影響", () => {
    const local: FBox[] = [
      { id: "T1", status: "closed", items: [item("1", 1)] },
      { id: "T2", status: "open", items: [item("2", 1)] },
    ];
    const first = OuterBoxLabel.loadSheetBoxes("2026-11-27", [raw("S1", "", [sItem("1", 1)]), raw("S2", "", [sItem("2", 1)])]);
    let order = OuterBoxLabel.pickAll(local, first, "all");
    expect(order).toEqual(["T1", "T2", first[0]!.key, first[1]!.key]);
    order = OuterBoxLabel.toggleOrder(order, "T1", false); // 本機只勾 T2
    const second = OuterBoxLabel.loadSheetBoxes("2026-11-27", [raw("S1", "", [sItem("1", 1)])]);
    order = OuterBoxLabel.dropKeys(order, first.map((b) => b.key));
    expect(order).toEqual(["T2"]); // 舊的一批全不在了；新載入的預設不勾
    expect(order).not.toContain(second[0]!.key);
    expect(OuterBoxLabel.dropKeys(["T1", "T2"], [])).toEqual(["T1", "T2"]);
  });

  it("全選＝本機可選的＋載入的；只選已完成＝本機已完成的＋載入的；空箱不選", () => {
    const local: FBox[] = [
      { id: "T1", status: "closed", items: [item("1", 1)] },
      { id: "T2", status: "open", items: [item("2", 1)] },
      { id: "T3", status: "closed", items: [] },
    ];
    const sheet = OuterBoxLabel.loadSheetBoxes("2026-11-27", [raw("S", "", [sItem("1", 1)])]);
    expect(OuterBoxLabel.pickAll(local, sheet, "all")).toEqual(["T1", "T2", sheet[0]!.key]);
    expect(OuterBoxLabel.pickAll(local, sheet, "closed")).toEqual(["T1", sheet[0]!.key]);
    expect(OuterBoxLabel.pickAll([], [], "all")).toEqual([]);
  });

  it("resolveOrder／mergePrepared：本機與載入的箱子依勾選順序交錯排版", () => {
    const local: FBox[] = [{ id: "T1", status: "closed", items: [item("1", 1)] }, { id: "T2", status: "closed", items: [item("2", 1)] }];
    const sheet = OuterBoxLabel.loadSheetBoxes("2026-11-27", [raw("T1", "", [sItem("1", 1)])]);
    const chosen = OuterBoxLabel.resolveOrder(["T2", sheet[0]!.key, "T1", "不存在", "sheet:不存在"], local, sheet);
    expect(chosen.map((c) => c.kind)).toEqual(["local", "sheet", "local"]);
    expect(OuterBoxLabel.mergePrepared(chosen, ["L-T2", "L-T1"], ["S-T1"])).toEqual(["L-T2", "S-T1", "L-T1"]);
  });

  it("關箱時間只顯示 HH:MM；空白或認不得的格式不顯示", () => {
    expect(OuterBoxLabel.formatClosedTime("2026-11-27 18:05:33")).toBe("18:05");
    expect(OuterBoxLabel.formatClosedTime("2026/11/27 9:05")).toBe("09:05");
    expect(OuterBoxLabel.formatClosedTime("")).toBe("");
    expect(OuterBoxLabel.formatClosedTime("   ")).toBe("");
    expect(OuterBoxLabel.formatClosedTime("亂寫")).toBe("");
  });

  it("台北時間（UTC+8）的今天：UTC 15:59:59 還是同一天、16:00:00 換日；跨月跨年也對", () => {
    expect(OuterBoxLabel.taipeiToday(Date.UTC(2026, 10, 27, 15, 59, 59))).toBe("2026-11-27");
    expect(OuterBoxLabel.taipeiToday(Date.UTC(2026, 10, 27, 16, 0, 0))).toBe("2026-11-28");
    expect(OuterBoxLabel.taipeiToday(Date.UTC(2026, 10, 27, 0, 0, 0))).toBe("2026-11-27");
    expect(OuterBoxLabel.taipeiToday(Date.UTC(2026, 11, 31, 16, 0, 0))).toBe("2027-01-01");
  });

  it("fetchSheetBoxes：成功整理成項目；失敗顯示 API 的 error，沒有 error 或格式不對就用固定句，不丟例外", async () => {
    const reply = (ok: boolean, body: unknown) => ({ post: vi.fn(async () => ({ ok, json: async () => body })) });
    const good = reply(true, { success: true, data: { date: "2026/11/27", boxes: [raw("B", "2026-11-27 10:00:00", [sItem("1", 2)])] } });
    const r = await OuterBoxLabel.fetchSheetBoxes(good, "2026-11-27");
    expect(good.post).toHaveBeenCalledWith("/api/boxes/lookup", { date: "2026-11-27" });
    expect(r.ok).toBe(true);
    expect(r.boxes).toHaveLength(1);
    expect((await OuterBoxLabel.fetchSheetBoxes(reply(false, { success: false, error: "商品主檔讀取失敗" }), "d"))).toEqual({ ok: false, error: "商品主檔讀取失敗" });
    const fixed = "無法讀取商品主檔，請稍後再試";
    expect(await OuterBoxLabel.fetchSheetBoxes(reply(false, { success: false }), "d")).toEqual({ ok: false, error: fixed });
    expect(await OuterBoxLabel.fetchSheetBoxes(reply(true, { success: true, data: {} }), "d")).toEqual({ ok: false, error: fixed });
    expect(await OuterBoxLabel.fetchSheetBoxes({ post: async () => ({ ok: false, json: async () => { throw new Error("not json"); } }) }, "d")).toEqual({ ok: false, error: fixed });
    expect(await OuterBoxLabel.fetchSheetBoxes({ post: async () => { throw new Error("offline"); } }, "d")).toEqual({ ok: false, error: fixed });
    expect(await OuterBoxLabel.fetchSheetBoxes(reply(true, { success: true, data: { boxes: [] } }), "d")).toEqual({ ok: true, boxes: [] });
  });
});

describe("index.html 的商品主檔載入接線（原始碼層級的檢查）", () => {
  const dialog = sliceBetween("// ========== Outer Box Print Dialog", "// ========== Helpers");

  it("本機沒有箱子也開得起來（不再因為沒有箱子就只跳提示），並有空狀態", () => {
    expect(dialog).not.toContain("目前沒有任何箱子");
    expect(dialog).toContain("這台裝置沒有箱子");
  });

  it("視窗有日期欄（預設台北今天）、載入按鈕、載入中／空結果文字、商品主檔標籤", () => {
    expect(dialog).toContain('type="date"');
    expect(dialog).toContain("OuterBoxLabel.taipeiToday(Date.now())");
    for (const text of ["載入中…", "這一天在商品主檔沒有已完成的箱子", "商品主檔", "別台裝置掃的箱子"]) expect(dialog).toContain(text);
    expect(dialog).toContain("OuterBoxLabel.fetchSheetBoxes(ApiClient, date)");
  });

  it("載入的箱子只活在視窗的記憶體：視窗程式碼沒有 persist()、Store、localStorage，也沒有寫進 state.boxes", () => {
    expect(dialog).not.toMatch(/persist\(/);
    expect(dialog).not.toMatch(/\bStore\b/);
    expect(dialog).not.toMatch(/localStorage/);
    expect(dialog).not.toMatch(/state\.boxes\s*(=|\.push|\.splice|\.unshift)/);
    expect(dialog).not.toMatch(/BoxManager\.(add|create|update|remove|close|rename)/);
    // 純邏輯也不碰儲存
    const logic = sliceBetween("// ========== OuterBoxLabel", "// ========== UI Logic").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(logic).not.toMatch(/localStorage|persist\(/);
  });

  it("載入的箱子的屬性插值與文字一律跳脫", () => {
    expect(dialog).toContain("escHtml(box.key)");
    expect(dialog).toContain("escHtml(box.id)");
    expect(dialog).toContain("escHtml(time)");
  });

  it("統計報表空狀態補一句說明，且列印時不印（no-print）", () => {
    expect(html.match(/這裡只顯示這台裝置掃描的資料；要印別台裝置掃的箱子，請按「列印外箱明細」從商品主檔載入。/g)).toHaveLength(2);
    expect(html).toContain('class="stats-empty-hint no-print"');
  });
});

describe("index.html 的外箱明細接線與樣式（原始碼層級的檢查）", () => {
  const styleText = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!.replace(/\/\*[\s\S]*?\*\//g, "");

  it("按鈕：統計報表、目前箱子橫幅、每個箱號的動作按鈕；既有的列印標籤單與統計列印保留", () => {
    expect(html).toContain('id="btn-print-outer-stats">列印外箱明細</button>');
    expect(html).toContain('id="btn-print-outer-current">列印外箱明細</button>');
    expect(html).toContain('id="btn-print-box">列印標籤單</button>');
    expect(html).toContain('id="btn-print">列印統計表</button>');
    expect(sliceBetween("function renderBoxTabs", "function startEditBox")).toContain("showOuterBoxDialog('box', box.id)");
    expect(html).toContain("showOuterBoxDialog('stats')");
  });

  it("選擇視窗：全選、只選已完成、全不選；空箱不能選（disabled）", () => {
    const dialog = sliceBetween("function showOuterBoxDialog", "async function printOuterBoxes");
    for (const label of ["全選", "只選已完成", "全不選"]) expect(dialog).toContain(label);
    expect(dialog).toContain("進行中");
    expect(dialog).toContain("已完成");
    expect(dialog).toContain("' disabled'");
    expect(dialog).toContain("escHtml(box.id)");
  });

  it("列印模式 print-mode-outerbox 納入 _setPrintMode 的清除清單；其他區塊在這個模式隱藏；@page 只在這個模式動態插入、結束時移除", () => {
    const manager = sliceBetween("// ========== PrintManager", "// ========== ProductFlow");
    expect(manager).toContain("document.body.classList.remove('print-mode-stats', 'print-mode-box', 'print-mode-outerbox');");
    expect(manager).toContain("pageStyle.id = 'outer-box-page-style';");
    expect(manager).toContain("@page { size: A4 portrait; margin: 10.5mm 8mm 8mm; }");
    expect(manager).toContain("document.getElementById('outer-box-page-style')");
    expect(styleText).not.toMatch(/@page/); // 靜態樣式表沒有 @page：既有兩種列印不受影響
    expect(styleText).toMatch(/body\.print-mode-outerbox \.main/);
    expect(styleText).toMatch(/body\.print-mode-outerbox #outer-box-print \{ display: block !important; \}/);
    expect(styleText).toMatch(/#outer-box-print \{ display: none; \}/);
  });

  it("不在 window.print() 之後立刻清掉列印模式；改在 afterprint 事件清", () => {
    const fn = sliceBetween("  printOuterBoxes(pagesHtml) {", "  endOuterBoxPrint()");
    expect(fn).toContain("window.print();");
    expect(fn).not.toContain("_setPrintMode(null)");
    expect(html).toContain("window.addEventListener('afterprint', () => PrintManager.endOuterBoxPrint());");
  });

  it("列印用的 DOM 在固定 id 的容器 #outer-box-print，產生後保留（沒有任何地方清空它）", () => {
    expect(html).toContain('<div id="outer-box-print"></div>');
    const clears = html.match(/getElementById\('outer-box-print'\)[^;]*;/g) ?? [];
    expect(clears).toEqual(["getElementById('outer-box-print').innerHTML = pagesHtml;"]);
  });

  it("字型堆疊以 Noto Sans CJK TC、Noto Sans TC 開頭；不載入任何外部資源", () => {
    expect(styleText).toMatch(/\.ob-page, \.ob-measure \{\s*font-family: "Noto Sans CJK TC", "Noto Sans TC", /);
    expect(html.match(/<link\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import|@font-face/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("量高度（measure）是唯一碰 DOM 的部分，用參數傳入的 doc；純邏輯區塊的頂層沒有 document／state／localStorage", () => {
    const block = sliceBetween("// ========== ProductFlow", "// ========== UI Logic").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block).not.toMatch(/localStorage/);
    expect(block).not.toMatch(/\bstate\b/);
    expect(block).not.toMatch(/\bwindow\b/);
    const withoutMeasure = block.slice(0, block.indexOf("  measure(doc, prepared, esc)"));
    expect(withoutMeasure).not.toMatch(/\bdocument\b/);
  });

  it("新區塊在 PrintManager 之後、UI Logic 之前，既有區塊標記沒被改名搬動", () => {
    const order = ["// ========== Store", "// ========== App State", "// ========== ApiClient", "// ========== OCREngine", "// ========== SaveEngine", "// ========== NotifyEngine", "// ========== CloseFlow", "// ========== PrintManager", "// ========== ProductFlow", "// ========== OuterBoxLabel", "// ========== UI Logic", "// ========== UserBar", "// ========== Init"].map((m) => html.indexOf(m));
    expect(order.every((n) => n > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
