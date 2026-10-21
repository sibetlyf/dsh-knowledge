import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const names = ['graphGroupPath', 'buildGraphGroupTree', 'findGraphGroup', 'graphGroupNode', 'graphVisibleData']
const declarations = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text))
const { graphVisibleData } = runInNewContext(
  declarations.map(statement => statement.getText(parsed)).join('\n') + `\n({ ${names.join(',')} })`,
  { Map, Set, String },
)

const data = {
  knowledgeBase: { id: 'base', name: '知识库' },
  nodes: [
    { id: 'doc-1', title: '架构说明', group: '制品 · docs', type: 'reference', tags: [], degree: 1 },
    { id: 'doc-2', title: '部署说明', group: '制品 · docs', type: 'procedure', tags: [], degree: 1 },
    { id: 'doc-3', title: '缓存策略', group: '工程/设计', type: 'decision', tags: [], degree: 0 },
  ],
  edges: [{ source: 'doc-1', target: 'doc-2', reason: 'tag', score: 1 }],
  truncated: false,
}

test('graph starts with top-level groups only', () => {
  const visible = graphVisibleData(data, [])
  assert.equal(visible.nodes.length, 2)
  assert.deepEqual(Array.from(visible.nodes, node => node.kind), ['group', 'group'])
  const titles = Array.from(visible.nodes, node => node.title)
  assert.ok(titles.includes('工程') && titles.includes('制品'))
  assert.equal(visible.nodes.some(node => node.id.startsWith('doc-')), false)
})

test('opening a group reveals its subgroups and then documents', () => {
  const levelTwo = graphVisibleData(data, ['制品'])
  const levelTwoTitles = Array.from(levelTwo.nodes, node => node.title)
  assert.ok(levelTwoTitles.includes('制品') && levelTwoTitles.includes('docs'))
  assert.equal(levelTwo.nodes.some(node => node.id === 'doc-1'), false)

  const levelThree = graphVisibleData(data, ['制品', 'docs'])
  const levelThreeTitles = Array.from(levelThree.nodes, node => node.title)
  assert.ok(levelThreeTitles.includes('docs') && levelThreeTitles.includes('架构说明') && levelThreeTitles.includes('部署说明'))
  assert.equal(Array.from(levelThree.nodes).filter(node => node.kind === 'document').length, 2)
  assert.ok(levelThree.edges.some(edge => edge.source === 'doc-1' && edge.target === 'doc-2'))
  assert.ok(levelThree.edges.some(edge => edge.source === 'group:制品/docs'))
})

test('unknown paths fall back to the root instead of rendering nothing', () => {
  const visible = graphVisibleData(data, ['不存在'])
  assert.equal(visible.nodes.length, 2)
  assert.ok(visible.nodes.every(node => node.kind === 'group'))
})
