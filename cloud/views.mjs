export function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

const AUTH_CSS = `<link rel="stylesheet" href="/assets/auth.css">`

function authShell(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · 团队知识库</title>${AUTH_CSS}</head>
<body><main class="auth-shell"><div class="auth-card">
<div class="brand"><span class="brand-mark">K</span><div><strong>团队知识库</strong><small>Team Knowledge</small></div></div>
${body}
</div><p class="auth-foot">轻量独立服务 · 不需要 DSH</p></main></body></html>`
}

export function renderLoginPage({ error = '', next = '/' } = {}) {
  return authShell('登录', `
  <h1>登录团队知识库</h1>
  <p class="auth-copy">使用管理员分配给你的邮箱和密码。</p>
  ${error ? `<p class="auth-error" role="alert">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/login" class="auth-form">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label>邮箱<input class="input" type="email" name="email" autocomplete="username" required autofocus></label>
    <label>密码<input class="input" type="password" name="password" autocomplete="current-password" required minlength="10"></label>
    <button class="btn primary wide" type="submit">登录</button>
  </form>`)
}

export function renderSetupPage({ error = '' } = {}) {
  return authShell('初始化', `
  <h1>创建管理员</h1>
  <p class="auth-copy">这是首次启动。创建第一个管理员后，邀请团队成员加入。</p>
  ${error ? `<p class="auth-error" role="alert">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/setup" class="auth-form">
    <label>管理员邮箱<input class="input" type="email" name="email" autocomplete="username" required autofocus></label>
    <label>显示名称<input class="input" type="text" name="name" maxlength="80" placeholder="可选"></label>
    <label>密码<input class="input" type="password" name="password" autocomplete="new-password" required minlength="10"></label>
    <label>确认密码<input class="input" type="password" name="confirm" autocomplete="new-password" required minlength="10"></label>
    <button class="btn primary wide" type="submit">创建并登录</button>
  </form>`)
}

export function renderInvitePage({ token, role, email = '', name = '', error = '' }) {
  return authShell('接受邀请', `
  <h1>加入团队知识库</h1>
  <p class="auth-copy">邀请角色：<strong>${escapeHtml(roleLabel(role))}</strong>。设置账号后即可进入团队库。</p>
  ${error ? `<p class="auth-error" role="alert">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/invite/${encodeURIComponent(token)}" class="auth-form">
    <label>邮箱<input class="input" type="email" name="email" autocomplete="username" required value="${escapeHtml(email)}"></label>
    <label>显示名称<input class="input" type="text" name="name" maxlength="80" value="${escapeHtml(name)}"></label>
    <label>密码<input class="input" type="password" name="password" autocomplete="new-password" required minlength="10"></label>
    <label>确认密码<input class="input" type="password" name="confirm" autocomplete="new-password" required minlength="10"></label>
    <button class="btn primary wide" type="submit">接受邀请</button>
  </form>`)
}

export function renderAppPage({ title = '团队知识库' } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/app.css"></head>
<body>
<div id="boot" class="boot"><span class="spinner"></span><span>正在加载团队知识库…</span></div>
<div id="app" class="app hidden"></div>
<script src="/assets/app.js" type="module"></script>
</body></html>`
}

export function renderErrorPage(status, message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${status} · 团队知识库</title>${AUTH_CSS}</head>
<body><main class="auth-shell"><div class="auth-card"><div class="brand"><span class="brand-mark">K</span><strong>团队知识库</strong></div>
<h1>${status}</h1><p class="auth-copy">${escapeHtml(message)}</p><a class="btn primary wide" href="/">返回首页</a></div></main></body></html>`
}

export function roleLabel(role) {
  return role === 'admin' ? '管理员' : role === 'viewer' ? '阅读者' : '编辑者'
}
