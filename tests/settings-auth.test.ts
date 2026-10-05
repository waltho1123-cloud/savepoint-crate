import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "../src/auth.js";
import { LOGIN_RATE_LIMIT_MAX, PASSWORD_GATE_MAX_ACTIVE, PASSWORD_GATE_MAX_QUEUE, SETUP_RATE_LIMIT_MAX } from "../src/settings-routes.js";
import { SETTINGS_FILE_NAME } from "../src/settings-store.js";
import {
  call,
  cleanupTempDirs,
  cookiePair,
  lineHandler,
  makeSettingsApp,
  NOW_MS,
  setCookieOf,
  TEST_ADMIN_PASSWORD,
  TEST_SETUP_CODE,
} from "./settings-helpers.js";

afterEach(cleanupTempDirs);

const GOOD_PASSWORD = "a-brand-new-password-42";

const ip = (address: string) => ({ "x-forwarded-for": address });

describe("啟動時的設定碼提示", () => {
  it("還沒設定管理密碼：log 有一行含設定碼的提示（格式固定）", async () => {
    const { log } = await makeSettingsApp({ withAdmin: false });
    expect(log.lines).toContain(`[settings] 尚未設定管理密碼：請開啟 /settings，用設定碼 ${TEST_SETUP_CODE} 建立密碼`);
  });

  it("已經有管理密碼：不再提示", async () => {
    const { log } = await makeSettingsApp();
    expect(log.lines.some((line) => line.includes("設定碼"))).toBe(false);
  });

  it("資料目錄不可用：不提示（用不到）", async () => {
    const { log } = await makeSettingsApp({ store: "unavailable" });
    expect(log.lines.some((line) => line.includes("設定碼"))).toBe(false);
  });
});

