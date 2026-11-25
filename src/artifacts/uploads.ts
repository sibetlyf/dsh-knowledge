import { readFile } from 'node:fs/promises'
import type { ResolvedUpload } from './archive.js'
import type { ArtifactUploadCandidate } from './collect.js'

/** Minimal structural view of the Host `attachments` service. */
export interface AttachmentStoreLike {
  fileHostPath?(ref: unknown): string | undefined
  imageHostPath?(ref: unknown): string | undefined
  readFileStream?(ref: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array>
  readImage?(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array; ref?: { mediaType?: string } }>
}

export interface UploadReaderOptions {
  /** Resolved Host services; read lazily so plugin activation never depends on them. */
  get(name: string): unknown
  /** Upper bound on bytes buffered for one upload. */
  maxBytes: number
  logger: { warn(message: string): void }
}

/**
 * Read one uploaded attachment into memory for archiving.
 *
 * Uploads live in the Host attachment store, not in the workspace, so they are
 * resolved through the `attachments` service instead of a filesystem path.
 * File streams are verified by the service; images are normalized on admission
 * and therefore archive the normalized bytes that history references.
 */
export function createUploadReader(options: UploadReaderOptions): (upload: ArtifactUploadCandidate) => Promise<ResolvedUpload | undefined> {
  return async (upload: ArtifactUploadCandidate): Promise<ResolvedUpload | undefined> => {
    const store = options.get('attachments') as AttachmentStoreLike | undefined
    if (store === undefined) return undefined
    try {
      if (upload.kind === 'image') {
        if (typeof store.readImage !== 'function') return undefined
        const stored = await store.readImage(upload.ref)
        const mediaType = stored.ref?.mediaType ?? upload.mediaType
        return {
          name: upload.name,
          bytes: Buffer.from(stored.data),
          ...mediaType === undefined ? {} : { mediaType },
        }
      }
      if (typeof store.readFileStream === 'function') {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of store.readFileStream(upload.ref)) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > options.maxBytes) {
            options.logger.warn(`dsh-knowledge: 上传附件 ${upload.name} 超过归档大小上限，已跳过`)
            return undefined
          }
          chunks.push(buffer)
        }
        return { name: upload.name, bytes: Buffer.concat(chunks) }
      }
      if (typeof store.fileHostPath === 'function') {
        const path = store.fileHostPath(upload.ref)
        return path === undefined ? undefined : { name: upload.name, bytes: await readFile(path) }
      }
      return undefined
    } catch (error) {
      options.logger.warn(`dsh-knowledge: 读取上传附件 ${upload.name} 失败: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}
