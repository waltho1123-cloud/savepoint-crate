import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 專案根目錄。 */
export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
/** 只允許連 api.line.me 與 api.openai.com（OCR）的 fetch 替身（見檔案內說明）。 */
export const lineStubPreload = fileURLToPath(new URL("./fixtures/line-stub-preload.mjs", import.meta.url));

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

export async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("等待逾時");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface RunningServer {
  port: number;
  base: string;
  /** 到目前為止的 stdout＋stderr。 */
  output(): string;
  /** 送 SIGTERM 並等行程結束（8 秒後改送 SIGKILL）。 */
  stop(): Promise<void>;
}

/**
 * 真的啟動 src/server.ts（用 tsx 執行）。子行程只拿到最少的環境變數（PATH、PORT 與呼叫端給的），沒有任何真實金鑰；
 * 只連本機 127.0.0.1。preload 是額外的 --import 模組（例如只允許打 LINE 的 fetch 替身）。
 */
export async function startServer(env: Record<string, string>, options: { preload?: string } = {}): Promise<RunningServer> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", ...(options.preload ? ["--import", options.preload] : []), "src/server.ts"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => void (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => void (output += chunk.toString()));
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  try {
    await waitFor(() => output.includes("listening on port"), 25_000);
  } catch (err) {
    child.kill("SIGKILL");
    throw new Error(`伺服器沒有在時限內啟動。輸出：\n${output}\n${String(err)}`);
  }
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: async () => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 8000);
      await exited;
      clearTimeout(killTimer);
    },
  };
}

/** 讀 LINE_STUB_LOG（每行一筆 JSON）。 */
export function readStubLog(path: string): Array<{ url: string; method: string; authorization?: string; body: any }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** 真實行程測試用的帳號（密碼雜湊由呼叫端先算好；scrypt 約 50～100 ms，一個測試檔算一次就好）。 */
export interface SeedAccount {
  id?: string;
  name: string;
  email: string;
  role: "admin" | "user";
  passwordHash: string;
  status?: "active" | "disabled";
}

/** 在資料目錄裡先寫好一份版本 3 的 settings.json（含帳號），讓真實行程啟動時就有人可以登入。回傳寫進去的 sessionSecret。 */
export function seedSettingsFile(dir: string, accounts: SeedAccount[], extra: Record<string, unknown> = {}): string {
  const sessionSecret = randomBytes(32).toString("hex");
  const file = {
    version: 3,
    accounts: accounts.map((a, i) => ({
      id: a.id ?? String(i + 1).padStart(32, "0"),
      name: a.name,
      email: a.email,
      role: a.role,
      passwordHash: a.passwordHash,
      status: a.status ?? "active",
      sessionVersion: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      lastLoginAt: null,
    })),
    sessionSecret,
    line: { enabled: true, channelAccessToken: "", channelSecret: "", groupId: "", groupName: "", updatedAt: "" },
    lineCaptured: [],
    ...extra,
  };
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return sessionSecret;
}

/** 對真實行程送 POST /login（帶 CSRF 標頭），回傳 `sp_session=…`（失敗就丟錯）。 */
export async function loginOverHttp(base: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`登入失敗：HTTP ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie()[0];
  if (!cookie) throw new Error("登入回應沒有 Set-Cookie");
  return cookie.split(";")[0]!;
}
