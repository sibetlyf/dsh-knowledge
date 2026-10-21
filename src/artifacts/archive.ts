import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { atomicWriteFile } from '../atomic-file.js'
import type { KnowledgeDraft, KnowledgeEntry, KnowledgeScope } from '../domain.js'
import type { KnowledgeProvider } from '../provider.js'
import type { SessionLike } from '../runtime.js'
import { extractPaperMetadata, type PaperMetadata } from './paper.js'
import type { KnowledgeWriteEvent } from '../knowledge-events.js'
import {
  collectTurnArtifacts,
  type ArtifactCandidate,
  type ArtifactUploadCandidate,
} from './collect.js'
import {
  artifactCategory,
  artifactMediaType,
  extensionForMediaType,
  extractArtifactContent,
  normalizeExtension,
  type ArtifactContent,
} from './text.js'

/** One archived artifact version. `path` is absolute, or the uploaded file name. */
export interface ArtifactRecord {
  id: string
  path: string
  display: string
  sha256: string
  size: number
  extension: string
  mediaType: string
  contentKind: ArtifactContent['kind']
  source: ArtifactCandidate['source']
  description?: string
  sessionId?: string
  turn?: number
  archivedAt: string
  updatedAt: string
  version: number
  blob: string
  knowledgeBaseId: string
  entryId: string
  textChars: number
}

interface Manifest {
  version: 1
  artifacts: Record<string, ArtifactRecord>
}

export interface ArtifactLogger {
  info(message: string): void
  warn(message: string): void
}

/** Bytes of one uploaded attachment read through the Host attachment service. */
export interface ResolvedUpload {
  name: string
  bytes: Buffer
  mediaType?: string
}

export interface ArtifactArchiverOptions {
  /** Directory holding `index.json` and the content-addressed `blobs/` tree. */
  root: string
  provider: KnowledgeProvider
  /** Knowledge base that receives one document per artifact path. */
  baseName: string
  /** Lowercase extensions without a dot; `*` captures every written file. */
  extensions: readonly string[]
  /** Glob-like patterns excluded from capture (matched on the display path). */
  excludePatterns: readonly string[]
  maxFileBytes: number
  /** Maximum indexed characters per artifact document. */
  maxContentChars: number
  /**
   * Embed extracted text in the knowledge document. Off by default: the
   * database keeps metadata, keywords and a link to the file on disk.
   */
  storeContent?: boolean
  /** Upper bound on manifest records; the least recently updated are dropped. */
  maxEntries: number
  /** Mount the artifact base for recall on the artifact's project. */
  autoMount: boolean
  /** Recognize PDF papers and file them in the paper base with metadata. */
  paperEnabled?: boolean
  /** Knowledge base that receives papers; created once on first paper. */
  paperBaseName?: string
  /** Reads uploaded attachment bytes; absent when the Host has no attachment service. */
  resolveUpload?: (upload: ArtifactUploadCandidate) => Promise<ResolvedUpload | undefined>
  /** Called after a new artifact document version is stored; feeds the work journal. */
  onArchived?: (event: KnowledgeWriteEvent) => void
  logger: ArtifactLogger
  now?: () => Date
}

export interface ArtifactIngestContext {
  sessionId: string
  cwd?: string
  turn: number
  /** Session model route, used as a worklog generation fallback. */
  route?: { provider: string; model: string }
}

export type ArtifactIngestAction = 'created' | 'updated' | 'unchanged' | 'skipped'

export interface ArtifactIngestItem {
  path: string
  display: string
  action: ArtifactIngestAction
  entryId?: string
}

export interface ArtifactIngestSummary {
  captured: number
  updated: number
  unchanged: number
  skipped: number
  failed: number
  items: ArtifactIngestItem[]
}

interface ArtifactInput {
  key: string
  /** Absolute source path, or the uploaded file's display name. */
  path: string
  display: string
  bytes: Buffer
  extension: string
  source: ArtifactCandidate['source']
  mediaType?: string
  description?: string
}

interface CaptureOutcome {
  action: ArtifactIngestAction
  item: ArtifactIngestItem
  key: string
}

