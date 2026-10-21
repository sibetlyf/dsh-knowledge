import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertKnowledgeBrowserRequest } from './api.js'
import type { ArtifactArchiveStatus } from './artifacts/archive.js'
import type { RuntimeContextLike } from './runtime.js'

export const BACKGROUND_STATUS_PATH = '/knowledge-control/v1/background-status'

export interface BackgroundStatusSources {
  archive(): ArtifactArchiveStatus
  writeback(): { queued: number; running: number; failed: number }
  worklog?(): boolean
  enabled(): { archive: boolean; writeback: boolean; worklog: boolean; approvals: boolean }
}

export interface BackgroundStatus {
  updatedAt: number
  enabled: ReturnType<BackgroundStatusSources['enabled']>
  archive: ArtifactArchiveStatus
  writeback: { queued: number; running: number; failed: number }
  worklog: { running: boolean }
}

/** Read-only, same-origin snapshot behind the console's background activity card. */
export function registerBackgroundStatusControl(ctx: RuntimeContextLike, sources: BackgroundStatusSources): () => void {
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContextLike['webServer']
  if (webServer === undefined) throw new Error('background status requires the DSH webServer service')
  return webServer.register({
    kind: 'prefix',
    path: BACKGROUND_STATUS_PATH,
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET')
          throw httpError(405, '后台状态只支持读取。')
        }
        assertKnowledgeBrowserRequest(req, 'management-web')
        return sendJson(res, 200, {
          updatedAt: Date.now(),
          enabled: sources.enabled(),
          archive: sources.archive(),
          writeback: sources.writeback(),
          worklog: { running: sources.worklog?.() ?? false },
        } satisfies BackgroundStatus)
      } catch (error) {
        const status = error !== null && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
          ? (error as { status: number }).status : 500
        sendJson(res, status, { error: status >= 500 ? '读取后台状态失败。' : error instanceof Error ? error.message : '请求无效。' })
      }
    },
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

export type { IncomingMessage, ServerResponse }
