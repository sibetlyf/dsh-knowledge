import { inflateSync } from 'node:zlib'

/**
 * 健壮纯 TS PDF 文本抽取器
 * 支持 FlateDecode 解压、UTF-16BE 编码、八进制与常见转义符解析、TJ/Tj 操作符提取。
 */
export function extractPdfText(buffer: Buffer): string {
  if (!buffer || buffer.length === 0) return ''
  // 校验 PDF 标识
  const header = buffer.subarray(0, 1024).toString('latin1')
  if (!header.includes('%PDF-')) {
    throw new Error('无效的 PDF 文件：缺少 %PDF- 文件头')
  }

  const textChunks: string[] = []
  const data = buffer

  // 1. 查找所有 stream ... endstream
  let streamSearchPos = 0
  while (streamSearchPos < data.length) {
    const streamIndex = findSubarray(data, Buffer.from('stream'), streamSearchPos)
    if (streamIndex === -1) break

    // 跳过 'stream' 后的 \r\n 或 \n
    let contentStart = streamIndex + 6
    if (contentStart < data.length && data[contentStart] === 0x0d) contentStart++ // \r
    if (contentStart < data.length && data[contentStart] === 0x0a) contentStart++ // \n

    const endStreamIndex = findSubarray(data, Buffer.from('endstream'), contentStart)
    if (endStreamIndex === -1) break

    // 检查 stream 前面是否带有 /FlateDecode 描述
    const dictHeaderRange = data.subarray(Math.max(0, streamIndex - 300), streamIndex).toString('latin1')
    const isFlate = dictHeaderRange.includes('/FlateDecode') || dictHeaderRange.includes('/Fl')

    let rawStream = data.subarray(contentStart, endStreamIndex)
    // 去除末尾多余的 \r 或 \n
    while (rawStream.length > 0 && (rawStream[rawStream.length - 1] === 0x0d || rawStream[rawStream.length - 1] === 0x0a)) {
      rawStream = rawStream.subarray(0, rawStream.length - 1)
    }

    let decodedText = ''
    if (isFlate) {
      try {
        const decompressed = inflateSync(rawStream)
        decodedText = decompressed.toString('latin1')
      } catch {
        // 如果无法解压，尝试直接转为字符串提取
        decodedText = rawStream.toString('latin1')
      }
    } else {
      decodedText = rawStream.toString('latin1')
    }

    // 从解压后的内容中解析文本
    const extracted = parsePdfStreamText(decodedText)
    if (extracted.trim().length > 0) {
      textChunks.push(extracted.trim())
    }

    streamSearchPos = endStreamIndex + 9
  }

  return textChunks.join('\n\n')
}

/** 查找子 Buffer 偏移 */
function findSubarray(source: Buffer, target: Buffer, start: number): number {
  return source.indexOf(target, start)
}

/** 解析 PDF 指令流中的文本操作符 (BT ... ET, Tj, TJ) */
function parsePdfStreamText(streamContent: string): string {
  const result: string[] = []
  // 匹配 BT ... ET 文本块
  const btRegex = /BT[\s\S]*?ET/g
  let match: RegExpExecArray | null

  while ((match = btRegex.exec(streamContent)) !== null) {
    const block = match[0]
    const blockText: string[] = []

    // 匹配 TJ 数组: [ (text1) -10 (text2) ] TJ 或 [ <hex1> <hex2> ] TJ
    const tjArrayRegex = /\[([\s\S]*?)\]\s*TJ/g
    let tjMatch: RegExpExecArray | null
    while ((tjMatch = tjArrayRegex.exec(block)) !== null) {
      const arrayContent = tjMatch[1] ?? ''
      const items = parseTjArray(arrayContent)
      if (items.length > 0) blockText.push(items)
    }

    // 匹配单个 Tj: (text) Tj 或 <hex> Tj
    const tjSingleRegex = /(\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>)\s*Tj/g
    let singleMatch: RegExpExecArray | null
    while ((singleMatch = tjSingleRegex.exec(block)) !== null) {
      const raw = singleMatch[1] ?? ''
      const text = decodePdfString(raw)
      if (text.length > 0) blockText.push(text)
    }

    if (blockText.length > 0) {
      result.push(blockText.join(' '))
    }
  }

  return result.join('\n')
}

/** 解析 [ (str) 10 (str2) ] TJ 数组 */
function parseTjArray(content: string): string {
  const pieces: string[] = []
  const itemRegex = /(\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>)/g
  let m: RegExpExecArray | null
  while ((m = itemRegex.exec(content)) !== null) {
    const raw = m[1] ?? ''
    const decoded = decodePdfString(raw)
    if (decoded) pieces.push(decoded)
  }
  return pieces.join('')
}

/** 解码 PDF 字符串，支持 (literal) 与 <hex> */
function decodePdfString(raw: string): string {
  if (!raw) return ''
  const trimmed = raw.trim()

  // 1. 十六进制字符串 <...>
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    const hex = trimmed.slice(1, -1).replace(/\s+/g, '')
    const padded = hex.length % 2 !== 0 ? hex + '0' : hex
    const buf = Buffer.from(padded, 'hex')
    // 检查是否为 UTF-16BE BOM
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      return buf.subarray(2).swap16().toString('utf16le')
    }
    // 尝试作为 utf8 或 latin1
    return buf.toString('utf8')
  }

  // 2. 字面量字符串 (...)
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const inner = trimmed.slice(1, -1)
    const unescaped = unescapePdfLiteral(inner)
    // 检查 UTF-16BE BOM (0xFE 0xFF)
    if (unescaped.length >= 2 && unescaped.charCodeAt(0) === 0xfe && unescaped.charCodeAt(1) === 0xff) {
      const buf = Buffer.from(unescaped, 'latin1')
      return buf.subarray(2).swap16().toString('utf16le')
    }
    return unescaped
  }

  return ''
}

/** 反转义 PDF 字符 */
function unescapePdfLiteral(str: string): string {
  return str.replace(/\\([0-7]{1,3}|[nrtbf()\\])/g, (_, match) => {
    switch (match) {
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      case 'b': return '\b'
      case 'f': return '\f'
      case '(': return '('
      case ')': return ')'
      case '\\': return '\\'
      default:
        // 八进制
        return String.fromCharCode(parseInt(match, 8))
    }
  })
}
