import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * 設定頁的驗證：管理員密碼（scrypt 雜湊）、登入 session（HMAC 簽章的 cookie 值，綁定帳號與帳號的 sessionVersion）、
 * 首次設定碼。全部只用 node:crypto，不加任何依賴。比對一律用 timingSafeEqual。
 */

// ===================================================================== 密碼雜湊（scrypt）

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;
/**
 * 驗證時接受的參數上限：雜湊字串帶著自己的 N／r／p，設定檔若被改壞，不能讓每次登入吃掉大量記憶體或時間。
 * （N=16384、r=8 約用 16 MiB；上限 N=65536、r=16 約 128 MiB。）
 */
const SCRYPT_MAX_N = 1 << 16;
const SCRYPT_MAX_R = 16;
const SCRYPT_MAX_P = 4;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

function scryptAsync(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function scryptOptions(n: number, r: number, p: number): ScryptOptions {
  return { N: n, r, p, maxmem: 256 * n * r }; // 預設 maxmem 只有 32 MiB；給兩倍所需記憶體的餘裕
}

/** 同一個密碼在不同裝置／輸入法下可能是不同的 Unicode 組合形式；雜湊與驗證前都先轉成 NFC。 */
function normalizePassword(password: string): string {
  return password.normalize("NFC");
}

/** 產生 `scrypt$N$r$p$salt$hash`（salt 與 hash 為 base64url）。用非同步版本，不卡住事件迴圈。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scryptAsync(normalizePassword(password), salt, SCRYPT_KEY_BYTES, scryptOptions(SCRYPT_N, SCRYPT_R, SCRYPT_P));
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

/** 驗證密碼。雜湊字串格式不對、參數超出範圍、或運算失敗一律回 false（不丟例外）。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!isPowerOfTwo(n) || n < 1024 || n > SCRYPT_MAX_N) return false;
  if (!Number.isInteger(r) || r < 1 || r > SCRYPT_MAX_R) return false;
  if (!Number.isInteger(p) || p < 1 || p > SCRYPT_MAX_P) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) return false;
  try {
    const actual = await scryptAsync(normalizePassword(password), salt, expected.length, scryptOptions(n, r, p));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * 固定的假雜湊（參數與正式雜湊相同：scrypt N=16384、r=8、p=1）：登入時查無帳號、或帳號已停用，也用它跑一次 verifyPassword，
 * 讓「帳號存在與否／有沒有被停用」不會從回應時間洩漏。對應的密碼是產生時隨機丟掉的 32 位元組，沒有任何人知道，
 * 所以對它的驗證永遠是 false。這個值不是祕密（只是個形狀正確的雜湊），可以放在原始碼裡。
 */
export const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$igxZU7LeML7BpuqmXa1ffQ$XDKBGZkx7N1yX3-7E36f4-yK4xaKXNCid0HVPepGeco";

/** 新密碼的規則：8～200 字元。回傳錯誤訊息；合格回 null。 */
export function validateNewPassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `密碼至少要 ${PASSWORD_MIN_LENGTH} 個字元`;
  if (password.length > PASSWORD_MAX_LENGTH) return `密碼最多 ${PASSWORD_MAX_LENGTH} 個字元`;
  return null;
}

// ===================================================================== 登入 session（HMAC 簽章 cookie）

export const SESSION_COOKIE_NAME = "sp_session";
/** session 有效期：7 天（寫在簽章內容裡，伺服器不存任何 session 狀態）。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signSession(secretHex: string, payload: string): string {
  return createHmac("sha256", Buffer.from(secretHex, "hex")).update(payload).digest("base64url");
}

/** cookie 裡簽進去的內容：這個 session 屬於哪個帳號、當時帳號的 sessionVersion。 */
export interface SessionClaims {
  accountId: string;
  sessionVersion: number;
}

/**
 * 產生 cookie 值 `<到期時間(ms)>.<帳號 id>.<sessionVersion>.<亂數>.<HMAC>`。HMAC 以 sessionSecret 為金鑰、對前四段簽章
 * （SHA-256，base64url）。簽章只證明「這個 cookie 是我們發的、沒被改過、還沒到期」；帳號是否仍存在、是否啟用、
 * sessionVersion 是否還是當時那個，要由呼叫端再對照目前的帳號資料（重設密碼、停用帳號都會把帳號的 sessionVersion 加一，
 * 該帳號所有已發出的 cookie 就一起失效，不影響其他帳號）。
 */
