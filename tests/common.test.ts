import { afterEach, describe, expect, it, vi } from "vitest";

import { describeError, sleep } from "../src/common.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sleep（至少等 ms 毫秒）", () => {
  it("用 vitest 假計時器：時間到才完成，不會提早 resolve", async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = sleep(1000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it("ms 為 0 或負數：立刻完成，不排任何計時器", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    await sleep(0);
    await sleep(-5);
    expect(timer).not.toHaveBeenCalled();
  });

  it("計時器比 Date.now() 量到的時間早觸發時，補睡到真的滿 ms 為止", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      clock += delays.length === 1 ? (ms ?? 0) - 2 : (ms ?? 0); // 第一次提早 2 ms 觸發，之後準時
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    await sleep(100);
    expect(delays).toEqual([100, 2]); // 補睡剩下的 2 ms
    expect(clock).toBe(1_000_100); // 總共剛好 100 ms
  });

  it("系統時鐘在睡眠中途被往回調 1 小時：每輪最多睡 ms，最多 3 輪（不會睡上一小時）", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      // 第 1 輪：只前進了 50 ms（還差 50）；第 2 輪：時鐘被往回調 1 小時；第 3 輪：正常前進
      if (delays.length === 1) clock += 50;
      else if (delays.length === 2) clock -= 3_600_000;
      else clock += ms ?? 0;
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    await sleep(100);
    expect(delays).toEqual([100, 50, 100]); // 第 3 輪被夾限在 ms（100），而不是 3_600_050
    expect(Math.max(...delays)).toBeLessThanOrEqual(100);
  });

  it("系統時鐘卡住不動（Date.now 一直沒前進）：最多睡 3 輪就放棄，不會等很久", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => 1_000_000); // 時鐘卡住不動
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    await sleep(100);
    expect(delays).toEqual([100, 100, 100]);
  });
});

describe("describeError（log 用的簡短錯誤描述）", () => {
  it("只取名稱與訊息、最多 200 字；非 Error 轉成字串", () => {
    expect(describeError(new TypeError("fetch failed"))).toBe("TypeError: fetch failed");
    expect(describeError("純字串")).toBe("純字串");
    expect(describeError(new Error("x".repeat(500)))).toHaveLength(200);
    expect(describeError("y".repeat(500))).toHaveLength(200);
  });

  it("有 cause.code 時附在後面", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    expect(describeError(err)).toBe("TypeError: fetch failed (ECONNREFUSED)");
  });

  it("secrets 先整段換成 ***、之後才截斷：被截在 200 字邊界上的 token 也遮得到", () => {
    const token = "secret-token-abcdefghijklmnopqrstuvwxyz-0123456789";
    // 訊息前面 150 字、後面接 token：若先截斷到 200 字再遮罩，token 只剩殘缺前綴（前 50 字裡的 40 多字）就遮不掉
    const err = new Error(`${"x".repeat(150)} Bearer ${token}`);
    const text = describeError(err, [token]);
    expect(text).not.toContain("secret-token");
    expect(text).toContain("Bearer ***");
    expect(describeError(new Error(`a ${token} b ${token}`), [token])).toBe("Error: a *** b ***");
    expect(describeError(`${token}`, [token])).toBe("***");
  });

  it("空字串的 secret 被忽略（不會把整段文字炸成 ***）", () => {
    expect(describeError(new Error("abc"), ["", ""])).toBe("Error: abc");
  });
});
