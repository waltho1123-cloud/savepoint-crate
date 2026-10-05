import { isIP } from "node:net";

/**
 * 簡單的記憶體內固定視窗限流（單一實例；服務重啟就清空，這裡不需要持久化）。
 */
export class FixedWindowLimiter {
  private readonly records = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /**
   * 記一次請求。回傳 allowed=false 代表這個 key 在目前視窗內已超過額度（應回 429），
   * retryAfterSeconds 是距離視窗結束還有幾秒（至少 1）。
   */
  hit(key: string, now: number = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    if (this.records.size > 5000) this.prune(now);
    let record = this.records.get(key);
    if (!record || now - record.windowStart >= this.windowMs) {
      record = { count: 0, windowStart: now };
      this.records.set(key, record);
    }
    record.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((record.windowStart + this.windowMs - now) / 1000));
    return { allowed: record.count <= this.max, retryAfterSeconds };
  }

  /** 清掉已過期的視窗，避免來源 IP 很多時 Map 無限成長。 */
  private prune(now: number): void {
    for (const [key, record] of this.records) {
      if (now - record.windowStart >= this.windowMs) this.records.delete(key);
    }
  }
}

function isPrivateIPv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10（CGNAT）
    (a === 169 && b === 254) || // link-local
    a === 0
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  if (lower === "::1" || lower === "::") return true;
  const first = lower.split(":")[0] ?? "";
  if (first.length === 4 && first.startsWith("f")) {
    if (first[1] === "c" || first[1] === "d") return true; // fc00::/7
    if (first[1] === "e" && "89ab".includes(first[2] ?? "")) return true; // fe80::/10
  }
  return false;
}

/** 由右往左找 X-Forwarded-For 裡第一個格式正確、非私有／內部位址的項目；找不到回 null。 */
export function firstPublicIp(xForwardedFor: string): string | null {
  const entries = xForwardedFor.split(",").map((entry) => entry.trim());
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i];
    if (!candidate) continue;
    // IPv6 的 zone id（例如 fe80::1%eth0）不是代理附加的真實來源位址；node:net 的 isIP() 卻會接受它，
    // 任意 "%…" 後綴會讓客戶端自創無限多個限流 key，也會讓 /healthz 把客戶端給的字串原樣回顯，所以一律略過。
    if (candidate.includes("%")) continue;
    const version = isIP(candidate);
    if (version === 4 && !isPrivateIPv4(candidate)) return candidate;
    if (version === 6 && !isPrivateIPv6(candidate)) return candidate.toLowerCase();
    // 私有位址或格式錯誤：略過，繼續往左找
  }
  return null;
}

/**
 * 取客戶端 IP（限流用）。服務跑在 Zeabur 反向代理後面，代理會把真實連線 IP 附加在
 * X-Forwarded-For 的最右邊；左邊的值可能是客戶端自己偽造的，所以由右往左取第一個公開位址。
 * 沒有 X-Forwarded-For（例如本機直連）或整串都不是公開位址時，退回 TCP 連線位址。
 */
export function getClientIp(xForwardedFor: string | undefined, remoteAddress: string | undefined): string {
  if (xForwardedFor) {
    const found = firstPublicIp(xForwardedFor);
    if (found) return found;
  }
  return remoteAddress || "unknown";
}