describe("狀態變更端點的 CSRF 防護（Content-Type 與 X-Requested-With）", () => {
  const endpoints: Array<[string, string, unknown]> = [
    ["POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: GOOD_PASSWORD }],
    ["POST", "/settings/login", { password: TEST_ADMIN_PASSWORD }],
    ["POST", "/settings/logout", {}],
    ["POST", "/settings/password", { currentPassword: TEST_ADMIN_PASSWORD, newPassword: GOOD_PASSWORD }],
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
    const res = await ctx.app.request("/settings/login", {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
      body: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(200);
  });
});

describe("設定頁的限流額度（規格的數字，每個 IP 每分鐘）", () => {
  it("建立密碼 5 次、登入與更改密碼共用 10 次（其他測試的迴圈是跟著常數跑的，所以這裡把數字本身釘住）", () => {
    expect(SETUP_RATE_LIMIT_MAX).toBe(5);
    expect(LOGIN_RATE_LIMIT_MAX).toBe(10);
  });
});

describe("POST /settings/setup（用設定碼建立管理密碼）", () => {
  it("設定碼錯誤 → 403，沒有 cookie，也沒有建立密碼", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: "ZZZZ-ZZZZ", password: GOOD_PASSWORD });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: "設定碼不正確" });
    expect(setCookieOf(res)).toBeUndefined();
    expect(ctx.store.data.admin).toBeNull();
  });

  it("缺少設定碼、設定碼不是字串 → 403", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (const body of [{ password: GOOD_PASSWORD }, { setupCode: 12345678, password: GOOD_PASSWORD }, { setupCode: null, password: GOOD_PASSWORD }]) {
      const res = await call(ctx.app, "POST", "/settings/setup", body);
      expect(res.status).toBe(403);
    }
  });

  it("密碼太短（9 字元）→ 400，設定碼仍然有效、可以重試", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: "123456789" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "密碼至少要 10 個字元" });
    expect(ctx.store.data.admin).toBeNull();
    expect(ctx.setupCode.currentCode).toBe(TEST_SETUP_CODE);
    const retry = await call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: GOOD_PASSWORD });
    expect(retry.status).toBe(200);
  });

  it("密碼太長（201 字元）、缺少密碼、密碼不是字串 → 400", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (const password of ["x".repeat(201), undefined, 123456789012, null]) {
      const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password });
      expect(res.status).toBe(400);
    }
    expect(ctx.store.data.admin).toBeNull();
  });

  it("成功：200、存下 scrypt 雜湊（檔案裡沒有明文密碼）、發登入 cookie、設定碼作廢、healthz 顯示已設定", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: GOOD_PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(ctx.store.data.admin?.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(ctx.store.data.admin?.updatedAt).toBe(new Date(NOW_MS).toISOString());
    const file = await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8");
    expect(file).toContain("scrypt$16384$8$1$");
    expect(file).not.toContain(GOOD_PASSWORD);
    expect(ctx.log.lines.join("\n")).not.toContain(GOOD_PASSWORD);

    // 拿到的 cookie 馬上可用
    const settings = await call(ctx.app, "GET", "/api/settings", undefined, { cookie: cookiePair(res) });
    expect(settings.status).toBe(200);
    expect(ctx.setupCode.currentCode).toBeNull();
    const health = (await (await ctx.app.request("/healthz")).json()) as { adminConfigured: boolean };
    expect(health.adminConfigured).toBe(true);
    expect(ctx.log.lines).toContain("[settings] 管理密碼已建立");
  });

  it("設定碼不分大小寫、橫線可省略", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: "abcdefgh", password: GOOD_PASSWORD });
    expect(res.status).toBe(200);
  });

  it("已經建立過密碼：再來 setup 一律 409（即使設定碼正確），不會覆蓋既有密碼", async () => {
    const ctx = await makeSettingsApp();
    const hashBefore = ctx.store.data.admin?.passwordHash;
    const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: GOOD_PASSWORD });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: "已經建立過管理密碼，請直接登入" });
    expect(ctx.store.data.admin?.passwordHash).toBe(hashBefore);
  });

  it("已經有密碼時，連設定碼對不對都不檢查（一律 409）：不能當成猜設定碼的管道，也不消耗設定碼的錯誤次數", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    await call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: GOOD_PASSWORD });
    for (let i = 0; i < 6; i++) {
      const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: "ZZZZ-ZZZZ", password: GOOD_PASSWORD }, ip(`198.51.100.${i + 1}`));
      expect(res.status).toBe(409);
    }
  });

  it("兩個請求同時用正確的設定碼：只有一個成功，另一個 409，最後只有一個密碼", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const [a, b] = await Promise.all([
      call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: "first-password-1234" }, ip("203.0.113.1")),
      call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: "second-password-5678" }, ip("203.0.113.2")),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // 登入得進去的只有贏的那個密碼
    const winnerPassword = a.status === 200 ? "first-password-1234" : "second-password-5678";
    const loser = a.status === 200 ? "second-password-5678" : "first-password-1234";
    expect((await call(ctx.app, "POST", "/settings/login", { password: winnerPassword })).status).toBe(200);
    expect((await call(ctx.app, "POST", "/settings/login", { password: loser })).status).toBe(401);
  });

  it(`每個 IP 每分鐘 ${SETUP_RATE_LIMIT_MAX} 次（每次嘗試都算）：第 ${SETUP_RATE_LIMIT_MAX + 1} 次 429＋Retry-After，其他 IP 不受影響，一分鐘後恢復`, async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (let i = 0; i < SETUP_RATE_LIMIT_MAX; i++) {
      const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: "ZZZZ-ZZZZ", password: GOOD_PASSWORD }, ip("203.0.113.10"));
      expect(res.status).toBe(403);
    }
    const blocked = await call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: GOOD_PASSWORD }, ip("203.0.113.10"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(await blocked.json()).toEqual({ success: false, error: "請求過於頻繁，請稍後再試" });
    expect(ctx.store.data.admin).toBeNull(); // 被擋下的請求連設定碼都沒驗

    const other = await call(ctx.app, "POST", "/settings/setup", { setupCode: "ZZZZ-ZZZZ", password: GOOD_PASSWORD }, ip("203.0.113.11"));
    expect(other.status).toBe(403);

    ctx.clock.now += 60_001;
    const later = await call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: GOOD_PASSWORD }, ip("203.0.113.10"));
    expect(later.status).toBe(200);
  });

  it("用很多不同 IP 繞過逐 IP 限流也沒用：累計 20 次錯誤，設定碼整組作廢、換新的並寫進 log", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (let i = 0; i < 20; i++) {
      const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: "ZZZZ-ZZZZ", password: GOOD_PASSWORD }, ip(`198.51.100.${i + 1}`));
      expect(res.status).toBe(403);
    }
    // 舊的（正確的）設定碼已經作廢
    const old = await call(ctx.app, "POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: GOOD_PASSWORD }, ip("198.51.100.99"));
    expect(old.status).toBe(403);
    expect(ctx.setupCode.currentCode).not.toBe(TEST_SETUP_CODE);
    // 新的碼可以用（log 裡的就是新碼：這裡的 app 是用注入的 guard，沒有接 onRegenerate，所以直接取 guard 的值）
    const fresh = await call(ctx.app, "POST", "/settings/setup", { setupCode: ctx.setupCode.currentCode!, password: GOOD_PASSWORD }, ip("198.51.100.100"));
    expect(fresh.status).toBe(200);
  });
});

