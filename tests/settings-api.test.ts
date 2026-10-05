import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OCR_RATE_LIMIT_MAX, SETTINGS_API_RATE_LIMIT_MAX } from "../src/app.js";
import { TEST_PUSH_RATE_LIMIT_MAX } from "../src/settings-routes.js";
import { SETTINGS_FILE_NAME } from "../src/settings-store.js";
import { TEST_GROUP_ID, TEST_LINE_SECRET, TEST_LINE_TOKEN } from "./helpers.js";
import { adminId, call, cleanupTempDirs, lineHandler, makeAccount, makeSettingsApp, NOW_MS, type SettingsApp } from "./settings-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

const OTHER_GROUP_ID = "Cfedcba9876543210fedcba9876543210";
const SUMMARY_URL = (id: string) => `https://api.line.me/v2/bot/group/${id}/summary`;
const PUSH_URL = "https://api.line.me/v2/bot/message/push";

async function readFileSettings(ctx: SettingsApp) {
  return JSON.parse(await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8")) as { line: Record<string, unknown>; lineCaptured: unknown[] };
}

/** 直接把 LINE 設定寫進設定檔（不經過 API），做為測試的起點。 */
async function seedLine(ctx: SettingsApp, line: Partial<{ enabled: boolean; token: string; secret: string; groupId: string; groupName: string }> = {}) {
  await ctx.store.update((draft) => {
    draft.line = {
      enabled: line.enabled ?? true,
      channelAccessToken: line.token ?? TEST_LINE_TOKEN,
      channelSecret: line.secret ?? TEST_LINE_SECRET,
      groupId: line.groupId ?? TEST_GROUP_ID,
      groupName: line.groupName ?? "既有群組",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
  });
}

describe("GET /api/settings", () => {
  it("沒登入 → 401，不呼叫任何外部服務", async () => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, "GET", "/api/settings");
    expect(res.status).toBe(401);
    expect(ctx.calls).toHaveLength(0);
  });

  it("全新狀態：資料目錄可寫、已有管理員、LINE 全空、來源是 null；多了 me（登入者）", async () => {
    const ctx = await makeSettingsApp();
    const res = await ctx.authed("GET", "/api/settings");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { data } = (await res.json()) as { data: Record<string, any> };
    expect(data).toMatchObject({
      dataDirWritable: true,
      adminConfigured: true,
      adminCount: 1,
      legacyAdminPending: false,
      me: { id: "0123456789abcdef0123456789abcdef", name: "測試管理員", email: "admin@example.test" },
      line: {
        enabled: true,
        channelAccessToken: { configured: false, last4: null },
        channelSecret: { configured: false, last4: null },
        groupId: "",
        groupName: "",
        updatedAt: "",
      },
      effective: { source: null, lineConfigured: false, lineWebhookConfigured: false },
      env: { tokenConfigured: false, groupIdConfigured: false, secretConfigured: false },
      captured: [],
    });
    expect([true, false, null]).toContain(data.dataDirMounted);
  });

  it("token／secret 只回「已設定」與末 4 碼，完整內容絕不出現在回應裡（連較長的片段也沒有）", async () => {
    const ctx = await makeSettingsApp();
    await seedLine(ctx);
    const res = await ctx.authed("GET", "/api/settings");
    const text = await res.text();
    const { data } = JSON.parse(text) as { data: any };
    expect(data.line.channelAccessToken).toEqual({ configured: true, last4: TEST_LINE_TOKEN.slice(-4) });
    expect(data.line.channelSecret).toEqual({ configured: true, last4: TEST_LINE_SECRET.slice(-4) });
    expect(data.line.groupId).toBe(TEST_GROUP_ID);
    expect(data.line.groupName).toBe("既有群組");
    expect(data.effective).toEqual({ source: "settings", lineConfigured: true, lineWebhookConfigured: true });
    expect(text).not.toContain(TEST_LINE_TOKEN);
    expect(text).not.toContain(TEST_LINE_SECRET);
    expect(text).not.toContain(TEST_LINE_TOKEN.slice(0, 8));
    expect(text).not.toContain(TEST_LINE_SECRET.slice(0, 8));
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("sessionSecret");
    expect(text).not.toContain("scrypt$");
  });

  it("很短的 token／secret 不顯示尾碼（免得洩漏過半）", async () => {
    const ctx = await makeSettingsApp();
    await seedLine(ctx, { token: "short-tok", secret: "short-sec" });
    const { data } = (await (await ctx.authed("GET", "/api/settings")).json()) as { data: any };
    expect(data.line.channelAccessToken).toEqual({ configured: true, last4: null });
    expect(data.line.channelSecret).toEqual({ configured: true, last4: null });
  });

  it("環境變數備援只回有沒有值，不回內容", async () => {
    const ctx = await makeSettingsApp({
      env: { LINE_CHANNEL_ACCESS_TOKEN: "env-line-token-aaaaaaaa", LINE_GROUP_ID: OTHER_GROUP_ID, LINE_CHANNEL_SECRET: "env-line-secret-bbbbbbbb" },
    });
    const res = await ctx.authed("GET", "/api/settings");
    const text = await res.text();
    const { data } = JSON.parse(text) as { data: any };
    expect(data.env).toEqual({ tokenConfigured: true, groupIdConfigured: true, secretConfigured: true });
    expect(data.effective).toEqual({ source: "env", lineConfigured: true, lineWebhookConfigured: true });
    expect(text).not.toContain("env-line-token");
    expect(text).not.toContain("env-line-secret");
    expect(text).not.toContain(OTHER_GROUP_ID);
  });
});

