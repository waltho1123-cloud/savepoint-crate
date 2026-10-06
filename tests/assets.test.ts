import { mkdir, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { ASSET_CACHE_CONTROL, loadStaticAssets, lookupAsset, MAX_ASSET_BYTES, REQUIRED_ASSETS, requireAssets, type StaticAssets } from "../src/assets.js";
import { loadEnv } from "../src/env.js";
import { SettingsStore } from "../src/settings-store.js";
import { repoRoot } from "./process-helpers.js";
import { cleanupTempDirs, createAuthFixture, makeTempDir, type AuthFixture } from "./settings-helpers.js";

afterEach(cleanupTempDirs);

const ASSETS_DIR = resolve(repoRoot, "public", "assets");
const file = (name: string): Buffer => readFileSync(join(ASSETS_DIR, name));

describe("loadStaticAssets：啟動時把 public/assets 讀進記憶體", () => {
  it("專案的 public/assets：有配色 token 與兩種 Logo，Content-Type 正確，內容與檔案逐位元組相同", () => {
    const assets = loadStaticAssets(ASSETS_DIR);
    expect([...assets.keys()].sort()).toEqual(["wiwi-colors.css", "wiwi-logo-white.svg", "wiwi-logo.svg"]);
    expect(assets.get("wiwi-colors.css")!.contentType).toBe("text/css; charset=utf-8");
    expect(assets.get("wiwi-logo.svg")!.contentType).toBe("image/svg+xml");
    expect(assets.get("wiwi-logo-white.svg")!.contentType).toBe("image/svg+xml");
    for (const [name, asset] of assets) expect(Buffer.from(asset.body).equals(file(name)), name).toBe(true);
    expect(() => requireAssets(assets)).not.toThrow();
    expect([...REQUIRED_ASSETS]).toEqual(["wiwi-colors.css", "wiwi-logo.svg"]);
  });

  it("只收第一層的一般檔案：子目錄、符號連結、隱藏檔、不認得的副檔名、檔名有特殊字元的都略過；副檔名不分大小寫", async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(join(outside, "secret.css"), "body{}");
    await writeFile(join(dir, "ok.css"), "a{}");
    await writeFile(join(dir, "UPPER.SVG"), "<svg/>");
    await writeFile(join(dir, "pic.PNG"), "png");
    await writeFile(join(dir, ".hidden.css"), "x{}");
    await writeFile(join(dir, "notes.txt"), "txt");
    await writeFile(join(dir, "script.js"), "alert(1)");
    await writeFile(join(dir, "with space.css"), "x{}");
    await writeFile(join(dir, "中文.css"), "x{}");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "nested.css"), "x{}");
    await mkdir(join(dir, "dir.css")); // 名字像檔案的目錄
    await symlink(join(outside, "secret.css"), join(dir, "link.css")); // 指到目錄外面的符號連結
    const assets = loadStaticAssets(dir);
    expect([...assets.keys()].sort()).toEqual(["UPPER.SVG", "ok.css", "pic.PNG"]);
    expect(assets.get("UPPER.SVG")!.contentType).toBe("image/svg+xml");
    expect(assets.get("pic.PNG")!.contentType).toBe("image/png");
  });

  it("目錄不存在 → 丟例外；檔案超過上限 → 丟例外（不會悄悄載入大檔）", async () => {
    expect(() => loadStaticAssets(join(tmpdir(), "savepoint-crate-no-such-dir-xyz"))).toThrow();
    const dir = await makeTempDir();
    await writeFile(join(dir, "big.css"), Buffer.alloc(MAX_ASSET_BYTES + 1, 97));
    expect(() => loadStaticAssets(dir)).toThrow(/太大/);
    await writeFile(join(dir, "big.css"), Buffer.alloc(MAX_ASSET_BYTES, 97)); // 剛好等於上限可以
    expect(loadStaticAssets(dir).get("big.css")!.body.byteLength).toBe(MAX_ASSET_BYTES);
  });

  it("requireAssets：缺少必要資源時丟例外，訊息列出缺哪些", async () => {
    const dir = await makeTempDir();
    const empty = await makeTempDir();
    await writeFile(join(dir, "wiwi-logo.svg"), "<svg/>");
    expect(() => requireAssets(loadStaticAssets(dir))).toThrow("缺少必要的靜態資源：wiwi-colors.css");
    expect(() => requireAssets(loadStaticAssets(empty))).toThrow("wiwi-colors.css、wiwi-logo.svg");
    expect(() => requireAssets(loadStaticAssets(dir), ["wiwi-logo.svg"])).not.toThrow();
  });
});

describe("lookupAsset：請求路徑只可能對到資源表裡的檔名", () => {
  const assets: StaticAssets = new Map([["a.css", { body: new Uint8Array([1]), contentType: "text/css; charset=utf-8" }]]);
  it("剛好是 /assets/<表裡的檔名> 才找得到", () => {
    expect(lookupAsset(assets, "/assets/a.css")).toBeDefined();
    expect(lookupAsset(assets, "/assets/%61.css")).toBeDefined(); // 百分比編碼的普通字元解碼後就是檔名
    for (const path of ["/assets/", "/assets", "/assets/b.css", "/assets/a.css/", "/assets/A.CSS", "/assets/sub/a.css", "/assets/../a.css", "/assets/..%2fa.css", "/assets/%2e%2e%2fa.css", "/assets/a.css%00", "/assets/a.css%5c", "/assets/%5ca.css", "/assets/%E0%A4%A", "/assets/%", "/other/a.css", "assets/a.css", "/assets/__proto__", "/assets/constructor", "/assets/toString"]) {
      expect(lookupAsset(assets, path), path).toBeUndefined();
    }
    expect(lookupAsset(undefined, "/assets/a.css")).toBeUndefined();
  });
});

