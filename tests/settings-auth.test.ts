import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as auth from "../src/auth.js";
import { DUMMY_PASSWORD_HASH, SESSION_COOKIE_NAME, SESSION_TTL_MS } from "../src/auth.js";
import { ServiceError } from "../src/common.js";
import { LOGIN_RATE_LIMIT_MAX, PASSWORD_GATE_MAX_ACTIVE, PASSWORD_GATE_MAX_QUEUE } from "../src/auth-kit.js";
import { SETUP_RATE_LIMIT_MAX } from "../src/settings-routes.js";
import { SETTINGS_FILE_NAME } from "../src/settings-store.js";
import {
  accountId,
  call,
  cleanupTempDirs,
  cookieAttributes,
  cookiePair,
  lineHandler,
  makeAccount,
  makeSettingsApp,
  NOW_MS,
  setCookieOf,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_ID,
  TEST_ADMIN_NAME,
  TEST_ADMIN_PASSWORD,
  TEST_SETUP_CODE,
} from "./settings-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

const GOOD_PASSWORD = "a-brand-new-password-42";
const ip = (address: string) => ({ "x-forwarded-for": address });
/** 每次呼叫都換一個來源 IP：迴圈裡連續送很多次請求時，不要被逐 IP 的限流（setup 5／login 10 每分鐘）擋住。 */
let ipCounter = 0;
const freshIp = () => ip(`198.18.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`);
const LOGIN_FAILED = { success: false, error: "帳號或密碼不正確" };

/** 建立第一位管理員（全新安裝）的請求內容。 */
const setupBody = (overrides: Record<string, unknown> = {}) => ({
  setupCode: TEST_SETUP_CODE,
  name: "第一位管理員",
  email: "first@example.test",
  password: GOOD_PASSWORD,
  ...overrides,
});
const loginBody = (overrides: Record<string, unknown> = {}) => ({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, ...overrides });
/** 沒登入（或登入無效）進需要登入的頁面：302 導向登入頁，登入後回到原本的頁面。 */
function expectRedirectToLogin(res: Response, next: string) {
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`/login?next=${next}`);
  expect(res.headers.get("cache-control")).toBe("no-store");
}

describe("啟動時的設定碼提示", () => {
  it("全新安裝（沒有任何管理員）：log 有一行含設定碼的提示（格式固定）", async () => {
    const { log } = await makeSettingsApp({ withAdmin: false });
    expect(log.lines).toContain(`[settings] 尚未設定管理密碼：請開啟 /settings，用設定碼 ${TEST_SETUP_CODE} 建立密碼`);
  });

  it("已經有管理員帳號：不再提示", async () => {
    const { log } = await makeSettingsApp();
    expect(log.lines.some((line) => line.includes("設定碼"))).toBe(false);
  });

  it("還有舊版的單一密碼等著升級：不提示設定碼（要用目前的密碼升級，不是用設定碼重來）", async () => {
    const { log } = await makeSettingsApp({ legacyAdmin: true });
    expect(log.lines.some((line) => line.includes("設定碼"))).toBe(false);
  });

  it("資料目錄不可用：不提示（用不到）", async () => {
    const { log } = await makeSettingsApp({ store: "unavailable" });
    expect(log.lines.some((line) => line.includes("設定碼"))).toBe(false);
  });
});

describe("狀態變更端點的 CSRF 防護（Content-Type 與 X-Requested-With）", () => {
  const endpoints: Array<[string, string, unknown]> = [
    ["POST", "/settings/setup", setupBody()],
    ["POST", "/settings/upgrade", { currentPassword: TEST_ADMIN_PASSWORD, name: "甲", email: "a@example.test" }],
    ["POST", "/login", loginBody()],
    ["POST", "/logout", {}],
    ["PUT", "/api/settings/line", { enabled: true }],
    ["POST", "/api/settings/line/test", {}],
  ];

  it.each(endpoints)("%s %s：沒有 X-Requested-With → 403，什麼都不會發生", async (method, path, body) => {
    const ctx = await makeSettingsApp();
    const res = await ctx.app.request(path, {
      method,
      headers: { "content-type": "application/json", cookie: ctx.sessionCookie() },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: "缺少必要的請求標頭" });
    expect(setCookieOf(res)).toBeUndefined();
    expect(ctx.calls).toHaveLength(0);
  });

  it.each(endpoints)("%s %s：X-Requested-With 值不對 → 403", async (method, path, body) => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, method, path, body, { "x-requested-with": "fetch", cookie: ctx.sessionCookie() });
    expect(res.status).toBe(403);
  });

  it.each(endpoints)("%s %s：Content-Type 不是 application/json（表單、純文字）→ 415", async (method, path, body) => {
    const ctx = await makeSettingsApp();
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      const res = await ctx.app.request(path, {
        method,
        headers: { ...(contentType ? { "content-type": contentType } : {}), "x-requested-with": "XMLHttpRequest", cookie: ctx.sessionCookie() },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ success: false, error: "Content-Type 必須是 application/json" });
    }
  });

  it("Content-Type 帶 charset 參數、大小寫不同仍可（application/json; charset=utf-8）", async () => {
    const ctx = await makeSettingsApp();
    const res = await ctx.app.request("/login", {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
      body: JSON.stringify(loginBody()),
    });
    expect(res.status).toBe(200);
  });
});

describe("設定頁的限流額度（規格的數字，每個 IP 每分鐘）", () => {
  it("建立第一位管理員 5 次、登入／升級共用 10 次（其他測試的迴圈是跟著常數跑的，所以這裡把數字本身釘住）", () => {
    expect(SETUP_RATE_LIMIT_MAX).toBe(5);
    expect(LOGIN_RATE_LIMIT_MAX).toBe(10);
  });
});