describe("PUT /api/settings/line", () => {
  it("處理期間操作者被停用 → 401，LINE 設定不變、沒有「更新了 LINE 設定」的 log（鎖內重新確認操作者）", async () => {
    const SECOND = adminId(2);
    const ctx = await makeSettingsApp({ extraAdmins: [makeAccount({ id: SECOND, name: "第二位", email: "second@example.test" })] });
    await seedLine(ctx);
    const realUpdate = ctx.store.update.bind(ctx.store);
    vi.spyOn(ctx.store, "update").mockImplementationOnce(async (mutator) => {
      await realUpdate((draft) => {
        draft.admins[1]!.status = "disabled"; // 操作者在讀完請求內容之後、寫檔之前被停用
      });
      return realUpdate(mutator);
    });
    const res = await ctx.authedAs(SECOND, "PUT", "/api/settings/line", { enabled: false, groupId: OTHER_GROUP_ID });
    expect(res.status).toBe(401);
    expect(ctx.store.data.line).toMatchObject({ enabled: true, groupId: TEST_GROUP_ID, channelAccessToken: TEST_LINE_TOKEN });
    expect(ctx.log.lines.some((line) => line.includes("更新了 LINE 設定"))).toBe(false);
  });

  it("沒登入 → 401，設定不變，不呼叫 LINE", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    const res = await call(ctx.app, "PUT", "/api/settings/line", { channelAccessToken: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID });
    expect(res.status).toBe(401);
    expect(ctx.store.data.line.channelAccessToken).toBe("");
    expect(ctx.calls).toHaveLength(0);
  });

  it("一次存下開關、token、secret、群組 ID：寫進設定檔、回遮罩後的設定、用新 token 查群組名稱並存下", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "倉庫出貨群" }) });
    const res = await ctx.authed("PUT", "/api/settings/line", {
      enabled: true,
      channelAccessToken: TEST_LINE_TOKEN,
      channelSecret: TEST_LINE_SECRET,
      groupId: TEST_GROUP_ID,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const { success, data } = JSON.parse(text) as { success: boolean; data: any };
    expect(success).toBe(true);
    expect(data.line).toEqual({
      enabled: true,
      channelAccessToken: { configured: true, last4: TEST_LINE_TOKEN.slice(-4) },
      channelSecret: { configured: true, last4: TEST_LINE_SECRET.slice(-4) },
      groupId: TEST_GROUP_ID,
      groupName: "倉庫出貨群",
      updatedAt: new Date(NOW_MS).toISOString(),
    });
    expect(data.effective).toEqual({ source: "settings", lineConfigured: true, lineWebhookConfigured: true });
    expect(text).not.toContain(TEST_LINE_TOKEN);
    expect(text).not.toContain(TEST_LINE_SECRET);

    const file = await readFileSettings(ctx);
    expect(file.line).toEqual({
      enabled: true,
      channelAccessToken: TEST_LINE_TOKEN,
      channelSecret: TEST_LINE_SECRET,
      groupId: TEST_GROUP_ID,
      groupName: "倉庫出貨群",
      updatedAt: new Date(NOW_MS).toISOString(),
    });

    // 只有一次對 LINE 的呼叫：查群組名稱，帶的是「新的」token
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]).toMatchObject({ method: "GET", url: SUMMARY_URL(TEST_GROUP_ID) });
    expect(ctx.calls[0]!.headers.authorization).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    expect(ctx.log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);
    expect(ctx.log.lines.join("\n")).not.toContain(TEST_LINE_SECRET);
    // 開關原本就是開的（預設值），這次也送 true＝沒有變更，所以不列「開關」
    expect(ctx.log.lines).toContain("[settings] admin@example.test 更新了 LINE 設定（token、secret、群組 ID）");
  });

  it("沒有 token 時不查群組名稱（不呼叫 LINE），名稱留空", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    const res = await ctx.authed("PUT", "/api/settings/line", { groupId: TEST_GROUP_ID });
    expect(res.status).toBe(200);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.store.data.line.groupId).toBe(TEST_GROUP_ID);
    expect(ctx.store.data.line.groupName).toBe("");
  });

  it("token 與 secret 留空（沒給、空字串、全空白）＝不變", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    for (const body of [
      { enabled: true },
      { channelAccessToken: "", channelSecret: "" },
      { channelAccessToken: "   ", channelSecret: "\n\t" },
      { channelAccessToken: null, channelSecret: null },
    ]) {
      const res = await ctx.authed("PUT", "/api/settings/line", body);
      expect(res.status).toBe(200);
      expect(ctx.store.data.line.channelAccessToken).toBe(TEST_LINE_TOKEN);
      expect(ctx.store.data.line.channelSecret).toBe(TEST_LINE_SECRET);
      expect(ctx.store.data.line.groupId).toBe(TEST_GROUP_ID); // 沒給 groupId 也維持
    }
  });

  it("只換 token：secret 與群組 ID 維持；前後空白會被去掉", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    const res = await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: "  new-token-abcdefghijk\n" });
    expect(res.status).toBe(200);
    expect(ctx.store.data.line).toMatchObject({ channelAccessToken: "new-token-abcdefghijk", channelSecret: TEST_LINE_SECRET, groupId: TEST_GROUP_ID });
    expect(ctx.calls[0]!.headers.authorization).toBe("Bearer new-token-abcdefghijk"); // 名稱查詢用新 token
  });

  it("clearChannelAccessToken／clearChannelSecret：明確清除；清掉 token 之後這份設定不再生效，退回環境變數", async () => {
    const ctx = await makeSettingsApp({
      handler: lineHandler(),
      env: { LINE_CHANNEL_ACCESS_TOKEN: "env-token-zzzzzzzzzzzz", LINE_GROUP_ID: OTHER_GROUP_ID },
    });
    await seedLine(ctx);
    const res = await ctx.authed("PUT", "/api/settings/line", { clearChannelAccessToken: true, clearChannelSecret: true });
    expect(res.status).toBe(200);
    expect(ctx.store.data.line.channelAccessToken).toBe("");
    expect(ctx.store.data.line.channelSecret).toBe("");
    expect(ctx.store.data.line.groupId).toBe(TEST_GROUP_ID); // 群組 ID 沒動
    const { data } = (await res.json()) as { data: any };
    expect(data.effective.source).toBe("env");
    expect(ctx.log.lines).toContain("[settings] admin@example.test 更新了 LINE 設定（token、secret）");
  });

  it("同時填新值又要求清除 → 400，設定不變", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    const a = await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: "new-token-abcdefghijk", clearChannelAccessToken: true });
    expect(a.status).toBe(400);
    const b = await ctx.authed("PUT", "/api/settings/line", { channelSecret: "new-secret-abcdefgh", clearChannelSecret: true });
    expect(b.status).toBe(400);
    expect(ctx.store.data.line.channelAccessToken).toBe(TEST_LINE_TOKEN);
    expect(ctx.store.data.line.channelSecret).toBe(TEST_LINE_SECRET);
  });

  it("關閉開關：只改開關，token 等不變", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    const res = await ctx.authed("PUT", "/api/settings/line", { enabled: false });
    expect(res.status).toBe(200);
    expect(ctx.store.data.line).toMatchObject({ enabled: false, channelAccessToken: TEST_LINE_TOKEN });
    const { data } = (await res.json()) as { data: any };
    expect(data.effective).toMatchObject({ source: "settings", lineConfigured: false, lineWebhookConfigured: true });
    expect(ctx.log.lines).toContain("[settings] admin@example.test 更新了 LINE 設定（開關）");
  });

  it("群組 ID 留空字串＝清除（連群組名稱一起清掉）；換群組會重新查名稱", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "新群組" }) });
    await seedLine(ctx);
    const switched = await ctx.authed("PUT", "/api/settings/line", { groupId: OTHER_GROUP_ID });
    expect(switched.status).toBe(200);
    expect(ctx.store.data.line).toMatchObject({ groupId: OTHER_GROUP_ID, groupName: "新群組" });
    expect(ctx.calls.at(-1)!.url).toBe(SUMMARY_URL(OTHER_GROUP_ID));

    ctx.calls.length = 0;
    const cleared = await ctx.authed("PUT", "/api/settings/line", { groupId: "  " });
    expect(cleared.status).toBe(200);
    expect(ctx.store.data.line).toMatchObject({ groupId: "", groupName: "" });
    expect(ctx.calls).toHaveLength(0); // 沒有群組就不必查
  });

  it("查不到群組名稱（機器人不在群組裡、LINE 回 404）：名稱留空，其他照存", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ summaryStatus: 404 }) });
    const res = await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID });
    expect(res.status).toBe(200);
    expect(ctx.store.data.line).toMatchObject({ groupId: TEST_GROUP_ID, groupName: "", channelAccessToken: TEST_LINE_TOKEN });
  });

  it("查不到名稱、但 webhook 記錄過這個群組：沿用記錄裡的名稱", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ summaryStatus: 404 }) });
    await ctx.store.update((draft) => {
      draft.lineCaptured = [{ groupId: TEST_GROUP_ID, groupName: "Webhook 記錄的名稱", eventType: "join", lastSeenAt: "2026-10-04T00:00:00.000Z" }];
    });
    const res = await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID });
    expect(res.status).toBe(200);
    expect(ctx.store.data.line.groupName).toBe("Webhook 記錄的名稱");
  });

  it("LINE 連線失敗（丟例外）：名稱留空，設定仍然存下，不丟 500", async () => {
    const ctx = await makeSettingsApp({
      handler: () => {
        throw new TypeError("fetch failed");
      },
    });
    const res = await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID });
    expect(res.status).toBe(200);
    expect(ctx.store.data.line).toMatchObject({ channelAccessToken: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID, groupName: "" });
    expect(ctx.log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);
  });

  it("群組名稱裡的控制字元與換行被清掉、最多 100 字", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: `甲\n乙\u0000丙${"長".repeat(150)}` }) });
    await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID });
    const name = ctx.store.data.line.groupName;
    expect(name.startsWith("甲 乙 丙")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(100);
  });

  describe("群組名稱：只在需要時才查，查不到不會把已經有的名稱清掉", () => {
    it("LINE 暫時失敗時只切換開關：已存的群組名稱不會被清掉，也不會呼叫 LINE", async () => {
      const ctx = await makeSettingsApp({
        handler: () => {
          throw new TypeError("fetch failed");
        },
      });
      await seedLine(ctx, { groupName: "倉庫群組" });
      const res = await ctx.authed("PUT", "/api/settings/line", { enabled: false });
      expect(res.status).toBe(200);
      expect(ctx.store.data.line).toMatchObject({ enabled: false, groupName: "倉庫群組", groupId: TEST_GROUP_ID });
      expect(ctx.calls).toHaveLength(0);
    });

    it("存檔內容跟現在一模一樣（設定頁每次都會送出目前的群組 ID）：不呼叫 LINE、名稱不變", async () => {
      const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "不該出現的名稱" }) });
      await seedLine(ctx, { groupName: "倉庫群組" });
      const res = await ctx.authed("PUT", "/api/settings/line", { enabled: true, groupId: TEST_GROUP_ID });
      expect(res.status).toBe(200);
      expect(ctx.calls).toHaveLength(0);
      expect(ctx.store.data.line.groupName).toBe("倉庫群組");
    });

    it("名稱還是空的（之前沒查到）：下一次存檔會再試一次，查到就補上", async () => {
      const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "補上的名稱" }) });
      await seedLine(ctx, { groupName: "" });
      await ctx.authed("PUT", "/api/settings/line", { enabled: true });
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.store.data.line.groupName).toBe("補上的名稱");
    });

    it("換 token：用新 token 重新查名稱", async () => {
      const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "新 token 查到的名稱" }) });
      await seedLine(ctx, { groupName: "舊名稱" });
      await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: "another-token-abcdefgh" });
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.calls[0]!.headers.authorization).toBe("Bearer another-token-abcdefgh");
      expect(ctx.store.data.line.groupName).toBe("新 token 查到的名稱");
    });

    it("換 token 之後查不到：維持原本存的名稱（群組沒變）", async () => {
      const ctx = await makeSettingsApp({ handler: lineHandler({ summaryStatus: 401 }) });
      await seedLine(ctx, { groupName: "舊名稱" });
      await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: "another-token-abcdefgh" });
      expect(ctx.store.data.line.groupName).toBe("舊名稱");
    });

    it("換了群組、又查不到：名稱清空，不能沿用舊群組的名稱", async () => {
      const ctx = await makeSettingsApp({ handler: lineHandler({ summaryStatus: 404 }) });
      await seedLine(ctx, { groupName: "舊群組的名稱" });
      await ctx.authed("PUT", "/api/settings/line", { groupId: OTHER_GROUP_ID });
      expect(ctx.store.data.line).toMatchObject({ groupId: OTHER_GROUP_ID, groupName: "" });
    });

    it("換了群組、查不到，但 webhook 記錄過新群組的名稱：用記錄的", async () => {
      const ctx = await makeSettingsApp({ handler: lineHandler({ summaryStatus: 404 }) });
      await seedLine(ctx, { groupName: "舊群組的名稱" });
      await ctx.store.update((draft) => {
        draft.lineCaptured = [{ groupId: OTHER_GROUP_ID, groupName: "記錄的新群組", eventType: "join", lastSeenAt: "2026-10-04T00:00:00.000Z" }];
      });
      await ctx.authed("PUT", "/api/settings/line", { groupId: OTHER_GROUP_ID });
      expect(ctx.store.data.line.groupName).toBe("記錄的新群組");
    });

    it("查名稱期間別的請求把群組換掉了：過期的名稱不會蓋掉新群組的名稱（請求交錯）", async () => {
      // B（只切開關、名稱是空的所以會查 G1）先開始、查名稱卡住；A（換成 G2）後開始、先完成。
      const gates = new Map<string, (name: string) => void>();
      const handler = (c: { url: string }) =>
        new Promise<Response>((resolve) => {
          const id = c.url.split("/").at(-2)!;
          gates.set(id, (name) => resolve(new Response(JSON.stringify({ groupName: name }), { status: 200, headers: { "content-type": "application/json" } })));
        });
      const ctx = await makeSettingsApp({ handler });
      await seedLine(ctx, { groupName: "" });

      const b = ctx.authed("PUT", "/api/settings/line", { enabled: false });
      await new Promise((r) => setTimeout(r, 20));
      expect(gates.has(TEST_GROUP_ID)).toBe(true);
      const a = ctx.authed("PUT", "/api/settings/line", { groupId: OTHER_GROUP_ID });
      await new Promise((r) => setTimeout(r, 20));
      expect(gates.has(OTHER_GROUP_ID)).toBe(true);

      gates.get(OTHER_GROUP_ID)!("新群組 G2");
      expect((await a).status).toBe(200);
      gates.get(TEST_GROUP_ID)!("過期的舊群組 G1");
      expect((await b).status).toBe(200);

      expect(ctx.store.data.line).toMatchObject({ enabled: false, groupId: OTHER_GROUP_ID, groupName: "新群組 G2" });
    });
  });

  describe("驗證", () => {
    const rejected: Array<[string, Record<string, unknown>]> = [
      ["token 裡有空白", { channelAccessToken: "abc def" }],
      ["token 裡有換行", { channelAccessToken: "abc\ndef" }],
      ["token 有非 ASCII 字元", { channelAccessToken: "金鑰abcdef" }],
      ["token 超過 1000 字元", { channelAccessToken: "a".repeat(1001) }],
      ["token 不是字串", { channelAccessToken: 12345 }],
      ["secret 裡有空白", { channelSecret: "abc def" }],
      ["secret 超過 1000 字元", { channelSecret: "a".repeat(1001) }],
      ["secret 不是字串", { channelSecret: { x: 1 } }],
      ["群組 ID 不是 C 開頭（使用者 ID）", { groupId: "U0123456789abcdef0123456789abcdef" }],
      ["群組 ID 有非法字元", { groupId: "C0123456789abcdef0123456789ab-def" }],
      ["群組 ID 有引號（注入）", { groupId: 'C123"><script>' }],
      ["群組 ID 太長", { groupId: `C${"a".repeat(64)}` }],
      ["群組 ID 不是字串", { groupId: 123 }],
      ["enabled 不是布林", { enabled: "yes" }],
      ["enabled 是數字", { enabled: 1 }],
      ["clear 旗標不是布林", { clearChannelAccessToken: "true" }],
    ];
    it.each(rejected)("%s → 400，設定完全不變、不呼叫 LINE", async (_name, body) => {
      const ctx = await makeSettingsApp({ handler: lineHandler() });
      await seedLine(ctx);
      const before = JSON.stringify(ctx.store.data.line);
      const res = await ctx.authed("PUT", "/api/settings/line", body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { success: boolean }).success).toBe(false);
      expect(JSON.stringify(ctx.store.data.line)).toBe(before);
      expect(ctx.calls).toHaveLength(0);
    });

    it("請求內容不是 JSON、是陣列、是空字串 → 400", async () => {
      const ctx = await makeSettingsApp();
      expect((await ctx.authed("PUT", "/api/settings/line", "{oops")).status).toBe(400);
      expect((await ctx.authed("PUT", "/api/settings/line", "[]")).status).toBe(400);
      expect((await ctx.authed("PUT", "/api/settings/line", "")).status).toBe(400);
    });

    it("錯誤訊息不含使用者填的 token", async () => {
      const ctx = await makeSettingsApp();
      const res = await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: "secret value with spaces" });
      expect(await res.text()).not.toContain("secret value");
    });

    it("沒有任何欄位的空物件：200，沒有欄位變更，只更新時間", async () => {
      const ctx = await makeSettingsApp();
      const res = await ctx.authed("PUT", "/api/settings/line", {});
      expect(res.status).toBe(200);
      expect(ctx.log.lines).toContain("[settings] admin@example.test 更新了 LINE 設定（沒有欄位變更）");
    });
  });

  it("未知的欄位被忽略（不能偷偷改 groupName、管理員帳號、sessionSecret）", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    const secretBefore = ctx.store.data.sessionSecret;
    const adminsBefore = JSON.stringify(ctx.store.data.admins);
    const res = await ctx.authed("PUT", "/api/settings/line", {
      groupName: "我自己亂填的名稱",
      admin: { passwordHash: "scrypt$x" },
      admins: [{ id: "f".repeat(32), name: "偷塞的管理員", email: "evil@example.test", passwordHash: "scrypt$x", status: "active", sessionVersion: 1 }],
      sessionSecret: "f".repeat(64),
      lineCaptured: [{ groupId: "Cevil" }],
    });
    expect(res.status).toBe(200);
    expect(ctx.store.data.line.groupName).toBe("");
    expect(ctx.store.data.sessionSecret).toBe(secretBefore);
    expect(JSON.stringify(ctx.store.data.admins)).toBe(adminsBefore);
    expect(ctx.store.data.admin).toBeNull();
    expect(ctx.store.data.lineCaptured).toEqual([]);
  });
});

