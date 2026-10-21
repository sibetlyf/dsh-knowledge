import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWritableMountGuard } from '../lib/auto-writable.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const silent = { info() {}, warn() {} }
const project = '/workspace/demo'
const agent = { session: { id: 'session-writable', header: { cwd: project }, snapshotEvents: () => [] } }

async function withProvider(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-writable-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => {
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  return provider
}

test('provisions a writable default mount when the project has none', async t => {
  const provider = await withProvider(t)
  const guard = createWritableMountGuard(provider, { mode: 'direct', logger: silent })
  await guard(agent)
  let mounts = await provider.listMounts('project', project)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].knowledgeBaseId, 'default')
  assert.equal(mounts[0].writeMode, 'direct')
  assert.equal(mounts[0].enabled, true)
  assert.equal(mounts[0].recallEnabled, true)

  await guard(agent)
  mounts = await provider.listMounts('project', project)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].writeMode, 'direct')
})

test('keeps an existing writable mount instead of adding the default base', async t => {
  const provider = await withProvider(t)
  const team = await provider.createKnowledgeBase({
    name: 'Team notes', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative',
  })
  await provider.upsertMount({
    targetKind: 'project', targetId: project, knowledgeBaseId: team.id,
    enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  await createWritableMountGuard(provider, { mode: 'direct', logger: silent })(agent)
  const mounts = await provider.listMounts('project', project)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].knowledgeBaseId, team.id)
  assert.equal(mounts[0].writeMode, 'audit')
})

test('respects an explicitly disabled default mount', async t => {
  const provider = await withProvider(t)
  await provider.upsertMount({
    targetKind: 'project', targetId: project, knowledgeBaseId: 'default',
    enabled: false, recallEnabled: false, writeMode: 'none', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  await createWritableMountGuard(provider, { mode: 'direct', logger: silent })(agent)
  const mounts = await provider.listMounts('project', project)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].enabled, false)
  assert.equal(mounts[0].writeMode, 'none')
})

test('respects a recall-only default mount', async t => {
  const provider = await withProvider(t)
  await provider.upsertMount({
    targetKind: 'project', targetId: project, knowledgeBaseId: 'default',
    enabled: true, recallEnabled: true, writeMode: 'none', includeTags: [], excludeTags: [], extractionInstructions: '',
  })
  await createWritableMountGuard(provider, { mode: 'direct', logger: silent })(agent)
  const mounts = await provider.listMounts('project', project)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].writeMode, 'none')
})

test('re-checks after a provider connection revision changes', async t => {
  const provider = await withProvider(t)
  let revision = 0
  const guard = createWritableMountGuard(provider, { mode: 'audit', logger: silent, revision: () => revision })
  await guard(agent)
  const [mount] = await provider.listMounts('project', project)
  assert.equal(mount.writeMode, 'audit')
  await provider.deleteMount(mount.id)
  await guard(agent)
  assert.equal((await provider.listMounts('project', project)).length, 0, 'the same revision stays cached')
  revision += 1
  await guard(agent)
  const mounts = await provider.listMounts('project', project)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].writeMode, 'audit')
})

test('creates nothing without a project working directory', async t => {
  const provider = await withProvider(t)
  const guard = createWritableMountGuard(provider, { mode: 'direct', logger: silent })
  await guard({ session: { id: 'no-cwd', header: {}, snapshotEvents: () => [] } })
  assert.deepEqual(await provider.listMounts(), [])
})
