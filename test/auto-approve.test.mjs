import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPendingAutoApprover } from '../lib/auto-approve.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-auto-approve-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  return provider
}

function proposal(title, reason) {
  return {
    action: 'create',
    draft: {
      knowledgeBaseId: 'default', group: '自动审批', title, body: `${title} 的可复用流程。`,
      type: 'procedure', tags: [], scope: { kind: 'global' }, confidence: 0.9,
    },
    reason,
  }
}

test('automatically approves ordinary pending candidates and keeps safety holds', async t => {
  const provider = await fixture(t)
  await provider.propose(proposal('普通候选', 'Reusable procedure.'))
  await provider.propose(proposal('敏感候选', 'Automatic direct write was withheld because credential-like content requires manual review (api key).'))
  await provider.propose(proposal('另一个普通候选', 'Reusable procedure.'))

  const before = await provider.listCandidates('pending', 20)
  assert.equal(before.length, 3)
  const approver = createPendingAutoApprover({
    provider,
    logger: { info() {}, warn() {} },
    intervalMinutes: 5,
  })
  t.after(() => approver.stop())
  await approver.run()

  const pending = await provider.listCandidates('pending', 20)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].draft.title, '敏感候选')
  const entries = await provider.list({ limit: 10 })
  assert.equal(entries.items.length, 2)
  assert.deepEqual(entries.items.map(item => item.title).sort(), ['另一个普通候选', '普通候选'])
})

test('a stopped approver performs no work', async t => {
  const provider = await fixture(t)
  await provider.propose(proposal('待处理', 'Reusable procedure.'))
  const approver = createPendingAutoApprover({ provider, logger: { info() {}, warn() {} }, intervalMinutes: 5 })
  approver.stop()
  await approver.run()
  assert.equal((await provider.listCandidates('pending', 20)).length, 1)
})