describe("POST /api/settings/line/test（發測試訊息）", () => {
  it("用設定檔裡的 token 推播到設定檔裡的群組：Authorization、to、訊息文字（含台北時間）都正確", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    const res = await ctx.authed("POST", "/api/settings/line/test", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, notified: true });
    expect(ctx.calls).toHaveLength(1);
    const push = ctx.calls[0]!;
    expect(push.url).toBe(PUSH_URL);
    expect(push.method).toBe("POST");
    expect(push.headers.authorization).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    expect(JSON.parse(push.body!)).toEqual({ to: TEST_GROUP_ID, messages: [{ type: "text", text: "🔔 savepoint-crate 測試通知 2026-10-05 15:20" }] });
  });

  it("設定檔優先：同時設了環境變數時，用的是設定檔的 token 與群組", async () => {
    const ctx = await makeSettingsApp({
      handler: lineHandler(),
      env: { LINE_CHANNEL_ACCESS_TOKEN: "env-token-zzzzzzzzzzzz", LINE_GROUP_ID: OTHER_GROUP_ID },
    });
    await seedLine(ctx);
    await ctx.authed("POST", "/api/settings/line/test", {});
    expect(ctx.calls[0]!.headers.authorization).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    expect(JSON.parse(ctx.calls[0]!.body!).to).toBe(TEST_GROUP_ID);
  });

  it("設定檔沒有 token：用環境變數的（生效的設定是哪組就用哪組）", async () => {
    const ctx = await makeSettingsApp({
      handler: lineHandler(),
      env: { LINE_CHANNEL_ACCESS_TOKEN: "env-token-zzzzzzzzzzzz", LINE_GROUP_ID: OTHER_GROUP_ID },
    });
    const res = await ctx.authed("POST", "/api/settings/line/test", {});
    expect(res.status).toBe(200);
    expect(ctx.calls[0]!.headers.authorization).toBe("Bearer env-token-zzzzzzzzzzzz");
    expect(JSON.parse(ctx.calls[0]!.body!).to).toBe(OTHER_GROUP_ID);
  });

  it("開關關著也能測試（目的就是驗證憑證）", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx, { enabled: false });
    expect((await ctx.authed("POST", "/api/settings/line/test", {})).status).toBe(200);
    expect(ctx.calls).toHaveLength(1);
  });

  it("沒有 token 或沒有群組 ID → 400，不呼叫 LINE", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    const none = await ctx.authed("POST", "/api/settings/line/test", {});
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ success: false, error: "請先儲存 Channel access token 與群組 ID" });
    await seedLine(ctx, { groupId: "" });
    expect((await ctx.authed("POST", "/api/settings/line/test", {})).status).toBe(400);
    await seedLine(ctx, { token: "" });
    expect((await ctx.authed("POST", "/api/settings/line/test", {})).status).toBe(400);
    expect(ctx.calls).toHaveLength(0);
  });

  it.each([
    [401, "LINE channel access token 無效或已過期"],
    [403, "群組 ID 無效，或機器人不在該群組裡"],
    [400, "群組 ID 無效，或機器人不在該群組裡"],
    [429, "已達 LINE 推播額度或速率限制"],
    [500, "LINE 回應 HTTP 500"],
  ])("LINE 回 %i → 502 與固定短句（不轉發 LINE 原文，也不含 token）", async (status, message) => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ pushStatus: status }) });
    await seedLine(ctx);
    const res = await ctx.authed("POST", "/api/settings/line/test", {});
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ success: false, error: message });
    expect(text).not.toContain("raw line error");
    expect(text).not.toContain(TEST_LINE_TOKEN);
    expect(ctx.log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);
  });

  it("LINE 連線失敗 → 502「連線 LINE 失敗或逾時」", async () => {
    const ctx = await makeSettingsApp({
      handler: () => {
        throw new TypeError("fetch failed");
      },
    });
    await seedLine(ctx);
    const res = await ctx.authed("POST", "/api/settings/line/test", {});
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: "連線 LINE 失敗或逾時" });
  });

  it("沒登入 → 401，不呼叫 LINE", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    const res = await call(ctx.app, "POST", "/api/settings/line/test", {});
    expect(res.status).toBe(401);
    expect(ctx.calls).toHaveLength(0);
  });

  it("每個 IP 每分鐘最多 6 次，第 7 次 429，一分鐘後恢復", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    const ip = { "x-forwarded-for": "203.0.113.50" };
    for (let i = 0; i < 6; i++) expect((await ctx.authed("POST", "/api/settings/line/test", {}, ip)).status).toBe(200);
    const blocked = await ctx.authed("POST", "/api/settings/line/test", {}, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(ctx.calls).toHaveLength(6);
    ctx.clock.now += 60_001;
    expect((await ctx.authed("POST", "/api/settings/line/test", {}, ip)).status).toBe(200);
  });
});

