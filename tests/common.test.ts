import { afterEach, describe, expect, it, vi } from "vitest";

import { sleep } from "../src/common.js";

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

  it("系統時鐘被往回調（Date.now 一直沒前進）：最多睡 3 輪就放棄，不會等很久", async () => {
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
