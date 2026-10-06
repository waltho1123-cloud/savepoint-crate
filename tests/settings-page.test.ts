import { describe, expect, it } from "vitest";

import type { AccountPublic } from "../src/accounts.js";
import type { SettingsView } from "../src/line-settings.js";
import {
  escapeHtml,
  pageSecurityHeaders,
  renderAccountPage,
  renderForbiddenPage,
  renderLoginPage,
  renderNoAccountsPage,
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

function admin(overrides: Partial<AccountPublic> = {}): AccountPublic {
  return { id: ME_ID, name: "測試管理員", email: "admin@example.test", role: "admin", status: "active", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", lastLoginAt: null, ...overrides };
}

/** 預設的管理員清單：自己（ME_ID）＋另一位。 */
function accounts(): AccountPublic[] {
  return [admin(), admin({ id: OTHER_ID, name: "第二位", email: "second@example.test", lastLoginAt: "2026-10-05T07:20:00.000Z" })];
}

function view(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    dataDirWritable: true,
    dataDirMounted: true,
    adminConfigured: true,
    adminCount: 2,
    accountCount: 3,
    legacyAdminPending: false,
    me: { id: ME_ID, name: "測試管理員", email: "admin@example.test", role: "admin" },
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

  const evilAdmins = (tag: string): AccountPublic[] => [
    admin({ id: ME_ID, name: `${tag}-me-name`, email: `${tag}-me-email` }),
    admin({ id: OTHER_ID, name: `${tag}-other-name`, email: `${tag}-other-email`, lastLoginAt: tag }),
  ];

  const renders = (tag: string) => [
    renderUnavailablePage(ctxOf({ origin: tag, nonce: "n1" })),
    renderSetupPage(ctxOf({ origin: tag, nonce: "n1" })),
    renderUpgradePage(ctxOf({ origin: tag, nonce: "n1" })),
    renderLoginPage(ctxOf({ origin: tag, nonce: "n1" }), `/${tag}`),
    renderNoAccountsPage(ctxOf({ origin: tag, nonce: "n1" }), true),
    renderForbiddenPage(ctxOf({ origin: tag, nonce: "n1" }), { name: `${tag}-user-name`, role: "user" }),
    renderAccountPage(ctxOf({ origin: tag, nonce: "n1" }), { name: `${tag}-me-name`, email: `${tag}-me-email`, role: "user" }),
    renderSettingsPage(ctxOf({ origin: tag, nonce: "n1" }), { ...evilView(tag), me: { id: ME_ID, name: `${tag}-me-name`, email: `${tag}-me-email`, role: "admin" } }, evilAdmins(tag)),
  ];

  it("所有頁面：換掉所有動態值（網址、姓名、Email、next、群組名稱、ID、尾碼…）之後，script 本文逐字相同，而且不含那些值", () => {
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
      accounts(),
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
      accounts(),
    );
    expect(html).toContain('placeholder="已設定（尾碼 …&quot;&gt;&lt;x）；留空表示不變"');
    expect(html).toContain('placeholder="已設定（尾碼 …&amp;&#39;&lt;&gt;）；留空表示不變"');
    expect(html).not.toContain('…"><x');
  });

  it("群組 ID 欄位的 value、群組名稱、網址：跳脫", () => {
    const html = renderSettingsPage(
      ctxOf({ origin: 'https://evil"><svg onload=1>' }),
      view({ line: { ...view().line, groupId: 'C" autofocus onfocus="alert(1)', groupName: "<u>名稱</u>" } }),
      accounts(),
    );
    expect(html).toContain('value="C&quot; autofocus onfocus=&quot;alert(1)"');
    expect(html).toContain("&lt;u&gt;名稱&lt;/u&gt;");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<u>名稱</u>");
    expect(html).toContain(`https://evil&quot;&gt;&lt;svg onload=1&gt;${WEBHOOK_PATH}`);
  });

  it("沒有 token／secret 時 placeholder 是空的；有但沒有尾碼（太短）時只說「已設定」", () => {
    const none = renderSettingsPage(ctxOf(), view({ line: { ...view().line, channelAccessToken: { configured: false, last4: null }, channelSecret: { configured: false, last4: null } } }), accounts());
    expect(none).toContain('placeholder=""');
    expect(none).not.toContain('placeholder="已設定');
    const short = renderSettingsPage(ctxOf(), view({ line: { ...view().line, channelAccessToken: { configured: true, last4: null } } }), accounts());
    expect(short).toContain('placeholder="已設定；留空表示不變"');
  });

  it("頁面絕不含 token／secret 的完整內容這種東西（view 裡本來就沒有，這裡確認輸出的結構只有「已設定」文字）", () => {
    const html = renderSettingsPage(ctxOf(), view(), accounts());
    expect(html).toContain("已設定（尾碼 …wxyz）");
    expect(html).toContain("已設定（尾碼 …abcd）");
  });
});

