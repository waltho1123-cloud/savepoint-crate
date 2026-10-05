import { chmod, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ServiceError } from "../src/common.js";
import {
  CAPTURED_GROUPS_MAX,
  DATA_DIR_UNAVAILABLE_MESSAGE,
  STALE_TEMP_MS,
  findMountPoint,
  newSettingsData,
  parseSettingsText,
  serializeSettings,
  SETTINGS_FILE_NAME,
  SettingsStore,
  type AdminAccount,
} from "../src/settings-store.js";
import { createCapturingLogger } from "./helpers.js";
import { cleanupTempDirs, makeTempDir } from "./settings-helpers.js";

afterEach(cleanupTempDirs);

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const modeOf = async (path: string) => (await stat(path)).mode & 0o777;
const readSettings = async (dir: string) => JSON.parse(await readFile(join(dir, SETTINGS_FILE_NAME), "utf8")) as Record<string, any>;

describe("SettingsStore.open：第一次啟動", () => {
  it("資料目錄是空的：建立 settings.json（權限 0600、結構正確、sessionSecret 是 32 位元組十六進位），沒有殘留暫存檔", async () => {
    const dir = await makeTempDir();
    const log = createCapturingLogger();
    const store = await SettingsStore.open(dir, { log });
    expect(store.writable).toBe(true);
    expect(store.dir).toBe(dir);

    const file = join(dir, SETTINGS_FILE_NAME);
    expect(await modeOf(file)).toBe(0o600);
    const saved = await readSettings(dir);
    expect(saved).toEqual({
      version: 2,
      admins: [], // 新檔沒有舊版的單一密碼，所以不會寫出 admin 欄位
      sessionSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
      line: { enabled: true, channelAccessToken: "", channelSecret: "", groupId: "", groupName: "", updatedAt: "" },
      lineCaptured: [],
    });
    expect(store.data.sessionSecret).toBe(saved.sessionSecret);
    expect(await readdir(dir)).toEqual([SETTINGS_FILE_NAME]);
    expect(log.lines.join("\n")).toContain(`[settings] 資料目錄：${dir}`);
    // 開啟之後（還沒有任何 update）記憶體裡的設定就已經是凍結的唯讀物件
    expect(Object.isFrozen(store.data)).toBe(true);
    expect(Object.isFrozen(store.data.line)).toBe(true);
    expect(Object.isFrozen(store.data.lineCaptured)).toBe(true);
  });

  it("資料目錄不存在：遞迴建立", async () => {
    const root = await makeTempDir();
    const dir = join(root, "a", "b", "data");
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    expect(store.writable).toBe(true);
    expect(await modeOf(join(dir, SETTINGS_FILE_NAME))).toBe(0o600);
  });

  it("相對路徑會被解析成絕對路徑", async () => {
    const root = await makeTempDir();
    const original = process.cwd();
    process.chdir(root);
    try {
      const store = await SettingsStore.open("./data", { log: createCapturingLogger() });
      expect(store.writable).toBe(true);
      expect(store.dir.endsWith("/data")).toBe(true);
      expect(store.dir.startsWith("/")).toBe(true);
    } finally {
      process.chdir(original);
    }
  });

  it("每次第一次啟動的 sessionSecret 都不一樣", async () => {
    const a = await SettingsStore.open(await makeTempDir(), { log: createCapturingLogger() });
    const b = await SettingsStore.open(await makeTempDir(), { log: createCapturingLogger() });
    expect(a.data.sessionSecret).not.toBe(b.data.sessionSecret);
  });
});

