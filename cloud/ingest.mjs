// 轻量文件文本抽取：文本类直接读取；PDF/Office/EPUB 使用纯 JS 解析器。
// 图片不做假 OCR：没有配置 OCR 时明确标记为需要 OCR 的“仅存储”文件。
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.log', '.ini', '.conf', '.toml', '.sql', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1', '.css', '.scss', '.vue', '.go', '.java', '.rs',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.rtf',
])
const OFFICE_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.epub'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'])
const TEXT_MIMES = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml|sql|x-sh|x-httpd-php|javascript))/iu
const OFFICE_MIMES = /^(?:application\/(?:pdf|vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|vnd\.ms-excel|epub\+zip)|application\/rtf)/iu
const IMAGE_MIMES = /^image\//iu
const MAX_BYTES = 30 * 1024 * 1024
const MAX_CHARS = 2_000_000

function decodeHtml(value) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function cleanText(content) {
  return content
    .replace(/\u0000/gu, '')
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function bounded(content) {
  return content.length > MAX_CHARS ? `${content.slice(0, MAX_CHARS)}\n\n[内容过长，已截断]` : content
}

function parseRtf(value) {
  return decodeHtml(value
    .replace(/\\par[d]?/giu, '\n')
    .replace(/\{\\\*[^}]*\}/gu, ' ')
    .replace(/\\[a-z]+(-?\d+)?\s?/giu, ' ')
    .replace(/[{}]/gu, ' ')
    .replace(/\\\\/gu, '\\')
    .replace(/\\'/gu, "'"))
}

async function parsePdf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  })
  const doc = await task.promise
  const pages = []
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map(item => ('str' in item ? item.str : '')).join(' ').replace(/[ \t]+/gu, ' ').trim()
      if (text !== '') pages.push(`## 第 ${pageNumber} 页\n\n${text}`)
      page.cleanup()
      if (pages.join('\n\n').length > MAX_CHARS) break
    }
    return { status: pages.length === 0 ? 'failed' : 'parsed', content: bounded(cleanText(pages.join('\n\n'))), parser: 'pdf', error: pages.length === 0 ? 'PDF 未提取到文本，可能是扫描版；需要 OCR 后才能进入检索' : null }
  } finally {
    await task.destroy().catch(() => {})
  }
}

async function parseDocx(bytes) {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  return { status: result.value.trim() === '' ? 'failed' : 'parsed', content: bounded(cleanText(result.value)), parser: 'docx', error: result.value.trim() === '' ? 'DOCX 没有可提取的文本' : null }
}

async function parseWorkbook(bytes, extension) {
  // .xls 是旧二进制格式；没有安全的纯 JS 解析器时明确失败，不伪造正文。
  if (extension === '.xls') {
    return { status: 'unsupported', content: '', parser: null, error: '旧版 .xls 暂不支持；请另存为 .xlsx 后上传' }
  }
  const { unzipSync } = await import('fflate')
  const files = unzipSync(new Uint8Array(bytes))
  const sharedXml = files['xl/sharedStrings.xml'] === undefined ? '' : Buffer.from(files['xl/sharedStrings.xml']).toString('utf8')
  const sharedStrings = [...sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/gu)].map(match => {
    const texts = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gu)].map(item => decodeHtml(item[1]))
    return texts.join(' ')
  })
  const sheetNames = Object.keys(files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const sections = []
  for (let index = 0; index < Math.min(sheetNames.length, 20); index += 1) {
    const xml = Buffer.from(files[sheetNames[index]]).toString('utf8')
    const rows = []
    for (const row of [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/gu)].slice(0, 500)) {
      const cells = []
      for (const cell of row[1].matchAll(/<c[^>]*r="([A-Z]+)(\d+)"[^>]*>([\s\S]*?)<\/c>/gu)) {
        const type = cell[0].match(/t="([^"]+)"/u)?.[1] ?? ''
        let value = ''
        if (type === 's') {
          const sharedIndex = cell[3].match(/<v>(\d+)<\/v>/u)?.[1]
          value = sharedIndex === undefined ? '' : sharedStrings[Number(sharedIndex)] ?? ''
        } else if (type === 'inlineStr') {
          value = [...cell[3].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gu)].map(match => decodeHtml(match[1])).join(' ')
        } else {
          value = cell[3].match(/<v>([\s\S]*?)<\/v>/u)?.[1] ?? ''
        }
        if (value.trim() !== '') cells.push(value.trim())
      }
      if (cells.length > 0) rows.push(cells.join('\t'))
    }
    if (rows.length > 0) sections.push(`## Sheet ${index + 1}\n\n${rows.join('\n')}`)
  }
  const content = cleanText(sections.join('\n\n'))
  return { status: content === '' ? 'failed' : 'parsed', content: bounded(content), parser: 'xlsx', error: content === '' ? '表格没有可提取的单元格文本' : null }
}

