# 約定：`index.html`（前端單頁）

> 這份是 `CLAUDE.md`「不可破壞的約定」的一部分，**效力與 `CLAUDE.md` 相同**；2026-11-27 從 `CLAUDE.md` 逐字搬出（只加了小標題，內文沒有改寫）；同日依使用者指示改版，新增「2026-11-27 改版：品名查詢、數量與外箱明細」、「2026-11-27 改版：外箱明細可從商品主檔載入別台裝置的箱子」與「2026-11-27 改版：統計報表的欄寬與手機版卡片」三節——它們放寬了前面幾節的範圍，兩者衝突時以它們為準。
> **動到下列任何一項之前，把這份整份讀完再動手**：`index.html` 的任何改動、`tests/notify-engine.test.ts`、`tests/scan-flow.test.ts`、`tests/outer-box-label.test.ts`。
> 改了這裡描述的行為，就同步改這份文件；`CLAUDE.md` 的路由表與「底線」摘要也要跟著對一次。

## 可以動的區塊（其餘不動）

`index.html` 的改動集中在幾個區塊，其餘不動：品牌配色（見 `branding.md`：`data-thermal`、stylesheet link、header Logo、`<style>` 只寫 token）；端點常數（`OCREngine.WEBHOOK_URL`＝`/api/ocr`、`SaveEngine.SAVE_URL`＝`/api/save`）；`NotifyEngine`（關箱 LINE 通知，2026-10-05 使用者同意放寬）與關箱流程：`CloseFlow`（`sync(box)`：先 `GET /api/me` 確認登入，再同步到商品主檔；**確認時或同步途中登入過期就整個中止、箱子保持開啟**，不顯示任何「完成」提示；其他結果——成功、部分失敗、全部失敗、斷線、`/api/me` 503——都照原本的行為完成這個箱子），關箱按鈕的處理器是 `const outcome = await CloseFlow.sync(box); if (!outcome.proceed) return; NotifyEngine.boxClosed(box, outcome.saveResult);`（通知不 await）；**全站登入（2026-10-06 使用者同意放寬）**：`ApiClient`（所有 `/api` 請求唯一的 `fetch` 出口：POST 帶 `X-Requested-With: XMLHttpRequest`，回 401 時 `location.href = '/login?next=' + encodeURIComponent(location.pathname)` 並記 `expired`；`SaveEngine` 見 `expired` 就停止逐筆送）、頂端使用者列（`#userbar`，header 之前，預設隱藏）與 `UserBar`（載入時呼叫一次 `GET /api/me` 顯示「👤 姓名（角色）」，管理員才有「設定」連結；登出 `POST /logout` 後導向 `/login`）。

## 掃描卡片常駐與 localStorage

**掃描卡片常駐（2026-10-07 使用者要求）**：`#scanner-card` 不再預設隱藏，`renderCurrentBox` 經 `setScannerEnabled` 在沒有箱子時把相機區的提示換成「請先新增箱號」、目前箱子已完成時換成「此箱已完成，請新增箱號或切換到開放中的箱號」，並停用「開啟相機」與手動輸入條碼（`btn-start-scan` 的處理器也自己再擋一次沒有開放中箱號的情況）；**不要動 localStorage 的鍵與箱子資料的載入／儲存**（`Store.KEY` 是 `ipas-state`）。

## 測試怎麼鎖住這些區塊

`tests/notify-engine.test.ts` 直接從 index.html 取出 `ApiClient`、各引擎、`CloseFlow` 與 `UserBar` 的原始碼在 Node 執行來測（注入假的 fetch、location、document；各區塊以 `// ========== 名稱` 標記切段，改名或搬動要同步改測試），並檢查 index.html 裡只有 ApiClient 一個 `fetch(`。

## 2026-11-27 改版：品名查詢、數量與外箱明細

使用者 2026-11-27 指示，在前面幾節的範圍之外再放寬下列區塊；前面幾節的其他限制照舊。

**新增的兩個邏輯區塊**（都在 `PrintManager` 之後、`UI Logic` 之前；寫成物件＋純函式，相依的東西從參數傳入，頂層不碰 DOM、`state`、`localStorage`，測試才切得出來）：

- `// ========== ProductFlow`：拿到商品編號之後的**唯一**流程。拍照與手動輸入都走 `scanBarcode` → `ProductFlow.run`，不要再分成兩份。測試在 `tests/scan-flow.test.ts`。
- `// ========== OuterBoxLabel`：外箱明細的合併、取品名、分頁、排版、量高度。測試在 `tests/outer-box-label.test.ts`。

**品名只來自商品總表**（後端的約定見 `CLAUDE.md`「商品總表查詢」）：

