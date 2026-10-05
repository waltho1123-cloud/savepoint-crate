import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { repoRoot, startServer } from "./process-helpers.js";
import { cleanupTempDirs, makeTempDir } from "./settings-helpers.js";

afterEach(cleanupTempDirs);

// 真的啟動 src/server.ts（用 tsx 執行），驗證啟動入口：PORT、綁定位址、index.html 路徑、log 內容。
// 只連本機 127.0.0.1，不打外部網路；子行程只給最少的環境變數（沒有任何真實金鑰）。
describe("src/server.ts（實際啟動行程）", () => {
  it("讀 PORT、綁 0.0.0.0、提供原本的 index.html，/healthz 與啟動 log 不含金鑰", async () => {
    const dataDir = await makeTempDir();
    const server = await startServer({
      OPENAI_API_KEY: "test-openai-key-123",
      GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "x", // 無法解析的假憑證
      DATA_DIR: dataDir,
    });
    try {
      // 實際綁定的位址（來自 server.address()）必須是所有介面，Docker／Zeabur 才連得進來
      expect(server.output()).toContain(`savepoint-crate listening on port ${server.port} (0.0.0.0)`);

      const index = await fetch(`${server.base}/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toBe(readFileSync(resolve(repoRoot, "index.html"), "utf8"));

      // 沒帶 X-Forwarded-For：clientIp 是真實的 TCP 連線位址（@hono/node-server 的 c.env.incoming.socket）
      const { dataDirMounted, ...health } = (await (await fetch(`${server.base}/healthz`)).json()) as Record<string, unknown>;
      expect(health).toEqual({
        ok: true,
        openaiConfigured: true,
        sheetsConfigured: false,
        serviceAccountEmail: null,
        clientIp: "127.0.0.1",
        requestIsHttps: false,
        dataDirWritable: true,
        adminConfigured: false,
        lineConfigured: false,
        lineWebhookConfigured: false,
        lineSource: null,
      });
      expect([true, false, null]).toContain(dataDirMounted); // 取決於測試機器（macOS 判斷不出來是 null）

      // 帶 X-Forwarded-For：取最右邊的公開位址（左邊客戶端自填的不採信）
      const forwarded = await fetch(`${server.base}/healthz`, {
        headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9, 10.42.0.7" },
      });
      expect(((await forwarded.json()) as { clientIp: string }).clientIp).toBe("203.0.113.9");

      // X-Forwarded-For 只有私有位址：退回連線位址
      const privateOnly = await fetch(`${server.base}/healthz`, { headers: { "x-forwarded-for": "10.0.0.5" } });
      expect(((await privateOnly.json()) as { clientIp: string }).clientIp).toBe("127.0.0.1");

      // 啟動警告只列出變數名稱，不含任何值
      expect(server.output()).toContain("GOOGLE_SERVICE_ACCOUNT_CREDENTIALS 無法解析");
      expect(server.output()).not.toContain("test-openai-key-123");
    } finally {
      await server.stop();
    }
  }, 40_000);
});
