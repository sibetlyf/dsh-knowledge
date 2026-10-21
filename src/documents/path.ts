import type { KnowledgeEntry } from '../domain.js'

/** Safe one-segment name for a knowledge base/group folder. */
export function knowledgeFolderName(name: string, fallback = '未命名'): string {
  const value = name.normalize('NFKC').trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/^[.\s]+|[.\s]+$/gu, '')
    .slice(0, 80)
  return value.length > 0 && value !== '.' && value !== '..' ? value : fallback
}

/** Group names are stored as `一级 · 二级`; mirror that structure as folders. */
export function knowledgeGroupFolders(group: string | undefined): string[] {
  if (group === undefined || group.trim().length === 0) return []
  return group
    .split(/\s*(?:·|\/|>|＞)\s*/u)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => knowledgeFolderName(part))
}

/** Stable, human-readable Markdown path shared by storage and retrieval output. */
export function knowledgeDocumentPath(entry: Pick<KnowledgeEntry, 'id' | 'title'> & { group?: string }): string {
  const stem = entry.title.normalize('NFKC').trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 72) || 'untitled'
  const suffix = entry.id.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 8) || 'document'
  return [...knowledgeGroupFolders(entry.group), `${stem}--${suffix}.md`].join('/')
}
