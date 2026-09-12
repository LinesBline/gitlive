// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive-backend-core/github.js
//
// Third gitlive-backend-core mode (alongside the SQLite mode in index.js):
// every read and write is a real file in a real GitHub repo, via the
// Contents API (github-store.js does the wire format). His framing for why
// this exists — GitHub already hosts the app's code, "dormant" as far as
// gitlive was concerned; this mode "activates" that same repo as the app's
// data store too, instead of standing up a separate database. Same shortcut
// gitlive-hello originally proved this trick against hosted platforms/
// applied to storage rather than just deploys.
//
// Deliberately scoped to auth/storage/stats only — the same supported
// surface as the SQLite mode minus arbitrary SQL (db.* is explicitly
// rejected below, not half-supported as e.g. slow key/value scans).
// Reconciling this mode with the SQLite mode (one app using both, or a
// migration path between them) is out of scope for this round by his own
// instruction — see DESIGN.md's addendum for the full reasoning.

const crypto = require('node:crypto');
const store = require('./github-store');
const { hashPassword, verifyPasswordHash, BackendError } = require('./index');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — same as the SQLite mode

function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Real bug, found by review not by running anything: storage.put/delete do
// `index[key] = ...` on a plain object rebuilt from JSON.parse. A key of
// "__proto__" (plausible if a key is ever derived from user input, like a
// filename) doesn't become a normal entry — it reassigns the object's own
// prototype, silently corrupting every later Object.entries/hasOwnProperty
// call against that index for every key, not just this one. "constructor"
// and "prototype" are excluded too, same defensive reasoning as guarding
// against them in any code that indexes a plain object by an untrusted
// string. Blob/user/session paths are already safe by construction (the
// raw key is always hashed before it becomes part of a repo path — see
// storageBlobPath) — this guard is specifically for the one place a raw
// key becomes a JS object key instead of a path segment.
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function assertSafeStorageKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new BackendError('INVALID_ARGS', 'storage key must be a non-empty string');
  }
  if (UNSAFE_OBJECT_KEYS.has(key)) {
    throw new BackendError('INVALID_ARGS', `storage key "${key}" is reserved and cannot be used (it would corrupt the storage index)`);
  }
}

// putFileRaw's MAX_FILE_BYTES check runs against the JSON envelope (base64
// content + metadata), not the raw file — so a raw file safely under 1MB
// can still get rejected there, with an error reporting the wrapped size,
// not the size actually passed in. Checking the raw size here first, with
// a deliberately conservative ceiling (base64 alone is ~1.34x; the JSON
// structure and metadata fields add a bit more on top), means a caller
// gets a clear, accurate rejection before any hashing/encoding work
// happens, quoting the number they'll actually recognize.
const RAW_FILE_BYTES_LIMIT = Math.floor(store.MAX_FILE_BYTES / 1.4);

// Repo paths are never built from raw user input — an email or storage key
// containing "/", "..", or other path-meaningful characters must not turn
// into an unintended repo path. Every path below is either a fixed prefix
// or a hashed segment (sha256 of the real value), never the value itself.
const usersDir = (ctx) => `${ctx.dataPrefix}/users`;
const userPath = (ctx, email) => `${usersDir(ctx)}/${sha256hex(email)}.json`;
const sessionPath = (ctx, tokenHash) => `${ctx.dataPrefix}/sessions/${tokenHash}.json`;
const storageBlobPath = (ctx, key) => `${ctx.dataPrefix}/storage/blobs/${sha256hex(key)}.json`;
const storageIndexPath = (ctx) => `${ctx.dataPrefix}/storage/_index.json`;

