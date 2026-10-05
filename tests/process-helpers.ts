import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

/** 專案根目錄。 */
export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
/** 只允許連 api.line.me 的 fetch 替身（見檔案內說明）。 */
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