describe("POST /settings/setup（全新安裝：用設定碼建立第一位管理員）", () => {
  it("設定碼錯誤 → 403，沒有 cookie，也沒有建立帳號", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const res = await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: "ZZZZ-ZZZZ" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: "設定碼不正確" });
    expect(setCookieOf(res)).toBeUndefined();
    expect(ctx.store.data.accounts).toEqual([]);
  });

  it("缺少設定碼、設定碼不是字串 → 403", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (const body of [setupBody({ setupCode: undefined }), setupBody({ setupCode: 12345678 }), setupBody({ setupCode: null })]) {
      expect((await call(ctx.app, "POST", "/settings/setup", body, freshIp())).status).toBe(403);
    }
  });

  it("設定碼對、但姓名不合規則 → 400（姓名 1～50 字、不可換行），設定碼仍有效、可以重試", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (const name of ["", "   ", "x".repeat(51), "a\nb", "a\u0000b", "a‮b", 123, null, undefined]) {
      const res = await call(ctx.app, "POST", "/settings/setup", setupBody({ name }), freshIp());
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: "姓名需為 1～50 個字元（不可含換行、控制字元或零寬字元，且要有看得見的字）" });
    }
    expect(ctx.store.data.accounts).toEqual([]);
    expect(ctx.setupCode.currentCode).toBe(TEST_SETUP_CODE);
    expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ name: "x".repeat(50) }), freshIp())).status).toBe(200);
  });

  it("設定碼對、但 Email 格式不對 → 400", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (const email of ["", "no-at-sign", "a@b", "@example.test", "a@", "a b@example.test", "a@exa mple.test", "a@@example.test", "a@example.test.", "a@.example.test", "a@exam_ple.test", `${"x".repeat(65)}@example.test`, 42, null, undefined]) {
      const res = await call(ctx.app, "POST", "/settings/setup", setupBody({ email }), freshIp());
      expect(res.status, JSON.stringify(email)).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("Email 格式不正確") });
    }
    expect(ctx.store.data.accounts).toEqual([]);
  });

  it("設定碼對、但密碼太短（7 字元）／太長（201）／缺少／不是字串 → 400，設定碼仍然有效、可以重試", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const short = await call(ctx.app, "POST", "/settings/setup", setupBody({ password: "1234567" }), freshIp());
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ success: false, error: "密碼至少要 8 個字元" });
    for (const password of ["x".repeat(201), undefined, 123456789012, null]) {
      expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ password }), freshIp())).status).toBe(400);
    }
    expect(ctx.store.data.accounts).toEqual([]);
    expect(ctx.setupCode.currentCode).toBe(TEST_SETUP_CODE);
    expect((await call(ctx.app, "POST", "/settings/setup", setupBody(), freshIp())).status).toBe(200);
  });

  it("成功：200、建立第一位管理員（Email 轉小寫、姓名 trim、scrypt 雜湊、sessionVersion 1、啟用）、發登入 cookie、設定碼作廢、檔案裡沒有明文密碼", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const res = await call(ctx.app, "POST", "/settings/setup", setupBody({ name: "  王小明  ", email: "  First@Example.TEST " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(ctx.store.data.accounts).toHaveLength(1);
    const admin = ctx.store.data.accounts[0]!;
    expect(admin).toMatchObject({
      name: "王小明",
      email: "first@example.test",
      role: "admin", // 第一位一定是管理員
      status: "active",
      sessionVersion: 1,
      createdAt: new Date(NOW_MS).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      lastLoginAt: new Date(NOW_MS).toISOString(),
    });
    expect(admin.id).toMatch(/^[0-9a-f]{32}$/);
    expect(admin.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(ctx.store.data.admin).toBeNull();
    expect(ctx.store.data.version).toBe(3);

    const file = await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8");
    expect(file).toContain("scrypt$16384$8$1$");
    expect(file).not.toContain(GOOD_PASSWORD);
    expect(ctx.log.lines.join("\n")).not.toContain(GOOD_PASSWORD);

    // 拿到的 cookie 綁著這位管理員，馬上可用；設定碼作廢
    const claims = decodeURIComponent(cookiePair(res).split("=")[1]!).split(".");
    expect(claims[1]).toBe(admin.id);
    expect(claims[2]).toBe("1");
    const settings = await call(ctx.app, "GET", "/api/settings", undefined, { cookie: cookiePair(res) });
    expect(settings.status).toBe(200);
    expect(((await settings.json()) as { data: { me: unknown } }).data.me).toEqual({ id: admin.id, name: "王小明", email: "first@example.test", role: "admin" });
    expect(ctx.setupCode.currentCode).toBeNull();
    const health = (await (await ctx.app.request("/healthz")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ adminConfigured: true, adminCount: 1, accountCount: 1, legacyAdminPending: false });
    expect(ctx.log.lines).toContain("[accounts] first@example.test 建立第一位管理員 first@example.test（來源 unknown）");
  });

  it("請求裡的 role 一律忽略：第一位永遠是管理員（不論填 user、admin 或亂填，都不會因為 role 不合法而 400）", async () => {
    for (const role of ["user", "admin", "root", null, 7]) {
      const ctx = await makeSettingsApp({ withAdmin: false });
      const res = await call(ctx.app, "POST", "/settings/setup", setupBody({ role }));
      expect(res.status, JSON.stringify(role)).toBe(200);
      expect(ctx.store.data.accounts[0]?.role).toBe("admin");
    }
  });

  it("設定碼不分大小寫、橫線可省略", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: "abcdefgh" }))).status).toBe(200);
  });

  it("已經有管理員：再來 setup 一律 409（即使設定碼正確），不會新增或覆蓋任何帳號", async () => {
    const ctx = await makeSettingsApp();
    const before = JSON.stringify(ctx.store.data.accounts);
    const res = await call(ctx.app, "POST", "/settings/setup", setupBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: "已經建立過帳號，請直接登入" });
    expect(JSON.stringify(ctx.store.data.accounts)).toBe(before);
  });

  it("還有舊版的單一密碼等著升級：setup 一律 409（不能用設定碼繞過目前的密碼），並指示改用升級", async () => {
    const ctx = await makeSettingsApp({ legacyAdmin: true });
    const res = await call(ctx.app, "POST", "/settings/setup", setupBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: "這裡還是舊版的單一管理密碼：請改用目前的密碼升級成管理員帳號" });
    expect(ctx.store.data.accounts).toEqual([]);
    expect(ctx.store.data.admin).not.toBeNull();
  });

  it("已經有管理員時，連設定碼對不對都不檢查（一律 409）：不能當成猜設定碼的管道，也不消耗設定碼的錯誤次數", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    await call(ctx.app, "POST", "/settings/setup", setupBody());
    for (let i = 0; i < 6; i++) {
      const res = await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: "ZZZZ-ZZZZ" }), ip(`198.51.100.${i + 1}`));
      expect(res.status).toBe(409);
    }
  });

  it("兩個請求同時用正確的設定碼：只有一個成功，另一個 409，最後只有一位管理員，登入得進去的只有贏的那一個", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const [a, b] = await Promise.all([
      call(ctx.app, "POST", "/settings/setup", setupBody({ email: "a@example.test", password: "first-password-1234" }), ip("203.0.113.1")),
      call(ctx.app, "POST", "/settings/setup", setupBody({ email: "b@example.test", password: "second-password-5678" }), ip("203.0.113.2")),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(ctx.store.data.accounts).toHaveLength(1);
    const winner = a.status === 200 ? { email: "a@example.test", password: "first-password-1234" } : { email: "b@example.test", password: "second-password-5678" };
    const loser = a.status === 200 ? { email: "b@example.test", password: "second-password-5678" } : { email: "a@example.test", password: "first-password-1234" };
    expect((await call(ctx.app, "POST", "/login", winner)).status).toBe(200);
    expect((await call(ctx.app, "POST", "/login", loser)).status).toBe(401);
  });

  it(`每個 IP 每分鐘 ${SETUP_RATE_LIMIT_MAX} 次（每次嘗試都算）：第 ${SETUP_RATE_LIMIT_MAX + 1} 次 429＋Retry-After，其他 IP 不受影響，一分鐘後恢復`, async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (let i = 0; i < SETUP_RATE_LIMIT_MAX; i++) {
      expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: "ZZZZ-ZZZZ" }), ip("203.0.113.10"))).status).toBe(403);
    }
    const blocked = await call(ctx.app, "POST", "/settings/setup", setupBody(), ip("203.0.113.10"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(await blocked.json()).toEqual({ success: false, error: "請求過於頻繁，請稍後再試" });
    expect(ctx.store.data.accounts).toEqual([]); // 被擋下的請求連設定碼都沒驗

    expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: "ZZZZ-ZZZZ" }), ip("203.0.113.11"))).status).toBe(403);
    ctx.clock.now += 60_001;
    expect((await call(ctx.app, "POST", "/settings/setup", setupBody(), ip("203.0.113.10"))).status).toBe(200);
  });

  it("用很多不同 IP 繞過逐 IP 限流也沒用：累計 20 次錯誤，設定碼整組作廢、換新的", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (let i = 0; i < 20; i++) {
      expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: "ZZZZ-ZZZZ" }), ip(`198.51.100.${i + 1}`))).status).toBe(403);
    }
    expect((await call(ctx.app, "POST", "/settings/setup", setupBody(), ip("198.51.100.99"))).status).toBe(403); // 舊的（正確的）設定碼已經作廢
    expect(ctx.setupCode.currentCode).not.toBe(TEST_SETUP_CODE);
    expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: ctx.setupCode.currentCode! }), ip("198.51.100.100"))).status).toBe(200);
  });
});

