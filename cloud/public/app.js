const state = {
  me: null,
  meta: null,
  kbs: [],
  baseId: null,
  groups: [],
  groupFilter: '',
  documents: [],
  selected: null,
  selectedFile: null,
  view: 'documents',
  ask: { question: '', answer: '', citations: [], engine: '', busy: false, error: '' },
  wiki: { pages: [], page: null, versions: [], draftTitle: '', draftContent: '', busy: false },
  sources: [],
  worklogs: [],
  worklogSummaries: [],
  worklogSummary: null,
  source: null,
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

function showBootError(error) {
  const boot = document.getElementById('boot')
  if (boot === null) return
  boot.classList.remove('hidden')
  boot.innerHTML = ''
  boot.append(h('div', { class: 'boot-error', text: `页面初始化失败：${error instanceof Error ? error.message : String(error)}` }))
}
window.addEventListener('error', event => showBootError(event.error ?? event.message))
window.addEventListener('unhandledrejection', event => showBootError(event.reason))

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
  if (hasBase && (state.view === 'documents' || state.view === 'files')) root.append(renderResourceList())
  else if (hasBase) root.append(renderContextList())
  root.append(renderMain())
  if (state.admin !== null) root.append(renderAdmin())
  document.getElementById('boot')?.classList.add('hidden')
  root.classList.remove('hidden')
}

function renderSidebar() {
  const baseList = state.kbs.map(base => h('button', {
    type: 'button',
    class: `kb-item${base.id === state.baseId ? ' active' : ''}${base.name.startsWith('云端·') ? ' cloud' : ''}`,
    onClick: () => void selectBase(base.id),
    'aria-pressed': String(base.id === state.baseId),
  }, h('strong', { text: base.name }), h('small', { text: `${base.documentCount} 篇文档${base.name.startsWith('云端·') ? ' · 云端镜像' : ''}` })))
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
      h('button', { type: 'button', class: `workspace-tab${state.view === 'documents' ? ' active' : ''}`, onClick: () => switchView('documents') }, '文档'),
      h('button', { type: 'button', class: `workspace-tab${state.view === 'files' ? ' active' : ''}`, onClick: () => switchView('files') }, '文件'),
      h('button', { type: 'button', class: `workspace-tab${state.view === 'ask' ? ' active' : ''}`, onClick: () => switchView('ask') }, '问答'),
      h('button', { type: 'button', class: `workspace-tab${state.view === 'wiki' ? ' active' : ''}`, onClick: () => switchView('wiki') }, 'Wiki'),
      h('button', { type: 'button', class: `workspace-tab${state.view === 'sources' ? ' active' : ''}`, onClick: () => switchView('sources') }, '数据源'),
      h('button', { type: 'button', class: `workspace-tab${state.view === 'worklogs' ? ' active' : ''}`, onClick: () => switchView('worklogs') }, '团队日报'),
    ),
    h('p', { class: 'kb-section-label', text: '团队知识库' }),
    h('nav', { class: 'kb-list', 'aria-label': '知识库' },
      ...(baseList.length === 0 ? [h('p', { class: 'note', text: '还没有可访问的知识库。' })] : baseList)),
    h('div', { class: 'sidebar-foot' },
      state.me.canEdit && state.view === 'documents' ? h('button', { type: 'button', class: 'side-btn accent', onClick: openCreate, text: state.baseId === null ? '+ 新建文档' : '+ 在这个库中新建' }) : null,
      state.me.isAdmin ? h('button', { type: 'button', class: 'side-btn', onClick: () => void openAdmin(), text: '成员与设置' }) : null,
      h('button', { type: 'button', class: 'side-btn ghost', onClick: () => void refreshAll(), text: '刷新' }),
      h('div', { class: 'build-stamp', title: '服务端 build ID', text: state.meta ? `build ${state.meta.buildId}` : 'build …' })),
  )
}

function renderMain() {
  const main = h('main', { class: 'main' })
  const base = state.kbs.find(item => item.id === state.baseId)
  const currentTitle = state.view === 'files' ? state.selectedFile?.name : state.view === 'wiki' ? state.wiki.page?.title : state.view === 'sources' ? state.source?.name : state.view === 'worklogs' ? state.worklogSummary?.to_day : state.selected?.title
  main.append(h('header', { class: 'topbar' },
    h('div', { class: 'breadcrumb' },
      h('span', { text: '工作区' }), h('span', { class: 'crumb-separator', text: '/' }),
      h('strong', { text: base?.name ?? '全部知识库' }),
      h('span', { class: 'crumb-separator', text: '/' }),
      h('span', { text: state.view === 'files' ? '文件' : state.view === 'ask' ? '问答' : state.view === 'wiki' ? 'Wiki' : state.view === 'sources' ? '数据源' : state.view === 'worklogs' ? '团队日报' : '文档' }),
      currentTitle ? h('span', { class: 'crumb-current', text: ` / ${currentTitle}` }) : null),
    h('div', { class: 'doc-actions' },
      state.view === 'documents' && state.baseId !== null && state.me.canEdit ? h('button', { type: 'button', class: 'btn primary', onClick: openCreate, text: '+ 新建文档' }) : null,
      state.view === 'wiki' && state.me.canEdit ? h('button', { type: 'button', class: 'btn primary', onClick: () => void generateWiki(), text: '+ 生成 Wiki 草稿' }) : null,
      state.me.isAdmin ? h('button', { type: 'button', class: 'btn', onClick: () => void openAdmin(), text: '成员与设置' }) : null,
      h('span', { class: 'pill', text: state.me.canEdit ? '可编辑' : '只读' }))))
  const content = h('section', { class: 'content' })
  if (state.baseId === null) content.append(renderWelcome())
  else if (state.loading) content.append(h('div', { class: 'welcome' }, h('p', { text: '正在加载…' })))
  else if (state.error !== '') content.append(h('div', { class: 'welcome' }, h('p', { text: state.error })))
  else if (state.view === 'ask') content.append(renderAskDetail())
  else if (state.view === 'wiki') content.append(renderWikiDetail())
  else if (state.view === 'sources') content.append(renderSourceDetail())
  else if (state.view === 'worklogs') content.append(renderWorklogDetail())
  else if (state.view === 'files') content.append(state.selectedFile === null ? renderEmptyDetail('选择一个文件查看详情') : renderFileDetail())
  else if (state.selected === null) content.append(renderWelcome())
  else content.append(state.editing ? renderEditor() : renderReader())
  main.append(content)
  return main
}

