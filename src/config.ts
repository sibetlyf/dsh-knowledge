import Schema from '@deepseek-ai/schemastery'
import { existsSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeRemoteKnowledgeUrl } from './remote-url.js'

/** Workspace noise that must never enter the artifact knowledge base. */
export const DEFAULT_ARTIFACT_EXCLUDE: string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.dsh/**',
  '**/.dsh-meow/**',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/credentials*',
  '**/secrets*',
  '**/*.sqlite',
  '**/*.sqlite3',
  '**/*.sqlite-wal',
  '**/*.sqlite-shm',
]

export interface Config {
  backend: 'local' | 'remote'
  databasePath?: string
  remoteUrl?: string
  remoteToken?: string
  remoteTimeoutMs: number
  connectionPath?: string
  writebackQueuePath?: string
  exposeApi: boolean
  apiToken?: string
  apiPrefix: string
  exposeWeb: boolean
  webPath: string
  extractionEnabled: boolean
  extractionProvider?: string
  extractionModel?: string
  extractionMaxTokens: number
  extractionTimeoutMs: number
  extractionMaxInputChars: number
  defaultScope: 'project' | 'global'
  autoRecallLimit: number
  autoRecallMinScore: number
  recallMaxChars: number
  trustedShareOrigins: string[]
  noteOrganizeEnabled: boolean
  noteOrganizeTargetFolder: string
  noteOrganizePrompt: string
  noteOrganizeIntervalMinutes: number
  noteOrganizeMinNotes: number
  artifactArchiveEnabled: boolean
  artifactArchiveBaseName: string
  artifactArchivePath?: string
  artifactArchiveExtensions: string[]
  artifactArchiveExclude: string[]
  artifactArchiveMaxFileBytes: number
  artifactArchiveMaxChars: number
  artifactArchiveStoreContent: boolean
  artifactArchivePaperEnabled: boolean
  artifactArchivePaperBaseName: string
  artifactArchiveMaxEntries: number
  artifactArchiveAutoMount: boolean
  autoWritableMountEnabled: boolean
  autoWritableMountWriteMode: 'direct' | 'audit'
  autoCreateKnowledgeBases: boolean
  autoCreateKnowledgeBasesMaxPerDay: number
  autoOrganizeTrigger: 'turn' | 'interval'
  autoOrganizeIntervalMinutes: number
  autoApprovePendingEnabled: boolean
  autoApprovePendingIntervalMinutes: number
  noteOrganizeAutoApprove: boolean
  worklogAutoUpdateEnabled: boolean
  worklogAutoUpdateTrigger: 'turn' | 'interval'
  worklogAutoUpdateIntervalMinutes: number
  tokenSavingEnabled: boolean
}