describe("/api/settings* 的限流額度（有自己的桶，與 OCR 互不擠壓）", () => {
  it("額度的數字：設定 API 60 次、測試訊息 6 次（測試迴圈跟著常數跑，這裡把數字本身釘住）", () => {
    expect(SETTINGS_API_RATE_LIMIT_MAX).toBe(60);
    expect(TEST_PUSH_RATE_LIMIT_MAX).toBe(6);
  });

  it(`每個 IP 每分鐘 ${SETTINGS_API_RATE_LIMIT_MAX} 次，超過 429；OCR 的額度不受影響`, async () => {
    const ctx = await makeSettingsApp();
    const ip = { "x-forwarded-for": "203.0.113.60" };
    for (let i = 0; i < SETTINGS_API_RATE_LIMIT_MAX; i++) expect((await ctx.authed("GET", "/api/settings", undefined, ip)).status).toBe(200);
    expect((await ctx.authed("GET", "/api/settings", undefined, ip)).status).toBe(429);
    // OCR 額度是另一個桶：還沒被用過（缺 image 回 400，不是 429）
    const ocr = await call(ctx.app, "POST", "/api/ocr", {}, ip);
    expect(ocr.status).toBe(400);
  });

  it("反過來：OCR 額度用完，設定 API 不受影響", async () => {
    const ctx = await makeSettingsApp();
    const ip = { "x-forwarded-for": "203.0.113.61" };
    for (let i = 0; i < OCR_RATE_LIMIT_MAX; i++) await call(ctx.app, "POST", "/api/ocr", {}, ip);
    expect((await call(ctx.app, "POST", "/api/ocr", {}, ip)).status).toBe(429);
    expect((await ctx.authed("GET", "/api/settings", undefined, ip)).status).toBe(200);
  });
});

