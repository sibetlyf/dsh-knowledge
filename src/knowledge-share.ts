// 知识文档只读分享：令牌只保存摘要无关的随机值；正文实时读取当前文档，
// 文档更新后链接仍有效，撤销后立即失效。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

export type KnowledgeShareKind = 'document' | 'worklog'

export interface KnowledgeShare {
  token: string
  kind: KnowledgeShareKind
  id: string
  title: string
  createdAt: number
}

const MAX_SHARES = 500
const TOKEN_RE = /^ks_[A-Za-z0-9_-]{32,64}$/u

function isShare(value: unknown): value is KnowledgeShare {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.token === 'string' && TOKEN_RE.test(row.token)
    && (row.kind === 'document' || row.kind === 'worklog')
    && typeof row.id === 'string' && row.id.length > 0
    && typeof row.title === 'string'
    && Number.isFinite(row.createdAt)
}

export class KnowledgeShareStore {
  private readonly path: string
  private rows: KnowledgeShare[] | undefined

  constructor(databasePath: string) {
    const base = databasePath === ':memory:' ? join(process.cwd(), '.knowledge-shares') : databasePath
    this.path = join(dirname(base), 'knowledge-shares.json')
  }

  private async load(): Promise<KnowledgeShare[]> {
    if (this.rows) return this.rows
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      const rows = Array.isArray(value) ? value.filter(isShare) : []
      this.rows = rows.slice(-MAX_SHARES)
    } catch {
      this.rows = []
    }
    return this.rows
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(this.rows ?? [], null, 2), 'utf8')
    await rename(tmp, this.path)
  }

  async list(): Promise<KnowledgeShare[]> {
    return [...await this.load()].sort((a, b) => b.createdAt - a.createdAt)
  }

  async get(token: string): Promise<KnowledgeShare | undefined> {
    if (!TOKEN_RE.test(token)) return undefined
    return (await this.load()).find(row => row.token === token)
  }

  async create(id: string, title: string, kind: KnowledgeShareKind = 'document'): Promise<KnowledgeShare> {
    const rows = await this.load()
    const existing = rows.find(row => row.kind === kind && row.id === id)
    if (existing) return existing
    if (rows.length >= MAX_SHARES) throw Object.assign(new Error('分享数量已达上限'), { status: 409 })
    const share: KnowledgeShare = {
      token: `ks_${randomBytes(24).toString('base64url')}`,
      kind,
      id,
      title: title.slice(0, 200),
      createdAt: Date.now(),
    }
    rows.push(share)
    await this.flush()
    return share
  }

  async revoke(token: string): Promise<boolean> {
    const rows = await this.load()
    const index = rows.findIndex(row => row.token === token)
    if (index < 0) return false
    rows.splice(index, 1)
    await this.flush()
    return true
  }
}
