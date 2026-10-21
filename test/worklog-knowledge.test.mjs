import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRefreshScheduler } from '../worklog/knowledge.js'
import { JournalService } from '../worklog/service.js'
import { Store } from '../worklog/store.js'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'worklog-knowledge-'))
  const store = new Store(join(root, 'worklog.sqlite'))
  t.after(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const service = new JournalService(store, {}, async () => [], () => ({ backend: 'local' }), async () => ({}))
  return { store, service }
}

function event(overrides = {}) {
  return {
    id: 'doc-1:2',
    title: '部署手册',
    summary: '知识库「默认知识库」已更新文档 部署手册--ab12.md。',
    project: '/project',
    sessionId: 'session-1',
    turn: 2,
    knowledgeBaseId: 'default',
    documentId: 'doc-1',
    action: 'updated',
    route: { provider: 'mock', model: 'mock' },
    ...overrides,
  }
}

test('a knowledge update provisions the worklog and records source material', async t => {
  const { store, service } = await fixture(t)
  const result = service.recordKnowledge(event())
  assert.ok(result)
  const config = store.config()
  assert.equal(config.enabled, true)
  assert.deepEqual(config.projects, ['/project'])
  assert.equal(config.scope, 'selected')
  assert.equal(config.scheduleEnabled, true)

  const records = store.records(result.day)
  assert.equal(records.length, 1)
  assert.equal(records[0].captureKind, 'knowledge')
  assert.match(records[0].user, /^知识库更新：部署手册/u)
  assert.match(records[0].answer, /部署手册--ab12\.md/u)
  assert.equal(records[0].project, '/project')
  assert.equal(records[0].sessionId, 'session-1')
  assert.equal(records[0].documentId, 'doc-1')
  assert.equal(records[0].action, 'updated')
  assert.deepEqual(records[0].route, { provider: 'mock', model: 'mock' })

  // Replaying the same document version is idempotent.
  assert.equal(service.recordKnowledge(event()).day, result.day)
  assert.equal(store.records(result.day).length, 1)
})

test('an explicitly excluded session is never recorded', async t => {
  const { store, service } = await fixture(t)
  store.configure({ ...store.config(), excludedSessions: ['session-1'] })
  assert.equal(service.recordKnowledge(event()), null)
})

test('a knowledge update expands an already enabled worklog to the affected project', async t => {
  const { store, service } = await fixture(t)
  store.configure({ ...store.config(), enabled: true, scope: 'selected', projects: ['/other'] })
  const result = service.recordKnowledge(event())
  assert.ok(result)
  assert.deepEqual([...store.config().projects].sort(), ['/other', '/project'])
  assert.equal(store.records(result.day).length, 1)
})

test('the debounced refresher enqueues a background report job', async t => {
  const { store, service } = await fixture(t)
  const result = service.recordKnowledge(event())
  assert.ok(result)
  const refresher = createRefreshScheduler(store, () => ({ backend: 'local' }), silent, 10)
  t.after(() => refresher.dispose())
  const before = store.db.prepare("SELECT count(*) AS n FROM jobs WHERE day=?").get(result.day).n
  refresher.schedule(result.day)
  await new Promise(resolve => setTimeout(resolve, 80))
  const jobs = store.db.prepare('SELECT status FROM jobs WHERE day=?').all(result.day)
  assert.equal(jobs.length, before + 1)
  assert.equal(jobs.at(-1).status, 'queued')
})

test('a manually edited report is never replaced by the automatic refresh', async t => {
  const { store, service } = await fixture(t)
  const result = service.recordKnowledge(event())
  assert.ok(result)
  const records = store.records(result.day)
  store.save(result.day, '# 手工日报\n\n已完成部署。', store.report(result.day).revision, records.map(record => record.id), true)
  const refresher = createRefreshScheduler(store, () => ({ backend: 'local' }), silent, 10)
  t.after(() => refresher.dispose())
  refresher.schedule(result.day)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM jobs WHERE day=?').get(result.day).n, 0)
  assert.match(store.report(result.day).markdown, /已完成部署/u)
})
