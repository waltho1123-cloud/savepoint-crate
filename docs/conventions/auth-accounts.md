# 約定：全站登入、帳號與設定頁（Volume）

> 這份是 `CLAUDE.md`「不可破壞的約定」的一部分，**效力與 `CLAUDE.md` 相同**；2026-11-27 從 `CLAUDE.md` 逐字搬出（只加了小標題，內文沒有改寫）；同日新增商品查詢 API（`POST /api/products/lookup`）時把它補進登入閘門的清單。
> **動到下列任何一項之前，把這份整份讀完再動手**：`src/auth.ts`、`src/auth-kit.ts`、`src/settings-store.ts`、`src/settings-routes.ts`、`src/settings-page.ts`、`src/login-routes.ts`、`src/account-routes.ts`、`src/accounts.ts`、`src/hub-sso.ts`、`src/line-settings.ts`；登入、session、帳號、角色、設定頁、`settings.json`、WIWI Hub 單一登入；以及**新增任何路由**。
> 改了這裡描述的行為，就同步改這份文件；`CLAUDE.md` 的路由表與「底線」摘要也要跟著對一次。

## 總則：資料目錄（Volume）與生效的 LINE 設定

**全站登入、帳號與設定頁（Volume）**（`src/settings-*.ts`、`src/auth*.ts`、`src/login-routes.ts`、`src/account*.ts`、`src/line-settings.ts`）：帳號與設定存在 `DATA_DIR/settings.json`（容器預設 `/app/data`，Coolify 要把持久儲存（Volume）掛在這裡；`0600`、暫存檔＋`rename` 原子寫入、寫檔成功才更新記憶體、變更排成佇列；損毀就備份成 `settings.json.corrupt-<時間>` 並以空設定重新開始，**不蓋掉原內容**）。**資料目錄不存在或不可寫（`SettingsStore.writable=false`）＝沒有地方存帳號＝沒有人登入得了**：登入頁、設定頁、OCR、存檔、商品查詢、關箱通知全部 503「請在 Coolify 的持久化儲存（Persistent Storage）掛載 Volume 到 /app/data」（主頁 302 到登入頁、登入頁 503；`/healthz` 與 LINE webhook 不受影響；`/healthz.dataDirWritable=false`）；`dataDirMounted` 用 `/proc/self/mountinfo` 盡力偵測資料目錄是不是獨立掛載（`false`＝容器暫存層，重新部署會消失）。**生效的 LINE 設定（`resolveLineConfig`）：設定檔裡有 channel access token 就整組用設定檔的（token、secret、群組 ID、開關），環境變數 `LINE_*` 完全不參與；沒有就整組用環境變數**；box-closed、webhook、`/healthz` 每次請求都重新解析（存檔立刻生效）。

## 帳號與角色

**帳號與角色**（`accounts`：`id`（隨機 16 位元組 hex）、`name`、`email`（trim＋小寫、唯一）、`role` `admin`／`user`、`passwordHash`、`status` active／disabled、`sessionVersion`（從 1 起）、時間欄位；上限 `ACCOUNT_MAX_COUNT`=200）。密碼用 scrypt（N=16384,r=8,p=1，`scrypt$N$r$p$salt$hash`）；沒有預設帳號，全新安裝（沒有任何帳號也沒有舊 `admin`）時每次啟動產生一次性設定碼（`XXXX-XXXX`，只在記憶體、寫進 log、用過作廢、累計錯 20 次換新）；**設定碼與升級建立的第一個帳號一定是 admin**（`/settings/setup` 忽略請求裡的 role）。`POST /api/accounts` 沒給 role 預設 `user`（最小權限），頁面的下拉也預設一般使用者。

## session 與登入流程