function renderEmptyDetail(message) {
  return h('div', { class: 'welcome' }, h('div', { class: 'empty-mark', text: state.view === 'files' ? '▧' : '▤' }), h('h2', { text: message }), h('p', { text: state.view === 'files' ? '选择左侧文件列表中的条目，查看元数据或打开预览。' : '从列表选择一篇文档开始阅读。' }))
}

function renderAskDetail() {
  const ask = state.ask
  const input = h('textarea', {
    class: 'ask-input', value: ask.question, rows: '3', placeholder: '向团队知识库提问，例如：这个项目的发布流程是什么？',
    onInput: event => { ask.question = event.currentTarget.value },
    onKeyDown: event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void submit() } },
  })
  input.value = ask.question
  const submit = async () => {
    if (ask.question.trim() === '' || ask.busy) return
    ask.busy = true
    ask.error = ''
    render()
    try {
      const result = await api('/api/ask', { method: 'POST', body: JSON.stringify({ q: ask.question.trim(), baseId: state.baseId ?? '' }) })
      ask.answer = result.answer
      ask.citations = result.citations ?? []
      ask.engine = result.engine ?? ''
    } catch (error) { ask.error = error.message } finally { ask.busy = false; render() }
  }
  return h('article', { class: 'ask-detail' },
    h('header', { class: 'ask-head' },
      h('p', { class: 'eyebrow', text: '团队知识库 · 引用问答' }),
      h('h1', { text: '从知识中找答案，并回到原文' }),
      h('p', { class: 'ask-copy', text: '回答只使用当前可访问的文档和已索引文件。结果中的编号可以打开来源。' })),
    h('div', { class: 'ask-form' },
      input,
      h('div', { class: 'ask-actions' }, h('button', { type: 'button', class: 'btn primary', disabled: ask.busy, onClick: () => void submit(), text: ask.busy ? '检索中…' : '提问' }),
        h('span', { class: 'ask-engine', text: ask.engine === 'model' ? '生成模型回答' : ask.engine === 'extractive' ? '抽取式证据（未配置模型）' : 'Ctrl/⌘ + Enter 提交' })),
      ask.error ? h('p', { class: 'parse-error', text: ask.error }) : null),
    ask.answer ? h('section', { class: 'ask-answer' },
      h('div', { class: 'ask-answer-head' }, h('strong', { text: '回答' }), h('span', { class: 'pill', text: ask.engine === 'model' ? '模型' : '证据' })),
      h('pre', { class: 'ask-answer-text', text: ask.answer }),
      ask.citations.length ? h('div', { class: 'citation-list' }, ...ask.citations.map(citation => h('a', {
        class: 'citation-card', href: citation.url, target: '_blank', rel: 'noopener',
      }, h('strong', { text: `[${citation.index}] ${citation.title}` }), h('small', { text: `${citation.locator} · ${citation.kind === 'file' ? '文件' : '文档'}` }),
      citation.excerpt ? h('p', { text: citation.excerpt.slice(0, 220) }) : null))) : null) : h('div', { class: 'ask-empty' }, h('div', { class: 'empty-mark', text: '?' }), h('p', { text: '提问后会在这里显示带来源的回答。' })))
}