describe("POST /settings/login", () => {
  it("密碼正確：200 與 session cookie（HttpOnly、SameSite=Lax、Path=/、Max-Age=7 天；http 下沒有 Secure）", async () => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const cookie = setCookieOf(res)!;
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(cookie).not.toContain("Secure");
    // cookie 值：<到期時間>.<亂數>.<簽章>，到期時間是現在加 7 天
    const value = decodeURIComponent(cookie.split(";")[0]!.slice(SESSION_COOKIE_NAME.length + 1));
    expect(value.split(".")).toHaveLength(3);
    expect(Number(value.split(".")[0])).toBe(NOW_MS + SESSION_TTL_MS);
  });

  it("走 HTTPS（X-Forwarded-Proto: https，Zeabur 反向代理）：cookie 帶 Secure；直接 http 不帶", async () => {
    const ctx = await makeSettingsApp();
    const https = await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD }, { "x-forwarded-proto": "https" });
    expect(setCookieOf(https)).toContain("Secure");
    const chain = await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD }, { "x-forwarded-proto": "https, http" });
    expect(setCookieOf(chain)).toContain("Secure");
    const http = await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD }, { "x-forwarded-proto": "http" });
    expect(setCookieOf(http)).not.toContain("Secure");
  });

  it("密碼錯誤 → 401（訊息固定，不透露細節），沒有 cookie", async () => {
    const ctx = await makeSettingsApp();
    for (const password of ["wrong-password-123", "", TEST_ADMIN_PASSWORD.toUpperCase(), `${TEST_ADMIN_PASSWORD} `]) {
      const res = await call(ctx.app, "POST", "/settings/login", { password });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, error: "密碼不正確" });
      expect(setCookieOf(res)).toBeUndefined();
    }
  });

  it("沒有密碼欄位、密碼不是字串、超過 200 字元 → 401", async () => {
    const ctx = await makeSettingsApp();
    for (const body of [{}, { password: 123 }, { password: null }, { password: "x".repeat(201) }]) {
      expect((await call(ctx.app, "POST", "/settings/login", body)).status).toBe(401);
    }
  });

  it("還沒設定管理密碼 → 400 並提示先建立", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const res = await call(ctx.app, "POST", "/settings/login", { password: "whatever-password" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "尚未設定管理密碼，請先用設定碼建立密碼" });
  });

  it("請求內容不是 JSON、不是物件 → 400", async () => {
    const ctx = await makeSettingsApp();
    expect((await call(ctx.app, "POST", "/settings/login", "{not json")).status).toBe(400);
    expect((await call(ctx.app, "POST", "/settings/login", "[1,2]")).status).toBe(400);
    expect((await call(ctx.app, "POST", "/settings/login", "")).status).toBe(400);
  });

  it(`每個 IP 每分鐘 ${LOGIN_RATE_LIMIT_MAX} 次：第 ${LOGIN_RATE_LIMIT_MAX + 1} 次 429（連正確的密碼也一樣），一分鐘後恢復，其他 IP 不受影響`, async () => {
    const ctx = await makeSettingsApp();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      expect((await call(ctx.app, "POST", "/settings/login", { password: "wrong-password-123" }, ip("203.0.113.20"))).status).toBe(401);
    }
    const blocked = await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD }, ip("203.0.113.20"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD }, ip("203.0.113.21"))).status).toBe(200);
    ctx.clock.now += 60_001;
    expect((await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD }, ip("203.0.113.20"))).status).toBe(200);
  });

  it("登入、建立密碼、改密碼的限流額度互相獨立（setup 5／login 10）", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    for (let i = 0; i < SETUP_RATE_LIMIT_MAX; i++) {
      await call(ctx.app, "POST", "/settings/setup", { setupCode: "ZZZZ-ZZZZ", password: GOOD_PASSWORD }, ip("203.0.113.30"));
    }
    expect((await call(ctx.app, "POST", "/settings/setup", { setupCode: "ZZZZ-ZZZZ", password: GOOD_PASSWORD }, ip("203.0.113.30"))).status).toBe(429);
    // setup 被擋，login 還有額度（回 400「尚未設定」而不是 429）
    expect((await call(ctx.app, "POST", "/settings/login", { password: "x" }, ip("203.0.113.30"))).status).toBe(400);
  });
});

