# savepoint-crate — IPAS 庫存盤點裝箱系統

倉庫人員用手機開網頁、**用自己的帳號（Email＋密碼）登入**後，建立箱號 → 對著商品條碼標籤拍照 → 系統用 OpenAI Vision 辨識（條碼、品名、性別、顏色、尺寸）→ 人工確認或修改 → **關箱時**逐筆寫進 Google 試算表「商品主檔」，並（選配）推播一則關箱通知到 LINE 群組（訊息帶操作者的姓名）。**全站要登入**：帳號有兩種角色——管理員（可進 `/settings` 設定頁：設定 LINE 通知、建立與管理所有人的帳號與角色）與一般使用者（只能使用裝箱程式）。**密碼統一由管理員設定，個人不能自己改密碼**（沒有「改自己的密碼」的功能），見「設定頁與 Volume」。

## 架構

這是**單一 Node 服務**（Hono ＋ `@hono/node-server`，TypeScript）：同一個服務既提供原本的 `index.html`，也提供後端端點（辨識、存檔、關箱 LINE 通知）。OpenAI 金鑰與 Google 服務帳號金鑰只存在伺服器環境變數；LINE token 存在環境變數或設定頁的設定檔（Volume 上，見「設定頁與 Volume」）。它們都不會進入前端。帳號（含密碼雜湊）也存在 Volume 上的設定檔。

```
手機瀏覽器 ── GET /login、POST /login ─→ 後端（Email＋密碼登入，發 session cookie）
          ── GET /            ─→ index.html（要先登入；純靜態頁，邏輯都在頁面內）
          ── GET /assets/*     ─→ 靜態資源（WIWI 配色 token 與 Logo；公開，不用登入）
          ── POST /api/ocr    ─→ 後端（要登入）─→ OpenAI chat/completions（Vision）
          ── POST /api/save   ─→ 後端（要登入）─→ Google Sheets API（讀表頭＋append）
          ── POST /api/box-closed ─→ 後端（要登入）─→ LINE Messaging API（push 到群組，訊息帶操作者；選配）
LINE 平台 ── POST /api/line/webhook ─→ 後端（取得群組 ID 用；選配；靠簽章驗證，不用登入）
管理員 ──── GET /settings、/api/settings*、/api/accounts* ─→ 後端 ─→ 資料目錄 DATA_DIR/settings.json（Volume：帳號與 LINE 設定）
```

> 2026-10-05 起取代原本打到 n8n（`waltho1123.zeabur.app/webhook/ipas-ocr`、`/webhook/ipas-save-product`）的兩條 webhook，詳見下方「n8n 已退役」。

## 端點

| 方法與路徑 | 說明 |
|---|---|
| `GET /`、`GET /index.html` | 回傳 `index.html`（`Cache-Control: no-cache`）。**沒登入 → 302 導向 `/login?next=/`**（登入後回到主頁）。 |
| `GET /assets/<檔名>`（公開，不用登入） | WIWI 品牌配色與 Logo（`public/assets/` 底下的 `wiwi-colors.css`、`wiwi-logo.svg`、`wiwi-logo-white.svg`）：`Cache-Control: public, max-age=86400`、`X-Content-Type-Options: nosniff`、正確的 Content-Type（CSS `text/css; charset=utf-8`、SVG `image/svg+xml`）；只有「剛好是資源表裡的檔名」才有內容，其餘（不存在、路徑穿越寫法、子目錄、大小寫不同…）一律 404，非 GET／HEAD 回 405。見「品牌配色與靜態資源」。 |
| `GET /healthz`（公開，不用登入） | 回 `{ ok, openaiConfigured, sheetsConfigured, serviceAccountEmail, clientIp, requestIsHttps, dataDirWritable, dataDirMounted, adminConfigured, adminCount, accountCount, legacyAdminPending, lineConfigured, lineWebhookConfigured, lineSource }`。`requestIsHttps`：這個請求被判斷為 HTTPS（看 `X-Forwarded-Proto`；Zeabur 的反向代理要有送，登入 cookie 才會加 `Secure`），和 `clientIp` 一樣是部署後 curl 一次就能確認代理行為的診斷欄位。`dataDirWritable`：資料目錄（Volume）可寫入，設定頁才能用；`dataDirMounted`：它是不是獨立掛載的磁碟（`false`＝只是容器內的暫存目錄，重新部署後設定會消失；`null`＝判斷不出來，例如非 Linux）；`adminConfigured`：有至少一位啟用中的管理員（角色 admin），或仍有待升級的舊版單一密碼（設定頁「有人進得去」）；`adminCount`：角色是 admin 的帳號數（含停用的）；`accountCount`：帳號總數（兩種角色、含停用的）；`legacyAdminPending`：還有舊版的單一管理密碼沒升級成帳號。`lineConfigured` 是**生效的** LINE 設定裡 token 與群組 ID 都有、且開關開著（關箱通知會推播），`lineWebhookConfigured` 是有 channel secret（webhook 啟用），`lineSource` 是生效的設定來自設定頁（`"settings"`）還是環境變數（`"env"`），都沒設定是 `null`；皆不含任何設定值。`serviceAccountEmail` 是從 `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS` 解析出的 `client_email`（缺少或解析失敗時為 `null`），部署後用它知道要把試算表分享給誰；**絕不**回傳 `private_key` 或憑證其他欄位。`clientIp` 是**限流用的同一個判斷**所得到的呼叫端 IP（`X-Forwarded-For` 由右往左第一個公開位址；沒有就是 TCP 連線位址；再沒有就是 `"unknown"`），部署後 curl 一次就能確認 Zeabur 反向代理的處理是否正確（見「部署」）。 |
| `POST /api/ocr` | **要登入（任一角色），而且要帶 `X-Requested-With: XMLHttpRequest`**（沒登入 401 `{success:false,error:"請先登入"}`、缺標頭 403；`/api/save`、`/api/box-closed` 同）。請求 `{ "image": "data:image/jpeg;base64,...", "boxId": "BOX-001" }`。成功 `{ "success": true, "data": { "barcode", "productName", "gender", "color", "size" } }`。 |
| `POST /api/save` | 要登入（見 `/api/ocr`）。請求 `{ seqNo, date, boxId, barcode, productName, gender, color, size, quantity, time }`（與原 n8n webhook 相同）。成功 `{ "success": true, "range": "'商品主檔'!A125:K125" }`；`range` 取自 Sheets API `values.append` 回應的 `updates.updatedRange`，拿不到時省略該欄位。 |
| `POST /api/box-closed` | 要登入（見 `/api/ocr`）。關箱後的 LINE 群組通知（見「LINE 群組通知」），訊息帶**登入者的姓名**（來自 session，請求內容裡的任何 `operator` 欄位都忽略）。請求 `{ boxId, closedAt?, items: [{ barcode, productName, gender, color, size, qty }], total, successCount, failedCount }`。**輸入格式正確、且沒被限流（429）或擋下（413）時一律回 200**：`{ "success": true, "notified": true }`，或 `{ "success": true, "notified": false, "reason": "not_configured" }`（LINE 沒設定好，靜默略過）、`{ "success": true, "notified": false, "reason": "push_failed", "error": "…" }`（推播失敗，`error` 是簡短原因）——LINE 的狀況不會讓關箱看起來失敗。 |
| `POST /api/line/webhook` | 公開（靠簽章驗證，不用登入）。LINE 平台的 webhook（生效的設定裡有 channel secret 才啟用，否則 503；secret 來自設定頁或 `LINE_CHANNEL_SECRET`，見「設定頁與 Volume」）。驗證 `X-Line-Signature`（對原始 body 做 HMAC-SHA256，不符回 401），驗證通過一律回 200。群組裡的 `join` 事件或文字訊息「群組ID」／「群組 ID」，會用 `replyToken` 回覆該群組的 ID；`join` 與群組裡的所有訊息事件還會把該群組記到設定檔的「最近收到的群組」（同一群組去重、最新在前、最多 10 筆；同一個群組的訊息事件 10 分鐘內只處理一次——查名稱與寫檔都不重複，節流表在記憶體內、服務重啟後重新開始），讓設定頁一鍵帶入群組 ID；其他事件忽略。 |
| `GET /login`、`POST /login`、`POST /logout` | 登入頁（Email＋密碼）／登入 `{ email, password, next? }` → `{ success: true, next }`（`next` 只接受同源的相對路徑：以 `/` 開頭、不是 `//`、不含反斜線與控制字元，其他一律當成 `/`）／登出（清 cookie）。已登入者開 `/login` 會被導向 `/`；還沒有任何帳號時 `/login` 顯示「請管理員先到設定頁」。 |
| `GET /api/me` | 目前登入者 `{ "success": true, "data": { "id", "name", "email", "role" } }`（任一角色；沒登入 401）。主頁頂端的使用者列用它。 |
| `GET /account` | 我的帳號頁（唯讀：姓名、Email、角色，加一行「密碼由管理員統一設定，需要變更請洽管理員」，沒有任何表單；任一角色；沒登入 302 導向 `/login?next=/account`）。**沒有任何「自己改密碼」的端點**：`POST /account/password`（以及更早的 `POST /settings/password`）不存在，回 404；密碼只由管理員用 `POST /api/accounts/:id/password` 設定（見下）。 |
| `GET /settings` | 設定頁（HTML；**只有管理員**）：沒登入 302 導向 `/login?next=/settings`、登入的是一般使用者 403（「需要管理員權限」頁）、資料目錄不可用 503。還沒有任何帳號時（全新安裝、或舊版單一密碼待升級）改顯示建立第一位管理員／升級的表單（這兩個流程各有自己的秘密擋著：設定碼、目前的密碼）。已登入的管理員：LINE 設定、帳號管理。見「設定頁與 Volume」。 |
| `POST /settings/setup`、`/settings/upgrade` | 建立第一位管理員（設定碼＋姓名＋Email＋密碼；角色一定是 admin）／把舊版單一密碼升級成管理員帳號（目前的密碼＋姓名＋Email；角色 admin）。**所有狀態變更端點**（含 `/login`、`/logout` 與下面的 `/api/*`）一律只收 `Content-Type: application/json`，且必須帶標頭 `X-Requested-With: XMLHttpRequest`（CSRF 防護）。 |
| `GET /api/settings`、`PUT /api/settings/line`、`POST /api/settings/line/test` | **只有管理員**（沒登入 401、一般使用者 403 `{success:false,error:"需要管理員權限"}`）：讀目前設定（token／secret 只回「已設定」與末 4 碼；另有 `me`＝目前登入的帳號 `{id,name,email,role}`）／儲存 LINE 設定／推播測試訊息到已儲存的群組。 |
| `GET /api/accounts`、`POST /api/accounts`、`PATCH /api/accounts/:id`、`POST /api/accounts/:id/password`、`POST /api/accounts/:id/status`、`DELETE /api/accounts/:id` | 帳號管理（**只有管理員**）：列出（不含密碼雜湊，含角色）／新增 `{name,email,password,role?}`（`role` 是 `admin` 或 `user`，沒給就是 `user`）／修改 `{name?,email?,role?}`／重設密碼 `{newPassword}`（對任何帳號，**包括管理員自己**；密碼只由管理員設定，對自己重設時這個瀏覽器自動換新的登入、其他裝置的登入失效）／停用或啟用 `{status:"active"\|"disabled"}`／刪除。規則見「設定頁與 Volume → 帳號與角色」。 |