export const Config: Schema<Config> = Schema.object({
  backend: Schema.union(['local', 'remote']).default('local'),
  databasePath: Schema.string(),
  remoteUrl: Schema.string(),
  remoteToken: Schema.string().role('secret'),
  remoteTimeoutMs: Schema.number().min(100).max(120_000).default(10_000),
  connectionPath: Schema.string(),
  writebackQueuePath: Schema.string().description('本机持久化回写队列；默认与知识库数据库或连接配置相邻。'),
  exposeApi: Schema.boolean().default(false),
  apiToken: Schema.string().role('secret'),
  apiPrefix: Schema.string().default('/knowledge-api/v1'),
  exposeWeb: Schema.boolean().default(true),
  webPath: Schema.string().default('/knowledge'),
  extractionEnabled: Schema.boolean().default(true),
  extractionProvider: Schema.string(),
  extractionModel: Schema.string(),
  extractionMaxTokens: Schema.number().min(128).max(8192).default(4096),
  extractionTimeoutMs: Schema.number().min(1000).max(300_000).default(90_000),
  extractionMaxInputChars: Schema.number().min(1000).max(200_000).default(30_000),
  defaultScope: Schema.union(['project', 'global']).default('project'),
  autoRecallLimit: Schema.number().min(0).max(10).default(3),
  autoRecallMinScore: Schema.number().min(0).max(1).default(0.2),
  recallMaxChars: Schema.number().min(500).max(20_000).default(5000),
  trustedShareOrigins: Schema.array(Schema.string()).default([]).description('允许分享导入在指定的精确 Origin 上使用内网 DNS 回流。不支持通配符；已安装远程访问插件时会自动合并其可信 Origin。'),
  noteOrganizeEnabled: Schema.boolean().default(false).description('是否开启后台自动笔记与对话知识整理'),
  noteOrganizeTargetFolder: Schema.string().default('整理归档').description('自动整理生成的笔记存放目录'),
  noteOrganizePrompt: Schema.string().default('对所有对话产出、笔记及文档进行深度提炼，提取核心主题、工作产出，并生成思维树与双链').description('自动整理提示词'),
  noteOrganizeIntervalMinutes: Schema.number().min(5).max(1440).default(60).description('自动整理定时轮询间隔（分钟）'),
  noteOrganizeMinNotes: Schema.number().min(1).max(50).default(2).description('触发自动整理的未归档最少素材数量'),
  artifactArchiveEnabled: Schema.boolean().default(true).description('自动归档每轮产出的制品文件（present 声明与文件工具写入）并纳入知识库，无需人工操作'),
  artifactArchiveBaseName: Schema.string().default('制品归档').description('接收制品文档的知识库名称；不存在时自动创建'),
  artifactArchivePath: Schema.string().description('归档副本目录；默认与知识库数据库相邻的 artifacts 目录'),
  artifactArchiveExtensions: Schema.array(Schema.string()).default(['*']).description('纳入自动归档的扩展名（不含点）；默认 * 表示任务中涉及的所有文件'),
  artifactArchiveExclude: Schema.array(Schema.string()).default(DEFAULT_ARTIFACT_EXCLUDE).description('排除的制品路径模式，支持 * 与 **'),
  artifactArchiveMaxFileBytes: Schema.number().min(1024).max(512 * 1024 * 1024).default(32 * 1024 * 1024).description('单个制品允许归档的最大字节数'),
  artifactArchiveMaxChars: Schema.number().min(1000).max(46_000).default(46_000).description('开启正文入库时单个制品写入知识文档的最大正文字符数'),
  artifactArchiveStoreContent: Schema.boolean().default(false).description('是否把抽取到的文件正文写入知识库文档；默认 false，数据库只保存文件链接、元数据与关键词，完整文件保留在归档目录'),
  artifactArchivePaperEnabled: Schema.boolean().default(true).description('识别 PDF 论文并把摘要、关键词、分类与年份写入知识库；论文统一归入一个论文知识库，按类别分组'),
  artifactArchivePaperBaseName: Schema.string().default('论文库').description('论文知识库名称；首次出现论文时自动创建，不按单篇论文新建知识库'),
  artifactArchiveMaxEntries: Schema.number().min(100).max(200_000).default(20_000).description('归档索引保留的最大记录数'),
  artifactArchiveAutoMount: Schema.boolean().default(true).description('首次归档时把制品知识库挂载到对应项目以参与召回'),
  autoWritableMountEnabled: Schema.boolean().default(true).description('当项目没有任何可写知识库挂载时，自动把默认知识库以可写模式挂载到项目，避免“未挂载可写知识库”而无法写入'),
  autoWritableMountWriteMode: Schema.union(['direct', 'audit']).default('direct').description('自动挂载默认知识库时使用的写入模式：direct 直接写入，audit 进入待审核'),
  autoCreateKnowledgeBases: Schema.boolean().default(true).description('提取时若现有知识库都不适合，允许模型自动新建一个知识栏目（知识库）并直接写入'),
  autoCreateKnowledgeBasesMaxPerDay: Schema.number().min(0).max(20).default(3).description('每天最多自动新建多少个知识库（0 表示只复用现有知识库），避免知识库爆炸'),
  autoOrganizeTrigger: Schema.union(['turn', 'interval']).default('turn').description('自动组织知识：turn 每轮对话后触发；interval 按下面的分钟间隔批量触发'),
  autoOrganizeIntervalMinutes: Schema.number().min(1).max(1440).default(30).description('自动组织知识的间隔分钟数（仅 interval 模式）'),
  autoApprovePendingEnabled: Schema.boolean().default(true).description('自动批准待审核的非冲突候选，取消人工审核；包含凭据等敏感内容的候选仍保留人工处理'),
  autoApprovePendingIntervalMinutes: Schema.number().min(1).max(60).default(2).description('自动批准待审核候选的轮询间隔（分钟）'),
  noteOrganizeAutoApprove: Schema.boolean().default(true).description('笔记自动整理生成的草案直接落盘，不再等待人工批准'),
  worklogAutoUpdateEnabled: Schema.boolean().default(true).description('知识库更新后自动记录工作素材并在后台实时刷新当日工作日报；首次使用会自动为当前项目开启日报采集与每日生成'),
  worklogAutoUpdateTrigger: Schema.union(['turn', 'interval']).default('turn').description('自动工作纪要触发方式：turn 每轮对话/知识更新后；interval 按分钟间隔批量刷新'),
  worklogAutoUpdateIntervalMinutes: Schema.number().min(1).max(1440).default(30).description('自动工作纪要的间隔分钟数（仅 interval 模式）'),
  tokenSavingEnabled: Schema.boolean().default(true).description('节省知识库 token：限制提取输入/输出、降低自动召回条数与上下文字符上限'),
})