async function parseZipDocument(bytes, extension) {
  const { unzipSync } = await import('fflate')
  const files = unzipSync(new Uint8Array(bytes))
  const names = Object.keys(files)
  const pick = pattern => names.filter(name => pattern.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  let text = ''
  if (extension === '.pptx') {
    text = pick(/^ppt\/slides\/slide\d+\.xml$/u).map(name => {
      const xml = Buffer.from(files[name]).toString('utf8')
      return [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gu)].map(match => decodeHtml(match[1])).join(' ')
    }).filter(Boolean).join('\n\n')
  } else {
    text = pick(/\.(?:xhtml|html|htm|txt|xml)$/u).map(name => {
      const body = Buffer.from(files[name]).toString('utf8')
      return decodeHtml(body)
    }).join('\n\n')
  }
  const cleaned = cleanText(text)
  return { status: cleaned === '' ? 'failed' : 'parsed', content: bounded(cleaned), parser: extension.slice(1), error: cleaned === '' ? '压缩文档没有可提取的文本' : null }
}

export async function extractText({ name, mime, bytes }) {
  const extension = String(name ?? '').toLowerCase().match(/\.[a-z0-9]+$/u)?.[0] ?? ''
  const mediaType = String(mime ?? '').toLowerCase()
  const textLike = TEXT_EXTENSIONS.has(extension) || TEXT_MIMES.test(mediaType)
  const officeLike = OFFICE_EXTENSIONS.has(extension) || OFFICE_MIMES.test(mediaType)
  const imageLike = IMAGE_EXTENSIONS.has(extension) || IMAGE_MIMES.test(mediaType)
  if (imageLike && !officeLike) {
    return { status: 'unsupported', content: '', parser: null, error: '图片已保存，但当前未配置 OCR；正文尚未进入检索索引' }
  }
  if (!textLike && !officeLike) {
    return { status: 'unsupported', content: '', parser: null, error: `暂不支持解析 ${extension || mediaType || '该文件'}；原文件仍可下载` }
  }
  if (bytes.length > MAX_BYTES) {
    return { status: 'failed', content: '', parser: null, error: '文件超过 30 MiB，未建立全文索引' }
  }
  try {
    if (officeLike) {
      if (extension === '.pdf' || mediaType === 'application/pdf') return await parsePdf(bytes)
      if (extension === '.docx') return await parseDocx(bytes)
      if (extension === '.xlsx' || extension === '.xls') return await parseWorkbook(bytes, extension)
      if (extension === '.pptx' || extension === '.epub') return await parseZipDocument(bytes, extension)
    }
    let content = Buffer.from(bytes).toString('utf8')
    if (extension === '.rtf' || mediaType === 'application/rtf') content = parseRtf(content)
    if (extension === '.html' || extension === '.htm' || mediaType.includes('text/html')) content = decodeHtml(content)
    content = cleanText(content)
    if (content === '') return { status: 'failed', content: '', parser: 'utf8', error: '文件没有可索引的文本内容' }
    return { status: 'parsed', content: bounded(content), parser: extension === '.rtf' ? 'rtf' : extension === '.html' || extension === '.htm' ? 'html-text' : 'utf8' }
  } catch (error) {
    return { status: 'failed', content: '', parser: extension.slice(1) || null, error: `解析失败：${error.message}` }
  }
}
