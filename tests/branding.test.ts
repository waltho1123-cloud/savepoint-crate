import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  renderAccountPage,
  renderForbiddenPage,
  renderLoginPage,
  renderNoAccountsPage,
  renderSettingsPage,
  renderSetupPage,
  renderUnavailablePage,
  renderUpgradePage,
  WIWI_COLORS_PATH,
  WIWI_LOGO_PATH,
  type PageContext,
} from "../src/settings-page.js";
import type { SettingsView } from "../src/line-settings.js";
import { repoRoot } from "./process-helpers.js";

/**
 * WIWI 品牌配色（skill wiwi-web-colors）的回歸測試：
 *   1. public/assets 的配色檔與 Logo 是 skill 原檔的 byte-identical 複本（以 sha256 釘住，不手改、不手抄色碼）。
 *   2. index.html 與設定頁（settings-page.ts）的 CSS 只寫語意 token：沒有任何色碼或 rgb()、用到的 var() 都有定義、
 *      橘（fill）不當字也不壓白字、品牌文字用加深版、互動控制項的邊框不用裝飾用的淺灰、整站 warm 極性。
 *   3. 頁面結構：html 的 data-thermal、stylesheet link 在 <style> 之前、Logo（>= 48px）、CSP 的 style-src 'self'。
 * 每個像素的對比比值不在這裡算（那是 skill 的 audit.py 與一次性的對比腳本做的）；這裡守的是「規則不會被改壞」。
 */

const read = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(resolve(repoRoot, path))).digest("hex");

describe("public/assets：skill 原檔的 byte-identical 複本", () => {
  // 要更新配色（skill 改版）：從 ~/.claude/skills/wiwi-web-colors/assets/ 重新複製這三個檔案（cmp 確認一模一樣），
  // 跑 `python3 ~/.claude/skills/wiwi-web-colors/scripts/audit.py public/assets/wiwi-colors.css`（離開碼 0），再更新這裡的雜湊。
  const PINNED: Record<string, string> = {
    "public/assets/wiwi-colors.css": "668b99e55a2f13d5582b5bd6762f0b7245e1d91eaca858fa8f97689c1110da2c",
    "public/assets/wiwi-logo.svg": "37da102a35ce06c0d6ca78f3eeda3b6efd29eba4373cfcf85e8c1f899138a8bd",
    "public/assets/wiwi-logo-white.svg": "428920547bc7ed8e8109569884c2be954b7ac70aa678d021e0e9038b01602797",
  };

  it.each(Object.entries(PINNED))("%s 的 sha256 與 skill 原檔相同（沒有被手改）", (path, hash) => {
    expect(sha256(path)).toBe(hash);
  });

  it("配色檔有感溫雙極與狀態色的 token（頁面 CSS 用到的 token 都在這裡）", () => {
    const css = read("public/assets/wiwi-colors.css");
    for (const name of ["--wiwi-thermal-solid", "--wiwi-thermal-on-solid", "--wiwi-thermal-fill", "--wiwi-thermal-on-fill", "--wiwi-thermal-tint", "--wiwi-thermal-text-strong", "--wiwi-border-strong", "--wiwi-text-muted", "--wiwi-success-tint", "--wiwi-danger-tint", "--wiwi-warning-tint"]) {
      expect(css, name).toMatch(new RegExp(`${name}\\s*:`));
    }
  });
});

// ───────────────────────────── 迷你 CSS 解析（只為了這份測試）─────────────────────────────
interface Rule {
  selectors: string[];
  decls: Map<string, string>;
  at: string;
}

function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function parseCss(source: string, at = ""): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let k = open + 1;
    while (k < text.length && depth > 0) {
      if (text[k] === "{") depth += 1;
      else if (text[k] === "}") depth -= 1;
      k += 1;
    }
    const body = text.slice(open + 1, k - 1);
    if (prelude.startsWith("@keyframes")) {
      // 動畫影格不含需要檢查的顏色宣告
    } else if (prelude.startsWith("@media") || prelude.startsWith("@supports")) {
      rules.push(...parseCss(body, `${at}${prelude} `));
    } else if (!prelude.startsWith("@")) {
      const decls = new Map<string, string>();
      for (const part of splitTop(body, ";")) {
        const colon = part.indexOf(":");
        if (colon < 0) continue;
        decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).replace(/!important/g, "").trim());
      }
      rules.push({ selectors: prelude.split(",").map((s) => s.trim()), decls, at: at.trim() });
    }
    i = k;
  }
  return rules;
}

