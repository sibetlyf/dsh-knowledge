import assert from 'node:assert/strict'
import test from 'node:test'
import { createFolderImportSource } from '../lib/folder-import-source.js'

test('folder import is an @ action that opens the importer and consumes the token', async () => {
  let opened = 0
  const source = createFolderImportSource(() => { opened += 1 })
  assert.equal(source.trigger, '@')
  const session = { sessionId: 'session-1' }
  const request = { query: '', position: 'inline', drilled: false, signal: new AbortController().signal }
  const items = await source.candidates(session, request)
  assert.equal(items.length, 1)
  assert.equal(items[0].name, '导入文件夹')
  assert.equal(items[0].value, 'folder-import')
  assert.equal(items[0].section, '知识库操作')
  assert.equal((await source.candidates(session, { ...request, query: '文件夹' })).length, 1)
  assert.equal((await source.candidates(session, { ...request, query: 'unrelated' })).length, 0)

  const outcome = source.onPick({
    candidate: items[0], session, position: 'inline', via: 'menu', action: 'pick',
    span: { start: 0, end: 1, text: '@' },
  })
  assert.equal(opened, 1)
  assert.deepEqual(outcome, { text: '' })
  assert.equal(source.onPick({
    candidate: items[0], session, position: 'inline', via: 'menu', action: 'drill',
    span: { start: 0, end: 1, text: '@' },
  }), undefined)
  assert.equal(opened, 1)
})
