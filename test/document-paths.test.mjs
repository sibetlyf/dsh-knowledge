import assert from 'node:assert/strict'
import test from 'node:test'
import { knowledgeDocumentPath } from '../lib/documents/path.js'

test('knowledge document paths mirror the database group hierarchy', () => {
  assert.equal(
    knowledgeDocumentPath({ id: 'doc-1', title: '部署约定', group: '项目规范 · 部署' }),
    '项目规范/部署/部署约定--doc1.md',
  )
  assert.equal(knowledgeDocumentPath({ id: 'doc-2', title: '无分组文档' }), '无分组文档--doc2.md')
})

test('folder names reject path separators that could escape the base directory', () => {
  assert.equal(
    knowledgeDocumentPath({ id: 'doc-3', title: '安全', group: '.. / 二级' }),
    '未命名/二级/安全--doc3.md',
  )
})
