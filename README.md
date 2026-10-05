# savepoint-crate — IPAS 庫存盤點裝箱系統

倉庫人員用手機開網頁，建立箱號 → 對著商品條碼標籤拍照 → 系統用 OpenAI Vision 辨識（條碼、品名、性別、顏色、尺寸）→ 人工確認或修改 → **關箱時**逐筆寫進 Google 試算表「商品主檔」。

## 架構

這是**單一 Node 服務**（Hono ＋ `@hono/node-server`，TypeScript）：同一個服務既提供原本的 `index.html`，也提供兩個後端端點。OpenAI 金鑰與 Google 服務帳號金鑰只存在伺服器環境變數，不會進入前端。

```
手機瀏覽器 ── GET /            ─→ index.html（純靜態頁，邏輯都在頁面內）
          ── POST /api/ocr    ─→ 後端 ─→ OpenAI chat/completions（Vision）
          ── POST /api/save   ─→ 後端 ─→ Google Sheets API（讀表頭＋append）
```

> 2026-10-05 起取代原本打到 n8n（`waltho1123.zeabur.app/webhook/ipas-ocr`、`/webhook/ipas-save-product`）的兩條 webhook，詳見下方「n8n 已退役」。

## 端點

| 方法與路徑 | 說明 |
|---|---|
| `GET /`、`GET /index.html` | 回傳 `index.html`（`Cache-Control: no-cache`）。 |
| `GET /healthz` | 回 `{ ok, openaiConfigured, sheetsConfigured, serviceAccountEmail, clientIp }`。`serviceAccountEmail` 是從 `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS` 解析出的 `client_email`（缺少或解析失敗時為 `null`），部署後用它知道要把試算表分享給誰；**絕不**回傳 `private_key` 或憑證其他欄位。`clientIp` 是**限流用的同一個判斷**所得到的呼叫端 IP（`X-Forwarded-For` 由右往左第一個公開位址；沒有就是 TCP 連線位址；再沒有就是 `"unknown"`），部署後 curl 一次就能確認 Zeabur 反向代理的處理是否正確（見「部署」）。 |
| `POST /api/ocr` | 請求 `{ "image": "data:image/jpeg;base64,...", "boxId": "BOX-001" }`。成功 `{ "success": true, "data": { "barcode", "productName", "gender", "color", "size" } }`。 |
| `POST /api/save` | 請求 `{ seqNo, date, boxId, barcode, productName, gender, color, size, quantity, time }`（與原 n8n webhook 相同）。成功 `{ "success": true, "range": "'商品主檔'!A125:K125" }`；`range` 取自 Sheets API `values.append` 回應的 `updates.updatedRange`，拿不到時省略該欄位。 |

失敗一律回 `{ "success": false, "error": "…" }`（繁中訊息，不含金鑰與上游原始回應），狀態碼如下：

| 狀態碼 | 情況 |
|---|---|
| 400 | JSON 格式錯誤、缺少 `image`、`image` 不是合法 data URL、`/api/save` 欄位型別不對或整筆都是空的 |
| 413 | 請求內容超過 15 MB |
| 429 | 同一個 IP 一分鐘內超過額度：`/api/ocr` 60 次、`/api/save` 600 次，兩者各自計算（其他 `/api/*` 路徑算進 OCR 的額度）；回應帶 `Retry-After` |
| 500 | 試算表／憑證設定問題：表頭缺必要欄位（訊息會列出缺哪欄）、服務帳號沒有權限或憑證無效、找不到試算表或分頁 |
| 502 | OpenAI 或 Google 暫時失敗（OCR 已自動重試一次）、OpenAI 回傳內容無法解析 |
| 503 | 伺服器尚未設定 `OPENAI_API_KEY`（OCR）或 Google 憑證（存檔）；或同時排隊等待寫入的存檔超過 50 筆 |

## 環境變數

範本在 [`.env.example`](.env.example)（值都是佔位符；`.env` 不進版控）。**真實金鑰只放平台的環境變數或本機 `.env`，不要寫進任何會進 git 的檔案。**

