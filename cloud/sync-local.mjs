#!/usr/bin/env node
// 把本地 dsh-knowledge 知识库同步到云端团队库；默认本地→云端，重复执行幂等。
// 文档通过云端 DSH 远程协议写入；任意类型文件通过 /knowledge-api/v1/files 写入。
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { RemoteKnowledgeProvider } from '../lib/remote-provider.js'

function usage() {
  console.log(`用法:
  node cloud/sync-local.mjs --db <本地 knowledge.sqlite> --url <云端 /knowledge-api/v1> --token <DSH Token> [--files <上传目录>] [--base <知识库>] [--map <映射文件>] [--pull]

  --pull  从云端拉取新增/更新到本地
  --mirror  拉取到本地镜像库“云端·<库名>”，本地原库保持不变
  --user <名字>  文件按这个名字建立云端子目录，默认本机用户名
  --files-out <目录>  同时下载云端文件

环境变量也可以:
  LOCAL_KB_DB, CLOUD_URL, CLOUD_TOKEN, CLOUD_SYNC_FILES, CLOUD_SYNC_BASE, CLOUD_SYNC_MAP
  CLOUD_SYNC_PULL=1, CLOUD_SYNC_FILES_OUT`)
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
const filesOut = options['files-out'] ?? process.env.CLOUD_SYNC_FILES_OUT
const pull = options.pull === '1' || process.env.CLOUD_SYNC_PULL === '1'
const mirror = options.mirror === '1' || process.env.CLOUD_SYNC_MIRROR === '1'
const mirrorPrefix = options['mirror-prefix'] ?? process.env.CLOUD_SYNC_MIRROR_PREFIX ?? '云端·'
const userName = String(options.user ?? process.env.CLOUD_SYNC_USER ?? userInfo().username ?? 'user').trim() || 'user'
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
    return { version: 1, bases: {}, docs: {}, mirrorBases: {} }
  }
}

async function saveMap(map) {
  await mkdir(dirname(mapPath), { recursive: true })
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 })
}

