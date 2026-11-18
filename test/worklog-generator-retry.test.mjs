import test from 'node:test'
import assert from 'node:assert/strict'
import { generate } from '../worklog/generator.js'

test('full report retries with a larger budget after max-tokens, then succeeds', async () => {
  const budgets = []
  const llm = {
    async *stream(request) {
      budgets.push(request.maxTokens)
      if (budgets.length === 1) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'text-delta', text: '完成 [依据:a]' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const output = await generate(llm, { records: [{ id: 'a' }], route: {} }, new AbortController().signal)
  assert.equal(output, '完成 [依据:a]')
  assert.deepEqual(budgets, [32768, 65536])
})

test('partial report uses its own small first budget and escalates', async () => {
  const budgets = []
  const llm = {
    async *stream(request) {
      budgets.push(request.maxTokens)
      if (budgets.length === 1) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'text-delta', text: '事实 [依据:a]' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const output = await generate(llm, { records: [{ id: 'a' }], route: {}, partial: true }, new AbortController().signal)
  assert.equal(output, '事实 [依据:a]')
  assert.deepEqual(budgets, [4000, 16000])
})
