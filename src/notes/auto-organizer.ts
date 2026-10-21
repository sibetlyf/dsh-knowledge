import { randomUUID } from 'node:crypto'
import type { ResolvedConfig } from '../config.js'
import { knowledgeFolderName } from '../documents/path.js'
import { extractPdfText } from '../pdf-parser.js'
import type { MessageLike, RuntimeContextLike } from '../runtime.js'
import type { NoteNode } from './domain.js'
import { parseMarkdownMindmap, type MindmapNode, type NoteProposal } from './mindmap-domain.js'
import type { NoteProposalStore } from './proposal-store.js'
import type { NoteStore } from './store.js'

export interface AutoOrganizeOptions {
  conversationContext?: {
    sessionId: string
    userText: string
    assistantText: string
  } | undefined
  signal?: AbortSignal | undefined
  force?: boolean | undefined
}

export interface AutoOrganizeResult {
  organized: boolean
  proposal?: NoteProposal | undefined
  mindmapTree?: MindmapNode[] | undefined
  scannedCount: number
  pdfCount: number
  reason?: string | undefined
}

function firstOrganizeTopic(tree: MindmapNode[]): string {
  const queue = [...tree]
  while (queue.length > 0) {
    const node = queue.shift()!
    if (node.level >= 3 && node.title.trim().length > 0) return knowledgeFolderName(node.title)
    queue.push(...node.children)
  }
  return '综合'
}

export class NoteAutoOrganizer {
  constructor(
    private readonly ctx: RuntimeContextLike,
    private readonly config: ResolvedConfig,
    private readonly noteStore: NoteStore,
    private readonly proposalStore: NoteProposalStore,
    private readonly getRoute: () => { provider: string; model: string } | undefined = () => undefined,
  ) {}

