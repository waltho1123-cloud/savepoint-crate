import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_MAX_COUNT,
  assertNotLastActiveAdmin,
  EMAIL_MAX_CHARS,
  emailTaken,
  normalizeEmail,
  otherActiveAdminCount,
  parseName,
  parseNewAccountInput,
  parseRole,
  requireActorInDraft,
  requireAdminInDraft,
  roleLabel,
  summarizeAccounts,
} from "../src/accounts.js";
import * as auth from "../src/auth.js";
import { SESSION_COOKIE_NAME } from "../src/auth.js";
import { newSettingsData } from "../src/settings-store.js";
import {
  accountId,
  call,
  cleanupTempDirs,
  cookiePair,
  makeAccount,
  makeSettingsApp,
  NOW_MS,
  setCookieOf,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_ID,
  TEST_ADMIN_NAME,
  TEST_ADMIN_PASSWORD,
  type SettingsApp,
} from "./settings-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

const GOOD_PASSWORD = "a-brand-new-password-42";
const SECOND = accountId(2);
const THIRD = accountId(3);
const NOT_FOUND = accountId(99);
let ipCounter = 0;
/** 每次呼叫都換一個來源 IP：迴圈裡連續送很多次請求時，不要被逐 IP 的限流擋住。 */
const freshIp = () => ({ "x-forwarded-for": `198.19.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` });

const second = (overrides = {}) => makeAccount({ id: SECOND, name: "第二位", email: "second@example.test", ...overrides });
const third = (overrides = {}) => makeAccount({ id: THIRD, name: "第三位", email: "third@example.test", ...overrides });
const adminsOf = async (ctx: SettingsApp) => (JSON.parse(await readFile(join(ctx.dir, "settings.json"), "utf8")) as { accounts: Array<Record<string, any>> }).accounts;
/** 新增帳號的請求內容（預設建立管理員：很多流程要拿新帳號當操作者；一般使用者用 role: "user" 覆蓋）。 */
const newBody = (overrides: Record<string, unknown> = {}) => ({ name: "新管理員", email: "new.admin@example.test", role: "admin", password: GOOD_PASSWORD, ...overrides });

describe("純函式：Email 正規化與驗證（normalizeEmail）", () => {
  it.each([
    ["admin@example.com", "admin@example.com"],
    ["  Admin@Example.COM  ", "admin@example.com"],
    ["first.last@sub.example.co.uk", "first.last@sub.example.co.uk"],
    ["user+tag@example.com", "user+tag@example.com"],
    ["a_b-c@example.com", "a_b-c@example.com"],
    ["o'brien@example.com", "o'brien@example.com"],
    ["!#$%&'*+/=?^_`{|}~-@example.com", "!#$%&'*+/=?^_`{|}~-@example.com"],
    ["x@a-b.example.com", "x@a-b.example.com"],
    ["x@123.example.com", "x@123.example.com"],
    ["x@xn--fiq228c.example.com", "x@xn--fiq228c.example.com"],
  ])("合法：%s → %s", (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });

  it.each([
    ["空字串", ""],
    ["只有空白", "   "],
    ["沒有 @", "plainaddress"],
    ["兩個 @", "a@@example.com"],
    ["兩個 @（本地部分帶 @）", "a@b@example.com"],
    ["沒有本地部分", "@example.com"],
    ["沒有網域", "user@"],
    ["網域只有一段", "user@localhost"],
    ["網域以點開頭", "user@.example.com"],
    ["網域以點結尾", "user@example.com."],
    ["網域有連續的點", "user@example..com"],
    ["本地部分以點開頭", ".user@example.com"],
    ["本地部分以點結尾", "user.@example.com"],
    ["本地部分有連續的點", "us..er@example.com"],
    ["網域的標籤以連字號開頭", "user@-example.com"],
    ["網域的標籤以連字號結尾", "user@example-.com"],
    ["網域含底線", "user@exam_ple.com"],
    ["最後一段全是數字（像 IP）", "user@1.2.3.4"],
    ["含空白", "us er@example.com"],
    ["含括號與逗號", "(user)@example.com, other@example.com"],
    ["含引號", 'us"er@example.com'],
    ["含換行", "user@example.com\nBcc: x@example.com"],
    ["含非 ASCII（中文）", "使用者@example.com"],
    ["含非 ASCII（網域）", "user@例え.jp"],
    ["本地部分超過 64 字元", `${"a".repeat(65)}@example.com`],
    ["標籤超過 63 字元", `user@${"a".repeat(64)}.com`],
    ["整體超過 254 字元", `a@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(61)}`],
  ])("不合法：%s", (_name, raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });

  it("不是字串一律不合法", () => {
    for (const value of [undefined, null, 123, {}, [], true]) expect(normalizeEmail(value)).toBeNull();
  });

  it(`長度邊界：本地部分剛好 64 字元、整體剛好 ${EMAIL_MAX_CHARS} 字元合法，多一個字就不合法`, () => {
    expect(normalizeEmail(`${"a".repeat(64)}@example.com`)).not.toBeNull();
    expect(normalizeEmail(`${"a".repeat(65)}@example.com`)).toBeNull();
    // a@ + 三個 63 字元的標籤 + 一個 60 字元的標籤（含 3 個點）＝ 2 + 252 ＝ 254（每個標籤都在 63 以內，最後一段全是字母）
    const l63 = "x".repeat(63);
    const exact = `a@${l63}.${l63}.${l63}.${"y".repeat(60)}`;
    expect(exact).toHaveLength(EMAIL_MAX_CHARS);
    expect(normalizeEmail(exact)).toBe(exact);
    expect(normalizeEmail(`${exact}y`)).toBeNull(); // 255 字元
  });

  it("大小寫混合、前後空白：結果一律是小寫、無空白（唯一性比對用的就是這個值）", () => {
    expect(normalizeEmail("  MiXeD.Case@ExAmPlE.CoM\t")).toBe("mixed.case@example.com");
  });
});

describe("純函式：姓名驗證（parseName）", () => {
  it("trim 後 1～50 個字元合法；emoji 與中文以「字元」計，一個 emoji 算 1", () => {
    expect(parseName("  王小明 ")).toEqual({ ok: true, value: "王小明" });
    expect(parseName("a")).toEqual({ ok: true, value: "a" });
    expect(parseName("x".repeat(50))).toEqual({ ok: true, value: "x".repeat(50) });
    expect(parseName("👍".repeat(50))).toEqual({ ok: true, value: "👍".repeat(50) }); // 50 個 emoji（每個 2 個 UTF-16 單位）
    expect(parseName("王".repeat(50)).ok).toBe(true);
  });

  it("零寬連字／零寬非連字在「有看得見的字」的前提下可以出現（表情符號序列與部分文字需要它們）", () => {
    expect(parseName("👨\u200D👩\u200D👧").ok).toBe(true); // 家庭表情符號序列
    expect(parseName("می\u200Cخواهم")).toEqual({ ok: true, value: "می\u200Cخواهم" }); // 波斯文
    expect(parseName("王\u00AD小明").ok).toBe(true); // 軟連字號只是看不見，姓名裡有其他看得見的字
  });

  it.each([
    ["空字串", ""],
    ["只有空白", "  \t "],
    ["51 個字元", "x".repeat(51)],
    ["51 個 emoji", "👍".repeat(51)],
    ["含換行", "王\n小明"],
    ["含 Tab", "王\t小明"],
    ["含 NUL", "王\u0000小明"],
    ["含 DEL 之類的控制字元", "王\u007F小明"],
    ["含行分隔符號", "王 小明"],
    ["含段落分隔符號", "王 小明"],
    ["含雙向控制字元（可用來偽裝顯示順序）", "王‮小明"],
    ["含隔離用的雙向控制字元", "王⁦小明"],
    ["含左至右標記", "王‎小明"],
    ["只有零寬空白（看起來是空白的名字）", "\u200B"],
    ["只有零寬連字", "\u200D"],
    ["只有零寬非連字", "\u200C"],
    ["只有字詞連接符", "\u2060"],
    ["只有軟連字號", "\u00AD"],
    ["只有阿拉伯字母標記", "\u061C"],
    ["只有韓文填充字元", "\u3164"],
    ["韓文填充字元加空白", "\u3164 \u115F\u1160\uFFA0"],
    ["只有點字空白", "\u2800"],
    ["只有高棉文固有母音", "\u17B4\u17B5"],
    ["只有 BOM（trim 後是空的）", "\uFEFF"],
    ["文字中間夾零寬空白", "王\u200B小明"],
    ["文字中間夾字詞連接符", "王\u2060小明"],
    ["文字中間夾 BOM", "王\uFEFF小明"],
    ["文字中間夾蒙古文元音分隔符", "王\u180E小明"],
    ["文字中間夾阿拉伯字母標記", "王\u061C小明"],
    ["不是字串（數字）", 123],
    ["null", null],
    ["undefined", undefined],
    ["物件", { a: 1 }],
  ])("不合法：%s", (_name, raw) => {
    expect(parseName(raw)).toEqual({ ok: false, error: "姓名需為 1～50 個字元（不可含換行、控制字元或零寬字元，且要有看得見的字）" });
  });
});

