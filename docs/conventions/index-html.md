# 約定：`index.html`（前端單頁）

> 這份是 `CLAUDE.md`「不可破壞的約定」的一部分，**效力與 `CLAUDE.md` 相同**；2026-11-27 從 `CLAUDE.md` 逐字搬出（只加了小標題，內文沒有改寫）；同日依使用者指示改版，新增「2026-11-27 改版：品名查詢、數量與外箱明細」一節——它放寬了前面幾節的範圍，兩者衝突時以它為準。
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

## 跳脫（XSS）備忘：已解決的既有問題

`index.html` 的 `escHtml()` 原本不跳脫雙引號卻用在 `value="…"` 屬性裡（品名含 `"` 會截斷欄位、可注入屬性）；2026-10-05 由 `dfe292c` 修正（同時跳脫 `"` 與 `'`）。設定頁與 `index.html` 同源，`index.html` 的任何 XSS 仍然能借用已登入管理員的 cookie 呼叫設定 API，所以 `index.html` 的屬性插值與 `innerHTML` 使用要持續保持跳脫。