export function createSessionToken(
  secretHex: string,
  accountId: string,
  sessionVersion: number,
  nowMs: number,
  ttlMs: number = SESSION_TTL_MS,
): string {
  const payload = `${nowMs + ttlMs}.${accountId}.${sessionVersion}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${signSession(secretHex, payload)}`;
}

const SESSION_TOKEN_RE = /^(\d{1,16})\.([0-9a-f]{32})\.(\d{1,16})\.([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{43})$/;

/**
 * 驗證 cookie 值：格式正確、簽章吻合（常數時間比對）、尚未到期，通過就回傳簽在裡面的帳號 id 與 sessionVersion；
 * 其餘一律回 null。舊格式的 cookie（升級成管理員帳號之前的 `<到期>.<亂數>.<簽章>` 三段式）格式不符，一律視為未登入。
 */
export function verifySessionToken(token: string | undefined, secretHex: string, nowMs: number): SessionClaims | null {
  if (!token) return null;
  const match = SESSION_TOKEN_RE.exec(token);
  if (!match) return null;
  const [, expires = "", accountId = "", version = "", nonce = "", mac = ""] = match;
  const expected = Buffer.from(signSession(secretHex, `${expires}.${accountId}.${version}.${nonce}`));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const expiresAt = Number(expires);
  const sessionVersion = Number(version);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowMs) return null;
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 1) return null;
  return { accountId, sessionVersion };
}

// ===================================================================== 首次設定碼

/** 去掉容易看錯的 I、L、O、0、1，剩 31 個字元（8 碼約 39.6 位元）。 */
export const SETUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SETUP_CODE_LENGTH = 8;

/** 產生 `XXXX-XXXX` 格式的設定碼（用 crypto.randomInt，無偏）。 */
export function generateSetupCode(): string {
  let chars = "";
  for (let i = 0; i < SETUP_CODE_LENGTH; i++) chars += SETUP_CODE_ALPHABET.charAt(randomInt(SETUP_CODE_ALPHABET.length));
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** 輸入的設定碼只留英數字、轉大寫：`abcd-efgh`、`ABCD EFGH`、`ABCDEFGH` 都視為同一組。 */
function normalizeSetupCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface SetupCodeGuardOptions {
  /** 指定設定碼（測試用）；不給就隨機產生。 */
  code?: string;
  /** 累計幾次錯誤後作廢目前的設定碼、換一組新的（防分散式暴力猜測）。預設 20。 */
  maxFailures?: number;
  /** 換新設定碼時呼叫（正式環境用來把新的碼寫進 log）。 */
  onRegenerate?: (code: string) => void;
}

/**
 * 管理首次設定碼：只存在記憶體，每次服務啟動都是新的一組；建立密碼成功後作廢（consume）。
 * 錯誤次數累計到 maxFailures 就整組作廢、換新的，所以即使有人用很多 IP 繞過逐 IP 的限流，也猜不完整個空間。
 */
export class SetupCodeGuard {
  private code: string | null;
  private failures = 0;
  private readonly maxFailures: number;
  private readonly onRegenerate: ((code: string) => void) | undefined;

  constructor(options: SetupCodeGuardOptions = {}) {
    this.code = options.code ?? generateSetupCode();
    this.maxFailures = options.maxFailures ?? 20;
    this.onRegenerate = options.onRegenerate;
  }

  /** 目前有效的設定碼（已 consume 則為 null）。啟動時用來寫進 log。 */
  get currentCode(): string | null {
    return this.code;
  }

  /** 驗證輸入。錯誤會累計；達到上限就換新的一組。 */
  verify(input: string): boolean {
    if (this.code === null) return false;
    const expected = Buffer.from(normalizeSetupCode(this.code));
    const actual = Buffer.from(normalizeSetupCode(input));
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!ok) {
      this.failures += 1;
      if (this.failures >= this.maxFailures) {
        this.code = generateSetupCode();
        this.failures = 0;
        this.onRegenerate?.(this.code);
      }
    }
    return ok;
  }

  /** 建立密碼成功後作廢：同一組碼不能再用。 */
  consume(): void {
    this.code = null;
  }
}
