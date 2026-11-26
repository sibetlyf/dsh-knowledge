// 可选 OpenAI 兼容模型调用；未配置时调用方使用抽取式回答/Wiki 草稿，不阻塞轻量部署。
export function llmConfig() {
  const base = process.env.TEAM_LLM_API_BASE?.trim() || ''
  const model = process.env.TEAM_LLM_MODEL?.trim() || ''
  const key = process.env.TEAM_LLM_API_KEY?.trim() || ''
  return { base, model, key, enabled: base !== '' && model !== '' }
}

export async function chatCompletion(messages, { maxTokens = 1200, signal } = {}) {
  const config = llmConfig()
  if (!config.enabled) return undefined
  const url = `${config.base.replace(/\/+$/u, '')}/chat/completions`
  const timeout = AbortSignal.timeout(60_000)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.key === '' ? {} : { authorization: `Bearer ${config.key}` }) },
    body: JSON.stringify({ model: config.model, messages, temperature: 0, max_tokens: maxTokens }),
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  if (!response.ok) return undefined
  const payload = await response.json().catch(() => undefined)
  const text = payload?.choices?.[0]?.message?.content
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined
}
