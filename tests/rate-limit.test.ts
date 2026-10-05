import { describe, expect, it, vi } from "vitest";

import { ConcurrencyGate, firstPublicIp, FixedWindowLimiter, getClientIp } from "../src/rate-limit.js";

describe("FixedWindowLimiter", () => {
  it("視窗內超過上限就拒絕，視窗結束後重新計算", () => {
    const limiter = new FixedWindowLimiter(3, 60_000);
    expect(limiter.hit("a", 0).allowed).toBe(true);
    expect(limiter.hit("a", 1000).allowed).toBe(true);
    expect(limiter.hit("a", 2000).allowed).toBe(true);
    const denied = limiter.hit("a", 3000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(57);
    expect(limiter.hit("a", 59_999).allowed).toBe(false);
    expect(limiter.hit("a", 60_000).allowed).toBe(true); // 新視窗
  });

  it("不同 key 各自計算", () => {
    const limiter = new FixedWindowLimiter(1, 60_000);
    expect(limiter.hit("a", 0).allowed).toBe(true);
    expect(limiter.hit("b", 0).allowed).toBe(true);
    expect(limiter.hit("a", 1).allowed).toBe(false);
  });

  it("來源很多時會清掉過期視窗（不會無限成長）", () => {
    const limiter = new FixedWindowLimiter(1, 1000);
    for (let i = 0; i < 5100; i++) limiter.hit(`ip-${i}`, 0);
    // 超過 5000 筆後的下一次 hit 會清理已過期的視窗；之後舊 key 重新開始計算
    expect(limiter.hit("ip-0", 5000).allowed).toBe(true);
    expect((limiter as unknown as { records: Map<string, unknown> }).records.size).toBeLessThan(5100);
  });
});

describe("getClientIp（Zeabur 反向代理把真實 IP 附加在 X-Forwarded-For 最右邊）", () => {
  it("取最右邊的公開位址，左邊客戶端自填的值不可信", () => {
    expect(getClientIp("203.0.113.9", "10.0.0.1")).toBe("203.0.113.9");
    expect(getClientIp("1.2.3.4, 203.0.113.9", undefined)).toBe("203.0.113.9");
    expect(getClientIp("198.51.100.1, 1.2.3.4, 203.0.113.9", undefined)).toBe("203.0.113.9");
  });

  it("略過私有／內部位址與格式錯誤的項目，繼續往左找", () => {
    expect(getClientIp("203.0.113.9, 10.1.2.3", undefined)).toBe("203.0.113.9");
    expect(getClientIp("203.0.113.9, 192.168.0.5, 172.16.0.1, 127.0.0.1, 100.64.0.1", undefined)).toBe("203.0.113.9");
    expect(getClientIp("203.0.113.9, not-an-ip", undefined)).toBe("203.0.113.9");
  });

  it("支援 IPv6，並略過 ::1、fc00::/7、fe80::/10 與 IPv4-mapped 私有位址", () => {
    expect(getClientIp("2001:db8::1", undefined)).toBe("2001:db8::1");
    expect(getClientIp("2001:db8::1, ::1, fd00::1, fe80::1, ::ffff:10.0.0.1", undefined)).toBe("2001:db8::1");
    expect(firstPublicIp("::ffff:203.0.113.5")).toBe("::ffff:203.0.113.5");
  });

  it("IPv6 zone id（%…）一律略過：不能讓客戶端用任意後綴自創限流 key，也不會被回顯", () => {
    expect(firstPublicIp("2001:db8::1%eth0")).toBeNull();
    expect(firstPublicIp("2001:db8::1%aaaa-attacker.controlled:text")).toBeNull();
    expect(getClientIp("2001:db8::1%a", "198.51.100.7")).toBe("198.51.100.7");
    // 最右邊是 zone id 位址時，繼續往左找真正的公開位址
    expect(getClientIp("203.0.113.9, 2001:db8::1%a", undefined)).toBe("203.0.113.9");
  });

  it("沒有 X-Forwarded-For 或整串都不是公開位址：退回連線位址，再退回 unknown", () => {
    expect(getClientIp(undefined, "127.0.0.1")).toBe("127.0.0.1");
    expect(getClientIp("10.0.0.1, 192.168.1.1", "172.20.0.3")).toBe("172.20.0.3");
    expect(getClientIp("", undefined)).toBe("unknown");
    expect(firstPublicIp("garbage, , ")).toBeNull();
  });
});

describe("FixedWindowLimiter：整理（prune）不會每次 hit 都全表掃描，記錄數有上限", () => {
  const privateOf = (limiter: FixedWindowLimiter) => limiter as unknown as { prune: (now: number) => void; records: Map<string, unknown> };

  it("來源很多時，整理最多每秒一次（偽造 X-Forwarded-For 灌大量 key 也不會把事件迴圈卡住）", () => {
    const limiter = new FixedWindowLimiter(10, 60_000);
    const prune = vi.spyOn(privateOf(limiter), "prune");
    for (let i = 0; i < 6000; i++) limiter.hit(`ip-${i}`, 0);
    expect(prune).toHaveBeenCalledTimes(1); // 剛超過 5000 筆那一次
    for (let i = 0; i < 1000; i++) limiter.hit(`more-${i}`, 999);
    expect(prune).toHaveBeenCalledTimes(1); // 1 秒內不再整理
    limiter.hit("later", 1000);
    expect(prune).toHaveBeenCalledTimes(2);
    limiter.hit("later-2", 1500);
    expect(prune).toHaveBeenCalledTimes(2);
    limiter.hit("later-3", 2000);
    expect(prune).toHaveBeenCalledTimes(3);
  });

  it("6 萬個不同的 key 連續 hit 在 2 秒內完成（以前每次都掃全表，累計約 7.7 秒）", () => {
    const limiter = new FixedWindowLimiter(10, 60_000);
    const started = performance.now();
    for (let i = 0; i < 60_000; i++) limiter.hit(`ip-${i}`, 5);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("記錄數硬上限 5 萬：下一次整理時丟掉最舊的，新的與沒被丟的照常計算", () => {
    const limiter = new FixedWindowLimiter(1, 60_000);
    for (let i = 0; i < 60_000; i++) limiter.hit(`ip-${i}`, 0);
    expect(privateOf(limiter).records.size).toBe(60_000); // 還沒到下一次整理，先不動
    limiter.hit("newcomer", 1000); // 整理：丟掉最舊的 1 萬個
    const records = privateOf(limiter).records;
    expect(records.size).toBe(50_001);
    expect(records.has("ip-0")).toBe(false);
    expect(records.has("ip-9999")).toBe(false);
    expect(records.has("ip-10000")).toBe(true);
    expect(records.has("ip-59999")).toBe(true);
    expect(records.has("newcomer")).toBe(true);
    // 沒被丟掉的 key 仍然記得自己用過額度；被丟掉的重新開始
    expect(limiter.hit("ip-59999", 1001).allowed).toBe(false);
    expect(limiter.hit("ip-0", 1001).allowed).toBe(true);
  });

  it("過期的視窗先清掉：沒超過上限就不會丟還沒過期的", () => {
    const limiter = new FixedWindowLimiter(1, 1000);
    for (let i = 0; i < 5100; i++) limiter.hit(`old-${i}`, 0);
    for (let i = 0; i < 10; i++) limiter.hit(`fresh-${i}`, 2000); // 2 秒後：舊的都過期了，整理時清掉
    const records = privateOf(limiter).records;
    expect(records.size).toBeLessThan(100);
    expect(records.has("fresh-0")).toBe(true);
  });
});

describe("ConcurrencyGate（限制同時進行的重運算數量）", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("同時最多 maxActive 個在跑，其餘排隊、先進先出，全部都會執行完", async () => {
    const gate = new ConcurrencyGate(2, 100);
    let running = 0;
    let peak = 0;
    const startOrder: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) => {
      const d = deferred();
      const result = gate.run(async () => {
        startOrder.push(i);
        running += 1;
        peak = Math.max(peak, running);
        await d.promise;
        running -= 1;
        return i;
      });
      return { d, result };
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(startOrder).toEqual([0, 1]); // 一開始只有前兩個在跑
    expect(gate.load).toEqual({ active: 2, queued: 8 });
    for (const task of tasks) {
      task.d.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }
    const results = await Promise.all(tasks.map((t) => t.result));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => (r.ok ? r.value : -1))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(startOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // 先進先出
    expect(peak).toBe(2);
    expect(gate.load).toEqual({ active: 0, queued: 0 });
  });

  it("排隊也滿了（maxQueue）就直接拒絕，回 { ok:false }，不執行、不影響已經在跑與排隊中的", async () => {
    const gate = new ConcurrencyGate(1, 1);
    const first = deferred();
    const ran: string[] = [];
    const a = gate.run(async () => {
      ran.push("a");
      await first.promise;
    });
    const b = gate.run(async () => void ran.push("b"));
    await new Promise((r) => setTimeout(r, 1));
    expect(gate.load).toEqual({ active: 1, queued: 1 });
    const c = await gate.run(async () => void ran.push("c"));
    expect(c).toEqual({ ok: false });
    expect(gate.load).toEqual({ active: 1, queued: 1 });
    first.resolve();
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect(ran).toEqual(["a", "b"]);
    // 恢復之後又可以用
    expect((await gate.run(async () => 42))).toEqual({ ok: true, value: 42 });
  });

  it("maxQueue 為 0：沒有空位就直接拒絕", async () => {
    const gate = new ConcurrencyGate(1, 0);
    const hold = deferred();
    const a = gate.run(() => hold.promise);
    await new Promise((r) => setTimeout(r, 1));
    expect(await gate.run(async () => 1)).toEqual({ ok: false });
    hold.resolve();
    await a;
  });

  it("fn 丟例外：例外原樣丟出，名額一定歸還（後面排隊的與之後的都能執行）", async () => {
    const gate = new ConcurrencyGate(1, 5);
    const hold = deferred();
    const failing = gate.run(async () => {
      await hold.promise;
      throw new Error("boom");
    });
    const next = gate.run(async () => "after");
    await new Promise((r) => setTimeout(r, 1));
    hold.resolve();
    await expect(failing).rejects.toThrow("boom");
    expect(await next).toEqual({ ok: true, value: "after" });
    expect(gate.load).toEqual({ active: 0, queued: 0 });
    expect(await gate.run(async () => "again")).toEqual({ ok: true, value: "again" });
  });

  it("名額交棒給排隊的人時 active 不會多算或少算（連續大量進出後歸零）", async () => {
    const gate = new ConcurrencyGate(3, 1000);
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => gate.run(async () => i)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(gate.load).toEqual({ active: 0, queued: 0 });
  });
});