const EMPTY_SUMMARY: ArtifactIngestSummary = { captured: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, items: [] }
const MANIFEST_FILE = 'index.json'
const MAX_CANDIDATES = 256
const MAX_BODY_CHARS = 49_500
const UPLOAD_KEY = '\u0000upload:'

export interface ArtifactArchiveStatus {
  /** Capture passes waiting behind the active one. */
  queued: number
  active: boolean
  total: number
  done: number
  current?: string
  last?: {
    at: number
    captured: number
    updated: number
    unchanged: number
    skipped: number
    failed: number
  }
}

/**
 * Archive files produced by completed turns and index them as knowledge.
 *
 * Product behavior:
 * - the plugin captures declared deliverables (`present`), files written by
 *   file tools, and attachments the user uploaded, as soon as a turn stops,
 *   with no review or confirmation step;
 * - every version of an artifact is kept byte-for-byte in a content-addressed
 *   archive next to the knowledge database;
 * - one knowledge document per artifact is created or updated in place, so its
 *   version history and search index follow the artifact;
 * - documents are grouped per project and the artifact knowledge base is
 *   mounted for recall on the producing project.
 */
export class ArtifactArchiver {
  private readonly root: string
  private readonly extensions: ReadonlySet<string> | 'all'
  private readonly patterns: RegExp[]
  private readonly storeContent: boolean
  private readonly logger: ArtifactLogger
  private readonly now: () => Date
  private readonly records = new Map<string, ArtifactRecord>()
  private readonly verifiedEntries = new Set<string>()
  private readonly mountedProjects = new Set<string>()
  private loading: Promise<void> | undefined
  private loaded = false
  private dirty = false
  private closed = false
  private baseId: string | undefined
  private paperBaseId: string | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private queuedBatches = 0
  private activeBatch: { total: number; done: number; current?: string } | undefined
  private lastCompletion: ArtifactArchiveStatus['last']

  constructor(private readonly options: ArtifactArchiverOptions) {
    this.root = resolve(options.root)
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    const normalized = options.extensions
      .map(extension => normalizeExtension(String(extension)))
      .filter(extension => extension.length > 0)
    this.extensions = normalized.includes('*') ? 'all' : new Set(normalized)
    this.patterns = options.excludePatterns
      .map(pattern => pattern.trim())
      .filter(pattern => pattern.length > 0)
      .map(globToRegExp)
    this.storeContent = options.storeContent ?? false
  }

  /** Artifacts produced by one completed turn, read from its session events. */
  collectTurn(session: SessionLike, turn: number): ArtifactCandidate[] {
    return collectTurnArtifacts(session, turn)
  }

  /**
   * Queue one bounded capture pass. Passes run one at a time so concurrent
   * turns cannot create duplicate documents for the same artifact path.
   */
  ingest(candidates: readonly ArtifactCandidate[], context: ArtifactIngestContext): Promise<ArtifactIngestSummary> {
    if (this.closed) return Promise.resolve({ ...EMPTY_SUMMARY, items: [] })
    this.queuedBatches += 1
    const run = async (): Promise<ArtifactIngestSummary> => {
      this.queuedBatches = Math.max(0, this.queuedBatches - 1)
      this.activeBatch = { total: Math.min(candidates.length, MAX_CANDIDATES), done: 0 }
      try {
        const summary = await this.run(candidates, context)
        this.lastCompletion = {
          at: this.now().getTime(), captured: summary.captured, updated: summary.updated,
          unchanged: summary.unchanged, skipped: summary.skipped, failed: summary.failed,
        }
        return summary
      } finally {
        this.activeBatch = undefined
      }
    }
    const task = this.tail.then(run, run)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }

  /** Snapshot used by the management console's background activity indicator. */
  status(): ArtifactArchiveStatus {
    return {
      queued: this.queuedBatches,
      active: this.activeBatch !== undefined,
      total: this.activeBatch?.total ?? 0,
      done: this.activeBatch?.done ?? 0,
      ...this.activeBatch?.current === undefined ? {} : { current: this.activeBatch.current },
      ...this.lastCompletion === undefined ? {} : { last: this.lastCompletion },
    }
  }

