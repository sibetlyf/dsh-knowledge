import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveKnowledgeGraph } from '../lib/document-graph.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

function draft(title, body, tags = []) {
  return {
    group: '图测试', knowledgeBaseId: 'default', title, body, type: 'fact', tags,
    scope: { kind: 'global' }, confidence: 0.9,
  }
}

test('the knowledge graph exposes nodes and bidirectional edges of one base', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-graph-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  const deploy = await provider.create(draft('部署手册', '参见 [[回滚步骤]]。', ['ops']))
  const rollback = await provider.create(draft('回滚步骤', '返回 [[部署手册]]。', ['ops']))
  const isolated = await provider.create({ ...draft('孤立文档', '没有关联。'), group: '其他分组' })
  const graph = await resolveKnowledgeGraph(provider, 'default')
  assert.equal(graph.knowledgeBase.id, 'default')
  assert.equal(graph.nodes.length, 3)
  assert.ok(graph.nodes.some(node => node.id === deploy.id && node.degree >= 1))
  assert.ok(graph.nodes.some(node => node.id === isolated.id && node.degree === 0))
  const edge = graph.edges.find(item => (
    item.source === deploy.id && item.target === rollback.id
  ) || (
    item.source === rollback.id && item.target === deploy.id
  ))
  assert.ok(edge)
  assert.equal(edge.reason, 'explicit')
  assert.equal(graph.truncated, false)

  const limited = await resolveKnowledgeGraph(provider, 'default', 2)
  assert.equal(limited.nodes.length, 2)
  await assert.rejects(() => resolveKnowledgeGraph(provider, 'missing-base'), /不存在|已归档/u)
})

test('graph nodes carry group, type, tags and degree for the visual legend', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-graph-meta-'))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }) })
  await provider.create({ ...draft('季度报表', '收入数据。', ['sales']), group: '报表' })
  await provider.create({ ...draft('年度预测', '渠道规划。', ['sales']), group: '报表' })
  const graph = await resolveKnowledgeGraph(provider, 'default')
  assert.ok(graph.edges.every(item => item.reason === 'tag'))
  assert.ok(graph.nodes.every(node => node.group === '报表' && node.type === 'fact' && node.tags.includes('sales')))
  assert.ok(graph.nodes.every(node => node.degree === 1))
})
