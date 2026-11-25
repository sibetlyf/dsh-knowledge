// 独立团队知识库服务：只依赖 Node.js 24 + 本仓库的存储层，不需要安装 DSH。
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { renderSharedMarkdown } from '../lib/notes/share-markdown.js'
import { TeamError, TeamStore } from './team-store.mjs'
import { renderAppPage, renderErrorPage, renderInvitePage, renderLoginPage, renderSetupPage, roleLabel } from './views.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const publicDir = join(here, 'public')
const dataDir = resolve(process.env.TEAM_DATA_DIR ?? join(here, '..', 'cloud-data'))
const port = integerEnv('TEAM_PORT', 8787, 1, 65535)
const host = process.env.TEAM_HOST?.trim() || '127.0.0.1'
const title = process.env.TEAM_TITLE?.trim() || '团队知识库'
const sessionDays = integerEnv('TEAM_SESSION_DAYS', 7, 1, 30)
const maxBody = integerEnv('TEAM_MAX_BODY_BYTES', 5 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024)
const trustProxy = process.env.TEAM_TRUST_PROXY === '1'
const publicOrigin = process.env.TEAM_PUBLIC_ORIGIN?.trim()
const kbDbPath = resolve(process.env.TEAM_KB_DB?.trim() || join(dataDir, 'knowledge.sqlite'))
const teamDbPath = resolve(process.env.TEAM_TEAM_DB?.trim() || join(dataDir, 'team.sqlite'))

mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const team = new TeamStore(teamDbPath)
const provider = new LocalKnowledgeProvider(kbDbPath)
let closing = false

function integerEnv(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}-${max} 的整数`)
  return value
}

function cookie(req, name) {
  const raw = req.headers.cookie
  if (raw === undefined) return undefined
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function isSecure(req) {
  if (publicOrigin?.startsWith('https://')) return true
  if (trustProxy && firstHeader(req.headers['x-forwarded-proto']) === 'https') return true
  return Boolean(req.socket.encrypted)
}

function sessionCookie(req, token, maxAgeSeconds) {
  const attrs = [`kb_session=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`]
  if (isSecure(req)) attrs.push('Secure')
  return attrs.join('; ')
}

function clearCookie(req) {
  const attrs = ['kb_session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (isSecure(req)) attrs.push('Secure')
  return attrs.join('; ')
}

function firstHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim()
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(body)
}

function sendHtml(res, status, html, headers = {}) {
  send(res, status, html, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  })
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
}

function redirect(res, location, headers = {}) {
  send(res, 302, '', { location, ...headers })
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBody) throw new HttpError(413, '请求内容过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const body = await readBody(req)
  if (body.length === 0) return {}
  try { return JSON.parse(body.toString('utf8')) } catch { throw new HttpError(400, 'JSON 格式不正确') }
}

async function readForm(req) {
  const body = await readBody(req)
  return Object.fromEntries(new URLSearchParams(body.toString('utf8')))
}

function safeNext(value) {
  const raw = String(value ?? '/')
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
}

function requestOrigin(req) {
  if (publicOrigin) return publicOrigin
  const protocol = isSecure(req) ? 'https' : 'http'
  return `${protocol}://${firstHeader(req.headers['x-forwarded-host']) ?? req.headers.host ?? '127.0.0.1'}`
}

function currentSession(req) {
  const token = cookie(req, 'kb_session')
  return token === undefined ? undefined : team.session(token)
}

function requireSession(req) {
  const session = currentSession(req)
  if (session === undefined) throw new HttpError(401, '请先登录')
  return session
}

function requireRole(session, roles) {
  if (!roles.includes(session.user.role)) throw new HttpError(403, '当前角色没有这个操作权限')
}

function requireCsrf(req, session) {
  const token = firstHeader(req.headers['x-csrf-token'])
  if (token === undefined || token !== session.csrf) throw new HttpError(403, 'CSRF 校验失败，请刷新页面重试')
}