describe("POST /login（Email＋密碼）", () => {
  it("成功：200 與 session cookie（HttpOnly、SameSite=Lax、Path=/、Max-Age=7 天；http 下沒有 Secure）；cookie 綁帳號 id 與 sessionVersion；更新 lastLoginAt", async () => {
    const ctx = await makeSettingsApp();
    expect(ctx.store.data.accounts[0]!.lastLoginAt).toBeNull();
    const res = await call(ctx.app, "POST", "/login", loginBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, next: "/" }); // 沒指定回到哪裡就是 /
    const cookie = setCookieOf(res)!;
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    const attributes = cookieAttributes(cookie);
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("SameSite=Lax");
    expect(attributes).toContain("Path=/"); // 整個屬性相等：Path=/x 不算
    expect(attributes).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(attributes).not.toContain("Secure");
    // cookie 值：<到期>.<帳號 id>.<sessionVersion>.<亂數>.<簽章>
    const value = decodeURIComponent(cookie.split(";")[0]!.slice(SESSION_COOKIE_NAME.length + 1));
    const parts = value.split(".");
    expect(parts).toHaveLength(5);
    expect(Number(parts[0])).toBe(NOW_MS + SESSION_TTL_MS);
    expect(parts[1]).toBe(TEST_ADMIN_ID);
    expect(parts[2]).toBe("1");
    expect(ctx.store.data.accounts[0]!.lastLoginAt).toBe(new Date(NOW_MS).toISOString());
    expect(ctx.log.lines).toContain(`[accounts] ${TEST_ADMIN_EMAIL} 登入成功（來源 unknown）`);
  });

  it("Email 不分大小寫、前後空白不影響", async () => {
    const ctx = await makeSettingsApp();
    for (const email of ["ADMIN@EXAMPLE.TEST", "  Admin@Example.Test  "]) {
      expect((await call(ctx.app, "POST", "/login", loginBody({ email }), freshIp())).status).toBe(200);
    }
  });

  it("走 HTTPS（X-Forwarded-Proto: https，Zeabur 反向代理）：cookie 帶 Secure；直接 http 不帶", async () => {
    const ctx = await makeSettingsApp();
    const https = await call(ctx.app, "POST", "/login", loginBody(), { "x-forwarded-proto": "https" });
    expect(setCookieOf(https)).toContain("Secure");
    const chain = await call(ctx.app, "POST", "/login", loginBody(), { "x-forwarded-proto": "https, http" });
    expect(setCookieOf(chain)).toContain("Secure");
    const http = await call(ctx.app, "POST", "/login", loginBody(), { "x-forwarded-proto": "http" });
    expect(setCookieOf(http)).not.toContain("Secure");
  });

  it("密碼錯誤、查無這個帳號、帳號已停用、Email 格式不對、缺欄位：一律 401 與同一句固定訊息（不透露是哪一種），沒有 cookie，lastLoginAt 不變", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), email: "disabled@example.test", status: "disabled" })] });
    const attempts: Array<Record<string, unknown>> = [
      loginBody({ password: "wrong-password-123" }),
      loginBody({ password: "" }),
      loginBody({ password: TEST_ADMIN_PASSWORD.toUpperCase() }),
      loginBody({ password: `${TEST_ADMIN_PASSWORD} ` }),
      loginBody({ email: "nobody@example.test" }),
      { email: "disabled@example.test", password: TEST_ADMIN_PASSWORD }, // 停用的帳號：連正確的密碼也不行
      loginBody({ email: "not-an-email" }),
      loginBody({ email: "" }),
      loginBody({ email: undefined }),
      loginBody({ email: 123 }),
      { password: TEST_ADMIN_PASSWORD },
      { email: TEST_ADMIN_EMAIL },
      {},
      loginBody({ password: 123 }),
      loginBody({ password: "x".repeat(201) }),
    ];
    for (const body of attempts) {
      const res = await call(ctx.app, "POST", "/login", body, freshIp());
      expect(res.status, JSON.stringify(body)).toBe(401);
      expect(await res.json()).toEqual(LOGIN_FAILED);
      expect(setCookieOf(res)).toBeUndefined();
    }
    expect(ctx.store.data.accounts.every((a) => a.lastLoginAt === null)).toBe(true);
  });

  it("每一種失敗都真的跑了一次 scrypt：查無帳號、帳號停用、Email 格式不對都拿固定的假雜湊驗（回應時間不洩漏帳號存不存在）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), email: "disabled@example.test", status: "disabled" })] });
    const spy = vi.spyOn(auth, "verifyPassword");
    for (const email of ["nobody@example.test", "disabled@example.test", "not-an-email"]) {
      spy.mockClear();
      expect((await call(ctx.app, "POST", "/login", { email, password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toBe(DUMMY_PASSWORD_HASH);
    }
    // 對照：存在且啟用的帳號、密碼錯：用的是它自己的雜湊
    spy.mockClear();
    expect((await call(ctx.app, "POST", "/login", loginBody({ password: "wrong-password-123" }))).status).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe(ctx.store.data.accounts[0]!.passwordHash);
  });

  it("用假雜湊驗證時就算「密碼」剛好對得上也不會通過（帳號停用或不存在，永遠登不進去）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), email: "disabled@example.test", status: "disabled" })] });
    // 即使 verifyPassword 被竄改成「恆為真」，查無帳號與停用的帳號仍然是 401（結果由 usable 把關，不是只看密碼）
    vi.spyOn(auth, "verifyPassword").mockResolvedValue(true);
    for (const email of ["nobody@example.test", "disabled@example.test"]) {
      expect((await call(ctx.app, "POST", "/login", { email, password: "anything-at-all-123" }, freshIp())).status).toBe(401);
    }
  });

  it("登入時寫 lastLoginAt 失敗（Volume 滿了或唯讀）：登入仍然成功（發 cookie），log 有一行警告，lastLoginAt 沒變，密碼不進 log", async () => {
    const ctx = await makeSettingsApp();
    const before = ctx.store.data.accounts[0]!.lastLoginAt;
    vi.spyOn(ctx.store, "update").mockRejectedValueOnce(new ServiceError(500, "寫入設定檔失敗，請確認 Volume 可寫入"));
    const res = await call(ctx.app, "POST", "/login", loginBody());
    expect(res.status).toBe(200);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: cookiePair(res) })).status).toBe(200); // cookie 可用
    expect(ctx.store.data.accounts[0]!.lastLoginAt).toBe(before);
    const warning = ctx.log.lines.find((line) => line.includes("登入成功，但無法更新最後登入時間"));
    expect(warning).toContain(TEST_ADMIN_EMAIL);
    expect(ctx.log.lines.join("\n")).not.toContain(TEST_ADMIN_PASSWORD);
  });

  it("寫檔失敗、而且帳號的 sessionVersion 在同一時間變了（例如被停用又啟用）：cookie 用「現在」的 sessionVersion，所以可以用", async () => {
    const ctx = await makeSettingsApp();
    const realUpdate = ctx.store.update.bind(ctx.store);
    vi.spyOn(ctx.store, "update").mockImplementationOnce(async () => {
      await realUpdate((draft) => {
        draft.accounts[0]!.sessionVersion = 5;
      });
      throw new ServiceError(500, "寫入設定檔失敗，請確認 Volume 可寫入");
    });
    const res = await call(ctx.app, "POST", "/login", loginBody());
    expect(res.status).toBe(200);
    expect(decodeURIComponent(cookiePair(res).split("=")[1]!).split(".")[2]).toBe("5");
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: cookiePair(res) })).status).toBe(200);
  });

  it("寫檔失敗、而且這個帳號在同一時間已被停用：仍然 401（不會因為寫檔失敗就放行），沒有 cookie", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), email: "second@example.test" })] });
    const realUpdate = ctx.store.update.bind(ctx.store);
    vi.spyOn(ctx.store, "update").mockImplementationOnce(async () => {
      await realUpdate((draft) => {
        draft.accounts[0]!.status = "disabled";
      });
      throw new ServiceError(500, "寫入設定檔失敗，請確認 Volume 可寫入");
    });
    const res = await call(ctx.app, "POST", "/login", loginBody());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(LOGIN_FAILED);
    expect(setCookieOf(res)).toBeUndefined();
  });

  it("驗證密碼的期間帳號被停用（或刪除、重設密碼）：這次登入作廢，不會發 cookie", async () => {
    const real = auth.verifyPassword;
    for (const interfere of [
      (draft: { accounts: Array<{ status: string }> }) => void (draft.accounts[0]!.status = "disabled"),
      (draft: { accounts: unknown[] }) => void draft.accounts.splice(0, 1),
      (draft: { accounts: Array<{ passwordHash: string }> }) => void (draft.accounts[0]!.passwordHash = DUMMY_PASSWORD_HASH),
    ]) {
      const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), email: "second@example.test" })] });
      vi.spyOn(auth, "verifyPassword").mockImplementationOnce(async (password, hash) => {
        await ctx.store.update((draft) => interfere(draft as never));
        return real(password, hash);
      });
      const res = await call(ctx.app, "POST", "/login", loginBody());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(LOGIN_FAILED);
      expect(setCookieOf(res)).toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it("驗證密碼的期間帳號的 sessionVersion 變了（密碼沒變、仍啟用）：登入照常成功，發的 cookie 帶的是「現在」的 sessionVersion，不是驗證前讀到的舊值", async () => {
    const ctx = await makeSettingsApp();
    const real = auth.verifyPassword;
    vi.spyOn(auth, "verifyPassword").mockImplementationOnce(async (password, hash) => {
      await ctx.store.update((draft) => {
        draft.accounts[0]!.sessionVersion = 5;
      });
      return real(password, hash);
    });
    const res = await call(ctx.app, "POST", "/login", loginBody());
    expect(res.status).toBe(200);
    expect(decodeURIComponent(cookiePair(res).split("=")[1]!).split(".")[2]).toBe("5");
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: cookiePair(res) })).status).toBe(200);
  });

  it("尚未建立任何帳號 → 400 並提示請管理員先到設定頁；還有舊版的單一密碼 → 409 並提示先升級", async () => {
    const fresh = await makeSettingsApp({ withAdmin: false });
    const res = await call(fresh.app, "POST", "/login", loginBody());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "尚未建立任何帳號：請管理員先到設定頁（/settings），用設定碼建立第一位管理員" });
    const legacy = await makeSettingsApp({ legacyAdmin: true });
    const res2 = await call(legacy.app, "POST", "/login", loginBody());
    expect(res2.status).toBe(409);
    expect(await res2.json()).toEqual({ success: false, error: "系統已改為帳號制：請管理員先到設定頁（/settings），用目前的管理密碼升級成管理員帳號" });
  });

  it("請求內容不是 JSON、不是物件 → 400", async () => {
    const ctx = await makeSettingsApp();
    expect((await call(ctx.app, "POST", "/login", "{not json")).status).toBe(400);
    expect((await call(ctx.app, "POST", "/login", "[1,2]")).status).toBe(400);
    expect((await call(ctx.app, "POST", "/login", "")).status).toBe(400);
  });

  it(`每個 IP 每分鐘 ${LOGIN_RATE_LIMIT_MAX} 次：第 ${LOGIN_RATE_LIMIT_MAX + 1} 次 429（連正確的密碼也一樣），一分鐘後恢復，其他 IP 不受影響`, async () => {
    const ctx = await makeSettingsApp();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      expect((await call(ctx.app, "POST", "/login", loginBody({ password: "wrong-password-123" }), ip("203.0.113.20"))).status).toBe(401);
    }
    const blocked = await call(ctx.app, "POST", "/login", loginBody(), ip("203.0.113.20"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await call(ctx.app, "POST", "/login", loginBody(), ip("203.0.113.21"))).status).toBe(200);
    ctx.clock.now += 60_001;
    expect((await call(ctx.app, "POST", "/login", loginBody(), ip("203.0.113.20"))).status).toBe(200);
  });

  it("換 Email 重試也沒用：額度是逐 IP 算的，不是逐帳號（攻擊者不能靠換帳號名稱繞過）", async () => {
    const ctx = await makeSettingsApp();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      await call(ctx.app, "POST", "/login", { email: `guess${i}@example.test`, password: "wrong-password-123" }, ip("203.0.113.22"));
    }
    expect((await call(ctx.app, "POST", "/login", loginBody(), ip("203.0.113.22"))).status).toBe(429);
  });

  it("登入、建立第一位管理員的限流額度互相獨立（setup 5／login 10）", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (let i = 0; i < SETUP_RATE_LIMIT_MAX; i++) {
      await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: "ZZZZ-ZZZZ" }), ip("203.0.113.30"));
    }
    expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: "ZZZZ-ZZZZ" }), ip("203.0.113.30"))).status).toBe(429);
    // setup 被擋，login 還有額度（回 400「尚未建立」而不是 429）
    expect((await call(ctx.app, "POST", "/login", loginBody(), ip("203.0.113.30"))).status).toBe(400);
  });
});