- OCR 的結果只取商品編號；OCR 回傳的品名、性別、顏色、尺寸一律不採用、也不預填任何視窗。`OCREngine` 區塊與 `/api/ocr` 的請求不動。
- 流程依序是：編號是空的 → 請人員輸入；**目前這一箱已有同編號 → 直接累加數量、不查詢**；記憶是 `source:'edit'` → 直接用記憶、不查詢；否則 `POST /api/products/lookup`。查得到直接加入（不跳確認視窗）；查不到跳「總表查無」視窗；查詢失敗（斷線、4xx/5xx、回應格式不對）跳「無法查詢商品總表」視窗——**查不到總表也要能繼續裝箱**。視窗裡改了編號，就用新編號把流程再走一次（查得到就用總表的，丟掉手動輸入的內容）。
- 商品（item）多兩個欄位：`officialName`（總表的官方完整品名；人員編輯過就清掉）、`catalog`（`'found'`；`'missing'`＝總表查無；`'unverified'`＝查詢失敗、未核對；`'edited'`＝用了人員修改過的品名）。清單只對 `'missing'`、`'unverified'` 顯示標記。**沒有這兩個欄位的舊資料必須照常運作**。
- 品名記憶（`state.productCache[編號]`）多一個 `source`：`'edit'`（「編輯商品」改過，**優先於總表**）、`'manual'`（查無時手動輸入，只用來預填視窗；總表一旦查得到就用總表的）。**沒有 `source` 的舊資料（改版前 AI 猜的）比照 `'manual'`，絕不能蓋過總表**。「編輯商品」存檔時（`ProductFlow.planEdit`）：品名／性別／顏色／尺寸有變才算編輯，只改數量不算；該筆是 `'missing'`／`'unverified'` 記成 `'manual'`，其他記成 `'edit'`。
- 「重設品名記憶」（`#btn-reset-product-cache`）只清 `state.productCache`，箱子與商品不動。「清除資料」按鈕的 HTML 被測試鎖住，不要改。

**數量**：一律是 1～9999 的整數（`ProductFlow.clampQty`；JS 端也要擋，不能只靠 HTML 屬性）。同一箱同一個編號只有一筆，再加入就累加（上限 9999）；改版前留下的同箱重複資料**不合併、不改寫**（累加到第一筆，列印時才合併顯示）。掃描卡片的「每次加入數量」（`#input-scan-qty`）成功加入後回到 1；清單每筆可以直接改數量。上一筆還在查詢或視窗還沒關時，再按「加入」不會再送一次（`ProductFlow.run` 回 `status:'busy'`），免得數量填 100 時連點變成 200。改數量、編輯、刪除之後要重畫箱號列（件數才會對）。`SaveEngine`、`NotifyEngine`、`CloseFlow` 與它們送出的 payload 形狀不動——同步到試算表的品名就是商品上的欄位。

**外箱明細**（A4 直式、一頁上下各一箱）：

- 三個入口（統計報表頁、目前箱號的橫幅、箱號旁的動作按鈕）→ 選擇視窗（依勾選順序排版；空箱不能選）。
- 同箱同編號合併成一列、依編號排序；最後一列「合計：X 件」。品名依序取：商品的 `officialName` → 改版前的舊商品（沒有 `officialName` 也沒有 `catalog`）列印時批次查總表（一次最多 200 個；只用於這次列印，**不改寫箱子裡的資料**；查詢失敗就退到下一項並提示）→ 用欄位組出來（`OuterBoxLabel.buildMergedName`，必須與後端 `src/sheets.ts` 的 `buildMergedName` 一致，測試逐一比對）。
- 分頁是純函式 `OuterBoxLabel.paginate`，吃**實際量到的每列高度**（品名會換行，不能假設等高）：放得下半頁的箱子依序兩兩一頁；放不下半頁的自己佔整頁，整頁放不下就接下一頁（任何一列都不截斷；接續頁標「（續）」；合計只在最後一段）；大箱前後不補位、維持順序。
- 表格用 `table-layout: fixed`＋`<colgroup>` 給欄寬（商品編號 24%／商品名稱 60%／數量 16%）。第一列是合併儲存格，沒有 `<colgroup>` 三欄會被平均分；量高度與實際列印必須是同一份結構（都走 `renderTable`）。
- 尺寸要一起算：`.ob-page` 是 194×276 mm＝上下各 135 mm 的區塊＋中間 6 mm（虛線在這 6 mm 的正中）；`@page` 是 `size: A4 portrait; margin: 10.5mm 8mm 8mm`，所以裁切虛線落在紙張正中央（10.5＋135＋3＝148.5 mm），內容區還有 2.5 mm 餘裕不會多出空白頁。改任何一個數字都要重算其他幾個。
- 列印模式是 body class `print-mode-outerbox`（已在 `PrintManager._setPrintMode` 的清除清單裡）。`@page` 由 `PrintManager.printOuterBoxes` **動態插入**（`<style id="outer-box-page-style">`）、離開這個模式就移除；靜態樣式表不可以有 `@page`（會影響既有兩種列印）。**不要在 `window.print()` 返回後立刻清掉列印模式**（手機瀏覽器的 `print()` 會立刻返回，馬上清掉會印出空白頁），在 `afterprint` 事件清。列印用的 DOM 留在 `#outer-box-print`，下一次列印才覆蓋。
- 字型堆疊以 `"Noto Sans CJK TC", "Noto Sans TC"` 開頭、後面接系統的中文字型。**不可載入任何外部資源**（`tests/branding.test.ts` 限制只能有一個 `<link>`），所以印的那台裝置沒裝這個字型就會退回系統字型——這是已知限制，不要為了它去掛外部字型。
- 驗證範圍：這個版面用電腦版 Chrome 轉 PDF 量過（頁數、每列不被截斷、裁切線位置、欄寬）；iPhone Safari 與實體印表機尚未實測。

