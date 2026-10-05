import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CAPTURE_REFRESH_MS } from "../src/line-settings.js";
import { CAPTURED_GROUPS_MAX, SETTINGS_FILE_NAME, SettingsStore } from "../src/settings-store.js";
import { createCapturingLogger, signLineBody, TEST_GROUP_ID, TEST_LINE_SECRET, TEST_LINE_TOKEN } from "./helpers.js";
import { cleanupTempDirs, lineHandler, makeSettingsApp, NOW_MS, type SettingsApp } from "./settings-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

const ENV_SECRET = "env-line-channel-secret-789";
const SUMMARY = (id: string) => `https://api.line.me/v2/bot/group/${id}/summary`;
const REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const groupSource = (id: string = TEST_GROUP_ID) => ({ type: "group", groupId: id });
const joinEvent = (id?: string) => ({ type: "join", replyToken: "rt-join", source: groupSource(id) });
const textEvent = (text: string, id?: string) => ({ type: "message", replyToken: "rt-msg", source: groupSource(id), message: { type: "text", text } });
/** 依序產生互不相同、格式合法的群組 ID。 */
const groupId = (n: number) => `C${String(n).padStart(32, "0")}`;

/** secret 傳 null＝不帶簽章標頭。 */
async function postWebhook(ctx: SettingsApp, events: unknown[], secret: string | null = TEST_LINE_SECRET, headers: Record<string, string> = {}) {
  const body = JSON.stringify({ destination: "Uxxx", events });
  return ctx.app.request("/api/line/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-line-signature": signLineBody(body, secret) }), ...headers },
    body,
  });
}

async function seedLine(ctx: SettingsApp, line: Partial<{ token: string; secret: string; groupId: string }> = {}) {
  await ctx.store.update((draft) => {
    draft.line = {
      enabled: true,
      channelAccessToken: line.token ?? TEST_LINE_TOKEN,
      channelSecret: line.secret ?? TEST_LINE_SECRET,
      groupId: line.groupId ?? "",
      groupName: "",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
  });
}

const savedFile = async (ctx: SettingsApp) => JSON.parse(await readFile(join(ctx.dir, SETTINGS_FILE_NAME), "utf8")) as { lineCaptured: Array<Record<string, string>> };

describe("webhook 簽章：用生效的設定裡的 secret 驗證", () => {
  it("設定檔有 token＋secret：用設定檔的 secret（環境變數的 secret 不再有效）", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler(), env: { LINE_CHANNEL_SECRET: ENV_SECRET } });
    await seedLine(ctx);
    expect((await postWebhook(ctx, [], TEST_LINE_SECRET)).status).toBe(200);
    expect((await postWebhook(ctx, [], ENV_SECRET)).status).toBe(401);
    expect((await postWebhook(ctx, [], "wrong-secret")).status).toBe(401);
    expect((await postWebhook(ctx, [], null)).status).toBe(401);
  });

  it("設定檔沒有 token：用環境變數的 secret（設定檔裡的 secret 不會單獨生效）", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler(), env: { LINE_CHANNEL_SECRET: ENV_SECRET } });
    await seedLine(ctx, { token: "" });
    expect((await postWebhook(ctx, [], ENV_SECRET)).status).toBe(200);
    expect((await postWebhook(ctx, [], TEST_LINE_SECRET)).status).toBe(401);
  });

  it("到哪裡都沒有 secret：503「LINE webhook 尚未啟用」", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    const res = await postWebhook(ctx, []);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: "LINE webhook 尚未啟用" });
    // 設定檔有 token 但 secret 是空的：同樣 503（不會退回環境變數的 secret）
    const ctx2 = await makeSettingsApp({ handler: lineHandler(), env: { LINE_CHANNEL_SECRET: ENV_SECRET } });
    await seedLine(ctx2, { secret: "" });
    expect((await postWebhook(ctx2, [], ENV_SECRET)).status).toBe(503);
  });

  it("在設定頁存檔後立刻生效（不必重啟）", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    expect((await postWebhook(ctx, [])).status).toBe(503);
    await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: TEST_LINE_TOKEN, channelSecret: TEST_LINE_SECRET });
    expect((await postWebhook(ctx, [])).status).toBe(200);
    await ctx.authed("PUT", "/api/settings/line", { channelSecret: "rotated-secret-0123456789" });
    expect((await postWebhook(ctx, [], TEST_LINE_SECRET)).status).toBe(401);
    expect((await postWebhook(ctx, [], "rotated-secret-0123456789")).status).toBe(200);
  });

  it("簽章不符時完全不處理事件（不回覆、不記錄、不查名稱）", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    const res = await postWebhook(ctx, [joinEvent()], "wrong-secret");
    expect(res.status).toBe(401);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.store.data.lineCaptured).toEqual([]);
  });
});

