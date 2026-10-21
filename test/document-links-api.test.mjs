import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

test('the management API exposes bidirectional document links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-links-api-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } } }, provider, '/api', { authMode: 'same-origin' })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  const draft = (title, body, tags) => ({
    group: '接口测试', knowledgeBaseId: 'default', title, body, type: 'fact', tags,
    scope: { kind: 'global' }, confidence: 0.9,
  })
  const first = await provider.create(draft('部署手册', '参见 [[回滚步骤]]。', ['ops']))
  const second = await provider.create(draft('回滚步骤', '返回 [[部署手册]]。', ['ops']))
  const base = `http://127.0.0.1:${server.address().port}/api/entries/${encodeURIComponent(first.id)}/links`

  const unauthorized = await fetch(base)
  assert.equal(unauthorized.status, 401)

  const response = await fetch(base, { headers: { 'x-dsh-knowledge-client': 'management-web' } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control'), /no-store/)
  const links = await response.json()
  assert.ok(links.related.some(link => link.id === second.id))
  assert.ok(links.backlinks.some(link => link.id === second.id))
  assert.equal(links.references[0].documentId, second.id)
  assert.equal(links.references[0].title, '回滚步骤')

  const missing = await fetch(`http://127.0.0.1:${server.address().port}/api/entries/00000000-0000-4000-8000-000000000000/links`, {
    headers: { 'x-dsh-knowledge-client': 'management-web' },
  })
  assert.equal(missing.status, 404)

  const graphResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/graph?knowledgeBaseId=default`, {
    headers: { 'x-dsh-knowledge-client': 'management-web' },
  })
  assert.equal(graphResponse.status, 200)
  const graph = await graphResponse.json()
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.edges.length, 1)
  assert.equal(graph.edges[0].reason, 'explicit')
})
