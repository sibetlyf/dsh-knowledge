import assert from 'node:assert/strict'
import test from 'node:test'
import { createTencentDocsBridge } from '../lib/tencent-docs.js'

const remoteBase = { id: 'default', name: '默认知识库', status: 'active' }

function fakeContext(tools, schemas) {
  return {
    get(name) { return name === 'tools' ? { execute: tools, schemas: () => schemas } : undefined },
    tools: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
}

function fakeProvider(entry = undefined) {
  const created = []
  return {
    created,
    async listKnowledgeBases() { return [remoteBase] },
    async create(draft) { created.push(draft); return { ...draft, id: 'doc-cloud-1', status: 'active', version: 1 } },
    async get(id) { return entry && entry.id === id ? entry : undefined },
    async list() { return { items: [], total: 0 } },
    async search() { return [] },
    async getSettings() { return { writebackPolicy: 'proactive' } },
  }
}

test('status reports whether the Tencent Docs MCP tools are live', async () => {
  const ctx = fakeContext(async () => ({}), [{ name: 'mcp__tencent-docs__get_content' }, { name: 'mcp__tencent-docs__create_smartcanvas_by_mdx' }])
  const status = await createTencentDocsBridge(ctx, fakeProvider()).status()
  assert.equal(status.connected, true)
  assert.deepEqual(status.tools.sort(), ['create_smartcanvas_by_mdx', 'get_content'])
})

test('import reads a cloud document and creates a local knowledge document', async () => {
  let called
  const ctx = fakeContext(async input => {
    called = input
    return { value: { title: '云端会议纪要', content: '# 决策\n\n采用缓存。' } }
  }, [{
    name: 'mcp__tencent-docs__get_content',
    parameters: { properties: { file_id: { type: 'string' } } },
  }])
  const provider = fakeProvider()
  const result = await createTencentDocsBridge(ctx, provider).importDocument({
    url: 'https://docs.qq.com/doc/AbCdEf123',
    group: '腾讯文档 · 会议',
  })
  assert.equal(called.arguments.file_id, 'AbCdEf123')
  assert.equal(result.title, '云端会议纪要')
  assert.equal(result.documentId, 'doc-cloud-1')
  assert.equal(provider.created[0].group, '腾讯文档 · 会议')
  assert.match(provider.created[0].body, /来源：腾讯文档/u)
  assert.match(provider.created[0].body, /采用缓存/u)
})

test('publish sends the local document body as MDX to Tencent Docs', async () => {
  let called
  const ctx = fakeContext(async input => {
    called = input
    return { value: { file_url: 'https://docs.qq.com/doc/NewDoc' } }
  }, [{
    name: 'mcp__tencent-docs__create_smartcanvas_by_mdx',
    parameters: { properties: { title: {}, mdx: {}, content_format: {} } },
  }])
  const entry = {
    id: 'doc-local', knowledgeBaseId: 'default', title: '缓存方案', body: '# 缓存方案\n\n两级缓存。',
    type: 'decision', tags: [], scope: { kind: 'global' }, confidence: 1, status: 'active', version: 2,
  }
  const result = await createTencentDocsBridge(ctx, fakeProvider(entry)).publish('doc-local')
  assert.equal(called.arguments.title, '缓存方案')
  assert.equal(called.arguments.mdx, '# 缓存方案\n\n两级缓存。')
  assert.equal(called.arguments.content_format, 'mdx')
  assert.equal(result.url, 'https://docs.qq.com/doc/NewDoc')
})

test('missing Tencent Docs tools fails with a login instruction', async () => {
  const bridge = createTencentDocsBridge(fakeContext(async () => ({}), []), fakeProvider())
  await assert.rejects(
    bridge.importDocument({ url: 'https://docs.qq.com/doc/abc' }),
    /tdoc-auth login|尚未连接/u,
  )
})