## 2026-11-27 改版：外箱明細可從商品主檔載入別台裝置的箱子

使用者 2026-11-27 指示。原因：箱子資料只存在掃描那支手機的 localStorage，辦公室電腦開統計報表是空的、印不了外箱明細；每個箱子「完成此箱」時都會逐筆寫進商品主檔，所以外箱明細的選擇視窗可以把別台裝置已完成的箱子讀回來。後端是唯讀的 `POST /api/boxes/lookup`（`{date}` → `{success,data:{date,boxes:[{boxId,closedAt,items:[{barcode,productName,gender,color,size,mergedName,qty}]}],rows,skipped}}`；同一天「箱號＋關箱時間」相同的算一批，同一個 `boxId` 可能出現多筆，`closedAt` 可能是空字串）。

- **視窗隨時開得起來**：本機沒有箱子也照開（本機清單顯示「這台裝置沒有箱子」），不再跳「目前沒有任何箱子」。
- **載入的箱子絕不進 `state`／localStorage**：只活在選擇視窗的區域變數（`showOuterBoxDialog` 的 `sheetBoxes`），不寫進 `state.boxes`、不 `persist()`、不動 `Store`／`ipas-state`／箱子資料的載入與儲存；關掉視窗就沒了。`tests/outer-box-label.test.ts` 有原始碼層級的檢查擋住。
- **清單鍵**：載入的項目鍵是 `sheet:<查詢日期>|<箱號>|<關箱時間>|<序>`（`OuterBoxLabel.sheetKey`），不會和本機箱號相撞，同一個 `boxId` 多筆也各自勾選；標籤顯示「商品主檔」（`ob-tag-sheet`），後面是關箱時間 `HH:MM`（空白就不顯示）與「N 種商品、M 件」。勾選順序與本機箱子共用同一個 `order`（`toggleOrder`）。
- **取代規則**：再按一次「載入」（同一天或換一天）＝用新結果取代先前載入的那一批，舊的鍵從勾選順序拿掉（`dropKeys`），本機箱子的勾選不動；新載入的預設不勾。「全選」＝本機可選的＋載入的；「只選已完成」＝本機已完成的＋載入的；「全不選」照舊（`pickAll`）。
- **日期預設今天，以台北時間（UTC+8）計**（`taipeiToday`），`<input type="date">` 的值直接送；失敗時顯示 API 的 `error`、沒有就用固定句「無法讀取商品主檔，請稍後再試」，不可讓視窗壞掉；空結果顯示「這一天在商品主檔沒有已完成的箱子」。所有 `/api` 請求仍只走 `ApiClient`。
- **載入的箱子的品名規則**（`OuterBoxLabel.sheetRowName`，純函式）：每一筆先用商品編號查商品總表（沿用 `ProductFlow.lookup` 與 200 個一批的分塊）；總表查得到、而且總表的 `productName／gender／color／size`（trim 後）與這一列完全相同 → 印總表的 `officialName`；其他情況（查不到、四欄有任何不同＝當初被人員改過、編號空白、查詢失敗）→ 印這一列的 `mergedName`，空白就用 `buildMergedName` 組。查詢失敗不擋列印（跳提示、退回試算表上的品名）。同箱同編號合併、數量加總且上限 9999（`prepareSheet`）。
- **列印**沿用既有流程（`prepare`／`prepareSheet` 的結果依勾選順序接在一起 → `measure` → `paginate` → `PrintManager.printOuterBoxes`）；表頭與本機箱子完全一樣（只有「箱號：<箱號>」，沒有日期欄位）。
- **統計報表空狀態**「尚無盤點資料」底下多一句說明（這裡只顯示這台裝置掃描的資料，要印別台裝置掃的箱子請按「列印外箱明細」從商品主檔載入），`no-print`，列印統計表時不印。
- **手機版**：新增的一段（日期欄＋載入按鈕）用 `flex-wrap`，≤600px 與 320px 寬度不可造成水平捲動；`.dialog-wide` 加了 `max-height`＋`overflow-y: auto`，視窗太高時整個可捲動。
- 驗證範圍：純邏輯有單元測試；真實瀏覽器（手機窄螢幕、實際列印）另由獨立驗證者確認。