function renderWikiDetail() {
  const page = state.wiki.page
  if (page === null) return h('div', { class: 'welcome' }, h('div', { class: 'empty-mark', text: '▤' }), h('h2', { text: '自动 Wiki' }), h('p', { text: '从文档和已索引文件生成带引用的 Wiki 草稿，审核后再发布。' }))
  const titleInput = h('input', { class: 'wiki-title-input', value: state.wiki.draftTitle, maxlength: '240', onInput: event => { state.wiki.draftTitle = event.currentTarget.value } })
  const contentInput = h('textarea', { class: 'wiki-editor', value: state.wiki.draftContent, onInput: event => { state.wiki.draftContent = event.currentTarget.value } })
  contentInput.value = state.wiki.draftContent
  const save = async (status) => {
    state.wiki.busy = true
    try {
      const updated = await api(`/api/wiki/${encodeURIComponent(page.id)}`, { method: 'PUT', body: JSON.stringify({ title: state.wiki.draftTitle, content: state.wiki.draftContent, status }) })
      state.wiki.page = updated.page
      state.wiki.draftTitle = updated.page.title
      state.wiki.draftContent = updated.page.content
      await loadWiki()
      toast(status === 'published' ? 'Wiki 已发布' : 'Wiki 草稿已保存')
    } catch (error) { toast(error.message, 'error') } finally { state.wiki.busy = false; render() }
  }
  return h('article', { class: 'wiki-detail' },
    h('header', { class: 'wiki-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: `Wiki · ${page.status === 'published' ? '已发布' : '待审核草稿'} · v${page.version}` }), h('h1', { text: page.title })),
      h('div', { class: 'doc-actions' },
        state.me.canEdit ? h('button', { type: 'button', class: 'btn', disabled: state.wiki.busy, onClick: () => void save('draft'), text: '保存草稿' }) : null,
        state.me.canEdit ? h('button', { type: 'button', class: 'btn primary', disabled: state.wiki.busy, onClick: () => void save('published'), text: '发布' }) : null)),
    h('div', { class: 'wiki-meta' },
      h('span', { class: 'parse-badge is-parsed', text: page.status === 'published' ? '已发布' : '待审核' }),
      h('span', { class: 'note', text: `由 ${page.updated_by || page.created_by || '团队'} 更新 · ${new Date(page.updated_at).toLocaleString()}` })),
    h('div', { class: 'wiki-editor-wrap' },
      h('label', { class: 'note', text: '标题' }, titleInput),
      contentInput),
    page.sources.length ? h('section', { class: 'wiki-sources' }, h('p', { class: 'eyebrow', text: '引用来源' }), ...page.sources.map(source => h('div', { class: 'wiki-source' }, h('strong', { text: source.title }), h('small', { text: source.excerpt?.slice(0, 240) ?? '' })))) : null,
    state.wiki.versions.length ? h('section', { class: 'wiki-versions' }, h('p', { class: 'eyebrow', text: '版本历史' }), ...state.wiki.versions.slice(0, 8).map(version => h('div', { class: 'wiki-version' },
      h('span', { text: `v${version.version} · ${version.status === 'published' ? '已发布' : '草稿'} · ${new Date(version.created_at).toLocaleString()}` }),
      state.me.canEdit ? h('button', { type: 'button', class: 'btn compact', onClick: async () => { try { const result = await api(`/api/wiki/${encodeURIComponent(page.id)}/restore`, { method: 'POST', body: JSON.stringify({ version: version.version }) }); state.wiki.page = result.page; state.wiki.draftTitle = result.page.title; state.wiki.draftContent = result.page.content; toast(`已恢复 v${version.version}`); render() } catch (error) { toast(error.message, 'error') } }, text: '恢复' }) : null))) : null)
}

function renderFileDetail() {
  const file = state.selectedFile
  const type = String(file.mime || '').toLowerCase()
  const safeImage = /^image\/(?:png|jpeg|gif|webp)(?:;|$)/u.test(type)
  const safeText = /^text\/(?:plain|markdown|csv)(?:;|$)/u.test(type) || type === 'application/json'
  const parsedText = file.parseStatus === 'parsed' && !safeImage && type !== 'application/pdf' && !/^audio\//u.test(type) && !/^video\//u.test(type)
  const safeAudio = /^audio\//u.test(type)
  const safeVideo = /^video\//u.test(type)
  const preview = safeImage
    ? h('img', { class: 'file-preview-image', src: file.inlineUrl, alt: file.name })
    : type === 'application/pdf'
      ? h('iframe', { class: 'file-preview-frame', src: file.inlineUrl, title: `${file.name} 预览` })
      : safeText || parsedText
        ? h('iframe', { class: 'file-preview-frame text-preview', src: file.previewUrl, title: `${file.name} 预览`, sandbox: '' })
        : safeAudio
          ? h('audio', { class: 'file-preview-audio', controls: true, src: file.inlineUrl, title: file.name })
          : safeVideo
            ? h('video', { class: 'file-preview-video', controls: true, src: file.inlineUrl, title: file.name })
            : h('div', { class: 'file-preview-unavailable' }, h('div', { class: 'empty-mark', text: '↓' }), h('p', { text: '此格式可下载后在本地打开。' }), h('a', { class: 'btn primary', href: file.downloadUrl, text: '下载文件' }))
  return h('article', { class: 'file-detail' },
    h('header', { class: 'file-detail-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: `${file.userName || '未署名'} · 文件` }), h('h1', { class: 'doc-title', text: file.name })),
      h('div', { class: 'doc-actions' }, h('a', { class: 'btn', href: file.downloadUrl, text: '下载' }),
        state.me.canEdit ? h('button', { type: 'button', class: 'btn', onClick: () => void reparseFile(file), text: file.parseStatus === 'parsed' ? '重新解析' : '解析索引' }) : null,
        state.me.canEdit ? h('button', { type: 'button', class: 'btn danger', onClick: () => void deleteFile(file), text: '删除' }) : null)),
    h('div', { class: 'file-metadata' },
      h('span', {}, h('small', { text: `类型 · ${file.parser || '未解析'}` }), h('strong', { text: file.mime || '未知' })),
      h('span', {}, h('small', { text: '大小' }), h('strong', { text: formatFileSize(file.size) })),
      h('span', {}, h('small', { text: '上传者' }), h('strong', { text: file.userName || '未署名' })),
      h('span', {}, h('small', { text: '检索状态' }), h('strong', {}, parseBadge(file.parseStatus), file.parseError ? h('span', { class: 'parse-error', text: file.parseError }) : null))),
    h('div', { class: 'file-source-path', text: file.sourceKey || file.name }),
    file.excerpt ? h('section', { class: 'file-extract' }, h('p', { class: 'eyebrow', text: '已索引文本节选' }), h('pre', { text: file.excerpt })) : null,
    h('div', { class: 'file-preview' }, preview))
}

async function reparseFile(file) {
  try {
    const result = await api(`/api/files/${encodeURIComponent(file.id)}/reparse`, { method: 'POST', body: '{}' })
    state.files = state.files.map(row => row.id === file.id ? result.file : row)
    state.selectedFile = result.file
    render()
    toast('解析状态已更新')
  } catch (error) { toast(error.message, 'error') }
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

function switchView(view) {
  state.view = view
  state.selected = null
  state.selectedFile = null
  if (view === 'files') { render(); void loadFiles(); return }
  if (view === 'wiki') { render(); void loadWiki(); return }
  if (view === 'sources') { render(); void loadSources(); return }
  if (view === 'worklogs') { render(); void loadWorklogs(); return }
  if (view === 'documents') { render(); void loadDocuments(); return }
  render()
}

function renderContextList() {
  if (state.view === 'worklogs') return renderWorklogList()
  if (state.view === 'sources') return renderSourceList()
  if (state.view === 'ask') {
    return h('section', { class: 'resource-list' },
      h('header', { class: 'resource-list-head' }, h('div', {}, h('p', { class: 'eyebrow', text: '引用问答' }), h('strong', { text: state.ask.citations.length ? `${state.ask.citations.length} 条证据` : '等待提问' }))),
      h('div', { class: 'context-note' },
        h('p', { text: '答案只使用当前知识库中已授权的文档和已索引文件。' }),
        h('p', { text: '没有配置生成模型时，返回可核对的相关证据片段，不伪造答案。' }),
        state.ask.citations.length ? h('div', { class: 'citation-mini-list' }, ...state.ask.citations.map(citation => h('a', {
          class: 'citation-mini', href: citation.url, target: '_blank', rel: 'noopener',
          text: `[${citation.index}] ${citation.title}`,
        }))) : null))
  }
  const pages = state.wiki.pages
  const rows = pages.map(page => h('button', {
    type: 'button', class: `doc-row${state.wiki.page?.id === page.id ? ' active' : ''}`,
    onClick: () => void openWiki(page.id),
  },
  h('span', { class: 'resource-icon', text: '▤' }),
  h('span', { class: 'resource-label' },
    h('strong', { text: page.title }),
    h('small', { text: `${page.status === 'published' ? '已发布' : '草稿'} · v${page.version}` }))))
  return h('section', { class: 'resource-list' },
    h('header', { class: 'resource-list-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: '自动 Wiki' }), h('strong', { text: `${pages.length} 个页面` })),
      state.me.canEdit ? h('button', { type: 'button', class: 'btn primary compact', onClick: () => void generateWiki(), text: '生成草稿' }) : null),
    pages.length === 0
      ? h('div', { class: 'doc-empty', text: '还没有 Wiki。生成草稿后由团队审核发布。' })
      : h('div', { class: 'doc-list' }, ...rows))
}

function renderWorklogList() {
  const summaries = state.worklogSummaries
  const rows = summaries.map(summary => h('button', {
    type: 'button', class: `doc-row${state.worklogSummary?.id === summary.id ? ' active' : ''}`,
    onClick: () => { state.worklogSummary = summary; render() },
  },
  h('span', { class: 'resource-icon', text: '▤' }),
  h('span', { class: 'resource-label' },
    h('strong', { text: `${summary.from_day}${summary.to_day === summary.from_day ? '' : ` ~ ${summary.to_day}`}` }),
    h('small', { text: `${summary.engine === 'model' ? '模型汇总' : '抽取式汇总'} · ${summary.status === 'published' ? '已发布' : '待审核'}` }))))
  return h('section', { class: 'resource-list' },
    h('header', { class: 'resource-list-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: '团队日报' }), h('strong', { text: `${state.worklogs.length} 天 · ${summaries.length} 份汇总` })),
      state.me.canEdit ? h('button', { type: 'button', class: 'btn primary compact', onClick: () => void summarizeWorklogs(), text: '+ 汇总今日' }) : null),
    h('div', { class: 'context-note' },
      h('p', { text: '成员日报由本地 DSH 工作日报自动同步到云端；汇总只读，不改变成员日报。' }),
      h('p', { text: '自动汇总每天在配置时间后生成草稿；也可以随时手动生成本日汇总。' })),
    summaries.length === 0
      ? h('div', { class: 'doc-empty', text: '还没有团队日报汇总。等成员同步日报后点击「汇总今日」。' })
      : h('div', { class: 'doc-list' }, ...rows))
}

async function loadWorklogs() {
  if (state.baseId === null) return
  setLoading(true)
  try {
    const result = await api(`/api/worklogs?baseId=${encodeURIComponent(state.baseId)}`)
    state.worklogs = result.logs
    state.worklogSummaries = result.summaries
    if (state.worklogSummary === null || !state.worklogSummaries.some(item => item.id === state.worklogSummary.id)) {
      state.worklogSummary = state.worklogSummaries[0] ?? null
    }
    state.error = ''
  } catch (error) { state.error = error.message } finally { setLoading(false); render() }
}

async function summarizeWorklogs() {
  if (state.baseId === null || !state.me.canEdit) return
  try {
    const result = await api('/api/worklogs/summarize', { method: 'POST', body: JSON.stringify({ baseId: state.baseId }) })
    state.worklogSummary = result.summary
    await loadWorklogs()
    toast(`已生成 ${result.days} 天团队日报汇总`)
  } catch (error) { toast(error.message, 'error') }
}

function renderWorklogDetail() {
  const summary = state.worklogSummary
  if (summary === null) {
    return h('div', { class: 'welcome' },
      h('div', { class: 'empty-mark', text: '▤' }),
      h('h2', { text: '团队日报汇总' }),
      h('p', { text: '同步成员的工作日报后，这里会显示每日团队进展、阻塞和下一步。' }),
      state.me.canEdit ? h('button', { type: 'button', class: 'btn primary', onClick: () => void summarizeWorklogs(), text: '汇总今日日报' }) : null)
  }
  const memberNames = [...new Set(state.worklogs.filter(row => row.day >= summary.from_day && row.day <= summary.to_day).map(row => row.user_name))]
  let keywords = []
  try { keywords = JSON.parse(summary.keywords ?? '[]') } catch {}
  return h('article', { class: 'worklog-detail' },
    h('header', { class: 'worklog-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: `团队日报 · ${summary.engine === 'model' ? '模型汇总' : '抽取式汇总'}` }), h('h1', { text: `${summary.from_day}${summary.to_day === summary.from_day ? '' : ` ~ ${summary.to_day}`}` }), h('p', { class: 'source-repo', text: `${memberNames.join('、') || '暂无成员'} · ${summary.status === 'published' ? '已发布' : '待审核'}` })),
      h('div', { class: 'doc-actions' },
        summary.wiki_page_id ? h('button', { type: 'button', class: 'btn', onClick: async () => { state.view = 'wiki'; await openWiki(summary.wiki_page_id) }, text: '打开 Wiki 草稿' }) : null,
        summary.document_id ? h('button', { type: 'button', class: 'btn', onClick: async () => { state.view = 'documents'; await openDocument(summary.document_id) }, text: '打开知识文档' }) : null,
        state.me.canEdit ? h('button', { type: 'button', class: 'btn primary', onClick: () => void summarizeWorklogs(), text: '重新汇总今日' }) : null,
        state.me.canEdit ? h('button', { type: 'button', class: 'btn', onClick: async () => {
          try { const updated = await api(`/api/worklogs/summaries/${encodeURIComponent(summary.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'published' }) }); state.worklogSummary = updated.summary; toast('汇总已标记发布'); render() } catch (error) { toast(error.message, 'error') }
        }, text: '标记发布' }) : null)),
    keywords.length ? h('div', { class: 'worklog-keywords' }, h('small', { text: '模型关键词' }), ...keywords.map(keyword => h('span', { class: 'tag', text: keyword }))) : null,
    h('section', { class: 'worklog-summary' }, h('pre', { text: summary.markdown })))
}

function renderSourceList() {
  const sources = state.sources
  const rows = sources.map(source => h('button', {
    type: 'button', class: `doc-row${state.source?.id === source.id ? ' active' : ''}`,
    onClick: () => { state.source = source; render() },
  },
  h('span', { class: 'resource-icon', text: source.provider === 'github' ? '⌘' : 'G' }),
  h('span', { class: 'resource-label' },
    h('strong', { text: source.name }),
    h('small', { text: `${source.provider} · ${source.owner}/${source.repo}${source.ref ? ` @${source.ref}` : ''} · ${source.status}` }))))
  return h('section', { class: 'resource-list' },
    h('header', { class: 'resource-list-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: '数据源' }), h('strong', { text: `${sources.length} 个连接器` })),
      state.me.canEdit ? h('button', { type: 'button', class: 'btn primary compact', onClick: () => openSourceForm(), text: '+ 连接' }) : null),
    sources.length === 0
      ? h('div', { class: 'doc-empty', text: '连接 GitHub 或 Gitee 仓库，把 Markdown 同步为知识库文档。' })
      : h('div', { class: 'doc-list' }, ...rows))
}

async function loadSources() {
  if (state.baseId === null) return
  setLoading(true)
  try {
    const result = await api(`/api/sources?baseId=${encodeURIComponent(state.baseId)}`)
    state.sources = result.sources
    if (state.source && !state.sources.some(source => source.id === state.source.id)) state.source = null
    state.error = ''
  } catch (error) { state.error = error.message } finally { setLoading(false); render() }
}

function openSourceForm(source = null) {
  if (state.baseId === null) { toast('请先选择知识库', 'error'); return }
  const providerInput = h('select', {}, h('option', { value: 'github', selected: source?.provider === 'github', text: 'GitHub' }), h('option', { value: 'gitee', selected: source?.provider === 'gitee', text: 'Gitee' }))
  const nameInput = h('input', { value: source?.name ?? '', placeholder: '例如：产品文档', maxlength: '120', required: true })
  const ownerInput = h('input', { value: source?.owner ?? '', placeholder: 'owner', maxlength: '120', required: true })
  const repoInput = h('input', { value: source?.repo ?? '', placeholder: 'repo', maxlength: '120', required: true })
  const refInput = h('input', { value: source?.ref ?? '', placeholder: 'main（留空使用默认分支）', maxlength: '120' })
  const includeInput = h('input', { value: source?.includePattern ?? '', placeholder: '路径包含，例如 docs/ 或 .md', maxlength: '200' })
  const groupInput = h('input', { value: source?.sourceGroup ?? '', placeholder: '默认 数据源/provider/owner/repo', maxlength: '160' })
  const tokenInput = h('input', { type: 'password', value: '', placeholder: source?.hasToken ? '已保存 Token；留空保持不变' : '私有仓库 Token（可选）', autocomplete: 'new-password' })
  const close = () => document.querySelector('.modal-backdrop')?.remove()
  const save = async event => {
    event.preventDefault()
    try {
      const body = { baseId: state.baseId, provider: providerInput.value, name: nameInput.value, owner: ownerInput.value, repo: repoInput.value, ref: refInput.value, token: tokenInput.value, includePattern: includeInput.value, group: groupInput.value }
      const result = source
        ? await api(`/api/sources/${encodeURIComponent(source.id)}`, { method: 'PUT', body: JSON.stringify(body) })
        : await api('/api/sources', { method: 'POST', body: JSON.stringify(body) })
      close()
      await loadSources()
      state.source = result.source ?? null
      toast(source ? '数据源已更新' : '数据源已连接')
    } catch (error) { toast(error.message, 'error') }
  }
  const modal = h('div', { class: 'modal-backdrop', onClick: event => { if (event.target === event.currentTarget) close() } },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': '连接数据源' },
      h('div', { class: 'modal-head' }, h('h2', { text: source ? '编辑数据源' : '连接数据源' }), h('button', { type: 'button', class: 'icon-btn', onClick: close, text: '关闭' })),
      h('form', { class: 'form-grid', onSubmit: save },
        h('label', {}, '类型', providerInput),
        h('label', {}, '显示名称', nameInput),
        h('label', {}, '仓库 owner', ownerInput),
        h('label', {}, '仓库 repo', repoInput),
        h('label', {}, '分支或引用', refInput),
        h('label', {}, '路径过滤', includeInput),
        h('label', {}, '文档分组', groupInput),
        h('label', {}, 'Token', tokenInput),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onClick: close, text: '取消' }), h('button', { type: 'submit', class: 'btn primary', text: '保存' })))))
  document.body.append(modal)
  nameInput.focus()
}

async function syncSource(source) {
  try {
    state.source = { ...source, status: 'syncing' }
    render()
    const result = await api(`/api/sources/${encodeURIComponent(source.id)}/sync`, { method: 'POST', body: '{}' })
    await loadSources()
    state.source = result.source
    render()
    toast(`同步完成：新增 ${result.created}，更新 ${result.updated}，失败 ${result.failed}`)
  } catch (error) { toast(error.message, 'error') }
}

async function deleteSource(source) {
  if (!confirm(`删除数据源「${source.name}」？已导入的文档会保留。`)) return
  try {
    await api(`/api/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' })
    state.source = null
    await loadSources()
    toast('数据源已删除')
  } catch (error) { toast(error.message, 'error') }
}

function renderSourceDetail() {
  const source = state.source
  if (source === null) return h('div', { class: 'welcome' }, h('div', { class: 'empty-mark', text: '⇄' }), h('h2', { text: '数据源' }), h('p', { text: '连接 GitHub 或 Gitee 仓库，把 Markdown 和文本文件同步到当前知识库。' }))
  return h('article', { class: 'source-detail' },
    h('header', { class: 'source-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: `${source.provider} · 数据源` }), h('h1', { text: source.name }), h('p', { class: 'source-repo', text: `${source.owner}/${source.repo}${source.ref ? ` @ ${source.ref}` : ''}` })),
      h('div', { class: 'doc-actions' },
        state.me.canEdit ? h('button', { type: 'button', class: 'btn primary', onClick: () => void syncSource(source), text: source.status === 'syncing' ? '同步中…' : '立即同步' }) : null,
        state.me.canEdit ? h('button', { type: 'button', class: 'btn', onClick: () => openSourceForm(source), text: '编辑' }) : null,
        state.me.canEdit ? h('button', { type: 'button', class: 'btn danger', onClick: () => void deleteSource(source), text: '删除' }) : null)),
    h('div', { class: 'file-metadata' },
      h('span', {}, h('small', { text: '状态' }), h('strong', {}, h('span', { class: `parse-badge is-${source.status === 'synced' ? 'parsed' : source.status === 'error' ? 'failed' : 'pending'}`, text: sourceStatusLabel(source.status) }))),
      h('span', {}, h('small', { text: '上次同步' }), h('strong', { text: source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString() : '从未同步' })),
      h('span', {}, h('small', { text: '路径过滤' }), h('strong', { text: source.includePattern || '全部文本文件' })),
      h('span', {}, h('small', { text: '文档分组' }), h('strong', { text: source.sourceGroup || `数据源/${source.provider}/${source.owner}/${source.repo}` }))),
    source.error ? h('p', { class: 'parse-error', text: source.error }) : null,
    h('div', { class: 'source-note' },
      h('p', { text: '同步规则：读取仓库中的 Markdown、文本、PDF、DOCX、XLSX、PPTX、EPUB 文件，按路径映射到文档；重复同步会更新已有文档，不会无限创建。已删除的仓库文件不会自动删掉本地文档。' }),
      h('p', { text: '公开仓库无需 Token；私有仓库填写 Token。Token 只保存在服务端数据库，不会从接口返回。' })))
}

async function generateWiki() {
  if (state.baseId === null) return
  const title = window.prompt('Wiki 标题', state.selected?.title ?? '')
  if (title === null || title.trim() === '') return
  const topic = window.prompt('整理主题（可留空）', title) ?? title
  try {
    const result = await api('/api/wiki/generate', { method: 'POST', body: JSON.stringify({ baseId: state.baseId, title: title.trim(), topic: topic.trim() || title.trim() }) })
    state.wiki.page = result.page
    state.wiki.draftTitle = result.page.title
    state.wiki.draftContent = result.page.content
    await loadWiki()
    toast(`Wiki 草稿已生成（${result.engine === 'model' ? '模型' : '抽取式'}）`)
  } catch (error) { toast(error.message, 'error') }
}

async function loadWiki() {
  if (state.baseId === null) return
  setLoading(true)
  try {
    const result = await api(`/api/wiki?baseId=${encodeURIComponent(state.baseId)}`)
    state.wiki.pages = result.pages
    state.error = ''
  } catch (error) { state.error = error.message } finally { setLoading(false); render() }
}

async function openWiki(id) {
  setLoading(true)
  try {
    const result = await api(`/api/wiki/${encodeURIComponent(id)}`)
    state.wiki.page = result.page
    state.wiki.versions = result.versions
    state.wiki.draftTitle = result.page.title
    state.wiki.draftContent = result.page.content
    state.error = ''
  } catch (error) { state.error = error.message } finally { setLoading(false); render() }
}

function renderDocumentList() {
  const groups = ['全部分组', ...state.groups]
  const filter = h('select', { class: 'list-filter', value: state.groupFilter, 'aria-label': '按分组筛选', onChange: event => { state.groupFilter = event.currentTarget.value; render() } },
    ...groups.map(group => h('option', { value: group === '全部分组' ? '' : group, selected: (group === '全部分组' ? '' : group) === state.groupFilter, text: group })))
  const documents = state.groupFilter === '' ? state.documents : state.documents.filter(row => (row.group || '未分组') === state.groupFilter)
  const byGroup = new Map()
  for (const document of documents) {
    const group = document.group || '未分组'
    if (!byGroup.has(group)) byGroup.set(group, [])
    byGroup.get(group).push(document)
  }
  const sections = [...byGroup.entries()].map(([group, items]) => {
    const rows = items.map(document => h('button', {
      type: 'button', class: `doc-row${state.selected?.id === document.id ? ' active' : ''}`,
      onClick: () => void openDocument(document.id),
    },
    h('span', { class: 'resource-icon', text: '▤' }),
    h('span', { class: 'resource-label' },
      h('strong', { text: document.title }),
      h('small', { text: document.group || '未分组' }))))
    return h('section', { class: 'doc-group' },
      h('div', { class: 'doc-group-head' }, h('strong', { text: group }), h('span', { text: `${items.length}` })),
      ...rows)
  })
  return h('section', { class: 'resource-list' },
    h('header', { class: 'resource-list-head' }, h('div', {}, h('p', { class: 'eyebrow', text: '文档目录' }), h('strong', { text: `${documents.length} 篇 · ${byGroup.size} 个分组` })), filter),
    sections.length === 0 ? h('div', { class: 'doc-empty', text: state.query === '' ? '这个知识库还没有文档。' : '没有匹配的文档。' }) : h('div', { class: 'doc-list' }, ...sections))
}

function renderFileList() {
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onChange: event => { const files = event.currentTarget.files; if (files) void uploadFiles([...files]); event.currentTarget.value = '' } })
  const folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, onChange: event => { const files = event.currentTarget.files; if (files) void uploadFiles([...files]); event.currentTarget.value = '' } })
  const query = state.query.trim().toLowerCase()
  const files = state.files.filter(file => query === '' || `${file.name} ${file.sourceKey || ''} ${file.userName || ''} ${file.mime || ''}`.toLowerCase().includes(query))
  const statusCounts = {
    parsed: files.filter(file => file.parseStatus === 'parsed').length,
    pending: files.filter(file => file.parseStatus === 'pending').length,
    unsupported: files.filter(file => file.parseStatus === 'unsupported').length,
    failed: files.filter(file => file.parseStatus === 'failed').length,
  }
  const users = [...new Set(files.map(file => file.userName || '未署名'))].sort((a, b) => a.localeCompare(b))
  const rows = users.flatMap(user => [
    h('div', { class: 'file-user-heading', text: user }),
    ...files.filter(file => (file.userName || '未署名') === user).map(file => h('button', {
      type: 'button', class: `doc-row file-entry${state.selectedFile?.id === file.id ? ' active' : ''}`,
      onClick: () => { state.selectedFile = file; render() },
    }, h('span', { class: 'resource-icon', text: '▧' }), h('span', { class: 'resource-label' },
      h('strong', { text: file.name }), h('small', { text: `${parseLabel(file.parseStatus)} · ${file.sourceKey || file.name} · ${formatFileSize(file.size)}` }))))
  ])
  return h('section', { class: 'resource-list' },
    h('header', { class: 'resource-list-head' },
      h('div', {}, h('p', { class: 'eyebrow', text: '文件' }), h('strong', { text: `${files.length} 个文件` })),
      state.me.canEdit ? h('div', { class: 'upload-actions' },
        h('button', { type: 'button', class: 'btn primary', onClick: () => fileInput.click(), text: '上传' }),
        h('button', { type: 'button', class: 'btn', onClick: () => folderInput.click(), text: '上传文件夹' }), fileInput, folderInput) : null),
    h('p', { class: 'file-support-note', text: '支持 PDF、DOCX、XLSX、PPTX、EPUB、Markdown/文本、图片和音视频；图片需配置 OCR 后才能进入检索。' }),
    h('div', { class: 'file-status-summary', 'aria-label': '文件解析状态汇总' },
      h('span', { class: 'is-parsed', text: `已索引 ${statusCounts.parsed}` }),
      h('span', { class: 'is-pending', text: `待解析 ${statusCounts.pending}` }),
      h('span', { class: 'is-unsupported', text: `仅存储 ${statusCounts.unsupported}` }),
      statusCounts.failed > 0 ? h('span', { class: 'is-failed', text: `失败 ${statusCounts.failed}` }) : null),
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
  else if (state.view === 'sources') await loadSources()
  else if (state.view === 'worklogs') await loadWorklogs()
  else if (state.view === 'wiki') await loadWiki()
  else if (state.view !== 'ask') await loadDocuments()
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
    state.meta = await api('/api/meta').catch(() => null)
    await refreshKbs()
    await loadGroups()
    if (state.view === 'files') await loadFiles()
    else if (state.view === 'sources') await loadSources()
    else if (state.view === 'worklogs') await loadWorklogs()
    else if (state.view === 'wiki') await loadWiki()
    else if (state.view !== 'ask') await loadDocuments()
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

function parseLabel(status) {
  return { parsed: '已索引', pending: '待解析', unsupported: '仅存储', failed: '解析失败' }[status] || '待解析'
}

function parseBadge(status) {
  return h('span', { class: `parse-badge is-${status || 'pending'}`, text: parseLabel(status) })
}

function sourceStatusLabel(status) {
  return { synced: '已同步', syncing: '同步中', partial: '部分失败', error: '同步失败', idle: '未同步' }[status] || status || '未同步'
}

async function openAdmin() {
  try {
    const [userResult, tokenResult, modelResult] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/tokens'),
      api('/api/admin/model'),
    ])
    state.admin = { open: true, users: userResult.users, tokens: tokenResult.tokens, model: modelResult.model, error: '' }
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
  const model = state.admin.model ?? {}
  const modelBase = h('input', { type: 'url', value: model.baseUrl ?? '', placeholder: 'https://api.example.com/v1' })
  const modelName = h('input', { value: model.model ?? '', placeholder: '例如 deepseek-chat', maxlength: '200' })
  const modelKey = h('input', { type: 'password', value: '', placeholder: model.hasApiKey ? '已保存 API Key；留空保持不变' : 'API Key（可选）', autocomplete: 'new-password' })
  const clearModelKey = h('input', { type: 'checkbox' })
  const modelMaxInput = h('input', { type: 'number', min: '256', max: '128000', step: '1', value: String(model.maxInputTokens ?? 16000) })
  const modelMaxOutput = h('input', { type: 'number', min: '64', max: '32000', step: '1', value: String(model.maxOutputTokens ?? 2400) })
  const modelFormat = h('select', {},
    h('option', { value: 'auto', selected: model.outputFormat === 'auto', text: '自动（问答/Wiki Markdown；日报 JSON）' }),
    h('option', { value: 'markdown', selected: model.outputFormat === 'markdown', text: 'Markdown' }),
    h('option', { value: 'text', selected: model.outputFormat === 'text', text: '纯文本' }),
    h('option', { value: 'json', selected: model.outputFormat === 'json', text: 'JSON' }),
    h('option', { value: 'custom', selected: model.outputFormat === 'custom', text: '自定义' }))
  const modelInstructions = h('textarea', { class: 'model-instructions', rows: '3', maxlength: '4000', placeholder: '例如：先给结论，再列风险和待办；不要使用表格' }, model.outputInstructions ?? '')
  const saveModel = async () => {
    try {
      const result = await api('/api/admin/model', { method: 'PUT', body: JSON.stringify({
        baseUrl: modelBase.value,
        model: modelName.value,
        apiKey: modelKey.value,
        clearApiKey: clearModelKey.checked,
        maxInputTokens: Number(modelMaxInput.value),
        maxOutputTokens: Number(modelMaxOutput.value),
        outputFormat: modelFormat.value,
        outputInstructions: modelInstructions.value,
      }) })
      state.admin.model = result.model
      render()
      toast(result.model.enabled ? '模型设置已保存并生效' : '模型设置已保存；当前仍未启用')
    } catch (error) { toast(error.message, 'error') }
  }
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
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '成员与设置' },
      h('div', { class: 'modal-head' }, h('h2', { text: '成员与设置' }), h('button', { type: 'button', class: 'icon-btn', onClick: close, text: '关闭' })),
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
      tokenRows.length > 0 ? h('div', { style: 'margin-top:12px' }, h('p', { class: 'note', text: '已签发的 Token' }), ...tokenRows) : null,
      h('div', { class: 'modal-head', style: 'margin-top:18px' }, h('h2', { text: '模型设置（可选）' })),
      h('p', { class: 'note', text: '用于云端问答、Wiki 和团队日报汇总。保存后立即生效并持久化；API Key 不会从接口返回。未配置时使用抽取式证据。' }),
      h('div', { class: 'form-grid' },
        h('label', {}, 'OpenAI 兼容接口', modelBase),
        h('label', {}, '模型名', modelName),
        h('label', {}, 'API Key', modelKey),
        h('label', { class: 'note' }, clearModelKey, ' 清除已保存的 API Key'),
        h('label', {}, '最大输入 token（估算）', modelMaxInput),
        h('label', {}, '最大输出 token', modelMaxOutput),
        h('label', {}, '输出格式', modelFormat),
        h('label', {}, '自定义输出说明', modelInstructions)),
      h('p', { class: 'note', text: '输入预算会按估算截断检索证据，避免超限；输出 token 对所有云端模型调用生效。日报汇总依赖 JSON 字段，选择非 JSON 格式时会退化为抽取式汇总。' }),
      h('div', { class: 'savebar' },
        h('span', { class: 'grow note', text: `${model.enabled ? '当前已启用' : '当前未启用'} · ${model.source === 'database' ? '页面配置' : model.source === 'environment' ? '环境变量' : '无配置'} · 输入 ${model.maxInputTokens ?? 16000} / 输出 ${model.maxOutputTokens ?? 2400} · ${model.outputFormat ?? 'auto'}${model.hasApiKey ? ' · Key 已保存' : ' · 无 Key'}` }),
        h('button', { type: 'button', class: 'btn primary', onClick: () => void saveModel(), text: '保存模型设置' }))))
}

window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault()
    document.querySelector('.editor button[type=submit]')?.click()
  }
})

refreshAll()