describe("session cookie 的驗證", () => {
  it("有效的 cookie 可以讀設定；沒有 cookie → 401", async () => {
    const ctx = await makeSettingsApp();
    expect((await ctx.authed("GET", "/api/settings")).status).toBe(200);
    const res = await call(ctx.app, "GET", "/api/settings");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "請先登入" });
  });

  it("被竄改的 cookie → 401：改簽章、改到期時間、改亂數、拿別的金鑰簽的", async () => {
    const ctx = await makeSettingsApp();
    const good = ctx.sessionCookie().slice(SESSION_COOKIE_NAME.length + 1);
    const [expires, nonce, mac] = good.split(".") as [string, string, string];
    const flippedMac = `${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`;
    const tampered = [
      `${expires}.${nonce}.${flippedMac}`,
      `${Number(expires) + 86_400_000}.${nonce}.${mac}`,
      `${expires}.${nonce.slice(0, -1)}${nonce.endsWith("A") ? "B" : "A"}.${mac}`,
      "garbage",
      "",
      `${expires}.${nonce}`,
    ];
    for (const value of tampered) {
      const res = await call(ctx.app, "GET", "/api/settings", undefined, { cookie: `${SESSION_COOKIE_NAME}=${value}` });
      expect(res.status).toBe(401);
    }
  });

  it("到期的 cookie → 401（API 與頁面都是）：剛好 7 天後失效", async () => {
    const ctx = await makeSettingsApp();
    const cookie = ctx.sessionCookie();
    ctx.clock.now += SESSION_TTL_MS - 1;
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie })).status).toBe(200);
    ctx.clock.now += 1;
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie })).status).toBe(401);
    const page = await ctx.app.request("/settings", { headers: { cookie } });
    expect(await page.text()).toContain('id="login-form"');
  });

  it("同名但無關的其他 cookie 不會被當成登入", async () => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, "GET", "/api/settings", undefined, { cookie: "other=1; session=abc; sp_session_x=2" });
    expect(res.status).toBe(401);
  });

  it("cookie 夾在其他 cookie 之間也能讀到", async () => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, "GET", "/api/settings", undefined, { cookie: `a=1; ${ctx.sessionCookie()}; b=2` });
    expect(res.status).toBe(200);
  });
});

describe("POST /settings/logout", () => {
  it("回 200 並清掉 cookie（Max-Age=0、Path=/）；不需要已登入", async () => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, "POST", "/settings/logout", {}, { cookie: ctx.sessionCookie() });
    expect(res.status).toBe(200);
    const cookie = setCookieOf(res)!;
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/");
    const anonymous = await call(ctx.app, "POST", "/settings/logout", {});
    expect(anonymous.status).toBe(200);
  });

  it("走 HTTPS 時清除的 cookie 也帶 Secure（才蓋得過 Secure 的 cookie）", async () => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, "POST", "/settings/logout", {}, { "x-forwarded-proto": "https" });
    expect(setCookieOf(res)).toContain("Secure");
  });
});

