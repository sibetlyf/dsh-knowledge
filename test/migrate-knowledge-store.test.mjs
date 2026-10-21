import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrateLegacyKnowledgeStore } from '../lib/migrate-knowledge-store.js'

test('the legacy knowledge store is copied once, including archives and the worklog database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-migrate-'))
  const legacyRoot = join(root, '.dsh')
  const source = join(legacyRoot, 'knowledge')
  const target = join(root, 'dsh-knowledge')
  await mkdir(join(source, 'artifacts', 'blobs'), { recursive: true })
  await mkdir(join(legacyRoot, 'worklog'), { recursive: true })
  await writeFile(join(source, 'knowledge.sqlite'), 'legacy-db')
  await writeFile(join(source, 'connection.json'), '{"backend":"local"}')
  await writeFile(join(source, 'artifacts', 'index.json'), '[]')
  await writeFile(join(source, 'artifacts', 'blobs', 'a.txt'), 'archived file')
  await writeFile(join(legacyRoot, 'worklog', 'worklog.sqlite'), 'legacy-worklog')
  const messages = { info: [], warn: [] }
  const logger = { info: message => messages.info.push(message), warn: message => messages.warn.push(message) }
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.equal(migrateLegacyKnowledgeStore(source, target, logger), true)
  assert.equal(existsSync(join(target, 'knowledge.sqlite')), true)
  assert.equal(existsSync(join(target, 'artifacts', 'blobs', 'a.txt')), true)
  assert.equal(existsSync(join(target, 'connection.json')), true)
  assert.equal(existsSync(join(target, 'knowledge.sqlite.worklog.sqlite')), true)
  assert.equal(messages.info.length, 1)

  assert.equal(migrateLegacyKnowledgeStore(source, target, logger), false, 'an existing target is never overwritten')
  assert.equal(existsSync(join(source, 'knowledge.sqlite')), true, 'the legacy directory stays as a backup')
})

test('migration is a no-op without a legacy database or with identical paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-migrate-noop-'))
  const source = join(root, 'source')
  const target = join(root, 'target')
  await mkdir(source, { recursive: true })
  await mkdir(target, { recursive: true })
  const logger = { info() {}, warn() {} }
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(migrateLegacyKnowledgeStore(source, target, logger), false)
  assert.equal(migrateLegacyKnowledgeStore(source, source, logger), false)
})