function loginRate(req) {
  const ip = (trustProxy ? firstHeader(req.headers['x-forwarded-for']) : undefined) ?? req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  const row = loginAttempts.get(ip)
  if (row === undefined || now - row.start > 10 * 60_000) {
    loginAttempts.set(ip, { start: now, count: 1 })
    return true
  }
  row.count += 1
  if (row.count > 20) return false
  return true
}

const loginAttempts = new Map()

function setLoginCookie(req, res, session) {
  const maxAge = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000))
  res.setHeader('set-cookie', sessionCookie(req, session.token, maxAge))
}

function providerError(error) {
  if (error?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: knowledge_entries\.content_hash/u.test(String(error.message))) {
    return new HttpError(409, '这篇文档的正文与知识库中另一篇文档完全相同，请修改后再保存。')
  }
  return error
}

function summarizeEntry(entry) {
  return {
    id: entry.id,
    knowledgeBaseId: entry.knowledgeBaseId,
    title: entry.title,
    group: entry.group ?? '',
    type: entry.type,
    tags: entry.tags,
    version: entry.version,
    updatedAt: entry.updatedAt,
    status: entry.status,
    documentState: entry.documentState,
  }
}

function draftFrom(entry, changes = {}) {
  return {
    knowledgeBaseId: entry.knowledgeBaseId,
    title: changes.title ?? entry.title,
    body: changes.body ?? entry.body,
    type: entry.type,
    tags: entry.tags,
    scope: entry.scope,
    confidence: entry.confidence,
    ...(entry.group === undefined || entry.group === '' ? {} : { group: entry.group }),
  }
}

