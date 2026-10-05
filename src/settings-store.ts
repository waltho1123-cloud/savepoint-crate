import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describeError, ServiceError, type Logger } from "./common.js";

/**
 * 設定檔儲存（放在 Volume 上的 DATA_DIR/settings.json）：登入帳號（姓名、Email、角色、密碼雜湊…）、登入 session 金鑰、
 * LINE 設定、webhook 最近收到的群組。整份載入記憶體，變更時「先寫檔、成功才更新記憶體」；
 * 寫檔用暫存檔＋rename（原子替換），權限 0600。
 *
 * 資料目錄不存在或不可寫時，store 進入「不可用」狀態（writable=false）：沒有地方存帳號，所以沒有人登得進去——
 * 整個網站（含裝箱主頁與 OCR、存檔、關箱通知）都回 503「請在 Zeabur 掛載 Volume 到 /app/data」。
 *
 * 檔案格式版本：
 *   - version 1：最舊的版本，只有一個管理密碼（`admin: { passwordHash, updatedAt }`），沒有帳號。
 *   - version 2：管理員帳號（`admins: [...]`，沒有角色欄位）。舊的 `admin` 只保留到升級完成為止。
 *   - version 3：帳號（`accounts: [...]`，每筆多一個 `role: "admin" | "user"`）。
 * 載入時三種都收；版本 1／2 只在記憶體轉換（版本 2 的 admins 全部視為角色 admin），**所有欄位（含不認識的）原樣保留、寫回去**。
 * 沒有帳號時檔案維持載入時的版本（版本 1 的檔案在升級成帳號之前一直維持版本 1），所以升級前回滾到舊版程式仍然讀得懂；
 * 有了帳號的那一次寫入才會變成版本 3（之後舊版程式不認得版本 3，會把檔案當成損毀）。
 */

/** 資料目錄不可用時，設定相關端點回的訊息（Zeabur 上要掛 Volume 的位置固定是 /app/data）。 */
export const DATA_DIR_UNAVAILABLE_MESSAGE = "請在 Zeabur 掛載 Volume 到 /app/data";

export const SETTINGS_FILE_NAME = "settings.json";
/** 目前的檔案格式版本（帳號含角色）。 */
export const SETTINGS_VERSION = 3;
/** 舊版格式：版本 1＝單一管理密碼、版本 2＝管理員帳號（沒有角色）；載入時仍然接受。 */
export const LEGACY_SETTINGS_VERSION = 1;
export const ADMINS_SETTINGS_VERSION = 2;
export type SettingsVersion = typeof LEGACY_SETTINGS_VERSION | typeof ADMINS_SETTINGS_VERSION | typeof SETTINGS_VERSION;
/** webhook 最近收到的群組最多留幾筆（最新的在前）。 */
export const CAPTURED_GROUPS_MAX = 10;
/** 資料目錄裡殘留的暫存檔（被強制結束的寫入、寫入探測）超過這個時間才會被清掉，免得誤刪另一個行程剛建的。 */
export const STALE_TEMP_MS = 10 * 60 * 1000;

/** 舊版的單一管理密碼（只在升級前存在；升級成管理員帳號時刪除）。 */
export interface AdminSettings {
  /** `scrypt$N$r$p$salt$hash`（見 auth.ts）。 */
  passwordHash: string;
  updatedAt: string;
}

export type AccountStatus = "active" | "disabled";
/** 角色：admin＝可以進設定頁與管理帳號；user＝只能使用裝箱程式與管理自己的密碼。 */
export type AccountRole = "admin" | "user";

