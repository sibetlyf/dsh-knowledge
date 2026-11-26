// GitHub/Gitee 仓库知识库同步：把 Markdown/文本文件 upsert 为知识库文档。
// 只处理可读文本文件；不做代码执行，不把 token 写入日志或 API 响应。
import { basename } from 'node:path'

const TEXT_PATH = /\.(?:md|markdown|mdx|txt|text|html|htm|rst|org)$/iu
const MAX_FILES = 80
const MAX_BYTES = 2 * 1024 * 1024

function clean(value, fallback = '') {
  return String(value ?? '').trim() || fallback
}

function headersFor(source) {
  const headers = { accept: 'application/json', 'user-agent': 'dsh-knowledge-sync' }
  if (source.token) {
    headers.authorization = source.provider === 'gitee' ? `token ${source.token}` : `Bearer ${source.token}`
  }
  return headers
}

async function fetchJson(url, source) {
  const target = new URL(url)
  if (source.provider === 'gitee' && source.token) target.searchParams.set('access_token', source.token)
  const response = await fetch(target, { headers: headersFor(source), signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${source.provider} API ${response.status}: ${text.slice(0, 160)}`)
  }
  return await response.json()
}

function apiBase(source) {
  return source.provider === 'gitee' ? 'https://gitee.com/api/v5' : 'https://api.github.com'
}

async function repository(source) {
  return await fetchJson(`${apiBase(source)}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`, source)
}

async function treeFiles(source, ref) {
  const tree = await fetchJson(`${apiBase(source)}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`, source)
  const entries = Array.isArray(tree?.tree) ? tree.tree : []
  const pattern = clean(source.include_pattern)
  return entries
    .filter(entry => entry?.type === 'blob' && typeof entry.path === 'string' && TEXT_PATH.test(entry.path))
    .filter(entry => pattern === '' || entry.path.toLowerCase().includes(pattern.toLowerCase()))
    .slice(0, MAX_FILES)
}

async function fileContent(source, path, ref) {
  const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const contents = await fetchJson(`${apiBase(source)}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, source)
  if (Array.isArray(contents)) throw new Error('路径是目录，不是文件')
  if (typeof contents?.content !== 'string') throw new Error('仓库 API 未返回文件正文')
  const bytes = Buffer.from(contents.content.replaceAll('\n', ''), 'base64')
  if (bytes.length > MAX_BYTES) throw new Error('文件超过 2 MiB，未导入')
  return bytes.toString('utf8')
}

function titleFor(path) {
  const name = basename(path)
  return name.replace(/\.(?:md|markdown|mdx|txt|text|html|htm|rst|org)$/iu, '').replace(/[-_]+/gu, ' ') || path
}

export async function syncRepositorySource({ source, provider, team }) {
  if (source === undefined) throw new Error('数据源不存在')
  if (!['github', 'gitee'].includes(source.provider)) throw new Error('暂不支持这个数据源类型')
  team.updateDataSource(source.id, { status: 'syncing', error: null })
  const result = { provider: source.provider, created: 0, updated: 0, skipped: 0, failed: 0, total: 0, errors: [] }
  try {
    const meta = await repository(source)
    const ref = clean(source.ref, clean(meta?.default_branch, 'main'))
    const files = await treeFiles(source, ref)
    result.total = files.length
    if (files.length === 0) throw new Error('仓库没有匹配的 Markdown/文本文件')
    const group = clean(source.source_group, `数据源/${source.provider}/${source.owner}/${source.repo}`)
    for (const file of files) {
      try {
        const body = await fileContent(source, file.path, ref)
        const title = titleFor(file.path)
        const item = team.getSourceItem(source.id, file.path)
        let entry = item === undefined ? undefined : await provider.get(item.document_id)
        if (entry !== undefined && entry.status === 'active') {
          entry = await provider.update(entry.id, {
            knowledgeBaseId: source.base_id,
            title,
            body,
            group,
            type: 'fact',
            tags: ['数据源', source.provider],
            scope: { kind: 'global' },
            confidence: 0.8,
          }, undefined, entry.version)
          result.updated += 1
        } else {
          entry = await provider.create({
            knowledgeBaseId: source.base_id,
            title,
            body,
            group,
            type: 'fact',
            tags: ['数据源', source.provider],
            scope: { kind: 'global' },
            confidence: 0.8,
          })
          result.created += 1
        }
        team.setSourceItem({ sourceId: source.id, path: file.path, documentId: entry.id, sha256: file.sha })
      } catch (error) {
        result.failed += 1
        result.errors.push(`${file.path}: ${error.message}`)
      }
    }
    team.updateDataSource(source.id, {
      status: result.failed > 0 ? 'partial' : 'synced',
      error: result.errors.length > 0 ? result.errors.slice(0, 3).join('；') : null,
      lastSyncedAt: new Date().toISOString(),
    })
    return result
  } catch (error) {
    team.updateDataSource(source.id, { status: 'error', error: error.message.slice(0, 500) })
    throw error
  }
}