describe("POST /settings/password（更改管理密碼）", () => {
  it("沒登入 → 401；密碼不會被改", async () => {
    const ctx = await makeSettingsApp();
    const hash = ctx.store.data.admin?.passwordHash;
    const res = await call(ctx.app, "POST", "/settings/password", { currentPassword: TEST_ADMIN_PASSWORD, newPassword: GOOD_PASSWORD });
    expect(res.status).toBe(401);
    expect(ctx.store.data.admin?.passwordHash).toBe(hash);
  });

  it("目前的密碼錯誤 → 403（不是 401，免得頁面當成登入過期）", async () => {
    const ctx = await makeSettingsApp();
    const res = await ctx.authed("POST", "/settings/password", { currentPassword: "not-my-password", newPassword: GOOD_PASSWORD });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: "目前的密碼不正確" });
  });

  it("新密碼太短 → 400；和目前的相同 → 400；缺欄位 → 錯誤；都不會改動", async () => {
    const ctx = await makeSettingsApp();
    const hash = ctx.store.data.admin?.passwordHash;
    const short = await ctx.authed("POST", "/settings/password", { currentPassword: TEST_ADMIN_PASSWORD, newPassword: "short" });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ success: false, error: "密碼至少要 10 個字元" });
    const same = await ctx.authed("POST", "/settings/password", { currentPassword: TEST_ADMIN_PASSWORD, newPassword: TEST_ADMIN_PASSWORD });
    expect(same.status).toBe(400);
    expect(await same.json()).toEqual({ success: false, error: "新密碼不能和目前的密碼相同" });
    expect((await ctx.authed("POST", "/settings/password", { newPassword: GOOD_PASSWORD })).status).toBe(403);
    expect((await ctx.authed("POST", "/settings/password", { currentPassword: TEST_ADMIN_PASSWORD })).status).toBe(400);
    expect(ctx.store.data.admin?.passwordHash).toBe(hash);
  });

  it("成功：新密碼可登入、舊密碼不行；簽章金鑰換掉，所有舊 cookie 失效；目前這個瀏覽器拿到新 cookie", async () => {
    const ctx = await makeSettingsApp();
    const oldCookie = ctx.sessionCookie();
    const oldSecret = ctx.store.data.sessionSecret;
    const res = await call(ctx.app, "POST", "/settings/password", { currentPassword: TEST_ADMIN_PASSWORD, newPassword: GOOD_PASSWORD }, { cookie: oldCookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(ctx.store.data.sessionSecret).not.toBe(oldSecret);
    expect(ctx.store.data.sessionSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.store.data.admin?.updatedAt).toBe(new Date(NOW_MS).toISOString());
    const file = await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8");
    expect(file).not.toContain(GOOD_PASSWORD);
    expect(file).not.toContain(TEST_ADMIN_PASSWORD);
    expect(JSON.parse(file).sessionSecret).toBe(ctx.store.data.sessionSecret);

    // 舊 cookie 失效、新 cookie 有效
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: oldCookie })).status).toBe(401);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: cookiePair(res) })).status).toBe(200);
    // 密碼：新的可以、舊的不行
    expect((await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD })).status).toBe(401);
    expect((await call(ctx.app, "POST", "/settings/login", { password: GOOD_PASSWORD })).status).toBe(200);
    expect(ctx.log.lines).toContain("[settings] 管理密碼已更新，既有的登入已全部失效");
  });

  it(`和登入共用額度（每 IP 每分鐘 ${LOGIN_RATE_LIMIT_MAX} 次）：用偷來的 cookie 也不能猜目前的密碼猜很多次`, async () => {
    const ctx = await makeSettingsApp();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      const res = await ctx.authed("POST", "/settings/password", { currentPassword: `wrong-guess-${i}`, newPassword: GOOD_PASSWORD }, ip("203.0.113.40"));
      expect(res.status).toBe(403);
    }
    const blocked = await ctx.authed("POST", "/settings/password", { currentPassword: TEST_ADMIN_PASSWORD, newPassword: GOOD_PASSWORD }, ip("203.0.113.40"));
    expect(blocked.status).toBe(429);
    expect(ctx.store.data.admin?.passwordHash).toBeDefined();
  });
});

