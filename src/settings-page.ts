import { roleLabel, type AccountPublic } from "./accounts.js";
import type { SettingsView } from "./line-settings.js";
import { formatTaipeiTime } from "./line.js";
import { DATA_DIR_UNAVAILABLE_MESSAGE, type Account } from "./settings-store.js";

/**
 * 伺服器端組字串的 HTML 頁面（不用任何前端框架），共用同一份樣式與同一段 script：
 *   /login → 登入頁（Email＋密碼；還沒有任何帳號時改顯示「請管理員先到設定頁」）；
 *   /account → 我的帳號（姓名、Email、角色、變更我的密碼；任一角色）；
 *   /settings → 設定頁（管理員）：unavailable＝沒有資料目錄（要掛 Volume）；setup＝全新安裝，用設定碼建立第一位管理員；
 *     upgrade＝還有舊版的單一管理密碼，要升級成管理員帳號；forbidden＝登入的是一般使用者；
 *     settings＝LINE 設定、帳號管理。
 * 所有動態內容（姓名、Email、群組名稱、網址、群組 ID、next…）一律經過 escapeHtml；頁面內的 script 是固定字串、靠 CSP nonce 執行，
 * 不使用 inline 事件屬性。
 */

export const WEBHOOK_PATH = "/api/line/webhook";

