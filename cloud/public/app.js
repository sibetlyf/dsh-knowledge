const state = {
  me: null,
  kbs: [],
  baseId: null,
  groups: [],
  documents: [],
  selected: null,
  editing: false,
  draftTitle: '',
  draftBody: '',
  query: '',
  searchFocus: false,
  searchTimer: null,
  loading: false,
  error: '',
  admin: null,
  invite: null,
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'html') node.innerHTML = value
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value === true) node.setAttribute(key, '')
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers ?? {}) }
  if (options.body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json'
  if (state.me?.csrf && options.method !== undefined && options.method !== 'GET') headers['x-csrf-token'] = state.me.csrf
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers })
  if (response.status === 401) {
    location.assign('/login?next=%2F')
    throw new Error('登录已失效')
  }
  const type = response.headers.get('content-type') ?? ''
  const payload = type.includes('application/json') ? await response.json() : await response.text()
  if (!response.ok) {
    const error = new Error(payload?.error ?? `请求失败 (${response.status})`)
    error.payload = payload
    error.status = response.status
    throw error
  }
  return payload
}

function toast(message, kind = 'info') {
  document.querySelector('.toast')?.remove()
  const node = h('div', { class: 'toast', role: 'status', text: message })
  if (kind === 'error') node.style.background = 'var(--danger)'
  document.body.append(node)
  setTimeout(() => node.remove(), 3200)
}

function setLoading(value) {
  state.loading = value
}

function render() {
  const root = document.getElementById('app')
  if (root === null) return
  root.innerHTML = ''
  if (state.me === null) return
  const sidebar = renderSidebar()
  const main = renderMain()
  root.append(sidebar, main)
  if (state.admin !== null) root.append(renderAdmin())
  document.getElementById('boot')?.classList.add('hidden')
  root.classList.remove('hidden')
}

function renderSidebar() {
  const baseList = state.kbs.map(base => h('button', {
    type: 'button',
    class: `kb-item${base.id === state.baseId ? ' active' : ''}`,
    onClick: () => void selectBase(base.id),
    'aria-pressed': String(base.id === state.baseId),
  }, h('strong', { text: base.name }), h('small', { text: `${base.documentCount} 篇文档` })))
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-head' },
      h('div', { class: 'brand-row' },
        h('span', { class: 'brand-mark', text: 'K' }),
        h('div', {}, h('strong', { text: state.me.title ?? '团队知识库' }), h('small', { text: 'TEAM KNOWLEDGE' }))),
      h('div', { class: 'user-row' },
        h('div', { class: 'user-chip' }, h('strong', { text: state.me.user.name }), h('small', { text: `${state.me.roleLabel} · ${state.me.user.email}` })),
        h('button', { type: 'button', class: 'icon-btn', onClick: () => void logout(), text: '退出' })),
    ),
    h('div', { class: 'sidebar-search' },
      h('input', {
        type: 'search', value: state.query, placeholder: '搜索标题、正文、标签', 'aria-label': '搜索知识库',
        onInput: event => {
          state.query = event.currentTarget.value
          clearTimeout(state.searchTimer)
          state.searchTimer = setTimeout(() => {
            state.searchFocus = true
            if (state.baseId !== null) void loadDocuments()
          }, 280)
        },
      })),
    h('nav', { class: 'kb-list', 'aria-label': '知识库' },
      baseList.length === 0 ? h('p', { class: 'note', text: '还没有可访问的知识库。' }) : baseList),
    h('div', { class: 'sidebar-foot' },
      state.me.canEdit ? h('button', { type: 'button', class: 'side-btn accent', onClick: openCreate, text: state.baseId === null ? '+ 新建文档' : '+ 在这个库中新建' }) : null,
      state.me.isAdmin ? h('button', { type: 'button', class: 'side-btn', onClick: () => void openAdmin(), text: '成员与邀请' }) : null,
      h('button', { type: 'button', class: 'side-btn ghost', onClick: () => void refreshAll(), text: '刷新' })),
  )
}