describe("純函式：帳號規則的輔助（otherActiveAdminCount、emailTaken、requireActorInDraft）", () => {
  const draft = () => {
    const data = newSettingsData();
    data.accounts = [makeAccount(), second(), third({ status: "disabled" })];
    return data;
  };

  it("otherActiveAdminCount：不算指定的那一位、不算停用的", () => {
    const d = draft();
    expect(otherActiveAdminCount(d, TEST_ADMIN_ID)).toBe(1); // 只剩第二位啟用中
    expect(otherActiveAdminCount(d, SECOND)).toBe(1);
    expect(otherActiveAdminCount(d, THIRD)).toBe(2); // 停用的第三位不算，但被排除的就是它自己
    expect(otherActiveAdminCount(d, accountId(77))).toBe(2); // 不存在的 id：全部啟用中的
    d.accounts[1]!.status = "disabled";
    expect(otherActiveAdminCount(d, TEST_ADMIN_ID)).toBe(0);
  });

  it("emailTaken：已被使用（含停用的帳號）；排除自己", () => {
    const d = draft();
    expect(emailTaken(d, "second@example.test")).toBe(true);
    expect(emailTaken(d, "third@example.test")).toBe(true); // 停用的也算
    expect(emailTaken(d, "nobody@example.test")).toBe(false);
    expect(emailTaken(d, "second@example.test", SECOND)).toBe(false); // 自己的 Email 不算重複
    expect(emailTaken(d, "second@example.test", TEST_ADMIN_ID)).toBe(true);
  });

  it("requireActorInDraft：帳號還在、啟用中、sessionVersion 相符才通過，否則 401", () => {
    const d = draft();
    expect(requireActorInDraft(d, { id: SECOND, sessionVersion: 1 }).email).toBe("second@example.test");
    for (const actor of [{ id: SECOND, sessionVersion: 2 }, { id: THIRD, sessionVersion: 1 }, { id: accountId(77), sessionVersion: 1 }]) {
      expect(() => requireActorInDraft(d, actor)).toThrowError(expect.objectContaining({ status: 401 }) as never);
    }
  });
});

describe("純函式：角色相關（parseRole、roleLabel、parseNewAccountInput、assertNotLastActiveAdmin、requireAdminInDraft）", () => {
  it("parseRole：只有精確的 admin、user 合法", () => {
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("user")).toBe("user");
    for (const bad of ["Admin", "USER", " admin", "root", "", null, undefined, 1, true, ["admin"], { role: "admin" }]) expect(parseRole(bad), JSON.stringify(bad)).toBeNull();
  });

  it("roleLabel：admin＝管理員、user＝一般使用者", () => {
    expect(roleLabel("admin")).toBe("管理員");
    expect(roleLabel("user")).toBe("一般使用者");
  });

  it("parseNewAccountInput：沒給 role 用預設（API 預設 user、第一位管理員傳 admin）；給了要合法；驗證順序是姓名 → Email → 密碼 → 角色", () => {
    const base = { name: "甲", email: "a@example.test", password: GOOD_PASSWORD };
    expect(parseNewAccountInput(base).role).toBe("user");
    expect(parseNewAccountInput(base, "admin").role).toBe("admin");
    expect(parseNewAccountInput({ ...base, role: "admin" }).role).toBe("admin");
    expect(parseNewAccountInput({ ...base, role: "user" }, "admin").role).toBe("user"); // 有給就用給的
    expect(() => parseNewAccountInput({ ...base, role: "root" })).toThrowError(expect.objectContaining({ status: 400, message: "角色必須是 admin（管理員）或 user（一般使用者）" }) as never);
    expect(() => parseNewAccountInput({ ...base, role: null })).toThrowError(expect.objectContaining({ status: 400 }) as never);
    expect(() => parseNewAccountInput({ name: "", email: "bad", password: "x", role: "root" })).toThrowError(expect.objectContaining({ message: expect.stringContaining("姓名需為") }) as never);
    expect(() => parseNewAccountInput({ ...base, password: "x", role: "root" })).toThrowError(expect.objectContaining({ message: "密碼至少要 10 個字元" }) as never);
  });

  it("assertNotLastActiveAdmin：啟用中的管理員而且沒有其他啟用中的管理員 → 409（停用、刪除、降級各有自己的訊息）；有其他人、或對象是一般使用者／已停用，都放行", () => {
    const only = { accounts: [makeAccount()] };
    for (const action of ["停用", "刪除", "降級"] as const) {
      expect(() => assertNotLastActiveAdmin(only, only.accounts[0]!, action)).toThrowError(
        expect.objectContaining({ status: 409, message: `不能${action}最後一位啟用中的管理員` }) as never,
      );
    }
    // 其他的啟用中管理員存在
    const two = { accounts: [makeAccount(), second()] };
    expect(() => assertNotLastActiveAdmin(two, two.accounts[0]!, "停用")).not.toThrow();
    // 另一位是一般使用者或已停用：不算「其他管理員」
    for (const other of [second({ role: "user" }), second({ status: "disabled" })]) {
      const draft = { accounts: [makeAccount(), other] };
      expect(() => assertNotLastActiveAdmin(draft, draft.accounts[0]!, "刪除")).toThrowError(expect.objectContaining({ status: 409 }) as never);
    }
    // 對象本身是一般使用者、或已停用的管理員：沒有保護問題
    const withUser = { accounts: [makeAccount(), second({ role: "user" })] };
    expect(() => assertNotLastActiveAdmin(withUser, withUser.accounts[1]!, "刪除")).not.toThrow();
    const withDisabled = { accounts: [makeAccount(), second({ status: "disabled" })] };
    expect(() => assertNotLastActiveAdmin(withDisabled, withDisabled.accounts[1]!, "刪除")).not.toThrow();
    // 整份資料裡根本沒有任何其他啟用中的管理員，對象也不是啟用中的管理員：照樣放行（角色與狀態都要看對象本身）
    const lonelyUser = { accounts: [second({ role: "user" })] };
    expect(() => assertNotLastActiveAdmin(lonelyUser, lonelyUser.accounts[0]!, "刪除")).not.toThrow();
    const lonelyDisabled = { accounts: [second({ status: "disabled" })] };
    expect(() => assertNotLastActiveAdmin(lonelyDisabled, lonelyDisabled.accounts[0]!, "停用")).not.toThrow();
  });

  it("otherActiveAdminCount 只數角色 admin 而且啟用中的（一般使用者不算）", () => {
    const d = newSettingsData();
    d.accounts = [makeAccount(), second({ role: "user" }), third({ role: "admin", status: "disabled" })];
    expect(otherActiveAdminCount(d, TEST_ADMIN_ID)).toBe(0);
    expect(otherActiveAdminCount(d, SECOND)).toBe(1);
  });

  it("requireAdminInDraft：操作者還要是角色 admin（一般使用者 403）；帳號不在、停用、sessionVersion 變了仍是 401", () => {
    const d = newSettingsData();
    d.accounts = [makeAccount(), second({ role: "user" })];
    expect(requireAdminInDraft(d, { id: TEST_ADMIN_ID, sessionVersion: 1 }).id).toBe(TEST_ADMIN_ID);
    expect(() => requireAdminInDraft(d, { id: SECOND, sessionVersion: 1 })).toThrowError(expect.objectContaining({ status: 403, message: "需要管理員權限" }) as never);
    expect(() => requireAdminInDraft(d, { id: TEST_ADMIN_ID, sessionVersion: 9 })).toThrowError(expect.objectContaining({ status: 401 }) as never);
    expect(() => requireAdminInDraft(d, { id: accountId(77), sessionVersion: 1 })).toThrowError(expect.objectContaining({ status: 401 }) as never);
  });
});

