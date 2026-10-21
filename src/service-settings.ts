import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from './atomic-file.js'

export interface KnowledgeServiceSettings {
  publicApiEnabled: boolean
  writebackProvider?: string
  writebackModel?: string
  autoApprovePendingEnabled?: boolean
  autoOrganizeTrigger?: 'turn' | 'interval'
  autoOrganizeIntervalMinutes?: number
  worklogAutoUpdateTrigger?: 'turn' | 'interval'
  worklogAutoUpdateIntervalMinutes?: number
  tokenSavingEnabled?: boolean
}

export function serviceSettingsPath(connectionPath: string | undefined): string | undefined {
  return connectionPath === undefined ? undefined : `${connectionPath}.service.json`
}

export function loadServiceSettings(path: string | undefined): KnowledgeServiceSettings | undefined {
  if (path === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`failed to read knowledge service settings: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stored knowledge service settings must be a JSON object')
  }
  const stored = value as {
    publicApiEnabled?: unknown
    writebackProvider?: unknown
    writebackModel?: unknown
    autoApprovePendingEnabled?: unknown
    autoOrganizeTrigger?: unknown
    autoOrganizeIntervalMinutes?: unknown
    worklogAutoUpdateTrigger?: unknown
    worklogAutoUpdateIntervalMinutes?: unknown
    tokenSavingEnabled?: unknown
  }
  const enabled = stored.publicApiEnabled
  if (typeof enabled !== 'boolean') throw new Error('stored public API setting must be a boolean')
  const provider = typeof stored.writebackProvider === 'string' ? stored.writebackProvider.trim() : undefined
  const model = typeof stored.writebackModel === 'string' ? stored.writebackModel.trim() : undefined
  if ((provider === undefined) !== (model === undefined)) throw new Error('stored client writeback provider and model must be configured together')
  const booleanValue = (key: string, fallback: boolean | undefined): boolean | undefined => {
    const current = stored[key as keyof typeof stored]
    if (current === undefined) return fallback
    if (typeof current !== 'boolean') throw new Error(`stored ${key} must be a boolean`)
    return current
  }
  const triggerValue = (key: string, fallback: 'turn' | 'interval' | undefined): 'turn' | 'interval' | undefined => {
    const current = stored[key as keyof typeof stored]
    if (current === undefined) return fallback
    if (current !== 'turn' && current !== 'interval') throw new Error(`stored ${key} must be turn or interval`)
    return current
  }
  const minutesValue = (key: string, fallback: number | undefined): number | undefined => {
    const current = stored[key as keyof typeof stored]
    if (current === undefined) return fallback
    if (typeof current !== 'number' || !Number.isFinite(current) || current < 1 || current > 1440) throw new Error(`stored ${key} must be between 1 and 1440`)
    return Math.trunc(current)
  }
  const autoApprovePendingEnabled = booleanValue('autoApprovePendingEnabled', undefined)
  const autoOrganizeTrigger = triggerValue('autoOrganizeTrigger', undefined)
  const autoOrganizeIntervalMinutes = minutesValue('autoOrganizeIntervalMinutes', undefined)
  const worklogAutoUpdateTrigger = triggerValue('worklogAutoUpdateTrigger', undefined)
  const worklogAutoUpdateIntervalMinutes = minutesValue('worklogAutoUpdateIntervalMinutes', undefined)
  const tokenSavingEnabled = booleanValue('tokenSavingEnabled', undefined)
  return {
    publicApiEnabled: enabled,
    ...provider && model ? { writebackProvider: provider, writebackModel: model } : {},
    ...autoApprovePendingEnabled === undefined ? {} : { autoApprovePendingEnabled },
    ...autoOrganizeTrigger === undefined ? {} : { autoOrganizeTrigger },
    ...autoOrganizeIntervalMinutes === undefined ? {} : { autoOrganizeIntervalMinutes },
    ...worklogAutoUpdateTrigger === undefined ? {} : { worklogAutoUpdateTrigger },
    ...worklogAutoUpdateIntervalMinutes === undefined ? {} : { worklogAutoUpdateIntervalMinutes },
    ...tokenSavingEnabled === undefined ? {} : { tokenSavingEnabled },
  }
}

export async function storeServiceSettings(path: string, settings: KnowledgeServiceSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await atomicWriteFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
}
