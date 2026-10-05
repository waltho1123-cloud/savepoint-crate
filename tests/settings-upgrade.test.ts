import { createHmac } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as auth from "../src/auth.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "../src/auth.js";
import { PASSWORD_GATE_MAX_ACTIVE, PASSWORD_GATE_MAX_QUEUE } from "../src/auth-kit.js";
import { SettingsStore } from "../src/settings-store.js";
import { createCapturingLogger, signLineBody, TEST_GROUP_ID, TEST_LINE_SECRET, TEST_LINE_TOKEN, type MockHandler } from "./helpers.js";
import {
  call,
  cleanupTempDirs,
  cookiePair,
  lineHandler,
  makeSettingsApp,
  makeTempDir,
  NOW_MS,
  setCookieOf,
  TEST_ADMIN_HASH,
  TEST_ADMIN_PASSWORD,
} from "./settings-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

const ip = (address: string) => ({ "x-forwarded-for": address });
let ipCounter = 0;
const freshIp = () => ip(`198.18.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`);

const SESSION_SECRET = "c".repeat(64);
/** 正式站現在的樣子：版本 1、舊的單一密碼、設定頁存好的 LINE 設定、最近收到的群組，另加一個未來才會有的欄位。 */
function legacyFile(): Record<string, unknown> {
  return {
    version: 1,
    admin: { passwordHash: TEST_ADMIN_HASH, updatedAt: "2026-09-30T00:00:00.000Z" },
    sessionSecret: SESSION_SECRET,
    line: {
      enabled: true,
      channelAccessToken: TEST_LINE_TOKEN,
      channelSecret: TEST_LINE_SECRET,
      groupId: TEST_GROUP_ID,
      groupName: "倉庫出貨群",
      updatedAt: "2026-10-01T00:00:00.000Z",
      futureLineField: "keep",
    },
    lineCaptured: [{ groupId: TEST_GROUP_ID, groupName: "倉庫出貨群", eventType: "join", lastSeenAt: "2026-10-02T00:00:00.000Z" }],
    futureTopLevelField: { nested: [1, 2, 3] },
  };
}

/** 用一份舊版（版本 1）的 settings.json 啟動：和正式站升級前的狀態一樣。 */
async function makeLegacyApp(options: { file?: Record<string, unknown>; handler?: MockHandler; withAdmin?: boolean } = {}) {
  const dir = await makeTempDir();
  const text = `${JSON.stringify(options.file ?? legacyFile(), null, 2)}\n`;
  await writeFile(join(dir, "settings.json"), text, { mode: 0o600 });
  const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
  const ctx = await makeSettingsApp({ store, withAdmin: options.withAdmin ?? false, handler: options.handler ?? lineHandler({ groupName: "倉庫出貨群" }) });
  const readFileJson = async () => JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, any>;
  return { ...ctx, originalText: text, readFileJson };
}

const upgradeBody = (overrides: Record<string, unknown> = {}) => ({
  currentPassword: TEST_ADMIN_PASSWORD,
  name: "  林管理  ",
  email: "  Lin.Admin@Example.TEST ",
  ...overrides,
});

