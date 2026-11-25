import { extname } from 'node:path'
import { extractPdfText } from '../pdf-parser.js'
import { extractOfficeText, officeKind } from './office-text.js'

/** File types archived by default: documents, tabular data and images. */
export const DEFAULT_ARTIFACT_EXTENSIONS: string[] = [
  'md', 'markdown', 'mdx', 'txt', 'text', 'rtf', 'log',
  'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm',
  'pdf', 'docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'ppsx',
  'odt', 'ods', 'odp', 'epub',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'avif', 'heic',
]

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico', 'avif', 'heic'])

const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'yaml', 'yml', 'xml', 'html', 'htm', 'svg', 'css', 'scss', 'less', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'cs', 'c', 'h', 'cpp', 'hpp',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'r', 'lua', 'php', 'vue', 'svelte', 'graphql', 'gql', 'proto', 'tex', 'bib', 'srt', 'vtt',
  'diff', 'patch',
])

const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', mdx: 'text/markdown',
  txt: 'text/plain', text: 'text/plain', log: 'text/plain', rtf: 'application/rtf',
  csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', jsonl: 'application/x-ndjson',
  yaml: 'application/yaml', yml: 'application/yaml', xml: 'application/xml',
  html: 'text/html', htm: 'text/html',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff',
  tiff: 'image/tiff', avif: 'image/avif', heic: 'image/heic',
}

export type ArtifactContentKind = 'text' | 'office' | 'pdf' | 'image' | 'binary'

export interface ArtifactContent {
  kind: ArtifactContentKind
  text: string
  /** True when the indexed text was cut at the configured limit. */
  truncated: boolean
  note?: string
}

/** Lowercase extension without the leading dot; empty when the name has none. */
export function normalizeExtension(pathOrExtension: string): string {
  const value = pathOrExtension.trim()
  if (value.length === 0) return ''
  if (!value.includes('/') && !value.includes('\\') && !value.includes('.') && /^[A-Za-z0-9]{1,16}$/u.test(value)) {
    return value.toLowerCase()
  }
  return extname(value).replace(/^\./u, '').toLowerCase()
}

/** Human-readable artifact category used as the default document column. */
export function artifactCategory(extension: string): string {
  const value = normalizeExtension(extension)
  if (['md', 'markdown', 'mdx', 'txt', 'text', 'log', 'rtf', 'pdf', 'docx', 'docm', 'dotx', 'odt', 'ott', 'epub', 'doc'].includes(value)) return '文档'
  if (['csv', 'tsv', 'xlsx', 'xlsm', 'ods', 'ots', 'xls'].includes(value)) return '表格'
  if (['pptx', 'pptm', 'ppsx', 'odp', 'otp', 'ppt'].includes(value)) return '演示'
  if (IMAGE_EXTENSIONS.has(value) || value === 'svg') return '图片'
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(value)) return '压缩包'
  if (['mp3', 'wav', 'm4a', 'ogg', 'mp4', 'webm', 'mov', 'mkv'].includes(value)) return '音视频'
  if (TEXT_EXTENSIONS.has(value)) return '代码'
  return '其他'
}

export function artifactMediaType(extension: string): string {
  return MEDIA_TYPES[normalizeExtension(extension)] ?? 'application/octet-stream'
}

/** Best-effort extension for a known media type (uploads may arrive unnamed). */
export function extensionForMediaType(mediaType: string | undefined): string {
  if (mediaType === undefined) return ''
  const match = Object.entries(MEDIA_TYPES).find(([, type]) => type === mediaType)
  return match?.[0] ?? ''
}

export function artifactContentKind(extension: string): ArtifactContentKind {
  const normalized = normalizeExtension(extension)
  if (IMAGE_EXTENSIONS.has(normalized)) return 'image'
  if (normalized === 'pdf') return 'pdf'
  if (officeKind(normalized) !== undefined) return 'office'
  return TEXT_EXTENSIONS.has(normalized) ? 'text' : 'binary'
}

/**
 * Extract the searchable text of one archived artifact.
 *
 * Binaries and images keep metadata only: the archive copy stays authoritative,
 * and the knowledge entry never claims to contain bytes it did not read.
 */
export function extractArtifactContent(extension: string, buffer: Buffer, maxChars: number): ArtifactContent {
  const kind = artifactContentKind(extension)
  const limit = Math.max(1, Math.trunc(maxChars))
  if (kind === 'image') return { kind, text: '', truncated: false }
  if (kind === 'pdf') {
    try {
      const text = extractPdfText(buffer.subarray(0, 16 * 1024 * 1024))
      return { kind, ...clip(text, limit) }
    } catch (error) {
      return { kind, text: '', truncated: false, note: `PDF 文本解析失败：${message(error)}` }
    }
  }
  if (kind === 'office') {
    try {
      const text = extractOfficeText(extension, buffer, limit)
      return { kind, ...clip(text, limit) }
    } catch (error) {
      return { kind, text: '', truncated: false, note: `Office 文本解析失败：${message(error)}` }
    }
  }
  if (kind === 'binary') return { kind, text: '', truncated: false }
  if (!looksLikeText(buffer)) return { kind: 'binary', text: '', truncated: false }
  const decodeCap = Math.max(64 * 1024, limit * 8)
  const decoded = decodeText(buffer.subarray(0, Math.min(buffer.length, decodeCap)))
  return { kind: 'text', ...clip(decoded, limit) }
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n?/gu, '\n').trim()
  if (normalized.length <= limit) return { text: normalized, truncated: false }
  return { text: normalized.slice(0, limit), truncated: true }
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000))
  if (sample.includes(0)) return false
  let control = 0
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12) control += 1
  }
  return sample.length === 0 || control / sample.length < 0.05
}

function decodeText(buffer: Buffer): string {
  const text = buffer.toString('utf8')
  return text.startsWith('\uFEFF') ? text.slice(1) : text
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
