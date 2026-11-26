// 独立团队知识库服务：只依赖 Node.js 24 + 本仓库的存储层，不需要安装 DSH。
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'
import { renderSharedMarkdown } from '../lib/notes/share-markdown.js'
import { extractText } from './ingest.mjs'
import { chatCompletion, llmConfig } from './llm.mjs'
import { syncRepositorySource } from './sources.mjs'
import { TeamError, TeamStore } from './team-store.mjs'
import { renderAppPage, renderErrorPage, renderInvitePage, renderLoginPage, renderSetupPage, roleLabel } from './views.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const publicDir = join(here, 'public')
const dataDir = resolve(process.env.TEAM_DATA_DIR ?? join(here, '..', 'cloud-data'))
const buildInfo = readBuildInfo()
const startedAt = new Date().toISOString()
const port = integerEnv('TEAM_PORT', 8787, 1, 65535)
const host = process.env.TEAM_HOST?.trim() || '127.0.0.1'
const title = process.env.TEAM_TITLE?.trim() || '团队知识库'
const sessionDays = integerEnv('TEAM_SESSION_DAYS', 7, 1, 30)
const maxBody = integerEnv('TEAM_MAX_BODY_BYTES', 5 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024)
const maxFileBytes = integerEnv('TEAM_MAX_FILE_BYTES', 100 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024)
const filesDir = join(dataDir, 'files')
const trustProxy = process.env.TEAM_TRUST_PROXY === '1'
const publicOrigin = process.env.TEAM_PUBLIC_ORIGIN?.trim()
const kbDbPath = resolve(process.env.TEAM_KB_DB?.trim() || join(dataDir, 'knowledge.sqlite'))
const teamDbPath = resolve(process.env.TEAM_TEAM_DB?.trim() || join(dataDir, 'team.sqlite'))

mkdirSync(dataDir, { recursive: true, mode: 0o700 })
mkdirSync(filesDir, { recursive: true, mode: 0o700 })
const team = new TeamStore(teamDbPath)
const provider = new LocalKnowledgeProvider(kbDbPath)
let closing = false

// DSH 远程客户端使用的 Bearer API；团队网页自身的 Cookie/CSRF API 与它彼此独立。
let remoteKnowledgeHandler
const remoteApiContext = {
  webServer: {
    register(route) {
      if (route.path === '/knowledge-api/v1') remoteKnowledgeHandler = route.handler
      return () => { if (remoteKnowledgeHandler === route.handler) remoteKnowledgeHandler = undefined }
    },
  },
  get() { return undefined },
}
registerKnowledgeApi(remoteApiContext, provider, '/knowledge-api/v1', { authMode: 'bearer' })

function readBuildInfo() {
  const hasher = createHash('sha256')
  for (const file of ['server.mjs', 'team-store.mjs', 'sources.mjs', 'ingest.mjs', 'llm.mjs', 'views.mjs', 'public/app.js', 'public/app.css']) {
    try { hasher.update(readFileSync(join(here, file))) } catch { hasher.update(file) }
  }
  let version = '0.0.0'
  try { version = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? version } catch { /* installed layouts may omit package.json */ }
  const hash = hasher.digest('hex').slice(0, 12)
  return {
    service: 'team-knowledge',
    version,
    buildId: `${version}-${hash}`,
    buildHash: hash,
    commit: process.env.TEAM_BUILD_COMMIT?.trim() || '',
    features: ['files', 'sync-v1', 'search-v1', 'qa-citations-v1', 'wiki-review-v1', 'worklogs-v1', 'automation-v1'],
  }
}

function healthPayload() {
  return { ok: true, ...buildInfo, startedAt, uptimeSeconds: Math.round(process.uptime()) }
}

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

async function readBody(req, limit = maxBody) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, '请求内容过大')
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

function decodeUploadHeader(value) {
  if (typeof value !== 'string') return ''
  try { return decodeURIComponent(value) } catch { return value }
}

function safeFileName(value) {
  const name = basename(String(value ?? '')).replace(/[\u0000-\u001f\u007f/\\]/gu, '_').trim()
  return name.length === 0 ? 'file' : name.slice(0, 200)
}

function mimeFromName(name) {
  const ext = extname(name).toLowerCase()
  return {
    '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.zip': 'application/zip',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.csv': 'text/csv; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  }[ext] ?? 'application/octet-stream'
}

async function storeUploadedFile({ baseId, name, mime, bytes, actorId, sourceKey, userName }) {
  const base = await provider.getKnowledgeBase(baseId)
  if (base === undefined || base.status !== 'active') throw new HttpError(400, '知识库不存在或不可用')
  if (bytes.length > maxFileBytes) throw new HttpError(413, `文件超过 ${Math.round(maxFileBytes / 1024 / 1024)} MiB 上限`)
  const displayName = safeFileName(name)
  const safeMime = String(mime ?? '').trim().slice(0, 200) || mimeFromName(displayName)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const owner = String(userName ?? '').trim().replace(/[\u0000-\u001f\u007f/\\]/gu, '_').slice(0, 100) || '未署名'
  const rawSource = sourceKey === undefined || sourceKey === '' ? null : String(sourceKey).replace(/^\/+/u, '').slice(0, 400)
  const source = rawSource === null ? null : `${owner}/${rawSource}`
  const existing = team.findFileBySource(baseId, source ?? '')
  const id = existing?.id ?? randomUUID()
  const relativePath = join('files', id)
  const absolutePath = join(dataDir, relativePath)
  await writeFile(absolutePath, bytes, { mode: 0o600 })
  if (existing !== undefined) {
    if (existing.storage_path !== relativePath && existsSync(join(dataDir, existing.storage_path))) {
      try { rmSync(join(dataDir, existing.storage_path)) } catch {}
    }
    const updated = team.updateFile(id, { name: displayName, mime: safeMime, size: bytes.length, sha256, storagePath: relativePath })
    await indexFile(updated, bytes)
    return updated
  }
  const created = team.addFile({ id, baseId, name: displayName, mime: safeMime, size: bytes.length, sha256, storagePath: relativePath, sourceKey: source, userName: owner, uploadedBy: actorId })
  await indexFile(created, bytes)
  return created
}

