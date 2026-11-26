const state = {
  me: null,
  kbs: [],
  baseId: null,
  groups: [],
  groupFilter: '',
  documents: [],
  selected: null,
  selectedFile: null,
  view: 'documents',
  editing: false,
  draftTitle: '',
  draftBody: '',
  query: '',
  searchFocus: false,
  searchTimer: null,
  loading: false,
  files: [],
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
  const hasBase = state.kbs.some(base => base.id === state.baseId)
  root.dataset.hasBase = String(hasBase)
  root.append(sidebar)
  if (hasBase) root.append(renderResourceList())
  root.append(renderMain())
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
            if (state.baseId !== null && state.view === 'documents') void loadDocuments()
            else render()
          }, 280)
        },
      })),
    h('div', { class: 'workspace-nav', role: 'tablist', 'aria-label': '工作区' },
      h('button', { type: 'button', class: `workspace-tab${state.view === 'documents' ? ' active' : ''}`, onClick: () => { state.view = 'documents'; state.selectedFile = null; render(); void loadDocuments() } }, '文档'),
      h('button', { type: 'button', class: `workspace-tab${state.view === 'files' ? ' active' : ''}`, onClick: () => { state.view = 'files'; state.selected = null; render(); void loadFiles() } }, '文件'),
    ),
    h('nav', { class: 'kb-list', 'aria-label': '知识库' },
      baseList.length === 0 ? h('p', { class: 'note', text: '还没有可访问的知识库。' }) : baseList),
    h('div', { class: 'sidebar-foot' },
      state.me.canEdit && state.view === 'documents' ? h('button', { type: 'button', class: 'side-btn accent', onClick: openCreate, text: state.baseId === null ? '+ 新建文档' : '+ 在这个库中新建' }) : null,
      state.me.isAdmin ? h('button', { type: 'button', class: 'side-btn', onClick: () => void openAdmin(), text: '成员与邀请' }) : null,
      h('button', { type: 'button', class: 'side-btn ghost', onClick: () => void refreshAll(), text: '刷新' })),
  )
}

function renderMain() {
  const main = h('main', { class: 'main' })
  const base = state.kbs.find(item => item.id === state.baseId)
  const currentTitle = state.view === 'files' ? state.selectedFile?.name : state.selected?.title
  main.append(h('header', { class: 'topbar' },
    h('div', { class: 'breadcrumb' },
      h('span', { text: '工作区' }), h('span', { class: 'crumb-separator', text: '/' }),
      h('strong', { text: base?.name ?? '全部知识库' }),
      h('span', { class: 'crumb-separator', text: '/' }),
      h('span', { text: state.view === 'files' ? '文件' : '文档' }),
      currentTitle ? h('span', { class: 'crumb-current', text: ` / ${currentTitle}` }) : null),
    h('div', { class: 'doc-actions' },
      state.view === 'documents' && state.baseId !== null && state.me.canEdit ? h('button', { type: 'button', class: 'btn primary', onClick: openCreate, text: '+ 新建文档' }) : null,
      state.me.isAdmin ? h('button', { type: 'button', class: 'btn', onClick: () => void openAdmin(), text: '成员与设置' }) : null,
      h('span', { class: 'pill', text: state.me.canEdit ? '可编辑' : '只读' }))))
  const content = h('section', { class: 'content' })
  if (state.baseId === null) content.append(renderWelcome())
  else if (state.loading) content.append(h('div', { class: 'welcome' }, h('p', { text: '正在加载…' })))
  else if (state.error !== '') content.append(h('div', { class: 'welcome' }, h('p', { text: state.error })))
  else if (state.view === 'files') content.append(state.selectedFile === null ? renderEmptyDetail('选择一个文件查看详情') : renderFileDetail())
  else if (state.selected === null) content.append(renderWelcome())
  else content.append(state.editing ? renderEditor() : renderReader())
  main.append(content)
  return main
}

function renderEmptyDetail(message) {
  return h('div', { class: 'welcome' }, h('div', { class: 'empty-mark', text: state.view === 'files' ? '▧' : '▤' }), h('h2', { text: message }), h('p', { text: state.view === 'files' ? '选择左侧文件列表中的条目，查看元数据或打开预览。' : '从列表选择一篇文档开始阅读。' }))
}

