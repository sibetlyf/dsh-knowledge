import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createKnowledgeWatcher } from '../lib/knowledge-watcher.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

test('the knowledge watcher records changed documents and ignores status-only bumps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-watcher-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const events = []
  const watcher = createKnowledgeWatcher({
    provider,
    emit: event => events.push(event),
    intervalMs: 5000,
    logger: { warn() {} },
  })
  t.after(async () => {
    watcher.stop()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  const created = await provider.create({
    group: '测试分组', knowledgeBaseId: 'default', title: '部署手册', body: '第一版部署步骤。',
    type: 'procedure', tags: [], scope: { kind: 'project', id: '/project' }, confidence: 0.9,
  })
  await watcher.poll()
  assert.equal(events.length, 0, 'the first pass only baselines existing documents')

  await provider.update(created.id, { ...created, body: '第二版部署步骤。' })
  await watcher.poll()
  assert.equal(events.length, 1)
  assert.equal(events[0].action, 'updated')
  assert.equal(events[0].title, '部署手册')
  assert.equal(events[0].project, '/project')
  assert.equal(events[0].id, `${created.id}:2`)

  const second = await provider.create({
    group: '测试分组', knowledgeBaseId: 'default', title: '回滚步骤', body: '回滚到上一版本。',
    type: 'procedure', tags: [], scope: { kind: 'project', id: '/project' }, confidence: 0.9,
  })
  await watcher.poll()
  assert.equal(events.length, 2)
  assert.equal(events[1].action, 'created')
  assert.equal(events[1].id, `${second.id}:1`)

  // Finalizing bumps the version but preserves the body; it is not a content update.
  await provider.finalize(second.id, 'resolved', '已确认完成')
  await watcher.poll()
  assert.equal(events.length, 2)

  // Archiving removes the entry from the active page and must not emit.
  await provider.archive(created.id)
  await watcher.poll()
  assert.equal(events.length, 2)
})

test('global-scope documents are reported without a project (the journal then skips them)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-watcher-global-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const events = []
  const watcher = createKnowledgeWatcher({ provider, emit: event => events.push(event), intervalMs: 5000 })
  t.after(async () => {
    watcher.stop()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  const entry = await provider.create({
    group: '测试分组', knowledgeBaseId: 'default', title: '通用约定', body: '日志保留 30 天。',
    type: 'fact', tags: [], scope: { kind: 'global' }, confidence: 0.9,
  })
  await watcher.poll()
  await provider.update(entry.id, { ...entry, body: '日志保留 60 天。' })
  await watcher.poll()
  assert.equal(events.length, 1)
  assert.equal(events[0].project, undefined)
  assert.equal(events[0].action, 'updated')
})
