import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import { createApp } from "../src/app.js";
import { createSessionToken, hashPassword, SESSION_COOKIE_NAME, SetupCodeGuard } from "../src/auth.js";
import { loadEnv } from "../src/env.js";
import { SettingsStore, type Account, type AccountRole } from "../src/settings-store.js";
import { createCapturingLogger, createFetchMock, jsonResponse, makeCredentials, type MockHandler, type RecordedCall } from "./helpers.js";

// ---------------------------------------------------------------------------
// 設定頁相關測試共用的東西：暫存資料目錄、注入假時鐘與假 fetch 的 app、登入用的 cookie。
// ---------------------------------------------------------------------------

/** 測試用管理員（假的）。雜湊每個測試檔只算一次（scrypt 約 50～100 ms），所有預先建立的測試帳號共用它（密碼都是 TEST_ADMIN_PASSWORD）。 */
export const TEST_ADMIN_PASSWORD = "test-admin-password-123";
export const TEST_ADMIN_HASH = await hashPassword(TEST_ADMIN_PASSWORD);
export const TEST_ADMIN_NAME = "測試管理員";
export const TEST_ADMIN_EMAIL = "admin@example.test";
/** 第一位測試管理員的 id（32 位十六進位）。 */
export const TEST_ADMIN_ID = "0123456789abcdef0123456789abcdef";
/** 測試用的首次設定碼（假的）。 */
export const TEST_SETUP_CODE = "ABCD-EFGH";
/** 注入的「現在」：2026-10-05 15:20（台北）。 */
export const NOW_MS = Date.parse("2026-10-05T07:20:00.000Z");

const tempDirs: string[] = [];

export async function makeTempDir(prefix = "savepoint-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 在 afterEach 呼叫：刪掉這個測試建立的所有暫存目錄（先把權限放寬，免得唯讀目錄刪不掉）。 */
export async function cleanupTempDirs(): Promise<void> {
  const { chmod } = await import("node:fs/promises");
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

/** 建立一個測試用的帳號物件（預設：管理員、啟用、sessionVersion 1、密碼是 TEST_ADMIN_PASSWORD）。 */
export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: TEST_ADMIN_ID,
    name: TEST_ADMIN_NAME,
    email: TEST_ADMIN_EMAIL,
    role: "admin",
    passwordHash: TEST_ADMIN_HASH,
    status: "active",
    sessionVersion: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastLoginAt: null,
    ...overrides,
  };
}

/** 依序產生的測試帳號 id（32 位十六進位）。 */
export function accountId(n: number): string {
  return String(n).padStart(32, "0");
}

/** 以 JSON＋XHR 標頭送請求（狀態變更端點要求的格式）。 */
export const XHR_HEADERS = { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };

type TestApp = ReturnType<typeof createApp>;

