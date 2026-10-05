# savepoint-crate — IPAS 庫存盤點裝箱系統

倉庫人員用手機開網頁，建立箱號 → 對著商品條碼標籤拍照 → 系統用 OpenAI Vision 辨識（條碼、品名、性別、顏色、尺寸）→ 人工確認或修改 → **關箱時**逐筆寫進 Google 試算表「商品主檔」，並（選配）推播一則關箱通知到 LINE 群組。

## 架構

這是**單一 Node 服務**（Hono ＋ `@hono/node-server`，TypeScript）：同一個服務既提供原本的 `index.html`，也提供後端端點（辨識、存檔、關箱 LINE 通知）。OpenAI 金鑰、Google 服務帳號金鑰與 LINE token 只存在伺服器環境變數，不會進入前端。

```
手機瀏覽器 ── GET /            ─→ index.html（純靜態頁，邏輯都在頁面內）
          ── POST /api/ocr    ─→ 後端 ─→ OpenAI chat/completions（Vision）
          ── POST /api/save   ─→ 後端 ─→ Google Sheets API（讀表頭＋append）
          ── POST /api/box-closed ─→ 後端 ─→ LINE Messaging API（push 到群組；選配）
LINE 平台 ── POST /api/line/webhook ─→ 後端（取得群組 ID 用；選配）
```

> 2026-10-05 起取代原本打到 n8n（`waltho1123.zeabur.app/webhook/ipas-ocr`、`/webhook/ipas-save-product`）的兩條 webhook，詳見下方「n8n 已退役」。

## 端點

| 方法與路徑 | 說明 |
|---|---|
| `GET /`、`GET /index.html` | 回傳 `index.html`（`Cache-Control: no-cache`）。 |
| `GET /healthz` | 回 `{ ok, openaiConfigured, sheetsConfigured, serviceAccountEmail, clientIp, lineConfigured, lineWebhookConfigured }`。`lineConfigured` 是 LINE token 與群組 ID 都有設定（關箱通知會推播），`lineWebhookConfigured` 是有設定 channel secret（webhook 啟用），皆不含任何設定值。`serviceAccountEmail` 是從 `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS` 解析出的 `client_email`（缺少或解析失敗時為 `null`），部署後用它知道要把試算表分享給誰；**絕不**回傳 `private_key` 或憑證其他欄位。`clientIp` 是**限流用的同一個判斷**所得到的呼叫端 IP（`X-Forwarded-For` 由右往左第一個公開位址；沒有就是 TCP 連線位址；再沒有就是 `"unknown"`），部署後 curl 一次就能確認 Zeabur 反向代理的處理是否正確（見「部署」）。 |
| `POST /api/ocr` | 請求 `{ "image": "data:image/jpeg;base64,...", "boxId": "BOX-001" }`。成功 `{ "success": true, "data": { "barcode", "productName", "gender", "color", "size" } }`。 |
| `POST /api/save` | 請求 `{ seqNo, date, boxId, barcode, productName, gender, color, size, quantity, time }`（與原 n8n webhook 相同）。成功 `{ "success": true, "range": "'商品主檔'!A125:K125" }`；`range` 取自 Sheets API `values.append` 回應的 `updates.updatedRange`，拿不到時省略該欄位。 |
| `POST /api/box-closed` | 關箱後的 LINE 群組通知（見「LINE 群組通知」）。請求 `{ boxId, closedAt?, items: [{ barcode, productName, gender, color, size, qty }], total, successCount, failedCount }`。**輸入格式正確、且沒被限流（429）或擋下（413）時一律回 200**：`{ "success": true, "notified": true }`，或 `{ "success": true, "notified": false, "reason": "not_configured" }`（LINE 沒設定好，靜默略過）、`{ "success": true, "notified": false, "reason": "push_failed", "error": "…" }`（推播失敗，`error` 是簡短原因）——LINE 的狀況不會讓關箱看起來失敗。 |
| `POST /api/line/webhook` | LINE 平台的 webhook（只有設定了 `LINE_CHANNEL_SECRET` 才啟用，否則 503）。驗證 `X-Line-Signature`（對原始 body 做 HMAC-SHA256，不符回 401），驗證通過一律回 200。群組裡的 `join` 事件或文字訊息「群組ID」／「群組 ID」，會用 `replyToken` 回覆該群組的 ID（用來取得 `LINE_GROUP_ID`）；其他事件忽略。 |