  /** Resolve and start one capture pass without waiting for it. */
  schedule(candidates: readonly ArtifactCandidate[], context: ArtifactIngestContext): void {
    void this.ingest(candidates, context).catch(error => {
      this.logger.warn(`dsh-knowledge: 制品自动归档异常: ${message(error)}`)
    })
  }

  /** Archive records, most recently updated first. */
  async list(): Promise<ArtifactRecord[]> {
    await this.load()
    return [...this.records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** Read one archived copy by its stable record id. */
  async read(id: string): Promise<{ record: ArtifactRecord; bytes: Buffer } | undefined> {
    await this.load()
    const record = [...this.records.values()].find(item => item.id === id)
    if (record === undefined) return undefined
    try {
      return { record, bytes: await readFile(join(this.root, record.blob)) }
    } catch {
      return undefined
    }
  }

  /** Wait for queued passes (used by tests and shutdown). */
  async flush(): Promise<void> {
    await this.tail.catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closed = true
    await this.flush()
  }

  private async run(candidates: readonly ArtifactCandidate[], context: ArtifactIngestContext): Promise<ArtifactIngestSummary> {
    const summary: ArtifactIngestSummary = { ...EMPTY_SUMMARY, items: [] }
    if (this.closed) return summary
    await this.load()
    // Scope and mount ids must stay byte-identical to the Session header value:
    // retrieval compares them with `agent.session.header.cwd` directly.
    const projectId = context.cwd !== undefined && context.cwd.trim().length > 0 ? context.cwd.trim() : undefined
    const baseDir = projectId === undefined ? undefined : resolve(projectId)
    const seen = new Set<string>()
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      try {
        const outcome = await this.captureCandidate(candidate, context, baseDir, projectId)
        if (seen.has(outcome.key)) continue
        seen.add(outcome.key)
        summary[outcome.action === 'created' ? 'captured' : outcome.action === 'updated' ? 'updated' : outcome.action === 'unchanged' ? 'unchanged' : 'skipped'] += 1
        if (outcome.action !== 'skipped') summary.items.push(outcome.item)
      } catch (error) {
        summary.failed += 1
        this.logger.warn(`dsh-knowledge: 制品归档失败 ${candidate.path ?? candidate.upload?.name ?? 'unknown'}: ${message(error)}`)
      }
      if (this.activeBatch !== undefined) {
        this.activeBatch.done += 1
        const name = candidate.path ?? candidate.upload?.name
        if (name !== undefined) this.activeBatch.current = name
      }
    }
    if (this.dirty) await this.persist()
    if (summary.captured + summary.updated > 0) {
      this.logger.info(`dsh-knowledge: 自动归档 ${summary.captured} 个新制品，更新 ${summary.updated} 个制品`)
    }
    return summary
  }

  private async captureCandidate(
    candidate: ArtifactCandidate,
    context: ArtifactIngestContext,
    baseDir: string | undefined,
    projectId: string | undefined,
  ): Promise<CaptureOutcome> {
    if (candidate.upload !== undefined) {
      const upload = candidate.upload
      const display = uploadDisplay(upload.name)
      const key = `${UPLOAD_KEY}${upload.ref.attachmentId}`
      const skipped = (): CaptureOutcome => ({ action: 'skipped', item: { path: upload.name, display, action: 'skipped' }, key })
      if (this.options.resolveUpload === undefined) return skipped()
      const resolved = await this.options.resolveUpload(upload)
      if (resolved === undefined) return skipped()
      if (resolved.bytes.length > this.options.maxFileBytes) return skipped()
      if (this.patterns.some(pattern => pattern.test(display))) return skipped()
      return this.store({
        key,
        path: upload.name,
        display,
        bytes: resolved.bytes,
        // Uploaded files are deliberate user input: capture every extension.
        extension: normalizeExtension(resolved.name) || extensionForMediaType(resolved.mediaType),
        source: 'upload',
        ...resolved.mediaType === undefined ? {} : { mediaType: resolved.mediaType },
        ...candidate.description === undefined ? {} : { description: candidate.description },
      }, context, projectId)
    }

    const absolute = resolveCandidate(candidate.path ?? '', baseDir)
    if (absolute === undefined) {
      const display = toPosix(candidate.path ?? '')
      return { action: 'skipped', item: { path: candidate.path ?? '', display, action: 'skipped' }, key: `\u0000invalid:${display}` }
    }
    const display = this.displayPath(absolute, baseDir)
    const key = pathKey(absolute)
    const skipped = (): CaptureOutcome => ({ action: 'skipped', item: { path: absolute, display, action: 'skipped' }, key })
    if (this.isExcluded(absolute)) return skipped()
    const extension = normalizeExtension(absolute)
    // Presented deliverables are explicit artifacts: capture any format there.
    if (candidate.source === 'file-tool' && this.extensions !== 'all' && !this.extensions.has(extension)) return skipped()
    if (this.patterns.some(pattern => pattern.test(display))) return skipped()
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined || !info.isFile()) return skipped()
    if (info.size > this.options.maxFileBytes) return skipped()
    const bytes = await readFile(absolute)
    return this.store({
      key,
      path: absolute,
      display,
      bytes,
      extension,
      source: candidate.source,
      ...candidate.description === undefined ? {} : { description: candidate.description },
    }, context, projectId)
  }

