import { describe, expect, it } from "vitest";

import type { AdminPublic } from "../src/admins.js";
import type { SettingsView } from "../src/line-settings.js";
import {
  escapeHtml,
  pageSecurityHeaders,
  renderLoginPage,
  renderSettingsPage,
  renderSetupPage,
  renderUnavailablePage,
  renderUpgradePage,
  WEBHOOK_PATH,
} from "../src/settings-page.js";

// 直接測 HTML 產生函式（不經過路由）：用刻意惡意的資料餵進去，確認每個動態值都被跳脫，
// 而且頁面內那一段 script 永遠是固定字串、不含任何伺服器端的值。

const SCRIPT_RE = /<script nonce="([^"]*)">([\s\S]*?)<\/script>/;

const ME_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";

function admin(overrides: Partial<AdminPublic> = {}): AdminPublic {
  return { id: ME_ID, name: "測試管理員", email: "admin@example.test", status: "active", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", lastLoginAt: null, ...overrides };
}

/** 預設的管理員清單：自己（ME_ID）＋另一位。 */
function admins(): AdminPublic[] {
  return [admin(), admin({ id: OTHER_ID, name: "第二位", email: "second@example.test", lastLoginAt: "2026-10-05T07:20:00.000Z" })];
}

function view(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    dataDirWritable: true,
    dataDirMounted: true,
    adminConfigured: true,
    adminCount: 2,
    legacyAdminPending: false,
    me: { id: ME_ID, name: "測試管理員", email: "admin@example.test" },
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

  const evilAdmins = (tag: string): AdminPublic[] => [
    admin({ id: ME_ID, name: `${tag}-me-name`, email: `${tag}-me-email` }),
    admin({ id: OTHER_ID, name: `${tag}-other-name`, email: `${tag}-other-email`, lastLoginAt: tag }),
  ];

  const renders = (tag: string) => [
    renderUnavailablePage(ctxOf({ origin: tag, nonce: "n1" })),
    renderSetupPage(ctxOf({ origin: tag, nonce: "n1" })),
    renderUpgradePage(ctxOf({ origin: tag, nonce: "n1" })),
    renderLoginPage(ctxOf({ origin: tag, nonce: "n1" })),
    renderSettingsPage(ctxOf({ origin: tag, nonce: "n1" }), { ...evilView(tag), me: { id: ME_ID, name: `${tag}-me-name`, email: `${tag}-me-email` } }, evilAdmins(tag)),
  ];

  it("五種頁面：換掉所有動態值（網址、姓名、Email、群組名稱、ID、尾碼…）之後，script 本文逐字相同，而且不含那些值", () => {
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
      admins(),
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
      admins(),
    );
    expect(html).toContain('placeholder="已設定（尾碼 …&quot;&gt;&lt;x）；留空表示不變"');
    expect(html).toContain('placeholder="已設定（尾碼 …&amp;&#39;&lt;&gt;）；留空表示不變"');
    expect(html).not.toContain('…"><x');
  });

  it("群組 ID 欄位的 value、群組名稱、網址：跳脫", () => {
    const html = renderSettingsPage(
      ctxOf({ origin: 'https://evil"><svg onload=1>' }),
      view({ line: { ...view().line, groupId: 'C" autofocus onfocus="alert(1)', groupName: "<u>名稱</u>" } }),
      admins(),
    );
    expect(html).toContain('value="C&quot; autofocus onfocus=&quot;alert(1)"');
    expect(html).toContain("&lt;u&gt;名稱&lt;/u&gt;");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<u>名稱</u>");
    expect(html).toContain(`https://evil&quot;&gt;&lt;svg onload=1&gt;${WEBHOOK_PATH}`);
  });

  it("沒有 token／secret 時 placeholder 是空的；有但沒有尾碼（太短）時只說「已設定」", () => {
    const none = renderSettingsPage(ctxOf(), view({ line: { ...view().line, channelAccessToken: { configured: false, last4: null }, channelSecret: { configured: false, last4: null } } }), admins());
    expect(none).toContain('placeholder=""');
    expect(none).not.toContain('placeholder="已設定');
    const short = renderSettingsPage(ctxOf(), view({ line: { ...view().line, channelAccessToken: { configured: true, last4: null } } }), admins());
    expect(short).toContain('placeholder="已設定；留空表示不變"');
  });

  it("頁面絕不含 token／secret 的完整內容這種東西（view 裡本來就沒有，這裡確認輸出的結構只有「已設定」文字）", () => {
    const html = renderSettingsPage(ctxOf(), view(), admins());
    expect(html).toContain("已設定（尾碼 …wxyz）");
    expect(html).toContain("已設定（尾碼 …abcd）");
  });
});