失敗一律回 `{ "success": false, "error": "…" }`（繁中訊息，不含金鑰與上游原始回應），狀態碼如下：

| 狀態碼 | 情況 |
|---|---|
| 400 | JSON 格式錯誤、缺少 `image`、`image` 不是合法 data URL、`/api/save` 欄位型別不對或整筆都是空的、`/api/box-closed` 輸入不合規則（`boxId` 空白或超過 100 字、`items` 不是陣列或超過 500 筆、文字欄位超過 200 字、`qty` 不是 1～9999 的整數、數量欄位不是非負整數）；設定頁、登入與 `/api/accounts*` 的輸入不合規則（姓名不是 1～50 字、Email 格式不對、密碼不是 8～200 字、`role` 不是 `admin`／`user`、`status` 不是 `active`／`disabled`、`PATCH` 沒有任何要改的欄位、還沒有任何帳號就想登入） |
| 401 | `/api/line/webhook` 的 `X-Line-Signature` 缺少或不符；**OCR、存檔、關箱通知、`/api/me`、設定 API、帳號 API 沒登入**（或 cookie 過期、被竄改、帳號已被停用／刪除、重設過密碼或改過角色）；登入失敗（帳號不存在、帳號停用、密碼不對都是同一句「帳號或密碼不正確」）；升級時目前的密碼不對 |
| 403 | 登入的是一般使用者卻存取設定頁、設定 API、帳號 API（「需要管理員權限」）；首次設定碼不正確；狀態變更請求（含 OCR、存檔、關箱通知）缺少 `X-Requested-With` 標頭 |
| 404 | `/api/accounts/:id*`：找不到這個帳號（id 不存在或格式不對）；沒有這個路徑（包括已經不存在的自助改密碼 `POST /account/password`）；`/assets/*` 沒有這個檔案（含各種路徑穿越寫法） |
| 409 | `/settings/setup`：已經有帳號（或還有舊版單一密碼等著升級）；`/settings/upgrade`：沒有待升級的舊版密碼；`/login`：還沒升級；`/api/accounts*`：Email 重複、不能停用或刪除自己、不能把自己改成一般使用者、不能停用、刪除或降級最後一位啟用中的管理員、帳號數量已達上限（200 個） |
| 415 | 設定頁的狀態變更請求不是 `Content-Type: application/json` |
| 413 | 請求內容超過 15 MB（登入、登出、`/settings/*`、`/api/settings/*`、`/api/accounts*` 的上限是 16 KB） |
| 429 | 同一個 IP 一分鐘內超過額度：`/api/ocr` 60 次、`/api/save` 600 次、`/api/box-closed` 60 次、`/api/line/webhook` 120 次，`/api/settings*`、`/api/accounts*` 與 `/api/me` 共用 60 次，五個額度各自計算（其他 `/api/*` 路徑算進 OCR 的額度）；登入頁另有更嚴的限制：建立第一位管理員 5 次、登入／升級共用 10 次、測試訊息 6 次；沒登入的 OCR／存檔／關箱通知請求在限流之前就被 401 擋下，其他沒登入的 `/api/*` 請求（`/api/me`、設定與帳號 API 的探測、不存在的路徑）算在另一組「匿名」額度，兩者都不會吃掉同一個出口 IP 上已登入同事的額度；另外 scrypt（密碼雜湊／驗證）同時最多跑 2 個、排隊 16 個，超過直接回 429「目前驗證請求過多，請稍後再試」；兩種 429 都帶 `Retry-After`（秒） |
| 500 | 試算表／憑證設定問題：表頭缺必要欄位（訊息會列出缺哪欄）、服務帳號沒有權限或憑證無效、找不到試算表或分頁 |
| 502 | OpenAI 或 Google 暫時失敗（OCR 已自動重試一次）、OpenAI 回傳內容無法解析 |
| 503 | 伺服器尚未設定 `OPENAI_API_KEY`（OCR）或 Google 憑證（存檔）；或同時排隊等待寫入的存檔超過 50 筆；或 `/api/line/webhook` 沒有 channel secret（webhook 未啟用）；或資料目錄不可用（沒有地方存帳號，沒有人登入得了）時的登入頁、設定頁、OCR、存檔、關箱通知與各 API（訊息「請在 Zeabur 掛載 Volume 到 /app/data」；`/healthz` 與 LINE webhook 不受影響） |

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
| `LINE_CHANNEL_ACCESS_TOKEN` | 否 | 空（未設定） | **備援**（設定頁優先，見「設定頁與 Volume」）。LINE Messaging API 的 channel access token（長期）：關箱通知推播、webhook 回覆用。 |
| `LINE_GROUP_ID` | 否 | 空（未設定） | **備援**。關箱通知的目標群組 ID（`C` 開頭）。**token 與群組 ID 兩者都有才會推播**，只有一個等於沒設定。 |
| `LINE_CHANNEL_SECRET` | 否 | 空（未設定） | **備援**。channel secret，**只用來驗證 webhook 簽章**（取得群組 ID 時才需要）；沒設定時 `POST /api/line/webhook` 回 503。 |
| `DATA_DIR` | 否 | `./data`（容器裡由 Dockerfile 設成 `/app/data`） | 設定頁的資料目錄（放 `settings.json`）。Zeabur 上要把 Volume 掛在這裡，見「設定頁與 Volume」。不存在會自動建立；不可寫入時服務照常啟動，但沒有地方存帳號，整個網站（登入、裝箱程式、設定頁）回 503，只有 `/healthz` 與 LINE webhook 照常。 |
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

## 設定頁與 Volume

**全站要登入**：每個人用自己的帳號（Email＋密碼）登入，才能使用裝箱程式（主頁、辨識、存檔、關箱通知）。帳號與 LINE 設定都存在資料目錄 `DATA_DIR`（容器裡是 `/app/data`）的 `settings.json`，所以**一定要在 Zeabur 掛一個 Volume 到 `/app/data`**。`/settings` 是管理員用的設定頁：設定 LINE 群組通知（Channel access token、Channel secret、群組 ID、開關）、一鍵從「最近收到的群組」帶入群組 ID、發測試訊息，也可以建立與管理所有人的帳號與角色——**不必改環境變數、不必重新部署**，存檔立刻生效。

**沒有 Volume（資料目錄不存在或寫不進去）時沒有地方存帳號，所以沒有人登入得了：登入頁、設定頁、OCR、存檔、關箱通知全部回 503「請在 Zeabur 掛載 Volume 到 /app/data」**（`/healthz` 與 LINE webhook 仍然可用，`/healthz` 的 `dataDirWritable` 會告訴你原因）。以前沒有 Volume 時 OCR 與存檔仍可使用，全站登入之後不是了——上線前請先確認 Volume 掛好。

### 在 Zeabur 掛載 Volume

Zeabur CLI 無法掛載 Volume，只能在 Dashboard 操作：

1. Zeabur Dashboard → 這個專案 → 這個服務 →「硬碟（Volume）」→ 新增。
2. 掛載路徑填 `/app/data`，儲存；服務會重新啟動。
3. 驗證：`curl -s https://<網域>/healthz`，看 `dataDirWritable` 與 `dataDirMounted`：

| `dataDirWritable` | `dataDirMounted` | 意思 |
|---|---|---|
| `true` | `true` | 正常：資料目錄在獨立掛載的磁碟上，重新部署後帳號與設定還在。 |
| `true` | `false` | 資料目錄只是容器內的暫存目錄（沒掛 Volume）：能用，但**重新部署後帳號與設定會消失**（要重新建立第一位管理員）；log 也會有一行警告。回去掛 Volume。 |
| `true` | `null` | 判斷不出來（非 Linux 環境，例如本機 macOS 開發）。 |
| `false` | — | 資料目錄不存在又建不起來、或寫不進去：整個網站 503。log 有一行 `[settings] 資料目錄 … 不可用`。 |

**權限**：容器以 root 啟動入口腳本（`scripts/docker-entrypoint.sh`），它把 `/app/data` 的擁有者修成 `appuser`（uid／gid 10001；`chown -R -h`，不追符號連結），再用 `su-exec` 降權，之後的 node 行程**不是 root**（啟動時若發現自己還是 root，會在 log 警告——代表平台的啟動指令繞過了入口腳本）。平台掛上來的 Volume 通常是 root 擁有的空目錄，沒有這一步 node 就寫不進去。若平台本來就以非 root 啟動（`docker run --user`），入口腳本跳過修正，只檢查目錄可寫。**資料目錄的任何問題（建不了、改不了擁有者、不可寫）入口腳本都只印警告、不讓容器退出**——這樣 `/healthz` 還看得到原因；node 端會再寫一行 error log，網站回 503。（想改成「資料目錄有問題就整個起不來」：把腳本裡的 `warn` 換成 `die`。）

### 帳號與角色

每個帳號有自己的**姓名、Email（登入帳號）、密碼、角色**；沒有預設帳號。帳號存在 `settings.json` 的 `accounts`。

