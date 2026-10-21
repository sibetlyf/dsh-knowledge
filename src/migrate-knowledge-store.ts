import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface MigrationLogger {
  info(message: string): void
  warn(message: string): void
}

/**
 * Copy an existing DSH-home knowledge store to a new data directory once.
 *
 * The old location stays untouched as a backup. Copying (rather than moving)
 * keeps absolute archive links stored in old artifact documents valid while new
 * archives use the new directory.
 */
export function migrateLegacyKnowledgeStore(source: string, target: string, logger: MigrationLogger): boolean {
  try {
    if (resolve(source) === resolve(target)) return false
    if (existsSync(join(target, 'knowledge.sqlite'))) return false
    if (!existsSync(join(source, 'knowledge.sqlite'))) return false
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source)) {
      try {
        cpSync(join(source, entry), join(target, entry), { recursive: true, errorOnExist: false, force: false })
      } catch (error) {
        logger.warn(`dsh-knowledge: 迁移旧知识库文件 ${entry} 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const legacyWorklog = join(source, '..', 'worklog', 'worklog.sqlite')
    const targetWorklog = join(target, 'knowledge.sqlite.worklog.sqlite')
    if (!existsSync(targetWorklog) && existsSync(legacyWorklog)) {
      try {
        cpSync(legacyWorklog, targetWorklog)
      } catch (error) {
        logger.warn(`dsh-knowledge: 迁移旧工作日报数据库失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    logger.info(`dsh-knowledge: 已将知识库从 ${source} 复制到 ${target}（旧目录保留为备份）`)
    return existsSync(join(target, 'knowledge.sqlite'))
  } catch (error) {
    logger.warn(`dsh-knowledge: 迁移旧知识库目录失败: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
