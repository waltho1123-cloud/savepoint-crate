import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Hono } from "hono";

/**
 * 靜態資源（專案根目錄 `public/assets/` 底下的檔案：WIWI 配色 token、Logo）。
 *
 * 設計：**啟動時把目錄裡的檔案一次讀進記憶體，之後請求只用「檔名」查表**——請求路徑根本碰不到檔案系統，
 * 所以不可能路徑穿越（`..`、百分比編碼的 `..`、反斜線、空字元、大小寫變體、子目錄…通通只是「表裡沒有這個名字」→ 404）。
 * 只收目錄第一層的一般檔案（不進子目錄、不跟符號連結、不收隱藏檔），副檔名要在白名單內。
 * 資源不需要登入（登入頁就要用）；回應帶 `Cache-Control: public, max-age=86400` 與 `nosniff`。
 *
 * 配色檔 `wiwi-colors.css` 與 Logo 是從 skill `wiwi-web-colors` 原樣複製來的（byte-identical，不手改、不手抄色碼），
 * 改過之後的檢查步驟見 README「品牌配色」。
 */

export interface StaticAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
}

/** 檔名（不含目錄）→ 內容與 Content-Type。 */
export type StaticAssets = ReadonlyMap<string, StaticAsset>;

/** 靜態資源的快取：一天（瀏覽器與代理都可以快取；檔案內容變了要等它過期或改檔名）。 */
export const ASSET_CACHE_CONTROL = "public, max-age=86400";

/** 每個檔案最大 2 MB：這些資源整個放進記憶體，不是拿來放大圖或影片的。 */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** 頁面一定要有的資源：缺了整個網站沒有品牌配色與 Logo，啟動時直接失敗（比照 index.html）。 */
export const REQUIRED_ASSETS = ["wiwi-colors.css", "wiwi-logo.svg"] as const;

/** 允許的副檔名與 Content-Type（白名單；不在表裡的檔案不會被載入）。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** 檔名只能是英數字開頭、之後英數字與 `.`、`_`、`-`（沒有隱藏檔、空白、中文、控制字元）。 */
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * 讀入 `dir` 底下（只有第一層）所有符合條件的檔案。目錄不存在、讀不到、檔案超過上限都會丟例外。
 * 不符合條件的項目（子目錄、符號連結、隱藏檔、不認得的副檔名、檔名含特殊字元）直接略過。
 */
export function loadStaticAssets(dir: string): StaticAssets {
  const assets = new Map<string, StaticAsset>();
  for (const name of readdirSync(dir).sort()) {
    if (!ASSET_NAME_RE.test(name)) continue;
    const contentType = CONTENT_TYPES[extname(name).toLowerCase()];
    if (contentType === undefined) continue;
    const path = join(dir, name);
    const info = lstatSync(path); // lstat：符號連結不是一般檔案，不收
    if (!info.isFile()) continue;
    if (info.size > MAX_ASSET_BYTES) throw new Error(`靜態資源 ${name} 太大（${info.size} 位元組，上限 ${MAX_ASSET_BYTES}）`);
    assets.set(name, { body: new Uint8Array(readFileSync(path)), contentType });
  }
  return assets;
}

/** 確認必要的資源都在；缺的丟例外（訊息列出缺哪些）。 */
export function requireAssets(assets: StaticAssets, names: ReadonlyArray<string> = REQUIRED_ASSETS): void {
  const missing = names.filter((name) => !assets.has(name));
  if (missing.length > 0) throw new Error(`缺少必要的靜態資源：${missing.join("、")}`);
}

/**
 * 請求路徑（`/assets/<檔名>`，沒有解碼）→ 資源。只有「`/assets/` 後面剛好是表裡某個檔名」才找得到：
 * 解碼失敗、解碼後含 `/`、`\`、空字元，或根本不在表裡，一律回 undefined。
 */
export function lookupAsset(assets: StaticAssets | undefined, requestPath: string): StaticAsset | undefined {
  const prefix = "/assets/";
  if (assets === undefined || !requestPath.startsWith(prefix)) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(requestPath.slice(prefix.length));
  } catch {
    return undefined; // 壞掉的百分比編碼
  }
  if (name === "" || /[\\/\0]/.test(name)) return undefined;
  return assets.get(name);
}

/** 註冊 `GET /assets/*`（HEAD 由 Hono 一併處理）；其他方法回 405。沒給資源表就一律 404。 */
export function registerAssetRoutes(app: Hono, assets: StaticAssets | undefined): void {
  app.get("/assets/*", (c) => {
    const asset = lookupAsset(assets, c.req.path);
    if (asset === undefined) return c.notFound();
    return c.body(asset.body as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": asset.contentType,
      "Cache-Control": ASSET_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    });
  });
  app.all("/assets/*", (c) => {
    c.header("Allow", "GET, HEAD");
    return c.json({ success: false, error: "此路徑只接受 GET, HEAD" }, 405);
  });
}
