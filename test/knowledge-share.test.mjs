import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeShareStore } from '../lib/knowledge-share.js'
import { renderKnowledgeSharePage } from '../lib/knowledge-share-page.js'

test('knowledge document shares are persistent, revocable and rendered as read-only markdown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-share-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new KnowledgeShareStore(join(root, 'knowledge.sqlite'))
  const first = await store.create('doc-1', '周报归档')
  assert.match(first.token, /^ks_[A-Za-z0-9_-]+$/u)
  assert.deepEqual(await store.get(first.token), first)
  assert.equal((await store.list()).length, 1)
  assert.equal((await store.create('doc-1', '周报归档')).token, first.token)

  const page = renderKnowledgeSharePage({
    apiPrefix: '/knowledge-local/v1',
    token: first.token,
    title: '周报归档',
    body: '# 本周\n\n- 完成 A\n\n<script>alert(1)</script>',
  })
  assert.match(page, /周报归档/u)
  assert.match(page, /完成 A/u)
  assert.doesNotMatch(page, /<script>alert/u)
  assert.match(page, new RegExp(`/knowledge-local/v1/shared-knowledge/${first.token}`, 'u'))

  assert.equal(await store.revoke(first.token), true)
  assert.equal(await store.get(first.token), undefined)
  assert.equal(await store.revoke(first.token), false)
})
