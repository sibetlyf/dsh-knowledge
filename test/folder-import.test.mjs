import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { scanFolder } from '../lib/artifacts/folder-import.js'

test('folder scanning is recursive, bounded and skips dependency folders', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-folder-'))
  await mkdir(join(root, 'papers', 'nested'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# readme')
  await writeFile(join(root, 'papers', 'a.pdf'), 'a')
  await writeFile(join(root, 'papers', 'nested', 'b.pdf'), 'b')
  await writeFile(join(root, 'node_modules', 'pkg', 'c.js'), 'c')
  t.after(() => rm(root, { recursive: true, force: true }))
  const scan = await scanFolder(root)
  assert.equal(scan.root, root)
  assert.deepEqual(scan.files.map(path => path.replace(root, '').replace(/\\/gu, '/')).sort(), ['/README.md', '/papers/a.pdf', '/papers/nested/b.pdf'])
  assert.equal(scan.truncated, false)
  assert.ok(scan.skipped >= 1)

  const bounded = await scanFolder(root, { maxFiles: 2 })
  assert.equal(bounded.files.length, 2)
  assert.equal(bounded.truncated, true)
  await assert.rejects(() => scanFolder(join(root, 'README.md')), /不是文件夹/u)
})
