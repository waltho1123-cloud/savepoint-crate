import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnv } from "../src/env.js";
import {
  buildSettingsView,
  CAPTURE_REFRESH_MS,
  CAPTURE_THROTTLE_MAX_ENTRIES,
  captureLineGroup,
  maskCredential,
  resolveLineConfig,
} from "../src/line-settings.js";
import { newSettingsData, SettingsStore, type SettingsData } from "../src/settings-store.js";
import { createCapturingLogger, createFetchMock, TEST_GROUP_ID, TEST_LINE_SECRET, TEST_LINE_TOKEN } from "./helpers.js";
import { cleanupTempDirs, lineHandler, makeTempDir, NOW_MS } from "./settings-helpers.js";

afterEach(cleanupTempDirs);

const ENV_ALL = { LINE_CHANNEL_ACCESS_TOKEN: "env-token-zzzzzzzzzzzz", LINE_GROUP_ID: "Cenvgroup00000000000000000000000", LINE_CHANNEL_SECRET: "env-secret-yyyyyyyy" };

function data(line: Partial<SettingsData["line"]> = {}): SettingsData {
  const base = newSettingsData();
  base.line = { ...base.line, ...line };
  return base;
}

describe("resolveLineConfig（設定檔優先、環境變數備援）", () => {
  it("設定檔有 token：整組用設定檔的（token、secret、群組 ID、開關），環境變數完全不參與", () => {
    const resolved = resolveLineConfig(
      loadEnv(ENV_ALL),
      data({ channelAccessToken: TEST_LINE_TOKEN, channelSecret: TEST_LINE_SECRET, groupId: TEST_GROUP_ID, enabled: true }),
    );
    expect(resolved).toEqual({
      source: "settings",
      enabled: true,
      token: TEST_LINE_TOKEN,
      secret: TEST_LINE_SECRET,
      groupId: TEST_GROUP_ID,
      notifyReady: true,
      webhookReady: true,
    });
  });

  it("設定檔有 token、但 secret 或群組 ID 是空的：不會從環境變數補", () => {
    const noSecret = resolveLineConfig(loadEnv(ENV_ALL), data({ channelAccessToken: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID }));
    expect(noSecret).toMatchObject({ source: "settings", secret: "", webhookReady: false, notifyReady: true });
    const noGroup = resolveLineConfig(loadEnv(ENV_ALL), data({ channelAccessToken: TEST_LINE_TOKEN, channelSecret: TEST_LINE_SECRET }));
    expect(noGroup).toMatchObject({ source: "settings", groupId: "", notifyReady: false, webhookReady: true });
  });

  it("開關關閉：notifyReady 為 false，但 webhook 照樣可用、來源仍是 settings（不會退回環境變數）", () => {
    const resolved = resolveLineConfig(
      loadEnv(ENV_ALL),
      data({ channelAccessToken: TEST_LINE_TOKEN, channelSecret: TEST_LINE_SECRET, groupId: TEST_GROUP_ID, enabled: false }),
    );
    expect(resolved).toMatchObject({ source: "settings", enabled: false, notifyReady: false, webhookReady: true, token: TEST_LINE_TOKEN });
  });

  it("設定檔沒有 token：整組用環境變數（設定檔裡其他欄位不參與）", () => {
    const resolved = resolveLineConfig(
      loadEnv(ENV_ALL),
      data({ channelSecret: TEST_LINE_SECRET, groupId: TEST_GROUP_ID, enabled: false }),
    );
    expect(resolved).toEqual({
      source: "env",
      enabled: true, // 環境變數版沒有開關
      token: ENV_ALL.LINE_CHANNEL_ACCESS_TOKEN,
      secret: ENV_ALL.LINE_CHANNEL_SECRET,
      groupId: ENV_ALL.LINE_GROUP_ID,
      notifyReady: true,
      webhookReady: true,
    });
  });

  it.each([
    ["只有 token", { LINE_CHANNEL_ACCESS_TOKEN: "t" }, { source: "env", notifyReady: false, webhookReady: false }],
    ["只有群組 ID", { LINE_GROUP_ID: "C1" }, { source: "env", notifyReady: false, webhookReady: false }],
    ["只有 secret", { LINE_CHANNEL_SECRET: "s" }, { source: "env", notifyReady: false, webhookReady: true }],
    ["token＋群組 ID", { LINE_CHANNEL_ACCESS_TOKEN: "t", LINE_GROUP_ID: "C1" }, { source: "env", notifyReady: true, webhookReady: false }],
    ["三個都有", { LINE_CHANNEL_ACCESS_TOKEN: "t", LINE_GROUP_ID: "C1", LINE_CHANNEL_SECRET: "s" }, { source: "env", notifyReady: true, webhookReady: true }],
    ["都沒有", {}, { source: null, notifyReady: false, webhookReady: false }],
  ])("環境變數：%s", (_name, env, expected) => {
    expect(resolveLineConfig(loadEnv(env), data())).toMatchObject(expected);
  });
});

