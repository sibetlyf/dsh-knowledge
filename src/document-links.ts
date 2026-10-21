import type { KnowledgeProvider } from './provider.js'

/** One automatically derived document link shown in the console. */
export interface KnowledgeDocumentLink {
  id: string
  title: string
  knowledgeBaseId: string
  reason: 'explicit' | 'backlink' | 'tag' | 'group' | 'topic'
}

/** One `[[Title]]` reference found in the current document. */
export interface KnowledgeWikiReference {
  title: string
  label: string
  documentId: string
  knowledgeBaseId: string
}

export interface KnowledgeDocumentLinks {
  /** Outgoing and symmetric relations; both documents in a relation list each other. */
  related: KnowledgeDocumentLink[]
  /** Documents whose body explicitly references the current document title. */
  backlinks: KnowledgeDocumentLink[]
  /** Resolved `[[Title]]` targets in the current body, used for clickable previews. */
  references: KnowledgeWikiReference[]
}

const GENERIC_TAGS = new Set(['artifact', 'deliverable', 'upload', 'presented', 'file-tool'])
const MAX_LINKS = 8
const MAX_CANDIDATES = 100

/**
 * Compute bidirectional links for one knowledge document.
 *
 * Links are derived, never written into the body, so previews stay stable and
 * no document version is created just to refresh a link. The relation is
 * symmetric for shared tags, document group and title topics (both documents
 * display each other), directional for explicit `[[Title]]` references (the
 * target lists them under backlinks), and every document in a non-empty base
 * keeps at least one related document instead of rendering an empty panel.
 */
export async function resolveDocumentLinks(
  provider: KnowledgeProvider,
  id: string,
  signal?: AbortSignal,
): Promise<KnowledgeDocumentLinks | undefined> {
  const entry = await provider.get(id, signal)
  if (entry === undefined || entry.status !== 'active') return undefined
  const page = await provider.list({ knowledgeBaseId: entry.knowledgeBaseId, status: 'active', limit: MAX_CANDIDATES }, signal)
  const candidates = page.items.filter(item => item.id !== entry.id)
  const byTitle = new Map(candidates.map(candidate => [wikiKey(candidate.title), candidate]))
  const targets = parseWikiTargets(entry.body)
  const references: KnowledgeWikiReference[] = []
  for (const target of targets) {
    const candidate = byTitle.get(target.key)
    if (candidate === undefined) continue
    if (references.some(reference => reference.documentId === candidate.id)) continue
    references.push({
      title: target.raw,
      label: target.label ?? target.raw,
      documentId: candidate.id,
      knowledgeBaseId: candidate.knowledgeBaseId,
    })
  }
  const related: KnowledgeDocumentLink[] = []
  const backlinks: KnowledgeDocumentLink[] = []
  const entryInput: LinkInput = {
    title: entry.title,
    tags: entry.tags,
    ...entry.group === undefined ? {} : { group: entry.group },
    references: new Set(targets.map(target => target.key)),
    keywords: bodyKeywords(entry.body),
  }
  const inputs = new Map<string, LinkInput>()
  for (const candidate of candidates) {
    inputs.set(candidate.id, {
      title: candidate.title,
      tags: candidate.tags,
      ...candidate.group === undefined ? {} : { group: candidate.group },
      references: new Set(parseWikiTargets(candidate.body).map(target => target.key)),
      keywords: bodyKeywords(candidate.body),
    })
  }
  for (const candidate of candidates) {
    const relation = relationBetween(entryInput, inputs.get(candidate.id)!)
    if (relation === undefined) continue
    const link: KnowledgeDocumentLink = {
      id: candidate.id,
      title: candidate.title,
      knowledgeBaseId: candidate.knowledgeBaseId,
      reason: relation.reason,
    }
    if (relation.explicitIn) backlinks.push(link)
    if (relation.explicitOut || relation.sharedTags > 0 || relation.topicScore >= 2 || (relation.sameGroup && relation.score >= 2)) related.push(link)
  }
  const dedupedRelated = dedupe(related).slice(0, MAX_LINKS)
  if (dedupedRelated.length === 0 && candidates.length > 0) {
    const fallback = candidates.find(candidate => entry.group && candidate.group === entry.group) ?? candidates[0]!
    dedupedRelated.push({ id: fallback.id, title: fallback.title, knowledgeBaseId: fallback.knowledgeBaseId, reason: 'topic' })
  }
  return { related: dedupedRelated, backlinks: dedupe(backlinks).slice(0, MAX_LINKS), references }
}