describe("GET /settings（頁面的三種狀態）", () => {
  it("還沒設定管理密碼：建立密碼的表單（設定碼＋兩次密碼），沒有登入表單與設定表單", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    const res = await ctx.app.request("/settings");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="setup-form"');
    expect(html).toContain('id="setup-code"');
    expect(html).toContain('id="setup-password2"');
    expect(html).not.toContain('id="login-form"');
    expect(html).not.toContain('id="line-form"');
    expect(html).not.toContain(TEST_SETUP_CODE); // 頁面不會洩漏設定碼
  });

  it("有密碼、沒登入：登入表單，沒有設定表單", async () => {
    const ctx = await makeSettingsApp();
    const html = await (await ctx.app.request("/settings")).text();
    expect(html).toContain('id="login-form"');
    expect(html).not.toContain('id="line-form"');
    expect(html).not.toContain('id="setup-form"');
  });

  it("已登入：設定表單（LINE 開關、token、secret、群組 ID、測試、webhook 網址、改密碼、登出）", async () => {
    const ctx = await makeSettingsApp();
    const res = await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } });
    const html = await res.text();
    for (const id of ["line-form", "line-enabled", "line-token", "line-secret", "line-group-id", "line-group-name", "line-test", "webhook-url", "copy-webhook", "password-form", "logout"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('id="login-form"');
  });

  it("三種狀態的 HTML 都帶安全標頭：CSP（script 只允許帶 nonce 的那段）、no-store、nosniff、不可被嵌入、noindex", async () => {
    const withoutAdmin = await makeSettingsApp({ withAdmin: false });
    const ctx = await makeSettingsApp();
    const responses = [
      await withoutAdmin.app.request("/settings"),
      await ctx.app.request("/settings"),
      await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } }),
    ];
    for (const res of responses) {
      const csp = res.headers.get("content-security-policy")!;
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("connect-src 'self'");
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
      const csp = (await ctx.app.request("/settings")).headers.get("content-security-policy")!;
      nonces.add(/nonce-([^']+)'/.exec(csp)![1]!);
    }
    expect(nonces.size).toBe(5);
  });

  it("/settings/ 與 /settings 一樣；其他方法回 405 並註明 Allow", async () => {
    const ctx = await makeSettingsApp();
    expect((await ctx.app.request("/settings/")).status).toBe(200);
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
    expect(html).not.toContain('id="setup-form"');
    expect(html).not.toContain('id="login-form"');
  });

  it.each([
    ["POST", "/settings/setup", { setupCode: TEST_SETUP_CODE, password: GOOD_PASSWORD }],
    ["POST", "/settings/login", { password: TEST_ADMIN_PASSWORD }],
    ["POST", "/settings/logout", {}],
    ["POST", "/settings/password", { currentPassword: "x", newPassword: GOOD_PASSWORD }],
    ["GET", "/api/settings", undefined],
    ["PUT", "/api/settings/line", { enabled: false }],
    ["POST", "/api/settings/line/test", {}],
  ] as Array<[string, string, unknown]>)("%s %s → 503「請在 Zeabur 掛載 Volume 到 /app/data」", async (method, path, body) => {
    const ctx = await makeSettingsApp({ store: "unavailable" });
    const res = await call(ctx.app, method, path, body);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: "請在 Zeabur 掛載 Volume 到 /app/data" });
    expect(ctx.calls).toHaveLength(0);
  });

  it("/healthz 回報 dataDirWritable:false；OCR 與環境變數版的 LINE 通知不受影響", async () => {
    const ctx = await makeSettingsApp({
      store: "unavailable",
      env: { LINE_CHANNEL_ACCESS_TOKEN: "test-line-access-token-123", LINE_GROUP_ID: "C0123456789abcdef0123456789abcdef" },
    });
    const health = (await (await ctx.app.request("/healthz")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ dataDirWritable: false, adminConfigured: false, lineConfigured: true, lineSource: "env" });
    const notify = await call(ctx.app, "POST", "/api/box-closed", { boxId: "B1", items: [], total: 0, successCount: 0, failedCount: 0 });
    expect(await notify.json()).toEqual({ success: true, notified: true });
    expect(ctx.calls.map((c) => c.url)).toEqual(["https://api.line.me/v2/bot/message/push"]);
  });
});

describe("請求內容上限與不允許的方法", () => {
  it("/settings/* 與 /api/settings/* 的內容超過 16 KB → 413", async () => {
    const ctx = await makeSettingsApp();
    const big = JSON.stringify({ password: "x".repeat(20 * 1024) });
    const login = await call(ctx.app, "POST", "/settings/login", big);
    expect(login.status).toBe(413);
    expect(await login.json()).toEqual({ success: false, error: "請求內容過大" });
    const put = await ctx.authed("PUT", "/api/settings/line", JSON.stringify({ groupId: "C".repeat(20 * 1024) }));
    expect(put.status).toBe(413);
    expect(ctx.store.data.line.groupId).toBe("");
  });

  it("其他方法一律 405 並註明 Allow", async () => {
    const ctx = await makeSettingsApp();
    const cases: Array<[string, string, string]> = [
      ["GET", "/settings/login", "POST"],
      ["GET", "/settings/setup", "POST"],
      ["PUT", "/settings/logout", "POST"],
      ["GET", "/settings/password", "POST"],
      ["POST", "/api/settings", "GET"],
      ["DELETE", "/api/settings", "GET"],
      ["GET", "/api/settings/line", "PUT"],
      ["POST", "/api/settings/line", "PUT"],
      ["GET", "/api/settings/line/test", "POST"],
    ];
    for (const [method, path, allow] of cases) {
      const res = await ctx.app.request(path, { method, headers: { cookie: ctx.sessionCookie() } });
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
    }
  });
});

