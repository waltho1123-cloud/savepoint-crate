import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { parseServiceAccountCredentials } from "./google-auth.js";

/**
 * 啟動入口：讀環境變數與 index.html → 建立 app → 監聽 0.0.0.0:${PORT}。
 * Zeabur 的反向代理固定打容器的 8080 並注入 PORT=8080，所以一律讀 process.env.PORT，不寫死埠號。
 * log 只印變數「名稱」，不印任何變數的值。
 */
function main(): void {
  const env = loadEnv();

  // index.html 與 dist/ 同層的上一層（本機：專案根目錄；容器：/app）。
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const indexPath = resolve(projectRoot, "index.html");
  let indexHtml: string;
  try {
    indexHtml = readFileSync(indexPath, "utf8");
  } catch {
    console.error(`找不到 index.html（預期位置：${indexPath}）`);
    process.exitCode = 1;
    return;
  }

  if (env.OPENAI_API_KEY === "") {
    console.warn("[config] OPENAI_API_KEY 未設定：POST /api/ocr 會回 503");
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS === "") {
    console.warn("[config] GOOGLE_SERVICE_ACCOUNT_CREDENTIALS 未設定：POST /api/save 會回 503");
  } else if (parseServiceAccountCredentials(env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS) === null) {
    console.warn(
      "[config] GOOGLE_SERVICE_ACCOUNT_CREDENTIALS 無法解析（需為服務帳號 JSON 或其 base64，且含 client_email 與 private_key）：POST /api/save 會回 503",
    );
  }

  const app = createApp({ env, indexHtml });
  const server = serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
    console.log(`savepoint-crate listening on port ${info.port} (${info.address})`);
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