function renderMain() {
  const main = h('main', { class: 'main' })
  const base = state.kbs.find(item => item.id === state.baseId)
  main.append(h('header', { class: 'topbar' },
    h('div', { class: 'breadcrumb' }, h('strong', { text: base?.name ?? '全部知识库' }), h('span', { text: state.selected ? ` / ${state.selected.title}` : '' })),
    h('span', { class: 'pill', text: state.me.canEdit ? '可编辑' : '只读' })))
  if (base !== undefined) main.append(renderDocumentList())
  const content = h('section', { class: 'content' })
  if (state.loading) content.append(h('div', { class: 'welcome' }, h('p', { text: '正在加载…' })))
  else if (state.error !== '') content.append(h('div', { class: 'welcome' }, h('p', { text: state.error })))
  else if (state.selected === null) content.append(renderWelcome())
  else content.append(state.editing ? renderEditor() : renderReader())
  main.append(content)
  return main
}

function renderWelcome() {
  return h('div', { class: 'welcome' },
    h('h2', { text: state.baseId === null ? '从左侧选择知识库' : '选择一篇文档' }),
    h('p', { text: '团队成员共用同一份知识：浏览、搜索、上传和编辑都在这里完成。所有修改都会保留版本记录。' }))
}

function renderDocumentList() {
  const rows = state.documents.map(document => h('button', {
    type: 'button', class: `doc-row${state.selected?.id === document.id ? ' active' : ''}`,
    onClick: () => void openDocument(document.id),
  },
  h('strong', { text: document.title }),
  h('small', { text: document.group || '未分组' })))
  return h('div', { class: 'doc-list-wrap' },
    rows.length === 0
      ? h('div', { class: 'doc-empty', text: state.query === '' ? '这个知识库还没有文档。' : '没有匹配的文档。' })
      : h('div', { class: 'doc-list' }, ...rows))
}

function renderReader() {
  const document = state.selected
  const tags = (document.tags ?? []).map(tag => h('span', { class: 'tag', text: tag }))
  return h('div', {},
    h('div', { class: 'doc-head' },
      h('div', {},
        h('h1', { class: 'doc-title', text: document.title }),
        h('div', { class: 'doc-meta' },
          h('span', { text: `${document.group || '未分组'} · v${document.version}` }),
          h('span', { text: new Date(document.updatedAt).toLocaleString() }),
          ...tags)),
      h('div', { class: 'doc-actions' },
        h('a', { class: 'btn', href: `/api/document/${encodeURIComponent(document.id)}/raw`, text: '下载 Markdown' }),
        state.me.canEdit ? h('button', { type: 'button', class: 'btn primary', onClick: () => { state.editing = true; state.draftTitle = document.title; state.draftBody = document.body; render() }, text: '编辑' }) : null)),
    state.me.canEdit ? h('div', { class: 'tabs', role: 'tablist' },
      h('button', { class: 'tab', role: 'tab', 'aria-selected': 'true', text: '阅读' }),
      h('button', { class: 'tab', role: 'tab', 'aria-selected': 'false', onClick: () => { state.editing = true; state.draftTitle = document.title; state.draftBody = document.body; render() }, text: '编辑' })) : null,
    h('div', { class: 'reader' }, h('div', { class: 'markdown-body', html: document.html ?? '' })))
}

