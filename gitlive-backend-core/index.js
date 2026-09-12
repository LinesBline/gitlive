// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive-backend-core
//
// Shared db/auth/storage implementation for the gitlive backend layer (ADR-001).
// Every function here is transport-agnostic: it takes an explicit `ctx` and does
// nothing else. gitlive-client's standalone mode calls these directly, in-process.
// gitlive-backend (the optional daemon) calls the exact same functions when it
// dispatches an incoming socket request. There is exactly one implementation of
// "verify a session" or "write a blob" — that's what makes the hybrid in ADR-001
// work without two codepaths to keep in sync.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  // Surfaced as a clear, actionable error rather than a cryptic MODULE_NOT_FOUND —
  // this project has been burned before (see gitlive's DESIGN.md) by silent
  // environment-mismatch failures, so fail loud and specific.
  throw new Error(
    'gitlive-backend-core requires Node 22.5+ with node:sqlite available. ' +
    'Run `node --version` and `node -e "require(\'node:sqlite\')"` to check. ' +
    'Original error: ' + err.message
  );
}

class BackendError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackendError';
    this.code = code; // 'NOT_FOUND' | 'CONFLICT' | 'INVALID_ARGS' | 'INTERNAL'
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_KEYLEN = 64;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function openApp(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const storageDir = path.join(dataDir, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });

  const dbPath = path.join(dataDir, 'app.db');

  // Cold-start races: when two processes bring up the SAME fresh data dir at
  // once (a real --safe blue-green boot — old and new slot both starting
  // against one empty $GITLIVE_DATA_DIR), SQLite's initial file creation +
  // journal-mode switch can hit SQLITE_BUSY before this connection has any
  // busy handler worth relying on (journal_mode itself needs an exclusive
  // lock, and a second process may be mid-creation). The 5s window below
  // mirrors the busy_timeout on the connection itself: brief rides are fine,
  // something genuinely stuck still fails loudly.
  const BUSY_RE = /(locked|busy)/i;
  const deadline = Date.now() + 5000;
  let lastErr;
  while (Date.now() < deadline) {
    let db;
    try {
      db = new DatabaseSync(dbPath);
      // busy_timeout must be installed BEFORE journal_mode: switching to WAL
      // takes an exclusive lock, and with no busy handler yet a second
      // process cold-starting the same fresh data dir dies instantly with
      // "database is locked" on the journal-mode pragma itself. Order
      // matters, not just presence.
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      bootstrapSystemTables(db);
      return { db, dataDir, storageDir };
    } catch (err) {
      lastErr = err;
      try { if (db) db.close(); } catch { /* already closed */ }
      if (!BUSY_RE.test(err.message)) throw err;
      // Synchronous sleep — openApp must stay sync for every existing
      // caller (client, daemon script, tests). Atomics.wait blocks the
      // thread without burning CPU.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  throw lastErr || new Error(`openApp: could not open ${dbPath} within 5s`);
}

function bootstrapSystemTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _gitlive_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _gitlive_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _gitlive_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES _gitlive_users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _gitlive_storage_meta (
      key TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      content_type TEXT,
      etag TEXT NOT NULL,
      modified_at TEXT NOT NULL
    );
  `);
}

function close(ctx) {
  ctx.db.close();
}

// ---------------------------------------------------------------------------
// db — thin, deliberately not an ORM
// ---------------------------------------------------------------------------

const db = {
  query(ctx, sql, params = []) {
    return ctx.db.prepare(sql).all(...params);
  },

  exec(ctx, sql, params = []) {
    const info = ctx.db.prepare(sql).run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  },

  migrate(ctx, migrationsDir) {
    if (!fs.existsSync(migrationsDir)) {
      return { applied: [] };
    }
    const already = new Set(
      ctx.db.prepare('SELECT name FROM _gitlive_migrations').all().map((r) => r.name)
    );
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // filename order, e.g. 001_init.sql, 002_add_todos.sql

    const applied = [];
    for (const file of files) {
      if (already.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      ctx.db.exec('BEGIN');
      try {
        ctx.db.exec(sql);
        ctx.db
          .prepare('INSERT INTO _gitlive_migrations (name, applied_at) VALUES (?, ?)')
          .run(file, new Date().toISOString());
        ctx.db.exec('COMMIT');
        applied.push(file);
      } catch (err) {
        ctx.db.exec('ROLLBACK');
        throw new BackendError('INTERNAL', `migration ${file} failed: ${err.message}`);
      }
    }
    return { applied };
  },
};

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

// scrypt is deliberately CPU-heavy (that's what makes it resistant to
// brute-forcing) — real enough to matter that scryptSync measurably queues
// up the single-threaded daemon under concurrent signups/logins, confirmed
// by a real 50-concurrent-signup test: some calls timed out client-side
// (2s) even though the daemon was still working through the queue and
// every one of them eventually succeeded. crypto.scrypt's async form runs
// on libuv's thread pool instead of blocking the main thread, so other
// requests (a read, another app's traffic) keep flowing while a hash
// computes. This is why auth.createUser/verifyPassword are async — every
// other function in this module stays synchronous because SQLite itself
// isn't the bottleneck here, hashing is.
const scryptAsync = require('node:util').promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, SCRYPT_KEYLEN)).toString('hex');
  return `${salt}:${hash}`;
}

async function verifyPasswordHash(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

const auth = {
  async createUser(ctx, { email, password }) {
    if (!email || !password) {
      throw new BackendError('INVALID_ARGS', 'email and password are required');
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    // Checked again, synchronously, right before the INSERT below — the
    // scrypt hashing in between is the one truly slow step, and another
    // concurrent createUser for the same email could complete while this
    // one is still hashing. The SELECT here is a fast pre-check for a
    // clean, fast-path CONFLICT; the UNIQUE constraint on the table itself
    // (not just this check) is what actually prevents a real race from
    // landing two rows for the same email — see the try/catch below.
    const existing = ctx.db
      .prepare('SELECT id FROM _gitlive_users WHERE email = ?')
      .get(normalizedEmail);
    if (existing) {
      throw new BackendError('CONFLICT', `a user with email ${normalizedEmail} already exists`);
    }
    const passwordHash = await hashPassword(password);
    const createdAt = new Date().toISOString();
    let info;
    try {
      info = ctx.db
        .prepare('INSERT INTO _gitlive_users (email, password_hash, created_at) VALUES (?, ?, ?)')
        .run(normalizedEmail, passwordHash, createdAt);
    } catch (err) {
      // Two concurrent createUser calls for the same email can both pass
      // the pre-check above (both start hashing before either has
      // inserted) — the table's own UNIQUE constraint is the real guard,
      // and hitting it here is a legitimate CONFLICT, not an internal
      // error. Never possible to trigger with gitlive-hello's test suite
      // (unique emails per test) — only found by testing genuine
      // concurrent load, not by code review.
      if (String(err.message || '').includes('UNIQUE constraint failed')) {
        throw new BackendError('CONFLICT', `a user with email ${normalizedEmail} already exists`);
      }
      throw err;
    }
    return { id: info.lastInsertRowid, email: normalizedEmail, createdAt };
  },

  async verifyPassword(ctx, { email, password }) {
    if (!email || !password) return null;
    const normalizedEmail = String(email).trim().toLowerCase();
    const row = ctx.db
      .prepare('SELECT id, email, password_hash FROM _gitlive_users WHERE email = ?')
      .get(normalizedEmail);
    if (!row) return null;
    if (!(await verifyPasswordHash(password, row.password_hash))) return null;
    return { id: row.id, email: row.email };
  },

  createSession(ctx, userId) {
    const user = ctx.db.prepare('SELECT id FROM _gitlive_users WHERE id = ?').get(userId);
    if (!user) {
      throw new BackendError('NOT_FOUND', `no user with id ${userId}`);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256hex(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    ctx.db
      .prepare('INSERT OR REPLACE INTO _gitlive_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, userId, expiresAt);
    return { token, expiresAt };
  },

  verifySession(ctx, token) {
    if (!token) return null;
    const tokenHash = sha256hex(token);
    const row = ctx.db
      .prepare(
        `SELECT s.user_id AS userId, s.expires_at AS expiresAt, u.email AS email
         FROM _gitlive_sessions s JOIN _gitlive_users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash);
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      ctx.db.prepare('DELETE FROM _gitlive_sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return { userId: row.userId, email: row.email };
  },

  revokeSession(ctx, token) {
    if (!token) return;
    ctx.db.prepare('DELETE FROM _gitlive_sessions WHERE token_hash = ?').run(sha256hex(token));
  },
};

