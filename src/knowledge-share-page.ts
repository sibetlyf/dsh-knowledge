import { renderSharedMarkdown } from './notes/share-markdown.js'
import { SHARE_PAGE_CSS } from './notes/share-page-styles.js'

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

const STANDALONE_TOKENS = `:root{--bg:#f5f6f7;--text:#202428;--text-secondary:#5c646b;--text-tertiary:#8b939a;--border:#d7dce0;--border-strong:#b5bcc2;--surface-raised:#fff;--accent:#3f647b;--font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;--font-mono:ui-monospace,SFMono-Regular,Consolas,monospace;--font-reading:Georgia,"Songti SC","Noto Serif CJK SC",serif}
@media(prefers-color-scheme:dark){:root{--bg:#15181a;--text:#eef1f3;--text-secondary:#aab2b8;--text-tertiary:#7d868d;--border:#333a3f;--border-strong:#4a545b;--surface-raised:#202528;--accent:#8eb6cd}}`

export interface KnowledgeSharePageInput {
  apiPrefix: string
  token: string
  title: string
  body: string
  baseTitle?: string
}

export function renderKnowledgeSharePage(input: KnowledgeSharePageInput): string {
  const rendered = renderSharedMarkdown(input.body)
  const baseHref = `${input.apiPrefix.replace(/\/$/, '')}/shared-knowledge/${encodeURIComponent(input.token)}`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>${escapeHtml(input.title)} · 知识库分享</title>
<style>${STANDALONE_TOKENS}${SHARE_PAGE_CSS}</style></head><body>
<main class="share-shell">
  <header class="share-header"><div class="share-title"><span class="eyebrow">DSH KNOWLEDGE</span><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.baseTitle ?? '知识库文档')} · 只读分享</p></div><span class="readonly">只读分享</span></header>
  <div class="share-workspace is-single">
    <article class="share-content"><div class="document"><div class="markdown-body">${rendered.html}</div></div></article>
  </div>
  <footer class="share-footer"><span>由 DSH Knowledge 生成 · 链接可随时撤销</span><a href="${escapeHtml(baseHref + '/raw')}" download="${escapeHtml(input.title)}.md">下载 Markdown</a></footer>
</main>
</body></html>`
}
