import { describe, expect, it } from "vitest";

import type { SettingsView } from "../src/line-settings.js";
import {
  escapeHtml,
  pageSecurityHeaders,
  renderLoginPage,
  renderSettingsPage,
  renderSetupPage,
  renderUnavailablePage,
  WEBHOOK_PATH,
} from "../src/settings-page.js";

// 直接測 HTML 產生函式（不經過路由）：用刻意惡意的資料餵進去，確認每個動態值都被跳脫，
// 而且頁面內那一段 script 永遠是固定字串、不含任何伺服器端的值。

const SCRIPT_RE = /<script nonce="([^"]*)">([\s\S]*?)<\/script>/;

function view(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    dataDirWritable: true,
    dataDirMounted: true,
    adminConfigured: true,
    line: {
      enabled: true,
      channelAccessToken: { configured: true, last4: "wxyz" },
      channelSecret: { configured: true, last4: "abcd" },
      groupId: "C0123456789abcdef0123456789abcdef",
      groupName: "倉庫群組",
      updatedAt: "2026-10-05T00:00:00.000Z",
    },
    effective: { source: "settings", lineConfigured: true, lineWebhookConfigured: true },
    env: { tokenConfigured: false, groupIdConfigured: false, secretConfigured: false },
    captured: [{ groupId: "Cfedcba9876543210fedcba9876543210", groupName: "另一個群組", eventType: "join", lastSeenAt: "2026-10-05T07:20:00.000Z" }],
    ...overrides,
  };
}

const ctxOf = (overrides: Partial<{ nonce: string; origin: string; insecure: boolean }> = {}) => ({ nonce: "test-nonce-abc", origin: "https://example.test", ...overrides });

