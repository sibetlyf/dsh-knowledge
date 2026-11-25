import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerKnowledgeApi } from '../lib/api.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { KnowledgeShareStore } from '../lib/knowledge-share.js'

test('a worklog share requires its link token and renders the daily report read-only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'worklog-share-api-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const shares = new KnowledgeShareStore(join(root, 'knowledge.sqlite'))
  const worklog = await shares.create('worklog', '工作日报', 'worklog')
  const calls = []
  const worklogBrowser = async (method, path) => {
    calls.push([method, path])
    if (path === '/state') return { today: '2026-11-25', days: ['2026-11-24', '2026-11-25'] }
    if (path === '/day-summary') return { report: { markdown: '# 今日\n\n完成 A。', updated: 1764000000000 } }
    if (path === '/brief') return { todos: [{ text: '回归测试', cat: 'work', done: false }] }
    throw new Error(`unexpected ${path}`)
  }
  let handler
  const ctx = { webServer: { register(route) { handler = route.handler; return () => {} } }, get() { return undefined } }
  registerKnowledgeApi(ctx, provider, '/knowledge-local/v1', { authMode: 'same-origin', knowledgeShares: shares, worklogBrowser })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}/knowledge-local/v1`
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })

  assert.equal((await fetch(`${base}/shared-worklog`)).status, 404)
  const page = await fetch(`${base}/shared-worklog/${worklog.token}`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /工作日报/u)
  assert.match(html, /完成 A/u)
  assert.match(html, /回归测试/u)
  assert.match(html, /2026-11-24/u)
  assert.deepEqual(calls.map(call => call[1]), ['/state', '/day-summary', '/brief'])

  const raw = await fetch(`${base}/shared-worklog/${worklog.token}/raw`)
  assert.equal(raw.status, 200)
  assert.match(await raw.text(), /完成 A/u)
})