describe("/api/admins* 的限流額度（和 /api/settings* 共用「設定 API」的桶，與 OCR 互不擠壓）", () => {
  it(`每個 IP 每分鐘 ${SETTINGS_API_RATE_LIMIT_MAX} 次，超過 429；帶 id 的路徑與 /api/settings* 在同一個桶；OCR 的額度不受影響`, async () => {
    const ctx = await makeSettingsApp();
    const ip = { "x-forwarded-for": "203.0.113.62" };
    for (let i = 0; i < SETTINGS_API_RATE_LIMIT_MAX; i++) expect((await ctx.authed("GET", "/api/admins", undefined, ip)).status).toBe(200);
    expect((await ctx.authed("GET", "/api/admins", undefined, ip)).status).toBe(429);
    expect((await ctx.authed("DELETE", `/api/admins/${adminId(99)}`, undefined, ip)).status).toBe(429); // 帶 id 的路徑也算同一個桶
    expect((await ctx.authed("GET", "/api/settings", undefined, ip)).status).toBe(429); // /api/settings* 與 /api/admins* 共用
    expect((await call(ctx.app, "POST", "/api/ocr", {}, ip)).status).toBe(400); // OCR 是另一個桶（缺 image 回 400，不是 429）
    ctx.clock.now += 60_001;
    expect((await ctx.authed("GET", "/api/admins", undefined, ip)).status).toBe(200); // 一分鐘後恢復
  });

  it("反過來：OCR 額度用完，/api/admins* 不受影響", async () => {
    const ctx = await makeSettingsApp();
    const ip = { "x-forwarded-for": "203.0.113.63" };
    for (let i = 0; i < OCR_RATE_LIMIT_MAX; i++) await call(ctx.app, "POST", "/api/ocr", {}, ip);
    expect((await call(ctx.app, "POST", "/api/ocr", {}, ip)).status).toBe(429);
    expect((await ctx.authed("GET", "/api/admins", undefined, ip)).status).toBe(200);
  });
});

