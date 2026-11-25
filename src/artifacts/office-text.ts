import { readZipEntries } from './zip.js'

/**
 * Dependency-free text extraction for Office Open XML and OpenDocument
 * artifacts. The archiver indexes the user-visible text so archived deck,
 * report and spreadsheet deliverables stay searchable in the knowledge base.
 * Only container members are read; macros, embedded objects and images are
 * never executed or inflated beyond the shared zip bounds.
 */

export type OfficeKind = 'docx' | 'pptx' | 'xlsx' | 'odf'

const OFFICE_EXTENSIONS: Record<string, OfficeKind> = {
  docx: 'docx',
  docm: 'docx',
  dotx: 'docx',
  pptx: 'pptx',
  pptm: 'pptx',
  ppsx: 'pptx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  odt: 'odf',
  ott: 'odf',
  ods: 'odf',
  ots: 'odf',
  odp: 'odf',
  otp: 'odf',
}

/** Normalized Office kind for one extension, or undefined for other files. */
export function officeKind(extension: string): OfficeKind | undefined {
  return OFFICE_EXTENSIONS[extension.replace(/^\./u, '').toLowerCase()]
}

/** Extract bounded plain text from an Office/ODF buffer; never throws for unknown content. */
export function extractOfficeText(extension: string, buffer: Buffer, maxChars: number): string {
  const kind = officeKind(extension)
  if (kind === undefined) return ''
  const isOdf = kind === 'odf'
  const entries = readZipEntries(buffer, {
    match: name => isOdf ? name === 'content.xml' : /^(word|ppt|xl)\//u.test(name) && name.endsWith('.xml'),
    maxEntries: 512,
    maxEntryBytes: 24 * 1024 * 1024,
    maxTotalBytes: 48 * 1024 * 1024,
  })
  if (isOdf) {
    const content = entries.get('content.xml')
    return content === undefined ? '' : clip(xmlText(content.toString('utf8')), maxChars)
  }
  if (kind === 'docx') return clip(docxText(entries), maxChars)
  if (kind === 'pptx') return clip(pptxText(entries), maxChars)
  return clip(xlsxText(entries, maxChars), maxChars)
}

function docxText(entries: Map<string, Buffer>): string {
  const parts: string[] = []
  const main = entries.get('word/document.xml')
  if (main !== undefined) parts.push(xmlText(main.toString('utf8')))
  const headers = [...entries.keys()]
    .filter(name => /^word\/(header|footer)\d*\.xml$/u.test(name))
    .sort()
  for (const name of headers) {
    const data = entries.get(name)
    if (data !== undefined) parts.push(xmlText(data.toString('utf8')))
  }
  for (const name of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const data = entries.get(name)
    if (data !== undefined) parts.push(xmlText(data.toString('utf8')))
  }
  return parts.filter(part => part.length > 0).join('\n\n')
}

function pptxText(entries: Map<string, Buffer>): string {
  const slides = [...entries.keys()]
    .map(name => ({ name, index: Number(/^ppt\/slides\/slide(\d+)\.xml$/u.exec(name)?.[1] ?? Number.NaN) }))
    .filter(item => Number.isFinite(item.index))
    .sort((left, right) => left.index - right.index)
  const parts: string[] = []
  for (const slide of slides) {
    const data = entries.get(slide.name)
    if (data === undefined) continue
    const text = xmlText(data.toString('utf8'))
    if (text.length > 0) parts.push(`[slide ${slide.index}]\n${text}`)
  }
  return parts.join('\n\n')
}

function xlsxText(entries: Map<string, Buffer>, maxChars: number): string {
  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '')
  const names = parseSheetNames(entries.get('xl/workbook.xml')?.toString('utf8') ?? '')
  const sheets = [...entries.keys()]
    .map(name => ({ name, index: Number(/^xl\/worksheets\/sheet(\d+)\.xml$/u.exec(name)?.[1] ?? Number.NaN) }))
    .filter(item => Number.isFinite(item.index))
    .sort((left, right) => left.index - right.index)
  const parts: string[] = []
  let used = 0
  for (const sheet of sheets) {
    const data = entries.get(sheet.name)
    if (data === undefined) continue
    const title = names[sheet.index - 1] ?? `Sheet${sheet.index}`
    const table = sheetToTsv(data.toString('utf8'), shared, Math.max(0, maxChars - used))
    if (table.length === 0) continue
    const block = `## ${title}\n${table}`
    used += block.length
    parts.push(block)
    if (used >= maxChars) break
  }
  return parts.join('\n\n')
}