function renderEditor() {
  const document = state.selected
  let draftTitle = state.draftTitle
  let draftBody = state.draftBody
  const titleInput = h('input', { value: draftTitle, maxlength: '240', onInput: event => { draftTitle = event.currentTarget.value; state.draftTitle = draftTitle } })
  const bodyInput = h('textarea', { value: draftBody, onInput: event => { draftBody = event.currentTarget.value; state.draftBody = draftBody } })
  bodyInput.value = draftBody
  const save = async () => {
    setLoading(true)
    try {
      const result = await api(`/api/document/${encodeURIComponent(document.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ title: draftTitle, body: draftBody, expectedVersion: document.version }),
      })
      state.selected = result.document
      state.editing = false
      state.draftTitle = ''
      state.draftBody = ''
      state.error = ''
      toast('已保存')
    } catch (error) {
      if (error.status === 409) {
        state.error = error.payload?.error ?? '文档已被其他人修改'
        state.documents = state.documents.map(row => row.id === document.id ? { ...row, version: error.payload.current.version, updatedAt: error.payload.current.updatedAt } : row)
      } else if (error.status === 403 || error.status === 401) {
        state.error = error.message
      } else {
        state.error = error.message
      }
    } finally {
      setLoading(false)
      render()
    }
  }
  return h('div', {},
    h('div', { class: 'doc-head' },
      h('div', {}, h('h1', { class: 'doc-title', text: '编辑文档' }), h('div', { class: 'doc-meta', text: `当前版本 v${document.version} · 保存时会检查其他人是否已修改` })),
      h('div', { class: 'doc-actions' },
        h('button', { type: 'button', class: 'btn', onClick: () => { state.editing = false; state.error = ''; render() }, text: '取消' }),
        h('button', { type: 'button', class: 'btn primary', onClick: () => void save(), text: '保存' }))),
    state.error !== '' ? h('div', { class: 'conflict' }, h('span', { text: state.error }), h('button', { type: 'button', class: 'btn', onClick: () => void openDocument(document.id), text: '载入最新版' })) : null,
    h('form', { class: 'editor', onSubmit: event => { event.preventDefault(); void save() } },
      h('label', {}, '标题', titleInput),
      h('label', {}, '正文（Markdown）', bodyInput),
      h('div', { class: 'savebar' }, h('span', { class: 'grow', text: 'Ctrl/⌘ + S 保存' }), h('button', { class: 'btn primary', type: 'submit', text: '保存' })),
    ))
}

function openCreate() {
  if (state.baseId === null) { toast('请先选择知识库', 'error'); return }
  const titleInput = h('input', { placeholder: '文档标题', maxlength: '240', required: true })
  const groupInput = h('input', { placeholder: '输入或选择已有分组', maxlength: '64', required: true, list: 'group-options' })
  const groupOptions = h('datalist', { id: 'group-options' }, ...state.groups.map(name => h('option', { value: name })))
  const bodyInput = h('textarea', { placeholder: '# 新文档\n\n从这里开始写。' })
  const close = () => document.querySelector('.modal-backdrop')?.remove()
  const create = async event => {
    event.preventDefault()
    try {
      const result = await api('/api/document', {
        method: 'POST',
        body: JSON.stringify({ knowledgeBaseId: state.baseId, title: titleInput.value, body: bodyInput.value, group: groupInput.value }),
      })
      close()
      await refreshKbs()
      await loadDocuments()
      await openDocument(result.document.id)
      toast('已创建文档')
    } catch (error) { toast(error.message, 'error') }
  }
  const modal = h('div', { class: 'modal-backdrop', role: 'presentation', onClick: event => { if (event.target === event.currentTarget) close() } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '新建文档' },
      h('div', { class: 'modal-head' }, h('h2', { text: '新建文档' }), h('button', { type: 'button', class: 'icon-btn', onClick: close, text: '关闭' })),
      h('form', { class: 'form-grid', onSubmit: create },
        h('label', {}, '标题', titleInput),
        h('label', {}, '分组', groupInput, groupOptions),
        h('label', {}, '正文', bodyInput),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', onClick: close, text: '取消' }),
          h('button', { type: 'submit', class: 'btn primary', text: '创建' })
        )
      )
    )
  )
  document.body.append(modal)
  titleInput.focus()
}

async function openDocument(id) {
  setLoading(true)
  try {
    const result = await api(`/api/document/${encodeURIComponent(id)}`)
    state.selected = result.document
    state.editing = false
    state.error = ''
  } catch (error) {
    state.error = error.message
  } finally {
    setLoading(false)
    render()
  }
}

async function selectBase(id) {
  state.baseId = id
  state.selected = null
  state.editing = false
  state.query = ''
  await Promise.all([loadGroups(), loadDocuments()])
}

async function loadGroups() {
  state.groups = []
  if (state.baseId === null) return
  try {
    const result = await api(`/api/groups?baseId=${encodeURIComponent(state.baseId)}`)
    state.groups = result.groups
  } catch {}
}

async function loadDocuments() {
  if (state.baseId === null) return
  setLoading(true)
  try {
    const query = state.query === '' ? '' : `&q=${encodeURIComponent(state.query)}`
    const result = await api(`/api/documents?baseId=${encodeURIComponent(state.baseId)}${query}`)
    state.documents = result.documents
    state.error = ''
  } catch (error) {
    state.error = error.message
  } finally {
    setLoading(false)
    render()
    if (state.searchFocus === true) {
      state.searchFocus = false
      const input = document.querySelector('.sidebar-search input')
      input?.focus()
      if (input instanceof HTMLInputElement) input.setSelectionRange(input.value.length, input.value.length)
    }
  }
}

async function refreshKbs() {
  const result = await api('/api/kbs')
  state.kbs = result.kbs
  if (state.baseId === null || !state.kbs.some(base => base.id === state.baseId)) state.baseId = state.kbs[0]?.id ?? null
}

async function refreshAll() {
  state.error = ''
  try {
    const me = await api('/api/me')
    state.me = me
    await refreshKbs()
    await loadGroups()
    await loadDocuments()
    render()
  } catch (error) {
    state.error = error.message
    render()
  }
}

async function logout() {
  try {
    await api('/logout', { method: 'POST' })
  } catch {}
  location.assign('/login')
}

async function openAdmin() {
  try {
    const result = await api('/api/admin/users')
    state.admin = { open: true, users: result.users, error: '' }
    render()
  } catch (error) { toast(error.message, 'error') }
}

function renderAdmin() {
  if (state.admin === null) return null
  const close = () => { state.admin = null; render() }
  const roleSelect = h('select', {}, h('option', { value: 'editor', text: '编辑者' }), h('option', { value: 'viewer', text: '阅读者' }), h('option', { value: 'admin', text: '管理员' }))
  const inviteBox = h('div', { class: 'invite-box', id: 'invite-result' })
  const users = state.admin.users.map(user => h('tr', {},
    h('td', { text: user.name }),
    h('td', { text: user.email }),
    h('td', {}, h('select', {
      disabled: user.id === state.me.user.id,
      onChange: async event => {
        try {
          const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: JSON.stringify({ role: event.currentTarget.value }) })
          state.admin.users = state.admin.users.map(row => row.id === user.id ? result.user : row)
          toast('角色已更新')
        } catch (error) { toast(error.message, 'error'); render() }
      },
    }, ['admin', 'editor', 'viewer'].map(role => h('option', { value: role, selected: user.role === role, text: role === 'admin' ? '管理员' : role === 'editor' ? '编辑者' : '阅读者' })))),
    h('td', {}, h('label', { class: 'note' }, h('input', {
      type: 'checkbox', checked: user.active,
      onChange: async event => {
        try {
          await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: JSON.stringify({ active: event.currentTarget.checked }) })
          user.active = event.currentTarget.checked
          toast(event.currentTarget.checked ? '已启用' : '已停用，所有会话立即失效')
        } catch (error) { toast(error.message, 'error'); render() }
      },
    }), ' 启用')),
    h('td', {}, user.id === state.me.user.id ? h('span', { class: 'pill', text: '当前账号' }) : null)))
  const invite = async () => {
    try {
      const result = await api('/api/admin/invites', { method: 'POST', body: JSON.stringify({ role: roleSelect.value, expiresHours: 168 }) })
      const absolute = new URL(result.invite.path, location.origin).href
      inviteBox.innerHTML = ''
      inviteBox.append(h('label', { class: 'note', text: '一次性邀请链接（7 天内有效）' }),
        h('input', { readonly: true, value: absolute, onFocus: event => event.currentTarget.select() }),
        h('button', { type: 'button', class: 'btn primary', onClick: () => void navigator.clipboard.writeText(absolute).then(() => toast('邀请链接已复制')), text: '复制邀请链接' }))
    } catch (error) { toast(error.message, 'error') }
  }
  return h('div', { class: 'modal-backdrop', onClick: event => { if (event.target === event.currentTarget) close() } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '成员与邀请' },
      h('div', { class: 'modal-head' }, h('h2', { text: '成员与邀请' }), h('button', { type: 'button', class: 'icon-btn', onClick: close, text: '关闭' })),
      h('p', { class: 'note', text: '邀请是一次性链接；成员领取后用自己的账号登录。阅读者不能创建或保存。' }),
      h('table', { class: 'users' }, h('thead', {}, h('tr', {}, h('th', { text: '成员' }), h('th', { text: '邮箱' }), h('th', { text: '角色' }), h('th', { text: '状态' }), h('th', { text: '' }))), h('tbody', {}, ...users)),
      h('div', { class: 'form-grid' },
        h('label', {}, '邀请角色', roleSelect),
        h('button', { type: 'button', class: 'btn primary', onClick: () => void invite(), text: '生成一次性邀请链接' })),
      inviteBox))
}

window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault()
    document.querySelector('.editor button[type=submit]')?.click()
  }
})

refreshAll()