**session**：cookie `sp_session=<到期ms>.<帳號 id>.<sessionVersion>.<亂數>.<HMAC>`（有效 7 天 `SESSION_TTL_MS`；HttpOnly、SameSite=Lax、請求判斷為 HTTPS 才加 Secure；金鑰 `sessionSecret`，**平常不換、升級時也不動**；**角色不簽在 cookie 裡**，每次請求從目前的帳號資料讀）：驗證 = 簽章＋到期＋帳號存在且 active 且 sessionVersion 相符（`kit.sessionAccount`）；重設密碼（含管理員重設自己的）、停用、啟用、**改角色**都把該帳號 `sessionVersion` 加一（只讓那個帳號的登入失效，停用再啟用也不會讓舊 cookie 復活）；管理員重設**自己**的密碼時回應帶新 cookie（`kit.issueSession`，用更新後的 sessionVersion），目前這個瀏覽器不會被登出；登出只清瀏覽器 cookie；舊格式（三段式）cookie 一律視為未登入。登入（`POST /login {email,password,next?}`）：查無帳號／停用／Email 格式不對都拿 `DUMMY_PASSWORD_HASH` 跑一次 `verifyPassword`（回應時間不洩漏帳號），一律 401「帳號或密碼不正確」；成功後在鎖內重新確認帳號仍啟用且雜湊沒變才更新 `lastLoginAt` 並發 cookie；`lastLoginAt` 寫不進去（`update` 回 500，例如 Volume 滿了或唯讀）只 warn、照樣發 cookie（改用記憶體裡目前的 sessionVersion，並重新確認帳號仍有效）。回 `{success:true,next}`，`next` 經 `safeNextPath`（同源相對路徑：以 `/` 開頭、不是 `//`、無反斜線與控制字元、≤2000 字，其他一律 `/`）。

## 閘門與權限

**閘門與權限**：主頁 `GET /`、`/index.html` 沒登入 302 到 `/login?next=/`；`POST /api/ocr|save|box-closed|products/lookup` 要有效 session（任一角色，沒登入 401「請先登入」）＋ `X-Requested-With: XMLHttpRequest`（缺了 403；先查登入再查標頭；資料目錄不可用 503）；`/settings`、`/api/settings*`、`/api/accounts*` 要 role admin（`kit.requireAdmin`：沒登入 401、一般使用者 403「需要管理員權限」；頁面：沒登入 302 到 `/login?next=/settings`、一般使用者回 403 頁；**還沒有任何帳號時 `/settings` 公開顯示「輸入設定碼」的建立表單或升級表單**（設定碼本身只寫在啟動 log，頁面不顯示），各有自己的秘密擋著）；`/login` 還沒有任何帳號時顯示「請管理員先到設定頁」、已登入導向 `/`；`/api/me`、`/account`（唯讀）任一角色。**沒有任何「自己改密碼」的端點**（`POST /account/password`、`POST /settings/password` 不存在，回 404；`/account` 頁只有姓名、Email、角色、一行「密碼由管理員統一設定，需要變更請洽管理員」與「商品主檔（Google 試算表）」連結卡片（`renderAccountPage(ctx, me, sheets)`；`registerLoginRoutes` 的 `options.sheets`＝`describeSheets(env)`，啟動時算一次；精簡版只有連結、分頁與 ID，不顯示服務帳號），沒有表單）——**密碼只由管理員設定**（`POST /api/accounts/:id/password`，可對任何帳號含自己；`tests/settings-auth.test.ts` 的路由清單（走訪 `app.routes`，涵蓋 `/account`、`/account/*`、`/settings/*` 底下的非 GET 路由）與「沒有「改自己的密碼」的端點」那組 404 測試（明列 `/account/password`、`/settings/password`、`/api/account/password`、`/api/me/password` 等路徑，任何角色、任何方法）會擋住有人把它加回來）。新增路由時要決定它屬於哪一類，並更新 `tests/login-gate.test.ts` 的權限矩陣。

## WIWI Hub 單一登入（SSO）