失敗一律回 `{ "success": false, "error": "…" }`（繁中訊息，不含金鑰與上游原始回應），狀態碼如下：

| 狀態碼 | 情況 |
|---|---|
| 400 | JSON 格式錯誤、缺少 `image`、`image` 不是合法 data URL、`/api/save` 欄位型別不對或整筆都是空的、`/api/box-closed` 輸入不合規則（`boxId` 空白或超過 100 字、`items` 不是陣列或超過 500 筆、文字欄位超過 200 字、`qty` 不是 1～9999 的整數、數量欄位不是非負整數） |
| 401 | `/api/line/webhook` 的 `X-Line-Signature` 缺少或不符 |
| 413 | 請求內容超過 15 MB |
| 429 | 同一個 IP 一分鐘內超過額度：`/api/ocr` 60 次、`/api/save` 600 次、`/api/box-closed` 60 次、`/api/line/webhook` 120 次，四者各自計算（其他 `/api/*` 路徑算進 OCR 的額度）；回應帶 `Retry-After` |
| 500 | 試算表／憑證設定問題：表頭缺必要欄位（訊息會列出缺哪欄）、服務帳號沒有權限或憑證無效、找不到試算表或分頁 |
| 502 | OpenAI 或 Google 暫時失敗（OCR 已自動重試一次）、OpenAI 回傳內容無法解析 |
| 503 | 伺服器尚未設定 `OPENAI_API_KEY`（OCR）或 Google 憑證（存檔）；或同時排隊等待寫入的存檔超過 50 筆；或 `/api/line/webhook` 沒有 `LINE_CHANNEL_SECRET`（webhook 未啟用） |

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
| `LINE_CHANNEL_ACCESS_TOKEN` | 否 | 空（未設定） | LINE Messaging API 的 channel access token（長期）：關箱通知推播、webhook 回覆用。 |
| `LINE_GROUP_ID` | 否 | 空（未設定） | 關箱通知的目標群組 ID（`C` 開頭）。**token 與群組 ID 兩者都有才會推播**，只有一個等於沒設定。 |
| `LINE_CHANNEL_SECRET` | 否 | 空（未設定） | channel secret，**只用來驗證 webhook 簽章**（取得群組 ID 時才需要）；沒設定時 `POST /api/line/webhook` 回 503。 |
| `PORT` | 否 | `8080` | 監聽埠，綁 `0.0.0.0`。Zeabur 固定注入 `PORT=8080`。 |

產生 base64：`base64 < service-account.json | tr -d '\n'`（本服務也接受換行折行的 base64）。

三個 `LINE_*` 都是選填：**都不設定就完全靜默**，不影響關箱與存檔（細節見下一節）。`.env.example` 裡它們刻意留空——空字串代表「未設定」，填假值反而會讓服務以為設定好了。

## 試算表設定

1. **分享**：把試算表分享給服務帳號（`/healthz` 的 `serviceAccountEmail`，即憑證裡的 `client_email`），權限給「編輯者」。沒分享的症狀是 `/api/save` 回 500「試算表拒絕存取」。
2. **表頭**：分頁第 1 列必須包含下列 11 個欄名（**順序不限**，依欄名對應；表頭多出來的欄位會留空）：

   `序號`、`日期`、`箱號`、`商品編號`、`品名`、`性別`、`顏色`、`尺寸`、`合併品名`、`數量`、`辨識時間`

   缺少任何一欄會回 500 並說明缺哪欄，**不會**默默寫到錯的位置。表頭從 A1 開始、不要在最前面留空欄。
3. **快取**：表頭讀取結果快取 5 分鐘（缺欄造成失敗時會立刻清掉快取）。改了表頭後，最多等 5 分鐘生效。
4. **寫入方式**：`values.append`，範圍 `'商品主檔'!A1`，`valueInputOption=USER_ENTERED`、`insertDataOption=INSERT_ROWS`——內容會像使用者手動輸入一樣被試算表解析。若要保留商品編號的前導 0，請把該欄格式設成「純文字」。
5. **寫入速度**：Google Sheets API 的寫入配額是每分鐘 60 次／使用者（服務帳號算一個使用者）。伺服器對 append 做**全域的滾動視窗配額**：過去 60 秒內已起始的 append 少於 55 次（留 5 次餘裕）就立刻送出、不等待；達到 55 次才先進先出排隊。所以 **55 件內全速寫入、超過才放慢**（以過去 60 秒內累計的件數計算，所有箱子、所有人共用同一份配額；見「安全與限制」的「限流與寫入速度」）。讀表頭不受影響。
6. 專案內的 `商品主檔範本.csv` 是**舊版範本（只有 9 欄，缺 `合併品名`、`數量`）**，不能直接當新表頭用，請以上面的 11 欄為準。

