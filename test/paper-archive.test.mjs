import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactArchiver } from '../lib/artifacts/archive.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

function buildPdf(lines) {
  const escape = value => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const stream = `BT /F1 12 Tf 72 720 Td ${lines.map((line, index) => `${index ? '0 -18 Td ' : ''}(${escape(line)}) Tj`).join(' ')} ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

test('a paper PDF goes to the single paper base with abstract and keywords in the database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-paper-archive-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'papers'), { recursive: true })
  await writeFile(join(workspace, 'papers', 'rag.pdf'), buildPdf([
    'arXiv:2401.01234v1 [cs.CL]',
    'Retrieval-Augmented Generation for Long Documents',
    'Abstract',
    'We study retrieval augmented generation for long documents and introduce a compact index that improves grounding while reducing token cost by a large margin.',
    'Keywords: retrieval-augmented generation; large language models',
    '1 Introduction',
    'The paper starts here.',
  ]))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const archiver = new ArtifactArchiver({
    root: join(root, 'artifacts'), provider, baseName: '制品归档', paperBaseName: '论文库',
    paperEnabled: true, extensions: ['pdf'], excludePatterns: [], maxFileBytes: 1024 * 1024,
    maxContentChars: 46000, maxEntries: 100, autoMount: false,
    logger: { info() {}, warn() {} },
  })
  t.after(async () => {
    await archiver.close()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  const summary = await archiver.ingest([{ path: 'papers/rag.pdf', source: 'presented' }], { sessionId: 's1', cwd: workspace, turn: 1 })
  assert.equal(summary.captured, 1)
  assert.equal(summary.items[0].category, '文档')
  assert.equal(summary.items[0].knowledgeBaseName, '论文库')
  assert.match(summary.items[0].group ?? '', /^论文 · /u)
  assert.equal(summary.items[0].paper?.title.includes('Retrieval-Augmented'), true)
  const bases = await provider.listKnowledgeBases()
  assert.equal(bases.some(base => base.name === '论文库'), true)
  assert.equal(bases.some(base => base.name === '制品归档'), false, 'papers do not create an extra artifact base')
  const paperBase = bases.find(base => base.name === '论文库')
  const page = await provider.list({ knowledgeBaseId: paperBase.id, limit: 10 })
  const entry = page.items[0]
  assert.match(entry.title, /^论文 · Retrieval-Augmented Generation/u)
  assert.match(entry.group, /^论文 · /u)
  assert.match(entry.body, /## 摘要/u)
  assert.match(entry.body, /retrieval[- ]augmented/u)
  assert.match(entry.body, /- 关键词：/u)
  assert.match(entry.body, /- arXiv：`2401\.01234`/u)
  assert.match(entry.body, /文件路径：`/u)
  assert.equal(entry.tags.includes('论文'), true)
})
