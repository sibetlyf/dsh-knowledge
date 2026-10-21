import type { ContentBlockLike, MessageLike, SessionLike } from '../runtime.js'

/** One uploaded attachment carried by a user prompt. */
export interface ArtifactUploadCandidate {
  kind: 'file' | 'image'
  /** Durable attachment reference as it appears in the session log. */
  ref: Record<string, unknown>
  name: string
  mediaType?: string
}

/** Every source that can contribute a file to the archive. */
export type ArtifactSource = 'presented' | 'file-tool' | 'upload' | 'reference' | 'workspace-change'

/** One file involved in a completed turn. */
export interface ArtifactCandidate {
  /** Absolute path, or a path relative to the Session working directory. */
  path?: string
  upload?: ArtifactUploadCandidate
  source: ArtifactSource
  description?: string
}

/** File-mutating tools whose path argument marks a written artifact. */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const MAX_CANDIDATES = 256
const UPLOAD_KEY = '\u0000upload:'

const FILE_KEYS = /^(?:file_?path|filepath|path|paths|file|files|target|target_?path|source|source_?path|output|output_?path|input|input_?path|dest|destination|from|to)$/iu
const COMMAND_KEYS = /^(?:command|script|cmd|shell|code)$/iu
const SOURCE_RANK: Record<ArtifactSource, number> = {
  'workspace-change': 0,
  reference: 1,
  'file-tool': 2,
  presented: 3,
  upload: 4,
}

/**
 * Collect every file involved in one completed turn.
 *
 * Durable signals are used instead of watching the filesystem:
 * - `deliverables/presented` declares deliverables, including shell-produced files;
 * - `tool/call` arguments name every file a tool read, viewed, converted, wrote or edited;
 * - shell command strings contribute path-like tokens that exist on disk;
 * - `@path` references in the user's message name files the user brought in;
 * - `user/message` file/image blocks are uploaded attachments.
 *
 * Reading the turn's own event slice keeps the result deterministic across
 * resumes. The archiver still validates each candidate (existence, regular
 * file, size, exclusions), so command or prose tokens never invent files.
 */
export function collectTurnArtifacts(session: SessionLike, turn: number): ArtifactCandidate[] {
  const events = session.snapshotEvents()
  let start = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data.turn === turn) {
      start = index
      break
    }
  }
  if (start < 0) return []
  const candidates = new Map<string, ArtifactCandidate>()
  const addPath = (path: unknown, source: Exclude<ArtifactSource, 'upload'>, description?: string): void => {
    if (typeof path !== 'string') return
    const value = path.trim()
    if (value.length === 0 || value.length > 1000) return
    const previous = candidates.get(value)
    const previousSource = previous?.source === 'upload' ? undefined : previous?.source
    const nextSource = previousSource === undefined || SOURCE_RANK[source] > SOURCE_RANK[previousSource] ? source : previousSource
    const cleanDescription = description === undefined ? undefined : description.trim().slice(0, 500)
    const nextDescription = previous?.description ?? (cleanDescription === undefined || cleanDescription.length === 0 ? undefined : cleanDescription)
    candidates.set(value, {
      path: value,
      source: nextSource,
      ...nextDescription === undefined ? {} : { description: nextDescription },
    })
  }
  const addUpload = (kind: ArtifactUploadCandidate['kind'], ref: Record<string, unknown> | undefined): void => {
    if (ref === undefined || typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0) return
    const key = `${UPLOAD_KEY}${ref.attachmentId}`
    if (candidates.has(key)) return
    const rawName = typeof ref.name === 'string' && ref.name.trim().length > 0
      ? ref.name.trim()
      : kind === 'image' ? 'image' : 'file'
    const name = rawName.slice(0, 200).replace(/[\u0000-\u001f\u007f]/gu, '_')
    candidates.set(key, {
      upload: {
        kind,
        ref: { ...ref },
        name,
        ...typeof ref.mediaType === 'string' && ref.mediaType.length > 0 ? { mediaType: ref.mediaType } : {},
      },
      source: 'upload',
    })
  }
  for (let index = start; index < events.length && candidates.size < MAX_CANDIDATES; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (index > start && event.type === 'turn/start') break
    if (event.type === 'user/message') {
      const message = event.data as unknown as MessageLike
      for (const block of uploadedBlocks(message)) {
        addUpload(block.type === 'image' ? 'image' : 'file', block.attachment as unknown as Record<string, unknown>)
      }
      if (message.source?.kind === 'user') {
        for (const text of messageTextBlocks(message)) {
          for (const reference of extractAtReferences(text)) addPath(reference, 'reference')
        }
      }
      continue
    }
    if (event.type === 'deliverables/presented') {
      forEachPresentedFile(event.data.files, (path, description) => addPath(path, 'presented', description))
      continue
    }
    if (event.type !== 'tool/call') continue
    const name = typeof event.data.name === 'string' ? event.data.name : ''
    const args = parseArguments(event.data.arguments)
    if (name === 'present') {
      forEachPresentedFile(args.files, (path, description) => addPath(path, 'presented', description))
      continue
    }
    const source: Exclude<ArtifactSource, 'upload' | 'presented'> = WRITE_TOOLS.has(name)
      ? name === 'str_replace_editor' && args.command === 'view' ? 'reference' : 'file-tool'
      : 'reference'
    for (const path of collectArgumentPaths(args)) addPath(path, source)
  }
  const result: ArtifactCandidate[] = []
  for (const candidate of candidates.values()) {
    result.push(candidate)
    if (result.length >= MAX_CANDIDATES) break
  }
  return result
}