// ---------------------------------------------------------------------------
// storage — files live under <dataDir>/storage/<key>. "/" in a key is a
// namespacing convention (e.g. "avatars/123.png"), not a path apps manage
// themselves; parent directories are created for them.
// ---------------------------------------------------------------------------

function safeStoragePath(storageDir, key) {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) {
    throw new BackendError('INVALID_ARGS', 'storage key must be a non-empty string');
  }
  const resolved = path.resolve(storageDir, key);
  const withinStorage = resolved === storageDir || resolved.startsWith(storageDir + path.sep);
  if (!withinStorage) {
    throw new BackendError('INVALID_ARGS', `storage key "${key}" resolves outside the app's storage dir`);
  }
  return resolved;
}

const storage = {
  put(ctx, key, buffer, { contentType } = {}) {
    if (!Buffer.isBuffer(buffer)) {
      throw new BackendError('INVALID_ARGS', 'storage.put requires a Buffer');
    }
    const filePath = safeStoragePath(ctx.storageDir, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);

    const size = buffer.length;
    const etag = sha256hex(buffer);
    const modifiedAt = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT INTO _gitlive_storage_meta (key, size, content_type, etag, modified_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           size = excluded.size,
           content_type = excluded.content_type,
           etag = excluded.etag,
           modified_at = excluded.modified_at`
      )
      .run(key, size, contentType ?? null, etag, modifiedAt);

    return { key, size, etag };
  },

  get(ctx, key) {
    const meta = ctx.db
      .prepare('SELECT size, content_type AS contentType FROM _gitlive_storage_meta WHERE key = ?')
      .get(key);
    if (!meta) return null;
    const filePath = safeStoragePath(ctx.storageDir, key);
    if (!fs.existsSync(filePath)) return null; // meta/blob got out of sync — treat as missing
    const buffer = fs.readFileSync(filePath);
    return { buffer, contentType: meta.contentType, size: meta.size };
  },

  delete(ctx, key) {
    const meta = ctx.db.prepare('SELECT key FROM _gitlive_storage_meta WHERE key = ?').get(key);
    if (!meta) return false;
    const filePath = safeStoragePath(ctx.storageDir, key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    ctx.db.prepare('DELETE FROM _gitlive_storage_meta WHERE key = ?').run(key);
    return true;
  },

  list(ctx, prefix = '') {
    return ctx.db
      .prepare(
        `SELECT key, size, modified_at AS modifiedAt
         FROM _gitlive_storage_meta
         WHERE key LIKE ? ESCAPE '\\'
         ORDER BY key`
      )
      .all(escapeLike(prefix) + '%');
  },
};

function escapeLike(str) {
  return String(str).replace(/[\\%_]/g, (c) => '\\' + c);
}

// ---------------------------------------------------------------------------
// stats — a small read-only summary, so an app can show "N users, N files,
// N bytes stored" without reaching into gitlive's internal `_gitlive_*`
// tables itself. Those tables are this module's own implementation detail,
// not a supported surface for app code to query directly.
// ---------------------------------------------------------------------------

function getStats(ctx) {
  const { userCount } = ctx.db.prepare('SELECT COUNT(*) AS userCount FROM _gitlive_users').get();
  const { fileCount, totalBytes } = ctx.db
    .prepare('SELECT COUNT(*) AS fileCount, COALESCE(SUM(size), 0) AS totalBytes FROM _gitlive_storage_meta')
    .get();
  return { userCount, fileCount, totalBytes };
}

// ---------------------------------------------------------------------------
// callOp — single op-name -> function dispatch table, shared by
// gitlive-client's standalone path and gitlive-backend's daemon-side RPC
// handler (see rpc.js), so there is exactly one mapping of wire op names
// to behavior, not two copies that can drift.
// ---------------------------------------------------------------------------

const OPS = {
  'db.query': (ctx, args) => db.query(ctx, args.sql, args.params || []),
  'db.exec': (ctx, args) => db.exec(ctx, args.sql, args.params || []),
  'db.migrate': (ctx, args) => db.migrate(ctx, args.migrationsDir),

  'auth.createUser': (ctx, args) => auth.createUser(ctx, { email: args.email, password: args.password }),
  'auth.verifyPassword': (ctx, args) => auth.verifyPassword(ctx, { email: args.email, password: args.password }),
  'auth.createSession': (ctx, args) => auth.createSession(ctx, args.userId),
  'auth.verifySession': (ctx, args) => auth.verifySession(ctx, args.token),
  'auth.revokeSession': (ctx, args) => {
    auth.revokeSession(ctx, args.token);
    return null;
  },

  'storage.put': (ctx, args, payload) => storage.put(ctx, args.key, payload, { contentType: args.contentType }),
  'storage.get': (ctx, args) => storage.get(ctx, args.key),
  'storage.delete': (ctx, args) => storage.delete(ctx, args.key),
  'storage.list': (ctx, args) => storage.list(ctx, args.prefix || ''),

  'stats': (ctx) => getStats(ctx),
};

function callOp(ctx, op, args = {}, payload = null) {
  const fn = OPS[op];
  if (!fn) {
    throw new BackendError('INVALID_ARGS', `unknown op "${op}"`);
  }
  return fn(ctx, args, payload);
}

module.exports = {
  openApp,
  close,
  db,
  auth,
  storage,
  getStats,
  callOp,
  BackendError,
  // Exported so github.js (the github-repo-as-storage mode, see
  // github.js/github-store.js) reuses the exact same password hashing
  // instead of a second copy that could quietly drift out of sync with
  // this one — there is exactly one place password hashes are computed
  // or checked, same reasoning as callOp's single op-dispatch table.
  hashPassword,
  verifyPasswordHash,
};
