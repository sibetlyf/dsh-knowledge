import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../worklog/store.js'

function store(t) {
  const value = new Store(':memory:')
  t.after(() => value.close())
  return value
}

test('daily todos support work/life groups, toggles and carry-over', (t) => {
  const s = store(t)
  let todos = s.addTodo('2026-09-29', '修复登录问题', 'work')
  todos = s.addTodo('2026-09-29', '买牛奶', 'life')
  assert.equal(todos.length, 2)
  assert.equal(todos.find(todo => todo.text === '修复登录问题').cat, 'work')
  assert.equal(todos.find(todo => todo.text === '买牛奶').cat, 'life')
  const work = todos.find(todo => todo.text === '修复登录问题')
  todos = s.mutateTodo({ action: 'toggle', id: work.id })
  assert.equal(todos.find(todo => todo.id === work.id).done, true)
  todos = s.mutateTodo({ action: 'delete', id: todos.find(todo => todo.text === '买牛奶').id })
  assert.equal(todos.length, 1)

  s.carryTodos('2026-09-30')
  const next = s.todos('2026-09-30')
  assert.equal(next.length, 0, 'completed tasks are not carried')

  s.addTodo('2026-09-29', '继续联调', 'work')
  s.carryTodos('2026-09-30')
  const carried = s.todos('2026-09-30')
  assert.equal(carried.length, 1)
  assert.equal(carried[0].text, '继续联调')
  assert.equal(carried[0].carriedFrom, '2026-09-29')
})

test('brief combines yesterday report and today todos', (t) => {
  const s = store(t)
  s.save('2026-09-28', '# 昨日日报\n\n完成登录修复。', 0, [], true)
  s.addTodo('2026-09-29', '回归测试', 'work')
  const brief = s.brief('2026-09-29')
  assert.equal(brief.yesterday, '2026-09-28')
  assert.match(brief.markdown, /昨日日报/u)
  assert.match(brief.markdown, /回归测试/u)
  assert.match(brief.summary, /昨日日报/u)
  assert.match(brief.markdown, /每日简报/u)
  assert.equal(brief.counts.total, 1)
  assert.equal(brief.counts.unfinished, 1)
})

test('weekly and monthly periods aggregate daily reports and use a cloud default route', (t) => {
  const s = new Store(':memory:', { provider: 'deepseek-cloud', model: 'cloud-model' })
  t.after(() => s.close())
  assert.equal(s.config().provider, 'deepseek-cloud')
  assert.equal(s.config().model, 'cloud-model')
  s.save('2026-09-28', '# 周一\n\n完成 A。', 0, [], true)
  s.save('2026-09-29', '# 周二\n\n完成 B。', 0, [], true)
  const week = s.period('2026-09-29', 'week')
  assert.equal(week.from, '2026-09-28')
  assert.equal(week.to, '2026-10-04')
  assert.match(week.markdown, /周报/u)
  assert.match(week.markdown, /完成 A/u)
  const month = s.period('2026-09-29', 'month')
  assert.equal(month.from, '2026-09-01')
  assert.equal(month.to, '2026-09-30')
  assert.match(month.markdown, /月报/u)
})
