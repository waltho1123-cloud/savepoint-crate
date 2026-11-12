import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "../src/auth.js";
import { findAccountByEmail, HUB_TOKEN_MAX_LENGTH, ssoNotice, verifyHubToken } from "../src/hub-sso.js";
import { SettingsStore } from "../src/settings-store.js";
import {
  accountId,
  cleanupTempDirs,
  cookieAttributes,
  cookiePair,
  makeAccount,
  makeSettingsApp,
  NOW_MS,
  setCookieOf,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_ID,
} from "./settings-helpers.js";

const SECRET = "test-hub-secret-not-real-0123456789abcdef";
const NOW_S = Math.floor(NOW_MS / 1000);
const USER_ID = accountId(41);
const USER_EMAIL = "user@example.test";

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const sign = (headerPart: string, payloadPart: string, secret = SECRET) =>
  createHmac("sha256", Buffer.from(secret, "utf8")).update(`${headerPart}.${payloadPart}`).digest("base64url");
/** 用 Hub 的格式簽一張票（可覆寫 claims；值為 undefined 的欄位會被拿掉）。 */
function makeToken(claims: Record<string, unknown> = {}, options: { header?: unknown; secret?: string } = {}): string {
  const base: Record<string, unknown> = {
    sub: "hub-user-1",
    email: USER_EMAIL,
    name: "Hub 名字",
    role: "admin",
    app: "savepoint-crate",
    iss: "wiwi-hub",
    aud: "savepoint-crate",
    iat: NOW_S,
    exp: NOW_S + 60,
    ...claims,
  };
  const headerPart = b64(JSON.stringify(options.header ?? { alg: "HS256" }));
  const payloadPart = b64(JSON.stringify(base));
  return `${headerPart}.${payloadPart}.${sign(headerPart, payloadPart, options.secret)}`;
}
/** 簽一張「payload 是任意位元組」的票。 */
function rawPayloadToken(payload: Buffer | string): string {
  const headerPart = b64(JSON.stringify({ alg: "HS256" }));
  const payloadPart = b64(payload);
  return `${headerPart}.${payloadPart}.${sign(headerPart, payloadPart)}`;
}
/** 失敗回應不得發出有效的 session：最多只有「清除 sp_session」（空值）的 Set-Cookie。 */
function expectNoSessionIssued(res: Response): void {
  for (const c of res.headers.getSetCookie()) expect(c.startsWith(`${SESSION_COOKIE_NAME}=;`) && c.includes("Max-Age=0"), c).toBe(true);
}
const verify = (token: unknown, nowMs = NOW_MS) => verifyHubToken(token, SECRET, nowMs);

