import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { KnowledgeShareStore } from '../lib/knowledge-share.js'

test('a shared knowledge document is readable without DSH or a bearer token', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-share-api-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const shares = new KnowledgeShareStore(join(root, 'knowledge.sqlite'))
  const entry = await provider.create({
    knowledgeBaseId: 'default', group: '分享测试', title: '可公开的周报', body: '# 本周\n\n完成 A。', type: 'fact', tags: [],
    scope: { kind: 'global' }, confidence: .9,
  })
  const share = await shares.create(entry.id, entry.title)
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

  const page = await fetch(`${base}/shared-knowledge/${share.token}`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/u)
  assert.match(await page.text(), /完成 A/u)

  const raw = await fetch(`${base}/shared-knowledge/${share.token}/raw`)
  assert.equal(raw.status, 200)
  assert.match(await raw.text(), /# 本周/u)

  const manifest = await (await fetch(`${base}/shared-knowledge/${share.token}/manifest`)).json()
  assert.equal(manifest.kind, 'knowledge-document')
  assert.equal(manifest.title, '可公开的周报')

  assert.equal((await fetch(`${base}/shared-knowledge/ks_invalid`)).status, 404)
})
