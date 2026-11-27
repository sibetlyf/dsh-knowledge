// 团队知识库的独立账号与会话存储。与知识数据分离，避免把成员信息混进知识库。
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROLES = new Set(['admin', 'editor', 'viewer'])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

export class TeamError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase()
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 10 && value.length <= 200
}

function hashToken(value) {
  return createHash('sha256').update(value).digest('hex')
}

export class TeamStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        token_hash TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at TEXT,
        used_by TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        source_key TEXT,
        user_name TEXT,
        uploaded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS files_base ON files(base_id, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS files_source ON files(base_id, source_key) WHERE source_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS sync_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        base_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        version INTEGER,
        occurred_at TEXT NOT NULL,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS sync_changes_base ON sync_changes(base_id, occurred_at, seq);
      CREATE TABLE IF NOT EXISTS file_text (
        file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
        base_id TEXT NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        parser TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS file_text_base ON file_text(base_id, status);
      CREATE VIRTUAL TABLE IF NOT EXISTS file_text_fts USING fts5(file_id UNINDEXED, base_id UNINDEXED, name, content, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS wiki_pages (
        id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS wiki_slug ON wiki_pages(base_id, slug);
      CREATE TABLE IF NOT EXISTS wiki_versions (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS wiki_version_unique ON wiki_versions(page_id, version);
      CREATE TABLE IF NOT EXISTS wiki_sources (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        excerpt TEXT,
        line_start INTEGER,
        line_end INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wiki_sources_page ON wiki_sources(page_id);
      CREATE TABLE IF NOT EXISTS data_sources (
        id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT '',
        token TEXT,
        include_pattern TEXT NOT NULL DEFAULT '',
        source_group TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        error TEXT,
        last_synced_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS data_sources_base ON data_sources(base_id, updated_at);
      CREATE TABLE IF NOT EXISTS source_items (
        source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        document_id TEXT NOT NULL,
        sha256 TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source_id, path)
      );
      CREATE TABLE IF NOT EXISTS team_worklogs (
        base_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        day TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        markdown TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'worklog',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(base_id, user_name, day)
      );
      CREATE INDEX IF NOT EXISTS team_worklogs_day ON team_worklogs(base_id, day, updated_at);
      CREATE TABLE IF NOT EXISTS worklog_summaries (
        id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL,
        from_day TEXT NOT NULL,
        to_day TEXT NOT NULL,
        markdown TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        engine TEXT NOT NULL DEFAULT 'extractive',
        keywords TEXT NOT NULL DEFAULT '[]',
        wiki_page_id TEXT,
        document_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS worklog_summaries_base ON worklog_summaries(base_id, to_day);
      CREATE TABLE IF NOT EXISTS automation_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const fileColumns = this.db.prepare('PRAGMA table_info(files)').all().map(column => column.name)
    if (!fileColumns.includes('user_name')) this.db.exec('ALTER TABLE files ADD COLUMN user_name TEXT')
    const summaryColumns = this.db.prepare('PRAGMA table_info(worklog_summaries)').all().map(column => column.name)
    if (!summaryColumns.includes('keywords')) this.db.exec("ALTER TABLE worklog_summaries ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]'")
    if (!summaryColumns.includes('wiki_page_id')) this.db.exec('ALTER TABLE worklog_summaries ADD COLUMN wiki_page_id TEXT')
    if (!summaryColumns.includes('document_id')) this.db.exec('ALTER TABLE worklog_summaries ADD COLUMN document_id TEXT')
  }

  close() {
    this.db.close()
  }

  countUsers() {
    return this.db.prepare('SELECT count(*) AS count FROM users').get().count
  }

  listUsers() {
    return this.db.prepare('SELECT id,email,name,role,active,created_at,last_login_at FROM users ORDER BY created_at').all()
      .map(row => ({ ...row, active: Boolean(row.active) }))
  }

  getUser(id) {
    const row = this.db.prepare('SELECT id,email,name,role,active,created_at,last_login_at FROM users WHERE id=?').get(id)
    return row === undefined ? undefined : { ...row, active: Boolean(row.active) }
  }

  findUser(email) {
    const row = this.db.prepare('SELECT * FROM users WHERE email=?').get(normalizeEmail(email))
    return row === undefined ? undefined : { ...row, active: Boolean(row.active) }
  }

  createUser({ email, name, password, role = 'editor', actor = null }) {
    const normalized = normalizeEmail(email)
    if (!EMAIL_RE.test(normalized)) throw new TeamError('邮箱格式不正确')
    const display = String(name ?? '').trim() || normalized.split('@')[0]
    if (!validPassword(password)) throw new TeamError('密码至少 10 位')
    if (!ROLES.has(role)) throw new TeamError('角色无效')
    if (this.findUser(normalized) !== undefined) throw new TeamError('该邮箱已存在', 409)
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(password, salt, 64).toString('hex')
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare('INSERT INTO users (id,email,name,role,salt,password_hash,active,created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(id, normalized, display, role, salt, hash, now)
    this.audit(actor, 'user.create', id, `${normalized} ${role}`)
    return this.getUser(id)
  }

  authenticate(email, password) {
    const user = this.findUser(email)
    if (user === undefined || !user.active) return undefined
    const actual = scryptSync(String(password ?? ''), user.salt, 64)
    const expected = Buffer.from(user.password_hash, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
    this.db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(new Date().toISOString(), user.id)
    return this.getUser(user.id)
  }

  createSession(userId, days = 7) {
    const token = randomBytes(32).toString('base64url')
    const csrf = randomBytes(24).toString('base64url')
    const now = Date.now()
    this.db.prepare('INSERT INTO sessions (token_hash,user_id,csrf,created_at,expires_at) VALUES (?,?,?,?,?)')
      .run(hashToken(token), userId, csrf, now, now + days * 86_400_000)
    return { token, csrf, expiresAt: now + days * 86_400_000 }
  }

  session(token) {
    if (typeof token !== 'string' || token.length < 20) return undefined
    const row = this.db.prepare(`SELECT s.token_hash,s.csrf,s.expires_at,u.id,u.email,u.name,u.role,u.active
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(token))
    if (row === undefined || row.expires_at <= Date.now() || !row.active) return undefined
    return {
      tokenHash: row.token_hash,
      csrf: row.csrf,
      expiresAt: row.expires_at,
      user: { id: row.id, email: row.email, name: row.name, role: row.role, active: Boolean(row.active) },
    }
  }

  deleteSession(token) {
    if (typeof token === 'string') this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token))
  }

  deleteUserSessions(userId) {
    this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId)
  }

  updateUser(id, { role, active }, actor = null) {
    const user = this.getUser(id)
    if (user === undefined) throw new TeamError('成员不存在', 404)
    if (role !== undefined && !ROLES.has(role)) throw new TeamError('角色无效')
    if (active !== undefined && typeof active !== 'boolean') throw new TeamError('状态无效')
    this.db.prepare('UPDATE users SET role=COALESCE(?,role), active=COALESCE(?,active) WHERE id=?')
      .run(role ?? null, active === undefined ? null : active ? 1 : 0, id)
    if (active === false) this.deleteUserSessions(id)
    this.audit(actor, 'user.update', id, JSON.stringify({ role, active }))
    return this.getUser(id)
  }

  createInvite({ role = 'editor', createdBy, expiresHours = 168 }) {
    if (!ROLES.has(role)) throw new TeamError('角色无效')
    const token = randomBytes(24).toString('base64url')
    const now = Date.now()
    this.db.prepare('INSERT INTO invites (token_hash,role,created_by,created_at,expires_at) VALUES (?,?,?,?,?)')
      .run(hashToken(token), role, createdBy, new Date().toISOString(), now + expiresHours * 3_600_000)
    this.audit(createdBy, 'invite.create', null, role)
    return { token, role, expiresAt: now + expiresHours * 3_600_000 }
  }

  inspectInvite(token) {
    if (typeof token !== 'string' || token.length < 20) return undefined
    const row = this.db.prepare('SELECT role,expires_at,used_at FROM invites WHERE token_hash=?').get(hashToken(token))
    if (row === undefined || row.used_at !== null || row.expires_at <= Date.now()) return undefined
    return { role: row.role, expiresAt: row.expires_at }
  }

  acceptInvite(token, { email, name, password }) {
    const invite = this.inspectInvite(token)
    if (invite === undefined) throw new TeamError('邀请链接已失效', 410)
    const user = this.createUser({ email, name, password, role: invite.role })
    // 邀请只能被领取一次；并发领取时后到者撤销刚创建的用户。
    const updated = this.db.prepare('UPDATE invites SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?')
      .run(new Date().toISOString(), hashToken(token), Date.now())
    if (updated.changes !== 1) {
      this.db.prepare('DELETE FROM users WHERE id=?').run(user.id)
      throw new TeamError('邀请链接已被使用', 410)
    }
    return user
  }

  audit(actorId, action, target = null, detail = null) {
    this.db.prepare('INSERT INTO audit (at,actor_id,action,target,detail) VALUES (?,?,?,?,?)')
      .run(new Date().toISOString(), actorId ?? null, action, target, detail)
  }

  recordChange({ entityKind, entityId, baseId, operation, version = null, payload = null, occurredAt = new Date().toISOString() }) {
    this.db.prepare(`INSERT INTO sync_changes
      (entity_kind,entity_id,base_id,operation,version,occurred_at,payload)
      VALUES (?,?,?,?,?,?,?)`)
      .run(entityKind, entityId, baseId, operation, version, occurredAt, payload === null ? null : JSON.stringify(payload))
  }

  listChanges(baseId, since = '', limit = 200) {
    const size = Math.min(Math.max(Number(limit) || 200, 1), 1000)
    const rows = this.db.prepare(`SELECT * FROM sync_changes
      WHERE base_id=? AND occurred_at>? ORDER BY occurred_at, seq LIMIT ?`).all(baseId, String(since ?? ''), size)
    return rows.map(row => ({
      seq: row.seq,
      entityKind: row.entity_kind,
      entityId: row.entity_id,
      baseId: row.base_id,
      operation: row.operation,
      version: row.version,
      occurredAt: row.occurred_at,
      payload: row.payload === null ? null : JSON.parse(row.payload),
    }))
  }

  listFileText(baseId) {
    return this.db.prepare('SELECT * FROM file_text WHERE base_id=? ORDER BY updated_at DESC').all(baseId)
  }

  getFileText(fileId) {
    return this.db.prepare('SELECT * FROM file_text WHERE file_id=?').get(fileId)
  }

  setFileText({ fileId, baseId, status, content = '', parser = null, error = null, name = '' }) {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO file_text (file_id,base_id,status,content,parser,error,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(file_id) DO UPDATE SET base_id=excluded.base_id,status=excluded.status,content=excluded.content,
      parser=excluded.parser,error=excluded.error,updated_at=excluded.updated_at`)
      .run(fileId, baseId, status, content, parser, error, now)
    this.db.prepare('DELETE FROM file_text_fts WHERE file_id=?').run(fileId)
    if (status === 'parsed' && content !== '') {
      this.db.prepare('INSERT INTO file_text_fts (file_id,base_id,name,content) VALUES (?,?,?,?)')
        .run(fileId, baseId, name, content)
    }
    return this.getFileText(fileId)
  }

  searchFileText(baseId, query, limit = 20) {
    const raw = String(query ?? '').trim()
    const terms = raw.split(/\s+/u).map(term => term.replace(/[^\p{L}\p{N}_-]/gu, '')).filter(Boolean).slice(0, 8)
    if (terms.length === 0) return []
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')
    try {
      const hits = this.db.prepare(`SELECT f.file_id AS fileId, f.base_id AS baseId, f.name AS name,
        snippet(file_text_fts, 3, '【', '】', '…', 24) AS snippet, bm25(file_text_fts) AS score
        FROM file_text_fts f JOIN files x ON x.id=f.file_id
        WHERE file_text_fts MATCH ? AND f.base_id=? ORDER BY score LIMIT ?`).all(match, baseId, Math.min(Math.max(limit, 1), 100))
      if (hits.length > 0) return hits
    } catch { /* fall through to substring search */ }
    // 中文等没有空格分词时，FTS5 往往只能命中完整短语；补充有限长度的子串检索。
    if (raw.length < 2) return []
    const pattern = `%${raw.slice(0, 80)}%`
    return this.db.prepare(`SELECT t.file_id AS fileId, t.base_id AS baseId, x.name AS name,
      substr(t.content, max(1, instr(t.content, ?) - 30), 90) AS snippet, 0 AS score
      FROM file_text t JOIN files x ON x.id=t.file_id
      WHERE t.base_id=? AND t.status='parsed' AND (t.content LIKE ? OR x.name LIKE ?)
      ORDER BY t.updated_at DESC LIMIT ?`).all(raw.slice(0, 80), baseId, pattern, pattern, Math.min(Math.max(limit, 1), 100))
  }

  listDataSources(baseId) {
    return this.db.prepare(`SELECT id,base_id,provider,name,owner,repo,ref,include_pattern,source_group,status,error,last_synced_at,created_by,created_at,updated_at
      FROM data_sources WHERE base_id=? ORDER BY updated_at DESC`).all(baseId).map(row => ({
      ...row,
      includePattern: row.include_pattern,
      sourceGroup: row.source_group,
      lastSyncedAt: row.last_synced_at,
      hasToken: this.db.prepare('SELECT token FROM data_sources WHERE id=?').get(row.id)?.token !== null,
    }))
  }

  getDataSource(id) {
    return this.db.prepare('SELECT * FROM data_sources WHERE id=?').get(id)
  }

  createDataSource({ baseId, provider, name, owner, repo, ref = '', token = null, includePattern = '', sourceGroup = '', createdBy = null }) {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO data_sources
      (id,base_id,provider,name,owner,repo,ref,token,include_pattern,source_group,status,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'idle',?,?,?)`)
      .run(id, baseId, provider, name, owner, repo, ref, token, includePattern, sourceGroup, createdBy, now, now)
    return this.getDataSource(id)
  }

  updateDataSource(id, { name, ref, token, includePattern, sourceGroup, status, error, lastSyncedAt }) {
    const source = this.getDataSource(id)
    if (source === undefined) throw new TeamError('数据源不存在', 404)
    this.db.prepare(`UPDATE data_sources SET name=COALESCE(?,name), ref=COALESCE(?,ref), token=COALESCE(?,token),
      include_pattern=COALESCE(?,include_pattern), source_group=COALESCE(?,source_group), status=COALESCE(?,status),
      error=?, last_synced_at=COALESCE(?,last_synced_at), updated_at=? WHERE id=?`)
      .run(name ?? null, ref ?? null, token ?? null, includePattern ?? null, sourceGroup ?? null, status ?? null,
        error ?? null, lastSyncedAt ?? null, new Date().toISOString(), id)
    return this.getDataSource(id)
  }

  deleteDataSource(id) {
    return this.db.prepare('DELETE FROM data_sources WHERE id=?').run(id).changes
  }

  getSourceItem(sourceId, path) {
    return this.db.prepare('SELECT * FROM source_items WHERE source_id=? AND path=?').get(sourceId, path)
  }

  setSourceItem({ sourceId, path, documentId, sha256 = null }) {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO source_items (source_id,path,document_id,sha256,updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(source_id,path) DO UPDATE SET document_id=excluded.document_id,sha256=excluded.sha256,updated_at=excluded.updated_at`)
      .run(sourceId, path, documentId, sha256, now)
  }

  listSourceItems(sourceId) {
    return this.db.prepare('SELECT * FROM source_items WHERE source_id=? ORDER BY path').all(sourceId)
  }

  upsertWorklog({ baseId, userName, day, revision = 0, markdown, source = 'worklog' }) {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO team_worklogs (base_id,user_name,day,revision,markdown,source,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(base_id,user_name,day) DO UPDATE SET
        revision=CASE WHEN excluded.revision > team_worklogs.revision THEN excluded.revision ELSE team_worklogs.revision END,
        markdown=excluded.markdown, source=excluded.source, updated_at=excluded.updated_at`)
      .run(baseId, userName, day, revision, markdown, source, now)
    return this.getWorklog(baseId, userName, day)
  }

  getWorklog(baseId, userName, day) {
    return this.db.prepare('SELECT * FROM team_worklogs WHERE base_id=? AND user_name=? AND day=?').get(baseId, userName, day)
  }

  listWorklogs(baseId, fromDay = '', toDay = '') {
    const from = fromDay === '' ? '0000-00-00' : fromDay
    const to = toDay === '' ? '9999-99-99' : toDay
    return this.db.prepare('SELECT * FROM team_worklogs WHERE base_id=? AND day>=? AND day<=? ORDER BY day DESC, user_name').all(baseId, from, to)
  }

  listWorklogSummaries(baseId, limit = 20) {
    return this.db.prepare('SELECT * FROM worklog_summaries WHERE base_id=? ORDER BY to_day DESC, updated_at DESC LIMIT ?').all(baseId, Math.max(1, Math.min(100, limit)))
  }

  findWorklogSummary(baseId, fromDay, toDay) {
    return this.db.prepare('SELECT * FROM worklog_summaries WHERE base_id=? AND from_day=? AND to_day=? ORDER BY updated_at DESC LIMIT 1').get(baseId, fromDay, toDay)
  }

  getWorklogSummary(id) {
    return this.db.prepare('SELECT * FROM worklog_summaries WHERE id=?').get(id)
  }

  createWorklogSummary({ baseId, fromDay, toDay, markdown, status = 'draft', engine = 'extractive', keywords = [], wikiPageId = null, documentId = null }) {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO worklog_summaries (id,base_id,from_day,to_day,markdown,status,engine,keywords,wiki_page_id,document_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, baseId, fromDay, toDay, markdown, status, engine, JSON.stringify(keywords), wikiPageId, documentId, now, now)
    return this.getWorklogSummary(id)
  }

  updateWorklogSummary(id, { markdown, status, keywords, wikiPageId, documentId }) {
    this.db.prepare('UPDATE worklog_summaries SET markdown=COALESCE(?,markdown), status=COALESCE(?,status), keywords=COALESCE(?,keywords), wiki_page_id=COALESCE(?,wiki_page_id), document_id=COALESCE(?,document_id), updated_at=? WHERE id=?')
      .run(markdown ?? null, status ?? null, keywords === undefined ? null : JSON.stringify(keywords), wikiPageId ?? null, documentId ?? null, new Date().toISOString(), id)
    return this.getWorklogSummary(id)
  }

  getAutomationState(key) {
    const row = this.db.prepare('SELECT * FROM automation_state WHERE key=?').get(key)
    return row === undefined ? undefined : row.value
  }

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)
    return row === undefined ? undefined : row.value
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, String(value), new Date().toISOString())
  }

  deleteSetting(key) {
    this.db.prepare('DELETE FROM app_settings WHERE key=?').run(key)
  }

  setAutomationState(key, value) {
    this.db.prepare(`INSERT INTO automation_state (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, String(value), new Date().toISOString())
  }

  listWikiPages(baseId) {    return this.db.prepare('SELECT id,base_id,slug,title,status,version,created_by,updated_by,created_at,updated_at FROM wiki_pages WHERE base_id=? ORDER BY updated_at DESC').all(baseId)
  }

  getWikiPage(id) {
    const row = this.db.prepare('SELECT * FROM wiki_pages WHERE id=?').get(id)
    if (row === undefined) return undefined
    return { ...row, sources: this.listWikiSources(id) }
  }

  findWikiPage(baseId, slug) {
    return this.db.prepare('SELECT * FROM wiki_pages WHERE base_id=? AND slug=?').get(baseId, slug)
  }

  listWikiSources(pageId) {
    return this.db.prepare('SELECT * FROM wiki_sources WHERE page_id=? ORDER BY created_at').all(pageId)
      .map(row => ({ ...row, lineStart: row.line_start, lineEnd: row.line_end }))
  }

  listWikiVersions(pageId) {
    return this.db.prepare('SELECT id,page_id,version,title,status,created_by,created_at FROM wiki_versions WHERE page_id=? ORDER BY version DESC').all(pageId)
  }

  createWikiPage({ baseId, slug, title, content, createdBy = null, status = 'draft', sources = [] }) {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO wiki_pages (id,base_id,slug,title,content,status,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?,?,?)`).run(id, baseId, slug, title, content, status, createdBy, createdBy, now, now)
    this.recordWikiVersion(id, title, content, status, createdBy, 1)
    for (const source of sources) this.addWikiSource(id, source)
    return this.getWikiPage(id)
  }

  updateWikiPage(id, { title, content, status, updatedBy = null, sources = undefined }) {
    const page = this.getWikiPage(id)
    if (page === undefined) throw new TeamError('Wiki 页面不存在', 404)
    const version = page.version + 1
    const now = new Date().toISOString()
    this.db.prepare(`UPDATE wiki_pages SET title=?,content=?,status=?,version=?,updated_by=?,updated_at=? WHERE id=?`)
      .run(title, content, status, version, updatedBy, now, id)
    this.recordWikiVersion(id, title, content, status, updatedBy, version)
    if (Array.isArray(sources)) {
      this.db.prepare('DELETE FROM wiki_sources WHERE page_id=?').run(id)
      for (const source of sources) this.addWikiSource(id, source)
    }
    this.recordChange({ entityKind: 'wiki', entityId: id, baseId: page.base_id, operation: 'update', version, payload: { title, status } })
    return this.getWikiPage(id)
  }

  publishWikiPage(id, actor = null) {
    const page = this.getWikiPage(id)
    if (page === undefined) throw new TeamError('Wiki 页面不存在', 404)
    return this.updateWikiPage(id, { title: page.title, content: page.content, status: 'published', updatedBy: actor })
  }

  deleteWikiPage(id) {
    const page = this.getWikiPage(id)
    if (page === undefined) return 0
    this.db.prepare('DELETE FROM wiki_pages WHERE id=?').run(id)
    this.recordChange({ entityKind: 'wiki', entityId: id, baseId: page.base_id, operation: 'delete', payload: { title: page.title } })
    return 1
  }

  recordWikiVersion(pageId, title, content, status, createdBy, version) {
    this.db.prepare(`INSERT INTO wiki_versions (id,page_id,version,title,content,status,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), pageId, version, title, content, status, createdBy ?? null, new Date().toISOString())
  }

  addWikiSource(pageId, source) {
    const id = randomUUID()
    this.db.prepare(`INSERT INTO wiki_sources
      (id,page_id,source_kind,source_id,title,excerpt,line_start,line_end,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, pageId, source.kind ?? 'document', source.sourceId ?? '', source.title ?? '', source.excerpt ?? null,
      source.lineStart ?? null, source.lineEnd ?? null, new Date().toISOString())
  }

  restoreWikiVersion(pageId, version, actor = null) {
    const row = this.db.prepare('SELECT * FROM wiki_versions WHERE page_id=? AND version=?').get(pageId, version)
    if (row === undefined) throw new TeamError('Wiki 版本不存在', 404)
    return this.updateWikiPage(pageId, { title: row.title, content: row.content, status: row.status, updatedBy: actor })
  }

  listAudit(limit = 100) {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500))
  }

  listFiles(baseId) {
    return this.db.prepare('SELECT * FROM files WHERE base_id=? ORDER BY updated_at DESC').all(baseId)
  }

  getFile(id) {
    return this.db.prepare('SELECT * FROM files WHERE id=?').get(id)
  }

  findFileBySource(baseId, sourceKey) {
    if (sourceKey === undefined || sourceKey === null || sourceKey === '') return undefined
    return this.db.prepare('SELECT * FROM files WHERE base_id=? AND source_key=?').get(baseId, sourceKey)
  }

  addFile({ id, baseId, name, mime, size, sha256, storagePath, sourceKey = null, userName = null, uploadedBy = null }) {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO files
      (id,base_id,name,mime,size,sha256,storage_path,source_key,user_name,uploaded_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, baseId, name, mime, size, sha256, storagePath, sourceKey, userName, uploadedBy, now, now)
    this.recordChange({ entityKind: 'file', entityId: id, baseId, operation: 'create', payload: { name, mime, size, sha256, sourceKey, userName } })
    return this.getFile(id)
  }

  updateFile(id, { name, mime, size, sha256, storagePath }) {
    const now = new Date().toISOString()
    this.db.prepare('UPDATE files SET name=?,mime=?,size=?,sha256=?,storage_path=?,updated_at=? WHERE id=?')
      .run(name, mime, size, sha256, storagePath, now, id)
    const row = this.getFile(id)
    this.recordChange({ entityKind: 'file', entityId: id, baseId: row.base_id, operation: 'update', payload: { name, mime, size, sha256 } })
    return row
  }

  deleteFile(id) {
    const row = this.getFile(id)
    if (row === undefined) return 0
    this.db.prepare('DELETE FROM file_text_fts WHERE file_id=?').run(id)
    this.db.prepare('DELETE FROM file_text WHERE file_id=?').run(id)
    const changes = this.db.prepare('DELETE FROM files WHERE id=?').run(id).changes
    if (changes > 0) this.recordChange({ entityKind: 'file', entityId: id, baseId: row.base_id, operation: 'delete', payload: { name: row.name } })
    return changes
  }
}