describe("SettingsStore.open：既有的設定檔", () => {
  it("有效的檔案：載入內容，不重寫檔案（內容與修改時間都不變）", async () => {
    const dir = await makeTempDir();
    const original = newSettingsData();
    original.admin = { passwordHash: "scrypt$16384$8$1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA", updatedAt: "2026-10-01T00:00:00.000Z" };
    original.line = {
      enabled: false,
      channelAccessToken: "tok-1",
      channelSecret: "sec-1",
      groupId: "C0123456789abcdef0123456789abcdef",
      groupName: "倉庫",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    original.lineCaptured = [{ groupId: "C1", groupName: "甲", eventType: "join", lastSeenAt: "2026-10-03T00:00:00.000Z" }];
    const file = join(dir, SETTINGS_FILE_NAME);
    const text = `${JSON.stringify(original, null, 2)}\n`;
    await writeFile(file, text, { mode: 0o600 });
    const mtimeBefore = (await stat(file)).mtimeMs;

    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    expect(store.writable).toBe(true);
    expect(store.data).toEqual(original);
    expect(await readFile(file, "utf8")).toBe(text);
    expect((await stat(file)).mtimeMs).toBe(mtimeBefore);
  });

  it("重新開啟：之前 update 寫進去的內容都還在", async () => {
    const dir = await makeTempDir();
    const first = await SettingsStore.open(dir, { log: createCapturingLogger() });
    await first.update((draft) => {
      draft.line.channelAccessToken = "persisted-token";
    });
    const second = await SettingsStore.open(dir, { log: createCapturingLogger() });
    expect(second.data.line.channelAccessToken).toBe("persisted-token");
    expect(second.data.sessionSecret).toBe(first.data.sessionSecret);
  });
});

describe("SettingsStore.update", () => {
  it("先寫檔、成功才換掉記憶體；檔案權限維持 0600；記憶體裡的設定是凍結的唯讀物件", async () => {
    const dir = await makeTempDir();
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    const before = store.data;
    await store.update((draft) => {
      draft.line.groupId = "C1";
    });
    expect(store.data.line.groupId).toBe("C1");
    expect(before.line.groupId).toBe(""); // 舊的快照沒被動到
    expect((await readSettings(dir)).line.groupId).toBe("C1");
    expect(await modeOf(join(dir, SETTINGS_FILE_NAME))).toBe(0o600);
    expect(await readdir(dir)).toEqual([SETTINGS_FILE_NAME]);
    expect(Object.isFrozen(store.data)).toBe(true);
    expect(Object.isFrozen(store.data.line)).toBe(true);
    expect(Object.isFrozen(store.data.lineCaptured)).toBe(true);
    expect(() => {
      (store.data.line as { groupId: string }).groupId = "hack";
    }).toThrow(TypeError);
  });

  it("連續 30 次變更依序完成：最後一個生效，沒有殘留的暫存檔", async () => {
    const dir = await makeTempDir();
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        store.update((draft) => {
          draft.line.groupName = `名稱-${i}`;
        }),
      ),
    );
    const saved = await readSettings(dir);
    expect(saved.line.groupName).toBe("名稱-29"); // 依序執行，最後一個生效
    expect(await readdir(dir)).toEqual([SETTINGS_FILE_NAME]);
  });

  it("同時進來的變更排成佇列依序執行，不會互相覆蓋（各改不同欄位，結果全部保留）", async () => {
    const dir = await makeTempDir();
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    await Promise.all([
      store.update((d) => void (d.line.channelAccessToken = "T")),
      store.update((d) => void (d.line.channelSecret = "S")),
      store.update((d) => void (d.line.groupId = "C9")),
      store.update((d) => void (d.lineCaptured = [{ groupId: "C7", groupName: "", eventType: "join", lastSeenAt: "" }])),
    ]);
    const saved = await readSettings(dir);
    expect(saved.line).toMatchObject({ channelAccessToken: "T", channelSecret: "S", groupId: "C9" });
    expect(saved.lineCaptured).toHaveLength(1);
    expect(store.data.line.channelSecret).toBe("S");
  });

  it("mutator 丟例外：整次作廢，檔案與記憶體都不變，後面的變更照常執行", async () => {
    const dir = await makeTempDir();
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    const fileBefore = await readFile(join(dir, SETTINGS_FILE_NAME), "utf8");
    await expect(
      store.update((draft) => {
        draft.line.groupId = "C-half-done";
        throw new ServiceError(409, "衝突");
      }),
    ).rejects.toMatchObject({ status: 409, message: "衝突" });
    expect(store.data.line.groupId).toBe("");
    expect(await readFile(join(dir, SETTINGS_FILE_NAME), "utf8")).toBe(fileBefore);

    await store.update((draft) => {
      draft.line.groupId = "C2";
    });
    expect(store.data.line.groupId).toBe("C2");
  });

  it.skipIf(isRoot)("寫檔失敗：丟 500、記憶體維持原樣、log 有一行 error，目錄恢復可寫後可以繼續", async () => {
    const dir = await makeTempDir();
    const log = createCapturingLogger();
    const store = await SettingsStore.open(dir, { log });
    await chmod(dir, 0o500); // 目錄變成唯讀：建不了暫存檔
    await expect(
      store.update((draft) => {
        draft.line.groupId = "C1";
      }),
    ).rejects.toMatchObject({ status: 500, message: "寫入設定檔失敗，請確認 Volume 可寫入" });
    expect(store.data.line.groupId).toBe("");
    expect(log.lines.some((line) => line.includes("寫入 settings.json 失敗"))).toBe(true);

    await chmod(dir, 0o700);
    await store.update((draft) => {
      draft.line.groupId = "C3";
    });
    expect(store.data.line.groupId).toBe("C3");
    expect((await readSettings(dir)).line.groupId).toBe("C3");
  });
});

