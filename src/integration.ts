import { DEFAULT_KNOWLEDGE_BASE_ID, type KnowledgeBase, type KnowledgeDraft, type KnowledgeEntry, type KnowledgeScope, type SearchHit, type SearchRequest } from './domain.js'
import type { ArtifactIngestSummary } from './artifacts/archive.js'
import type { ArtifactArchiver } from './artifacts/archive.js'
import type { KnowledgeWriteEvent } from './knowledge-events.js'
import type { KnowledgeProvider } from './provider.js'
import type { RuntimeContextLike } from './runtime.js'

export const KNOWLEDGE_INTEGRATION_SERVICE = 'dshKnowledge'
export const KNOWLEDGE_WRITE_EVENT = 'knowledge/write'

export interface KnowledgeWriteBus {
  emit(event: KnowledgeWriteEvent): void
  on(listener: (event: KnowledgeWriteEvent) => void): () => void
}

/** Host event bridge: future meeting/memory plugins can subscribe without a hard dependency. */
export function createKnowledgeWriteBus(ctx: RuntimeContextLike): KnowledgeWriteBus {
  const listeners = new Set<(event: KnowledgeWriteEvent) => void>()
  return {
    emit(event) {
      for (const listener of listeners) {
        try { listener(event) } catch { /* subscriber failures must not affect archiving */ }
      }
      try { ctx.emit?.(KNOWLEDGE_WRITE_EVENT, event) } catch { /* optional event bridge */ }
    },
    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export interface KnowledgeIntegrationRecord {
  title: string
  body: string
  tags?: string[]
  group?: string
  type?: KnowledgeDraft['type']
  knowledgeBaseId?: string
  projectId?: string
  scope?: KnowledgeScope
}

export interface KnowledgeIntegrationOptions {
  provider: KnowledgeProvider
  archive?: ArtifactArchiver
  bus: KnowledgeWriteBus
}

/**
 * Stable Cordis service for other plugins (meetings, memory, importers).
 * Every record created through it emits the same `knowledge/write` event as
 * archive/extraction writes, so subscribers see one consistent stream.
 */
export function createKnowledgeIntegration(options: KnowledgeIntegrationOptions) {
  const { provider, archive, bus } = options
  return {
    async ingestFiles(paths: readonly string[], input: { projectId?: string; sessionId?: string; source?: 'folder' | 'reference' } = {}): Promise<ArtifactIngestSummary> {
      if (archive === undefined) throw new Error('artifact archiving is disabled')
      const files = paths.map(path => String(path).trim()).filter(Boolean)
      if (files.length === 0) return { captured: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, items: [] }
      return archive.ingest(files.map(path => ({
        path,
        source: input.source ?? 'reference',
      })), {
        sessionId: input.sessionId ?? 'integration',
        ...input.projectId === undefined ? {} : { cwd: input.projectId },
        turn: 0,
      })
    },
    async ingestRecord(input: KnowledgeIntegrationRecord): Promise<KnowledgeEntry> {
      const title = input.title.trim().slice(0, 200)
      const body = input.body.trim()
      if (title.length === 0 || body.length === 0) throw new Error('title and body are required')
      const knowledgeBaseId = input.knowledgeBaseId ?? DEFAULT_KNOWLEDGE_BASE_ID
      const base = (await provider.listKnowledgeBases()).find(item => item.id === knowledgeBaseId && item.status === 'active')
      if (base === undefined) throw new Error('target knowledge base is unavailable')
      const entry = await provider.create({
        knowledgeBaseId,
        group: input.group?.trim() || '外部插件',
        title,
        body,
        type: input.type ?? 'fact',
        tags: [...new Set([...(input.tags ?? []).map(tag => tag.trim()).filter(Boolean), 'integration'])].slice(0, 32),
        scope: input.scope ?? (input.projectId === undefined ? { kind: 'global' } : { kind: 'project', id: input.projectId }),
        confidence: 1,
        source: { evidence: 'verified' },
      })
      bus.emit({
        id: `${entry.id}:${entry.version}`,
        title: entry.title,
        summary: `外部插件写入知识库「${base.name}」：${entry.title}`,
        ...entry.scope.kind === 'project' ? { project: entry.scope.id } : {},
        knowledgeBaseId: base.id,
        documentId: entry.id,
        action: 'created',
      })
      return entry
    },
    async search(request: SearchRequest): Promise<SearchHit[]> {
      return provider.search(request)
    },
    async listBases(): Promise<KnowledgeBase[]> {
      return (await provider.listKnowledgeBases()).filter(base => base.status === 'active')
    },
    async introduceBase(sessionId: string, knowledgeBaseId: string): Promise<{ base: KnowledgeBase; mountId: string }> {
      const base = (await provider.listKnowledgeBases()).find(item => item.id === knowledgeBaseId && item.status === 'active')
      if (base === undefined) throw new Error('knowledge base is unavailable')
      const existing = await provider.listMounts('session', sessionId)
      const mount = existing.find(item => item.knowledgeBaseId === knowledgeBaseId)
      if (mount !== undefined && mount.enabled && mount.recallEnabled) return { base, mountId: mount.id }
      const created = await provider.upsertMount({
        targetKind: 'session',
        targetId: sessionId,
        knowledgeBaseId,
        enabled: true,
        recallEnabled: true,
        writeMode: 'none',
        includeTags: [],
        excludeTags: [],
        extractionInstructions: '',
      })
      return { base, mountId: created.id }
    },
    /** Subscribe to writes from archives, conversation extraction and other plugins. */
    onWrite(listener: (event: KnowledgeWriteEvent) => void): () => void {
      return bus.on(listener)
    },
  }
}

export type KnowledgeIntegrationService = ReturnType<typeof createKnowledgeIntegration>
