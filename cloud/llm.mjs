// 可选 OpenAI 兼容模型调用；未配置时调用方使用抽取式回答/Wiki 草稿，不阻塞轻量部署。
// 输入/输出预算由云端模型设置或环境变量统一控制；输入预算按字符估算，宁可少放证据也不硬塞。
const FORMATS = new Set(['auto', 'markdown', 'text', 'json', 'custom'])

function integerEnv(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

export function llmConfig() {
  const base = process.env.TEAM_LLM_API_BASE?.trim() || ''
  const model = process.env.TEAM_LLM_MODEL?.trim() || ''
  const key = process.env.TEAM_LLM_API_KEY?.trim() || ''
  const rawFormat = process.env.TEAM_LLM_OUTPUT_FORMAT?.trim() || 'auto'
  return {
    base,
    model,
    key,
    enabled: base !== '' && model !== '',
    maxInputTokens: integerEnv(process.env.TEAM_LLM_MAX_INPUT_TOKENS, 16000, 256, 128000),
    maxOutputTokens: integerEnv(process.env.TEAM_LLM_MAX_OUTPUT_TOKENS, 2400, 64, 32000),
    outputFormat: FORMATS.has(rawFormat) ? rawFormat : 'auto',
    outputInstructions: process.env.TEAM_LLM_OUTPUT_INSTRUCTIONS?.trim() || '',
  }
}

function estimateTokens(text) {
  const cjk = (String(text).match(/[\u3400-\u9fff\uf900-\ufaff]/gu) ?? []).length
  return cjk + Math.ceil((String(text).length - cjk) / 4)
}

function trimText(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text
  const maxChars = Math.max(0, maxTokens * 2)
  if (text.length <= maxChars) return text
  const head = text.slice(0, Math.ceil(maxChars * 0.72))
  const tail = text.slice(-Math.floor(maxChars * 0.18))
  return `${head}\n\n…（已按输入预算截断）…\n\n${tail}`
}

function boundedMessages(messages, maxInputTokens) {
  const next = messages.map(message => ({ ...message, content: String(message.content ?? '') }))
  let total = next.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  if (total <= maxInputTokens) return next
  const systemBudget = Math.min(2000, Math.floor(maxInputTokens * 0.25))
  const systemMessages = next.filter(message => message.role === 'system')
  const otherMessages = next.filter(message => message.role !== 'system')
  const systemTotal = systemMessages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  if (systemTotal > systemBudget) {
    let remaining = systemBudget
    for (const message of systemMessages) {
      const budget = Math.max(64, Math.floor(systemBudget * (estimateTokens(message.content) / systemTotal)))
      message.content = trimText(message.content, Math.min(budget, remaining))
      remaining -= estimateTokens(message.content)
    }
  }
  total = next.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  const available = Math.max(128, maxInputTokens - total + otherMessages.reduce((sum, message) => sum + estimateTokens(message.content), 0))
  const otherTotal = Math.max(1, otherMessages.reduce((sum, message) => sum + estimateTokens(message.content), 0))
  for (const message of otherMessages) {
    const share = Math.max(48, Math.floor(available * (estimateTokens(message.content) / otherTotal)))
    message.content = trimText(message.content, share)
  }
  return next
}

function formatDirective(config, requested) {
  const format = config.outputFormat !== 'auto' ? config.outputFormat : (requested ?? 'markdown')
  if (format === 'custom' && config.outputInstructions !== '') return config.outputInstructions
  if (format === 'text') return '请只输出纯文本，不使用 Markdown、表格或代码围栏。'
  if (format === 'json') return '请只输出合法 JSON，不要 Markdown 代码围栏或额外解释。'
  if (format === 'markdown') return '请使用 Markdown 输出，不要额外解释格式。'
  return ''
}

export async function chatCompletion(messages, { maxTokens = 1200, format, signal } = {}) {
  const config = llmConfig()
  if (!config.enabled) return undefined
  const prepared = Array.isArray(messages) ? messages.map(message => ({
    role: message.role,
    content: String(message.content ?? ''),
  })) : []
  const directive = formatDirective(config, format)
  if (directive !== '') prepared.unshift({ role: 'system', content: directive })
  const bounded = boundedMessages(prepared, config.maxInputTokens)
  const url = `${config.base.replace(/\/+$/u, '')}/chat/completions`
  const timeout = AbortSignal.timeout(60_000)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.key === '' ? {} : { authorization: `Bearer ${config.key}` }) },
    body: JSON.stringify({ model: config.model, messages: bounded, temperature: 0, max_tokens: config.maxOutputTokens || maxTokens }),
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  if (!response.ok) return undefined
  const payload = await response.json().catch(() => undefined)
  const text = payload?.choices?.[0]?.message?.content
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined
}