/** 一筆合法的管理員資料（測試損毀案例時拿來改壞其中一個欄位）。 */
function validAdmin(): Record<string, unknown> {
  return {
    id: "a".repeat(32),
    name: "管理員",
    email: "admin@example.test",
    passwordHash: "scrypt$16384$8$1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
    status: "active",
    sessionVersion: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastLoginAt: null,
  };
}

describe("SettingsStore.open：損毀的設定檔", () => {
  const FIXED_NOW = Date.parse("2026-10-05T10:45:30.123Z");

  it("不是 JSON：備份成 settings.json.corrupt-<時間>（內容原樣、權限 0600），以空設定重新開始並寫出新檔，log 有說明", async () => {
    const dir = await makeTempDir();
    const file = join(dir, SETTINGS_FILE_NAME);
    await writeFile(file, '{"version":1, "admin": {broken', { mode: 0o644 });
    const log = createCapturingLogger();

    const store = await SettingsStore.open(dir, { log, now: () => FIXED_NOW });
    expect(store.writable).toBe(true);
    expect(store.data.admin).toBeNull();

    const backup = `${file}.corrupt-20261005T104530Z`;
    expect(await readFile(backup, "utf8")).toBe('{"version":1, "admin": {broken');
    expect(await modeOf(backup)).toBe(0o600);
    expect((await readSettings(dir)).version).toBe(2); // 新檔
    expect(log.lines.join("\n")).toContain("內容損毀");
    expect(log.lines.join("\n")).toContain("settings.json.corrupt-20261005T104530Z");
    expect((await readdir(dir)).sort()).toEqual([SETTINGS_FILE_NAME, "settings.json.corrupt-20261005T104530Z"]);
  });

  it("備份檔名已存在：加序號，不蓋掉舊備份", async () => {
    const dir = await makeTempDir();
    const file = join(dir, SETTINGS_FILE_NAME);
    await writeFile(`${file}.corrupt-20261005T104530Z`, "舊備份");
    await writeFile(file, "壞掉了");
    await SettingsStore.open(dir, { log: createCapturingLogger(), now: () => FIXED_NOW });
    expect(await readFile(`${file}.corrupt-20261005T104530Z`, "utf8")).toBe("舊備份");
    expect(await readFile(`${file}.corrupt-20261005T104530Z-1`, "utf8")).toBe("壞掉了");
  });

  it("修好之後再重新開啟：不會再產生備份", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, SETTINGS_FILE_NAME), "nope");
    await SettingsStore.open(dir, { log: createCapturingLogger(), now: () => FIXED_NOW });
    await SettingsStore.open(dir, { log: createCapturingLogger(), now: () => FIXED_NOW + 1000 });
    const backups = (await readdir(dir)).filter((name) => name.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
  });

  const baseSecret = "a".repeat(64);
  it.each([
    ["版本不認得（未來的版本）", { version: 3, sessionSecret: baseSecret }],
    ["版本不認得（0）", { version: 0, sessionSecret: baseSecret }],
    ["版本是字串", { version: "2", sessionSecret: baseSecret }],
    ["沒有 version", { sessionSecret: baseSecret }],
    ["根不是物件（陣列）", []],
    ["根是字串", "settings"],
    ["sessionSecret 太短", { version: 1, sessionSecret: "abc" }],
    ["sessionSecret 不是十六進位", { version: 1, sessionSecret: "z".repeat(64) }],
    ["缺少 sessionSecret", { version: 1 }],
    ["admin 不是物件", { version: 1, sessionSecret: baseSecret, admin: "x" }],
    ["admin.passwordHash 不是 scrypt 格式", { version: 1, sessionSecret: baseSecret, admin: { passwordHash: "plain", updatedAt: "" } }],
    ["line 不是物件", { version: 1, sessionSecret: baseSecret, line: "x" }],
    ["line.channelAccessToken 型別錯誤", { version: 1, sessionSecret: baseSecret, line: { channelAccessToken: 123 } }],
    ["line.enabled 不是布林", { version: 1, sessionSecret: baseSecret, line: { enabled: "yes" } }],
    ["lineCaptured 不是陣列", { version: 1, sessionSecret: baseSecret, lineCaptured: {} }],
    ["admins 不是陣列", { version: 2, sessionSecret: baseSecret, admins: {} }],
    ["admins 裡有不是物件的項目", { version: 2, sessionSecret: baseSecret, admins: ["x"] }],
    ["管理員的 id 格式不對", { version: 2, sessionSecret: baseSecret, admins: [{ ...validAdmin(), id: "short" }] }],
    ["管理員缺少姓名", { version: 2, sessionSecret: baseSecret, admins: [{ ...validAdmin(), name: undefined }] }],
    ["管理員的 Email 是空的", { version: 2, sessionSecret: baseSecret, admins: [{ ...validAdmin(), email: "  " }] }],
    ["管理員的密碼雜湊不是 scrypt 格式", { version: 2, sessionSecret: baseSecret, admins: [{ ...validAdmin(), passwordHash: "plain" }] }],
    ["管理員的狀態不是 active／disabled", { version: 2, sessionSecret: baseSecret, admins: [{ ...validAdmin(), status: "banned" }] }],
    ["管理員的 sessionVersion 不是正整數", { version: 2, sessionSecret: baseSecret, admins: [{ ...validAdmin(), sessionVersion: 0 }] }],
    ["管理員的 sessionVersion 是小數", { version: 2, sessionSecret: baseSecret, admins: [{ ...validAdmin(), sessionVersion: 1.5 }] }],
    ["管理員的 sessionVersion 是字串", { version: 2, sessionSecret: baseSecret, admins: [{ ...validAdmin(), sessionVersion: "1" }] }],
    ["兩位管理員的 id 重複", { version: 2, sessionSecret: baseSecret, admins: [validAdmin(), { ...validAdmin(), email: "other@example.test" }] }],
    ["兩位管理員的 Email 重複（不分大小寫）", { version: 2, sessionSecret: baseSecret, admins: [validAdmin(), { ...validAdmin(), id: "f".repeat(32), email: "ADMIN@Example.test" }] }],
  ])("結構性問題（%s）視為損毀", async (_name, content) => {
    const dir = await makeTempDir();
    await writeFile(join(dir, SETTINGS_FILE_NAME), JSON.stringify(content));
    const store = await SettingsStore.open(dir, { log: createCapturingLogger(), now: () => FIXED_NOW });
    expect(store.writable).toBe(true);
    expect(store.data.admin).toBeNull();
    expect((await readdir(dir)).some((name) => name.includes(".corrupt-"))).toBe(true);
  });
});