function parseSharedStrings(xml: string): string[] {
  const values: string[] = []
  const itemPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/gu
  let match: RegExpExecArray | null
  while ((match = itemPattern.exec(xml)) !== null) {
    const inner = match[1] ?? ''
    const text = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)]
      .map(part => decodeEntities(part[1] ?? ''))
      .join(' ')
    values.push(text)
    if (values.length >= 100_000) break
  }
  return values
}

function parseSheetNames(xml: string): string[] {
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/gu)].map(match => decodeEntities(match[1] ?? ''))
}

function sheetToTsv(xml: string, shared: readonly string[], budget: number): string {
  const lines: string[] = []
  let used = 0
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/gu
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowPattern.exec(xml)) !== null && lines.length < 5000 && used < budget) {
    const row = rowMatch[1] ?? ''
    const cells: string[] = []
    const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/gu
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellPattern.exec(row)) !== null && cells.length < 64) {
      const attributes = cellMatch[1] ?? ''
      const inner = cellMatch[2] ?? ''
      const column = columnIndex(/\br="([A-Za-z]+)\d+"/u.exec(attributes)?.[1])
      while (column !== undefined && cells.length < column) cells.push('')
      const type = /\bt="([^"]*)"/u.exec(attributes)?.[1]
      const value = cellValue(type, inner, shared)
      if (column === undefined) cells.push(value)
      else cells[column] = value
    }
    const line = cells.map(cell => cell.replace(/[\t\r\n]+/gu, ' ')).join('\t').replace(/\t+$/u, '')
    if (line.trim().length > 0) {
      lines.push(line)
      used += line.length + 1
    }
  }
  return lines.join('\n')
}

function cellValue(type: string | undefined, inner: string, shared: readonly string[]): string {
  if (type === 's') {
    const index = Number(extractTag(inner, 'v'))
    return Number.isInteger(index) ? shared[index] ?? '' : ''
  }
  if (type === 'inlineStr') {
    return [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)].map(match => decodeEntities(match[1] ?? '')).join(' ')
  }
  if (type === 'b') return extractTag(inner, 'v') === '1' ? 'TRUE' : 'FALSE'
  return decodeEntities(extractTag(inner, 'v'))
}

function extractTag(xml: string, tag: string): string {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'u').exec(xml)?.[1] ?? ''
}

function columnIndex(letters: string | undefined): number | undefined {
  if (letters === undefined || !/^[A-Za-z]{1,3}$/u.test(letters)) return undefined
  let value = 0
  for (const letter of letters.toUpperCase()) value = value * 26 + (letter.charCodeAt(0) - 64)
  return value - 1
}

const PARAGRAPH_END = /<\/(?:w:p|a:p|text:p|text:h|table:table-row|w:tr)>/gu
const CELL_END = /<\/(?:w:tc|table:table-cell)>/gu
const BREAK_TAG = /<(?:w:br|w:cr|text:line-break)\b[^>]*\/>/gu
const TAB_TAG = /<(?:w:tab|text:tab)\b[^>]*\/>/gu
const SPACE_TAG = /<(?:text:s|w:softHyphen)\b[^>]*\/>/gu

/** Flatten one WordprocessingML/presentation/ODF XML member into plain text. */
export function xmlText(xml: string): string {
  const text = xml
    .replace(TAB_TAG, '\t')
    .replace(SPACE_TAG, ' ')
    .replace(BREAK_TAG, '\n')
    .replace(CELL_END, '\t')
    .replace(PARAGRAPH_END, '\n')
    .replace(/<[^>]+>/gu, '')
  return decodeEntities(text)
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (entity, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? safeCodePoint(code) : entity
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? safeCodePoint(code) : entity
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity
  })
}

function safeCodePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return ''
  try { return String.fromCodePoint(code) } catch { return '' }
}

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, Math.max(0, maxChars))}\n\n…（内容已截断）`
}