async function syncChanges(cloudBaseId, since) {
  const response = await fetch(`${apiBase}/sync/changes?baseId=${encodeURIComponent(cloudBaseId)}&since=${encodeURIComponent(since)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`读取变更失败 (${response.status})`)
  return await response.json()
}

async function uploadFile(cloudBaseId, localPath, sourceKey, displayName = basename(sourceKey), map) {
  const info = await stat(localPath)
  if (!info.isFile()) return false
  if (info.size > 100 * 1024 * 1024) {
    console.warn(`  跳过（超过 100 MiB）: ${sourceKey}`)
    return false
  }
  const bytes = await readFile(localPath)
  const sha256 = digest(bytes)
  const mapKey = `${userName}:${sourceKey}`
  if (map.files[mapKey]?.sha256 === sha256) return false
  const name = displayName || 'file'
  const response = await fetch(`${apiBase}/files`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-file-base-id': cloudBaseId,
      'x-file-name': encodeURIComponent(name),
      'x-file-source-key': encodeURIComponent(sourceKey),
      'x-file-user-name': encodeURIComponent(userName),
      'x-content-type': mimeFor(name),
    },
    body: bytes,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error ?? `上传失败 (${response.status})`)
  }
  map.files[mapKey] = { sha256, sourceKey, name, updatedAt: new Date().toISOString() }
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

async function artifactFiles(directory) {
  const indexFiles = [join(directory, 'index.json'), join(dirname(directory), 'index.json'), join(dirname(dirname(directory)), 'index.json')]
  const indexFile = indexFiles.find(path => existsSync(path))
  if (indexFile === undefined) return new Map()
  try {
    const root = JSON.parse(await readFile(indexFile, 'utf8'))
    const entries = root?.artifacts && typeof root.artifacts === 'object'
      ? root.artifacts
      : root?.entries && typeof root.entries === 'object'
        ? root.entries
        : root
    const map = new Map()
    for (const record of Object.values(entries ?? {})) {
      if (record === null || typeof record !== 'object' || typeof record.blob !== 'string') continue
      const blob = record.blob.replaceAll('\\', '/')
      const relative = blob.startsWith('blobs/') ? blob.slice('blobs/'.length) : blob
      const display = typeof record.display === 'string' && record.display.trim() !== '' ? record.display : record.path
      if (typeof display !== 'string' || display.trim() === '') continue
      const name = basename(display.split('/').pop() || display)
      map.set(relative, { sourceKey: display, name })
    }
    return map
  } catch {
    return new Map()
  }
}

async function downloadCloudFile(baseId, file, directory) {
  const path = file.sourceKey && !file.sourceKey.split('/').some(part => part === '..' || part === '')
    ? file.sourceKey
    : file.name
  const target = join(directory, ...path.split('/'))
  const response = await fetch(`${apiBase}/files/${encodeURIComponent(file.id)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`下载失败 (${response.status})`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, Buffer.from(await response.arrayBuffer()), { mode: 0o600 })
  return path
}

async function pullCloud(local, remote, map, remoteBases, localBases) {
  let pulled = 0
  let skipped = 0
  let conflicts = 0
  let failed = 0
  for (const cloudBase of remoteBases) {
    if (baseFilter !== undefined && cloudBase.name !== baseFilter && cloudBase.id !== baseFilter) continue
    const mappedLocalId = Object.entries(map.bases).find(([, cloudId]) => cloudId === cloudBase.id)?.[0]
    let localBase
    if (mirror) {
      const mirrorId = map.mirrorBases[cloudBase.id]
      localBase = localBases.find(base => base.id === mirrorId)
        ?? localBases.find(base => base.name === `${mirrorPrefix}${cloudBase.name}`)
      if (localBase === undefined) {
        localBase = await local.createKnowledgeBase({
          name: `${mirrorPrefix}${cloudBase.name}`,
          description: `云端团队库镜像：${cloudBase.name}`,
          defaultTags: [],
          extractionInstructions: '',
          writebackPolicy: 'conservative',
        })
        console.log(`创建本地镜像库: ${localBase.name}`)
      }
      map.mirrorBases[cloudBase.id] = localBase.id
    } else {
      localBase = localBases.find(base => base.id === mappedLocalId) ?? localBases.find(base => base.name === cloudBase.name)
      if (localBase === undefined) {
        localBase = await local.createKnowledgeBase({
          name: cloudBase.name,
          description: cloudBase.description ?? '',
          defaultTags: cloudBase.defaultTags ?? [],
          extractionInstructions: cloudBase.extractionInstructions ?? '',
          writebackPolicy: cloudBase.writebackPolicy ?? 'conservative',
        })
        console.log(`创建本地知识库: ${localBase.name}`)
      }
    }
    map.bases[localBase.id] = cloudBase.id
    let cloudDocs = await remote.listDocuments(cloudBase.id)
    let nextCursor = new Date().toISOString()
    const since = map.sync[cloudBase.id]
    if (typeof since === 'string' && since !== '') {
      try {
        const feed = await syncChanges(cloudBase.id, since)
        cloudDocs = feed.changes.filter(change => change.entityKind === 'document' && change.operation !== 'delete')
          .map(change => ({ id: change.entityId, title: change.payload?.title ?? '' }))
        nextCursor = feed.nextCursor ?? nextCursor
        console.log(`  增量变更: ${cloudDocs.length} 篇文档`)
      } catch (error) {
        console.warn(`  增量接口不可用，回退全量扫描: ${error.message}`)
      }
    }
    console.log(`\n拉取 ${cloudBase.name}: ${cloudDocs.length} 篇文档`)
    for (const summary of cloudDocs) {
      try {
        const cloudEntry = await remote.get(summary.id)
        if (cloudEntry === undefined || cloudEntry.status !== 'active') { skipped += 1; continue }
        const targetMap = mirror ? map.mirrorDocs : map.docs
        const localId = Object.entries(targetMap).find(([, value]) => value.cloudId === cloudEntry.id)?.[0]
        const cloudHash = docHash(cloudEntry, localBase.id)
        if (localId === undefined) {
          const created = await local.create({
            knowledgeBaseId: localBase.id,
            title: cloudEntry.title,
            body: cloudEntry.body,
            group: cloudEntry.group && cloudEntry.group !== '' ? cloudEntry.group : '云端同步',
            type: cloudEntry.type,
            tags: cloudEntry.tags,
            scope: cloudEntry.scope,
            confidence: cloudEntry.confidence,
          })
          targetMap[created.id] = { cloudId: cloudEntry.id, hash: cloudHash, updatedAt: new Date().toISOString() }
          pulled += 1
          console.log(`  新建: ${cloudEntry.title}`)
        } else {
          const localEntry = await local.get(localId)
          if (localEntry === undefined) {
            delete targetMap[localId]
            skipped += 1
            continue
          }
          const known = targetMap[localId]
          const localHash = docHash(localEntry, localBase.id)
          if (cloudHash === known.hash) { skipped += 1; continue }
          if (localHash !== known.hash) {
            conflicts += 1
            console.warn(`  冲突（本地和云端都变了，保留本地）: ${cloudEntry.title}`)
            continue
          }
          const updated = await local.update(localId, {
            knowledgeBaseId: localBase.id,
            title: cloudEntry.title,
            body: cloudEntry.body,
            group: cloudEntry.group && cloudEntry.group !== '' ? cloudEntry.group : '云端同步',
            type: cloudEntry.type,
            tags: cloudEntry.tags,
            scope: cloudEntry.scope,
            confidence: cloudEntry.confidence,
          }, undefined, localEntry.version)
          targetMap[localId] = { cloudId: cloudEntry.id, hash: cloudHash, updatedAt: new Date().toISOString() }
          pulled += 1
          console.log(`  更新: ${updated.title}`)
        }
        await saveMap(map)
      } catch (error) {
        failed += 1
        console.error(`  拉取失败: ${summary.title} — ${error.message}`)
      }
    }
    map.sync[cloudBase.id] = nextCursor
    await saveMap(map)
    if (filesOut !== undefined) {
      const response = await fetch(`${apiBase}/files?baseId=${encodeURIComponent(cloudBase.id)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error(`读取云端文件列表失败 (${response.status})`)
      const files = await response.json()
      console.log(`\n下载文件 ${cloudBase.name}: ${files.files.length} 个`)
      for (const file of files.files) {
        try {
          const relative = await downloadCloudFile(cloudBase.id, file, resolve(filesOut))
          console.log(`  下载: ${relative}`)
        } catch (error) {
          failed += 1
          console.error(`  文件失败: ${file.name} — ${error.message}`)
        }
      }
    }
  }
  console.log(`\n拉取完成：写入 ${pulled}，跳过 ${skipped}，冲突 ${conflicts}，失败 ${failed}`)
  await saveMap(map)
}

async function main() {
  const local = new LocalKnowledgeProvider(db)
  const remote = new RemoteKnowledgeProvider({ url: apiBase, token, timeoutMs: 30_000 })
  const map = await loadMap()
  map.bases ??= {}
  map.docs ??= {}
  map.mirrorBases ??= {}
  map.mirrorDocs ??= {}
  map.files ??= {}
  map.sync ??= {}
  const localBases = (await local.listKnowledgeBases()).filter(base => base.status === 'active')
  const selectedBases = baseFilter === undefined
    ? localBases.filter(base => !new Set(Object.values(map.mirrorBases)).has(base.id))
    : localBases.filter(base => base.id === baseFilter || base.name === baseFilter)
  if (mirror && !pull) throw new Error('--mirror 只能和 --pull 一起使用')
  if (!pull && selectedBases.length === 0) throw new Error('没有匹配的本地知识库')
  if (!pull && filesDir !== undefined && selectedBases.length > 1 && baseFilter === undefined) {
    throw new Error('本地有多个知识库；上传文件时必须用 --base 指定一个知识库，避免把文件传到错误的库。')
  }

  const remoteBases = await remote.listKnowledgeBases()
  if (pull) {
    await pullCloud(local, remote, map, remoteBases, localBases)
    await local.close().catch(() => {})
    return
  }
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
      const sourcePath = resolve(filesDir)
      const sourceInfo = await stat(sourcePath)
      const all = sourceInfo.isFile()
        ? [{ absolute: sourcePath, relative: basename(sourcePath) }]
        : await walkFiles(sourcePath)
      const artifactMap = await artifactFiles(sourceInfo.isFile() ? dirname(sourcePath) : sourcePath)
      console.log(`\n文件${sourceInfo.isFile() ? '' : '目录'} ${filesDir}: ${all.length} 个文件`)
      for (const file of all) {
        try {
          const relative = file.relative.replaceAll('\\', '/')
          const artifact = artifactMap.get(relative) ?? artifactMap.get(relative.replace(/^blobs\//u, ''))
          const sourceKey = artifact?.sourceKey ?? relative
          const name = artifact?.name ?? basename(relative)
          if (await uploadFile(cloudBase.id, file.absolute, sourceKey, name, map)) {
            console.log(`  上传: ${sourceKey}`)
            await saveMap(map)
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
