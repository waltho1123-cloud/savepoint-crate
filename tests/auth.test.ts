import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createSessionToken,
  DUMMY_PASSWORD_HASH,
  generateSetupCode,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  SESSION_TTL_MS,
  SETUP_CODE_ALPHABET,
  SetupCodeGuard,
  validateNewPassword,
  verifyPassword,
  verifySessionToken,
} from "../src/auth.js";

describe("hashPassword／verifyPassword（scrypt）", () => {
  it("格式是 scrypt$N$r$p$salt$hash（N=16384、r=8、p=1、16 位元組 salt），同一個密碼每次的雜湊都不同", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect([SCRYPT_N, SCRYPT_R, SCRYPT_P]).toEqual([16384, 8, 1]);
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(a.includes("correct horse")).toBe(false);
  });

  it("正確的密碼通過、錯誤的不過（含差一個字、大小寫、空字串、前後空白）", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    for (const wrong of ["correct horse batterY", "correct horse batter", "Correct horse battery", "", " correct horse battery", "correct horse battery "]) {
      expect(await verifyPassword(wrong, hash)).toBe(false);
    }
  });

  it("Unicode 組合形式不同（é 的合成與分解）視為同一個密碼；全形與半形不同", async () => {
    const hash = await hashPassword("café-secret-password");
    expect(await verifyPassword("café-secret-password", hash)).toBe(true);
    expect(await verifyPassword("ｃａｆé-secret-password", hash)).toBe(false);
  });

  it("中文與 emoji 密碼可以雜湊與驗證", async () => {
    const hash = await hashPassword("倉庫管理密碼🔐很長很長");
    expect(await verifyPassword("倉庫管理密碼🔐很長很長", hash)).toBe(true);
    expect(await verifyPassword("倉庫管理密碼🔐很長很短", hash)).toBe(false);
  });

  it("儲存的雜湊格式不對、參數超出範圍時一律回 false（不丟例外、不做大量運算）", async () => {
    const good = await hashPassword("some password 123");
    const [, , , , salt, key] = good.split("$") as [string, string, string, string, string, string];
    const badOnes = [
      "",
      "scrypt",
      "plain-text-password",
      `bcrypt$16384$8$1$${salt}$${key}`,
      `scrypt$16384$8$1$${salt}`, // 少一段
      `scrypt$16384$8$1$${salt}$${key}$extra`, // 多一段
      `scrypt$abc$8$1$${salt}$${key}`, // N 不是數字
      `scrypt$16383$8$1$${salt}$${key}`, // N 不是 2 的次方
      `scrypt$512$8$1$${salt}$${key}`, // N 太小
      `scrypt$${1 << 17}$8$1$${salt}$${key}`, // N 太大
      `scrypt$16384$0$1$${salt}$${key}`, // r 太小
      `scrypt$16384$17$1$${salt}$${key}`, // r 太大
      `scrypt$16384$8$0$${salt}$${key}`, // p 太小
      `scrypt$16384$8$5$${salt}$${key}`, // p 太大
      `scrypt$16384$8.5$1$${salt}$${key}`, // r 不是整數
      `scrypt$16384$8$1$AAAA$${key}`, // salt 太短
      `scrypt$16384$8$1$${salt}$AAAA`, // hash 太短
      `scrypt$16384$8$1$${salt}$${"A".repeat(200)}`, // hash 太長
      `scrypt$16384$8$1$$`, // 空的 salt 與 hash
    ];
    for (const bad of badOnes) expect(await verifyPassword("some password 123", bad)).toBe(false);
  });

  it("N 超過上限（2^16）的雜湊即使密碼完全正確也一律拒絕——不會因為設定檔被改壞而被迫做大量運算", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    // N=2^17、r=2（scrypt 要求 N < 2^(16r)，所以 r 至少 2；約 32 MiB）：對這個密碼來說是正確的雜湊，只是 N 超過上限
    const key = scryptSync("over the limit password", salt, 32, { N: 1 << 17, r: 2, p: 1, maxmem: 256 * 1024 * 1024 });
    const stored = `scrypt$${1 << 17}$2$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
    expect(await verifyPassword("over the limit password", stored)).toBe(false);
    // 對照：同樣的做法但 N 在上限內（2^16）就能通過
    const okKey = scryptSync("over the limit password", salt, 32, { N: 1 << 16, r: 2, p: 1, maxmem: 256 * 1024 * 1024 });
    expect(await verifyPassword("over the limit password", `scrypt$${1 << 16}$2$1$${salt.toString("base64url")}$${okKey.toString("base64url")}`)).toBe(true);
  });

  it.each([
    ["r 超過上限（17 > 16）", { N: 1024, r: 17, p: 1 }, false],
    ["r 剛好在上限（16）", { N: 1024, r: 16, p: 1 }, true],
    ["p 超過上限（5 > 4）", { N: 1024, r: 8, p: 5 }, false],
    ["p 剛好在上限（4）", { N: 1024, r: 8, p: 4 }, true],
  ])("參數上限：%s——雜湊對這個密碼是正確的，只看參數有沒有超過上限", async (_name, params, expected) => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync("bound check password", salt, 32, { ...params, maxmem: 256 * 1024 * 1024 });
    const stored = `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
    expect(await verifyPassword("bound check password", stored)).toBe(expected);
  });

  it("參數可以不同：帶著自己的 N／r／p 的舊雜湊仍可驗證（在上限內）", async () => {
    // 用 node:crypto 手動算一個 N=1024 的雜湊，模擬「以後調整過參數」的設定檔
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync("older params password", salt, 32, { N: 1024, r: 8, p: 1 });
    const stored = `scrypt$1024$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
    expect(await verifyPassword("older params password", stored)).toBe(true);
    expect(await verifyPassword("older params passwore", stored)).toBe(false);
  });
});

describe("validateNewPassword", () => {
  it(`長度 ${PASSWORD_MIN_LENGTH}～${PASSWORD_MAX_LENGTH} 字元合格，邊界外回傳錯誤訊息`, () => {
    expect(validateNewPassword("x".repeat(PASSWORD_MIN_LENGTH - 1))).toBe("密碼至少要 8 個字元");
    expect(validateNewPassword("x".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(validateNewPassword("x".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(validateNewPassword("x".repeat(PASSWORD_MAX_LENGTH + 1))).toBe("密碼最多 200 個字元");
    expect(validateNewPassword("")).toBe("密碼至少要 8 個字元");
  });
});

describe("session cookie 值（HMAC 簽章，綁定帳號與 sessionVersion）", () => {
  const secret = "ab".repeat(32);
  const now = 1_800_000_000_000;
  const ACCOUNT = "0123456789abcdef0123456789abcdef";
  const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";

  it("格式是 <到期時間>.<帳號 id>.<sessionVersion>.<亂數>.<HMAC>，到期時間是現在加 7 天，每次的亂數都不同", () => {
    const a = createSessionToken(secret, ACCOUNT, 3, now);
    const b = createSessionToken(secret, ACCOUNT, 3, now);
    const [expires, id, version, nonce, mac] = a.split(".") as [string, string, string, string, string];
    expect(Number(expires)).toBe(now + SESSION_TTL_MS);
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(id).toBe(ACCOUNT);
    expect(version).toBe("3");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.split(".")).toHaveLength(5);
    expect(a).not.toBe(b);
  });

  it("HMAC 是以 sessionSecret（十六進位轉成位元組）為金鑰、對「<到期時間>.<帳號 id>.<sessionVersion>.<亂數>」做 SHA-256、base64url", () => {
    const token = createSessionToken(secret, ACCOUNT, 7, now);
    const parts = token.split(".") as [string, string, string, string, string];
    const expected = createHmac("sha256", Buffer.from(secret, "hex")).update(parts.slice(0, 4).join(".")).digest("base64url");
    expect(parts[4]).toBe(expected);
  });

  it("驗證通過時回傳簽在裡面的帳號 id 與 sessionVersion", () => {
    const token = createSessionToken(secret, ACCOUNT, 12, now);
    expect(verifySessionToken(token, secret, now)).toEqual({ accountId: ACCOUNT, sessionVersion: 12 });
    expect(verifySessionToken(createSessionToken(secret, OTHER_ACCOUNT, 1, now), secret, now)).toEqual({ accountId: OTHER_ACCOUNT, sessionVersion: 1 });
  });

  it("有效期內通過；到期時間當下（含）與之後都不通過", () => {
    const token = createSessionToken(secret, ACCOUNT, 1, now);
    expect(verifySessionToken(token, secret, now)).not.toBeNull();
    expect(verifySessionToken(token, secret, now + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(verifySessionToken(token, secret, now + SESSION_TTL_MS)).toBeNull();
    expect(verifySessionToken(token, secret, now + SESSION_TTL_MS + 1)).toBeNull();
  });

  it("換一把簽章金鑰就全部失效", () => {
    const token = createSessionToken(secret, ACCOUNT, 1, now);
    expect(verifySessionToken(token, "cd".repeat(32), now)).toBeNull();
  });

  it("任何一段被改過都不通過：到期時間延長、換成別的帳號 id、把 sessionVersion 改大、亂數、簽章的任一字元", () => {
    const token = createSessionToken(secret, ACCOUNT, 2, now);
    const [expires, id, version, nonce, mac] = token.split(".") as [string, string, string, string, string];
    const make = (e = expires, i = id, v = version, n = nonce, m = mac) => `${e}.${i}.${v}.${n}.${m}`;
    expect(verifySessionToken(make(String(Number(expires) + 86_400_000)), secret, now)).toBeNull(); // 想把到期時間往後延
    expect(verifySessionToken(make(undefined, OTHER_ACCOUNT), secret, now)).toBeNull(); // 想冒充別的帳號
    expect(verifySessionToken(make(undefined, undefined, "3"), secret, now)).toBeNull(); // 想把 sessionVersion 改成新的
    expect(verifySessionToken(make(undefined, undefined, "1"), secret, now)).toBeNull();
    expect(verifySessionToken(make(undefined, undefined, undefined, `${nonce.slice(0, -1)}${nonce.endsWith("A") ? "B" : "A"}`), secret, now)).toBeNull();
    const flipped = mac.startsWith("A") ? `B${mac.slice(1)}` : `A${mac.slice(1)}`;
    expect(verifySessionToken(make(undefined, undefined, undefined, undefined, flipped), secret, now)).toBeNull();
    const flippedEnd = mac.endsWith("A") ? `${mac.slice(0, -1)}B` : `${mac.slice(0, -1)}A`;
    expect(verifySessionToken(make(undefined, undefined, undefined, undefined, flippedEnd), secret, now)).toBeNull();
  });

  it("舊格式（升級成管理員帳號之前的 <到期>.<亂數>.<簽章> 三段式）一律視為未登入，即使簽章本身是對的", () => {
    const expires = String(now + SESSION_TTL_MS);
    const nonce = "AAAAAAAAAAAAAAAA";
    const mac = createHmac("sha256", Buffer.from(secret, "hex")).update(`${expires}.${nonce}`).digest("base64url");
    expect(`${expires}.${nonce}.${mac}`.split(".")).toHaveLength(3);
    expect(verifySessionToken(`${expires}.${nonce}.${mac}`, secret, now)).toBeNull();
  });

  it("格式不對一律不通過（不丟例外）", () => {
    const token = createSessionToken(secret, ACCOUNT, 1, now);
    const [expires, id, version, nonce, mac] = token.split(".") as [string, string, string, string, string];
    const bad: Array<string | undefined> = [
      undefined,
      "",
      "garbage",
      "a.b",
      `${expires}.${id}.${version}.${nonce}`, // 少簽章
      `${token}.extra`, // 多一段
      `abc.${id}.${version}.${nonce}.${mac}`, // 到期時間不是數字
      `-5.${id}.${version}.${nonce}.${mac}`,
      `${expires}.${id.slice(0, 31)}.${version}.${nonce}.${mac}`, // 帳號 id 太短
      `${expires}.${id.toUpperCase()}.${version}.${nonce}.${mac}`, // 帳號 id 要是小寫十六進位
      `${expires}.${"g".repeat(32)}.${version}.${nonce}.${mac}`, // 帳號 id 不是十六進位
      `${expires}.${id}.abc.${nonce}.${mac}`, // sessionVersion 不是數字
      `${expires}.${id}.-1.${nonce}.${mac}`,
      `${expires}.${id}..${nonce}.${mac}`, // sessionVersion 是空的
      `${expires}.${id}.${"9".repeat(17)}.${nonce}.${mac}`, // sessionVersion 位數過多
      `${expires}.${id}.${version}.${nonce}.${mac.slice(0, 42)}`, // 簽章太短
      `${expires}.${id}.${version}.${nonce}.${mac}A`, // 簽章太長
      `${expires}.${id}.${version}..${mac}`, // 亂數是空的
      `${expires}.${id}.${version}.${nonce}.${mac.replace(/.$/, "!")}`, // 非法字元
      "1".repeat(17) + `.${id}.${version}.${nonce}.${mac}`, // 到期時間位數過多
    ];
    for (const value of bad) expect(verifySessionToken(value, secret, now)).toBeNull();
  });

  it("帳號 id 必須是 32 個小寫十六進位字元：即使簽章是對的，太短、太長、大寫、含非十六進位字元、空的都不通過", () => {
    const sign = (accountId: string) => {
      const expires = String(now + SESSION_TTL_MS);
      const mac = createHmac("sha256", Buffer.from(secret, "hex")).update(`${expires}.${accountId}.1.AAAAAAAAAAAAAAAA`).digest("base64url");
      return `${expires}.${accountId}.1.AAAAAAAAAAAAAAAA.${mac}`;
    };
    expect(verifySessionToken(sign(ACCOUNT), secret, now)).toEqual({ accountId: ACCOUNT, sessionVersion: 1 }); // 對照組：格式對就通過
    for (const bad of [ACCOUNT.slice(1), `${ACCOUNT}0`, ACCOUNT.toUpperCase(), `g${ACCOUNT.slice(1)}`, "", "admin", "x".repeat(40)]) {
      expect(verifySessionToken(sign(bad), secret, now), JSON.stringify(bad)).toBeNull();
    }
  });

  it("sessionVersion 很大（十位數以上，仍是安全整數）只要簽章是對的就通過；不是安全整數就不通過", () => {
    const sign = (version: string) => {
      const expires = String(now + SESSION_TTL_MS);
      const mac = createHmac("sha256", Buffer.from(secret, "hex")).update(`${expires}.${ACCOUNT}.${version}.AAAAAAAAAAAAAAAA`).digest("base64url");
      return `${expires}.${ACCOUNT}.${version}.AAAAAAAAAAAAAAAA.${mac}`;
    };
    expect(verifySessionToken(sign("1234567890123"), secret, now)).toEqual({ accountId: ACCOUNT, sessionVersion: 1234567890123 });
    expect(verifySessionToken(sign("9007199254740991"), secret, now)).toEqual({ accountId: ACCOUNT, sessionVersion: 9007199254740991 });
    expect(verifySessionToken(sign("9007199254740993"), secret, now)).toBeNull(); // 超過安全整數
  });

  it("sessionVersion 必須 ≥ 1：即使簽章是對的，0 也不通過", () => {
    const expires = String(now + SESSION_TTL_MS);
    const nonce = "AAAAAAAAAAAAAAAA";
    const mac = createHmac("sha256", Buffer.from(secret, "hex")).update(`${expires}.${ACCOUNT}.0.${nonce}`).digest("base64url");
    expect(verifySessionToken(`${expires}.${ACCOUNT}.0.${nonce}.${mac}`, secret, now)).toBeNull();
  });

  it("用別人自己簽的（金鑰不同）token 無法通過：偽造的簽章不行", () => {
    const forged = createSessionToken("00".repeat(32), ACCOUNT, 1, now);
    expect(verifySessionToken(forged, secret, now)).toBeNull();
  });
});

describe("DUMMY_PASSWORD_HASH（登入時查無帳號也要跑一次 scrypt 用的假雜湊）", () => {
  it("是形狀正確的 scrypt 雜湊（參數與正式雜湊相同），任何密碼都驗證不過，且確實會花一次 scrypt 的時間", async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    const real = await hashPassword("some password 123");
    expect(DUMMY_PASSWORD_HASH.split("$").slice(0, 4)).toEqual(real.split("$").slice(0, 4)); // N、r、p 一樣
    const started = performance.now();
    for (const guess of ["", "password", "admin", "test-admin-password-123", "x".repeat(200)]) {
      expect(await verifyPassword(guess, DUMMY_PASSWORD_HASH)).toBe(false);
    }
    // 五次完整的 scrypt（N=16384、r=8）至少要幾十毫秒；若被當成格式錯誤而提早回 false（不跑 scrypt）會快上幾個數量級
    expect(performance.now() - started).toBeGreaterThan(30);
  });
});

describe("首次設定碼", () => {
  it("格式 XXXX-XXXX，字元只來自去掉 I、L、O、0、1 的 31 字元字母表", () => {
    expect(SETUP_CODE_ALPHABET).toHaveLength(31);
    for (const confusable of ["I", "L", "O", "0", "1"]) expect(SETUP_CODE_ALPHABET.includes(confusable)).toBe(false);
    expect(new Set(SETUP_CODE_ALPHABET).size).toBe(31);
    for (let i = 0; i < 300; i++) {
      expect(generateSetupCode()).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    }
  });

  it("每次都不一樣（300 組裡沒有重複）", () => {
    const seen = new Set(Array.from({ length: 300 }, () => generateSetupCode()));
    expect(seen.size).toBe(300);
  });

  it("每個字元位置都會用到字母表裡的各種字元（不是偏在一小塊）", () => {
    const used = new Set<string>();
    for (let i = 0; i < 400; i++) for (const ch of generateSetupCode().replace("-", "")) used.add(ch);
    expect(used.size).toBeGreaterThanOrEqual(28);
  });

  describe("SetupCodeGuard", () => {
    it("不指定就隨機產生一組；currentCode 是 XXXX-XXXX", () => {
      expect(new SetupCodeGuard().currentCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    it("正確的碼通過；大小寫、有沒有橫線、前後與中間的空白都不影響", () => {
      const guard = new SetupCodeGuard({ code: "ABCD-EFGH" });
      for (const input of ["ABCD-EFGH", "abcd-efgh", "ABCDEFGH", " abcd efgh ", "AbCd-eFgH", "ABCD–EFGH", "ABCD_EFGH"]) {
        expect(guard.verify(input)).toBe(true);
      }
    });

    it("錯的碼、空字串、太長、太短都不通過", () => {
      const guard = new SetupCodeGuard({ code: "ABCD-EFGH", maxFailures: 1000 });
      for (const input of ["ABCD-EFGJ", "", "ABCD-EFG", "ABCD-EFGHI", "ABCD-EFGH-ABCD", "00000000", "EFGH-ABCD"]) {
        expect(guard.verify(input)).toBe(false);
      }
    });

    it("consume 之後同一組碼不能再用", () => {
      const guard = new SetupCodeGuard({ code: "ABCD-EFGH" });
      expect(guard.verify("ABCD-EFGH")).toBe(true);
      guard.consume();
      expect(guard.currentCode).toBeNull();
      expect(guard.verify("ABCD-EFGH")).toBe(false);
    });

    it("累計錯誤達上限：整組作廢、換新的一組並通知 onRegenerate；舊的碼不能再用，新的可以", () => {
      const onRegenerate = vi.fn();
      const guard = new SetupCodeGuard({ code: "ABCD-EFGH", maxFailures: 3, onRegenerate });
      expect(guard.verify("AAAA-AAAA")).toBe(false);
      expect(guard.verify("BBBB-BBBB")).toBe(false);
      expect(onRegenerate).not.toHaveBeenCalled();
      expect(guard.currentCode).toBe("ABCD-EFGH");
      expect(guard.verify("CCCC-CCCC")).toBe(false); // 第 3 次
      expect(onRegenerate).toHaveBeenCalledTimes(1);
      const fresh = onRegenerate.mock.calls[0]![0] as string;
      expect(fresh).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(fresh).not.toBe("ABCD-EFGH");
      expect(guard.currentCode).toBe(fresh);
      expect(guard.verify("ABCD-EFGH")).toBe(false);
      expect(guard.verify(fresh)).toBe(true);
    });

    it("正確的輸入不算錯誤次數；換新碼之後錯誤次數歸零", () => {
      const onRegenerate = vi.fn();
      const guard = new SetupCodeGuard({ code: "ABCD-EFGH", maxFailures: 2, onRegenerate });
      expect(guard.verify("ABCD-EFGH")).toBe(true);
      expect(guard.verify("ABCD-EFGH")).toBe(true);
      expect(guard.verify("ZZZZ-ZZZZ")).toBe(false); // 第 1 次錯
      expect(onRegenerate).not.toHaveBeenCalled();
      expect(guard.verify("ZZZZ-ZZZZ")).toBe(false); // 第 2 次錯：換新
      expect(onRegenerate).toHaveBeenCalledTimes(1);
      expect(guard.verify("ZZZZ-ZZZY")).toBe(false); // 歸零後的第 1 次
      expect(onRegenerate).toHaveBeenCalledTimes(1);
    });

    it("預設累計 20 次錯誤才換新碼", () => {
      const onRegenerate = vi.fn();
      const guard = new SetupCodeGuard({ code: "ABCD-EFGH", onRegenerate });
      for (let i = 0; i < 19; i++) guard.verify("ZZZZ-ZZZZ");
      expect(onRegenerate).not.toHaveBeenCalled();
      guard.verify("ZZZZ-ZZZZ");
      expect(onRegenerate).toHaveBeenCalledTimes(1);
    });

    it("已 consume 的 guard 不會因為錯誤輸入又冒出新的碼", () => {
      const onRegenerate = vi.fn();
      const guard = new SetupCodeGuard({ code: "ABCD-EFGH", maxFailures: 1, onRegenerate });
      guard.consume();
      for (let i = 0; i < 5; i++) expect(guard.verify("ZZZZ-ZZZZ")).toBe(false);
      expect(onRegenerate).not.toHaveBeenCalled();
      expect(guard.currentCode).toBeNull();
    });
  });
});
