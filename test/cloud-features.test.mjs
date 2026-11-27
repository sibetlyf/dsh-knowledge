import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TeamStore } from '../cloud/team-store.mjs'
import { applyStoredModelSettings, modelSettingsStatus, saveModelSettings } from '../cloud/model-settings.mjs'
import { chatCompletion } from '../cloud/llm.mjs'
import { extractText } from '../cloud/ingest.mjs'
import { zipSync, strToU8 } from 'fflate'

test('text-like files are indexed and unsupported files remain downloadable', async () => {
  const markdown = await extractText({ name: 'guide.md', mime: 'text/markdown', bytes: Buffer.from('# 发布流程\n\n发布前必须审批。') })
  assert.equal(markdown.status, 'parsed')
  assert.match(markdown.content, /发布流程/u)
  const zip = await extractText({ name: 'guide.bin', mime: 'application/octet-stream', bytes: Buffer.from('binary') })
  assert.equal(zip.status, 'unsupported')
  assert.match(zip.error, /仍可下载/u)
})

test('office documents are extracted without Markdown', async () => {
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX 发布流程</w:t></w:r></w:p></w:body></w:document>'),
  })
  const pptx = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'ppt/slides/slide1.xml': strToU8('<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:txBody><a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">PPTX 发布流程</a:t></p:txBody></p:spTree></p:cSld></p:sld>'),
  })
  const xlsx = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'xl/sharedStrings.xml': strToU8('<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>负责人</t></si><si><t>状态</t></si><si><t>Alice</t></si><si><t>已发布</t></si></sst>'),
    'xl/worksheets/sheet1.xml': strToU8('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row></sheetData></worksheet>'),
  })
  const docxResult = await extractText({ name: 'guide.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.from(docx) })
  assert.equal(docxResult.status, 'parsed')
  assert.match(docxResult.content, /DOCX 发布流程/u)
  const pptxResult = await extractText({ name: 'guide.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: Buffer.from(pptx) })
  assert.equal(pptxResult.status, 'parsed')
  assert.match(pptxResult.content, /PPTX 发布流程/u)
  const xlsxResult = await extractText({ name: 'guide.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: Buffer.from(xlsx) })
  assert.equal(xlsxResult.status, 'parsed')
  assert.match(xlsxResult.content, /Alice/u)
})

test('team worklogs and automation state persist', () => {
  const store = new TeamStore(':memory:')
  try {
    const first = store.upsertWorklog({ baseId: 'default', userName: 'alice', day: '2026-11-26', revision: 1, markdown: '# 日报\n\n完成多格式解析。' })
    assert.equal(first.day, '2026-11-26')
    const second = store.upsertWorklog({ baseId: 'default', userName: 'alice', day: '2026-11-26', revision: 2, markdown: '# 日报\n\n完成多格式解析。\n\n补充日报。' })
    assert.equal(second.revision, 2)
    assert.equal(store.listWorklogs('default', '2026-11-26', '2026-11-26').length, 1)
    const summary = store.createWorklogSummary({ baseId: 'default', fromDay: '2026-11-26', toDay: '2026-11-26', markdown: '# 团队汇总', engine: 'extractive', keywords: ['发布', '审批'], wikiPageId: 'wiki-1' })
    assert.equal(store.listWorklogSummaries('default').length, 1)
    assert.match(summary.keywords, /发布/u)
    assert.equal(summary.wiki_page_id, 'wiki-1')
    assert.equal(store.updateWorklogSummary(summary.id, { status: 'published', keywords: ['发布'] }).status, 'published')
    store.setAutomationState('auto-wiki:default', '2026-11-26T00:00:00Z')
    assert.equal(store.getAutomationState('auto-wiki:default'), '2026-11-26T00:00:00Z')
  } finally {
    store.close()
  }
})

test('cloud model settings persist limits and never expose the API key', () => {
  const store = new TeamStore(':memory:')
  const previous = {
    base: process.env.TEAM_LLM_API_BASE,
    model: process.env.TEAM_LLM_MODEL,
    key: process.env.TEAM_LLM_API_KEY,
    maxInput: process.env.TEAM_LLM_MAX_INPUT_TOKENS,
    maxOutput: process.env.TEAM_LLM_MAX_OUTPUT_TOKENS,
    format: process.env.TEAM_LLM_OUTPUT_FORMAT,
    instructions: process.env.TEAM_LLM_OUTPUT_INSTRUCTIONS,
  }
  try {
    const saved = saveModelSettings(store, {
      baseUrl: 'https://api.example.com/v1',
      model: 'deepseek-chat',
      apiKey: 'secret-value',
      maxInputTokens: 4096,
      maxOutputTokens: 512,
      outputFormat: 'custom',
      outputInstructions: '先结论，再列风险和待办。',
    })
    assert.equal(saved.enabled, true)
    assert.equal(saved.maxInputTokens, 4096)
    assert.equal(saved.maxOutputTokens, 512)
    assert.equal(saved.outputFormat, 'custom')
    assert.equal(saved.hasApiKey, true)
    assert.equal(JSON.stringify(saved).includes('secret-value'), false)
    applyStoredModelSettings(store)
    assert.equal(process.env.TEAM_LLM_MAX_INPUT_TOKENS, '4096')
    assert.equal(process.env.TEAM_LLM_MAX_OUTPUT_TOKENS, '512')
    assert.equal(process.env.TEAM_LLM_OUTPUT_FORMAT, 'custom')
    assert.equal(modelSettingsStatus(store).outputInstructions, '先结论，再列风险和待办。')
    assert.throws(() => saveModelSettings(store, { baseUrl: 'file:///tmp/x', model: 'm' }), /http/u)
    assert.throws(() => saveModelSettings(store, { baseUrl: 'https://api.example.com/v1', model: 'm', maxOutputTokens: 1 }), /最大输出 token/u)
  } finally {
    store.close()
    for (const [key, value] of Object.entries({
      TEAM_LLM_API_BASE: previous.base,
      TEAM_LLM_MODEL: previous.model,
      TEAM_LLM_API_KEY: previous.key,
      TEAM_LLM_MAX_INPUT_TOKENS: previous.maxInput,
      TEAM_LLM_MAX_OUTPUT_TOKENS: previous.maxOutput,
      TEAM_LLM_OUTPUT_FORMAT: previous.format,
      TEAM_LLM_OUTPUT_INSTRUCTIONS: previous.instructions,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('cloud model call applies input/output budgets and custom format', async () => {
  const keys = {
    base: 'TEAM_LLM_API_BASE',
    model: 'TEAM_LLM_MODEL',
    key: 'TEAM_LLM_API_KEY',
    maxInput: 'TEAM_LLM_MAX_INPUT_TOKENS',
    maxOutput: 'TEAM_LLM_MAX_OUTPUT_TOKENS',
    format: 'TEAM_LLM_OUTPUT_FORMAT',
    instructions: 'TEAM_LLM_OUTPUT_INSTRUCTIONS',
  }
  const previous = Object.fromEntries(Object.values(keys).map(key => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  let request
  try {
    process.env[keys.base] = 'https://api.example.com/v1'
    process.env[keys.model] = 'test-model'
    process.env[keys.key] = 'test-key'
    process.env[keys.maxInput] = '600'
    process.env[keys.maxOutput] = '333'
    process.env[keys.format] = 'custom'
    process.env[keys.instructions] = '只输出一句话'
    globalThis.fetch = async (url, init) => {
      request = { url, body: JSON.parse(init.body) }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const answer = await chatCompletion([
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '证据'.repeat(5000) },
    ])
    assert.equal(answer, 'ok')
    assert.equal(request.body.max_tokens, 333)
    assert.match(request.body.messages[0].content, /只输出一句话/u)
    const chars = request.body.messages.reduce((sum, message) => sum + message.content.length, 0)
    assert.ok(chars < 3000, `request should be bounded, got ${chars} chars`)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('file full-text search and wiki version/restore work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cloud-test-'))
  const store = new TeamStore(join(dir, 'team.sqlite'))
  try {
    const fileId = randomUUID()
    const now = new Date().toISOString()
    store.addFile({ id: fileId, baseId: 'default', name: '发布规范.md', mime: 'text/markdown', size: 30, sha256: 'a'.repeat(32), storagePath: 'files/x', sourceKey: 'alice/发布规范.md', userName: 'alice' })
    store.setFileText({ fileId, baseId: 'default', status: 'parsed', content: '发布前必须经过测试和审批。', parser: 'utf8', name: '发布规范.md' })
    const hits = store.searchFileText('default', '发布')
    assert.equal(hits.length, 1)
    assert.match(hits[0].snippet, /发布前/u)

    const page = store.createWikiPage({ baseId: 'default', slug: 'release', title: '发布 Wiki', content: 'v1 内容', createdBy: 'admin', sources: [{ kind: 'file', sourceId: fileId, title: '发布规范.md' }] })
    assert.equal(page.version, 1)
    const published = store.publishWikiPage(page.id, 'admin')
    assert.equal(published.status, 'published')
    assert.equal(published.version, 2)
    const restored = store.restoreWikiVersion(page.id, 1, 'admin')
    assert.equal(restored.content, 'v1 内容')
    assert.equal(restored.version, 3)
    assert.ok(store.listWikiVersions(page.id).length >= 3)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
