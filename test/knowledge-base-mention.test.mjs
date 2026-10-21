import assert from 'node:assert/strict'
import test from 'node:test'
import { createKnowledgeBaseMentionSource, KNOWLEDGE_BASE_MENTION_SOURCE } from '../lib/knowledge-base-mention-source.js'

test('the @ source lists knowledge bases, inserts a chip and introduces a recall-only session mount', async () => {
  const calls = []
  const request = async (url, init) => {
    calls.push({ url, init })
    if (String(url).includes('/introduce')) {
      return new Response(JSON.stringify({ introduced: true, knowledgeBase: { id: 'base-1', name: '项目资料' }, mountId: 'mount-1' }), { status: 200 })
    }
    return new Response(JSON.stringify({
      sourceKey: 'a'.repeat(64),
      items: [
        { id: 'base-1', name: '项目资料', description: '项目决策与复盘', mounted: false },
        { id: 'base-2', name: '产品资料', description: '', mounted: true },
      ],
    }), { status: 200 })
  }
  const source = createKnowledgeBaseMentionSource(request)
  assert.equal(source.trigger, '@')
  assert.equal(source.name, KNOWLEDGE_BASE_MENTION_SOURCE)
  const signal = new AbortController().signal
  const session = { sessionId: 'session-1' }
  const candidates = await source.candidates(session, { query: '', quoted: false, drilled: false, position: 'inline', signal })
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].section, '引入知识库')
  assert.match(candidates[0].description, /项目决策/)
  assert.match(candidates[1].description, /已挂载/)

  const pick = source.onPick({ candidate: candidates[0], session, position: 'inline', via: 'menu', action: 'pick' })
  assert.equal(pick.insert.source, KNOWLEDGE_BASE_MENTION_SOURCE)
  assert.equal(pick.insert.label, '知识库 · 项目资料')
  const serialized = await source.codec.serialize(pick.insert.ref, signal)
  assert.match(serialized, /引入知识库：项目资料/u)
  assert.match(serialized, /仅召回/u)
  const introduce = calls.find(call => String(call.url).includes('/introduce'))
  assert.ok(introduce)
  assert.equal(introduce.init.method, 'POST')
  assert.match(String(introduce.url), /sessionId=session-1/)
  assert.equal(source.codec.clipboardText(pick.insert.ref), '[知识库：项目资料]')
})