describe("升級前的狀態（舊版單一管理密碼，正式站現在的樣子）", () => {
  it("GET /settings 顯示「升級為管理員帳號」表單（目前密碼、姓名、Email），沒有登入、建立管理員、設定表單", async () => {
    const ctx = await makeLegacyApp();
    const res = await ctx.app.request("/settings");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const id of ["upgrade-form", "upgrade-password", "upgrade-name", "upgrade-email"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("升級為管理員帳號");
    expect(html).toContain("密碼沿用目前這個，不需要重設");
    for (const id of ["login-form", "setup-form", "line-form", "admin-table"]) expect(html).not.toContain(`id="${id}"`);
    expect(html).not.toContain(TEST_LINE_TOKEN); // 頁面上沒有任何設定值
    expect(html).not.toContain("scrypt$");
  });

  it("舊版時代發的 cookie（三段式）不能登入：頁面仍然是升級表單，API 回 401", async () => {
    const ctx = await makeLegacyApp();
    const expires = String(NOW_MS + SESSION_TTL_MS);
    const nonce = "AAAAAAAAAAAAAAAA";
    const mac = createHmac("sha256", Buffer.from(SESSION_SECRET, "hex")).update(`${expires}.${nonce}`).digest("base64url");
    const cookie = `${SESSION_COOKIE_NAME}=${expires}.${nonce}.${mac}`;
    expect(await (await ctx.app.request("/settings", { headers: { cookie } })).text()).toContain('id="upgrade-form"');
    for (const [method, path] of [["GET", "/api/settings"], ["GET", "/api/accounts"]] as const) {
      expect((await call(ctx.app, method, path, undefined, { cookie })).status).toBe(401);
    }
  });

  it("/healthz：legacyAdminPending true、adminConfigured true（有人進得去）、adminCount 0", async () => {
    const ctx = await makeLegacyApp();
    const health = (await (await ctx.app.request("/healthz")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ adminConfigured: true, adminCount: 0, legacyAdminPending: true, lineConfigured: true, lineSource: "settings" });
  });

  it("升級前（全站登入之後）：沒有任何帳號可以登入，所以主頁與 OCR、存檔、關箱通知都要登入、回 401；LINE webhook 仍然公開、照常運作，用的是設定檔裡的 token、群組與 secret", async () => {
    const ctx = await makeLegacyApp();
    const notify = await call(ctx.app, "POST", "/api/box-closed", { boxId: "BOX-1", items: [], total: 0, successCount: 0, failedCount: 0 });
    expect(notify.status).toBe(401);
    expect(await notify.json()).toEqual({ success: false, error: "請先登入" });
    expect(ctx.calls.some((c) => c.url.endsWith("/message/push"))).toBe(false);
    const main = await ctx.app.request("/");
    expect(main.status).toBe(302);
    expect(main.headers.get("location")).toBe("/login?next=/");
    const loginPage = await ctx.app.request("/login");
    expect(loginPage.status).toBe(200);
    const html = await loginPage.text();
    expect(html).toContain("尚未建立任何帳號");
    expect(html).toContain("用目前正在使用的管理密碼升級成管理員帳號");
    expect(html).toContain('href="/settings"');
    expect(html).not.toContain('id="login-form"');

    const body = JSON.stringify({ events: [{ type: "join", replyToken: "r", source: { type: "group", groupId: TEST_GROUP_ID } }] });
    const hook = await ctx.app.request("/api/line/webhook", { method: "POST", headers: { "content-type": "application/json", "x-line-signature": signLineBody(body) }, body });
    expect(hook.status).toBe(200);
    expect(ctx.calls.some((c) => c.url.endsWith("/message/reply"))).toBe(true);
  });

  it("升級前 webhook 記錄群組的寫入：檔案仍是版本 1、舊的 admin 與其他欄位原樣（升級前回滾到舊版程式仍讀得懂）", async () => {
    const ctx = await makeLegacyApp();
    const body = JSON.stringify({ events: [{ type: "join", replyToken: "r", source: { type: "group", groupId: "C0000000000000000000000000000000f" } }] });
    await ctx.app.request("/api/line/webhook", { method: "POST", headers: { "content-type": "application/json", "x-line-signature": signLineBody(body) }, body });
    const file = await ctx.readFileJson();
    expect(file.version).toBe(1);
    expect(file.admin).toEqual({ passwordHash: TEST_ADMIN_HASH, updatedAt: "2026-09-30T00:00:00.000Z" });
    expect(file.sessionSecret).toBe(SESSION_SECRET);
    expect(file.lineCaptured.map((g: { groupId: string }) => g.groupId)).toEqual(["C0000000000000000000000000000000f", TEST_GROUP_ID]);
    expect(file.futureTopLevelField).toEqual({ nested: [1, 2, 3] });
  });

  it("舊版時代沒有任何登入端點可用：login 409（請先升級）、setup 409、改密碼 401", async () => {
    const ctx = await makeLegacyApp();
    expect((await call(ctx.app, "POST", "/login", { email: "a@example.test", password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(409);
    expect((await call(ctx.app, "POST", "/settings/setup", { setupCode: "ABCD-EFGH", name: "甲", email: "a@example.test", password: "a-brand-new-password-42" }, freshIp())).status).toBe(409);
    expect((await call(ctx.app, "POST", "/account/password", { currentPassword: TEST_ADMIN_PASSWORD, newPassword: "a-brand-new-password-42" }, freshIp())).status).toBe(401);
    expect(await ctx.readFileJson()).toMatchObject({ version: 1, admin: { passwordHash: TEST_ADMIN_HASH } });
  });
});

describe("POST /settings/upgrade", () => {
  it("目前的密碼錯誤 → 401，什麼都不會改（檔案逐位元組不變）、沒有 cookie；log 有一行失敗紀錄（含 Email、來源 IP，沒有密碼）", async () => {
    const ctx = await makeLegacyApp();
    const res = await call(ctx.app, "POST", "/settings/upgrade", upgradeBody({ currentPassword: "totally-wrong-password" }), ip("203.0.113.61"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "目前的密碼不正確" });
    expect(setCookieOf(res)).toBeUndefined();
    expect(await readFile(join(ctx.dir, "settings.json"), "utf8")).toBe(ctx.originalText);
    expect(ctx.store.data.admin).not.toBeNull();
    expect(ctx.store.data.accounts).toEqual([]);
    expect(ctx.log.lines).toContain("[accounts] lin.admin@example.test 升級管理員帳號失敗：目前的密碼不正確 lin.admin@example.test（來源 203.0.113.61）");
    const logged = ctx.log.lines.join("\n");
    expect(logged).not.toContain("totally-wrong-password");
    expect(logged).not.toContain(TEST_ADMIN_PASSWORD);
  });

  it("目前的密碼缺少、不是字串、超過 200 字元 → 401", async () => {
    const ctx = await makeLegacyApp();
    for (const currentPassword of [undefined, null, 123, "", "x".repeat(201)]) {
      expect((await call(ctx.app, "POST", "/settings/upgrade", upgradeBody({ currentPassword }), freshIp())).status).toBe(401);
    }
    expect(ctx.store.data.accounts).toEqual([]);
  });

  it("姓名或 Email 不合規則 → 400（先擋，不會去驗密碼：連 scrypt 都沒跑）", async () => {
    const ctx = await makeLegacyApp();
    const spy = vi.spyOn(auth, "verifyPassword");
    for (const bad of [{ name: "" }, { name: "x".repeat(51) }, { name: "a\nb" }, { name: 5 }, { email: "" }, { email: "nope" }, { email: "a@b" }, { email: 7 }, { email: undefined }]) {
      const res = await call(ctx.app, "POST", "/settings/upgrade", upgradeBody(bad), freshIp());
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(ctx.store.data.accounts).toEqual([]);
  });

  it("成功：200、建立第一位管理員（角色 admin、沿用同一個密碼雜湊、不要求重設）、舊的 admin 消失、版本變 3、發新格式的 cookie", async () => {
    const ctx = await makeLegacyApp();
    const res = await call(ctx.app, "POST", "/settings/upgrade", upgradeBody(), ip("203.0.113.62"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const file = await ctx.readFileJson();
    expect(file.version).toBe(3);
    expect("admin" in file).toBe(false); // 舊的單一密碼整個欄位都沒了
    expect("admins" in file).toBe(false);
    expect(file.accounts).toHaveLength(1);
    expect(file.accounts[0]).toMatchObject({
      name: "林管理", // trim
      email: "lin.admin@example.test", // trim＋小寫
      role: "admin", // 舊的單一管理密碼就是管理員
      passwordHash: TEST_ADMIN_HASH, // 沿用同一個雜湊
      status: "active",
      sessionVersion: 1,
      createdAt: new Date(NOW_MS).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      lastLoginAt: new Date(NOW_MS).toISOString(),
    });
    expect(file.accounts[0].id).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.store.data.admin).toBeNull();
    expect(ctx.store.data.version).toBe(3);

    // 新格式 cookie，綁著剛建立的帳號
    const parts = decodeURIComponent(cookiePair(res).split("=")[1]!).split(".");
    expect(parts).toHaveLength(5);
    expect(parts[1]).toBe(file.accounts[0].id);
    expect(parts[2]).toBe("1");
    expect(setCookieOf(res)).toContain("HttpOnly");
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: cookiePair(res) })).status).toBe(200);
    expect(ctx.log.lines).toContain("[accounts] lin.admin@example.test 升級為管理員帳號 lin.admin@example.test（來源 203.0.113.62）");
    expect(ctx.log.lines.join("\n")).not.toContain(TEST_ADMIN_PASSWORD);
  });

  it("升級不動到 line、lineCaptured、sessionSecret 與其他不認識的欄位：逐欄位比對與升級前完全相同", async () => {
    const ctx = await makeLegacyApp();
    const before = JSON.parse(ctx.originalText) as Record<string, any>;
    expect((await call(ctx.app, "POST", "/settings/upgrade", upgradeBody())).status).toBe(200);
    const after = await ctx.readFileJson();
    expect(after.sessionSecret).toBe(before.sessionSecret);
    expect(after.line).toEqual(before.line); // 含不認識的 futureLineField
    expect(after.lineCaptured).toEqual(before.lineCaptured);
    expect(after.futureTopLevelField).toEqual(before.futureTopLevelField);
    // 除了 version、admin（刪除）、accounts（新增）之外，沒有任何頂層欄位被改動或新增
    expect(Object.keys(after).sort()).toEqual(["accounts", "futureTopLevelField", "line", "lineCaptured", "sessionSecret", "version"]);
  });

  it("升級後舊登入全部失效：升級前簽的舊格式 cookie 仍然是 401；用 Email＋「原本那個密碼」登入成功", async () => {
    const ctx = await makeLegacyApp();
    const expires = String(NOW_MS + SESSION_TTL_MS);
    const nonce = "AAAAAAAAAAAAAAAA";
    const mac = createHmac("sha256", Buffer.from(SESSION_SECRET, "hex")).update(`${expires}.${nonce}`).digest("base64url");
    const legacyCookie = `${SESSION_COOKIE_NAME}=${expires}.${nonce}.${mac}`;
    expect((await call(ctx.app, "POST", "/settings/upgrade", upgradeBody(), freshIp())).status).toBe(200);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: legacyCookie })).status).toBe(401);
    const redirected = await ctx.app.request("/settings", { headers: { cookie: legacyCookie } });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe("/login?next=/settings");
    const login = await call(ctx.app, "POST", "/login", { email: "lin.admin@example.test", password: TEST_ADMIN_PASSWORD }, freshIp());
    expect(login.status).toBe(200);
    // 只有密碼（舊的登入方式）已經不能用
    expect((await call(ctx.app, "POST", "/login", { password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(401);
  });

  it("升級後 LINE 設定原封不動地繼續運作：關箱通知用同一個 token 與群組、設定頁顯示同樣的 LINE 設定", async () => {
    const ctx = await makeLegacyApp();
    const upgrade = await call(ctx.app, "POST", "/settings/upgrade", upgradeBody());
    ctx.calls.length = 0;
    const notify = await call(ctx.app, "POST", "/api/box-closed", { boxId: "BOX-2", items: [], total: 0, successCount: 0, failedCount: 0 }, { cookie: cookiePair(upgrade) });
    expect(await notify.json()).toEqual({ success: true, notified: true });
    expect(ctx.calls[0]!.headers.authorization).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    const view = (await (await call(ctx.app, "GET", "/api/settings", undefined, { cookie: cookiePair(upgrade) })).json()) as { data: any };
    expect(view.data.line).toMatchObject({ enabled: true, groupId: TEST_GROUP_ID, groupName: "倉庫出貨群", channelAccessToken: { configured: true }, channelSecret: { configured: true } });
    expect(view.data.captured).toHaveLength(1);
    expect(view.data).toMatchObject({ adminCount: 1, accountCount: 1, legacyAdminPending: false });
  });

  it("升級後 /healthz：legacyAdminPending false、adminCount 1；設定頁頁面是登入後的設定頁（有管理員表格）", async () => {
    const ctx = await makeLegacyApp();
    const upgrade = await call(ctx.app, "POST", "/settings/upgrade", upgradeBody());
    const health = (await (await ctx.app.request("/healthz")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ adminConfigured: true, adminCount: 1, legacyAdminPending: false });
    const html = await (await ctx.app.request("/settings", { headers: { cookie: cookiePair(upgrade) } })).text();
    expect(html).toContain('id="admin-table"');
    expect(html).toContain("lin.admin@example.test");
    expect(html).toContain("林管理");
  });

  it("只能升級一次：已經升級後再呼叫 409（即使目前的密碼正確），不會多建帳號", async () => {
    const ctx = await makeLegacyApp();
    expect((await call(ctx.app, "POST", "/settings/upgrade", upgradeBody(), freshIp())).status).toBe(200);
    const again = await call(ctx.app, "POST", "/settings/upgrade", upgradeBody({ email: "other@example.test" }), freshIp());
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ success: false, error: "沒有需要升級的舊版管理密碼" });
    expect(ctx.store.data.accounts).toHaveLength(1);
  });

  it("沒有待升級的舊版密碼（全新安裝、或本來就有管理員）：409，且不去驗密碼", async () => {
    const spy = vi.spyOn(auth, "verifyPassword");
    for (const ctx of [await makeSettingsApp({ withAdmin: false }), await makeSettingsApp()]) {
      const res = await call(ctx.app, "POST", "/settings/upgrade", upgradeBody(), freshIp());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ success: false, error: "沒有需要升級的舊版管理密碼" });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("兩個升級請求同時進來（都帶正確的密碼）：只有一個成功，另一個 409，只建一位管理員", async () => {
    const ctx = await makeLegacyApp();
    const [a, b] = await Promise.all([
      call(ctx.app, "POST", "/settings/upgrade", upgradeBody({ email: "a@example.test" }), freshIp()),
      call(ctx.app, "POST", "/settings/upgrade", upgradeBody({ email: "b@example.test" }), freshIp()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(ctx.store.data.accounts).toHaveLength(1);
    expect(ctx.store.data.admin).toBeNull();
  });

  it("驗證密碼期間舊密碼被換掉：這次升級作廢（409），不會用過期的雜湊建立帳號", async () => {
    const ctx = await makeLegacyApp();
    const real = auth.verifyPassword;
    vi.spyOn(auth, "verifyPassword").mockImplementationOnce(async (password, hash) => {
      await ctx.store.update((draft) => {
        draft.admin!.passwordHash = auth.DUMMY_PASSWORD_HASH;
      });
      return real(password, hash);
    });
    const res = await call(ctx.app, "POST", "/settings/upgrade", upgradeBody(), freshIp());
    expect(res.status).toBe(409);
    expect(ctx.store.data.accounts).toEqual([]);
  });

  it(`scrypt 並行閘門：同時最多 ${PASSWORD_GATE_MAX_ACTIVE} 個在算、${PASSWORD_GATE_MAX_QUEUE} 個排隊，其餘 429——升級端點也不能繞過閘門`, async () => {
    const ctx = await makeLegacyApp();
    const total = 40;
    const responses = await Promise.all(
      Array.from({ length: total }, (_, i) => call(ctx.app, "POST", "/settings/upgrade", upgradeBody({ currentPassword: `wrong-password-${i}` }), ip(`198.51.100.${i + 1}`))),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.every((st) => st === 401 || st === 429)).toBe(true);
    expect(statuses.filter((st) => st === 401).length).toBeLessThanOrEqual(PASSWORD_GATE_MAX_ACTIVE + PASSWORD_GATE_MAX_QUEUE);
    expect(statuses.filter((st) => st === 429).length).toBeGreaterThanOrEqual(total - PASSWORD_GATE_MAX_ACTIVE - PASSWORD_GATE_MAX_QUEUE);
    expect(await ctx.readFileJson()).toEqual(JSON.parse(ctx.originalText)); // 什麼都沒改
    expect((await call(ctx.app, "POST", "/settings/upgrade", upgradeBody(), ip("198.51.100.200"))).status).toBe(200); // 洪水過後恢復
  });

  it("和登入共用額度（每 IP 每分鐘 10 次）：用錯誤的密碼猜 10 次之後第 11 次 429（連正確的也一樣）", async () => {
    const ctx = await makeLegacyApp();
    for (let i = 0; i < 10; i++) {
      expect((await call(ctx.app, "POST", "/settings/upgrade", upgradeBody({ currentPassword: `wrong-guess-${i}` }), ip("203.0.113.66"))).status).toBe(401);
    }
    const blocked = await call(ctx.app, "POST", "/settings/upgrade", upgradeBody(), ip("203.0.113.66"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(ctx.store.data.accounts).toEqual([]);
    expect((await call(ctx.app, "POST", "/settings/upgrade", upgradeBody(), ip("203.0.113.67"))).status).toBe(200); // 其他 IP 不受影響
  });

  it("升級後可以立刻新增第二位管理員（整條流程接得起來）", async () => {
    const ctx = await makeLegacyApp();
    const upgrade = await call(ctx.app, "POST", "/settings/upgrade", upgradeBody());
    const created = await call(ctx.app, "POST", "/api/accounts", { name: "第二位", email: "second@example.test", password: "second-admin-password-1" }, { cookie: cookiePair(upgrade) });
    expect(created.status).toBe(200);
    expect((await ctx.readFileJson()).accounts).toHaveLength(2);
  });

  it("檔案是 0600、沒有殘留暫存檔", async () => {
    const ctx = await makeLegacyApp();
    await call(ctx.app, "POST", "/settings/upgrade", upgradeBody());
    expect((await stat(join(ctx.dir, "settings.json"))).mode & 0o777).toBe(0o600);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(ctx.dir)).sort()).toEqual(["settings.json"]);
  });

  it("重新啟動（重新開啟同一個資料目錄）後：升級的結果還在，新登入有效，不再提示待升級", async () => {
    const ctx = await makeLegacyApp();
    await call(ctx.app, "POST", "/settings/upgrade", upgradeBody());
    const reopened = await SettingsStore.open(ctx.dir, { log: createCapturingLogger() });
    expect(reopened.data.admin).toBeNull();
    expect(reopened.data.accounts).toHaveLength(1);
    expect(reopened.data.accounts[0]!.passwordHash).toBe(TEST_ADMIN_HASH);
    const app2 = await makeSettingsApp({ store: reopened });
    expect((await call(app2.app, "POST", "/login", { email: "lin.admin@example.test", password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(200);
    expect(app2.log.lines.some((l) => l.includes("設定碼"))).toBe(false);
  });
});

describe("版本 1 的檔案沒有 admin 也沒有 accounts（舊版全新安裝、還沒建立密碼）", () => {
  it("視為全新安裝：顯示建立第一位管理員的表單，啟動 log 有設定碼，建立之後檔案變成版本 3", async () => {
    const file = legacyFile();
    delete file.admin;
    const ctx = await makeLegacyApp({ file });
    expect(await (await ctx.app.request("/settings")).text()).toContain('id="setup-form"');
    expect(ctx.log.lines.some((l) => l.includes("設定碼"))).toBe(true);
    const res = await call(ctx.app, "POST", "/settings/setup", { setupCode: "ABCD-EFGH", name: "甲", email: "a@example.test", password: "a-brand-new-password-42" });
    expect(res.status).toBe(200);
    const after = await ctx.readFileJson();
    expect(after.version).toBe(3);
    expect(after.sessionSecret).toBe(SESSION_SECRET);
    expect(after.line.channelAccessToken).toBe(TEST_LINE_TOKEN);
  });
});