describe("escapeHtml", () => {
  it("& < > \" ' ` 全部跳脫；一般文字（含中文、emoji）原樣", () => {
    expect(escapeHtml(`&<>"'\``)).toBe("&amp;&lt;&gt;&quot;&#39;&#96;");
    expect(escapeHtml("倉庫群組 🔔 ABC-123")).toBe("倉庫群組 🔔 ABC-123");
    expect(escapeHtml("")).toBe("");
  });

  it("每一個危險字元單獨測（少跳脫任何一個都會被抓到）", () => {
    for (const [raw, escaped] of [["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"], ['"', "&quot;"], ["'", "&#39;"], ["`", "&#96;"]] as const) {
      expect(escapeHtml(`a${raw}b`)).toBe(`a${escaped}b`);
    }
  });

  it("不會重複跳脫已經是實體的內容以外的東西：先跳脫 & 再跳脫其他（結果不含未跳脫的 & 開頭實體誤判）", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("頁面內的 script 是固定字串：不含任何伺服器端插入的值", () => {
  const SENTINEL_A = "SENTINEL-A-<>\"'&`-0001";
  const SENTINEL_B = "SENTINEL-B-<>\"'&`-0002";
  const evilView = (tag: string) =>
    view({
      line: {
        enabled: false,
        channelAccessToken: { configured: true, last4: `${tag}1` },
        channelSecret: { configured: true, last4: `${tag}2` },
        groupId: `${tag}-gid`,
        groupName: `${tag}-gname`,
        updatedAt: tag,
      },
      captured: [{ groupId: `${tag}-cid`, groupName: `${tag}-cname`, eventType: `${tag}-event`, lastSeenAt: tag }],
    });

  const renders = (tag: string) => [
    renderUnavailablePage(ctxOf({ origin: tag, nonce: "n1" })),
    renderSetupPage(ctxOf({ origin: tag, nonce: "n1" })),
    renderLoginPage(ctxOf({ origin: tag, nonce: "n1" })),
    renderSettingsPage(ctxOf({ origin: tag, nonce: "n1" }), evilView(tag)),
  ];

  it("四種頁面：換掉所有動態值（網址、群組名稱、ID、尾碼…）之後，script 本文逐字相同，而且不含那些值", () => {
    const a = renders(SENTINEL_A);
    const b = renders(SENTINEL_B);
    for (let i = 0; i < a.length; i++) {
      const scriptA = SCRIPT_RE.exec(a[i]!)![2]!;
      const scriptB = SCRIPT_RE.exec(b[i]!)![2]!;
      expect(scriptA.length).toBeGreaterThan(1000);
      expect(scriptA).toBe(scriptB);
      expect(scriptA).not.toContain("SENTINEL");
      expect((a[i]!.match(/<script/g) ?? []).length).toBe(1);
      expect(a[i]).not.toMatch(/\son[a-z]+=/i);
    }
  });

  it("nonce 只出現在 <script> 標籤上，值本身經過跳脫", () => {
    const html = renderLoginPage(ctxOf({ nonce: 'abc"><img src=x>' }));
    expect(html).toContain('<script nonce="abc&quot;&gt;&lt;img src=x&gt;">');
    expect(html).not.toContain("<img src=x>");
  });
});

describe("設定頁的動態值都有跳脫（刻意用不合法的資料直接餵，不經過 webhook 的格式驗證）", () => {
  it("最近收到的群組：ID（出現在 data 屬性裡）、名稱、事件類型、時間都跳脫，屬性不會被截斷", () => {
    const html = renderSettingsPage(
      ctxOf(),
      view({
        captured: [{ groupId: 'C"><img src=x onerror=alert(1)>', groupName: `<script>alert(2)</script>"'`, eventType: "<b>join</b>", lastSeenAt: "<i>now</i>" }],
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>join</b>");
    expect(html).not.toContain("<i>now</i>");
    expect(html).toContain('data-use-group="C&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('data-group-name="&lt;script&gt;alert(2)&lt;/script&gt;&quot;&#39;"');
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });

  it("token 與 secret 的尾碼（token 字元集允許 \" < > & '）出現在 placeholder 屬性裡：跳脫", () => {
    const html = renderSettingsPage(
      ctxOf(),
      view({ line: { ...view().line, channelAccessToken: { configured: true, last4: '"><x' }, channelSecret: { configured: true, last4: "&'<>" } } }),
    );
    expect(html).toContain('placeholder="已設定（尾碼 …&quot;&gt;&lt;x）；留空表示不變"');
    expect(html).toContain('placeholder="已設定（尾碼 …&amp;&#39;&lt;&gt;）；留空表示不變"');
    expect(html).not.toContain('…"><x');
  });

  it("群組 ID 欄位的 value、群組名稱、網址：跳脫", () => {
    const html = renderSettingsPage(
      ctxOf({ origin: 'https://evil"><svg onload=1>' }),
      view({ line: { ...view().line, groupId: 'C" autofocus onfocus="alert(1)', groupName: "<u>名稱</u>" } }),
    );
    expect(html).toContain('value="C&quot; autofocus onfocus=&quot;alert(1)"');
    expect(html).toContain("&lt;u&gt;名稱&lt;/u&gt;");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<u>名稱</u>");
    expect(html).toContain(`https://evil&quot;&gt;&lt;svg onload=1&gt;${WEBHOOK_PATH}`);
  });

  it("沒有 token／secret 時 placeholder 是空的；有但沒有尾碼（太短）時只說「已設定」", () => {
    const none = renderSettingsPage(ctxOf(), view({ line: { ...view().line, channelAccessToken: { configured: false, last4: null }, channelSecret: { configured: false, last4: null } } }));
    expect(none).toContain('placeholder=""');
    expect(none).not.toContain('placeholder="已設定');
    const short = renderSettingsPage(ctxOf(), view({ line: { ...view().line, channelAccessToken: { configured: true, last4: null } } }));
    expect(short).toContain('placeholder="已設定；留空表示不變"');
  });

  it("頁面絕不含 token／secret 的完整內容這種東西（view 裡本來就沒有，這裡確認輸出的結構只有「已設定」文字）", () => {
    const html = renderSettingsPage(ctxOf(), view());
    expect(html).toContain("已設定（尾碼 …wxyz）");
    expect(html).toContain("已設定（尾碼 …abcd）");
  });
});

describe("頁面共通", () => {
  it("明文 http 的警告只在 insecure 為 true 時出現（四種頁面都是）", () => {
    for (const render of [
      (insecure: boolean) => renderUnavailablePage(ctxOf({ insecure })),
      (insecure: boolean) => renderSetupPage(ctxOf({ insecure })),
      (insecure: boolean) => renderLoginPage(ctxOf({ insecure })),
      (insecure: boolean) => renderSettingsPage(ctxOf({ insecure }), view()),
    ]) {
      expect(render(true)).toContain('id="insecure-notice"');
      expect(render(false)).not.toContain('id="insecure-notice"');
    }
    expect(renderLoginPage(ctxOf())).not.toContain('id="insecure-notice"'); // 沒給就是沒有
  });

  it("資料目錄不是掛載的 Volume：狀態列顯示警告與說明；是或判斷不出來則沒有", () => {
    const warn = renderSettingsPage(ctxOf(), view({ dataDirMounted: false }));
    expect(warn).toContain("資料目錄：不是掛載的 Volume");
    expect(warn).toContain("重新部署後設定會消失");
    expect(renderSettingsPage(ctxOf(), view({ dataDirMounted: true }))).not.toContain("不是掛載的 Volume");
    expect(renderSettingsPage(ctxOf(), view({ dataDirMounted: null }))).not.toContain("不是掛載的 Volume");
  });

  it("安全標頭：CSP 的 script-src 只有這次的 nonce，沒有 unsafe-inline／unsafe-eval，並禁止嵌入與表單送出", () => {
    const headers = pageSecurityHeaders("N0nce+/=");
    const csp = headers["Content-Security-Policy"]!;
    expect(csp).toContain("script-src 'nonce-N0nce+/='");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    for (const directive of ["default-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'", "connect-src 'self'"]) {
      expect(csp).toContain(directive);
    }
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Robots-Tag"]).toContain("noindex");
  });
});
