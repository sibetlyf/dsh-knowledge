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
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    `)
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

  listAudit(limit = 100) {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500))
  }
}
