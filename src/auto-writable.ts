import { DEFAULT_KNOWLEDGE_BASE_ID } from './domain.js'
import type { KnowledgeProvider } from './provider.js'
import type { AgentLike } from './runtime.js'

export interface WritableMountGuardOptions {
  /** Write mode used for the automatically mounted base. */
  mode: 'audit' | 'direct'
  logger: { info(message: string): void; warn(message: string): void }
  /** Provider connection revision; a switch re-checks mounts on the new provider. */
  revision?: () => number
}

/**
 * Guarantee one writable knowledge mount for the session's project.
 *
 * Knowledge write-back and artifact archiving cannot persist anything when a
 * project only has recall-only mounts (or no mount at all). On the first step
 * of a turn this guard checks the resolved mounts and, when none is writable,
 * mounts the built-in default knowledge base on the project. Explicit user
 * overrides are respected: a disabled row, or a recall-only row for the default
 * base, is never re-enabled or rewritten.
 */
export function createWritableMountGuard(
  provider: KnowledgeProvider,
  options: WritableMountGuardOptions,
): (agent: AgentLike) => Promise<void> {
  const ensured = new Set<string>()
  let revision = options.revision?.()
  return async (agent: AgentLike): Promise<void> => {
    const projectId = agent.session.header.cwd?.trim()
    if (projectId === undefined || projectId.length === 0) return
    const currentRevision = options.revision?.()
    if (currentRevision !== undefined && currentRevision !== revision) {
      ensured.clear()
      revision = currentRevision
    }
    if (ensured.has(projectId)) return
    const mounts = await provider.resolveMounts(agent.session.id, projectId)
    if (mounts.some(mount => mount.enabled && mount.writeMode !== 'none')) {
      ensured.add(projectId)
      return
    }
    const rows = await provider.listMounts('project', projectId)
    const existing = rows.find(mount => mount.knowledgeBaseId === DEFAULT_KNOWLEDGE_BASE_ID)
    if (existing !== undefined && (!existing.enabled || existing.writeMode === 'none')) {
      ensured.add(projectId)
      options.logger.info('dsh-knowledge: 默认知识库挂载被显式设为不可写，保留现有设置')
      return
    }
    const base = await provider.getKnowledgeBase(DEFAULT_KNOWLEDGE_BASE_ID)
    if (base === undefined || base.status !== 'active') {
      options.logger.warn('dsh-knowledge: 默认知识库不可用，无法自动挂载可写知识库')
      return
    }
    await provider.upsertMount({
      targetKind: 'project',
      targetId: projectId,
      knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID,
      enabled: true,
      recallEnabled: true,
      writeMode: options.mode,
      includeTags: [],
      excludeTags: [],
      extractionInstructions: '',
    })
    ensured.add(projectId)
    options.logger.info(`dsh-knowledge: 未挂载可写知识库，已自动挂载「${base.name}」（${options.mode}）到项目 ${projectId}`)
  }
}