/** Latest model route used by this session; a fallback for background worklog generation. */
export function lastAssistantRoute(session: SessionLike): { provider: string; model: string } | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const message = event.data.message as { source?: { kind?: unknown; provider?: unknown; model?: unknown } } | undefined
    if (message?.source?.kind !== 'model') continue
    if (typeof message.source.provider === 'string' && typeof message.source.model === 'string') {
      return { provider: message.source.provider, model: message.source.model }
    }
  }
  return undefined
}

function uploadedBlocks(message: MessageLike): ContentBlockLike[] {
  if (!Array.isArray(message.content)) return []
  return message.content.filter(block => (
    (block.type === 'file' || block.type === 'image')
    && typeof block.attachment === 'object'
    && block.attachment !== null
  ))
}

function messageTextBlocks(message: MessageLike): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text ?? '')
}

function forEachPresentedFile(value: unknown, visit: (path: unknown, description?: string) => void): void {
  const files = Array.isArray(value) ? value : []
  for (const file of files) {
    if (typeof file !== 'object' || file === null) continue
    const record = file as Record<string, unknown>
    visit(record.path, typeof record.description === 'string' ? record.description : undefined)
  }
}

/** Walk tool arguments and collect paths, including nested `files: [{path}]` shapes. */
export function collectArgumentPaths(args: Record<string, unknown>): string[] {
  const found: string[] = []
  const push = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.length > 1000 || found.length >= 64) return
    if (!found.includes(trimmed)) found.push(trimmed)
  }
  const visit = (value: unknown, depth: number, fileContext: boolean): void => {
    if (found.length >= 64 || depth > 4) return
    if (typeof value === 'string') {
      if (value.length > 1000 || /[\r\n]/u.test(value)) return
      if (fileContext || looksLikePath(value)) push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, fileContext)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (COMMAND_KEYS.test(key) && typeof item === 'string') {
        for (const path of commandPaths(item)) push(path)
        continue
      }
      if (FILE_KEYS.test(key)) visit(item, depth + 1, true)
      else if (depth === 0 && typeof item === 'object' && item !== null) visit(item, depth + 1, fileContext)
    }
  }
  visit(args, 0, false)
  return found
}

function looksLikePath(value: string): boolean {
  if (value.length === 0 || value.length > 1000 || /[\r\n]/u.test(value)) return false
  if (/^(?:https?|data|mailto):/iu.test(value)) return false
  if (/^(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])/u.test(value)) return true
  return /[\\/]/u.test(value) && /\.[A-Za-z0-9]{1,12}(?:$|[?#])/u.test(value)
}

function commandPaths(command: string): string[] {
  const source = command.length > 20_000 ? command.slice(0, 20_000) : command
  const tokens = source.match(/"[^"]*"|'[^']*'|[^\s"'`]+/gu) ?? []
  const paths: string[] = []
  for (const token of tokens) {
    let value = token.replace(/^["'`]|["'`]$/gu, '')
    if (value.startsWith('-')) value = value.replace(/^--?[A-Za-z0-9_-]+=/u, '')
    if (!looksLikePath(value) || /[<>|&;]/u.test(value)) continue
    paths.push(value)
    if (paths.length >= 24) break
  }
  return paths
}

function extractAtReferences(text: string): string[] {
  const paths: string[] = []
  const pattern = /(?:^|[\s(])@(?:"([^"\n]+)"|([^\s"@，。；：、)】]+))/gu
  for (const match of text.matchAll(pattern)) {
    const value = (match[1] ?? match[2] ?? '').trim()
    if (!looksLikePath(value)) continue
    paths.push(value)
    if (paths.length >= 24) break
  }
  return paths
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2_000_000) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
