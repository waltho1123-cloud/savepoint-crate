import { describe, expect, it } from "vitest";

import { firstPublicIp, FixedWindowLimiter, getClientIp } from "../src/rate-limit.js";

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