describe("verifyHubToken（規格 2–5）", () => {
  it("合法票回正規化後的 email（trim＋小寫）", () => {
    expect(verify(makeToken())).toBe(USER_EMAIL);
    expect(verify(makeToken({ email: "  User@Example.TEST " }))).toBe(USER_EMAIL);
  });

  it("沒有 iat 也可以（iat 只在存在時檢查）", () => {
    expect(verify(makeToken({ iat: undefined }))).toBe(USER_EMAIL);
  });

  it.each([
    ["非字串", 123],
    ["undefined", undefined],
    ["空字串", ""],
    ["兩段", "a.b"],
    ["四段", "a.b.c.d"],
    ["空的段", ".."],
  ])("票證格式不對：%s", (_name, token) => {
    expect(verify(token)).toBeNull();
  });

  it("長度上限 4096", () => {
    const header = b64(JSON.stringify({ alg: "HS256" }));
    const payload = b64(JSON.stringify({ iss: "wiwi-hub", aud: "savepoint-crate", exp: NOW_S + 60, email: USER_EMAIL, pad: "x".repeat(HUB_TOKEN_MAX_LENGTH) }));
    const token = `${header}.${payload}.${sign(header, payload)}`;
    expect(token.length).toBeGreaterThan(HUB_TOKEN_MAX_LENGTH);
    expect(verify(token)).toBeNull();
  });

  it("嚴格 base64url：padding、非法字元、非標準編碼（尾端多餘位元）都拒絕", () => {
    const [h, p, s] = makeToken().split(".") as [string, string, string];
    expect(verify(`${h}=.${p}.${s}`)).toBeNull();
    expect(verify(`${h}.${p}+.${s}`)).toBeNull();
    expect(verify(`${h}.${p}.${s}=`)).toBeNull();
    expect(verify(`${h}.${p}.${s}!`)).toBeNull();
    // 簽章最後一個字元只有 2 個有效位元；換成同樣解出相同位元組的別種寫法，重新編碼不相同 → 拒絕
    const last = s[s.length - 1]!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = alphabet[(alphabet.indexOf(last) + 1) % 64]!;
    expect(Buffer.from(s.slice(0, -1) + sibling, "base64url").equals(Buffer.from(s, "base64url"))).toBe(true);
    expect(verify(`${h}.${p}.${s.slice(0, -1)}${sibling}`)).toBeNull();
  });

  it.each([
    ["none", { alg: "none" }],
    ["HS384", { alg: "HS384" }],
    ["RS256", { alg: "RS256" }],
    ["小寫 hs256", { alg: "hs256" }],
    ["沒有 alg", {}],
    ["alg 不是字串", { alg: ["HS256"] }],
  ])("header 的 alg 必須恰為 HS256：%s", (_name, header) => {
    expect(verify(makeToken({}, { header }))).toBeNull();
  });

  it("header 不是物件、不是 JSON、不是 UTF-8 都拒絕", () => {
    for (const bad of ["[]", "null", '"HS256"', "not json", "123"]) {
      const h = b64(bad);
      const p = b64(JSON.stringify({ iss: "wiwi-hub", aud: "savepoint-crate", exp: NOW_S + 60, email: USER_EMAIL }));
      expect(verify(`${h}.${p}.${sign(h, p)}`)).toBeNull();
    }
    const h = b64(Buffer.from([0xff, 0xfe, 0x7b]));
    const p = b64("{}");
    expect(verify(`${h}.${p}.${sign(h, p)}`)).toBeNull();
  });

  it("簽章：錯密鑰、被竄改的 payload、長度不同的簽章", () => {
    expect(verify(makeToken({}, { secret: "another-fake-secret-0123456789" }))).toBeNull();
    const [h, p, s] = makeToken().split(".") as [string, string, string];
    const forged = b64(JSON.stringify({ iss: "wiwi-hub", aud: "savepoint-crate", exp: NOW_S + 60, email: "evil@example.test" }));
    expect(verify(`${h}.${forged}.${s}`)).toBeNull();
    expect(verify(`${h}.${p}.${s.slice(0, -2)}`)).toBeNull();
    expect(verify(`${h}.${p}.${s}AA`)).toBeNull();
    expect(verifyHubToken(makeToken(), "", NOW_MS)).toBeNull();
  });

  it("iss／aud 必須恰好符合；aud 陣列一律拒絕", () => {
    expect(verify(makeToken({ iss: "someone-else" }))).toBeNull();
    expect(verify(makeToken({ iss: undefined }))).toBeNull();
    expect(verify(makeToken({ aud: "other-app" }))).toBeNull();
    expect(verify(makeToken({ aud: ["savepoint-crate"] }))).toBeNull();
    expect(verify(makeToken({ aud: undefined }))).toBeNull();
  });

  it("exp：必須存在且為有限數字；過期容忍 30 秒", () => {
    expect(verify(makeToken({ exp: undefined }))).toBeNull();
    expect(verify(makeToken({ exp: "9999999999" }))).toBeNull();
    expect(verify(makeToken({ exp: null }))).toBeNull();
    expect(verify(makeToken({ exp: NOW_S - 29, iat: NOW_S - 80 }))).toBe(USER_EMAIL);
    expect(verify(makeToken({ exp: NOW_S - 31, iat: NOW_S - 80 }))).toBeNull();
  });

  it("iat：若存在須為有限數字、不得晚於現在 30 秒以上、exp − iat ≤ 600", () => {
    expect(verify(makeToken({ iat: "1" }))).toBeNull();
    expect(verify(makeToken({ iat: NOW_S + 29, exp: NOW_S + 60 }))).toBe(USER_EMAIL);
    expect(verify(makeToken({ iat: NOW_S + 31, exp: NOW_S + 60 }))).toBeNull();
    expect(verify(makeToken({ iat: NOW_S, exp: NOW_S + 600 }))).toBe(USER_EMAIL);
    expect(verify(makeToken({ iat: NOW_S, exp: NOW_S + 601 }))).toBeNull();
  });

  it("email：必須是字串、符合 email 形狀、長度 ≤ 254、不含控制字元", () => {
    for (const email of [undefined, null, 5, ["a@b.co"], "", "   ", "no-at-sign", "a@b", "a@@b.co", "a b@example.test", "a\u0000@example.test", "a@exam\nple.test", `${"a".repeat(250)}@b.co`]) {
      expect(verify(makeToken({ email })), JSON.stringify(email)).toBeNull();
    }
  });

  it("R3：email 含 Cc（含 C1 的 U+0085、U+009B）、Cf（U+200B、U+202E）或孤立代理對一律無效；前後的控制／格式字元也不能靠 trim 蒙混", () => {
    const bad = ["\u0085", "\u009b", "\u200b", "\u202e", "\ud800", "\udc00", "\u0000", "\u007f", "\ufeff", "\u2060"];
    for (const ch of bad) {
      for (const email of [`us${ch}er@example.test`, `${ch}user@example.test`, `user${ch}@example.test`, `user@exa${ch}mple.test`, `user@example.test${ch}`]) {
        expect(verify(makeToken({ email })), JSON.stringify(email)).toBeNull();
      }
    }
  });

  it("email 總長度邊界：254 通過、255 拒絕（本地部分與網域各段都在各自上限內，只有總長度不同）", () => {
    const label = "b".repeat(63);
    const local = "a".repeat(64);
    const e254 = `${local}@${label}.${label}.${"c".repeat(61)}`;
    expect(e254.length).toBe(254);
    expect(verify(makeToken({ email: e254 }))).toBe(e254);
    const e255 = `${e254}c`;
    expect(e255.length).toBe(255);
    expect(verify(makeToken({ email: e255 }))).toBeNull();
  });

  it("R5：深層巢狀 JSON 在長度上限內也只回 null／email，不丟例外（header 段與 payload 段各一；payload 用正確簽章才進得到解析）", () => {
    const depth = 1400;
    const deep = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    // payload 段：整個 payload 是深層陣列（簽章正確 → 進到 JSON 解析 → 不是物件 → null）
    const deepPayload = rawPayloadToken(deep);
    expect(deepPayload.length).toBeLessThanOrEqual(HUB_TOKEN_MAX_LENGTH);
    expect(() => verify(deepPayload)).not.toThrow();
    expect(verify(deepPayload)).toBeNull();
    // 物件裡面巢狀很深、其餘 claims 合法：解析得過，採用 email（巢狀欄位被忽略）
    const claimsWithDeep = `{"a":${deep},"iss":"wiwi-hub","aud":"savepoint-crate","exp":${NOW_S + 60},"email":"${USER_EMAIL}"}`;
    const nested = rawPayloadToken(claimsWithDeep);
    expect(nested.length).toBeLessThanOrEqual(HUB_TOKEN_MAX_LENGTH);
    expect(verify(nested)).toBe(USER_EMAIL);
    // header 段：整個 header 是深層陣列／物件（簽章對 header.payload 字串算，所以簽章也正確）
    for (const headerJson of [deep, `{"alg":"HS256","x":${deep}}`.replace('"alg":"HS256",', '"alg":"none",')]) {
      const h = b64(headerJson);
      const p = b64(JSON.stringify({ iss: "wiwi-hub", aud: "savepoint-crate", exp: NOW_S + 60, email: USER_EMAIL }));
      const token = `${h}.${p}.${sign(h, p)}`;
      expect(token.length).toBeLessThanOrEqual(HUB_TOKEN_MAX_LENGTH);
      expect(() => verify(token)).not.toThrow();
      expect(verify(token)).toBeNull();
    }
  });

  it("R5：長度上限邊界——其他條件全部合法，剛好 4096 通過、超過上限被拒", () => {
    /** 組一張簽章正確、claims 合法、總長剛好是 target 的票（用 payload 的填充欄位與 header 的空白微調）。 */
    function tokenOfLength(target: number): string {
      for (let headerSpaces = 0; headerSpaces < 3; headerSpaces += 1) {
        const h = b64(`{"alg":"HS256"${" ".repeat(headerSpaces)}}`);
        for (let pad = 0; pad < 4000; pad += 1) {
          const p = b64(JSON.stringify({ iss: "wiwi-hub", aud: "savepoint-crate", exp: NOW_S + 60, email: USER_EMAIL, pad: "x".repeat(pad) }));
          const length = h.length + p.length + 43 + 2;
          if (length > target) break;
          if (length === target) return `${h}.${p}.${sign(h, p)}`;
        }
      }
      throw new Error(`組不出長度 ${target} 的票`);
    }
    const atLimit = tokenOfLength(HUB_TOKEN_MAX_LENGTH);
    expect(atLimit.length).toBe(HUB_TOKEN_MAX_LENGTH);
    expect(verify(atLimit)).toBe(USER_EMAIL);
    const over = tokenOfLength(HUB_TOKEN_MAX_LENGTH + 1);
    expect(over.length).toBe(HUB_TOKEN_MAX_LENGTH + 1);
    expect(verify(over)).toBeNull();
  });

  it("R5：非 canonical base64url——只改最後一個字元的填充位元、解碼結果相同；payload／header 段重新簽章讓 HMAC 仍合法，仍須拒絕", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = (seg: string) => seg.slice(0, -1) + alphabet[(alphabet.indexOf(seg[seg.length - 1]!) + 1) % 64]!;
    // payload：挑一個位元組數不是 3 的倍數的 JSON（最後一個字元帶未使用的位元）
    let payloadJson = "";
    for (let pad = 0; pad < 3; pad += 1) {
      payloadJson = JSON.stringify({ iss: "wiwi-hub", aud: "savepoint-crate", exp: NOW_S + 60, email: USER_EMAIL, pad: "x".repeat(pad) });
      if (Buffer.byteLength(payloadJson) % 3 !== 0) break;
    }
    const h = b64(JSON.stringify({ alg: "HS256" }));
    const p = b64(payloadJson);
    expect(verify(`${h}.${p}.${sign(h, p)}`)).toBe(USER_EMAIL);
    const p2 = sibling(p);
    expect(Buffer.from(p2, "base64url").equals(Buffer.from(p, "base64url"))).toBe(true);
    expect(verify(`${h}.${p2}.${sign(h, p2)}`)).toBeNull();
    // header 段同理：{"alg":"HS256"} 是 15 個位元組（3 的倍數），加一個空白變 16 個位元組
    const hPad = b64('{"alg":"HS256" }');
    expect(verify(`${hPad}.${p}.${sign(hPad, p)}`)).toBe(USER_EMAIL);
    const hPad2 = sibling(hPad);
    expect(Buffer.from(hPad2, "base64url").equals(Buffer.from(hPad, "base64url"))).toBe(true);
    expect(verify(`${hPad2}.${p}.${sign(hPad2, p)}`)).toBeNull();
  });

  it("惡意輸入一律回 null、不丟例外：深層巢狀、非 UTF-8、超大數字、NaN／Infinity、型別錯誤", () => {
    const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
    const cases: Array<Buffer | string> = [
      deep,
      `{"a":${deep},"iss":"wiwi-hub"}`,
      Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
      '{"iss":"wiwi-hub","aud":"savepoint-crate","exp":1e999,"email":"user@example.test"}',
      '{"iss":"wiwi-hub","aud":"savepoint-crate","exp":-1e999,"email":"user@example.test"}',
      `{"iss":"wiwi-hub","aud":"savepoint-crate","exp":${NOW_S + 60},"iat":1e999,"email":"user@example.test"}`,
      '{"iss":"wiwi-hub","aud":"savepoint-crate","exp":NaN,"email":"user@example.test"}',
      '{"iss":"wiwi-hub","aud":"savepoint-crate","exp":Infinity,"email":"user@example.test"}',
      "null",
      "[]",
      '"str"',
      "123",
      '{"iss":{},"aud":{},"exp":{},"email":{}}',
    ];
    for (const payload of cases) {
      const token = rawPayloadToken(payload);
      if (token.length > HUB_TOKEN_MAX_LENGTH) {
        expect(verify(token)).toBeNull();
        continue;
      }
      expect(() => verify(token)).not.toThrow();
      expect(verify(token)).toBeNull();
    }
    for (const weird of [{}, [], Symbol("x"), 1n, () => 1, new Proxy({}, { get: () => { throw new Error("boom"); } })]) {
      expect(() => verifyHubToken(weird, SECRET, NOW_MS)).not.toThrow();
      expect(verifyHubToken(weird, SECRET, NOW_MS)).toBeNull();
    }
  });
});