**WIWI Hub 單一登入（SSO）**（`GET /sso/callback?sso_token=<JWT>`，`src/login-routes.ts`；驗票在 `src/hub-sso.ts`；使用者 2026-11-12 指示、2026-11-13 已部署，PR #3 `09ebf20`）：公開的 GET，**刻意不放在 `/api/` 底下**（不套逐 IP 限流，也不經密碼登入的失敗限流）。`HUB_JWT_SECRET` 每次請求現讀；未設回 404 且沒有任何 Set-Cookie，**絕不退回使用本系統的 `sessionSecret`**。驗票（`verifyHubToken`）：HS256、三段都要是嚴格 base64url、長度 ≤4096、`iss` 精確等於 `wiwi-hub`、`aud` 精確等於 `savepoint-crate`、`exp` 必填、時鐘誤差 30 秒、有 `iat` 時 `exp−iat` ≤ 600 秒（Hub 實際簽 60 秒）；**只採信 `email`**，`name`／`role`／`sub` 一律不看，權限以本地帳號為準；任何失敗（含例外）只回 `null`，呼叫端不得區分原因。對應帳號（`findAccountByEmail`）：資料檔的 email 逐筆正規化後必須**恰好一筆**且啟用中，**不自動建帳號**。失敗一律 302：沒有或多個 `sso_token`、驗票失敗 → `/login?sso=invalid`；查無／多筆／停用／資料目錄不可寫 → `/login?sso=no_account`；兩種都先 `kit.clearSession`（走進接票流程就結束舊登入，免得失敗後還以前一個人的身分繼續用），登入頁的提示是白名單查表（`ssoNotice`）。成功：鎖內重新確認帳號仍啟用並更新 `lastLoginAt`（寫不進去只 warn、照樣登入，與密碼登入相同）→ `kit.issueSession`（同一種 `sp_session`，不動 `sessionVersion`）→ 審計「登入成功（WIWI Hub 單一登入）」→ 302 `/`（相對路徑，不收 `next`）。票證與 Hub 傳來的 email 不進 log。契約由 `tests/hub-sso.test.ts` 鎖住（它不是 `mutate()` 路由，也不在 `tests/login-gate.test.ts` 的權限矩陣裡）；上線紀錄見 README。

## 設定檔版本 1／2→3 與升級

**檔案版本 1／2→3 與升級**：版本 1＝最舊的單一密碼（`admin: {passwordHash, updatedAt}`）、版本 2＝`admins`（管理員，無角色）、**版本 3＝`accounts`（含 role）**。`parseSettingsText` 三種都收：版本 1／2 **只在記憶體轉換**（`admins` 讀成 accounts、role 一律 admin；各版本只認自己的欄位名稱），**所有欄位（含不認識的，頂層／admin／各帳號／line／lineCaptured 每一筆）原樣保留**（`unknownFields`，`__proto__` 丟掉）；`update()` 後的 `normalizeAfterMutation`：有 accounts 就把版本設成 3、`admin` 設 null；`serializeSettings`：有帳號或本來就是版本 3 寫成版本 3（`accounts`），沒有帳號的版本 1／2 維持舊格式（`admins: []`、版本 1 仍帶 `admin`）——所以**沒有帳號時檔案維持載入時的版本**（舊檔升級前、版本 2 檔案沒有寫入前，回滾到 `b54b21b`／`f7529dd` 仍讀得懂；版本 2 檔案第一次寫入就成版本 3，之後舊版會當損毀備份）。有舊 `admin` 且 accounts 為空＝待升級（`legacyAdminPending`）：`POST /settings/upgrade {currentPassword,name,email}`（走 scrypt 閘門與登入限流）驗目前密碼 → 在鎖內建立第一個帳號（role admin）、**沿用同一個 passwordHash**、`admin=null`；`line`／`lineCaptured`／`sessionSecret` 不動；待升級期間 login／setup 回 409、不提示設定碼、LINE webhook 照常（但沒有任何帳號可登入，裝箱程式與 OCR 等都用不了）。`/healthz`：`adminConfigured`＝有啟用中的 admin 或待升級、`adminCount`＝角色 admin 的帳號數（含停用）、`accountCount`＝全部、`legacyAdminPending`。

## 帳號管理 API

**帳號管理 API**（`src/account-routes.ts`，全部 `kit.mutate()`＋`kit.requireAdmin`）：不能停用或刪除自己、**不能把自己改成 user**、不能停用／刪除／降級最後一位啟用中的管理員（純函式 `assertNotLastActiveAdmin`；正常情況由「操作者必須是啟用中的管理員」＋「不能對自己」保證到不了，仍明確檢查當第二道防線，單元測試直接驗它）、Email 重複 409、姓名 1～50 字／Email 格式（`normalizeEmail`）／密碼 8～200 字／role 只能精確的 admin 或 user；**每個改動狀態的 mutator（帳號操作、`PUT /api/settings/line`）都在鎖內先 `requireAdminInDraft`／`requireActorInDraft`（操作者仍存在、啟用中、sessionVersion 沒變，管理員專用的還要 role 仍是 admin）**——請求處理期間（讀 body、查 LINE 名稱、算 scrypt）操作者可能已被停用，所以兩位管理員同時互相停用／降級／刪除只會有一個成功、被停用的人不能再改設定；新增改動狀態的端點時照做；`POST /api/accounts/:id/password`（重設密碼）對任何帳號都行、包括自己（密碼只由管理員設定）：不需要目前的密碼，對自己重設時 `sessionVersion`＋1 並用新值重發 cookie（操作者不會被登出，其他裝置失效），審計 log 的動作記成「重設密碼（自己）」，對別人是「重設密碼」；同時重設自己的密碼時後到的因 `sessionVersion` 已變而 401（鎖內 `requireAdminInDraft`）。審計 log `[accounts] <操作者 email> <動作> <對象 email>（來源 IP）`（動作含「新增帳號（角色 x）」「修改帳號（…角色 a → b）」「停用／啟用／刪除帳號」；登入成功／失敗只有操作者；失敗用 warn；email 一律經 `normalizeEmail`／`emailForLog`，不會把任意字串寫進 log）。