interface WikiTarget {
  raw: string
  key: string
  label?: string
}

function parseWikiTargets(body: string): WikiTarget[] {
  const targets: WikiTarget[] = []
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/gu
  for (const match of body.matchAll(pattern)) {
    const raw = (match[1] ?? '').trim()
    if (raw.length === 0) continue
    targets.push({
      raw,
      key: wikiKey(raw),
      ...match[2] === undefined ? {} : { label: match[2].trim() },
    })
    if (targets.length >= 200) break
  }
  return targets
}

export function wikiKey(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
}

/** Normalized `[[Title]]` targets in one body, for graph construction. */
export function wikiTargetsOf(body: string): Set<string> {
  return new Set(parseWikiTargets(body).map(target => target.key))
}

/** Keywords in an artifact-style `- 关键词：a、b` line. */
export function bodyKeywords(body: string): Set<string> {
  const keywords = new Set<string>()
  const match = /关键词[:：]\s*([^\n]+)/u.exec(body)
  if (match === null) return keywords
  for (const term of (match[1] ?? '').split(/[\s、,，;；]+/u)) {
    const value = wikiKey(term)
    if (value.length >= 2 && value.length <= 40 && value !== '无' && value !== '未提取到' && value !== 'none') keywords.add(value)
    if (keywords.size >= 24) break
  }
  return keywords
}

export interface LinkInput {
  title: string
  tags: readonly string[]
  group?: string
  /** Normalized `[[Title]]` targets found in the body. */
  references: ReadonlySet<string>
  /** Bounded keywords extracted from the body (artifact documents store them explicitly). */
  keywords?: ReadonlySet<string>
}

export interface LinkRelation {
  score: number
  reason: KnowledgeDocumentLink['reason']
  explicitOut: boolean
  explicitIn: boolean
  sharedTags: number
  topicScore: number
  sameGroup: boolean
}

/** Score one unordered pair; the symmetric parts are identical in both directions. */
export function relationBetween(left: LinkInput, right: LinkInput): LinkRelation | undefined {
  const explicitOut = left.references.has(wikiKey(right.title))
  const explicitIn = right.references.has(wikiKey(left.title))
  const sharedTags = sharedLinkTags(
    [...left.tags, ...(left.keywords ?? [])],
    [...right.tags, ...(right.keywords ?? [])],
  )
  const sameGroup = Boolean(left.group) && left.group === right.group
  const topicScore = titleTopicOverlap(left.title, right.title)
  const score = (explicitOut ? 10 : 0) + (explicitIn ? 12 : 0) + sharedTags.length * 2 + (sameGroup ? 1 : 0) + Math.min(3, topicScore)
  if (score <= 0 || !(score >= 2 || explicitOut || explicitIn || sameGroup)) return undefined
  return {
    score,
    reason: explicitOut ? 'explicit' : explicitIn ? 'backlink' : sharedTags.length > 0 ? 'tag' : sameGroup ? 'group' : 'topic',
    explicitOut, explicitIn, sharedTags: sharedTags.length, topicScore, sameGroup,
  }
}

function sharedLinkTags(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right.map(tag => tag.toLocaleLowerCase()))
  return left.map(tag => tag.toLocaleLowerCase()).filter(tag => !GENERIC_TAGS.has(tag) && tag.length > 1 && rightSet.has(tag))
}

function titleTopicOverlap(left: string, right: string): number {
  const leftTokens = topicTokens(left)
  const rightTokens = topicTokens(right)
  let shared = 0
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1
  return shared
}

function topicTokens(value: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of value.toLocaleLowerCase().matchAll(/[a-z0-9][a-z0-9._-]{1,}/gu)) tokens.add(match[0])
  for (const match of value.matchAll(/[\u4e00-\u9fff]{2,}/gu)) {
    const text = match[0]
    for (let index = 0; index + 1 < text.length; index += 1) tokens.add(text.slice(index, index + 2))
  }
  return tokens
}

function dedupe(links: KnowledgeDocumentLink[]): KnowledgeDocumentLink[] {
  const seen = new Map<string, KnowledgeDocumentLink>()
  for (const link of links) if (!seen.has(link.id)) seen.set(link.id, link)
  return [...seen.values()]
}