describe("session cookie 的驗證（綁帳號與 sessionVersion）", () => {
  it("有效的 cookie 可以讀設定；沒有 cookie → 401", async () => {
    const ctx = await makeSettingsApp();
    expect((await ctx.authed("GET", "/api/settings")).status).toBe(200);
    const res = await call(ctx.app, "GET", "/api/settings");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "請先登入" });
  });

  it("/api/settings 回應多了 me：目前登入的管理員的 id、姓名、Email（不含密碼雜湊）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), name: "第二位", email: "second@example.test" })] });
    const first = await ctx.authed("GET", "/api/settings");
    const text = await first.text();
    expect(JSON.parse(text).data.me).toEqual({ id: TEST_ADMIN_ID, name: TEST_ADMIN_NAME, email: TEST_ADMIN_EMAIL, role: "admin" });
    expect(text).not.toContain("scrypt$");
    const second = await ctx.authedAs(accountId(2), "GET", "/api/settings");
    expect(((await second.json()) as { data: { me: unknown } }).data.me).toEqual({ id: accountId(2), name: "第二位", email: "second@example.test", role: "admin" });
  });

  it("被竄改的 cookie → 401：改簽章、改到期時間、改亂數、改成別的帳號 id、改 sessionVersion", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), email: "second@example.test" })] });
    const good = ctx.sessionCookie().slice(SESSION_COOKIE_NAME.length + 1);
    const [expires, id, version, nonce, mac] = good.split(".") as [string, string, string, string, string];
    const flippedMac = `${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`;
    const tampered = [
      [expires, id, version, nonce, flippedMac],
      [String(Number(expires) + 86_400_000), id, version, nonce, mac],
      [expires, id, version, `${nonce.slice(0, -1)}${nonce.endsWith("A") ? "B" : "A"}`, mac],
      [expires, accountId(2), version, nonce, mac], // 想冒充另一位（存在的）管理員
      [expires, id, "2", nonce, mac], // 想把 sessionVersion 改成別的
    ].map((parts) => parts.join("."));
    for (const value of [...tampered, "garbage", "", `${expires}.${id}.${version}.${nonce}`]) {
      const res = await call(ctx.app, "GET", "/api/settings", undefined, { cookie: `${SESSION_COOKIE_NAME}=${value}` });
      expect(res.status, value).toBe(401);
    }
  });

  it("舊格式的 cookie（升級前的三段式 <到期>.<亂數>.<簽章>）一律視為未登入，即使簽章是用目前的金鑰簽的", async () => {
    const { createHmac } = await import("node:crypto");
    const ctx = await makeSettingsApp();
    const expires = String(NOW_MS + SESSION_TTL_MS);
    const nonce = "AAAAAAAAAAAAAAAA";
    const mac = createHmac("sha256", Buffer.from(ctx.store.data.sessionSecret, "hex")).update(`${expires}.${nonce}`).digest("base64url");
    const res = await call(ctx.app, "GET", "/api/settings", undefined, { cookie: `${SESSION_COOKIE_NAME}=${expires}.${nonce}.${mac}` });
    expect(res.status).toBe(401);
    const page = await ctx.app.request("/settings", { headers: { cookie: `${SESSION_COOKIE_NAME}=${expires}.${nonce}.${mac}` } });
    expectRedirectToLogin(page, "/settings");
  });

  it("帳號被刪除、被停用後，那個帳號的 cookie 立刻失效（API 與頁面都是）；其他帳號不受影響", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), email: "second@example.test" }), makeAccount({ id: accountId(3), email: "third@example.test" })] });
    const cookies = [ctx.sessionCookie(accountId(2)), ctx.sessionCookie(accountId(3))];
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: cookies[0]! })).status).toBe(200);
    await ctx.store.update((draft) => {
      draft.accounts.find((a) => a.id === accountId(2))!.status = "disabled";
      draft.accounts.splice(draft.accounts.findIndex((a) => a.id === accountId(3)), 1);
    });
    for (const cookie of cookies) {
      expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie })).status).toBe(401);
      expectRedirectToLogin(await ctx.app.request("/settings", { headers: { cookie } }), "/settings");
    }
    expect((await ctx.authed("GET", "/api/settings")).status).toBe(200); // 第一位不受影響
  });

  it("sessionVersion 不符的 cookie 失效（帳號的 sessionVersion 變大之後，舊 cookie 全部作廢；新的 cookie 有效）", async () => {
    const ctx = await makeSettingsApp();
    const oldCookie = ctx.sessionCookie();
    await ctx.store.update((draft) => {
      draft.accounts[0]!.sessionVersion = 2;
    });
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: oldCookie })).status).toBe(401);
    expect((await ctx.authed("GET", "/api/settings")).status).toBe(200); // sessionCookie() 現在用的是 2
  });

  it("到期的 cookie → 401（API 與頁面都是）：剛好 7 天後失效", async () => {
    const ctx = await makeSettingsApp();
    const cookie = ctx.sessionCookie();
    ctx.clock.now += SESSION_TTL_MS - 1;
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie })).status).toBe(200);
    ctx.clock.now += 1;
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie })).status).toBe(401);
    expectRedirectToLogin(await ctx.app.request("/settings", { headers: { cookie } }), "/settings");
  });

  it("同名但無關的其他 cookie 不會被當成登入；cookie 夾在其他 cookie 之間也能讀到", async () => {
    const ctx = await makeSettingsApp();
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: "other=1; session=abc; sp_session_x=2" })).status).toBe(401);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: `a=1; ${ctx.sessionCookie()}; b=2` })).status).toBe(200);
  });

  it("簽章金鑰不同（別的部署簽的）→ 401", async () => {
    const other = await makeSettingsApp();
    const ctx = await makeSettingsApp();
    expect(other.store.data.sessionSecret).not.toBe(ctx.store.data.sessionSecret);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: other.sessionCookie() })).status).toBe(401);
  });
});

