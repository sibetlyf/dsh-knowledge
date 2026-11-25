export interface PaperMetadata {
  title: string
  abstract: string
  keywords: string[]
  /** Display categories; the first one becomes the document group. */
  categories: string[]
  /** Raw arXiv category codes (e.g. cs.CL). */
  codes: string[]
  arxivId?: string
  doi?: string
  year?: number
}

const MAX_ABSTRACT_CHARS = 5000
const STOP_HEADING = /^(?:keywords?|key\s*words|index\s*terms|关键词|关键字|ccs\s*concepts|acm\s*reference\s*format|(?:1|i)[\.\s]+introduction|introduction|引言|1\s+introduction)(?:\s|[:：]|$)/iu
const ARXIV_CATEGORY_LABELS: Array<[RegExp, string]> = [
  [/^cs\.CL$|^cs\.IR$/u, '自然语言处理'],
  [/^cs\.CV$/u, '计算机视觉'],
  [/^cs\.LG$|^stat\.ML$/u, '机器学习'],
  [/^cs\.AI$/u, '人工智能'],
  [/^cs\.RO$/u, '机器人'],
  [/^cs\.DB$/u, '数据库'],
  [/^cs\.CR$/u, '安全'],
  [/^cs\.DC$/u, '分布式系统'],
  [/^cs\.SE$/u, '软件工程'],
  [/^cs\.HC$/u, '人机交互'],
  [/^cs\./u, '计算机科学'],
  [/^stat\./u, '统计学'],
  [/^math\./u, '数学'],
  [/^physics\./u, '物理'],
  [/^q-bio\./u, '生物'],
  [/^econ\./u, '经济'],
  [/^eess\./u, '电子工程'],
]

/**
 * Deterministic metadata extraction for PDF papers. The abstract and keywords
 * become searchable database fields; the full paper still stays in the archive
 * file. No model call is made, so a malformed PDF never blocks archiving.
 */
export function extractPaperMetadata(text: string, display: string): PaperMetadata | undefined {
  const normalized = text.replace(/\r\n?/gu, '\n').replace(/\f/gu, '\n')
  const lines = normalized.split('\n').map(line => line.replace(/[ \t]+/gu, ' ').trim())
  const head = normalized.slice(0, 20_000)
  const arxiv = /arxiv[:\s]*(\d{4}\.\d{4,5})(v\d+)?(?:\s*\[([^\]]+)\])?/iu.exec(head)
  const arxivId = arxiv?.[1]
  const codes = arxiv?.[3]?.split(/[,\s]+/u).map(code => code.trim()).filter(Boolean) ?? []
  const doi = /10\.\d{4,9}\/[^\s<>"']+/u.exec(head)?.[0]
  const abstract = findAbstract(lines, normalized)
  const keywords = findKeywords(lines)
  if ((abstract?.length ?? 0) < 60 && keywords.length < 2 && arxivId === undefined) return undefined
  const title = pretty(findTitle(lines, display, normalized))
  const effectiveKeywords = keywords.length > 0 ? keywords : deriveKeywords(title, 12)
  const categories = categorize(codes, effectiveKeywords, `${title}\n${abstract ?? ''}`)
  const year = arxivYear(arxivId) ?? findYear(head) ?? findYear(display)
  return {
    title,
    abstract: pretty((abstract ?? '').slice(0, MAX_ABSTRACT_CHARS)),
    keywords: effectiveKeywords,
    categories,
    codes,
    ...arxivId === undefined ? {} : { arxivId },
    ...doi === undefined ? {} : { doi },
    ...year === undefined ? {} : { year },
  }
}

