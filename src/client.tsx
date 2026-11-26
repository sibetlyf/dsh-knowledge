import { useCallback, useEffect, useRef, useState } from 'react'
import { createConnectionClient, ConnectionRequestError, type KnowledgeConnectionView } from './connection-client.js'
import { WritebackStatusClient } from './writeback/status-client.js'
import { createNoteMentionSource } from './note-mention-source.js'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { observeWritebackVisibility } from './writeback/status-visibility.js'
import { subscribeWritebackChanges } from '../web/writeback-live.js'
import type { WritebackStatus } from './writeback/queue.js'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { activatePluginWorkspace, observePluginWorkspace } from './workspace-ownership.js'
// DSH 0.1.7 renamed size-suffixed icon exports to weight-suffixed ones;
// aliases keep every call site (and the contract tests) on legacy names.
import {
  IconChevronLeftOutlineRegular as IconChevronLeftOutline14,
  IconDataOutlineRegular as IconDataOutline16,
  IconPanelLeftOutlineRegular as IconPanelLeftOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { HeroMorningCard } from './morning-card.js'
import { knowledgeDesignCss } from './design-tokens.js'
import { availableActivitySession, deriveCurrentSession } from './knowledge-activity-state.js'
import { supportsDockedPanels } from './docked-panel-compat.js'
import cssText from './client.css'
import { settingsSurfaceCss } from './settings-surface.js'
import { registerMainPanel } from './main-panel-compat.js'
import { installCitationLinks } from './citation-links.js'
import activityCss from './knowledge-activity.css'
import { createKnowledgeActivityController, type KnowledgeActivityController } from './knowledge-activity-controller.js'
import {
  createKnowledgeHostTheme,
  KNOWLEDGE_THEME_PROTOCOL_VERSION,
  KNOWLEDGE_THEME_READY_MESSAGE,
  type ThemeSnapshotLike,
} from './theme-bridge.js'

const PLUGIN_ID = '@lemoncat7/dsh-knowledge'
const STYLE_ID = `${PLUGIN_ID}/client`

type SidebarActionProps = PropsRuntime<'sidebar.footer.action'>
type ConversationSlotProps = PropsRuntime<'conversation'>

export interface KnowledgeWorkspaceController {
  isOpen(): boolean
  open(): void
  toggle(): void
  openDocument(target: KnowledgeDocumentTarget): void
  currentTarget(): KnowledgeDocumentTarget | undefined
  close(): void
  subscribe(listener: () => void): () => void
}

export type KnowledgeDocumentTarget =
  | { view?: 'entries'; knowledgeBaseId: string; documentId: string }
  | { view: 'notes'; noteId?: string }
  | { view: 'writeback'; sessionId: string }
  | { view: 'citation'; citation: string }


const connectionClient = createConnectionClient()
const requestConnection = connectionClient.request

/** Cordis services needed by the browser half. */
export const inject = ['slots', 'theme', 'layout', 'sessions']

/** Register the knowledge launcher in the sidebar's official extension slot. */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-knowledge: client styles')
  const docked = supportsDockedPanels(ctx)
  let activity: KnowledgeActivityController | undefined
  const workspace = createKnowledgeWorkspaceController(ctx, () => { if (!docked) activity?.close(undefined, true) })
  ctx.effect(() => installCitationLinks(citation => workspace.openDocument({ view: 'citation', citation: JSON.stringify(citation) })), 'dsh-knowledge: inline source navigation')
  ctx.inject(['inputTriggers'], scoped => {
    scoped.effect(() => scoped.inputTriggers.registerSource(createNoteMentionSource(
      noteId => workspace.openDocument({ view: 'notes', noteId }),
    )), 'dsh-knowledge: @ note documents')
  })
  activity = createKnowledgeActivityController(ctx, {
    beforeOpen: () => { workspace.close(); if (!docked) activatePluginWorkspace(PLUGIN_ID) },
    openWorkspace: target => { if (target === undefined) workspace.open(); else workspace.openDocument(target) },
  })
  ctx.effect(() => observePluginWorkspace(PLUGIN_ID, () => { workspace.close(); if (!docked) activity?.close(undefined, true) }), 'dsh-knowledge: exclusive workspace')
  ctx.effect(() => () => { workspace.close(); activity?.dispose() }, 'dsh-knowledge: workspace lifecycle')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'knowledge',
    order: 21, // Immediately after the appearance entry (order 20).
  }, props => <KnowledgeLauncher {...props} workspace={workspace} activity={activity!} docked={supportsDockedPanels(ctx)} />))

  // DSH 0.1.7 retired `settings.plugin.item`; `settings.plugins.tab` exists on
  // both host generations and hosts the same connection card as one tab.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'knowledge',
    order: 20,
    label: () => '知识库',
  }, KnowledgeConnectionCard))
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'knowledge-tencent-docs',
    order: 21,
    label: () => '腾讯文档',
  }, TencentDocsSettings))
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'knowledge-cloud-sync',
    order: 22,
    label: () => '云端同步',
  }, CloudSyncSettings))

  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'knowledge-writeback-status',
  }, props => <KnowledgeWritebackStatus sessionId={String(props.sessionId)} turn={props.turn.turn} workspace={workspace} />))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
  }, props => <HeroMorningCard {...props} />))
}