export interface ResolvedConfig extends Config {
  remoteTimeoutMs: number
  apiPrefix: string
  exposeWeb: boolean
  webPath: string
  extractionMaxTokens: number
  extractionTimeoutMs: number
  extractionMaxInputChars: number
  defaultScope: 'project' | 'global'
  autoRecallLimit: number
  autoRecallMinScore: number
  recallMaxChars: number
  noteOrganizeEnabled: boolean
  noteOrganizeTargetFolder: string
  noteOrganizePrompt: string
  noteOrganizeIntervalMinutes: number
  noteOrganizeMinNotes: number
  artifactArchiveEnabled: boolean
  artifactArchiveBaseName: string
  artifactArchiveExtensions: string[]
  artifactArchiveExclude: string[]
  artifactArchiveMaxFileBytes: number
  artifactArchiveMaxChars: number
  artifactArchiveStoreContent: boolean
  artifactArchivePaperEnabled: boolean
  artifactArchivePaperBaseName: string
  artifactArchiveMaxEntries: number
  artifactArchiveAutoMount: boolean
  autoWritableMountEnabled: boolean
  autoWritableMountWriteMode: 'direct' | 'audit'
  autoCreateKnowledgeBases: boolean
  autoCreateKnowledgeBasesMaxPerDay: number
  autoOrganizeTrigger: 'turn' | 'interval'
  autoOrganizeIntervalMinutes: number
  autoApprovePendingEnabled: boolean
  autoApprovePendingIntervalMinutes: number
  noteOrganizeAutoApprove: boolean
  worklogAutoUpdateEnabled: boolean
  worklogAutoUpdateTrigger: 'turn' | 'interval'
  worklogAutoUpdateIntervalMinutes: number
  tokenSavingEnabled: boolean
}