const styleOf = (html: string): string => /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
const ctx: PageContext = { nonce: "TESTNONCE", origin: "https://crate.example.test" };
const view = {
  line: { enabled: true, channelAccessToken: { configured: false, last4: "" }, channelSecret: { configured: false, last4: "" }, groupId: "", groupName: "" },
  effective: { source: null, lineConfigured: false, lineWebhookConfigured: false },
  captured: [],
  sheets: { spreadsheetId: "1abc", sheetName: "商品主檔", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/1abc/edit", serviceAccountEmail: "sa@example.test", configured: true },
  dataDirWritable: true,
  dataDirMounted: true,
  me: { id: "1".repeat(32), name: "王老闆", email: "boss@example.test", role: "admin" },
  adminCount: 1,
  accountCount: 1,
} as unknown as SettingsView;
const me = { name: "王老闆", email: "boss@example.test", role: "admin" as const };

/** 設定頁系列的所有頁面（每個都共用同一份 layout、樣式與 script）。 */
const PAGES: Array<[string, string]> = [
  ["登入頁", renderLoginPage(ctx)],
  ["尚未建立任何帳號頁", renderNoAccountsPage(ctx, false)],
  ["建立第一位管理員頁", renderSetupPage(ctx)],
  ["升級頁", renderUpgradePage(ctx)],
  ["503 頁", renderUnavailablePage(ctx)],
  ["403 頁", renderForbiddenPage(ctx, me)],
  ["我的帳號頁", renderAccountPage(ctx, me, view.sheets)],
  ["設定頁", renderSettingsPage(ctx, view, [])],
];

/**
 * 文字顏色允許的 token（白字只有 on-solid；橘 fill 只配 on-fill 的深字；--wiwi-surface 是深色 toast 上的反白字）。
 * 品牌文字只用加深版 text-strong（#A83800）：白底專用的 --wiwi-thermal-text（#CD4400，純白底 4.75:1）壓在淡底／灰底上會差 0.07 以下，
 * 目視看不出來，而這些頁面的底大多不是純白，所以不放進來；真的要在純白卡片上用，要連同這份清單與對比檢查一起改。
 */
const ALLOWED_TEXT = new Set([
  "--wiwi-text",
  "--wiwi-text-muted",
  "--wiwi-thermal-text-strong",
  "--wiwi-thermal-on-fill",
  "--wiwi-thermal-on-solid",
  "--wiwi-success",
  "--wiwi-success-tint", // 反白（success 底上的淡色字）
  "--wiwi-danger",
  "--wiwi-danger-tint",
  "--wiwi-warning",
  "--wiwi-info",
  "--wiwi-surface", // 反白（深色 toast 上的字）
]);

const INDEX_HTML = read("index.html");
const SHEETS: Array<[string, string]> = [
  ["index.html", styleOf(INDEX_HTML)],
  ["設定頁系列（settings-page.ts）", styleOf(PAGES[0]![1])],
];
const TOKEN_CSS = read("public/assets/wiwi-colors.css");
const WIWI_TOKENS = new Set([...TOKEN_CSS.matchAll(/(--wiwi-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));

/** 解開一個值裡的 var()：回傳最後落在哪些 --wiwi-* token（沿著頁面 :root 的舊變數別名一路解到 token）。 */
function wiwiTokensOf(value: string, aliases: Map<string, string>, depth = 0): string[] {
  if (depth > 10) throw new Error(`var() 循環：${value}`);
  const out: string[] = [];
  for (const m of value.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
    const name = m[1]!;
    if (name.startsWith("--wiwi-")) out.push(name);
    else {
      const next = aliases.get(name);
      if (next === undefined) throw new Error(`未定義的變數 ${name}`);
      out.push(...wiwiTokensOf(next, aliases, depth + 1));
    }
  }
  return out;
}

function aliasesOf(rules: Rule[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const rule of rules) {
    if (rule.selectors.length === 1 && rule.selectors[0] === ":root") {
      for (const [k, v] of rule.decls) if (k.startsWith("--")) aliases.set(k, v);
    }
  }
  return aliases;
}

describe.each(SHEETS)("%s 的樣式只寫語意 token", (sheetName, css) => {
  const rules = parseCss(css);
  const aliases = aliasesOf(rules);
  const label = (rule: Rule) => `${rule.selectors.join(", ")}${rule.at ? ` （${rule.at}）` : ""}`;

  it("沒有任何色碼、rgb()／hsl()／oklch() 或顏色名稱（要半透明就用 color-mix() 從 token 調）", () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(stripped).not.toMatch(/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/);
    const NAMED = /\b(white|black|red|green|blue|gray|grey|orange|teal|yellow|silver|navy|maroon|purple|lime|aqua|fuchsia|olive|pink|brown|gold|cyan|magenta|tan|ivory|beige|coral|crimson)\b/i;
    for (const rule of rules) {
      for (const [prop, value] of rule.decls) {
        if (!/^(color|background|background-color|background-image|border|border-[a-z-]*|outline|outline-color|box-shadow|text-shadow|fill|stroke|accent-color|caret-color|--.*)$/.test(prop)) continue;
        const withoutVars = value.replace(/var\(--[a-z0-9-]+\)/g, "var()");
        expect(withoutVars, `${label(rule)} { ${prop}: ${value} }`).not.toMatch(NAMED);
      }
    }
  });

  it("用到的 var() 都有定義（--wiwi-* 在配色檔裡、其他在頁面的 :root 裡）", () => {
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) {
      if (name.startsWith("--wiwi-")) expect(WIWI_TOKENS.has(name), `${name} 不在 public/assets/wiwi-colors.css`).toBe(true);
      else expect(aliases.has(name), `${name} 沒有在 :root 定義`).toBe(true);
    }
    for (const [name, value] of aliases) {
      if (name.startsWith("--") && /var\(/.test(value)) expect(() => wiwiTokensOf(value, aliases), name).not.toThrow(); // 別名一路解得到 token
    }
  });

  it("文字顏色只用允許的 token：橘／藍綠原色（fill、border、orange-*、teal-*）不當字，--wiwi-text-subtle（3.45:1）不當內文，品牌文字只用加深版 text-strong（不用白底專用的 thermal-text）", () => {
    let checked = 0;
    for (const rule of rules) {
      const value = rule.decls.get("color");
      if (value === undefined || value === "inherit") continue;
      checked += 1;
      expect(value, `${label(rule)} 的 color 不能是 color-mix() 或字面值`).toMatch(/^var\(--[a-z0-9-]+\)$/);
      for (const token of wiwiTokensOf(value, aliases)) expect(ALLOWED_TEXT.has(token), `${label(rule)} { color: ${value} } → ${token} 不是允許的文字顏色`).toBe(true);
    }
    expect(checked).toBeGreaterThan(15);
  });

  it("品牌橘（fill）當底色時，字一定是 on-fill（深字）；solid 當底色時，字一定是 on-solid（白字）；白字只出現在 solid 底上", () => {
    const FILL = new Set(["--wiwi-thermal-fill", "--wiwi-thermal-fill-hover"]);
    const SOLID = new Set(["--wiwi-thermal-solid", "--wiwi-thermal-solid-hover", "--wiwi-thermal-solid-active"]);
    let fillRules = 0;
    let solidRules = 0;
    // :hover／:active／:focus 的規則常常只換底色，字色沿用原本那條規則的：用去掉偽類的選擇器去找原規則的 color
    const baseColor = new Map<string, string>();
    const baseBackground = new Map<string, string>();
    for (const rule of rules) {
      const color = rule.decls.get("color");
      const background = rule.decls.get("background") ?? rule.decls.get("background-color");
      for (const selector of rule.selectors) {
        if (/:/.test(selector)) continue;
        if (color !== undefined) baseColor.set(selector, color);
        if (background !== undefined) baseBackground.set(selector, background);
      }
    }
    const baseOf = (rule: Rule, map: Map<string, string>): string | undefined =>
      rule.selectors.map((s) => map.get(s.replace(/:(hover|active|focus|focus-visible|disabled)\b/g, ""))).find((v) => v !== undefined);
    for (const rule of rules) {
      const bg = rule.decls.get("background") ?? rule.decls.get("background-color") ?? baseOf(rule, baseBackground);
      const color = rule.decls.get("color") ?? baseOf(rule, baseColor);
      const bgTokens = bg === undefined ? [] : wiwiTokensOf(bg, aliases);
      const colorTokens = color === undefined || color === "inherit" ? [] : wiwiTokensOf(color, aliases);
      if (bgTokens.some((t) => FILL.has(t))) {
        fillRules += 1;
        expect(colorTokens, `${label(rule)}：橘底要配 on-fill`).toEqual(["--wiwi-thermal-on-fill"]);
      }
      if (bgTokens.some((t) => SOLID.has(t))) {
        solidRules += 1;
        expect(colorTokens, `${label(rule)}：深橘 solid 底要配 on-solid`).toEqual(["--wiwi-thermal-on-solid"]);
      }
      if (colorTokens.includes("--wiwi-thermal-on-solid")) expect(bgTokens.some((t) => SOLID.has(t)), `${label(rule)}：白字（on-solid）只能壓在 solid 底上`).toBe(true);
      if (colorTokens.includes("--wiwi-thermal-on-fill")) expect(bgTokens.some((t) => FILL.has(t)), `${label(rule)}：on-fill 只用在橘底上`).toBe(true);
    }
    // 兩份樣式表各自該有幾條：主頁有橘底的選取分頁（主分頁、箱號分頁）與好幾種深橘按鈕；設定頁沒有橘底，只有深橘主要按鈕
    if (sheetName === "index.html") {
      expect(fillRules).toBeGreaterThanOrEqual(2);
      expect(solidRules).toBeGreaterThanOrEqual(5);
    } else {
      expect(fillRules).toBe(0);
      expect(solidRules).toBeGreaterThanOrEqual(3);
    }
  });

  it("互動控制項（輸入框、按鈕、分頁、小圓鈕）的邊框不用裝飾用的 --wiwi-border（淺灰 1.3:1），要 border-strong、狀態色、solid 或焦點色", () => {
    const INTERACTIVE = /(^|[\s>+~])(button|input|select|textarea)\b|\.btn\b|\.btn-|\.box-tab\b|\.box-action-btn|\.nav-tab\b|\.box-edit-input/;
    let checked = 0;
    for (const rule of rules) {
      if (!rule.selectors.some((s) => INTERACTIVE.test(s))) continue;
      for (const prop of ["border", "border-color"]) {
        const value = rule.decls.get(prop);
        if (value === undefined) continue;
        checked += 1;
        for (const token of wiwiTokensOf(value, aliases)) {
          expect(["--wiwi-border", "--wiwi-text-subtle"], `${label(rule)} { ${prop}: ${value} } 用了裝飾用的邊框色`).not.toContain(token);
        }
      }
    }
    expect(checked).toBeGreaterThan(8);
  });

  it("placeholder 用 muted（6.10:1），不用 text-subtle（3.45:1）", () => {
    const rule = rules.find((r) => r.selectors.includes("::placeholder"));
    expect(rule, "找不到 ::placeholder 規則").toBeDefined();
    expect(wiwiTokensOf(rule!.decls.get("color")!, aliases)).toEqual(["--wiwi-text-muted"]);
  });

  it("有鍵盤焦點的樣式（:focus-visible 用 --wiwi-focus-ring）", () => {
    const rule = rules.find((r) => r.selectors.includes(":focus-visible"));
    expect(rule, "找不到 :focus-visible 規則").toBeDefined();
    expect(wiwiTokensOf(rule!.decls.get("outline")!, aliases)).toEqual(["--wiwi-focus-ring"]);
  });

  it("沒有手寫的深色模式或涼感（整站就是 warm）", () => {
    expect(css).not.toMatch(/data-theme|data-thermal="cool"/);
  });
});

describe("index.html 的品牌結構", () => {
  it('<html lang="zh-Hant" data-thermal="warm">；stylesheet link 在 <style> 之前', () => {
    expect(INDEX_HTML).toContain('<html lang="zh-Hant" data-thermal="warm">');
    const link = INDEX_HTML.indexOf(`<link rel="stylesheet" href="${WIWI_COLORS_PATH}">`);
    expect(link).toBeGreaterThan(-1);
    expect(INDEX_HTML.split(`href="${WIWI_COLORS_PATH}"`)).toHaveLength(2); // 只有一個
    expect(link).toBeLessThan(INDEX_HTML.indexOf("<style>"));
    expect(INDEX_HTML.match(/<link\b/g)).toHaveLength(1);
  });

  it("header：Logo 在標題左側（img 在 h1 之前），高度 48px（>= 48）、有 alt；h1 與清除資料鈕沒變", () => {
    const header = /<header class="header">([\s\S]*?)<\/header>/.exec(INDEX_HTML)![1]!;
    expect(header).toContain(`<img class="brand-logo" src="${WIWI_LOGO_PATH}" alt="WIWI" width="53" height="48">`);
    expect(header.indexOf("<img")).toBeLessThan(header.indexOf("<h1>"));
    expect(header).toContain("<h1>IPAS 庫存盤點裝箱系統</h1>");
    expect(header).toContain('onclick="confirmClearAll()">清除資料</button>');
    const logo = parseCss(styleOf(INDEX_HTML)).find((r) => r.selectors.includes(".brand-logo"))!;
    expect(logo.decls.get("height")).toBe("48px");
  });

  it("沒有 inline style 帶色碼或 rgb()（含 JS 產生的 HTML 字串）", () => {
    for (const m of INDEX_HTML.matchAll(/style=("[^"]*"|'[^']*')/g)) {
      expect(m[1], "inline style").not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla)\(/);
    }
    // inline style 裡的 color 只能是 var(--token)，而且要解得到允許的文字 token
    const aliases = aliasesOf(parseCss(styleOf(INDEX_HTML)));
    const inlineColors = [...INDEX_HTML.matchAll(/style="([^"]*)"/g)].flatMap((m) => [...m[1]!.matchAll(/(?:^|;)\s*color:\s*([^;]+)/g)].map((c) => c[1]!.trim()));
    expect(inlineColors.length).toBeGreaterThanOrEqual(2); // ocr-status 與統計摘要
    for (const value of inlineColors) {
      expect(value).toMatch(/^var\(--[a-z-]+\)$/);
      for (const token of wiwiTokensOf(value, aliases)) expect(ALLOWED_TEXT.has(token), `inline style 的 color: ${value} → ${token}`).toBe(true);
    }
    expect(INDEX_HTML).toContain('style="margin-top:8px;font-size:.85rem;color:var(--primary-dark);text-align:center;display:none"'); // 非純白底上的品牌字用加深版
  });
});

describe("設定頁系列的品牌結構與 CSP", () => {
  it.each(PAGES)('%s：<html lang="zh-Hant" data-thermal="warm">、stylesheet link 在 <style> 之前、Logo 在標題之前', (_name, html) => {
    expect(html).toContain('<html lang="zh-Hant" data-thermal="warm">');
    const link = html.indexOf(`<link rel="stylesheet" href="${WIWI_COLORS_PATH}">`);
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(html.indexOf("<style>"));
    expect(html.match(/<link\b/g)).toHaveLength(1);
    const logo = html.indexOf(`<img class="brand-logo" src="${WIWI_LOGO_PATH}" alt="WIWI" width="53" height="48">`);
    expect(logo).toBeGreaterThan(-1);
    expect(logo).toBeLessThan(html.indexOf("<h1>"));
    expect(html).not.toMatch(/\son[a-z]+=/i); // 沒有 inline 事件屬性（img 也沒有 onerror／onload）
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });

  it("登入頁與「尚未建立任何帳號」頁的 Logo、標題置中（class=wrap center）；其他頁靠左", () => {
    for (const [name, html] of PAGES) {
      const centered = name === "登入頁" || name === "尚未建立任何帳號頁";
      expect(html.includes('<main class="wrap center">'), name).toBe(centered);
      expect(html.includes('<main class="wrap">'), name).toBe(!centered);
    }
    const logo = parseCss(styleOf(PAGES[0]![1])).find((r) => r.selectors.includes(".brand-logo"))!;
    expect(logo.decls.get("height")).toBe("48px"); // Logo 高度不低於 48px
  });

  it("所有頁面都不放色碼的 inline style", () => {
    for (const [name, html] of PAGES) expect(html, name).not.toMatch(/style="[^"]*(#[0-9a-fA-F]{3,8}\b|rgba?\()/);
  });
});

describe("Dockerfile", () => {
  it("runtime 階段把 public/ 複製進映像（server.ts 從 dist/ 的上一層讀 public/assets）", () => {
    const dockerfile = read("Dockerfile");
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    expect(runtime).toMatch(/^COPY public \.\/public$/m);
    expect(runtime).toMatch(/^COPY index\.html \.\/index\.html$/m);
    expect(read(".dockerignore")).not.toMatch(/^public\/?$/m); // 沒有被 .dockerignore 排除
  });
});