  private async store(input: ArtifactInput, context: ArtifactIngestContext, projectId: string | undefined): Promise<CaptureOutcome> {
    const item = (action: ArtifactIngestAction, entryId?: string): CaptureOutcome => ({
      action,
      item: { path: input.path, display: input.display, action, ...entryId === undefined ? {} : { entryId } },
      key: input.key,
    })
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const previous = this.records.get(input.key)
    if (previous !== undefined && previous.sha256 === sha256 && previous.size === input.bytes.length) {
      if (await this.entryUsable(previous.entryId)) return item('unchanged', previous.entryId)
    }

    const blob = this.blobPath(sha256, input.extension)
    await this.writeBlob(blob, input.bytes)
    const content = extractArtifactContent(input.extension, input.bytes, this.options.maxContentChars)
    const paper = this.options.paperEnabled !== false && input.extension === 'pdf'
      ? extractPaperMetadata(content.text, input.display)
      : undefined
    const baseId = await this.ensureBase(paper !== undefined)
    const draft = this.buildDraft({ baseId, input, sha256, blob, content, ...paper === undefined ? {} : { paper }, context, projectId })
    let reuse = previous !== undefined && previous.knowledgeBaseId === baseId ? previous : undefined
    if (reuse === undefined && previous !== undefined && paper !== undefined) {
      // Migrate an earlier PDF artifact into the paper base instead of creating a
      // second document for the same path.
      try {
        await this.options.provider.moveDocument(previous.entryId, baseId)
        reuse = { ...previous, knowledgeBaseId: baseId }
      } catch (error) {
        this.logger.warn(`dsh-knowledge: 迁移论文 ${input.display} 到论文库失败: ${message(error)}`)
      }
    }
    let action: 'created' | 'updated' = 'created'
    let entry: KnowledgeEntry | undefined
    if (reuse !== undefined) {
      // Let a provider read failure abort this pass: the record and document
      // stay consistent and the next turn retries the same artifact.
      const current = await this.options.provider.get(reuse.entryId)
      if (current !== undefined && current.status === 'active' && current.documentState === 'open') {
        if (current.body === draft.body) {
          this.verifiedEntries.add(current.id)
          return item('unchanged', current.id)
        }
        entry = await this.options.provider.update(current.id, draft, undefined, current.version)
        action = 'updated'
      }
    }
    entry ??= await this.createOrRecover(draft)
    this.verifiedEntries.add(entry.id)

    const timestamp = this.now().toISOString()
    const record: ArtifactRecord = {
      id: recordId(input.key),
      path: input.path,
      display: input.display,
      sha256,
      size: input.bytes.length,
      extension: input.extension,
      mediaType: input.mediaType ?? artifactMediaType(input.extension),
      contentKind: content.kind,
      source: input.source,
      ...input.description === undefined ? {} : { description: input.description },
      sessionId: context.sessionId,
      turn: context.turn,
      archivedAt: previous?.archivedAt ?? timestamp,
      updatedAt: timestamp,
      version: (previous?.version ?? 0) + 1,
      blob,
      knowledgeBaseId: baseId,
      entryId: entry.id,
      textChars: content.text.length,
    }
    this.records.set(input.key, record)
    this.dirty = true
    await this.ensureMount(projectId, baseId)
    // Source files stay in the knowledge base and file browser, but must not
    // flood the daily report: the worklog only receives document-like artifacts.
    if (artifactCategory(record.extension) !== '代码') {
      this.notifyArchived({
        id: `${entry.id}:${record.version}`,
        title: entry.title,
        summary: `自动归档制品「${record.display}」（${record.mediaType}，${formatBytes(record.size)}）并写入知识库。`,
        ...projectId === undefined ? {} : { project: projectId },
        sessionId: context.sessionId,
        turn: context.turn,
        knowledgeBaseId: baseId,
        documentId: entry.id,
        action: action === 'updated' ? 'updated' : 'created',
        ...context.route === undefined ? {} : { route: context.route },
      })
    }
    return item(action, entry.id)
  }

