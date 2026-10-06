import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as auth from "../src/auth.js";
import { createSessionToken, SESSION_COOKIE_NAME } from "../src/auth.js";
import { safeNextPath } from "../src/auth-kit.js";
import { SettingsStore } from "../src/settings-store.js";
import { createCapturingLogger, SAMPLE_IMAGE } from "./helpers.js";
import {
  accountId,
  call,
  cleanupTempDirs,
  cookiePair,
  lineHandler,
  makeAccount,
  makeSettingsApp,
  makeTempDir,
  NOW_MS,
  setCookieOf,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_HASH,
  TEST_ADMIN_ID,
  TEST_ADMIN_NAME,
  TEST_ADMIN_PASSWORD,
  type SettingsApp,
} from "./settings-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

// 全站登入：登入頁與導向、next 白名單、/api/me、我的帳號頁、角色與權限（一般使用者 vs 管理員）、v2 → v3 載入。
// 登入本身的安全細節（固定假雜湊、並行閘門、限流、cookie 綁帳號與 sessionVersion…）見 settings-auth.test.ts。

const USER = accountId(40);
const USER_PASSWORD = TEST_ADMIN_PASSWORD; // makeAccount 的雜湊是同一個密碼
const NEW_PASSWORD = "a-brand-new-password-42";
let ipCounter = 0;
/** 每次呼叫都換一個來源 IP：迴圈裡連續送很多次請求時，不要被逐 IP 的限流擋住。 */
const freshIp = () => ({ "x-forwarded-for": `198.20.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` });

const userAccount = (overrides = {}) => makeAccount({ id: USER, name: "一般同事", email: "user@example.test", role: "user", ...overrides });
/** 有一位管理員（預設的測試管理員）與一位一般使用者的 app。 */
const makeApp = (options: Parameters<typeof makeSettingsApp>[0] = {}) => makeSettingsApp({ extraAccounts: [userAccount()], ...options });
const page = (ctx: SettingsApp, path: string, accountId?: string, headers: Record<string, string> = {}) =>
  ctx.app.request(path, { headers: { ...(accountId ? { cookie: ctx.sessionCookie(accountId) } : {}), ...headers } });

describe("safeNextPath（登入後要回去的位置：只接受同源的相對路徑）", () => {
  it.each([
    ["/", "/"],
    ["/settings", "/settings"],
    ["/account", "/account"],
    ["/index.html", "/index.html"],
    ["/a/b/c?x=1&y=2#frag", "/a/b/c?x=1&y=2#frag"],
    ["/path%20with%20escapes", "/path%20with%20escapes"],
    ["/login?next=/settings", "/login?next=/settings"],
    ["/@evil.com", "/@evil.com"], // 站內的路徑（對瀏覽器是同源的 /@evil.com）
    ["/%2F%2Fevil.com", "/%2F%2Fevil.com"], // 百分比編碼的斜線不會被當成協定相對網址
  ])("合法：%s", (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    ["//evil.com", "協定相對網址"],
    ["//evil.com/path", "協定相對網址"],
    ["///evil.com", "多個斜線"],
    ["https://evil.com", "絕對網址"],
    ["http://evil.com/x", "絕對網址"],
    ["javascript:alert(1)", "javascript:"],
    ["data:text/html,<script>alert(1)</script>", "data:"],
    ["evil.com", "沒有開頭斜線"],
    ["settings", "沒有開頭斜線"],
    ["", "空字串"],
    [" /settings", "開頭有空白"],
    ["\t/settings", "開頭有 Tab"],
    ["/\\evil.com", "/ 加反斜線（有些瀏覽器當成 //）"],
    ["\\\\evil.com", "反斜線開頭"],
    ["/a\\b", "含反斜線"],
    ["/a\nb", "含換行"],
    ["/a\rb", "含 CR"],
    ["/a\tb", "含 Tab"],
    ["/a\u0000b", "含 NUL"],
    ["/a\u007Fb", "含 DEL"],
    ["/a\u0085b", "含 C1 控制字元"],
    ["/a b", "含行分隔符號"],
    ["/a b", "含段落分隔符號"],
    ["/" + "a".repeat(2000), "太長（2001 字元）"],
  ])("一律回 /：%s（%s）", (raw) => {
    expect(safeNextPath(raw)).toBe("/");
  });

  it("長度剛好 2000 字元合法；不是字串（數字、null、undefined、陣列、物件）一律回 /", () => {
    const edge = "/" + "a".repeat(1999);
    expect(edge).toHaveLength(2000);
    expect(safeNextPath(edge)).toBe(edge);
    for (const raw of [123, null, undefined, ["/settings"], { next: "/settings" }, true]) expect(safeNextPath(raw), JSON.stringify(raw)).toBe("/");
  });
});

