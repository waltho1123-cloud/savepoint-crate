import { copyFileSync, cpSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth.js";
import { loginOverHttp, repoRoot, runServerUntilExit, seedSettingsFile, startServer } from "./process-helpers.js";
import { cleanupTempDirs, makeTempDir } from "./settings-helpers.js";

afterEach(cleanupTempDirs);

// 真的啟動 src/server.ts（用 tsx 執行），驗證啟動入口：PORT、綁定位址、index.html 路徑、log 內容。
// 只連本機 127.0.0.1，不打外部網路；子行程只給最少的環境變數（沒有任何真實金鑰）。
describe("src/server.ts（實際啟動行程）", () => {
  it("讀 PORT、綁 0.0.0.0、提供原本的 index.html，/healthz 與啟動 log 不含金鑰", async () => {
    const dataDir = await makeTempDir();
    // 全站登入：先放一位管理員（真實行程啟動時就讀得到），再用它登入才拿得到主頁
    seedSettingsFile(dataDir, [{ name: "測試管理員", email: "admin@example.test", role: "admin", passwordHash: await hashPassword("process-test-password-1") }]);
    const server = await startServer({
      OPENAI_API_KEY: "test-openai-key-123",
      GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "x", // 無法解析的假憑證
      DATA_DIR: dataDir,
    });
    try {
      // 實際綁定的位址（來自 server.address()）必須是所有介面，Docker／Zeabur 才連得進來
      expect(server.output()).toContain(`savepoint-crate listening on port ${server.port} (0.0.0.0)`);

      // 沒登入：主頁導向登入頁
      const anonymous = await fetch(`${server.base}/`, { redirect: "manual" });
      expect(anonymous.status).toBe(302);
      expect(anonymous.headers.get("location")).toBe("/login?next=/");
      // 登入之後：原本的 index.html
      const cookie = await loginOverHttp(server.base, "admin@example.test", "process-test-password-1");
      const index = await fetch(`${server.base}/`, { headers: { cookie } });
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
        adminConfigured: true,
        adminCount: 1,
        accountCount: 1,
        legacyAdminPending: false,
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

  it("靜態資源：真實行程提供 /assets/*（不需登入），登入頁引用同源的配色與 Logo，CSP 允許同源樣式與圖片", async () => {
    const dataDir = await makeTempDir();
    seedSettingsFile(dataDir, [{ name: "測試管理員", email: "admin@example.test", role: "admin", passwordHash: await hashPassword("process-test-password-1") }]);
    const server = await startServer({ OPENAI_API_KEY: "test-openai-key-123", GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "x", DATA_DIR: dataDir });
    try {
      const css = await fetch(`${server.base}/assets/wiwi-colors.css`); // 沒帶 cookie
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(css.headers.get("cache-control")).toBe("public, max-age=86400");
      expect(await css.text()).toBe(readFileSync(resolve(repoRoot, "public/assets/wiwi-colors.css"), "utf8"));
      const logo = await fetch(`${server.base}/assets/wiwi-logo.svg`);
      expect(logo.status).toBe(200);
      expect(logo.headers.get("content-type")).toBe("image/svg+xml");
      expect(Buffer.from(await logo.arrayBuffer()).equals(readFileSync(resolve(repoRoot, "public/assets/wiwi-logo.svg")))).toBe(true);
      // 路徑穿越：用原始請求（fetch 會先正規化網址，所以走 http.request 送原樣的路徑）
      const rawStatus = (path: string) =>
        new Promise<number>((resolveStatus, reject) => {
          const req = request({ host: "127.0.0.1", port: server.port, path, method: "GET" }, (res) => {
            res.resume();
            resolveStatus(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        });
      for (const path of ["/assets/../package.json", "/assets/%2e%2e/package.json", "/assets/..%2fpackage.json", "/assets/%2e%2e%2fpackage.json", "/assets/..%5cpackage.json", "/assets/nope.css", "/assets/"]) {
        expect(await rawStatus(path), path).toBe(404);
      }

      const login = await fetch(`${server.base}/login`);
      const html = await login.text();
      expect(html).toContain('<html lang="zh-Hant" data-thermal="warm">');
      expect(html).toContain('<link rel="stylesheet" href="/assets/wiwi-colors.css">');
      expect(html).toContain('<img class="brand-logo" src="/assets/wiwi-logo.svg" alt="WIWI" width="53" height="48">');
      const csp = login.headers.get("content-security-policy")!;
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toContain("default-src 'none'");

      const cookie = await loginOverHttp(server.base, "admin@example.test", "process-test-password-1");
      const index = await (await fetch(`${server.base}/`, { headers: { cookie } })).text();
      expect(index).toContain('<link rel="stylesheet" href="/assets/wiwi-colors.css">');
      expect(index).toContain('<html lang="zh-Hant" data-thermal="warm">');
    } finally {
      await server.stop();
    }
  }, 40_000);

  describe("缺少靜態資源時啟動就失敗（比照 index.html；部署時新版起不來，舊版繼續跑）", () => {
    /** 一份只有 src、package.json、index.html 的專案複本（node_modules 用符號連結）；assets 決定 public/assets 長什麼樣。 */
    async function makeProjectRoot(assets: "none" | "only-logo" | "full"): Promise<string> {
      const root = await makeTempDir();
      cpSync(join(repoRoot, "src"), join(root, "src"), { recursive: true });
      copyFileSync(join(repoRoot, "package.json"), join(root, "package.json"));
      copyFileSync(join(repoRoot, "index.html"), join(root, "index.html"));
      symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
      if (assets !== "none") {
        mkdirSync(join(root, "public", "assets"), { recursive: true });
        copyFileSync(join(repoRoot, "public/assets/wiwi-logo.svg"), join(root, "public/assets/wiwi-logo.svg"));
        if (assets === "full") copyFileSync(join(repoRoot, "public/assets/wiwi-colors.css"), join(root, "public/assets/wiwi-colors.css"));
      }
      return root;
    }

    it("沒有 public/ 目錄：結束碼 1，訊息指出預期位置，沒有開始監聽", async () => {
      const root = await makeProjectRoot("none");
      const result = await runServerUntilExit({ OPENAI_API_KEY: "x", DATA_DIR: await makeTempDir() }, { root });
      expect(result.code).toBe(1);
      expect(result.output).toContain("無法載入靜態資源");
      expect(result.output).toContain(join(root, "public", "assets"));
      expect(result.output).not.toContain("listening on port");
    }, 40_000);

    it("public/assets 缺少配色檔：結束碼 1，訊息列出缺哪個檔案", async () => {
      const root = await makeProjectRoot("only-logo");
      const result = await runServerUntilExit({ OPENAI_API_KEY: "x", DATA_DIR: await makeTempDir() }, { root });
      expect(result.code).toBe(1);
      expect(result.output).toContain("缺少必要的靜態資源：wiwi-colors.css");
      expect(result.output).not.toContain("listening on port");
    }, 40_000);

    it("對照組：資源齊全的複本照常啟動（所以上面兩個失敗真的是因為缺資源）", async () => {
      const root = await makeProjectRoot("full");
      const dataDir = await makeTempDir();
      const server = await startServer({ OPENAI_API_KEY: "x", DATA_DIR: dataDir }, { root });
      try {
        expect((await fetch(`${server.base}/assets/wiwi-colors.css`)).status).toBe(200);
      } finally {
        await server.stop();
      }
    }, 40_000);
  });
});