describe("純函式：summarizeAccounts（healthz 與設定頁的帳號統計）", () => {
  it("待升級＝有舊版 admin 而且還沒有任何帳號；有了帳號之後，舊 admin 即使還留著也不算待升級", () => {
    const d = newSettingsData();
    expect(summarizeAccounts(d)).toEqual({ adminConfigured: false, adminCount: 0, accountCount: 0, legacyAdminPending: false }); // 全新安裝
    d.admin = { passwordHash: "scrypt$16384$8$1$AAAA$BBBB", updatedAt: "2026-10-01T00:00:00.000Z" };
    expect(summarizeAccounts(d)).toEqual({ adminConfigured: true, adminCount: 0, accountCount: 0, legacyAdminPending: true }); // 待升級：有人進得去
    d.accounts = [makeAccount({ status: "disabled" })];
    expect(summarizeAccounts(d)).toEqual({ adminConfigured: false, adminCount: 1, accountCount: 1, legacyAdminPending: false }); // 舊 admin 殘留也不算
    d.accounts = [makeAccount({ status: "disabled" }), second()];
    expect(summarizeAccounts(d)).toEqual({ adminConfigured: true, adminCount: 2, accountCount: 2, legacyAdminPending: false });
  });

  it("adminConfigured 看的是「啟用中的管理員（角色 admin）」：只有一般使用者、或管理員都停用，都不算；adminCount 只數角色 admin（含停用）、accountCount 數全部", () => {
    const d = newSettingsData();
    d.accounts = [makeAccount({ role: "user" }), second({ role: "user" })];
    expect(summarizeAccounts(d)).toEqual({ adminConfigured: false, adminCount: 0, accountCount: 2, legacyAdminPending: false });
    d.accounts = [makeAccount({ role: "admin", status: "disabled" }), second({ role: "user" })];
    expect(summarizeAccounts(d)).toEqual({ adminConfigured: false, adminCount: 1, accountCount: 2, legacyAdminPending: false });
    d.accounts = [makeAccount({ role: "admin" }), second({ role: "user" }), third({ role: "admin", status: "disabled" })];
    expect(summarizeAccounts(d)).toEqual({ adminConfigured: true, adminCount: 2, accountCount: 3, legacyAdminPending: false });
  });
});

describe("GET /api/accounts", () => {
  it("沒登入 → 401", async () => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, "GET", "/api/accounts");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "請先登入" });
  });

  it("列出所有帳號（含停用的），依建立順序；欄位只有 id、姓名、Email、角色、狀態、時間，絕不含密碼雜湊或 sessionVersion", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second({ status: "disabled", lastLoginAt: "2026-10-04T00:00:00.000Z" })] });
    const res = await ctx.authed("GET", "/api/accounts");
    expect(res.status).toBe(200);
    const text = await res.text();
    const { success, data } = JSON.parse(text) as { success: boolean; data: { accounts: Array<Record<string, unknown>> } };
    expect(success).toBe(true);
    expect(data.accounts).toEqual([
      { id: TEST_ADMIN_ID, name: TEST_ADMIN_NAME, email: TEST_ADMIN_EMAIL, role: "admin", status: "active", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", lastLoginAt: null },
      { id: SECOND, name: "第二位", email: "second@example.test", role: "admin", status: "disabled", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", lastLoginAt: "2026-10-04T00:00:00.000Z" },
    ]);
    for (const secret of ["scrypt$", "passwordHash", "sessionVersion", "sessionSecret"]) expect(text).not.toContain(secret);
  });

  it("每一位啟用中的管理員都能讀；停用的看不到（401）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second(), third({ status: "disabled" })] });
    expect((await ctx.authedAs(SECOND, "GET", "/api/accounts")).status).toBe(200);
    expect((await ctx.authedAs(THIRD, "GET", "/api/accounts")).status).toBe(401);
  });
});