describe("GET /assets/*（createApp 的靜態資源路由）", () => {
  let auth: AuthFixture;
  beforeAll(async () => {
    auth = await createAuthFixture();
  });
  afterAll(cleanupTempDirs);

  /** 有帳號的設定檔（全站要登入）＋真實的 public/assets。 */
  const makeApp = (withAssets = true) =>
    createApp({ env: loadEnv({}), indexHtml: "<!DOCTYPE html><html><body>主頁</body></html>", settings: auth.store, ...(withAssets ? { assets: loadStaticAssets(ASSETS_DIR) } : {}) });

  it("GET /assets/wiwi-colors.css：200、text/css、Cache-Control: public, max-age=86400、nosniff，內容就是檔案；不需要登入", async () => {
    const res = await makeApp().request("/assets/wiwi-colors.css"); // 沒帶 cookie：登入頁就要用它
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(res.headers.get("cache-control")).toBe(ASSET_CACHE_CONTROL);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(Buffer.from(await res.arrayBuffer()).equals(file("wiwi-colors.css"))).toBe(true);
  });

  it("兩種 Logo：200、image/svg+xml、內容逐位元組相同", async () => {
    const app = makeApp();
    for (const name of ["wiwi-logo.svg", "wiwi-logo-white.svg"]) {
      const res = await app.request(`/assets/${name}`);
      expect(res.status, name).toBe(200);
      expect(res.headers.get("content-type"), name).toBe("image/svg+xml");
      expect(res.headers.get("cache-control"), name).toBe("public, max-age=86400");
      expect(Buffer.from(await res.arrayBuffer()).equals(file(name)), name).toBe(true);
    }
  });

  it("HEAD 也行（標頭相同、沒有內容）；查詢字串不影響", async () => {
    const app = makeApp();
    const head = await app.request("/assets/wiwi-colors.css", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(head.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(await head.text()).toBe("");
    expect((await app.request("/assets/wiwi-colors.css?v=20261006")).status).toBe(200);
  });

  it("不存在的檔案與各種路徑穿越寫法一律 404（純文字 Not Found），不洩漏專案檔案", async () => {
    const app = makeApp();
    const paths = [
      "/assets/nope.css",
      "/assets/",
      "/assets",
      "/assets/wiwi-colors.css/",
      "/assets/WIWI-COLORS.CSS",
      "/assets/../package.json", // URL 正規化後是 /package.json
      "/assets/../../etc/passwd",
      "/assets/%2e%2e/package.json", // 百分比編碼的 .. 也會被 URL 正規化
      "/assets/%2E%2E/package.json",
      "/assets/..%2fpackage.json", // 編碼的斜線：解碼後含 /
      "/assets/%2e%2e%2fpackage.json",
      "/assets/..%5cpackage.json", // 反斜線
      "/assets/%252e%252e/package.json", // 雙重編碼
      "/assets/wiwi-colors.css%00.png", // 空字元
      "/assets/wiwi-colors.css%2f..%2f..%2fpackage.json",
      "/assets/sub/wiwi-colors.css",
      "/assets/.env",
      "/assets/.DS_Store",
      "/assets/%E0%A4%A", // 壞掉的百分比編碼
      "/assets/__proto__",
      "/assets/constructor",
      "/assets/wiwi-colors.json", // skill 裡有、但沒有複製進專案的檔案
      "/assets/wiwi-logo.png",
    ];
    for (const path of paths) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      const body = await res.text();
      expect(body, path).toBe("Not Found");
      expect(body, path).not.toContain("savepoint-crate");
    }
    // URL 正規化後 /assets/../index.html 就是 /index.html：那是主頁的路由（沒登入導向登入頁），不是資源路由吐出任何檔案
    const home = await app.request("/assets/../index.html");
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/login?next=/");
  });

  it("其他方法回 405（Allow: GET, HEAD）；沒給資源表的 app 一律 404", async () => {
    const app = makeApp();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await app.request("/assets/wiwi-colors.css", { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET, HEAD");
    }
    const bare = makeApp(false);
    expect((await bare.request("/assets/wiwi-colors.css")).status).toBe(404);
    expect((await bare.request("/assets/wiwi-logo.svg")).status).toBe(404);
  });

  it("資源路由不影響其他路徑：主頁沒登入照樣導向登入頁、API 沒登入照樣 401", async () => {
    const app = makeApp();
    const home = await app.request("/");
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/login?next=/");
    const ocr = await app.request("/api/ocr", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" }, body: "{}" });
    expect(ocr.status).toBe(401);
  });

  it("資料目錄不可用（整站 503）時資源仍然可以取得：登入頁的 503 說明也要有樣式與 Logo", async () => {
    const app = createApp({ env: loadEnv({}), indexHtml: "x", settings: SettingsStore.unavailable(), assets: loadStaticAssets(ASSETS_DIR) });
    expect((await app.request("/assets/wiwi-colors.css")).status).toBe(200);
    expect((await app.request("/assets/wiwi-logo.svg")).status).toBe(200);
  });
});