  private notifyArchived(event: KnowledgeWriteEvent): void {
    if (this.options.onArchived === undefined) return
    try {
      this.options.onArchived(event)
    } catch (error) {
      this.logger.warn(`dsh-knowledge: 制品归档事件通知失败: ${message(error)}`)
    }
  }

  private async entryUsable(entryId: string): Promise<boolean> {
    if (this.verifiedEntries.has(entryId)) return true
    let entry: KnowledgeEntry | undefined
    try {
      entry = await this.options.provider.get(entryId)
    } catch {
      // A transport failure is not proof that the document disappeared. Keep
      // the existing artifact record untouched rather than risk a duplicate.
      return true
    }
    if (entry === undefined || entry.status !== 'active' || entry.documentState !== 'open') return false
    if (this.verifiedEntries.size >= 5000) this.verifiedEntries.clear()
    this.verifiedEntries.add(entryId)
    return true
  }

  private async createOrRecover(draft: KnowledgeDraft): Promise<KnowledgeEntry> {
    try {
      return await this.options.provider.create(draft)
    } catch (error) {
      if (!/unique|constraint/iu.test(message(error))) throw error
      // A previous manifest was lost: adopt the byte-equivalent document.
      const result = await this.options.provider.listDocumentIndex({
        knowledgeBaseIds: [draft.knowledgeBaseId], query: draft.title, limit: 20,
      })
      const matches = result.items.filter(item => item.knowledgeBaseId === draft.knowledgeBaseId && item.title === draft.title)
      const match = matches.length === 1 ? matches[0] : undefined
      if (match === undefined) throw error
      const current = await this.options.provider.get(match.id)
      if (current === undefined) throw error
      return await this.options.provider.update(current.id, draft, undefined, current.version)
    }
  }

  private async ensureBase(paper = false): Promise<string> {
    const name = paper ? (this.options.paperBaseName ?? '论文库') : this.options.baseName
    if (paper && name === this.options.baseName) return this.ensureBase(false)
    if (paper && this.paperBaseId !== undefined) {
      const current = await this.options.provider.getKnowledgeBase(this.paperBaseId).catch(() => undefined)
      if (current !== undefined && current.status === 'active') return this.paperBaseId
      this.paperBaseId = undefined
    }
    if (!paper && this.baseId !== undefined) {
      const current = await this.options.provider.getKnowledgeBase(this.baseId).catch(() => undefined)
      if (current !== undefined && current.status === 'active') return this.baseId
      this.baseId = undefined
    }
    const bases = await this.options.provider.listKnowledgeBases()
    const active = bases.find(base => base.name === name && base.status === 'active')
    if (active !== undefined) {
      if (paper) this.paperBaseId = active.id
      else this.baseId = active.id
      return active.id
    }
    if (bases.some(base => base.name === name)) {
      if (paper) {
        this.logger.warn(`dsh-knowledge: 论文知识库「${name}」已归档，论文继续归档到制品库`)
        return this.ensureBase(false)
      }
      throw new Error(`知识库「${name}」已归档，已停止自动归档`)
    }
    const created = await this.options.provider.createKnowledgeBase({
      name,
      description: paper
        ? '自动整理的学术论文：按论文类别分组，保存标题、摘要、关键词与年份，完整 PDF 保留在归档目录。'
        : '由 dsh-knowledge 自动归档的制品文件：交付文档、表格、演示文稿、图片与数据文件；每篇文档对应一个制品路径并保留完整版本历史。',
      defaultTags: paper ? ['论文', 'paper'] : ['制品', 'artifact'],
      extractionInstructions: '',
      writebackPolicy: 'conservative',
    })
    if (paper) this.paperBaseId = created.id
    else this.baseId = created.id
    this.logger.info(`dsh-knowledge: 已创建${paper ? '论文' : '制品'}知识库「${created.name}」`)
    return created.id
  }

