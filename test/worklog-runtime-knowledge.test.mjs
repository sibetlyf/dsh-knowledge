import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/worklog-runtime.js'
import { Store } from '../worklog/store.js'

test('the shipped worklog bundle exposes knowledge recording and stores a source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'worklog-runtime-'))
  const databasePath = join(root, 'worklog.sqlite')
  const disposers = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: {
      async *stream() {},
      listProviders() { return [] },
      async listModels() { return [] },
      async resolveModelInfo(provider, model) { return { provider, id: model, name: model } },
    },
    connection: {},
    on() { return () => {} },
    inject() { return undefined },
    effect(factory) { disposers.push(factory()) },
  }
  const runtime = apply(ctx, { databasePath, current: () => ({ backend: 'local' }), onDispose() {} })
  assert.equal(typeof runtime.recordKnowledge, 'function')
  const accepted = runtime.recordKnowledge({
    id: 'document-1:2',
    title: '部署手册',
    summary: '知识库「默认知识库」已更新文档 部署手册--ab12.md。',
    project: '/project',
    sessionId: 'session-1',
    turn: 2,
    knowledgeBaseId: 'default',
    documentId: 'document-1',
    action: 'updated',
    route: { provider: 'mock', model: 'mock' },
  })
  assert.equal(accepted, true)

  const store = new Store(databasePath)
  try {
    const config = store.config()
    assert.equal(config.enabled, true)
    assert.ok(config.projects.includes('/project'))
    const records = store.db.prepare("SELECT day, project FROM records WHERE id='knowledge:document-1:2'").get()
    assert.ok(records)
    assert.equal(records.project, '/project')
    const body = store.db.prepare("SELECT body FROM records WHERE id='knowledge:document-1:2'").get()
    const record = JSON.parse(body.body)
    assert.equal(record.captureKind, 'knowledge')
    assert.match(record.user, /^知识库更新：部署手册/u)
    assert.deepEqual(record.route, { provider: 'mock', model: 'mock' })
  } finally {
    store.close()
  }

  for (const dispose of disposers.reverse()) await dispose()
  await rm(root, { recursive: true, force: true })
})