export function resolveConfig(config: Config): ResolvedConfig {
  const databasePath = config.databasePath ?? (config.backend === 'local' ? join(defaultKnowledgeDirectory(), 'knowledge.sqlite') : undefined)
  const connectionPath = config.connectionPath ?? deriveConnectionPath(databasePath) ?? join(defaultKnowledgeDirectory(), 'connection.json')
  const tokenSaving = config.tokenSavingEnabled ?? true
  const resolved: ResolvedConfig = {
    ...config,
    ...databasePath === undefined ? {} : { databasePath },
    remoteTimeoutMs: config.remoteTimeoutMs ?? 10_000,
    ...connectionPath === undefined ? {} : { connectionPath },
    writebackQueuePath: config.writebackQueuePath ?? (databasePath === ':memory:' ? ':memory:' : databasePath
      ? `${databasePath}.writeback.sqlite` : connectionPath ? `${connectionPath}.writeback.sqlite` : join(defaultKnowledgeDirectory(), 'writeback.sqlite')),
    apiPrefix: normalizePrefix(config.apiPrefix ?? '/knowledge-api/v1'),
    exposeWeb: config.exposeWeb ?? true,
    webPath: normalizePrefix(config.webPath ?? '/knowledge'),
    extractionMaxTokens: Math.min(config.extractionMaxTokens ?? 4096, tokenSaving ? 3072 : Infinity),
    extractionTimeoutMs: config.extractionTimeoutMs ?? 90_000,
    extractionMaxInputChars: Math.min(config.extractionMaxInputChars ?? 30_000, tokenSaving ? 12_000 : Infinity),
    defaultScope: config.defaultScope ?? 'project',
    autoRecallLimit: Math.min(config.autoRecallLimit ?? 3, tokenSaving ? 2 : 10),
    autoRecallMinScore: config.autoRecallMinScore ?? 0.2,
    recallMaxChars: Math.min(config.recallMaxChars ?? 5000, tokenSaving ? 3000 : 20_000),
    trustedShareOrigins: normalizeTrustedShareOrigins(config.trustedShareOrigins ?? []),
    noteOrganizeEnabled: config.noteOrganizeEnabled ?? false,
    noteOrganizeTargetFolder: config.noteOrganizeTargetFolder ?? '整理归档',
    noteOrganizePrompt: config.noteOrganizePrompt ?? '对所有对话产出、笔记及文档进行深度提炼，提取核心主题、工作产出，并生成思维树与双链',
    noteOrganizeIntervalMinutes: config.noteOrganizeIntervalMinutes ?? 60,
    noteOrganizeMinNotes: config.noteOrganizeMinNotes ?? 2,
    artifactArchiveEnabled: config.artifactArchiveEnabled ?? true,
    artifactArchiveBaseName: (config.artifactArchiveBaseName ?? '制品归档').trim() || '制品归档',
    artifactArchiveExtensions: [...(config.artifactArchiveExtensions ?? ['*'])],
    artifactArchiveExclude: [...(config.artifactArchiveExclude ?? DEFAULT_ARTIFACT_EXCLUDE)],
    artifactArchiveMaxFileBytes: config.artifactArchiveMaxFileBytes ?? 32 * 1024 * 1024,
    artifactArchiveMaxChars: config.artifactArchiveMaxChars ?? 46_000,
    artifactArchiveStoreContent: config.artifactArchiveStoreContent ?? false,
    artifactArchivePaperEnabled: config.artifactArchivePaperEnabled ?? true,
    artifactArchivePaperBaseName: (config.artifactArchivePaperBaseName ?? '论文库').trim() || '论文库',
    artifactArchiveMaxEntries: config.artifactArchiveMaxEntries ?? 20_000,
    artifactArchiveAutoMount: config.artifactArchiveAutoMount ?? true,
    autoWritableMountEnabled: config.autoWritableMountEnabled ?? true,
    autoWritableMountWriteMode: config.autoWritableMountWriteMode ?? 'direct',
    autoCreateKnowledgeBases: config.autoCreateKnowledgeBases ?? true,
    autoCreateKnowledgeBasesMaxPerDay: config.autoCreateKnowledgeBasesMaxPerDay ?? 3,
    autoOrganizeTrigger: config.autoOrganizeTrigger ?? 'turn',
    autoOrganizeIntervalMinutes: config.autoOrganizeIntervalMinutes ?? 30,
    autoApprovePendingEnabled: config.autoApprovePendingEnabled ?? true,
    autoApprovePendingIntervalMinutes: config.autoApprovePendingIntervalMinutes ?? 2,
    noteOrganizeAutoApprove: config.noteOrganizeAutoApprove ?? true,
    worklogAutoUpdateEnabled: config.worklogAutoUpdateEnabled ?? true,
    worklogAutoUpdateTrigger: config.worklogAutoUpdateTrigger ?? 'turn',
    worklogAutoUpdateIntervalMinutes: config.worklogAutoUpdateIntervalMinutes ?? 30,
    tokenSavingEnabled: tokenSaving,
  }
  if (resolved.backend === 'local' && (resolved.databasePath === undefined || resolved.databasePath.trim().length === 0)) {
    throw new Error('local knowledge backend requires databasePath')
  }
  if (resolved.backend === 'remote') {
    if (resolved.remoteUrl === undefined || resolved.remoteToken === undefined) {
      throw new Error('remote knowledge backend requires remoteUrl and remoteToken')
    }
    normalizeRemoteKnowledgeUrl(resolved.remoteUrl)
    if (resolved.remoteToken.trim().length < 24) throw new Error('remoteToken must contain at least 24 characters')
    if (resolved.exposeApi) throw new Error('remote knowledge backend cannot expose the local API')
  }
  const hasExtractionProvider = resolved.extractionProvider !== undefined
  const hasExtractionModel = resolved.extractionModel !== undefined
  if (hasExtractionProvider !== hasExtractionModel) {
    throw new Error('extractionProvider and extractionModel must be configured together')
  }
  if (resolved.exposeApi && (resolved.apiToken === undefined || resolved.apiToken.trim().length < 24)) {
    throw new Error('exposeApi requires apiToken with at least 24 characters')
  }
  if (resolved.webPath === resolved.apiPrefix || resolved.webPath.startsWith(`${resolved.apiPrefix}/`) || resolved.apiPrefix.startsWith(`${resolved.webPath}/`)) {
    throw new Error('webPath and apiPrefix must not overlap')
  }
  return resolved
}