describe("頁面共通", () => {
  it("明文 http 的警告只在 insecure 為 true 時出現（所有頁面都是）", () => {
    for (const render of [
      (insecure: boolean) => renderUnavailablePage(ctxOf({ insecure })),
      (insecure: boolean) => renderSetupPage(ctxOf({ insecure })),
      (insecure: boolean) => renderUpgradePage(ctxOf({ insecure })),
      (insecure: boolean) => renderLoginPage(ctxOf({ insecure })),
      (insecure: boolean) => renderNoAccountsPage(ctxOf({ insecure }), false),
      (insecure: boolean) => renderForbiddenPage(ctxOf({ insecure }), { name: "甲", role: "user" }),
      (insecure: boolean) => renderAccountPage(ctxOf({ insecure }), { name: "甲", email: "a@example.test", role: "user" }),
      (insecure: boolean) => renderSettingsPage(ctxOf({ insecure }), view(), accounts()),
    ]) {
      expect(render(true)).toContain('id="insecure-notice"');
      expect(render(false)).not.toContain('id="insecure-notice"');
    }
    expect(renderLoginPage(ctxOf())).not.toContain('id="insecure-notice"'); // 沒給就是沒有
  });

  it("資料目錄不是掛載的 Volume：狀態列顯示警告與說明；是或判斷不出來則沒有", () => {
    const warn = renderSettingsPage(ctxOf(), view({ dataDirMounted: false }), accounts());
    expect(warn).toContain("資料目錄：不是掛載的 Volume");
    expect(warn).toContain("重新部署後設定會消失");
    expect(renderSettingsPage(ctxOf(), view({ dataDirMounted: true }), accounts())).not.toContain("不是掛載的 Volume");
    expect(renderSettingsPage(ctxOf(), view({ dataDirMounted: null }), accounts())).not.toContain("不是掛載的 Volume");
  });

  it("安全標頭：CSP 的 script-src 只有這次的 nonce，沒有 unsafe-inline／unsafe-eval，並禁止嵌入與表單送出", () => {
    const headers = pageSecurityHeaders("N0nce+/=");
    const csp = headers["Content-Security-Policy"]!;
    expect(csp).toContain("script-src 'nonce-N0nce+/='");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    for (const directive of ["default-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'", "connect-src 'self'"]) {
      expect(csp).toContain(directive);
    }
    // WIWI 配色 token 是同源的 /assets/wiwi-colors.css（style-src 'self'），頁面自己的樣式仍是 inline；Logo 是同源圖片（img-src 'self'）
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toMatch(/(?:default|style|img|script)-src[^;]*\*/); // 沒有萬用字元來源
    expect(csp).not.toMatch(/https?:/); // 沒有放行任何外部網域
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

  it("登入頁：Email＋密碼（不再是只有密碼）；標題是程式名稱，不是「設定」", () => {
    const html = renderLoginPage(ctxOf());
    for (const id of ["login-form", "login-email", "login-password", "login-msg"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('type="email" id="login-email"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain("README 的「忘記所有密碼時的復原方式」");
    expect(html).toContain("<title>登入 - IPAS 庫存盤點裝箱系統</title>");
    expect(html).toContain("<h1>IPAS 庫存盤點裝箱系統</h1>");
    expect(html).not.toContain("savepoint-crate 設定");
  });

  it("登入頁的 next：預設（/）不輸出；有值時放在表單的 data-next 屬性（跳脫），不會進到 script", () => {
    expect(renderLoginPage(ctxOf())).not.toContain('data-next="');
    expect(renderLoginPage(ctxOf(), "/")).not.toContain('data-next="');
    const html = renderLoginPage(ctxOf(), '/zz-sentinel?a="><img src=x>');
    expect(html).toContain('<form id="login-form" data-next="/zz-sentinel?a=&quot;&gt;&lt;img src=x&gt;">');
    expect(html).not.toContain("<img src=x");
    expect(SCRIPT_RE.exec(html)![2]).not.toContain("zz-sentinel");
  });

  it("還沒有任何帳號的登入頁：沒有登入表單，說明請管理員先到設定頁（全新安裝 vs 舊密碼待升級各有自己的說法），並有連結", () => {
    const fresh = renderNoAccountsPage(ctxOf(), false);
    const legacy = renderNoAccountsPage(ctxOf(), true);
    for (const html of [fresh, legacy]) {
      expect(html).toContain("尚未建立任何帳號");
      expect(html).toContain('<a class="btn primary" href="/settings">前往設定頁</a>');
      expect(html).not.toContain('id="login-form"');
    }
    expect(fresh).toContain("設定碼");
    expect(fresh).not.toContain("升級成管理員帳號");
    expect(legacy).toContain("用目前正在使用的管理密碼升級成管理員帳號");
  });

  it("一般使用者的 403 頁：說明需要管理員權限、顯示姓名與角色；導覽沒有「設定」連結", () => {
    const html = renderForbiddenPage(ctxOf(), { name: "小明<b>", role: "user" });
    expect(html).toContain("需要管理員權限");
    expect(html).toContain("小明&lt;b&gt;");
    expect(html).not.toContain("小明<b>");
    expect(html).toContain('<span class="who">👤 小明&lt;b&gt;（一般使用者）</span>');
    expect(html).toContain('<a class="btn primary" href="/">回裝箱程式</a>');
    expect(html).toContain('href="/account"');
    expect(html).not.toContain('href="/settings"');
    expect(html).toContain('id="logout"');
    expect(html).toContain("可以使用裝箱程式；需要調整 LINE 通知、帳號或密碼的話，請洽管理員。"); // 密碼也是找管理員
    expect(html).not.toContain("變更自己的密碼");
  });

  it("我的帳號頁：姓名、Email、角色（唯讀）與「密碼由管理員統一設定，需要變更請洽管理員」；沒有任何表單；導覽（管理員才有「設定」連結，沒有「我的帳號」連結——就在這頁）", () => {
    const user = renderAccountPage(ctxOf(), { name: "小明", email: "ming@example.test", role: "user" });
    expect(user).toContain('<strong id="me-name">小明</strong>');
    expect(user).toContain('<strong id="me-email" class="mono">ming@example.test</strong>');
    expect(user).toContain('<strong id="me-role">一般使用者</strong>');
    expect(user).toContain('<p class="note" id="password-policy">密碼由管理員統一設定，需要變更請洽管理員。</p>');
    expect(user).toContain("要修改姓名、Email 或角色，請洽管理員");
    expect(user).not.toMatch(/<form|<input|<textarea|<select/);
    for (const id of ["password-form", "current-password", "new-password", "new-password2", "password-msg"]) expect(user).not.toContain(`id="${id}"`);
    expect(user).not.toContain("變更我的密碼");
    expect(user).toContain('id="logout"');
    expect(user).not.toContain('href="/settings"');
    expect(user).not.toContain('href="/account"');
    expect(user).toContain('href="/"');
    const admin = renderAccountPage(ctxOf(), { name: "老闆", email: "boss@example.test", role: "admin" });
    expect(admin).toContain('<strong id="me-role">管理員</strong>');
    expect(admin).toContain('href="/settings"');
    expect(admin).toContain("密碼由管理員統一設定，需要變更請洽管理員");
    expect(admin).not.toMatch(/<form|<input|<textarea|<select/);
  });

  it("我的帳號頁的姓名與 Email 一律跳脫（含 script 標籤與引號）", () => {
    const html = renderAccountPage(ctxOf(), { name: '<img src=x onerror=alert(1)>"\'', email: '"><svg onload=1>@example.test', role: "user" });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;");
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });
});

describe("設定頁的「帳號管理」區塊", () => {
  const rowFor = (html: string, email: string) => {
    const rows = html.split("<tr>").slice(1);
    const row = rows.find((r) => r.includes(`data-email="${email}"`));
    if (!row) throw new Error(`找不到 ${email} 那一列`);
    return row.split("</tr>")[0]!; // 只留這一列（不要把後面的頁面內容算進來）
  };

  it("表格欄位：姓名、Email、角色、狀態、最後登入、操作；有「新增帳號」按鈕與預設隱藏的編輯面板（含角色下拉）", () => {
    const html = renderSettingsPage(ctxOf(), view(), accounts());
    expect(html).toContain("<th>姓名</th><th>Email</th><th>角色</th><th>狀態</th><th>最後登入</th><th>操作</th>");
    expect(html).toContain("<h2>帳號管理</h2>");
    expect(html).toContain('id="admin-add">新增帳號</button>');
    expect(html).toContain('id="admin-editor" hidden');
    for (const id of ["ae-name", "ae-email", "ae-role", "ae-password", "ae-password2", "ae-submit", "ae-cancel", "admin-form"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('<option value="user">一般使用者（只能使用裝箱程式）</option>');
    expect(html).toContain('<option value="admin">管理員（可進設定頁、管理帳號）</option>');
  });

  it("角色欄：管理員與一般使用者各有標籤；按鈕帶 data-role 與 data-me（供 script 決定編輯面板的角色下拉要不要停用）", () => {
    const html = renderSettingsPage(ctxOf(), view(), [admin(), admin({ id: OTHER_ID, name: "同事", email: "user@example.test", role: "user" })]);
    expect(rowFor(html, "admin@example.test")).toContain('<span class="chip admin">管理員</span>');
    expect(rowFor(html, "admin@example.test")).toContain('data-role="admin" data-me="1"');
    expect(rowFor(html, "user@example.test")).toContain('<span class="chip user">一般使用者</span>');
    expect(rowFor(html, "user@example.test")).toContain('data-role="user" data-me="0"');
  });

  it("每個帳號一列：姓名、Email、狀態（啟用／停用）、最後登入（台北時間，沒登入過是 —）", () => {
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

  it("自己那一列標示「（你）」；停用、刪除兩個按鈕是停用的；編輯與「重設密碼」可以按（管理員重設自己的密碼，是唯一改自己密碼的途徑）；別人的列四個按鈕都能按", () => {
    const html = renderSettingsPage(ctxOf(), view(), accounts());
    const me = rowFor(html, "admin@example.test");
    expect(me).toContain("（你）");
    for (const action of ["toggle", "delete"]) expect(me).toMatch(new RegExp(`data-admin-action="${action}"[^>]*disabled`));
    for (const action of ["edit", "reset"]) expect(me).not.toMatch(new RegExp(`data-admin-action="${action}"[^>]*disabled`));
    expect(me).toMatch(/data-admin-action="reset"[^>]*title="重設你自己的密碼：這個瀏覽器維持登入，其他裝置上的登入會失效"/);
    expect(me).toMatch(/data-admin-action="reset"[^>]*data-me="1"/);
    const other = rowFor(html, "second@example.test");
    expect(other).not.toContain("（你）");
    expect(other).not.toContain("disabled");
    for (const action of ["edit", "reset", "toggle", "delete"]) expect(other).toContain(`data-admin-action="${action}"`);
  });

  it("按鈕帶的是帳號 id、姓名、Email 的 data 屬性（供 script 取用；伺服器端的規則才是真正的防線）", () => {
    const html = renderSettingsPage(ctxOf(), view(), accounts());
    const other = rowFor(html, "second@example.test");
    expect(other).toContain(`data-id="${OTHER_ID}"`);
    expect(other).toContain('data-name="第二位"');
  });

  it("沒有任何地方輸出密碼雜湊（AccountPublic 本來就沒有，這裡確認頁面也沒有）", () => {
    const html = renderSettingsPage(ctxOf(), view(), accounts());
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

  it("頂端導覽：登入者的姓名與角色（跳脫）、回裝箱程式、我的帳號、登出；設定頁沒有任何改密碼表單（密碼只由管理員在「帳號管理」設定）", () => {
    const html = renderSettingsPage(ctxOf(), view({ me: { id: ME_ID, name: "我自己<b>", email: "me@example.test", role: "admin" } }), accounts());
    expect(html).toContain('<span class="who">👤 我自己&lt;b&gt;（管理員）</span>');
    expect(html).not.toContain("我自己<b>");
    expect(html).toContain('<a href="/">裝箱程式</a>');
    expect(html).toContain('<a href="/account">我的帳號</a>');
    expect(html).not.toContain('<a href="/settings">'); // 已經在設定頁
    expect(html).toContain('id="logout"');
    for (const id of ["password-form", "current-password", "me-name"]) expect(html).not.toContain(`id="${id}"`);
  });

  it("狀態列顯示帳號數與管理員數", () => {
    expect(renderSettingsPage(ctxOf(), view({ adminCount: 3, accountCount: 12 }), accounts())).toContain("帳號：12 個（管理員 3 位）");
  });

  it("頁面的 script 有刪除與停用的二次確認（confirm），啟用不用確認", () => {
    const script = SCRIPT_RE.exec(renderSettingsPage(ctxOf(), view(), accounts()))![2]!;
    expect(script).toContain("window.confirm('確定要停用 '");
    expect(script).toContain("window.confirm('確定要刪除 '");
    expect(script).toContain("next === 'disabled' &&"); // 只有停用才確認
  });

  it("503 頁（資料目錄不可用）：說明登入、裝箱程式、設定頁都暫時無法使用，只有 /healthz 與 LINE webhook 不受影響（不再說 OCR、存檔不受影響）", () => {
    const html = renderUnavailablePage(ctxOf());
    expect(html).toContain("<h2>目前無法使用</h2>");
    expect(html).toContain("請在 Zeabur 掛載 Volume 到 /app/data");
    expect(html).toContain("登入、裝箱程式（OCR 辨識、存檔到商品主檔、關箱通知）與設定頁目前都無法使用");
    expect(html).toContain('<span class="mono">/healthz</span> 與 LINE webhook 不受影響');
    expect(html).not.toContain("都不受影響"); // 舊的說法：OCR、存檔、LINE 通知都不受影響
    expect(html).not.toContain("目前無法使用設定頁");
  });

  it("升級頁的說明指向「帳號管理」（不是已經改名的「管理員」區塊）", () => {
    const html = renderUpgradePage(ctxOf());
    expect(html).toContain("設定頁的「帳號管理」替其他同事建立帳號");
    expect(html).not.toContain("「管理員」區塊");
  });

  it("頁面的 script 的角色處理：新增帳號一定送出所選的角色；編輯自己時角色下拉停用、而且不送 role（伺服器端也會擋）；登入成功後回到 data-next", () => {
    const script = SCRIPT_RE.exec(renderSettingsPage(ctxOf(), view(), accounts()))![2]!;
    expect(script).toContain("{ name: $('ae-name').value, email: $('ae-email').value, role: $('ae-role').value, password: pw }"); // 新增：帶角色
    expect(script).toContain("$('ae-role').disabled = nextMode === 'edit' && isMe;"); // 自己那一列不能改自己的角色
    expect(script).toContain("if (!$('ae-role').disabled) patch.role = $('ae-role').value;"); // 停用的下拉不送 role
    expect(script).toContain("var wanted = $('login-form').getAttribute('data-next') || '/';"); // 登入後回到被導向前要去的位置
  });

  it("頁面的 script：重設密碼的編輯面板記住是不是自己；對自己重設的成功訊息說「這個瀏覽器維持登入」，對別人說「對方所有裝置上的登入都已失效」", () => {
    const script = SCRIPT_RE.exec(renderSettingsPage(ctxOf(), view(), accounts()))![2]!;
    expect(script).toContain("targetIsMe = !!isMe;"); // 打開面板時記住
    expect(script).toContain("targetIsMe = false;"); // 關閉面板時清掉
    expect(script).toContain("'重設密碼：' + email + (isMe ? '（你自己）' : '')");
    expect(script).toContain("targetIsMe ? '你的密碼已重設；你在其他裝置上的登入都已失效（這個瀏覽器維持登入）' : '密碼已重設；對方所有裝置上的登入都已失效'");
    expect(script).toContain("request('POST', '/api/accounts/' + targetId + '/password', { newPassword: pw })"); // 自己或別人都打同一支
  });

  it("帳號管理的說明：密碼只由管理員設定（個人不能自己改），管理員可以重設任何人的、包括自己的（不再說一般使用者可以變更自己的密碼）", () => {
    const html = renderSettingsPage(ctxOf(), view(), accounts());
    expect(html).toContain("<strong>密碼只由管理員設定</strong>：個人不能自己改密碼，需要變更時由管理員在這裡「重設密碼」（包括管理員自己的）");
    expect(html).toContain("重設自己的密碼時，這個瀏覽器維持登入");
    expect(html).not.toContain("與變更自己的密碼");
    expect(html).not.toContain("變更我的密碼");
  });

  it("頁面的 script 打的是這些端點：/login、/logout、/api/accounts*（沒有任何改自己密碼的端點：/account/password、/settings/password，也沒有舊的 /settings/login、/api/admins）", () => {
    const script = SCRIPT_RE.exec(renderSettingsPage(ctxOf(), view(), accounts()))![2]!;
    for (const url of ["'/login'", "'/logout'", "'/api/accounts'", "'/api/accounts/' + id + '/status'", "'/api/accounts/' + targetId + '/password'"]) expect(script, url).toContain(url);
    for (const old of ["/settings/login", "/settings/logout", "/settings/password", "/account/password", "/api/admins"]) expect(script, old).not.toContain(old);
    for (const gone of ["password-form", "$('current-password')", "$('new-password", "password-msg"]) expect(script, gone).not.toContain(gone); // 改密碼表單的處理已整段移除
    expect(script).toContain("location.href = (r.data && typeof r.data.next === 'string' && r.data.next) || '/'"); // 登入成功後回到 next
  });
});