function KnowledgeWritebackStatus({
  sessionId,
  turn,
  workspace,
}: { sessionId: string; turn: number; workspace: KnowledgeWorkspaceController }) {
  const [state, setState] = useState<WritebackStatus>()
  const [retrying, setRetrying] = useState(false)
  const [readError, setReadError] = useState<string>()
  const client = useRef<WritebackStatusClient>()
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setState(undefined)
    setRetrying(false)
    setReadError(undefined)
    const status = new WritebackStatusClient(
      `/knowledge-control/v1/writeback-status?sessionId=${encodeURIComponent(sessionId)}&turn=${turn}`,
      (value, pending, error) => { setState(value); setRetrying(pending); setReadError(error) },
    )
    client.current = status
    const stopVisibility = container.current ? observeWritebackVisibility(container.current, status,
      () => subscribeWritebackChanges('conversation-web', () => status.invalidate())) : undefined
    return () => {
      stopVisibility?.()
      status.dispose()
      client.current = undefined
    }
  }, [sessionId, turn])
  if (state === undefined) return <div ref={container}>
    {readError && <div className="dsh-knowledge-writeback-notice" role="status">{readError}<button type="button" onClick={() => workspace.openDocument({ view: 'writeback', sessionId })}>管理回写</button></div>}
  </div>
  const retry = (): void => client.current?.retry()
  const destinations = state.destinations ?? []
  const summary = state.summary.replace(/^知识库回写\s*·\s*/u, '')
  return <div ref={container} className="dsh-knowledge-writeback-notice" data-status={state.status}>
    <div className="dsh-knowledge-writeback-summary" role="status" aria-atomic="true">
      <span>知识库回写</span><strong>@lemoncat7/dsh-knowledge</strong><span title={state.error}>{summary}</span>
      {(state.buffered || state.status === 'failed' && state.retryable) && <button type="button" disabled={retrying} onClick={() => { void retry() }}>{retrying ? '处理中…' : state.buffered ? '立即回写' : '重试'}</button>}
      {state.status !== 'completed' && <button type="button" onClick={() => workspace.openDocument({ view: 'writeback', sessionId })}>管理回写</button>}
    </div>
    {destinations.length > 0 && <ul className="dsh-knowledge-writeback-destinations" aria-label="回写目标">
      {destinations.map((destination, index) => <li key={`${destination.knowledgeBaseId}:${destination.documentId ?? destination.documentTitle}:${index}`}>
        <span className="dsh-knowledge-writeback-base">{destination.knowledgeBaseName}</span>
        <span className="dsh-knowledge-writeback-separator" aria-hidden="true">/</span>
        {destination.documentId
          ? <button
            type="button"
            className="dsh-knowledge-writeback-document"
            title={`打开 ${destination.documentPath ?? destination.documentTitle}`}
            aria-label={`在知识库中打开 ${destination.documentTitle}`}
            onClick={() => { workspace.openDocument({ knowledgeBaseId: destination.knowledgeBaseId, documentId: destination.documentId! }) }}
          ><strong>{destination.documentPath ?? destination.documentTitle}</strong></button>
          : <strong title={destination.documentTitle}>{`拟新建：${destination.documentTitle}`}</strong>}
        <small data-disposition={destination.disposition}>{destination.disposition === 'written' ? (destination.documentState === 'resolved' ? '已解决' : destination.documentState === 'complete' ? '已完成' : '已写入') : (destination.documentState ? '待审核 · 标记' + (destination.documentState === 'resolved' ? '解决' : '完成') : '待审核')}</small>
      </li>)}
    </ul>}
    {state.status === 'failed' && state.error && <p className="dsh-knowledge-writeback-error" role="alert">{state.error}</p>}
    {readError && <p className="dsh-knowledge-writeback-error" role="status">{readError}</p>}
  </div>
}

