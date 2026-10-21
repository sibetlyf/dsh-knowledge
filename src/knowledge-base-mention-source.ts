import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

export const KNOWLEDGE_BASE_MENTION_SOURCE = 'knowledge-bases'
const PATH = '/knowledge-control/v1/activity/knowledge-bases'

interface KnowledgeBaseMention {
  id: string
  name: string
  sessionId: string
  sourceKey: string
}

/**
 * `@` source for introducing a knowledge base into the current conversation.
 *
 * The reference survives editing/copying like a file mention. At submit time
 * the codec creates a recall-only session mount, so the existing automatic
 * recall, knowledge_search and knowledge_read paths see the selected base
 * without any extra model instruction.
 */
export function createKnowledgeBaseMentionSource(request: typeof fetch = fetch): InputTriggerSource {
  async function read(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const response = await request(path, {
      ...init,
      signal,
      headers: { accept: 'application/json', 'x-dsh-knowledge-client': 'conversation-web', ...init.headers },
    })
    const body: unknown = await response.json()
    if (!response.ok) throw new Error(isObject(body) && typeof body.error === 'string' ? body.error : `知识库请求失败（HTTP ${response.status}）`)
    signal.throwIfAborted()
    return body
  }

  return {
    trigger: '@', name: KNOWLEDGE_BASE_MENTION_SOURCE, order: 15, showGroupTitle: false,
    async candidates(session, { query, quoted, drilled, signal }) {
      if (quoted || drilled || query.length > 255) return []
      await pause(100, signal)
      const params = new URLSearchParams({ sessionId: session.sessionId, q: query.trim() })
      const body = await read(`${PATH}?${params}`, { method: 'GET' }, signal)
      if (!isObject(body) || typeof body.sourceKey !== 'string' || !Array.isArray(body.items)) throw new Error('知识库列表返回了无效数据。')
      const sourceKey = body.sourceKey
      return body.items.slice(0, 30).map((item: unknown) => {
        if (!isObject(item) || typeof item.id !== 'string' || typeof item.name !== 'string') throw new Error('知识库列表返回了无效条目。')
        const description = typeof item.description === 'string' ? item.description : ''
        const mounted = item.mounted === true
        return {
          name: `知识库 · ${item.name}`,
          label: `知识库 · ${item.name}`,
          icon: 'folder' as const,
          section: '引入知识库',
          description: mounted ? `已挂载${description ? ` · ${description}` : ''}` : (description || '选择后把该知识库引入当前对话'),
          value: JSON.stringify({
            id: item.id, name: item.name, sessionId: session.sessionId, sourceKey,
          } satisfies KnowledgeBaseMention),
        }
      })
    },
    onPick({ candidate, session, action }) {
      if (action !== 'pick') return undefined
      const reference = parseReference(candidate.value)
      if (!reference || reference.sessionId !== session.sessionId) return undefined
      return {
        insert: {
          source: KNOWLEDGE_BASE_MENTION_SOURCE,
          ref: candidate.value!,
          label: `知识库 · ${reference.name}`,
          appearance: 'folder',
          clipboardText: `[知识库：${reference.name}]`,
        },
      }
    },
    openReference() { return false },
    codec: {
      clipboardText(ref) {
        const reference = parseReference(ref)
        if (!reference) throw new Error('知识库引用无效，请重新选择。')
        return `[知识库：${reference.name}]`
      },
      async serialize(ref, signal) {
        const reference = parseReference(ref)
        if (!reference) throw new Error('知识库引用无效，请重新选择。')
        const params = new URLSearchParams({ sessionId: reference.sessionId })
        const body = await read(`${PATH}/${encodeURIComponent(reference.id)}/introduce?${params}`, { method: 'POST' }, signal)
        if (!isObject(body) || body.introduced !== true || !isObject(body.knowledgeBase)) throw new Error('知识库引入失败。')
        const name = typeof body.knowledgeBase.name === 'string' ? body.knowledgeBase.name : reference.name
        return [
          `【引入知识库：${name}】`,
          `本轮对话已把知识库「${name}」加入召回范围（仅召回，不写入该库）。`,
          '回答时优先依据该知识库；需要细节时使用 knowledge_search / knowledge_base_search，并用 knowledge_read 读取命中文档。',
        ].join('\n')
      },
    },
  }
}

function parseReference(raw: string | undefined): KnowledgeBaseMention | undefined {
  if (!raw || raw.length > 4096) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (isObject(value) && typeof value.id === 'string' && value.id.length > 0
      && typeof value.name === 'string' && value.name.length <= 255
      && typeof value.sessionId === 'string' && value.sessionId.length > 0
      && typeof value.sourceKey === 'string') return value as unknown as KnowledgeBaseMention
  } catch { /* Invalid clipboard or stale draft payload. */ }
  return undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
