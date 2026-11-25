import { mkdir, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { atomicWriteFile } from './atomic-file.js'

export interface TencentDocsTokenStatus {
  configured: boolean
  source: 'env' | 'vault' | 'none'
  fingerprint: string
  overriddenByEnv: boolean
}

export function tencentDocsVaultPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TDOC_VAULT?.trim()
  return configured && configured.length > 0 ? configured : join(homedir(), '.dsh', 'tencent-docs', 'vault.json')
}

export function isValidTencentDocsToken(token: string): boolean {
  return /^[0-9a-f]{32}$/u.test(token.trim())
}

function fingerprint(token: string): string {
  return token.length === 0 ? '(无)' : `len${token.length}:${token.slice(0, 4)}…`
}

async function readVault(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Effective token status. Never returns the token itself. */
export async function readTencentDocsToken(
  env: NodeJS.ProcessEnv = process.env,
  path = tencentDocsVaultPath(env),
): Promise<TencentDocsTokenStatus & { token: string }> {
  const direct = env.TDOC_OAUTH_ACCESS_TOKEN?.trim() ?? ''
  if (direct.length > 0) {
    return { token: direct, configured: true, source: 'env', fingerprint: fingerprint(direct), overriddenByEnv: true }
  }
  const vault = await readVault(path)
  const stored = typeof vault.access_token === 'string' ? vault.access_token.trim() : ''
  if (stored.length > 0) {
    return { token: stored, configured: true, source: 'vault', fingerprint: fingerprint(stored), overriddenByEnv: false }
  }
  return { token: '', configured: false, source: 'none', fingerprint: fingerprint(''), overriddenByEnv: false }
}

/** Persist a user-entered token into the local bridge vault (mode 0600). */
export async function saveTencentDocsToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  path = tencentDocsVaultPath(env),
): Promise<TencentDocsTokenStatus> {
  const normalized = token.trim().toLowerCase()
  if (!isValidTencentDocsToken(normalized)) {
    throw Object.assign(new Error('腾讯文档 token 必须是 32 位十六进制 space_secret。'), { status: 400 })
  }
  const existing = await readVault(path)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await atomicWriteFile(path, `${JSON.stringify({
    ...existing,
    access_token: normalized,
    _source: 'knowledge-ui',
    _updated_at: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 })
  const { token: _token, ...status } = await readTencentDocsToken(env, path)
  return status
}

/** Remove the persisted token so the bridge watcher unmounts its MCP client. */
export async function clearTencentDocsToken(
  env: NodeJS.ProcessEnv = process.env,
  path = tencentDocsVaultPath(env),
): Promise<TencentDocsTokenStatus> {
  const existing = await readVault(path)
  if (Object.keys(existing).length === 0) {
    const { token: _token, ...status } = await readTencentDocsToken(env, path)
    return status
  }
  delete existing.access_token
  delete existing._source
  if (Object.keys(existing).length === 0) {
    try { await unlink(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  } else {
    await atomicWriteFile(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 })
  }
  const { token: _token, ...status } = await readTencentDocsToken(env, path)
  return status
}
