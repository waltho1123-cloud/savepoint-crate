import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth.js";
import { lineStubPreload, readStubLog, startServer } from "./process-helpers.js";
import { cleanupTempDirs, makeTempDir } from "./settings-helpers.js";

afterEach(cleanupTempDirs);

// 真的啟動 src/server.ts，走完設定頁的完整流程：
//   1. 全新安裝：建立第一位管理員 → 登入 → 存 LINE 設定 → 關箱通知／webhook／測試訊息 → 重新啟動後設定與登入都還在
//   2. 舊檔升級：正式站現在的樣子（版本 1、舊的單一密碼、LINE 設定都存好了）→ 不中斷地升級成管理員帳號 →
//      新增第二位 → 停用第一位 → 第二位登入 → 自己不能刪／停用自己 → 重新啟動後一切還在
// 子行程裡的 fetch 被換成只允許打 api.line.me 的替身（tests/fixtures/line-stub-preload.mjs），不會真的打 LINE。

const PASSWORD = "real-process-password-42";
const SECOND_PASSWORD = "second-admin-password-77";
const TOKEN = "real-process-line-token-0123456789";
const SECRET = "real-process-line-secret-abcdef";
const GROUP = "C0123456789abcdef0123456789abcdef";
const JSON_HEADERS = { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };

async function api(base: string, method: string, path: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...JSON_HEADERS, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as any };
}
const cookieOf = (res: { headers: Headers }) => res.headers.getSetCookie()[0]!.split(";")[0]!;