  private async ensureMount(cwd: string | undefined, baseId: string): Promise<void> {
    if (!this.options.autoMount || cwd === undefined) return
    const mountKey = `${cwd}\u0000${baseId}`
    if (this.mountedProjects.has(mountKey)) return
    this.mountedProjects.add(mountKey)
    try {
      const mounts = await this.options.provider.listMounts('project', cwd)
      const existing = mounts.find(mount => mount.knowledgeBaseId === baseId)
      if (existing !== undefined) {
        if (!existing.recallEnabled || !existing.enabled) {
          this.logger.info('dsh-knowledge: 制品知识库挂载已存在但未开启召回，保留现有设置')
        }
        return
      }
      await this.options.provider.upsertMount({
        targetKind: 'project',
        targetId: cwd,
        knowledgeBaseId: baseId,
        enabled: true,
        recallEnabled: true,
        writeMode: 'none',
        includeTags: [],
        excludeTags: [],
        extractionInstructions: '',
      })
      this.logger.info(`dsh-knowledge: 已自动挂载制品知识库到项目 ${cwd}`)
    } catch (error) {
      this.mountedProjects.delete(mountKey)
      this.logger.warn(`dsh-knowledge: 自动挂载制品知识库失败: ${message(error)}`)
    }
  }

  private buildDraft(input: {
    baseId: string
    input: ArtifactInput
    sha256: string
    blob: string
    content: ArtifactContent
    paper?: PaperMetadata
    context: ArtifactIngestContext
    projectId: string | undefined
  }): KnowledgeDraft {
    const scope: KnowledgeScope = input.projectId === undefined ? { kind: 'global' } : { kind: 'project', id: input.projectId }
    const paper = input.paper
    const title = paper === undefined ? artifactTitle(input.input.display) : paperTitle(paper.title)
    const source = input.input.source
    const tags = [
      'artifact',
      'involved',
      ...(source === 'upload' ? ['upload'] : source === 'presented' ? ['deliverable'] : [source]),
      ...(input.input.extension.length > 0 ? [input.input.extension] : []),
      source,
      ...paper === undefined ? [] : ['论文', 'paper', ...paper.categories, ...paper.codes, ...(paper.year === undefined ? [] : [String(paper.year)])],
    ]
    return {
      knowledgeBaseId: input.baseId,
      group: paper === undefined ? artifactGroup(input.input.extension) : `论文 · ${paper.categories[0] ?? '综合'}`,
      title,
      body: artifactBody({
        title,
        display: input.input.display,
        blob: input.blob,
        sha256: input.sha256,
        size: input.input.bytes.length,
        mediaType: input.input.mediaType ?? artifactMediaType(input.input.extension),
        source,
        ...input.input.description === undefined ? {} : { description: input.input.description },
        extension: input.input.extension,
        content: input.content,
        ...paper === undefined ? {} : { paper },
        archivePath: join(this.root, input.blob),
        storeContent: this.storeContent,
        context: input.context,
      }),
      type: 'fact',
      tags,
      scope,
      confidence: 1,
      source: { sessionId: input.context.sessionId, turn: input.context.turn, evidence: 'verified' },
    }
  }

