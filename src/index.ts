import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { apply as registerWorklog, type JournalRuntime } from './worklog-runtime.js'
import { ArtifactArchiver, globToRegExp, type ArtifactIngestItem } from './artifacts/archive.js'
import { scanFolder } from './artifacts/folder-import.js'
import { lastAssistantRoute } from './artifacts/collect.js'
import { createUploadReader } from './artifacts/uploads.js'
import { createKnowledgeWatcher } from './knowledge-watcher.js'
import { createKnowledgeIntegration, createKnowledgeWriteBus, KNOWLEDGE_INTEGRATION_SERVICE } from './integration.js'
import { migrateLegacyKnowledgeStore } from './migrate-knowledge-store.js'
import { createWritableMountGuard } from './auto-writable.js'
import { createPendingAutoApprover } from './auto-approve.js'
import { assertKnowledgeBrowserRequest, LOCAL_MANAGEMENT_API_PREFIX, registerKnowledgeApi } from './api.js'
import { registerKnowledgeActivityControl } from './activity-control.js'
import { registerBackgroundStatusControl } from './background-status.js'
import { registerWritebackControl } from './writeback/control.js'
import { registerWritebackLive } from './writeback/live-control.js'
import {
  connectionSettingsBase,
  createConnectionProvider,
  loadStoredConnection,
  sameConnection,
  storeConnection,
  validateConnectionSettings,
  type KnowledgeConnectionSettings,
} from './connection.js'
import { Config as ConfigSchema, resolveConfig, type Config as KnowledgeConfig } from './config.js'
import { registerKnowledgeControl, type KnowledgeConnectionUpdate } from './control.js'
import { ExtractionCoordinator } from './extraction.js'
import type { ExtractionJobRecord } from './domain.js'
import { LocalKnowledgeProvider } from './local-provider.js'
import { registerRemoteManagementProxy } from './management-proxy.js'
import type { KnowledgeProvider } from './provider.js'
import { KnowledgeProviderRouter } from './provider-router.js'
import { registerKnowledgeCatalog, registerKnowledgeRecall } from './recall.js'
import { KnowledgeHandleCodec } from './retrieval.js'
import { KnowledgeNoteHandleCodec } from './note-reference-handle.js'
import { RemoteKnowledgeProvider, RemoteProviderError } from './remote-provider.js'
import type { RuntimeContextLike, SessionLike } from './runtime.js'
import type { ArtifactCandidate } from './artifacts/collect.js'
import { loadServiceSettings, serviceSettingsPath, storeServiceSettings, type KnowledgeServiceSettings } from './service-settings.js'
import { registerKnowledgeTools } from './tools.js'
import { createKnowledgeTrackingService, KNOWLEDGE_TRACKING_SERVICE } from './tracking.js'
import { createKnowledgeMountManagement, KNOWLEDGE_MOUNT_MANAGEMENT_SERVICE } from './mount-management.js'
import { createNoteRecording } from './note-recording.js'
import { registerKnowledgeWeb } from './web.js'
import { WritebackQueue, WritebackDeferred, type WritebackStatus, type WritebackWork } from './writeback/queue.js'
import { NoteAutoOrganizer } from './notes/auto-organizer.js'
import { NoteProposalStore } from './notes/proposal-store.js'
import { extractPdfText } from './pdf-parser.js'

export const Config = ConfigSchema
export type Config = KnowledgeConfig
export * from './domain.js'
export * from './provider.js'
export * from './notes/domain.js'
export * from './notes/mindmap-domain.js'
export { extractPdfText } from './pdf-parser.js'
export { ArtifactArchiver } from './artifacts/archive.js'
export type { ArtifactRecord, ArtifactIngestSummary } from './artifacts/archive.js'
export { artifactMediaType, extractArtifactContent } from './artifacts/text.js'
export { NoteAutoOrganizer } from './notes/auto-organizer.js'
export { NoteProposalStore } from './notes/proposal-store.js'
export { LocalKnowledgeProvider } from './local-provider.js'
export { RemoteKnowledgeProvider, RemoteProviderError } from './remote-provider.js'

/** Human-readable Cordis plugin name. */
export const name = 'dsh-knowledge'

/** Extraction and native retrieval tools require the corresponding DSH host services. */
export const inject = ['llm', 'tools']

/** Mount storage, hybrid retrieval, extraction, and the optional authenticated HTTP API. */
interface FolderImportJob {
  id: string
  root: string
  status: 'running' | 'done' | 'failed'
  accepted: number
  processed: number
  startedAt: string
  finishedAt?: string
  error?: string
  truncated: boolean
  skippedByScan: number
  counts: { created: number; updated: number; unchanged: number; skipped: number; failed: number }
  items: ArtifactIngestItem[]
}

