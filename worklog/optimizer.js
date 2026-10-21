const SYSTEM = `你是一名严谨的中文工作纪要编辑。只优化格式与表达，不改变事实。
规则：
1. 保留所有事实、数字、日期、路径、交付物和 [依据:...] 引用编号，不新增或删除依据。
2. 去掉重复、空泛过渡和 AI 腔（如“首先/其次”“综上所述”“值得注意的是”），改成具体、克制的书面表达。
3. 使用清晰的小标题、短段落和必要的列表；不要机械地把所有内容改成列表。
4. 只输出优化后的 Markdown 日报正文，不要解释、不要加前言、不要用代码围栏包住整篇。`

export async function optimizeReport(llm, markdown, route, signal = AbortSignal.timeout(120_000)) {
  let output = ''
  for await (const chunk of llm.stream({
    ...route, system: SYSTEM, maxTokens: 4096, temperature: 0, reasoningEffort: 'off', signal,
    messages: [{ id: 'optimize-worklog', role: 'user', source: { kind: 'plugin:dsh-worklog' }, content: [{ type: 'text', text: markdown }] }],
  })) {
    if (signal.aborted) throw signal.reason
    if (chunk.type === 'text-delta') output += chunk.text ?? ''
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') output += chunk.block.text ?? ''
  }
  const body = output.trim()
  if (body.length === 0) throw new Error('优化模型没有返回正文，日报未修改')
  if (body.length > 100_000) throw new Error('优化结果过长，日报未修改')
  return body
}
