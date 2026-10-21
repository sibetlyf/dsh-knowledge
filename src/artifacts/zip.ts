import { inflateRawSync } from 'node:zlib'

/**
 * Minimal, allocation-bounded ZIP reader for Office/ODF artifacts.
 *
 * Office files are ordinary ZIP containers. The artifact archiver only needs
 * a handful of XML members, so this reader walks the central directory instead
 * of adding a ZIP dependency. Every offset, size and method is validated before
 * use; Zip64, encryption and unsupported compression methods are rejected
 * instead of guessed.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

export interface ReadZipOptions {
  /** Keep only members accepted by this predicate; other members are skipped. */
  match?: (name: string) => boolean
  /** Maximum number of members read (default 256). */
  maxEntries?: number
  /** Maximum bytes any single member may inflate to (default 16 MiB). */
  maxEntryBytes?: number
  /** Maximum bytes all selected members may inflate to (default 32 MiB). */
  maxTotalBytes?: number
}

export function readZipEntries(buffer: Buffer, options: ReadZipOptions = {}): Map<string, Buffer> {
  const maxEntries = options.maxEntries ?? 256
  const maxEntryBytes = options.maxEntryBytes ?? 16 * 1024 * 1024
  const maxTotalBytes = options.maxTotalBytes ?? 32 * 1024 * 1024
  const result = new Map<string, Buffer>()
  if (buffer.length < 22) return result

  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) return result
  const total = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('Zip64 containers are not supported')
  }
  if (directoryOffset + directorySize > buffer.length) throw new Error('zip central directory is out of range')

  let totalBytes = 0
  let offset = directoryOffset
  for (let index = 0; index < total && result.size < maxEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('zip central directory entry is malformed')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) throw new Error('zip member name is out of range')
    const name = decodeName(buffer.subarray(nameStart, nameEnd), (flags & 0x0800) !== 0)
    offset = nameEnd + extraLength + commentLength
    if ((flags & 0x0001) !== 0) throw new Error('encrypted zip members are not supported')
    if (name.endsWith('/')) continue
    if (options.match !== undefined && !options.match(name)) continue
    if (uncompressedSize > maxEntryBytes) throw new Error(`zip member ${name} exceeds the size limit`)
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`zip local header for ${name} is malformed`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error(`zip member ${name} is truncated`)
    const compressed = buffer.subarray(dataStart, dataEnd)
    let data: Buffer
    if (method === 0) {
      data = Buffer.from(compressed)
    } else if (method === 8) {
      data = inflateRawSync(compressed, { maxOutputLength: maxEntryBytes })
    } else {
      throw new Error(`zip member ${name} uses unsupported compression method ${method}`)
    }
    if (uncompressedSize !== 0 && data.length !== uncompressedSize) {
      throw new Error(`zip member ${name} has an inconsistent size`)
    }
    totalBytes += data.length
    if (totalBytes > maxTotalBytes) throw new Error('zip members exceed the total size limit')
    result.set(name, data)
  }
  return result
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      const commentLength = buffer.readUInt16LE(offset + 20)
      if (offset + 22 + commentLength <= buffer.length) return offset
    }
  }
  return -1
}

function decodeName(bytes: Buffer, utf8: boolean): string {
  return bytes.toString(utf8 ? 'utf8' : 'latin1')
}
