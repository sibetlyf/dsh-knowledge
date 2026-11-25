#!/usr/bin/env node
// 把本地 dsh-knowledge 知识库单向同步到云端团队库；重复执行是幂等的。
// 文档通过云端 DSH 远程协议写入；任意类型文件通过 /knowledge-api/v1/files 写入。
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'

function usage() {
  console.log(`用法:
  node cloud/sync-local.mjs --db <本地 knowledge.sqlite> --url <云端 /knowledge-api/v1> --token <DSH Token> [--files <目录>] [--base <知识库>] [--map <映射文件>]

环境变量也可以:
  LOCAL_KB_DB, CLOUD_URL, CLOUD_TOKEN, CLOUD_SYNC_FILES, CLOUD_SYNC_BASE, CLOUD_SYNC_MAP`)
}

function args() {
  const raw = process.argv.slice(2)
  const result = {}
  for (let index = 0; index < raw.length; index += 1) {
    const key = raw[index]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = raw[index + 1]?.startsWith('--') === false ? raw[++index] : '1'
    result[name] = value
  }
  return result
}

const options = args()
if (options.help === '1') { usage(); process.exit(0) }
const db = resolve(options.db ?? process.env.LOCAL_KB_DB ?? '')
const url = options.url ?? process.env.CLOUD_URL ?? ''
const token = options.token ?? process.env.CLOUD_TOKEN ?? ''
const filesDir = options.files ?? process.env.CLOUD_SYNC_FILES
const baseFilter = options.base ?? process.env.CLOUD_SYNC_BASE
const mapPath = resolve(options.map ?? process.env.CLOUD_SYNC_MAP ?? `${db}.cloud-sync.json`)
if (db === '' || url === '' || token === '') {
  usage()
  console.error('\n缺少 --db / --url / --token。')
  process.exit(2)
}
if (!existsSync(db)) {
  console.error(`本地知识库不存在：${db}`)
  process.exit(2)
}

const apiBase = url.replace(/\/+$/u, '').endsWith('/knowledge-api/v1')
  ? url.replace(/\/+$/u, '')
  : `${url.replace(/\/+$/u, '')}/knowledge-api/v1`

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function docHash(entry, baseId) {
  return digest(JSON.stringify({
    baseId,
    title: entry.title,
    body: entry.body,
    group: entry.group ?? '',
    type: entry.type,
    tags: entry.tags,
    scope: entry.scope,
    confidence: entry.confidence,
  }))
}

function mimeFor(name) {
  return {
    '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.zip': 'application/zip',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.csv': 'text/csv; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  }[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

async function loadMap() {
  try {
    return JSON.parse(await readFile(mapPath, 'utf8'))
  } catch {
    return { version: 1, bases: {}, docs: {} }
  }
}

async function saveMap(map) {
  await mkdir(dirname(mapPath), { recursive: true })
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 })
}

async function uploadFile(cloudBaseId, localPath, sourceKey) {
  const info = await stat(localPath)
  if (!info.isFile()) return false
  if (info.size > 100 * 1024 * 1024) {
    console.warn(`  跳过（超过 100 MiB）: ${sourceKey}`)
    return false
  }
  const bytes = await readFile(localPath)
  const name = sourceKey.split('/').pop() || 'file'
  const response = await fetch(`${apiBase}/files`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-file-base-id': cloudBaseId,
      'x-file-name': encodeURIComponent(name),
      'x-file-source-key': encodeURIComponent(sourceKey),
      'x-content-type': mimeFor(name),
    },
    body: bytes,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error ?? `上传失败 (${response.status})`)
  }
  return true
}

async function walkFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(absolute, relative))
    else if (entry.isFile()) files.push({ absolute, relative })
  }
  return files
}

async function main() {
  const local = new LocalKnowledgeProvider(db)
  const remote = new RemoteKnowledgeProvider({ url: apiBase, token, timeoutMs: 30_000 })
  const map = await loadMap()
  const localBases = (await local.listKnowledgeBases()).filter(base => base.status === 'active')
  const selectedBases = baseFilter === undefined
    ? localBases
    : localBases.filter(base => base.id === baseFilter || base.name === baseFilter)
  if (selectedBases.length === 0) throw new Error('没有匹配的本地知识库')

  const remoteBases = await remote.listKnowledgeBases()
  let pushed = 0
  let skipped = 0
  let failed = 0
  for (const localBase of selectedBases) {
    const target = remoteBases.find(base => base.id === map.bases[localBase.id])
      ?? remoteBases.find(base => base.name === localBase.name)
    let cloudBase = target
    if (cloudBase === undefined) {
      cloudBase = await remote.createKnowledgeBase({
        name: localBase.name,
        description: localBase.description ?? '',
        defaultTags: localBase.defaultTags ?? [],
        writebackPolicy: localBase.writebackPolicy ?? 'conservative',
      })
      console.log(`创建云端知识库: ${cloudBase.name}`)
    }
    map.bases[localBase.id] = cloudBase.id

    const localDocs = await local.listDocuments(localBase.id)
    console.log(`\n知识库 ${localBase.name}: ${localDocs.length} 篇文档`)
    for (const summary of localDocs) {
      try {
        const entry = await local.get(summary.id)
        if (entry === undefined || entry.status !== 'active') { skipped += 1; continue }
        const draft = {
          knowledgeBaseId: cloudBase.id,
          title: entry.title,
          body: entry.body,
          group: entry.group && entry.group !== '' ? entry.group : '本地导入',
          type: entry.type,
          tags: entry.tags,
          scope: entry.scope,
          confidence: entry.confidence,
        }
        const hash = docHash(entry, localBase.id)
        const known = map.docs[entry.id]
        if (known?.hash === hash) { skipped += 1; continue }
        let cloud = known === undefined ? undefined : await remote.get(known.cloudId).catch(() => undefined)
        if (cloud === undefined) {
          cloud = await remote.create(draft)
          console.log(`  新建: ${entry.title}`)
        } else {
          cloud = await remote.update(cloud.id, draft, undefined, cloud.version)
          console.log(`  更新: ${entry.title}`)
        }
        map.docs[entry.id] = { cloudId: cloud.id, hash, updatedAt: new Date().toISOString() }
        pushed += 1
        await saveMap(map)
      } catch (error) {
        failed += 1
        console.error(`  失败: ${summary.title} — ${error.message}`)
      }
    }
    await saveMap(map)

    if (filesDir !== undefined) {
      if (selectedBases.length > 1 && baseFilter === undefined) {
        throw new Error('多个本地库同时同步文件时，请用 --base 指定一个知识库')
      }
      const all = await walkFiles(resolve(filesDir))
      console.log(`\n文件目录 ${filesDir}: ${all.length} 个文件`)
      for (const file of all) {
        try {
          if (await uploadFile(cloudBase.id, file.absolute, file.relative)) {
            console.log(`  上传: ${file.relative}`)
          }
        } catch (error) {
          failed += 1
          console.error(`  文件失败: ${file.relative} — ${error.message}`)
        }
      }
    }
  }
  console.log(`\n完成：写入 ${pushed}，跳过 ${skipped}，失败 ${failed}`)
  console.log(`映射文件：${mapPath}`)
  await local.close().catch(() => {})
}

main().catch(error => {
  console.error(`同步失败：${error.message}`)
  process.exit(1)
})
