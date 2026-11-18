import { useEffect, useState } from 'react'
import { api } from './api.js'
import { Markdown } from './Markdown.jsx'

export function DailyBoard({ day, onMessage }) {
  const [todos, setTodos] = useState([])
  const [brief, setBrief] = useState(null)
  const [text, setText] = useState('')
  const [cat, setCat] = useState('work')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    Promise.all([
      api(`/todos?day=${encodeURIComponent(day)}`, undefined, controller.signal),
      api(`/brief?day=${encodeURIComponent(day)}`, undefined, controller.signal),
    ]).then(([todoResult, briefResult]) => {
      if (controller.signal.aborted) return
      setTodos(todoResult.todos || [])
      setBrief(briefResult)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason.message)
    })
    return () => controller.abort()
  }, [day])

  async function mutate(body) {
    setBusy(true)
    try {
      const result = await api('/todos', { ...body, day })
      setTodos(result.todos || [])
      setBrief(await api(`/brief?day=${encodeURIComponent(day)}`))
      setError('')
    } catch (reason) {
      setError(reason.message)
    } finally {
      setBusy(false)
    }
  }

  async function add(event) {
    event.preventDefault()
    if (!text.trim()) return
    await mutate({ action: 'add', text: text.trim(), cat })
    setText('')
  }

  const unfinished = todos.filter(todo => !todo.done).length
  const items = category => todos.filter(todo => todo.cat === category)
  const row = todo => <li key={todo.id} className={todo.done ? 'is-done' : ''}>
    <label><input type="checkbox" checked={todo.done} disabled={busy} onChange={() => mutate({ action: 'toggle', id: todo.id })} />
      <span>{todo.text}</span></label>
    {todo.carriedFrom ? <small>承接 {todo.carriedFrom}</small> : null}
    <button type="button" className="wl-todo-delete" disabled={busy} onClick={() => mutate({ action: 'delete', id: todo.id })} aria-label="删除待办">×</button>
  </li>

  return <section className="wl-daily-board">
    <header className="wl-daily-header">
      <div><h3>早晨卡片 · 每日待办</h3><p>{unfinished} 项未完成 · {todos.length - unfinished} 项完成 · {day}</p></div>
      <button type="button" disabled={busy} onClick={() => mutate({ action: 'carry' })}>顺延昨日未完成</button>
    </header>
    {brief ? <div className="wl-morning-brief">
      <div className="wl-morning-brief-head"><h4>早晨简报</h4>
        <button type="button" onClick={() => { navigator.clipboard?.writeText(brief.markdown).then(() => onMessage?.('简报已复制'), () => onMessage?.('复制失败')) }}>复制简报</button>
      </div>
      <Markdown text={brief.markdown} />
    </div> : null}
    <form className="wl-todo-add" onSubmit={add}>
      <select value={cat} onChange={event => setCat(event.target.value)} aria-label="待办分类">
        <option value="work">工作</option>
        <option value="life">生活</option>
      </select>
      <input value={text} onChange={event => setText(event.target.value)} maxLength={500} placeholder="今天要做的事" aria-label="新待办" />
      <button type="submit" className="wl-primary" disabled={busy || !text.trim()}>添加</button>
    </form>
    {error ? <p className="wl-error" role="alert">{error}</p> : null}
    <div className="wl-todo-columns">
      {['work', 'life'].map(category => <div key={category}>
        <h4>{category === 'work' ? '工作' : '生活'}</h4>
        {items(category).length === 0 ? <p className="wl-muted">暂无</p> : <ul>{items(category).map(row)}</ul>}
      </div>)}
    </div>
  </section>
}
