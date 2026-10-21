import type { Context } from '@deepseek-ai/cordis'
import type { KnowledgeConnectionSettings } from './connection.js'
import type { KnowledgeWriteEvent } from './knowledge-events.js'

export type { KnowledgeWriteEvent } from './knowledge-events.js'

export interface JournalRuntime {
  dispatch(method: string, path: string, data: Record<string, unknown>, query: URLSearchParams): Promise<unknown>
  isRunning(): boolean
  /** Record one automatic knowledge write and refresh the day's report in the background. */
  recordKnowledge(event: KnowledgeWriteEvent): boolean
}
export function apply(ctx: Context, config: {
  databasePath: string
  current(): KnowledgeConnectionSettings
  onDispose(): void
  autoUpdate?: { trigger: 'turn' | 'interval'; intervalMinutes: number }
}): JournalRuntime
