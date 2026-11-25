import { DEFAULT_KNOWLEDGE_BASE_ID } from './domain.js'
import type { KnowledgeProvider } from './provider.js'
import type { RuntimeContextLike } from './runtime.js'
import {
  clearTencentDocsToken,
  readTencentDocsToken,
  saveTencentDocsToken,
  type TencentDocsTokenStatus,
} from './tencent-docs-token.js'

interface ToolSchemaLike {
  name: string
  parameters?: { properties?: Record<string, unknown>; required?: string[] }
}

interface ToolResultLike {
  isError?: boolean
  value?: unknown
  content?: unknown
}

interface ToolServiceLike {
  schemas?(scope?: unknown): ToolSchemaLike[]
  execute?(input: {
    name: string
    arguments: unknown
    signal: AbortSignal
    callId: never
  }): Promise<ToolResultLike>
}

export interface TencentDocsStatus {
  connected: boolean
  tools: string[]
  endpoint: string
  token: TencentDocsTokenStatus
}

export interface TencentDocsImportInput {
  url: string
  knowledgeBaseId?: string
  title?: string
  group?: string
}

export interface TencentDocsImportResult {
  documentId: string
  title: string
  knowledgeBaseId: string
  group: string
  relPath?: string
  sourceUrl: string
}

export interface TencentDocsPublishResult {
  documentId: string
  title: string
  url?: string
}

const PREFIX = 'mcp__tencent-docs__'
const ENDPOINT = 'https://docs.qq.com/openapi/mcp'