describe("POST /logout", () => {
  it("回 200 並清掉 cookie（Max-Age=0、Path=/）；不需要已登入", async () => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, "POST", "/logout", {}, { cookie: ctx.sessionCookie() });
    expect(res.status).toBe(200);
    const cookie = setCookieOf(res)!;
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(cookieAttributes(cookie)).toContain("Max-Age=0");
    expect(cookieAttributes(cookie)).toContain("Path=/"); // 要和發出去的 cookie 同一個 Path 才清得掉
    expect((await call(ctx.app, "POST", "/logout", {})).status).toBe(200);
  });

  it("走 HTTPS 時清除的 cookie 也帶 Secure（才蓋得過 Secure 的 cookie）", async () => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, "POST", "/logout", {}, { "x-forwarded-proto": "https" });
    expect(setCookieOf(res)).toContain("Secure");
  });
});

describe("沒有「改自己的密碼」的端點（密碼只由管理員設定：POST /api/accounts/:id/password）", () => {
  const second = () => makeAccount({ id: accountId(2), name: "第二位", email: "second@example.test" });
  const PATHS = ["/account/password", "/account/password/", "/settings/password", "/account/passwd", "/api/account/password", "/api/me/password", "/api/password"];

  it("POST /account/password（以及舊的 /settings/password 等路徑）整個不存在：沒登入、一般使用者、管理員都是 404，什麼都不會改", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const before = await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8");
    const bodies = [
      { currentPassword: TEST_ADMIN_PASSWORD, newPassword: GOOD_PASSWORD },
      { newPassword: GOOD_PASSWORD },
      {},
    ];
    for (const path of PATHS) {
      for (const cookie of [undefined, ctx.sessionCookie(), ctx.sessionCookie(accountId(2))]) {
        for (const body of bodies) {
          const res = await call(ctx.app, "POST", path, body, { ...(cookie ? { cookie } : {}), ...freshIp() });
          expect(res.status, `POST ${path}`).toBe(404);
          expect(setCookieOf(res), `POST ${path}`).toBeUndefined();
        }
      }
    }
    expect(await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8")).toBe(before); // 設定檔逐位元組沒變
    expect(ctx.log.lines.filter((line) => line.includes("[accounts]"))).toEqual([]); // 也沒有任何審計 log
  });

  it("其他方法（GET、PUT、PATCH、DELETE）也是 404，不是 405——路由根本沒有註冊；內容很大也是 404（沒有 body 上限的處理器）", async () => {
    const ctx = await makeSettingsApp();
    for (const path of PATHS) {
      for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
        const res = await ctx.app.request(path, { method, headers: { cookie: ctx.sessionCookie(), ...freshIp() } });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.headers.get("allow"), `${method} ${path}`).toBeNull();
      }
    }
    const big = await ctx.authed("POST", "/account/password", JSON.stringify({ currentPassword: "x".repeat(20 * 1024), newPassword: "y" }));
    expect(big.status).toBe(404);
  });

  it("沒有人（含管理員）能用「目前的密碼」換新密碼：登入者帶著正確的目前密碼打過去，密碼、sessionVersion 都不變", async () => {
    const ctx = await makeSettingsApp();
    const hash = ctx.store.data.accounts[0]!.passwordHash;
    const res = await ctx.authed("POST", "/account/password", { currentPassword: TEST_ADMIN_PASSWORD, newPassword: GOOD_PASSWORD });
    expect(res.status).toBe(404);
    expect(ctx.store.data.accounts[0]!.passwordHash).toBe(hash);
    expect(ctx.store.data.accounts[0]!.sessionVersion).toBe(1);
    expect((await call(ctx.app, "POST", "/login", loginBody(), freshIp())).status).toBe(200); // 原本的密碼照常可登入
    expect((await call(ctx.app, "POST", "/login", loginBody({ password: GOOD_PASSWORD }), freshIp())).status).toBe(401);
  });

  it("也不會被「請求內容裡帶新密碼」的其他端點偷渡：PATCH /api/accounts/:id 帶 password／passwordHash 欄位會被忽略", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const hash = ctx.store.data.accounts[1]!.passwordHash;
    const res = await ctx.authed("PATCH", `/api/accounts/${accountId(2)}`, { name: "改名", password: GOOD_PASSWORD, newPassword: GOOD_PASSWORD, passwordHash: "scrypt$x" });
    expect(res.status).toBe(200);
    expect(ctx.store.data.accounts[1]!.name).toBe("改名");
    expect(ctx.store.data.accounts[1]!.passwordHash).toBe(hash);
    expect(ctx.store.data.accounts[1]!.sessionVersion).toBe(1);
  });
});

describe("GET /settings（頁面的狀態）", () => {
  it("全新安裝：建立第一位管理員的表單（設定碼、姓名、Email、兩次密碼），沒有登入與設定表單，也不洩漏設定碼", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const res = await ctx.app.request("/settings");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const id of ["setup-form", "setup-code", "setup-name", "setup-email", "setup-password2"]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('id="login-form"');
    expect(html).not.toContain('id="upgrade-form"');
    expect(html).not.toContain('id="line-form"');
    expect(html).not.toContain(TEST_SETUP_CODE);
  });

  it("有帳號、沒登入：302 導向 /login?next=/settings（不顯示任何設定內容）", async () => {
    const ctx = await makeSettingsApp();
    for (const path of ["/settings", "/settings/"]) {
      const res = await ctx.app.request(path);
      expectRedirectToLogin(res, "/settings");
      expect(await res.text()).toBe("");
    }
  });

  it("有帳號、登入的是一般使用者：403 的「需要管理員權限」頁（沒有設定內容、沒有帳號清單），帶頂端導覽（回裝箱程式、我的帳號、登出，沒有「設定」連結）", async () => {
    const USER = accountId(40);
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: USER, name: "一般同事", email: "user@example.test", role: "user" })] });
    const res = await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie(USER) } });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("需要管理員權限");
    expect(html).toContain("一般同事");
    expect(html).toContain('<span class="who">👤 一般同事（一般使用者）</span>');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/account"');
    expect(html).toContain('id="logout"');
    expect(html).not.toContain('href="/settings"');
    for (const id of ["line-form", "admin-table", "setup-form", "upgrade-form", "login-form"]) expect(html).not.toContain(`id="${id}"`);
    expect(html).not.toContain(TEST_ADMIN_EMAIL); // 不洩漏其他帳號
  });

  it("已登入的管理員：設定表單、帳號管理表格；頂端顯示登入者的姓名與角色與導覽（沒有任何改密碼表單——密碼只由管理員在帳號管理設定）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), name: "第二位", email: "second@example.test" })] });
    const res = await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const id of ["line-form", "line-enabled", "line-token", "line-secret", "line-group-id", "line-group-name", "line-test", "webhook-url", "copy-webhook", "admin-table", "admin-add", "admin-editor", "ae-role", "logout"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain(`<span class="who">👤 ${TEST_ADMIN_NAME}（管理員）</span>`);
    expect(html).toContain('href="/account"');
    expect(html).toContain('href="/"');
    expect(html).toContain(TEST_ADMIN_EMAIL);
    expect(html).toContain("second@example.test");
    for (const id of ["login-form", "password-form"]) expect(html).not.toContain(`id="${id}"`);
  });

  it("所有狀態的 HTML 都帶安全標頭：CSP（script 只允許帶 nonce 的那段）、no-store、nosniff、不可被嵌入、noindex", async () => {
    const fresh = await makeSettingsApp({ withAdmin: false });
    const legacy = await makeSettingsApp({ legacyAdmin: true });
    const USER = accountId(40);
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: USER, name: "一般同事", email: "user@example.test", role: "user" })] });
    const responses = [
      await fresh.app.request("/settings"),
      await legacy.app.request("/settings"),
      await ctx.app.request("/login"),
      await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } }),
      await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie(USER) } }), // 403 頁
      await ctx.app.request("/account", { headers: { cookie: ctx.sessionCookie(USER) } }),
    ];
    for (const res of responses) {
      const csp = res.headers.get("content-security-policy")!;
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'"); // 同源的 /assets/wiwi-colors.css ＋ 頁面自己的 inline 樣式
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).not.toContain("script-src 'unsafe-inline'");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
      const html = await res.text();
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect((html.match(/<script/g) ?? []).length).toBe(1); // 只有一段 script
      expect(html).not.toMatch(/\son[a-z]+=/i); // 沒有 inline 事件屬性
    }
  });

  it("nonce 每次請求都不一樣", async () => {
    const ctx = await makeSettingsApp();
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const csp = (await ctx.app.request("/login")).headers.get("content-security-policy")!;
      nonces.add(/nonce-([^']+)'/.exec(csp)![1]!);
    }
    expect(nonces.size).toBe(5);
  });

  it("/settings/ 與 /settings 一樣；其他方法回 405 並註明 Allow", async () => {
    const ctx = await makeSettingsApp();
    expect((await ctx.app.request("/settings/", { headers: { cookie: ctx.sessionCookie() } })).status).toBe(200);
    const post = await ctx.app.request("/settings", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  it("webhook 網址依請求的 Host 與 X-Forwarded-Proto 顯示", async () => {
    const ctx = await makeSettingsApp();
    const get = async (headers: Record<string, string>) =>
      (await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie(), ...headers } })).text());
    expect(await get({ host: "savepoint-crate.zeabur.app", "x-forwarded-proto": "https" })).toContain(
      '<code id="webhook-url" class="mono">https://savepoint-crate.zeabur.app/api/line/webhook</code>',
    );
    // 沒有 X-Forwarded-Proto：公開網域視為 https，本機與內網視為 http
    expect(await get({ host: "savepoint-crate.zeabur.app" })).toContain("https://savepoint-crate.zeabur.app/api/line/webhook");
    expect(await get({ host: "localhost:8080" })).toContain("http://localhost:8080/api/line/webhook");
    expect(await get({ host: "192.168.1.20:8080" })).toContain("http://192.168.1.20:8080/api/line/webhook");
    // X-Forwarded-Host 優先
    expect(await get({ host: "internal:8080", "x-forwarded-host": "example.zeabur.app", "x-forwarded-proto": "https" })).toContain(
      "https://example.zeabur.app/api/line/webhook",
    );
  });

  it("Host 標頭不合法（可能是注入）：不顯示它，改用佔位字串，且頁面沒有未跳脫的內容", async () => {
    const ctx = await makeSettingsApp();
    const html = await (
      await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie(), "x-forwarded-host": 'evil"><script>alert(1)</script>' } })
    ).text();
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("https://&lt;網域&gt;/api/line/webhook");
  });
});