describe("parseSettingsText", () => {
  const secret = "b".repeat(64);

  it("缺少的選填欄位補預設值（版本 1 沒有 admins：視為空陣列，版本維持 1）", () => {
    const parsed = parseSettingsText(JSON.stringify({ version: 1, sessionSecret: secret }));
    expect(parsed).toEqual({
      version: 1,
      admin: null,
      admins: [],
      sessionSecret: secret,
      line: { enabled: true, channelAccessToken: "", channelSecret: "", groupId: "", groupName: "", updatedAt: "" },
      lineCaptured: [],
    });
  });

  it("版本 2 缺少 admins（忘記密碼時手動刪掉）或 admins 是空陣列：都視為沒有管理員，版本維持 2，其他欄位原樣", () => {
    for (const admins of [undefined, []]) {
      const parsed = parseSettingsText(JSON.stringify({ version: 2, sessionSecret: secret, ...(admins === undefined ? {} : { admins }), line: { enabled: false, groupId: "C1" } }));
      expect(parsed).toMatchObject({ version: 2, admin: null, admins: [], sessionSecret: secret, line: { enabled: false, groupId: "C1" } });
    }
  });

  it("lineCaptured：格式不對的項目略過、最多留 10 筆、缺的欄位補空字串", () => {
    const captured = [
      ...Array.from({ length: 14 }, (_, i) => ({ groupId: `C${i}`, groupName: `g${i}`, eventType: "join", lastSeenAt: "2026-10-05T00:00:00.000Z" })),
    ];
    const withJunk = [null, 5, "x", { groupName: "沒有 groupId" }, { groupId: "" }, { groupId: "C".repeat(65) }, ...captured, { groupId: "C-after" }];
    const parsed = parseSettingsText(JSON.stringify({ version: 1, sessionSecret: secret, lineCaptured: withJunk }));
    expect(parsed?.lineCaptured).toHaveLength(CAPTURED_GROUPS_MAX);
    expect(parsed?.lineCaptured[0]).toEqual({ groupId: "C0", groupName: "g0", eventType: "join", lastSeenAt: "2026-10-05T00:00:00.000Z" });

    const sparse = parseSettingsText(JSON.stringify({ version: 1, sessionSecret: secret, lineCaptured: [{ groupId: "C5" }] }));
    expect(sparse?.lineCaptured).toEqual([{ groupId: "C5", groupName: "", eventType: "", lastSeenAt: "" }]);
  });

  it("不是 JSON 回 null", () => {
    expect(parseSettingsText("")).toBeNull();
    expect(parseSettingsText("not json")).toBeNull();
  });

  it("版本 2：admins 載入時 Email 正規化（trim＋小寫）、lastLoginAt 缺少或不是字串就是 null、createdAt／updatedAt 缺少補空字串", () => {
    const parsed = parseSettingsText(
      JSON.stringify({
        version: 2,
        sessionSecret: secret,
        admins: [{ ...validAdmin(), email: "  Admin@EXAMPLE.test ", lastLoginAt: 123, createdAt: undefined, updatedAt: undefined }, { ...validAdmin(), id: "b".repeat(32), email: "b@example.test", status: "disabled", sessionVersion: 7, lastLoginAt: "2026-10-04T00:00:00.000Z" }],
      }),
    );
    expect(parsed?.version).toBe(2);
    expect(parsed?.admin).toBeNull();
    expect(parsed?.admins).toEqual([
      { ...validAdmin(), email: "admin@example.test", lastLoginAt: null, createdAt: "", updatedAt: "" },
      { ...validAdmin(), id: "b".repeat(32), email: "b@example.test", status: "disabled", sessionVersion: 7, lastLoginAt: "2026-10-04T00:00:00.000Z" },
    ]);
  });

  it("版本 1 的舊檔：admin（舊的單一密碼）原樣讀進來、admins 是空陣列", () => {
    const hash = "scrypt$16384$8$1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA";
    const parsed = parseSettingsText(JSON.stringify({ version: 1, sessionSecret: secret, admin: { passwordHash: hash, updatedAt: "2026-10-01T00:00:00.000Z" } }));
    expect(parsed).toMatchObject({ version: 1, admin: { passwordHash: hash, updatedAt: "2026-10-01T00:00:00.000Z" }, admins: [] });
  });

  describe("不認識的欄位原樣保留（載入、修改、寫回去都不會掉）", () => {
    const rich = (): Record<string, unknown> => ({
      version: 2,
      sessionSecret: secret,
      futureTopLevel: { nested: [1, 2, { deep: true }] },
      admins: [{ ...validAdmin(), futureAdminField: "keep-me", avatar: { url: "x" } }],
      line: { enabled: true, channelAccessToken: "t", futureLineField: 42 },
      lineCaptured: [{ groupId: "C1", groupName: "甲", eventType: "join", lastSeenAt: "x", futureCapturedField: "keep" }],
    });

    it("parseSettingsText：頂層、各管理員帳號、line、lineCaptured 的每一筆都保留", () => {
      const parsed = parseSettingsText(JSON.stringify(rich()))!;
      expect((parsed as unknown as Record<string, unknown>).futureTopLevel).toEqual({ nested: [1, 2, { deep: true }] });
      expect((parsed.admins[0] as unknown as Record<string, unknown>).futureAdminField).toBe("keep-me");
      expect((parsed.admins[0] as unknown as Record<string, unknown>).avatar).toEqual({ url: "x" });
      expect((parsed.line as unknown as Record<string, unknown>).futureLineField).toBe(42);
      expect((parsed.lineCaptured[0] as unknown as Record<string, unknown>).futureCapturedField).toBe("keep");
    });

    it("舊的單一密碼（admin）裡不認識的欄位也保留（直到升級把它刪掉）", () => {
      const parsed = parseSettingsText(JSON.stringify({ version: 1, sessionSecret: secret, admin: { passwordHash: "scrypt$x", updatedAt: "u", note: "legacy-extra" } }))!;
      expect((parsed.admin as unknown as Record<string, unknown>).note).toBe("legacy-extra");
    });

    it("`__proto__` 之類危險的鍵不會被帶進去（也不會污染原型）", () => {
      const parsed = parseSettingsText(`{"version":2,"sessionSecret":"${secret}","__proto__":{"polluted":true},"line":{"__proto__":{"polluted":true}}}`)!;
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      expect((parsed as unknown as Record<string, unknown>).polluted).toBeUndefined();
      expect((parsed.line as unknown as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("真的檔案：open → update（改別的欄位）→ 檔案裡所有不認識的欄位都還在", async () => {
      const dir = await makeTempDir();
      await writeFile(join(dir, SETTINGS_FILE_NAME), `${JSON.stringify(rich(), null, 2)}\n`);
      const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
      await store.update((draft) => {
        draft.line.groupId = "C9";
        draft.admins[0]!.lastLoginAt = "2026-10-05T00:00:00.000Z";
      });
      const saved = await readSettings(dir);
      expect(saved.futureTopLevel).toEqual({ nested: [1, 2, { deep: true }] });
      expect(saved.admins[0].futureAdminField).toBe("keep-me");
      expect(saved.admins[0].avatar).toEqual({ url: "x" });
      expect(saved.admins[0].lastLoginAt).toBe("2026-10-05T00:00:00.000Z");
      expect(saved.line.futureLineField).toBe(42);
      expect(saved.line.groupId).toBe("C9");
      expect(saved.lineCaptured[0].futureCapturedField).toBe("keep");
    });
  });
});

describe("檔案格式版本：1（舊的單一密碼）→ 2（管理員帳號）", () => {
  const LEGACY_HASH = "scrypt$16384$8$1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA";
  const legacyFile = (extra: Record<string, unknown> = {}) => ({
    version: 1,
    admin: { passwordHash: LEGACY_HASH, updatedAt: "2026-10-01T00:00:00.000Z" },
    sessionSecret: "c".repeat(64),
    line: { enabled: true, channelAccessToken: "line-token-xyz", channelSecret: "line-secret-xyz", groupId: "C0123456789abcdef0123456789abcdef", groupName: "倉庫", updatedAt: "2026-10-02T00:00:00.000Z" },
    lineCaptured: [{ groupId: "C0123456789abcdef0123456789abcdef", groupName: "倉庫", eventType: "join", lastSeenAt: "2026-10-03T00:00:00.000Z" }],
    ...extra,
  });

  it("版本 1 的檔案開啟時完全不動（內容與修改時間都不變）", async () => {
    const dir = await makeTempDir();
    const file = join(dir, SETTINGS_FILE_NAME);
    const text = `${JSON.stringify(legacyFile(), null, 2)}\n`;
    await writeFile(file, text, { mode: 0o600 });
    const before = (await stat(file)).mtimeMs;
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    expect(store.data.version).toBe(1);
    expect(store.data.admin?.passwordHash).toBe(LEGACY_HASH);
    expect(store.data.admins).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(text);
    expect((await stat(file)).mtimeMs).toBe(before);
  });

  it("還沒有管理員帳號時，其他變更（LINE 設定、webhook 記錄群組）不會改版本：維持版本 1、保留舊的 admin（升級前回滾到舊版程式仍讀得懂）", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, SETTINGS_FILE_NAME), JSON.stringify(legacyFile()));
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    await store.update((draft) => {
      draft.lineCaptured.unshift({ groupId: "C2", groupName: "乙", eventType: "message", lastSeenAt: "2026-10-05T00:00:00.000Z" });
    });
    const saved = await readSettings(dir);
    expect(saved.version).toBe(1);
    expect(saved.admin).toEqual({ passwordHash: LEGACY_HASH, updatedAt: "2026-10-01T00:00:00.000Z" });
    expect(saved.sessionSecret).toBe("c".repeat(64));
    expect(saved.line.channelAccessToken).toBe("line-token-xyz");
  });

  it("加進第一位管理員的那一次寫入：版本變 2、舊的 admin 同時消失；line、lineCaptured、sessionSecret 與不認識的欄位原封不動", async () => {
    const dir = await makeTempDir();
    const original = legacyFile({ futureField: { keep: "me" } });
    await writeFile(join(dir, SETTINGS_FILE_NAME), JSON.stringify(original));
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    await store.update((draft) => {
      draft.admins.push({ ...(validAdmin() as unknown as AdminAccount), passwordHash: LEGACY_HASH });
    });
    const saved = await readSettings(dir);
    expect(saved.version).toBe(2);
    expect("admin" in saved).toBe(false); // 舊的單一密碼整個欄位都不寫了
    expect(saved.admins).toHaveLength(1);
    expect(saved.admins[0].passwordHash).toBe(LEGACY_HASH); // 沿用同一個雜湊
    expect(saved.sessionSecret).toBe(original.sessionSecret);
    expect(saved.line).toEqual(original.line);
    expect(saved.lineCaptured).toEqual(original.lineCaptured);
    expect(saved.futureField).toEqual({ keep: "me" });
    expect(store.data.version).toBe(2);
    expect(store.data.admin).toBeNull();
  });

  it("版本 2 的檔案裡殘留舊的 admin（手動編輯出來的怪狀態）：下一次寫入時丟掉它", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, SETTINGS_FILE_NAME), JSON.stringify({ version: 2, sessionSecret: "d".repeat(64), admin: { passwordHash: LEGACY_HASH, updatedAt: "" }, admins: [validAdmin()] }));
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    await store.update((draft) => {
      draft.line.groupId = "C1";
    });
    expect("admin" in (await readSettings(dir))).toBe(false);
  });

  it("全新安裝的檔案是版本 2、沒有 admin 欄位；之後新增管理員仍是版本 2", async () => {
    const dir = await makeTempDir();
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    expect(store.data.version).toBe(2);
    expect("admin" in (await readSettings(dir))).toBe(false);
    await store.update((draft) => {
      draft.admins.push(validAdmin() as unknown as AdminAccount);
    });
    expect((await readSettings(dir)).version).toBe(2);
  });

  it("serializeSettings：admin 是 null 就不寫出該欄位；有值就寫", () => {
    const base = newSettingsData();
    expect("admin" in JSON.parse(serializeSettings(base))).toBe(false);
    const legacy = { ...base, version: 1 as const, admin: { passwordHash: LEGACY_HASH, updatedAt: "u" } };
    expect(JSON.parse(serializeSettings(legacy)).admin).toEqual({ passwordHash: LEGACY_HASH, updatedAt: "u" });
    expect(serializeSettings(base).endsWith("}\n")).toBe(true);
  });
});

