import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "../src/common.js";
import {
  BOX_CLOSED_MAX_DETAIL_LINES,
  buildBoxClosedMessage,
  formatTaipeiTime,
  handleLineWebhookBody,
  LINE_MESSAGE_MAX_CHARS,
  LINE_PUSH_URL,
  LINE_REPLY_URL,
  notifyBoxClosed,
  parseBoxClosedInput,
  pushLineText,
  replyLineText,
  verifyLineSignature,
  type BoxClosedInput,
} from "../src/line.js";
import {
  createCapturingLogger,
  createFetchMock,
  jsonResponse,
  signLineBody,
  TEST_GROUP_ID,
  TEST_LINE_SECRET,
  TEST_LINE_TOKEN,
} from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const LS = String.fromCharCode(0x2028); // 行分隔符號（不要直接寫進原始碼）
const PS = String.fromCharCode(0x2029); // 段落分隔符號

/** 合法的最小請求內容；各測試在這個基礎上改欄位。 */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    boxId: "BOX-001",
    items: [{ barcode: "1801080204", productName: "第五代溫灸刷毛圓領發熱衣", gender: "女", color: "經典黑", size: "L", qty: 3 }],
    total: 1,
    successCount: 1,
    failedCount: 0,
    ...overrides,
  };
}

function parsed(overrides: Record<string, unknown> = {}): BoxClosedInput {
  return parseBoxClosedInput(validBody(overrides));
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { barcode: "1801080204", productName: "品名", gender: "", color: "", size: "", qty: 1, ...overrides };
}

