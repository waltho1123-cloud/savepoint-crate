import { createHmac } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { lineStubPreload, readStubLog, startServer } from "./process-helpers.js";
import { cleanupTempDirs, makeTempDir } from "./settings-helpers.js";

afterEach(cleanupTempDirs);

// 真的啟動 src/server.ts，走完設定頁的完整流程：建立密碼 → 登入 → 存 LINE 設定 → 關箱通知 → webhook → 重新啟動後仍然有效。
// 子行程裡的 fetch 被換成只允許打 api.line.me 的替身（tests/fixtures/line-stub-preload.mjs），不會真的打 LINE。

const PASSWORD = "real-process-password-42";
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

describe("設定頁在真實行程裡的完整流程", () => {
  it("建立密碼 → 登入 → 存 LINE 設定 → 關箱通知／webhook／測試訊息 → 重新啟動後設定與登入都還在", async () => {
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
      expect(health0).toMatchObject({ dataDirWritable: true, adminConfigured: false, lineConfigured: false, lineWebhookConfigured: false, lineSource: null });

      // 設定檔在第一次啟動時就建好了：權限 0600
      const file = join(dataDir, "settings.json");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await readdir(dataDir)).sort()).toEqual(["settings.json"]);

      const page = await fetch(`${first.base}/settings`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('id="setup-form"');

      // 設定碼錯誤 403；密碼太短 400；沒登入讀設定 401
      expect((await api(first.base, "POST", "/settings/setup", { setupCode: "ZZZZ-ZZZZ", password: PASSWORD })).status).toBe(403);
      expect((await api(first.base, "POST", "/settings/setup", { setupCode, password: "short" })).status).toBe(400);
      expect((await api(first.base, "GET", "/api/settings")).status).toBe(401);

      // 建立密碼：200、cookie
      const setup = await api(first.base, "POST", "/settings/setup", { setupCode, password: PASSWORD });
      expect(setup.status).toBe(200);
      const setCookie = setup.headers.getSetCookie()[0]!;
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      cookie = setCookie.split(";")[0]!;

      const saved = await readFile(file, "utf8");
      expect(saved).toContain("scrypt$16384$8$1$");
      expect(saved).not.toContain(PASSWORD);
      expect((await stat(file)).mode & 0o777).toBe(0o600);

      // 存 LINE 設定（子行程裡的 LINE 是替身；查群組名稱會打到替身）
      const put = await api(first.base, "PUT", "/api/settings/line", { enabled: true, channelAccessToken: TOKEN, channelSecret: SECRET, groupId: GROUP }, cookie);
      expect(put.status).toBe(200);
      expect(put.json.data.line).toMatchObject({ groupId: GROUP, groupName: "真實行程測試群組" });
      expect(JSON.stringify(put.json)).not.toContain(TOKEN);
      expect(JSON.stringify(put.json)).not.toContain(SECRET);

      const health1 = (await (await fetch(`${first.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health1).toMatchObject({ adminConfigured: true, lineConfigured: true, lineWebhookConfigured: true, lineSource: "settings" });

      // 關箱通知：推播到「設定檔裡的」群組，帶「設定檔裡的」token
      const notify = await api(first.base, "POST", "/api/box-closed", { boxId: "BOX-001", items: [{ barcode: "1", productName: "商品", qty: 2 }], total: 1, successCount: 1, failedCount: 0 });
      expect(notify.json).toEqual({ success: true, notified: true });
      const push = readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"));
      expect(push).toHaveLength(1);
      expect(push[0]).toMatchObject({ method: "POST", authorization: `Bearer ${TOKEN}` });
      expect(push[0]!.body.to).toBe(GROUP);

      // 測試訊息
      const test = await api(first.base, "POST", "/api/settings/line/test", {}, cookie);
      expect(test.json).toEqual({ success: true, notified: true });
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

      // 頁面（已登入）有設定表單與剛記錄的群組，且沒有完整的 token／secret
      const settingsPage = await (await fetch(`${first.base}/settings`, { headers: { cookie } })).text();
      expect(settingsPage).toContain('id="line-form"');
      expect(settingsPage).toContain(`data-use-group="${newGroup}"`);
      expect(settingsPage).not.toContain(TOKEN);
      expect(settingsPage).not.toContain(SECRET);

      // 整個過程的輸出（stdout＋stderr）不含 token、secret、密碼
      for (const secret of [TOKEN, SECRET, PASSWORD]) expect(first.output()).not.toContain(secret);
    } finally {
      await first.stop();
    }

    // ------------------------------------------------------------ 重新啟動（同一個資料目錄）
    const second = await startServer(env, { preload: lineStubPreload });
    try {
      // 已經有密碼：不再提示設定碼
      expect(second.output()).not.toContain("尚未設定管理密碼");
      // 重新啟動前拿到的 cookie 仍然有效（sessionSecret 存在設定檔裡）
      expect((await api(second.base, "GET", "/api/settings", undefined, cookie)).status).toBe(200);
      const health = (await (await fetch(`${second.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ adminConfigured: true, lineConfigured: true, lineWebhookConfigured: true, lineSource: "settings" });
      // 密碼登入也成立
      const login = await api(second.base, "POST", "/settings/login", { password: PASSWORD });
      expect(login.status).toBe(200);
      expect((await api(second.base, "POST", "/settings/login", { password: "wrong-password-xx" })).status).toBe(401);
      // 關箱通知仍然用設定檔裡的設定
      const before = readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push")).length;
      const notify = await api(second.base, "POST", "/api/box-closed", { boxId: "BOX-002", items: [], total: 0, successCount: 0, failedCount: 0 });
      expect(notify.json).toEqual({ success: true, notified: true });
      expect(readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"))).toHaveLength(before + 1);
      expect(second.output()).toContain(`[settings] 資料目錄：${dataDir}`);
    } finally {
      await second.stop();
    }
  }, 90_000);

  it("資料目錄不可用（上層是一般檔案）：服務照常啟動；/healthz 回 false；設定頁與設定 API 回 503；環境變數版的 LINE 通知照常運作", async () => {
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
      expect(health).toMatchObject({ dataDirWritable: false, adminConfigured: false, lineConfigured: true, lineSource: "env" });

      const page = await fetch(`${server.base}/settings`);
      expect(page.status).toBe(503);
      expect(await page.text()).toContain("請在 Zeabur 掛載 Volume 到 /app/data");
      expect((await api(server.base, "GET", "/api/settings")).status).toBe(503);
      expect((await api(server.base, "POST", "/settings/setup", { setupCode: "ABCD-EFGH", password: PASSWORD })).status).toBe(503);
      expect(server.output()).not.toContain("尚未設定管理密碼");

      const notify = await api(server.base, "POST", "/api/box-closed", { boxId: "B1", items: [], total: 0, successCount: 0, failedCount: 0 });
      expect(notify.json).toEqual({ success: true, notified: true });
      expect(readStubLog(stubLog).filter((c) => c.url.endsWith("/message/push"))).toHaveLength(1);
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
      expect(JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8")).version).toBe(1);
      const health = (await (await fetch(`${server.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ dataDirWritable: true, adminConfigured: false });
      expect(server.output()).toContain("尚未設定管理密碼"); // 空設定重新開始，要重新建立密碼
    } finally {
      await server.stop();
    }
  }, 60_000);
});
