import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  clearTencentDocsToken,
  isValidTencentDocsToken,
  readTencentDocsToken,
  saveTencentDocsToken,
  tencentDocsVaultPath,
} from '../lib/tencent-docs-token.js'

const TOKEN = 'aabbccddeeff00112233445566778899'

test('user token is persisted in the local vault and never returned', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tencent-token-'))
  const path = join(root, 'vault.json')
  const env = { TDOC_VAULT: path }
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.equal(tencentDocsVaultPath(env), path)
  const saved = await saveTencentDocsToken(TOKEN.toUpperCase(), env, path)
  assert.equal(saved.configured, true)
  assert.equal(saved.source, 'vault')
  assert.equal('token' in saved, false)
  assert.match(saved.fingerprint, /^len32:/u)

  const read = await readTencentDocsToken(env, path)
  assert.equal(read.token, TOKEN)
  assert.equal(read.source, 'vault')

  const cleared = await clearTencentDocsToken(env, path)
  assert.equal(cleared.configured, false)
  assert.equal(cleared.source, 'none')
  assert.equal((await readTencentDocsToken(env, path)).token, '')
})

test('environment token overrides the vault without hiding its status', async () => {
  const env = { TDOC_OAUTH_ACCESS_TOKEN: TOKEN }
  const status = await readTencentDocsToken(env, join(tmpdir(), 'does-not-exist', 'vault.json'))
  assert.equal(status.source, 'env')
  assert.equal(status.token, TOKEN)
  assert.equal(status.overriddenByEnv, true)
})

test('invalid tokens are rejected before writing', async () => {
  assert.equal(isValidTencentDocsToken(TOKEN), true)
  assert.equal(isValidTencentDocsToken('not-a-token'), false)
  await assert.rejects(
    saveTencentDocsToken('short', { TDOC_VAULT: join(tmpdir(), 'unused-vault.json') }),
    /32 位十六进制/u,
  )
})