describe("parseBoxClosedInput（輸入驗證）", () => {
  it("合法內容：整理成固定欄位（boxId 去前後空白、缺少的文字欄位當空字串、缺少 qty 當 1）", () => {
    const result = parseBoxClosedInput({
      boxId: "  BOX-001 ",
      closedAt: "2026-10-05T07:20:00.000Z",
      items: [{ barcode: "1801080204", productName: "A", gender: "男", color: "藍", size: "M", qty: 2 }, { barcode: "123" }, {}],
      total: 3,
      successCount: 2,
      failedCount: 1,
    });
    expect(result.boxId).toBe("BOX-001");
    expect(result.closedAt?.toISOString()).toBe("2026-10-05T07:20:00.000Z");
    expect(result.items).toEqual([
      { barcode: "1801080204", productName: "A", gender: "男", color: "藍", size: "M", qty: 2 },
      { barcode: "123", productName: "", gender: "", color: "", size: "", qty: 1 },
      { barcode: "", productName: "", gender: "", color: "", size: "", qty: 1 },
    ]);
    expect([result.total, result.successCount, result.failedCount]).toEqual([3, 2, 1]);
  });

  it("items 可以是空陣列；null 的文字欄位與 qty 視同缺少；數字型的文字欄位轉成字串", () => {
    expect(parsed({ items: [], total: 0, successCount: 0, failedCount: 0 }).items).toEqual([]);
    expect(parsed({ items: [{ barcode: 1801080204, productName: null, qty: null }] }).items).toEqual([
      { barcode: "1801080204", productName: "", gender: "", color: "", size: "", qty: 1 },
    ]);
  });

  it("closedAt：缺少、不是字串、解析不了、超長都當作沒給（改用伺服器時間），不會因此被拒絕", () => {
    for (const bad of [undefined, null, 123, "不是時間", "x".repeat(101), {}]) {
      expect(parsed({ closedAt: bad }).closedAt).toBeNull();
    }
  });

  it("closedAt 只接受 2000～2100 年：太極端的值（會讓台北時間溢位成 NaN）與太小的年份都當作沒給", () => {
    expect(parsed({ closedAt: "2000-01-01T00:00:00.000Z" }).closedAt?.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(parsed({ closedAt: "2100-12-31T23:59:59.999Z" }).closedAt).not.toBeNull();
    for (const bad of ["1999-12-31T23:59:59.999Z", "2101-01-01T00:00:00.000Z", "+275760-09-13T00:00:00.000Z", "-000001-01-01T00:00:00.000Z", "0099-01-01T00:00:00.000Z"]) {
      expect(parsed({ closedAt: bad }).closedAt).toBeNull();
    }
    // 因此訊息裡的時間一定是正常的格式
    const text = buildBoxClosedMessage(parsed({ closedAt: "+275760-09-13T00:00:00.000Z" }), new Date("2026-10-05T07:20:00.000Z"));
    expect(text.split("\n").at(-1)).toBe("時間：2026-10-05 15:20");
  });

  it("邊界值：boxId 100 字、items 500 筆、文字欄位 200 字、qty 1 與 9999 都通過", () => {
    expect(parsed({ boxId: "箱".repeat(100) }).boxId).toHaveLength(100);
    const many = Array.from({ length: 500 }, () => item());
    expect(parsed({ items: many }).items).toHaveLength(500);
    for (const key of ["barcode", "productName", "gender", "color", "size"]) {
      expect(parsed({ items: [item({ [key]: "字".repeat(200) })] }).items).toHaveLength(1);
    }
    expect(parsed({ items: [item({ qty: 1 }), item({ qty: 9999 })] }).items.map((i) => i.qty)).toEqual([1, 9999]);
  });

  const bad: Array<[string, unknown]> = [
    ["請求內容不是物件（字串）", "字串"],
    ["請求內容是陣列", []],
    ["請求內容是 null", null],
    ["缺少 boxId", validBody({ boxId: undefined })],
    ["boxId 是空字串", validBody({ boxId: "" })],
    ["boxId 只有空白", validBody({ boxId: "   " })],
    ["boxId 不是字串", validBody({ boxId: 123 })],
    ["boxId 超過 100 字", validBody({ boxId: "箱".repeat(101) })],
    ["缺少 items", validBody({ items: undefined })],
    ["items 不是陣列", validBody({ items: "x" })],
    ["items 超過 500 筆", validBody({ items: Array.from({ length: 501 }, () => item()) })],
    ["item 是 null", validBody({ items: [null] })],
    ["item 是陣列", validBody({ items: [[]] })],
    ["item 是字串", validBody({ items: ["x"] })],
    ["文字欄位是物件", validBody({ items: [item({ productName: { x: 1 } })] })],
    ["文字欄位是 true", validBody({ items: [item({ color: true })] })],
    ["文字欄位是陣列", validBody({ items: [item({ size: ["L"] })] })],
    ["barcode 超過 200 字", validBody({ items: [item({ barcode: "1".repeat(201) })] })],
    ["productName 超過 200 字", validBody({ items: [item({ productName: "字".repeat(201) })] })],
    ["gender 超過 200 字", validBody({ items: [item({ gender: "字".repeat(201) })] })],
    ["color 超過 200 字", validBody({ items: [item({ color: "字".repeat(201) })] })],
    ["size 超過 200 字", validBody({ items: [item({ size: "字".repeat(201) })] })],
    ["qty 是 0", validBody({ items: [item({ qty: 0 })] })],
    ["qty 是負數", validBody({ items: [item({ qty: -1 })] })],
    ["qty 超過 9999", validBody({ items: [item({ qty: 10000 })] })],
    ["qty 不是整數", validBody({ items: [item({ qty: 1.5 })] })],
    ["qty 是字串", validBody({ items: [item({ qty: "3" })] })],
    ["qty 是 true", validBody({ items: [item({ qty: true })] })],
    ["缺少 total", validBody({ total: undefined })],
    ["缺少 successCount", validBody({ successCount: undefined })],
    ["缺少 failedCount", validBody({ failedCount: undefined })],
    ["total 是負數", validBody({ total: -1 })],
    ["successCount 不是整數", validBody({ successCount: 1.5 })],
    ["failedCount 是字串", validBody({ failedCount: "0" })],
    ["total 大到不是安全整數", validBody({ total: 1e21 })],
    ["total 是 null", validBody({ total: null })],
  ];
  it.each(bad)("格式不正確回 400：%s", (_name, body) => {
    const error = (() => {
      try {
        parseBoxClosedInput(body);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBe(400);
  });
});

describe("formatTaipeiTime（台北時間 YYYY-MM-DD HH:mm）", () => {
  it("UTC+8", () => {
    expect(formatTaipeiTime(new Date("2026-10-05T07:20:00.000Z"))).toBe("2026-10-05 15:20");
  });

  it("跨日與午夜（小時是 00，不是 24）", () => {
    expect(formatTaipeiTime(new Date("2026-10-05T16:00:00.000Z"))).toBe("2026-10-06 00:00");
    expect(formatTaipeiTime(new Date("2026-10-05T15:59:59.999Z"))).toBe("2026-10-05 23:59");
    expect(formatTaipeiTime(new Date("2026-12-31T16:30:00.000Z"))).toBe("2027-01-01 00:30");
  });

  it("個位數的月、日、時、分補 0", () => {
    expect(formatTaipeiTime(new Date("2026-01-02T01:05:00.000Z"))).toBe("2026-01-02 09:05");
  });
});

describe("buildBoxClosedMessage（訊息版型）", () => {
  const fallback = new Date("2026-10-05T07:20:00.000Z");

  it("全部成功：照指定版型逐行輸出（含合併品名三種分支、種數與件數、台北時間）", () => {
    const input = parsed({
      closedAt: "2026-10-05T07:20:00.000Z",
      items: [
        item({ barcode: "1801080204", productName: "第五代溫灸刷毛圓領發熱衣", gender: "女", color: "經典黑", size: "L", qty: 3 }),
        item({ barcode: "1801472364", productName: "搖粒絨極暖衝鋒褲", gender: "", color: "星夜黑", size: "XL", qty: 2 }),
        item({ barcode: "1037720345", productName: "素面防曬排汗短版涼感衣", qty: 1 }),
      ],
      total: 3,
      successCount: 3,
      failedCount: 0,
    });
    expect(buildBoxClosedMessage(input, fallback)).toBe(
      [
        "📦 箱號 BOX-001 已完成",
        "共 3 種商品、6 件",
        "已同步 3/3 筆到商品主檔 ✓",
        "明細：",
        "1801080204 第五代溫灸刷毛圓領發熱衣(女-經典黑L) ×3",
        "1801472364 搖粒絨極暖衝鋒褲(星夜黑XL) ×2",
        "1037720345 素面防曬排汗短版涼感衣 ×1",
        "時間：2026-10-05 15:20",
      ].join("\n"),
    );
  });

  it("部分失敗：第 3 行改成警告文案", () => {
    const text = buildBoxClosedMessage(parsed({ total: 12, successCount: 10, failedCount: 2 }), fallback);
    expect(text.split("\n")[2]).toBe("⚠️ 同步 10/12 筆，2 筆失敗，請查核商品主檔");
    expect(text).not.toContain("✓");
  });

  it("全部失敗（successCount 0）也是警告文案", () => {
    expect(buildBoxClosedMessage(parsed({ total: 4, successCount: 0, failedCount: 4 }), fallback).split("\n")[2]).toBe(
      "⚠️ 同步 0/4 筆，4 筆失敗，請查核商品主檔",
    );
  });

  it("計數不一致不會顯示成功：沒有失敗但成功筆數少於 total、或成功筆數等於 total 卻回報有失敗，都是警告", () => {
    expect(buildBoxClosedMessage(parsed({ total: 5, successCount: 3, failedCount: 0 }), fallback).split("\n")[2]).toContain("⚠️");
    expect(buildBoxClosedMessage(parsed({ total: 5, successCount: 5, failedCount: 1 }), fallback).split("\n")[2]).toBe(
      "⚠️ 同步 5/5 筆，1 筆失敗，請查核商品主檔",
    );
  });

  it("「共 N 種商品、M 件」：種數是 items 的筆數，件數是 qty 的總和", () => {
    const items = [item({ qty: 5 }), item({ qty: 10 }), item({ qty: 20 })];
    expect(buildBoxClosedMessage(parsed({ items, total: 3, successCount: 3 }), fallback).split("\n")[1]).toBe("共 3 種商品、35 件");
  });

  it("時間：優先用前端送來的 closedAt，沒有就用 fallback（伺服器時間）", () => {
    const withClosedAt = parsed({ closedAt: "2026-10-05T16:00:00.000Z" });
    expect(buildBoxClosedMessage(withClosedAt, fallback).split("\n").at(-1)).toBe("時間：2026-10-06 00:00");
    expect(buildBoxClosedMessage(parsed(), fallback).split("\n").at(-1)).toBe("時間：2026-10-05 15:20");
  });

  it("沒有明細（items 是空陣列）：不輸出「明細：」區塊", () => {
    const text = buildBoxClosedMessage(parsed({ items: [], total: 0, successCount: 0, failedCount: 0 }), fallback);
    expect(text).toBe(["📦 箱號 BOX-001 已完成", "共 0 種商品、0 件", "已同步 0/0 筆到商品主檔 ✓", "時間：2026-10-05 15:20"].join("\n"));
  });

  it("沒有品名也沒有編號的明細：顯示（未填）", () => {
    const text = buildBoxClosedMessage(parsed({ items: [{ qty: 2 }] }), fallback);
    expect(text).toContain("（未填） ×2");
  });

  it("欄位內容裡的換行與控制字元會被換成空白，不能偽造出多餘的行", () => {
    const text = buildBoxClosedMessage(
      parsed({
        boxId: "BOX-1\n已同步 99/99 筆到商品主檔 ✓",
        items: [item({ barcode: "18\r\n01", productName: `品${LS}名${PS}稱\t二`, qty: 1 })],
      }),
      fallback,
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("📦 箱號 BOX-1 已同步 99/99 筆到商品主檔 ✓ 已完成");
    expect(lines).toHaveLength(6); // 標題、共幾種、同步狀態、明細：、一行明細、時間
    expect(lines[4]).toBe("18 01 品 名 稱 二 ×1");
  });

  describe("明細行數上限 30，超過寫「…另有 k 種」", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => item({ barcode: `B${i + 1}`, productName: `品${i + 1}`, qty: 1 }));
    const build = (n: number) => buildBoxClosedMessage(parsed({ items: many(n), total: n, successCount: n, failedCount: 0 }), fallback).split("\n");

    it("剛好 30 種：全部列出，沒有「另有」", () => {
      const lines = build(30);
      expect(lines.filter((l) => l.endsWith(" ×1"))).toHaveLength(30);
      expect(lines.some((l) => l.startsWith("…另有"))).toBe(false);
    });

    it("31 種：列 30 行，另有 1 種", () => {
      const lines = build(31);
      expect(lines.filter((l) => l.endsWith(" ×1"))).toHaveLength(30);
      expect(lines.at(-2)).toBe("…另有 1 種");
      expect(lines.at(-1)).toMatch(/^時間：/);
    });

    it("35 種：列 30 行，另有 5 種；列的是前 30 筆", () => {
      const lines = build(35);
      const details = lines.filter((l) => l.endsWith(" ×1"));
      expect(details).toHaveLength(30);
      expect(details[0]).toBe("B1 品1 ×1");
      expect(details[29]).toBe("B30 品30 ×1");
      expect(lines.at(-2)).toBe("…另有 5 種");
      expect(lines[1]).toBe("共 35 種商品、35 件"); // 件數與種數仍是全部的，不是只算列出的
      expect(BOX_CLOSED_MAX_DETAIL_LINES).toBe(30);
    });
  });

  describe("整則訊息不超過 4500 字：超過就先砍明細行數", () => {
    const longItem = (i: number) =>
      item({ barcode: `${i}`.padEnd(200, "0"), productName: "品".repeat(200), gender: "男".repeat(200), color: "色".repeat(200), size: "S".repeat(200), qty: 9999 });
    const text = buildBoxClosedMessage(
      parsed({ items: Array.from({ length: 40 }, (_, i) => longItem(i)), total: 40, successCount: 40, failedCount: 0 }),
      fallback,
    );
    const lines = text.split("\n");

    it("長度 ≤ 4500", () => {
      expect(LINE_MESSAGE_MAX_CHARS).toBe(4500);
      expect(text.length).toBeLessThanOrEqual(4500);
    });

    it("砍掉的行數算進「…另有 k 種」（列出的行數＋k＝40），而且還是列了幾行", () => {
      const detailCount = lines.filter((l) => l.endsWith(" ×9999")).length;
      expect(detailCount).toBeGreaterThan(0);
      expect(detailCount).toBeLessThan(30);
      expect(lines.at(-2)).toBe(`…另有 ${40 - detailCount} 種`);
    });

    it("標題、種數件數、同步狀態與時間都還在", () => {
      expect(lines[0]).toBe("📦 箱號 BOX-001 已完成");
      expect(lines[1]).toBe(`共 40 種商品、${40 * 9999} 件`);
      expect(lines[2]).toBe("已同步 40/40 筆到商品主檔 ✓");
      expect(lines.at(-1)).toBe("時間：2026-10-05 15:20");
    });

    it("字數邊界：剛好 4500 字不砍，4501 字就砍掉最後一行明細", () => {
      // 4 個最長的明細（每行約 1000 字）＋ 1 個可以調整長度的明細（品名 a 字、性別 190 字）：
      // a 每加 1，整則訊息就多 1 個字，所以「還放得下的最大 a」對應的長度一定剛好是 4500。
      const fixed = Array.from({ length: 4 }, (_, i) => longItem(i));
      const build = (a: number) =>
        buildBoxClosedMessage(
          parsed({
            items: [...fixed, item({ barcode: "TUNE", productName: "名".repeat(a), gender: "男".repeat(190), qty: 1 })],
            total: 5,
            successCount: 5,
            failedCount: 0,
          }),
          fallback,
        );
      let maxFit = -1;
      for (let a = 0; a <= 200; a++) {
        if (build(a).includes("TUNE")) maxFit = a;
      }
      expect(maxFit).toBeGreaterThan(0);
      expect(maxFit).toBeLessThan(200); // 200 字的品名放不下，所以邊界落在範圍內

      const atLimit = build(maxFit);
      expect(atLimit.length).toBe(4500); // 剛好 4500：5 行明細都在
      expect(atLimit.split("\n").some((l) => l.startsWith("…另有"))).toBe(false);

      const overLimit = build(maxFit + 1); // 4501：放不下，最後一行明細被砍
      expect(overLimit.length).toBeLessThanOrEqual(4500);
      expect(overLimit).not.toContain("TUNE");
      expect(overLimit.split("\n").at(-2)).toBe("…另有 1 種");
    });

    it("只砍到剛好夠，不多砍：剛好放得下的行數全部列出，再多一行才開始出現「另有」", () => {
      const detailCount = lines.filter((l) => l.endsWith(" ×9999")).length;
      const build = (n: number) =>
        buildBoxClosedMessage(
          parsed({ items: Array.from({ length: n }, (_, i) => longItem(i)), total: n, successCount: n, failedCount: 0 }),
          fallback,
        ).split("\n");
      const exactlyFits = build(detailCount); // 剛好放得下：全部列出，沒有「另有」
      expect(exactlyFits.filter((l) => l.endsWith(" ×9999"))).toHaveLength(detailCount);
      expect(exactlyFits.some((l) => l.startsWith("…另有"))).toBe(false);
      expect(exactlyFits.join("\n").length).toBeLessThanOrEqual(4500);
      const oneOver = build(detailCount + 1); // 多一行就放不下：維持列 detailCount 行，另有 1 種
      expect(oneOver.filter((l) => l.endsWith(" ×9999"))).toHaveLength(detailCount);
      expect(oneOver.at(-2)).toBe("…另有 1 種");
    });
  });
});

describe("pushLineText（推播）", () => {
  function setup(handler: Parameters<typeof createFetchMock>[0] = () => jsonResponse({})) {
    const { mock, calls } = createFetchMock(handler);
    const log = createCapturingLogger();
    return { deps: { fetchImpl: mock, log, token: TEST_LINE_TOKEN }, calls, log, mock };
  }

  it("POST https://api.line.me/v2/bot/message/push，Bearer token，body 是 {to, messages:[{type:text,text}]}，10 秒 timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const { deps, calls } = setup();
    expect(await pushLineText(deps, TEST_GROUP_ID, "哈囉\n世界")).toEqual({ ok: true });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.line.me/v2/bot/message/push");
    expect(call.url).toBe(LINE_PUSH_URL);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.body!)).toEqual({ to: TEST_GROUP_ID, messages: [{ type: "text", text: "哈囉\n世界" }] });
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy.mock.calls).toEqual([[10_000]]);
  });

  it.each([
    [401, "LINE channel access token 無效或已過期"],
    [400, "群組 ID 無效，或機器人不在該群組裡"],
    [403, "群組 ID 無效，或機器人不在該群組裡"],
    [429, "已達 LINE 推播額度或速率限制"],
    [500, "LINE 回應 HTTP 500"],
    [503, "LINE 回應 HTTP 503"],
  ])("LINE 回 %i：回傳固定的短句原因，不重試（只呼叫一次），log 有狀態碼", async (status, expected) => {
    const { deps, calls, log } = setup(() => jsonResponse({ message: "LINE 的原始錯誤說明 xyz" }, status));
    expect(await pushLineText(deps, TEST_GROUP_ID, "x")).toEqual({ ok: false, error: expected });
    expect(calls).toHaveLength(1); // 不重試（避免重複通知）
    expect(log.lines.join("\n")).toContain(`HTTP ${status}`);
  });

  it("回給前端的原因不含 LINE 的原始回應；log 不含 token（即使 LINE 的回應內文剛好回顯了 token 也會被蓋掉）", async () => {
    const { deps, log } = setup(() => jsonResponse({ message: `Authentication failed: ${TEST_LINE_TOKEN}` }, 401));
    const result = await pushLineText(deps, TEST_GROUP_ID, "x");
    expect(result).toEqual({ ok: false, error: "LINE channel access token 無效或已過期" });
    const logged = log.lines.join("\n");
    expect(logged).not.toContain(TEST_LINE_TOKEN);
    expect(logged).toContain("Authentication failed: ***");
  });

  it("LINE 回應不是 JSON：照常回傳失敗原因", async () => {
    const { deps } = setup(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await pushLineText(deps, TEST_GROUP_ID, "x")).toEqual({ ok: false, error: "LINE 回應 HTTP 502" });
  });

  it("連線錯誤的訊息很長、token 剛好落在 200 字邊界上：log 仍遮得到（先遮罩再截斷）", async () => {
    const err = new TypeError(`${"x".repeat(150)} Authorization: Bearer ${TEST_LINE_TOKEN}`);
    const { deps, log } = setup(() => {
      throw err;
    });
    await pushLineText(deps, TEST_GROUP_ID, "x");
    const logged = log.lines.join("\n");
    expect(logged).not.toContain(TEST_LINE_TOKEN);
    expect(logged).not.toContain("test-line-access"); // 連殘缺的前綴也不能出現
    expect(logged).toContain("Bearer ***");
  });

  it("連線錯誤或逾時：回傳失敗（不丟例外、不重試），log 不含 token", async () => {
    for (const failure of [new TypeError("fetch failed"), new DOMException("The operation was aborted due to timeout", "TimeoutError")]) {
      const { deps, calls, log } = setup(() => {
        throw failure;
      });
      expect(await pushLineText(deps, TEST_GROUP_ID, "x")).toEqual({ ok: false, error: "連線 LINE 失敗或逾時" });
      expect(calls).toHaveLength(1);
      expect(log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);
      expect(log.lines).toHaveLength(1);
    }
  });
});