describe("SettingsStore：資料目錄不可用", () => {
  it("SettingsStore.unavailable()：writable 為 false、設定是空的、update 一律丟 503", async () => {
    const store = SettingsStore.unavailable();
    expect(store.writable).toBe(false);
    expect(store.mounted).toBeNull();
    expect(store.data.admin).toBeNull();
    expect(store.data.line.channelAccessToken).toBe("");
    await expect(store.update(() => undefined)).rejects.toMatchObject({ status: 503, message: DATA_DIR_UNAVAILABLE_MESSAGE });
  });

  it("訊息固定是「請在 Zeabur 掛載 Volume 到 /app/data」", () => {
    expect(DATA_DIR_UNAVAILABLE_MESSAGE).toBe("請在 Zeabur 掛載 Volume 到 /app/data");
  });

  it("資料目錄的上層是一般檔案（建不了目錄）：不可用，log 有 error 與掛載 Volume 的提示，不丟例外", async () => {
    const root = await makeTempDir();
    const blocker = join(root, "i-am-a-file");
    await writeFile(blocker, "x");
    const log = createCapturingLogger();
    const store = await SettingsStore.open(join(blocker, "data"), { log });
    expect(store.writable).toBe(false);
    const text = log.lines.join("\n");
    expect(text).toContain("不可用");
    expect(text).toContain("請在 Zeabur 掛載 Volume 到 /app/data");
    await expect(store.update(() => undefined)).rejects.toMatchObject({ status: 503 });
  });

  it.skipIf(isRoot)("目錄唯讀（寫入探測失敗）：不可用，且不會留下任何檔案", async () => {
    const dir = await makeTempDir();
    await chmod(dir, 0o500);
    const log = createCapturingLogger();
    const store = await SettingsStore.open(dir, { log });
    expect(store.writable).toBe(false);
    expect(log.lines.join("\n")).toContain("無法寫入");
    await chmod(dir, 0o700);
    expect(await readdir(dir)).toEqual([]);
  });

  it("settings.json 是目錄（讀取失敗、不是「不存在」）：不可用，也不去動它", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, SETTINGS_FILE_NAME));
    const log = createCapturingLogger();
    const store = await SettingsStore.open(dir, { log });
    expect(store.writable).toBe(false);
    expect(log.lines.join("\n")).toContain("無法讀取 settings.json");
    expect((await stat(join(dir, SETTINGS_FILE_NAME))).isDirectory()).toBe(true);
  });
});