function createKnowledgeWorkspaceController(client: ClientContext, beforeOpen: () => void): KnowledgeWorkspaceController {
  const listeners = new Set<() => void>()
  let disposeWorkspace: (() => void) | undefined
  let target: KnowledgeDocumentTarget | undefined
  const notify = (): void => { for (const listener of listeners) listener() }
  const close = (): void => {
    if (disposeWorkspace === undefined) return
    const dispose = disposeWorkspace
    disposeWorkspace = undefined
    dispose()
    notify()
  }
  let controller: KnowledgeWorkspaceController
  const open = (): void => {
    if (disposeWorkspace !== undefined) return
    beforeOpen()
    activatePluginWorkspace(PLUGIN_ID)
    disposeWorkspace = registerMainPanel(client, PLUGIN_ID, -1, props => (
      <KnowledgeWorkspace {...props} client={client} workspace={controller} />
    ), close)
  }
  controller = {
    isOpen: () => disposeWorkspace !== undefined,
    open: () => { target = undefined; open(); notify() },
    toggle: () => {
      if (disposeWorkspace !== undefined) return close()
      target = undefined
      open()
      notify()
    },
    openDocument: nextTarget => {
      target = nextTarget
      open()
      notify()
    },
    currentTarget: () => target,
    close,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return controller
}

function TencentDocsSettings() {
  const [status, setStatus] = useState<{
    connected?: boolean
    tools?: string[]
    token?: { configured?: boolean; source?: string; fingerprint?: string; overriddenByEnv?: boolean }
    error?: string
  }>()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const load = useCallback(async () => {
    try {
      const response = await fetch('/knowledge-local/v1/tencent-docs/status', {
        credentials: 'same-origin',
        headers: { 'x-dsh-knowledge-client': 'management-web' },
      })
      const body = await response.json()
      setStatus(body)
      setMessage('')
    } catch (error) {
      setStatus({ error: error instanceof Error ? error.message : String(error) })
    }
  }, [])
  useEffect(() => { void load() }, [load])
  const save = async () => {
    if (!token.trim()) return
    setBusy(true)
    try {
      const response = await fetch('/knowledge-local/v1/tencent-docs/token', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-knowledge-client': 'management-web' },
        body: JSON.stringify({ token: token.trim() }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      setStatus(body); setToken(''); setMessage('已保存到本地 vault，桥插件会自动重连。')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const clear = async () => {
    setBusy(true)
    try {
      const response = await fetch('/knowledge-local/v1/tencent-docs/token', {
        method: 'DELETE', credentials: 'same-origin',
        headers: { 'x-dsh-knowledge-client': 'management-web' },
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      setStatus(body); setMessage('已清除腾讯文档 token。')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const tokenState = status?.token
  return <section className="dsh-knowledge-settings-card">
    <header><h3>腾讯文档</h3><p>导入腾讯文档到知识库，或把知识文档发布回腾讯文档。凭据只保存在本机 vault，接口不返回明文。</p></header>
    <div className="dsh-knowledge-remote-fields">
      <label>space_secret
        <input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="32 位 space_secret" autoComplete="off" spellCheck={false} />
      </label>
      <p className="dsh-knowledge-hint">
        {status?.error ? `状态读取失败：${status.error}` : tokenState?.configured
          ? `已配置 · 来源 ${tokenState.source === 'env' ? '环境变量' : 'vault'} · 指纹 ${tokenState.fingerprint}${tokenState.overriddenByEnv ? '（环境变量覆盖）' : ''}`
          : '尚未配置。环境变量 TDOC_OAUTH_ACCESS_TOKEN 优先。'}
      </p>
      {status?.tools?.length ? <p className="dsh-knowledge-hint">已检测到工具：{status.tools.join('、')}</p> : null}
    </div>
    {message ? <p className="dsh-knowledge-hint" role="status">{message}</p> : null}
    <div className="dsh-knowledge-settings-actions">
      <button type="button" disabled={busy || !token.trim()} onClick={() => { void save() }}>{busy ? '保存中…' : '保存 token'}</button>
      {tokenState?.configured ? <button type="button" disabled={busy} onClick={() => { void clear() }}>清除</button> : null}
      <button type="button" disabled={busy} onClick={() => { void load() }}>刷新状态</button>
    </div>
  </section>
}

function KnowledgeConnectionCard() {
  const [current, setCurrent] = useState<KnowledgeConnectionView>()
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [open, setOpen] = useState(false)
  const [backend, setBackend] = useState<'local' | 'remote'>('local')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteToken, setRemoteToken] = useState('')
  const [timeout, setTimeoutValue] = useState('10000')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string }>()

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoadState('loading')
    setLoadError('')
    try {
      const value = await requestConnection('GET', undefined, signal)
      if (signal?.aborted) return
      setCurrent(value)
      setLoadState('ready')
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(connectionErrorMessage(error))
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [load])

  useEffect(() => {
    if (dirty || current === undefined) return
    setBackend(current.backend)
    setRemoteUrl(current.remoteUrl ?? '')
    setTimeoutValue(String(current.remoteTimeoutMs ?? 10000))
  }, [current, dirty])

  const timeoutNumber = Number(timeout)
  const urlError = backend === 'remote' ? validateRemoteUrl(remoteUrl) : undefined
  const tokenError = backend === 'remote' && !current?.tokenConfigured && remoteToken.trim().length === 0
    ? '首次连接必须填写客户端令牌。'
    : remoteToken.length > 0 && remoteToken.trim().length < 24 ? '令牌至少需要 24 个字符。' : undefined
  const timeoutError = !Number.isInteger(timeoutNumber) || timeoutNumber < 100 || timeoutNumber > 120000
    ? '超时必须是 100 到 120000 毫秒之间的整数。'
    : undefined
  const invalid = urlError !== undefined || tokenError !== undefined || timeoutError !== undefined

  const edit = (action: () => void): void => {
    action()
    setDirty(true)
    setMessage(undefined)
  }
  const reset = (): void => {
    setBackend(current?.backend ?? 'local')
    setRemoteUrl(current?.remoteUrl ?? '')
    setRemoteToken('')
    setTimeoutValue(String(current?.remoteTimeoutMs ?? 10000))
    setDirty(false)
    setMessage(undefined)
  }
  const save = async (): Promise<void> => {
    if (!dirty || invalid || !current?.writable || saving) return
    setSaving(true)
    setMessage(undefined)
    try {
      const next = await requestConnection('PUT', {
        backend,
        remoteTimeoutMs: timeoutNumber,
        ...backend === 'remote' ? { remoteUrl: remoteUrl.trim() } : {},
        ...backend === 'remote' && remoteToken.trim().length > 0 ? { remoteToken: remoteToken.trim() } : {},
      })
      setCurrent(next)
      setRemoteToken('')
      setDirty(false)
      setMessage({
        kind: 'success',
        text: backend === 'remote' ? '已验证并切换至远程知识库。' : '已切换至本地知识库。',
      })
    } catch (error) {
      setMessage({ kind: 'error', text: connectionErrorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className={`dsh-plugin-settings dsh-knowledge-settings-card${open ? ' dsh-knowledge-settings-card--open' : ''}`}>
      <button type="button" className="dsh-knowledge-settings-header" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <span><strong>知识库连接</strong><small>选择本机知识库，或连接一台中央 DSH 知识库</small></span>
        <span className="dsh-knowledge-settings-summary">{loadState === 'loading' ? '读取中' : loadState === 'error' ? '连接入口' : current?.backend === 'remote' ? '远程' : '本地'}<i aria-hidden="true" /></span>
      </button>
      {open && <div className="dsh-knowledge-settings-body">
        {loadState === 'loading' ? <p className="dsh-knowledge-settings-note" role="status">正在读取连接配置…</p>
          : loadState === 'error' ? <div className="dsh-knowledge-settings-load-error" role="alert">
            <p>{loadError}</p>
            <button type="button" onClick={() => { void load() }}>重新读取</button>
          </div> : <>
          <fieldset className="dsh-knowledge-source-picker">
            <legend>知识库来源</legend>
            <label className={backend === 'local' ? 'is-selected' : ''}>
              <input type="radio" name="dsh-knowledge-backend" checked={backend === 'local'} onChange={() => edit(() => { setBackend('local') })} />
              <span><strong>本地</strong><small>数据保存在当前 DSH 的 SQLite 中</small></span>
            </label>
            <label className={`${backend === 'remote' ? 'is-selected' : ''}${!current?.canSwitchRemote ? ' is-disabled' : ''}`}>
              <input type="radio" name="dsh-knowledge-backend" checked={backend === 'remote'} disabled={!current?.canSwitchRemote} onChange={() => edit(() => { setBackend('remote') })} />
              <span><strong>远程</strong><small>召回和回写统一使用中央知识库</small></span>
            </label>
          </fieldset>
          {!current?.canSwitchRemote && <p className="dsh-knowledge-settings-note">当前实例是中央知识库服务，不能再切换到另一台远程服务。</p>}
          {backend === 'remote' && <div className="dsh-knowledge-remote-fields">
            <label htmlFor="dsh-knowledge-remote-url">服务器地址
              <input id="dsh-knowledge-remote-url" type="url" value={remoteUrl} placeholder="https://example.com/knowledge-api/v1" autoComplete="url" onChange={event => edit(() => { setRemoteUrl(event.target.value) })} aria-invalid={urlError !== undefined} aria-describedby={urlError ? 'dsh-knowledge-url-error' : undefined} />
              {urlError && <small id="dsh-knowledge-url-error" className="dsh-knowledge-field-error">{urlError}</small>}
            </label>
            <label htmlFor="dsh-knowledge-remote-token">客户端令牌
              <input id="dsh-knowledge-remote-token" type="password" value={remoteToken} placeholder={current?.tokenConfigured ? '已保存；留空则保持不变' : '粘贴客户端令牌'} autoComplete="new-password" onChange={event => edit(() => { setRemoteToken(event.target.value) })} aria-invalid={tokenError !== undefined} aria-describedby="dsh-knowledge-token-help" />
              <small id="dsh-knowledge-token-help" className={tokenError ? 'dsh-knowledge-field-error' : undefined}>{tokenError ?? (current?.tokenConfigured ? '令牌已安全保存，页面无法读取；输入新令牌可覆盖。' : '令牌保存后不可读取，只能覆盖。')}</small>
            </label>
          </div>}
          <label className="dsh-knowledge-timeout-field" htmlFor="dsh-knowledge-timeout">请求超时（毫秒）
            <input id="dsh-knowledge-timeout" type="number" min="100" max="120000" step="100" value={timeout} onChange={event => edit(() => { setTimeoutValue(event.target.value) })} aria-invalid={timeoutError !== undefined} />
            {timeoutError && <small className="dsh-knowledge-field-error">{timeoutError}</small>}
          </label>
          {!current?.writable && <p className="dsh-knowledge-settings-note">当前插件没有配置持久化路径，无法保存连接。</p>}
          {message && <p className={`dsh-knowledge-settings-message is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{message.text}</p>}
          <div className="dsh-knowledge-settings-actions">
            <button type="button" onClick={reset} disabled={!dirty || saving}>放弃更改</button>
            <button type="button" className="is-primary" onClick={() => { void save() }} disabled={!dirty || invalid || saving || !current?.writable}>{saving ? '正在验证…' : '验证并连接'}</button>
          </div>
        </>}
      </div>}
    </li>
  )
}

function validateRemoteUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return '远程知识库必须使用 HTTPS。'
    return undefined
  } catch { return '请输入完整的知识库 API 地址。' }
}

function connectionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Failed to fetch')) return '无法访问插件连接接口，请确认插件服务已加载。'
  return message || '连接配置操作失败，请检查地址、令牌和 DSH 日志。'
}

interface CloudSyncStatusView {
  configured: boolean
  url: string
  userName: string
  autoSync: boolean
  intervalMinutes: number
  filesDir: string
  filesOut: string
  base: string
  running: boolean
  mode?: string
  lastRunAt?: string
  lastError?: string
  lastOutput?: string
}

async function cloudSyncRequest(method: 'GET' | 'PUT' | 'POST', body?: Record<string, unknown>): Promise<CloudSyncStatusView> {
  const path = method === 'POST' ? '/knowledge-local/v1/cloud-sync/run' : '/knowledge-local/v1/cloud-sync'
  const response = await fetch(path, {
    method,
    headers: {
      'x-dsh-knowledge-client': 'management-web',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error ?? `云端同步请求失败 (${response.status})`)
  return payload as CloudSyncStatusView
}

function CloudSyncSettings() {
  const [status, setStatus] = useState<CloudSyncStatusView>()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [userName, setUserName] = useState('')
  const [autoSync, setAutoSync] = useState(false)
  const [interval, setIntervalValue] = useState('5')
  const [filesDir, setFilesDir] = useState('')
  const [filesOut, setFilesOut] = useState('')
  const [base, setBase] = useState('')
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string }>()
  const [busy, setBusy] = useState(false)
  const editingRef = useRef(false)

  const apply = useCallback((value: CloudSyncStatusView) => {
    setStatus(value)
    if (editingRef.current) return
    setUrl(value.url)
    setUserName(value.userName)
    setAutoSync(value.autoSync)
    setIntervalValue(String(value.intervalMinutes))
    setFilesDir(value.filesDir)
    setFilesOut(value.filesOut)
    setBase(value.base)
  }, [])
  const update = <T,>(setter: (value: T) => void, value: T): void => {
    editingRef.current = true
    setter(value)
  }

  const load = useCallback(async () => {
    try { apply(await cloudSyncRequest('GET')) } catch (error) { setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) }) }
  }, [apply])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 3000)
    return () => window.clearInterval(timer)
  }, [load])

  const save = async (runAfterSave: boolean): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      const intervalNumber = Number(interval)
      if (!Number.isInteger(intervalNumber) || intervalNumber < 1 || intervalNumber > 60) throw new Error('自动同步间隔必须是 1-60 分钟')
      const next = await cloudSyncRequest('PUT', { url, token, userName, autoSync, intervalMinutes: intervalNumber, filesDir, filesOut, base })
      editingRef.current = false
      apply(next)
      setToken('')
      if (!next.configured) {
        setMessage({ kind: 'error', text: '配置已保存，但还缺少云端地址或 Token；填好后点“连接并立即同步”。' })
        return
      }
      if (runAfterSave || next.autoSync) {
        apply(await cloudSyncRequest('POST', { mode: 'sync' }))
        setMessage({ kind: 'success', text: '已连接云端并开始首次同步；下方状态会自动刷新。' })
      } else {
        setMessage({ kind: 'success', text: '配置已保存；开启自动同步或点“上传/拉取”开始。' })
      }
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally { setBusy(false) }
  }

  const run = async (mode: 'push' | 'pull' | 'sync'): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      apply(await cloudSyncRequest('POST', { mode }))
      setMessage({ kind: 'success', text: mode === 'push' ? '已开始上传本地→云端。' : mode === 'pull' ? '已开始拉取云端→本地镜像。' : '已开始双向同步。' })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally { setBusy(false) }
  }

  return <li className="dsh-plugin-settings dsh-knowledge-settings-card">
    <div className="dsh-knowledge-settings-body">
      <div className="dsh-knowledge-settings-header" style={{ cursor: 'default' }}>
        <span><strong>云端团队同步</strong><small>连接云端后，本地原库保持可用，并自动增加“云端·库名”的本地镜像库。</small></span>
        <span className="dsh-knowledge-settings-summary">{status?.configured ? (status.running ? '同步中' : status.autoSync ? '自动' : '已连接') : '未连接'}<i aria-hidden="true" /></span>
      </div>
      <p className="dsh-knowledge-settings-note">云端需要先部署团队知识库服务，并在「成员与邀请」生成 DSH Token。Token 随本机配置保存在知识库数据目录，不进入 Git。</p>
      <div className="dsh-knowledge-remote-fields">
        <label>云端服务地址
          <input type="url" value={url} placeholder="https://知识库域名/knowledge-api/v1" onChange={event => update(setUrl, event.target.value)} />
        </label>
        <label>DSH Token
          <input type="password" value={token} placeholder={status?.configured ? '已保存；留空保持不变' : '粘贴 dshk_...'} autoComplete="new-password" onChange={event => update(setToken, event.target.value)} />
        </label>
        <label>文件归属用户名
          <input type="text" value={userName} placeholder="默认本机用户名" maxLength={100} onChange={event => update(setUserName, event.target.value)} />
        </label>
        <label>自动同步间隔（分钟）
          <input type="number" min="1" max="60" step="1" value={interval} onChange={event => update(setIntervalValue, event.target.value)} />
        </label>
      </div>
      <label className="dsh-knowledge-settings-note">
        <input type="checkbox" checked={autoSync} onChange={event => update(setAutoSync, event.target.checked)} /> 自动同步（本地/云端变化后轮询）
      </label>
      <div className="dsh-knowledge-remote-fields">
        <label>本地文件上传目录（可选）
          <input type="text" value={filesDir} placeholder="例如 G:\dsh-knowledge\artifacts\blobs" onChange={event => update(setFilesDir, event.target.value)} />
        </label>
        <label>云端文件下载目录（可选）
          <input type="text" value={filesOut} placeholder="例如 G:\dsh-knowledge\cloud-files" onChange={event => update(setFilesOut, event.target.value)} />
        </label>
        <label>指定本地知识库（可选）
          <input type="text" value={base} placeholder="留空同步全部；填库名或 ID 限定上传文件" onChange={event => update(setBase, event.target.value)} />
        </label>
      </div>
      {message && <p className={`dsh-knowledge-settings-message is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>}
      <div className="dsh-knowledge-settings-actions">
        <button type="button" className="is-primary" disabled={busy || status?.running} onClick={() => { void save(true) }}>{busy || status?.running ? '同步中…' : '连接并立即同步'}</button>
        <button type="button" disabled={busy || status?.running || !status?.configured} onClick={() => { void run('push') }}>上传本地→云</button>
        <button type="button" disabled={busy || status?.running || !status?.configured} onClick={() => { void run('pull') }}>拉取云端→本地镜像</button>
        <button type="button" disabled={busy || !status?.configured} onClick={() => { void save(false) }}>保存配置</button>
      </div>
      {status && <div className="dsh-knowledge-settings-note">
        <p>状态：{status.running ? `正在${status.mode ?? '同步'}` : status.lastRunAt ? `上次同步 ${new Date(status.lastRunAt).toLocaleString()}` : '尚未同步'}{status.autoSync ? ` · 每 ${status.intervalMinutes} 分钟自动` : ''}</p>
        {status.lastError && <p className="dsh-knowledge-field-error">上次错误：{status.lastError}</p>}
        {status.lastOutput && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', fontSize: 11 }}>{status.lastOutput}</pre>}
      </div>}
    </div>
  </li>
}

function KnowledgeLauncher({ wide, useSessions, workspace, activity, docked }: SidebarActionProps & { workspace: KnowledgeWorkspaceController; activity: KnowledgeActivityController; docked: boolean }) {
  const [open, setOpen] = useState(workspace.isOpen())
  const currentSessionId = useSessions((state: SessionListState) => availableActivitySession(state, docked))
  const [activityOpen, setActivityOpen] = useState(currentSessionId === undefined ? false : activity.isOpen(currentSessionId))

  useEffect(() => workspace.subscribe(() => { setOpen(workspace.isOpen()) }), [workspace])
  useEffect(() => {
    const sync = (): void => {
      setActivityOpen(currentSessionId === undefined ? false : activity.isOpen(currentSessionId))
    }
    sync()
    return activity.subscribe(sync)
  }, [activity, currentSessionId])

  return (
    <div className={`dsh-knowledge-launcher${wide ? '' : ' dsh-knowledge-launcher--rail'}`} role="group" aria-label="知识库入口">
    {wide && <button
      type="button"
      className={`dsh-knowledge-trigger${wide ? '' : ' dsh-knowledge-trigger--rail'}${open ? ' is-active' : ''}`}
      aria-label={open ? '返回对话' : '打开知识库工作区'}
      aria-pressed={open}
      title={open ? '返回对话' : '打开知识库工作区'}
      onClick={() => workspace.toggle()}
    >
      <IconDataOutline16 size={wide ? 16 : 18} />
      {wide && <span>知识库</span>}
    </button>}
    <button
      type="button"
      className={`dsh-knowledge-trigger dsh-knowledge-panel-trigger${activityOpen ? ' is-active' : ''}`}
      aria-label={activityOpen ? '收起会话知识库' : '展开会话知识库'}
      aria-expanded={activityOpen}
      disabled={currentSessionId === undefined}
      title={currentSessionId === undefined ? '进入会话后可展开知识侧栏' : activityOpen ? '收起会话知识库' : '展开会话知识库'}
      onClick={() => { if (currentSessionId !== undefined) activity.toggle(currentSessionId) }}
    >
      <IconPanelLeftOutline16 size={16} className="dsh-knowledge-panel-right-icon" />
    </button>
    </div>
  )
}

function KnowledgeWorkspace({
  sessionId: scopedSessionId,
  useSessions,
  client,
  workspace,
}: ConversationSlotProps & { client: ClientContext; workspace: KnowledgeWorkspaceController }) {
  const cachedConnectionView = connectionClient.peek()
  const cachedManagementPath = cachedConnectionView?.managementAvailable ? cachedConnectionView.managementPath : undefined
  const [panelState, setPanelState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>(cachedConnectionView === undefined ? 'loading' : cachedManagementPath === undefined ? 'unavailable' : 'ready')
  const [managementPath, setManagementPath] = useState<string | undefined>(cachedManagementPath)
  const [panelError, setPanelError] = useState('')
  const [target, setTarget] = useState<KnowledgeDocumentTarget | undefined>(workspace.currentTarget())
  const selectedSessionId = useSessions((state: SessionListState) => deriveCurrentSession(state))
  const sessionId = scopedSessionId ?? selectedSessionId
  const projectId = useSessions((state: SessionListState) => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const knowledgeUrl = managementPath === undefined ? undefined : knowledgePanelUrl(managementPath, sessionId, projectId, target)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const themeFrame = useRef(0)
  const connectionRequest = useRef<AbortController | null>(null)
  const managementPathRef = useRef(managementPath)
  managementPathRef.current = managementPath

  const loadManagement = useCallback(async (background = false): Promise<void> => {
    connectionRequest.current?.abort()
    const controller = new AbortController()
    connectionRequest.current = controller
    if (!background) setPanelState('loading')
    setPanelError('')
    try {
      const connection = await requestConnection('GET', undefined, controller.signal)
      if (controller.signal.aborted) return
      if (!connection.managementAvailable || connection.managementPath === undefined) {
        setManagementPath(undefined)
        setPanelState('unavailable')
        return
      }
      setManagementPath(connection.managementPath)
      setPanelState('ready')
    } catch (error) {
      if (controller.signal.aborted) return
      // A temporary metadata outage must not destroy an editor already on screen.
      // Access revocation and a removed endpoint must still fail closed.
      if (background && managementPathRef.current !== undefined
        && !(error instanceof ConnectionRequestError && [401, 403, 404].includes(error.status))) {
        setPanelError(connectionErrorMessage(error))
        return
      }
      setManagementPath(undefined)
      setPanelError(connectionErrorMessage(error))
      setPanelState('error')
    } finally {
      if (connectionRequest.current === controller) connectionRequest.current = null
    }
  }, [])

  useEffect(() => {
    void loadManagement(managementPathRef.current !== undefined)
    const reconnect = (): void => { void loadManagement(managementPathRef.current !== undefined) }
    window.addEventListener('online', reconnect)
    return () => {
      connectionRequest.current?.abort()
      window.removeEventListener('online', reconnect)
    }
  }, [loadManagement])

  useEffect(() => workspace.subscribe(() => { setTarget(workspace.currentTarget()) }), [workspace])

  const sendTheme = useCallback((): void => {
    const currentFrame = frame.current
    if (currentFrame === null) return
    const target = currentFrame.contentWindow
    if (target === null) return
    target.postMessage(
      createKnowledgeHostTheme(client.theme.getTheme()),
      frameOrigin(currentFrame) ?? '*',
    )
  }, [client])

  const scheduleTheme = useCallback((): void => {
    if (themeFrame.current !== 0) window.cancelAnimationFrame(themeFrame.current)
    themeFrame.current = window.requestAnimationFrame(() => {
      themeFrame.current = 0
      sendTheme()
    })
  }, [sendTheme])

  useEffect(() => {
    const off = client.on('theme/change', scheduleTheme)
    const onMessage = (event: MessageEvent): void => {
      const currentFrame = frame.current
      if (event.source !== currentFrame?.contentWindow) return
      const expectedOrigin = frameOrigin(currentFrame)
      if (expectedOrigin !== undefined && event.origin !== expectedOrigin) return
      const data = event.data as { type?: unknown; version?: unknown; sessionId?: unknown } | null
      if (data?.type === '@lemoncat7/dsh-worklog/open-session' && typeof data.sessionId === 'string' && data.sessionId.length > 0 && data.sessionId.length <= 256) {
        const navigation = client.get('uiWorkspace') as { openSession(id: string): void } | undefined
        if (navigation) { navigation.openSession(data.sessionId); activatePluginWorkspace('conversation') }
      }
      if (data?.type === KNOWLEDGE_THEME_READY_MESSAGE && data.version === KNOWLEDGE_THEME_PROTOCOL_VERSION) sendTheme()
    }
    window.addEventListener('message', onMessage)
    scheduleTheme()
    return () => {
      off()
      window.removeEventListener('message', onMessage)
      if (themeFrame.current !== 0) window.cancelAnimationFrame(themeFrame.current)
    }
  }, [client, scheduleTheme, sendTheme])

  return (
    <section className="dsh-knowledge-workspace" data-knowledge-surface="workspace" aria-labelledby="dsh-knowledge-workspace-title">
      <header className="dsh-knowledge-workspace-header">
        <div>
          <button type="button" data-knowledge-workspace-close onClick={workspace.close} aria-label="返回会话" title="返回会话"><IconChevronLeftOutline14 size={15} /></button>
          <IconDataOutline16 size={18} />
          <span><h2 id="dsh-knowledge-workspace-title">知识库</h2><p>文档、审核、挂载与访问管理</p></span>
        </div>
      </header>
      {panelState === 'ready' && panelError && <div className="dsh-knowledge-connection-warning" role="status">
        <span>连接复查暂未完成，当前页面已保留。{panelError}</span>
        <button type="button" onClick={() => { void loadManagement(true) }}>重试</button>
      </div>}
      {panelState === 'ready' && knowledgeUrl !== undefined
        ? <iframe ref={frame} className="dsh-knowledge-frame" src={knowledgeUrl} title="知识库管理台" onLoad={sendTheme} />
        : <div className="dsh-knowledge-panel-state" role={panelState === 'error' ? 'alert' : 'status'} aria-live="polite">
          <span className="dsh-knowledge-panel-state-icon" aria-hidden="true">{panelState === 'loading' ? '···' : panelState === 'error' ? '!' : '—'}</span>
          <div>
            <h3>{panelState === 'loading' ? '正在打开知识库…' : panelState === 'error' ? '暂时无法打开知识库' : '这台 DSH 未启用知识库管理台'}</h3>
            <p>{panelState === 'loading'
              ? '正在确认当前实例是否提供管理页面。'
              : panelState === 'error'
                ? panelError
                : '本地召回和回写仍可使用。当前 profile 已显式关闭 exposeWeb；重新启用后即可在这里管理。使用远程知识库时，请前往中央 DSH 的知识库管理台。'}</p>
            {panelState === 'error' && <button type="button" onClick={() => { void loadManagement() }}>重试</button>}
          </div>
        </div>}
    </section>
  )
}

function knowledgePanelUrl(managementPath: string, sessionId?: string, projectId?: string, target?: KnowledgeDocumentTarget): string {
  const params = new URLSearchParams()
  if (sessionId !== undefined) params.set('sessionId', sessionId)
  if (projectId !== undefined) params.set('projectId', projectId)
  if (target !== undefined) {
    if (target.view === 'citation') {
      params.set('citation', target.citation)
    } else if (target.view === 'writeback') {
      params.set('view', 'writeback')
      params.set('sessionId', target.sessionId)
    } else if (target.view === 'notes') {
      params.set('view', 'notes')
      if (target.noteId !== undefined) params.set('noteId', target.noteId)
    } else {
      params.set('knowledgeBaseId', target.knowledgeBaseId)
      params.set('documentId', target.documentId)
    }
  }
  const query = params.toString()
  return query.length === 0 ? managementPath : `${managementPath}${managementPath.includes('?') ? '&' : '?'}${query}`
}

function frameOrigin(frame: HTMLIFrameElement): string | undefined {
  try {
    const origin = new URL(frame.src).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

function installStyles(): () => void {
  const previous = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
  previous?.remove()
  const style = document.createElement('style')
  style.dataset.plugin = PLUGIN_ID
  style.dataset.pluginCss = STYLE_ID
  const scope = ':is(.dsh-knowledge-trigger, .dsh-knowledge-activity-panel, .dsh-knowledge-workspace, .dsh-knowledge-settings-card, .dsh-knowledge-writeback-notice, .dsh-knowledge-morning-card)'
  style.textContent = knowledgeDesignCss(scope, 'body[data-ds-dark-theme] ' + scope, false) + cssText + activityCss + settingsSurfaceCss
  document.head.appendChild(style)
  return () => { style.remove() }
}