describe("狀態變更端點都有統一的 CSRF 檢查（走訪 app.routes，新增端點漏掉就會失敗）", () => {
  const MUTATING = ["POST /settings/setup", "POST /settings/login", "POST /settings/logout", "POST /settings/password", "PUT /api/settings/line", "POST /api/settings/line/test"];

  it("設定相關的非 GET 路由就是這 6 條——新增端點時請用 mutate() 註冊並更新這張清單", async () => {
    const ctx = await makeSettingsApp();
    // app.post(path, guard, handler) 會在 routes 裡留下兩筆（中介層與處理器），所以先去重
    const found = [
      ...new Set(
        ctx.app.routes
          .filter((r) => (r.path === "/settings" || r.path.startsWith("/settings/") || r.path === "/api/settings" || r.path.startsWith("/api/settings/")) && !["GET", "ALL"].includes(r.method))
          .map((r) => `${r.method} ${r.path}`),
      ),
    ].sort();
    expect(found).toEqual([...MUTATING].sort());
  });

  it.each(MUTATING)("%s：沒帶 Content-Type／X-Requested-With 的請求一律被擋（415），而且什麼都沒發生", async (route) => {
    const [method, path] = route.split(" ") as [string, string];
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    const before = await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8");
    const res = await ctx.app.request(path, { method, headers: { cookie: ctx.sessionCookie() }, body: JSON.stringify({ enabled: false, password: TEST_ADMIN_PASSWORD }) });
    expect(res.status).toBe(415);
    expect(setCookieOf(res)).toBeUndefined();
    expect(ctx.calls).toHaveLength(0);
    expect(await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8")).toBe(before);
  });

  it("這些端點的回應都帶 nosniff 與 no-store（含錯誤回應）", async () => {
    const ctx = await makeSettingsApp();
    const ok = await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD });
    const bad = await call(ctx.app, "POST", "/settings/login", { password: "wrong-password-123" });
    for (const res of [ok, bad]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const get = await ctx.authed("GET", "/api/settings");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("cache-control")).toBe("no-store");
  });
});

describe("安全相關事件的 log（留下暴力破解的足跡，但絕不帶密碼或設定碼）", () => {
  it("登入失敗與成功都有一行 log，帶來源 IP", async () => {
    const ctx = await makeSettingsApp();
    await call(ctx.app, "POST", "/settings/login", { password: "my-wrong-guess-123" }, ip("203.0.113.77"));
    await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD }, ip("203.0.113.78"));
    expect(ctx.log.lines).toContain("[settings] 登入失敗：密碼不正確（來源 203.0.113.77）");
    expect(ctx.log.lines).toContain("[settings] 登入成功（來源 203.0.113.78）");
    const logged = ctx.log.lines.join("\n");
    expect(logged).not.toContain("my-wrong-guess-123");
    expect(logged).not.toContain(TEST_ADMIN_PASSWORD);
  });

  it("設定碼錯誤與更改密碼時目前密碼錯誤也有 log", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    await call(ctx.app, "POST", "/settings/setup", { setupCode: "WRONG-CODE-GUESS", password: GOOD_PASSWORD }, ip("203.0.113.80"));
    expect(ctx.log.lines).toContain("[settings] 建立密碼失敗：設定碼不正確（來源 203.0.113.80）");
    expect(ctx.log.lines.filter((l) => l.includes("建立密碼失敗")).join("\n")).not.toContain("WRONG-CODE-GUESS");

    const admin = await makeSettingsApp();
    await admin.authed("POST", "/settings/password", { currentPassword: "not-my-password-1", newPassword: GOOD_PASSWORD }, ip("203.0.113.81"));
    expect(admin.log.lines).toContain("[settings] 更改密碼失敗：目前的密碼不正確（來源 203.0.113.81）");
    expect(admin.log.lines.join("\n")).not.toContain("not-my-password-1");
    expect(admin.log.lines.join("\n")).not.toContain(GOOD_PASSWORD);
  });

  it("被限流擋下的請求不再寫 log（洪水不會灌爆 log）", async () => {
    const ctx = await makeSettingsApp();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) await call(ctx.app, "POST", "/settings/login", { password: "wrong-password-123" }, ip("203.0.113.90"));
    const linesBefore = ctx.log.lines.length;
    for (let i = 0; i < 20; i++) expect((await call(ctx.app, "POST", "/settings/login", { password: "wrong-password-123" }, ip("203.0.113.90"))).status).toBe(429);
    expect(ctx.log.lines.length).toBe(linesBefore);
  });
});