describe("/healthz 的設定相關欄位", () => {
  const health = async (ctx: SettingsApp) => (await (await ctx.app.request("/healthz")).json()) as Record<string, unknown>;

  it("全新狀態：資料目錄可寫、沒有管理員（測試起點）、LINE 都沒設定", async () => {
    const ctx = await makeSettingsApp({ withAdmin: false });
    expect(await health(ctx)).toMatchObject({
      dataDirWritable: true,
      adminConfigured: false,
      adminCount: 0,
      legacyAdminPending: false,
      lineConfigured: false,
      lineWebhookConfigured: false,
      lineSource: null,
    });
    const withAdmin = await makeSettingsApp();
    expect((await health(withAdmin)).adminConfigured).toBe(true);
  });

  it("lineSource：沒設定 null → 只有環境變數 env → 設定檔有 token settings", async () => {
    const ctx = await makeSettingsApp({ env: { LINE_CHANNEL_SECRET: "env-secret-only-aaaa" } });
    expect(await health(ctx)).toMatchObject({ lineSource: "env", lineConfigured: false, lineWebhookConfigured: true });
    await seedLine(ctx);
    expect(await health(ctx)).toMatchObject({ lineSource: "settings", lineConfigured: true, lineWebhookConfigured: true });
  });

  it("設定檔有 token 但沒有 secret：webhook 不啟用（整組以設定檔為準，環境變數的 secret 不會混進來）", async () => {
    const ctx = await makeSettingsApp({ env: { LINE_CHANNEL_SECRET: "env-secret-only-aaaa" } });
    await seedLine(ctx, { secret: "" });
    expect(await health(ctx)).toMatchObject({ lineSource: "settings", lineConfigured: true, lineWebhookConfigured: false });
  });

  it("開關關閉：lineConfigured 為 false，來源仍是 settings", async () => {
    const ctx = await makeSettingsApp();
    await seedLine(ctx, { enabled: false });
    expect(await health(ctx)).toMatchObject({ lineSource: "settings", lineConfigured: false });
  });

  it("設定檔有 secret 沒有 token：這份設定沒有生效（來源看環境變數）", async () => {
    const ctx = await makeSettingsApp();
    await seedLine(ctx, { token: "" });
    expect(await health(ctx)).toMatchObject({ lineSource: null, lineWebhookConfigured: false });
  });

  it("不含任何 LINE 設定的值", async () => {
    const ctx = await makeSettingsApp();
    await seedLine(ctx);
    const text = JSON.stringify(await health(ctx));
    for (const secret of [TEST_LINE_TOKEN, TEST_LINE_SECRET, TEST_GROUP_ID, "既有群組"]) expect(text).not.toContain(secret);
  });
});