| 變數 | 必填 | 預設 | 說明 |
|---|---|---|---|
| `OPENAI_API_KEY` | 是 | — | OpenAI 金鑰。未設定時服務仍會啟動，但 `/api/ocr` 回 503。 |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com` | OpenAI 相容端點（**不含** `/v1`、結尾不加斜線）。 |
| `OPENAI_MODEL` | 否 | `gpt-5.6-luna` | 辨識模型。請求參數（`max_completion_tokens`、`reasoning_effort: none`）沿用 n8n 現行版，換模型前先確認該模型支援這些參數。 |
| `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS` | 是 | — | Google 服務帳號金鑰：**JSON 原文或整包 JSON 的 base64 都可以**（Zeabur 上建議存 base64）。未設定或無法解析時服務仍會啟動，但 `/api/save` 回 503。 |
| `GOOGLE_SHEET_ID` | 否 | `1Wql_6lg_PQ1TT2xOF_5tv2AwA8Wy-PUWfeRPaVV-B_A` | 目標試算表 ID。 |
| `GOOGLE_SHEET_NAME` | 否 | `商品主檔` | 目標分頁名稱。 |
| `PORT` | 否 | `8080` | 監聽埠，綁 `0.0.0.0`。Zeabur 固定注入 `PORT=8080`。 |

產生 base64：`base64 < service-account.json | tr -d '\n'`（本服務也接受換行折行的 base64）。

## 試算表設定

1. **分享**：把試算表分享給服務帳號（`/healthz` 的 `serviceAccountEmail`，即憑證裡的 `client_email`），權限給「編輯者」。沒分享的症狀是 `/api/save` 回 500「試算表拒絕存取」。
2. **表頭**：分頁第 1 列必須包含下列 11 個欄名（**順序不限**，依欄名對應；表頭多出來的欄位會留空）：

   `序號`、`日期`、`箱號`、`商品編號`、`品名`、`性別`、`顏色`、`尺寸`、`合併品名`、`數量`、`辨識時間`

   缺少任何一欄會回 500 並說明缺哪欄，**不會**默默寫到錯的位置。表頭從 A1 開始、不要在最前面留空欄。
3. **快取**：表頭讀取結果快取 5 分鐘（缺欄造成失敗時會立刻清掉快取）。改了表頭後，最多等 5 分鐘生效。
4. **寫入方式**：`values.append`，範圍 `'商品主檔'!A1`，`valueInputOption=USER_ENTERED`、`insertDataOption=INSERT_ROWS`——內容會像使用者手動輸入一樣被試算表解析。若要保留商品編號的前導 0，請把該欄格式設成「純文字」。
5. **寫入速度**：Google Sheets API 的寫入配額是每分鐘 60 次／使用者（服務帳號算一個使用者），所以伺服器把所有 append 排成一條**全域**佇列：一次只送一筆，相鄰兩筆的**起始時間**至少間隔 1 秒（見「安全與限制」的「限流與寫入速度」）。讀表頭不受影響。
6. 專案內的 `商品主檔範本.csv` 是**舊版範本（只有 9 欄，缺 `合併品名`、`數量`）**，不能直接當新表頭用，請以上面的 11 欄為準。

## 本機開發

需要 Node 22 與 pnpm 9.15.9（版本釘在 `package.json` 的 `packageManager`）。

```bash
pnpm install
cp .env.example .env        # 填入真實值（.env 不進版控）
pnpm dev                    # http://localhost:8080，改程式自動重啟
pnpm typecheck              # tsc --noEmit（含 tests）
pnpm test                   # vitest：OpenAI／Google 一律用 mock 的 fetch，不打外部網路、不讀 .env
pnpm build && pnpm start    # 編譯到 dist/ 後以 node dist/server.js 啟動
```

只跑單一測試檔或單一案例：`pnpm exec vitest run tests/ocr.test.ts -t "男女共版"`。

用假金鑰快速確認服務起得來：

```bash
PORT=8099 OPENAI_API_KEY=x GOOGLE_SERVICE_ACCOUNT_CREDENTIALS=x node dist/server.js
curl -s localhost:8099/healthz
curl -s -X POST localhost:8099/api/ocr -H 'content-type: application/json' -d '{}'   # 400 {"success":false,...}
```

## 部署（Docker／Zeabur）

用專案根目錄的 `Dockerfile` 建置（兩階段：build 階段編譯 TypeScript，runtime 階段只裝 production 依賴並複製 `index.html`），容器以非 root 使用者執行 `node dist/server.js`。

- **埠號**：Zeabur 反向代理固定打容器 8080 並注入 `PORT=8080`，程式讀 `process.env.PORT`，不要在 `CMD` 寫死埠號。
- **NODE_ENV**：Zeabur 會把 `NODE_ENV=production` 注入 build 階段，pnpm 會因此跳過 devDependencies 導致建置失敗；Dockerfile 的 build 階段已明確設 `ENV NODE_ENV=development` 並用 `--prod=false`，不要拿掉。
- **pnpm 版本**：`package.json` 的 `packageManager`、Dockerfile 的 `corepack prepare pnpm@…`、產生 `pnpm-lock.yaml` 的 pnpm 三者必須同版（目前 9.15.9），否則 `--frozen-lockfile` 會失敗。
- 在服務的環境變數頁設定上表的變數（至少 `OPENAI_API_KEY`、`GOOGLE_SERVICE_ACCOUNT_CREDENTIALS`）。**改環境變數後容器不會自動重啟**：請重啟服務，並用 `GET /healthz` 確認 `openaiConfigured`、`sheetsConfigured` 都變成 `true`；若仍是 `false`（重啟沒有帶到新增的變數），改為重新部署。
- **重啟與重新部署**：收到 SIGTERM／SIGINT 後，服務停止接受新連線，並最多等 25 秒（`src/server.ts` 的 `SHUTDOWN_GRACE_MS`，比 Kubernetes 預設的 30 秒終止寬限期短）讓處理中與排隊中的存檔寫完；超過的會被中斷。有人正在關大箱子時請避免重啟或部署。
- 本機驗證映像：`docker build -t savepoint-crate:local .`，再 `docker run --rm -p 8080:8080 -e OPENAI_API_KEY=x -e GOOGLE_SERVICE_ACCOUNT_CREDENTIALS=x savepoint-crate:local`。
- 部署後檢查：
  1. runtime log 出現 `savepoint-crate listening on port 8080`。
  2. `curl -s https://<網域>/healthz`：`openaiConfigured`、`sheetsConfigured` 皆為 `true`，並把 `serviceAccountEmail` 加為試算表編輯者。
  3. **確認反向代理的 IP 處理**：同一個 `/healthz` 回應的 `clientIp` 應該是你自己的對外 IP（可與「我的 IP」網站比對）。如果看到 `10.x`、`172.16–31.x`、`192.168.x`、`100.64–127.x` 這類內部位址或 `"unknown"`，或不同人 curl 得到同一個值，代表 `X-Forwarded-For` 沒有被正確取得，**所有使用者會共用同一個限流額度**，需要先處理再上線。
  4. **偽造測試**：`curl -s -H 'X-Forwarded-For: 203.0.113.99' https://<網域>/healthz` 回的 `clientIp` **不得**是 `203.0.113.99`（應該仍是你自己的對外 IP）。若回的是偽造值，代表代理沒有把真實 IP 附加在 `X-Forwarded-For` 最右邊，限流可以被客戶端自填的標頭繞過，需要先處理。
  5. 最後在頁面實際拍一張標籤、關一個箱子，確認有寫進試算表。

