import type { KnowledgeEntry } from './domain.js'
import type { KnowledgeProvider } from './provider.js'
import type { RuntimeContextLike } from './runtime.js'

const SYSTEM_PROMPT = `你是一名严谨的中文文档编辑，只做格式与表达优化，不改变事实。
规则：
1. 不增加原文没有的事实、数字、日期、路径、引用编号、链接或结论；不删除关键事实。
2. 保留所有 Markdown 代码块、链接、文件路径、SHA、arXiv/DOI、引用和 [依据:...] 标记。
3. 去掉重复、空泛过渡、AI 腔（如“首先/其次/最后”“综上所述”“值得注意的是”），改成具体、克制的书面表达。
4. 用小标题和短段落组织内容；列表只在并列事项时使用，不要机械地把所有段落改成列表。
5. 只输出优化后的 Markdown 正文，不要解释、不要加前言、不要用代码围栏包住整篇文档。`

export interface OptimizeRoute {
  provider: string
  model: string
}

/**
 * Rewrite one document in place with an editorial pass. The stored facts,
 * links, tags and references are left untouched; only the body is replaced.
 */
export async function optimizeKnowledgeDocument(
  provider: KnowledgeProvider,
  llm: RuntimeContextLike['llm'],
  entry: KnowledgeEntry,
  route: OptimizeRoute,
  signal: AbortSignal,
): Promise<KnowledgeEntry> {
  let output = ''
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    system: SYSTEM_PROMPT,
    maxTokens: 4096,
    temperature: 0,
    reasoningEffort: 'off' as never,
    signal,
    messages: [{
      id: 'optimize-document',
      role: 'user',
      source: { kind: 'plugin:dsh-knowledge' },
      content: [{ type: 'text', text: entry.body }],
    }],
  })) {
    if (signal.aborted) throw signal.reason
    if (chunk.type === 'text-delta' && 'text' in chunk) output += chunk.text ?? ''
    if (chunk.type === 'block-end' && 'block' in chunk && chunk.block?.type === 'text') output += chunk.block.text ?? ''
  }
  const body = output.trim()
  if (body.length === 0) throw new Error('优化模型没有返回正文，原文未修改')
  if (body.length > 120_000) throw new Error('优化结果过长，原文未修改')
  return provider.update(entry.id, {
    knowledgeBaseId: entry.knowledgeBaseId,
    ...entry.group === undefined ? {} : { group: entry.group },
    title: entry.title,
    body,
    type: entry.type,
    tags: entry.tags,
    scope: entry.scope,
    confidence: entry.confidence,
    ...entry.source === undefined ? {} : { source: entry.source },
  }, undefined, entry.version)
}
