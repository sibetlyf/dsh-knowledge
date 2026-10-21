/**
 * One knowledge mutation worth recording in the work journal.
 *
 * Producers are the automatic write paths (completed-turn extraction and
 * artifact archiving). The journal layer decides whether it is in scope,
 * provisions the worklog on first use, writes the source record and schedules
 * a debounced background regeneration of the day's report.
 */
export interface KnowledgeWriteEvent {
  /** Stable event identity; repeated writes of the same version must reuse it. */
  id: string
  title: string
  summary: string
  project?: string
  sessionId?: string
  turn?: number
  knowledgeBaseId?: string
  documentId?: string
  action: 'created' | 'updated' | 'archived'
  route?: { provider: string; model: string }
  /** Event time in milliseconds; defaults to now. */
  time?: number
}