## 狀態變更端點（`kit.mutate()`）與 scrypt 閘門

**所有狀態變更的端點**（POST／PUT／PATCH／DELETE：`/login`、`/logout`、`/settings/setup|upgrade`、`/api/settings/*`、`/api/accounts*`）一律用 `kit.mutate()`（`src/auth-kit.ts`）註冊——它在處理器之前統一檢查資料目錄、只收 `application/json`、要 `X-Requested-With: XMLHttpRequest`，並帶 `nosniff`／`no-store`；`tests/settings-auth.test.ts` 會走訪 `app.routes`，新增端點沒走 `mutate()` 就會失敗（並要更新那張清單，目前 11 條）。scrypt（雜湊／驗證）一律經過 `kit.gated`（`ConcurrencyGate`，同時 2 個、排隊 16 個，超過 429＋`Retry-After: 1`——`ServiceError` 的 `retryAfterSeconds` 選項由 `app.onError` 轉成標頭），免得公開端點被灌請求時占滿 libuv 執行緒池、拖慢 OCR 與存檔。

## 「商品主檔（Google 試算表）」卡片

設定頁最上方「狀態」之後是「商品主檔（Google 試算表）」卡片（`renderSheetsCard`，2026-10-07 使用者要求）：顯示目前生效的 `GOOGLE_SHEET_ID`／`GOOGLE_SHEET_NAME`、「開啟 Google 試算表」連結與寫入用服務帳號的 `client_email`（資料來自 `SettingsView.sheets`＝`describeSheets(env)`，`/api/settings` 也會回這組）；ID 只有符合 `SPREADSHEET_ID_PATTERN`（`[A-Za-z0-9_-]`）才產生連結（`spreadsheetUrlOf`），否則不出連結、顯示警告；憑證解析不了就顯示警告；絕不含 private_key 或憑證原文。`/account` 頁有精簡版（`renderAccountSheetsCard`，任一角色），兩者共用 `renderSheetsLink`。

## 頁面安全、設定檔行為與測試慣例

頁面帶 CSP nonce，動態內容一律 `escapeHtml`、script 內不得插入任何伺服器資料（`tests/settings-page.test.ts` 用哨兵值鎖住這條；登入頁的 `next` 放在表單的 `data-next` 屬性，不進 script）；公開網域上的明文 http 會在頁面頂端警告，`/healthz.requestIsHttps` 讓部署後能確認代理有送 `X-Forwarded-Proto`。token／secret 明文存檔，但 API 與頁面只回「已設定」與末 4 碼，log 一律不印。設定檔開啟時會收緊既有檔案權限、清超過 10 分鐘的殘留暫存檔、容忍 BOM；整份由記憶體重寫、沒有檔案鎖，**假設只有單一實例使用同一個 Volume**。PUT `/api/settings/line` 的群組名稱只在群組 ID／token 變了或名稱還是空的時才查 LINE，查不到時沒換群組就維持原名（不要因為 LINE 暫時失敗把名稱清掉），並防止請求交錯時用過期名稱覆蓋新群組。**測試一律用暫存 `DATA_DIR`**（`tests/settings-helpers.ts` 的 `makeTempDir`），絕不碰 `./data`；測 OCR／存檔／商品查詢／關箱通知要登入——用 `createAuthFixture()`（有一般使用者帳號的 store＋登入標頭）或 `makeSettingsApp().authed()`；真實行程測試用 `seedSettingsFile`／`loginOverHttp`（`tests/process-helpers.ts`）。
