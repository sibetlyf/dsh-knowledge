import { bodyKeywords, relationBetween, wikiTargetsOf, type LinkInput } from './document-links.js'
import type { KnowledgeProvider } from './provider.js'

export interface KnowledgeGraphNode {
  id: string
  title: string
  group: string
  type: string
  tags: string[]
  degree: number
}

export interface KnowledgeGraphEdge {
  source: string
  target: string
  reason: 'explicit' | 'tag' | 'group' | 'topic'
  score: number
}

export interface KnowledgeGraph {
  knowledgeBase: { id: string; name: string }
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
  truncated: boolean
}

const MAX_EDGES = 600

/**
 * Build the document link graph of one knowledge base.
 *
 * The same relation rules as the per-document panel are used, but each body is
 * parsed once and every unordered pair is scored once. Nodes without relations
 * remain in the graph so the console can show isolated knowledge too.
 */
export async function resolveKnowledgeGraph(
  provider: KnowledgeProvider,
  knowledgeBaseId: string,
  limit = 80,
): Promise<KnowledgeGraph> {
  const bases = await provider.listKnowledgeBases()
  const base = bases.find(item => item.id === knowledgeBaseId && item.status === 'active')
  if (base === undefined) throw Object.assign(new Error('知识库不存在或已归档'), { status: 404 })
  const page = await provider.list({ knowledgeBaseId, status: 'active', limit: 100 })
  const entries = page.items.slice(0, Math.max(2, Math.min(100, limit)))
  const inputs = new Map<string, LinkInput>()
  for (const entry of entries) {
    inputs.set(entry.id, {
      title: entry.title,
      tags: entry.tags,
      ...entry.group === undefined ? {} : { group: entry.group },
      references: wikiTargetsOf(entry.body),
      keywords: bodyKeywords(entry.body),
    })
  }
  const degrees = new Map<string, number>(entries.map(entry => [entry.id, 0]))
  const edges: KnowledgeGraphEdge[] = []
  for (let left = 0; left < entries.length && edges.length < MAX_EDGES; left += 1) {
    for (let right = left + 1; right < entries.length && edges.length < MAX_EDGES; right += 1) {
      const a = entries[left]!
      const b = entries[right]!
      const relation = relationBetween(inputs.get(a.id)!, inputs.get(b.id)!)
      if (relation === undefined) continue
      if (relation.explicitOut || relation.explicitIn) {
        // explicit either way is a real document link
      } else if (relation.sharedTags === 0 && relation.topicScore < 2 && !relation.sameGroup) {
        continue
      }
      edges.push({
        source: a.id,
        target: b.id,
        reason: relation.explicitOut || relation.explicitIn ? 'explicit' : relation.sharedTags > 0 ? 'tag' : relation.sameGroup ? 'group' : 'topic',
        score: relation.score,
      })
      degrees.set(a.id, (degrees.get(a.id) ?? 0) + 1)
      degrees.set(b.id, (degrees.get(b.id) ?? 0) + 1)
    }
  }
  const nodes: KnowledgeGraphNode[] = entries.map(entry => ({
    id: entry.id,
    title: entry.title,
    group: entry.group ?? '未分组',
    type: entry.type,
    tags: [...entry.tags],
    degree: degrees.get(entry.id) ?? 0,
  }))
  return {
    knowledgeBase: { id: base.id, name: base.name },
    nodes,
    edges,
    truncated: page.items.length > entries.length || edges.length >= MAX_EDGES,
  }
}