/** 登入帳號。 */
export interface Account {
  /** 隨機 16 位元組的十六進位（32 字元）；登入 cookie 綁的是它，不是 Email（Email 可以改）。 */
  id: string;
  name: string;
  /** 已 trim、轉小寫；唯一。 */
  email: string;
  role: AccountRole;
  /** `scrypt$N$r$p$salt$hash`（見 auth.ts）。 */
  passwordHash: string;
  status: AccountStatus;
  /** 從 1 起算；重設密碼、改密碼、停用／啟用都會加一，該帳號所有已發出的登入 cookie 就一起失效。 */
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface LineSettings {
  /** 關箱通知開關（只管關箱通知；webhook 只要有 secret 就運作）。 */
  enabled: boolean;
  /** 明文存放（檔案權限 0600、只在 Volume 上）；API 與頁面只會顯示「已設定」與尾碼。 */
  channelAccessToken: string;
  channelSecret: string;
  groupId: string;
  /** 唯讀：儲存時用 token 查 LINE 得到的群組名稱，查不到就是空字串。 */
  groupName: string;
  updatedAt: string;
}

export interface CapturedGroup {
  groupId: string;
  groupName: string;
  eventType: string;
  lastSeenAt: string;
}

export interface SettingsData {
  /** 這份資料目前對應的檔案格式版本（載入時的版本；有了帳號、寫檔時一律是 3）。 */
  version: SettingsVersion;
  /** 舊版的單一管理密碼；沒有（或已升級）就是 null。寫檔時 null 不會寫出 `admin` 欄位。 */
  admin: AdminSettings | null;
  accounts: Account[];
  /**
   * 簽 session cookie 用的金鑰（32 位元組的十六進位）。登入 cookie 的失效靠各帳號自己的 sessionVersion，
   * 這把金鑰平常不會換（升級成管理員帳號時也不會動）。
   */
  sessionSecret: string;
  line: LineSettings;
  lineCaptured: CapturedGroup[];
}

/** 對外唯讀的檢視（凍結的物件）：要改一律走 SettingsStore.update。 */
export type ReadonlySettings = Readonly<{
  version: SettingsVersion;
  admin: Readonly<AdminSettings> | null;
  accounts: ReadonlyArray<Readonly<Account>>;
  sessionSecret: string;
  line: Readonly<LineSettings>;
  lineCaptured: ReadonlyArray<Readonly<CapturedGroup>>;
}>;

export function emptyLineSettings(): LineSettings {
  return { enabled: true, channelAccessToken: "", channelSecret: "", groupId: "", groupName: "", updatedAt: "" };
}

export function newSettingsData(): SettingsData {
  return {
    version: SETTINGS_VERSION,
    admin: null,
    accounts: [],
    sessionSecret: randomBytes(32).toString("hex"),
    line: emptyLineSettings(),
    lineCaptured: [],
  };
}

/**
 * 變更後的整理：有了帳號就一定是新格式（版本 3），並且丟掉舊的單一密碼——
 * 升級（建立第一位管理員）的那一次寫入因此「舊 admin 消失」與「accounts 出現」同時發生，不會有只做一半的檔案；
 * 版本 2（admins，沒有角色）的檔案在第一次寫入時也在這裡升成版本 3。沒有帳號時版本不動（見檔頭說明）。
 */
function normalizeAfterMutation(draft: SettingsData): void {
  if (draft.accounts.length > 0) {
    draft.version = SETTINGS_VERSION;
    draft.admin = null;
  }
}

/**
 * 轉成要寫進檔案的 JSON 文字：`admin` 是 null 就不寫出該欄位；其餘（含不認識的欄位）原樣。
 * 有帳號、或本來就是版本 3：寫成版本 3（`accounts`）；沒有帳號的版本 1／2 檔案維持舊格式（空的 `admins`），
 * 升級前回滾到舊版程式才讀得懂。
 */
export function serializeSettings(data: ReadonlySettings): string {
  const { version, admin, accounts, sessionSecret, line, lineCaptured, ...unknown } = data as ReadonlySettings & Record<string, unknown>;
  const fileVersion: SettingsVersion = accounts.length > 0 ? SETTINGS_VERSION : version;
  const out: Record<string, unknown> = { version: fileVersion };
  if (admin !== null && admin !== undefined) out.admin = admin;
  if (fileVersion === SETTINGS_VERSION) out.accounts = accounts;
  else out.admins = [];
  out.sessionSecret = sessionSecret;
  out.line = line;
  out.lineCaptured = lineCaptured;
  for (const [key, value] of Object.entries(unknown)) {
    if (!Object.hasOwn(out, key)) out[key] = value; // 用 hasOwn：`in` 會把 constructor、toString 這類原型上的名字也當成「已經有了」而丟掉
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

// ===================================================================== 檔案內容解析

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取出不在 known 清單裡的欄位（不認識的欄位原樣保留用）。`__proto__` 一律丟掉，免得設到原型上。 */
function unknownFields(raw: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "__proto__" || known.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

const KNOWN_TOP_KEYS = ["version", "admin", "admins", "accounts", "sessionSecret", "line", "lineCaptured"] as const;
const KNOWN_LEGACY_ADMIN_KEYS = ["passwordHash", "updatedAt"] as const;
const KNOWN_ACCOUNT_KEYS = ["id", "name", "email", "role", "passwordHash", "status", "sessionVersion", "createdAt", "updatedAt", "lastLoginAt"] as const;
const KNOWN_LINE_KEYS = ["enabled", "channelAccessToken", "channelSecret", "groupId", "groupName", "updatedAt"] as const;
const KNOWN_CAPTURED_KEYS = ["groupId", "groupName", "eventType", "lastSeenAt"] as const;

/**
 * 解析設定檔內容（版本 1、2、3 都收）。結構性的問題（不是 JSON、不是物件、版本不認得、型別錯誤、sessionSecret 格式不對、
 * 帳號資料不合法或 id／Email 重複、版本 3 的角色不是 admin／user）一律回 null，由呼叫端當作「檔案損毀」處理；
 * 缺少的選填欄位補預設值（版本 1 沒有帳號、缺少 admins／accounts 都視為空陣列）；lineCaptured 裡格式不對的項目直接略過。
 * 版本 1／2 只在記憶體轉換：帳號從 `admins` 讀進來、角色一律是 admin；版本 3 從 `accounts` 讀。
 * **不認識的欄位原樣保留**（頂層、admin、各帳號、line、lineCaptured 每一筆都是）。
 */
export function parseSettingsText(text: string): SettingsData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, "")); // 有些編輯器會在檔案開頭加 BOM，JSON.parse 不收
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const version = raw.version;
  if (version !== LEGACY_SETTINGS_VERSION && version !== ADMINS_SETTINGS_VERSION && version !== SETTINGS_VERSION) return null;

  let admin: AdminSettings | null = null;
  if (raw.admin !== undefined && raw.admin !== null) {
    const a = raw.admin;
    if (!isRecord(a) || typeof a.passwordHash !== "string" || !a.passwordHash.startsWith("scrypt$")) return null;
    admin = { ...unknownFields(a, KNOWN_LEGACY_ADMIN_KEYS), passwordHash: a.passwordHash, updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : "" };
  }

  const rawAccounts = version === SETTINGS_VERSION ? raw.accounts : raw.admins; // 版本 2 以前叫 admins
  const rawList = rawAccounts === undefined ? [] : rawAccounts;
  if (!Array.isArray(rawList)) return null;
  const accounts: Account[] = [];
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  for (const item of rawList) {
    if (!isRecord(item)) return null;
    if (typeof item.id !== "string" || !/^[0-9a-f]{32}$/.test(item.id)) return null;
    if (typeof item.name !== "string" || typeof item.email !== "string") return null;
    const email = item.email.trim().toLowerCase();
    if (email === "") return null;
    if (typeof item.passwordHash !== "string" || !item.passwordHash.startsWith("scrypt$")) return null;
    if (item.status !== "active" && item.status !== "disabled") return null;
    if (version === SETTINGS_VERSION && item.role !== "admin" && item.role !== "user") return null;
    if (typeof item.sessionVersion !== "number" || !Number.isSafeInteger(item.sessionVersion) || item.sessionVersion < 1) return null;
    if (seenIds.has(item.id) || seenEmails.has(email)) return null;
    seenIds.add(item.id);
    seenEmails.add(email);
    accounts.push({
      ...unknownFields(item, KNOWN_ACCOUNT_KEYS),
      id: item.id,
      name: item.name,
      email,
      role: version === SETTINGS_VERSION ? (item.role as AccountRole) : "admin", // 版本 2 以前的管理員帳號一律是 admin
      passwordHash: item.passwordHash,
      status: item.status,
      sessionVersion: item.sessionVersion,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      lastLoginAt: typeof item.lastLoginAt === "string" ? item.lastLoginAt : null,
    });
  }

  if (typeof raw.sessionSecret !== "string" || !/^[0-9a-f]{64}$/.test(raw.sessionSecret)) return null;

  const rawLine = raw.line === undefined ? {} : raw.line;
  if (!isRecord(rawLine)) return null;
  const line: LineSettings = { ...unknownFields(rawLine, KNOWN_LINE_KEYS), ...emptyLineSettings() };
  for (const key of ["channelAccessToken", "channelSecret", "groupId", "groupName", "updatedAt"] as const) {
    const value = rawLine[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    line[key] = value;
  }
  if (rawLine.enabled !== undefined) {
    if (typeof rawLine.enabled !== "boolean") return null;
    line.enabled = rawLine.enabled;
  }

  const rawCaptured = raw.lineCaptured === undefined ? [] : raw.lineCaptured;
  if (!Array.isArray(rawCaptured)) return null;
  const lineCaptured: CapturedGroup[] = [];
  for (const item of rawCaptured) {
    if (!isRecord(item) || typeof item.groupId !== "string" || item.groupId === "" || item.groupId.length > 64) continue;
    lineCaptured.push({
      ...unknownFields(item, KNOWN_CAPTURED_KEYS),
      groupId: item.groupId,
      groupName: typeof item.groupName === "string" ? item.groupName : "",
      eventType: typeof item.eventType === "string" ? item.eventType : "",
      lastSeenAt: typeof item.lastSeenAt === "string" ? item.lastSeenAt : "",
    });
    if (lineCaptured.length >= CAPTURED_GROUPS_MAX) break;
  }

  return {
    version,
    admin,
    accounts,
    sessionSecret: raw.sessionSecret,
    line,
    lineCaptured,
    ...unknownFields(raw, KNOWN_TOP_KEYS),
  };
}

// ===================================================================== Volume 偵測（盡力而為）

/**
 * 從 /proc/self/mountinfo 的內容找出「涵蓋 target 路徑的最深一層掛載點」；沒有資料就回 null。
 * mountinfo 每行第 5 欄（索引 4）是掛載點，空白等字元以 \040 之類的八進位跳脫。
 */
export function findMountPoint(mountinfo: string, target: string): string | null {
  let best: string | null = null;
  for (const line of mountinfo.split("\n")) {
    const raw = line.split(" ")[4];
    if (raw === undefined || raw === "") continue;
    const mountPoint = raw.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    const covers = mountPoint === "/" || target === mountPoint || target.startsWith(`${mountPoint}/`);
    if (covers && (best === null || mountPoint.length > best.length)) best = mountPoint;
  }
  return best;
}

/**
 * 資料目錄是不是在一個獨立掛載的磁碟（Volume）上：true／false；判斷不出來（非 Linux、讀不到 mountinfo）回 null。
 * 容器裡沒掛 Volume 時 /app/data 只是映像最上層的暫存目錄，重新部署就消失——這是設定頁最容易踩的坑，所以特別偵測。
 */
async function detectMounted(dir: string): Promise<boolean | null> {
  if (process.platform !== "linux") return null;
  try {
    const [info, real] = await Promise.all([readFile("/proc/self/mountinfo", "utf8"), realpath(dir)]);
    const mountPoint = findMountPoint(info, real);
    return mountPoint === null ? null : mountPoint !== "/";
  } catch {
    return null;
  }
}

// ===================================================================== store

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface SettingsStoreOptions {
  log: Logger;
  /** 目前時間（毫秒）；損毀備份檔名用。 */
  now?: () => number;
}

export class SettingsStore {
  private current: SettingsData;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    /** 資料目錄（絕對路徑）。 */
    readonly dir: string,
    /** false＝資料目錄不可用：設定頁與設定 API 回 503，update() 一律丟 503。 */
    readonly writable: boolean,
    /** 資料目錄是否在獨立掛載的 Volume 上；null＝判斷不出來。 */
    readonly mounted: boolean | null,
    initial: SettingsData,
    private readonly log: Logger,
  ) {
    this.current = deepFreeze(initial);
  }

  /** 不可用的 store（沒有資料目錄時用；記憶體裡是空設定，也不會被寫入）。 */
  static unavailable(dir = "", log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }): SettingsStore {
    return new SettingsStore(dir, false, null, newSettingsData(), log);
  }

