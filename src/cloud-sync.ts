// 插件内的团队云端同步：连接云端后在本地建立镜像库，并在本地/云端变化时自动双向同步。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CloudSyncConfig {
  url: string
  token: string
  userName: string
  autoSync: boolean
  intervalMinutes: number
  filesDir: string
  filesOut: string
  base: string
}

export interface CloudSyncConfigInput {
  url?: string
  token?: string
  userName?: string
  autoSync?: boolean
  intervalMinutes?: number
  filesDir?: string
  filesOut?: string
  base?: string
}

export interface CloudSyncStatus {
  configured: boolean
  url: string
  userName: string
  autoSync: boolean
  intervalMinutes: number
  filesDir: string
  filesOut: string
  base: string
  running: boolean
  mode?: string
  lastRunAt?: string
  lastError?: string
  lastOutput?: string
}

export interface CloudSyncControl {
  status(): Promise<CloudSyncStatus>
  configure(input: CloudSyncConfigInput): Promise<CloudSyncStatus>
  run(mode: 'push' | 'pull' | 'sync'): Promise<CloudSyncStatus>
  scheduleSoon(): void
}

const DEFAULT_CONFIG: CloudSyncConfig = {
  url: '',
  token: '',
  userName: '',
  autoSync: true,
  intervalMinutes: 5,
  filesDir: '',
  filesOut: '',
  base: '',
}