describe("webhook 記錄最近收到的群組（lineCaptured）", () => {
  it("join 事件：記錄群組（名稱用 token 向 LINE 查）、寫進設定檔，同時照常回覆群組 ID", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "倉庫出貨群" }) });
    await seedLine(ctx);
    const res = await postWebhook(ctx, [joinEvent()]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const expected = { groupId: TEST_GROUP_ID, groupName: "倉庫出貨群", eventType: "join", lastSeenAt: new Date(NOW_MS).toISOString() };
    expect(ctx.store.data.lineCaptured).toEqual([expected]);
    expect((await savedFile(ctx)).lineCaptured).toEqual([expected]);

    const urls = ctx.calls.map((c) => c.url).sort();
    expect(urls).toEqual([REPLY_URL, SUMMARY(TEST_GROUP_ID)].sort());
    for (const c of ctx.calls) expect(c.headers.authorization).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    const reply = ctx.calls.find((c) => c.url === REPLY_URL)!;
    expect(JSON.parse(reply.body!).messages[0].text).toContain(TEST_GROUP_ID);
  });

  it("一般的群組訊息也會記錄（eventType 是 message），但不回覆", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "出貨群" }) });
    await seedLine(ctx);
    await postWebhook(ctx, [textEvent("大家好")]);
    expect(ctx.store.data.lineCaptured).toEqual([
      { groupId: TEST_GROUP_ID, groupName: "出貨群", eventType: "message", lastSeenAt: new Date(NOW_MS).toISOString() },
    ]);
    expect(ctx.calls.map((c) => c.url)).toEqual([SUMMARY(TEST_GROUP_ID)]); // 只有查名稱
  });

  it("非文字訊息（貼圖、圖片）也算 message 事件", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    await postWebhook(ctx, [{ type: "message", source: groupSource(), message: { type: "sticker" } }]);
    expect(ctx.store.data.lineCaptured).toHaveLength(1);
  });

  it("「群組ID」關鍵字：回覆並記錄", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    await postWebhook(ctx, [textEvent("群組ID")]);
    expect(ctx.calls.some((c) => c.url === REPLY_URL)).toBe(true);
    expect(ctx.store.data.lineCaptured.map((g) => g.groupId)).toEqual([TEST_GROUP_ID]);
  });

  it("同一個群組去重：再 join 一次只有一筆，時間與事件類型更新、名稱重新查詢", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "舊名稱" }) });
    await seedLine(ctx);
    await postWebhook(ctx, [joinEvent()]);
    ctx.clock.now += 5_000;
    // 群組改名了：join 事件一律重新查名稱
    const renamed = await makeSettingsApp({ store: ctx.store, withAdmin: false, handler: lineHandler({ groupName: "新名稱" }) });
    renamed.clock.now = ctx.clock.now;
    await postWebhook(renamed, [joinEvent()]);
    expect(ctx.store.data.lineCaptured).toEqual([
      { groupId: TEST_GROUP_ID, groupName: "新名稱", eventType: "join", lastSeenAt: new Date(NOW_MS + 5_000).toISOString() },
    ]);
  });

  it("名稱沿用已記錄的：message 事件在刷新間隔之後只更新時間，不再查名稱", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "出貨群" }) });
    await seedLine(ctx);
    await postWebhook(ctx, [joinEvent()]);
    ctx.calls.length = 0;
    ctx.clock.now += CAPTURE_REFRESH_MS;
    await postWebhook(ctx, [textEvent("大家好")]);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.store.data.lineCaptured).toEqual([
      { groupId: TEST_GROUP_ID, groupName: "出貨群", eventType: "message", lastSeenAt: new Date(NOW_MS + CAPTURE_REFRESH_MS).toISOString() },
    ]);
  });

  it("繁忙的群組不會每則訊息都寫檔、查名稱：10 分鐘內的 message 事件略過，滿 10 分鐘才更新", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "出貨群" }) });
    await seedLine(ctx);
    await postWebhook(ctx, [textEvent("第一則")]);
    const firstSeen = new Date(NOW_MS).toISOString();
    ctx.calls.length = 0;
    const updateSpy = vi.spyOn(ctx.store, "update");

    ctx.clock.now = NOW_MS + CAPTURE_REFRESH_MS - 1;
    await postWebhook(ctx, [textEvent("第二則")]);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.store.data.lineCaptured[0]!.lastSeenAt).toBe(firstSeen);

    ctx.clock.now = NOW_MS + CAPTURE_REFRESH_MS;
    await postWebhook(ctx, [textEvent("第三則")]);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(ctx.store.data.lineCaptured[0]!.lastSeenAt).toBe(new Date(NOW_MS + CAPTURE_REFRESH_MS).toISOString());
  });

  it("活躍群組超過 10 個（有群組被擠出最近 10 筆名單）：被擠出去的群組 10 分鐘內的 message 事件仍然不查名稱、不寫檔", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "出貨群" }) });
    await seedLine(ctx);
    for (let i = 1; i <= 12; i++) {
      ctx.clock.now = NOW_MS + i * 1000;
      await postWebhook(ctx, [textEvent("hi", groupId(i))]);
    }
    expect(ctx.store.data.lineCaptured.map((g) => g.groupId)).not.toContain(groupId(1)); // 1 號已經被擠出去了
    ctx.calls.length = 0;
    const updateSpy = vi.spyOn(ctx.store, "update");

    // 31 個事件（含被擠出去的 1 號與還在名單裡的 12 號），全都在 10 分鐘內：一律不處理
    for (let n = 0; n < 31; n++) {
      ctx.clock.now = NOW_MS + 13_000 + n * 1000;
      await postWebhook(ctx, [textEvent("hi again", groupId(n % 2 === 0 ? 1 : 12))]);
    }
    expect(ctx.calls).toHaveLength(0);
    expect(updateSpy).not.toHaveBeenCalled();

    // 滿 10 分鐘之後才會再處理
    ctx.clock.now = NOW_MS + 1_000 + CAPTURE_REFRESH_MS;
    await postWebhook(ctx, [textEvent("later", groupId(1))]);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(ctx.store.data.lineCaptured[0]!.groupId).toBe(groupId(1));
  });

  it("join 事件不受 10 分鐘的限制（剛加入的群組一定要記錄）", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    await postWebhook(ctx, [textEvent("先有訊息")]);
    ctx.clock.now += 1_000;
    await postWebhook(ctx, [joinEvent()]);
    expect(ctx.store.data.lineCaptured[0]).toMatchObject({ eventType: "join", lastSeenAt: new Date(NOW_MS + 1_000).toISOString() });
  });

  it("名稱一直查不到時，每 10 分鐘才重試一次（不是每則訊息都打 LINE）", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ summaryStatus: 404 }) });
    await seedLine(ctx);
    await postWebhook(ctx, [textEvent("1")]);
    expect(ctx.calls.filter((c) => c.url === SUMMARY(TEST_GROUP_ID))).toHaveLength(1);
    await postWebhook(ctx, [textEvent("2")]);
    await postWebhook(ctx, [textEvent("3")]);
    expect(ctx.calls.filter((c) => c.url === SUMMARY(TEST_GROUP_ID))).toHaveLength(1);
    ctx.clock.now += CAPTURE_REFRESH_MS;
    await postWebhook(ctx, [textEvent("4")]);
    expect(ctx.calls.filter((c) => c.url === SUMMARY(TEST_GROUP_ID))).toHaveLength(2);
  });

  it(`最多留 ${CAPTURED_GROUPS_MAX} 筆、最新的在前：12 個不同群組 → 留下最後 10 個`, async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    for (let i = 1; i <= 12; i++) {
      ctx.clock.now = NOW_MS + i * 1000;
      await postWebhook(ctx, [joinEvent(groupId(i))]);
    }
    const ids = ctx.store.data.lineCaptured.map((g) => g.groupId);
    expect(ids).toHaveLength(10);
    expect(ids).toEqual(Array.from({ length: 10 }, (_, k) => groupId(12 - k)));
    expect(ids).not.toContain(groupId(1));
    expect(ids).not.toContain(groupId(2));
    expect((await savedFile(ctx)).lineCaptured).toHaveLength(10);
  });

  it("已在清單裡的舊群組再出現：移到最前面（不會因為排擠而丟掉別人）", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    for (let i = 1; i <= 3; i++) {
      ctx.clock.now = NOW_MS + i * 1000;
      await postWebhook(ctx, [joinEvent(groupId(i))]);
    }
    ctx.clock.now = NOW_MS + 10_000;
    await postWebhook(ctx, [joinEvent(groupId(1))]);
    expect(ctx.store.data.lineCaptured.map((g) => g.groupId)).toEqual([groupId(1), groupId(3), groupId(2)]);
  });

  it("同一次 webhook 帶多個事件（不同群組）：全部記錄", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    await postWebhook(ctx, [joinEvent(groupId(1)), textEvent("hi", groupId(2)), joinEvent(groupId(3))]);
    expect(ctx.store.data.lineCaptured.map((g) => g.groupId).sort()).toEqual([groupId(1), groupId(2), groupId(3)].sort());
  });

  it("個人對話、聊天室、格式不合法的群組 ID、leave／follow 等其他事件：都不記錄", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    await postWebhook(ctx, [
      { type: "message", source: { type: "user", userId: "U0123456789abcdef0123456789abcdef" }, message: { type: "text", text: "群組ID" } },
      { type: "message", source: { type: "room", roomId: "R0123456789abcdef0123456789abcdef" }, message: { type: "text", text: "hi" } },
      { type: "join", source: { type: "group", groupId: 'C"><script>alert(1)</script>' } },
      { type: "join", source: { type: "group", groupId: `C${"a".repeat(100)}` } },
      { type: "join", source: { type: "group", groupId: 12345 } },
      { type: "leave", source: groupSource() },
      { type: "follow", source: groupSource() },
      { type: "postback", source: groupSource() },
      { type: "join" },
      "字串",
      null,
    ]);
    expect(ctx.store.data.lineCaptured).toEqual([]);
    expect(ctx.calls.some((c) => c.url.includes("summary"))).toBe(false);
  });

  it("沒有 token（只有環境變數的 secret）：照樣記錄，名稱留空，不呼叫 LINE", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler(), env: { LINE_CHANNEL_SECRET: ENV_SECRET } });
    const res = await postWebhook(ctx, [joinEvent()], ENV_SECRET);
    expect(res.status).toBe(200);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.store.data.lineCaptured).toEqual([
      { groupId: TEST_GROUP_ID, groupName: "", eventType: "join", lastSeenAt: new Date(NOW_MS).toISOString() },
    ]);
  });

  it("環境變數版（有 token）也會記錄，並用環境變數的 token 查名稱", async () => {
    const ctx = await makeSettingsApp({
      handler: lineHandler({ groupName: "環境變數群" }),
      env: { LINE_CHANNEL_ACCESS_TOKEN: "env-token-zzzzzzzzzzzz", LINE_CHANNEL_SECRET: ENV_SECRET },
    });
    await postWebhook(ctx, [joinEvent()], ENV_SECRET);
    expect(ctx.store.data.lineCaptured[0]).toMatchObject({ groupName: "環境變數群" });
    expect(ctx.calls.find((c) => c.url === SUMMARY(TEST_GROUP_ID))!.headers.authorization).toBe("Bearer env-token-zzzzzzzzzzzz");
  });

  it("查名稱失敗（404、連線錯誤）：照樣記錄（名稱留空），回覆也照常送出", async () => {
    for (const handler of [
      lineHandler({ summaryStatus: 404 }),
      (c: { url: string }) => {
        if (c.url.endsWith("/summary")) throw new TypeError("fetch failed");
        return new Response("{}", { status: 200 });
      },
    ]) {
      const ctx = await makeSettingsApp({ handler });
      await seedLine(ctx);
      const res = await postWebhook(ctx, [joinEvent()]);
      expect(res.status).toBe(200);
      expect(ctx.store.data.lineCaptured).toEqual([{ groupId: TEST_GROUP_ID, groupName: "", eventType: "join", lastSeenAt: new Date(NOW_MS).toISOString() }]);
      expect(ctx.calls.some((c) => c.url === REPLY_URL)).toBe(true);
      expect(ctx.log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);
    }
  });

  it("資料目錄不可用：webhook 仍然回覆群組 ID、回 200，只是不記錄", async () => {
    const ctx = await makeSettingsApp({
      store: "unavailable",
      handler: lineHandler(),
      env: { LINE_CHANNEL_ACCESS_TOKEN: TEST_LINE_TOKEN, LINE_CHANNEL_SECRET: ENV_SECRET },
    });
    const res = await postWebhook(ctx, [joinEvent(), textEvent("hi")], ENV_SECRET);
    expect(res.status).toBe(200);
    expect(ctx.calls.map((c) => c.url)).toEqual([REPLY_URL]); // 沒有查名稱（沒地方存）
    expect(ctx.store.data.lineCaptured).toEqual([]);
  });

  it("寫檔失敗：webhook 仍回 200、回覆照常送出，log 有錯誤（不含 token），記憶體維持原樣", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    vi.spyOn(ctx.store, "update").mockRejectedValue(new Error(`disk full ${TEST_LINE_TOKEN}`));
    const res = await postWebhook(ctx, [joinEvent()]);
    expect(res.status).toBe(200);
    expect(ctx.calls.some((c) => c.url === REPLY_URL)).toBe(true);
    expect(ctx.log.lines.join("\n")).toContain("[line] 記錄群組事件失敗");
    expect(ctx.log.lines.join("\n")).not.toContain(TEST_LINE_TOKEN);
    expect(ctx.store.data.lineCaptured).toEqual([]);
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("資料目錄中途變成唯讀（真的寫不進去）：同樣不影響 webhook 回應", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    await chmod(ctx.dir, 0o500);
    const res = await postWebhook(ctx, [joinEvent()]);
    await chmod(ctx.dir, 0o700);
    expect(res.status).toBe(200);
    expect(ctx.store.data.lineCaptured).toEqual([]);
  });

  it("重新開啟資料目錄後，記錄還在（Volume 上持久化）", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "持久化群組" }) });
    await seedLine(ctx);
    await postWebhook(ctx, [joinEvent()]);
    const reopened = await SettingsStore.open(ctx.dir, { log: createCapturingLogger() });
    expect(reopened.data.lineCaptured).toEqual([
      { groupId: TEST_GROUP_ID, groupName: "持久化群組", eventType: "join", lastSeenAt: new Date(NOW_MS).toISOString() },
    ]);
  });

  it("log 不含 token 或 secret；join 的 log 只有群組 ID", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler() });
    await seedLine(ctx);
    await postWebhook(ctx, [joinEvent()]);
    const logged = ctx.log.lines.join("\n");
    expect(logged).toContain(`[line] 事件 join 來自 group ${TEST_GROUP_ID}`);
    expect(logged).not.toContain(TEST_LINE_TOKEN);
    expect(logged).not.toContain(TEST_LINE_SECRET);
  });
});