describe("GET /login", () => {
  it("沒登入：登入頁（Email＋密碼）；next 預設不輸出，白名單內的 next 放在表單的 data-next", async () => {
    const ctx = await makeApp();
    const plain = await page(ctx, "/login");
    expect(plain.status).toBe(200);
    expect(plain.headers.get("cache-control")).toBe("no-store");
    expect(plain.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await plain.text();
    for (const id of ["login-form", "login-email", "login-password"]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('data-next="');

    const withNext = await (await page(ctx, "/login?next=/settings")).text();
    expect(withNext).toContain('<form id="login-form" data-next="/settings">');
  });

  it.each(["//evil.com", "https://evil.com/x", "javascript:alert(1)", "/\\evil.com", "evil.com", ""])("next 不合法（%s）：忽略，不輸出 data-next", async (next) => {
    const ctx = await makeApp();
    const html = await (await page(ctx, `/login?next=${encodeURIComponent(next)}`)).text();
    expect(html).toContain('id="login-form"');
    expect(html).not.toContain('data-next="');
    expect(html).not.toContain("evil.com");
  });

  it("next 含 HTML 特殊字元：屬性值跳脫（不會截斷屬性或帶出標籤）", async () => {
    const ctx = await makeApp();
    const html = await (await page(ctx, `/login?next=${encodeURIComponent('/x"><img src=x onerror=alert(1)>')}`)).text();
    expect(html).toContain('data-next="/x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).not.toContain("<img src=x");
  });

  it("已登入（任一角色）：302 導向 /（不管 next）", async () => {
    const ctx = await makeApp();
    for (const id of [TEST_ADMIN_ID, USER]) {
      const res = await page(ctx, "/login?next=/settings", id);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("cookie 無效（竄改、帳號停用、sessionVersion 變了）的人看到的仍是登入頁，不是導向", async () => {
    const ctx = await makeApp();
    const good = ctx.sessionCookie(USER);
    expect((await ctx.app.request("/login", { headers: { cookie: `${good.slice(0, -2)}xx` } })).status).toBe(200);
    await ctx.store.update((draft) => {
      draft.accounts.find((a) => a.id === USER)!.status = "disabled";
    });
    expect((await ctx.app.request("/login", { headers: { cookie: good } })).status).toBe(200);
  });

  it("還沒有任何帳號：沒有登入表單，說明請管理員先到設定頁（全新安裝／舊密碼待升級）", async () => {
    const fresh = await makeSettingsApp({ withAdmin: false });
    const freshHtml = await (await fresh.app.request("/login")).text();
    expect(freshHtml).toContain("尚未建立任何帳號");
    expect(freshHtml).toContain("設定碼");
    expect(freshHtml).not.toContain('id="login-form"');
    expect(freshHtml).toContain('href="/settings"');
    const legacy = await makeSettingsApp({ legacyAdmin: true });
    const legacyHtml = await (await legacy.app.request("/login")).text();
    expect(legacyHtml).toContain("用目前正在使用的管理密碼升級成管理員帳號");
    expect(legacyHtml).not.toContain('id="login-form"');
  });

  it("資料目錄不可用：503 與掛載 Volume 的說明", async () => {
    const ctx = await makeSettingsApp({ store: "unavailable" });
    const res = await ctx.app.request("/login");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("請在 Zeabur 掛載 Volume 到 /app/data");
  });

  it("其他方法：405 並註明 Allow（GET, POST）", async () => {
    const ctx = await makeApp();
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await ctx.app.request("/login", { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST");
    }
  });
});

describe("POST /login 的 next", () => {
  const login = (ctx: SettingsApp, body: Record<string, unknown>) =>
    call(ctx.app, "POST", "/login", { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, ...body }, freshIp());

  it("沒給 next → /；給了白名單內的 → 原樣回傳", async () => {
    const ctx = await makeApp();
    expect(await (await login(ctx, {})).json()).toEqual({ success: true, next: "/" });
    expect(await (await login(ctx, { next: "/settings" })).json()).toEqual({ success: true, next: "/settings" });
    expect(await (await login(ctx, { next: "/account?x=1" })).json()).toEqual({ success: true, next: "/account?x=1" });
  });

  it.each(["//evil.com", "https://evil.com", "javascript:alert(1)", "/\\evil.com", "evil.com", "", null, 123, ["/settings"], { a: 1 }, "/a\nb", `/${"a".repeat(2000)}`])(
    "不合法的 next（%j）→ 仍然登入成功，但回 /",
    async (next) => {
      const ctx = await makeApp();
      const res = await login(ctx, { next });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, next: "/" });
    },
  );

  it("登入失敗時不回 next，也不發 cookie", async () => {
    const ctx = await makeApp();
    const res = await login(ctx, { password: "wrong-password-123", next: "/settings" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "帳號或密碼不正確" });
    expect(setCookieOf(res)).toBeUndefined();
  });

  it("一般使用者也能登入（任一角色），拿到的 cookie 能用在主頁與 /api/me", async () => {
    const ctx = await makeApp();
    const res = await call(ctx.app, "POST", "/login", { email: "user@example.test", password: USER_PASSWORD, next: "/" }, freshIp());
    expect(res.status).toBe(200);
    const cookie = cookiePair(res);
    expect((await ctx.app.request("/", { headers: { cookie } })).status).toBe(200);
    expect(((await (await call(ctx.app, "GET", "/api/me", undefined, { cookie })).json()) as { data: { role: string } }).data.role).toBe("user");
    expect(ctx.store.data.accounts.find((a) => a.id === USER)?.lastLoginAt).toBe(new Date(NOW_MS).toISOString());
  });
});

describe("GET /api/me", () => {
  it("沒登入 → 401「請先登入」", async () => {
    const ctx = await makeApp();
    const res = await call(ctx.app, "GET", "/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "請先登入" });
  });

  it("回目前登入者的 { id, name, email, role }（任一角色）；不含雜湊、sessionVersion、其他帳號；no-store", async () => {
    const ctx = await makeApp();
    const admin = await ctx.authed("GET", "/api/me");
    expect(admin.status).toBe(200);
    expect(admin.headers.get("cache-control")).toBe("no-store");
    expect(admin.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await admin.json()).toEqual({ success: true, data: { id: TEST_ADMIN_ID, name: TEST_ADMIN_NAME, email: TEST_ADMIN_EMAIL, role: "admin" } });
    const userRes = await ctx.authedAs(USER, "GET", "/api/me");
    const text = await userRes.text();
    expect(JSON.parse(text)).toEqual({ success: true, data: { id: USER, name: "一般同事", email: "user@example.test", role: "user" } });
    for (const secret of ["scrypt$", "passwordHash", "sessionVersion", "sessionSecret", TEST_ADMIN_EMAIL]) expect(text).not.toContain(secret);
  });

  it("角色變更之後（sessionVersion 加一）舊 cookie 失效；新登入就是新角色", async () => {
    const ctx = await makeApp();
    const old = ctx.sessionCookie(USER);
    expect((await call(ctx.app, "GET", "/api/me", undefined, { cookie: old })).status).toBe(200);
    expect((await ctx.authed("PATCH", `/api/accounts/${USER}`, { role: "admin" }, freshIp())).status).toBe(200);
    expect((await call(ctx.app, "GET", "/api/me", undefined, { cookie: old })).status).toBe(401);
    const relog = await call(ctx.app, "POST", "/login", { email: "user@example.test", password: USER_PASSWORD }, freshIp());
    const me = (await (await call(ctx.app, "GET", "/api/me", undefined, { cookie: cookiePair(relog) })).json()) as { data: { role: string } };
    expect(me.data.role).toBe("admin");
  });

  it("停用的帳號 401；資料目錄不可用 503；其他方法 405", async () => {
    const ctx = await makeApp();
    await ctx.store.update((draft) => {
      draft.accounts.find((a) => a.id === USER)!.status = "disabled";
    });
    expect((await ctx.authedAs(USER, "GET", "/api/me")).status).toBe(401);
    expect((await (await makeSettingsApp({ store: "unavailable" })).authed("GET", "/api/me")).status).toBe(503);
    const res = await ctx.app.request("/api/me", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("有自己的限流桶（和設定 API 共用 60 次／分，不吃 OCR 的額度）", async () => {
    const ctx = await makeApp();
    const ip = { "x-forwarded-for": "203.0.113.70" };
    for (let i = 0; i < 60; i++) expect((await ctx.authed("GET", "/api/me", undefined, ip)).status).toBe(200);
    expect((await ctx.authed("GET", "/api/me", undefined, ip)).status).toBe(429);
    expect((await ctx.authed("POST", "/api/ocr", {}, ip)).status).toBe(400); // OCR 的桶沒被動到（缺 image）
  });
});

describe("GET /account（我的帳號）", () => {
  it("沒登入：302 導向 /login?next=/account", async () => {
    const ctx = await makeApp();
    const res = await page(ctx, "/account");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=/account");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  const NOTE = "密碼由管理員統一設定，需要變更請洽管理員";

  it("一般使用者：看到自己的姓名、Email、角色與「密碼由管理員統一設定」的說明；沒有任何表單或輸入欄位、沒有「設定」連結、沒有其他人的資料", async () => {
    const ctx = await makeApp();
    const res = await page(ctx, "/account", USER);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    const html = await res.text();
    expect(html).toContain('<strong id="me-name">一般同事</strong>');
    expect(html).toContain('<strong id="me-email" class="mono">user@example.test</strong>');
    expect(html).toContain('<strong id="me-role">一般使用者</strong>');
    expect(html).toContain(NOTE); // 說明文字
    expect(html).toContain('id="password-policy"');
    expect(html).toContain("要修改姓名、Email 或角色，請洽管理員");
    expect(html).not.toMatch(/<form|<input|<textarea|<select/); // 唯讀：沒有任何表單
    for (const id of ["password-form", "current-password", "new-password", "new-password2", "password-msg"]) expect(html).not.toContain(`id="${id}"`);
    expect(html).not.toContain("變更我的密碼");
    expect(html).toContain('id="logout"'); // 導覽列的登出按鈕仍在
    expect(html).not.toContain('href="/settings"');
    expect(html).not.toContain(TEST_ADMIN_EMAIL);
    expect(html).not.toContain("scrypt$");
  });

  it("管理員：同一頁（一樣唯讀、一樣有說明），多一個「設定」連結", async () => {
    const ctx = await makeApp();
    const html = await (await page(ctx, "/account", TEST_ADMIN_ID)).text();
    expect(html).toContain('<strong id="me-role">管理員</strong>');
    expect(html).toContain('href="/settings"');
    expect(html).toContain(NOTE);
    expect(html).not.toMatch(/<form|<input|<textarea|<select/);
  });

  it("頁面的 script 沒有任何改密碼的程式（不打 /account/password、沒有 password-form 的處理）", async () => {
    const ctx = await makeApp();
    for (const id of [USER, TEST_ADMIN_ID]) {
      const html = await (await page(ctx, "/account", id)).text();
      const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
      expect(script).not.toContain("/account/password");
      expect(script).not.toContain("password-form");
      expect(script).not.toContain("$('current-password')"); // 改密碼表單的欄位
      expect(script).not.toContain("$('new-password");
      expect(script).not.toContain("password-msg");
    }
  });

  it("停用的帳號導向登入頁；資料目錄不可用 503；其他方法 405", async () => {
    const ctx = await makeApp();
    const cookie = ctx.sessionCookie(USER);
    await ctx.store.update((draft) => {
      draft.accounts.find((a) => a.id === USER)!.status = "disabled";
    });
    expect((await ctx.app.request("/account", { headers: { cookie } })).status).toBe(302);
    expect((await (await makeSettingsApp({ store: "unavailable" })).app.request("/account")).status).toBe(503);
    expect((await ctx.app.request("/account", { method: "POST" })).status).toBe(405);
  });
});

describe("密碼只由管理員設定：一般使用者與管理員都不能自己改密碼（只有管理員的「重設密碼」）", () => {
  const reset = (ctx: SettingsApp, as: string, targetId: string, body: unknown = { newPassword: NEW_PASSWORD }) =>
    ctx.authedAs(as, "POST", `/api/accounts/${targetId}/password`, body, freshIp());

  it("自助改密碼的端點不存在：一般使用者與管理員打 POST /account/password 都是 404，密碼、sessionVersion 都沒變", async () => {
    const ctx = await makeApp();
    const before = ctx.store.data.accounts.map((a) => [a.id, a.passwordHash, a.sessionVersion]);
    for (const id of [USER, TEST_ADMIN_ID]) {
      const res = await ctx.authedAs(id, "POST", "/account/password", { currentPassword: USER_PASSWORD, newPassword: NEW_PASSWORD }, freshIp());
      expect(res.status).toBe(404);
      expect(setCookieOf(res)).toBeUndefined();
    }
    expect((await call(ctx.app, "POST", "/account/password", { currentPassword: USER_PASSWORD, newPassword: NEW_PASSWORD }, freshIp())).status).toBe(404); // 沒登入也是 404（不是 401）
    expect((await ctx.authed("POST", "/settings/password", { currentPassword: TEST_ADMIN_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(404); // 更早的舊路徑也沒有
    expect(ctx.store.data.accounts.map((a) => [a.id, a.passwordHash, a.sessionVersion])).toEqual(before);
  });

  it("一般使用者呼叫 /api/accounts/:id/password（不論對自己、對管理員、對不存在的 id、內容對不對）一律 403「需要管理員權限」，不改任何東西、不發 cookie、不跑 scrypt", async () => {
    const ctx = await makeApp();
    const hashSpy = vi.spyOn(auth, "hashPassword");
    const before = ctx.store.data.accounts.map((a) => [a.id, a.passwordHash, a.sessionVersion]);
    for (const targetId of [USER, TEST_ADMIN_ID, accountId(99)]) {
      for (const body of [{ newPassword: NEW_PASSWORD }, { newPassword: "short" }, {}, { currentPassword: USER_PASSWORD, newPassword: NEW_PASSWORD }]) {
        const res = await reset(ctx, USER, targetId, body);
        expect(res.status, `${targetId} ${JSON.stringify(body)}`).toBe(403);
        expect(await res.json()).toEqual({ success: false, error: "需要管理員權限" });
        expect(setCookieOf(res)).toBeUndefined();
      }
    }
    expect((await reset(ctx, USER, "not-an-id")).status).toBe(403); // id 格式不對也是先判斷權限
    expect(hashSpy).not.toHaveBeenCalled();
    expect(ctx.store.data.accounts.map((a) => [a.id, a.passwordHash, a.sessionVersion])).toEqual(before);
    expect((await call(ctx.app, "POST", "/login", { email: "user@example.test", password: USER_PASSWORD }, freshIp())).status).toBe(200); // 原本的密碼照常可登入
  });

  it("沒登入呼叫 /api/accounts/:id/password → 401；被降成一般使用者之後（舊 cookie 已失效）→ 401，重新登入後 → 403", async () => {
    const ctx = await makeApp({ extraAccounts: [makeAccount({ id: accountId(41), name: "第二位管理員", email: "second-admin@example.test" })] });
    expect((await call(ctx.app, "POST", `/api/accounts/${USER}/password`, { newPassword: NEW_PASSWORD }, freshIp())).status).toBe(401);
    const oldCookie = ctx.sessionCookie(accountId(41));
    expect((await ctx.authed("PATCH", `/api/accounts/${accountId(41)}`, { role: "user" }, freshIp())).status).toBe(200);
    expect((await call(ctx.app, "POST", `/api/accounts/${accountId(41)}/password`, { newPassword: NEW_PASSWORD }, { cookie: oldCookie, ...freshIp() })).status).toBe(401);
    const relog = await call(ctx.app, "POST", "/login", { email: "second-admin@example.test", password: TEST_ADMIN_PASSWORD }, freshIp());
    expect((await call(ctx.app, "POST", `/api/accounts/${accountId(41)}/password`, { newPassword: NEW_PASSWORD }, { cookie: cookiePair(relog), ...freshIp() })).status).toBe(403);
  });

  it("管理員幫一般使用者重設密碼：新密碼可登入、舊密碼不行；對方舊 cookie 失效、管理員自己的登入不受影響；沒有新 cookie 發給管理員", async () => {
    const ctx = await makeApp();
    const userOld = ctx.sessionCookie(USER);
    const adminBefore = ctx.store.data.accounts.find((a) => a.id === TEST_ADMIN_ID)!.sessionVersion;
    const res = await reset(ctx, TEST_ADMIN_ID, USER);
    expect(res.status).toBe(200);
    expect(setCookieOf(res)).toBeUndefined(); // 重設別人的密碼：不動操作者的 cookie
    expect((await call(ctx.app, "GET", "/api/me", undefined, { cookie: userOld })).status).toBe(401);
    expect((await call(ctx.app, "POST", "/login", { email: "user@example.test", password: USER_PASSWORD }, freshIp())).status).toBe(401);
    expect((await call(ctx.app, "POST", "/login", { email: "user@example.test", password: NEW_PASSWORD }, freshIp())).status).toBe(200);
    expect(ctx.store.data.accounts.find((a) => a.id === TEST_ADMIN_ID)!.sessionVersion).toBe(adminBefore);
    expect((await ctx.authed("GET", "/api/me")).status).toBe(200);
    expect(ctx.log.lines.some((l) => /^\[accounts\] .* 重設密碼 user@example\.test（來源 /.test(l))).toBe(true);
    expect(ctx.log.lines.join("\n")).not.toContain(NEW_PASSWORD);
  });
});

describe("角色與權限（一般使用者 vs 管理員 vs 沒登入）", () => {
  // [說明, 方法, 路徑, 內容, 沒登入, 一般使用者, 管理員]；"pass" 表示通過閘門（不是 401／403），實際結果由端點自己決定
  type Expect = number | "pass";
  const MATRIX: Array<[string, string, string, unknown, Expect, Expect, Expect]> = [
    ["主頁", "GET", "/", undefined, 302, 200, 200],
    ["主頁（index.html）", "GET", "/index.html", undefined, 302, 200, 200],
    ["登入頁", "GET", "/login", undefined, 200, 302, 302],
    ["我的帳號頁", "GET", "/account", undefined, 302, 200, 200],
    ["設定頁", "GET", "/settings", undefined, 302, 403, 200],
    ["設定頁（結尾斜線）", "GET", "/settings/", undefined, 302, 403, 200],
    ["目前登入者", "GET", "/api/me", undefined, 401, 200, 200],
    ["讀設定", "GET", "/api/settings", undefined, 401, 403, 200],
    ["存 LINE 設定", "PUT", "/api/settings/line", { enabled: true }, 401, 403, 200],
    ["發測試訊息（環境變數有 LINE 設定，所以會推播）", "POST", "/api/settings/line/test", {}, 401, 403, 200],
    ["列出帳號", "GET", "/api/accounts", undefined, 401, 403, 200],
    ["新增帳號", "POST", "/api/accounts", { name: "新", email: "new@example.test", password: NEW_PASSWORD }, 401, 403, 200],
    ["修改帳號", "PATCH", `/api/accounts/${accountId(99)}`, { name: "乙" }, 401, 403, 404],
    ["重設他人密碼", "POST", `/api/accounts/${accountId(99)}/password`, { newPassword: NEW_PASSWORD }, 401, 403, 404],
    ["停用／啟用", "POST", `/api/accounts/${accountId(99)}/status`, { status: "disabled" }, 401, 403, 404],
    ["刪除帳號", "DELETE", `/api/accounts/${accountId(99)}`, undefined, 401, 403, 404],
    ["OCR", "POST", "/api/ocr", { image: SAMPLE_IMAGE }, 401, "pass", "pass"],
    ["存檔", "POST", "/api/save", {}, 401, "pass", "pass"],
    ["關箱通知", "POST", "/api/box-closed", { boxId: "B", items: [], total: 0, successCount: 0, failedCount: 0 }, 401, 200, 200],
    ["自助改密碼（已移除：任何人都是 404）", "POST", "/account/password", { currentPassword: "wrong-password-123", newPassword: NEW_PASSWORD }, 404, 404, 404],
    ["重設一般使用者的密碼（管理員：200；一般使用者打自己的 id：403）", "POST", `/api/accounts/${USER}/password`, { newPassword: NEW_PASSWORD }, 401, 403, 200],
    ["重設管理員的密碼（管理員對自己：200，這是唯一改自己密碼的途徑；一般使用者打管理員的 id：403）", "POST", `/api/accounts/${TEST_ADMIN_ID}/password`, { newPassword: NEW_PASSWORD }, 401, 403, 200],
    ["登出（不需要登入）", "POST", "/logout", {}, 200, 200, 200],
    ["healthz（公開）", "GET", "/healthz", undefined, 200, 200, 200],
  ];

  const who = ["沒登入", "一般使用者", "管理員"] as const;
  it.each(MATRIX)("%s：%s %s", async (_name, method, path, body, anonymous, user, admin) => {
    const results: Array<[string, Expect, number]> = [];
    for (const [i, expected] of [anonymous, user, admin].entries()) {
      const ctx = await makeApp({ handler: lineHandler(), env: { LINE_CHANNEL_ACCESS_TOKEN: "test-line-access-token-123", LINE_GROUP_ID: "C0123456789abcdef0123456789abcdef" } });
      const cookie = i === 0 ? undefined : ctx.sessionCookie(i === 1 ? USER : TEST_ADMIN_ID);
      const res = await ctx.app.request(path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-requested-with": "XMLHttpRequest",
          ...freshIp(),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      results.push([who[i]!, expected, res.status]);
    }
    for (const [label, expected, actual] of results) {
      if (expected === "pass") expect([401, 403], `${label}：${method} ${path} 應該通過閘門，實際 ${actual}`).not.toContain(actual);
      else expect(actual, `${label}：${method} ${path}`).toBe(expected);
    }
  });

  it("403 的 JSON 回應固定是 { success:false, error:\"需要管理員權限\" }；頁面是 403 的「需要管理員權限」頁", async () => {
    const ctx = await makeApp();
    for (const [method, path] of [["GET", "/api/settings"], ["GET", "/api/accounts"], ["PUT", "/api/settings/line"]] as const) {
      const res = await ctx.authedAs(USER, method, path, method === "PUT" ? { enabled: true } : undefined, freshIp());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ success: false, error: "需要管理員權限" });
    }
    const html = await (await page(ctx, "/settings", USER)).text();
    expect(html).toContain("需要管理員權限");
  });

  it("授權先於驗證：一般使用者送出內容錯誤、id 不存在、Email 重複的請求一律 403（不是 400／404／409），也不會先花一次 scrypt", async () => {
    const ctx = await makeApp();
    const hashSpy = vi.spyOn(auth, "hashPassword");
    const cases: Array<[string, string, unknown]> = [
      ["POST", "/api/accounts", { name: "", email: "not-an-email", password: "x" }], // 內容全錯
      ["POST", "/api/accounts", { name: "重複", email: TEST_ADMIN_EMAIL, password: NEW_PASSWORD }], // 內容合法但 Email 已被使用
      ["POST", "/api/accounts", { name: "要提權", email: "grab@example.test", password: NEW_PASSWORD, role: "root" }], // 角色不合法
      ["PATCH", `/api/accounts/${accountId(99)}`, {}], // 沒有要修改的欄位、id 也不存在
      ["PATCH", "/api/accounts/not-an-id", { name: "x" }], // id 格式不對
      ["PATCH", `/api/accounts/${USER}`, { role: "admin" }], // 想把自己升成管理員
      ["POST", `/api/accounts/${accountId(99)}/password`, { newPassword: "x" }],
      ["POST", `/api/accounts/${TEST_ADMIN_ID}/password`, { newPassword: NEW_PASSWORD }], // 想重設管理員的密碼
      ["POST", "/api/accounts/not-an-id/status", { status: "bogus" }],
      ["POST", `/api/accounts/${TEST_ADMIN_ID}/status`, { status: "disabled" }], // 想停用管理員
      ["DELETE", "/api/accounts/not-an-id", undefined],
      ["DELETE", `/api/accounts/${TEST_ADMIN_ID}`, undefined], // 想刪除管理員
      ["PUT", "/api/settings/line", { groupId: "bad", enabled: "yes" }], // LINE 設定內容全錯
      ["POST", "/api/settings/line/test", {}],
    ];
    for (const [method, path, body] of cases) {
      const res = await ctx.authedAs(USER, method, path, body, freshIp());
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json(), `${method} ${path}`).toEqual({ success: false, error: "需要管理員權限" });
    }
    // 內容根本不是合法的 JSON（壞掉的、陣列、字串、空的）：也是先判斷權限，不是 400——授權在讀取內容之前
    const raw: Array<[string, string]> = [
      ["POST", "/api/accounts"],
      ["PATCH", `/api/accounts/${USER}`],
      ["POST", `/api/accounts/${USER}/password`],
      ["POST", `/api/accounts/${TEST_ADMIN_ID}/password`],
      ["POST", `/api/accounts/${USER}/status`],
      ["PUT", "/api/settings/line"],
      ["POST", "/api/settings/line/test"],
    ];
    for (const [method, path] of raw) {
      for (const body of ["{not json", "[]", '"string"', "null", ""]) {
        const res = await ctx.authedAs(USER, method, path, body, freshIp());
        expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(403);
      }
    }
    expect(hashSpy).not.toHaveBeenCalled(); // 沒有任何一次密碼雜湊（一般使用者不能拿來燒 CPU）
    expect(ctx.store.data.accounts.map((a) => [a.id, a.role, a.status])).toEqual([
      [TEST_ADMIN_ID, "admin", "active"],
      [USER, "user", "active"],
    ]);
    expect(ctx.store.data.line.groupId).toBe("");
  });

  it("管理員把某人降成一般使用者之後，那個人的舊 cookie 失效；重新登入後進設定頁是 403、/api/accounts 是 403", async () => {
    const ctx = await makeApp({ extraAccounts: [userAccount({ role: "admin" })] });
    const old = ctx.sessionCookie(USER);
    expect((await call(ctx.app, "GET", "/api/accounts", undefined, { cookie: old })).status).toBe(200);
    expect((await ctx.authed("PATCH", `/api/accounts/${USER}`, { role: "user" }, freshIp())).status).toBe(200);
    expect((await call(ctx.app, "GET", "/api/accounts", undefined, { cookie: old })).status).toBe(401);
    const relog = await call(ctx.app, "POST", "/login", { email: "user@example.test", password: USER_PASSWORD }, freshIp());
    const cookie = cookiePair(relog);
    expect((await call(ctx.app, "GET", "/api/accounts", undefined, { cookie })).status).toBe(403);
    expect((await ctx.app.request("/settings", { headers: { cookie } })).status).toBe(403);
    expect((await ctx.app.request("/", { headers: { cookie } })).status).toBe(200); // 仍可使用裝箱程式
  });

  it("沒有任何啟用中的管理員、只剩一般使用者（手動編輯出來的狀態）：設定頁與帳號 API 沒有人進得去（全部 403），裝箱程式仍可用", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    await ctx.store.update((draft) => {
      draft.accounts.push(userAccount());
    });
    expect((await ctx.authedAs(USER, "GET", "/api/accounts")).status).toBe(403);
    expect((await ctx.authedAs(USER, "POST", "/api/box-closed", { boxId: "B", items: [], total: 0, successCount: 0, failedCount: 0 })).status).toBe(200);
    const health = (await (await ctx.app.request("/healthz")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ adminConfigured: false, adminCount: 0, accountCount: 1 });
  });
});

describe("v2（管理員帳號，沒有角色）→ v3 載入：同一個密碼照常登入，第一次寫入才升版", () => {
  const SECRET = "ef".repeat(32);
  const v2File = () => ({
    version: 2,
    sessionSecret: SECRET,
    admins: [
      { id: accountId(1), name: "舊管理員甲", email: "old1@example.test", passwordHash: TEST_ADMIN_HASH, status: "active", sessionVersion: 5, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", lastLoginAt: null, futureAdminField: "keep" },
      { id: accountId(2), name: "舊管理員乙", email: "old2@example.test", passwordHash: TEST_ADMIN_HASH, status: "disabled", sessionVersion: 2, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", lastLoginAt: null },
    ],
    line: { enabled: true, channelAccessToken: "tok", channelSecret: "sec", groupId: "C0123456789abcdef0123456789abcdef", groupName: "倉庫", updatedAt: "2026-09-03T00:00:00.000Z", futureLineField: 1 },
    lineCaptured: [{ groupId: "C0123456789abcdef0123456789abcdef", groupName: "倉庫", eventType: "join", lastSeenAt: "2026-09-04T00:00:00.000Z" }],
    futureTopLevel: { keep: true },
  });

  async function openV2() {
    const dir = await makeTempDir();
    const text = `${JSON.stringify(v2File(), null, 2)}\n`;
    await writeFile(join(dir, "settings.json"), text, { mode: 0o600 });
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    const ctx = await makeSettingsApp({ store, withAdmin: false, handler: lineHandler() });
    return { ctx, dir, text, readFileJson: async () => JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, any> };
  }

  it("啟動：不改檔案；healthz 的 adminCount 2（全部視為管理員）、accountCount 2、adminConfigured true（有一位啟用中）；不提示設定碼", async () => {
    const { ctx, dir, text } = await openV2();
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(text);
    const health = (await (await ctx.app.request("/healthz")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ adminConfigured: true, adminCount: 2, accountCount: 2, legacyAdminPending: false, lineConfigured: true, lineSource: "settings" });
    expect(ctx.log.lines.some((l) => l.includes("設定碼"))).toBe(false);
  });

  it("v2 時代發的登入 cookie（帳號 id 與 sessionVersion 沒變）在 v3 仍然有效；而且是管理員（能進設定頁）", async () => {
    const { ctx } = await openV2();
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(SECRET, accountId(1), 5, NOW_MS)}`;
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie })).status).toBe(200);
    expect((await ctx.app.request("/settings", { headers: { cookie } })).status).toBe(200);
    expect(((await (await call(ctx.app, "GET", "/api/me", undefined, { cookie })).json()) as { data: { role: string } }).data.role).toBe("admin");
  });

  it("用原本的 Email 與密碼登入照常成功（這是第一次寫入：lastLoginAt）→ 檔案升成版本 3：admins → accounts、每位 role admin；其他欄位（含不認識的）、line、lineCaptured、sessionSecret 原封不動", async () => {
    const { ctx, readFileJson } = await openV2();
    const res = await call(ctx.app, "POST", "/login", { email: "old1@example.test", password: TEST_ADMIN_PASSWORD }, freshIp());
    expect(res.status).toBe(200);
    const saved = await readFileJson();
    const original = v2File();
    expect(saved.version).toBe(3);
    expect("admins" in saved).toBe(false);
    expect(saved.accounts.map((a: Record<string, unknown>) => [a.email, a.role, a.status, a.sessionVersion])).toEqual([
      ["old1@example.test", "admin", "active", 5],
      ["old2@example.test", "admin", "disabled", 2],
    ]);
    expect(saved.accounts[0].lastLoginAt).toBe(new Date(NOW_MS).toISOString());
    expect(saved.accounts[0].futureAdminField).toBe("keep");
    expect(saved.accounts[0].passwordHash).toBe(TEST_ADMIN_HASH);
    expect(saved.sessionSecret).toBe(original.sessionSecret);
    expect(saved.line).toEqual(original.line);
    expect(saved.lineCaptured).toEqual(original.lineCaptured);
    expect(saved.futureTopLevel).toEqual(original.futureTopLevel);
  });

  it("停用的 v2 管理員仍然登不進去；升級後用管理員新增一般使用者、降級舊管理員，一切照常", async () => {
    const { ctx } = await openV2();
    expect((await call(ctx.app, "POST", "/login", { email: "old2@example.test", password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(401);
    const login = await call(ctx.app, "POST", "/login", { email: "old1@example.test", password: TEST_ADMIN_PASSWORD }, freshIp());
    const cookie = cookiePair(login);
    const created = await call(ctx.app, "POST", "/api/accounts", { name: "新同事", email: "staff@example.test", password: NEW_PASSWORD, role: "user" }, { cookie, ...freshIp() });
    expect(created.status).toBe(200);
    expect(ctx.store.data.accounts.map((a) => [a.email, a.role])).toEqual([["old1@example.test", "admin"], ["old2@example.test", "admin"], ["staff@example.test", "user"]]);
    const staff = await call(ctx.app, "POST", "/login", { email: "staff@example.test", password: NEW_PASSWORD }, freshIp());
    expect(staff.status).toBe(200);
    expect((await call(ctx.app, "POST", "/api/box-closed", { boxId: "B", items: [], total: 0, successCount: 0, failedCount: 0 }, { cookie: cookiePair(staff) })).status).toBe(200);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: cookiePair(staff) })).status).toBe(403);
  });
});

describe("全站登入的其他細節", () => {
  it("路徑變體（HEAD、OPTIONS、其他方法、尾斜線、大小寫、百分比編碼、/./、重複斜線）：沒登入一律拿不到 index.html，也不發 cookie", async () => {
    const ctx = await makeApp();
    const variants = ["/", "/index.html", "/%69ndex.html", "/./index.html", "/%2e/index.html", "/static/../index.html", "/index.html?x=1", "/index.html/", "/INDEX.HTML", "/Index.html", "//", "//index.html", "/index.htm", "/index.html%00", "/index.html%2f"];
    for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE"]) {
      for (const path of variants) {
        const res = await ctx.app.request(path, { method, headers: { ...freshIp(), "content-type": "application/json", "x-requested-with": "XMLHttpRequest" } });
        expect(res.status, `${method} ${path}`).not.toBe(200);
        expect(await res.text(), `${method} ${path}`).not.toContain("測試頁");
        expect(res.headers.get("set-cookie"), `${method} ${path}`).toBeNull();
      }
    }
    // 指向主頁的寫法（GET、HEAD）一律導向登入頁，不是 404 也不是內容
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["/", "/index.html", "/%69ndex.html", "/./index.html", "/%2e/index.html", "/static/../index.html", "/index.html?x=1"]) {
        const res = await ctx.app.request(path, { method, headers: freshIp() });
        expect(res.status, `${method} ${path}`).toBe(302);
        expect(res.headers.get("location"), `${method} ${path}`).toBe("/login?next=/");
      }
    }
  });

  it("OCR／存檔／關箱通知：未登入的錯誤回應是 JSON（含 nosniff 以外不帶任何多餘資訊），不會洩漏帳號是否存在", async () => {
    const ctx = await makeApp();
    for (const path of ["/api/ocr", "/api/save", "/api/box-closed"]) {
      const res = await call(ctx.app, "POST", path, {}, { cookie: "" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, error: "請先登入" });
    }
  });

  it("settings.json 裡沒有明文密碼；帳號資料只有 v3 的欄位（含 role）", async () => {
    const ctx = await makeApp();
    const text = await readFile(join(ctx.dir, "settings.json"), "utf8");
    expect(text).not.toContain(TEST_ADMIN_PASSWORD);
    const saved = JSON.parse(text) as { version: number; accounts: Array<Record<string, unknown>> };
    expect(saved.version).toBe(3);
    expect(Object.keys(saved.accounts[0]!).sort()).toEqual(["createdAt", "email", "id", "lastLoginAt", "name", "passwordHash", "role", "sessionVersion", "status", "updatedAt"]);
  });
});