## 回滾

依影響範圍由小到大：

1. **平台層**：在 Zeabur 把服務回到前一個成功的部署（舊的純靜態頁，仍打 n8n webhook）。
2. **程式碼層**：`git revert` 改版相關的所有 commit（把 `index.html` 與整個後端一起退回純靜態頁），或直接用改版前的最後一個 commit `db5c061`（純靜態頁）重新部署。
3. **只退回 n8n 後端**：把 `index.html` 裡兩個常數改回
   - `OCREngine.WEBHOOK_URL = 'https://waltho1123.zeabur.app/webhook/ipas-ocr'`
   - `SaveEngine.SAVE_URL = 'https://waltho1123.zeabur.app/webhook/ipas-save-product'`

   並確認 n8n 上的兩個工作流是**啟用**狀態：「IPAS 裝箱系統 - OCR 辨識」（`7edM4NtAnRULFNAt`）、「IPAS 裝箱系統 - 存入商品主檔 v2.1 (合併品名→數量)」（`oflGwGvIcismzcNb`）。這次改版沒有對 n8n 做任何變更（刪除、停用都沒有）；若之後有人停用或刪除了它們，這條退路就不存在了，請先到 n8n 確認。

## n8n 已退役

兩條 n8n webhook 已由本服務取代，**不再被前端使用**。`docs/legacy-n8n/` 只是歷史參考：

