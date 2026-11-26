// 轻量文件文本抽取：只为可直接读取的文本格式建立全文索引；复杂格式明确标记为 unsupported。
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.log', '.ini', '.conf', '.toml', '.sql', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1', '.css', '.scss', '.vue', '.go', '.java', '.rs',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php',
])
const TEXT_MIMES = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml|sql|x-sh|x-httpd-php|javascript))/iu

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

export function extractText({ name, mime, bytes }) {
  const extension = String(name ?? '').toLowerCase().match(/\.[a-z0-9]+$/u)?.[0] ?? ''
  const mediaType = String(mime ?? '').toLowerCase()
  const textLike = TEXT_EXTENSIONS.has(extension) || TEXT_MIMES.test(mediaType)
  if (!textLike) {
    return { status: 'unsupported', content: '', parser: null, error: `暂不支持解析 ${extension || mediaType || '该文件' }；原文件仍可下载` }
  }
  if (bytes.length > 8 * 1024 * 1024) {
    return { status: 'failed', content: '', parser: 'utf8', error: '文本文件超过 8 MiB，未建立全文索引' }
  }
  let content = Buffer.from(bytes).toString('utf8').replace(/\u0000/gu, '')
  if (content.length > 2_000_000) content = content.slice(0, 2_000_000)
  if (extension === '.html' || extension === '.htm' || mediaType.includes('text/html')) content = decodeHtml(content)
  content = content.trim()
  if (content === '') return { status: 'failed', content: '', parser: 'utf8', error: '文件没有可索引的文本内容' }
  return { status: 'parsed', content, parser: extension === '.html' || extension === '.htm' ? 'html-text' : 'utf8' }
}