describe("資料目錄不可用", () => {
  it("GET /settings → 503 與掛載 Volume 的說明（仍帶安全標頭）", async () => {
    const ctx = await makeSettingsApp({ store: "unavailable" });
    const res = await ctx.app.request("/settings");
    expect(res.status).toBe(503);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("請在 Zeabur 掛載 Volume 到 /app/data");
    for (const id of ["setup-form", "login-form", "upgrade-form"]) expect(html).not.toContain(`id="${id}"`);
  });

  it.each([
    ["POST", "/settings/setup", setupBody()],
    ["POST", "/settings/upgrade", { currentPassword: TEST_ADMIN_PASSWORD, name: "甲", email: "a@example.test" }],
    ["POST", "/login", loginBody()],
    ["POST", "/logout", {}],
    ["GET", "/api/settings", undefined],
    ["PUT", "/api/settings/line", { enabled: false }],
    ["POST", "/api/settings/line/test", {}],
    ["GET", "/api/accounts", undefined],
    ["POST", "/api/accounts", { name: "甲", email: "a@example.test", password: GOOD_PASSWORD }],
    ["PATCH", `/api/accounts/${TEST_ADMIN_ID}`, { name: "乙" }],
    ["POST", `/api/accounts/${TEST_ADMIN_ID}/password`, { newPassword: GOOD_PASSWORD }],
    ["POST", `/api/accounts/${TEST_ADMIN_ID}/status`, { status: "disabled" }],
    ["DELETE", `/api/accounts/${TEST_ADMIN_ID}`, undefined],
  ] as Array<[string, string, unknown]>)("%s %s → 503「請在 Zeabur 掛載 Volume 到 /app/data」", async (method, path, body) => {
    const ctx = await makeSettingsApp({ store: "unavailable" });
    const res = await call(ctx.app, method, path, body);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: "請在 Zeabur 掛載 Volume 到 /app/data" });
    expect(ctx.calls).toHaveLength(0);
  });

  it("/healthz 仍然公開、回報 dataDirWritable:false；整個網站（主頁、登入頁、OCR、存檔、關箱通知）都因為沒有地方存帳號而用不了：主頁導向登入頁、登入頁與 API 回 503（環境變數版的 LINE 通知也一併停擺）", async () => {
    const ctx = await makeSettingsApp({
      store: "unavailable",
      env: { LINE_CHANNEL_ACCESS_TOKEN: "test-line-access-token-123", LINE_GROUP_ID: "C0123456789abcdef0123456789abcdef" },
    });
    const health = (await (await ctx.app.request("/healthz")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ dataDirWritable: false, adminConfigured: false, adminCount: 0, accountCount: 0, legacyAdminPending: false, lineConfigured: true, lineSource: "env" });
    expectRedirectToLogin(await ctx.app.request("/"), "/");
    const login = await ctx.app.request("/login");
    expect(login.status).toBe(503);
    expect(await login.text()).toContain("請在 Zeabur 掛載 Volume 到 /app/data");
    for (const path of ["/api/ocr", "/api/save", "/api/box-closed"]) {
      const res = await call(ctx.app, "POST", path, { boxId: "B1", items: [], total: 0, successCount: 0, failedCount: 0 });
      expect(res.status, path).toBe(503);
      expect(await res.json()).toEqual({ success: false, error: "請在 Zeabur 掛載 Volume 到 /app/data" });
    }
    expect(ctx.calls).toHaveLength(0);
  });
});

describe("請求內容上限與不允許的方法", () => {
  it("/settings/*、/api/settings/*、/api/accounts* 的內容超過 16 KB → 413", async () => {
    const ctx = await makeSettingsApp();
    const big = JSON.stringify({ password: "x".repeat(20 * 1024) });
    const login = await call(ctx.app, "POST", "/login", big);
    expect(login.status).toBe(413);
    expect(await login.json()).toEqual({ success: false, error: "請求內容過大" });
    const put = await ctx.authed("PUT", "/api/settings/line", JSON.stringify({ groupId: "C".repeat(20 * 1024) }));
    expect(put.status).toBe(413);
    expect(ctx.store.data.line.groupId).toBe("");
    const create = await ctx.authed("POST", "/api/accounts", JSON.stringify({ name: "甲", email: "a@example.test", password: "x".repeat(20 * 1024) }));
    expect(create.status).toBe(413);
    const patch = await ctx.authed("PATCH", `/api/accounts/${TEST_ADMIN_ID}`, JSON.stringify({ name: "x".repeat(20 * 1024) }));
    expect(patch.status).toBe(413);
    expect((await call(ctx.app, "POST", "/logout", JSON.stringify({ junk: "x".repeat(20 * 1024) }))).status).toBe(413);
    expect(ctx.store.data.accounts).toHaveLength(1);
  });

  it("其他方法一律 405 並註明 Allow", async () => {
    const ctx = await makeSettingsApp();
    const id = TEST_ADMIN_ID;
    const cases: Array<[string, string, string]> = [
      ["PUT", "/login", "GET, POST"],
      ["DELETE", "/login", "GET, POST"],
      ["GET", "/logout", "POST"],
      ["POST", "/api/me", "GET"],
      ["PUT", "/account", "GET"],
      ["POST", "/account", "GET"],
      ["GET", "/settings/setup", "POST"],
      ["GET", "/settings/upgrade", "POST"],
      ["PUT", "/logout", "POST"],
      ["POST", "/api/settings", "GET"],
      ["DELETE", "/api/settings", "GET"],
      ["GET", "/api/settings/line", "PUT"],
      ["POST", "/api/settings/line", "PUT"],
      ["GET", "/api/settings/line/test", "POST"],
      ["PUT", "/api/accounts", "GET, POST"],
      ["DELETE", "/api/accounts", "GET, POST"],
      ["GET", `/api/accounts/${id}`, "PATCH, DELETE"],
      ["PUT", `/api/accounts/${id}`, "PATCH, DELETE"],
      ["POST", `/api/accounts/${id}`, "PATCH, DELETE"],
      ["GET", `/api/accounts/${id}/password`, "POST"],
      ["PUT", `/api/accounts/${id}/password`, "POST"],
      ["GET", `/api/accounts/${id}/status`, "POST"],
      ["DELETE", `/api/accounts/${id}/status`, "POST"],
    ];
    for (const [method, path, allow] of cases) {
      const res = await ctx.app.request(path, { method, headers: { cookie: ctx.sessionCookie() } });
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
    }
  });
});

