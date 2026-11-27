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
