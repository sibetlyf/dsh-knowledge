/**
 * 思维标题树与 Obsidian 风格双链模型定义
 */

export interface MindmapNode {
  id: string
  title: string
  level: number
  summary?: string | undefined
  links?: string[] | undefined
  children: MindmapNode[]
}

export interface NoteProposal {
  id: string
  title: string
  kind: 'auto_summary' | 'mindmap_tree' | 'worklog_cluster'
  targetFolder: string
  content: string
  mindmapJson: string // JSON 序列化的 MindmapNode[]
  sourceNoteIds: string[] // 关联的原笔记/PDF ID 列表
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  reviewedAt?: string | undefined
  reviewNote?: string | undefined
}

/**
 * 从 Obsidian / Markdown 文本中解析思维标题树
 * 识别 # ~ ###### 标题层级以及 [[双链]]
 */
export function parseMarkdownMindmap(markdown: string): MindmapNode[] {
  const lines = markdown.split(/\r?\n/)
  const rootNodes: MindmapNode[] = []
  const stack: { node: MindmapNode; level: number }[] = []
  let autoId = 1

  for (const rawLine of lines) {
    const line = rawLine ?? ''
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (!headingMatch) {
      // 如果处于某个节点下，尝试收集链接与简述
      const topEntry = stack[stack.length - 1]
      if (topEntry) {
        const top = topEntry.node
        const linkMatches = line.matchAll(/\[\[(.*?)\]\]/g)
        for (const m of linkMatches) {
          const link = m[1]
          if (link) {
            if (!top.links) top.links = []
            if (!top.links.includes(link)) top.links.push(link)
          }
        }
        if (!top.summary && line.trim().length > 0 && !line.startsWith('-') && !line.startsWith('`')) {
          top.summary = line.trim().slice(0, 150)
        }
      }
      continue
    }

    const hashes = headingMatch[1] ?? '#'
    const rawTitle = (headingMatch[2] ?? '').trim()
    const level = hashes.length

    // 提取标题内的 [[链接]]
    const links: string[] = []
    const cleanTitle = rawTitle.replace(/\[\[(.*?)\]\]/g, (_, linkText: string) => {
      if (linkText) links.push(linkText)
      return ''
    }).trim()

    const node: MindmapNode = {
      id: `node_${autoId++}`,
      title: cleanTitle,
      level,
      links: links.length > 0 ? links : undefined,
      children: [],
    }

    // 调整栈位置构建树
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top && top.level >= level) {
        stack.pop()
      } else {
        break
      }
    }

    const parent = stack[stack.length - 1]
    if (!parent) {
      rootNodes.push(node)
    } else {
      parent.node.children.push(node)
    }

    stack.push({ node, level })
  }

  return rootNodes
}

/**
 * 将思维标题树转化为层级缩进的纯文本大纲（供预览或模型展示）
 */
export function formatMindmapOutline(nodes: MindmapNode[], indent = 0): string {
  const lines: string[] = []
  const prefix = '  '.repeat(indent)
  for (const node of nodes) {
    const linkStr = node.links && node.links.length > 0 ? ` (关联: ${node.links.map(l => `[[${l}]]`).join(', ')})` : ''
    lines.push(`${prefix}- ${node.title}${linkStr}`)
    if (node.children.length > 0) {
      lines.push(formatMindmapOutline(node.children, indent + 1))
    }
  }
  return lines.join('\n')
}
