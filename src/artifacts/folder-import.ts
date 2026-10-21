import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface FolderScanResult {
  root: string
  files: string[]
  truncated: boolean
  skipped: number
}

export interface FolderScanOptions {
  maxFiles?: number
  /** Glob-like matchers applied to the path relative to the selected root. */
  excludePatterns?: readonly RegExp[]
  /** Paths that must never be entered (archive root, data directory). */
  excludeRoots?: readonly string[]
}

const DEFAULT_SKIP = new Set(['node_modules', '.git', '.dsh', '.svn', '__pycache__', 'dist', 'build'])

/**
 * Recursively enumerate regular files in a user-selected folder. The scanner
 * is bounded and never follows symlinks, so a folder import cannot escape the
 * selected tree or walk an entire drive.
 */
export async function scanFolder(root: string, options: FolderScanOptions = {}): Promise<FolderScanResult> {
  const absoluteRoot = resolve(root)
  const info = await stat(absoluteRoot)
  if (!info.isDirectory()) throw Object.assign(new Error('选择的路径不是文件夹'), { status: 400 })
  const maxFiles = Math.max(1, Math.min(2000, options.maxFiles ?? 800))
  const excludeRoots = (options.excludeRoots ?? []).map(item => resolve(item))
  const files: string[] = []
  let skipped = 0
  let truncated = false
  const queue: string[] = [absoluteRoot]
  while (queue.length > 0 && !truncated) {
    const current = queue.shift()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      skipped += 1
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (excludeRoots.some(exclude => path === exclude || path.startsWith(`${exclude}\\`) || path.startsWith(`${exclude}/`))) continue
      if (entry.isSymbolicLink()) { skipped += 1; continue }
      if (entry.isDirectory()) {
        if (DEFAULT_SKIP.has(entry.name)) { skipped += 1; continue }
        if (options.excludePatterns?.some(pattern => pattern.test(relative(absoluteRoot, path).replace(/\\/gu, '/')))) { skipped += 1; continue }
        queue.push(path)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = relative(absoluteRoot, path).replace(/\\/gu, '/')
      if (options.excludePatterns?.some(pattern => pattern.test(relativePath))) { skipped += 1; continue }
      if (files.length >= maxFiles) { truncated = true; break }
      files.push(path)
    }
  }
  files.sort()
  return { root: absoluteRoot, files, truncated, skipped }
}

export function isAbsoluteFolderPath(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && isAbsolute(value.trim())
}
