import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { extractPdfText } from '../lib/pdf-parser.js'
import { parseMarkdownMindmap, formatMindmapOutline } from '../lib/notes/mindmap-domain.js'
import { NoteProposalStore } from '../lib/notes/proposal-store.js'
import { NoteStore } from '../lib/notes/store.js'
import { NoteAutoOrganizer } from '../lib/notes/auto-organizer.js'
import { resolveConfig } from '../lib/config.js'

test('PDF 文本解析支持：解压并提取 PDF 中的指令文本', () => {
  // 构造包含 FlateDecode 的合成 PDF
  const textStream = 'BT /F1 12 Tf 72 712 Td (Hello Obsidian) Tj ET'
  const compressed = deflateSync(Buffer.from(textStream, 'latin1'))

  const pdfContent = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + compressed.length + ' /Filter /FlateDecode >>\nstream\n'),
    compressed,
    Buffer.from('\nendstream\nendobj\n%%EOF'),
  ])

  const extracted = extractPdfText(pdfContent)
  assert.equal(extracted.includes('Hello Obsidian'), true)
})

test('思维标题树解析：识别多级标题与 Obsidian 风格 [[双链]]', () => {
  const markdown = `# 项目工作整理与知识脉络
## 思维标题树（知识脉络）
### 架构设计 [[微内核]]
关于系统架构的简述。
#### 插件机制 [[Cordis]]
### 存储方案 [[SQLite]]
## 对应工作内容与决策归集
- 完成了后台自动笔记整理
- 增加了 PDF 文本解析能力
## 待办与后续行动
- [ ] 接入前端思维树可视化
- [ ] 完善多文档聚类`

  const tree = parseMarkdownMindmap(markdown)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].title, '项目工作整理与知识脉络')

  const children = tree[0].children
  assert.equal(children.length, 3)
  assert.equal(children[0].title, '思维标题树（知识脉络）')

  const subNodes = children[0].children
  assert.equal(subNodes[0].title, '架构设计')
  assert.deepEqual(subNodes[0].links, ['微内核'])
  assert.equal(subNodes[0].children[0].title, '插件机制')
  assert.deepEqual(subNodes[0].children[0].links, ['Cordis'])

  const outline = formatMindmapOutline(tree)
  assert.equal(outline.includes('架构设计 (关联: [[微内核]])'), true)
})

test('草案存储 NoteProposalStore：创建、列表、审批落盘与拒绝', async () => {
  const tempDir = join(tmpdir(), `dsh-test-notes-${randomUUID()}`)
  mkdirSync(tempDir, { recursive: true })
  try {
    const noteStore = new NoteStore(tempDir)
    const proposalStore = new NoteProposalStore(noteStore.database)

    const created = proposalStore.createProposal({
      title: '2026-10-20 核心功能总结',
      targetFolder: '整理归档',
      content: '## 思维标题树\n### 知识库 [[RAG]]\n## 对应工作内容\n- 完成整理',
      mindmapJson: '[]',
      sourceNoteIds: ['note_1', 'note_2'],
    })

    assert.equal(created.status, 'pending')
    assert.equal(proposalStore.listProposals('pending').length, 1)

    // 审批通过：自动创建文件夹并创建 Markdown 笔记
    const approved = await proposalStore.approveProposal(created.id, noteStore, '人工核对通过')
    assert.equal(approved.proposal.status, 'approved')
    assert.equal(approved.proposal.reviewNote, '人工核对通过')

    // 检查 noteStore 中是否生成对应文件与目录
    const allNotes = noteStore.list({ recursive: true })
    const targetFolder = allNotes.find(n => n.kind === 'folder' && n.name === '整理归档')
    assert.ok(targetFolder)

    const createdDoc = allNotes.find(n => n.kind === 'document' && n.name === '2026-10-20 核心功能总结.md')
    assert.ok(createdDoc)
    assert.equal(createdDoc.parentId, targetFolder.id)

    // 检查生成的文档内容
    const { content } = await noteStore.read(createdDoc.id)
    assert.equal(content.toString('utf8'), created.content)
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }
})

test('NoteAutoOrganizer：结合碎片笔记与 PDF 自动提炼工作内容与思维标题树', async () => {
  const tempDir = join(tmpdir(), `dsh-test-organizer-${randomUUID()}`)
  mkdirSync(tempDir, { recursive: true })

  try {
    const noteStore = new NoteStore(tempDir)
    const proposalStore = new NoteProposalStore(noteStore.database)

    // 1. 创建未归档的 Markdown 笔记
    await noteStore.createDocument('草稿1.md', null, '# 需求讨论\n我们需要支持多篇碎片笔记自动提炼。')

    // 2. 创建一个带文本流的 PDF 附件
    const pdfText = 'BT /F1 12 Tf (PDF技术报告：关于知识库图谱与Obsidian双链设计的深入探讨) Tj ET'
    const compressed = deflateSync(Buffer.from(pdfText, 'latin1'))
    const pdfContent = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + compressed.length + ' /Filter /FlateDecode >>\nstream\n'),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF'),
    ])
    await noteStore.upload({
      name: '技术参考.pdf',
      parentId: null,
      mediaType: 'application/pdf',
      content: pdfContent,
    })

    // 模拟 LLM 流式输出 Obsidian 风格内容
    const mockLlmResponse = `# 知识库架构整理
## 思维标题树（知识脉络）
### 笔记管理 [[双链图谱]]
探讨了碎片知识与 [[Obsidian]] 风格思维树的自动化归纳。
### 附件支持 [[PDF解析]]
## 对应工作内容与决策归集
- 实现了后台自动笔记整理
- 增加了 PDF 文本抽取
## 待办与后续行动
- [ ] 优化大文件分页处理`

    const mockCtx = {
      logger: { warn: () => {}, info: () => {}, debug: () => {} },
      llm: {
        async *stream() {
          yield { type: 'text-delta', text: mockLlmResponse }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    }

    const config = resolveConfig({
      backend: 'local',
      databasePath: join(tempDir, 'knowledge.sqlite'),
      noteOrganizeEnabled: true,
      noteOrganizeTargetFolder: '知识归档',
      noteOrganizeMinNotes: 2,
    })

    const organizer = new NoteAutoOrganizer(
      mockCtx,
      config,
      noteStore,
      proposalStore,
      () => ({ provider: 'test', model: 'test' }),
    )

    // 执行后台整理
    const result = await organizer.organize({
      conversationContext: {
        sessionId: 'test-session',
        userText: '请帮我整理今天讨论的个人知识库架构',
        assistantText: '好的，我已经为你梳理了相关工作和知识图谱。',
      },
    })

    assert.equal(result.organized, true)
    assert.ok(result.proposal)
    assert.equal(result.proposal.title, '知识库架构整理')
    assert.equal(result.proposal.status, 'pending')
    assert.equal(result.pdfCount, 1)

    // 检查解析出的思维树
    assert.ok(result.mindmapTree)
    assert.equal(result.mindmapTree.length, 1)
    assert.equal(result.mindmapTree[0].title, '知识库架构整理')
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }
})
