import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveDocumentLinks, bodyKeywords, wikiKey } from '../lib/document-links.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-links-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  return provider
}

function draft(title, body, options = {}) {
  return {
    group: options.group ?? '测试分组',
    knowledgeBaseId: 'default',
    title,
    body,
    type: 'fact',
    tags: options.tags ?? [],
    scope: { kind: 'project', id: '/project' },
    confidence: 0.9,
  }
}

test('explicit wiki references become clickable links in both directions', async t => {
  const provider = await fixture(t)
  const deploy = await provider.create(draft('部署手册', '发布前请先阅读 [[回滚步骤]]。', { tags: ['ops'] }))
  const rollback = await provider.create(draft('回滚步骤', '整体流程参见 [[部署手册]]。', { tags: ['ops'] }))

  const deployLinks = await resolveDocumentLinks(provider, deploy.id)
  assert.ok(deployLinks)
  assert.equal(deployLinks.references.length, 1)
  assert.equal(deployLinks.references[0].documentId, rollback.id)
  assert.equal(deployLinks.references[0].title, '回滚步骤')
  assert.ok(deployLinks.related.some(link => link.id === rollback.id))
  assert.ok(deployLinks.backlinks.some(link => link.id === rollback.id), 'the reverse reference is a backlink')

  const rollbackLinks = await resolveDocumentLinks(provider, rollback.id)
  assert.ok(rollbackLinks.references.some(reference => reference.documentId === deploy.id))
  assert.ok(rollbackLinks.backlinks.some(link => link.id === deploy.id))
  assert.ok(rollbackLinks.related.some(link => link.id === deploy.id))
})

test('shared tags and the same group relate unrelated titles in both documents', async t => {
  const provider = await fixture(t)
  const first = await provider.create(draft('季度销售报表', '第一季度收入增长。', { tags: ['sales'], group: '报表' }))
  const second = await provider.create(draft('年度销售预测', '明年渠道规划。', { tags: ['sales'], group: '报表' }))
  const firstLinks = await resolveDocumentLinks(provider, first.id)
  const secondLinks = await resolveDocumentLinks(provider, second.id)
  assert.ok(firstLinks.related.some(link => link.id === second.id))
  assert.ok(secondLinks.related.some(link => link.id === first.id))
  assert.equal(firstLinks.references.length, 0)
})

test('every document in a non-empty base receives at least one related link', async t => {
  const provider = await fixture(t)
  const first = await provider.create(draft('Alpha', 'first document', { group: 'One' }))
  const second = await provider.create(draft('Beta', 'second document', { group: 'Two' }))
  const links = await resolveDocumentLinks(provider, first.id)
  assert.equal(links.related.length, 1)
  assert.equal(links.related[0].id, second.id)
  assert.equal(links.related[0].reason, 'topic')
})

test('links stay inside the document knowledge base and ignore archived documents', async t => {
  const provider = await fixture(t)
  const base = await provider.createKnowledgeBase({
    name: 'Second', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative',
  })
  const here = await provider.create(draft('共享主题', '当前知识库文档。', { tags: ['shared'] }))
  await provider.create({ ...draft('共享主题', '另一个知识库。', { tags: ['shared'] }), knowledgeBaseId: base.id })
  const archived = await provider.create(draft('已归档文档', '会被排除。', { tags: ['shared'] }))
  await provider.archive(archived.id)
  const links = await resolveDocumentLinks(provider, here.id)
  assert.equal(links.related.some(link => link.knowledgeBaseId === base.id), false)
  assert.equal(links.related.some(link => link.id === archived.id), false)
})

test('wiki target matching normalizes width, whitespace and case', async t => {
  const provider = await fixture(t)
  const target = await provider.create(draft('Release Notes', 'target'))
  const source = await provider.create(draft('索引', '参见 [[ＲＥＬＥＡＳＥ   notes]]。'))
  const links = await resolveDocumentLinks(provider, source.id)
  assert.equal(links.references.length, 1)
  assert.equal(links.references[0].documentId, target.id)
  assert.equal(wikiKey(' Release   NOTES '), 'release notes')
})

test('keyword lines link files with unrelated titles across groups', async t => {
  const provider = await fixture(t)
  const first = await provider.create(draft('A 文件', '- 关键词：预算、季度、渠道', { group: 'One' }))
  const second = await provider.create(draft('B 文件', '- 关键词：季度、预算、复盘', { group: 'Two' }))
  assert.deepEqual([...bodyKeywords(first.body)].sort(), ['季度', '渠道', '预算'])
  const links = await resolveDocumentLinks(provider, first.id)
  assert.ok(links.related.some(link => link.id === second.id))
  assert.equal(links.related.find(link => link.id === second.id).reason, 'tag')
  const reverse = await resolveDocumentLinks(provider, second.id)
  assert.ok(reverse.related.some(link => link.id === first.id), 'the keyword relation is bidirectional')
})


test('a missing document id resolves to undefined', async t => {
  const provider = await fixture(t)
  assert.equal(await resolveDocumentLinks(provider, '00000000-0000-4000-8000-000000000000'), undefined)
})