describe("POST /api/accounts（新增管理員）", () => {
  it("沒登入 → 401，什麼都不會發生", async () => {
    const ctx = await makeSettingsApp();
    const res = await call(ctx.app, "POST", "/api/accounts", newBody());
    expect(res.status).toBe(401);
    expect(ctx.store.data.accounts).toHaveLength(1);
  });

  it("成功：200 回新管理員（公開欄位）；存下的 Email 轉小寫、姓名 trim、scrypt 雜湊、啟用、sessionVersion 1、lastLoginAt null；新帳號可以登入", async () => {
    const ctx = await makeSettingsApp();
    const res = await ctx.authed("POST", "/api/accounts", newBody({ name: "  新來的  ", email: "  New.Admin@Example.TEST " }), freshIp());
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { account: Record<string, unknown> } };
    expect(data.account).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      name: "新來的",
      email: "new.admin@example.test",
      role: "admin",
      status: "active",
      createdAt: new Date(NOW_MS).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      lastLoginAt: null,
    });
    const stored = ctx.store.data.accounts[1]!;
    expect(stored).toMatchObject({ name: "新來的", email: "new.admin@example.test", role: "admin", status: "active", sessionVersion: 1, lastLoginAt: null });
    expect(stored.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(stored.passwordHash).not.toBe(ctx.store.data.accounts[0]!.passwordHash); // 新的鹽、新的雜湊
    const file = await readFile(join(ctx.dir, "settings.json"), "utf8");
    expect(file).not.toContain(GOOD_PASSWORD);
    expect(JSON.stringify(data)).not.toContain("scrypt$");
    // 新帳號用自己的 Email 與密碼登入
    const login = await call(ctx.app, "POST", "/login", { email: "NEW.admin@example.test", password: GOOD_PASSWORD }, freshIp());
    expect(login.status).toBe(200);
    expect(decodeURIComponent(cookiePair(login).split("=")[1]!).split(".")[1]).toBe(stored.id);
    expect(ctx.log.lines.some((l) => /^\[accounts\] admin@example\.test 新增帳號 new\.admin@example\.test（角色 admin）（來源 [\d.]+）$/.test(l))).toBe(true);
  });

  it("姓名不合規則 → 400；Email 格式不對 → 400；密碼太短／太長／缺少 → 400；都不會建立帳號、不會跑 scrypt", async () => {
    const ctx = await makeSettingsApp();
    const spy = vi.spyOn(auth, "hashPassword");
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["姓名是空的", newBody({ name: "" }), "姓名需為"],
      ["姓名太長", newBody({ name: "x".repeat(51) }), "姓名需為"],
      ["姓名含換行", newBody({ name: "a\nb" }), "姓名需為"],
      ["姓名只有零寬空白", newBody({ name: "\u200B" }), "姓名需為"],
      ["姓名只有韓文填充字元", newBody({ name: "\u3164\u3164" }), "姓名需為"],
      ["姓名缺少", { email: "a@example.test", password: GOOD_PASSWORD }, "姓名需為"],
      ["Email 格式不對", newBody({ email: "not-an-email" }), "Email 格式不正確"],
      ["Email 缺少", { name: "甲", password: GOOD_PASSWORD }, "Email 格式不正確"],
      ["Email 太長", newBody({ email: `${"a".repeat(250)}@b.co` }), "Email 格式不正確"],
      ["密碼 9 字元", newBody({ password: "123456789" }), "密碼至少要 10 個字元"],
      ["密碼 201 字元", newBody({ password: "x".repeat(201) }), "密碼最多 200 個字元"],
      ["密碼缺少", { name: "甲", email: "a@example.test" }, "密碼至少要 10 個字元"],
      ["密碼不是字串", newBody({ password: 1234567890123 }), "密碼至少要 10 個字元"],
    ];
    for (const [name, body, message] of cases) {
      const res = await ctx.authed("POST", "/api/accounts", body, freshIp());
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as { error: string }).error, name).toContain(message);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(ctx.store.data.accounts).toHaveLength(1);
  });

  it("驗證的順序是姓名 → Email → 密碼（同時有多個錯誤時回最前面那個）", async () => {
    const ctx = await makeSettingsApp();
    const res = await ctx.authed("POST", "/api/accounts", { name: "", email: "bad", password: "x" });
    expect(((await res.json()) as { error: string }).error).toContain("姓名需為");
    const res2 = await ctx.authed("POST", "/api/accounts", { name: "甲", email: "bad", password: "x" });
    expect(((await res2.json()) as { error: string }).error).toContain("Email 格式不正確");
  });

  it("Email 重複 → 409（不分大小寫、前後空白；停用的帳號也算），而且不會白跑一次 scrypt", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second({ status: "disabled" })] });
    const spy = vi.spyOn(auth, "hashPassword");
    for (const email of [TEST_ADMIN_EMAIL, "ADMIN@Example.TEST", `  ${TEST_ADMIN_EMAIL}  `, "second@example.test"]) {
      const res = await ctx.authed("POST", "/api/accounts", newBody({ email }), freshIp());
      expect(res.status, email).toBe(409);
      expect(await res.json()).toEqual({ success: false, error: "這個 Email 已經是其他帳號的登入帳號" });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(ctx.store.data.accounts).toHaveLength(2);
  });

  it("兩個請求同時新增同一個 Email：只有一個成功，另一個 409", async () => {
    const ctx = await makeSettingsApp();
    const [a, b] = await Promise.all([
      ctx.authed("POST", "/api/accounts", newBody({ email: "same@example.test" }), freshIp()),
      ctx.authed("POST", "/api/accounts", newBody({ email: "same@example.test", name: "另一個" }), freshIp()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(ctx.store.data.accounts.filter((x) => x.email === "same@example.test")).toHaveLength(1);
  });

  it("兩個請求同時新增不同的 Email：都成功", async () => {
    const ctx = await makeSettingsApp();
    const [a, b] = await Promise.all([
      ctx.authed("POST", "/api/accounts", newBody({ email: "a@example.test" }), freshIp()),
      ctx.authed("POST", "/api/accounts", newBody({ email: "b@example.test" }), freshIp()),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(ctx.store.data.accounts).toHaveLength(3);
  });

  it(`管理員數量上限 ${ACCOUNT_MAX_COUNT}：第 ${ACCOUNT_MAX_COUNT} 位可以新增，再多 409`, async () => {
    const extra = Array.from({ length: ACCOUNT_MAX_COUNT - 2 }, (_, i) => makeAccount({ id: accountId(100 + i), email: `user${i}@example.test` }));
    const ctx = await makeSettingsApp({ extraAccounts: extra });
    expect(ctx.store.data.accounts).toHaveLength(ACCOUNT_MAX_COUNT - 1);
    expect((await ctx.authed("POST", "/api/accounts", newBody({ email: "last@example.test" }), freshIp())).status).toBe(200);
    expect(ctx.store.data.accounts).toHaveLength(ACCOUNT_MAX_COUNT);
    const over = await ctx.authed("POST", "/api/accounts", newBody({ email: "over@example.test" }), freshIp());
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ success: false, error: `帳號數量已達上限（${ACCOUNT_MAX_COUNT} 個）` });
    expect(ctx.store.data.accounts).toHaveLength(ACCOUNT_MAX_COUNT);
    expect(ACCOUNT_MAX_COUNT).toBe(200);
  });

  it("已經滿額時直接 409，不會白跑一次 scrypt", async () => {
    const extra = Array.from({ length: ACCOUNT_MAX_COUNT - 1 }, (_, i) => makeAccount({ id: accountId(100 + i), email: `user${i}@example.test` }));
    const ctx = await makeSettingsApp({ extraAccounts: extra });
    expect(ctx.store.data.accounts).toHaveLength(ACCOUNT_MAX_COUNT);
    const spy = vi.spyOn(auth, "hashPassword");
    expect((await ctx.authed("POST", "/api/accounts", newBody({ email: "over@example.test" }), freshIp())).status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
  });

  it(`產生密碼雜湊的期間別的請求把最後一個名額占走了：這次新增 409（上限在寫檔的鎖內再檢查一次），不會超過 ${ACCOUNT_MAX_COUNT} 位`, async () => {
    const extra = Array.from({ length: ACCOUNT_MAX_COUNT - 2 }, (_, i) => makeAccount({ id: accountId(100 + i), email: `user${i}@example.test` }));
    const ctx = await makeSettingsApp({ extraAccounts: extra });
    expect(ctx.store.data.accounts).toHaveLength(ACCOUNT_MAX_COUNT - 1);
    const real = auth.hashPassword;
    vi.spyOn(auth, "hashPassword").mockImplementationOnce(async (password) => {
      await ctx.store.update((draft) => {
        draft.accounts.push(makeAccount({ id: accountId(900), email: "racer@example.test" }));
      });
      return real(password);
    });
    const res = await ctx.authed("POST", "/api/accounts", newBody({ email: "late@example.test" }), freshIp());
    expect(res.status).toBe(409);
    expect(ctx.store.data.accounts).toHaveLength(ACCOUNT_MAX_COUNT);
    expect(ctx.store.data.accounts.map((admin) => admin.email)).not.toContain("late@example.test");
  });

  it("產生密碼雜湊的期間操作者被停用：這次新增作廢（401），不會留下帳號", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const real = auth.hashPassword;
    vi.spyOn(auth, "hashPassword").mockImplementationOnce(async (password) => {
      await ctx.store.update((draft) => {
        draft.accounts[1]!.status = "disabled";
      });
      return real(password);
    });
    const res = await ctx.authedAs(SECOND, "POST", "/api/accounts", newBody(), freshIp());
    expect(res.status).toBe(401);
    expect(ctx.store.data.accounts).toHaveLength(2);
  });

  it("請求內容不是 JSON、是陣列 → 400", async () => {
    const ctx = await makeSettingsApp();
    expect((await ctx.authed("POST", "/api/accounts", "{oops")).status).toBe(400);
    expect((await ctx.authed("POST", "/api/accounts", "[]")).status).toBe(400);
  });
});

describe("PATCH /api/accounts/:id（修改姓名、Email）", () => {
  it("改姓名：200 回更新後的資料；updatedAt 更新、其他欄位不動；log 有一行", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    ctx.clock.now += 60_000;
    const res = await ctx.authed("PATCH", `/api/accounts/${SECOND}`, { name: "  改過的名字  " });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { account: Record<string, unknown> } };
    expect(data.account).toMatchObject({ id: SECOND, name: "改過的名字", email: "second@example.test", status: "active", updatedAt: new Date(NOW_MS + 60_000).toISOString() });
    expect(ctx.store.data.accounts[1]!.sessionVersion).toBe(1); // 改姓名不影響登入
    expect(ctx.log.lines.some((l) => l.startsWith(`[accounts] ${TEST_ADMIN_EMAIL} 修改帳號 second@example.test（姓名）（來源 `))).toBe(true);
  });

  it("改 Email：新 Email 轉小寫；舊 Email 不能再登入、新 Email 可以；對方原本的登入（cookie）仍然有效；log 的對象是舊 Email、註明新 Email", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second({ passwordHash: await auth.hashPassword("second-admin-password-1") })] });
    const otherCookie = ctx.sessionCookie(SECOND);
    const res = await ctx.authed("PATCH", `/api/accounts/${SECOND}`, { email: "  New.Second@Example.TEST " });
    expect(res.status).toBe(200);
    expect(ctx.store.data.accounts[1]!.email).toBe("new.second@example.test");
    expect((await call(ctx.app, "POST", "/login", { email: "second@example.test", password: "second-admin-password-1" }, freshIp())).status).toBe(401);
    expect((await call(ctx.app, "POST", "/login", { email: "new.second@example.test", password: "second-admin-password-1" }, freshIp())).status).toBe(200);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: otherCookie })).status).toBe(200); // cookie 綁的是帳號 id，不是 Email
    expect(ctx.log.lines.some((l) => l.startsWith(`[accounts] ${TEST_ADMIN_EMAIL} 修改帳號 second@example.test（Email 改為 new.second@example.test）（來源 `))).toBe(true);
  });

  it("同時改姓名與 Email", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const res = await ctx.authed("PATCH", `/api/accounts/${SECOND}`, { name: "新名字", email: "renamed@example.test" });
    expect(res.status).toBe(200);
    expect(ctx.store.data.accounts[1]).toMatchObject({ name: "新名字", email: "renamed@example.test" });
    expect(ctx.log.lines.some((l) => l.includes("修改帳號 second@example.test（姓名、Email 改為 renamed@example.test）"))).toBe(true);
  });

  it("可以改自己的姓名與 Email；自己的登入不受影響（cookie 綁帳號 id）", async () => {
    const ctx = await makeSettingsApp();
    const res = await ctx.authed("PATCH", `/api/accounts/${TEST_ADMIN_ID}`, { name: "改了自己", email: "me.new@example.test" });
    expect(res.status).toBe(200);
    const me = await ctx.authed("GET", "/api/settings");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { data: { me: unknown } }).data.me).toEqual({ id: TEST_ADMIN_ID, name: "改了自己", email: "me.new@example.test", role: "admin" });
  });

  it("值跟現在一樣：200、什麼都沒變（updatedAt 不動）、不寫 log", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    ctx.clock.now += 60_000;
    const logsBefore = ctx.log.lines.length;
    const res = await ctx.authed("PATCH", `/api/accounts/${SECOND}`, { name: "第二位", email: "SECOND@example.test" });
    expect(res.status).toBe(200);
    expect(ctx.store.data.accounts[1]!.updatedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(ctx.log.lines.length).toBe(logsBefore);
  });

  it("Email 和別人重複 → 409（自己現有的 Email 不算重複）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second(), third({ status: "disabled" })] });
    for (const email of [TEST_ADMIN_EMAIL, "ADMIN@example.test", "third@example.test"]) {
      const res = await ctx.authed("PATCH", `/api/accounts/${SECOND}`, { email });
      expect(res.status, email).toBe(409);
      expect(await res.json()).toEqual({ success: false, error: "這個 Email 已經是其他帳號的登入帳號" });
    }
    expect(ctx.store.data.accounts[1]!.email).toBe("second@example.test");
    expect((await ctx.authed("PATCH", `/api/accounts/${SECOND}`, { email: "second@example.test" })).status).toBe(200);
  });

  it("沒有任何要改的欄位、或欄位不合規則 → 400，不會改動", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "沒有要修改的欄位"],
      [{ status: "disabled", passwordHash: "x", id: accountId(5), sessionVersion: 9 }, "沒有要修改的欄位"], // 只有不能用這支改的欄位
      [{ name: "" }, "姓名需為"],
      [{ name: null }, "姓名需為"],
      [{ name: "x".repeat(51) }, "姓名需為"],
      [{ email: "not-an-email" }, "Email 格式不正確"],
      [{ email: null }, "Email 格式不正確"],
      [{ email: 42 }, "Email 格式不正確"],
    ];
    for (const [body, message] of cases) {
      const res = await ctx.authed("PATCH", `/api/accounts/${SECOND}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(message);
    }
    expect(ctx.store.data.accounts[1]).toMatchObject({ name: "第二位", email: "second@example.test", status: "active", sessionVersion: 1, id: SECOND });
  });

  it("夾帶其他欄位（status、passwordHash、id、sessionVersion）會被忽略，不會被改動", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const hash = ctx.store.data.accounts[1]!.passwordHash;
    const res = await ctx.authed("PATCH", `/api/accounts/${SECOND}`, { name: "只改這個", status: "disabled", passwordHash: "scrypt$evil", id: accountId(5), sessionVersion: 99 });
    expect(res.status).toBe(200);
    expect(ctx.store.data.accounts[1]).toMatchObject({ id: SECOND, name: "只改這個", status: "active", passwordHash: hash, sessionVersion: 1 });
  });

  it("不存在的帳號（格式正確）→ 404；id 格式不對 → 404", async () => {
    const ctx = await makeSettingsApp();
    for (const id of [NOT_FOUND, "nope", "../etc/passwd", "ZZZZ", "0123456789ABCDEF0123456789ABCDEF"]) {
      const res = await ctx.authed("PATCH", `/api/accounts/${encodeURIComponent(id)}`, { name: "x" });
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ success: false, error: "找不到這個帳號" });
    }
  });

  it("沒登入 → 401", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    expect((await call(ctx.app, "PATCH", `/api/accounts/${SECOND}`, { name: "x" })).status).toBe(401);
    expect(ctx.store.data.accounts[1]!.name).toBe("第二位");
  });
});

describe("改動帳號資料的請求在鎖內重新確認操作者（請求處理期間操作者被停用）", () => {
  it("PATCH：操作者在處理期間被停用 → 401，對方的資料不變", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second(), third()] });
    const realUpdate = ctx.store.update.bind(ctx.store);
    vi.spyOn(ctx.store, "update").mockImplementationOnce(async (mutator) => {
      await realUpdate((draft) => {
        draft.accounts[1]!.status = "disabled"; // 操作者（第二位）在這一刻被停用
      });
      return realUpdate(mutator);
    });
    const res = await ctx.authedAs(SECOND, "PATCH", `/api/accounts/${THIRD}`, { name: "被改掉的名字", email: "changed@example.test" }, freshIp());
    expect(res.status).toBe(401);
    expect(ctx.store.data.accounts.find((admin) => admin.id === THIRD)).toMatchObject({ name: "第三位", email: "third@example.test" });
  });

  it("重設他人密碼：產生雜湊的期間操作者被停用 → 401，對方的密碼與 sessionVersion 都不變", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second(), third()] });
    const before = ctx.store.data.accounts.find((admin) => admin.id === THIRD)!;
    const real = auth.hashPassword;
    vi.spyOn(auth, "hashPassword").mockImplementationOnce(async (password) => {
      await ctx.store.update((draft) => {
        draft.accounts[1]!.status = "disabled";
      });
      return real(password);
    });
    const res = await ctx.authedAs(SECOND, "POST", `/api/accounts/${THIRD}/password`, { newPassword: GOOD_PASSWORD }, freshIp());
    expect(res.status).toBe(401);
    const after = ctx.store.data.accounts.find((admin) => admin.id === THIRD)!;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.sessionVersion).toBe(before.sessionVersion);
  });
});

describe("POST /api/accounts/:id/password（重設他人的密碼）", () => {
  it("成功：200；對方的密碼換成新的、sessionVersion 加一（對方舊 cookie 立刻失效）、舊密碼不能登入、新密碼可以；其他管理員不受影響", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second({ passwordHash: await auth.hashPassword("second-admin-password-1") }), third()] });
    const secondCookie = ctx.sessionCookie(SECOND);
    const thirdCookie = ctx.sessionCookie(THIRD);
    const hashBefore = ctx.store.data.accounts[1]!.passwordHash;
    ctx.clock.now += 60_000;

    const res = await ctx.authed("POST", `/api/accounts/${SECOND}/password`, { newPassword: GOOD_PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const target = ctx.store.data.accounts[1]!;
    expect(target.passwordHash).not.toBe(hashBefore);
    expect(target.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(target.sessionVersion).toBe(2);
    expect(target.updatedAt).toBe(new Date(NOW_MS + 60_000).toISOString());
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: secondCookie })).status).toBe(401); // 對方的舊 cookie 失效
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: thirdCookie })).status).toBe(200); // 第三位不受影響
    expect((await ctx.authed("GET", "/api/settings")).status).toBe(200); // 操作者自己不受影響
    expect((await call(ctx.app, "POST", "/login", { email: "second@example.test", password: "second-admin-password-1" }, freshIp())).status).toBe(401);
    expect((await call(ctx.app, "POST", "/login", { email: "second@example.test", password: GOOD_PASSWORD }, freshIp())).status).toBe(200);
    expect(ctx.store.data.accounts[0]!.sessionVersion).toBe(1);
    expect(ctx.store.data.accounts[2]!.sessionVersion).toBe(1);
    expect(ctx.log.lines.some((l) => l.startsWith(`[accounts] ${TEST_ADMIN_EMAIL} 重設密碼 second@example.test（來源 `))).toBe(true);
    expect(ctx.log.lines.join("\n")).not.toContain(GOOD_PASSWORD);
    expect(await readFile(join(ctx.dir, "settings.json"), "utf8")).not.toContain(GOOD_PASSWORD);
  });

  it("不能用這支改自己的密碼（要用「我的帳號」的變更密碼，需要目前的密碼）→ 400，不改動", async () => {
    const ctx = await makeSettingsApp();
    const hash = ctx.store.data.accounts[0]!.passwordHash;
    const res = await ctx.authed("POST", `/api/accounts/${TEST_ADMIN_ID}/password`, { newPassword: GOOD_PASSWORD });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "要更改自己的密碼，請用「我的帳號」頁的變更密碼（需要輸入目前的密碼）" });
    expect(ctx.store.data.accounts[0]!.passwordHash).toBe(hash);
    expect(ctx.store.data.accounts[0]!.sessionVersion).toBe(1);
  });

  it("新密碼太短／太長／缺少／不是字串 → 400，不跑 scrypt、不改動", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const spy = vi.spyOn(auth, "hashPassword");
    for (const body of [{ newPassword: "short" }, { newPassword: "x".repeat(201) }, {}, { newPassword: 1234567890123 }, { newPassword: null }]) {
      expect((await ctx.authed("POST", `/api/accounts/${SECOND}/password`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(ctx.store.data.accounts[1]!.sessionVersion).toBe(1);
  });

  it("不存在的帳號 → 404，而且不會白跑一次 scrypt；id 格式不對 → 404", async () => {
    const ctx = await makeSettingsApp();
    const spy = vi.spyOn(auth, "hashPassword");
    expect((await ctx.authed("POST", `/api/accounts/${NOT_FOUND}/password`, { newPassword: GOOD_PASSWORD })).status).toBe(404);
    expect((await ctx.authed("POST", `/api/accounts/not-an-id/password`, { newPassword: GOOD_PASSWORD })).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("可以重設已停用帳號的密碼（停用狀態不變）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second({ status: "disabled" })] });
    expect((await ctx.authed("POST", `/api/accounts/${SECOND}/password`, { newPassword: GOOD_PASSWORD })).status).toBe(200);
    expect(ctx.store.data.accounts[1]).toMatchObject({ status: "disabled", sessionVersion: 2 });
  });

  it("沒登入 → 401", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    expect((await call(ctx.app, "POST", `/api/accounts/${SECOND}/password`, { newPassword: GOOD_PASSWORD })).status).toBe(401);
  });
});

describe("POST /api/accounts/:id/status（停用／啟用）", () => {
  it("停用別人：200；狀態變 disabled、sessionVersion 加一；對方舊 cookie 立刻失效、不能登入（401）；其他人不受影響；log 有一行", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second(), third()] });
    const secondCookie = ctx.sessionCookie(SECOND);
    const res = await ctx.authed("POST", `/api/accounts/${SECOND}/status`, { status: "disabled" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { account: { status: string } } }).data.account.status).toBe("disabled");
    expect(ctx.store.data.accounts[1]).toMatchObject({ status: "disabled", sessionVersion: 2 });
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: secondCookie })).status).toBe(401);
    expect((await call(ctx.app, "POST", "/login", { email: "second@example.test", password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(401);
    expect((await ctx.authedAs(THIRD, "GET", "/api/settings")).status).toBe(200);
    expect(ctx.log.lines.some((l) => l.startsWith(`[accounts] ${TEST_ADMIN_EMAIL} 停用帳號 second@example.test（來源 `))).toBe(true);
  });

  it("重新啟用：狀態變 active、sessionVersion 再加一；停用之前發的舊 cookie 不會復活；新登入可以；log 有一行", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const cookieBeforeDisable = ctx.sessionCookie(SECOND); // sessionVersion 1
    await ctx.authed("POST", `/api/accounts/${SECOND}/status`, { status: "disabled" }); // → 2
    const cookieWhileDisabled = ctx.sessionCookie(SECOND); // sessionVersion 2
    const res = await ctx.authed("POST", `/api/accounts/${SECOND}/status`, { status: "active" }); // → 3
    expect(res.status).toBe(200);
    expect(ctx.store.data.accounts[1]).toMatchObject({ status: "active", sessionVersion: 3 });
    for (const stale of [cookieBeforeDisable, cookieWhileDisabled]) {
      expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: stale })).status).toBe(401);
    }
    expect((await ctx.authedAs(SECOND, "GET", "/api/settings")).status).toBe(200);
    expect((await call(ctx.app, "POST", "/login", { email: "second@example.test", password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(200);
    expect(ctx.log.lines.some((l) => l.startsWith(`[accounts] ${TEST_ADMIN_EMAIL} 啟用帳號 second@example.test（來源 `))).toBe(true);
  });

  it("已經是那個狀態：200，什麼都不變（sessionVersion 不動、不寫 log）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second(), third({ status: "disabled" })] });
    const logsBefore = ctx.log.lines.length;
    expect((await ctx.authed("POST", `/api/accounts/${SECOND}/status`, { status: "active" })).status).toBe(200);
    expect((await ctx.authed("POST", `/api/accounts/${THIRD}/status`, { status: "disabled" })).status).toBe(200);
    expect(ctx.store.data.accounts.map((a) => a.sessionVersion)).toEqual([1, 1, 1]);
    expect(ctx.log.lines.length).toBe(logsBefore);
  });

  it("不能停用自己 → 409；「啟用自己」是無害的（已經是啟用中）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const res = await ctx.authed("POST", `/api/accounts/${TEST_ADMIN_ID}/status`, { status: "disabled" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: "不能停用自己的帳號" });
    expect(ctx.store.data.accounts[0]!.status).toBe("active");
    expect((await ctx.authed("POST", `/api/accounts/${TEST_ADMIN_ID}/status`, { status: "active" })).status).toBe(200);
  });

  it("只有一位管理員時：不能停用自己（所以不會鎖死系統）", async () => {
    const ctx = await makeSettingsApp();
    expect((await ctx.authed("POST", `/api/accounts/${TEST_ADMIN_ID}/status`, { status: "disabled" })).status).toBe(409);
    expect((await call(ctx.app, "POST", "/login", { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(200);
  });

  it("兩位管理員同時互相停用對方：只有先到的那一個成功，另一個因為操作者已被停用而 401——不會變成「沒有任何啟用中的管理員」", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const [a, b] = await Promise.all([
      ctx.authed("POST", `/api/accounts/${SECOND}/status`, { status: "disabled" }),
      ctx.authedAs(SECOND, "POST", `/api/accounts/${TEST_ADMIN_ID}/status`, { status: "disabled" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(ctx.store.data.accounts.filter((x) => x.status === "active")).toHaveLength(1);
  });

  it("status 不是 active／disabled（缺少、錯字、大小寫、型別不對）→ 400", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    for (const body of [{}, { status: "" }, { status: "Active" }, { status: "ACTIVE" }, { status: "enabled" }, { status: "banned" }, { status: true }, { status: null }, { status: 1 }]) {
      const res = await ctx.authed("POST", `/api/accounts/${SECOND}/status`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: "status 必須是 active 或 disabled" });
    }
    expect(ctx.store.data.accounts[1]!.status).toBe("active");
  });

  it("不存在的帳號 → 404；沒登入 → 401", async () => {
    const ctx = await makeSettingsApp();
    expect((await ctx.authed("POST", `/api/accounts/${NOT_FOUND}/status`, { status: "disabled" })).status).toBe(404);
    expect((await call(ctx.app, "POST", `/api/accounts/${NOT_FOUND}/status`, { status: "disabled" })).status).toBe(401);
  });
});

describe("DELETE /api/accounts/:id（刪除）", () => {
  it("刪除別人：200；從設定檔移除；對方舊 cookie 失效、不能登入；其他人不受影響；adminCount 減一；log 有一行", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second(), third()] });
    const secondCookie = ctx.sessionCookie(SECOND);
    const res = await ctx.authed("DELETE", `/api/accounts/${SECOND}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect((await adminsOf(ctx)).map((a) => a.id)).toEqual([TEST_ADMIN_ID, THIRD]);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: secondCookie })).status).toBe(401);
    expect((await call(ctx.app, "POST", "/login", { email: "second@example.test", password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(401);
    expect((await ctx.authedAs(THIRD, "GET", "/api/settings")).status).toBe(200);
    expect(((await (await ctx.app.request("/healthz")).json()) as { adminCount: number }).adminCount).toBe(2);
    expect(ctx.log.lines.some((l) => l.startsWith(`[accounts] ${TEST_ADMIN_EMAIL} 刪除帳號 second@example.test（來源 `))).toBe(true);
  });

  it("刪掉之後，同一個 Email 可以再建立新帳號（新的 id；舊 cookie 不會對應到新帳號）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const oldCookie = ctx.sessionCookie(SECOND);
    await ctx.authed("DELETE", `/api/accounts/${SECOND}`);
    const created = await ctx.authed("POST", "/api/accounts", { name: "第二位（重建）", email: "second@example.test", password: GOOD_PASSWORD }, freshIp());
    expect(created.status).toBe(200);
    const newId = ctx.store.data.accounts[1]!.id;
    expect(newId).not.toBe(SECOND);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: oldCookie })).status).toBe(401);
  });

  it("不能刪除自己 → 409，不改動", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const res = await ctx.authed("DELETE", `/api/accounts/${TEST_ADMIN_ID}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: "不能刪除自己的帳號" });
    expect(ctx.store.data.accounts).toHaveLength(2);
  });

  it("只有一位管理員時：不能刪除自己（所以不會鎖死系統）", async () => {
    const ctx = await makeSettingsApp();
    expect((await ctx.authed("DELETE", `/api/accounts/${TEST_ADMIN_ID}`)).status).toBe(409);
    expect(ctx.store.data.accounts).toHaveLength(1);
  });

  it("可以刪除已停用的帳號", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second({ status: "disabled" })] });
    expect((await ctx.authed("DELETE", `/api/accounts/${SECOND}`)).status).toBe(200);
    expect(ctx.store.data.accounts).toHaveLength(1);
  });

  it("兩位管理員同時互相刪除對方：只有先到的成功，另一個 401——不會把所有帳號都刪光", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const [a, b] = await Promise.all([ctx.authed("DELETE", `/api/accounts/${SECOND}`), ctx.authedAs(SECOND, "DELETE", `/api/accounts/${TEST_ADMIN_ID}`)]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(ctx.store.data.accounts).toHaveLength(1);
  });

  it("不存在的帳號 → 404（刪兩次，第二次 404）；沒登入 → 401", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    expect((await call(ctx.app, "DELETE", `/api/accounts/${SECOND}`)).status).toBe(401);
    expect((await ctx.authed("DELETE", `/api/accounts/${SECOND}`)).status).toBe(200);
    expect((await ctx.authed("DELETE", `/api/accounts/${SECOND}`)).status).toBe(404);
    expect((await ctx.authed("DELETE", `/api/accounts/${NOT_FOUND}`)).status).toBe(404);
  });
});

describe("整條流程：新增第二位 → 停用第一位 → 第二位登入 → 自己不能刪／停用自己", () => {
  it("每一步的結果都符合規則，而且 log 留下完整的審計紀錄（沒有任何密碼）", async () => {
    const ctx = await makeSettingsApp();
    const secondPassword = "second-admin-password-1";

    // 第一位新增第二位
    const created = await ctx.authed("POST", "/api/accounts", { name: "第二位", email: "second@example.test", password: secondPassword, role: "admin" }, freshIp());
    expect(created.status).toBe(200);
    const secondId = ((await created.json()) as { data: { account: { id: string } } }).data.account.id;

    // 第一位不能停用／刪除自己
    expect((await ctx.authed("POST", `/api/accounts/${TEST_ADMIN_ID}/status`, { status: "disabled" })).status).toBe(409);
    expect((await ctx.authed("DELETE", `/api/accounts/${TEST_ADMIN_ID}`)).status).toBe(409);

    // 第二位登入
    const login = await call(ctx.app, "POST", "/login", { email: "second@example.test", password: secondPassword }, freshIp());
    expect(login.status).toBe(200);
    const secondCookie = cookiePair(login);

    // 第二位停用第一位 → 第一位的 cookie 立刻失效、登入失敗
    const firstCookie = ctx.sessionCookie();
    const disable = await call(ctx.app, "POST", `/api/accounts/${TEST_ADMIN_ID}/status`, { status: "disabled" }, { cookie: secondCookie });
    expect(disable.status).toBe(200);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: firstCookie })).status).toBe(401);
    expect((await call(ctx.app, "POST", "/login", { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(401);

    // 第二位現在是唯一啟用中的管理員：不能停用或刪除自己
    expect((await call(ctx.app, "POST", `/api/accounts/${secondId}/status`, { status: "disabled" }, { cookie: secondCookie })).status).toBe(409);
    expect((await call(ctx.app, "DELETE", `/api/accounts/${secondId}`, undefined, { cookie: secondCookie })).status).toBe(409);

    // 第二位重新啟用第一位，第一位用密碼重新登入
    expect((await call(ctx.app, "POST", `/api/accounts/${TEST_ADMIN_ID}/status`, { status: "active" }, { cookie: secondCookie })).status).toBe(200);
    expect((await call(ctx.app, "GET", "/api/settings", undefined, { cookie: firstCookie })).status).toBe(401); // 舊 cookie 沒有復活
    expect((await call(ctx.app, "POST", "/login", { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }, freshIp())).status).toBe(200);

    // 第二位刪除第一位
    expect((await call(ctx.app, "DELETE", `/api/accounts/${TEST_ADMIN_ID}`, undefined, { cookie: secondCookie })).status).toBe(200);
    expect(ctx.store.data.accounts.map((a) => a.email)).toEqual(["second@example.test"]);

    // 審計 log：每個操作一行，動作與對象都在，沒有任何密碼
    const audit = ctx.log.lines.filter((l) => l.startsWith("[accounts] ")).map((l) => l.replace(/（來源 .*）$/, ""));
    expect(audit).toEqual([
      `[accounts] ${TEST_ADMIN_EMAIL} 新增帳號 second@example.test（角色 admin）`,
      "[accounts] second@example.test 登入成功",
      `[accounts] second@example.test 停用帳號 ${TEST_ADMIN_EMAIL}`,
      `[accounts] ${TEST_ADMIN_EMAIL} 登入失敗`,
      `[accounts] second@example.test 啟用帳號 ${TEST_ADMIN_EMAIL}`,
      `[accounts] ${TEST_ADMIN_EMAIL} 登入成功`,
      `[accounts] second@example.test 刪除帳號 ${TEST_ADMIN_EMAIL}`,
    ]);
    const logged = ctx.log.lines.join("\n");
    for (const secret of [secondPassword, TEST_ADMIN_PASSWORD]) expect(logged).not.toContain(secret);
    expect(await readFile(join(ctx.dir, "settings.json"), "utf8")).not.toContain(secondPassword);
  });
});

describe("頁面上的管理員區塊（伺服器端渲染）", () => {
  it("每位管理員一列：姓名、Email、狀態、最後登入；自己那一列標示「（你）」；停用的顯示「停用」", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second({ status: "disabled", lastLoginAt: "2026-10-04T07:20:00.000Z" })] });
    const html = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(html).toContain("測試管理員");
    expect(html).toContain("（你）");
    expect(html).toContain("second@example.test");
    expect(html).toContain('<span class="chip bad">停用</span>');
    expect(html).toContain("2026-10-04 15:20");
  });

  it("用第二位的 cookie 看：「（你）」標在第二位那一列，頂端顯示登入者的姓名與角色", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const html = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie(SECOND) } })).text();
    expect(html).toContain('<span class="who">👤 第二位（管理員）</span>');
    const rows = html.split("<tr>").slice(1).map((r) => r.split("</tr>")[0]!);
    expect(rows.find((r) => r.includes("（你）"))).toContain("second@example.test");
  });

  it("惡意姓名（含標籤與引號）在頁面上一律跳脫", async () => {
    const evilName = `<img src=x onerror=alert(1)>"'`;
    const ctx = await makeSettingsApp({ extraAccounts: [second({ name: evilName })] });
    const html = await (await ctx.app.request("/settings", { headers: { cookie: ctx.sessionCookie() } })).text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;");
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });
});