| 角色 | 能做什麼 |
|---|---|
| **管理員**（`admin`） | 使用裝箱程式、查看自己的帳號資料；**另外**可以進設定頁（LINE 設定）、新增／編輯／停用／刪除所有帳號、改角色、**設定所有人的密碼（包括自己的）**。 |
| **一般使用者**（`user`） | 使用裝箱程式、查看自己的帳號資料。進設定頁或呼叫設定／帳號 API 一律 403「需要管理員權限」。**不能自己改密碼**，要變更請洽管理員。 |

**密碼只由管理員設定**：沒有任何人（包括管理員）能憑「目前的密碼」自己改密碼——系統沒有「改自己的密碼」的端點，`/account` 頁只顯示「密碼由管理員統一設定，需要變更請洽管理員」。管理員在設定頁的「帳號管理」按「重設密碼」設定任何帳號的密碼，**包括自己的**（重設自己的密碼不需要輸入目前的密碼，管理員的登入就是授權；這個瀏覽器自動換新的登入、不會被登出，其他裝置的登入失效）。

各路徑的權限（帳號必須是啟用中；停用的帳號一律當成沒登入）：

| 路徑 | 沒登入 | 一般使用者 | 管理員 |
|---|---|---|---|
| `GET /`、`/index.html`（裝箱程式） | 302 → `/login?next=/` | 可 | 可 |
| `POST /api/ocr`、`/api/save`、`/api/box-closed` | 401 | 可（要帶 `X-Requested-With`） | 可 |
| `GET /api/me`、`GET /account`（唯讀） | 401／302 → `/login?next=/account` | 可 | 可 |
| `GET /settings`、`/api/settings*`、`/api/accounts*` | 302 → `/login?next=/settings`／401 | **403** | 可 |
| `POST /api/accounts/:id/password`（設定密碼：唯一的途徑） | 401 | **403**（連自己的也不行） | 可（任何帳號，包括自己） |
| `POST /account/password`（自助改密碼：已移除） | 404 | 404 | 404 |
| `GET /login`、`POST /login`、`POST /logout` | 可（`/login` 已登入會導向 `/`） | 可 | 可 |
| `GET /healthz`、`POST /api/line/webhook` | 公開 | 公開 | 公開 |

#### 上線提醒：部署後所有人都要登入，管理員先建帳號

全站登入上線的那一刻起，**沒有帳號的人什麼都用不了**（主頁導向登入頁）。請照順序做：

1. **管理員先登入**：
   - 已經在用舊版**單一管理密碼**、還沒升級的部署（`/healthz` 顯示 `legacyAdminPending: true`、`adminCount: 0`）：升級完成之前**所有人（包括管理員）都登不進去**，登入頁會提示「請管理員先到設定頁」。管理員開 `/settings`，用目前正在使用的管理密碼升級成管理員帳號（見下面「從舊版的單一管理密碼升級」，LINE 設定原封不動）。
   - 已經有**管理員帳號**的部署（上一版的檔案格式，管理員沒有角色欄位）：所有舊管理員自動成為「管理員」角色，照原本的 Email 與密碼登入，登入第一次寫檔時檔案自動升成版本 3。
   - 全新安裝：照下面「全新安裝」用設定碼建立第一位管理員。
2. **管理員到設定頁的「帳號管理」替每位同事建立帳號**（姓名、Email、密碼、角色；預設是一般使用者），再把網址、Email 與密碼告訴大家。**密碼統一由管理員設定，同事不能自己改**：他們的「我的帳號」頁只有姓名、Email、角色與一行說明「密碼由管理員統一設定，需要變更請洽管理員」。
3. 同事要換密碼或忘記密碼：管理員在「帳號管理」按「重設密碼」（對方所有裝置上的登入會失效）。管理員自己要換密碼：登入後在表格自己那一列按「重設密碼」（這個瀏覽器維持登入，其他裝置會被登出）。管理員忘記密碼、登不進去：另一位管理員幫忙重設；所有管理員都登不進去：用下面「忘記所有密碼時的復原方式」。
4. 瀏覽器裡的箱子資料（`localStorage`）不受影響；登入過期時頁面會導向登入頁，登入後回到原本的頁面，箱子資料還在。按「完成此箱」時會先確認登入還有效：已經過期的話**什麼都不送、箱子保持開啟**（不會鎖起來、也不會漏同步），登入後再按一次即可；若剛好是同步到一半才過期（機率很低，因為關箱前才剛確認過），箱子同樣保持開啟，但已經寫進試算表的那幾筆會在重新同步時再寫一次（試算表會出現重複列，需要人工刪除）。
5. 登入與升級共用「每個 IP 每分鐘 10 次」的限流（成功也算，沒有帳號鎖定）：同一個辦公室（同一個出口 IP）上線第一天若超過 10 個人在同一分鐘內登入，後面的人會看到「請求過於頻繁，請稍後再試」，等一分鐘再試即可；登入有效 7 天，平常不會同時登入。

#### 全新安裝：用設定碼建立第一位管理員

沒有任何預設密碼，也不需要任何環境變數。**每次服務啟動時，如果還沒有任何帳號**（也沒有舊版的單一密碼等著升級），會產生一組一次性的設定碼寫進 log：

```
[settings] 尚未設定管理密碼：請開啟 /settings，用設定碼 XXXX-XXXX 建立密碼
```

1. 在 Zeabur 這個服務的「記錄（Logs）」找這一行（沒有這一行代表已經有帳號了、或有舊密碼待升級、或資料目錄不可用——後者見上面的對照表）。設定碼只存在記憶體，服務每次重新啟動都會換一組；用過一次（建立成功）就作廢。
2. 開啟 `https://<網域>/settings`，輸入設定碼、**姓名**（1～50 字）、**Email**、密碼（至少 8 個字元、最多 200）→ 建立第一位管理員（角色一定是管理員）並自動登入。
3. **請在第一次部署後立刻做這件事。** 在建立之前，任何能看到這個服務記錄的人都能用設定碼建立管理員。設定碼錯誤累計 20 次就整組作廢、換新的一組（新的碼會寫進 log）；每個 IP 每分鐘最多試 5 次。

#### 從舊版的單一管理密碼升級（已經上線的部署）

舊版（`b54b21b`，只有一個管理密碼）已經上線的部署，照下面做，**不需要中斷服務、不需要動 Volume 或環境變數**（升級完成之前，全站登入讓所有人都暫時用不了裝箱程式，見上面的上線提醒）：

1. 部署新版，**等 Zeabur 顯示新版部署完成、舊的容器已經停掉再做下一步**（滾動部署的重疊期間，舊容器若剛好收到 LINE webhook，會把它記憶體裡的舊格式整份寫回檔案，蓋掉剛做完的升級；這種情況管理員會從檔案裡消失，要重新升級）。升級完成之前：LINE webhook（含記錄最近收到的群組）照常用設定頁原本存的 LINE 設定運作；`/healthz` 顯示 `legacyAdminPending: true`、`adminConfigured: true`、`adminCount: 0`、`accountCount: 0`；登入與建立端點回 409「請先升級」，不提示設定碼；主頁導向登入頁，登入頁顯示「尚未建立任何帳號，請管理員先到設定頁」。
2. 開啟 `https://<網域>/settings`：會看到「**升級為管理員帳號**」表單。輸入**目前正在使用的管理密碼**，再填你的**姓名**與 **Email**，按「升級並登入」。
3. 升級做的事（一次原子寫入）：以你填的姓名與 Email 建立第一個帳號（**角色：管理員**），**沿用同一個密碼雜湊（不要求重設密碼）**，刪除舊的 `admin` 欄位，檔案版本變成 3。**`line`（LINE 設定）、`lineCaptured`（最近收到的群組）、`sessionSecret` 與頂層、`line`、`lineCaptured` 裡任何不認識的欄位都原封不動**（只有舊的 `admin` 物件本身，連同它裡面的欄位，會被刪除），所以升級前後關箱通知完全不受影響。
4. 升級前發的舊登入（cookie）一律失效；升級後用 **Email ＋ 原本那個密碼**登入。接著到「帳號管理」替其他人建立帳號。
5. 目前的密碼輸入錯誤回 401、不改任何東西；升級走密碼驗證的並行閘門與登入的限流（每 IP 每分鐘 10 次）。
6. **回滾**：升級前檔案維持版本 1（即使這段期間 webhook 記錄了新的群組，寫的也還是版本 1 並保留舊的 `admin`），所以升級前回滾到上一版仍然讀得懂。**升級後（版本 3）若回滾到舊版程式，舊版不認識版本 3，會把檔案當成損毀、備份成 `settings.json.corrupt-<時間>` 後以空設定重新開始**（LINE 設定在備份檔裡，需要手動搬回）——升級前先確認不需要回滾。

#### 登入與日常管理