## LINE 群組通知

使用者關箱、逐筆同步到商品主檔之後，後端會把「箱號、幾種商品幾件、同步結果、明細」推播到指定的 LINE 群組（LINE Messaging API push）。**LINE 沒設定時整個功能靜默略過，絕不影響關箱與存檔**；通知失敗也只會在頁面上提示一下，箱子照樣關。

訊息長這樣（純文字、台北時間）：

```
📦 箱號 BOX-001 已完成
共 12 種商品、35 件
已同步 12/12 筆到商品主檔 ✓
明細：
1801080204 第五代溫灸刷毛圓領發熱衣(女-經典黑L) ×3
…
時間：2026-10-05 15:20
```

- 部分失敗時，第 3 行改成 `⚠️ 同步 10/12 筆，2 筆失敗，請查核商品主檔`。
- 「N 種」是商品筆數、「M 件」是數量加總；明細的品名格式與寫進商品主檔的「合併品名」相同（`品名(性別-顏色尺寸)`）。
- 明細最多 30 行，超過寫 `…另有 k 種`；整則訊息不超過 4500 字（LINE 的上限是 5000），太長時會先砍明細行數。
- 「時間」用前端送來的關箱時間（`closedAt`，瀏覽器時間）；沒有就用伺服器時間，一律轉成台北時間。

### 設定

在服務的環境變數頁設定（說明見上面「環境變數」表）：

| 變數 | 用途 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 推播（與 webhook 回覆）用的 channel access token |
| `LINE_GROUP_ID` | 目標群組 ID（`C` 開頭） |
| `LINE_CHANNEL_SECRET` | 只給 webhook 驗簽用，取得群組 ID 時才需要（選填） |

**設定後要重新部署（或至少重啟服務）才會生效**——改環境變數後容器不會自動重啟。之後用 `curl -s https://<網域>/healthz` 確認 `lineConfigured`（token 與群組 ID 都有）與 `lineWebhookConfigured`（有 secret）。