function clean(value: string | undefined, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

export class CloudSyncManager implements CloudSyncControl {
  private config: CloudSyncConfig = { ...DEFAULT_CONFIG }
  private readonly configPath: string
  private readonly scriptPath: string
  private readonly databasePath: string
  private readonly logger: { warn: (message: string) => void }
  private timer: NodeJS.Timeout | undefined
  private debounce: NodeJS.Timeout | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly ready: Promise<void>
  private running = false
  private mode: string | undefined
  private lastRunAt: string | undefined
  private lastError: string | undefined
  private lastOutput: string | undefined

  constructor(options: { databasePath: string; logger: { warn: (message: string) => void } }) {
    this.databasePath = options.databasePath
    this.configPath = `${options.databasePath}.cloud-sync.config.json`
    this.scriptPath = fileURLToPath(new URL('../cloud/sync-local.mjs', import.meta.url))
    this.logger = options.logger
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    try {
      if (!existsSync(this.configPath)) return
      const parsed = JSON.parse(await readFile(this.configPath, 'utf8')) as Partial<CloudSyncConfig>
      this.config = {
        ...DEFAULT_CONFIG,
        ...parsed,
        url: clean(parsed.url, ''),
        token: clean(parsed.token, ''),
        userName: clean(parsed.userName, ''),
        intervalMinutes: Math.max(1, Math.min(60, Number(parsed.intervalMinutes) || 5)),
        filesDir: clean(parsed.filesDir, ''),
        filesOut: clean(parsed.filesOut, ''),
        base: clean(parsed.base, ''),
      }
      this.applyTimer()
    } catch (error) {
      this.lastError = `读取云端同步配置失败：${error instanceof Error ? error.message : String(error)}`
      this.logger.warn(this.lastError)
    }
  }

  private async save(): Promise<void> {
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 })
    await writeFile(this.configPath, JSON.stringify(this.config, null, 2), { mode: 0o600 })
    try { await chmod(this.configPath, 0o600) } catch { /* Windows may not support POSIX modes */ }
  }

  async status(): Promise<CloudSyncStatus> {
    await this.ready
    return {
      configured: this.config.url !== '' && this.config.token !== '',
      url: this.config.url,
      userName: this.config.userName,
      autoSync: this.config.autoSync,
      intervalMinutes: this.config.intervalMinutes,
      filesDir: this.config.filesDir,
      filesOut: this.config.filesOut,
      base: this.config.base,
      running: this.running,
      ...(this.mode === undefined ? {} : { mode: this.mode }),
      ...(this.lastRunAt === undefined ? {} : { lastRunAt: this.lastRunAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.lastOutput === undefined ? {} : { lastOutput: this.lastOutput }),
    }
  }

  async configure(input: CloudSyncConfigInput): Promise<CloudSyncStatus> {
    await this.ready
    if (this.running) throw new Error('同步正在运行，请完成后再修改配置')
    this.config = {
      ...this.config,
      ...(typeof input.url === 'string' ? { url: input.url.trim().replace(/\/+$/u, '') } : {}),
      ...(typeof input.token === 'string' && input.token.trim() !== '' ? { token: input.token.trim() } : {}),
      ...(typeof input.userName === 'string' ? { userName: input.userName.trim() } : {}),
      ...(typeof input.autoSync === 'boolean' ? { autoSync: input.autoSync } : {}),
      ...(typeof input.intervalMinutes === 'number' ? { intervalMinutes: Math.max(1, Math.min(60, Math.floor(input.intervalMinutes))) } : {}),
      ...(typeof input.filesDir === 'string' ? { filesDir: input.filesDir.trim() } : {}),
      ...(typeof input.filesOut === 'string' ? { filesOut: input.filesOut.trim() } : {}),
      ...(typeof input.base === 'string' ? { base: input.base.trim() } : {}),
    }
    this.lastError = undefined
    await this.save()
    this.applyTimer()
    return this.status()
  }

  async run(mode: 'push' | 'pull' | 'sync'): Promise<CloudSyncStatus> {
    await this.ready
    if (this.running) return this.status()
    if (this.config.url === '' || this.config.token === '') throw new Error('请先填写云端地址和 Token')
    this.running = true
    this.mode = mode
    this.lastRunAt = new Date().toISOString()
    this.lastError = undefined
    this.lastOutput = ''
    void this.execute(mode).catch(error => {
      this.running = false
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger.warn(`云端同步失败：${this.lastError}`)
    })
    return this.status()
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.debounce !== undefined) clearTimeout(this.debounce)
    this.child?.kill()
    this.child = undefined
  }

  scheduleSoon(): void {
    if (!this.config.autoSync || this.running) return
    if (this.config.url === '' || this.config.token === '') return
    if (this.debounce !== undefined) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      if (this.config.autoSync && !this.running) void this.run('sync')
    }, 3_000)
    this.debounce.unref()
  }

  private applyTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    if (!this.config.autoSync) return
    this.timer = setInterval(() => {
      if (!this.running && this.config.url !== '' && this.config.token !== '') {
        void this.run('sync').catch(error => this.logger.warn(`云端自动同步失败：${error instanceof Error ? error.message : String(error)}`))
      }
    }, this.config.intervalMinutes * 60_000)
    this.timer.unref()
  }

  private async execute(mode: 'push' | 'pull' | 'sync'): Promise<void> {
    if (!existsSync(this.scriptPath)) throw new Error(`找不到同步脚本：${this.scriptPath}`)
    if (mode === 'sync') {
      await this.executeOne('push')
      await this.executeOne('pull')
      this.running = false
      this.mode = undefined
      return
    }
    await this.executeOne(mode)
    this.running = false
    this.mode = undefined
  }

  private async executeOne(mode: 'push' | 'pull'): Promise<void> {
    return await new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LOCAL_KB_DB: this.databasePath,
        CLOUD_URL: this.config.url,
        CLOUD_TOKEN: this.config.token,
        ...(this.config.userName === '' ? {} : { CLOUD_SYNC_USER: this.config.userName }),
        ...(this.config.filesDir === '' ? {} : { CLOUD_SYNC_FILES: this.config.filesDir }),
        ...(this.config.filesOut === '' ? {} : { CLOUD_SYNC_FILES_OUT: this.config.filesOut }),
        ...(this.config.base === '' ? {} : { CLOUD_SYNC_BASE: this.config.base }),
        ...(mode === 'pull' ? { CLOUD_SYNC_PULL: '1', CLOUD_SYNC_MIRROR: '1' } : {}),
      }
      const child = spawn(process.execPath, [this.scriptPath], {
        env,
        cwd: dirname(dirname(this.scriptPath)),
        windowsHide: true,
        stdio: 'pipe',
      })
      this.child = child
      let output = ''
      const append = (chunk: Buffer | string): void => {
        output += String(chunk)
        if (output.length > 12_000) output = output.slice(-12_000)
        this.lastOutput = output.trim().slice(-8_000)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      child.on('error', reject)
      child.on('exit', code => {
        this.child = undefined
        output = output.trim()
        this.lastOutput = output.slice(-8_000)
        if (code === 0) resolve()
        else reject(new Error(output.slice(-1_000) || `同步脚本退出码 ${code}`))
      })
    })
  }
}