describe("replyLineText（用 replyToken 回覆）", () => {
  it("POST https://api.line.me/v2/bot/message/reply，body 是 {replyToken, messages:[{type:text,text}]}", async () => {
    const { mock, calls } = createFetchMock(() => jsonResponse({}));
    const log = createCapturingLogger();
    expect(await replyLineText({ fetchImpl: mock, log, token: TEST_LINE_TOKEN }, "reply-token-1", "你好")).toBe(true);
    const call = calls[0]!;
    expect(call.url).toBe(LINE_REPLY_URL);
    expect(call.url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(call.headers.authorization).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    expect(JSON.parse(call.body!)).toEqual({ replyToken: "reply-token-1", messages: [{ type: "text", text: "你好" }] });
  });

  it("失敗只回 false 並寫 log（不丟例外、log 不含 token）", async () => {
    const log = createCapturingLogger();
    const http = createFetchMock(() => jsonResponse({ message: "Invalid reply token" }, 400));
    expect(await replyLineText({ fetchImpl: http.mock, log, token: TEST_LINE_TOKEN }, "t", "x")).toBe(false);
    expect(log.lines.join("\n")).toContain("HTTP 400 Invalid reply token");
    const net = createFetchMock(() => {
      throw new TypeError("fetch failed");
    });
    expect(await replyLineText({ fetchImpl: net.mock, log, token: TEST_LINE_TOKEN }, "t", "x")).toBe(false);
    expect(log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);
  });
});

describe("notifyBoxClosed（關箱通知）", () => {
  const now = () => Date.parse("2026-10-05T07:20:00.000Z");
  function setup(config: { token?: string; groupId?: string }, handler: Parameters<typeof createFetchMock>[0] = () => jsonResponse({})) {
    const { mock, calls } = createFetchMock(handler);
    const log = createCapturingLogger();
    const deps = { fetchImpl: mock, log, token: config.token ?? "", groupId: config.groupId ?? "", now };
    return { deps, calls, log };
  }

  it.each([
    ["token 與群組 ID 都沒設定", { token: "", groupId: "" }],
    ["只有 token", { token: TEST_LINE_TOKEN, groupId: "" }],
    ["只有群組 ID", { token: "", groupId: TEST_GROUP_ID }],
  ])("%s：靜默略過（not_configured）——不呼叫 LINE、不寫 log", async (_name, config) => {
    const { deps, calls, log } = setup(config);
    expect(await notifyBoxClosed(deps, parsed())).toEqual({ notified: false, reason: "not_configured" });
    expect(calls).toHaveLength(0);
    expect(log.lines).toEqual([]);
  });

  it("設定好：推播到群組，訊息時間在前端沒送 closedAt 時用 now()", async () => {
    const { deps, calls } = setup({ token: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID });
    expect(await notifyBoxClosed(deps, parsed())).toEqual({ notified: true });
    const body = JSON.parse(calls[0]!.body!) as { to: string; messages: Array<{ text: string }> };
    expect(body.to).toBe(TEST_GROUP_ID);
    expect(body.messages[0]!.text.split("\n").at(-1)).toBe("時間：2026-10-05 15:20");
  });

  it("推播失敗：回 push_failed 與簡短原因（不丟例外）", async () => {
    const { deps } = setup({ token: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID }, () => jsonResponse({}, 401));
    expect(await notifyBoxClosed(deps, parsed())).toEqual({
      notified: false,
      reason: "push_failed",
      error: "LINE channel access token 無效或已過期",
    });
  });

  it("組字時出了預期外的錯誤：照樣回 push_failed，不丟例外、log 不含 token", async () => {
    const { deps, log } = setup({ token: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID });
    const broken = { ...parsed(), items: null } as unknown as BoxClosedInput; // 模擬不該發生的壞資料
    expect(await notifyBoxClosed(deps, broken)).toEqual({ notified: false, reason: "push_failed", error: "通知處理發生錯誤" });
    expect(log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);
    expect(log.lines).toHaveLength(1);
  });
});

describe("verifyLineSignature（webhook 簽章）", () => {
  const body = JSON.stringify({ events: [{ type: "message", message: { type: "text", text: "群組ID 🙂" } }] });

  it("對原始 body 的 HMAC-SHA256（base64）正確才通過", () => {
    expect(verifyLineSignature(Buffer.from(body), signLineBody(body), TEST_LINE_SECRET)).toBe(true);
  });

  it("body 含多位元組字元（中文、emoji）時，用原始位元組驗簽仍正確", () => {
    const bytes = Buffer.from(body, "utf8");
    expect(verifyLineSignature(bytes, signLineBody(bytes), TEST_LINE_SECRET)).toBe(true);
  });

  it.each([
    ["簽章是別的內容的", signLineBody("別的內容")],
    ["簽章是用別的 secret 算的", signLineBody(body, "another-secret")],
    ["簽章被改一個字元", signLineBody(body).replace(/.$/, (c) => (c === "A" ? "B" : "A"))],
    ["簽章長度不同", "abc"],
    ["簽章是空字串", ""],
    ["簽章含非 ASCII 字元", "簽章簽章簽章簽章簽章簽章簽章簽章簽章簽章簽章簽章簽章簽章簽章簽章簽章"],
  ])("不通過：%s", (_name, signature) => {
    expect(verifyLineSignature(Buffer.from(body), signature, TEST_LINE_SECRET)).toBe(false);
  });

  it("沒有簽章標頭或 secret 是空字串：不通過", () => {
    expect(verifyLineSignature(Buffer.from(body), undefined, TEST_LINE_SECRET)).toBe(false);
    expect(verifyLineSignature(Buffer.from(body), signLineBody(body, ""), "")).toBe(false);
  });

  it("body 被改過：不通過", () => {
    expect(verifyLineSignature(Buffer.from(body + " "), signLineBody(body), TEST_LINE_SECRET)).toBe(false);
  });
});

describe("handleLineWebhookBody（取得群組 ID 的事件處理）", () => {
  function setup(token = TEST_LINE_TOKEN) {
    const { mock, calls } = createFetchMock(() => jsonResponse({}));
    const log = createCapturingLogger();
    return { deps: { fetchImpl: mock, log, token }, calls, log };
  }
  const groupSource = { type: "group", groupId: TEST_GROUP_ID, userId: "U0123456789abcdef0123456789abcdef" };
  const body = (...events: unknown[]) => JSON.stringify({ destination: "Uxxx", events });
  const replyBody = (calls: Array<{ body?: string }>) => JSON.parse(calls[0]!.body!) as { replyToken: string; messages: Array<{ type: string; text: string }> };

  it("join（bot 被加進群組）：回覆已加入與群組 ID，並寫一行 log", async () => {
    const { deps, calls, log } = setup();
    await handleLineWebhookBody(deps, body({ type: "join", replyToken: "rt-join", source: groupSource }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(LINE_REPLY_URL);
    expect(replyBody(calls)).toEqual({
      replyToken: "rt-join",
      messages: [{ type: "text", text: `已加入，此群組 ID：${TEST_GROUP_ID}。請把它設定到 LINE_GROUP_ID。` }],
    });
    expect(log.lines).toContain(`[line] 事件 join 來自 group ${TEST_GROUP_ID}`);
  });

  it.each(["群組ID", "群組 ID", " 群組ID ", "群組　ID", "群組id", "群 組 I D", "\n群組ID\n"])("群組裡傳「%s」：回覆此群組 ID", async (text) => {
    const { deps, calls, log } = setup();
    await handleLineWebhookBody(deps, body({ type: "message", replyToken: "rt-msg", source: groupSource, message: { type: "text", text } }));
    expect(calls).toHaveLength(1);
    expect(replyBody(calls)).toEqual({ replyToken: "rt-msg", messages: [{ type: "text", text: `此群組 ID：${TEST_GROUP_ID}` }] });
    expect(log.lines).toContain(`[line] 事件 message 來自 group ${TEST_GROUP_ID}`);
  });

  it.each([
    ["文字不是關鍵字", { type: "message", replyToken: "r", source: groupSource, message: { type: "text", text: "大家好" } }],
    ["關鍵字後面還有別的字", { type: "message", replyToken: "r", source: groupSource, message: { type: "text", text: "群組ID是多少" } }],
    ["不是文字訊息（貼圖）", { type: "message", replyToken: "r", source: groupSource, message: { type: "sticker", text: "群組ID" } }],
    ["文字不是字串", { type: "message", replyToken: "r", source: groupSource, message: { type: "text", text: 123 } }],
    ["leave 事件", { type: "leave", source: groupSource }],
    ["memberJoined 事件", { type: "memberJoined", replyToken: "r", source: groupSource }],
    ["個人對話（不是群組）說群組ID", { type: "message", replyToken: "r", source: { type: "user", userId: "Uabc" }, message: { type: "text", text: "群組ID" } }],
    ["聊天室（room）說群組ID", { type: "message", replyToken: "r", source: { type: "room", roomId: "Rabc" }, message: { type: "text", text: "群組ID" } }],
    ["沒有 source", { type: "join", replyToken: "r" }],
    ["群組 ID 格式不對", { type: "join", replyToken: "r", source: { type: "group", groupId: "C 帶空白\n的 id" } }],
    ["群組 ID 不是字串", { type: "join", replyToken: "r", source: { type: "group", groupId: 123 } }],
    ["join 但沒有 replyToken", { type: "join", source: groupSource }],
    ["事件不是物件", "字串"],
    ["事件是 null", null],
  ])("其他事件一律忽略（不呼叫 reply API）：%s", async (_name, event) => {
    const { deps, calls } = setup();
    await handleLineWebhookBody(deps, body(event));
    expect(calls).toHaveLength(0);
  });

  it("被忽略的事件完全不寫 log（群組裡一般的聊天訊息不會洗版）；處理到的事件才各寫一行", async () => {
    const { deps, log } = setup();
    await handleLineWebhookBody(
      deps,
      body(
        { type: "message", replyToken: "r0", source: groupSource, message: { type: "text", text: "大家好" } },
        { type: "leave", source: groupSource },
        { type: "x\ny", source: groupSource },
      ),
    );
    expect(log.lines).toEqual([]);

    await handleLineWebhookBody(
      deps,
      body(
        { type: "join", replyToken: "r1", source: groupSource },
        { type: "message", replyToken: "r2", source: groupSource, message: { type: "text", text: "群組ID" } },
      ),
    );
    expect(log.lines).toEqual([`[line] 事件 join 來自 group ${TEST_GROUP_ID}`, `[line] 事件 message 來自 group ${TEST_GROUP_ID}`]);
  });

  it("沒有設定 token：沒辦法回覆，不呼叫 LINE，但 log 有群組 ID 與提醒", async () => {
    const { deps, calls, log } = setup("");
    await handleLineWebhookBody(deps, body({ type: "join", replyToken: "r", source: groupSource }));
    expect(calls).toHaveLength(0);
    expect(log.lines[0]).toBe(`[line] 事件 join 來自 group ${TEST_GROUP_ID}`);
    expect(log.lines[1]).toContain("LINE_CHANNEL_ACCESS_TOKEN 未設定");
  });

  it("一次帶多個事件：依序處理；其中一個回覆失敗不影響後面的", async () => {
    let n = 0;
    const { mock, calls } = createFetchMock(() => {
      if (++n === 1) throw new TypeError("fetch failed");
      return jsonResponse({});
    });
    const log = createCapturingLogger();
    await handleLineWebhookBody(
      { fetchImpl: mock, log, token: TEST_LINE_TOKEN },
      body({ type: "join", replyToken: "r1", source: groupSource }, { type: "message", replyToken: "r2", source: groupSource, message: { type: "text", text: "群組ID" } }),
    );
    expect(calls.map((c) => (JSON.parse(c.body!) as { replyToken: string }).replyToken)).toEqual(["r1", "r2"]);
  });

  it("一次最多處理 100 個事件，超過的忽略", async () => {
    const { deps, calls } = setup();
    const many = Array.from({ length: 150 }, (_, i) => ({ type: "join", replyToken: `rt-${i}`, source: groupSource }));
    await handleLineWebhookBody(deps, body(...many));
    expect(calls).toHaveLength(100);
    expect((JSON.parse(calls[99]!.body!) as { replyToken: string }).replyToken).toBe("rt-99");
  });

  it("內容不是有效的 JSON、events 不是陣列、沒有 events（LINE 的 Verify 會送空的 events）：忽略，不丟例外", async () => {
    const { deps, calls, log } = setup();
    await handleLineWebhookBody(deps, "這不是 JSON");
    expect(log.lines.join("\n")).toContain("不是有效的 JSON");
    await handleLineWebhookBody(deps, JSON.stringify({ events: "x" }));
    await handleLineWebhookBody(deps, JSON.stringify({ events: [] }));
    await handleLineWebhookBody(deps, JSON.stringify(null));
    await handleLineWebhookBody(deps, "[]");
    expect(calls).toHaveLength(0);
  });
});
