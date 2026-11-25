import { renderSharedMarkdown } from './notes/share-markdown.js'
import { SHARE_PAGE_CSS } from './notes/share-page-styles.js'
import { STANDALONE_TOKENS } from './knowledge-share-page.js'

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export interface WorklogSharePageInput {
  apiPrefix: string
  token: string
  day: string
  days: string[]
  markdown: string
  updated?: number
  todos?: Array<{ text: string; cat?: string; done?: boolean; carriedFrom?: string }>
  title?: string
}

export function renderWorklogSharePage(input: WorklogSharePageInput): string {
  const base = `${input.apiPrefix.replace(/\/$/, '')}/shared-worklog/${encodeURIComponent(input.token)}`
  const rendered = renderSharedMarkdown(input.markdown || '')
  const nav = input.days.slice(0, 60).map(day => `<a href="${escapeHtml(`${base}?day=${encodeURIComponent(day)}`)}"${day === input.day ? ' aria-current="date"' : ''}>${escapeHtml(day)}</a>`).join('')
  const todoRows = (input.todos ?? []).map(todo => `<li class="${todo.done ? 'is-done' : ''}"><span>${todo.done ? '☑' : '☐'}</span>${escapeHtml(todo.text)}${todo.carriedFrom ? `<small>承接 ${escapeHtml(todo.carriedFrom)}</small>` : ''}</li>`).join('')
  const updated = input.updated ? new Date(input.updated).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>${escapeHtml(input.title || '工作日报')} · ${escapeHtml(input.day)}</title>
<style>${STANDALONE_TOKENS}${SHARE_PAGE_CSS}
.share-date-nav{display:flex;gap:6px;overflow:auto;padding:12px clamp(16px,3vw,32px);border-bottom:1px solid var(--line);scrollbar-width:thin}
.share-date-nav a{flex:none;border:1px solid var(--line);border-radius:999px;padding:4px 10px;color:var(--text-secondary);font-size:11px;text-decoration:none}
.share-date-nav a[aria-current=date]{border-color:var(--accent);background:var(--accent);color:#fff}
.share-todos{margin:0 clamp(16px,3vw,32px) 24px;padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface-raised)}
.share-todos h2{margin:0 0 8px;font-size:14px}.share-todos ul{display:grid;gap:5px;margin:0;padding:0;list-style:none;font-size:13px}
.share-todos li{display:flex;gap:7px;align-items:baseline}.share-todos li.is-done{color:var(--muted);text-decoration:line-through}.share-todos small{color:var(--muted);font-size:10px}
</style></head><body>
<main class="share-shell">
  <header class="share-header"><div class="share-title"><span class="eyebrow">DSH KNOWLEDGE · WORKLOG</span><h1>工作日报</h1><p>${escapeHtml(input.day)}${updated ? ` · 整理于 ${escapeHtml(updated)}` : ''} · 只读分享</p></div><span class="readonly">只读分享</span></header>
  <nav class="share-date-nav" aria-label="日期">${nav}</nav>
  <div class="share-workspace is-single"><article class="share-content"><div class="document"><div class="markdown-body">${rendered.html || '<p class="empty">这一天还没有日报。</p>'}</div></div></article></div>
  ${todoRows ? `<section class="share-todos"><h2>当天待办</h2><ul>${todoRows}</ul></section>` : ''}
  <footer class="share-footer"><span>由 DSH Knowledge 生成 · 链接可随时撤销</span><a href="${escapeHtml(base + '/raw')}">下载 Markdown</a></footer>
</main>
</body></html>`
}