describe("Volume 偵測（findMountPoint）", () => {
  const mountinfo = [
    "1 0 0:46 / / rw,relatime - overlay overlay rw",
    "2 1 0:47 / /proc rw,nosuid - proc proc rw",
    "3 1 0:48 / /dev rw,nosuid - tmpfs tmpfs rw",
    "4 1 8:1 / /app/data rw,relatime - ext4 /dev/sda1 rw",
    "5 1 8:2 / /mnt/my\\040disk rw,relatime - ext4 /dev/sdb1 rw",
    "",
  ].join("\n");

  it("路徑在獨立掛載點底下：回傳最深的掛載點", () => {
    expect(findMountPoint(mountinfo, "/app/data")).toBe("/app/data");
    expect(findMountPoint(mountinfo, "/app/data/sub/dir")).toBe("/app/data");
  });

  it("沒有獨立掛載：回傳根目錄", () => {
    expect(findMountPoint(mountinfo, "/app/other")).toBe("/");
    expect(findMountPoint(mountinfo, "/home/user/data")).toBe("/");
  });

  it("只是名稱開頭相同不算（/app/data2 不在 /app/data 底下）", () => {
    expect(findMountPoint(mountinfo, "/app/data2")).toBe("/");
    expect(findMountPoint(mountinfo, "/app/dat")).toBe("/");
  });

  it("掛載點裡的八進位跳脫（\\040＝空白）會還原", () => {
    expect(findMountPoint(mountinfo, "/mnt/my disk/x")).toBe("/mnt/my disk");
  });

  it("沒有任何資料（空字串、格式不對）回 null", () => {
    expect(findMountPoint("", "/app/data")).toBeNull();
    expect(findMountPoint("garbage\nmore garbage", "/app/data")).toBeNull();
  });
});