- **登入**：Email（不分大小寫、前後空白不影響）＋密碼。成功後發 7 天有效的 session cookie（`sp_session`），cookie 綁定**帳號**與該帳號的 `sessionVersion`。登入失敗一律回同一句「帳號或密碼不正確」，不論是帳號不存在、帳號已停用或密碼不對；查無帳號與停用的帳號也會用固定的假雜湊跑一次 scrypt，回應時間不洩漏帳號存不存在。登入成功會更新「最後登入」時間；這個時間寫不進去（例如 Volume 滿了或變成唯讀）只會記一行警告，不會讓登入失敗。**登入後回到哪裡**由 `next` 決定：被導向登入頁時帶著原本要去的路徑（例如 `/login?next=/settings`），只接受同源的相對路徑，其他一律回 `/`。
- **主頁頂端的使用者列**：登入後主頁最上面有一條窄列，顯示「👤 姓名（角色）」、「我的帳號」、（管理員才有）「設定」與「登出」。登出只清這個瀏覽器的 cookie。主頁的 OCR、存檔、關箱通知請求回 401（登入過期）時，頁面自動導向登入頁，登入後回到主頁；箱子資料（`localStorage`）不受影響。「完成此箱」會先用 `GET /api/me` 確認登入還有效，過期就不送出任何東西、箱子保持開啟（登入後再按一次）。
- **我的帳號**（`/account`，任一角色，唯讀）：顯示自己的姓名、Email、角色，以及一行說明「密碼由管理員統一設定，需要變更請洽管理員」；沒有任何表單，沒有自己改密碼的功能。要改姓名、Email、角色或密碼，請洽管理員。
- **帳號管理**（設定頁，管理員）表格：姓名、Email、角色、狀態、最後登入；按鈕：**新增帳號**（姓名、Email、角色、密碼）、**編輯**（姓名、Email、角色）、**重設密碼**（任何帳號，包括自己的；這是設定密碼的唯一途徑）、**停用／啟用**、**刪除**。停用與刪除會先跳出確認；自己那一列只有「停用」與「刪除」不能按。
  - 規則（伺服器端強制，頁面只是把按鈕停用）：**不能停用或刪除自己**；**不能把自己改成一般使用者**；不能停用、刪除或降級**最後一位啟用中的管理員**；Email（不分大小寫）不可重複，重複回 409；姓名 1～50 字（不可含換行、控制字元、雙向控制字元與零寬字元，而且至少要有一個看得見的字）、Email 格式檢查（一般的 RFC 寬鬆版、只收 ASCII，長度 ≤ 254、本地部分 ≤ 64）、密碼 8～200 字；帳號總數上限 200 個。
  - 停用、啟用、重設密碼、**改角色**都會讓**該帳號**既有的登入立刻失效（`sessionVersion` 加一；停用後再啟用也不會讓舊 cookie 復活；改角色後對方要重新登入才拿到新的權限）；刪除帳號則是帳號不存在了。其他帳號的登入不受影響。管理員重設**自己**的密碼時，自己所有的登入同樣失效，但回應會帶新的 cookie，目前這個瀏覽器繼續登入、其他裝置要重新登入；重設別人的密碼不會動操作者的 cookie。
  - 重設密碼（對自己或別人）都只要新密碼（8～200 字），不需要「目前的密碼」。兩個分頁同時重設**自己**的密碼時，只有先到的那個成功，後到的因為 `sessionVersion` 已變而 401，不會把先設的蓋掉；另一位管理員在你重設自己的密碼的同時也重設了你的密碼時，兩邊都可能成功，**最後寫入的密碼有效**，而且你剛換到的 cookie 會立刻失效（`sessionVersion` 又被加了一次），要用最後設定的密碼重新登入；同時重設**同一位別人**的密碼也是後到的覆蓋先到的（兩個都成功，最後設的有效）。
  - 所有規則都在寫檔的鎖內重新檢查，包括「發出請求的人現在還是啟用中的管理員」：兩位管理員同時互相停用、互相降級（或刪除）對方，只有先到的那個成功，不會變成沒有任何管理員能登入；被停用或降級的人不能再改設定。
- **審計 log**：每個帳號操作留一行 `[accounts] <操作者 email> <動作> <對象 email>（來源 <IP>）`，例如 `[accounts] a@example.com 新增帳號 b@example.com（角色 user）（來源 203.0.113.9）`、`[accounts] a@example.com 修改帳號 b@example.com（角色 user → admin）（來源 …）`、`[accounts] a@example.com 重設密碼 b@example.com（來源 …）`、`[accounts] a@example.com 重設密碼（自己） a@example.com（來源 …）`；登入成功與失敗記 Email 與來源 IP（Email 格式不對的失敗登入只記固定佔位字串）。**絕不記密碼。**

#### 忘記所有密碼時的復原方式（要改 Volume 裡的設定檔，有風險）

只有在**所有管理員都登不進去**時才用這個方法；只要還有任何一位管理員能登入，請他在「帳號管理」幫你重設密碼就好。做法是把設定檔裡的帳號清空，讓「第一次使用」的設定碼流程重新出現（建立的第一位一定是管理員）。**`line`（LINE 設定）、`lineCaptured`、`sessionSecret` 不動**，所以關箱通知與 webhook 不受影響。

1. **備份**（在能存取 Volume 的地方：Zeabur 這個服務的終端機；自管 Docker 用 `docker exec`，或掛同一個 Volume 的暫時容器）：

   ```
   cp /app/data/settings.json /app/data/settings.json.bak-$(date +%Y%m%d)
   ```

   備份檔裡有明文的 LINE token，用完請刪掉。
2. **清空帳號**（Node 內建，容器裡就有；只把帳號清成空陣列——版本 3 的檔案是 `accounts`、舊版本 1／2 的檔案叫 `admins`——並刪掉舊版殘留的 `admin`，其他欄位原樣寫回；原地改寫，檔案的擁有者與 `0600` 權限不變）：

   ```
   node -e "const fs=require('fs');const p='/app/data/settings.json';const d=JSON.parse(fs.readFileSync(p,'utf8'));if(d.version===3)d.accounts=[];else d.admins=[];delete d.admin;fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n')"
   ```

   不想用指令、要手動編輯也可以：把 `"accounts"`（舊檔是 `"admins"`）改成 `[]`（或整個刪掉，缺少等於空）、刪掉 `"admin"`，其他都不要動。
3. **立刻重啟服務**（Zeabur Dashboard 重啟；自管 Docker `docker restart <容器>`）。服務把整份設定放在記憶體、每次變更都整份寫回，**服務在跑的時候改檔，下一次寫入（例如有人登入更新「最後登入」、LINE webhook 剛好記錄了一個群組）就會把你的修改蓋回去**。能先停服務再改檔最好（自管 Docker：`docker stop` → 用同一個 Volume 的暫時容器跑上面那行 → `docker start`）；Zeabur 的終端機要服務在跑才進得去，所以請「改完馬上重啟」，並確認下一步的 log 有出現——沒出現就是被蓋回去了，重做一次。
4. 重啟後 log 會出現新的設定碼（見上面「全新安裝」）。用設定碼建立新的第一位管理員；之後再在「帳號管理」建立其他人。
5. **風險**：
   - 這會**刪除所有帳號**（姓名、Email、密碼、角色都沒了），要重新建立每一位，大家的登入都會失效。
   - 在建立新的第一位管理員之前，任何能看到服務記錄的人都能用設定碼建立管理員（和第一次安裝一樣），請在重啟後立刻完成。
   - 手動編輯時 JSON 寫錯（多一個逗號、少一個括號）會讓檔案被當成損毀：服務啟動時自動備份成 `settings.json.corrupt-<時間>` 並以空設定重新開始，**LINE 設定也會因此消失**（要從備份搬回）。用上面的指令改就不會有這個問題；手動改完可以用 `node -e "JSON.parse(require('fs').readFileSync('/app/data/settings.json','utf8'))"` 確認是合法的 JSON。
   - 檔案要維持 `0600`、擁有者是 `appuser`：上面的指令是原地改寫，不會變；用別的方式整個換檔的話，入口腳本在容器啟動時會把擁有者修回去、程式開啟時會把權限收緊成 `0600`。

### 設定 LINE 通知與取得群組 ID

登入後在「LINE 群組通知」：

1. 填 **Channel access token** 與 **Channel secret**（取得方式見下面「LINE 群組通知 → 設定」），按「儲存」。token 與 secret 儲存後不會再顯示（只顯示「已設定（尾碼 …xxxx）」）；**留空表示不變**；要清掉就勾「清除」。
2. 複製頁面上的 **Webhook 網址**（`https://<目前網域>/api/line/webhook`），到 LINE Developers 的 Messaging API 分頁貼上、按「Verify」、開啟「Use webhook」。
3. 把 bot **加進目標群組**（或在已有 bot 的群組裡輸入「群組ID」）。回到設定頁，群組會出現在「**最近收到的群組**」（群組 ID、名稱、時間、事件類型），按「使用此群組」帶入群組 ID，再按「儲存」。儲存時會用 token 向 LINE 查群組名稱（「群組名稱」欄位唯讀；查不到就空白）。
4. 按「**發送測試訊息**」：會推播「🔔 savepoint-crate 測試通知 <台北時間>」到**已儲存**的群組，成功或失敗原因（固定短句）都會顯示在頁面上。
5. 「啟用關箱通知」開關預設是開的。**關掉開關只停止關箱通知**（立刻生效），webhook 只要有 Channel secret 就照常運作。

### 設定頁與環境變數的關係

- **設定頁優先、環境變數備援**：設定檔裡有 Channel access token 時，**整組**（token、secret、群組 ID、開關）都用設定頁的，環境變數 `LINE_*` 完全不參與（不會各取一半）；設定檔沒有 token 時，整組用環境變數。清除設定頁的 token 就會退回環境變數。
- `/healthz` 的 `lineSource` 告訴你目前生效的是哪一組（`"settings"`／`"env"`／`null`），設定頁的狀態列也會顯示。
- 每個請求都重新解析，所以在設定頁存檔後**立刻生效**；以前用環境變數設好的部署不必做任何事，照常運作。

### 資料檔（settings.json）