export function apply(ctx: Context, config: KnowledgeConfig): void {
  const runtime = ctx as unknown as RuntimeContextLike
  const resolved = resolveConfig(config)
  const trustedShareOrigins = [...resolved.trustedShareOrigins]
  const trust = runtime.get('remoteSettingsTrust') as { origins?: readonly string[]; subscribe?(listener: () => void): () => void } | undefined
  if (trust !== undefined) {
    const sync = (): void => {
      const merged = new Set([...resolved.trustedShareOrigins, ...(trust.origins ?? [])])
      trustedShareOrigins.splice(0, trustedShareOrigins.length, ...merged)
    }
    sync()
    if (typeof trust.subscribe === 'function') runtime.effect(() => trust.subscribe!(sync), 'dsh-knowledge: trusted share origin synchronization')
  }
  // rc.2 projects settings from Loader entries; no synthetic namespace is needed.
  // Keep the native generated form hidden because the plugin owns its connection UI.
  runtime.inject?.(['settings'], settingsRuntime => {
    settingsRuntime.effect(() => settingsRuntime.settings!.configure({ auto: false }, ctx.fiber))
  })
  if ((config.databasePath ?? '').trim().length === 0 && resolved.backend === 'local'
    && resolved.databasePath !== undefined && resolved.databasePath !== ':memory:') {
    const legacyRoot = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'knowledge')
    migrateLegacyKnowledgeStore(legacyRoot, dirname(resolved.databasePath), runtime.logger)
  }
  const persistedServicePath = serviceSettingsPath(resolved.connectionPath)
  let publicApiEnabled = resolved.exposeApi
  let clientSettings: KnowledgeServiceSettings = { publicApiEnabled }
  try {
    const storedService = loadServiceSettings(persistedServicePath)
    if (storedService !== undefined) { clientSettings = storedService; publicApiEnabled = storedService.publicApiEnabled }
  } catch (error) {
    runtime.logger.warn(`dsh-knowledge: ignored invalid service settings: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (resolved.backend === 'remote') { publicApiEnabled = false; clientSettings = { ...clientSettings, publicApiEnabled: false } }
  const baseConnection = connectionSettingsBase(resolved)
  let initialConnection = baseConnection
  try {
    const stored = loadStoredConnection(resolved.connectionPath)
    if (stored !== undefined) {
      validateConnectionSettings(stored, publicApiEnabled, resolved.databasePath !== undefined && resolved.databasePath.trim().length > 0)
      initialConnection = stored
    }
  } catch (error) {
    runtime.logger.warn(`dsh-knowledge: ignored invalid stored connection: ${error instanceof Error ? error.message : String(error)}`)
  }
  const managementProvider = resolved.databasePath === undefined || resolved.databasePath.trim().length === 0
    ? undefined
    : new LocalKnowledgeProvider(resolved.databasePath)
  const connectionProvider = (settings: KnowledgeConnectionSettings): { provider: KnowledgeProvider; owned: boolean } => {
    if (settings.backend === 'local' && managementProvider !== undefined) {
      return { provider: managementProvider, owned: false }
    }
    return { provider: createConnectionProvider(resolved, settings, publicApiEnabled), owned: true }
  }
  const initial = connectionProvider(initialConnection)
  const providerRouter = new KnowledgeProviderRouter(initial.provider, { owned: initial.owned })
  const provider: KnowledgeProvider = providerRouter.provider
  let activeConnection = initialConnection
  let connectionChanging = false
  let journalRuntime: JournalRuntime | undefined
  const writeBus = createKnowledgeWriteBus(runtime)
  ctx.inject?.(['connection'], journal => {
    const connection = journal.get('connection') as { requestRejection?: unknown } | undefined
    if (typeof connection?.requestRejection !== 'function') return
    const base = resolved.databasePath || resolved.connectionPath
    if (!base) return
    const legacy = join(dirname(dirname(base)), 'worklog', 'worklog.sqlite')
    const databasePath = base === ':memory:' ? ':memory:' : existsSync(legacy) ? legacy : `${base}.worklog.sqlite`
    journalRuntime = registerWorklog(journal, {
      databasePath,
      current: () => ({ ...activeConnection, paused: connectionChanging }),
      autoUpdate: {
        trigger: resolved.worklogAutoUpdateTrigger,
        intervalMinutes: resolved.worklogAutoUpdateIntervalMinutes,
      },
      onDispose: () => { journalRuntime = undefined },
    })
  })
  const journalDispatch = (method: string, path: string, data: Record<string, unknown>, query: URLSearchParams): Promise<unknown> => {
    if (!journalRuntime) throw connectionError(503, '中央日报服务尚未就绪')
    return journalRuntime.dispatch(method, path, data, query)
  }
  const knowledgeWatcher = resolved.worklogAutoUpdateEnabled && provider.mode === 'local' ? createKnowledgeWatcher({
    provider,
    emit: event => {
      writeBus.emit(event)
      journalRuntime?.recordKnowledge(event)
    },
    logger: runtime.logger,
  }) : undefined
  if (knowledgeWatcher) {
    knowledgeWatcher.start()
    runtime.effect(() => () => knowledgeWatcher.stop(), 'dsh-knowledge.knowledge-watcher')
  }

  const coordinator = new ExtractionCoordinator(runtime, provider, resolved, () => (
    clientSettings.writebackProvider && clientSettings.writebackModel
      ? { provider: clientSettings.writebackProvider, model: clientSettings.writebackModel }
      : undefined
  ), event => {
    writeBus.emit(event)
    if (resolved.worklogAutoUpdateEnabled) journalRuntime?.recordKnowledge(event)
  })
  const writebackStatuses = new Map<string, WritebackStatus>()
  const writebackSources = new Map<string, WritebackWork>()
  const destination = (): string => activeConnection.backend === 'local' ? `local:${resolved.databasePath}` : `remote:${activeConnection.remoteUrl}`
  const writebackQueue = resolved.extractionEnabled ? new WritebackQueue(resolved.writebackQueuePath!, async (work, checkpoint, signal) => {
    if (connectionChanging) throw new WritebackDeferred('知识库连接正在切换，等待稳定后回写')
    if (work.destination !== destination()) throw new Error('知识库连接已切换，旧回写仍绑定原目标；请恢复原连接后重试')
    const existing = await provider.extractionJob(work.snapshot.sourceKey, signal)
    if (existing?.status === 'completed') return statusFromExtractionJob(existing, false)
    if (existing?.status === 'failed' && existing.attempts >= 3) await provider.resetExtraction(work.snapshot.sourceKey, signal)
    const result = await coordinator.runSnapshot(work.snapshot, signal, checkpoint)
    if (result.status !== 'duplicate') return statusFromExtractionResult(result)
    const job = await provider.extractionJob(work.snapshot.sourceKey, signal)
    if (job?.status === 'completed') return statusFromExtractionJob(job, false)
    if (job?.status === 'running') throw new WritebackDeferred('上一次远端回写租约尚未释放，等待恢复')
    throw new Error(job?.lastError ?? '未能确认远端回写状态，请重试')
  }, message => runtime.logger.warn(message)) : undefined
  const pendingOrganize: WritebackWork[] = []
  const flushOrganize = (): void => {
    if (writebackQueue === undefined) return
    for (const work of pendingOrganize.splice(0)) {
      try { writebackQueue.enqueue(work) } catch (error) {
        runtime.logger.warn(`dsh-knowledge: 定时知识整理入队失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const queueOrganize = (work: WritebackWork, key: string): void => {
    if (resolved.autoOrganizeTrigger === 'interval') {
      pendingOrganize.push(work)
      if (pendingOrganize.length > 200) {
        pendingOrganize.shift()
        runtime.logger.warn('dsh-knowledge: 待整理快照超过 200 条，已丢弃最旧的一条')
      }
      return
    }
    writebackQueue?.enqueue(work)
    writebackStatuses.delete(key)
    writebackSources.delete(key)
  }
  const handleCodec = new KnowledgeHandleCodec(randomBytes(32))
  const noteHandleCodec = new KnowledgeNoteHandleCodec(randomBytes(32))
  const managementEmbedToken = randomBytes(32).toString('base64url')
  const artifactArchiver = resolved.artifactArchiveEnabled ? new ArtifactArchiver({
    root: resolved.artifactArchivePath ?? join(
      dirname(resolved.databasePath ?? resolved.connectionPath ?? join(homedir(), '.dsh', 'knowledge', 'knowledge.sqlite')),
      'artifacts',
    ),
    provider,
    baseName: resolved.artifactArchiveBaseName,
    extensions: resolved.artifactArchiveExtensions,
    excludePatterns: resolved.artifactArchiveExclude,
    maxFileBytes: resolved.artifactArchiveMaxFileBytes,
    maxContentChars: resolved.artifactArchiveMaxChars,
    storeContent: resolved.artifactArchiveStoreContent,
    paperEnabled: resolved.artifactArchivePaperEnabled,
    paperBaseName: resolved.artifactArchivePaperBaseName,
    maxEntries: resolved.artifactArchiveMaxEntries,
    autoMount: resolved.artifactArchiveAutoMount,
    resolveUpload: createUploadReader({
      get: name => runtime.get(name),
      maxBytes: resolved.artifactArchiveMaxFileBytes,
      logger: runtime.logger,
    }),
    onArchived: event => {
      writeBus.emit(event)
      if (resolved.worklogAutoUpdateEnabled) journalRuntime?.recordKnowledge(event)
    },
    logger: runtime.logger,
  }) : undefined
  const pendingAutoApprover = resolved.autoApprovePendingEnabled ? createPendingAutoApprover({
    provider,
    logger: runtime.logger,
    intervalMinutes: resolved.autoApprovePendingIntervalMinutes,
  }) : undefined
  if (pendingAutoApprover) {
    pendingAutoApprover.start()
    runtime.on('agent/turn-stopping', () => { void pendingAutoApprover.run() })
    runtime.effect(() => () => pendingAutoApprover.stop(), 'dsh-knowledge.pending-auto-approve')
  }
  const writableMountGuard = resolved.autoWritableMountEnabled ? createWritableMountGuard(provider, {
    mode: resolved.autoWritableMountWriteMode,
    logger: runtime.logger,
    revision: () => providerRouter.revision,
  }) : undefined
  if (writableMountGuard) {
    const ensureWritable = writableMountGuard
    runtime.on('agent/pre-step', async (payload, next) => {
      try {
        await ensureWritable(payload.agent)
      } catch (error) {
        runtime.logger.warn(`dsh-knowledge: 自动挂载可写知识库失败: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })
    runtime.on('agent/turn-stopping', ({ agent }) => {
      void ensureWritable(agent).catch(error => {
        runtime.logger.warn(`dsh-knowledge: 自动挂载可写知识库失败: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
  }
  registerKnowledgeRecall(runtime, provider, resolved, handleCodec)
  registerKnowledgeCatalog(runtime, provider, resolved)
  registerKnowledgeTools(runtime, provider, handleCodec, noteHandleCodec)
  runtime.provide?.(KNOWLEDGE_TRACKING_SERVICE, createKnowledgeTrackingService(provider))
  runtime.provide?.(KNOWLEDGE_MOUNT_MANAGEMENT_SERVICE, createKnowledgeMountManagement(provider, () => providerRouter.revision))
  runtime.provide?.('dshKnowledgeNoteRecording', createNoteRecording(provider))
  runtime.provide?.(KNOWLEDGE_INTEGRATION_SERVICE, createKnowledgeIntegration({
    provider,
    ...artifactArchiver === undefined ? {} : { archive: artifactArchiver },
    bus: writeBus,
  }))

  const autoOrganizer = managementProvider !== undefined ? new NoteAutoOrganizer(
    runtime,
    resolved,
    managementProvider.notes,
    managementProvider.proposalStore,
    () => (
      clientSettings.writebackProvider && clientSettings.writebackModel
        ? { provider: clientSettings.writebackProvider, model: clientSettings.writebackModel }
        : undefined
    ),
  ) : undefined

  let refreshManagementApi = (): void => {}
  let switching: Promise<unknown> = Promise.resolve()
  const updateConnection = (input: KnowledgeConnectionUpdate): Promise<KnowledgeConnectionSettings> => {
    const pending = switching.then(async () => {
      const next: KnowledgeConnectionSettings = {
        backend: input.backend,
        remoteTimeoutMs: input.remoteTimeoutMs,
        ...input.remoteUrl !== undefined ? { remoteUrl: input.remoteUrl } : activeConnection.remoteUrl !== undefined ? { remoteUrl: activeConnection.remoteUrl } : {},
        ...input.remoteToken !== undefined ? { remoteToken: input.remoteToken } : activeConnection.remoteToken !== undefined ? { remoteToken: activeConnection.remoteToken } : {},
      }
      validateConnectionSettings(next, publicApiEnabled, resolved.databasePath !== undefined && resolved.databasePath.trim().length > 0)
      if (sameConnection(next, activeConnection)) return activeConnection
      if (writebackQueue?.isRunning) throw connectionError(409, '回写正在执行，请完成后再切换知识库连接')
      if (journalRuntime?.isRunning()) throw connectionError(409, '日报正在整理，请完成或取消后再切换知识库连接')
      if (resolved.connectionPath === undefined) throw connectionError(409, '当前插件没有配置持久化路径，无法保存连接。')
      const candidate = connectionProvider(next)
      connectionChanging = true
      let persisted = false
      let installed = false
      let managementRouteChanged = false
      const previous = activeConnection
      const restoreManagementApi = (): void => {
        activeConnection = previous
        try { refreshManagementApi() } catch (rollbackError) {
          runtime.logger.error(`dsh-knowledge: failed to restore management API route: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
      try {
        if (next.backend === 'remote') await candidate.provider.stats()
        await storeConnection(resolved.connectionPath, next)
        persisted = true
        activeConnection = next
        try {
          refreshManagementApi()
          managementRouteChanged = true
        } catch (error) {
          restoreManagementApi()
          throw error
        }
        await providerRouter.replace(candidate.provider, { owned: candidate.owned })
        handleCodec.clear()
        installed = true
        runtime.logger.info(`dsh-knowledge: verified and switched to ${next.backend} provider`)
        return activeConnection
      } catch (error) {
        if (installed) return next
        if (candidate.owned) await candidate.provider.close().catch(() => {})
        activeConnection = previous
        if (managementRouteChanged) restoreManagementApi()
        if (persisted) {
          await storeConnection(resolved.connectionPath, previous).catch(rollbackError => {
            runtime.logger.error(`dsh-knowledge: failed to restore connection settings: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
          })
        }
        throw error
      } finally { connectionChanging = false }
    })
    const operation = pending.catch(error => {
      runtime.logger.warn(`dsh-knowledge: connection switch rejected: ${error instanceof Error ? error.message : String(error)}`)
      throw publicConnectionError(error)
    })
    switching = operation.catch(() => {})
    return operation
  }

  const registerHttpSurfaces = (httpRuntime: RuntimeContextLike): void => {
    const disposeActivityControl = registerKnowledgeActivityControl(httpRuntime, provider, {
      codec: noteHandleCodec,
      sourceKey: () => createHash('sha256').update(destination()).digest('hex'),
    })
    httpRuntime.effect(() => disposeActivityControl, 'dsh-knowledge.activity-control')
    const disposeBackgroundStatus = registerBackgroundStatusControl(httpRuntime, {
      archive: () => artifactArchiver?.status() ?? { queued: 0, active: false, total: 0, done: 0 },
      writeback: () => writebackQueue?.counts() ?? { queued: 0, running: 0, failed: 0 },
      worklog: () => journalRuntime?.isRunning() ?? false,
      enabled: () => ({
        archive: artifactArchiver !== undefined,
        writeback: writebackQueue !== undefined,
        worklog: resolved.worklogAutoUpdateEnabled,
        approvals: resolved.autoApprovePendingEnabled,
      }),
    })
    httpRuntime.effect(() => disposeBackgroundStatus, 'dsh-knowledge.background-status')
    let disposePublicApi: (() => void) | undefined
    const publicApiView = () => ({
      publicApiEnabled,
      publicApiPrefix: resolved.apiPrefix,
      ...clientSettings.writebackProvider && clientSettings.writebackModel
        ? { writebackProvider: clientSettings.writebackProvider, writebackModel: clientSettings.writebackModel }
        : {},
    })
    const applyPublicApiRoute = (enabled: boolean): void => {
      disposePublicApi?.()
      disposePublicApi = undefined
      if (enabled) {
        if (managementProvider === undefined) throw connectionError(409, '当前 DSH 没有可供远程访问的本地知识库。')
        disposePublicApi = registerKnowledgeApi(httpRuntime, managementProvider, resolved.apiPrefix, {
          worklog: journalDispatch,
          shareRequestPolicy: () => ({ trustedPrivateOrigins: trustedShareOrigins }),
        })
      }
    }
    const updateClientSettings = async (patch: { publicApiEnabled?: boolean; writebackProvider?: string | null; writebackModel?: string | null }): Promise<ReturnType<typeof publicApiView>> => {
      const enabled = patch.publicApiEnabled ?? publicApiEnabled
      if (enabled && activeConnection.backend !== 'local') throw connectionError(409, '请先把知识库来源切换为本地，再开启远程 API。')
      if (persistedServicePath === undefined) throw connectionError(409, '当前插件没有配置持久化路径，无法保存远程 API 状态。')
      const clearRoute = patch.writebackProvider === null || patch.writebackModel === null
      const provider = typeof patch.writebackProvider === 'string' ? patch.writebackProvider.trim() : clientSettings.writebackProvider
      const model = typeof patch.writebackModel === 'string' ? patch.writebackModel.trim() : clientSettings.writebackModel
      if (!clearRoute && ((provider === undefined) !== (model === undefined))) throw connectionError(400, '本机回写模型需要同时选择提供方和模型。')
      if (!clearRoute && provider && model) {
        try { await runtime.llm.resolveModelInfo(provider, model) }
        catch (error) { throw connectionError(400, `当前客户端无法使用 ${provider} / ${model}：${error instanceof Error ? error.message : String(error)}`) }
      }
      const previous = clientSettings
      const next: KnowledgeServiceSettings = {
        publicApiEnabled: enabled,
        ...!clearRoute && provider && model ? { writebackProvider: provider, writebackModel: model } : {},
      }
      if (enabled !== publicApiEnabled) applyPublicApiRoute(enabled)
      publicApiEnabled = enabled
      clientSettings = next
      try {
        await storeServiceSettings(persistedServicePath, next)
      } catch (error) {
        clientSettings = previous
        if (publicApiEnabled !== previous.publicApiEnabled) applyPublicApiRoute(previous.publicApiEnabled)
        publicApiEnabled = previous.publicApiEnabled
        throw error
      }
      return publicApiView()
    }

    if (resolved.exposeApi && managementProvider !== undefined && resolved.apiToken !== undefined) {
      managementProvider.ensureBootstrapToken(resolved.apiToken)
    }

    let disposeManagementApi: (() => void) | undefined
    const applyManagementApiRoute = (): void => {
      disposeManagementApi?.()
      disposeManagementApi = undefined
      if (!resolved.exposeWeb) return
      if (activeConnection.backend === 'remote') {
        disposeManagementApi = registerRemoteManagementProxy(httpRuntime, LOCAL_MANAGEMENT_API_PREFIX, () => activeConnection, {
          current: publicApiView,
          update: updateClientSettings,
        })
      } else if (managementProvider !== undefined) {
        disposeManagementApi = registerKnowledgeApi(httpRuntime, managementProvider, LOCAL_MANAGEMENT_API_PREFIX, {
          authMode: 'same-origin',
          service: { current: publicApiView, update: updateClientSettings },
          shareRequestPolicy: () => ({ trustedPrivateOrigins: trustedShareOrigins }),
        })
      }
    }
    refreshManagementApi = applyManagementApiRoute
    applyManagementApiRoute()
    httpRuntime.effect(() => () => { disposeManagementApi?.() }, 'dsh-knowledge.management-api')

    if (resolved.exposeWeb) {
      const disposeWeb = registerKnowledgeWeb(
        httpRuntime,
        resolved.webPath,
        LOCAL_MANAGEMENT_API_PREFIX,
        'same-origin',
        managementEmbedToken,
      )
      httpRuntime.effect(() => disposeWeb, 'dsh-knowledge.web')
    }

    applyPublicApiRoute(publicApiEnabled)
    httpRuntime.effect(() => () => { disposePublicApi?.() }, 'dsh-knowledge.public-api')

    const disposeControl = registerKnowledgeControl(httpRuntime, {
      current: () => activeConnection,
      canSwitchRemote: () => !publicApiEnabled,
      writable: resolved.connectionPath !== undefined,
      managementAvailable: () => resolved.exposeWeb && (activeConnection.backend === 'remote' || managementProvider !== undefined),
      ...resolved.exposeWeb
        ? { managementPath: `${resolved.webPath}?embed=${encodeURIComponent(managementEmbedToken)}` }
        : {},
      update: updateConnection,
    })
    httpRuntime.effect(() => disposeControl, 'dsh-knowledge.connection-control')

    const disposeWritebackControl = registerWritebackControl(httpRuntime, writebackQueue)
    const disposeWritebackLive = registerWritebackLive(httpRuntime, writebackQueue)
    if (disposeWritebackLive) httpRuntime.effect(() => disposeWritebackLive, 'dsh-knowledge.writeback-live')
    if (disposeWritebackControl) httpRuntime.effect(() => disposeWritebackControl, 'dsh-knowledge.writeback-control')
    const disposeWritebackStatus = httpRuntime.webServer?.register({
      kind: 'exact',
      path: '/knowledge-control/v1/writeback-status',
      async handler(req, res) {
        try {
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, POST' }).end()
            return
          }
          assertKnowledgeBrowserRequest(req, 'conversation-web')
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId')?.trim()
          const turn = Number(url.searchParams.get('turn'))
          if (!sessionId || !Number.isInteger(turn) || turn < 0) throw connectionError(400, 'sessionId and a non-negative integer turn are required')
          const key = `${sessionId}:${turn}`
          let state = writebackQueue?.status(key) ?? writebackStatuses.get(key)
          if (state === undefined) {
            // Transport failure is not authoritative absence. Return an error so
            // clients retain their last known state with a disconnected warning.
            const job = await provider.extractionJob(key)
            state = job === undefined ? undefined : statusFromExtractionJob(job, false)
            if (state && job?.status !== 'completed') {
              state = { ...state, summary: `${state.summary}（历史服务端记录；本客户端无恢复快照，请到发起回写的客户端核对）` }
            }
          }
          if (req.method === 'POST') {
            if (!writebackQueue) throw connectionError(409, '知识库回写已停用')
            const source = writebackSources.get(key)
            state = source ? writebackQueue.enqueue(source) : writebackQueue.retry(key)
            writebackSources.delete(key)
            writebackStatuses.delete(key)
          }
          // An absent record is a successful status lookup, not a missing route.
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          }).end(JSON.stringify(state === undefined ? { status: 'missing' } : state))
        } catch (error) {
          sendControlError(res, error)
        }
      },
    })
    if (disposeWritebackStatus !== undefined) httpRuntime.effect(() => disposeWritebackStatus, 'dsh-knowledge.writeback-status')
    if (artifactArchiver) {
      const archive = artifactArchiver
      const folderImportJobs = new Map<string, FolderImportJob>()
      const disposeArtifacts = httpRuntime.webServer?.register({
        kind: 'prefix',
        path: '/knowledge-control/v1/artifacts',
        async handler(req, res) {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const rest = url.pathname.replace(/^\/knowledge-control\/v1\/artifacts\/?/u, '')
            if (req.method === 'POST' && rest === 'import') {
              assertKnowledgeBrowserRequest(req, 'management-web')
              const body = await readControlJson(req)
              const folder = typeof body.path === 'string' ? body.path.trim() : ''
              if (folder.length === 0) throw connectionError(400, '请选择要导入的文件夹')
              const projectId = typeof body.projectId === 'string' && body.projectId.trim().length > 0 ? body.projectId.trim() : undefined
              const archiveRoot = resolved.artifactArchivePath ?? join(
                dirname(resolved.databasePath ?? resolved.connectionPath ?? join(homedir(), '.dsh', 'knowledge', 'knowledge.sqlite')),
                'artifacts',
              )
              const scan = await scanFolder(folder, {
                maxFiles: 800,
                excludePatterns: resolved.artifactArchiveExclude.map(globToRegExp),
                excludeRoots: [archiveRoot, dirname(resolved.databasePath ?? resolved.connectionPath ?? archiveRoot)],
              })
              const candidates = scan.files.map(path => ({ path, source: 'folder' as const }))
              if (candidates.length === 0) {
                res.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                  .end(JSON.stringify({ accepted: 0, root: scan.root, truncated: scan.truncated, skipped: scan.skipped }))
                return
              }
              const context = {
                sessionId: `folder-${randomBytes(8).toString('hex')}`,
                cwd: projectId ?? scan.root,
                turn: 0,
              }
              const job: FolderImportJob = {
                id: `folder-${randomBytes(6).toString('hex')}`,
                root: scan.root,
                status: 'running',
                accepted: candidates.length,
                processed: 0,
                startedAt: new Date().toISOString(),
                truncated: scan.truncated,
                skippedByScan: scan.skipped,
                counts: { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 },
                items: [] as ArtifactIngestItem[],
              }
              folderImportJobs.set(job.id, job)
              void (async () => {
                try {
                  for (let offset = 0; offset < candidates.length; offset += 256) {
                    const summary = await archive.ingest(candidates.slice(offset, offset + 256), context)
                    job.processed += summary.items.length
                    job.counts.created += summary.captured
                    job.counts.updated += summary.updated
                    job.counts.unchanged += summary.unchanged
                    job.counts.skipped += summary.skipped
                    job.counts.failed += summary.failed
                    job.items.push(...summary.items)
                    if (job.items.length > 1000) job.items = job.items.slice(-1000)
                  }
                  job.status = 'done'
                } catch (error) {
                  job.status = 'failed'
                  job.error = error instanceof Error ? error.message : String(error)
                } finally {
                  job.finishedAt = new Date().toISOString()
                  while (folderImportJobs.size > 12) {
                    const oldest = folderImportJobs.keys().next().value
                    if (oldest === undefined || oldest === job.id) break
                    folderImportJobs.delete(oldest)
                  }
                }
              })()
              res.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                .end(JSON.stringify({ accepted: candidates.length, jobId: job.id, root: scan.root, truncated: scan.truncated, skipped: scan.skipped }))
              return
            }
            if (req.method !== 'GET') {
              res.writeHead(405, { allow: 'GET, POST' }).end()
              return
            }
            assertKnowledgeBrowserRequest(req, 'management-web')
            if (rest === '') {
              const artifacts = (await archive.list()).slice(0, 500)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                .end(JSON.stringify({ artifacts }))
              return
            }
            if (rest.startsWith('imports/')) {
              const jobId = rest.slice('imports/'.length).replace(/\/+$/u, '')
              const job = folderImportJobs.get(jobId)
              if (job === undefined) {
                res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'import job not found' }))
                return
              }
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                .end(JSON.stringify({ ...job, items: job.items, itemsTruncated: job.items.length >= 1000 }))
              return
            }
            const id = rest.replace(/\/+$/u, '')
            if (!/^[a-f0-9]{8,64}$/u.test(id)) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'invalid artifact id' }))
              return
            }
            const found = await archive.read(id)
            if (found === undefined) {
              res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'artifact not found' }))
              return
            }
            const name = basename(found.record.path) || `artifact-${id}`
            const asciiName = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
            res.writeHead(200, {
              'content-type': found.record.mediaType,
              'content-length': found.bytes.length,
              'cache-control': 'no-store',
              'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            }).end(found.bytes)
          } catch (error) {
            sendControlError(res, error)
          }
        },
      })
      if (disposeArtifacts !== undefined) httpRuntime.effect(() => disposeArtifacts, 'dsh-knowledge.artifacts-api')
    }
    const disposeFolders = httpRuntime.webServer?.register({
      kind: 'prefix', path: '/knowledge-control/v1/folders',
      async handler(req, res) {
        try {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          assertKnowledgeBrowserRequest(req, 'management-web')
          const url = new URL(req.url ?? '/', 'http://localhost')
          const requested = url.searchParams.get('path')?.trim() || homedir()
          const path = resolve(requested)
          const info = await stat(path).catch(() => undefined)
          if (info === undefined || !info.isDirectory()) throw connectionError(400, '文件夹不存在或不可访问')
          const entries = await readdir(path, { withFileTypes: true })
          const directories = entries
            .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, 300)
            .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
          const parent = dirname(path)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            .end(JSON.stringify({ path, parent: parent === path ? '' : parent, directories }))
        } catch (error) {
          sendControlError(res, error)
        }
      },
    })
    if (disposeFolders !== undefined) httpRuntime.effect(() => disposeFolders, 'dsh-knowledge.folders-api')
    const disposeModelCatalog = httpRuntime.webServer?.register({
      kind: 'exact', path: '/knowledge-control/v1/models',
      async handler(req, res) {
        try {
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return }
          assertKnowledgeBrowserRequest(req, 'management-web')
          const providers = await Promise.all(runtime.llm.listProviders().map(async provider => ({
            ...provider, models: await runtime.llm.listModels(provider.id).catch(() => []),
          })))
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify({ providers }))
        } catch (error) {
          sendControlError(res, error)
        }
      },
    })
    if (disposeModelCatalog !== undefined) httpRuntime.effect(() => disposeModelCatalog, 'dsh-knowledge.model-catalog')

    const disposeNoteOrganizeApi = httpRuntime.webServer?.register({
      kind: 'prefix', path: '/knowledge-control/v1/note-organize',
      async handler(req, res) {
        try {
          if (!autoOrganizer) throw connectionError(409, '本地笔记整理服务不可用')
          const url = new URL(req.url ?? '/', 'http://localhost')
          const path = url.pathname.replace(/^\/knowledge-control\/v1\/note-organize\/?/, '')
          if (req.method === 'POST' && (path === '' || path === 'run')) {
            const result = await autoOrganizer.organize({ force: true })
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result))
            return
          }
          res.writeHead(404).end()
        } catch (error) {
          sendControlError(res, error)
        }
      },
    })
    if (disposeNoteOrganizeApi !== undefined) httpRuntime.effect(() => disposeNoteOrganizeApi, 'dsh-knowledge.note-organize-api')

    const disposeNoteProposalApi = httpRuntime.webServer?.register({
      kind: 'prefix', path: '/knowledge-control/v1/note-proposals',
      async handler(req, res) {
        try {
          if (!managementProvider) throw connectionError(409, '本地笔记草案服务不可用')
          const url = new URL(req.url ?? '/', 'http://localhost')
          const path = url.pathname.replace(/^\/knowledge-control\/v1\/note-proposals\/?/, '')
          const parts = path.split('/').filter(Boolean)

          if (req.method === 'GET' && parts.length === 0) {
            const status = url.searchParams.get('status') as any
            const list = managementProvider.proposalStore.listProposals(status)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ proposals: list }))
            return
          }

          const proposalId = parts[0]
          if (!proposalId) { res.writeHead(400).end(); return }

          if (req.method === 'GET' && parts.length === 1) {
            const proposal = managementProvider.proposalStore.getProposal(proposalId)
            if (!proposal) { res.writeHead(404).end(); return }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ proposal }))
            return
          }

          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'approve') {
            const approved = await managementProvider.proposalStore.approveProposal(proposalId, managementProvider.notes)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(approved))
            return
          }

          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'reject') {
            const rejected = managementProvider.proposalStore.rejectProposal(proposalId)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ proposal: rejected }))
            return
          }

          res.writeHead(404).end()
        } catch (error) {
          sendControlError(res, error)
        }
      },
    })
    if (disposeNoteProposalApi !== undefined) httpRuntime.effect(() => disposeNoteProposalApi, 'dsh-knowledge.note-proposal-api')
  }

  if (runtime.inject !== undefined) {
    runtime.inject(['webServer'], registerHttpSurfaces)
  } else if (runtime.webServer !== undefined) {
    registerHttpSurfaces(runtime)
  } else {
    runtime.logger.warn('dsh-knowledge: webServer is unavailable; management and connection settings are disabled')
  }

  if (autoOrganizer && resolved.noteOrganizeEnabled && resolved.noteOrganizeIntervalMinutes > 0) {
    const intervalMs = resolved.noteOrganizeIntervalMinutes * 60 * 1000
    const timer = setInterval(() => {
      autoOrganizer.organize().catch(err => {
        runtime.logger.warn(`dsh-knowledge: 定时自动整理笔记异常: ${String(err)}`)
      })
    }, intervalMs)
    timer.unref()
    runtime.effect(() => () => clearInterval(timer), 'dsh-knowledge.auto-organizer-interval')
  }

  runtime.on('agent/turn-stopping', ({ agent, turn }) => {
    if (autoOrganizer && resolved.noteOrganizeEnabled) {
      try {
        const snapshot = coordinator.capture(agent.session, turn)
        if (snapshot) {
          autoOrganizer.organize({
            conversationContext: {
              sessionId: agent.session.id,
              userText: snapshot.userText,
              assistantText: snapshot.assistantText,
            },
          }).catch(err => {
            runtime.logger.warn(`dsh-knowledge: 对话后自动笔记整理异常: ${String(err)}`)
          })
        }
      } catch (err) {
        runtime.logger.warn(`dsh-knowledge: 对话后自动笔记整理捕获异常: ${String(err)}`)
      }
    }
  })

  if (artifactArchiver) {
    const archive = artifactArchiver
    runtime.on('agent/turn-stopping', ({ agent, turn }) => {
      void (async () => {
        try {
          const candidates = archive.collectTurn(agent.session, turn)
          try {
            await appendWorkspaceChangeCandidates(runtime, agent.session, turn, candidates)
          } catch (error) {
            runtime.logger.warn(`dsh-knowledge: 读取任务变更文件失败: ${error instanceof Error ? error.message : String(error)}`)
          }
          if (candidates.length === 0) return
          const cwd = agent.session.header.cwd
          const route = lastAssistantRoute(agent.session)
          archive.schedule(candidates, {
            sessionId: agent.session.id,
            ...cwd === undefined || cwd.trim().length === 0 ? {} : { cwd },
            turn,
            ...route === undefined ? {} : { route },
          })
        } catch (error) {
          runtime.logger.warn(`dsh-knowledge: 制品采集失败: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    })
    runtime.effect(() => async () => { await archive.close() }, 'dsh-knowledge.artifact-archiver')
  }

  if (resolved.extractionEnabled) {
    runtime.on('agent/turn-stopping', ({ agent, turn }) => {
      const key = `${agent.session.id}:${turn}`
      let work: WritebackWork | undefined
      try {
        const snapshot = coordinator.capture(agent.session, turn)
        if (snapshot) work = { snapshot, destination: destination() }
        if (work) queueOrganize(work, key)
        else writebackQueue!.completeEmpty(key, agent.session.id)
        writebackStatuses.delete(key)
        writebackSources.delete(key)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Disk/queue failures are explicit; never pretend an unsaved job succeeded.
        rememberWritebackStatus(writebackStatuses, writebackSources, key, {
          status: 'failed', summary: '知识库回写 · 未能可靠入队', error: message, retryable: work !== undefined,
        })
        if (work) writebackSources.set(key, work)
        runtime.logger.warn(`dsh-knowledge: writeback enqueue failed: ${message}`)
      }
    })
    writebackQueue?.start()
    if (resolved.autoOrganizeTrigger === 'interval' && writebackQueue) {
      const timer = setInterval(flushOrganize, Math.max(1, resolved.autoOrganizeIntervalMinutes) * 60_000)
      timer.unref()
      runtime.effect(() => () => clearInterval(timer), 'dsh-knowledge.auto-organize-interval')
    }
  }

  runtime.effect(() => async () => {
    await writebackQueue?.close()
    await coordinator.close()
    await providerRouter.close()
    await managementProvider?.close()
  }, 'dsh-knowledge.close')

  runtime.logger.info(`dsh-knowledge: ${provider.mode} provider ready`)
}

function statusFromExtractionResult(result: Awaited<ReturnType<ExtractionCoordinator['run']>>): WritebackStatus {
  if (result.status === 'unmounted') return { status: 'completed', summary: '知识库回写 · 未挂载可写知识库', retryable: false }
  if (result.status === 'skipped') return { status: 'completed', summary: '知识库回写 · 当前回答无可提取内容', retryable: false }
  if (result.status === 'duplicate') return { status: 'completed', summary: '知识库回写 · 已处理', retryable: false }
  if (result.candidateCount === 0) return { status: 'completed', summary: '知识库回写 · 无需收录', retryable: false }
  return {
    status: 'completed',
    summary: summarizeWritebackCounts(result.bases),
    retryable: false,
    destinations: result.destinations,
  }
}

function statusFromExtractionJob(job: ExtractionJobRecord, retryable: boolean): WritebackStatus {
  if (job.status === 'running') return { status: 'running', summary: '知识库回写 · 正在处理', retryable: false }
  if (job.status === 'failed') return {
    status: 'failed', summary: '知识库回写 · 失败', error: job.lastError ?? '知识库回写失败', retryable,
  }
  const completion = job.completion
  if (completion === undefined) return {
    status: 'completed', summary: job.candidateCount > 0 ? `知识库回写 · 已处理 ${job.candidateCount} 项` : '知识库回写 · 无需收录', retryable: false,
  }
  if (completion.outcome === 'unmounted') return { status: 'completed', summary: '知识库回写 · 未挂载可写知识库', retryable: false }
  if (completion.outcome === 'skipped') return { status: 'completed', summary: '知识库回写 · 当前回答无可提取内容', retryable: false }
  if (completion.candidateCount === 0) return { status: 'completed', summary: '知识库回写 · 无需收录', retryable: false }
  const grouped = new Map<string, { name: string; directCount: number; auditCount: number }>()
  for (const destination of completion.destinations) {
    const current = grouped.get(destination.knowledgeBaseId) ?? {
      name: destination.knowledgeBaseName, directCount: 0, auditCount: 0,
    }
    if (destination.disposition === 'written') current.directCount += 1
    else current.auditCount += 1
    grouped.set(destination.knowledgeBaseId, current)
  }
  return {
    status: 'completed',
    summary: grouped.size === 0
      ? `知识库回写 · 已处理 ${completion.candidateCount} 项`
      : summarizeWritebackCounts([...grouped.values()]),
    retryable: false,
    destinations: completion.destinations,
  }
}

function summarizeWritebackCounts(bases: Array<{ name: string; directCount: number; auditCount: number }>): string {
  return `知识库回写 · ${bases.map(base => {
    const parts = [base.directCount > 0 ? `直写 ${base.directCount}` : '', base.auditCount > 0 ? `待审 ${base.auditCount}` : ''].filter(Boolean)
    return `${base.name}：${parts.join('、')}`
  }).join('；')}`
}

function rememberWritebackStatus(
  statuses: Map<string, WritebackStatus>,
  sources: Map<string, WritebackWork>,
  key: string,
  state: WritebackStatus,
): void {
  statuses.set(key, state)
  while (statuses.size > 1000) {
    const oldest = statuses.keys().next().value as string | undefined
    if (oldest === undefined) break
    statuses.delete(oldest)
    sources.delete(oldest)
  }
}

function publicConnectionError(error: unknown): Error {
  if (error instanceof RemoteProviderError) {
    if (error.status === 401) return connectionError(400, '客户端令牌无效或已被撤销。')
    if (error.status === 403) return connectionError(400, '客户端令牌没有读取该知识库的权限。')
    if (error.status === 404) return connectionError(400, '服务器地址不是有效的知识库 API 地址。')
    if (error.status === 0) return connectionError(400, '无法连接远程知识库，请检查地址、网络和证书。')
    return connectionError(400, `远程知识库验证失败（HTTP ${error.status}）。`)
  }
  if (error instanceof Error && typeof (error as Error & { status?: unknown }).status === 'number') return error
  if (error instanceof Error) {
    if (/server URL and client token|24 characters/i.test(error.message)) return connectionError(400, '首次连接需要填写至少 24 个字符的客户端令牌。')
    if (/HTTPS/i.test(error.message)) return connectionError(400, '远程知识库必须使用 HTTPS。')
    if (/timeout/i.test(error.message)) return connectionError(400, '请求超时时间不正确。')
    if (/databasePath/i.test(error.message)) return connectionError(409, '当前 DSH 没有可用的本地知识库。')
  }
  return error instanceof Error ? error : new Error(String(error))
}

interface WorkspaceChangeSummaryLike {
  files?: Array<{ path?: unknown; display?: unknown }>
}

interface WorkspaceChangesServiceLike {
  summary?(sessionId: string, seq: number): WorkspaceChangeSummaryLike | Promise<WorkspaceChangeSummaryLike | undefined> | undefined
}

/** Add files the workspace-changes plugin recorded for this turn (shell edits included). */
async function appendWorkspaceChangeCandidates(
  runtime: RuntimeContextLike,
  session: SessionLike,
  turn: number,
  candidates: ArtifactCandidate[],
): Promise<void> {
  const service = runtime.get('workspaceChanges') as WorkspaceChangesServiceLike | undefined
  if (service === undefined || typeof service.summary !== 'function') return
  let seq = workspaceChangeSeq(session, turn)
  // The workspace-changes recorder may append its event in its own turn-stopping
  // listener; give it one short moment when our listener ran first.
  if (seq === undefined) {
    await new Promise(resolve => setTimeout(resolve, 400))
    seq = workspaceChangeSeq(session, turn)
  }
  if (seq === undefined) return
  let summary = service.summary(session.id, seq)
  if (summary instanceof Promise) summary = await summary
  if (summary === undefined) {
    await new Promise(resolve => setTimeout(resolve, 400))
    summary = service.summary(session.id, seq)
    if (summary instanceof Promise) summary = await summary
  }
  const files = Array.isArray(summary?.files) ? summary.files : []
  for (const file of files) {
    const path = typeof file?.path === 'string' ? file.path : undefined
    if (path === undefined || path.length === 0 || path.length > 1000) continue
    if (candidates.some(candidate => candidate.path === path)) continue
    candidates.push({ path, source: 'workspace-change' })
    if (candidates.length >= 160) break
  }
}

function workspaceChangeSeq(session: SessionLike, turn: number): number | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'workspace/changes' && (event.data.turn === turn || event.data.turn === undefined)) return event.seq
    if (event?.type === 'turn/start' && event.data.turn === turn) break
  }
  return undefined
}

async function readControlJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > 64 * 1024) throw connectionError(413, '请求内容过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value as Record<string, unknown>
  } catch {
    throw connectionError(400, '请求 JSON 格式无效')
  }
}

function connectionError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

function sendControlError(res: { writeHead(status: number, headers?: Record<string, string>): { end(body?: string): void } }, error: unknown): void {
  const status = error instanceof Error && typeof (error as Error & { status?: unknown }).status === 'number'
    ? (error as Error & { status: number }).status
    : 500
  const message = status >= 500 ? 'internal knowledge control error' : error instanceof Error ? error.message : String(error)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }).end(JSON.stringify({ error: message }))
}
