// 云端模型设置：管理员可在云端页面持久化 OpenAI 兼容接口配置。
// 数据库配置优先于启动时的环境变量；清空数据库配置后回退环境变量。
const KEYS = {
  base: 'llm.apiBase',
  model: 'llm.model',
  key: 'llm.apiKey',
  maxInput: 'llm.maxInputTokens',
  maxOutput: 'llm.maxOutputTokens',
  format: 'llm.outputFormat',
  instructions: 'llm.outputInstructions',
}

const ENV = {
  base: 'TEAM_LLM_API_BASE',
  model: 'TEAM_LLM_MODEL',
  key: 'TEAM_LLM_API_KEY',
  maxInput: 'TEAM_LLM_MAX_INPUT_TOKENS',
  maxOutput: 'TEAM_LLM_MAX_OUTPUT_TOKENS',
  format: 'TEAM_LLM_OUTPUT_FORMAT',
  instructions: 'TEAM_LLM_OUTPUT_INSTRUCTIONS',
}

const INITIAL = {
  base: process.env.TEAM_LLM_API_BASE ?? '',
  model: process.env.TEAM_LLM_MODEL ?? '',
  key: process.env.TEAM_LLM_API_KEY ?? '',
  maxInput: process.env.TEAM_LLM_MAX_INPUT_TOKENS ?? '16000',
  maxOutput: process.env.TEAM_LLM_MAX_OUTPUT_TOKENS ?? '2400',
  format: process.env.TEAM_LLM_OUTPUT_FORMAT ?? 'auto',
  instructions: process.env.TEAM_LLM_OUTPUT_INSTRUCTIONS ?? '',
}

const FORMATS = new Set(['auto', 'markdown', 'text', 'json', 'custom'])


function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizedBase(value) {
  const raw = text(value).replace(/\/+$/u, '')
  if (raw === '') return ''
  if (raw.length > 500) throw new Error('模型接口地址过长')
  let parsed
  try { parsed = new URL(raw) } catch { throw new Error('模型接口地址不是完整 URL') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('模型接口地址必须使用 http 或 https')
  if (parsed.username !== '' || parsed.password !== '') throw new Error('模型接口地址不能包含用户名或密码')
  if (parsed.search !== '' || parsed.hash !== '') throw new Error('模型接口地址不能包含查询参数或锚点')
  return raw
}

function normalizedModel(value) {
  const model = text(value)
  if (model.length > 200) throw new Error('模型名过长')
  return model
}

function tokenLimit(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}必须是 ${min}-${max} 的整数`)
  return number
}

function normalizedFormat(value) {
  const format = text(value) || 'auto'
  if (!FORMATS.has(format)) throw new Error('输出格式无效')
  return format
}

function displayFormat(value) {
  const format = text(value) || 'auto'
  return FORMATS.has(format) ? format : 'auto'
}

function displayToken(value, fallback, min = 256, max = 128000) {
  try { return tokenLimit(value, fallback, min, max, 'token') } catch { return fallback }
}

export function applyStoredModelSettings(store) {
  const base = store.getSetting(KEYS.base)
  const model = store.getSetting(KEYS.model)
  const key = store.getSetting(KEYS.key)
  const maxInput = store.getSetting(KEYS.maxInput)
  const maxOutput = store.getSetting(KEYS.maxOutput)
  const format = store.getSetting(KEYS.format)
  const instructions = store.getSetting(KEYS.instructions)
  process.env[ENV.base] = base !== undefined && base !== '' ? base : INITIAL.base
  process.env[ENV.model] = model !== undefined && model !== '' ? model : INITIAL.model
  process.env[ENV.key] = key !== undefined ? key : INITIAL.key
  process.env[ENV.maxInput] = maxInput !== undefined && maxInput !== '' ? maxInput : INITIAL.maxInput
  process.env[ENV.maxOutput] = maxOutput !== undefined && maxOutput !== '' ? maxOutput : INITIAL.maxOutput
  process.env[ENV.format] = format !== undefined && format !== '' ? format : INITIAL.format
  process.env[ENV.instructions] = instructions !== undefined ? instructions : INITIAL.instructions
}

export function modelSettingsStatus(store) {
  const dbBase = store.getSetting(KEYS.base)
  const dbModel = store.getSetting(KEYS.model)
  const dbKey = store.getSetting(KEYS.key)
  const dbMaxInput = store.getSetting(KEYS.maxInput)
  const dbMaxOutput = store.getSetting(KEYS.maxOutput)
  const dbFormat = store.getSetting(KEYS.format)
  const dbInstructions = store.getSetting(KEYS.instructions)
  const base = dbBase !== undefined && dbBase !== '' ? dbBase : INITIAL.base
  const model = dbModel !== undefined && dbModel !== '' ? dbModel : INITIAL.model
  const key = dbKey !== undefined ? dbKey : INITIAL.key
  return {
    baseUrl: base,
    model,
    hasApiKey: key !== '',
    enabled: base.trim() !== '' && model.trim() !== '',
    source: dbBase !== undefined && dbBase !== '' ? 'database' : base !== '' ? 'environment' : 'none',
    keySource: dbKey !== undefined ? (dbKey === '' ? 'none' : 'database') : key !== '' ? 'environment' : 'none',
    maxInputTokens: displayToken(dbMaxInput ?? INITIAL.maxInput, 16000),
    maxOutputTokens: displayToken(dbMaxOutput ?? INITIAL.maxOutput, 2400, 64, 32000),
    outputFormat: displayFormat(dbFormat ?? INITIAL.format),
    outputInstructions: dbInstructions ?? INITIAL.instructions,
  }
}

export function saveModelSettings(store, input = {}) {
  const base = normalizedBase(input.baseUrl)
  const model = normalizedModel(input.model)
  const maxInput = tokenLimit(input.maxInputTokens, Number(INITIAL.maxInput) || 16000, 256, 128000, '最大输入 token')
  const maxOutput = tokenLimit(input.maxOutputTokens, Number(INITIAL.maxOutput) || 2400, 64, 32000, '最大输出 token')
  const format = normalizedFormat(input.outputFormat ?? INITIAL.format)
  const instructions = text(input.outputInstructions)
  if (instructions.length > 4000) throw new Error('自定义输出说明不能超过 4000 字符')
  if (base === '') store.deleteSetting(KEYS.base)
  else store.setSetting(KEYS.base, base)
  if (model === '') store.deleteSetting(KEYS.model)
  else store.setSetting(KEYS.model, model)
  store.setSetting(KEYS.maxInput, String(maxInput))
  store.setSetting(KEYS.maxOutput, String(maxOutput))
  store.setSetting(KEYS.format, format)
  if (instructions === '') store.deleteSetting(KEYS.instructions)
  else store.setSetting(KEYS.instructions, instructions)

  if (input.clearApiKey === true) store.deleteSetting(KEYS.key)
  else {
    const key = text(input.apiKey)
    if (key !== '') {
      if (key.length > 500) throw new Error('API Key 过长')
      store.setSetting(KEYS.key, key)
    }
  }
  applyStoredModelSettings(store)
  return modelSettingsStatus(store)
}