  /**
   * 执行后台笔记与对话自动整理
   */
  async organize(options: AutoOrganizeOptions = {}): Promise<AutoOrganizeResult> {
    if (!this.config.noteOrganizeEnabled && !options.force) {
      return { organized: false, scannedCount: 0, pdfCount: 0, reason: '自动整理功能未开启 (noteOrganizeEnabled=false)' }
    }

    const signal = options.signal ?? new AbortController().signal

    // 1. 扫描未归纳的碎片笔记与 PDF 文件
    const allNodes = this.noteStore.list({ recursive: true })
    const targetFolder = this.config.noteOrganizeTargetFolder || '整理归档'

    // 查找目标整理目录的 ID，避免把已整理文件又扫进来
    const targetFolderNode = allNodes.find(n => n.kind === 'folder' && n.name === targetFolder)
    const targetFolderId = targetFolderNode ? targetFolderNode.id : null

    // 筛选位于根目录或未归档的 document 及 pdf 文件
    const candidateNodes: NoteNode[] = allNodes.filter(node => {
      if (targetFolderId && node.parentId === targetFolderId) return false
      if (node.kind === 'document') return true
      if (node.kind === 'file' && (node.mediaType === 'application/pdf' || /\.pdf$/i.test(node.name))) return true
      return false
    })

    const userText = options.conversationContext?.userText ?? ''
    const assistantText = options.conversationContext?.assistantText ?? ''
    const hasConversation = userText.trim().length > 0 || assistantText.trim().length > 0

    const minNotes = this.config.noteOrganizeMinNotes ?? 2
    if (candidateNodes.length < minNotes && !hasConversation && !options.force) {
      return {
        organized: false,
        scannedCount: candidateNodes.length,
        pdfCount: 0,
        reason: `未归档素材数量 (${candidateNodes.length}) 未达到触发阈值 (${minNotes})，且无对话输入`,
      }
    }

    // 2. 读取素材文本
    let pdfCount = 0
    const sourceContents: { id: string; name: string; kind: string; text: string }[] = []
    const sourceNoteIds: string[] = []

    for (const node of candidateNodes.slice(0, 15)) { // 限制单次最多提炼 15 篇
      try {
        if (node.kind === 'document') {
          const { content } = await this.noteStore.read(node.id)
          const text = content.toString('utf8').trim()
          if (text.length > 0) {
            sourceContents.push({ id: node.id, name: node.name, kind: 'markdown', text: text.slice(0, 8000) })
            sourceNoteIds.push(node.id)
          }
        } else if (node.kind === 'file' && (node.mediaType === 'application/pdf' || /\.pdf$/i.test(node.name))) {
          const { content } = await this.noteStore.read(node.id)
          try {
            const pdfText = extractPdfText(content).trim()
            if (pdfText.length > 0) {
              sourceContents.push({ id: node.id, name: node.name, kind: 'pdf', text: pdfText.slice(0, 12000) })
              sourceNoteIds.push(node.id)
              pdfCount++
            }
          } catch (pdfErr) {
            this.ctx.logger.warn(`dsh-knowledge: 解析 PDF "${node.name}" 失败: ${String(pdfErr)}`)
          }
        }
      } catch (err) {
        this.ctx.logger.warn(`dsh-knowledge: 读取素材 "${node.name}" 失败: ${String(err)}`)
      }
    }

    // 3. 组装输入上下文
    const sections: string[] = []

    if (hasConversation) {
      sections.push(`【当前会话交流记录】:\n用户输入:\n${userText.slice(0, 5000)}\n\nAI回答:\n${assistantText.slice(0, 8000)}`)
    }

    if (sourceContents.length > 0) {
      sections.push('【待整理的碎片笔记与 PDF 文档】:')
      for (const item of sourceContents) {
        sections.push(`--- 文档 [${item.kind.toUpperCase()}]: ${item.name} ---\n${item.text}\n`)
      }
    }

    if (sections.length === 0) {
      return { organized: false, scannedCount: 0, pdfCount: 0, reason: '没有可供提取的有效内容' }
    }

    const route = this.getRoute() ?? (this.config.extractionProvider && this.config.extractionModel ? {
      provider: this.config.extractionProvider,
      model: this.config.extractionModel,
    } : undefined)

    if (!route) {
      throw new Error('未配置可用的 LLM 模型路由，无法执行后台整理')
    }

    // 4. 调用 LLM 生成 Obsidian 风格知识与思维大纲
    const prompt = this.config.noteOrganizePrompt || '对所有对话产出、笔记及文档进行深度提炼，提取核心主题、工作产出，并生成思维树与双链'
    const systemPrompt = `你是一个专业的个人知识库整理与 Obsidian 笔记架构专家。
你的任务是将用户对话产出以及碎片素材（包括 Markdown 笔记、PDF 资料）进行深度提炼与结构化重组。
输出必须遵循以下 Obsidian 风格的完整 Markdown 规范：
1. 顶部必须是二级标题 "## 思维标题树（知识脉络）"：
   - 提取出严密的分级大纲（###、####）；
   - 大量使用 Obsidian 风格双向链接 [[关键概念或子主题]] 来表达知识图谱网状关联；
2. 中部是二级标题 "## 对应工作内容与决策归集"：
   - 结构化总结已完成的具体工作、代码/技术方案要点、核心决策；
3. 下部是二级标题 "## 待办与后续行动"：
   - 使用 Markdown 任务列表格式 (- [ ] 待办事项)。
全部使用清晰简明的中文撰写。直接输出 Markdown，不要包含额外开场白。`

    const userMessage: MessageLike = {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: `【整理要求】\n${prompt}\n\n【素材数据】\n${sections.join('\n\n')}`,
      }],
      source: { kind: 'plugin:dsh-knowledge' },
    }

    const sessionId = options.conversationContext?.sessionId ?? 'system-auto-organizer'
    const generatedMarkdown = await this.invokeModel(route, systemPrompt, userMessage, sessionId, signal)

    // 5. 解析思维标题树
    const mindmapTree = parseMarkdownMindmap(generatedMarkdown)

    // 6. 提炼标题
    const dateStr = new Date().toISOString().slice(0, 10)
    let title = `${dateStr} 知识整理与思维大纲`
    const firstHeading = generatedMarkdown.match(/^#\s+(.+)$/m)
    if (firstHeading && firstHeading[1]) {
      const headingText = firstHeading[1].trim()
      if (headingText.length > 0) title = headingText
    }

    // 7. 存入待审阅草案；未关闭自动批准时直接落盘，不再等待人工确认
    const topic = firstOrganizeTopic(mindmapTree)
    const targetPath = [targetFolder, topic].filter(Boolean).join('/')
    const proposal = this.proposalStore.createProposal({
      title,
      kind: 'auto_summary',
      targetFolder: targetPath,
      content: generatedMarkdown,
      mindmapJson: JSON.stringify(mindmapTree),
      sourceNoteIds,
    })
    if (this.config.noteOrganizeAutoApprove) {
      const approved = await this.proposalStore.approveProposal(proposal.id, this.noteStore)
      return {
        organized: true,
        proposal: approved.proposal,
        mindmapTree,
        scannedCount: candidateNodes.length,
        pdfCount,
      }
    }

    return {
      organized: true,
      proposal,
      mindmapTree,
      scannedCount: candidateNodes.length,
      pdfCount,
    }
  }

  private async invokeModel(
    route: { provider: string; model: string },
    system: string,
    message: MessageLike,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('笔记整理 LLM 调用超时')), this.config.extractionTimeoutMs || 90_000)
    const combinedSignal = AbortSignal.any([signal, controller.signal])
    let text = ''

    try {
      for await (const chunk of this.ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [message],
        system,
        maxTokens: this.config.extractionMaxTokens || 4096,
        temperature: 0.2,
        signal: combinedSignal,
        sessionId,
      })) {
        if (chunk.type === 'text-delta' && 'text' in chunk && typeof chunk.text === 'string') {
          text += chunk.text
        } else if (chunk.type === 'block-end' && 'block' in chunk && chunk.block.type === 'text') {
          text += chunk.block.text ?? ''
        }
      }
    } finally {
      clearTimeout(timeout)
    }

    if (!text.trim()) throw new Error('模型未返回任何整理内容')
    return text.trim()
  }
}