describe("findAccountByEmail（規格 6）", () => {
  const acc = (email: string) => ({ email });
  it("資料檔 email 沒正規化也能比對；恰好一筆才算", () => {
    expect(findAccountByEmail([acc("  User@Example.test ")], USER_EMAIL)).toEqual(acc("  User@Example.test "));
    expect(findAccountByEmail([acc("a@example.test")], USER_EMAIL)).toBeUndefined();
    expect(findAccountByEmail([acc("USER@example.test"), acc("user@example.test")], USER_EMAIL)).toBeUndefined();
  });
  it("_ 與 % 不是萬用字元：u_er@ 不會對到 user@", () => {
    expect(findAccountByEmail([acc("user@example.test")], "u_er@example.test")).toBeUndefined();
    expect(findAccountByEmail([acc("user@example.test")], "%@example.test")).toBeUndefined();
    expect(findAccountByEmail([acc("u_er@example.test")], "u_er@example.test")).toBeDefined();
  });
});

describe("ssoNotice（規格 8）", () => {
  it("白名單查表；白名單外（含 __proto__、constructor）回 null", () => {
    expect(ssoNotice("invalid")).toBe("WIWI Hub 單一登入失敗，請重新從 Hub 進入或改用原本的方式登入");
    expect(ssoNotice("no_account")).toBe("WIWI Hub 單一登入失敗：此 Email 尚未在本系統建立帳號或已停用");
    for (const code of [undefined, "", "__proto__", "constructor", "toString", "hasOwnProperty", "INVALID", "<script>"]) {
      expect(ssoNotice(code), String(code)).toBeNull();
    }
  });
});

