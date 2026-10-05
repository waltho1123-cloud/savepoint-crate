import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { parseServiceAccountCredentials } from "./google-auth.js";

/**
 * 收到 SIGTERM／SIGINT 後，最多等多久讓處理中（含排隊中的存檔）的請求完成才強制結束。
 * append 視窗已滿時，排隊的存檔最長要等約 60 秒（等最舊的起始離開視窗，見 sheets.ts 的 APPEND_WINDOW_MS），
 * 但 Kubernetes 預設的終止寬限期是 30 秒，所以取 25 秒；超過的請求會被中斷（排隊中、還沒寫進試算表的存檔就是這樣掉的）。
 */
const SHUTDOWN_GRACE_MS = 25_000;

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

  // LINE 關箱通知是選填功能：三個變數都沒設定就完全靜默；只設定一半時提醒（名稱而已，不印值）。
  const hasLineToken = env.LINE_CHANNEL_ACCESS_TOKEN !== "";
  const hasLineGroup = env.LINE_GROUP_ID !== "";
  if (hasLineToken !== hasLineGroup) {
    console.warn("[config] 關箱 LINE 通知需要同時設定 LINE_CHANNEL_ACCESS_TOKEN 與 LINE_GROUP_ID（目前只設定了其中一個）：關箱時不會推播");
  } else if (hasLineGroup && !env.LINE_GROUP_ID.startsWith("C")) {
    console.warn("[config] LINE_GROUP_ID 看起來不是群組 ID（群組 ID 以 C 開頭）：推播可能會失敗");
  }
  if (env.LINE_CHANNEL_SECRET !== "" && !hasLineToken) {
    console.warn("[config] 已設定 LINE_CHANNEL_SECRET 但沒有 LINE_CHANNEL_ACCESS_TOKEN：webhook 只能把群組 ID 寫進 log，無法回覆");
  }

  const app = createApp({ env, indexHtml });
  const server = serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
    console.log(`savepoint-crate listening on port ${info.port} (${info.address})`);
  });

  // 優雅關閉：停止接受新連線（Node 22 會一併關掉閒置連線），等處理中的請求完成就結束；最多等 SHUTDOWN_GRACE_MS。
  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
