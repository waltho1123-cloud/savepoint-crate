import { isIP } from "node:net";

/** 限流視窗：一分鐘。 */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** 記錄數超過這個值就會（最多每 PRUNE_MIN_INTERVAL_MS 一次）整理一遍：先清過期的，還是太多再從最舊的開始丟。 */
const PRUNE_THRESHOLD = 5000;
/** 整理的最短間隔：每次 hit 都全表掃描的話，來源 IP 很多（或偽造 X-Forwarded-For）時會把事件迴圈卡住。 */
const PRUNE_MIN_INTERVAL_MS = 1000;
/** 記錄數的硬上限（整理時才會強制）：超過就丟掉最舊的，記憶體不會因為灌入大量不同的 key 而無限成長。 */
const MAX_RECORDS = 50_000;

/**
 * 簡單的記憶體內固定視窗限流（單一實例；服務重啟就清空，這裡不需要持久化）。
 */
export class FixedWindowLimiter {
  private readonly records = new Map<string, { count: number; windowStart: number }>();
  private lastPruneAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /**
   * 記一次請求。回傳 allowed=false 代表這個 key 在目前視窗內已超過額度（應回 429），
   * retryAfterSeconds 是距離視窗結束還有幾秒（至少 1）。
   */
  hit(key: string, now: number = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    if (this.records.size > PRUNE_THRESHOLD && now - this.lastPruneAt >= PRUNE_MIN_INTERVAL_MS) {
      this.prune(now);
      this.lastPruneAt = now;
    }
    let record = this.records.get(key);
    if (!record || now - record.windowStart >= this.windowMs) {
      record = { count: 0, windowStart: now };
      this.records.set(key, record);
    }
    record.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((record.windowStart + this.windowMs - now) / 1000));
    return { allowed: record.count <= this.max, retryAfterSeconds };
  }

  /** 清掉已過期的視窗；仍然超過 MAX_RECORDS 時從最舊的（Map 的插入順序）開始丟，避免記憶體無限成長。 */
  private prune(now: number): void {
    for (const [key, record] of this.records) {
      if (now - record.windowStart >= this.windowMs) this.records.delete(key);
    }
    let excess = this.records.size - MAX_RECORDS;
    if (excess > 0) {
      for (const key of this.records.keys()) {
        if (excess-- <= 0) break;
        this.records.delete(key);
      }
    }
  }
}

/**
 * 限制「同時進行」的重運算數量（用在 scrypt 密碼雜湊／驗證）：同時最多 maxActive 個在跑，其餘排隊（先進先出），
 * 排隊也滿了（maxQueue）就直接拒絕。公開端點被灌請求時，不會把 libuv 執行緒池（預設 4 條，DNS 解析與檔案 I/O
 * 也靠它）全部占滿——否則連帶會拖慢 OCR 與存檔。
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxQueue: number,
  ) {}

  /** 目前正在執行的數量與排隊中的數量（測試與診斷用）。 */
  get load(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiters.length };
  }

  /** 執行 fn。排隊已滿時不執行，回 { ok:false }（呼叫端應回 429）；fn 丟的例外會原樣丟出，名額一定會歸還。 */
  async run<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    if (this.active >= this.maxActive) {
      if (this.waiters.length >= this.maxQueue) return { ok: false };
      // 被喚醒時名額已經直接交棒給我們（active 沒有減），所以這裡不用再加
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return { ok: true, value: await fn() };
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
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