describe("設定頁顯示最近收到的群組", () => {
  it("GET /api/settings 與頁面都列出（最新在前），頁面有「使用此群組」按鈕", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "出貨群" }) });
    await seedLine(ctx);
    for (let i = 1; i <= 2; i++) {
      ctx.clock.now = NOW_MS + i * 1000;
      await postWebhook(ctx, [joinEvent(groupId(i))]);
    }
    const { data } = (await (await ctx.authed("GET", "/api/settings")).json()) as { data: { captured: Array<{ groupId: string }> } };
    expect(data.captured.map((g) => g.groupId)).toEqual([groupId(2), groupId(1)]);

    const html = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(html).toContain(`data-use-group="${groupId(1)}"`);
    expect(html).toContain(`data-use-group="${groupId(2)}"`);
    expect(html.indexOf(groupId(2))).toBeLessThan(html.indexOf(groupId(1)));
    expect(html).toContain("出貨群");
    expect(html).toContain("使用此群組");
    expect(html).toContain("加入群組");
  });

  it("還沒有任何記錄：顯示說明文字，沒有按鈕", async () => {
    const ctx = await makeSettingsApp();
    const html = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(html).toContain("還沒有收到任何群組");
    expect(html).not.toContain("data-use-group=");
  });

  it("LINE 回傳的群組名稱含 HTML：頁面一律跳脫，不會變成可執行的標籤或屬性", async () => {
    const evil = `<img src=x onerror=alert(1)>"onmouseover="alert(2)'><script>alert(3)</script>`;
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: evil }) });
    await seedLine(ctx);
    await postWebhook(ctx, [joinEvent()]);
    const html = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('"onmouseover=');
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&quot;onmouseover=&quot;alert(2)");
    expect((html.match(/<script/g) ?? []).length).toBe(1); // 還是只有頁面自己那一段 script
  });

  it("設定頁的群組名稱欄位（儲存時查到的名稱）同樣跳脫", async () => {
    const ctx = await makeSettingsApp({ handler: lineHandler({ groupName: "<b>粗體</b>" }) });
    await ctx.authed("PUT", "/api/settings/line", { channelAccessToken: TEST_LINE_TOKEN, groupId: TEST_GROUP_ID });
    const html = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(html).not.toContain("<b>粗體</b>");
    expect(html).toContain("&lt;b&gt;粗體&lt;/b&gt;");
  });

  it("頁面裡絕不出現完整的 token 或 secret（只有「已設定（尾碼 …xxxx）」的提示）", async () => {
    const ctx = await makeSettingsApp();
    await seedLine(ctx, { groupId: TEST_GROUP_ID });
    const html = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(html).not.toContain(TEST_LINE_TOKEN);
    expect(html).not.toContain(TEST_LINE_SECRET);
    expect(html).not.toContain(TEST_LINE_TOKEN.slice(0, 8));
    expect(html).toContain(`已設定（尾碼 …${TEST_LINE_TOKEN.slice(-4)}）`);
    expect(html).toContain(`已設定（尾碼 …${TEST_LINE_SECRET.slice(-4)}）`);
    expect(html).toContain(`value="${TEST_GROUP_ID}"`);
    expect(html).toContain('id="line-token-clear"'); // 已設定才有「清除」選項
  });

  it("尚未設定 token／secret：沒有「清除」選項，placeholder 是空的", async () => {
    const ctx = await makeSettingsApp();
    const html = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(html).not.toContain('id="line-token-clear"');
    expect(html).not.toContain('id="line-secret-clear"');
    expect(html).toContain('id="line-token" autocomplete="new-password" spellcheck="false" maxlength="1000" placeholder=""');
  });

  it("目前生效的是環境變數：頁面說明這點；設定檔只有 secret 沒有 token：頁面提醒尚未生效", async () => {
    const ctx = await makeSettingsApp({ env: { LINE_CHANNEL_ACCESS_TOKEN: "env-token-zzzzzzzzzzzz", LINE_GROUP_ID: groupId(1) } });
    const html = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(html).toContain("目前生效的是環境變數裡的 LINE 設定（備援）");
    expect(html).toContain("設定來源：環境變數（備援）");
    expect(html).not.toContain("env-token-zzzzzzzzzzzz");
    expect(html).not.toContain(groupId(1));

    await ctx.store.update((draft) => {
      draft.line.channelSecret = "only-a-secret-0123456789";
    });
    const half = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(half).toContain("已填 Channel secret 但還沒填 Channel access token");
  });

  it("狀態列：生效設定的各項狀態（已啟用／已停用／設定未完成、Webhook）", async () => {
    const ctx = await makeSettingsApp();
    const page = async () => (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(await page()).toContain("LINE 關箱通知：設定未完成");
    expect(await page()).toContain("Webhook：缺少 Channel secret");
    expect(await page()).toContain("設定來源：尚未設定");
    await seedLine(ctx, { groupId: TEST_GROUP_ID });
    const ready = await page();
    expect(ready).toContain("LINE 關箱通知：已啟用");
    expect(ready).toContain("Webhook：已啟用");
    expect(ready).toContain("設定來源：設定頁");
    await ctx.authed("PUT", "/api/settings/line", { enabled: false });
    const disabled = await page();
    expect(disabled).toContain("LINE 關箱通知：已停用");
    expect(disabled).not.toContain('id="line-enabled" checked');
    expect(ready).toContain('id="line-enabled" checked');
  });
});