  /**
   * 開啟資料目錄：建立（若不存在）→ 寫入探測 → 讀 settings.json。
   * 檔案不存在（第一次啟動）就建立初始檔（含新產生的 sessionSecret）；檔案損毀就備份成 settings.json.corrupt-<時間>、
   * 以空設定重新開始（不會把損毀內容直接蓋掉）；任何無法繼續的情況都回不可用的 store，並寫一行 error log。
   */
  static async open(dirInput: string, options: SettingsStoreOptions): Promise<SettingsStore> {
    const { log } = options;
    const now = options.now ?? (() => Date.now());
    const dir = resolve(dirInput);
    const unavailable = (reason: string): SettingsStore => {
      log.error(`[settings] 資料目錄 ${dir} 不可用：${reason}。整個網站停用（沒有地方存帳號：登入頁、裝箱主頁、OCR、存檔、關箱通知、設定頁都回 503；/healthz 與 LINE webhook 不受影響）。${DATA_DIR_UNAVAILABLE_MESSAGE}`);
      return SettingsStore.unavailable(dir, log);
    };

    try {
      await mkdir(dir, { recursive: true, mode: 0o700 }); // 只影響這次新建的目錄；已存在的不動
    } catch (err) {
      return unavailable(`無法建立（${describeError(err)}）`);
    }
    // 寫入探測：建一個空檔再刪掉。access(W_OK) 對唯讀掛載之類的情況不夠可靠，直接試寫最準。
    const probe = join(dir, `.write-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      await writeFile(probe, "", { flag: "wx", mode: 0o600 });
      await unlink(probe);
    } catch (err) {
      return unavailable(`無法寫入（${describeError(err)}）`);
    }

    await cleanupStaleTempFiles(dir, now());

    const file = join(dir, SETTINGS_FILE_NAME);
    let text: string | null = null;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return unavailable(`無法讀取 ${SETTINGS_FILE_NAME}（${describeError(err)}）`);
    }

    let initial: SettingsData;
    let needsWrite = false;
    if (text === null) {
      initial = newSettingsData();
      needsWrite = true;
    } else {
      const parsed = parseSettingsText(text);
      if (parsed) {
        initial = parsed;
        await chmod(file, 0o600).catch(() => undefined); // 檔案是別的工具放的（0644）也一律收緊，不等到下一次寫入
      } else {
        // 損毀（或版本不符）：先備份，備份成功才用空設定重新開始；備份失敗就停用，避免把唯一的一份內容蓋掉。
        const backup = await backupCorruptFile(file, now());
        if (backup === null) return unavailable(`${SETTINGS_FILE_NAME} 內容損毀，且無法備份`);
        log.error(`[settings] ${SETTINGS_FILE_NAME} 內容損毀（或版本不符），已備份為 ${backup}，以空設定重新開始（管理密碼需要重設、LINE 設定需要重填）`);
        initial = newSettingsData();
        needsWrite = true;
      }
    }

    const mounted = await detectMounted(dir);
    const store = new SettingsStore(dir, true, mounted, initial, log);
    if (needsWrite) {
      try {
        await store.persist(initial);
      } catch (err) {
        return unavailable(`無法寫入 ${SETTINGS_FILE_NAME}（${describeError(err)}）`);
      }
    }
    if (mounted === false) {
      log.warn(
        `[settings] 資料目錄 ${dir} 可寫入，但看起來不是掛載的 Volume：設定會在重新部署時消失。${DATA_DIR_UNAVAILABLE_MESSAGE}`,
      );
    } else {
      log.info(`[settings] 資料目錄：${dir}（可寫入${mounted === true ? "，已掛載 Volume" : ""}）`);
    }
    return store;
  }

  /** 目前的設定（凍結的唯讀物件）。 */
  get data(): ReadonlySettings {
    return this.current;
  }

  /**
   * 變更設定：複製一份 → 呼叫 mutator 修改 → 寫檔 → 成功才換掉記憶體裡的版本。
   * 所有變更排成一條佇列依序執行（同時進來的變更不會互相覆蓋）。mutator 要是同步的純修改；
   * 它丟例外（例如 ServiceError）就整次作廢、不寫檔。寫檔失敗丟 500，記憶體維持原樣。
   */
  update(mutator: (draft: SettingsData) => void): Promise<void> {
    if (!this.writable) return Promise.reject(new ServiceError(503, DATA_DIR_UNAVAILABLE_MESSAGE));
    const run = async (): Promise<void> => {
      const draft = structuredClone(this.current) as SettingsData;
      mutator(draft);
      normalizeAfterMutation(draft);
      try {
        await this.persist(draft);
      } catch (err) {
        this.log.error(`[settings] 寫入 ${SETTINGS_FILE_NAME} 失敗：${describeError(err)}`);
        throw new ServiceError(500, "寫入設定檔失敗，請確認 Volume 可寫入");
      }
      this.current = deepFreeze(draft);
    };
    const result = this.queue.then(run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 原子寫入：暫存檔（0600）寫完並 fsync → rename 蓋過正式檔 → 盡力 fsync 目錄。 */
  private async persist(data: SettingsData): Promise<void> {
    const file = join(this.dir, SETTINGS_FILE_NAME);
    const tmp = join(this.dir, `.${SETTINGS_FILE_NAME}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.chmod(0o600); // 不受 umask 影響
        await handle.writeFile(serializeSettings(data), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    try {
      const dirHandle = await open(this.dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // 有些檔案系統不支援對目錄 fsync；rename 本身已經完成，忽略
    }
  }
}

/**
 * 清掉資料目錄裡殘留的暫存檔：被強制結束（SIGKILL、斷電）的寫入會留下 `.settings.json.<pid>.<隨機>.tmp`
 * （內容含 token），寫入探測會留下 `.write-probe-*`。只清超過 STALE_TEMP_MS 沒動過的（新的可能是另一個
 * 行程——例如滾動部署時舊容器——正在用的）。盡力而為，任何錯誤都略過。
 */
async function cleanupStaleTempFiles(dir: string, nowMs: number): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (!/^\.settings\.json\..+\.tmp$/.test(name) && !name.startsWith(".write-probe-")) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (info.isFile() && nowMs - info.mtimeMs > STALE_TEMP_MS) await unlink(path);
      } catch {
        // 競爭或權限問題：略過
      }
    }
  } catch {
    // 讀不了目錄就算了
  }
}

/** 把損毀的設定檔複製成 settings.json.corrupt-<UTC 時間>（同名已存在就加序號）；回傳備份檔名，失敗回 null。 */
async function backupCorruptFile(file: string, nowMs: number): Promise<string | null> {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  for (let attempt = 0; attempt < 20; attempt++) {
    const backup = `${file}.corrupt-${stamp}${attempt === 0 ? "" : `-${attempt}`}`;
    try {
      await copyFile(file, backup, constants.COPYFILE_EXCL);
      await chmod(backup, 0o600); // copyFile 會沿用來源檔的權限；備份裡可能有 token，一律收成 0600
      return backup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
  }
  return null;
}
