import { dayOf } from './domain.js'

/**
 * Build the worklog source record for one knowledge write.
 *
 * Knowledge records reuse the normal source shape so report generation,
 * exclusion, history and central sync keep working unchanged. `captureKind`
 * lets the UI distinguish them from conversation captures.
 */
export function knowledgeRecord(event, config, sourceId, now = Date.now()) {
  const time = Number.isFinite(event?.time) ? event.time : now
  const project = typeof event?.project === 'string' ? event.project.trim() : ''
  const route = event?.route && typeof event.route.provider === 'string' && typeof event.route.model === 'string'
    ? { provider: event.route.provider, model: event.route.model }
    : null
  return {
    id: `knowledge:${String(event?.id ?? '').slice(0, 400)}`,
    day: dayOf(time, config.timezone),
    project,
    time,
    user: `知识库更新：${String(event?.title ?? '知识文档').slice(0, 400)}`,
    answer: String(event?.summary ?? '').slice(0, 32000),
    sessionId: typeof event?.sessionId === 'string' ? event.sessionId : null,
    turn: Number.isSafeInteger(event?.turn) && event.turn >= 0 ? event.turn : 0,
    truncated: false,
    captureKind: 'knowledge',
    knowledgeBaseId: typeof event?.knowledgeBaseId === 'string' ? event.knowledgeBaseId : null,
    documentId: typeof event?.documentId === 'string' ? event.documentId : null,
    action: typeof event?.action === 'string' ? event.action : 'updated',
    route,
    sourceId,
  }
}

/** Prepare the worklog for automatic knowledge updates on first use. */
export function prepareWorklog(store, project, now = Date.now()) {
  const config = store.config()
  if (!project) return config
  if (!config.enabled) {
    return store.configure({
      ...config,
      enabled: true,
      scope: 'selected',
      projects: [...new Set([...config.projects, project])],
      scheduleEnabled: true,
      scheduleCatchup: true,
    }, now)
  }
  if (config.scope === 'selected' && !config.projects.includes(project)) {
    return store.configure({ ...config, projects: [...new Set([...config.projects, project])] }, now)
  }
  return config
}

/**
 * Debounce background regeneration of the day's report.
 *
 * A burst of knowledge writes (one turn can archive several files and update
 * several documents) must not trigger one model call per write. Manual report
 * edits keep precedence: an edited report is never replaced automatically.
 */
export function createRefreshScheduler(store, current, logger, delayMs = 8000) {
  let timer
  const pending = (day) => {
    const detail = store.detail(day)
    return detail.records.some(record => !record.excluded && !detail.report.covered.includes(record.id))
  }
  const generate = (day, retries) => {
    try {
      if (current().backend !== 'local') return
      if (store.report(day).edited) {
        logger.info('worklog: 日报已手工修改，跳过知识库触发的自动更新')
        return
      }
      if (!pending(day)) return
      const id = store.enqueue(day)
      const job = store.job(id)
      // A running generation covers only its snapshot. Keep checking until the
      // new knowledge material is actually covered, then stop.
      if (retries > 0 && job && (job.status === 'queued' || job.status === 'running')) {
        timer = setTimeout(() => generate(day, retries - 1), 15000)
        timer.unref?.()
      }
    } catch (error) {
      logger.warn(`worklog: 知识库更新后自动整理日报失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const schedule = (day) => {
    if (!day || current().backend !== 'local') return
    clearTimeout(timer)
    timer = setTimeout(() => generate(day, 6), delayMs)
    timer.unref?.()
  }
  const dispose = () => clearTimeout(timer)
  return { schedule, dispose }
}