describe("權限與 cookie 的小地方", () => {
  it("每一位啟用中的管理員權限相同（沒有角色之分）：第二位也能新增、修改、停用、刪除別人", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second(), third()] });
    expect((await ctx.authedAs(SECOND, "POST", "/api/accounts", newBody({ email: "by.second@example.test" }), freshIp())).status).toBe(200);
    expect((await ctx.authedAs(SECOND, "PATCH", `/api/accounts/${THIRD}`, { name: "被第二位改名" })).status).toBe(200);
    expect((await ctx.authedAs(SECOND, "POST", `/api/accounts/${THIRD}/status`, { status: "disabled" })).status).toBe(200);
    expect((await ctx.authedAs(SECOND, "DELETE", `/api/accounts/${THIRD}`)).status).toBe(200);
  });

  it("停用或刪除之後，那個帳號的 cookie 對所有 /api/accounts 端點都是 401", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second(), third()] });
    const cookie = ctx.sessionCookie(SECOND);
    await ctx.authed("POST", `/api/accounts/${SECOND}/status`, { status: "disabled" });
    const attempts: Array<[string, string, unknown]> = [
      ["GET", "/api/accounts", undefined],
      ["POST", "/api/accounts", newBody()],
      ["PATCH", `/api/accounts/${THIRD}`, { name: "x" }],
      ["POST", `/api/accounts/${THIRD}/password`, { newPassword: GOOD_PASSWORD }],
      ["POST", `/api/accounts/${THIRD}/status`, { status: "disabled" }],
      ["DELETE", `/api/accounts/${THIRD}`, undefined],
    ];
    for (const [method, path, body] of attempts) {
      expect((await call(ctx.app, method, path, body, { cookie, ...freshIp() })).status, `${method} ${path}`).toBe(401);
    }
    expect(ctx.store.data.accounts).toHaveLength(3);
    expect(ctx.store.data.accounts[2]).toMatchObject({ name: "第三位", status: "active" });
  });

  it("沒有 cookie 或是 cookie 簽章不對時，所有 /api/accounts 端點都是 401", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const bad = `${SESSION_COOKIE_NAME}=1.${SECOND}.1.AAAAAAAAAAAAAAAA.${"A".repeat(43)}`;
    for (const headers of [{}, { cookie: bad }] as Array<Record<string, string>>) {
      expect((await call(ctx.app, "GET", "/api/accounts", undefined, headers)).status).toBe(401);
      expect((await call(ctx.app, "DELETE", `/api/accounts/${SECOND}`, undefined, headers)).status).toBe(401);
    }
    expect(setCookieOf(await call(ctx.app, "GET", "/api/accounts"))).toBeUndefined();
  });
});

