# 約定：`index.html`（前端單頁）

> 這份是 `CLAUDE.md`「不可破壞的約定」的一部分，**效力與 `CLAUDE.md` 相同**；2026-11-27 從 `CLAUDE.md` 逐字搬出（只加了小標題，內文沒有改寫）。
> **動到下列任何一項之前，把這份整份讀完再動手**：`index.html` 的任何改動、`tests/notify-engine.test.ts`。
> 改了這裡描述的行為，就同步改這份文件；`CLAUDE.md` 的路由表與「底線」摘要也要跟著對一次。

## 可以動的區塊（其餘不動）

`index.html` 的改動集中在幾個區塊，其餘不動：品牌配色（見 `branding.md`：`data-thermal`、stylesheet link、header Logo、`<style>` 只寫 token）；端點常數（`OCREngine.WEBHOOK_URL`＝`/api/ocr`、`SaveEngine.SAVE_URL`＝`/api/save`）；`NotifyEngine`（關箱 LINE 通知，2026-10-05 使用者同意放寬）與關箱流程：`CloseFlow`（`sync(box)`：先 `GET /api/me` 確認登入，再同步到商品主檔；**確認時或同步途中登入過期就整個中止、箱子保持開啟**，不顯示任何「完成」提示；其他結果——成功、部分失敗、全部失敗、斷線、`/api/me` 503——都照原本的行為完成這個箱子），關箱按鈕的處理器是 `const outcome = await CloseFlow.sync(box); if (!outcome.proceed) return; NotifyEngine.boxClosed(box, outcome.saveResult);`（通知不 await）；**全站登入（2026-10-06 使用者同意放寬）**：`ApiClient`（所有 `/api` 請求唯一的 `fetch` 出口：POST 帶 `X-Requested-With: XMLHttpRequest`，回 401 時 `location.href = '/login?next=' + encodeURIComponent(location.pathname)` 並記 `expired`；`SaveEngine` 見 `expired` 就停止逐筆送）、頂端使用者列（`#userbar`，header 之前，預設隱藏）與 `UserBar`（載入時呼叫一次 `GET /api/me` 顯示「👤 姓名（角色）」，管理員才有「設定」連結；登出 `POST /logout` 後導向 `/login`）。

## 掃描卡片常駐與 localStorage

**掃描卡片常駐（2026-10-07 使用者要求）**：`#scanner-card` 不再預設隱藏，`renderCurrentBox` 經 `setScannerEnabled` 在沒有箱子時把相機區的提示換成「請先新增箱號」、目前箱子已完成時換成「此箱已完成，請新增箱號或切換到開放中的箱號」，並停用「開啟相機」與手動輸入條碼（`btn-start-scan` 的處理器也自己再擋一次沒有開放中箱號的情況）；**不要動 localStorage 的鍵與箱子資料的載入／儲存**（`Store.KEY` 是 `ipas-state`）。

## 測試怎麼鎖住這些區塊

`tests/notify-engine.test.ts` 直接從 index.html 取出 `ApiClient`、各引擎、`CloseFlow` 與 `UserBar` 的原始碼在 Node 執行來測（注入假的 fetch、location、document；各區塊以 `// ========== 名稱` 標記切段，改名或搬動要同步改測試），並檢查 index.html 裡只有 ApiClient 一個 `fetch(`。

## 跳脫（XSS）備忘：已解決的既有問題

`index.html` 的 `escHtml()` 原本不跳脫雙引號卻用在 `value="…"` 屬性裡（品名含 `"` 會截斷欄位、可注入屬性）；2026-10-05 由 `dfe292c` 修正（同時跳脫 `"` 與 `'`）。設定頁與 `index.html` 同源，`index.html` 的任何 XSS 仍然能借用已登入管理員的 cookie 呼叫設定 API，所以 `index.html` 的屬性插值與 `innerHTML` 使用要持續保持跳脫。
