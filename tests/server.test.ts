import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("等待逾時");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// 真的啟動 src/server.ts（用 tsx 執行），驗證啟動入口：PORT、綁定位址、index.html 路徑、log 內容。
// 只連本機 127.0.0.1，不打外部網路；子行程只給最少的環境變數（沒有任何真實金鑰）。
describe("src/server.ts（實際啟動行程）", () => {
  it("讀 PORT、綁 0.0.0.0、提供原本的 index.html，/healthz 與啟動 log 不含金鑰", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        PORT: String(port),
        OPENAI_API_KEY: "test-openai-key-123",
        GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "x", // 無法解析的假憑證
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => void (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => void (output += chunk.toString()));
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

    try {
      await waitFor(() => output.includes("listening on port"), 25_000);
      // 實際綁定的位址（來自 server.address()）必須是所有介面，Docker／Zeabur 才連得進來
      expect(output).toContain(`savepoint-crate listening on port ${port} (0.0.0.0)`);

      const index = await fetch(`http://127.0.0.1:${port}/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toBe(readFileSync(resolve(repoRoot, "index.html"), "utf8"));

      // 沒帶 X-Forwarded-For：clientIp 是真實的 TCP 連線位址（@hono/node-server 的 c.env.incoming.socket）
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await health.json()).toEqual({
        ok: true,
        openaiConfigured: true,
        sheetsConfigured: false,
        serviceAccountEmail: null,
        clientIp: "127.0.0.1",
      });

      // 帶 X-Forwarded-For：取最右邊的公開位址（左邊客戶端自填的不採信）
      const forwarded = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9, 10.42.0.7" },
      });
      expect(((await forwarded.json()) as { clientIp: string }).clientIp).toBe("203.0.113.9");

      // X-Forwarded-For 只有私有位址：退回連線位址
      const privateOnly = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { "x-forwarded-for": "10.0.0.5" } });
      expect(((await privateOnly.json()) as { clientIp: string }).clientIp).toBe("127.0.0.1");

      // 啟動警告只列出變數名稱，不含任何值
      expect(output).toContain("GOOGLE_SERVICE_ACCOUNT_CREDENTIALS 無法解析");
      expect(output).not.toContain("test-openai-key-123");
    } finally {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 8000);
      await exited;
      clearTimeout(killTimer);
    }
  }, 40_000);
});