describe("狀態變更端點都有統一的 CSRF 檢查（走訪 app.routes，新增端點漏掉就會失敗）", () => {
  const MUTATING = [
    "POST /settings/setup",
    "POST /settings/upgrade",
    "POST /login",
    "POST /logout",
    "PUT /api/settings/line",
    "POST /api/settings/line/test",
    "POST /api/accounts",
    "PATCH /api/accounts/:id",
    "POST /api/accounts/:id/password",
    "POST /api/accounts/:id/status",
    "DELETE /api/accounts/:id",
  ];
  const isSettingsPath = (path: string) =>
    path === "/settings" || path.startsWith("/settings/") || path === "/api/settings" || path.startsWith("/api/settings/") || path === "/api/accounts" || path.startsWith("/api/accounts/") ||
    path === "/login" || path === "/logout" || path === "/account" || path.startsWith("/account/");

  it("設定、登入與帳號相關的非 GET 路由就是這 11 條（沒有 /account/password：密碼只由管理員設定）——新增端點時請用 mutate() 註冊並更新這張清單", async () => {
    const ctx = await makeSettingsApp();
    // app.post(path, guard, handler) 會在 routes 裡留下兩筆（中介層與處理器），所以先去重
    const found = [...new Set(ctx.app.routes.filter((r) => isSettingsPath(r.path) && !["GET", "ALL"].includes(r.method)).map((r) => `${r.method} ${r.path}`))].sort();
    expect(found).toEqual([...MUTATING].sort());
  });

  it.each(MUTATING)("%s：沒帶 Content-Type／X-Requested-With 的請求一律被擋（415），而且什麼都沒發生", async (route) => {
    const [method, pattern] = route.split(" ") as [string, string];
    const path = pattern.replace(":id", accountId(2));
    const ctx = await makeSettingsApp({ handler: lineHandler(), extraAccounts: [makeAccount({ id: accountId(2), email: "second@example.test" })] });
    const before = await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8");
    const res = await ctx.app.request(path, {
      method,
      headers: { cookie: ctx.sessionCookie() },
      body: JSON.stringify({ enabled: false, password: TEST_ADMIN_PASSWORD, newPassword: GOOD_PASSWORD, status: "disabled", name: "改名" }),
    });
    expect(res.status).toBe(415);
    expect(setCookieOf(res)).toBeUndefined();
    expect(ctx.calls).toHaveLength(0);
    expect(await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8")).toBe(before);
  });

  it("這些端點的回應都帶 nosniff 與 no-store（含錯誤回應）", async () => {
    const ctx = await makeSettingsApp();
    const ok = await call(ctx.app, "POST", "/login", loginBody());
    const bad = await call(ctx.app, "POST", "/login", loginBody({ password: "wrong-password-123" }));
    for (const res of [ok, bad]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    for (const path of ["/api/settings", "/api/accounts"]) {
      const get = await ctx.authed("GET", path);
      expect(get.headers.get("x-content-type-options")).toBe("nosniff");
      expect(get.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("安全相關事件的 log（留下暴力破解的足跡，但絕不帶密碼或設定碼）", () => {
  it("登入失敗與成功都有一行 log，帶 Email 與來源 IP", async () => {
    const ctx = await makeSettingsApp();
    await call(ctx.app, "POST", "/login", loginBody({ password: "my-wrong-guess-123" }), ip("203.0.113.77"));
    await call(ctx.app, "POST", "/login", loginBody(), ip("203.0.113.78"));
    expect(ctx.log.lines).toContain(`[accounts] ${TEST_ADMIN_EMAIL} 登入失敗（來源 203.0.113.77）`);
    expect(ctx.log.lines).toContain(`[accounts] ${TEST_ADMIN_EMAIL} 登入成功（來源 203.0.113.78）`);
    const logged = ctx.log.lines.join("\n");
    expect(logged).not.toContain("my-wrong-guess-123");
    expect(logged).not.toContain(TEST_ADMIN_PASSWORD);
  });

  it("失敗的安全事件用 warn 等級、成功的用 info（登入、設定碼）", async () => {
    const ctx = await makeSettingsApp();
    await call(ctx.app, "POST", "/login", loginBody({ password: "my-wrong-guess-123" }), ip("203.0.113.77"));
    await call(ctx.app, "POST", "/login", loginBody(), ip("203.0.113.78"));
    expect(ctx.log.warns).toContain(`[accounts] ${TEST_ADMIN_EMAIL} 登入失敗（來源 203.0.113.77）`);
    expect(ctx.log.warns).not.toContain(`[accounts] ${TEST_ADMIN_EMAIL} 登入成功（來源 203.0.113.78）`);
    expect(ctx.log.lines).toContain(`[accounts] ${TEST_ADMIN_EMAIL} 登入成功（來源 203.0.113.78）`);
    const fresh = await makeSettingsApp({ withAdmin: false });
    await call(fresh.app, "POST", "/settings/setup", setupBody({ setupCode: "WRONG-CODE-GUESS" }), ip("203.0.113.80"));
    expect(fresh.log.warns).toContain("[accounts] （尚未有帳號） 建立第一位管理員失敗：設定碼不正確（來源 203.0.113.80）");
  });

  it("查無帳號、停用帳號的失敗也記（記的是填的 Email，格式不對的一律記固定佔位字串，不會把任意字串寫進 log）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), email: "disabled@example.test", status: "disabled" })] });
    await call(ctx.app, "POST", "/login", { email: "  Nobody@Example.TEST ", password: "guess-password-1" }, ip("203.0.113.70"));
    await call(ctx.app, "POST", "/login", { email: "disabled@example.test", password: TEST_ADMIN_PASSWORD }, ip("203.0.113.71"));
    await call(ctx.app, "POST", "/login", { email: "evil\nINJECTED log line", password: "guess-password-2" }, ip("203.0.113.72"));
    await call(ctx.app, "POST", "/login", { email: { a: 1 }, password: "guess-password-3" }, ip("203.0.113.73"));
    expect(ctx.log.lines).toContain("[accounts] nobody@example.test 登入失敗（來源 203.0.113.70）");
    expect(ctx.log.lines).toContain("[accounts] disabled@example.test 登入失敗（來源 203.0.113.71）");
    expect(ctx.log.lines).toContain("[accounts] （格式不正確的 Email） 登入失敗（來源 203.0.113.72）");
    expect(ctx.log.lines).toContain("[accounts] （格式不正確的 Email） 登入失敗（來源 203.0.113.73）");
    const logged = ctx.log.lines.join("\n");
    expect(logged).not.toContain("INJECTED");
    for (const secret of ["guess-password-1", "guess-password-2", "guess-password-3", TEST_ADMIN_PASSWORD]) expect(logged).not.toContain(secret);
    expect(ctx.log.lines.every((l) => !l.includes("\n"))).toBe(true);
  });

  it("設定碼錯誤也有 log（沒有設定碼、沒有密碼）", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: "WRONG-CODE-GUESS" }), ip("203.0.113.80"));
    expect(ctx.log.lines).toContain("[accounts] （尚未有帳號） 建立第一位管理員失敗：設定碼不正確（來源 203.0.113.80）");
    const logged = ctx.log.lines.join("\n");
    expect(logged).not.toContain("WRONG-CODE-GUESS");
    expect(logged).not.toContain(GOOD_PASSWORD);
  });

  it("被限流擋下的請求不再寫 log（洪水不會灌爆 log）", async () => {
    const ctx = await makeSettingsApp();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) await call(ctx.app, "POST", "/login", loginBody({ password: "wrong-password-123" }), ip("203.0.113.90"));
    const linesBefore = ctx.log.lines.length;
    for (let i = 0; i < 20; i++) expect((await call(ctx.app, "POST", "/login", loginBody({ password: "wrong-password-123" }), ip("203.0.113.90"))).status).toBe(429);
    expect(ctx.log.lines.length).toBe(linesBefore);
  });
});

describe("scrypt 的並行上限（PasswordGate）：公開端點被灌請求也不會占滿執行緒池", () => {
  it(`同時最多 ${PASSWORD_GATE_MAX_ACTIVE} 個在算、${PASSWORD_GATE_MAX_QUEUE} 個排隊，其餘直接 429；每個回應不是 401 就是 429`, async () => {
    expect([PASSWORD_GATE_MAX_ACTIVE, PASSWORD_GATE_MAX_QUEUE]).toEqual([2, 16]);
    const ctx = await makeSettingsApp();
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) => call(ctx.app, "POST", "/login", loginBody({ password: `wrong-password-${i}` }), ip(`198.51.100.${i + 1}`))),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.every((st) => st === 401 || st === 429)).toBe(true);
    expect(statuses.filter((st) => st === 401).length).toBeGreaterThanOrEqual(PASSWORD_GATE_MAX_ACTIVE);
    expect(statuses.filter((st) => st === 401).length).toBeLessThanOrEqual(PASSWORD_GATE_MAX_ACTIVE + PASSWORD_GATE_MAX_QUEUE);
    expect(statuses.filter((st) => st === 429).length).toBeGreaterThanOrEqual(60 - PASSWORD_GATE_MAX_ACTIVE - PASSWORD_GATE_MAX_QUEUE);
    const rejected = responses.find((r) => r.status === 429)!;
    expect(await rejected.json()).toEqual({ success: false, error: "目前驗證請求過多，請稍後再試" });
    expect(rejected.headers.get("retry-after")).toBe("1"); // 和逐 IP 限流的 429 一樣，告訴呼叫端過幾秒再試
    // 洪水過後恢復正常：名額都有歸還
    expect((await call(ctx.app, "POST", "/login", loginBody(), ip("198.51.100.200"))).status).toBe(200);
  });
});