function renderFileDetail() {
  const file = state.selectedFile
  const type = String(file.mime || '').toLowerCase()
  const safeImage = /^image\/(?:png|jpeg|gif|webp)(?:;|$)/u.test(type)
  const safeText = /^text\/(?:plain|markdown|csv)(?:;|$)/u.test(type) || type === 'application/json'
  const preview = safeImage
    ? h('img', { class: 'file-preview-image', src: file.inlineUrl, alt: file.name })
    : type === 'application/pdf'
      ? h('iframe', { class: 'file-preview-frame', src: file.inlineUrl, title: `${file.name} 预览` })
      : safeText
        ? h('iframe', { class: 'file-preview-frame text-preview', src: file.inlineUrl, title: `${file.name} 预览` })
        : h('div', { class: 'file-preview-unavailable' }, h('div', { class: 'empty-mark', text: '↓' }), h('p', { text: '此格式可下载后在本地打开。' }), h('a', { class: 'btn primary', href: file.downloadUrl, text: '下载文件' }))
  return h('article', { class: 'file-detail' },
    h('header', { class: 'file-detail-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: `${file.userName || '未署名'} · 文件` }), h('h1', { class: 'doc-title', text: file.name })),
      h('div', { class: 'doc-actions' }, h('a', { class: 'btn', href: file.downloadUrl, text: '下载' }),
        state.me.canEdit ? h('button', { type: 'button', class: 'btn danger', onClick: () => void deleteFile(file), text: '删除' }) : null)),
    h('div', { class: 'file-metadata' },
      h('span', {}, h('small', { text: '类型' }), h('strong', { text: file.mime || '未知' })),
      h('span', {}, h('small', { text: '大小' }), h('strong', { text: formatFileSize(file.size) })),
      h('span', {}, h('small', { text: '上传者' }), h('strong', { text: file.userName || '未署名' })),
      h('span', {}, h('small', { text: '更新时间' }), h('strong', { text: new Date(file.updatedAt).toLocaleString() }))),
    h('div', { class: 'file-source-path', text: file.sourceKey || file.name }),
    h('div', { class: 'file-preview' }, preview))
}

async function deleteFile(file) {
  if (!confirm(`删除文件「${file.name}」？`)) return
  try {
    await api(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
    state.files = state.files.filter(row => row.id !== file.id)
    state.selectedFile = null
    render()
    toast('文件已删除')
  } catch (error) { toast(error.message, 'error') }
}

function renderWelcome() {
  return h('div', { class: 'welcome' },
    h('div', { class: 'empty-mark', text: '▤' }),
    h('h2', { text: state.baseId === null ? '从左侧选择知识库' : state.view === 'files' ? '文件工作区' : '选择一篇文档' }),
    h('p', { text: state.baseId === null ? '选择知识库开始浏览文档和文件。' : '文档、附件、用户分区和文件详情都在同一个工作区中浏览。' }))
}

function renderResourceList() {
  return state.view === 'files' ? renderFileList() : renderDocumentList()
}

function renderDocumentList() {
  const groups = ['全部分组', ...state.groups]
  const filter = h('select', { class: 'list-filter', value: state.groupFilter, 'aria-label': '按分组筛选', onChange: event => { state.groupFilter = event.currentTarget.value; render() } },
    ...groups.map(group => h('option', { value: group === '全部分组' ? '' : group, selected: (group === '全部分组' ? '' : group) === state.groupFilter, text: group })))
  const documents = state.groupFilter === '' ? state.documents : state.documents.filter(row => (row.group || '未分组') === state.groupFilter)
  const rows = documents.map(document => h('button', {
    type: 'button', class: `doc-row${state.selected?.id === document.id ? ' active' : ''}`,
    onClick: () => void openDocument(document.id),
  }, h('span', { class: 'resource-icon', text: '▤' }), h('span', { class: 'resource-label' },
    h('strong', { text: document.title }), h('small', { text: document.group || '未分组' }))))
  return h('section', { class: 'resource-list' },
    h('header', { class: 'resource-list-head' }, h('div', {}, h('p', { class: 'eyebrow', text: '文档' }), h('strong', { text: `${documents.length} 篇` })), filter),
    rows.length === 0 ? h('div', { class: 'doc-empty', text: state.query === '' ? '这个知识库还没有文档。' : '没有匹配的文档。' }) : h('div', { class: 'doc-list' }, ...rows))
}

function renderFileList() {
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onChange: event => { const files = event.currentTarget.files; if (files) void uploadFiles([...files]); event.currentTarget.value = '' } })
  const folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, onChange: event => { const files = event.currentTarget.files; if (files) void uploadFiles([...files]); event.currentTarget.value = '' } })
  const query = state.query.trim().toLowerCase()
  const files = state.files.filter(file => query === '' || `${file.name} ${file.sourceKey || ''} ${file.userName || ''} ${file.mime || ''}`.toLowerCase().includes(query))
  const users = [...new Set(files.map(file => file.userName || '未署名'))].sort((a, b) => a.localeCompare(b))
  const rows = users.flatMap(user => [
    h('div', { class: 'file-user-heading', text: user }),
    ...files.filter(file => (file.userName || '未署名') === user).map(file => h('button', {
      type: 'button', class: `doc-row file-entry${state.selectedFile?.id === file.id ? ' active' : ''}`,
      onClick: () => { state.selectedFile = file; render() },
    }, h('span', { class: 'resource-icon', text: '▧' }), h('span', { class: 'resource-label' },
      h('strong', { text: file.name }), h('small', { text: `${file.sourceKey || file.name} · ${formatFileSize(file.size)}` }))))
  ])
  return h('section', { class: 'resource-list' },
    h('header', { class: 'resource-list-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: '文件' }), h('strong', { text: `${files.length} 个文件` })),
      state.me.canEdit ? h('div', { class: 'upload-actions' },
        h('button', { type: 'button', class: 'btn primary', onClick: () => fileInput.click(), text: '上传' }),
        h('button', { type: 'button', class: 'btn', onClick: () => folderInput.click(), text: '上传文件夹' }), fileInput, folderInput) : null),
    rows.length === 0 ? h('div', { class: 'doc-empty', text: query ? '没有匹配的文件。' : '这个知识库还没有文件。' }) : h('div', { class: 'doc-list file-list-panel' }, ...rows))
}

