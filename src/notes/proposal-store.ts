import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { NoteProposal } from './mindmap-domain.js'
import type { NoteStore } from './store.js'

type SqlRow = Record<string, unknown>

export class NoteProposalStore {
  constructor(private readonly db: DatabaseSync) {
    this.init()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS note_proposals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_folder TEXT NOT NULL,
        content TEXT NOT NULL,
        mindmap_json TEXT NOT NULL,
        source_note_ids TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        review_note TEXT
      );
      CREATE INDEX IF NOT EXISTS note_proposals_status ON note_proposals(status, created_at DESC);
    `)
  }

  createProposal(params: {
    title: string
    kind?: NoteProposal['kind'] | undefined
    targetFolder: string
    content: string
    mindmapJson: string
    sourceNoteIds: string[]
  }): NoteProposal {
    const id = `prop_${randomUUID().replaceAll('-', '')}`
    const createdAt = new Date().toISOString()
    const kind = params.kind ?? 'auto_summary'
    const status = 'pending'

    this.db.prepare(`
      INSERT INTO note_proposals (id, title, kind, target_folder, content, mindmap_json, source_note_ids, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.title,
      kind,
      params.targetFolder,
      params.content,
      params.mindmapJson,
      JSON.stringify(params.sourceNoteIds),
      status,
      createdAt,
    )

    return {
      id,
      title: params.title,
      kind,
      targetFolder: params.targetFolder,
      content: params.content,
      mindmapJson: params.mindmapJson,
      sourceNoteIds: params.sourceNoteIds,
      status,
      createdAt,
      reviewedAt: undefined,
      reviewNote: undefined,
    }
  }

  listProposals(status?: NoteProposal['status'] | undefined): NoteProposal[] {
    const query = status
      ? 'SELECT * FROM note_proposals WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM note_proposals ORDER BY created_at DESC'
    const rows = (status ? this.db.prepare(query).all(status) : this.db.prepare(query).all()) as SqlRow[]
    return rows.map(mapProposal)
  }

  getProposal(id: string): NoteProposal | undefined {
    const row = this.db.prepare('SELECT * FROM note_proposals WHERE id = ?').get(id) as SqlRow | undefined
    return row ? mapProposal(row) : undefined
  }

  async approveProposal(id: string, noteStore: NoteStore, reviewNote?: string | undefined): Promise<{ proposal: NoteProposal; documentId: string }> {
    const proposal = this.getProposal(id)
    if (!proposal) throw new Error(`草案 ${id} 不存在`)
    if (proposal.status !== 'pending') throw new Error(`草案 ${id} 已处于 ${proposal.status} 状态，无法重复审批`)

    // 1. 查找或创建目标文件夹
    let folderId: string | null = null
    if (proposal.targetFolder && proposal.targetFolder.trim().length > 0) {
      const folders = noteStore.list({ kind: 'folder' })
      const existingFolder = folders.find(f => f.name === proposal.targetFolder)
      if (existingFolder) {
        folderId = existingFolder.id
      } else {
        const createdFolder = await noteStore.createFolder(proposal.targetFolder)
        folderId = createdFolder.id
      }
    }

    // 2. 在目标目录创建整理后的 Markdown 笔记
    const docName = proposal.title.endsWith('.md') ? proposal.title : `${proposal.title}.md`
    const createdDoc = await noteStore.createDocument(docName, folderId, proposal.content)

    // 3. 更新草案状态
    const reviewedAt = new Date().toISOString()
    this.db.prepare(`
      UPDATE note_proposals
      SET status = 'approved', reviewed_at = ?, review_note = ?
      WHERE id = ?
    `).run(reviewedAt, reviewNote ?? null, id)

    return {
      proposal: {
        ...proposal,
        status: 'approved',
        reviewedAt,
        reviewNote,
      },
      documentId: createdDoc.id,
    }
  }

  rejectProposal(id: string, reviewNote?: string | undefined): NoteProposal {
    const proposal = this.getProposal(id)
    if (!proposal) throw new Error(`草案 ${id} 不存在`)
    if (proposal.status !== 'pending') throw new Error(`草案 ${id} 已处于 ${proposal.status} 状态，无法操作`)

    const reviewedAt = new Date().toISOString()
    this.db.prepare(`
      UPDATE note_proposals
      SET status = 'rejected', reviewed_at = ?, review_note = ?
      WHERE id = ?
    `).run(reviewedAt, reviewNote ?? null, id)

    return {
      ...proposal,
      status: 'rejected',
      reviewedAt,
      reviewNote,
    }
  }
}

function mapProposal(row: SqlRow): NoteProposal {
  let sourceNoteIds: string[] = []
  try {
    sourceNoteIds = JSON.parse(String(row.source_note_ids))
  } catch {
    sourceNoteIds = []
  }
  return {
    id: String(row.id),
    title: String(row.title),
    kind: String(row.kind) as NoteProposal['kind'],
    targetFolder: String(row.target_folder),
    content: String(row.content),
    mindmapJson: String(row.mindmap_json),
    sourceNoteIds,
    status: String(row.status) as NoteProposal['status'],
    createdAt: String(row.created_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : undefined,
    reviewNote: row.review_note ? String(row.review_note) : undefined,
  }
}
