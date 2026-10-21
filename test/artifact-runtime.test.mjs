import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, LocalKnowledgeProvider } from '../lib/index.js'

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${label}`)
}

test('a completed turn archives presented deliverables into the knowledge base without review', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifact-runtime-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'summary.md'), '# 交付摘要\n\n自动归档验收。\n', 'utf8')
  await writeFile(join(workspace, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]))
  await writeFile(join(workspace, 'changed.txt'), 'shell 生成的变更文件\n', 'utf8')
  const databasePath = join(root, 'knowledge.sqlite')
  const listeners = new Map()
  const preStepListeners = []
  const disposers = []
  const uploaded = {
    readFileStream: async function* () { yield Buffer.from('区域,销量\n华东,10\n', 'utf8') },
    readImage: async () => ({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), ref: { mediaType: 'image/png' } }),
  }
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: {
      async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
      async listProviders() { return [] },
      async listModels() { return [] },
      async resolveModelInfo(provider, model) { return { provider, id: model, name: model } },
    },
    tools: { register() { return () => {} } },
    on(name, listener) {
      if (name === 'agent/pre-step') preStepListeners.push(listener)
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    effect(factory) { disposers.push(factory()) },
    get(name) {
      if (name === 'attachments') return uploaded
      if (name === 'workspaceChanges') return { summary: () => ({ files: [{ path: 'changed.txt' }] }) }
      return undefined
    },
  }
  apply(ctx, {
    backend: 'local', databasePath, remoteTimeoutMs: 5000, exposeApi: false,
    apiPrefix: '/knowledge-api/v1', extractionEnabled: false, defaultScope: 'project',
    artifactArchivePath: join(root, 'archives'),
    artifactArchiveEnabled: true,
    artifactArchiveBaseName: '制品归档',
  })
  t.after(async () => {
    await observer.close()
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  })
  const observer = new LocalKnowledgeProvider(databasePath)

  const session = {
    id: 'session-artifacts',
    header: { cwd: workspace },
    snapshotEvents() { return this.events },
    events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1,
        data: {
          id: 'u1', role: 'user', source: { kind: 'user' },
          content: [
            { type: 'text', text: '请处理这些附件' },
            { type: 'file', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: '销售.csv', bytes: 24 } },
            { type: 'image', attachment: { attachmentId: `sha256:${'b'.repeat(64)}`, name: '趋势.png', mediaType: 'image/png', bytes: 4 } },
          ],
        },
      },
      {
        type: 'tool/call', seq: 2,
        data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'summary.md', content: '# 交付摘要' }) },
      },
      {
        type: 'deliverables/presented', seq: 3,
        data: { turn: 1, callId: 'c2', files: [{ path: 'summary.md', description: '交付摘要' }, { path: 'chart.png' }] },
      },
      { type: 'workspace/changes', seq: 4, data: { turn: 1 } },
    ],
  }
  await listeners.get('agent/turn-stopping')({ agent: { session }, turn: 1, signal: new AbortController().signal })

  const hit = await waitFor(async () => {
    const bases = await observer.listKnowledgeBases()
    const base = bases.find(item => item.name === '制品归档')
    if (base === undefined) return undefined
    const index = await observer.listDocumentIndex({ knowledgeBaseIds: [base.id], query: 'summary', limit: 10 })
    const document = index.items.find(item => item.title.includes('summary.md'))
    return document === undefined ? undefined : { base, document }
  }, 'archived deliverable')
  assert.match(hit.document.title, /summary\.md/u)

  const entry = await observer.get(hit.document.id)
  assert.match(entry.body, /关键词：/u)
  assert.match(entry.body, /(自动|归档|验收)/u)
  assert.match(entry.body, /文件路径：`/u)
  assert.match(entry.body, /交付摘要/u)
  assert.deepEqual(entry.scope, { kind: 'project', id: workspace })
  const mounts = await observer.listMounts('project', workspace)
  assert.equal(mounts.some(mount => mount.knowledgeBaseId === hit.base.id && mount.recallEnabled), true)
  const candidates = await observer.listCandidates('pending', 10)
  assert.equal(candidates.length, 0, 'auto archival must not create review candidates')

  const image = await waitFor(async () => {
    const index = await observer.listDocumentIndex({ knowledgeBaseIds: [hit.base.id], query: 'chart', limit: 10 })
    return index.items.find(item => item.title.includes('chart.png'))
  }, 'archived image')
  const imageEntry = await observer.get(image.id)
  assert.match(imageEntry.body, /类型：image\/png/u)

  const upload = await waitFor(async () => {
    const index = await observer.listDocumentIndex({ knowledgeBaseIds: [hit.base.id], query: '销售', limit: 10 })
    return index.items.find(item => item.title.includes('销售.csv'))
  }, 'archived upload')
  const uploadEntry = await observer.get(upload.id)
  assert.match(uploadEntry.title, /用户上传\/销售\.csv/u)
  assert.match(uploadEntry.body, /关键词：/u)
  assert.match(uploadEntry.body, /(华东|销量|区域)/u)
  assert.match(uploadEntry.body, /用户上传附件/u)
  assert.equal(uploadEntry.tags.includes('upload'), true)

  const changed = await waitFor(async () => {
    const index = await observer.listDocumentIndex({ knowledgeBaseIds: [hit.base.id], query: 'changed', limit: 10 })
    return index.items.find(item => item.title.includes('changed.txt'))
  }, 'archived workspace change')
  const changedEntry = await observer.get(changed.id)
  assert.match(changedEntry.body, /关键词：/u)
  assert.match(changedEntry.body, /(变更|生成|shell)/u)
  assert.match(changedEntry.body, /任务中变更的文件/u)

  // The first model step of a turn provisions a writable mount when the
  // project had none, so completed-turn write-back is never blocked.
  for (const listener of preStepListeners) {
    await listener(
      { agent: { session }, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
  }
  const projectMounts = await observer.listMounts('project', workspace)
  const defaultMount = projectMounts.find(mount => mount.knowledgeBaseId === 'default')
  assert.ok(defaultMount, 'a writable default mount must be provisioned')
  assert.equal(defaultMount.enabled, true)
  assert.equal(defaultMount.recallEnabled, true)
  assert.equal(defaultMount.writeMode, 'direct')
})