function bearerActor(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw new HttpError(401, 'Bearer token is required')
  const token = header.slice(7).trim()
  const record = provider.authenticate(token)
  if (record === undefined) throw new HttpError(401, 'Token 无效或已撤销')
  return record
}

function sendFile(res, row, inline = false) {
  const absolute = join(dataDir, row.storage_path)
  if (!existsSync(absolute)) throw new HttpError(410, '文件内容已丢失')
  // 不把 HTML/SVG 等主动内容 inline 到同源页面，避免上传文件执行脚本。
  const safeInline = /^(?:image\/(?:png|jpeg|gif|webp)|application\/pdf|audio\/|video\/|text\/(?:plain|markdown|csv)|application\/json)/u.test(row.mime ?? '')
  const disposition = inline && safeInline ? 'inline' : 'attachment'
  res.writeHead(200, {
    'content-type': row.mime || 'application/octet-stream',
    'content-length': String(row.size),
    'content-disposition': `${disposition}; filename="${encodeURIComponent(row.name)}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': inline && safeInline ? 'private, max-age=300' : 'no-store',
  })
  createReadStream(absolute).pipe(res)
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function fileMetadata(row, prefix = '/api/files') {
  const text = team.getFileText(row.id)
  return {
    id: row.id,
    baseId: row.base_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    sourceKey: row.source_key ?? null,
    userName: row.user_name ?? null,
    parseStatus: text?.status ?? 'pending',
    parseError: text?.error ?? null,
    parser: text?.parser ?? null,
    excerpt: text?.content ? text.content.slice(0, 700) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    inlineUrl: `${prefix}/${row.id}?inline=1`,
    previewUrl: `/api/files/${row.id}/preview`,
    downloadUrl: `${prefix}/${row.id}`,
  }
}

async function indexFile(row, bytes) {
  const result = await extractText({ name: row.name, mime: row.mime, bytes })
  team.setFileText({
    fileId: row.id,
    baseId: row.base_id,
    status: result.status,
    content: result.content,
    parser: result.parser,
    error: result.error,
    name: row.name,
  })
  return result
}

async function handleTokenFiles(req, res, url, path, method) {
  const actor = bearerActor(req)
  const record = actor
  const canWrite = Array.isArray(record.permissions) && record.permissions.includes('write')
  if (path === '/knowledge-api/v1/files' && method === 'GET') {
    const baseId = url.searchParams.get('baseId') ?? ''
    if (baseId === '') throw new HttpError(400, 'baseId 不能为空')
    return sendJson(res, 200, { files: team.listFiles(baseId).map(row => fileMetadata(row, '/knowledge-api/v1/files')) })
  }
  if (path === '/knowledge-api/v1/files' && method === 'POST') {
    if (!canWrite) throw new HttpError(403, 'Token 没有 write 权限')
    const baseId = decodeUploadHeader(firstHeader(req.headers['x-file-base-id'])) || url.searchParams.get('baseId') || ''
    const name = decodeUploadHeader(firstHeader(req.headers['x-file-name'])) || 'file'
    const mime = firstHeader(req.headers['x-content-type']) || ''
    const sourceKey = decodeUploadHeader(firstHeader(req.headers['x-file-source-key']))
    const userName = decodeUploadHeader(firstHeader(req.headers['x-file-user-name'])) || '未署名'
    const bytes = await readBody(req, maxFileBytes)
    const row = await storeUploadedFile({ baseId, name, mime, bytes, actorId: null, sourceKey, userName })
    return sendJson(res, 201, { file: fileMetadata(row, '/knowledge-api/v1/files') })
  }
  const tokenMatch = /^\/knowledge-api\/v1\/files\/([a-f0-9-]{36})$/u.exec(path)
  if (tokenMatch !== null && method === 'GET') {
    const row = team.getFile(tokenMatch[1])
    if (row === undefined) throw new HttpError(404, '文件不存在')
    return sendFile(res, row, url.searchParams.get('inline') === '1')
  }
  if (tokenMatch !== null && method === 'DELETE') {
    if (!canWrite) throw new HttpError(403, 'Token 没有 write 权限')
    const row = team.getFile(tokenMatch[1])
    if (row === undefined) throw new HttpError(404, '文件不存在')
    team.deleteFile(row.id)
    if (existsSync(join(dataDir, row.storage_path))) {
      try { rmSync(join(dataDir, row.storage_path)) } catch {}
    }
    return sendJson(res, 200, { ok: true })
  }
  throw new HttpError(404, '文件接口不存在')
}

async function handleTeamFiles(req, res, url, path, method, session) {
  if (path === '/api/files' && method === 'GET') {
    const baseId = url.searchParams.get('baseId') ?? ''
    if (baseId === '') throw new HttpError(400, 'baseId 不能为空')
    return sendJson(res, 200, { files: team.listFiles(baseId).map(row => fileMetadata(row)) })
  }
  if (path === '/api/files' && method === 'POST') {
    requireRole(session, ['admin', 'editor'])
    const baseId = decodeUploadHeader(firstHeader(req.headers['x-file-base-id'])) || ''
    const name = decodeUploadHeader(firstHeader(req.headers['x-file-name'])) || 'file'
    const mime = firstHeader(req.headers['x-content-type']) || ''
    const sourceKey = decodeUploadHeader(firstHeader(req.headers['x-file-source-key']))
    const userName = decodeUploadHeader(firstHeader(req.headers['x-file-user-name'])) || session.user.name
    const bytes = await readBody(req, maxFileBytes)
    const row = await storeUploadedFile({ baseId, name, mime, bytes, actorId: session.user.id, sourceKey, userName })
    team.audit(session.user.id, 'file.upload', row.id, `${name} ${bytes.length}`)
    return sendJson(res, 201, { file: fileMetadata(row) })
  }
  const previewMatch = /^\/api\/files\/([a-f0-9-]{36})\/preview$/u.exec(path)
  if (previewMatch !== null && method === 'GET') {
    const row = team.getFile(previewMatch[1])
    if (row === undefined) throw new HttpError(404, '文件不存在')
    const parsed = team.getFileText(row.id)
    if (parsed === undefined || parsed.status !== 'parsed') {
      return send(res, 200, '<!doctype html><html><body style="font-family:system-ui;padding:24px;color:#666">该文件尚未建立文本预览。请先解析索引，或下载原文件。</body></html>', { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" })
    }
    let html
    if (row.mime === 'text/markdown' || row.mime === 'text/plain') {
      html = `<article style="max-width:760px;margin:32px auto;line-height:1.75;font-family:system-ui">${renderSharedMarkdown(parsed.content).html}</article>`
    } else if (row.mime === 'text/csv') {
      const rows = parsed.content.split(/\r?\n/u).slice(0, 100).map(line => line.split(',').slice(0, 20))
      const cells = rows.map((line, index) => `<tr>${line.map(cell => index === 0 ? `<th>${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
      html = `<div style="padding:20px;overflow:auto"><table style="border-collapse:collapse;font:12px/1.5 system-ui">${cells}</table></div>`
    } else {
      html = `<pre style="white-space:pre-wrap;word-break:break-word;padding:24px;font:12px/1.65 monospace">${escapeHtml(parsed.content)}</pre>`
    }
    return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fffefb;color:#24221e}article,pre,table{border:0}th,td{border:1px solid #e5e1d9;padding:5px 8px;text-align:left}</style></head><body>${html}</body></html>`, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
  }
  const reparseMatch = /^\/api\/files\/([a-f0-9-]{36})\/reparse$/u.exec(path)
  if (reparseMatch !== null && method === 'POST') {
    requireRole(session, ['admin', 'editor'])
    const row = team.getFile(reparseMatch[1])
    if (row === undefined) throw new HttpError(404, '文件不存在')
    const absolute = join(dataDir, row.storage_path)
    if (!existsSync(absolute)) throw new HttpError(410, '文件内容已丢失')
    const bytes = await readFile(absolute)
    await indexFile(row, bytes)
    team.audit(session.user.id, 'file.reparse', row.id, row.name)
    return sendJson(res, 200, { file: fileMetadata(row) })
  }
  const fileMatch = /^\/api\/files\/([a-f0-9-]{36})$/u.exec(path)
  if (fileMatch !== null && method === 'GET') {
    const row = team.getFile(fileMatch[1])
    if (row === undefined) throw new HttpError(404, '文件不存在')
    return sendFile(res, row, url.searchParams.get('inline') === '1')
  }
  if (fileMatch !== null && method === 'DELETE') {
    requireRole(session, ['admin', 'editor'])
    const row = team.getFile(fileMatch[1])
    if (row === undefined) throw new HttpError(404, '文件不存在')
    team.deleteFile(row.id)
    if (existsSync(join(dataDir, row.storage_path))) {
      try { rmSync(join(dataDir, row.storage_path)) } catch {}
    }
    team.audit(session.user.id, 'file.delete', row.id, row.name)
    return sendJson(res, 200, { ok: true })
  }
  throw new HttpError(404, '文件接口不存在')
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

async function listAllDocuments(baseId, query) {  const documents = []
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

function citationFromDocument(hit, index, baseId) {
  return {
    index,
    kind: 'document',
    id: hit.entry.id,
    baseId: hit.entry.knowledgeBaseId ?? baseId,
    title: hit.entry.title,
    locator: hit.passage ? `第 ${hit.passage.startLine}-${hit.passage.endLine} 行` : `v${hit.entry.version}`,
    excerpt: hit.passage?.text ?? '',
    url: `/api/document/${hit.entry.id}`,
  }
}

function citationFromFile(file, index) {
  const text = team.getFileText(file.fileId)
  return {
    index,
    kind: 'file',
    id: file.fileId,
    baseId: file.baseId,
    title: file.name,
    locator: text?.parser ? `全文索引 · ${text.parser}` : '文件',
    excerpt: file.snippet ?? (text?.content?.slice(0, 260) ?? ''),
    url: `/api/files/${file.fileId}`,
  }
}

async function retrieveEvidence(question, baseId) {
  const bases = baseId === '' ? (await provider.listKnowledgeBases()).filter(base => base.status === 'active').map(base => base.id) : [baseId]
  const query = question.replace(/[?？!！。]/gu, ' ').replace(/(是什么|有哪些|如何|怎么|为什么|请问|一下|吗)/gu, ' ').replace(/\s+/gu, ' ').trim() || question
  const documents = await provider.search({
    text: query,
    includePassage: true,
    limit: 8,
    ...(baseId === '' ? {} : { knowledgeBaseIds: [baseId] }),
  })
  const files = bases.flatMap(id => team.searchFileText(id, query, 6)).slice(0, 8)
  const citations = [
    ...documents.map((hit, index) => citationFromDocument(hit, index + 1, baseId)),
    ...files.map((file, index) => citationFromFile(file, documents.length + index + 1)),
  ]
  return { citations }
}

function evidencePrompt(question, citations) {
  const evidence = citations.map(citation => `[${citation.index}] ${citation.title}（${citation.locator}）\n${citation.excerpt}`).join('\n\n')
  return [
    { role: 'system', content: '你是企业知识库问答助手。只使用给定证据回答；证据不足时明确说证据不足；每个事实句末尾用 [编号] 标注来源。不要编造链接或文件名。' },
    { role: 'user', content: `问题：${question}\n\n证据：\n${evidence}` },
  ]
}

async function answerQuestion(question, baseId) {
  const { citations } = await retrieveEvidence(question, baseId)
  if (citations.length === 0) return { answer: '未在当前知识库中找到可引用的证据。', citations: [], engine: 'none' }
  const modelAnswer = await chatCompletion(evidencePrompt(question, citations), { maxTokens: 1400 }).catch(() => undefined)
  if (modelAnswer !== undefined) return { answer: modelAnswer, citations, engine: 'model' }
  return {
    answer: `当前未配置生成模型，先返回与问题最相关的证据片段：\n\n${citations.map(citation => `- [${citation.index}] ${citation.title}：${citation.excerpt.slice(0, 320)}`).join('\n')}`,
    citations,
    engine: 'extractive',
  }
}

function wikiSlug(title) {
  return String(title).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'wiki'
}

async function generateWikiPage({ baseId, topic, title, actor }) {
  const question = topic || title
  const { citations } = await retrieveEvidence(question, baseId)
  const viewevidence = citations.map(citation => `### ${citation.title}\n\n${citation.excerpt.slice(0, 600)}\n\n来源：[${citation.index}] ${citation.url}`).join('\n\n')
  const fallback = `# ${title}\n\n> 自动生成草稿，待团队审核。生成时间：${new Date().toLocaleString('zh-CN')}\n\n## 主题摘要\n\n${topic ? `围绕「${topic}」整理当前可检索资料。` : '根据当前知识库最近内容整理。'}\n\n## 证据摘录\n\n${viewevidence || '当前没有可引用的已索引资料。'}\n\n## 待补充\n\n- 请审核事实、补充结论并确认引用。`
  const generated = await chatCompletion([
    { role: 'system', content: '你是企业 Wiki 编辑。只根据给定证据写 Markdown 草稿，结构包含概述、要点、待确认事项、来源列表；每个结论附 [编号] 引用，不得编造。' },
    { role: 'user', content: `主题：${question}\n\n${viewevidence}` },
  ], { maxTokens: 1800 }).catch(() => undefined)
  const content = generated ?? fallback
  const safeTitle = String(title || topic || '未命名 Wiki').trim().slice(0, 240)
  let slug = wikiSlug(safeTitle)
  if (team.findWikiPage(baseId, slug) !== undefined) slug = `${slug}-${Date.now().toString(36)}`
  const sources = citations.map(citation => ({ kind: citation.kind, sourceId: citation.id, title: citation.title, excerpt: citation.excerpt.slice(0, 500), lineStart: null, lineEnd: null }))
  const page = team.createWikiPage({ baseId, slug, title: safeTitle, content, createdBy: actor, sources })
  return { page, engine: generated === undefined ? 'extractive' : 'model', citations }
}

async function syncFeed(baseId, since = '') {
  if (baseId === '') throw new HttpError(400, 'baseId 不能为空')
  const base = await provider.getKnowledgeBase(baseId)
  if (base === undefined || base.status !== 'active') throw new HttpError(404, '知识库不存在')
  const now = new Date().toISOString()
  const documents = await listAllDocuments(baseId, '')
  const documentChanges = documents.documents
    .filter(item => item.updatedAt !== undefined && String(item.updatedAt) > since)
    .map(item => ({
      entityKind: 'document',
      entityId: item.id,
      baseId,
      operation: 'upsert',
      version: item.version,
      occurredAt: item.updatedAt,
      payload: { title: item.title, group: item.group ?? '', updatedAt: item.updatedAt },
    }))
  const fileChanges = team.listChanges(baseId, since, 1000)
  return {
    baseId,
    since,
    nextCursor: now,
    changes: [...documentChanges, ...fileChanges].sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt))),
    hasMore: fileChanges.length >= 1000,
  }
}

function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : ''
}

function dayOffset(date, offset) {
  const copy = new Date(`${date}T00:00:00Z`)
  copy.setUTCDate(copy.getUTCDate() + offset)
  return copy.toISOString().slice(0, 10)
}

function worklogEvidence(rows) {
  return rows.map(row => `## ${row.day} · ${row.user_name}\n\n${String(row.markdown ?? '').slice(0, 6_000)}`).join('\n\n')
}

async function summarizeTeamWorklogs({ baseId, fromDay, toDay, actor, force = false }) {
  const base = await provider.getKnowledgeBase(baseId)
  if (base === undefined || base.status !== 'active') throw new HttpError(404, '知识库不存在')
  const from = validDay(fromDay) || toDay || new Date().toISOString().slice(0, 10)
  const to = validDay(toDay) || from
  const logs = team.listWorklogs(baseId, from, to)
  if (logs.length === 0) throw new HttpError(404, `没有 ${from} 至 ${to} 的团队日报`)
  const evidence = worklogEvidence(logs)
  const fallback = `# 团队工作日报总结 · ${from} 至 ${to}\n\n> 自动汇总草稿，请人工审核。\n\n## 已汇总成员\n\n${[...new Set(logs.map(row => row.user_name))].map(name => `- ${name}`).join('\n')}\n\n## 日报摘录\n\n${logs.map(row => `### ${row.day} · ${row.user_name}\n\n${String(row.markdown ?? '').slice(0, 1_200)}`).join('\n\n')}`
  const generated = await chatCompletion([
    { role: 'system', content: '你是企业团队日报编辑。只根据给定成员日报总结团队进展、阻塞和下一步；按成员和日期保留可核验事实，不编造，不忽略未完成事项。输出 Markdown，结论后附 [成员/日期]。' },
    { role: 'user', content: `日期范围：${from} 至 ${to}\n\n团队日报：\n${evidence}` },
  ], { maxTokens: 1800 }).catch(() => undefined)
  const summary = team.findWorklogSummary(baseId, from, to) === undefined
    ? team.createWorklogSummary({
      baseId,
      fromDay: from,
      toDay: to,
      markdown: generated ?? fallback,
      engine: generated === undefined ? 'extractive' : 'model',
    })
    : team.updateWorklogSummary(team.findWorklogSummary(baseId, from, to).id, { markdown: generated ?? fallback, status: 'draft' })
  team.audit(actor ?? null, 'worklog.summarize', summary.id, `${from}..${to} ${logs.length} 天`)
  return { summary, members: [...new Set(logs.map(row => row.user_name))], days: logs.length, citations: logs.map(row => `${row.user_name}/${row.day}`) }
}

async function upsertAutoWiki(baseId) {
  const docs = await provider.listDocuments(baseId)
  if (docs.length === 0) return undefined
  const latest = docs.reduce((max, doc) => String(doc.updatedAt ?? '') > max ? String(doc.updatedAt ?? '') : max, '')
  const key = `auto-wiki:${baseId}`
  if (latest === '' || latest <= (team.getAutomationState(key) ?? '')) return undefined
  const { citations } = await retrieveEvidence('团队知识概览', baseId)
  const evidence = citations.map(citation => `### ${citation.title}\n\n${citation.excerpt.slice(0, 600)}\n\n来源：[${citation.index}] ${citation.url}`).join('\n\n')
  const generated = await chatCompletion([
    { role: 'system', content: '你是企业知识库 Wiki 编辑。只根据证据整理团队知识概览：主题、关键结论、待确认事项和来源。输出 Markdown，结论附 [编号]，不得编造。' },
    { role: 'user', content: `请生成团队知识概览：\n\n${evidence}` },
  ], { maxTokens: 1800 }).catch(() => undefined)
  const content = generated ?? `# 自动 Wiki · 团队知识概览\n\n> 自动生成草稿，待团队审核。\n\n## 证据摘要\n\n${evidence || '当前没有可引用资料。'}`
  const title = '自动 Wiki · 团队知识概览'
  const slug = 'auto-team-wiki'
  const sources = citations.map(citation => ({ kind: citation.kind, sourceId: citation.id, title: citation.title, excerpt: citation.excerpt.slice(0, 500), lineStart: null, lineEnd: null }))
  const existing = team.findWikiPage(baseId, slug)
  const page = existing === undefined || existing.status === 'published'
    ? team.createWikiPage({ baseId, slug: existing === undefined ? slug : `${slug}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`, title: existing === undefined ? title : `${title}（更新 ${new Date().toISOString().slice(0, 10)}）`, content, createdBy: null, status: 'draft', sources })
    : team.updateWikiPage(existing.id, { title, content, status: 'draft', sources })
  team.setAutomationState(key, latest)
  return page
}

async function runAutomation({ force = false } = {}) {
  const result = { wiki: [], worklog: [], skipped: 0 }
  const bases = (await provider.listKnowledgeBases()).filter(base => base.status === 'active')
  for (const base of bases) {
    try {
      const page = await upsertAutoWiki(base.id)
      if (page !== undefined) result.wiki.push({ baseId: base.id, pageId: page.id })
      else result.skipped += 1
    } catch (error) {
      result.wiki.push({ baseId: base.id, error: error.message })
    }
  }
  const today = new Date().toISOString().slice(0, 10)
  const autoHour = Math.max(0, Math.min(23, Number(process.env.TEAM_WORKLOG_SUMMARY_HOUR ?? 19)))
  if (force || new Date().getHours() >= autoHour) {
    const stateKey = `worklog-summary:${today}`
    if (force || team.getAutomationState(stateKey) === undefined) {
      let generated = false
      for (const base of bases) {
        const logs = team.listWorklogs(base.id, today, today)
        if (logs.length === 0) continue
        try {
          const summary = await summarizeTeamWorklogs({ baseId: base.id, fromDay: today, toDay: today, actor: null, force })
          result.worklog.push({ baseId: base.id, summaryId: summary.summary.id })
          generated = true
        } catch (error) {
          result.worklog.push({ baseId: base.id, error: error.message })
        }
      }
      if (generated) team.setAutomationState(stateKey, new Date().toISOString())
    }
  }
  return result
}

function automationStatus() {
  return {
    autoWiki: process.env.TEAM_AUTO_WIKI !== '0',
    autoWorklog: process.env.TEAM_AUTO_WORKLOG !== '0',
    summaryHour: Number(process.env.TEAM_WORKLOG_SUMMARY_HOUR ?? 19),
    intervalMinutes: Math.max(1, Number(process.env.TEAM_AUTO_INTERVAL_MINUTES ?? 30)),
    lastWiki: team.getAutomationState('auto-wiki:default') ?? null,
    lastWorklog: team.getAutomationState(`worklog-summary:${new Date().toISOString().slice(0, 10)}`) ?? null,
  }
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', requestOrigin(req))
  const method = req.method ?? 'GET'
  const path = url.pathname

  if (path === '/api/health' || path === '/health') return sendJson(res, 200, healthPayload())

  if (path === '/knowledge-api/v1' || path.startsWith('/knowledge-api/v1/')) {
    if (path === '/knowledge-api/v1/health') return sendJson(res, 200, { ...healthPayload(), schemaVersion: 15 })
    if (path === '/knowledge-api/v1/sync/changes' && method === 'GET') {
      bearerActor(req)
      return sendJson(res, 200, await syncFeed(url.searchParams.get('baseId') ?? '', url.searchParams.get('since') ?? ''))
    }
    if (path === '/knowledge-api/v1/worklogs' && (method === 'POST' || method === 'GET')) {
      const actor = bearerActor(req)
      const canWrite = Array.isArray(actor.permissions) && actor.permissions.includes('write')
      if (method === 'GET') {
        const baseId = url.searchParams.get('baseId') ?? 'default'
        return sendJson(res, 200, { logs: team.listWorklogs(baseId, url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '') })
      }
      if (!canWrite) throw new HttpError(403, 'Token 没有 write 权限')
      const body = await readJson(req)
      const baseId = String(body.baseId ?? 'default')
      const day = validDay(body.day)
      if (day === '') throw new HttpError(400, 'day 必须是 YYYY-MM-DD')
      const markdown = String(body.markdown ?? '').trim()
      if (markdown === '') throw new HttpError(400, '日报内容不能为空')
      const row = team.upsertWorklog({
        baseId, userName: String(body.userName ?? '未署名').trim().slice(0, 100), day,
        revision: Number(body.revision ?? 0) || 0, markdown, source: String(body.source ?? 'worklog').slice(0, 80),
      })
      team.audit(null, 'worklog.sync', `${baseId}/${row.user_name}/${day}`, `${markdown.length} chars`)
      return sendJson(res, 201, { ok: true, day, userName: row.user_name })
    }
    if (path === '/knowledge-api/v1/files' || path.startsWith('/knowledge-api/v1/files/')) {
      await handleTokenFiles(req, res, url, path, method)
      return
    }
    if (remoteKnowledgeHandler === undefined) throw new HttpError(503, 'DSH 远程 API 尚未就绪')
    await remoteKnowledgeHandler(req, res)
    return
  }

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

  if (path === '/api/meta' && method === 'GET') return sendJson(res, 200, { ...healthPayload(), schemaVersion: 15 })

  if (path === '/api/sync/changes' && method === 'GET') {
    return sendJson(res, 200, await syncFeed(url.searchParams.get('baseId') ?? '', url.searchParams.get('since') ?? ''))
  }

  if (method !== 'GET' && method !== 'HEAD') requireCsrf(req, session)

  if (path === '/api/worklogs' && method === 'GET') {
    const baseId = url.searchParams.get('baseId') ?? 'default'
    return sendJson(res, 200, {
      logs: team.listWorklogs(baseId, url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? ''),
      summaries: team.listWorklogSummaries(baseId),
    })
  }

  if (path === '/api/worklogs/summaries' && method === 'GET') {
    const baseId = url.searchParams.get('baseId') ?? 'default'
    return sendJson(res, 200, { summaries: team.listWorklogSummaries(baseId, Number(url.searchParams.get('limit') ?? 20)) })
  }

  if (path === '/api/worklogs/summarize' && method === 'POST') {
    requireRole(session, ['admin', 'editor'])
    const body = await readJson(req)
    return sendJson(res, 201, await summarizeTeamWorklogs({
      baseId: String(body.baseId ?? 'default'),
      fromDay: validDay(body.from) || undefined,
      toDay: validDay(body.to) || undefined,
      actor: session.user.id,
      force: true,
    }))
  }

  const summaryMatch = /^\/api\/worklogs\/summaries\/([a-f0-9-]{36})$/u.exec(path)
  if (summaryMatch !== null && method === 'PATCH') {
    requireRole(session, ['admin', 'editor'])
    const body = await readJson(req)
    const status = String(body.status ?? '')
    if (!['draft', 'published'].includes(status)) throw new HttpError(400, '无效的汇总状态')
    const summary = team.updateWorklogSummary(summaryMatch[1], { status })
    if (summary === undefined) throw new HttpError(404, '汇总不存在')
    team.audit(session.user.id, 'worklog.summary.status', summary.id, status)
    return sendJson(res, 200, { summary })
  }

  if (path === '/api/automation/status' && method === 'GET') {
    return sendJson(res, 200, automationStatus())
  }

  if (path === '/api/automation/run' && method === 'POST') {
    requireRole(session, ['admin'])
    return sendJson(res, 200, await runAutomation({ force: true }))
  }

  if (path === '/api/files' || path.startsWith('/api/files/')) {
    await handleTeamFiles(req, res, url, path, method, session)
    return
  }

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
    const fileBases = baseId === undefined
      ? (await provider.listKnowledgeBases()).filter(base => base.status === 'active').map(base => base.id)
      : [baseId]
    const fileHits = fileBases.flatMap(id => team.searchFileText(id, query, 10)).slice(0, 20)
    return sendJson(res, 200, {
      hits: hits.map(hit => ({
        ...summarizeEntry(hit.entry),
        score: hit.score,
        passage: hit.passage === undefined ? undefined : { text: hit.passage.text, startLine: hit.passage.startLine, endLine: hit.passage.endLine },
      })),
      fileHits: fileHits.map(file => ({
        id: file.fileId, baseId: file.baseId, name: file.name, score: file.score, snippet: file.snippet,
        downloadUrl: `/api/files/${file.fileId}`,
      })),
    })
  }

  if (path === '/api/ask' && method === 'POST') {
    const body = await readJson(req)
    const question = String(body.q ?? '').trim()
    if (question === '') throw new HttpError(400, '问题不能为空')
    const baseId = String(body.baseId ?? '')
    return sendJson(res, 200, await answerQuestion(question, baseId))
  }

  if (path === '/api/wiki' && method === 'GET') {
    const baseId = url.searchParams.get('baseId') ?? ''
    if (baseId === '') throw new HttpError(400, 'baseId 不能为空')
    return sendJson(res, 200, { pages: team.listWikiPages(baseId), engine: llmConfig().enabled ? 'model' : 'extractive' })
  }

  if (path === '/api/wiki/generate' && method === 'POST') {
    requireRole(session, ['admin', 'editor'])
    const body = await readJson(req)
    const baseId = String(body.baseId ?? '')
    const title = String(body.title ?? '').trim().slice(0, 240)
    const topic = String(body.topic ?? title).trim().slice(0, 1000)
    const base = await provider.getKnowledgeBase(baseId)
    if (base === undefined || base.status !== 'active') throw new HttpError(404, '知识库不存在')
    if (title === '') throw new HttpError(400, 'Wiki 标题不能为空')
    const result = await generateWikiPage({ baseId, topic, title, actor: session.user.id })
    team.audit(session.user.id, 'wiki.generate', result.page.id, title)
    return sendJson(res, 201, result)
  }

  if (path === '/api/wiki' && method === 'POST') {
    requireRole(session, ['admin', 'editor'])
    const body = await readJson(req)
    const baseId = String(body.baseId ?? '')
    const title = String(body.title ?? '').trim().slice(0, 240)
    const content = String(body.content ?? '')
    if (title === '' || content === '') throw new HttpError(400, '标题和正文不能为空')
    const base = await provider.getKnowledgeBase(baseId)
    if (base === undefined || base.status !== 'active') throw new HttpError(404, '知识库不存在')
    let slug = wikiSlug(title)
    if (team.findWikiPage(baseId, slug) !== undefined) slug = `${slug}-${Date.now().toString(36)}`
    const page = team.createWikiPage({ baseId, slug, title, content, createdBy: session.user.id })
    team.audit(session.user.id, 'wiki.create', page.id, title)
    return sendJson(res, 201, { page })
  }

  const wikiMatch = /^\/api\/wiki\/([a-f0-9-]{36})(?:\/(publish|restore|versions)\/?)?$/u.exec(path)
  if (wikiMatch !== null) {
    const id = wikiMatch[1]
    const action = wikiMatch[2] ?? ''
    const page = team.getWikiPage(id)
    if (page === undefined) throw new HttpError(404, 'Wiki 页面不存在')
    if (method === 'GET' && action === '') return sendJson(res, 200, { page, versions: team.listWikiVersions(id) })
    if (method === 'GET' && action === 'versions') return sendJson(res, 200, { versions: team.listWikiVersions(id) })
    if (method === 'PUT' && action === '') {
      requireRole(session, ['admin', 'editor'])
      const body = await readJson(req)
      const title = String(body.title ?? page.title).trim().slice(0, 240)
      const content = String(body.content ?? page.content)
      const status = body.status === 'published' ? 'published' : 'draft'
      if (title === '' || content === '') throw new HttpError(400, '标题和正文不能为空')
      const updated = team.updateWikiPage(id, { title, content, status, updatedBy: session.user.id })
      team.audit(session.user.id, 'wiki.update', id, title)
      return sendJson(res, 200, { page: updated })
    }
    if (method === 'POST' && action === 'publish') {
      requireRole(session, ['admin', 'editor'])
      const published = team.publishWikiPage(id, session.user.id)
      team.audit(session.user.id, 'wiki.publish', id, published.title)
      return sendJson(res, 200, { page: published })
    }
    if (method === 'POST' && action === 'restore') {
      requireRole(session, ['admin', 'editor'])
      const body = await readJson(req)
      const version = Number(body.version)
      if (!Number.isSafeInteger(version)) throw new HttpError(400, 'version 必须是整数')
      const restored = team.restoreWikiVersion(id, version, session.user.id)
      team.audit(session.user.id, 'wiki.restore', id, `v${version}`)
      return sendJson(res, 200, { page: restored })
    }
    if (method === 'DELETE') {
      requireRole(session, ['admin', 'editor'])
      team.deleteWikiPage(id)
      return sendJson(res, 200, { ok: true })
    }
  }

  if (path === '/api/sources' && method === 'GET') {
    const baseId = url.searchParams.get('baseId') ?? ''
    if (baseId === '') throw new HttpError(400, 'baseId 不能为空')
    return sendJson(res, 200, { sources: team.listDataSources(baseId) })
  }

  if (path === '/api/sources' && method === 'POST') {
    requireRole(session, ['admin', 'editor'])
    const body = await readJson(req)
    const baseId = String(body.baseId ?? '')
    const base = await provider.getKnowledgeBase(baseId)
    if (base === undefined || base.status !== 'active') throw new HttpError(404, '知识库不存在')
    const providerName = String(body.provider ?? '').toLowerCase()
    if (!['github', 'gitee'].includes(providerName)) throw new HttpError(400, '目前支持 github、gitee')
    const owner = String(body.owner ?? '').trim()
    const repo = String(body.repo ?? '').trim()
    if (owner === '' || repo === '') throw new HttpError(400, '仓库 owner 和 repo 不能为空')
    const source = team.createDataSource({
      baseId, provider: providerName, name: String(body.name ?? `${owner}/${repo}`).trim().slice(0, 120),
      owner: owner.slice(0, 120), repo: repo.slice(0, 120), ref: String(body.ref ?? '').trim().slice(0, 120),
      token: body.token === undefined || String(body.token).trim() === '' ? null : String(body.token).trim(),
      includePattern: String(body.includePattern ?? '').trim().slice(0, 200),
      sourceGroup: String(body.group ?? '').trim().slice(0, 160),
      createdBy: session.user.id,
    })
    team.audit(session.user.id, 'source.create', source.id, `${providerName} ${owner}/${repo}`)
    return sendJson(res, 201, { source: team.listDataSources(baseId).find(item => item.id === source.id) })
  }

  const sourceMatch = /^\/api\/sources\/([a-f0-9-]{36})(?:\/sync)?$/u.exec(path)
  if (sourceMatch !== null) {
    const id = sourceMatch[1]
    const source = team.getDataSource(id)
    if (source === undefined) throw new HttpError(404, '数据源不存在')
    if (method === 'PUT' && !path.endsWith('/sync')) {
      requireRole(session, ['admin', 'editor'])
      const body = await readJson(req)
      const updated = team.updateDataSource(id, {
        name: String(body.name ?? source.name).trim().slice(0, 120),
        ref: body.ref === undefined ? source.ref : String(body.ref).trim().slice(0, 120),
        token: body.token === undefined || String(body.token).trim() === '' ? source.token : String(body.token).trim(),
        includePattern: body.includePattern === undefined ? source.include_pattern : String(body.includePattern).trim().slice(0, 200),
        sourceGroup: body.group === undefined ? source.source_group : String(body.group).trim().slice(0, 160),
      })
      return sendJson(res, 200, { source: team.listDataSources(source.base_id).find(item => item.id === id) ?? updated })
    }
    if (method === 'DELETE' && !path.endsWith('/sync')) {
      requireRole(session, ['admin', 'editor'])
      team.deleteDataSource(id)
      team.audit(session.user.id, 'source.delete', id, `${source.owner}/${source.repo}`)
      return sendJson(res, 200, { ok: true })
    }
    if (method === 'POST' && path.endsWith('/sync')) {
      requireRole(session, ['admin', 'editor'])
      try {
        const result = await syncRepositorySource({ source, provider, team })
        team.audit(session.user.id, 'source.sync', id, JSON.stringify({ created: result.created, updated: result.updated, failed: result.failed }))
        return sendJson(res, 200, { ...result, source: team.listDataSources(source.base_id).find(item => item.id === id) })
      } catch (error) {
        throw new HttpError(502, error instanceof Error ? error.message : String(error))
      }
    }
  }

  if (path === '/api/groups' && method === 'GET') {    const baseId = url.searchParams.get('baseId') ?? ''
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
  if (path === '/api/admin/tokens' && method === 'GET') {
    requireRole(session, ['admin'])
    return sendJson(res, 200, { tokens: provider.listApiTokens(), path: '/knowledge-api/v1' })
  }

  if (path === '/api/admin/tokens' && method === 'POST') {
    requireRole(session, ['admin'])
    const body = await readJson(req)
    const name = String(body.name ?? '').trim() || 'DSH 本地客户端'
    if (name.length > 100) throw new HttpError(400, 'Token 名称过长')
    const created = provider.createApiToken(name, ['read', 'propose', 'write'])
    team.audit(session.user.id, 'token.create', created.record.id, name)
    return sendJson(res, 201, { token: created.token, record: created.record })
  }

  const tokenMatch = /^\/api\/admin\/tokens\/([a-f0-9-]{36})$/u.exec(path)
  if (tokenMatch !== null && method === 'DELETE') {
    requireRole(session, ['admin'])
    provider.revokeApiToken(tokenMatch[1])
    team.audit(session.user.id, 'token.revoke', tokenMatch[1])
    return sendJson(res, 200, { ok: true })
  }

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
  const intervalMinutes = Math.max(1, Number(process.env.TEAM_AUTO_INTERVAL_MINUTES ?? 30))
  const run = () => {
    if (closing) return
    void runAutomation().catch(error => console.error('[team-kb] automation failed:', error))
  }
  setTimeout(run, 15_000).unref()
  setInterval(run, intervalMinutes * 60_000).unref()
  console.log(`[team-kb] automation interval=${intervalMinutes}m wiki=${process.env.TEAM_AUTO_WIKI !== '0' ? 'on' : 'off'} worklog=${process.env.TEAM_AUTO_WORKLOG !== '0' ? 'on' : 'off'}`)
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
