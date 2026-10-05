# CLAUDE.md

IPAS 庫存盤點裝箱系統（`savepoint-crate`）：手機網頁拍照 OCR 商品條碼標籤 → 關箱時寫入 Google 試算表「商品主檔」。
**單一 Node 服務**（Hono ＋ TypeScript，Node 22、pnpm 9.15.9）：同一個服務提供 `index.html`、`GET /healthz`、`POST /api/ocr`、`POST /api/save`。
2026-10-05 起取代原本的兩條 n8n webhook（`ipas-ocr`、`ipas-save-product`）；n8n 工作流 JSON 已退役，放在 `docs/legacy-n8n/`（舊版匯出，不是正本）。

## 指令

- `pnpm install`、`pnpm dev`（tsx watch，載入 `.env`）、`pnpm typecheck`（tsc --noEmit，含 tests）、`pnpm build`（→ `dist/`）、`pnpm test`（vitest）、`pnpm start`。
- 單一測試：`pnpm exec vitest run tests/<檔>.test.ts -t "<名稱>"`（不要用 npx；不要經 `pnpm test -- …` 轉遞旗標）。
- 驗映像：`docker build -t savepoint-crate:local .`。

## 結構

`src/app.ts`（路由、限流、body 上限）、`src/ocr.ts`、`src/sheets.ts`、`src/google-auth.ts`、`src/rate-limit.ts`、`src/env.ts`、`src/common.ts`、`src/server.ts`（啟動）。
所有對外呼叫（OpenAI、Google）都走注入的 fetch；不使用 googleapis、openai SDK。細節見 `README.md`。

## 不可破壞的約定

- **OCR 行為與 n8n 現行版（2026-08-05 修正版）逐字等價**：`src/ocr.ts` 的 system prompt、請求參數（`max_completion_tokens: 300`、`reasoning_effort: 'none'`、`temperature: 0.1`、`detail: 'auto'`）、解析規則（剝 ```json 圍欄、抓第一個 `{…}`、`男女共版`→`中性`）、timeout 30 秒、失敗重試一次（間隔 1 秒）都不要「優化」。`tests/fixtures/n8n-golden.json` 是 n8n 現行版 Code 節點的實際輸出（產生腳本 `tests/fixtures/generate-n8n-golden.mjs`，需要 n8n 工作流匯出檔路徑當參數；匯出檔不放 repo），`tests/ocr.test.ts` 逐案例比對；改行為前先確認使用者真的要改。`parseImageInput` 在跑 data URL 正規式前先擋行終止符，這是為了避免二次方回溯（ReDoS：128 KB 請求可卡住服務約 1 秒），結果與 n8n 相同，不要拿掉。
- **存檔欄位**固定 11 欄 `序號,日期,箱號,商品編號,品名,性別,顏色,尺寸,合併品名,數量,辨識時間`，依試算表第 1 列表頭名稱對應；表頭缺欄回 500 並指出缺哪欄，絕不猜位置。合併品名規則照抄 n8n「整理欄位」（含有性別但顏色尺寸皆空會得到 `品名(男-)` 的邊角行為）。
- 回應格式：OCR 成功 `{success:true,data:{barcode,productName,gender,color,size}}`、存檔成功 `{success:true,range?}`，失敗 `{success:false,error}` ＋ 4xx/5xx；錯誤訊息（`ServiceError`）不得含金鑰、憑證或上游原始回應。
- `/healthz` 的 `serviceAccountEmail` 只能是 `client_email`，絕不輸出 `private_key` 或憑證其他欄位。
- `index.html` 只允許改 `OCREngine.WEBHOOK_URL`（`/api/ocr`）與 `SaveEngine.SAVE_URL`（`/api/save`）兩個常數；其餘不動。
- 金鑰只放環境變數（`.env` 已 gitignore）。`.env.example` 與測試只用佔位符／現場產生的測試金鑰；提交前 grep 一次金鑰特徵（OpenAI 金鑰樣式：`sk-` 後接 10 個以上英數字；PEM 私鑰標頭：`BEGIN` 空格 `PRIVATE KEY`）。
- `values.append` 不自動重試（避免重複列），唯一例外是 401 換 token 後重送一次。
- 測試的 OpenAI／Google 一律 mock fetch、不讀 `.env`、不打外部網路（`tests/server.test.ts` 會在本機啟動服務並只連 127.0.0.1）。

## 部署

Docker（Zeabur）：反代固定打容器 8080 並注入 `PORT=8080`，程式讀 `process.env.PORT`、綁 `0.0.0.0`。Dockerfile 的 build 階段必須 `ENV NODE_ENV=development` ＋ `pnpm install --prod=false`（Zeabur 會注入 `NODE_ENV=production`）。`packageManager`、Dockerfile 的 pnpm 版本與 lockfile 產生版本三者同為 9.15.9。改環境變數後要手動重啟服務。