- `n8n-workflow-ipas-ocr.json`、`n8n-workflow-save-product.json` 是**較早期的匯出**（OCR 那份還是 `gpt-4o-mini` ＋ `max_tokens`），與 2026-08-05 修正後的現行 n8n 版不同，**不要拿來當正本**。
- 現行行為的正本是 `src/ocr.ts`、`src/sheets.ts`：OCR 的 system prompt、請求參數、解析規則與合併品名規則都是從 n8n 現行版逐字移植，並由 `tests/fixtures/n8n-golden.json`（直接執行 n8n 現行版 Code 節點得到的標準答案）逐案例比對，改動前請先確認真的要改變辨識行為。

與 n8n 版的**刻意差異**：

| 項目 | n8n 版 | 本服務 |
|---|---|---|
| 存檔結果 | 寫入試算表與回傳成功同時進行，寫入失敗前端也看不到 | 寫入成功才回 `success: true`；失敗回 4xx／5xx，前端會顯示同步失敗 |
| 輸入錯誤 | 缺 `image` 等情況 webhook 回 500 | 回 400 與明確訊息 |
| 存檔輸入驗證 | 不檢查 | 欄位只接受字串／數字、單欄 ≤ 1000 字、`barcode` 與 `productName` 至少一個非空 |
| 公式字元 | 以 `=`、`+`、`-`、`@` 開頭的文字會被試算表當公式執行 | 這類文字前面加單引號（顯示內容不變）；純數字（含負數）不受影響 |
| 回應 `range` | 無 | `/api/save` 成功時多帶 `range` |
| 寫入速度 | 每筆各自寫入，沒有節流 | 所有 append 全域排隊，相鄰兩筆起始時間 ≥ 1 秒（Google 寫入配額每分鐘 60 次／使用者）。一個 N 筆的箱子，關箱同步至少要 N 秒 |
| `color`、`size` 是 JSON 數字時的合併品名 | JavaScript 會把兩個數字相加（例如 `-1` 與 `5` 得到 `(4)`） | 一律當文字串接（得到 `(-15)`）。前端永遠送字串，不會觸發 |

## 安全與限制

