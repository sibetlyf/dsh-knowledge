import type { KnowledgeProvider } from './provider.js'

export interface PendingAutoApproverOptions {
  provider: KnowledgeProvider
  logger: { info(message: string): void; warn(message: string): void }
  /** Poll interval in minutes. */
  intervalMinutes: number
  /** Candidates reviewed per batch (1-50, default 20). */
  batchLimit?: number
  /** Live enable switch; when false a scheduled pass becomes a no-op. */
  enabled?: () => boolean
}

export interface PendingAutoApprover {
  /** Review one bounded set of pending non-conflict candidates. */
  run(): Promise<void>
  start(): void
  stop(): void
}

/** Candidates the automated flow must not approve: contradictions and secrets. */
const BLOCKED_REASON = /credential-like|requires manual review|敏感|凭据|密钥/iu

/**
 * Approve reviewable pending candidates in the background.
 *
 * The knowledge pipeline can still route a write to audit mode (an explicit
 * audit mount, a conflicting revision, or credential-like content). This
 * approver removes the manual step for ordinary proposals while leaving two
 * deliberate exceptions: conflicts need a real decision, and credential-like
 * content keeps its safety hold. The provider's batch method already skips
 * conflicts; the explicit exclusion list also protects sensitive candidates.
 */
export function createPendingAutoApprover(options: PendingAutoApproverOptions): PendingAutoApprover {
  const batchLimit = Math.max(1, Math.min(50, Math.trunc(options.batchLimit ?? 20)))
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false
  let stopped = false
  const run = async (): Promise<void> => {
    if (running || stopped || options.enabled?.() === false) return
    running = true
    try {
      let approved = 0
      for (let pass = 0; pass < 5; pass += 1) {
        const pending = await options.provider.listCandidates('pending', 100)
        const excluded = pending
          .filter(candidate => candidate.action === 'conflict' || BLOCKED_REASON.test(candidate.reason))
          .map(candidate => candidate.id)
        const result = await options.provider.approvePendingBatch(batchLimit, excluded)
        approved += result.approved
        if (result.selected === 0 || result.remainingReviewable === 0) break
      }
      if (approved > 0) options.logger.info(`dsh-knowledge: 自动批准 ${approved} 条待审核知识候选`)
    } catch (error) {
      options.logger.warn(`dsh-knowledge: 自动批准待审核候选失败: ${message(error)}`)
    } finally {
      running = false
    }
  }
  return {
    run,
    start() {
      if (timer !== undefined || stopped) return
      timer = setInterval(() => { void run() }, Math.max(1, Math.trunc(options.intervalMinutes)) * 60_000)
      timer.unref?.()
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