describe("頁面共通", () => {
  it("明文 http 的警告只在 insecure 為 true 時出現（五種頁面都是）", () => {
    for (const render of [
      (insecure: boolean) => renderUnavailablePage(ctxOf({ insecure })),
      (insecure: boolean) => renderSetupPage(ctxOf({ insecure })),
      (insecure: boolean) => renderUpgradePage(ctxOf({ insecure })),
      (insecure: boolean) => renderLoginPage(ctxOf({ insecure })),
      (insecure: boolean) => renderSettingsPage(ctxOf({ insecure }), view(), admins()),
    ]) {
      expect(render(true)).toContain('id="insecure-notice"');
      expect(render(false)).not.toContain('id="insecure-notice"');
    }
    expect(renderLoginPage(ctxOf())).not.toContain('id="insecure-notice"'); // 沒給就是沒有
  });

  it("資料目錄不是掛載的 Volume：狀態列顯示警告與說明；是或判斷不出來則沒有", () => {
    const warn = renderSettingsPage(ctxOf(), view({ dataDirMounted: false }), admins());
    expect(warn).toContain("資料目錄：不是掛載的 Volume");
    expect(warn).toContain("重新部署後設定會消失");
    expect(renderSettingsPage(ctxOf(), view({ dataDirMounted: true }), admins())).not.toContain("不是掛載的 Volume");
    expect(renderSettingsPage(ctxOf(), view({ dataDirMounted: null }), admins())).not.toContain("不是掛載的 Volume");
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

describe("各頁面的表單欄位", () => {
  it("建立第一位管理員（全新安裝）：設定碼、姓名、Email、密碼、確認密碼", () => {
    const html = renderSetupPage(ctxOf());
    for (const id of ["setup-form", "setup-code", "setup-name", "setup-email", "setup-password", "setup-password2", "setup-msg"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('type="email" id="setup-email"');
    expect(html).toContain("找「[settings] 尚未設定管理密碼」那一行"); // 和啟動 log 的那一行一致
  });

  it("升級舊版密碼：目前的密碼、姓名、Email，並說明密碼沿用、不需要重設", () => {
    const html = renderUpgradePage(ctxOf());
    for (const id of ["upgrade-form", "upgrade-password", "upgrade-name", "upgrade-email", "upgrade-msg"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('type="email" id="upgrade-email"');
    expect(html).toContain("密碼沿用目前這個，不需要重設");
    expect(html).not.toContain('id="login-form"');
    expect(html).not.toContain('id="setup-form"');
  });

  it("登入頁：Email＋密碼（不再是只有密碼）", () => {
    const html = renderLoginPage(ctxOf());
    for (const id of ["login-form", "login-email", "login-password", "login-msg"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('type="email" id="login-email"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain("README 的「忘記所有密碼時的復原方式」");
  });
});

describe("設定頁的「管理員」與「我的帳號」區塊", () => {
  const rowFor = (html: string, email: string) => {
    const rows = html.split("<tr>").slice(1);
    const row = rows.find((r) => r.includes(`data-email="${email}"`));
    if (!row) throw new Error(`找不到 ${email} 那一列`);
    return row.split("</tr>")[0]!; // 只留這一列（不要把後面的頁面內容算進來）
  };

  it("表格欄位：姓名、Email、狀態、最後登入、操作；有「新增管理員」按鈕與預設隱藏的編輯面板", () => {
    const html = renderSettingsPage(ctxOf(), view(), admins());
    expect(html).toContain("<th>姓名</th><th>Email</th><th>狀態</th><th>最後登入</th><th>操作</th>");
    expect(html).toContain('id="admin-add"');
    expect(html).toContain('id="admin-editor" hidden');
    for (const id of ["ae-name", "ae-email", "ae-password", "ae-password2", "ae-submit", "ae-cancel", "admin-form"]) expect(html).toContain(`id="${id}"`);
  });

  it("每位管理員一列：姓名、Email、狀態（啟用／停用）、最後登入（台北時間，沒登入過是 —）", () => {
    const html = renderSettingsPage(ctxOf(), view(), [admin(), admin({ id: OTHER_ID, name: "第二位", email: "second@example.test", status: "disabled", lastLoginAt: "2026-10-05T07:20:00.000Z" })]);
    const me = rowFor(html, "admin@example.test");
    expect(me).toContain("測試管理員");
    expect(me).toContain('<span class="chip ok">啟用</span>');
    expect(me).toContain("<td>—</td>");
    const other = rowFor(html, "second@example.test");
    expect(other).toContain("第二位");
    expect(other).toContain('<span class="chip bad">停用</span>');
    expect(other).toContain("2026-10-05 15:20");
    expect(other).toContain('data-admin-action="toggle" data-status="disabled"');
    expect(other).toContain(">啟用</button>"); // 停用中的帳號，按鈕是「啟用」
  });

  it("自己那一列標示「（你）」；重設密碼、停用、刪除三個按鈕是停用的（只能編輯）；別人的列四個按鈕都能按", () => {
    const html = renderSettingsPage(ctxOf(), view(), admins());
    const me = rowFor(html, "admin@example.test");
    expect(me).toContain("（你）");
    for (const action of ["reset", "toggle", "delete"]) expect(me).toMatch(new RegExp(`data-admin-action="${action}"[^>]*disabled`));
    expect(me).not.toMatch(/data-admin-action="edit"[^>]*disabled/);
    const other = rowFor(html, "second@example.test");
    expect(other).not.toContain("（你）");
    expect(other).not.toContain("disabled");
    for (const action of ["edit", "reset", "toggle", "delete"]) expect(other).toContain(`data-admin-action="${action}"`);
  });

  it("按鈕帶的是帳號 id、姓名、Email 的 data 屬性（供 script 取用；伺服器端的規則才是真正的防線）", () => {
    const html = renderSettingsPage(ctxOf(), view(), admins());
    const other = rowFor(html, "second@example.test");
    expect(other).toContain(`data-id="${OTHER_ID}"`);
    expect(other).toContain('data-name="第二位"');
  });

  it("沒有任何地方輸出密碼雜湊（AdminPublic 本來就沒有，這裡確認頁面也沒有）", () => {
    const html = renderSettingsPage(ctxOf(), view(), admins());
    expect(html).not.toContain("scrypt$");
    expect(html).not.toContain("passwordHash");
    expect(html).not.toContain("sessionVersion");
  });

  it("姓名與 Email 都跳脫（惡意姓名不會變成標籤或截斷屬性）", () => {
    const evil = admin({ id: OTHER_ID, name: '<img src=x onerror=alert(1)>"\'', email: 'a"><svg onload=1>@example.test' });
    const html = renderSettingsPage(ctxOf(), view(), [admin(), evil]);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;");
    expect(html).toContain('data-name="&lt;img src=x onerror=alert(1)&gt;&quot;&#39;"');
    expect(html).toContain('data-email="a&quot;&gt;&lt;svg onload=1&gt;@example.test"');
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });

  it("「我的帳號」：顯示登入者的姓名與 Email、變更密碼表單、登出", () => {
    const html = renderSettingsPage(ctxOf(), view({ me: { id: ME_ID, name: "我自己<b>", email: "me@example.test" } }), admins());
    expect(html).toContain('<strong id="me-name">我自己&lt;b&gt;</strong>');
    expect(html).toContain('<strong id="me-email" class="mono">me@example.test</strong>');
    for (const id of ["password-form", "current-password", "new-password", "new-password2", "logout"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("變更我的密碼");
  });

  it("狀態列顯示管理員數", () => {
    expect(renderSettingsPage(ctxOf(), view({ adminCount: 3 }), admins())).toContain("管理員：3 位");
  });

  it("頁面的 script 有刪除與停用的二次確認（confirm），啟用不用確認", () => {
    const script = SCRIPT_RE.exec(renderSettingsPage(ctxOf(), view(), admins()))![2]!;
    expect(script).toContain("window.confirm('確定要停用 '");
    expect(script).toContain("window.confirm('確定要刪除 '");
    expect(script).toContain("next === 'disabled' &&"); // 只有停用才確認
  });
});
