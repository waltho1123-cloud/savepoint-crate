import { createHmac } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth.js";
import { SAMPLE_IMAGE } from "./helpers.js";
import { lineStubPreload, loginOverHttp, readStubLog, startServer } from "./process-helpers.js";
import { cleanupTempDirs, makeTempDir } from "./settings-helpers.js";

afterEach(cleanupTempDirs);

// 全站登入，真的啟動 src/server.ts 走完整流程：
//   v2（管理員帳號，沒有角色）的舊檔啟動 → 管理員登入 → 建一位一般使用者 → 一般使用者登入 → 用 /api/ocr（OpenAI 是替身）→
//   進 /settings 被 403 → 關箱通知帶操作者姓名 → 重新啟動後一切還在、檔案已是版本 3。
// 子行程裡的 fetch 被換成只允許打 api.line.me 與 api.openai.com 的替身（tests/fixtures/line-stub-preload.mjs），不會真的打外網。

const TOKEN = "login-e2e-line-token-0123456789";
const SECRET = "login-e2e-line-secret-abcdef";
const GROUP = "C0123456789abcdef0123456789abcdef";
const OPENAI_KEY = "login-e2e-openai-key-xyz";
const ADMIN_PASSWORD = "e2e-admin-password-1234";
const STAFF_PASSWORD = "e2e-staff-password-5678";
const STAFF_NEW_PASSWORD = "e2e-staff-NEW-password-9012";
const JSON_HEADERS = { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };

async function api(base: string, method: string, path: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...JSON_HEADERS, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as any };
}