describe("GET /sso/callback", () => {
  const saved = process.env.HUB_JWT_SECRET;
  beforeEach(() => {
    process.env.HUB_JWT_SECRET = SECRET;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.HUB_JWT_SECRET;
    else process.env.HUB_JWT_SECRET = saved;
    await cleanupTempDirs();
  });

  const makeApp = (options: Parameters<typeof makeSettingsApp>[0] = {}) =>
    makeSettingsApp({ extraAccounts: [makeAccount({ id: USER_ID, name: "一般同事", email: USER_EMAIL, role: "user" })], ...options });
  const hit = (ctx: Awaited<ReturnType<typeof makeApp>>, query: string, headers: Record<string, string> = {}) => ctx.app.request(`/sso/callback${query}`, { headers });
  const tokenQuery = (token: string) => `?sso_token=${encodeURIComponent(token)}`;

  it("規格 1：未設定／空白／全空白的 HUB_JWT_SECRET → 404，沒有 Location、沒有 Set-Cookie，也不拿系統自己的密鑰驗簽", async () => {
    const ctx = await makeApp();
    for (const value of [undefined, "", "   \n"]) {
      if (value === undefined) delete process.env.HUB_JWT_SECRET;
      else process.env.HUB_JWT_SECRET = value;
      const sessionSecret = ctx.store.data.sessionSecret;
      const forgedWithSessionSecret = makeToken({}, { secret: sessionSecret });
      for (const query of [tokenQuery(makeToken()), tokenQuery(forgedWithSessionSecret), ""]) {
        const res = await hit(ctx, query);
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.getSetCookie()).toEqual([]);
      }
    }
  });

  it("每次請求現讀環境變數：執行中才設定也立刻生效", async () => {
    const ctx = await makeApp();
    delete process.env.HUB_JWT_SECRET;
    expect((await hit(ctx, tokenQuery(makeToken()))).status).toBe(404);
    process.env.HUB_JWT_SECRET = SECRET;
    expect((await hit(ctx, tokenQuery(makeToken()))).status).toBe(302);
  });

  it("規格 7：合法票＋啟用帳號 → 302 到 /，發與密碼登入相同格式的 sp_session，拿它能呼叫需要登入的 API", async () => {
    const ctx = await makeApp();
    const res = await hit(ctx, tokenQuery(makeToken()), { "x-forwarded-proto": "https" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = setCookieOf(res)!;
    expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    for (const attr of ["HttpOnly", "SameSite=Lax", "Path=/", "Secure"]) expect(setCookie).toContain(attr);
    const me = await ctx.app.request("/api/me", { headers: { cookie: cookiePair(res) } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { data: { id: string; email: string; role: string } };
    expect(body.data).toMatchObject({ id: USER_ID, email: USER_EMAIL, role: "user" });
    // 與密碼登入同樣會更新 lastLoginAt、寫審計 log
    expect(ctx.store.data.accounts.find((a) => a.id === USER_ID)?.lastLoginAt).toBe(new Date(NOW_MS).toISOString());
    expect(ctx.log.lines.some((l) => l.includes(USER_EMAIL) && l.includes("登入成功"))).toBe(true);
  });

  it("admin 也能走 SSO；權限以本地角色為準（Hub 傳來的 role／name 不採信）", async () => {
    const ctx = await makeApp();
    const adminRes = await hit(ctx, tokenQuery(makeToken({ email: TEST_ADMIN_EMAIL, role: "user", name: "x" })));
    expect(adminRes.headers.get("location")).toBe("/");
    const me = (await (await ctx.app.request("/api/me", { headers: { cookie: cookiePair(adminRes) } })).json()) as { data: { id: string; role: string; name: string } };
    expect(me.data).toMatchObject({ id: TEST_ADMIN_ID, role: "admin" });
    expect(me.data.name).not.toBe("x");
    const userRes = await hit(ctx, tokenQuery(makeToken({ role: "admin", name: "Hub 名字" })));
    const settingsPage = await ctx.app.request("/api/accounts", { headers: { cookie: cookiePair(userRes) } });
    expect(settingsPage.status).toBe(403);
  });

  it("規格 6：查無帳號、停用帳號、重複 email → no_account；不自動建帳號", async () => {
    const ctx = await makeApp();
    const before = ctx.store.data.accounts.length;
    const none = await hit(ctx, tokenQuery(makeToken({ email: "nobody@example.test" })));
    expect(none.headers.get("location")).toBe("/login?sso=no_account");
    expectNoSessionIssued(none);
    expect(ctx.store.data.accounts.length).toBe(before);

    await ctx.store.update((d) => {
      d.accounts.find((a) => a.id === USER_ID)!.status = "disabled";
    });
    const disabled = await hit(ctx, tokenQuery(makeToken()));
    expect(disabled.headers.get("location")).toBe("/login?sso=no_account");
    expectNoSessionIssued(disabled);

    await ctx.store.update((d) => {
      const u = d.accounts.find((a) => a.id === USER_ID)!;
      u.status = "active";
      d.accounts.push({ ...u, id: accountId(42), email: "USER@example.test" });
    });
    const dup = await hit(ctx, tokenQuery(makeToken()));
    expect(dup.headers.get("location")).toBe("/login?sso=no_account");
  });

  it("沒有可用的資料目錄 → no_account（沒有地方存帳號）", async () => {
    const ctx = await makeSettingsApp({ store: SettingsStore.unavailable() });
    const res = await hit(ctx, tokenQuery(makeToken()));
    expect(res.headers.get("location")).toBe("/login?sso=no_account");
  });

  it("規格 2、5：sso_token 缺少、出現兩次、假票、壞票 → 一律 /login?sso=invalid（不分原因、不發 cookie）", async () => {
    const ctx = await makeApp();
    const good = makeToken();
    const queries = [
      "",
      "?sso_token=",
      `?sso_token=${good}&sso_token=${good}`,
      `?sso_token=${good}&sso_token=x`,
      "?sso_token=abc.def.ghi",
      tokenQuery(makeToken({}, { secret: "wrong-fake-secret-0123456789" })),
      tokenQuery(makeToken({ aud: "other" })),
      tokenQuery(makeToken({ exp: NOW_S - 1000, iat: NOW_S - 1060 })),
      tokenQuery(makeToken({}, { header: { alg: "none" } })),
      tokenQuery(rawPayloadToken(`${"[".repeat(1200)}`)),
      `?sso_token=${"A".repeat(5000)}`,
      "?sso_token=%ff%fe",
    ];
    for (const q of queries) {
      const res = await hit(ctx, q);
      expect(res.status, q.slice(0, 40)).toBe(302);
      expect(res.headers.get("location")).toBe("/login?sso=invalid");
      expectNoSessionIssued(res);
    }
  });

  it("R2：帶著另一個帳號的有效 session 走每一條失敗路徑 → 回應清掉 sp_session、導到登入頁，瀏覽器清 cookie 後看得到 ?sso= 提示", async () => {
    const ctx = await makeApp();
    const oldCookie = ctx.sessionCookie(TEST_ADMIN_ID);
    // 對照：舊 cookie 沒被清掉時，/login 會把已登入的人彈回 /，提示永遠看不到（這就是要修的問題）
    const bounced = await ctx.app.request("/login?sso=invalid", { headers: { cookie: oldCookie } });
    expect(bounced.status).toBe(302);
    expect(bounced.headers.get("location")).toBe("/");

    const good = makeToken();
    const paths: Array<[string, string, string]> = [
      ["沒有 sso_token", "", "/login?sso=invalid"],
      ["票數不對", `?sso_token=${good}&sso_token=${good}`, "/login?sso=invalid"],
      ["假票", "?sso_token=abc.def.ghi", "/login?sso=invalid"],
      ["錯密鑰", tokenQuery(makeToken({}, { secret: "wrong-fake-secret-0123456789" })), "/login?sso=invalid"],
      ["查無帳號", tokenQuery(makeToken({ email: "nobody@example.test" })), "/login?sso=no_account"],
    ];
    for (const [name, query, location] of paths) {
      const res = await hit(ctx, query, { cookie: oldCookie });
      expect(res.status, name).toBe(302);
      expect(res.headers.get("location"), name).toBe(location);
      const cleared = res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      expect(cleared.length, name).toBe(1);
      const attrs = cookieAttributes(cleared[0]!);
      expect(attrs[0], name).toBe(`${SESSION_COOKIE_NAME}=`);
      expect(attrs, name).toContain("Path=/");
      expect(attrs.some((a) => a === "Max-Age=0"), name).toBe(true);
      // 瀏覽器照指示清掉 cookie 後，跟著導向去 /login：不會被彈走，看得到提示
      const page = await ctx.app.request(location);
      expect(page.status, name).toBe(200);
      expect(await page.text(), name).toContain("sso-notice");
    }
    // 停用帳號
    await ctx.store.update((d) => {
      d.accounts.find((a) => a.id === USER_ID)!.status = "disabled";
    });
    const disabled = await hit(ctx, tokenQuery(good), { cookie: oldCookie });
    expect(disabled.headers.get("location")).toBe("/login?sso=no_account");
    expect(setCookieOf(disabled)!.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
  });

  it("R2：未設定密鑰的 404 路徑即使帶舊 cookie 也沒有任何 Set-Cookie", async () => {
    const ctx = await makeApp();
    delete process.env.HUB_JWT_SECRET;
    const res = await hit(ctx, tokenQuery(makeToken()), { cookie: ctx.sessionCookie(TEST_ADMIN_ID) });
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("規格 9：忽略 next／redirect 之類的參數；Location 一律是相對路徑，不受 Host／X-Forwarded-Host 影響", async () => {
    const ctx = await makeApp();
    const ok = await ctx.app.request(`/sso/callback${tokenQuery(makeToken())}&next=https://evil.test/&redirect=//evil.test&redirect_uri=/settings`, {
      headers: { host: "internal-container:8080", "x-forwarded-host": "evil.test" },
    });
    expect(ok.headers.get("location")).toBe("/");
    const bad = await ctx.app.request("/sso/callback?sso_token=bad&next=https://evil.test/", { headers: { host: "internal-container:8080" } });
    expect(bad.headers.get("location")).toBe("/login?sso=invalid");
  });

  it("規格 10：票證與 email 不寫進 log；服務也沒有記錄請求網址的 access log", async () => {
    const ctx = await makeApp();
    const token = makeToken();
    await hit(ctx, tokenQuery(token));
    await hit(ctx, tokenQuery(makeToken({ email: "nobody@example.test" })));
    await hit(ctx, tokenQuery("bad.token.value"));
    const all = ctx.log.lines.join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain("sso_token");
    expect(all).not.toContain("nobody@example.test");
    // 沒有 access log：src 底下沒有 hono/logger，也沒有用 console 記請求網址
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(server + app).not.toMatch(/hono\/logger|logger\(\)/);
  });

  it("規格 11：不吃逐 IP 的額度——同一個 IP 連續打 40 次（> 登入的 10 次／分）都不會 429", async () => {
    const ctx = await makeApp();
    for (let i = 0; i < 40; i += 1) {
      const res = await hit(ctx, tokenQuery("bad.token.value"), { "x-forwarded-for": "198.51.100.7" });
      expect(res.status).toBe(302);
    }
    // SSO 失敗也不影響密碼登入的限流額度
    const login = await ctx.app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ email: USER_EMAIL, password: "wrong-password-xx" }),
    });
    expect(login.status).toBe(401);
  });

  it("非 GET 方法回 405；回應不快取", async () => {
    const ctx = await makeApp();
    const post = await ctx.app.request(`/sso/callback${tokenQuery(makeToken())}`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    const res = await hit(ctx, tokenQuery(makeToken()));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("寫檔失敗（Volume 唯讀）時仍能單一登入，與密碼登入相同", async () => {
    const ctx = await makeApp();
    const original = ctx.store.update.bind(ctx.store);
    ctx.store.update = async () => {
      const { ServiceError } = await import("../src/common.js");
      throw new ServiceError(500, "寫檔失敗");
    };
    const res = await hit(ctx, tokenQuery(makeToken()));
    ctx.store.update = original;
    expect(res.headers.get("location")).toBe("/");
    expect(ctx.log.warns.some((w) => w.includes("無法更新最後登入時間"))).toBe(true);
  });
});

describe("登入頁的 ?sso= 提示（規格 8）", () => {
  afterEach(cleanupTempDirs);
  const loginPage = async (query: string) => {
    const ctx = await makeSettingsApp();
    const res = await ctx.app.request(`/login${query}`);
    expect(res.status).toBe(200);
    return res.text();
  };

  it("invalid／no_account 顯示固定的中文提示", async () => {
    expect(await loginPage("?sso=invalid")).toContain("WIWI Hub 單一登入失敗，請重新從 Hub 進入或改用原本的方式登入");
    expect(await loginPage("?sso=no_account")).toContain("WIWI Hub 單一登入失敗：此 Email 尚未在本系統建立帳號或已停用");
  });

  it("沒帶參數、或白名單外的值：不顯示提示，也不把參數原文輸出到頁面", async () => {
    expect(await loginPage("")).not.toContain("sso-notice");
    for (const value of ["__proto__", "constructor", "toString", "unknown", "%3Cscript%3Ealert(1)%3C/script%3E", "invalid%00"]) {
      const html = await loginPage(`?sso=${value}`);
      expect(html, value).not.toContain("sso-notice");
      expect(html, value).not.toContain(decodeURIComponent(value));
    }
    expect(await loginPage("?sso=invalid&sso=no_account")).toContain("sso-notice"); // 第一個值為準，仍是白名單內的固定文字
  });
});