## 2026-11-27 改版：統計報表的欄寬與手機版卡片

使用者 2026-11-27 指示（手機上統計報表有 8 欄，品名被擠成一個字一行）。**只有 CSS**：`renderStats`、表格的 DOM 與 `AggregationEngine` 都沒有改。

- **表格模式（`@media screen and (min-width: 768px)`）**：每欄給最小寬度（商品編號 11ch、品名 9em——900px 以上是 13em、性別 2.5em、顏色 4em、尺寸 3em、所在箱號 5em；序號與數量不換行；**這些是內容寬度**——全站是 `border-box`，所以這一段把 `td` 改成 `box-sizing: content-box`，否則最小寬度會被左右內距吃掉、短欄照樣被擠成直的；768～899px 另把左右內距縮成 10px，8 欄才放得進平板直放的寬度），不讓欄位被擠成一個字一行（中文每個字都能斷行，空間不夠時品名會先被擠扁）。**不要用 `white-space: nowrap` 撐欄位**：一筆超長的商品編號或顏色會把整張表撐寬，數量與箱號被擠出畫面（2026-11-27 第一版就這樣被驗證者退回）；內容超過最小寬度就照樣換行。空狀態那一格（`td.stats-empty`，它同時是第 1 格）要維持可以換行。
- **窄螢幕（`@media screen and (max-width: 767px)`：手機直放、小平板）**：同一份 DOM 改成一筆一張卡片——`tr` 是 `display:flex; flex-wrap:wrap`，用 `order` 排成四行：序號＋商品編號＋（靠右）數量／品名／性別・顏色・尺寸／所在箱號；`thead` 隱藏，欄名用 `td::before` 補上（「數量」「性別」「顏色」「尺寸」「箱號」）。商品編號那一格是 `flex: 1 1 0`（再長也在自己的格子裡換行，不會把數量擠到下一行）。
- **上面兩段都只對 screen 生效**——不要把 `screen` 拿掉，也不要在 `@media` 外面寫 `nth-child` 規則（第一版的 `nowrap` 沒包 `screen`，資料有超長編號時列印右邊幾欄被切掉）。
- **列印統計表**（`@media print` 裡的 `body.print-mode-stats .stats-table …`）有自己的一組：仍然是表格，同樣每欄給最小寬度（內容寬度、`content-box`；品名 12em，其餘與螢幕相同；8 欄的最小寬度合計約 630px，A4 直式左右各留 20mm 也放得下）、超長內容在格子裡換行，左右內距縮成 8px 讓 A4 直式放得下。原因與螢幕相同——一筆商品分裝在很多箱時，所在箱號那一欄會把品名、性別、顏色擠成直的（修正前就有，2026-11-27 驗證者在驗螢幕版時發現）。這組規則一律掛在 `print-mode-stats` 底下，不可影響標籤單與外箱明細的列印。
- **CSS 用 `td:nth-child` 定位欄位**：表頭 8 欄與 `renderStats` 每列 8 格的順序是這個約定的一部分，改了順序或增減欄位，上面兩組規則要一起改（`tests/scan-flow.test.ts` 有原始碼層級的檢查擋住）。
- 驗證範圍：真實瀏覽器（320～1280 各寬度的卡片與表格、列印統計表轉 PDF）由獨立驗證者確認；iPhone Safari 實機與實體印表機尚未實測。

## 跳脫（XSS）備忘：已解決的既有問題

`index.html` 的 `escHtml()` 原本不跳脫雙引號卻用在 `value="…"` 屬性裡（品名含 `"` 會截斷欄位、可注入屬性）；2026-10-05 由 `dfe292c` 修正（同時跳脫 `"` 與 `'`）。設定頁與 `index.html` 同源，`index.html` 的任何 XSS 仍然能借用已登入管理員的 cookie 呼叫設定 API，所以 `index.html` 的屬性插值與 `innerHTML` 使用要持續保持跳脫。