/** PDF extraction often drops spaces at glyph boundaries; restore readable casing. */
function pretty(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/([:：])(?=[^\s])/gu, '$1 ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Category labels used for groups/tags; deterministic and bounded. */
export function categorize(codes: string[], keywords: string[], text: string): string[] {
  const labels = new Set<string>()
  for (const code of codes) {
    const matched = ARXIV_CATEGORY_LABELS.find(([pattern]) => pattern.test(code))
    if (matched !== undefined) labels.add(matched[1])
  }
  if (labels.size > 0) return [...labels].slice(0, 3)
  const haystack = `${keywords.join(' ')}\n${text}`
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .toLocaleLowerCase('zh-CN')
  const rules: Array<[RegExp, string]> = [
    [/natural language|language model|machine translation|text classification|\bnlp\b|\bllm\b|transformer|语言模型|自然语言|文本分类|机器翻译|语料/iu, '自然语言处理'],
    [/computer vision|image classification|object detection|segmentation|视觉|图像识别|目标检测/iu, '计算机视觉'],
    [/machine learning|deep learning|neural network|reinforcement learning|机器学习|深度学习|神经网络|强化学习/iu, '机器学习'],
    [/database|distributed system|operating system|networking|数据库|分布式|操作系统|网络/iu, '计算机系统'],
    [/algorithm|complexity|theorem|proof|算法|复杂度|定理|证明/iu, '理论与算法'],
    [/human-computer|user study|interaction design|人机交互|用户研究/iu, '人机交互'],
    [/clinical|patient|medical|biomedical|医学|临床|生物医学/iu, '生物医学'],
    [/econom|finance|market|经济|金融|市场/iu, '经济与金融'],
  ]
  for (const [pattern, label] of rules) {
    if (pattern.test(haystack)) {
      labels.add(label)
      if (labels.size >= 2) break
    }
  }
  return labels.size > 0 ? [...labels] : ['综合']
}

function findAbstract(lines: string[], normalized: string): string | undefined {
  const heading = lines.findIndex(line => /^(?:abstract|摘要)(?:\s|[:：.\-—]|$)/iu.test(line) && line.length <= 40)
  if (heading >= 0) {
    const collected: string[] = []
    for (let index = heading + 1; index < lines.length; index += 1) {
      const line = lines[index]!
      if (STOP_HEADING.test(line)) break
      if (line.length > 0) collected.push(line)
      if (collected.join(' ').length > MAX_ABSTRACT_CHARS) break
    }
    const text = collected.join(' ').replace(/\s+/gu, ' ').trim()
    if (text.length >= 60) return text
  }
  const inline = /\babstract\b\s*[:：.\-—]?\s*([\s\S]{80,5000}?)(?=\s*(?:1\s+)?introduction\b|\s*(?:keywords?|index\s*terms)\b|$)/iu.exec(normalized)
  const text = inline?.[1]?.replace(/\s+/gu, ' ').trim()
  return text !== undefined && text.length >= 60 ? text : undefined
}

function findKeywords(lines: string[]): string[] {
  const keywords: string[] = []
  for (const line of lines.slice(0, 120)) {
    const match = /^(?:keywords?|key\s*words|index\s*terms|关键词|关键字)\s*[:：.\-—]?\s*(.+)$/iu.exec(line)
    if (match === null) continue
    for (const term of (match[1] ?? '').split(/[;,，；、·|]+/u)) {
      const value = term.replace(/^[\s\-–—]+|[\s\-–—]+$/gu, '').slice(0, 80)
      if (value.length >= 2 && value.length <= 80 && !keywords.includes(value)) keywords.push(value)
      if (keywords.length >= 24) return keywords
    }
  }
  return keywords
}

const KEYWORD_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'had', 'not', 'you',
  'your', 'can', 'will', 'would', 'should', 'could', 'but', 'all', 'any', 'our', 'their', 'they', 'them', 'then',
  'than', 'into', 'out', 'its', 'use', 'used', 'using', 'paper', 'study', 'show', 'shows', 'based', 'results',
  'method', 'methods', 'approach', 'propose', 'proposed', 'also', 'more', 'most', 'such', 'these', 'those',
  'https', 'http', 'www', 'com', 'org', 'edu', 'doi', 'arxiv', 'usa', 'university', 'institute', 'abstract',
])

/** Keywords derived from title + abstract when the PDF has no keyword line. */
function deriveKeywords(text: string, limit: number): string[] {
  const counts = new Map<string, number>()
  const add = (term: string): void => {
    if (term.length < 2 || term.length > 48 || KEYWORD_STOPWORDS.has(term) || /^\d+$/u.test(term)) return
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  for (const match of text.toLocaleLowerCase().matchAll(/[a-z][a-z0-9_+-]{2,}/gu)) {
    if (match[0].length >= 4 || ['llm', 'llms', 'kv', 'rag', 'gpu', 'cpu', 'api', 'nlp', 'cv'].includes(match[0])) add(match[0])
  }
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,}/gu)) {
    const run = match[0]
    for (let index = 0; index + 1 < run.length; index += 1) add(run.slice(index, index + 2))
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([term]) => term)
}

function findTitle(lines: string[], display: string, normalized: string): string {
  let abstractAt = lines.findIndex(line => /^(?:abstract|摘要)(?:\s|[:：.\-—]|$)/iu.test(line) && line.length <= 40)
  if (abstractAt < 0) abstractAt = Math.min(lines.length, 80)
  for (const line of lines.slice(0, abstractAt)) {
    if (line.length < 6 || line.length > 220) continue
    if (/^(?:arxiv|preprint|research article|original article|review article|proceedings|journal|volume|issue|published|received|accepted|copyright|©)/iu.test(line)) continue
    if (/@|https?:\/\/|doi[:\s]|www\./iu.test(line)) continue
    if (!/[A-Za-z\u4e00-\u9fff]{3,}/u.test(line)) continue
    return line
  }
  // Some PDF extractors flatten the whole first page into one line. Recover the
  // title between the arXiv header and the abstract heading.
  const beforeAbstract = normalized.split(/\b(?:abstract|摘要)\b/iu)[0] ?? ''
  const candidate = beforeAbstract
    .replace(/^[\s\S]*?arxiv[:\s]*\d{4}\.\d{4,5}(?:v\d+)?(?:\s*\[[^\]]+\])?/iu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (candidate.length >= 8 && candidate.length <= 220 && /[A-Za-z\u4e00-\u9fff]{3,}/u.test(candidate)) return candidate
  return display.split(/[\\/]/u).pop()?.replace(/\.[^.]+$/u, '') || '未命名论文'
}

function arxivYear(arxivId: string | undefined): number | undefined {
  if (arxivId === undefined) return undefined
  const value = Number(arxivId.slice(0, 2))
  if (!Number.isFinite(value)) return undefined
  return 2000 + value
}

function findYear(value: string): number | undefined {
  const match = /(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/u.exec(value)
  const year = match === null ? undefined : Number(match[1])
  return year !== undefined && year >= 1900 && year <= 2100 ? year : undefined
}
