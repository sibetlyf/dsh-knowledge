import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactArchiver } from '../lib/artifacts/archive.js'
import { collectTurnArtifacts } from '../lib/artifacts/collect.js'
import { extractOfficeText, xmlText } from '../lib/artifacts/office-text.js'
import { globToRegExp } from '../lib/artifacts/archive.js'
import { Config, resolveConfig } from '../lib/config.js'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

const silent = { info() {}, warn() {} }

function archiverFor(root, provider, overrides = {}) {
  return new ArtifactArchiver({
    root: join(root, 'artifacts'),
    provider,
    baseName: '制品归档',
    extensions: ['md', 'txt', 'png', 'docx', 'xlsx', 'pptx'],
    excludePatterns: ['**/node_modules/**', '**/.env'],
    maxFileBytes: 1024 * 1024,
    maxContentChars: 4000,
    maxEntries: 100,
    autoMount: true,
    logger: silent,
    ...overrides,
  })
}

function sessionWith(events, cwd) {
  return { id: 'session-artifacts', header: { cwd }, snapshotEvents: () => events }
}

test('collectTurnArtifacts captures every file a turn touched', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '参考 @docs/plan.md 和 @"assets/logo.png" 再写' }] } },
    { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'reports/quarter.md', content: 'x' }) } },
    { type: 'tool/call', seq: 3, data: { turn: 1, step: 1, callId: 'c2', name: 'str_replace_editor', arguments: JSON.stringify({ command: 'view', path: '/tmp/viewed.md' }) } },
    { type: 'tool/call', seq: 4, data: { turn: 1, step: 1, callId: 'c3', name: 'edit', arguments: JSON.stringify({ file_path: 'docs/plan.md', old_string: 'a', new_string: 'b' }) } },
    { type: 'tool/call', seq: 5, data: { turn: 1, step: 1, callId: 'c4', name: 'read', arguments: JSON.stringify({ file_path: 'src/config.ts' }) } },
    { type: 'tool/call', seq: 6, data: { turn: 1, step: 1, callId: 'c5', name: 'read_image', arguments: JSON.stringify({ path: 'assets/logo.png' }) } },
    { type: 'tool/call', seq: 7, data: { turn: 1, step: 1, callId: 'c6', name: 'pwsh', arguments: JSON.stringify({ command: 'Get-Content C:\\work\\notes.md' }) } },
    { type: 'deliverables/presented', seq: 8, data: { turn: 1, callId: 'c7', files: [{ path: 'reports/quarter.md', description: '季度报告' }, { path: 'charts/trend.png' }] } },
    { type: 'turn/start', seq: 9, data: { turn: 2 } },
    { type: 'tool/call', seq: 10, data: { turn: 2, step: 1, callId: 'c8', name: 'write', arguments: JSON.stringify({ file_path: 'next.md' }) } },
  ]
  const candidates = collectTurnArtifacts(sessionWith(events, '/workspace/demo'), 1)
  assert.deepEqual(candidates.map(item => item.path).sort(), [
    '/tmp/viewed.md', 'C:\\work\\notes.md', 'assets/logo.png', 'charts/trend.png', 'docs/plan.md', 'reports/quarter.md', 'src/config.ts',
  ])
  const sourceOf = path => candidates.find(item => item.path === path)?.source
  assert.equal(sourceOf('reports/quarter.md'), 'presented')
  assert.equal(candidates.find(item => item.path === 'reports/quarter.md').description, '季度报告')
  assert.equal(sourceOf('charts/trend.png'), 'presented')
  assert.equal(sourceOf('docs/plan.md'), 'file-tool')
  assert.equal(sourceOf('/tmp/viewed.md'), 'reference')
  assert.equal(sourceOf('src/config.ts'), 'reference')
  assert.equal(sourceOf('assets/logo.png'), 'reference')
  assert.equal(sourceOf('C:\\work\\notes.md'), 'reference')
  assert.equal(collectTurnArtifacts(sessionWith(events, '/workspace/demo'), 2).length, 1)
  assert.deepEqual(collectTurnArtifacts(sessionWith(events, '/workspace/demo'), 9), [])
})

