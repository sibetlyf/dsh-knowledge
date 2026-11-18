import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
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
}

interface ManualPosition {
  left: number
  top: number
}

const CARD_WIDTH = 420
const GAP = 12
const EDGE = 16
const POSITION_KEY = 'dsh-knowledge-morning-position'

function savedPosition(): ManualPosition | null {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<ManualPosition>
    return typeof value.left === 'number' && typeof value.top === 'number' && Number.isFinite(value.left) && Number.isFinite(value.top)
      ? { left: value.left, top: value.top }
      : null
  } catch {
    return null
  }
}

export function HeroMorningCard({ size = 34, className }: { size?: number; className?: string }) {
  const [open, setOpen] = useState(true)
  const [data, setData] = useState<MorningResponse>()
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [cat, setCat] = useState<'work' | 'life'>('work')
  const [box, setBox] = useState<CardBox>()
  const [manual, setManual] = useState<ManualPosition | null>(savedPosition)
  const [dragging, setDragging] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  const manualRef = useRef<ManualPosition | null>(manual)

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
    const natural = card.scrollHeight || 380
    const manualPosition = manualRef.current
    if (manualPosition) {
      const height = Math.min(natural, window.innerHeight - EDGE * 2)
      const left = Math.max(EDGE, Math.min(window.innerWidth - width - EDGE, manualPosition.left))
      const top = Math.max(EDGE, Math.min(window.innerHeight - height - EDGE, manualPosition.top))
      setBox({ left, top, width, maxHeight: window.innerHeight - EDGE * 2, placement: 'above' })
      return
    }
    const above = anchorRect.top - EDGE - GAP
    const below = window.innerHeight - anchorRect.bottom - EDGE - GAP
    const placement: 'above' | 'below' = above >= 260 || above >= below ? 'above' : 'below'
    const room = placement === 'above' ? above : below
    const maxHeight = Math.max(140, Math.min(room, window.innerHeight - EDGE * 2))
    const height = Math.min(natural, maxHeight)
    const desiredTop = placement === 'above' ? anchorRect.top - height - GAP : anchorRect.bottom + GAP
    const top = Math.max(EDGE, Math.min(window.innerHeight - height - EDGE, desiredTop))
    const left = Math.max(EDGE, Math.min(window.innerWidth - width - EDGE, anchorRect.left + anchorRect.width / 2 - width / 2))
    const next: CardBox = { left, top, width, maxHeight, placement }
    setBox(previous => previous && previous.left === next.left && previous.top === next.top
      && previous.width === next.width && previous.maxHeight === next.maxHeight
      && previous.placement === next.placement ? previous : next)
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

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    const card = cardRef.current
    const current = box ? { left: box.left, top: box.top } : manualRef.current
    if (!card || !current) return
    event.preventDefault()
    const startX = event.clientX, startY = event.clientY
    const width = Math.min(CARD_WIDTH, window.innerWidth - EDGE * 2)
    const height = Math.min(card.scrollHeight || 380, window.innerHeight - EDGE * 2)
    setDragging(true)
    const move = (moveEvent: PointerEvent) => {
      const left = Math.max(EDGE, Math.min(window.innerWidth - width - EDGE, current.left + moveEvent.clientX - startX))
      const top = Math.max(EDGE, Math.min(window.innerHeight - height - EDGE, current.top + moveEvent.clientY - startY))
      manualRef.current = { left, top }
      setBox(previous => previous ? { ...previous, left, top } : previous)
      setManual({ left, top })
    }
    const finish = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      const position = manualRef.current
      if (position) {
        try { window.localStorage.setItem(POSITION_KEY, JSON.stringify(position)) } catch { /* storage can be unavailable */ }
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const resetPosition = () => {
    manualRef.current = null
    setManual(null)
    try { window.localStorage.removeItem(POSITION_KEY) } catch { /* storage can be unavailable */ }
    setBox(undefined)
    window.requestAnimationFrame(place)
  }

  const todos = data?.brief?.todos ?? []
  const counts = data?.brief?.counts
  const total = counts?.total ?? 0
  const done = counts?.done ?? 0
  const progress = total > 0 ? Math.round(done / total * 100) : 0
  const dayLabel = data?.day
    ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${data.day}T00:00:00`))
    : '今天'
  const meetingText = data?.meeting?.available
    ? data.meeting.summary || '会议助手已就绪'
    : '会议助手未连接'
  const meetingActive = meetingText.includes('正在听')

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
      } : { visibility: 'hidden' }}
    >
      <header
        className={`dsh-knowledge-morning-head${dragging ? ' is-dragging' : ''}`}
        onPointerDown={beginDrag}
        onDoubleClick={resetPosition}
        title="拖动移动卡片，双击恢复默认位置"
      >
        <div className="dsh-knowledge-morning-title">
          <h2>早晨卡片</h2>
          <small>{dayLabel}</small>
        </div>
        <button type="button" className="dsh-knowledge-morning-x" aria-label="收起早晨卡片" onClick={() => setOpen(false)}>×</button>
      </header>
      <div className="dsh-knowledge-morning-scroll">
        {error ? <p className="dsh-knowledge-morning-note" role="status">早晨卡片暂不可用 · {error}</p> : null}
        <div className="dsh-knowledge-morning-hero">
          <div className="dsh-knowledge-morning-ring" style={{ ['--dsh-morning-progress' as string]: `${progress}%` }}>
            <strong>{progress}<span>%</span></strong>
          </div>
          <div className="dsh-knowledge-morning-hero-copy">
            <div className="dsh-knowledge-morning-metric"><strong>{counts?.unfinished ?? 0}</strong><span>项待办</span></div>
            <small>{done} 项完成 · {total} 项总计</small>
          </div>
        </div>
        <p className="dsh-knowledge-morning-summary">{data?.brief?.summary || '今天还没有可回顾的日报，先在下面记几件要做的事。'}</p>
        <div className="dsh-knowledge-morning-meeting">
          <i className={`dsh-knowledge-morning-dot${meetingActive ? ' is-active' : ''}${data?.meeting?.available ? '' : ' is-off'}`} />
          <span>{meetingText}</span>
        </div>
        <div className="dsh-knowledge-morning-todo-head">
          <h4>今日待办</h4>
          <span>{todos.length}</span>
        </div>
        {todos.length === 0
          ? <p className="dsh-knowledge-morning-empty">今天还没有待办。</p>
          : <ul className="dsh-knowledge-morning-list">
            {todos.map(todo => <li key={todo.id} className={todo.done ? 'is-done' : ''}>
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
      </div>
      <footer className="dsh-knowledge-morning-foot">
        <span>每分钟刷新</span>
        <button type="button" className="dsh-knowledge-morning-btn" onClick={() => { void load() }}>刷新</button>
        <button type="button" className="dsh-knowledge-morning-btn primary" onClick={() => window.open('/knowledge?view=worklog', '_blank', 'noopener,noreferrer')}>打开日报</button>
      </footer>
    </section>}
  </>
}
