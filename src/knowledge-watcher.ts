import { contentHash } from './domain.js'
import type { KnowledgeProvider } from './provider.js'
import type { KnowledgeWriteEvent } from './knowledge-events.js'

export interface KnowledgeWatcherOptions {
  provider: KnowledgeProvider
  emit: (event: KnowledgeWriteEvent) => void
  intervalMs?: number
  limit?: number
  logger?: { warn(message: string): void }
}

export interface KnowledgeWatcher {
  start(): void
  stop(): void
  /** Run one comparison pass; exported for tests. */
  poll(): Promise<void>
}

/**
 * Safety net for knowledge writes that do not go through the extraction or
 * artifact callbacks — for example a manual edit in the management console or
 * an audit candidate approved in the background.
 *
 * The first pass only baselines current versions so existing documents are not
 * dumped into today's journal. Later passes compare a bounded page ordered by
 * `updatedAt`; a version bump that does not change the document content (status
 * finalize/reopen/archive) is ignored. Event ids reuse `<documentId>:<version>`,
 * so the journal's insert-if-absent deduplicates them against direct events.
 */
export function createKnowledgeWatcher(options: KnowledgeWatcherOptions): KnowledgeWatcher {
  const seen = new Map<string, { version: number; hash: string }>()
  const intervalMs = Math.max(5000, Math.trunc(options.intervalMs ?? 60_000))
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)))
  let baseline = true
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  const poll = async (): Promise<void> => {
    if (stopped) return
    try {
      const page = await options.provider.list({ status: 'active', limit })
      const current = new Set<string>()
      for (const entry of page.items) {
        current.add(entry.id)
        const hash = contentHash(entry)
        const previous = seen.get(entry.id)
        seen.set(entry.id, { version: entry.version, hash })
        if (baseline || (previous !== undefined && previous.hash === hash)) continue
        try {
          options.emit({
            id: `${entry.id}:${entry.version}`,
            title: entry.title,
            summary: `知识文档「${entry.title}」已${previous === undefined ? '写入' : '更新'}（知识库 ${entry.knowledgeBaseId}）。`,
            ...entry.scope.kind === 'project' ? { project: entry.scope.id } : {},
            knowledgeBaseId: entry.knowledgeBaseId,
            documentId: entry.id,
            action: previous === undefined ? 'created' : 'updated',
          })
        } catch (error) {
          options.logger?.warn(`dsh-knowledge: 知识库变更事件通知失败: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      baseline = false
      if (seen.size > 5000) {
        for (const id of [...seen.keys()]) if (!current.has(id)) seen.delete(id)
      }
    } catch (error) {
      options.logger?.warn(`dsh-knowledge: 知识库变更巡检失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    poll,
    start() {
      if (timer !== undefined || stopped) return
      void poll()
      timer = setInterval(() => { void poll() }, intervalMs)
      timer.unref?.()
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