**到哪裡取得 token 與 secret**：到 [LINE Developers](https://developers.line.biz/)，進入你的 Provider 與 Messaging API channel（沒有的話先建立一個，或沿用其他系統已在使用的官方帳號）：

- **Channel access token**：channel 的「Messaging API」分頁，Channel access token（long-lived）按「Issue」發行。
- **Channel secret**：channel 的「Basic settings」分頁。
- 要讓 bot 能被加進群組：在「Messaging API」分頁開啟「Allow bot to join group chats」（會連到 LINE Official Account Manager 的回應設定；實際選項名稱以 LINE 介面為準）。

### 取得群組 ID（兩種方式）

**方式一：用本服務的 webhook 取得**

1. 設定 `LINE_CHANNEL_SECRET`（以及 `LINE_CHANNEL_ACCESS_TOKEN`，bot 才能回覆）並重新部署，確認 `/healthz` 的 `lineWebhookConfigured` 是 `true`。
2. 在 LINE Developers 的「Messaging API」分頁，把 **Webhook URL** 設成 `https://savepoint-crate.zeabur.app/api/line/webhook`（本服務目前的 Zeabur 網域；網域不同時換成你的 `https://<網域>/api/line/webhook`），按「Verify」（應該回成功），並開啟「Use webhook」。
3. 把官方帳號（bot）**加進目標群組**：bot 會回覆「已加入，此群組 ID：C…。請把它設定到 LINE_GROUP_ID。」；或者在已有 bot 的群組裡輸入「**群組ID**」（或「群組 ID」），bot 會回覆「此群組 ID：C…」。
4. 如果 bot 沒有回覆（例如還沒設定 token），到服務的 runtime log 找 `[line] 事件 … 來自 group C…` 這一行，群組 ID 就在裡面。
5. 把群組 ID 填進 `LINE_GROUP_ID`，重新部署。取得之後可以把 webhook 關掉（Use webhook 關閉），並清掉 `LINE_CHANNEL_SECRET`。

**方式二：沿用已知的群組 ID**：如果這個服務使用的官方帳號（channel）已經在目標群組裡，而你從其他系統已經知道該群組的 ID（`C` 開頭），直接填進 `LINE_GROUP_ID` 就好，不必走 webhook。注意 bot 必須在該群組裡，否則推播會被 LINE 拒絕（400／403）。

### 行為與限制

- **前端流程**：關箱確認後，頁面先逐筆同步到商品主檔，然後呼叫 `POST /api/box-closed`（**不等回應**，所以 LINE 再慢也不會拖住關箱），最後才鎖箱。同步結果不論全成功或部分失敗、甚至同步過程丟了例外，都會通知（例外時成功筆數算 0）；**空箱子（沒有任何商品）不通知**。超過後端驗證上限的值（數量 9999、文字欄位 200 字、500 筆）會先在前端截斷，免得整則通知被 400 擋掉。
- **失敗的提示**：回應 `notified: false` 且 `reason: "push_failed"` 時，頁面跳「LINE 通知失敗（不影響關箱）」；`not_configured`（LINE 沒設定）不提示；網路錯誤只在瀏覽器 console 留下紀錄。
- **推播 10 秒逾時、不重試**（避免重複通知），所以 LINE 暫時失敗就會漏掉這一則——這是「通知」，不保證送達。失敗原因會寫進服務的 log（只有狀態碼與 LINE 回應的簡短說明，**不含 token**）；回給前端的 `error` 是固定的簡短句子，不轉發 LINE 的原始回應。
- **額度**：每則推播都計入 LINE 官方帳號的每月訊息額度（依你的方案而定）。
- **沒有登入機制**：和其他端點一樣，任何知道網址的人都能呼叫 `/api/box-closed`，也就是能讓 bot 在群組裡發出訊息（內容由呼叫端決定）。已做的防護只有每 IP 每分鐘 60 次的限流與欄位長度上限。若被濫用：清空 `LINE_GROUP_ID`（或 token）並重新部署即可停用，必要時到 LINE Developers 重新發行 token 讓舊的失效。
- **重複通知**：前端沒有「同步中」的鎖定，同一個箱子若連按兩次「確認」，會重複寫入試算表，也會重複通知（見下面「安全與限制」）。
- **webhook 安全**：`/api/line/webhook` 用 channel secret 驗證每個請求真的來自 LINE（對**原始 body 位元組**做 HMAC-SHA256、base64 後以 `timingSafeEqual` 比對 `X-Line-Signature`），不符回 401；它只處理群組來源的 `join` 與「群組ID」文字，不儲存任何訊息內容。

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
  5. **LINE 通知（選配）**：照上面「LINE 群組通知」設定後，`/healthz` 的 `lineConfigured` 應為 `true`；關一個測試箱子，群組應收到一則通知。沒設定 LINE 時什麼都不會發生（也不會有錯誤）。
  6. 最後在頁面實際拍一張標籤、關一個箱子，確認有寫進試算表。

## 回滾

依影響範圍由小到大：

1. **平台層**：在 Zeabur 把服務回到前一個成功的部署（舊的純靜態頁，仍打 n8n webhook）。
2. **程式碼層**：`git revert` 改版相關的所有 commit（把 `index.html` 與整個後端一起退回純靜態頁），或直接用改版前的最後一個 commit `db5c061`（純靜態頁）重新部署。
3. **只退回 n8n 後端**：把 `index.html` 裡兩個常數改回
   - `OCREngine.WEBHOOK_URL = 'https://waltho1123.zeabur.app/webhook/ipas-ocr'`
   - `SaveEngine.SAVE_URL = 'https://waltho1123.zeabur.app/webhook/ipas-save-product'`

   （頁面裡的 `NotifyEngine` 會打 `/api/box-closed`，沒有這個後端時只會在 console 留下錯誤，不影響關箱。）並確認 n8n 上的兩個工作流是**啟用**狀態：「IPAS 裝箱系統 - OCR 辨識」（`7edM4NtAnRULFNAt`）、「IPAS 裝箱系統 - 存入商品主檔 v2.1 (合併品名→數量)」（`oflGwGvIcismzcNb`）。這次改版沒有對 n8n 做任何變更（刪除、停用都沒有）；若之後有人停用或刪除了它們，這條退路就不存在了，請先到 n8n 確認。

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
| 關箱 LINE 通知 | 無 | 新功能：關箱後推播到 LINE 群組（選配，見「LINE 群組通知」） |
| 寫入速度 | 每筆各自寫入，沒有節流（量大時會撞到 Google 配額而失敗） | 過去 60 秒內最多起始 55 次 append（Google 寫入配額每分鐘 60 次／使用者，留 5 次餘裕）：過去 60 秒累計 55 件內全速寫入，超過才排隊放慢，而不是失敗 |
| `color`、`size` 是 JSON 數字時的合併品名 | JavaScript 會把兩個數字相加（例如 `-1` 與 `5` 得到 `(4)`） | 一律當文字串接（得到 `(-15)`）。前端永遠送字串，不會觸發 |

## 安全與限制

- **沒有登入機制**，與原 n8n webhook 相同：任何知道網址的人都能呼叫 `/api/*`。已做的防護：每 IP 每分鐘限流（OCR 60 次、存檔 600 次、關箱通知 60 次、LINE webhook 120 次，各自計算；記憶體內，服務重啟即重置；IP 取 `X-Forwarded-For` 由右往左第一個公開位址）、15 MB body 上限、存檔欄位驗證與公式字元處理、錯誤訊息不帶金鑰。若需要更嚴格的存取控制，請另外規劃（例如在前面加存取閘道）。
- **限流與寫入速度**：
  - **限流（每 IP 每分鐘）**：`/api/ocr` 60 次（`OCR_RATE_LIMIT_MAX`）、`/api/save` 600 次（`SAVE_RATE_LIMIT_MAX`）、`/api/box-closed` 60 次（`BOX_CLOSED_RATE_LIMIT_MAX`）、`/api/line/webhook` 120 次（`LINE_WEBHOOK_RATE_LIMIT_MAX`），四個額度**各自獨立計算**——關箱時前端是逐筆、循序送出，不會被拍照的次數擠壓。其他 `/api/*` 路徑（含不存在的）算進 OCR 的額度。常數在 `src/app.ts`。同一個出口 IP（例如倉庫同一個網路）的人共用一份額度。
  - **寫入速度（滾動視窗配額）**：Google Sheets API 的寫入配額預設是每分鐘 60 次／使用者（服務帳號算一個使用者；每專案 300 次，超過回 429；來源：developers.google.com/workspace/sheets/api/limits，2026-10-05 查閱）。所以伺服器對 `values.append` 做**全域的滾動視窗配額**（整個程序共用、不分來源請求）：過去 **60 秒**內已起始的 append 少於 **55 次**（留 5 次餘裕）就**立刻送出、不等待**（視窗內可以同時有多筆在途）；達到 55 次時依先進先出排隊，等最舊的那次起始時間離開視窗才送。常數是 `src/sheets.ts` 的 `APPEND_WINDOW_MAX`（55）與 `APPEND_WINDOW_MS`（60 000），建構 `SheetsClient` 時可用 `appendWindowMax`、`appendWindowMs` 覆寫。規則細節：401 之後的重送算一次新的起始、同樣受視窗限制；換不到 token 的失敗發生在取得名額之前，不佔配額；已經送出但失敗的那次照樣佔配額；前一筆不論成功或失敗都不會卡住後面的；讀表頭不受影響。
  - **實務影響**：**55 件內全速、超過才放慢**。全速＝不人為等待，每筆只是一次 Google 往返；放慢＝第 56 件起要等視窗放出名額（最多約 60 秒），之後再全速送，整體平均約每分鐘 55 件——這是為了不撞到 Google 配額而失敗。「55 件」是**過去 60 秒內累計**的件數，所有箱子、所有人共用同一份配額：例如一分鐘內連續關兩個 30 件的箱子，第二個箱子做到約第 26 件就會停頓一陣子。
  - **⚠️ 前端沒有「同步中」的鎖定**：頁面的「正在同步到商品主檔…」提示約 2.5 秒就消失，確認對話框關閉後「完成此箱」鈕仍可按，直到全部寫完才會鎖箱。依裁定前端沒有加這個鎖定（`index.html` 只改了兩個端點常數，外加關箱 LINE 通知的 `NotifyEngine` 與關箱流程裡的一次呼叫）。所以請提醒現場：**按下確認後，等到出現「已同步 N 筆到商品主檔 ✓」再離開頁面或再按一次**——中途離開頁面，剩下的筆就不會送出；重複按會把同一箱再送一次（重複列）。超過 55 件的大箱子會在中途停頓一陣子（視前面花了多久而定，最多約 1 分鐘），更要等。
  - **等待與代理逾時**：視窗已滿時，單一請求最長要等約 60 秒（等最舊的起始離開視窗），剛好在一般反向代理 60 秒左右的逾時邊緣（排在後面的也不會等更久：每過一個視窗，最舊的那批起始會一起離開）；Zeabur 的實際逾時未確認。等得比代理逾時還久，前端會先看到失敗、伺服器之後卻還是寫入，使用者重送就變成重複列。部署後請用一個超過 55 件的箱子實測一次。
  - **排隊上限**：排隊等名額（視窗已滿、還沒送出）的 append 超過 `APPEND_MAX_PENDING`（50）筆時，新的請求直接回 503「目前等待寫入的筆數過多」；已經取得名額、正在送出的不算。這個上限是為了避免異常流量讓請求與連線越積越多，**不是**等待時間的上限：排隊的人最多等約一個視窗（60 秒），與排在第幾個無關。正常使用時前端是逐筆等回應才送下一筆，排隊的人數頂多等於同時關大箱子的人數。
  - **已知限制**：(1) 排隊上限是**全域**的，沒有每個 IP 各自的佇列額度——單一來源在一分鐘內送出約 51～105 個請求（視窗已被用滿時只要 51 個：50 個排隊再加 1 個；視窗全空時要先用掉 55 個名額再排滿 50 個，共約 105 個；每分鐘 600 次的存檔額度都允許），就能讓全站的存檔暫時回 503（約一分鐘）；單純每分鐘送滿 55 筆也能用光全站的視窗配額，讓別人的存檔排隊等待；(2) client 中途斷線時，已排進佇列的請求仍會寫入（與 n8n 版相同）；(3) 佇列在記憶體裡，服務重啟或重新部署時，還沒寫進試算表的排隊中存檔會遺失（見「部署」的優雅關閉說明）；(4) 視窗內可以同時有多筆 append 在途，同時送出的多筆在試算表裡的列順序不保證與送出順序相同（前端單一裝置逐筆送出時不受影響）。
- **不開 CORS**：頁面與 API 同源。
- **`/api/save` 的 `values.append` 不自動重試**：逾時或 5xx 時無法確定有沒有寫進去，重試可能造成重複列；失敗時前端會提示，請到試算表確認後再補送。唯一的例外是 401（授權過期、請求尚未執行）：換新 token 後重送一次，重送算一次新的起始、同樣受視窗配額限制。
- log 不記請求內容（圖片、商品資料）與任何金鑰；上游失敗只記狀態碼與錯誤類型／代碼（Google 讀表頭失敗時另記其簡短錯誤訊息，方便判斷是分頁名稱還是權限問題；append 失敗不記訊息，因為可能回顯欄位值）。

## 專案結構

```
index.html              原本的前端頁面（OCR／存檔兩個端點常數改成 /api/ocr、/api/save；另多了 NotifyEngine 與關箱流程裡的一次呼叫，用來通知 LINE）
src/server.ts           啟動入口（讀環境變數與 index.html，監聽 0.0.0.0:PORT）
src/app.ts              Hono app：路由、限流（OCR／存檔／關箱通知／LINE webhook 各自額度）、body 上限、錯誤處理
src/ocr.ts              OCR：prompt、請求組裝、OpenAI 呼叫（timeout、重試）、回應解析
src/sheets.ts           存檔：欄位整理、合併品名、表頭對應、Sheets REST（讀表頭＋append）、append 滾動視窗配額
src/google-auth.ts      服務帳號 JWT（RS256）換 token、憑證解析（JSON／base64）
src/line.ts             關箱 LINE 通知：輸入驗證、訊息組字、push／reply、webhook 驗簽與事件處理
src/rate-limit.ts       固定視窗限流與客戶端 IP 判斷
src/env.ts              環境變數載入
src/common.ts           共用型別與工具（ServiceError、Logger、FetchLike）
tests/                  vitest（含 notify-engine.test.ts：直接從 index.html 取出 NotifyEngine 在 Node 執行來測）；tests/fixtures/n8n-golden.json 是 n8n 現行版的標準答案（產生腳本：tests/fixtures/generate-n8n-golden.mjs）
docs/legacy-n8n/        已退役的 n8n 工作流匯出（歷史參考）
Dockerfile              兩階段建置，EXPOSE／預設 PORT=8080
```