describe("SettingsStore.open：mounted 欄位", () => {
  it("在非 Linux 判斷不出來是 null；在 Linux 是布林或 null（取決於測試環境），絕不丟例外", async () => {
    const store = await SettingsStore.open(await makeTempDir(), { log: createCapturingLogger() });
    if (process.platform !== "linux") expect(store.mounted).toBeNull();
    else expect([true, false, null]).toContain(store.mounted);
  });
});

describe("SettingsStore.open：收緊權限、清殘留暫存檔、容忍 BOM", () => {
  it("既有的 settings.json 權限太寬（0644，例如別的工具放的）：開啟時就收成 0600，不等到下一次寫入", async () => {
    const dir = await makeTempDir();
    const file = join(dir, SETTINGS_FILE_NAME);
    await writeFile(file, `${JSON.stringify(newSettingsData(), null, 2)}\n`, { mode: 0o644 });
    await chmod(file, 0o644);
    expect(await modeOf(file)).toBe(0o644);
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    expect(store.writable).toBe(true);
    expect(await modeOf(file)).toBe(0o600);
  });

  it("新建的資料目錄權限是 0700（只影響這次新建的；已存在的目錄不動）", async () => {
    const root = await makeTempDir();
    await SettingsStore.open(join(root, "fresh", "data"), { log: createCapturingLogger() });
    expect(await modeOf(join(root, "fresh"))).toBe(0o700);
    expect(await modeOf(join(root, "fresh", "data"))).toBe(0o700);

    const existing = await makeTempDir();
    await chmod(existing, 0o755);
    await SettingsStore.open(existing, { log: createCapturingLogger() });
    expect(await modeOf(existing)).toBe(0o755);
  });

  it(`殘留的暫存檔（被強制結束的寫入、寫入探測）超過 ${STALE_TEMP_MS / 60_000} 分鐘沒動過就清掉；新的與不相干的檔案不動`, async () => {
    const dir = await makeTempDir();
    const old = new Date(Date.now() - STALE_TEMP_MS - 60_000);
    const stale = [".settings.json.12345.abcd1234.tmp", ".write-probe-999-deadbeef"];
    const keep = [".settings.json.54321.fresh000.tmp", ".write-probe-1-fresh", "notes.txt", ".settings.json.bak"];
    for (const name of [...stale, ...keep]) await writeFile(join(dir, name), "x");
    for (const name of [...stale, "notes.txt", ".settings.json.bak"]) await utimes(join(dir, name), old, old);
    await mkdir(join(dir, ".write-probe-dir")); // 名稱像暫存檔但是目錄：不動
    await utimes(join(dir, ".write-probe-dir"), old, old);

    await SettingsStore.open(dir, { log: createCapturingLogger() });
    const names = await readdir(dir);
    for (const name of stale) expect(names).not.toContain(name);
    for (const name of [...keep, ".write-probe-dir"]) expect(names).toContain(name);
    expect(names).toContain(SETTINGS_FILE_NAME);
  });

  it("寫入暫存檔後失敗（rename 失敗）：暫存檔會被刪掉，不留下含 token 的殘檔", async () => {
    const dir = await makeTempDir();
    const log = createCapturingLogger();
    const store = await SettingsStore.open(dir, { log });
    // 把 settings.json 換成「非空的目錄」：rename 蓋不過去（EISDIR／ENOTEMPTY），但暫存檔已經建好了
    await rm(join(dir, SETTINGS_FILE_NAME));
    await mkdir(join(dir, SETTINGS_FILE_NAME));
    await writeFile(join(dir, SETTINGS_FILE_NAME, "inside"), "x");
    await expect(
      store.update((draft) => {
        draft.line.channelAccessToken = "token-that-must-not-linger";
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(store.data.line.channelAccessToken).toBe("");
    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(log.lines.join("\n")).not.toContain("token-that-must-not-linger");
  });

  it.skipIf(isRoot)("目錄唯讀、但 settings.json 已經存在且有效：寫入探測失敗，不可用（不會假裝可以寫）", async () => {
    const dir = await makeTempDir();
    await SettingsStore.open(dir, { log: createCapturingLogger() }); // 先建好有效的檔案
    await chmod(dir, 0o500);
    const log = createCapturingLogger();
    const store = await SettingsStore.open(dir, { log });
    await chmod(dir, 0o700);
    expect(store.writable).toBe(false);
    expect(log.lines.join("\n")).toContain("無法寫入");
    await expect(store.update(() => undefined)).rejects.toMatchObject({ status: 503 });
  });

  it("檔案開頭有 BOM（有些編輯器會加）的有效 JSON：照常載入，不當成損毀、不產生備份", async () => {
    const dir = await makeTempDir();
    const data = newSettingsData();
    data.line.groupId = "C-from-bom-file";
    await writeFile(join(dir, SETTINGS_FILE_NAME), `\uFEFF${JSON.stringify(data, null, 2)}\n`);
    const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
    expect(store.data.line.groupId).toBe("C-from-bom-file");
    expect((await readdir(dir)).filter((n) => n.includes(".corrupt-"))).toEqual([]);
  });
});