function mapStoreError(err) {
  if (err.name !== 'GithubStoreError') throw err;
  // RATE_LIMITED / AUTH_ERROR / NETWORK_ERROR aren't application-level
  // outcomes an app should branch on the way it branches on CONFLICT or
  // NOT_FOUND — they're "the backend is unreachable right now," same
  // category as gitlive-client's CONNECTION_ERROR_CODES for the daemon
  // transport. Collapsed to INTERNAL here; the original code/message
  // survives on `cause` for logging.
  const code = err.code === 'CONFLICT' || err.code === 'INVALID_ARGS' ? err.code : 'INTERNAL';
  const mapped = new BackendError(code, err.message);
  mapped.cause = err;
  return mapped;
}

// Reads a JSON doc (or null if it doesn't exist yet), applies `mutate`, and
// writes the result back using the sha it was read at — GitHub's own sha
// check is the real concurrency guard, same principle as every other
// write in this file. `mutate` returning `undefined` means "nothing to
// write" (a clean no-op, e.g. deleting a key that was already absent).
//
// On a genuine race (someone else committed to this path in between) this
// re-reads the fresh sha and retries, up to `retries` times, with a short
// jittered backoff between attempts. A single retry (the original design)
// is enough for two racing writers but not for several — a realistic case
// this mode has to handle, since the storage index is one shared file
// every storage.put/delete goes through: a handful of near-simultaneous
// uploads (several users, or one user picking a handful of files) all
// contend for the same sha. More attempts with backoff, rather than one
// bare retry, is what actually resolves that under real concurrent load —
// verified in tests/github-mode.test.js with several genuinely concurrent
// storage.put calls against a fake API that enforces sha conflicts.
function jitterDelayMs(attempt) {
  return 20 + Math.floor(Math.random() * 40) * (attempt + 1);
}

async function upsertJson(ctx, repoPath, mutate, { message, retries = 6 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let existing;
    try {
      existing = await store.getFileRaw(ctx.cfg, repoPath);
    } catch (err) {
      throw mapStoreError(err);
    }
    const current = existing ? JSON.parse(existing.buffer.toString('utf8')) : null;
    const next = mutate(current);
    if (next === undefined) return current;
    const buffer = Buffer.from(JSON.stringify(next), 'utf8');
    try {
      await store.putFileRaw(ctx.cfg, repoPath, buffer, { sha: existing ? existing.sha : undefined, message });
      return next;
    } catch (err) {
      if (err.name === 'GithubStoreError' && err.code === 'CONFLICT' && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, jitterDelayMs(attempt)));
        continue; // re-read the fresh sha, try again
      }
      throw mapStoreError(err);
    }
  }
}

function openApp(config) {
  if (!config || !config.owner || !config.repo || !config.token) {
    throw new BackendError('INVALID_ARGS', 'github mode requires { owner, repo, token }');
  }
  return {
    cfg: {
      owner: config.owner,
      repo: config.repo,
      token: config.token,
      branch: config.branch || 'main',
      apiBase: config.apiBase,
    },
    // Everything this mode writes lives under one prefix, so a github-mode
    // app can share a repo with its own real source code without colliding
    // with it — the same role $GITLIVE_DATA_DIR plays for the SQLite/local
    // storage modes (a dedicated subdirectory, never the app's own checkout).
    dataPrefix: config.dataPrefix || '_gitlive',
  };
}

function close() {
  // Every op here is its own independent HTTPS request — nothing is held
  // open between calls. Present only for API symmetry with the SQLite
  // mode's close(ctx), which does need to release a real file handle.
}