describe("POST /api/box-closed：設定檔優先、環境變數備援", () => {
  const body = { boxId: "BOX-001", items: [{ barcode: "1", productName: "商品", qty: 2 }], total: 1, successCount: 1, failedCount: 0 };

  it("設定檔有 token＋群組：用設定檔的（即使環境變數也設了別的）", async () => {
    const ctx = await makeSettingsApp({
      handler: lineHandler(),
      env: { LINE_CHANNEL_ACCESS_TOKEN: "env-token-zzzzzzzzzzzz", LINE_GROUP_ID: OTHER_GROUP_ID },
    });
    await seedLine(ctx);
    const res = await call(ctx.app, "POST", "/api/box-closed", body);
    expect(await res.json()).toEqual({ success: true, notified: true });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]!.headers.authorization).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    expect(JSON.parse(ctx.calls[0]!.body!).to).toBe(TEST_GROUP_ID);
  });

  it("設定檔沒有 token：退回環境變數", async () => {
    const ctx = await makeSettingsApp({
      handler: lineHandler(),
      env: { LINE_CHANNEL_ACCESS_TOKEN: "env-token-zzzzzzzzzzzz", LINE_GROUP_ID: OTHER_GROUP_ID },
    });
    const res = await call(ctx.app, "POST", "/api/box-closed", body);
    expect(await res.json()).toEqual({ success: true, notified: true });
    expect(ctx.calls[0]!.headers.authorization).toBe("Bearer env-token-zzzzzzzzzzzz");
    expect(JSON.parse(ctx.calls[0]!.body!).to).toBe(OTHER_GROUP_ID);
  });

  it("設定檔的開關關著：不通知（not_configured、不呼叫 LINE），即使環境變數有設定", async () => {
    const ctx = await makeSettingsApp({
      handler: lineHandler(),
      env: { LINE_CHANNEL_ACCESS_TOKEN: "env-token-zzzzzzzzzzzz", LINE_GROUP_ID: OTHER_GROUP_ID },
    });
    await seedLine(ctx, { enabled: false });
    const res = await call(ctx.app, "POST", "/api/box-closed", body);
    expect(await res.json()).toEqual({ success: true, notified: false, reason: "not_configured" });
    expect(ctx.calls).toHaveLength(0);
  });

  it("設定檔有 token 但沒有群組 ID：不通知（環境變數的群組 ID 不會混進來）", async () => {
    const ctx = await makeSettingsApp({
      handler: lineHandler(),
      env: { LINE_CHANNEL_ACCESS_TOKEN: "env-token-zzzzzzzzzzzz", LINE_GROUP_ID: OTHER_GROUP_ID },
    });
    await seedLine(ctx, { groupId: "" });
    const res = await call(ctx.app, "POST", "/api/box-closed", body);
    expect(await res.json()).toEqual({ success: true, notified: false, reason: "not_configured" });
    expect(ctx.calls).toHaveLength(0);
  });

  it("兩邊都沒設定：靜默略過", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    const res = await call(ctx.app, "POST", "/api/box-closed", body);
    expect(await res.json()).toEqual({ success: true, notified: false, reason: "not_configured" });
    expect(ctx.calls).toHaveLength(0);
  });

  it("在設定頁存檔後立刻生效（不必重啟）：存檔前 not_configured，存檔後推播到新的群組", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    expect(await (await call(ctx.app, "POST", "/api/box-closed", body)).json()).toEqual({ success: true, notified: false, reason: "not_configured" });
    await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: TEST_LINE_TOKEN, groupId: OTHER_GROUP_ID });
    ctx.calls.length = 0;
    expect(await (await call(ctx.app, "POST", "/api/box-closed", body)).json()).toEqual({ success: true, notified: true });
    expect(JSON.parse(ctx.calls[0]!.body!).to).toBe(OTHER_GROUP_ID);
    // 再改群組：下一次就推到新的
    await ctx.authed("PUT", "/api/settings/line", { groupId: TEST_GROUP_ID });
    ctx.calls.length = 0;
    await call(ctx.app, "POST", "/api/box-closed", body);
    expect(JSON.parse(ctx.calls[0]!.body!).to).toBe(TEST_GROUP_ID);
  });

  it("推播失敗仍回 200 與固定短句，log 不含設定檔裡的 token", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ pushStatus: 401 }) });
    await seedLine(ctx);
    const res = await call(ctx.app, "POST", "/api/box-closed", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, notified: false, reason: "push_failed", error: "LINE channel access token 無效或已過期" });
    expect(ctx.log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);
  });
});