  private displayPath(absolute: string, cwd: string | undefined): string {
    if (cwd !== undefined) {
      const rel = relative(cwd, absolute)
      if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel)
    }
    return toPosix(absolute)
  }

  private isExcluded(absolute: string): boolean {
    const root = pathKey(this.root)
    const key = pathKey(absolute)
    if (key === root) return true
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`
    return key.startsWith(prefix)
  }

  private blobPath(sha256: string, extension: string): string {
    return `blobs/${sha256.slice(0, 2)}/${sha256}${extension.length > 0 ? `.${extension}` : ''}`
  }

  private async writeBlob(relativePath: string, bytes: Buffer): Promise<void> {
    const target = join(this.root, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await atomicWriteFile(target, bytes, { mode: 0o600 })
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loading ??= this.readManifest()
    await this.loading
  }

  private async readManifest(): Promise<void> {
    this.loaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.root, MANIFEST_FILE), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return
      const artifacts = (parsed as { artifacts?: unknown }).artifacts
      if (typeof artifacts !== 'object' || artifacts === null) return
      for (const [key, value] of Object.entries(artifacts as Record<string, unknown>)) {
        if (isRecord(value)) this.records.set(key, value)
      }
    } catch (error) {
      if (!isMissingFile(error)) this.logger.warn(`dsh-knowledge: 制品归档索引不可读，将从空索引开始: ${message(error)}`)
    }
  }

  private async persist(): Promise<void> {
    this.prune()
    const manifest: Manifest = { version: 1, artifacts: Object.fromEntries([...this.records.entries()].sort(([left], [right]) => left.localeCompare(right))) }
    await mkdir(this.root, { recursive: true })
    await atomicWriteFile(join(this.root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    this.dirty = false
  }

  private prune(): void {
    const limit = Math.max(1, Math.trunc(this.options.maxEntries))
    if (this.records.size <= limit) return
    const ordered = [...this.records.entries()].sort(([, left], [, right]) => left.updatedAt.localeCompare(right.updatedAt))
    for (const [key] of ordered.slice(0, this.records.size - limit)) this.records.delete(key)
  }
}

function resolveCandidate(value: string, baseDir: string | undefined): string | undefined {
  if (value.length === 0 || value.length > 1000) return undefined
  if (/^[a-z]+:/iu.test(value) && !/^[a-z]:[\\/]/iu.test(value)) return undefined
  try {
    return isAbsolute(value) ? resolve(value) : resolve(baseDir ?? process.cwd(), value)
  } catch {
    return undefined
  }
}

function pathKey(absolute: string): string {
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function recordId(key: string): string {
  return createHash('sha256').update(`dsh-knowledge:artifact:${key}`).digest('hex').slice(0, 32)
}

function uploadDisplay(name: string): string {
  return `用户上传/${name}`
}

function artifactTitle(display: string): string {
  const prefix = '制品 · '
  const max = 200 - prefix.length
  return display.length <= max ? `${prefix}${display}` : `${prefix}…${display.slice(-(max - 1))}`
}

/** Group artifact documents by their file category so one base stays browsable. */
export function artifactGroup(extension: string): string {
  return `制品 · ${artifactCategory(extension)}`.slice(0, 64)
}

function paperTitle(title: string): string {
  const prefix = '论文 · '
  const max = 200 - prefix.length
  const value = title.replace(/\s+/gu, ' ').trim() || '未命名论文'
  return value.length <= max ? `${prefix}${value}` : `${prefix}${value.slice(0, max - 1)}…`
}

function artifactBody(input: {
  title: string
  display: string
  blob: string
  archivePath: string
  sha256: string
  size: number
  mediaType: string
  source: ArtifactCandidate['source']
  description?: string
  extension: string
  content: ArtifactContent
  paper?: PaperMetadata
  storeContent: boolean
  context: ArtifactIngestContext
}): string {
  const paper = input.paper
  const extracted = paper === undefined ? extractArtifactKeywords(`${input.display}\n${input.content.text}`, 12) : []
  const keywords = [...new Set([...(paper?.keywords ?? []), ...extracted])].slice(0, 20)
  const lines = [
    `# ${input.title}`,
    '',
    `- 源文件：\`${input.display}\``,
    `- 归档副本：\`${input.blob}\``,
    `- 文件路径：\`${input.archivePath}\``,
    `- 大小：${formatBytes(input.size)}`,
    `- 类型：${input.mediaType}`,
    `- SHA-256：\`${input.sha256}\``,
    `- 来源：${sourceLabel(input.source)}`,
    `- 会话：\`${input.context.sessionId}\` · 第 ${input.context.turn} 轮`,
    ...paper === undefined ? [] : [
      `- 论文分类：${paper.categories.join(' / ')}`,
      ...paper.year === undefined ? [] : [`- 年份：${paper.year}`],
      ...paper.arxivId === undefined ? [] : [`- arXiv：\`${paper.arxivId}\``],
      ...paper.doi === undefined ? [] : [`- DOI：\`${paper.doi}\``],
    ],
    `- 关键词：${keywords.length > 0 ? keywords.join('、') : '无'}`,
    ...input.description === undefined ? [] : [`- 说明：${oneLine(input.description)}`],
    '',
    '> 数据库保存文件链接、元数据、摘要与关键词；完整内容保存在归档目录中的文件里。',
    '',
  ]
  if (paper?.abstract) {
    lines.push('## 摘要', '', paper.abstract, '')
  }
  lines.push(
    '## 使用',
    '',
    `使用 read 工具读取 \`${input.archivePath}\` 获取完整内容。`,
  )
  if (input.storeContent) {
    lines.push('', '## 内容')
    if (input.content.text.length > 0) {
      lines.push('', input.content.text)
      if (input.content.truncated) lines.push('', '> 内容超长已截断，完整内容见归档副本。')
    } else if (input.content.note !== undefined) {
      lines.push('', `> ${oneLine(input.content.note)}`)
    } else if (input.content.kind === 'image') {
      lines.push('', `> 图片制品已归档（${input.mediaType}）；知识库保留元数据，原始像素见归档副本。`)
    } else {
      lines.push('', '> 二进制制品已归档；知识库保留元数据，原始字节见归档副本。')
    }
  }
  const body = lines.join('\n')
  return body.length <= MAX_BODY_CHARS ? body : `${body.slice(0, MAX_BODY_CHARS)}\n\n…（已截断）`
}

