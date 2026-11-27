# 約定：WIWI 品牌配色與靜態資源

> 這份是 `CLAUDE.md`「不可破壞的約定」的一部分，**效力與 `CLAUDE.md` 相同**；2026-11-27 從 `CLAUDE.md` 逐字搬出（只加了小標題，內文沒有改寫）。
> **動到下列任何一項之前，把這份整份讀完再動手**：任何頁面的 CSS／配色／Logo（`index.html` 的 `<style>`、`src/settings-page.ts` 的樣式）、`public/assets/`、`src/assets.ts`、設定頁系列的 CSP、`tests/branding.test.ts`、`tests/assets.test.ts`。
> 改了這裡描述的行為，就同步改這份文件；`CLAUDE.md` 的路由表與「底線」摘要也要跟著對一次。

## 正本、原樣複製與頁面寫法

**WIWI 品牌配色（2026-10-06）**：所有頁面（`index.html`、設定頁系列）的配色正本是 skill `wiwi-web-colors`（`~/.claude/skills/wiwi-web-colors/`，先讀它的 `SKILL.md`）。`public/assets/` 的 `wiwi-colors.css`、`wiwi-logo.svg`、`wiwi-logo-white.svg` 是**原樣複製**（byte-identical，不手改、不手抄色碼；`tests/branding.test.ts` 用 sha256 釘住）。頁面 `<html data-thermal="warm">`（整站溫感，不混極）、`<link rel="stylesheet" href="/assets/wiwi-colors.css">` 在自己的 `<style>` 之前，CSS **只寫語意 token**：沒有色碼、沒有 `rgb()`（半透明用 `color-mix()`，包在 `@supports` 裡、預設退回不透明的 token）；舊變數（`--primary`、`--text`…）保留名稱但指向 token。

## 配色鐵律、Logo 與稽核指令

**配色鐵律**（測試會擋）：橘／藍綠原色（`--wiwi-thermal-fill`、`orange-*`、`teal-*`）只當底色與圖形，不當字、不壓白字——橘底配 `--wiwi-thermal-on-fill`、深橘 solid 底配 `--wiwi-thermal-on-solid`（白字只出現在 solid 底上）；品牌文字一律用 `--wiwi-thermal-text-strong`（這些頁面的底大多不是純白；白底專用的 `--wiwi-thermal-text` 不在測試的允許清單裡）；`--wiwi-text-subtle` 不當內文，placeholder 與次要文字用 `--wiwi-text-muted`；互動控制項的邊框用 `--wiwi-border-strong`（選取狀態的橘底再加深橘邊框），`--wiwi-border` 只給裝飾；狀態色只用「狀態色字＋各自的 `-tint` 底」。Logo 高度 48px（不低於 48）、淺色底；主頁在 header 標題左側，設定頁系列在每頁頂端（登入頁置中）。改過色碼或樣式後跑 `python3 ~/.claude/skills/wiwi-web-colors/scripts/audit.py public/assets/wiwi-colors.css`（離開碼 0）與 `pnpm test`。

## 靜態資源路由（`GET /assets/*`）與 CSP

**靜態資源路由**（`src/assets.ts`）：啟動時把 `public/assets/` 第一層的一般檔案讀進記憶體，`GET /assets/*` 只用檔名查表（不碰檔案系統，所以沒有路徑穿越的可能；不進子目錄、不跟符號連結、不收隱藏檔、副檔名白名單、單檔 <= 2 MB），公開、不需登入，`Cache-Control: public, max-age=86400`＋`nosniff`；缺 `wiwi-colors.css` 或 `wiwi-logo.svg` 就啟動失敗（`process.exitCode = 1`）；`server.ts` 用與 `index.html` 相同的方式從 `dist/` 的上一層找 `public/`，Dockerfile runtime 階段 `COPY public ./public`。設定頁系列的 CSP 因此是 `style-src 'self' 'unsafe-inline'`（同源配色檔＋inline 樣式）、`img-src 'self' data:`。