- 位置 `DATA_DIR/settings.json`，檔案權限 `0600`。內容：帳號（`accounts`：`id`、姓名、Email、**角色**、scrypt 密碼雜湊、`status`、`sessionVersion`、建立／更新／最後登入時間）、session 簽章金鑰（`sessionSecret`）、LINE 設定（**token 與 secret 是明文**，只靠檔案權限與 Volume 隔離保護）、最近收到的群組。**絕不進版控**（`.gitignore` 與 `.dockerignore` 都排除 `data/`）。
- **格式版本**：版本 1＝最舊的版本（只有一個管理密碼 `admin`）；版本 2＝管理員帳號（`admins`，沒有角色欄位，上一版）；**版本 3＝帳號含角色（`accounts`，目前的版本）**。載入時三種都收；版本 1、2 **只在記憶體轉換**（版本 2 的 `admins` 全部視為角色 admin），**所有欄位（含不認識的，頂層、各帳號、`line`、`lineCaptured` 每一筆都是）原樣保留、寫回去**。只要還沒有帳號，檔案就維持載入時的版本（舊檔維持版本 1／2，所以升級前回滾到上一版仍讀得懂）；**有了帳號之後的第一次寫入（例如有人登入更新「最後登入」）才把檔案升成版本 3**，同時刪掉舊的 `admin` 欄位、把 `admins` 改名 `accounts`、每位加上 `role`。全新安裝直接是版本 3。
- **回滾須知**：版本 3 的檔案，上一版（`f7529dd`）和更早的版本都不認得，會把它當成損毀：備份成 `settings.json.corrupt-<時間>`、以空設定重新開始（LINE 設定與帳號在備份檔裡，要手動搬回）。所以**全站登入上線、有人登入過之後就不要回滾到舊版**；一定要回滾的話，先備份 `settings.json`，回滾後把備份裡的 `line`／`lineCaptured`／`sessionSecret` 搬回，並重新建立管理員（舊版只有「管理員」，沒有角色）。
- 每次變更都「先寫暫存檔、`fsync`、再 `rename` 蓋過正式檔」（原子替換），寫入成功才更新記憶體；同時進來的變更依序執行。
- 檔案損毀（不是合法 JSON、版本不認得、欄位型別錯誤、帳號資料不合法、角色不是 admin／user、id／Email 重複）：啟動時備份成 `settings.json.corrupt-<UTC 時間>`（權限 0600）、log 一行說明、以空設定重新開始，**不會把損毀內容直接蓋掉**；需要重新用設定碼建立第一位管理員、重填 LINE 設定。
- 讀不到（不是「不存在」而是權限或 I/O 錯誤）時，不動檔案、整個網站停用（503）。
- 開啟時還會：把既有 `settings.json` 的權限收緊成 `0600`、清掉超過 10 分鐘沒動過的殘留暫存檔（被強制結束的寫入留下的 `.settings.json.*.tmp`、`.write-probe-*`）、容忍檔案開頭的 BOM；新建的資料目錄是 `0700`。
- **單一實例假設**：整份設定由記憶體重寫、沒有檔案鎖，所以服務只能有一個執行個體使用同一個 Volume（Zeabur 的 Volume 本來就只能掛給單一實例）。滾動部署時新舊容器會短暫重疊，重疊的那幾分鐘請不要在設定頁做變更（後寫的會蓋掉先寫的）。

## LINE 群組通知

使用者關箱、逐筆同步到商品主檔之後，後端會把「箱號、幾種商品幾件、同步結果、明細」推播到指定的 LINE 群組（LINE Messaging API push）。**LINE 沒設定時整個功能靜默略過，絕不影響關箱與存檔**；通知失敗也只會在頁面上提示一下，箱子照樣關。

訊息長這樣（純文字、台北時間）：

```
📦 箱號 BOX-001 已完成
共 12 種商品、35 件
操作：王小明
已同步 12/12 筆到商品主檔 ✓
明細：
1801080204 第五代溫灸刷毛圓領發熱衣(女-經典黑L) ×3
…
時間：2026-10-05 15:20
```

- 「**操作：<姓名>**」是關這個箱子的人（登入帳號的姓名）：由後端依登入的 session 填入，**前端送來的任何 operator 欄位都忽略**；姓名裡的換行與控制字元會被壓成一個空白。
- 部分失敗時，第 4 行改成 `⚠️ 同步 10/12 筆，2 筆失敗，請查核商品主檔`。
- 「N 種」是商品筆數、「M 件」是數量加總；明細的品名格式與寫進商品主檔的「合併品名」相同（`品名(性別-顏色尺寸)`）。
- 明細最多 30 行，超過寫 `…另有 k 種`；整則訊息不超過 4500 字（LINE 的上限是 5000），太長時會先砍明細行數。
- 「時間」用前端送來的關箱時間（`closedAt`，瀏覽器時間）；沒有就用伺服器時間，一律轉成台北時間。

### 設定

**建議用設定頁**（見上面「設定頁與 Volume」）：以管理員登入 `/settings` 填 token、secret，從「最近收到的群組」帶入群組 ID，存檔立刻生效，不必動環境變數。環境變數是備援（設定頁沒有 token 時才用）：

| 變數 | 用途 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 推播（與 webhook 回覆）用的 channel access token |
| `LINE_GROUP_ID` | 目標群組 ID（`C` 開頭） |
| `LINE_CHANNEL_SECRET` | 只給 webhook 驗簽用，取得群組 ID 時才需要（選填） |

用環境變數設定時**要重新部署（或至少重啟服務）才會生效**——改環境變數後容器不會自動重啟。之後用 `curl -s https://<網域>/healthz` 確認 `lineConfigured`（token 與群組 ID 都有）、`lineWebhookConfigured`（有 secret）與 `lineSource`。