describe("角色與權限（/api/accounts*：只有管理員）", () => {
  const USER = accountId(40);
  const userAccount = (overrides = {}) => makeAccount({ id: USER, name: "一般同事", email: "user@example.test", role: "user", ...overrides });

  it("一般使用者呼叫每一個 /api/accounts* 端點都是 403（不是 401）：不改動、也不洩漏帳號清單", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [userAccount(), second()] });
    const before = JSON.stringify(ctx.store.data);
    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/api/accounts"],
      ["POST", "/api/accounts", newBody({ email: "x@example.test" })],
      ["PATCH", `/api/accounts/${SECOND}`, { name: "被改" }],
      ["PATCH", `/api/accounts/${USER}`, { role: "admin" }], // 不能自己升級自己
      ["POST", `/api/accounts/${SECOND}/password`, { newPassword: GOOD_PASSWORD }],
      ["POST", `/api/accounts/${SECOND}/status`, { status: "disabled" }],
      ["DELETE", `/api/accounts/${SECOND}`],
    ];
    for (const [method, path, body] of calls) {
      const res = await ctx.authedAs(USER, method, path, body, freshIp());
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ success: false, error: "需要管理員權限" });
    }
    expect(JSON.stringify(ctx.store.data)).toBe(before);
  });

  it("沒登入仍是 401；停用的管理員仍是 401（不是 403）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second({ status: "disabled" })] });
    expect((await call(ctx.app, "GET", "/api/accounts")).status).toBe(401);
    expect((await ctx.authedAs(SECOND, "GET", "/api/accounts")).status).toBe(401);
  });

  it("新增：沒給 role 預設建立一般使用者；role 可以是 admin 或 user；不合法的 role → 400，不建立、不跑 scrypt", async () => {
    const ctx = await makeSettingsApp();
    const noRole = await ctx.authed("POST", "/api/accounts", { name: "甲", email: "a@example.test", password: GOOD_PASSWORD }, freshIp());
    expect(noRole.status).toBe(200);
    expect(((await noRole.json()) as { data: { account: { role: string } } }).data.account.role).toBe("user");
    expect(ctx.store.data.accounts.find((a) => a.email === "a@example.test")?.role).toBe("user");
    const admin = await ctx.authed("POST", "/api/accounts", newBody({ email: "b@example.test", role: "admin" }), freshIp());
    expect(((await admin.json()) as { data: { account: { role: string } } }).data.account.role).toBe("admin");
    const spy = vi.spyOn(auth, "hashPassword");
    for (const bad of ["root", "Admin", "", null, 1, true]) {
      const res = await ctx.authed("POST", "/api/accounts", newBody({ email: "c@example.test", role: bad }), freshIp());
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("角色必須是 admin（管理員）或 user（一般使用者）");
    }
    expect(spy).not.toHaveBeenCalled();
    expect(ctx.store.data.accounts.map((a) => a.email)).toEqual([TEST_ADMIN_EMAIL, "a@example.test", "b@example.test"]);
    expect(ctx.log.lines.some((l) => l.includes("新增帳號 a@example.test（角色 user）"))).toBe(true);
  });

  it("改角色（user → admin）：200；角色變了、sessionVersion 加一（對方舊 cookie 立刻失效）、updatedAt 更新；log 記錄角色變更；其他人不受影響", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [userAccount(), second()] });
    const oldCookie = ctx.sessionCookie(USER);
    expect((await call(ctx.app, "GET", "/api/me", undefined, { cookie: oldCookie })).status).toBe(200);
    ctx.clock.now += 60_000;
    const res = await ctx.authed("PATCH", `/api/accounts/${USER}`, { role: "admin" }, freshIp());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { account: Record<string, unknown> } }).data.account).toMatchObject({ id: USER, role: "admin", updatedAt: new Date(NOW_MS + 60_000).toISOString() });
    expect(ctx.store.data.accounts.find((a) => a.id === USER)).toMatchObject({ role: "admin", sessionVersion: 2 });
    expect((await call(ctx.app, "GET", "/api/me", undefined, { cookie: oldCookie })).status).toBe(401); // 舊的登入失效，要重新登入才拿到新的權限
    expect((await ctx.authedAs(SECOND, "GET", "/api/accounts")).status).toBe(200); // 其他人不受影響
    expect((await ctx.authedAs(USER, "GET", "/api/accounts")).status).toBe(200); // 新的 cookie（新的 sessionVersion）就是管理員
    expect(ctx.log.lines.some((l) => l.startsWith(`[accounts] ${TEST_ADMIN_EMAIL} 修改帳號 user@example.test（角色 user → admin）（來源 `))).toBe(true);
  });

  it("改角色（admin → user）：另一位管理員可以降級別人；降級後對方舊 cookie 失效、進不了設定頁與帳號 API（新登入拿到的是 403）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const res = await ctx.authed("PATCH", `/api/accounts/${SECOND}`, { role: "user" }, freshIp());
    expect(res.status).toBe(200);
    expect(ctx.store.data.accounts.find((a) => a.id === SECOND)).toMatchObject({ role: "user", sessionVersion: 2 });
    expect((await ctx.authedAs(SECOND, "GET", "/api/accounts")).status).toBe(403);
    expect(ctx.log.lines.some((l) => l.includes("修改帳號 second@example.test（角色 admin → user）"))).toBe(true);
  });

  it("不能把自己改成一般使用者 → 409，什麼都不變（即使還有別的管理員）；改成 admin（沒有變化）是無害的：不加 sessionVersion、不寫 log", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const res = await ctx.authed("PATCH", `/api/accounts/${TEST_ADMIN_ID}`, { role: "user" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: "不能把自己改成一般使用者" });
    expect(ctx.store.data.accounts[0]).toMatchObject({ role: "admin", sessionVersion: 1 });
    const linesBefore = ctx.log.lines.length;
    expect((await ctx.authed("PATCH", `/api/accounts/${TEST_ADMIN_ID}`, { role: "admin" })).status).toBe(200);
    expect(ctx.store.data.accounts[0]).toMatchObject({ role: "admin", sessionVersion: 1 });
    expect(ctx.log.lines.length).toBe(linesBefore);
  });

  it("只有一位管理員時：不能停用、刪除自己，也不能把自己改成一般使用者（系統永遠留得住一位管理員）", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [userAccount()] }); // 另一個帳號是一般使用者，不算管理員
    expect((await ctx.authed("POST", `/api/accounts/${TEST_ADMIN_ID}/status`, { status: "disabled" })).status).toBe(409);
    expect((await ctx.authed("DELETE", `/api/accounts/${TEST_ADMIN_ID}`)).status).toBe(409);
    expect((await ctx.authed("PATCH", `/api/accounts/${TEST_ADMIN_ID}`, { role: "user" })).status).toBe(409);
    expect(ctx.store.data.accounts.filter((a) => a.role === "admin" && a.status === "active")).toHaveLength(1);
  });

  it("兩位管理員同時互相降級對方：只有先到的成功，另一個因為操作者已被降級而 401——不會變成沒有任何管理員", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [second()] });
    const [a, b] = await Promise.all([
      ctx.authedAs(TEST_ADMIN_ID, "PATCH", `/api/accounts/${SECOND}`, { role: "user" }, freshIp()),
      ctx.authedAs(SECOND, "PATCH", `/api/accounts/${TEST_ADMIN_ID}`, { role: "user" }, freshIp()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(ctx.store.data.accounts.filter((x) => x.role === "admin" && x.status === "active")).toHaveLength(1);
  });

  it("PATCH 只改角色就夠了（不必帶姓名或 Email）；一個欄位都沒帶 → 400；同時改姓名與角色，log 兩項都記", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [userAccount()] });
    expect((await ctx.authed("PATCH", `/api/accounts/${USER}`, {}, freshIp())).status).toBe(400);
    const both = await ctx.authed("PATCH", `/api/accounts/${USER}`, { name: "新名字", role: "admin" }, freshIp());
    expect(both.status).toBe(200);
    expect(ctx.log.lines.some((l) => l.includes("修改帳號 user@example.test（姓名、角色 user → admin）"))).toBe(true);
    for (const bad of ["root", "Admin", null, 1]) {
      expect((await ctx.authed("PATCH", `/api/accounts/${USER}`, { role: bad }, freshIp())).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("停用、啟用、重設密碼對一般使用者照樣有效（對方 sessionVersion 加一）；刪除一般使用者不受「最後一位管理員」限制", async () => {
    const ctx = await makeSettingsApp({ extraAccounts: [userAccount()] });
    const oldCookie = ctx.sessionCookie(USER);
    expect((await ctx.authed("POST", `/api/accounts/${USER}/status`, { status: "disabled" })).status).toBe(200);
    expect((await call(ctx.app, "GET", "/api/me", undefined, { cookie: oldCookie })).status).toBe(401);
    expect((await ctx.authed("POST", `/api/accounts/${USER}/status`, { status: "active" })).status).toBe(200);
    expect((await ctx.authed("POST", `/api/accounts/${USER}/password`, { newPassword: GOOD_PASSWORD }, freshIp())).status).toBe(200);
    expect(ctx.store.data.accounts.find((a) => a.id === USER)?.sessionVersion).toBe(4); // 停用、啟用、重設各加一
    expect((await ctx.authed("DELETE", `/api/accounts/${USER}`)).status).toBe(200);
    expect(ctx.store.data.accounts.map((a) => a.id)).toEqual([TEST_ADMIN_ID]);
  });
});