const auth = {
  async createUser(ctx, { email, password }) {
    if (!email || !password) {
      throw new BackendError('INVALID_ARGS', 'email and password are required');
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const path = userPath(ctx, normalizedEmail);
    let existing;
    try {
      existing = await store.getFileRaw(ctx.cfg, path);
    } catch (err) {
      throw mapStoreError(err);
    }
    if (existing) {
      throw new BackendError('CONFLICT', `a user with email ${normalizedEmail} already exists`);
    }
    const passwordHash = await hashPassword(password);
    const createdAt = new Date().toISOString();
    try {
      await store.putFileRaw(
        ctx.cfg,
        path,
        Buffer.from(JSON.stringify({ email: normalizedEmail, passwordHash, createdAt }), 'utf8'),
        { message: `gitlive-backend: create user ${normalizedEmail}` }
      );
    } catch (err) {
      // Same real race the SQLite mode's createUser guards against: two
      // concurrent signups for the same email can both pass the
      // getFileRaw check above before either has committed. Here GitHub's
      // own "no sha supplied against a path that now exists" response is
      // the actual guard (mapped to CONFLICT by github-store.js).
      if (err.name === 'GithubStoreError' && err.code === 'CONFLICT') {
        throw new BackendError('CONFLICT', `a user with email ${normalizedEmail} already exists`);
      }
      throw mapStoreError(err);
    }
    // id === email is deliberate, not a placeholder: this mode has no
    // autoincrement id, and email is already this mode's real primary key
    // (see userPath). Returning it as `id` means app code that does
    // `gitlive.auth.createSession(user.id)` after a successful
    // createUser/verifyPassword works unchanged across every mode —
    // SQLite mode's `id` is a number, this mode's is the email string, but
    // callers never need to know which mode they're talking to.
    return { id: normalizedEmail, email: normalizedEmail, createdAt };
  },

  async verifyPassword(ctx, { email, password }) {
    if (!email || !password) return null;
    const normalizedEmail = String(email).trim().toLowerCase();
    let existing;
    try {
      existing = await store.getFileRaw(ctx.cfg, userPath(ctx, normalizedEmail));
    } catch (err) {
      throw mapStoreError(err);
    }
    if (!existing) return null;
    const doc = JSON.parse(existing.buffer.toString('utf8'));
    if (!(await verifyPasswordHash(password, doc.passwordHash))) return null;
    return { id: doc.email, email: doc.email };
  },

  // `id` here is the email string returned by createUser/verifyPassword
  // above (see the comment there) — this is genuinely the same call shape
  // as the SQLite mode's createSession(ctx, userId), not a lookalike.
  async createSession(ctx, id) {
    if (!id) {
      throw new BackendError('INVALID_ARGS', 'createSession requires a user id (email, in this mode)');
    }
    let existing;
    try {
      existing = await store.getFileRaw(ctx.cfg, userPath(ctx, id));
    } catch (err) {
      throw mapStoreError(err);
    }
    if (!existing) {
      throw new BackendError('NOT_FOUND', `no user with id ${id}`);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256hex(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    try {
      await store.putFileRaw(
        ctx.cfg,
        sessionPath(ctx, tokenHash),
        Buffer.from(JSON.stringify({ email: id, expiresAt }), 'utf8'),
        { message: `gitlive-backend: create session for ${id}` }
      );
    } catch (err) {
      throw mapStoreError(err);
    }
    return { token, expiresAt };
  },

  async verifySession(ctx, token) {
    if (!token) return null;
    const path = sessionPath(ctx, sha256hex(token));
    let existing;
    try {
      existing = await store.getFileRaw(ctx.cfg, path);
    } catch (err) {
      throw mapStoreError(err);
    }
    if (!existing) return null;
    const doc = JSON.parse(existing.buffer.toString('utf8'));
    if (new Date(doc.expiresAt).getTime() < Date.now()) {
      try {
        await store.deleteFileRaw(ctx.cfg, path, { sha: existing.sha, message: 'gitlive-backend: expire session' });
      } catch {
        // Best-effort cleanup — an expired session reads as "not logged
        // in" either way; a failed delete of an already-useless file
        // shouldn't fail verifySession itself.
      }
      return null;
    }
    return { userId: doc.email, email: doc.email };
  },

  async revokeSession(ctx, token) {
    if (!token) return;
    const path = sessionPath(ctx, sha256hex(token));
    let existing;
    try {
      existing = await store.getFileRaw(ctx.cfg, path);
    } catch (err) {
      throw mapStoreError(err);
    }
    if (!existing) return;
    try {
      await store.deleteFileRaw(ctx.cfg, path, { sha: existing.sha, message: 'gitlive-backend: revoke session' });
    } catch (err) {
      throw mapStoreError(err);
    }
  },
};

const storage = {
  async put(ctx, key, buffer, { contentType } = {}) {
    assertSafeStorageKey(key);
    if (!Buffer.isBuffer(buffer)) {
      throw new BackendError('INVALID_ARGS', 'storage.put requires a Buffer');
    }
    // Checked here, against the RAW size, before any hashing/encoding work
    // — putFileRaw's own MAX_FILE_BYTES check only sees the JSON-wrapped,
    // base64-inflated envelope, so without this a file safely under 1MB
    // could still get rejected there with an error quoting the wrapped
    // size, not the size actually passed in. This way the caller sees a
    // number that matches what they gave us.
    if (buffer.length > RAW_FILE_BYTES_LIMIT) {
      throw new BackendError(
        'INVALID_ARGS',
        `file is ${buffer.length} bytes, over this mode's ~${RAW_FILE_BYTES_LIMIT}-byte practical limit (the base64 + JSON envelope this mode wraps it in pushes a larger raw file over GitHub's real 1MB Contents API ceiling)`
      );
    }
    const size = buffer.length;
    const etag = sha256hex(buffer);
    const modifiedAt = new Date().toISOString();
    const blobPath = storageBlobPath(ctx, key);
    let existingBlob;
    try {
      existingBlob = await store.getFileRaw(ctx.cfg, blobPath);
    } catch (err) {
      throw mapStoreError(err);
    }
    const doc = { key, size, contentType: contentType ?? null, etag, modifiedAt, contentBase64: buffer.toString('base64') };
    try {
      await store.putFileRaw(ctx.cfg, blobPath, Buffer.from(JSON.stringify(doc), 'utf8'), {
        sha: existingBlob ? existingBlob.sha : undefined,
        message: `gitlive-backend: storage.put ${key}`,
      });
    } catch (err) {
      throw mapStoreError(err);
    }
    // The index is the only supported way to list or prefix-search — the
    // real key never appears as a repo path (blob paths are hashed, see
    // storageBlobPath) and GitHub's directory listing is single-level
    // anyway, so a recursive walk isn't an option the way it is for the
    // SQLite mode's SQL LIKE query.
    await upsertJson(
      ctx,
      storageIndexPath(ctx),
      (current) => {
        // Object.create(null) as defense in depth alongside
        // assertSafeStorageKey above — a null-prototype object has no
        // __proto__ setter to intercept, so even a key that somehow got
        // past the guard (or an index written before this fix existed)
        // can't reassign the object's prototype via plain assignment.
        const index = current ? Object.assign(Object.create(null), current) : Object.create(null);
        index[key] = { size, contentType: contentType ?? null, etag, modifiedAt };
        return index;
      },
      { message: `gitlive-backend: index storage.put ${key}` }
    );
    return { key, size, etag };
  },

  async get(ctx, key) {
    assertSafeStorageKey(key);
    let existing;
    try {
      existing = await store.getFileRaw(ctx.cfg, storageBlobPath(ctx, key));
    } catch (err) {
      throw mapStoreError(err);
    }
    if (!existing) return null;
    const doc = JSON.parse(existing.buffer.toString('utf8'));
    return { buffer: Buffer.from(doc.contentBase64, 'base64'), contentType: doc.contentType, size: doc.size };
  },

  async delete(ctx, key) {
    assertSafeStorageKey(key);
    const blobPath = storageBlobPath(ctx, key);
    let existing;
    try {
      existing = await store.getFileRaw(ctx.cfg, blobPath);
    } catch (err) {
      throw mapStoreError(err);
    }
    if (!existing) return false;
    try {
      await store.deleteFileRaw(ctx.cfg, blobPath, { sha: existing.sha, message: `gitlive-backend: storage.delete ${key}` });
    } catch (err) {
      throw mapStoreError(err);
    }
    await upsertJson(
      ctx,
      storageIndexPath(ctx),
      (current) => {
        // Object.prototype.hasOwnProperty, not the `in` operator — `key in
        // {}` is true for "__proto__" even when never explicitly set,
        // since it's an inherited accessor on every plain object. Moot
        // now that assertSafeStorageKey rejects that key outright, but
        // hasOwnProperty is the correct check here regardless.
        if (!current || !Object.prototype.hasOwnProperty.call(current, key)) return undefined; // already absent — no-op write
        const index = Object.assign(Object.create(null), current);
        delete index[key];
        return index;
      },
      { message: `gitlive-backend: unindex storage.delete ${key}` }
    );
    return true;
  },

  async list(ctx, prefix = '') {
    let existing;
    try {
      existing = await store.getFileRaw(ctx.cfg, storageIndexPath(ctx));
    } catch (err) {
      throw mapStoreError(err);
    }
    if (!existing) return [];
    const index = JSON.parse(existing.buffer.toString('utf8'));
    return Object.entries(index)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, meta]) => ({ key, size: meta.size, modifiedAt: meta.modifiedAt }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  },
};

async function getStats(ctx) {
  let userEntries;
  let indexEntry;
  try {
    [userEntries, indexEntry] = await Promise.all([
      store.listDirRaw(ctx.cfg, usersDir(ctx)),
      store.getFileRaw(ctx.cfg, storageIndexPath(ctx)),
    ]);
  } catch (err) {
    throw mapStoreError(err);
  }
  const index = indexEntry ? JSON.parse(indexEntry.buffer.toString('utf8')) : {};
  const files = Object.values(index);
  return {
    userCount: userEntries.length,
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
  };
}

// callOp — same single op-name -> function dispatch shape as index.js's
// OPS table, so gitlive-client's dispatch() can call either mode through
// one identical interface. db.* is rejected with a clear, specific error
// rather than silently missing or half-implemented as a slow scan over
// storage — an app hitting this should immediately know why, not debug a
// mysterious "unknown op" or a query that quietly does nothing.
const UNSUPPORTED_DB_MESSAGE =
  'db.* is not supported in github mode — this mode has no SQL engine, only auth/storage/stats (github-repo-as-storage is a third gitlive-backend-core mode, not a SQL backend). See DESIGN.md.';

const OPS = {
  'db.query': () => {
    throw new BackendError('INVALID_ARGS', UNSUPPORTED_DB_MESSAGE);
  },
  'db.exec': () => {
    throw new BackendError('INVALID_ARGS', UNSUPPORTED_DB_MESSAGE);
  },
  'db.migrate': () => {
    throw new BackendError('INVALID_ARGS', UNSUPPORTED_DB_MESSAGE);
  },

  'auth.createUser': (ctx, args) => auth.createUser(ctx, { email: args.email, password: args.password }),
  'auth.verifyPassword': (ctx, args) => auth.verifyPassword(ctx, { email: args.email, password: args.password }),
  'auth.createSession': (ctx, args) => auth.createSession(ctx, args.userId),
  'auth.verifySession': (ctx, args) => auth.verifySession(ctx, args.token),
  'auth.revokeSession': (ctx, args) => auth.revokeSession(ctx, args.token),

  'storage.put': (ctx, args, payload) => storage.put(ctx, args.key, payload, { contentType: args.contentType }),
  'storage.get': (ctx, args) => storage.get(ctx, args.key),
  'storage.delete': (ctx, args) => storage.delete(ctx, args.key),
  'storage.list': (ctx, args) => storage.list(ctx, args.prefix || ''),

  stats: (ctx) => getStats(ctx),
};

async function callOp(ctx, op, args = {}, payload = null) {
  const fn = OPS[op];
  if (!fn) {
    throw new BackendError('INVALID_ARGS', `unknown op "${op}"`);
  }
  return fn(ctx, args, payload);
}

module.exports = { openApp, close, auth, storage, getStats, callOp };