**到哪裡取得 token 與 secret**：到 [LINE Developers](https://developers.line.biz/)，進入你的 Provider 與 Messaging API channel（沒有的話先建立一個，或沿用其他系統已在使用的官方帳號）：

- **Channel access token**：channel 的「Messaging API」分頁，Channel access token（long-lived）按「Issue」發行。
- **Channel secret**：channel 的「Basic settings」分頁。
- 要讓 bot 能被加進群組：在「Messaging API」分頁開啟「Allow bot to join group chats」（會連到 LINE Official Account Manager 的回應設定；實際選項名稱以 LINE 介面為準）。

### 取得群組 ID（三種方式）

**方式一（建議）：設定頁的「最近收到的群組」**

1. 在設定頁填好 Channel secret 與 Channel access token（token 讓 bot 能回覆，也用來查群組名稱），儲存。
2. 把設定頁顯示的 **Webhook 網址**（本服務目前的 Zeabur 網域是 `https://savepoint-crate.zeabur.app/api/line/webhook`；頁面會顯示你實際使用的網域）貼到 LINE Developers 的「Messaging API」分頁 →「Webhook URL」，按「Verify」（應該回成功），開啟「Use webhook」。
3. 把官方帳號（bot）**加進目標群組**：bot 會回覆「已加入，此群組 ID：C…。請到設定頁（/settings）選用這個群組，或把它設定到 LINE_GROUP_ID。」；或在已有 bot 的群組裡輸入「**群組ID**」（或「群組 ID」），bot 會回覆「此群組 ID：C…」。
4. 回設定頁重新整理，群組出現在「最近收到的群組」，按「使用此群組」→「儲存」。

**方式二：看 log（bot 沒有回覆時）**：到服務的 runtime log 找 `[line] 事件 … 來自 group C…` 這一行，群組 ID 就在裡面（例如還沒有設定 token、bot 無法回覆時）。

**方式三：沿用已知的群組 ID**：如果這個服務使用的官方帳號（channel）已經在目標群組裡，而你從其他系統已經知道該群組的 ID（`C` 開頭），直接填進設定頁（或環境變數 `LINE_GROUP_ID`）就好，不必走 webhook。注意 bot 必須在該群組裡，否則推播會被 LINE 拒絕（400／403）。

取得之後可以把 webhook 關掉（Use webhook 關閉）；留著也沒關係，它只處理群組來源的 `join` 與訊息事件、不儲存訊息內容。

### 行為與限制

- **前端流程**：關箱確認後，頁面先逐筆同步到商品主檔，然後呼叫 `POST /api/box-closed`（**不等回應**，所以 LINE 再慢也不會拖住關箱），最後才鎖箱。同步結果不論全成功或部分失敗、甚至同步過程丟了例外，都會通知（例外時成功筆數算 0）；**空箱子（沒有任何商品）不通知**。超過後端驗證上限的值（數量 9999、文字欄位 200 字、500 筆）會先在前端截斷，免得整則通知被 400 擋掉。
- **失敗的提示**：回應 `notified: false` 且 `reason: "push_failed"` 時，頁面跳「LINE 通知失敗（不影響關箱）」；`not_configured`（LINE 沒設定）不提示；網路錯誤只在瀏覽器 console 留下紀錄。
- **推播 10 秒逾時、不重試**（避免重複通知），所以 LINE 暫時失敗就會漏掉這一則——這是「通知」，不保證送達。失敗原因會寫進服務的 log（只有狀態碼與 LINE 回應的簡短說明，**不含 token**）；回給前端的 `error` 是固定的簡短句子，不轉發 LINE 的原始回應。
- **額度**：每則推播都計入 LINE 官方帳號的每月訊息額度（依你的方案而定）。
- **`/api/box-closed` 要登入**（任一角色，並帶 `X-Requested-With`）：只有登入的人能讓 bot 在群組裡發出訊息；訊息內容仍由呼叫端決定（但「操作：」那一行一定是登入者的姓名），另有每 IP 每分鐘 60 次的限流與欄位長度上限。若某個帳號被濫用：管理員在「帳號管理」停用它（立刻生效，審計 log 看得到是誰、哪個 IP）；要整個停掉：在設定頁關掉「啟用關箱通知」（立刻生效），或清空群組 ID／token（環境變數版要重新部署），必要時到 LINE Developers 重新發行 token 讓舊的失效。
- **重複通知**：前端沒有「同步中」的鎖定，同一個箱子若連按兩次「確認」，會重複寫入試算表，也會重複通知（見下面「安全與限制」）。
- **webhook 安全**：`/api/line/webhook` 用 channel secret 驗證每個請求真的來自 LINE（對**原始 body 位元組**做 HMAC-SHA256、base64 後以 `timingSafeEqual` 比對 `X-Line-Signature`），不符回 401；它只處理群組來源的 `join` 與訊息事件：`join` 與「群組ID」文字會回覆群組 ID，並把群組（ID、名稱、事件類型、時間）記進「最近收到的群組」；**不儲存任何訊息內容**。

## 品牌配色與靜態資源（WIWI）

所有頁面（主頁 `index.html`、登入頁、設定頁、我的帳號、403／503 頁…）都用 WIWI 品牌配色。配色與 Logo 的正本是 skill `wiwi-web-colors`（`~/.claude/skills/wiwi-web-colors/`；色票取自 wiwi.com.tw 官網 CSS 與原廠 Logo，內建的 124 組搭配全數通過 WCAG 2.1 AA）。

- **檔案**：`public/assets/` 放三個從 skill 原樣複製來的檔案——`wiwi-colors.css`（語意 token）、`wiwi-logo.svg`（淺底用的全標）、`wiwi-logo-white.svg`（深底用）。**不手改、不手抄色碼**：`tests/branding.test.ts` 用 sha256 釘住它們（與 skill 原檔 byte-identical）。
- **提供方式**（`src/assets.ts`）：`GET /assets/<檔名>`，不需要登入（登入頁就要用）。啟動時把 `public/assets/` 第一層的檔案一次讀進記憶體，請求只用「檔名」查表，**碰不到檔案系統，所以不可能路徑穿越**（`..`、百分比編碼的 `..`、編碼的斜線與反斜線、空字元、雙重編碼、大小寫變體都只是「表裡沒有這個名字」→ 404）；只收一般檔案（不進子目錄、不跟符號連結、不收隱藏檔、檔名限英數與 `._-`），副檔名要在白名單內（css、svg、png、jpg／jpeg、webp、gif、ico、woff、woff2），每個檔案最大 2 MB。缺少 `wiwi-colors.css` 或 `wiwi-logo.svg` 時**服務啟動直接失敗**（結束碼 1、log 指出缺什麼與預期位置；比照 `index.html`——部署時新版起不來，Zeabur 會繼續用舊版，比上線一個沒有樣式的網站好）。`server.ts` 從 `dist/` 的上一層找 `public/`（與 `index.html` 同一個方式），Dockerfile 的 runtime 階段 `COPY public ./public`。
- **頁面怎麼用**：`<html lang="zh-Hant" data-thermal="warm">`（整站溫感橘，官網預設，不混極）、`<link rel="stylesheet" href="/assets/wiwi-colors.css">` 放在頁面自己的 `<style>` 之前。頁面自己的 CSS **只寫語意 token**（`--wiwi-text`、`--wiwi-thermal-solid`、`--wiwi-border-strong`…），不寫色碼、不寫 `rgb()`；要半透明（玻璃擬態、陰影）就用 `color-mix()` 從 token 調（瀏覽器不支援時退回不透明的 token，`@supports` 包起來）。舊的變數名稱（`--primary`、`--text`、`--bg`…）保留，但全部改成指向 token（JS 產生的 HTML 裡有 `var(--primary-dark)` 這類用法）。設定頁系列的 CSP：`style-src 'self' 'unsafe-inline'`（同源的配色檔 ＋ 頁面自己的 inline 樣式）、`img-src 'self' data:`（同源的 Logo）；`index.html` 沒有 CSP 標頭。
- **配色鐵律**（skill 的五個坑；`tests/branding.test.ts` 會擋）：
  1. 橘 `#F2971B` 與藍綠 `#44BCCE` 只能當底色與圖形，**不能當字，也不能壓白字**（只有 2.28:1）——橘底上的字用 `--wiwi-thermal-on-fill`（`#333333`，5.55:1）。
  2. 白底上的品牌文字可以用 `--wiwi-thermal-text`（`#CD4400`，4.75:1）；**非純白底（淡底、灰底、半透明卡片）一律用加深版 `--wiwi-thermal-text-strong`（`#A83800`）**——差 0.07 的坑，目視看不出來。這些頁面的底大多不是純白，所以頁面 CSS 一律用 `--wiwi-thermal-text-strong`，測試的允許清單不放白底專用的 `--wiwi-thermal-text`。
  3. `#8A8A8A`（`--wiwi-text-subtle`）不當內文；次要文字用 `--wiwi-text-muted`（`#626262`，6.10:1），placeholder 也是。
  4. 輸入框、按鈕、分頁等互動控制項的邊框用 `--wiwi-border-strong`（>= 3:1）；`--wiwi-border`（淺灰）只給卡片與分隔線這類裝飾。選取狀態的橘底再加一圈深橘邊（橘單獨對白底只有 2.2:1）。
  5. 主要按鈕 = `--wiwi-thermal-solid` 底 + `--wiwi-thermal-on-solid`（白字）；品牌淡底卡片 = `--wiwi-thermal-tint` + `--wiwi-text`；狀態色（成功、警告、危險）只用「狀態色字 + 各自的 `-tint` 底」。
  用量比例約為：中性 70%／品牌淡底 20%／品牌原色 7%／深色 solid 3%——品牌色只出現在該被看見的地方（header 底線、選取中的分頁、主要按鈕、banner 淡底）。
- **Logo**：主頁 header 標題左側、每個設定頁系列頁面（登入、設定、我的帳號、403／503…）的頂端（登入頁置中）。`<img>` 高度 48px（不低於 48px，字標才不會糊）；header 是淺色底（Logo 的橘與藍綠要在淺底上才看得見）。
- **改過配色或樣式之後**：跑 `python3 ~/.claude/skills/wiwi-web-colors/scripts/audit.py public/assets/wiwi-colors.css`（離開碼 0＝124 組全過；沒改色碼就不必跑）與 `pnpm test`（branding 測試守規則）。要更新 skill 的新版檔案：重新複製三個檔案（`cmp` 確認 byte-identical）、跑 audit.py、再更新 `tests/branding.test.ts` 裡的 sha256。

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

本機開發時資料目錄預設是 `./data`（不存在會自動建立；已在 `.gitignore`）：開 `http://localhost:8080/settings`，用啟動 log 裡的設定碼建立第一位管理員（姓名、Email、密碼），之後開 `http://localhost:8080/` 會先要求登入。測試用的 `DATA_DIR` 一律是暫存目錄，不會碰到你的 `./data`。

只跑單一測試檔或單一案例：`pnpm exec vitest run tests/ocr.test.ts -t "男女共版"`。

用假金鑰快速確認服務起得來：

```bash
PORT=8099 OPENAI_API_KEY=x GOOGLE_SERVICE_ACCOUNT_CREDENTIALS=x node dist/server.js
curl -s localhost:8099/healthz
curl -s -X POST localhost:8099/api/ocr -H 'content-type: application/json' -d '{}'   # 503 或 401：全站要登入（沒有資料目錄時 503「請在 Zeabur 掛載 Volume」，有資料目錄但沒登入時 401「請先登入」）
```

## 部署（Docker／Zeabur）

用專案根目錄的 `Dockerfile` 建置（兩階段：build 階段編譯 TypeScript，runtime 階段只裝 production 依賴並複製 `index.html` 與 `public/`（WIWI 配色與 Logo）），容器的入口腳本（`scripts/docker-entrypoint.sh`）以 root 啟動、把資料目錄 `/app/data` 修成 `appuser` 擁有後用 `su-exec` 降權，所以實際執行 `node dist/server.js` 的行程**不是 root**（映像裡沒有 `USER` 指令，是入口腳本自己降權）。

- **埠號**：Zeabur 反向代理固定打容器 8080 並注入 `PORT=8080`，程式讀 `process.env.PORT`，不要在 `CMD` 寫死埠號。
- **NODE_ENV**：Zeabur 會把 `NODE_ENV=production` 注入 build 階段，pnpm 會因此跳過 devDependencies 導致建置失敗；Dockerfile 的 build 階段已明確設 `ENV NODE_ENV=development` 並用 `--prod=false`，不要拿掉。
- **pnpm 版本**：`package.json` 的 `packageManager`、Dockerfile 的 `corepack prepare pnpm@…`、產生 `pnpm-lock.yaml` 的 pnpm 三者必須同版（目前 9.15.9），否則 `--frozen-lockfile` 會失敗。
- 在服務的環境變數頁設定上表的變數（至少 `OPENAI_API_KEY`、`GOOGLE_SERVICE_ACCOUNT_CREDENTIALS`）。**改環境變數後容器不會自動重啟**：請重啟服務，並用 `GET /healthz` 確認 `openaiConfigured`、`sheetsConfigured` 都變成 `true`；若仍是 `false`（重啟沒有帶到新增的變數），改為重新部署。
- **重啟與重新部署**：收到 SIGTERM／SIGINT 後，服務停止接受新連線，並最多等 25 秒（`src/server.ts` 的 `SHUTDOWN_GRACE_MS`，比 Kubernetes 預設的 30 秒終止寬限期短）讓處理中與排隊中的存檔寫完；超過的會被中斷。有人正在關大箱子時請避免重啟或部署。
- **Volume（必要）**：帳號與設定都存在 `/app/data`，要把 Volume 掛上去（Zeabur Dashboard → 服務 → 硬碟；詳見「設定頁與 Volume」）。**沒有可寫的資料目錄時整個網站（登入、主頁的 OCR／存檔／關箱通知）都是 503**；資料目錄只是容器暫存層（沒掛 Volume）時能用，但每次重新部署帳號都會消失（`/healthz` 的 `dataDirMounted` 會是 `false`，log 也有警告）。
- 本機驗證映像：`docker build -t savepoint-crate:local .`，再 `docker run --rm -p 8080:8080 -v "$(mktemp -d):/app/data" -e OPENAI_API_KEY=x -e GOOGLE_SERVICE_ACCOUNT_CREDENTIALS=x savepoint-crate:local`（`-v` 那段模擬 Volume）。
- 部署後檢查：
  1. runtime log 出現 `savepoint-crate listening on port 8080`。
  2. `curl -s https://<網域>/healthz`：`openaiConfigured`、`sheetsConfigured` 皆為 `true`，並把 `serviceAccountEmail` 加為試算表編輯者。
  3. **確認反向代理的 IP 處理**：同一個 `/healthz` 回應的 `clientIp` 應該是你自己的對外 IP（可與「我的 IP」網站比對）。如果看到 `10.x`、`172.16–31.x`、`192.168.x`、`100.64–127.x` 這類內部位址或 `"unknown"`，或不同人 curl 得到同一個值，代表 `X-Forwarded-For` 沒有被正確取得，**所有使用者會共用同一個限流額度**，需要先處理再上線。
  4. **偽造測試**：`curl -s -H 'X-Forwarded-For: 203.0.113.99' https://<網域>/healthz` 回的 `clientIp` **不得**是 `203.0.113.99`（應該仍是你自己的對外 IP）。若回的是偽造值，代表代理沒有把真實 IP 附加在 `X-Forwarded-For` 最右邊，限流可以被客戶端自填的標頭繞過，需要先處理。
  5. **LINE 通知（選配）**：照上面「設定頁與 Volume」（或「LINE 群組通知」的環境變數備援）設定後，`/healthz` 的 `lineConfigured` 應為 `true`、`lineSource` 顯示來自 `settings` 還是 `env`；關一個測試箱子，群組應收到一則通知。沒設定 LINE 時什麼都不會發生（也不會有錯誤）。
  6. **帳號與 Volume**：`/healthz` 的 `dataDirWritable` 與 `dataDirMounted` 都是 `true`（見「設定頁與 Volume」的對照表）；`requestIsHttps` 是 `true`（代理有送 `X-Forwarded-Proto: https`，登入 cookie 才會加 `Secure`；是 `false` 的話登入頁與設定頁頂端會顯示警告）。**部署後所有人都要登入，管理員先建帳號**：全新安裝：到 Zeabur 記錄找設定碼、開 `/settings` 建立第一位管理員（越早越好）；從舊版單一密碼升級：`/healthz` 先顯示 `legacyAdminPending: true`，開 `/settings` 用目前的密碼升級成管理員帳號（見「設定頁與 Volume → 從舊版的單一管理密碼升級」），之後 `legacyAdminPending` 變 `false`、`adminCount` 為 1；已經有管理員帳號的版本 2 檔案：照原本的 Email 與密碼登入即可。接著到「帳號管理」替每位同事建立帳號並通知大家。**登入的暴力破解防護（逐 IP 限流）依賴上面第 3、4 項的 `clientIp` 判斷是正確的**，請務必先做。
  7. 最後用一個**一般使用者**的帳號登入主頁（確認頂端有「👤 姓名（一般使用者）」且進 `/settings` 是 403）、實際拍一張標籤、關一個箱子，確認有寫進試算表，LINE 群組收到的通知有「操作：<姓名>」。

## 回滾

依影響範圍由小到大：

1. **平台層**：在 Zeabur 把服務回到前一個成功的部署（舊的純靜態頁，仍打 n8n webhook）。
2. **只退回設定頁**（保留關箱 LINE 通知）：用「環境變數版 LINE 通知」的最後一個 commit `29d8046` 重新部署。那個版本沒有設定頁與 Volume，LINE 設定只認環境變數 `LINE_*`（所以環境變數備援要保留到確定不再回頭為止）；`/app/data` 裡的 `settings.json` 只是不再被讀取，不需要處理。
   - **退回「單一管理密碼」的上一版**（`b54b21b`）：**只有在還沒升級成帳號之前**才安全（檔案仍是版本 1，舊版讀得懂、舊密碼照常能登入）。升級之後檔案是版本 3，舊版不認識，會把它當損毀、備份成 `settings.json.corrupt-<時間>` 後以空設定重新開始（見「設定頁與 Volume → 從舊版的單一管理密碼升級」第 6 點）。
   - **退回「管理員帳號、沒有全站登入」的上一版**（`f7529dd`）：**只有在新版還沒寫過檔之前**才安全（檔案仍是版本 2 或 1，上一版讀得懂）。只要新版寫過一次檔（有人登入更新「最後登入」、LINE webhook 記錄新群組、任何設定變更）、檔案就已經是版本 3，上一版不認識，會把檔案當成損毀、備份後以空設定重新開始（LINE 設定與帳號在備份檔裡，要手動搬回；見「設定頁與 Volume → 資料檔」的回滾須知）。上一版的 OCR／存檔／關箱通知不需要登入，退回去就不再有操作者姓名。
3. **程式碼層**：`git revert` 改版相關的所有 commit（把 `index.html` 與整個後端一起退回純靜態頁），或直接用改版前的最後一個 commit `db5c061`（純靜態頁）重新部署。
4. **只退回 n8n 後端**：把 `index.html` 裡兩個常數改回
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

- **全站要登入**（見「設定頁與 Volume」）：主頁、`/api/ocr`、`/api/save`、`/api/box-closed` 都要有效的登入 session（任一角色），並帶 `X-Requested-With: XMLHttpRequest`（CSRF 防護）；沒登入的請求在限流**之前**就被 401 擋下，不會吃掉同一個出口 IP 上其他人的限流額度（其他沒登入的 `/api/*` 請求——`/api/me`、設定與帳號 API 的探測、不存在的路徑——算在另一組匿名額度，同樣不會擠壓已登入的人）。仍然公開的只有 `/healthz`（不含任何金鑰與設定值）、`/api/line/webhook`（靠簽章驗證）與登入頁。已做的防護：登入、每 IP 每分鐘限流（OCR 60 次、存檔 600 次、關箱通知 60 次、LINE webhook 120 次、設定／帳號／目前登入者 API 60 次，各自計算；記憶體內，服務重啟即重置；IP 取 `X-Forwarded-For` 由右往左第一個公開位址）、15 MB body 上限、存檔欄位驗證與公式字元處理、錯誤訊息不帶金鑰。登入帳號是「同事」層級的存取控制，不是細緻的權限系統：任何一位登入的人都能呼叫這三支 API（內容由呼叫端決定）。
- **登入與設定頁的安全設計**（細節見「設定頁與 Volume」）：
  - 密碼用 scrypt（N=16384、r=8、p=1、16 位元組隨機 salt）雜湊，格式 `scrypt$N$r$p$salt$hash`，以 `timingSafeEqual` 比對；8～200 個字元。每個帳號各有自己的雜湊。
  - 登入後發 `sp_session` cookie：值是 `<到期時間>.<帳號 id>.<sessionVersion>.<亂數>.<HMAC-SHA256 簽章>`（金鑰是設定檔裡隨機產生的 `sessionSecret`，平常不會換），`HttpOnly`、`SameSite=Lax`、`Path=/`、7 天，走 HTTPS（`X-Forwarded-Proto: https`）時加 `Secure`。驗證時除了簽章與到期，還要對照目前的帳號資料：帳號必須存在、啟用中、`sessionVersion` 相符（角色是每次請求從目前的帳號資料讀的，不簽在 cookie 裡）。**登出只清除這個瀏覽器的 cookie**（伺服器不存 session）；要讓某個帳號所有裝置立刻失效，用重設密碼、停用或改角色（`sessionVersion` 加一）。
  - 登入時間不洩漏帳號：查無帳號、帳號停用、Email 格式不對都拿固定的假雜湊（`DUMMY_PASSWORD_HASH`，參數與正式雜湊相同）跑一次 scrypt，一律回同一句「帳號或密碼不正確」。
  - 所有狀態變更的端點只收 `Content-Type: application/json` 且必須帶 `X-Requested-With: XMLHttpRequest`（瀏覽器的跨站表單送不出這種請求），再加上 `SameSite=Lax`，作為 CSRF 防護。
  - 暴力破解防護：建立第一位管理員 5 次／分、登入與升級共用 10 次／分（皆每 IP，IP 的判斷見上面第 3、4 項部署檢查；換 Email 重試也不會多出額度）；設定碼累計 20 次錯誤就整組作廢換新。scrypt 同時最多跑 2 個、排隊 16 個（超過回 429），所以公開端點被灌請求也不會把 libuv 執行緒池占滿、拖慢 OCR 與存檔。**沒有「帳號鎖定」或全域失敗額度**（避免被人故意鎖死管理者），所以請用夠長、不好猜的密碼。改成 Email 登入之後，針對已知 Email 猜密碼是主要風險，而限流只依來源 IP：服務一定要走有附加 `X-Forwarded-For` 的反向代理（Zeabur 的代理會做），如果直接把服務暴露在公網，攻擊者可以偽造這個標頭來繞過逐 IP 限流（見「部署」的檢查 3、4）。登入成功／失敗、設定碼錯誤、升級失敗與每個帳號操作（含重設密碼）都會在 log 留一行（`[accounts] <操作者> <動作> <對象>（來源 IP）`，不含任何密碼；被限流擋下的請求不再寫 log）。
  - 所有狀態變更的登入、設定與帳號端點統一用 `mutate()` 註冊（資料目錄可用 → `application/json` → `X-Requested-With`），並帶 `X-Content-Type-Options: nosniff` 與 `Cache-Control: no-store`；測試會走訪 `app.routes` 確認沒有漏掉的端點。
  - 登入頁、帳號頁與設定頁 HTML 帶 CSP（`default-src 'none'`，script 只允許帶每次請求隨機 nonce 的那一段，`style-src 'self' 'unsafe-inline'`（同源的 WIWI 配色檔＋頁面自己的 inline 樣式），`img-src 'self' data:`（同源的 Logo），`form-action 'none'`，`frame-ancestors 'none'`）、`X-Frame-Options: DENY`、`Cache-Control: no-store`、`noindex`；所有動態內容（姓名、Email、`next`、群組名稱、網址…）都經過 HTML 跳脫。
  - token 與 secret **明文**存在 Volume 的 `settings.json`（`0600`），讀取 API 與頁面只給「已設定」與末 4 碼、永遠不回傳完整內容，log 也不印。能進服務終端機或讀 Volume 的人就能讀到它——與環境變數的暴露面相同。
  - 設定碼會寫進服務 log：在建立第一位管理員之前，能看到 log 的人都能建立管理員，所以請在第一次部署後立刻建立。
  - 已知限制：登入 session 是無狀態的 cookie，**登出只清瀏覽器端**（偷到的 cookie 7 天內仍有效，要作廢請重設該帳號的密碼或停用它）；密碼只檢查長度（8～200 字元），不檢查強度；角色只有兩種（管理員與一般使用者）、沒有更細的權限；任何一位啟用中的管理員都能新增、停用、刪除其他帳號與改角色（但不能動自己、也不能讓系統沒有管理員）；`index.html` 是同源的另一個頁面，它的任何 XSS 都能借用已登入者的 cookie 呼叫 API（一般使用者的 cookie 呼叫不了設定與帳號 API）。
- **限流與寫入速度**：
  - **限流（每 IP 每分鐘）**：`/api/ocr` 60 次（`OCR_RATE_LIMIT_MAX`）、`/api/save` 600 次（`SAVE_RATE_LIMIT_MAX`）、`/api/box-closed` 60 次（`BOX_CLOSED_RATE_LIMIT_MAX`）、`/api/line/webhook` 120 次（`LINE_WEBHOOK_RATE_LIMIT_MAX`）、`/api/settings*`、`/api/accounts*` 與 `/api/me` 共用 60 次（`SETTINGS_API_RATE_LIMIT_MAX`），五個額度**各自獨立計算**——關箱時前端是逐筆、循序送出，不會被拍照的次數擠壓。其他 `/api/*` 路徑（含不存在的）算進 OCR 的額度。常數在 `src/app.ts`。同一個出口 IP（例如倉庫同一個網路）的人共用一份額度。
  - **寫入速度（滾動視窗配額）**：Google Sheets API 的寫入配額預設是每分鐘 60 次／使用者（服務帳號算一個使用者；每專案 300 次，超過回 429；來源：developers.google.com/workspace/sheets/api/limits，2026-10-05 查閱）。所以伺服器對 `values.append` 做**全域的滾動視窗配額**（整個程序共用、不分來源請求）：過去 **60 秒**內已起始的 append 少於 **55 次**（留 5 次餘裕）就**立刻送出、不等待**（視窗內可以同時有多筆在途）；達到 55 次時依先進先出排隊，等最舊的那次起始時間離開視窗才送。常數是 `src/sheets.ts` 的 `APPEND_WINDOW_MAX`（55）與 `APPEND_WINDOW_MS`（60 000），建構 `SheetsClient` 時可用 `appendWindowMax`、`appendWindowMs` 覆寫。規則細節：401 之後的重送算一次新的起始、同樣受視窗限制；換不到 token 的失敗發生在取得名額之前，不佔配額；已經送出但失敗的那次照樣佔配額；前一筆不論成功或失敗都不會卡住後面的；讀表頭不受影響。
  - **實務影響**：**55 件內全速、超過才放慢**。全速＝不人為等待，每筆只是一次 Google 往返；放慢＝第 56 件起要等視窗放出名額（最多約 60 秒），之後再全速送，整體平均約每分鐘 55 件——這是為了不撞到 Google 配額而失敗。「55 件」是**過去 60 秒內累計**的件數，所有箱子、所有人共用同一份配額：例如一分鐘內連續關兩個 30 件的箱子，第二個箱子做到約第 26 件就會停頓一陣子。
  - **⚠️ 前端沒有「同步中」的鎖定**：頁面的「正在同步到商品主檔…」提示約 2.5 秒就消失，確認對話框關閉後「完成此箱」鈕仍可按，直到全部寫完才會鎖箱。依裁定前端沒有加這個鎖定（`index.html` 只改了端點常數，外加關箱 LINE 通知的 `NotifyEngine` 與關箱流程裡的一次呼叫，以及全站登入的 `ApiClient` 與頂端使用者列）。所以請提醒現場：**按下確認後，等到出現「已同步 N 筆到商品主檔 ✓」再離開頁面或再按一次**——中途離開頁面，剩下的筆就不會送出；重複按會把同一箱再送一次（重複列）。超過 55 件的大箱子會在中途停頓一陣子（視前面花了多久而定，最多約 1 分鐘），更要等。
  - **等待與代理逾時**：視窗已滿時，單一請求最長要等約 60 秒（等最舊的起始離開視窗），剛好在一般反向代理 60 秒左右的逾時邊緣（排在後面的也不會等更久：每過一個視窗，最舊的那批起始會一起離開）；Zeabur 的實際逾時未確認。等得比代理逾時還久，前端會先看到失敗、伺服器之後卻還是寫入，使用者重送就變成重複列。部署後請用一個超過 55 件的箱子實測一次。
  - **排隊上限**：排隊等名額（視窗已滿、還沒送出）的 append 超過 `APPEND_MAX_PENDING`（50）筆時，新的請求直接回 503「目前等待寫入的筆數過多」；已經取得名額、正在送出的不算。這個上限是為了避免異常流量讓請求與連線越積越多，**不是**等待時間的上限：排隊的人最多等約一個視窗（60 秒），與排在第幾個無關。正常使用時前端是逐筆等回應才送下一筆，排隊的人數頂多等於同時關大箱子的人數。
  - **已知限制**：(1) 排隊上限是**全域**的，沒有每個 IP 各自的佇列額度——單一來源在一分鐘內送出約 51～105 個請求（視窗已被用滿時只要 51 個：50 個排隊再加 1 個；視窗全空時要先用掉 55 個名額再排滿 50 個，共約 105 個；每分鐘 600 次的存檔額度都允許），就能讓全站的存檔暫時回 503（約一分鐘）；單純每分鐘送滿 55 筆也能用光全站的視窗配額，讓別人的存檔排隊等待；(2) client 中途斷線時，已排進佇列的請求仍會寫入（與 n8n 版相同）；(3) 佇列在記憶體裡，服務重啟或重新部署時，還沒寫進試算表的排隊中存檔會遺失（見「部署」的優雅關閉說明）；(4) 視窗內可以同時有多筆 append 在途，同時送出的多筆在試算表裡的列順序不保證與送出順序相同（前端單一裝置逐筆送出時不受影響）。
- **不開 CORS**：頁面與 API 同源。
- **`/api/save` 的 `values.append` 不自動重試**：逾時或 5xx 時無法確定有沒有寫進去，重試可能造成重複列；失敗時前端會提示，請到試算表確認後再補送。唯一的例外是 401（授權過期、請求尚未執行）：換新 token 後重送一次，重送算一次新的起始、同樣受視窗配額限制。
- log 不記請求內容（圖片、商品資料）與任何金鑰；上游失敗只記狀態碼與錯誤類型／代碼（Google 讀表頭失敗時另記其簡短錯誤訊息，方便判斷是分頁名稱還是權限問題；append 失敗不記訊息，因為可能回顯欄位值）。

## 專案結構

```
index.html              原本的前端頁面（OCR／存檔兩個端點常數改成 /api/ocr、/api/save；另多了 NotifyEngine 與關箱流程裡的一次呼叫，用來通知 LINE；全站登入後多了 ApiClient（所有 /api 請求共用：帶 X-Requested-With、401 導向登入頁）與頂端使用者列 UserBar；WIWI 品牌配色：只寫語意 token、header 有 Logo）
public/assets/          WIWI 配色 token（wiwi-colors.css）與 Logo（wiwi-logo.svg、wiwi-logo-white.svg）：從 skill wiwi-web-colors 原樣複製，不手改；GET /assets/* 提供（見「品牌配色與靜態資源」）
src/server.ts           啟動入口（讀環境變數、index.html 與 public/assets、開啟資料目錄，監聽 0.0.0.0:PORT）
src/assets.ts           靜態資源：啟動時把 public/assets 讀進記憶體、GET /assets/* 只用檔名查表（不可能路徑穿越）、缺必要檔案就啟動失敗
src/app.ts              Hono app：主頁與三支 API 的登入閘門、路由、限流（OCR／存檔／關箱通知／LINE webhook／設定 API 各自額度）、body 上限、錯誤處理
src/ocr.ts              OCR：prompt、請求組裝、OpenAI 呼叫（timeout、重試）、回應解析
src/sheets.ts           存檔：欄位整理、合併品名、表頭對應、Sheets REST（讀表頭＋append）、append 滾動視窗配額
src/google-auth.ts      服務帳號 JWT（RS256）換 token、憑證解析（JSON／base64）
src/line.ts             關箱 LINE 通知：輸入驗證、訊息組字、push／reply、查群組名稱、webhook 驗簽與事件處理
src/line-settings.ts    生效的 LINE 設定（設定頁的設定檔優先、環境變數備援）、設定頁用的遮罩檢視、webhook 記錄最近收到的群組
src/settings-store.ts   設定檔儲存（DATA_DIR/settings.json）：載入、原子寫入（0600）、損毀備份、Volume 偵測
src/auth.ts             密碼（scrypt）、登入 session cookie（HMAC 簽章，綁帳號與 sessionVersion）、首次設定碼、登入用的假雜湊
src/auth-kit.ts         全站共用的登入工具：session 簽發／驗證、角色檢查（requireAdmin）、CSRF 標頭、逐 IP 登入限流、scrypt 並行閘門、審計 log、mutate()、next 白名單（safeNextPath）
src/login-routes.ts     登入頁與登入／登出、/api/me、我的帳號頁（唯讀，任一角色；沒有自己改密碼的端點）
src/settings-routes.ts  設定頁與設定 API 的路由（只有管理員；/settings、/settings/setup、/settings/upgrade、/api/settings*）：建立第一位管理員、升級舊版密碼、LINE 設定
src/account-routes.ts   帳號管理 API（/api/accounts*，只有管理員）：新增、修改（含角色）、重設密碼（包括自己的；密碼只由管理員設定）、停用／啟用、刪除，規則都在寫檔的鎖內檢查
src/accounts.ts         帳號的小工具：姓名、Email、角色的驗證／正規化、對外檢視（不含雜湊）、統計、最後一位管理員保護、鎖內重新確認操作者
src/settings-page.ts    登入頁、帳號頁、設定頁、403 頁的 HTML（伺服器端組字串、CSP nonce、不用前端框架）
src/http.ts             共用的 HTTP 小工具（客戶端 IP、讀 JSON、HTTPS 判斷、對外網址）
src/rate-limit.ts       固定視窗限流、客戶端 IP 判斷、並行閘門（ConcurrencyGate，限制 scrypt 同時進行的數量）
src/env.ts              環境變數載入
src/common.ts           共用型別與工具（ServiceError、Logger、FetchLike）
scripts/docker-entrypoint.sh  容器入口：修正 Volume 擁有者後用 su-exec 降權
tests/                  vitest（含 assets.test.ts：靜態資源路由與路徑穿越；branding.test.ts：配色檔 sha256、CSS 只寫 token 且守住配色鐵律、頁面結構與 CSP；notify-engine.test.ts：直接從 index.html 取出 ApiClient、各引擎與 UserBar 在 Node 執行來測；server*.test.ts 真的啟動 src/server.ts；login-gate.test.ts：登入閘門、next 白名單、角色與權限、v2→v3）；tests/fixtures/n8n-golden.json 是 n8n 現行版的標準答案（產生腳本：tests/fixtures/generate-n8n-golden.mjs）
docs/legacy-n8n/        已退役的 n8n 工作流匯出（歷史參考）
Dockerfile              兩階段建置，EXPOSE／預設 PORT=8080、DATA_DIR=/app/data，入口腳本降權
```
