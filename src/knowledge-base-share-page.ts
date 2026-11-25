import { renderSharedMarkdown } from './notes/share-markdown.js'
import { SHARE_PAGE_CSS } from './notes/share-page-styles.js'
import { STANDALONE_TOKENS } from './knowledge-share-page.js'

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export interface KnowledgeBaseShareDocument {
  id: string
  title: string
  relPath?: string
  body: string
}

export interface KnowledgeBaseSharePageInput {
  apiPrefix: string
  token: string
  baseName: string
  documents: KnowledgeBaseShareDocument[]
  selectedId?: string
  truncated?: boolean
}

export function renderKnowledgeBaseSharePage(input: KnowledgeBaseSharePageInput): string {
  const base = `${input.apiPrefix.replace(/\/$/, '')}/shared-base/${encodeURIComponent(input.token)}`
  const selected = input.documents.find(row => row.id === input.selectedId) ?? input.documents[0]
  const list = input.documents.slice(0, 2000).map(document => {
    const href = `${base}?doc=${encodeURIComponent(document.id)}`
    return `<a class="base-doc-link" href="${escapeHtml(href)}"${document.id === selected?.id ? ' aria-current="document"' : ''}><strong>${escapeHtml(document.title)}</strong><small>${escapeHtml(document.relPath ?? '')}</small></a>`
  }).join('')
  const rendered = selected === undefined ? undefined : renderSharedMarkdown(selected.body)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>${escapeHtml(input.baseName)} · 知识库分享</title>
<style>${STANDALONE_TOKENS}${SHARE_PAGE_CSS}
.share-base-layout{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);min-height:calc(100dvh - 210px)}
.base-doc-list{overflow:auto;padding:12px;border-right:1px solid var(--line);background:var(--panel);max-height:calc(100dvh - 150px)}
.base-doc-link{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;color:var(--text-secondary);text-decoration:none;font-size:12px}
.base-doc-link strong{font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.base-doc-link small{color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.base-doc-link:hover{background:rgba(255,255,255,.55)}.base-doc-link[aria-current=document]{background:var(--raised);box-shadow:inset 2px 0 0 var(--accent)}
.base-share-content{min-width:0;overflow:auto}.base-empty{padding:32px;color:var(--muted)}
@media(max-width:760px){.share-base-layout{display:flex;flex-direction:column}.base-doc-list{max-height:30dvh;border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body>
<main class="share-shell">
  <header class="share-header"><div class="share-title"><span class="eyebrow">DSH KNOWLEDGE</span><h1>${escapeHtml(input.baseName)}</h1><p>整个知识库 · 只读分享${input.truncated ? ' · 文档较多，仅列出前 2000 篇' : ''}</p></div><span class="readonly">只读分享</span></header>
  <div class="share-base-layout">
    <nav class="base-doc-list" aria-label="知识文档">${list || '<p class="base-empty">这个知识库还没有文档。</p>'}</nav>
    <article class="base-share-content"><div class="document"><div class="markdown-body">${rendered?.html ?? '<p class="base-empty">选择左侧文档查看。</p>'}</div></div></article>
  </div>
  <footer class="share-footer"><span>由 DSH Knowledge 生成 · 链接可随时撤销</span>${selected ? `<a href="${escapeHtml(`${base}/raw?doc=${encodeURIComponent(selected.id)}`)}">下载当前 Markdown</a>` : ''}</footer>
</main>
</body></html>`
}