describe("scrypt 的並行上限（PasswordGate）：公開端點被灌請求也不會占滿執行緒池", () => {
  it(`同時最多 ${PASSWORD_GATE_MAX_ACTIVE} 個在算、${PASSWORD_GATE_MAX_QUEUE} 個排隊，其餘直接 429；每個回應不是 401 就是 429`, async () => {
    expect([PASSWORD_GATE_MAX_ACTIVE, PASSWORD_GATE_MAX_QUEUE]).toEqual([2, 16]);
    const ctx = await makeSettingsApp();
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) => call(ctx.app, "POST", "/settings/login", { password: `wrong-password-${i}` }, ip(`198.51.100.${i + 1}`))),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.every((st) => st === 401 || st === 429)).toBe(true);
    expect(statuses.filter((st) => st === 401).length).toBeGreaterThanOrEqual(PASSWORD_GATE_MAX_ACTIVE);
    expect(statuses.filter((st) => st === 401).length).toBeLessThanOrEqual(PASSWORD_GATE_MAX_ACTIVE + PASSWORD_GATE_MAX_QUEUE);
    expect(statuses.filter((st) => st === 429).length).toBeGreaterThanOrEqual(60 - PASSWORD_GATE_MAX_ACTIVE - PASSWORD_GATE_MAX_QUEUE);
    const rejected = responses.find((r) => r.status === 429)!;
    expect(await rejected.json()).toEqual({ success: false, error: "目前驗證請求過多，請稍後再試" });
    // 洪水過後恢復正常：名額都有歸還
    expect((await call(ctx.app, "POST", "/settings/login", { password: TEST_ADMIN_PASSWORD }, ip("198.51.100.200"))).status).toBe(200);
  });
});

describe("不是 HTTPS 時的警告與 /healthz 的 requestIsHttps", () => {
  const BANNER = 'id="insecure-notice"';
  const page = async (ctx: Awaited<ReturnType<typeof makeSettingsApp>>, headers: Record<string, string>, authed = false) =>
    (await ctx.app.request("/settings", { headers: { ...(authed ? { cookie: ctx.sessionCookie() } : {}), ...headers } })).text();

  it("公開網域上的明文 http：登入頁、建立密碼頁、設定頁都在頂端顯示警告", async () => {
    const ctx = await makeSettingsApp();
    const fresh = await makeSettingsApp({ withAdmin: false });
    const headers = { host: "savepoint-crate.zeabur.app", "x-forwarded-proto": "http" };
    expect(await page(ctx, headers)).toContain(BANNER);
    expect(await page(fresh, headers)).toContain(BANNER);
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

describe("不注入設定碼（正式啟動的做法）：log 裡的設定碼真的能用，換新碼時也會寫進 log", () => {
  const codeIn = (lines: string[]): string[] =>
    lines.map((l) => /設定碼 ([A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}) 建立密碼/.exec(l)?.[1]).filter((c): c is string => typeof c === "string");

  it("啟動 log 的設定碼可以用來建立密碼", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false, defaultSetupCode: true });
    const codes = codeIn(ctx.log.lines);
    expect(codes).toHaveLength(1);
    const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: codes[0], password: GOOD_PASSWORD });
    expect(res.status).toBe(200);
  });

  it("累計 20 次錯誤：舊碼作廢、新碼寫進 log（第二組不同於第一組）且可以用", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false, defaultSetupCode: true });
    const [first] = codeIn(ctx.log.lines);
    for (let i = 0; i < 20; i++) {
      await call(ctx.app, "POST", "/settings/setup", { setupCode: "ZZZZ-ZZZZ", password: GOOD_PASSWORD }, ip(`198.51.100.${i + 1}`));
    }
    const codes = codeIn(ctx.log.lines);
    expect(codes).toHaveLength(2);
    expect(codes[1]).not.toBe(first);
    expect((await call(ctx.app, "POST", "/settings/setup", { setupCode: first, password: GOOD_PASSWORD }, ip("198.51.100.100"))).status).toBe(403);
    expect((await call(ctx.app, "POST", "/settings/setup", { setupCode: codes[1], password: GOOD_PASSWORD }, ip("198.51.100.101"))).status).toBe(200);
  });
});