async function listAllDocuments(baseId, query) {
  const documents = []
  let cursor
  let total = 0
  do {
    const page = await provider.listDocumentIndex({
      ...(baseId === undefined ? {} : { knowledgeBaseIds: [baseId] }),
      ...(query === undefined || query === '' ? {} : { query }),
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })
    documents.push(...page.items)
    total = page.total
    cursor = page.nextCursor
  } while (cursor !== undefined && documents.length < 2000)
  return { documents, total }
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', requestOrigin(req))
  const method = req.method ?? 'GET'
  const path = url.pathname

  if (path === '/api/health') return sendJson(res, 200, { ok: true, service: 'team-knowledge' })

  // ---- auth pages ------------------------------------------------------------
  if (path === '/login' && method === 'GET') {
    if (team.countUsers() === 0) return redirect(res, '/setup')
    if (currentSession(req) !== undefined) return redirect(res, '/')
    return sendHtml(res, 200, renderLoginPage({ next: safeNext(url.searchParams.get('next')), error: url.searchParams.get('error') ?? '' }))
  }
  if (path === '/login' && method === 'POST') {
    if (!loginRate(req)) return sendHtml(res, 429, renderLoginPage({ error: '尝试次数过多，请稍后再试', next: safeNext((await readForm(req)).next) }))
    const form = await readForm(req)
    const user = team.authenticate(form.email, form.password)
    if (user === undefined) return sendHtml(res, 401, renderLoginPage({ error: '邮箱或密码不正确，或账号已停用', next: safeNext(form.next) }))
    const session = team.createSession(user.id, sessionDays)
    team.audit(user.id, 'login', user.id)
    setLoginCookie(req, res, session)
    return redirect(res, safeNext(form.next))
  }
  if (path === '/setup' && method === 'GET') {
    if (team.countUsers() > 0) return redirect(res, '/login')
    return sendHtml(res, 200, renderSetupPage())
  }
  if (path === '/setup' && method === 'POST') {
    if (team.countUsers() > 0) throw new HttpError(409, '管理员已经创建')
    const form = await readForm(req)
    if (form.password !== form.confirm) throw new HttpError(400, '两次密码不一致')
    const user = team.createUser({ email: form.email, name: form.name, password: form.password, role: 'admin' })
    const session = team.createSession(user.id, sessionDays)
    setLoginCookie(req, res, session)
    return redirect(res, '/')
  }
  if (path === '/logout' && method === 'POST') {
    const session = currentSession(req)
    if (session !== undefined) {
      requireCsrf(req, session)
      team.deleteSession(cookie(req, 'kb_session'))
    }
    res.setHeader('set-cookie', clearCookie(req))
    return redirect(res, '/login')
  }
  if (path.startsWith('/invite/') && method === 'GET') {
    const token = path.slice('/invite/'.length)
    const invite = team.inspectInvite(token)
    if (invite === undefined) return sendHtml(res, 410, renderErrorPage(410, '邀请链接已失效或已被使用'))
    return sendHtml(res, 200, renderInvitePage({ token, role: invite.role }))
  }
  if (path.startsWith('/invite/') && method === 'POST') {
    const token = path.slice('/invite/'.length)
    const form = await readForm(req)
    if (form.password !== form.confirm) throw new HttpError(400, '两次密码不一致')
    const user = team.acceptInvite(token, { email: form.email, name: form.name, password: form.password })
    const session = team.createSession(user.id, sessionDays)
    setLoginCookie(req, res, session)
    team.audit(user.id, 'invite.accept', user.id, roleLabel(user.role))
    return redirect(res, '/')
  }

  // ---- assets ----------------------------------------------------------------
  if (path.startsWith('/assets/') && method === 'GET') {
    const name = path.slice('/assets/'.length)
    if (!/^[a-z0-9._-]+$/u.test(name)) throw new HttpError(404, '资源不存在')
    const file = join(publicDir, name)
    if (!existsSync(file)) throw new HttpError(404, '资源不存在')
    res.writeHead(200, {
      'content-type': name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    })
    createReadStream(file).pipe(res)
    return
  }

  // ---- app shell -------------------------------------------------------------
  if (path === '/' && method === 'GET') {
    if (team.countUsers() === 0) return redirect(res, '/setup')
    const session = currentSession(req)
    if (session === undefined) return redirect(res, '/login?next=%2F')
    return sendHtml(res, 200, renderAppPage({ title }))
  }

  // ---- api -------------------------------------------------------------------
  if (!path.startsWith('/api/')) throw new HttpError(404, '页面不存在')
  const session = requireSession(req)

  if (path === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { user: session.user, csrf: session.csrf, title, roleLabel: roleLabel(session.user.role), canEdit: ['admin', 'editor'].includes(session.user.role), isAdmin: session.user.role === 'admin' })
  }

  if (method !== 'GET' && method !== 'HEAD') requireCsrf(req, session)

  if (path === '/api/kbs' && method === 'GET') {
    const bases = (await provider.listKnowledgeBases()).filter(base => base.status === 'active')
    const rows = []
    for (const base of bases) {
      const page = await provider.listDocumentIndex({ knowledgeBaseIds: [base.id], limit: 1 })
      rows.push({ id: base.id, name: base.name, description: base.description ?? '', documentCount: page.total })
    }
    return sendJson(res, 200, { kbs: rows })
  }

  if (path === '/api/documents' && method === 'GET') {
    const baseId = url.searchParams.get('baseId') ?? undefined
    const query = url.searchParams.get('q')?.trim() || undefined
    if (baseId !== undefined) {
      const base = await provider.getKnowledgeBase(baseId)
      if (base === undefined || base.status !== 'active') throw new HttpError(404, '知识库不存在')
    }
    const all = await listAllDocuments(baseId, query)
    return sendJson(res, 200, { documents: all.documents, total: all.total, truncated: all.documents.length >= 2000 && all.total > all.documents.length })
  }

  if (path === '/api/search' && method === 'GET') {
    const query = url.searchParams.get('q')?.trim() ?? ''
    if (query === '') return sendJson(res, 200, { hits: [] })
    const baseId = url.searchParams.get('baseId') ?? undefined
    const hits = await provider.search({
      text: query,
      includePassage: true,
      limit: 20,
      ...(baseId === undefined ? {} : { knowledgeBaseIds: [baseId] }),
    })
    return sendJson(res, 200, {
      hits: hits.map(hit => ({
        ...summarizeEntry(hit.entry),
        score: hit.score,
        passage: hit.passage === undefined ? undefined : { text: hit.passage.text, startLine: hit.passage.startLine, endLine: hit.passage.endLine },
      })),
    })
  }

  if (path === '/api/groups' && method === 'GET') {
    const baseId = url.searchParams.get('baseId') ?? ''
    const base = await provider.getKnowledgeBase(baseId)
    if (base === undefined || base.status !== 'active') throw new HttpError(404, '知识库不存在')
    const groups = await provider.listDocumentGroups(baseId)
    return sendJson(res, 200, { groups: groups.map(group => group.name) })
  }

  if (path === '/api/document' && method === 'POST') {
    requireRole(session, ['admin', 'editor'])
    const body = await readJson(req)
    const base = await provider.getKnowledgeBase(String(body.knowledgeBaseId ?? ''))
    if (base === undefined || base.status !== 'active') throw new HttpError(400, '请选择可用的知识库')
    const titleValue = String(body.title ?? '').trim()
    const bodyValue = String(body.body ?? '')
    const groupValue = String(body.group ?? '').trim()
    if (titleValue.length === 0) throw new HttpError(400, '标题不能为空')
    if (groupValue === '' || groupValue === '未分组') throw new HttpError(400, '请选择或填写文档分组')
    if (groupValue.length > 64) throw new HttpError(400, '分组名称不能超过 64 个字符')
    if (titleValue.length > 240) throw new HttpError(400, '标题过长')
    if (bodyValue.length > maxBody) throw new HttpError(413, '正文过长')
    const entry = await provider.create({
      knowledgeBaseId: base.id,
      title: titleValue,
      body: bodyValue,
      type: 'fact',
      tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 12) : [],
      scope: { kind: 'global' },
      confidence: 1,
      group: groupValue,
    }).catch(error => { throw providerError(error) })
    team.audit(session.user.id, 'document.create', entry.id, titleValue)
    return sendJson(res, 201, { document: summarizeEntry(entry) })
  }

  const documentMatch = /^\/api\/document\/([a-f0-9-]{36})(?:\/raw|\/versions)?$/u.exec(path)
  if (documentMatch !== null) {
    const id = documentMatch[1]
    const entry = await provider.get(id)
    if (entry === undefined || entry.status !== 'active') throw new HttpError(404, '文档不存在或已归档')

    if (path.endsWith('/raw') && method === 'GET') {
      return send(res, 200, entry.body, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${encodeURIComponent(entry.title)}.md"`,
        'cache-control': 'no-store',
      })
    }

    if (path.endsWith('/versions') && method === 'GET') {
      return sendJson(res, 200, { versions: await provider.versions(id) })
    }

    if (path === `/api/document/${id}` && method === 'GET') {
      const html = renderSharedMarkdown(entry.body).html
      return sendJson(res, 200, {
        document: {
          ...summarizeEntry(entry),
          body: entry.body,
          html,
          group: entry.group ?? '',
          tags: entry.tags,
        },
      })
    }

    if (path === `/api/document/${id}` && method === 'PUT') {
      requireRole(session, ['admin', 'editor'])
      const body = await readJson(req)
      const expectedVersion = Number(body.expectedVersion)
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new HttpError(400, 'expectedVersion 必须是正整数')
      const titleValue = String(body.title ?? entry.title).trim()
      const bodyValue = String(body.body ?? entry.body)
      if (titleValue.length === 0) throw new HttpError(400, '标题不能为空')
      if (titleValue.length > 240) throw new HttpError(400, '标题过长')
      if (bodyValue.length > maxBody) throw new HttpError(413, '正文过长')
      try {
        const updated = await provider.update(id, draftFrom(entry, { title: titleValue, body: bodyValue }), undefined, expectedVersion)
        team.audit(session.user.id, 'document.update', id, titleValue)
        return sendJson(res, 200, { document: { ...summarizeEntry(updated), body: updated.body, html: renderSharedMarkdown(updated.body).html, tags: updated.tags, group: updated.group ?? '' } })
      } catch (error) {
        if (error?.code === 'CONFLICT') {
          const current = await provider.get(id)
          return sendJson(res, 409, {
            error: '文档已被其他人修改，请先查看最新版再保存。你的草稿仍保留在当前页面。',
            code: 'CONFLICT',
            current: current === undefined ? undefined : { ...summarizeEntry(current), body: current.body, html: renderSharedMarkdown(current.body).html, tags: current.tags, group: current.group ?? '' },
          })
        }
        throw providerError(error)
      }
    }
  }

  // ---- admin -----------------------------------------------------------------
  if (path === '/api/admin/users' && method === 'GET') {
    requireRole(session, ['admin'])
    return sendJson(res, 200, { users: team.listUsers(), invitePath: '/invite/' })
  }

  if (path === '/api/admin/invites' && method === 'POST') {
    requireRole(session, ['admin'])
    const body = await readJson(req)
    const role = body.role ?? 'editor'
    if (!['admin', 'editor', 'viewer'].includes(role)) throw new HttpError(400, '角色无效')
    const hours = Number(body.expiresHours ?? 168)
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) throw new HttpError(400, '有效期必须在 1-720 小时')
    const invite = team.createInvite({ role, createdBy: session.user.id, expiresHours: hours })
    return sendJson(res, 201, { invite: { ...invite, path: `/invite/${invite.token}` } })
  }

  if (path === '/api/admin/audit' && method === 'GET') {
    requireRole(session, ['admin'])
    return sendJson(res, 200, { audit: team.listAudit(200) })
  }

  const userMatch = /^\/api\/admin\/users\/([a-f0-9-]{36})$/u.exec(path)
  if (userMatch !== null && method === 'PATCH') {
    requireRole(session, ['admin'])
    const body = await readJson(req)
    const target = team.getUser(userMatch[1])
    if (target === undefined) throw new HttpError(404, '成员不存在')
    if (target.id === session.user.id && body.active === false) throw new HttpError(400, '不能停用自己')
    if (target.id === session.user.id && body.role !== undefined && body.role !== 'admin' && target.role === 'admin') {
      const adminCount = team.listUsers().filter(user => user.role === 'admin' && user.active).length
      if (adminCount <= 1) throw new HttpError(400, '至少需要保留一个管理员')
    }
    const updated = team.updateUser(target.id, {
      ...(body.role === undefined ? {} : { role: body.role }),
      ...(body.active === undefined ? {} : { active: Boolean(body.active) }),
    }, session.user.id)
    return sendJson(res, 200, { user: updated })
  }

  throw new HttpError(404, '接口不存在')
}

