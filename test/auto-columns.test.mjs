import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExtractionCoordinator } from '../lib/extraction.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const userText = '把数据库备份的做法记下来，下次直接用'
const assistantText = '每天 02:00 全量备份，保留 14 天，并在恢复演练后再清理旧备份。'

function sessionFor(id) {
  return {
    id,
    header: { cwd: '/project' },
    snapshotEvents() {
      return [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] } },
        { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: assistantText }] } } },
      ]
    },
  }
}

function candidate(newKnowledgeBase, documentTitle) {
  return {
    action: 'create',
    ...newKnowledgeBase === undefined ? { knowledgeBaseId: 'default' } : { newKnowledgeBase },
    group: '备份恢复',
    documentTitle,
    body: `${documentTitle} 的流程：每天 02:00 全量备份，保留 14 天。`,
    type: 'procedure',
    tags: ['mysql'],
    scope: { kind: 'project', id: '/project' },
    confidence: 0.97,
    retention: { durable: true, evidence: 'explicit' },
    reason: '可复用运维流程',
  }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-auto-columns-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  await provider.upsertMount({
    targetKind: 'project', targetId: '/project', knowledgeBaseId: 'default',
    enabled: true, recallEnabled: true, writeMode: 'direct', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  const events = []
  const coordinator = new ExtractionCoordinator(
    { logger: { debug() {}, info() {}, warn() {}, error() {} }, llm: { stream: options.stream } },
    provider,
    {
      extractionMaxInputChars: 20000, extractionMaxTokens: 1000, extractionTimeoutMs: 5000,
      defaultScope: 'project', autoCreateKnowledgeBases: options.autoCreateKnowledgeBases ?? true,
    },
    () => undefined,
    event => events.push(event),
  )
  t.after(() => coordinator.close())
  return { provider, coordinator, events }
}

test('extraction creates a new knowledge column and writes the document directly', async t => {
  let requests = 0
  const { provider, coordinator, events } = await fixture(t, {
    async *stream() {
      requests += 1
      yield { type: 'text-delta', text: JSON.stringify({ candidates: [candidate({ name: '数据库运维', description: '数据库备份、恢复与运维经验' }, 'MySQL 备份策略')] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const result = await coordinator.run(sessionFor('auto-column-run'), 1, new AbortController().signal)
  assert.equal(result.status, 'completed')
  assert.equal(result.directCount, 1)
  assert.equal(requests, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].title, 'MySQL 备份策略')
  assert.equal(events[0].action, 'created')
  assert.equal(events[0].project, '/project')
  assert.equal(events[0].sessionId, 'auto-column-run')
  assert.equal(events[0].route.provider, 'mock')

  const bases = await provider.listKnowledgeBases()
  const created = bases.find(base => base.name === '数据库运维')
  assert.ok(created, 'a new knowledge column must be created')
  assert.equal(created.description, '数据库备份、恢复与运维经验')

  const mounts = await provider.listMounts('project', '/project')
  const mount = mounts.find(item => item.knowledgeBaseId === created.id)
  assert.ok(mount, 'the new column must be mounted on the project')
  assert.equal(mount.writeMode, 'direct')
  assert.equal(mount.recallEnabled, true)

  const entries = await provider.list({ knowledgeBaseId: created.id, limit: 10 })
  assert.equal(entries.items.length, 1)
  assert.equal(entries.items[0].title, 'MySQL 备份策略')
  assert.equal(entries.items[0].group, '备份恢复')
})

test('an existing column with the same name is reused instead of duplicated', async t => {
  let title = 'MySQL 备份策略'
  const { provider, coordinator } = await fixture(t, {
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ candidates: [candidate({ name: '数据库运维', description: '数据库备份、恢复与运维经验' }, title)] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  await coordinator.run(sessionFor('auto-column-reuse-1'), 1, new AbortController().signal)
  await provider.resetExtraction('auto-column-reuse-1:1')
  title = 'MySQL 恢复演练'
  await coordinator.run(sessionFor('auto-column-reuse-2'), 1, new AbortController().signal)
  const bases = (await provider.listKnowledgeBases()).filter(base => base.name === '数据库运维')
  assert.equal(bases.length, 1)
  const mounts = (await provider.listMounts('project', '/project')).filter(item => item.knowledgeBaseId === bases[0].id)
  assert.equal(mounts.length, 1)
  assert.equal((await provider.list({ knowledgeBaseId: bases[0].id, limit: 10 })).items.length, 2)
})

test('auto-created columns are disabled by configuration', async t => {
  const { provider, coordinator } = await fixture(t, {
    autoCreateKnowledgeBases: false,
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ candidates: [candidate({ name: '数据库运维', description: '数据库运维' }, 'MySQL 备份策略')] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const result = await coordinator.run(sessionFor('auto-column-off'), 1, new AbortController().signal)
  assert.equal(result.candidateCount, 0)
  assert.equal((await provider.listKnowledgeBases()).some(base => base.name === '数据库运维'), false)
})
