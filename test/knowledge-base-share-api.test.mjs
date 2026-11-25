import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { KnowledgeShareStore } from '../lib/knowledge-share.js'

test('a shared knowledge base lists documents and serves the selected document token-gated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-base-share-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const shares = new KnowledgeShareStore(join(root, 'knowledge.sqlite'))
  const draft = { group: '测试组', title: '文件一', body: '# 文件一\n\n内容 A。', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: .9 }
  const first = await provider.create(draft)
  const second = await provider.create({ ...draft, title: '文件二', body: '# 文件二\n\n内容 B。' })
  const share = await shares.create('default', '默认知识库', 'base')
  let handler
  const ctx = { webServer: { register(route) { handler = route.handler; return () => {} } }, get() { return undefined } }
  registerKnowledgeApi(ctx, provider, '/knowledge-local/v1', { authMode: 'same-origin', knowledgeShares: shares })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}/knowledge-local/v1`
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })

  assert.equal((await fetch(`${base}/shared-base`)).status, 404)
  const page = await fetch(`${base}/shared-base/${share.token}`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /默认知识库/u)
  assert.match(html, /文件一/u)
  assert.match(html, /文件二/u)
  assert.match(html, /内容 A/u)

  const selected = await fetch(`${base}/shared-base/${share.token}?doc=${encodeURIComponent(second.id)}`)
  assert.equal(selected.status, 200)
  assert.match(await selected.text(), /内容 B/u)

  const raw = await fetch(`${base}/shared-base/${share.token}/raw?doc=${encodeURIComponent(first.id)}`)
  assert.equal(raw.status, 200)
  assert.match(await raw.text(), /内容 A/u)
})