export function normalizeTrustedShareOrigins(values: readonly string[]): string[] {
  const normalized = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    if (value === '') continue
    let url: URL
    try { url = new URL(value) } catch { throw new Error(`invalid trusted share origin: ${value}`) }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`trusted share origin must be an exact HTTP(S) origin: ${value}`)
    }
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || isIP(url.hostname.replace(/^\[|\]$/gu, '')) !== 0) {
      throw new Error(`trusted share origin must use a DNS hostname: ${value}`)
    }
    normalized.add(url.origin)
  }
  return [...normalized]
}

function deriveConnectionPath(databasePath: string | undefined): string | undefined {
  return databasePath === undefined || databasePath.trim().length === 0 || databasePath === ':memory:'
    ? undefined
    : join(dirname(databasePath), 'connection.json')
}

/**
 * Default data directory for this installation.
 *
 * On Windows it prefers a non-system drive: the drive that holds the plugin
 * itself (so a plugin installed on `G:` keeps its data on `G:`), then any
 * existing `dsh-knowledge` folder on another drive, and only then the DSH home
 * on the system drive. `DSH_KNOWLEDGE_HOME` overrides the whole choice.
 */
export function defaultKnowledgeDirectory(): string {
  const override = process.env.DSH_KNOWLEDGE_HOME?.trim()
  if (override !== undefined && override.length > 0) return override
  if (process.platform === 'win32') {
    try {
      // A DSH profile often links the plugin from another drive (junction or
      // symlink); resolve the link before choosing the data drive.
      const root = parse(realpathSync.native(fileURLToPath(import.meta.url))).root
      if (/^[A-Za-z]:[\\/]$/u.test(root) && !/^[cC]:[\\/]$/u.test(root)) return join(root, 'dsh-knowledge')
    } catch {
      // fall through to a drive scan or the DSH home
    }
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const candidate = `${letter}:\\dsh-knowledge`
      if (existsSync(candidate)) return candidate
    }
  }
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'knowledge')
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim()
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const prefix = withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(prefix)) throw new Error('apiPrefix must be an absolute URL path')
  return prefix
}
