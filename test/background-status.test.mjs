import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { registerBackgroundStatusControl } from '../lib/background-status.js'

test('the background status endpoint reports archive and writeback activity to the console', async t => {
  let handler
  const ctx = { webServer: { register(route) { handler = route.handler; return () => {} } } }
  const dispose = registerBackgroundStatusControl(ctx, {
    archive: () => ({ queued: 1, active: true, total: 4, done: 2, current: 'docs/a.md', last: { at: 10, captured: 2, updated: 0, unchanged: 0, skipped: 0, failed: 0 } }),
    writeback: () => ({ queued: 2, running: 1, failed: 0 }),
    worklog: () => true,
    enabled: () => ({ archive: true, writeback: true, worklog: true, approvals: true }),
  })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const url = `http://127.0.0.1:${server.address().port}/knowledge-control/v1/background-status`

  const unauthorized = await fetch(url)
  assert.equal(unauthorized.status, 401)

  const response = await fetch(url, { headers: { 'x-dsh-knowledge-client': 'management-web' } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control'), /no-store/)
  const body = await response.json()
  assert.equal(body.archive.active, true)
  assert.equal(body.archive.done, 2)
  assert.equal(body.archive.current, 'docs/a.md')
  assert.deepEqual(body.writeback, { queued: 2, running: 1, failed: 0 })
  assert.deepEqual(body.worklog, { running: true })
  assert.deepEqual(body.enabled, { archive: true, writeback: true, worklog: true, approvals: true })
  assert.equal(typeof body.updatedAt, 'number')

  const method = await fetch(url, { method: 'POST', headers: { 'x-dsh-knowledge-client': 'management-web' } })
  assert.equal(method.status, 405)
})