describe("全站登入：真實行程的完整流程", () => {
  it("v2 舊檔啟動 → 管理員登入 → 建一位一般使用者 → 一般使用者登入並用 OCR → 進設定頁被 403 → 關箱通知帶操作者 → 重新啟動後一切還在", async () => {
    const dataDir = await makeTempDir();
    const stubLog = join(await makeTempDir(), "stub.log");
    const env = { OPENAI_API_KEY: OPENAI_KEY, GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "x", DATA_DIR: dataDir, LINE_STUB_LOG: stubLog };
    const file = join(dataDir, "settings.json");
    const adminHash = await hashPassword(ADMIN_PASSWORD);
    const sessionSecret = "9a".repeat(32);
    const v2 = {
      version: 2,
      admins: [
        {
          id: "1".repeat(32),
          name: "王老闆",
          email: "boss@example.test",
          passwordHash: adminHash,
          status: "active",
          sessionVersion: 3,
          createdAt: "2026-09-20T00:00:00.000Z",
          updatedAt: "2026-09-20T00:00:00.000Z",
          lastLoginAt: null,
          futureAdminField: "keep-me",
        },
      ],
      sessionSecret,
      line: { enabled: true, channelAccessToken: TOKEN, channelSecret: SECRET, groupId: GROUP, groupName: "倉庫出貨群", updatedAt: "2026-09-21T00:00:00.000Z" },
      lineCaptured: [{ groupId: GROUP, groupName: "倉庫出貨群", eventType: "join", lastSeenAt: "2026-09-22T00:00:00.000Z" }],
      futureTopLevel: { keep: ["me"] },
    };
    const v2Text = `${JSON.stringify(v2, null, 2)}\n`;
    await writeFile(file, v2Text, { mode: 0o600 });

    let bossCookie = "";
    let staffCookie = "";
    let staffId = "";
    const first = await startServer(env, { preload: lineStubPreload });
    try {
      // ---------------------------------------------------------------- 啟動：v2 檔案不動；沒有設定碼；全部視為管理員
      expect(await readFile(file, "utf8")).toBe(v2Text);
      expect(first.output()).not.toContain("設定碼");
      const health0 = (await (await fetch(`${first.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health0).toMatchObject({ adminConfigured: true, adminCount: 1, accountCount: 1, legacyAdminPending: false, openaiConfigured: true, lineConfigured: true, lineSource: "settings" });

      // ---------------------------------------------------------------- 沒登入：主頁導向登入頁、API 要登入、webhook 與 healthz 公開
      const home = await api(first.base, "GET", "/");
      expect(home.status).toBe(302);
      expect(home.headers.get("location")).toBe("/login?next=/");
      expect((await api(first.base, "POST", "/api/ocr", { image: SAMPLE_IMAGE })).status).toBe(401);
      expect((await api(first.base, "POST", "/api/save", {})).status).toBe(401);
      expect((await api(first.base, "POST", "/api/box-closed", { boxId: "B", items: [], total: 0, successCount: 0, failedCount: 0 })).status).toBe(401);
      expect((await api(first.base, "GET", "/api/me")).status).toBe(401);
      const loginPage = await fetch(`${first.base}/login?next=/settings`);
      expect(loginPage.status).toBe(200);
      expect(await loginPage.text()).toContain('<form id="login-form" data-next="/settings">');
      const webhookBody = JSON.stringify({ events: [] });
      const sig = createHmac("sha256", SECRET).update(webhookBody).digest("base64");
      expect((await fetch(`${first.base}/api/line/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": sig }, body: webhookBody })).status).toBe(200);
      expect(readStubLog(stubLog).filter((c) => c.url.includes("openai"))).toHaveLength(0); // 沒登入的 OCR 請求沒有往上游走

      // ---------------------------------------------------------------- 管理員登入（用 v2 時代的 Email 與密碼）
      const badLogin = await api(first.base, "POST", "/login", { email: "boss@example.test", password: "wrong-password-xx" });
      expect(badLogin.status).toBe(401);
      expect(badLogin.json).toEqual({ success: false, error: "帳號或密碼不正確" });
      const login = await api(first.base, "POST", "/login", { email: " BOSS@Example.test ", password: ADMIN_PASSWORD, next: "/settings" });
      expect(login.status).toBe(200);
      expect(login.json).toEqual({ success: true, next: "/settings" });
      bossCookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
      // 第一次寫入（lastLoginAt）把檔案升成版本 3：admins → accounts、角色 admin、其他欄位原樣
      const afterLogin = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
      expect(afterLogin.version).toBe(3);
      expect("admins" in afterLogin).toBe(false);
      expect(afterLogin.accounts).toHaveLength(1);
      expect(afterLogin.accounts[0]).toMatchObject({ id: "1".repeat(32), role: "admin", passwordHash: adminHash, sessionVersion: 3, futureAdminField: "keep-me" });
      expect(afterLogin.sessionSecret).toBe(sessionSecret);
      expect(afterLogin.line).toEqual(v2.line);
      expect(afterLogin.lineCaptured).toEqual(v2.lineCaptured);
      expect(afterLogin.futureTopLevel).toEqual(v2.futureTopLevel);
      expect((await stat(file)).mode & 0o777).toBe(0o600);

      expect((await fetch(`${first.base}/`, { headers: { cookie: bossCookie } })).status).toBe(200);
      expect((await api(first.base, "GET", "/api/me", undefined, bossCookie)).json.data).toEqual({ id: "1".repeat(32), name: "王老闆", email: "boss@example.test", role: "admin" });
      expect((await fetch(`${first.base}/settings`, { headers: { cookie: bossCookie } })).status).toBe(200);

      // ---------------------------------------------------------------- 管理員建一位一般使用者（預設角色 user）
      const created = await api(first.base, "POST", "/api/accounts", { name: "李倉管", email: "Staff@Example.test", password: STAFF_PASSWORD }, bossCookie);
      expect(created.status).toBe(200);
      expect(created.json.data.account).toMatchObject({ name: "李倉管", email: "staff@example.test", role: "user", status: "active" });
      staffId = created.json.data.account.id as string;
      expect((await api(first.base, "POST", "/api/accounts", { name: "重複", email: "STAFF@example.test", password: STAFF_PASSWORD }, bossCookie)).status).toBe(409);
      expect((await api(first.base, "POST", "/api/accounts", { name: "壞角色", email: "x@example.test", password: STAFF_PASSWORD, role: "root" }, bossCookie)).status).toBe(400);

      // ---------------------------------------------------------------- 一般使用者登入：能用裝箱程式，不能進設定
      staffCookie = await loginOverHttp(first.base, "staff@example.test", STAFF_PASSWORD);
      expect((await fetch(`${first.base}/`, { headers: { cookie: staffCookie } })).status).toBe(200);
      expect((await api(first.base, "GET", "/api/me", undefined, staffCookie)).json.data).toMatchObject({ name: "李倉管", role: "user" });

      // OCR（OpenAI 是替身）：登入＋CSRF 標頭才行
      const noHeader = await fetch(`${first.base}/api/ocr`, { method: "POST", headers: { "content-type": "application/json", cookie: staffCookie }, body: JSON.stringify({ image: SAMPLE_IMAGE }) });
      expect(noHeader.status).toBe(403);
      const ocr = await api(first.base, "POST", "/api/ocr", { image: SAMPLE_IMAGE }, staffCookie);
      expect(ocr.status).toBe(200);
      expect(ocr.json).toEqual({ success: true, data: { barcode: "1801080204", productName: "第五代溫灸刷毛圓領發熱衣", gender: "女", color: "經典黑", size: "L" } });
      const openaiCalls = readStubLog(stubLog).filter((c) => c.url.includes("openai"));
      expect(openaiCalls).toHaveLength(1);
      expect(openaiCalls[0]).toMatchObject({ method: "POST", authorization: `Bearer ${OPENAI_KEY}` });

      // 設定頁與設定 API、帳號 API：一般使用者 403
      const settingsPage = await fetch(`${first.base}/settings`, { headers: { cookie: staffCookie }, redirect: "manual" });
      expect(settingsPage.status).toBe(403);
      const forbiddenHtml = await settingsPage.text();
      expect(forbiddenHtml).toContain("需要管理員權限");
      for (const secret of [TOKEN, SECRET, "scrypt$", "boss@example.test"]) expect(forbiddenHtml).not.toContain(secret);
      for (const [method, path, body] of [["GET", "/api/settings"], ["PUT", "/api/settings/line", { enabled: false }], ["POST", "/api/settings/line/test", {}], ["GET", "/api/accounts"], ["POST", "/api/accounts", { name: "x", email: "x@example.test", password: STAFF_PASSWORD }], ["DELETE", `/api/accounts/${"1".repeat(32)}`]] as const) {
        const res = await api(first.base, method, path, body, staffCookie);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.json).toEqual({ success: false, error: "需要管理員權限" });
      }
      expect((await fetch(`${first.base}/account`, { headers: { cookie: staffCookie } })).status).toBe(200);

      // ---------------------------------------------------------------- 關箱通知帶操作者姓名（來自 session，不是前端送的）
      const notify = await api(first.base, "POST", "/api/box-closed", { boxId: "BOX-001", operator: "假冒的人", items: [{ barcode: "1", productName: "商品", qty: 2 }], total: 1, successCount: 1, failedCount: 0 }, staffCookie);
      expect(notify.json).toEqual({ success: true, notified: true });
      const pushes = readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"));
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ authorization: `Bearer ${TOKEN}` });
      expect(pushes[0]!.body.to).toBe(GROUP);
      const text = pushes[0]!.body.messages[0].text as string;
      expect(text.split("\n").slice(0, 3)).toEqual(["📦 箱號 BOX-001 已完成", "共 1 種商品、2 件", "操作：李倉管"]);
      expect(text).not.toContain("假冒的人");
      // 管理員操作時換成管理員的姓名
      await api(first.base, "POST", "/api/box-closed", { boxId: "BOX-002", items: [], total: 0, successCount: 0, failedCount: 0 }, bossCookie);
      expect(readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"))[1]!.body.messages[0].text).toContain("操作：王老闆");

      // ---------------------------------------------------------------- 一般使用者改自己的密碼：舊 cookie 失效、新 cookie 可用、舊密碼不能登入
      const change = await api(first.base, "POST", "/account/password", { currentPassword: STAFF_PASSWORD, newPassword: STAFF_NEW_PASSWORD }, staffCookie);
      expect(change.status).toBe(200);
      const newStaffCookie = change.headers.getSetCookie()[0]!.split(";")[0]!;
      expect((await api(first.base, "GET", "/api/me", undefined, staffCookie)).status).toBe(401);
      expect((await api(first.base, "GET", "/api/me", undefined, newStaffCookie)).status).toBe(200);
      expect((await api(first.base, "POST", "/login", { email: "staff@example.test", password: STAFF_PASSWORD })).status).toBe(401);
      staffCookie = newStaffCookie;

      // ---------------------------------------------------------------- 管理員停用一般使用者：立刻不能用；刪不掉自己
      expect((await api(first.base, "POST", `/api/accounts/${staffId}/status`, { status: "disabled" }, bossCookie)).status).toBe(200);
      expect((await api(first.base, "POST", "/api/ocr", { image: SAMPLE_IMAGE }, staffCookie)).status).toBe(401);
      expect((await fetch(`${first.base}/`, { headers: { cookie: staffCookie }, redirect: "manual" })).status).toBe(302);
      expect((await api(first.base, "POST", `/api/accounts/${staffId}/status`, { status: "active" }, bossCookie)).status).toBe(200);
      expect((await api(first.base, "GET", "/api/me", undefined, staffCookie)).status).toBe(401); // 停用再啟用，舊的登入不會復活
      staffCookie = await loginOverHttp(first.base, "staff@example.test", STAFF_NEW_PASSWORD); // 重新登入
      expect((await api(first.base, "DELETE", `/api/accounts/${"1".repeat(32)}`, undefined, bossCookie)).status).toBe(409);
      expect((await api(first.base, "PATCH", `/api/accounts/${"1".repeat(32)}`, { role: "user" }, bossCookie)).status).toBe(409);

      // ---------------------------------------------------------------- 輸出沒有密碼、token、金鑰；審計 log 有各項操作與角色
      for (const secret of [ADMIN_PASSWORD, STAFF_PASSWORD, STAFF_NEW_PASSWORD, "wrong-password-xx", TOKEN, SECRET, OPENAI_KEY]) expect(first.output()).not.toContain(secret);
      for (const expected of [
        /\[accounts\] boss@example\.test 登入成功（來源 127\.0\.0\.1）/,
        /\[accounts\] boss@example\.test 新增帳號 staff@example\.test（角色 user）（來源 127\.0\.0\.1）/,
        /\[accounts\] staff@example\.test 登入成功（來源 127\.0\.0\.1）/,
        /\[accounts\] staff@example\.test 變更自己的密碼 staff@example\.test（來源 127\.0\.0\.1）/,
        /\[accounts\] boss@example\.test 停用帳號 staff@example\.test（來源 127\.0\.0\.1）/,
        /\[accounts\] boss@example\.test 啟用帳號 staff@example\.test（來源 127\.0\.0\.1）/,
        /\[accounts\] boss@example\.test 登入失敗（來源 127\.0\.0\.1）/,
      ]) {
        expect(first.output()).toMatch(expected);
      }
    } finally {
      await first.stop();
    }

    // ---------------------------------------------------------------- 重新啟動：版本 3、帳號與角色都在；現有的 cookie 仍有效；LINE 設定沒變
    const second = await startServer(env, { preload: lineStubPreload });
    try {
      expect(second.output()).not.toContain("設定碼");
      const health = (await (await fetch(`${second.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ adminConfigured: true, adminCount: 1, accountCount: 2, legacyAdminPending: false, lineConfigured: true, lineSource: "settings" });
      expect((await api(second.base, "GET", "/api/me", undefined, bossCookie)).json.data.role).toBe("admin");
      expect((await api(second.base, "GET", "/api/me", undefined, staffCookie)).json.data.role).toBe("user");
      expect((await api(second.base, "POST", "/login", { email: "staff@example.test", password: STAFF_NEW_PASSWORD })).status).toBe(200);
      const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
      expect(saved.version).toBe(3);
      expect(saved.accounts.map((a: Record<string, unknown>) => [a.email, a.role])).toEqual([["boss@example.test", "admin"], ["staff@example.test", "user"]]);
      expect(saved.sessionSecret).toBe(sessionSecret);
      expect(saved.line).toEqual(v2.line);
      expect(saved.lineCaptured).toEqual(v2.lineCaptured);
      expect(saved.futureTopLevel).toEqual(v2.futureTopLevel);
    } finally {
      await second.stop();
    }
  }, 120_000);
});
