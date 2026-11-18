import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { BrandWordmark } from '@deepseek-ai/dsh-client-ui-primitives'

interface MorningTodo {
  id: string
  text: string
  cat: 'work' | 'life'
  done: boolean
  carriedFrom?: string
}

interface MorningBrief {
  day: string
  yesterday?: string
  summary?: string
  markdown?: string
  counts?: { total?: number; done?: number; unfinished?: number; work?: number; life?: number }
  todos?: MorningTodo[]
}

interface MorningResponse {
  day: string
  brief?: MorningBrief
  meeting?: { available: boolean; tool?: string; summary?: string; error?: string }
}

interface CardBox {
  left: number
  top: number
  width: number
  maxHeight: number
  placement: 'above' | 'below'
  arrow: number
}

const CARD_WIDTH = 440
const GAP = 12
const EDGE = 16

export function HeroMorningCard({ size = 34, className }: { size?: number; className?: string }) {
  const [open, setOpen] = useState(true)
  const [data, setData] = useState<MorningResponse>()
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [cat, setCat] = useState<'work' | 'life'>('work')
  const [box, setBox] = useState<CardBox>()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLElement>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/knowledge-local/v1/morning', {
        credentials: 'same-origin',
        headers: { 'x-dsh-knowledge-client': 'management-web' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setData(await response.json() as MorningResponse)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 60_000)
    return () => window.clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (cardRef.current?.contains(target) || anchorRef.current?.contains(target))) return
      setOpen(false)
    }
    window.addEventListener('keydown', close)
    window.addEventListener('pointerdown', outside, true)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('pointerdown', outside, true)
    }
  }, [open])

  const place = useCallback(() => {
    const anchor = anchorRef.current, card = cardRef.current
    if (!anchor || !card) return
    const anchorRect = anchor.getBoundingClientRect()
    const width = Math.min(CARD_WIDTH, window.innerWidth - EDGE * 2)
    const natural = card.scrollHeight || 360
    const above = anchorRect.top - EDGE - GAP
    const below = window.innerHeight - anchorRect.bottom - EDGE - GAP
    const placement: 'above' | 'below' = above >= 240 || above >= below ? 'above' : 'below'
    const room = placement === 'above' ? above : below
    const maxHeight = Math.max(140, Math.min(room, window.innerHeight - EDGE * 2))
    const height = Math.min(natural, maxHeight)
    const desiredTop = placement === 'above' ? anchorRect.top - height - GAP : anchorRect.bottom + GAP
    const top = Math.max(EDGE, Math.min(window.innerHeight - height - EDGE, desiredTop))
    const left = Math.max(EDGE, Math.min(window.innerWidth - width - EDGE, anchorRect.left + anchorRect.width / 2 - width / 2))
    const next: CardBox = {
      left,
      top,
      width,
      maxHeight,
      placement,
      arrow: Math.max(12, Math.min(width - 12, anchorRect.left + anchorRect.width / 2 - left)),
    }
    setBox(previous => previous && previous.left === next.left && previous.top === next.top
      && previous.width === next.width && previous.maxHeight === next.maxHeight
      && previous.placement === next.placement && previous.arrow === next.arrow ? previous : next)
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    place()
    const frame = window.requestAnimationFrame(place)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place, data])

  const mutate = async (body: Record<string, unknown>) => {
    const response = await fetch('/worklog-control/v1/todos', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dsh-worklog-client': 'workspace' },
      body: JSON.stringify({ ...body, day: data?.day }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await load()
  }

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft.trim()) return
    try {
      await mutate({ action: 'add', text: draft.trim(), cat })
      setDraft('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const todos = data?.brief?.todos ?? []
  const counts = data?.brief?.counts
  const meetingText = data?.meeting?.available
    ? data.meeting.summary || '会议助手已就绪'
    : '会议助手未连接'

  return <>
    <button
      ref={anchorRef}
      type="button"
      className="dsh-knowledge-morning-brand"
      aria-label={open ? '收起早晨卡片' : '打开早晨卡片'}
      onClick={() => setOpen(value => !value)}
    >
      <BrandWordmark size={size} includeMark className={className} />
    </button>
    {open && <section
      ref={cardRef}
      className="dsh-knowledge-morning-card"
      role="dialog"
      aria-modal="false"
      aria-label="早晨卡片"
      data-placement={box?.placement ?? 'above'}
      style={box ? {
        left: box.left,
        top: box.top,
        width: box.width,
        maxHeight: box.maxHeight,
        visibility: 'visible',
        ['--dsh-morning-arrow' as string]: `${box.arrow}px`,
      } : { visibility: 'hidden' }}
    >
      <header className="dsh-knowledge-morning-head">
        <div className="dsh-knowledge-morning-title">
          早晨卡片
          <small>{data?.day || '今天'}{counts?.total !== undefined ? ` · ${counts.total} 项待办` : ''}</small>
        </div>
        <button type="button" className="dsh-knowledge-morning-x" aria-label="收起早晨卡片" onClick={() => setOpen(false)}>×</button>
      </header>
      <div className="dsh-knowledge-morning-scroll">
        {error ? <p className="dsh-knowledge-morning-note" role="status">早晨卡片暂不可用 · {error}</p> : null}
        <p className="dsh-knowledge-morning-summary">{data?.brief?.summary || '今天还没有可回顾的日报，先在下面记几件要做的事。'}</p>
        <div className="dsh-knowledge-morning-stats">
          <span>{counts?.unfinished ?? 0} 项未完成</span>
          <span>{counts?.done ?? 0} 项完成</span>
        </div>
        <aside className="dsh-knowledge-morning-discovery">
          <b>会议助手：</b>{meetingText}
        </aside>
        <section className="dsh-knowledge-morning-todos">
          <h4>今日待办 · {todos.length}</h4>
          {todos.length === 0 ? <p className="dsh-knowledge-morning-empty">今天还没有待办。</p> : <ul>
            {todos.slice(0, 8).map(todo => <li key={todo.id} className={todo.done ? 'is-done' : ''}>
              <label>
                <input type="checkbox" checked={todo.done} onChange={() => { void mutate({ action: 'toggle', id: todo.id }).catch(reason => setError(String(reason))) }} />
                <span>{todo.text}</span>
              </label>
              {todo.carriedFrom ? <small>承接 {todo.carriedFrom}</small> : null}
              <button type="button" className="dsh-knowledge-morning-delete" aria-label="删除待办" onClick={() => { void mutate({ action: 'delete', id: todo.id }).catch(reason => setError(String(reason))) }}>×</button>
            </li>)}
          </ul>}
          <form className="dsh-knowledge-morning-add" onSubmit={event => { void add(event) }}>
            <select value={cat} onChange={event => setCat(event.target.value === 'life' ? 'life' : 'work')} aria-label="待办分类">
              <option value="work">工作</option>
              <option value="life">生活</option>
            </select>
            <input value={draft} onChange={event => setDraft(event.target.value)} maxLength={500} placeholder="加一件今天要做的事" aria-label="新待办" />
            <button type="submit" disabled={!draft.trim()}>添加</button>
          </form>
        </section>
      </div>
      <footer className="dsh-knowledge-morning-foot">
        <span>本地简报 · 每分钟刷新</span>
        <button type="button" className="dsh-knowledge-morning-btn" onClick={() => { void load() }}>刷新</button>
        <button type="button" className="dsh-knowledge-morning-btn primary" onClick={() => window.open('/worklog', '_blank', 'noopener,noreferrer')}>打开日报</button>
      </footer>
    </section>}
  </>
}
