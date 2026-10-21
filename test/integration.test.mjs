import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createKnowledgeIntegration, createKnowledgeWriteBus } from '../lib/integration.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

test('the integration service creates records, emits one write event and exposes bases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-integration-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const emitted = []
  const bus = createKnowledgeWriteBus({ emit(name, payload) { emitted.push({ name, payload }) } })
  const integration = createKnowledgeIntegration({ provider, bus })
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })

  const seen = []
  const unsubscribe = integration.onWrite(event => seen.push(event))
  const entry = await integration.ingestRecord({
    title: '会议结论', body: '决定采用新的缓存策略。', tags: ['会议'], group: '会议记录',
  })
  assert.equal(entry.title, '会议结论')
  assert.equal(entry.tags.includes('integration'), true)
  assert.equal(entry.group, '会议记录')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].documentId, entry.id)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].name, 'knowledge/write')
  unsubscribe()
  await integration.ingestRecord({ title: '第二条', body: '内容', knowledgeBaseId: 'default' })
  assert.equal(seen.length, 1, 'unsubscribed listeners are not called')

  const bases = await integration.listBases()
  assert.ok(bases.some(base => base.id === 'default'))
  const introduced = await integration.introduceBase('session-1', 'default')
  assert.equal(introduced.base.id, 'default')
  const mounts = await provider.listMounts('session', 'session-1')
  assert.equal(mounts.some(mount => mount.knowledgeBaseId === 'default' && mount.writeMode === 'none'), true)
  await assert.rejects(() => integration.ingestFiles(['/tmp/file.txt']), /disabled/u)
})