export function call(app: TestApp, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { ...XHR_HEADERS, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

export interface SettingsAppOptions {
  env?: Record<string, string>;
  /** "unavailable"＝沒有資料目錄；不給就開一個新的暫存目錄。 */
  store?: SettingsStore | "unavailable";
  /** 預設 true：先寫入第一位管理員（TEST_ADMIN_EMAIL，密碼是 TEST_ADMIN_PASSWORD）。false＝全新安裝（沒有任何管理員）。 */
  withAdmin?: boolean;
  /** true＝改成「舊版單一管理密碼」的狀態（只有舊的 admin 欄位、沒有管理員帳號），用來測升級流程。優先於 withAdmin。 */
  legacyAdmin?: boolean;
  /** 另外預先建立的管理員（接在第一位後面）。 */
  extraAccounts?: Account[];
  /** 打到 fetch（LINE）的請求怎麼回應；預設回 {}。 */
  handler?: MockHandler;
  startTime?: number;
  /**
   * true＝不注入設定碼，讓 createApp 自己產生（正式啟動的做法）：設定碼會出現在 log 裡，
   * 錯誤累計太多次換新碼時也會寫進 log。預設 false（注入固定的 TEST_SETUP_CODE，方便測試）。
   */
  defaultSetupCode?: boolean;
}

export async function makeSettingsApp(options: SettingsAppOptions = {}) {
  const log = createCapturingLogger();
  const dir = await makeTempDir();
  const store =
    options.store === "unavailable" ? SettingsStore.unavailable() : (options.store ?? (await SettingsStore.open(dir, { log })));
  if (store.writable && store.data.accounts.length === 0 && store.data.admin === null) {
    if (options.legacyAdmin) {
      await store.update((draft) => {
        draft.admin = { passwordHash: TEST_ADMIN_HASH, updatedAt: "2026-10-01T00:00:00.000Z" };
      });
    } else if (options.withAdmin !== false) {
      await store.update((draft) => {
        draft.accounts.push(makeAccount(), ...(options.extraAccounts ?? []));
      });
    }
  }
  const clock = { now: options.startTime ?? NOW_MS };
  const { mock, calls } = createFetchMock(options.handler ?? (() => jsonResponse({})));
  const setupCode = new SetupCodeGuard({ code: TEST_SETUP_CODE });
  const creds = makeCredentials();
  const app = createApp({
    env: loadEnv({ OPENAI_API_KEY: "test-openai-key-123", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: creds.base64, ...options.env }),
    indexHtml: "<!DOCTYPE html><html><body>測試頁</body></html>",
    log,
    sleep: vi.fn(async () => undefined),
    now: () => clock.now,
    fetchImpl: mock,
    settings: store,
    ...(options.defaultSetupCode ? {} : { setupCode }),
  });
  /**
   * 某個帳號（預設是第一位測試管理員）目前的 session cookie（`sp_session=…`）：用現在的簽章金鑰、假時鐘，
   * 以及該帳號「現在」的 sessionVersion 產生（帳號不存在就用 1，方便測「帳號被刪除後 cookie 失效」）。
   */
  const sessionCookie = (accountId: string = TEST_ADMIN_ID): string => {
    const account = store.data.accounts.find((a) => a.id === accountId);
    return `${SESSION_COOKIE_NAME}=${createSessionToken(store.data.sessionSecret, accountId, account?.sessionVersion ?? 1, clock.now)}`;
  };
  return {
    app,
    store,
    /** 設定檔所在的資料目錄（傳進來的 store 就是它自己的目錄）。 */
    dir: store.writable ? store.dir : dir,
    log,
    calls,
    clock,
    setupCode,
    sessionCookie,
    /** 帶著登入 cookie（第一位測試管理員）的請求。 */
    authed: (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      call(app, method, path, body, { cookie: sessionCookie(), ...headers }),
    /** 帶著指定帳號的登入 cookie 的請求。 */
    authedAs: (accountId: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      call(app, method, path, body, { cookie: sessionCookie(accountId), ...headers }),
  };
}

export type SettingsApp = Awaited<ReturnType<typeof makeSettingsApp>>;

/** 這次回應要設定的 cookie（Set-Cookie 的第一筆）。 */
export function setCookieOf(res: Response): string | undefined {
  return res.headers.getSetCookie()[0];
}

/**
 * 把 Set-Cookie 拆成「屬性」陣列（`sp_session=…`、`Path=/`、`HttpOnly`…），用來做「整個屬性相等」的斷言：
 * 只用 toContain("Path=/") 的話，`Path=/x` 也會通過。
 */
export function cookieAttributes(setCookie: string): string[] {
  return setCookie.split(";").map((part) => part.trim());
}

/** 從 Set-Cookie 取出 `名稱=值`（去掉屬性），可直接當 Cookie 請求標頭用。 */
export function cookiePair(res: Response): string {
  const raw = setCookieOf(res);
  if (!raw) throw new Error("回應沒有 Set-Cookie");
  return raw.split(";")[0]!;
}

/** LINE 假伺服器：依 URL 回應（預設全部 200 {}；group summary 回 groupName）。 */
export function lineHandler(options: { groupName?: string; summaryStatus?: number; pushStatus?: number; replyStatus?: number } = {}): MockHandler {
  return (c: RecordedCall) => {
    if (c.url.endsWith("/summary")) {
      if (options.summaryStatus && options.summaryStatus !== 200) {
        return jsonResponse({ message: "Not found" }, options.summaryStatus);
      }
      return jsonResponse({ groupId: c.url.split("/").at(-2), groupName: options.groupName ?? "倉庫群組", pictureUrl: "https://example.test/p.png" });
    }
    if (c.url.endsWith("/message/push")) {
      return options.pushStatus && options.pushStatus !== 200 ? jsonResponse({ message: "raw line error" }, options.pushStatus) : jsonResponse({});
    }
    if (c.url.endsWith("/message/reply")) {
      return options.replyStatus && options.replyStatus !== 200 ? jsonResponse({ message: "raw line error" }, options.replyStatus) : jsonResponse({});
    }
    throw new Error(`測試未預期的 fetch：${c.method} ${c.url}`);
  };
}

// ---------------------------------------------------------------------------
// 全站登入之後，OCR／存檔／關箱通知都要登入：給這些 API 的測試用的「有帳號的設定檔 store」與它的登入標頭。
// ---------------------------------------------------------------------------

export interface AuthFixture {
  store: SettingsStore;
  account: Account;
  /** `sp_session=…`：這位帳號的登入 cookie（有效期 100 年，不受測試注入的假時鐘影響）。 */
  cookie: string;
  /** 打 OCR／存檔／關箱通知要帶的標頭：登入 cookie ＋ X-Requested-With。 */
  headers: Record<string, string>;
  dir: string;
}

/**
 * 建立一個暫存資料目錄與設定檔 store，裡面有一個帳號（預設角色 user：任一角色都能用裝箱程式的 API，
 * 用一般使用者來測才看得出「不需要管理員」）。暫存目錄由 cleanupTempDirs 一併刪除。
 */
export async function createAuthFixture(options: { role?: AccountRole; name?: string; email?: string } = {}): Promise<AuthFixture> {
  const dir = await makeTempDir();
  const store = await SettingsStore.open(dir, { log: createCapturingLogger() });
  const account = makeAccount({
    id: accountId(7001),
    name: options.name ?? "測試使用者",
    email: options.email ?? "user@example.test",
    role: options.role ?? "user",
  });
  await store.update((draft) => {
    draft.accounts.push(account);
  });
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(store.data.sessionSecret, account.id, account.sessionVersion, Date.now(), 100 * 365 * 24 * 3600 * 1000)}`;
  return { store, account, cookie, headers: { cookie, "x-requested-with": "XMLHttpRequest" }, dir };
}