export function escapeHtml(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
  return value.replace(/[&<>"'`]/g, (ch) => entities[ch] ?? ch);
}

/** 設定頁回應要帶的安全標頭；script 只允許帶這次 nonce 的那一段。 */
export function pageSecurityHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'", // 即使 script 沒載入，表單也不會被瀏覽器原生送出（密碼不會跑進網址）
      "frame-ancestors 'none'",
    ].join("; "),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export interface PageContext {
  /** CSP nonce（每個請求隨機產生）。 */
  nonce: string;
  /** 對外網址（scheme://host），用來顯示 webhook 網址。 */
  origin: string;
  /** 目前是公開網域上的明文 http（或代理沒送 X-Forwarded-Proto）：頁面頂端顯示警告。 */
  insecure?: boolean;
}

const CSS = `
:root{--primary:#3ab5ec;--primary-dark:#1a9fd8;--bg:#eef5fa;--card:#fff;--text:#0c1e2e;--muted:#5e7d94;--line:rgba(0,0,0,.09);--radius:16px;--radius-sm:10px}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang TC","Noto Sans TC",Roboto,sans-serif;line-height:1.6;font-size:16px}
.wrap{max-width:640px;margin:0 auto;padding:16px 16px 48px}
h1{font-size:1.35rem;margin:.5rem 0 .1rem}
h2{font-size:1.05rem;margin:0 0 .5rem}
.sub{color:var(--muted);margin:0 0 .6rem;font-size:.9rem}
.card{background:var(--card);border-radius:var(--radius);padding:18px 18px 16px;margin:14px 0;box-shadow:0 8px 32px rgba(14,120,180,.08)}
label{display:block;font-weight:600;font-size:.9rem;margin:14px 0 6px}
input[type=text],input[type=password],input[type=email]{width:100%;min-height:44px;padding:10px 12px;font-size:1rem;border:1.5px solid var(--line);border-radius:var(--radius-sm);background:#fff;color:var(--text)}
input[type=text]:focus,input[type=password]:focus,input[type=email]:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(58,181,236,.23)}
.mono{font-family:'SF Mono','Fira Code',ui-monospace,monospace;font-size:.88rem;word-break:break-all}
.check{display:flex;align-items:center;gap:8px;font-weight:500;margin:10px 0 0;font-size:.95rem}
.check input{width:20px;height:20px;margin:0}
.btn{min-height:44px;padding:0 18px;border:0;border-radius:var(--radius-sm);font-size:1rem;font-weight:600;cursor:pointer;background:#e3eef6;color:var(--text)}
.btn.primary{background:var(--primary);color:#fff}
.btn.small{min-height:36px;padding:0 12px;font-size:.9rem}
.btn.danger{background:#fde4e9;color:#be123c}
.btn:disabled{opacity:.55;cursor:not-allowed}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.msg{margin:12px 0 0;padding:10px 12px;border-radius:var(--radius-sm);font-size:.92rem}
.msg.ok{background:#d1fae5;color:#065f46}
.msg.err{background:#ffe4e6;color:#9f1239}
.note{background:#eaf6fd;color:#0b5f87;padding:10px 12px;border-radius:var(--radius-sm);font-size:.9rem;margin:10px 0 0}
.note.warn{background:#fef3c7;color:#92400e}
.muted{color:var(--muted);font-size:.9rem;margin:.4rem 0 0}
.chips{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:5px 11px;border-radius:999px;font-size:.85rem;font-weight:600;background:#e3eef6;color:#2b4a60}
.chip.ok{background:#d1fae5;color:#065f46}
.chip.bad{background:#ffe4e6;color:#9f1239}
.chip.warn{background:#fef3c7;color:#92400e}
.groups{list-style:none;padding:0;margin:0}
.groups li{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--line)}
.groups li:first-child{border-top:0}
.gname{font-weight:600}
.urlbox{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.urlbox code{flex:1 1 220px;padding:10px 12px;background:#f3f8fb;border-radius:var(--radius-sm)}
.tablewrap{overflow-x:auto;margin:10px -4px 0}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:8px 6px;vertical-align:middle;border-top:1px solid var(--line)}
th{font-size:.8rem;color:var(--muted);font-weight:600;border-top:0;white-space:nowrap}
td.actions{white-space:nowrap}
td.actions .btn{margin:2px 6px 2px 0}
.me{color:var(--muted);font-size:.85rem}
.chip.admin{background:#e0e7ff;color:#3730a3}
.chip.user{background:#e3eef6;color:#2b4a60}
select{width:100%;min-height:44px;padding:10px 12px;font-size:1rem;border:1.5px solid var(--line);border-radius:var(--radius-sm);background:#fff;color:var(--text)}
select:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(58,181,236,.23)}
.topnav{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:space-between;margin:2px 0 6px;font-size:.92rem}
.topnav .who{color:var(--muted)}
.topnav .links{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}
.topnav a{color:var(--primary-dark);text-decoration:none;font-weight:600}
.topnav a:hover{text-decoration:underline}
.topnav button{min-height:32px;padding:0 12px;font-size:.88rem}
a.btn{display:inline-flex;align-items:center;text-decoration:none}
[hidden]{display:none!important}
`;

/** 頁面用的 script：固定字串（沒有任何伺服器端插入的內容），用字串串接、不用樣板字串，避免和外層樣板字串衝突。 */
const SCRIPT = `
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function request(method, url, payload) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      return res.json().then(function (data) { return data; }, function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }
  function say(id, text, ok) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'msg ' + (ok ? 'ok' : 'err');
    el.hidden = false;
  }
  function failText(r) {
    return (r.data && r.data.error) ? r.data.error : ('發生錯誤（HTTP ' + r.status + '）');
  }
  function offline(msgId, btn) {
    say(msgId, '連線失敗，請稍後再試', false);
    if (btn) btn.disabled = false;
  }
  function sessionLost(r) {
    if (r.status === 401) { location.reload(); return true; }
    return false;
  }
  function onSubmit(formId, handler) {
    var form = $(formId);
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      handler(form.querySelector('button[type=submit]'));
    });
  }

  onSubmit('setup-form', function (btn) {
    var pw = $('setup-password').value;
    if (pw !== $('setup-password2').value) { say('setup-msg', '兩次輸入的密碼不一致', false); return; }
    btn.disabled = true;
    request('POST', '/settings/setup', { setupCode: $('setup-code').value, name: $('setup-name').value, email: $('setup-email').value, password: pw }).then(function (r) {
      if (r.ok) { location.reload(); return; }
      say('setup-msg', failText(r), false);
      btn.disabled = false;
    }, function () { offline('setup-msg', btn); });
  });

  onSubmit('upgrade-form', function (btn) {
    btn.disabled = true;
    request('POST', '/settings/upgrade', { currentPassword: $('upgrade-password').value, name: $('upgrade-name').value, email: $('upgrade-email').value }).then(function (r) {
      if (r.ok) { location.reload(); return; }
      say('upgrade-msg', failText(r), false);
      btn.disabled = false;
    }, function () { offline('upgrade-msg', btn); });
  });

  onSubmit('login-form', function (btn) {
    btn.disabled = true;
    var wanted = $('login-form').getAttribute('data-next') || '/';
    request('POST', '/login', { email: $('login-email').value, password: $('login-password').value, next: wanted }).then(function (r) {
      if (r.ok) { location.href = (r.data && typeof r.data.next === 'string' && r.data.next) || '/'; return; }
      say('login-msg', failText(r), false);
      btn.disabled = false;
    }, function () { offline('login-msg', btn); });
  });

  onSubmit('line-form', function (btn) {
    var payload = { enabled: $('line-enabled').checked, groupId: $('line-group-id').value.trim() };
    var token = $('line-token').value.trim();
    if (token) payload.channelAccessToken = token;
    var secret = $('line-secret').value.trim();
    if (secret) payload.channelSecret = secret;
    if ($('line-token-clear') && $('line-token-clear').checked) payload.clearChannelAccessToken = true;
    if ($('line-secret-clear') && $('line-secret-clear').checked) payload.clearChannelSecret = true;
    btn.disabled = true;
    request('PUT', '/api/settings/line', payload).then(function (r) {
      if (sessionLost(r)) return;
      if (r.ok) {
        say('line-msg', '已儲存', true);
        setTimeout(function () { location.reload(); }, 700);
        return;
      }
      say('line-msg', failText(r), false);
      btn.disabled = false;
    }, function () { offline('line-msg', btn); });
  });

  var testBtn = $('line-test');
  if (testBtn) testBtn.addEventListener('click', function () {
    testBtn.disabled = true;
    say('line-msg', '傳送中…', true);
    request('POST', '/api/settings/line/test', {}).then(function (r) {
      testBtn.disabled = false;
      if (sessionLost(r)) return;
      say('line-msg', r.ok ? '測試訊息已送出，請到 LINE 群組確認' : failText(r), r.ok);
    }, function () { offline('line-msg', testBtn); });
  });

  var useButtons = document.querySelectorAll('[data-use-group]');
  for (var i = 0; i < useButtons.length; i++) {
    useButtons[i].addEventListener('click', function (event) {
      var b = event.currentTarget;
      $('line-group-id').value = b.getAttribute('data-use-group');
      $('line-group-name').textContent = b.getAttribute('data-group-name') || '（儲存時查詢）';
      say('line-msg', '已帶入群組 ID，按「儲存」後才會生效', true);
      $('line-group-id').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  var urlEl = $('webhook-url');
  if (urlEl) urlEl.textContent = location.origin + '/api/line/webhook';
  var copyBtn = $('copy-webhook');
  if (copyBtn && urlEl) copyBtn.addEventListener('click', function () {
    function done(ok) {
      copyBtn.textContent = ok ? '已複製' : '請手動複製';
      setTimeout(function () { copyBtn.textContent = '複製'; }, 1500);
    }
    var text = urlEl.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      return;
    }
    try {
      var range = document.createRange();
      range.selectNodeContents(urlEl);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      done(document.execCommand('copy'));
    } catch (e) { done(false); }
  });

  // ---- 帳號管理：表格上的按鈕（事件委派）與共用的編輯面板（新增／編輯／重設密碼）
  var editor = $('admin-editor');
  var mode = null;
  var targetId = null;
  function setRow(id, visible) { var el = $(id); if (el) el.hidden = !visible; }
  function openEditor(nextMode, id, name, email, role, isMe) {
    mode = nextMode;
    targetId = id;
    var withProfile = nextMode === 'add' || nextMode === 'edit';
    var withPassword = nextMode === 'add' || nextMode === 'reset';
    $('ae-title').textContent = nextMode === 'add' ? '新增帳號' : (nextMode === 'edit' ? '編輯帳號' : '重設密碼：' + email);
    setRow('ae-row-name', withProfile);
    setRow('ae-row-email', withProfile);
    setRow('ae-row-role', withProfile);
    setRow('ae-row-password', withPassword);
    $('ae-name').value = nextMode === 'edit' ? name : '';
    $('ae-email').value = nextMode === 'edit' ? email : '';
    $('ae-role').value = nextMode === 'edit' ? (role === 'admin' ? 'admin' : 'user') : 'user';
    $('ae-role').disabled = nextMode === 'edit' && isMe;
    $('ae-password').value = '';
    $('ae-password2').value = '';
    $('ae-msg').hidden = true;
    $('ae-submit').disabled = false;
    editor.hidden = false;
    editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var first = withProfile ? $('ae-name') : $('ae-password');
    if (first) first.focus();
  }
  function closeEditor() { if (editor) editor.hidden = true; mode = null; targetId = null; }
  function accountResult(r, btn) {
    if (sessionLost(r)) return;
    if (r.ok) { location.reload(); return; }
    say('admin-msg', failText(r), false);
    if (btn) btn.disabled = false;
  }

  var addBtn = $('admin-add');
  if (addBtn) addBtn.addEventListener('click', function () { openEditor('add', null, '', '', 'user', false); });
  var cancelBtn = $('ae-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);

  var table = $('admin-table');
  if (table) table.addEventListener('click', function (event) {
    var btn = event.target && event.target.closest ? event.target.closest('button[data-admin-action]') : null;
    if (!btn || btn.disabled) return;
    var action = btn.getAttribute('data-admin-action');
    var id = btn.getAttribute('data-id');
    var name = btn.getAttribute('data-name') || '';
    var email = btn.getAttribute('data-email') || '';
    var role = btn.getAttribute('data-role') || 'user';
    var isMe = btn.getAttribute('data-me') === '1';
    if (action === 'edit') { openEditor('edit', id, name, email, role, isMe); return; }
    if (action === 'reset') { openEditor('reset', id, name, email, role, isMe); return; }
    if (action === 'toggle') {
      var next = btn.getAttribute('data-status') === 'active' ? 'disabled' : 'active';
      if (next === 'disabled' && !window.confirm('確定要停用 ' + email + ' 嗎？\\n對方會立刻被登出，也無法再登入，直到你重新啟用。')) return;
      btn.disabled = true;
      request('POST', '/api/accounts/' + id + '/status', { status: next }).then(function (r) { accountResult(r, btn); }, function () { offline('admin-msg', btn); });
      return;
    }
    if (action === 'delete') {
      if (!window.confirm('確定要刪除 ' + email + ' 嗎？\\n這個動作無法復原。')) return;
      btn.disabled = true;
      request('DELETE', '/api/accounts/' + id, {}).then(function (r) { accountResult(r, btn); }, function () { offline('admin-msg', btn); });
    }
  });

  onSubmit('admin-form', function (btn) {
    var pw = $('ae-password').value;
    if ((mode === 'add' || mode === 'reset') && pw !== $('ae-password2').value) { say('ae-msg', '兩次輸入的密碼不一致', false); return; }
    var req;
    if (mode === 'add') req = request('POST', '/api/accounts', { name: $('ae-name').value, email: $('ae-email').value, role: $('ae-role').value, password: pw });
    else if (mode === 'edit') {
      var patch = { name: $('ae-name').value, email: $('ae-email').value };
      if (!$('ae-role').disabled) patch.role = $('ae-role').value;
      req = request('PATCH', '/api/accounts/' + targetId, patch);
    }
    else if (mode === 'reset') req = request('POST', '/api/accounts/' + targetId + '/password', { newPassword: pw });
    else return;
    btn.disabled = true;
    req.then(function (r) {
      if (sessionLost(r)) return;
      if (r.ok) {
        if (mode === 'reset') { say('ae-msg', '密碼已重設；對方所有裝置上的登入都已失效', true); setTimeout(function () { location.reload(); }, 900); return; }
        location.reload();
        return;
      }
      say('ae-msg', failText(r), false);
      btn.disabled = false;
    }, function () { offline('ae-msg', btn); });
  });

  onSubmit('password-form', function (btn) {
    var next = $('new-password').value;
    if (next !== $('new-password2').value) { say('password-msg', '兩次輸入的新密碼不一致', false); return; }
    btn.disabled = true;
    request('POST', '/account/password', { currentPassword: $('current-password').value, newPassword: next }).then(function (r) {
      btn.disabled = false;
      if (sessionLost(r)) return;
      if (r.ok) {
        $('current-password').value = '';
        $('new-password').value = '';
        $('new-password2').value = '';
        say('password-msg', '密碼已更新；你在其他裝置上的登入已全部失效（這個瀏覽器維持登入）', true);
        return;
      }
      say('password-msg', failText(r), false);
    }, function () { offline('password-msg', btn); });
  });

  var logoutBtn = $('logout');
  if (logoutBtn) logoutBtn.addEventListener('click', function () {
    request('POST', '/logout', {}).then(function () { location.href = '/login'; }, function () { location.href = '/login'; });
  });
})();
`;

const INSECURE_NOTICE = `<p class="note warn" id="insecure-notice">目前的連線不是 HTTPS（或反向代理沒有送出 X-Forwarded-Proto: https）：密碼與登入 cookie 可能以明文傳送，cookie 也不會加 Secure。請改用 https:// 網址；如果你已經在用 https，請開 <span class="mono">/healthz</span> 確認 <span class="mono">requestIsHttps</span> 是不是 true。</p>`;

interface LayoutOptions {
  title?: string;
  heading?: string;
  sub?: string;
}

function layout(ctx: PageContext, body: string, options: LayoutOptions = {}): string {
  const heading = options.heading ?? "savepoint-crate 設定";
  const sub = options.sub ?? "管理 LINE 群組通知與帳號";
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(options.title ?? "設定 - savepoint-crate")}</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
<h1>${escapeHtml(heading)}</h1>
<p class="sub">${escapeHtml(sub)}</p>
${ctx.insecure ? INSECURE_NOTICE : ""}
${body}
</main>
<script nonce="${escapeHtml(ctx.nonce)}">${SCRIPT}</script>
</body>
</html>
`;
}

/** 登入頁與帳號頁用的標題（程式名稱與 index.html 的 h1 一致）。 */
const APP_NAME = "IPAS 庫存盤點裝箱系統";

/** 登入後的頁面頂端：誰登入了、回裝箱程式、我的帳號、（管理員）設定、登出。 */
function renderNav(me: Pick<Account, "name" | "role">, current: "account" | "settings" | "forbidden"): string {
  const links = [
    `<a href="/">裝箱程式</a>`,
    ...(current === "account" ? [] : [`<a href="/account">我的帳號</a>`]),
    ...(me.role === "admin" && current !== "settings" ? [`<a href="/settings">設定</a>`] : []),
  ];
  return `<nav class="topnav">
<span class="who">👤 ${escapeHtml(me.name)}（${escapeHtml(roleLabel(me.role))}）</span>
<span class="links">${links.join("")}<button type="button" class="btn small" id="logout">登出</button></span>
</nav>`;
}

export function renderUnavailablePage(ctx: PageContext): string {
  return layout(
    ctx,
    `<section class="card">
<h2>目前無法使用</h2>
<p class="msg err">${escapeHtml(DATA_DIR_UNAVAILABLE_MESSAGE)}</p>
<p class="muted">帳號與設定需要一個「重新部署後仍會保留」的資料目錄；沒有它就沒有地方存帳號，所以登入、裝箱程式（OCR 辨識、存檔到商品主檔、關箱通知）與設定頁目前都無法使用。請管理員在 Zeabur Dashboard 開啟這個服務 → 「硬碟（Volume）」→ 新增，掛載路徑填 <span class="mono">/app/data</span>；儲存後服務會重新啟動，再重新整理這一頁。</p>
<p class="muted">服務本身仍在運作：<span class="mono">/healthz</span> 與 LINE webhook 不受影響。</p>
</section>`,
  );
}

export function renderSetupPage(ctx: PageContext): string {
  return layout(
    ctx,
    `<section class="card">
<h2>第一次使用：建立第一位管理員</h2>
<p class="muted">請輸入服務啟動時寫在記錄（Zeabur：服務 → 記錄）裡的設定碼——找「[settings] 尚未設定管理密碼」那一行。設定碼只存在記憶體，每次服務重新啟動都會產生新的一組。</p>
<form id="setup-form" autocomplete="off">
<label for="setup-code">設定碼</label>
<input type="text" id="setup-code" placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" required>
<label for="setup-name">姓名</label>
<input type="text" id="setup-name" autocomplete="name" maxlength="50" required>
<label for="setup-email">Email（之後用它登入）</label>
<input type="email" id="setup-email" autocomplete="username" spellcheck="false" maxlength="254" required>
<label for="setup-password">密碼（至少 10 個字元）</label>
<input type="password" id="setup-password" autocomplete="new-password" minlength="10" maxlength="200" required>
<label for="setup-password2">再輸入一次密碼</label>
<input type="password" id="setup-password2" autocomplete="new-password" minlength="10" maxlength="200" required>
<div class="row"><button type="submit" class="btn primary">建立管理員並登入</button></div>
<p id="setup-msg" class="msg" role="status" hidden></p>
</form>
</section>`,
  );
}

export function renderUpgradePage(ctx: PageContext): string {
  return layout(
    ctx,
    `<section class="card">
<h2>升級為管理員帳號</h2>
<p class="muted">這個系統已改成「管理員帳號」制：每位管理員有自己的姓名、Email 與密碼。請輸入<strong>目前使用的管理密碼</strong>，再填入你的姓名與 Email，建立第一位管理員——<strong>密碼沿用目前這個，不需要重設</strong>，LINE 設定與其他資料都不會動。升級後舊的單一密碼與舊的登入會失效，之後用 Email 與密碼登入，並可以在設定頁的「帳號管理」替其他同事建立帳號。</p>
<form id="upgrade-form" autocomplete="off">
<label for="upgrade-password">目前的管理密碼</label>
<input type="password" id="upgrade-password" autocomplete="current-password" maxlength="200" required>
<label for="upgrade-name">姓名</label>
<input type="text" id="upgrade-name" autocomplete="name" maxlength="50" required>
<label for="upgrade-email">Email（之後用它登入）</label>
<input type="email" id="upgrade-email" autocomplete="username" spellcheck="false" maxlength="254" required>
<div class="row"><button type="submit" class="btn primary">升級並登入</button></div>
<p id="upgrade-msg" class="msg" role="status" hidden></p>
</form>
</section>`,
  );
}

export function renderLoginPage(ctx: PageContext, next = "/"): string {
  return layout(
    ctx,
    `<section class="card">
<h2>登入</h2>
<form id="login-form"${next === "/" ? "" : ` data-next="${escapeHtml(next)}"`}>
<label for="login-email">Email</label>
<input type="email" id="login-email" autocomplete="username" spellcheck="false" maxlength="254" required>
<label for="login-password">密碼</label>
<input type="password" id="login-password" autocomplete="current-password" maxlength="200" required>
<div class="row"><button type="submit" class="btn primary">登入</button></div>
<p id="login-msg" class="msg" role="status" hidden></p>
</form>
<p class="muted">帳號由管理員建立。忘記密碼：請管理員在設定頁的「帳號管理」幫你重設。所有管理員都登入不了時，請參考 README 的「忘記所有密碼時的復原方式」（需要動到 Volume 裡的設定檔，有風險，請先讀完說明）。</p>
</section>`,
    { title: `登入 - ${APP_NAME}`, heading: APP_NAME, sub: "請用你的帳號（Email）與密碼登入" },
  );
}

/** /login：還沒有任何帳號時沒有人登入得了——請管理員先到設定頁完成第一次設定。 */
export function renderNoAccountsPage(ctx: PageContext, legacyPending: boolean): string {
  return layout(
    ctx,
    `<section class="card">
<h2>尚未建立任何帳號</h2>
<p class="muted">這個系統需要先登入才能使用，但目前還沒有任何帳號。請管理員先到設定頁完成第一次設定：${
      legacyPending
        ? "用目前正在使用的管理密碼升級成管理員帳號（升級後再替其他人建立帳號）。"
        : "用服務啟動記錄裡的設定碼建立第一位管理員（之後再替其他人建立帳號）。"
    }</p>
<div class="row"><a class="btn primary" href="/settings">前往設定頁</a></div>
</section>`,
    { title: `尚未建立帳號 - ${APP_NAME}`, heading: APP_NAME, sub: "請用你的帳號（Email）與密碼登入" },
  );
}

/** 登入的是一般使用者，進設定頁：403。 */
export function renderForbiddenPage(ctx: PageContext, me: Pick<Account, "name" | "role">): string {
  return layout(
    ctx,
    `${renderNav(me, "forbidden")}
<section class="card">
<h2>需要管理員權限</h2>
<p class="muted">設定頁只有管理員可以使用。你目前登入的帳號是「${escapeHtml(me.name)}」（${escapeHtml(roleLabel(me.role))}），可以使用裝箱程式與變更自己的密碼；需要調整 LINE 通知或帳號的話，請洽管理員。</p>
<div class="row"><a class="btn primary" href="/">回裝箱程式</a></div>
</section>`,
    { title: `需要管理員權限 - ${APP_NAME}`, heading: "需要管理員權限", sub: APP_NAME },
  );
}

/** /account：任一角色都可以看自己的資料、變更自己的密碼。 */
export function renderAccountPage(ctx: PageContext, me: Pick<Account, "name" | "email" | "role">): string {
  return layout(
    ctx,
    `${renderNav(me, "account")}
<section class="card">
<h2>我的帳號</h2>
<p class="muted">姓名：<strong id="me-name">${escapeHtml(me.name)}</strong><br>Email：<strong id="me-email" class="mono">${escapeHtml(me.email)}</strong><br>角色：<strong id="me-role">${escapeHtml(roleLabel(me.role))}</strong><br>要修改姓名、Email 或角色，請洽管理員。</p>
<form id="password-form" autocomplete="off">
<label for="current-password">目前的密碼</label>
<input type="password" id="current-password" autocomplete="current-password" maxlength="200" required>
<label for="new-password">新密碼（至少 10 個字元）</label>
<input type="password" id="new-password" autocomplete="new-password" minlength="10" maxlength="200" required>
<label for="new-password2">再輸入一次新密碼</label>
<input type="password" id="new-password2" autocomplete="new-password" minlength="10" maxlength="200" required>
<div class="row">
<button type="submit" class="btn primary">變更我的密碼</button>
</div>
<p class="muted">變更密碼後，你在其他裝置上的登入會全部失效（其他人不受影響）。</p>
<p id="password-msg" class="msg" role="status" hidden></p>
</form>
</section>`,
    { title: `我的帳號 - ${APP_NAME}`, heading: "我的帳號", sub: APP_NAME },
  );
}

function chip(kind: "ok" | "bad" | "warn" | "", text: string): string {
  return `<li class="chip${kind === "" ? "" : ` ${kind}`}">${escapeHtml(text)}</li>`;
}

function describeEvent(eventType: string): string {
  if (eventType === "join") return "加入群組";
  if (eventType === "message") return "群組訊息";
  return eventType;
}

function formatSeenAt(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : formatTaipeiTime(new Date(ms));
}

function credentialPlaceholder(cred: { configured: boolean; last4: string | null }): string {
  if (!cred.configured) return "";
  return cred.last4 ? `已設定（尾碼 …${cred.last4}）；留空表示不變` : "已設定；留空表示不變";
}

function renderStatus(view: SettingsView): string {
  const eff = view.effective;
  const chips: string[] = [];
  chips.push(chip(view.dataDirWritable ? "ok" : "bad", view.dataDirWritable ? "資料目錄：可寫入" : "資料目錄：不可寫入"));
  if (view.dataDirWritable && view.dataDirMounted === false) chips.push(chip("warn", "資料目錄：不是掛載的 Volume"));
  if (eff.lineConfigured) chips.push(chip("ok", "LINE 關箱通知：已啟用"));
  else if (eff.source === "settings" && !view.line.enabled) chips.push(chip("warn", "LINE 關箱通知：已停用"));
  else chips.push(chip("bad", "LINE 關箱通知：設定未完成"));
  chips.push(chip(eff.lineWebhookConfigured ? "ok" : "bad", eff.lineWebhookConfigured ? "Webhook：已啟用" : "Webhook：缺少 Channel secret"));
  chips.push(chip("", `設定來源：${eff.source === "settings" ? "設定頁" : eff.source === "env" ? "環境變數（備援）" : "尚未設定"}`));
  chips.push(chip("", `帳號：${view.accountCount} 個（管理員 ${view.adminCount} 位）`));
  const mountWarning =
    view.dataDirWritable && view.dataDirMounted === false
      ? `<p class="note warn">這個資料目錄看起來不是掛載的 Volume，服務重新部署後設定會消失。請在 Zeabur 掛載 Volume 到 <span class="mono">/app/data</span>。</p>`
      : "";
  return `<section class="card">
<h2>狀態</h2>
<ul class="chips">${chips.join("")}</ul>
${mountWarning}
</section>`;
}

function renderLineCard(view: SettingsView): string {
  const line = view.line;
  const envNote =
    view.effective.source === "env"
      ? `<p class="note">目前生效的是環境變數裡的 LINE 設定（備援）。在這裡儲存 Channel access token 之後，會整組改用這一頁的設定；環境變數保留不動，清除這裡的 token 就會退回環境變數。</p>`
      : "";
  const halfNote =
    line.channelAccessToken.configured || !line.channelSecret.configured
      ? ""
      : `<p class="note warn">已填 Channel secret 但還沒填 Channel access token：這一頁的設定尚未生效（仍使用環境變數或未啟用）。</p>`;
  const clearToken = line.channelAccessToken.configured
    ? `<label class="check"><input type="checkbox" id="line-token-clear"> 清除已儲存的 Channel access token</label>`
    : "";
  const clearSecret = line.channelSecret.configured
    ? `<label class="check"><input type="checkbox" id="line-secret-clear"> 清除已儲存的 Channel secret</label>`
    : "";
  return `<section class="card">
<h2>LINE 群組通知</h2>
<p class="muted">關箱後，把箱號與商品明細推播到指定的 LINE 群組。</p>
${envNote}${halfNote}
<form id="line-form" autocomplete="off">
<label class="check"><input type="checkbox" id="line-enabled"${line.enabled ? " checked" : ""}> 啟用關箱通知</label>
<label for="line-token">Channel access token</label>
<input type="password" id="line-token" autocomplete="new-password" spellcheck="false" maxlength="1000" placeholder="${escapeHtml(credentialPlaceholder(line.channelAccessToken))}">
${clearToken}
<label for="line-secret">Channel secret（驗證 webhook 用）</label>
<input type="password" id="line-secret" autocomplete="new-password" spellcheck="false" maxlength="200" placeholder="${escapeHtml(credentialPlaceholder(line.channelSecret))}">
${clearSecret}
<label for="line-group-id">群組 ID</label>
<input type="text" id="line-group-id" class="mono" value="${escapeHtml(line.groupId)}" placeholder="C 開頭；可從下方「最近收到的群組」帶入" autocomplete="off" spellcheck="false" maxlength="64">
<p class="muted">群組名稱：<strong id="line-group-name">${escapeHtml(line.groupName) || "（尚未取得）"}</strong>（唯讀，儲存時用 token 向 LINE 查詢）</p>
<div class="row">
<button type="submit" class="btn primary">儲存</button>
<button type="button" class="btn" id="line-test">發送測試訊息</button>
</div>
<p class="muted">測試訊息使用「已儲存」的設定。token 與 secret 儲存後不會再顯示，留空表示不變。</p>
<p id="line-msg" class="msg" role="status" hidden></p>
</form>
</section>`;
}

function renderWebhookCard(ctx: PageContext): string {
  return `<section class="card">
<h2>Webhook 網址</h2>
<p class="muted">到 LINE Developers → 你的 Messaging API channel →「Messaging API」分頁，把 Webhook URL 設成下面這個網址，按「Verify」並開啟「Use webhook」；再把機器人加進要通知的群組，群組就會出現在下方清單。</p>
<div class="urlbox"><code id="webhook-url" class="mono">${escapeHtml(ctx.origin + WEBHOOK_PATH)}</code><button type="button" class="btn small" id="copy-webhook">複製</button></div>
</section>`;
}

function renderCapturedCard(view: SettingsView): string {
  const items = view.captured
    .map(
      (group) => `<li>
<div><div class="gname">${escapeHtml(group.groupName) || "（未取得名稱）"}</div><div class="mono">${escapeHtml(group.groupId)}</div><div class="muted">${escapeHtml(describeEvent(group.eventType))} · ${escapeHtml(formatSeenAt(group.lastSeenAt))}</div></div>
<button type="button" class="btn small" data-use-group="${escapeHtml(group.groupId)}" data-group-name="${escapeHtml(group.groupName)}">使用此群組</button>
</li>`,
    )
    .join("");
  const body =
    items === ""
      ? `<p class="muted">還沒有收到任何群組。設定好 Webhook 之後，把機器人加進群組，或在群組裡輸入「群組ID」，這裡就會出現。</p>`
      : `<ul class="groups">${items}</ul>`;
  return `<section class="card">
<h2>最近收到的群組</h2>
${body}
</section>`;
}

function renderAccountRow(account: AccountPublic, meId: string): string {
  const isMe = account.id === meId;
  const active = account.status === "active";
  const data = `data-id="${escapeHtml(account.id)}" data-name="${escapeHtml(account.name)}" data-email="${escapeHtml(account.email)}" data-role="${account.role}" data-me="${isMe ? "1" : "0"}"`;
  const lastLogin = account.lastLoginAt ? formatSeenAt(account.lastLoginAt) : "—";
  // 對自己：只能編輯姓名／Email（角色不能自己降級）；重設密碼請用「我的帳號」、不能停用或刪除自己（伺服器端也會擋）
  const selfHint = ' disabled title="不能對自己的帳號這麼做"';
  return `<tr>
<td>${escapeHtml(account.name)}${isMe ? ' <span class="me">（你）</span>' : ""}</td>
<td class="mono">${escapeHtml(account.email)}</td>
<td>${account.role === "admin" ? '<span class="chip admin">管理員</span>' : '<span class="chip user">一般使用者</span>'}</td>
<td>${active ? '<span class="chip ok">啟用</span>' : '<span class="chip bad">停用</span>'}</td>
<td>${escapeHtml(lastLogin)}</td>
<td class="actions">
<button type="button" class="btn small" data-admin-action="edit" ${data}>編輯</button>
<button type="button" class="btn small" data-admin-action="reset" ${data}${isMe ? selfHint : ""}>重設密碼</button>
<button type="button" class="btn small" data-admin-action="toggle" data-status="${active ? "active" : "disabled"}" ${data}${isMe ? selfHint : ""}>${active ? "停用" : "啟用"}</button>
<button type="button" class="btn small danger" data-admin-action="delete" ${data}${isMe ? selfHint : ""}>刪除</button>
</td>
</tr>`;
}

function renderAccountsCard(view: SettingsView, accounts: ReadonlyArray<AccountPublic>): string {
  const rows = accounts.map((account) => renderAccountRow(account, view.me.id)).join("\n");
  return `<section class="card">
<h2>帳號管理</h2>
<p class="muted">所有人都要用自己的 Email 與密碼登入才能使用裝箱程式。<strong>管理員</strong>可以進設定頁、管理所有帳號；<strong>一般使用者</strong>只能使用裝箱程式與變更自己的密碼。停用、重設密碼或改角色會立刻讓對方所有裝置上的登入失效；不能停用、刪除自己，也不能把自己改成一般使用者，並且不能停用、刪除或降級最後一位啟用中的管理員。</p>
<div class="tablewrap">
<table id="admin-table">
<thead><tr><th>姓名</th><th>Email</th><th>角色</th><th>狀態</th><th>最後登入</th><th>操作</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
<div class="row"><button type="button" class="btn primary" id="admin-add">新增帳號</button></div>
<p id="admin-msg" class="msg" role="status" hidden></p>
</section>
<section class="card" id="admin-editor" hidden>
<h2 id="ae-title">新增帳號</h2>
<form id="admin-form" autocomplete="off">
<div id="ae-row-name">
<label for="ae-name">姓名</label>
<input type="text" id="ae-name" autocomplete="off" maxlength="50">
</div>
<div id="ae-row-email">
<label for="ae-email">Email（登入帳號）</label>
<input type="email" id="ae-email" autocomplete="off" spellcheck="false" maxlength="254">
</div>
<div id="ae-row-role">
<label for="ae-role">角色</label>
<select id="ae-role">
<option value="user">一般使用者（只能使用裝箱程式）</option>
<option value="admin">管理員（可進設定頁、管理帳號）</option>
</select>
</div>
<div id="ae-row-password">
<label for="ae-password">密碼（至少 10 個字元）</label>
<input type="password" id="ae-password" autocomplete="new-password" minlength="10" maxlength="200">
<label for="ae-password2">再輸入一次密碼</label>
<input type="password" id="ae-password2" autocomplete="new-password" minlength="10" maxlength="200">
</div>
<div class="row">
<button type="submit" class="btn primary" id="ae-submit">儲存</button>
<button type="button" class="btn" id="ae-cancel">取消</button>
</div>
<p id="ae-msg" class="msg" role="status" hidden></p>
</form>
</section>`;
}

export function renderSettingsPage(ctx: PageContext, view: SettingsView, accounts: ReadonlyArray<AccountPublic>): string {
  return layout(
    ctx,
    [renderNav(view.me, "settings"), renderStatus(view), renderLineCard(view), renderWebhookCard(ctx), renderCapturedCard(view), renderAccountsCard(view, accounts)].join("\n"),
  );
}