async function bootstrap() {
  const email = process.env.TEAM_ADMIN_EMAIL?.trim()
  const password = process.env.TEAM_ADMIN_PASSWORD
  if (team.countUsers() > 0) return
  if (email === undefined || email === '') {
    console.log('[team-kb] 首次启动：请打开 /setup 创建管理员')
    return
  }
  if (typeof password !== 'string' || password.length < 10) throw new Error('TEAM_ADMIN_PASSWORD 至少 10 位')
  const user = team.createUser({ email, name: process.env.TEAM_ADMIN_NAME?.trim() || '管理员', password, role: 'admin' })
  console.log(`[team-kb] 已创建初始管理员：${user.email}`)
}

await bootstrap()

const server = createServer((req, res) => {
  if (closing) return send(res, 503, '服务正在关闭')
  handle(req, res).catch(error => {
    const status = error instanceof HttpError ? error.status : error instanceof TeamError ? error.status : 500
    const message = error instanceof HttpError || error instanceof TeamError ? error.message : '服务器内部错误'
    if (!(error instanceof HttpError || error instanceof TeamError)) console.error('[team-kb]', error)
    if (String(req.url ?? '').startsWith('/api/')) sendJson(res, status, { error: message, ...(error?.code === undefined ? {} : { code: error.code }) })
    else sendHtml(res, status, renderErrorPage(status, message))
  })
})

server.listen(port, host, () => {
  console.log(`[team-kb] listening http://${host}:${port}`)
  console.log(`[team-kb] data=${dataDir}`)
  console.log(`[team-kb] knowledge=${kbDbPath}`)
  console.log(`[team-kb] team=${teamDbPath}`)
})

async function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`[team-kb] ${signal}，正在关闭`)
  server.close()
  try { await provider.close() } catch {}
  team.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