describe("設定頁在真實行程裡的完整流程（全新安裝）", () => {
  it("設定碼建立第一位管理員 → Email 登入 → 存 LINE 設定 → 關箱通知／webhook／測試訊息 → 重新啟動後設定與登入都還在", async () => {
    const dataDir = await makeTempDir();
    const stubLog = join(await makeTempDir(), "line.log");
    const env = { OPENAI_API_KEY: "x", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "x", DATA_DIR: dataDir, LINE_STUB_LOG: stubLog };

    // ------------------------------------------------------------ 第一次啟動
    const first = await startServer(env, { preload: lineStubPreload });
    let cookie = "";
    try {
      const announce = /\[settings\] 尚未設定管理密碼：請開啟 \/settings，用設定碼 ([A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}) 建立密碼/.exec(first.output());
      expect(announce, first.output()).not.toBeNull();
      const setupCode = announce![1]!;

      const health0 = (await (await fetch(`${first.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health0).toMatchObject({ dataDirWritable: true, adminConfigured: false, adminCount: 0, accountCount: 0, legacyAdminPending: false, lineConfigured: false, lineWebhookConfigured: false, lineSource: null });

      // 設定檔在第一次啟動時就建好了：權限 0600、版本 3、沒有舊的 admin 欄位
      const file = join(dataDir, "settings.json");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await readdir(dataDir)).sort()).toEqual(["settings.json"]);
      const initial = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      expect(initial).toMatchObject({ version: 3, accounts: [] });
      expect("admin" in initial).toBe(false);

      const page = await fetch(`${first.base}/settings`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('id="setup-form"');

      // 設定碼錯誤 403；姓名／Email／密碼不合規則 400；沒登入讀設定 401
      const ok = { setupCode, name: "第一位管理員", email: "First@Example.TEST", password: PASSWORD };
      expect((await api(first.base, "POST", "/settings/setup", { ...ok, setupCode: "ZZZZ-ZZZZ" })).status).toBe(403);
      expect((await api(first.base, "POST", "/settings/setup", { ...ok, name: "" })).status).toBe(400);
      expect((await api(first.base, "POST", "/settings/setup", { ...ok, email: "nope" })).status).toBe(400);
      expect((await api(first.base, "POST", "/settings/setup", { ...ok, password: "short" })).status).toBe(400);
      expect((await api(first.base, "GET", "/api/settings")).status).toBe(401);

      // 建立第一位管理員：200、cookie
      const setup = await api(first.base, "POST", "/settings/setup", ok);
      expect(setup.status).toBe(200);
      const setCookie = setup.headers.getSetCookie()[0]!;
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      cookie = setCookie.split(";")[0]!;
      expect(decodeURIComponent(cookie.split("=")[1]!).split(".")).toHaveLength(5);

      const saved = await readFile(file, "utf8");
      expect(saved).toContain("scrypt$16384$8$1$");
      expect(saved).not.toContain(PASSWORD);
      expect(JSON.parse(saved).accounts[0]).toMatchObject({ name: "第一位管理員", email: "first@example.test", role: "admin", status: "active", sessionVersion: 1 });
      expect((await stat(file)).mode & 0o777).toBe(0o600);

      // 登入：舊版只有密碼的登入方式不能用；Email＋密碼可以
      expect((await api(first.base, "POST", "/login", { password: PASSWORD })).status).toBe(401);
      expect((await api(first.base, "POST", "/login", { email: "first@example.test", password: "wrong-password-xx" })).status).toBe(401);
      expect((await api(first.base, "POST", "/login", { email: " FIRST@example.test ", password: PASSWORD })).status).toBe(200);
      expect((await api(first.base, "GET", "/api/settings", undefined, cookie)).json.data.me).toMatchObject({ name: "第一位管理員", email: "first@example.test", role: "admin" });

      // 存 LINE 設定（子行程裡的 LINE 是替身；查群組名稱會打到替身）
      const put = await api(first.base, "PUT", "/api/settings/line", { enabled: true, channelAccessToken: TOKEN, channelSecret: SECRET, groupId: GROUP }, cookie);
      expect(put.status).toBe(200);
      expect(put.json.data.line).toMatchObject({ groupId: GROUP, groupName: "真實行程測試群組" });
      expect(JSON.stringify(put.json)).not.toContain(TOKEN);
      expect(JSON.stringify(put.json)).not.toContain(SECRET);

      const health1 = (await (await fetch(`${first.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health1).toMatchObject({ adminConfigured: true, adminCount: 1, accountCount: 1, legacyAdminPending: false, lineConfigured: true, lineWebhookConfigured: true, lineSource: "settings" });

      // 關箱通知：推播到「設定檔裡的」群組，帶「設定檔裡的」token
      expect((await api(first.base, "POST", "/api/box-closed", { boxId: "BOX-001", items: [], total: 0, successCount: 0, failedCount: 0 })).status).toBe(401); // 沒登入不能用
      const notify = await api(first.base, "POST", "/api/box-closed", { boxId: "BOX-001", items: [{ barcode: "1", productName: "商品", qty: 2 }], total: 1, successCount: 1, failedCount: 0 }, cookie);
      expect(notify.json).toEqual({ success: true, notified: true });
      const push = readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"));
      expect(push).toHaveLength(1);
      expect(push[0]).toMatchObject({ method: "POST", authorization: `Bearer ${TOKEN}` });
      expect(push[0]!.body.to).toBe(GROUP);
      expect(push[0]!.body.messages[0].text).toContain("操作：第一位管理員"); // 訊息帶登入者的姓名

      // 測試訊息
      expect((await api(first.base, "POST", "/api/settings/line/test", {}, cookie)).json).toEqual({ success: true, notified: true });
      expect(readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"))).toHaveLength(2);

      // webhook：用「設定檔裡的」secret 簽章
      const newGroup = "Cfedcba9876543210fedcba9876543210";
      const webhookBody = JSON.stringify({ events: [{ type: "join", replyToken: "rt-1", source: { type: "group", groupId: newGroup } }] });
      const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64");
      const bad = await fetch(`${first.base}/api/line/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": sign(webhookBody, "wrong") }, body: webhookBody });
      expect(bad.status).toBe(401);
      const good = await fetch(`${first.base}/api/line/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": sign(webhookBody, SECRET) }, body: webhookBody });
      expect(good.status).toBe(200);
      const afterWebhook = await api(first.base, "GET", "/api/settings", undefined, cookie);
      expect(afterWebhook.json.data.captured).toEqual([
        { groupId: newGroup, groupName: "真實行程測試群組", eventType: "join", lastSeenAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      ]);
      const replies = readStubLog(stubLog).filter((c) => c.url.endsWith("/message/reply"));
      expect(replies).toHaveLength(1);
      expect(replies[0]!.body.messages[0].text).toContain(newGroup);

      // 頁面（已登入）有設定表單、管理員表格與剛記錄的群組，且沒有完整的 token／secret／密碼雜湊
      const settingsPage = await (await fetch(`${first.base}/settings`, { headers: { cookie } })).text();
      expect(settingsPage).toContain('id="line-form"');
      expect(settingsPage).toContain('id="admin-table"');
      expect(settingsPage).toContain("first@example.test");
      expect(settingsPage).toContain(`data-use-group="${newGroup}"`);
      for (const secret of [TOKEN, SECRET, "scrypt$"]) expect(settingsPage).not.toContain(secret);

      // 整個過程的輸出（stdout＋stderr）不含 token、secret、密碼；審計 log 有建立與登入
      for (const secret of [TOKEN, SECRET, PASSWORD, "wrong-password-xx"]) expect(first.output()).not.toContain(secret);
      expect(first.output()).toMatch(/\[accounts\] first@example\.test 建立第一位管理員 first@example\.test（來源 127\.0\.0\.1）/);
      expect(first.output()).toMatch(/\[accounts\] first@example\.test 登入失敗（來源 127\.0\.0\.1）/);
      expect(first.output()).toMatch(/\[accounts\] first@example\.test 登入成功（來源 127\.0\.0\.1）/);
    } finally {
      await first.stop();
    }

    // ------------------------------------------------------------ 重新啟動（同一個資料目錄）
    const second = await startServer(env, { preload: lineStubPreload });
    try {
      expect(second.output()).not.toContain("尚未設定管理密碼"); // 已經有管理員：不再提示
      expect((await api(second.base, "GET", "/api/settings", undefined, cookie)).status).toBe(200); // 重新啟動前拿到的 cookie 仍然有效
      const health = (await (await fetch(`${second.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ adminConfigured: true, adminCount: 1, accountCount: 1, legacyAdminPending: false, lineConfigured: true, lineWebhookConfigured: true, lineSource: "settings" });
      expect((await api(second.base, "POST", "/login", { email: "first@example.test", password: PASSWORD })).status).toBe(200);
      expect((await api(second.base, "POST", "/login", { email: "first@example.test", password: "wrong-password-xx" })).status).toBe(401);
      const before = readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push")).length;
      const notify = await api(second.base, "POST", "/api/box-closed", { boxId: "BOX-002", items: [], total: 0, successCount: 0, failedCount: 0 }, cookie);
      expect(notify.json).toEqual({ success: true, notified: true });
      expect(readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"))).toHaveLength(before + 1);
      expect(second.output()).toContain(`[settings] 資料目錄：${dataDir}`);
    } finally {
      await second.stop();
    }
  }, 90_000);
});

describe("舊檔升級（正式站現在的狀態）→ 管理員帳號管理，在真實行程裡", () => {
  it("舊版單一密碼的檔案不中斷升級：LINE 設定與 sessionSecret 原封不動 → 新增第二位 → 停用第一位 → 第二位登入 → 自己不能刪／停用自己 → 重新啟動後一切還在", async () => {
    const dataDir = await makeTempDir();
    const stubLog = join(await makeTempDir(), "line.log");
    const env = { OPENAI_API_KEY: "x", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "x", DATA_DIR: dataDir, LINE_STUB_LOG: stubLog };
    const legacyPassword = "legacy-single-password-1";
    const legacyHash = await hashPassword(legacyPassword);
    const sessionSecret = "ab".repeat(32);
    const original = {
      version: 1,
      admin: { passwordHash: legacyHash, updatedAt: "2026-09-30T00:00:00.000Z" },
      sessionSecret,
      line: { enabled: true, channelAccessToken: TOKEN, channelSecret: SECRET, groupId: GROUP, groupName: "倉庫出貨群", updatedAt: "2026-10-01T00:00:00.000Z" },
      lineCaptured: [{ groupId: GROUP, groupName: "倉庫出貨群", eventType: "join", lastSeenAt: "2026-10-02T00:00:00.000Z" }],
      futureTopLevelField: { keep: ["me"] },
    };
    const file = join(dataDir, "settings.json");
    await writeFile(file, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
    const readFileJson = async () => JSON.parse(await readFile(file, "utf8")) as Record<string, any>;

    let firstCookie = "";
    let secondCookie = "";
    const first = await startServer(env, { preload: lineStubPreload });
    try {
      // ---- 升級前：不提示設定碼；有待升級的舊密碼；頁面是升級表單；LINE 通知照常運作；檔案沒被動過
      expect(first.output()).not.toContain("設定碼");
      const health0 = (await (await fetch(`${first.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health0).toMatchObject({ adminConfigured: true, adminCount: 0, legacyAdminPending: true, lineConfigured: true, lineSource: "settings" });
      expect(await (await fetch(`${first.base}/settings`)).text()).toContain('id="upgrade-form"');
      // 全站登入：升級之前沒有任何帳號可以登入，主頁導向登入頁、API 要登入；LINE webhook 仍然公開
      expect((await fetch(`${first.base}/`, { redirect: "manual" })).status).toBe(302);
      expect((await api(first.base, "POST", "/api/box-closed", { boxId: "BOX-1", items: [], total: 0, successCount: 0, failedCount: 0 })).status).toBe(401);
      expect(readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"))).toHaveLength(0);
      expect(await (await fetch(`${first.base}/login`)).text()).toContain("尚未建立任何帳號");
      expect(await readFileJson()).toEqual(original);
      // 舊版的登入端點（只有密碼）已經不能用，要先升級
      expect((await api(first.base, "POST", "/login", { email: "first@example.test", password: legacyPassword })).status).toBe(409);

      // ---- 升級：錯誤的目前密碼 401（檔案不變）；正確 200
      const upgradeBody = { currentPassword: legacyPassword, name: "第一位", email: "first@example.test" };
      expect((await api(first.base, "POST", "/settings/upgrade", { ...upgradeBody, currentPassword: "not-the-password" })).status).toBe(401);
      expect(await readFileJson()).toEqual(original);
      const upgrade = await api(first.base, "POST", "/settings/upgrade", upgradeBody);
      expect(upgrade.status).toBe(200);
      firstCookie = cookieOf(upgrade);
      const upgraded = await readFileJson();
      expect(upgraded.version).toBe(3);
      expect("admin" in upgraded).toBe(false);
      expect("admins" in upgraded).toBe(false);
      expect(upgraded.accounts).toHaveLength(1);
      expect(upgraded.accounts[0]).toMatchObject({ name: "第一位", email: "first@example.test", role: "admin", passwordHash: legacyHash, status: "active", sessionVersion: 1 });
      expect(upgraded.sessionSecret).toBe(original.sessionSecret);
      expect(upgraded.line).toEqual(original.line);
      expect(upgraded.lineCaptured).toEqual(original.lineCaptured);
      expect(upgraded.futureTopLevelField).toEqual(original.futureTopLevelField);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const health1 = (await (await fetch(`${first.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health1).toMatchObject({ adminConfigured: true, adminCount: 1, accountCount: 1, legacyAdminPending: false });
      // 升級之後 LINE 通知照常（用的是設定檔裡原本的 token 與群組），帶操作者姓名
      expect((await api(first.base, "POST", "/api/box-closed", { boxId: "BOX-1", items: [], total: 0, successCount: 0, failedCount: 0 }, firstCookie)).json).toEqual({ success: true, notified: true });
      const pushes = readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"));
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ authorization: `Bearer ${TOKEN}` });
      expect(pushes[0]!.body.to).toBe(GROUP);
      expect(pushes[0]!.body.messages[0].text).toContain("操作：第一位");
      // 升級後舊格式（三段式）的 cookie 失效
      const legacyCookie = (() => {
        const expires = String(Date.now() + 3_600_000);
        const mac = createHmac("sha256", Buffer.from(sessionSecret, "hex")).update(`${expires}.AAAAAAAAAAAAAAAA`).digest("base64url");
        return `sp_session=${expires}.AAAAAAAAAAAAAAAA.${mac}`;
      })();
      expect((await api(first.base, "GET", "/api/settings", undefined, legacyCookie)).status).toBe(401);
      // 用 Email 與「原本那個密碼」可以登入（沿用同一個密碼，不用重設）
      expect((await api(first.base, "POST", "/login", { email: "first@example.test", password: legacyPassword })).status).toBe(200);
      expect((await api(first.base, "GET", "/api/settings", undefined, firstCookie)).json.data.me).toMatchObject({ name: "第一位", email: "first@example.test", role: "admin" });

      // ---- 新增第二位
      const created = await api(first.base, "POST", "/api/accounts", { name: "第二位", email: "Second@Example.test", password: SECOND_PASSWORD, role: "admin" }, firstCookie);
      expect(created.status).toBe(200);
      const secondId = created.json.data.account.id as string;
      const firstId = upgraded.accounts[0].id as string;
      expect((await api(first.base, "POST", "/api/accounts", { name: "重複", email: "SECOND@example.test", password: SECOND_PASSWORD }, firstCookie)).status).toBe(409); // Email 重複
      expect((await api(first.base, "GET", "/api/accounts", undefined, firstCookie)).json.data.accounts.map((a: { email: string }) => a.email)).toEqual(["first@example.test", "second@example.test"]);
      expect(JSON.stringify((await api(first.base, "GET", "/api/accounts", undefined, firstCookie)).json)).not.toContain("scrypt$");

      // ---- 第一位不能停用或刪除自己
      expect((await api(first.base, "POST", `/api/accounts/${firstId}/status`, { status: "disabled" }, firstCookie)).status).toBe(409);
      expect((await api(first.base, "DELETE", `/api/accounts/${firstId}`, undefined, firstCookie)).status).toBe(409);

      // ---- 第二位登入，並停用第一位
      const secondLogin = await api(first.base, "POST", "/login", { email: "second@example.test", password: SECOND_PASSWORD });
      expect(secondLogin.status).toBe(200);
      secondCookie = cookieOf(secondLogin);
      expect((await api(first.base, "POST", `/api/accounts/${firstId}/status`, { status: "disabled" }, secondCookie)).status).toBe(200);
      expect((await api(first.base, "GET", "/api/settings", undefined, firstCookie)).status).toBe(401); // 第一位的登入立刻失效
      expect((await api(first.base, "POST", "/login", { email: "first@example.test", password: legacyPassword })).status).toBe(401); // 停用的帳號登不進去

      // ---- 第二位現在是唯一啟用中的管理員：不能停用或刪除自己
      expect((await api(first.base, "POST", `/api/accounts/${secondId}/status`, { status: "disabled" }, secondCookie)).status).toBe(409);
      expect((await api(first.base, "DELETE", `/api/accounts/${secondId}`, undefined, secondCookie)).status).toBe(409);

      // ---- 第二位重設第一位的密碼並重新啟用；第一位用新密碼登入，舊 cookie 沒有復活
      expect((await api(first.base, "POST", `/api/accounts/${firstId}/password`, { newPassword: "first-new-password-88" }, secondCookie)).status).toBe(200);
      expect((await api(first.base, "POST", `/api/accounts/${firstId}/status`, { status: "active" }, secondCookie)).status).toBe(200);
      expect((await api(first.base, "GET", "/api/settings", undefined, firstCookie)).status).toBe(401);
      const firstAgain = await api(first.base, "POST", "/login", { email: "first@example.test", password: "first-new-password-88" });
      expect(firstAgain.status).toBe(200);
      firstCookie = cookieOf(firstAgain);

      // ---- LINE 設定與測試訊息一路都沒受影響
      expect((await api(first.base, "POST", "/api/settings/line/test", {}, firstCookie)).json).toEqual({ success: true, notified: true });

      // ---- 輸出裡沒有任何密碼、token、secret；審計 log 完整
      for (const secret of [legacyPassword, SECOND_PASSWORD, "first-new-password-88", "not-the-password", TOKEN, SECRET]) expect(first.output()).not.toContain(secret);
      for (const expected of [
        /\[accounts\] first@example\.test 升級為管理員帳號 first@example\.test（來源 127\.0\.0\.1）/,
        /\[accounts\] first@example\.test 新增帳號 second@example\.test（角色 admin）（來源 127\.0\.0\.1）/,
        /\[accounts\] second@example\.test 停用帳號 first@example\.test（來源 127\.0\.0\.1）/,
        /\[accounts\] second@example\.test 重設密碼 first@example\.test（來源 127\.0\.0\.1）/,
        /\[accounts\] second@example\.test 啟用帳號 first@example\.test（來源 127\.0\.0\.1）/,
        /\[accounts\] first@example\.test 登入失敗（來源 127\.0\.0\.1）/,
      ]) {
        expect(first.output()).toMatch(expected);
      }
    } finally {
      await first.stop();
    }

    // ---- 重新啟動：帳號、密碼、sessionVersion、LINE 設定都還在；現有的 cookie 仍然有效；不再有待升級
    const second = await startServer(env, { preload: lineStubPreload });
    try {
      expect(second.output()).not.toContain("設定碼");
      const health = (await (await fetch(`${second.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ adminConfigured: true, adminCount: 2, accountCount: 2, legacyAdminPending: false, lineConfigured: true, lineSource: "settings" });
      expect((await api(second.base, "GET", "/api/settings", undefined, firstCookie)).status).toBe(200);
      expect((await api(second.base, "GET", "/api/settings", undefined, secondCookie)).status).toBe(200);
      expect((await api(second.base, "POST", "/login", { email: "second@example.test", password: SECOND_PASSWORD })).status).toBe(200);
      expect((await api(second.base, "POST", "/login", { email: "first@example.test", password: legacyPassword })).status).toBe(401); // 舊密碼已被重設掉
      // 第一位刪除第二位（不是自己）→ 成功；第二位的 cookie 失效
      const secondId = (await api(second.base, "GET", "/api/accounts", undefined, firstCookie)).json.data.accounts.find((a: { email: string }) => a.email === "second@example.test").id as string;
      expect((await api(second.base, "DELETE", `/api/accounts/${secondId}`, undefined, firstCookie)).status).toBe(200);
      expect((await api(second.base, "GET", "/api/settings", undefined, secondCookie)).status).toBe(401);
      const finalFile = await readFileJson();
      expect(finalFile.accounts).toHaveLength(1);
      expect(finalFile.line).toEqual(original.line);
      expect(finalFile.sessionSecret).toBe(original.sessionSecret);
      expect(finalFile.futureTopLevelField).toEqual(original.futureTopLevelField);
    } finally {
      await second.stop();
    }
  }, 120_000);
});

describe("設定頁在真實行程裡的其他情況", () => {
  it("資料目錄不可用（上層是一般檔案）：服務照常啟動；/healthz 回 false；整個網站（登入頁、設定頁、API）回 503，因為沒有地方存帳號", async () => {
    const root = await makeTempDir();
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "x");
    const stubLog = join(root, "line.log");
    const server = await startServer(
      {
        OPENAI_API_KEY: "x",
        GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "x",
        DATA_DIR: join(blocker, "data"),
        LINE_STUB_LOG: stubLog,
        LINE_CHANNEL_ACCESS_TOKEN: TOKEN,
        LINE_GROUP_ID: GROUP,
      },
      { preload: lineStubPreload },
    );
    try {
      expect(server.output()).toContain("請在 Zeabur 掛載 Volume 到 /app/data");
      const health = (await (await fetch(`${server.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ dataDirWritable: false, adminConfigured: false, adminCount: 0, accountCount: 0, legacyAdminPending: false, lineConfigured: true, lineSource: "env" });

      const page = await fetch(`${server.base}/settings`);
      expect(page.status).toBe(503);
      expect(await page.text()).toContain("請在 Zeabur 掛載 Volume 到 /app/data");
      expect((await api(server.base, "GET", "/api/settings")).status).toBe(503);
      expect((await api(server.base, "GET", "/api/accounts")).status).toBe(503);
      expect((await api(server.base, "POST", "/settings/setup", { setupCode: "ABCD-EFGH", name: "甲", email: "a@example.test", password: PASSWORD })).status).toBe(503);
      expect(server.output()).not.toContain("尚未設定管理密碼");

      // 全站登入：沒有地方存帳號就沒有人登入得了，整個網站（含關箱通知）回 503 與掛載 Volume 的說明；/healthz 仍然公開
      const notify = await api(server.base, "POST", "/api/box-closed", { boxId: "B1", items: [], total: 0, successCount: 0, failedCount: 0 });
      expect(notify.status).toBe(503);
      expect(notify.json).toEqual({ success: false, error: "請在 Zeabur 掛載 Volume 到 /app/data" });
      expect((await fetch(`${server.base}/`, { redirect: "manual" })).status).toBe(302);
      expect((await fetch(`${server.base}/login`)).status).toBe(503);
      expect(readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"))).toHaveLength(0);
    } finally {
      await server.stop();
    }
  }, 60_000);

  it("設定檔損毀：備份成 settings.json.corrupt-<時間>、用空設定重新開始（不覆蓋原內容）、log 有說明", async () => {
    const dataDir = await makeTempDir();
    await writeFile(join(dataDir, "settings.json"), '{"version":1,"admin":{"passwordHash":"scrypt$broken');
    const server = await startServer({ OPENAI_API_KEY: "x", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "x", DATA_DIR: dataDir });
    try {
      expect(server.output()).toMatch(/settings\.json 內容損毀.*settings\.json\.corrupt-\d{8}T\d{6}Z/);
      const names = await readdir(dataDir);
      const backup = names.find((name) => name.startsWith("settings.json.corrupt-"));
      expect(backup).toBeDefined();
      expect(await readFile(join(dataDir, backup!), "utf8")).toBe('{"version":1,"admin":{"passwordHash":"scrypt$broken');
      expect(JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8")).version).toBe(3);
      const health = (await (await fetch(`${server.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ dataDirWritable: true, adminConfigured: false, adminCount: 0, accountCount: 0, legacyAdminPending: false });
      expect(server.output()).toContain("尚未設定管理密碼"); // 空設定重新開始，要重新用設定碼建立第一位管理員
    } finally {
      await server.stop();
    }
  }, 60_000);

  // 忘記所有密碼時的復原方式（README）：版本 3（accounts）與舊的版本 2（admins）的檔案，同一行指令都能清空帳號
  it.each([
    { label: "版本 3（accounts）", version: 3, key: "accounts", roleField: true },
    { label: "版本 2（admins，沒有角色欄位）", version: 2, key: "admins", roleField: false },
  ])("$label 的檔案：照 README 的一行指令清空帳號（忘記所有密碼時的復原方式）→ 重新啟動後設定碼流程重新出現，LINE 設定不受影響", async ({ version, key, roleField }) => {
    const dataDir = await makeTempDir();
    const stubLog = join(await makeTempDir(), "line.log");
    const env = { OPENAI_API_KEY: "x", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "x", DATA_DIR: dataDir, LINE_STUB_LOG: stubLog };
    const file = join(dataDir, "settings.json");
    const entry = {
      id: "a".repeat(32),
      name: "舊管理員",
      email: "old@example.test",
      ...(roleField ? { role: "admin" } : {}),
      passwordHash: await hashPassword("forgotten-password-1"),
      status: "active",
      sessionVersion: 3,
      createdAt: "x",
      updatedAt: "x",
      lastLoginAt: null,
    };
    const withAccounts = {
      version,
      [key]: [entry],
      sessionSecret: "cd".repeat(32),
      line: { enabled: true, channelAccessToken: TOKEN, channelSecret: SECRET, groupId: GROUP, groupName: "倉庫", updatedAt: "x" },
      lineCaptured: [],
      futureField: { keep: ["我不認識的欄位也要原樣保留"] },
    };
    // 舊版升級後殘留一個 admin 欄位的情況也一併演練（復原指令要連它一起刪掉）
    await writeFile(file, JSON.stringify({ ...withAccounts, admin: { passwordHash: await hashPassword("legacy-leftover-pass"), updatedAt: "x" } }, null, 2));

    // 先確認有帳號時沒有設定碼
    const normal = await startServer(env, { preload: lineStubPreload });
    try {
      expect(normal.output()).not.toContain("尚未設定管理密碼");
      expect(((await (await fetch(`${normal.base}/healthz`)).json()) as { accountCount: number }).accountCount).toBe(1);
    } finally {
      await normal.stop();
    }

    // 服務停著的時候，照 README「忘記所有密碼時的復原方式」的那一行指令改檔（直接從 README 取出來跑，文件與實際行為不會脫節）
    // （版本 2 的檔案在上面那次啟動沒有任何寫入，所以檔案原樣；版本 3 同理）
    const readme = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
    const command = /^ {3}(node -e ".*accounts=\[\].*")$/m.exec(readme)?.[1];
    expect(command, "README 裡找不到復原用的那一行 node -e 指令").toBeTruthy();
    execFileSync("/bin/sh", ["-c", command!.split("/app/data/settings.json").join(file)], {
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    });
    const edited = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(edited).toEqual({ ...withAccounts, [key]: [] }); // 只有帳號清空、舊的 admin 刪掉；其他欄位（含不認識的）原樣；沒有多出任何欄位
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const recovered = await startServer(env, { preload: lineStubPreload });
    try {
      const announce = /用設定碼 ([A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}) 建立密碼/.exec(recovered.output());
      expect(announce, recovered.output()).not.toBeNull();
      const health = (await (await fetch(`${recovered.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ adminConfigured: false, adminCount: 0, accountCount: 0, legacyAdminPending: false, lineConfigured: true, lineSource: "settings" });
      expect(await (await fetch(`${recovered.base}/settings`)).text()).toContain('id="setup-form"');
      // 用新的設定碼建立新的第一位管理員（寫檔時升成版本 3；LINE 設定與 sessionSecret 原樣）
      const setup = await api(recovered.base, "POST", "/settings/setup", { setupCode: announce![1], name: "新管理員", email: "new@example.test", password: PASSWORD });
      expect(setup.status).toBe(200);
      const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
      expect(saved.version).toBe(3);
      expect("admins" in saved).toBe(false);
      expect(saved.accounts).toHaveLength(1);
      expect(saved.accounts[0]).toMatchObject({ email: "new@example.test", role: "admin" });
      expect(saved.line.channelAccessToken).toBe(TOKEN);
      expect(saved.sessionSecret).toBe(withAccounts.sessionSecret);
      expect(saved.futureField).toEqual(withAccounts.futureField);
      // 關箱 LINE 通知用新管理員的登入，用的是原本的 LINE 設定
      const newCookie = cookieOf(setup);
      expect((await api(recovered.base, "POST", "/api/box-closed", { boxId: "B", items: [], total: 0, successCount: 0, failedCount: 0 }, newCookie)).json).toEqual({ success: true, notified: true });
      // 舊管理員的 cookie 不會對應到新帳號（帳號 id 不同）
      const oldCookie = (() => {
        const expires = String(Date.now() + 3_600_000);
        const payload = `${expires}.${"a".repeat(32)}.3.AAAAAAAAAAAAAAAA`;
        return `sp_session=${payload}.${createHmac("sha256", Buffer.from(withAccounts.sessionSecret, "hex")).update(payload).digest("base64url")}`;
      })();
      expect((await api(recovered.base, "GET", "/api/settings", undefined, oldCookie)).status).toBe(401);
    } finally {
      await recovered.stop();
    }
  }, 90_000);
});
