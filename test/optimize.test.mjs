import assert from 'node:assert/strict'
import test from 'node:test'
import { optimizeKnowledgeDocument } from '../lib/optimize.js'

test('document optimization replaces only the body and preserves metadata', async () => {
  const entry = {
    id: 'doc-1', knowledgeBaseId: 'default', group: '项目', title: '缓存方案',
    body: '## 旧正文\n\n首先，我们需要说明一下。', type: 'decision', tags: ['cache'], scope: { kind: 'global' }, confidence: 1,
    status: 'active', documentState: 'open', version: 3,
  }
  let received
  const provider = { async update(id, draft, _checkpoint, version) { received = { id, draft, version }; return { ...entry, ...draft, version: 4 } } }
  const llm = {
    async *stream(request) {
      assert.equal(request.reasoningEffort, 'off')
      assert.equal(request.maxTokens, 4096)
      yield { type: 'text-delta', text: '## 缓存方案\n\n采用两级缓存，降低重复计算。' }
    },
  }
  const updated = await optimizeKnowledgeDocument(provider, llm, entry, { provider: 'mock', model: 'editor' }, new AbortController().signal)
  assert.equal(received.id, 'doc-1')
  assert.equal(received.version, 3)
  assert.equal(received.draft.group, '项目')
  assert.deepEqual(received.draft.tags, ['cache'])
  assert.match(received.draft.body, /两级缓存/u)
  assert.equal(updated.version, 4)
})
