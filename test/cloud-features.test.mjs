import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TeamStore } from '../cloud/team-store.mjs'
import { extractText } from '../cloud/ingest.mjs'

test('text-like files are indexed and unsupported files remain downloadable', () => {
  const markdown = extractText({ name: 'guide.md', mime: 'text/markdown', bytes: Buffer.from('# 发布流程\n\n发布前必须审批。') })
  assert.equal(markdown.status, 'parsed')
  assert.match(markdown.content, /发布流程/u)
  const pdf = extractText({ name: 'guide.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7') })
  assert.equal(pdf.status, 'unsupported')
  assert.match(pdf.error, /仍可下载/u)
})

test('file full-text search and wiki version/restore work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cloud-test-'))
  const store = new TeamStore(join(dir, 'team.sqlite'))
  try {
    const fileId = randomUUID()
    const now = new Date().toISOString()
    store.addFile({ id: fileId, baseId: 'default', name: '发布规范.md', mime: 'text/markdown', size: 30, sha256: 'a'.repeat(32), storagePath: 'files/x', sourceKey: 'alice/发布规范.md', userName: 'alice' })
    store.setFileText({ fileId, baseId: 'default', status: 'parsed', content: '发布前必须经过测试和审批。', parser: 'utf8', name: '发布规范.md' })
    const hits = store.searchFileText('default', '发布')
    assert.equal(hits.length, 1)
    assert.match(hits[0].snippet, /发布前/u)

    const page = store.createWikiPage({ baseId: 'default', slug: 'release', title: '发布 Wiki', content: 'v1 内容', createdBy: 'admin', sources: [{ kind: 'file', sourceId: fileId, title: '发布规范.md' }] })
    assert.equal(page.version, 1)
    const published = store.publishWikiPage(page.id, 'admin')
    assert.equal(published.status, 'published')
    assert.equal(published.version, 2)
    const restored = store.restoreWikiVersion(page.id, 1, 'admin')
    assert.equal(restored.content, 'v1 内容')
    assert.equal(restored.version, 3)
    assert.ok(store.listWikiVersions(page.id).length >= 3)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