/** Local knowledge <-> Tencent Docs bridge. Uses the already-mounted official MCP tools. */
export function createTencentDocsBridge(ctx: RuntimeContextLike, provider: KnowledgeProvider) {
  const toolService = (): ToolServiceLike | undefined => {
    const value = ctx.get('tools') ?? (ctx.tools as unknown as ToolServiceLike)
    return value !== null && typeof value === 'object' && typeof (value as ToolServiceLike).execute === 'function'
      ? value as ToolServiceLike
      : undefined
  }
  const schemas = (): ToolSchemaLike[] => {
    try { return toolService()?.schemas?.() ?? [] } catch { return [] }
  }
  const tools = (): ToolSchemaLike[] => schemas().filter(tool => tool.name.startsWith(PREFIX))

  const status = async (): Promise<TencentDocsStatus> => {
    const token = await readTencentDocsToken()
    const available = tools()
    return {
      connected: available.length > 0,
      tools: available.map(tool => tool.name.slice(PREFIX.length)),
      endpoint: ENDPOINT,
      token: {
        configured: token.configured,
        source: token.source,
        fingerprint: token.fingerprint,
        overriddenByEnv: token.overriddenByEnv,
      },
    }
  }

  const find = (suffix: string): ToolSchemaLike | undefined =>
    tools().find(tool => tool.name.slice(PREFIX.length) === suffix || tool.name.slice(PREFIX.length).endsWith(`_${suffix}`))

  const call = async (suffix: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    const tool = find(suffix)
    const service = toolService()
    if (tool === undefined || service?.execute === undefined) {
      throw Object.assign(new Error('腾讯文档尚未连接。请先运行 tdoc-auth login，等桥插件挂载 mcp__tencent-docs__* 工具。'), { status: 409 })
    }
    const result = await service.execute({
      name: tool.name,
      arguments: args,
      signal,
      callId: `tencent-docs:${Date.now()}:${Math.random().toString(36).slice(2)}` as never,
    })
    if (result.isError) throw Object.assign(new Error(textOf(result)), { status: 502 })
    return result.value ?? result.content
  }

  return {
    status,
    async saveToken(token: string): Promise<TencentDocsStatus> {
      await saveTencentDocsToken(token)
      return status()
    },
    async clearToken(): Promise<TencentDocsStatus> {
      await clearTencentDocsToken()
      return status()
    },
    async importDocument(input: TencentDocsImportInput, signal = new AbortController().signal): Promise<TencentDocsImportResult> {
      const fileId = tencentDocsFileId(input.url)
      const tool = find('get_content')
      if (tool === undefined) throw Object.assign(new Error('腾讯文档尚未连接，无法读取云端文档。'), { status: 409 })
      const properties = tool.parameters?.properties ?? {}
      const args = fileId === undefined
        ? (properties.url === undefined ? { file_id: input.url } : { url: input.url })
        : properties.file_id !== undefined
          ? { file_id: fileId }
          : properties.doc_id !== undefined
            ? { doc_id: fileId }
            : properties.url !== undefined
              ? { url: input.url }
              : { file_id: fileId }
      const raw = await call('get_content', args, signal)
      const body = textOf(raw).trim()
      if (body.length === 0) throw Object.assign(new Error('腾讯文档没有返回可导入的正文。'), { status: 422 })
      const title = input.title ?? objectString(raw, ['title', 'name', 'file_name']) ?? `腾讯文档 ${fileId ?? ''}`.trim()
      const bases = await provider.listKnowledgeBases(signal)
      const target = input.knowledgeBaseId !== undefined
        ? bases.find(base => base.id === input.knowledgeBaseId && base.status === 'active')
        : bases.find(base => base.id === DEFAULT_KNOWLEDGE_BASE_ID && base.status === 'active')
          ?? bases.find(base => base.status === 'active')
      if (target === undefined) throw Object.assign(new Error('没有可写入的本地知识库。'), { status: 409 })
      const group = input.group?.trim() || '腾讯文档'
      const entry = await provider.create({
        knowledgeBaseId: target.id,
        title,
        body: `> 来源：腾讯文档 ${input.url}\n\n${body.slice(0, 200_000)}`,
        type: 'fact',
        tags: ['tencent-docs'],
        scope: { kind: 'global' },
        confidence: 1,
        group,
      }, signal)
      return {
        documentId: entry.id,
        title: entry.title,
        knowledgeBaseId: entry.knowledgeBaseId,
        group: entry.group ?? group,
        sourceUrl: input.url,
      }
    },
    async publish(documentId: string, signal = new AbortController().signal): Promise<TencentDocsPublishResult> {
      const entry = await provider.get(documentId, signal)
      if (entry === undefined || entry.status !== 'active') throw Object.assign(new Error('知识文档不存在或已归档。'), { status: 404 })
      const tool = find('create_smartcanvas_by_mdx')
      if (tool === undefined) throw Object.assign(new Error('腾讯文档尚未连接，无法发布云端文档。'), { status: 409 })
      const properties = tool.parameters?.properties ?? {}
      const args: Record<string, unknown> = { title: entry.title }
      if (properties.mdx !== undefined) args.mdx = entry.body
      else if (properties.markdown !== undefined) args.markdown = entry.body
      else args.content = entry.body
      if (properties.content_format !== undefined) args.content_format = 'mdx'
      const raw = await call('create_smartcanvas_by_mdx', args, signal)
      const url = objectString(raw, ['url', 'file_url', 'doc_url', 'link']) ?? textOf(raw).match(/https:\/\/docs\.qq\.com\/[^\s"'<>]+/u)?.[0]
      return { documentId: entry.id, title: entry.title, ...url === undefined ? {} : { url } }
    },
  }
}

function tencentDocsFileId(url: string): string | undefined {
  const match = /docs\.qq\.com\/(?:doc|sheet|slide|mind|flowchart|form|smartsheet)\/([A-Za-z0-9_-]+)/u.exec(url.trim())
  return match?.[1] ?? (/^[A-Za-z0-9_-]{8,}$/u.test(url.trim()) ? url.trim() : undefined)
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['markdown', 'mdx', 'content', 'text', 'body', 'data']) {
      if (record[key] !== undefined) {
        const text = textOf(record[key])
        if (text.length > 0) return text
      }
    }
    return Object.values(record).map(textOf).filter(Boolean).join('\n')
  }
  return ''
}

function objectString(value: unknown, keys: string[]): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const item = record[key]
    if (typeof item === 'string' && item.trim().length > 0) return item.trim()
  }
  for (const item of Object.values(record)) {
    const found = objectString(item, keys)
    if (found !== undefined) return found
  }
  return undefined
}