function renderReader() {
  const document = state.selected
  const tags = (document.tags ?? []).map(tag => h('span', { class: 'tag', text: tag }))
  return h('div', { class: 'document-detail' },
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
  state.selectedFile = null
  state.groupFilter = ''
  state.editing = false
  state.query = ''
  await loadGroups()
  if (state.view === 'files') await loadFiles()
  else await loadDocuments()
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
    if (state.view === 'files') await loadFiles()
    else await loadDocuments()
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

async function loadFiles() {
  if (state.baseId === null) return
  setLoading(true)
  try {
    const result = await api(`/api/files?baseId=${encodeURIComponent(state.baseId)}`)
    state.files = result.files
    state.error = ''
    if (state.selectedFile && !state.files.some(file => file.id === state.selectedFile.id)) state.selectedFile = null
  } catch (error) {
    state.error = error.message
  } finally {
    setLoading(false)
    render()
  }
}

async function uploadFiles(files) {
  if (files.length === 0) return
  let uploaded = 0
  for (const file of files) {
    try {
      const response = await fetch('/api/files', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'x-csrf-token': state.me.csrf,
          'x-file-base-id': state.baseId,
          'x-file-name': encodeURIComponent(file.name),
          'x-file-source-key': encodeURIComponent(file.webkitRelativePath || file.name),
          'x-file-user-name': encodeURIComponent(state.me.user.name),
          'x-content-type': file.type || 'application/octet-stream',
        },
        body: file,
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.error ?? `上传失败 (${response.status})`)
      }
      uploaded += 1
    } catch (error) {
      toast(`${file.name}：${error.message}`, 'error')
    }
  }
  if (uploaded > 0) toast(`已上传 ${uploaded} 个文件`)
  await loadFiles()
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function openAdmin() {
  try {
    const [userResult, tokenResult] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/tokens'),
    ])
    state.admin = { open: true, users: userResult.users, tokens: tokenResult.tokens, error: '' }
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
  const tokenName = h('input', { placeholder: '例如：我的 DSH', maxlength: '100' })
  const tokenBox = h('div', { class: 'invite-box' })
  const tokenRows = (state.admin.tokens ?? []).map(token => h('div', { class: 'savebar' },
    h('span', { class: 'grow', text: `${token.name} · ${new Date(token.createdAt).toLocaleDateString()}${token.revokedAt ? ' · 已撤销' : ''}` }),
    token.revokedAt ? null : h('button', {
      type: 'button', class: 'btn danger', text: '撤销',
      onClick: async () => {
        try {
          await api(`/api/admin/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' })
          state.admin.tokens = state.admin.tokens.filter(row => row.id !== token.id)
          render()
          toast('Token 已撤销')
        } catch (error) { toast(error.message, 'error') }
      },
    })))
  const createToken = async () => {
    try {
      const result = await api('/api/admin/tokens', { method: 'POST', body: JSON.stringify({ name: tokenName.value || 'DSH 本地客户端' }) })
      const origin = location.origin
      tokenBox.innerHTML = ''
      tokenBox.append(
        h('label', { class: 'note', text: '这个 Token 只显示一次；复制到本地 DSH 的远程知识库连接设置。' }),
        h('input', { readonly: true, value: result.token, onFocus: event => event.currentTarget.select() }),
        h('button', {
          type: 'button', class: 'btn primary',
          onClick: () => void navigator.clipboard.writeText(result.token).then(() => toast('Token 已复制')),
          text: '复制 Token',
        }),
        h('label', { class: 'note', text: `远程地址：${origin}/knowledge-api/v1  ·  权限：读取、提出、写入` }),
      )
      state.admin.tokens = [result.record, ...(state.admin.tokens ?? [])]
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
      inviteBox,
      h('div', { class: 'modal-head', style: 'margin-top:18px' }, h('h2', { text: '连接本地 DSH' })),
      h('p', { class: 'note', text: '本地 DSH 使用 Bearer Token 连接云端；Token 与网页登录密码不同。远程地址必须是 HTTPS，或通过 SSH 隧道映射到 127.0.0.1。' }),
      h('div', { class: 'form-grid' },
        h('label', {}, 'Token 名称', tokenName),
        h('button', { type: 'button', class: 'btn', onClick: () => void createToken(), text: '生成 DSH Token' })),
      tokenBox,
      tokenRows.length > 0 ? h('div', { style: 'margin-top:12px' }, h('p', { class: 'note', text: '已签发的 Token' }), ...tokenRows) : null))
}

window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault()
    document.querySelector('.editor button[type=submit]')?.click()
  }
})

refreshAll()