test('stores only the file link, metadata and keywords by default', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-link-only-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'report.md'), '# Q4\n\n收入增长 12%。\n', 'utf8')
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const archiver = archiverFor(root, provider)
  t.after(async () => {
    await archiver.close()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  const summary = await archiver.ingest([{ path: 'report.md', source: 'presented' }], { sessionId: 's1', cwd: workspace, turn: 1 })
  assert.equal(summary.captured, 1)
  const entry = await provider.get((await archiver.list())[0].entryId)
  assert.match(entry.body, /文件路径：`/u)
  assert.match(entry.body, /关键词：/u)
  assert.match(entry.body, /(收入|增长)/u)
  assert.match(entry.body, /使用 read 工具读取/u)
  assert.doesNotMatch(entry.body, /收入增长 12%/u, 'the extracted body is not duplicated in the database')
  assert.doesNotMatch(entry.body, /## 内容/u)
})


test('archives a presented artifact, indexes its text, and keeps one version per content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const report = join(workspace, 'report.md')
  await writeFile(report, '# Q4\n\n收入增长 12%。\n', 'utf8')
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const archivedEvents = []
  const archiver = archiverFor(root, provider, { onArchived: event => archivedEvents.push(event), storeContent: true })
  t.after(async () => {
    await archiver.close()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })

  const first = await archiver.ingest([{ path: 'report.md', source: 'presented', description: '季度报告' }], { sessionId: 's1', cwd: workspace, turn: 1 })
  assert.equal(first.captured, 1)
  assert.equal(first.failed, 0)
  assert.equal(archivedEvents.length, 1)
  assert.equal(archivedEvents[0].action, 'created')
  assert.equal(archivedEvents[0].project, workspace)
  assert.equal(archivedEvents[0].sessionId, 's1')
  assert.match(archivedEvents[0].summary, /自动归档制品「report\.md」/u)

  const records = await archiver.list()
  assert.equal(records.length, 1)
  const record = records[0]
  assert.equal(record.display, 'report.md')
  assert.equal(record.entryId.length > 0, true)
  const archived = await archiver.read(record.id)
  assert.equal(archived.bytes.toString('utf8'), '# Q4\n\n收入增长 12%。\n')

  const bases = await provider.listKnowledgeBases()
  const base = bases.find(item => item.name === '制品归档')
  assert.ok(base)
  assert.equal(record.knowledgeBaseId, base.id)
  const entry = await provider.get(record.entryId)
  assert.match(entry.title, /^制品 · report\.md$/u)
  assert.match(entry.body, /收入增长 12%/u)
  assert.match(entry.body, /SHA-256/u)
  assert.equal(entry.type, 'fact')
  assert.deepEqual(entry.scope, { kind: 'project', id: workspace })
  assert.equal(entry.tags.includes('md'), true)
  assert.equal(entry.tags.includes('presented'), true)
  assert.equal(entry.documentState, 'open')

  const mounts = await provider.listMounts('project', workspace)
  const mount = mounts.find(item => item.knowledgeBaseId === base.id)
  assert.ok(mount)
  assert.equal(mount.recallEnabled, true)
  assert.equal(mount.writeMode, 'none')

  const second = await archiver.ingest([{ path: 'report.md', source: 'presented' }], { sessionId: 's1', cwd: workspace, turn: 1 })
  assert.equal(second.unchanged, 1)
  assert.equal((await provider.get(record.entryId)).version, 1)

  await writeFile(report, '# Q4\n\n收入增长 15%。\n新增：海外市场。\n', 'utf8')
  const third = await archiver.ingest([{ path: 'report.md', source: 'presented' }], { sessionId: 's1', cwd: workspace, turn: 2 })
  assert.equal(third.updated, 1)
  const updated = await provider.get(record.entryId)
  assert.equal(updated.version, 2)
  assert.match(updated.body, /海外市场/u)
  const versions = await provider.versions(record.entryId)
  assert.equal(versions.length >= 2, true)

  const restarted = archiverFor(root, provider)
  t.after(() => restarted.close())
  const persisted = await restarted.list()
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].sha256, (await archiver.list())[0].sha256)
  const afterRestart = await restarted.ingest([{ path: 'report.md', source: 'presented' }], { sessionId: 's1', cwd: workspace, turn: 3 })
  assert.equal(afterRestart.unchanged, 1)
})

test('skips excluded, unsupported and oversized artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-skip-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'node_modules'), { recursive: true })
  await writeFile(join(workspace, 'node_modules', 'pkg.md'), 'noise', 'utf8')
  await writeFile(join(workspace, '.env'), 'TOKEN=1', 'utf8')
  await writeFile(join(workspace, 'code.ts'), 'export {}', 'utf8')
  await writeFile(join(workspace, 'big.md'), 'x'.repeat(2048), 'utf8')
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const archiver = archiverFor(root, provider, { maxFileBytes: 1024 })
  t.after(async () => {
    await archiver.close()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  const summary = await archiver.ingest([
    { path: 'node_modules/pkg.md', source: 'file-tool' },
    { path: '.env', source: 'file-tool' },
    { path: 'code.ts', source: 'file-tool' },
    { path: 'big.md', source: 'file-tool' },
    { path: 'missing.md', source: 'file-tool' },
  ], { sessionId: 's2', cwd: workspace, turn: 1 })
  assert.equal(summary.captured, 0)
  assert.equal(summary.skipped, 5)
  assert.deepEqual(await archiver.list(), [])
  assert.equal((await provider.listKnowledgeBases()).length, 1)
})

test('extracts text from docx, pptx and xlsx containers', () => {
  const docx = makeZip({
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>Second &amp; third</w:t></w:r></w:p></w:body></w:document>',
  })
  const docxText = extractOfficeText('docx', docx, 1000)
  assert.match(docxText, /第一段/u)
  assert.match(docxText, /Second & third/u)

  const pptx = makeZip({
    'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>',
  })
  const slides = extractOfficeText('pptx', pptx, 1000)
  assert.match(slides, /\[slide 1\][\s\S]*First slide/u)
  assert.match(slides, /\[slide 2\][\s\S]*Second slide/u)
  assert.equal(slides.indexOf('First slide') < slides.indexOf('Second slide'), true)

  const xlsx = makeZip({
    'xl/sharedStrings.xml': '<sst><si><t>名称</t></si><si><t>数量</t></si></sst>',
    'xl/workbook.xml': '<workbook><sheets><sheet name="汇总" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>42</v></c></row>'
      + '</sheetData></worksheet>',
  })
  const sheet = extractOfficeText('xlsx', xlsx, 1000)
  assert.match(sheet, /## 汇总/u)
  assert.match(sheet, /名称\t数量/u)
  assert.match(sheet, /名称\t42/u)

  assert.equal(xmlText('<w:p>a<w:tab/>b</w:p>'), 'a\tb')
  assert.equal(extractOfficeText('docx', Buffer.from('not a zip'), 1000), '')
})

test('glob patterns used for exclusion behave predictably', () => {
  assert.equal(globToRegExp('**/node_modules/**').test('node_modules/pkg/a.md'), true)
  assert.equal(globToRegExp('**/node_modules/**').test('src/node_modules/a.md'), true)
  assert.equal(globToRegExp('**/.env').test('.env'), true)
  assert.equal(globToRegExp('**/.env').test('config/.env'), true)
  assert.equal(globToRegExp('**/*.pem').test('certs/server.pem'), true)
  assert.equal(globToRegExp('**/*.pem').test('certs/server.pem.bak'), false)
  assert.equal(globToRegExp('reports/*.md').test('reports/q4.md'), true)
  assert.equal(globToRegExp('reports/*.md').test('reports/q4.txt'), false)
})

function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

test('artifact archiving is enabled by default and exposes bounded configuration defaults', () => {
  const validated = Config({ backend: 'local', databasePath: ':memory:' })
  assert.equal(validated.artifactArchiveEnabled, true)
  assert.equal(validated.artifactArchiveBaseName, '制品归档')
  assert.equal(validated.artifactArchiveAutoMount, true)
  assert.equal(validated.artifactArchiveMaxFileBytes, 32 * 1024 * 1024)
  assert.equal(validated.artifactArchiveMaxChars, 46000)
  assert.deepEqual(validated.artifactArchiveExtensions, ['*'])
  assert.equal(validated.artifactArchiveExclude.includes('**/.env'), true)
  const resolved = resolveConfig(validated)
  assert.equal(resolved.artifactArchiveEnabled, true)
  assert.deepEqual(resolved.artifactArchiveExtensions, ['*'])
  assert.equal(resolved.autoWritableMountEnabled, true)
  assert.equal(resolved.autoWritableMountWriteMode, 'direct')
  const disabled = resolveConfig(Config({ backend: 'local', databasePath: ':memory:', artifactArchiveEnabled: false }))
  assert.equal(disabled.artifactArchiveEnabled, false)
})

test('archives and indexes a user-uploaded attachment without review', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-upload-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const uploads = new Map([
    ['sha256:file', { name: '销售.csv', bytes: Buffer.from('区域,销量\n华东,10\n', 'utf8') }],
    ['sha256:image', { name: '趋势.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' }],
  ])
  const archiver = archiverFor(root, provider, {
    resolveUpload: async upload => uploads.get(upload.ref.attachmentId),
  })
  t.after(async () => {
    await archiver.close()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  const candidates = [
    { upload: { kind: 'file', ref: { attachmentId: 'sha256:file' }, name: '销售.csv' }, source: 'upload' },
    { upload: { kind: 'image', ref: { attachmentId: 'sha256:image' }, name: '趋势' }, source: 'upload' },
  ]
  const first = await archiver.ingest(candidates, { sessionId: 's-upload', cwd: workspace, turn: 1 })
  assert.equal(first.captured, 2)
  assert.equal(first.failed, 0)

  const records = await archiver.list()
  assert.equal(records.length, 2)
  const csv = records.find(record => record.display.includes('销售.csv'))
  assert.equal(csv.path, '销售.csv')
  assert.equal(csv.source, 'upload')
  const csvBytes = await archiver.read(csv.id)
  assert.match(csvBytes.bytes.toString('utf8'), /华东,10/u)
  const csvEntry = await provider.get(csv.entryId)
  assert.equal(csvEntry.title, '制品 · 用户上传/销售.csv')
  assert.match(csvEntry.body, /用户上传附件/u)
  assert.match(csvEntry.body, /关键词：.*(华东|销量|区域)/u)
  assert.equal(csvEntry.tags.includes('upload'), true)
  assert.equal(csvEntry.group, '制品 · 表格')

  const image = records.find(record => record.display.includes('趋势'))
  assert.equal(image.extension, 'png', 'unnamed uploads fall back to the media type extension')
  assert.equal(image.mediaType, 'image/png')
  assert.match((await provider.get(image.entryId)).body, /类型：image\/png/u)

  const again = await archiver.ingest(candidates, { sessionId: 's-upload', cwd: workspace, turn: 2 })
  assert.equal(again.unchanged, 2)
  assert.equal((await provider.get(csv.entryId)).version, 1)

  const withoutService = archiverFor(root, provider)
  t.after(() => withoutService.close())
  const skipped = await withoutService.ingest(candidates, { sessionId: 's-upload', cwd: workspace, turn: 3 })
  assert.equal(skipped.skipped, 2)
})

test('presented deliverables bypass the extension allowlist and are grouped by category', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-format-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'model.stl'), 'solid example', 'utf8')
  await writeFile(join(workspace, 'plan.bin'), Buffer.from([0, 1, 2, 3]))
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const archiver = archiverFor(root, provider, { extensions: ['md'] })
  t.after(async () => {
    await archiver.close()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  const summary = await archiver.ingest([
    { path: 'model.stl', source: 'file-tool' },
    { path: 'plan.bin', source: 'presented' },
  ], { sessionId: 's-format', cwd: workspace, turn: 1 })
  assert.equal(summary.skipped, 1, 'file-tool writes still follow the extension allowlist')
  assert.equal(summary.captured, 1)
  const [record] = await archiver.list()
  const entry = await provider.get(record.entryId)
  assert.equal(record.display, 'plan.bin')
  assert.equal(entry.group, '制品 · 其他')
  assert.equal(record.mediaType, 'application/octet-stream')
  assert.match(entry.body, /文件路径：`/u)
})

test('archive copies remain readable after the source file is deleted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-copy-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const target = join(workspace, 'notes.txt')
  await writeFile(target, 'kept bytes', 'utf8')
  const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
  const archiver = archiverFor(root, provider)
  t.after(async () => {
    await archiver.close()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  await archiver.ingest([{ path: 'notes.txt', source: 'file-tool' }], { sessionId: 's3', cwd: workspace, turn: 1 })
  await rm(target)
  const [record] = await archiver.list()
  const found = await archiver.read(record.id)
  assert.equal(found.bytes.toString('utf8'), 'kept bytes')
  assert.equal(found.record.extension, 'txt')
})