describe("不是 HTTPS 時的警告與 /healthz 的 requestIsHttps", () => {
  const BANNER = 'id="insecure-notice"';
  /** 登入頁（沒帶 authed 時是 /login，因為有帳號又沒登入的 /settings 會被導向）或設定頁。 */
  const page = async (ctx: Awaited<ReturnType<typeof makeSettingsApp>>, headers: Record<string, string>, authed = false) =>
    (await ctx.app.request(authed ? "/settings" : ctx.store.data.accounts.length > 0 ? "/login" : "/settings", { headers: { ...(authed ? { cookie: ctx.sessionCookie() } : {}), ...headers } })).text();

  it("公開網域上的明文 http：登入頁、建立管理員頁、升級頁、設定頁都在頂端顯示警告", async () => {
    const ctx = await makeSettingsApp();
    const fresh = await makeSettingsApp({ withAdmin: false });
    const legacy = await makeSettingsApp({ legacyAdmin: true });
    const headers = { host: "savepoint-crate.zeabur.app", "x-forwarded-proto": "http" };
    expect(await page(ctx, headers)).toContain(BANNER);
    expect(await page(fresh, headers)).toContain(BANNER);
    expect(await page(legacy, headers)).toContain(BANNER);
    expect(await page(ctx, headers, true)).toContain(BANNER);
    expect(await page(ctx, headers)).toContain("目前的連線不是 HTTPS");
  });

  it("沒有 X-Forwarded-Proto 的公開網域（代理沒送）也警告；https、本機、內網都不警告", async () => {
    const ctx = await makeSettingsApp();
    // 沒有 X-Forwarded-Proto 時，app.request 的連線本身是 http://localhost，所以要靠 Host 判斷主機類型
    expect(await page(ctx, { host: "savepoint-crate.zeabur.app" })).toContain(BANNER);
    expect(await page(ctx, { host: "savepoint-crate.zeabur.app", "x-forwarded-proto": "https" })).not.toContain(BANNER);
    expect(await page(ctx, { host: "localhost:8080" })).not.toContain(BANNER);
    expect(await page(ctx, { host: "192.168.1.20:8080" })).not.toContain(BANNER);
    expect(await page(ctx, {})).not.toContain(BANNER); // 看不出主機（沒有 Host 標頭）：不亂警告
  });

  it("/healthz 的 requestIsHttps：有送 X-Forwarded-Proto: https 才是 true", async () => {
    const ctx = await makeSettingsApp();
    const get = async (headers: Record<string, string>) => ((await (await ctx.app.request("/healthz", { headers })).json()) as { requestIsHttps: boolean }).requestIsHttps;
    expect(await get({})).toBe(false);
    expect(await get({ "x-forwarded-proto": "http" })).toBe(false);
    expect(await get({ "x-forwarded-proto": "https" })).toBe(true);
    expect(await get({ "x-forwarded-proto": "https, http" })).toBe(true);
  });
});

describe("/healthz 的管理員欄位", () => {
  const health = async (ctx: Awaited<ReturnType<typeof makeSettingsApp>>) => (await (await ctx.app.request("/healthz")).json()) as Record<string, unknown>;

  it("全新安裝：adminConfigured false、adminCount 0、legacyAdminPending false", async () => {
    expect(await health(await makeSettingsApp({ withAdmin: false }))).toMatchObject({ adminConfigured: false, adminCount: 0, legacyAdminPending: false });
  });

  it("還有待升級的舊版單一密碼：adminConfigured true、adminCount 0、legacyAdminPending true", async () => {
    expect(await health(await makeSettingsApp({ legacyAdmin: true }))).toMatchObject({ adminConfigured: true, adminCount: 0, legacyAdminPending: true });
  });

  it("有管理員：adminConfigured（至少一位啟用中）、adminCount（含停用的）、legacyAdminPending false", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [makeAccount({ id: accountId(2), email: "b@example.test", status: "disabled" })] });
    expect(await health(ctx)).toMatchObject({ adminConfigured: true, adminCount: 2, legacyAdminPending: false });
  });

  it("全部管理員都停用（只可能是手動編輯檔案）：adminConfigured false、adminCount 仍計入", async () => {
    const ctx = await makeSettingsApp();
    await ctx.store.update((draft) => {
      draft.accounts[0]!.status = "disabled";
    });
    expect(await health(ctx)).toMatchObject({ adminConfigured: false, adminCount: 1, legacyAdminPending: false });
  });

  it("不含任何管理員的姓名、Email 或雜湊", async () => {
    const ctx = await makeSettingsApp();
    const text = JSON.stringify(await health(ctx));
    for (const secret of [TEST_ADMIN_EMAIL, TEST_ADMIN_NAME, "scrypt$", TEST_ADMIN_ID]) expect(text).not.toContain(secret);
  });
});

describe("不注入設定碼（正式啟動的做法）：log 裡的設定碼真的能用，換新碼時也會寫進 log", () => {
  const codeIn = (lines: string[]): string[] =>
    lines.map((l) => /設定碼 ([A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}) 建立密碼/.exec(l)?.[1]).filter((c): c is string => typeof c === "string");

  it("啟動 log 的設定碼可以用來建立第一位管理員", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false, defaultSetupCode: true });
    const codes = codeIn(ctx.log.lines);
    expect(codes).toHaveLength(1);
    expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: codes[0] }))).status).toBe(200);
  });

  it("累計 20 次錯誤：舊碼作廢、新碼寫進 log（第二組不同於第一組）且可以用", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false, defaultSetupCode: true });
    const [first] = codeIn(ctx.log.lines);
    for (let i = 0; i < 20; i++) {
      await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: "ZZZZ-ZZZZ" }), ip(`198.51.100.${i + 1}`));
    }
    const codes = codeIn(ctx.log.lines);
    expect(codes).toHaveLength(2);
    expect(codes[1]).not.toBe(first);
    expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: first }), ip("198.51.100.100"))).status).toBe(403);
    expect((await call(ctx.app, "POST", "/settings/setup", setupBody({ setupCode: codes[1] }), ip("198.51.100.101"))).status).toBe(200);
  });
});