- **沒有登入機制**，與原 n8n webhook 相同：任何知道網址的人都能呼叫 `/api/*`。已做的防護：每 IP 每分鐘限流（OCR 60 次、存檔 600 次，各自計算；記憶體內，服務重啟即重置；IP 取 `X-Forwarded-For` 由右往左第一個公開位址）、15 MB body 上限、存檔欄位驗證與公式字元處理、錯誤訊息不帶金鑰。若需要更嚴格的存取控制，請另外規劃（例如在前面加存取閘道）。
- **限流與寫入速度**：
  - **限流（每 IP 每分鐘）**：`/api/ocr` 60 次（`OCR_RATE_LIMIT_MAX`）、`/api/save` 600 次（`SAVE_RATE_LIMIT_MAX`），兩個額度**各自獨立計算**——關箱時前端是逐筆、循序送出，不會被拍照的次數擠壓。其他 `/api/*` 路徑（含不存在的）算進 OCR 的額度。常數在 `src/app.ts`。同一個出口 IP（例如倉庫同一個網路）的人共用一份額度。
  - **寫入速度（真正的瓶頸）**：Google Sheets API 的寫入配額預設是每分鐘 60 次／使用者（服務帳號算一個使用者；每專案 300 次，超過回 429；來源：developers.google.com/workspace/sheets/api/limits，2026-10-05 查閱）。所以伺服器把所有 `values.append` 排成一條**全域**佇列（整個程序共用、不分來源請求，先進先出）：一次只送一筆，相鄰兩筆的**起始時間**至少間隔 1 秒（`src/sheets.ts` 的 `APPEND_MIN_INTERVAL_MS`，建構 `SheetsClient` 時可用 `appendMinIntervalMs` 覆寫）；前一筆不論成功或失敗都不會卡住後面的；讀表頭不受影響。
  - **實務影響**：第 1 筆不等待，所以一個箱子有 N 筆商品，關箱同步約需 (N−1) 秒再加上每筆的往返時間（例如 8 筆約 7 秒、50 筆約 49 秒）；多人同時關箱會互相排隊，整體速度仍是每秒 1 筆。Google 若回應很慢（單次 timeout 20 秒），後面排隊的請求也會跟著等。
  - **⚠️ 前端沒有「同步中」的鎖定**：頁面的「正在同步到商品主檔…」提示約 2.5 秒就消失，確認對話框關閉後「完成此箱」鈕仍可按，直到全部寫完才會鎖箱。`index.html` 依規定只改了兩個端點常數，沒有動這部分。所以請提醒現場：**按下確認後，等到出現「已同步 N 筆到商品主檔 ✓」再離開頁面或再按一次**——中途離開頁面，剩下的筆就不會送出；重複按會把同一箱再送一次（重複列）。要根治，需要讓前端在同步期間鎖住按鈕、顯示進度（或改成批次送出），這會動到 `index.html`，需要另外決定。
  - **配額邊緣**：不間斷地連續寫入時，1 秒間隔剛好是每分鐘 60 次，正好壓在 Google 配額邊緣。如果實際看到 `/api/save` 回 502、且 log 出現 `[sheets] POST 失敗：HTTP 429`，請把 `APPEND_MIN_INTERVAL_MS` 調大一點（例如 1200）。
  - **排隊上限**：同時排隊（含正在送出）的 append 超過 `APPEND_MAX_PENDING`（50）筆時，新的請求直接回 503「目前等待寫入的筆數過多」。每筆約 1 秒時，50 筆最多等約 50 秒，仍低於一般反向代理 60 秒左右的逾時（Google 變慢時每筆最長 20 秒，等待會更久，因為上限是用「筆數」而不是「時間」算的）；等得比代理逾時還久，前端會先看到失敗、伺服器之後卻還是寫入，使用者重送就變成重複列。正常使用時前端是逐筆等回應才送下一筆，佇列長度頂多等於同時關箱的人數。
  - **已知限制**：(1) 上限是**全域**的，沒有每個 IP 各自的佇列額度——單一來源一次送出 50 個以上的請求（每分鐘 600 次的額度允許），就能讓全站的存檔暫時回 503 約 50 秒；(2) client 中途斷線時，已排進佇列的請求仍會寫入（與 n8n 版相同）；(3) 佇列在記憶體裡，服務重啟或重新部署時，還沒寫進試算表的排隊中存檔會遺失（見「部署」的優雅關閉說明）。
- **不開 CORS**：頁面與 API 同源。
- **`/api/save` 的 `values.append` 不自動重試**：逾時或 5xx 時無法確定有沒有寫進去，重試可能造成重複列；失敗時前端會提示，請到試算表確認後再補送。唯一的例外是 401（授權過期、請求尚未執行）：換新 token 後重送一次，重送前一樣會等滿配速間隔。
- log 不記請求內容（圖片、商品資料）與任何金鑰；上游失敗只記狀態碼與錯誤類型／代碼（Google 讀表頭失敗時另記其簡短錯誤訊息，方便判斷是分頁名稱還是權限問題；append 失敗不記訊息，因為可能回顯欄位值）。

## 專案結構

```
index.html              原本的前端頁面（只有 OCR／存檔兩個端點常數改成 /api/ocr、/api/save）
src/server.ts           啟動入口（讀環境變數與 index.html，監聽 0.0.0.0:PORT）
src/app.ts              Hono app：路由、限流（OCR／存檔各自額度）、body 上限、錯誤處理
src/ocr.ts              OCR：prompt、請求組裝、OpenAI 呼叫（timeout、重試）、回應解析
src/sheets.ts           存檔：欄位整理、合併品名、表頭對應、Sheets REST（讀表頭＋append）、append 全域配速
src/google-auth.ts      服務帳號 JWT（RS256）換 token、憑證解析（JSON／base64）
src/rate-limit.ts       固定視窗限流與客戶端 IP 判斷
src/env.ts              環境變數載入
src/common.ts           共用型別與工具（ServiceError、Logger、FetchLike）
tests/                  vitest；tests/fixtures/n8n-golden.json 是 n8n 現行版的標準答案（產生腳本：tests/fixtures/generate-n8n-golden.mjs）
docs/legacy-n8n/        已退役的 n8n 工作流匯出（歷史參考）
Dockerfile              兩階段建置，EXPOSE／預設 PORT=8080
```