const KEYWORD_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'had',
  'not', 'you', 'your', 'can', 'will', 'would', 'should', 'could', 'but', 'all', 'any', 'our', 'their',
  'they', 'them', 'then', 'than', 'into', 'out', 'its', 'it', 'is', 'to', 'of', 'in', 'on', 'at', 'as', 'by',
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '可以', '需要', '进行', '以及', '或者', '如果',
  '因为', '所以', '但是', '并且', '通过', '对于', '关于', '一个', '没有', '已经', '还是', '就是', '不是',
  '文件', '内容', '数据', '文档', '相关', '使用', '支持', '自动',
])

/** Bounded term-frequency keywords used for indexing and cross-format links. */
export function extractArtifactKeywords(text: string, limit = 12): string[] {
  const counts = new Map<string, number>()
  const add = (term: string): void => {
    if (term.length < 2 || term.length > 40 || KEYWORD_STOPWORDS.has(term) || /^\d+$/u.test(term)) return
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  const source = text.length > 200_000 ? text.slice(0, 200_000) : text
  for (const match of source.toLocaleLowerCase().matchAll(/[a-z][a-z0-9_+-]{2,}/gu)) add(match[0])
  for (const match of source.matchAll(/[\u4e00-\u9fff]{2,}/gu)) {
    const run = match[0]
    for (let index = 0; index + 1 < run.length; index += 1) add(run.slice(index, index + 2))
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([term]) => term)
}

function sourceLabel(source: ArtifactCandidate['source']): string {
  if (source === 'presented') return 'present（制品声明）'
  if (source === 'upload') return '用户上传附件'
  if (source === 'reference') return '任务中读取或引用的文件'
  if (source === 'workspace-change') return '任务中变更的文件'
  return '文件工具写入'
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 300)
}

function toPosix(value: string): string {
  return value.replace(/\\/gu, '/')
}

function isRecord(value: unknown): value is ArtifactRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.path === 'string'
    && typeof record.display === 'string'
    && typeof record.sha256 === 'string'
    && typeof record.blob === 'string'
    && typeof record.entryId === 'string'
    && typeof record.knowledgeBaseId === 'string'
    && typeof record.updatedAt === 'string'
    && typeof record.version === 'number'
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Convert the small glob dialect used by configuration into a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = toPosix(pattern.trim())
  let source = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        index += 1
        if (normalized[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
    }
  }
  return new RegExp(`^${source}$`, 'iu')
}