describe("maskCredential", () => {
  it("沒有值：未設定、沒有尾碼", () => {
    expect(maskCredential("")).toEqual({ configured: false, last4: null });
  });

  it("至少 12 字元才顯示末 4 碼；更短的只顯示「已設定」", () => {
    expect(maskCredential("12345678901")).toEqual({ configured: true, last4: null });
    expect(maskCredential("123456789012")).toEqual({ configured: true, last4: "9012" });
    expect(maskCredential(TEST_LINE_TOKEN)).toEqual({ configured: true, last4: TEST_LINE_TOKEN.slice(-4) });
  });

  it("結果裡沒有完整的值", () => {
    expect(JSON.stringify(maskCredential(TEST_LINE_TOKEN))).not.toContain(TEST_LINE_TOKEN);
  });
});

describe("buildSettingsView", () => {
  it("不可用的 store：dataDirWritable false、其他都是空的", () => {
    const view = buildSettingsView(loadEnv({}), SettingsStore.unavailable());
    expect(view).toMatchObject({
      dataDirWritable: false,
      dataDirMounted: null,
      adminConfigured: false,
      captured: [],
      effective: { source: null, lineConfigured: false, lineWebhookConfigured: false },
    });
  });

  it("captured 是複本：改它不會動到 store 裡凍結的資料", async () => {
    const store = await SettingsStore.open(await makeTempDir(), { log: createCapturingLogger() });
    await store.update((draft) => {
      draft.lineCaptured = [{ groupId: "C1", groupName: "甲", eventType: "join", lastSeenAt: "2026-10-05T00:00:00.000Z" }];
    });
    const view = buildSettingsView(loadEnv({}), store);
    view.captured[0]!.groupName = "被改了";
    view.captured.push({ groupId: "C2", groupName: "", eventType: "", lastSeenAt: "" });
    expect(store.data.lineCaptured).toHaveLength(1);
    expect(store.data.lineCaptured[0]!.groupName).toBe("甲");
  });

  it("整份檢視序列化後不含 token／secret／環境變數的值／密碼雜湊／sessionSecret", async () => {
    const store = await SettingsStore.open(await makeTempDir(), { log: createCapturingLogger() });
    await store.update((draft) => {
      draft.admin = { passwordHash: "scrypt$16384$8$1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA", updatedAt: "" };
      draft.line.channelAccessToken = TEST_LINE_TOKEN;
      draft.line.channelSecret = TEST_LINE_SECRET;
    });
    const text = JSON.stringify(buildSettingsView(loadEnv(ENV_ALL), store));
    for (const secret of [TEST_LINE_TOKEN, TEST_LINE_SECRET, ...Object.values(ENV_ALL), "scrypt$", store.data.sessionSecret]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("captureLineGroup（邊界）", () => {
  async function setup(handler = lineHandler({ groupName: "出貨群" })) {
    const log = createCapturingLogger();
    const store = await SettingsStore.open(await makeTempDir(), { log });
    const { mock, calls } = createFetchMock(handler);
    const clock = { now: NOW_MS };
    const lastHandled = new Map<string, number>();
    const capture = (event: { groupId: string; eventType: "join" | "message" }, token: string = TEST_LINE_TOKEN) =>
      captureLineGroup({ store, fetchImpl: mock, log, token, now: () => clock.now, lastHandled }, event);
    return { store, calls, clock, capture, log, lastHandled };
  }

  it("剛好差 10 分鐘就更新、差 10 分鐘少 1 毫秒就略過", async () => {
    const { store, clock, capture } = await setup();
    await capture({ groupId: TEST_GROUP_ID, eventType: "message" });
    clock.now = NOW_MS + CAPTURE_REFRESH_MS - 1;
    await capture({ groupId: TEST_GROUP_ID, eventType: "message" });
    expect(store.data.lineCaptured[0]!.lastSeenAt).toBe(new Date(NOW_MS).toISOString());
    clock.now = NOW_MS + CAPTURE_REFRESH_MS;
    await capture({ groupId: TEST_GROUP_ID, eventType: "message" });
    expect(store.data.lineCaptured[0]!.lastSeenAt).toBe(new Date(NOW_MS + CAPTURE_REFRESH_MS).toISOString());
    expect(CAPTURE_REFRESH_MS).toBe(600_000);
  });

  it("系統時鐘往回調（現在比上次記錄還早）：不當成「剛剛才記過」，直接更新", async () => {
    const { store, clock, capture } = await setup();
    await capture({ groupId: TEST_GROUP_ID, eventType: "message" });
    clock.now = NOW_MS - 3_600_000;
    await capture({ groupId: TEST_GROUP_ID, eventType: "message" });
    expect(store.data.lineCaptured[0]!.lastSeenAt).toBe(new Date(NOW_MS - 3_600_000).toISOString());
  });

  it("節流靠記憶體裡的處理時間，不靠「群組還在最近 10 筆名單裡」：名單裡沒有（被擠掉、重新啟動後）的群組照樣節流", async () => {
    const { store, calls, clock, capture } = await setup();
    await capture({ groupId: TEST_GROUP_ID, eventType: "message" });
    // 名單被清空（模擬群組被別的群組擠出最近 10 筆）：10 分鐘內的 message 事件仍然不處理（不查名稱、不寫檔）
    await store.update((draft) => {
      draft.lineCaptured = [];
    });
    calls.length = 0;
    clock.now = NOW_MS + 1000;
    await capture({ groupId: TEST_GROUP_ID, eventType: "message" });
    expect(calls).toHaveLength(0);
    expect(store.data.lineCaptured).toEqual([]);
  });

  it("重新啟動後（節流表是空的）：已記錄的群組第一則 message 事件只更新時間，不重查名稱", async () => {
    const { store, calls, capture } = await setup();
    await store.update((draft) => {
      draft.lineCaptured = [{ groupId: TEST_GROUP_ID, groupName: "舊", eventType: "join", lastSeenAt: "2026-10-01T00:00:00.000Z" }];
    });
    await capture({ groupId: TEST_GROUP_ID, eventType: "message" });
    expect(calls).toHaveLength(0);
    expect(store.data.lineCaptured[0]).toMatchObject({ groupName: "舊", lastSeenAt: new Date(NOW_MS).toISOString() });
  });

  it("join 事件不受節流限制，而且會更新節流表", async () => {
    const { clock, capture, lastHandled } = await setup();
    await capture({ groupId: TEST_GROUP_ID, eventType: "message" });
    clock.now = NOW_MS + 1000;
    await capture({ groupId: TEST_GROUP_ID, eventType: "join" });
    expect(lastHandled.get(TEST_GROUP_ID)).toBe(NOW_MS + 1000);
  });

  it(`節流表最多 ${CAPTURE_THROTTLE_MAX_ENTRIES} 個群組：超過就丟掉最舊的（記憶體有上限）`, async () => {
    const { store, capture, lastHandled } = await setup(lineHandler({ summaryStatus: 404 }));
    vi.spyOn(store, "update").mockResolvedValue(undefined); // 這裡只測節流表；不必真的寫一千多次檔案
    const id = (n: number) => `C${String(n).padStart(32, "0")}`;
    for (let i = 1; i <= CAPTURE_THROTTLE_MAX_ENTRIES + 5; i++) await capture({ groupId: id(i), eventType: "message" }, "");
    expect(lastHandled.size).toBe(CAPTURE_THROTTLE_MAX_ENTRIES);
    expect(lastHandled.has(id(1))).toBe(false);
    expect(lastHandled.has(id(5))).toBe(false);
    expect(lastHandled.has(id(6))).toBe(true);
    expect(lastHandled.has(id(CAPTURE_THROTTLE_MAX_ENTRIES + 5))).toBe(true);
    expect(CAPTURE_THROTTLE_MAX_ENTRIES).toBe(1000);
  });

  it("沒有 token：不查名稱，沿用已記錄的名稱（不會被清成空字串）", async () => {
    const { store, calls, capture } = await setup();
    await capture({ groupId: TEST_GROUP_ID, eventType: "join" });
    expect(store.data.lineCaptured[0]!.groupName).toBe("出貨群");
    calls.length = 0;
    await capture({ groupId: TEST_GROUP_ID, eventType: "join" }, "");
    expect(calls).toHaveLength(0);
    expect(store.data.lineCaptured[0]!.groupName).toBe("出貨群");
  });

  it("join 重新查名稱時查不到：保留舊名稱，不會被清空", async () => {
    const ctx = await setup(lineHandler({ summaryStatus: 404 }));
    await ctx.store.update((draft) => {
      draft.lineCaptured = [{ groupId: TEST_GROUP_ID, groupName: "舊名稱", eventType: "join", lastSeenAt: "2026-10-01T00:00:00.000Z" }];
    });
    await ctx.capture({ groupId: TEST_GROUP_ID, eventType: "join" });
    expect(ctx.store.data.lineCaptured[0]).toMatchObject({ groupName: "舊名稱", eventType: "join", lastSeenAt: new Date(NOW_MS).toISOString() });
  });

  it("資料目錄不可用：什麼都不做（不查名稱、不丟例外）", async () => {
    const { mock, calls } = createFetchMock(lineHandler());
    const log = createCapturingLogger();
    await captureLineGroup(
      { store: SettingsStore.unavailable(), fetchImpl: mock, log, token: TEST_LINE_TOKEN, now: () => NOW_MS, lastHandled: new Map() },
      { groupId: TEST_GROUP_ID, eventType: "join" },
    );
    expect(calls).toHaveLength(0);
    expect(log.lines).toEqual([]);
  });
});
