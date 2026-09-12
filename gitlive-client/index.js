// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive-client — what an app fused with gitlive imports.
//
//   const gitlive = require('gitlive-client')({ app: 'my-app' })
//   const todos = await gitlive.db.query('SELECT * FROM todos WHERE done = ?', [0])
//
// Same API regardless of whether a gitlive-backend daemon is running for this
// app. On the first call (and re-checked at most every 5s) it probes for
// <dataDir>/backend.sock; found -> talks to the daemon over RPC; not found ->
// opens the app's own SQLite file directly, in-process. If the daemon dies
// mid-run, the next call detects the broken connection and falls back to
// standalone automatically — there's no separate failure mode to handle,
// "socket absent" is already the default path. See ADR-001 / gitlive-backend-spec.md.

const os = require('node:os');
const path = require('node:path');
// Relative, not a bare specifier — gitlive-backend-core is Node built-ins
// only (node:sqlite, node:crypto), so requiring it by relative path (it must
// sit as a sibling folder next to gitlive-client) means no npm install step
// is needed at all, keeping this consistent with gitlive's own "zero runtime
// dependencies" habit rather than needing a node_modules symlink for what's
// really just two plain JS files.
const core = require('../gitlive-backend-core');
const coreGithub = require('../gitlive-backend-core/github');
const { rpcCall, probeSocket } = require('../gitlive-backend-core/rpc');

const MODE_RECHECK_MS = 5000;

// Codes that mean "the daemon isn't reachable right now" — safe to silently
// retry against standalone. Anything else (CONFLICT, NOT_FOUND, INVALID_ARGS,
// an INTERNAL error the daemon raised on purpose) is a real application-level
// result and must be surfaced, never masked by a silent retry elsewhere.
const CONNECTION_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ENOENT', 'EPIPE', 'ECONNRESET']);

// A connection error on a READ (db.query, verifySession, storage.get/list,
// stats) is safe to silently retry against standalone — re-running a read
// has no side effect. A connection error on a WRITE is NOT safe to silently
// retry: the daemon may have already applied it and the error happened only
// while the response was on its way back (a real, confirmed scenario — see
// DESIGN.md's v2.4.0 addendum: under concurrent load, scrypt hashing queues
// up the single-threaded daemon, some calls exceed the client's RPC timeout,
// and the daemon finishes and commits the write anyway). Silently retrying a
// write in that state re-executes it — for auth.createUser this surfaced as
// a spurious UNIQUE-constraint crash; for a less-guarded write it would have
// been silent duplicate data with no error at all. So writes on a connection
// error still downgrade `mode` for future calls (the socket really is
// unreachable right now) but are NOT retried automatically — the error is
// surfaced so the caller can decide, the same way a network request failing
// partway through a POST anywhere else would be.
const IDEMPOTENT_OPS = new Set(['db.query', 'auth.verifyPassword', 'auth.verifySession', 'storage.get', 'storage.list', 'stats']);

function gitliveClient({ app, dataDir, github } = {}) {
  // GitHub-repo-as-storage mode (v2.5.0): an explicit { github: { owner,
  // repo, token } } option routes the whole public surface (auth/storage/
  // stats) through github.js straight to a GitHub repo — no socket probing,
  // no dataDir, no per-app SQLite file. db.* ops are rejected by the backend
  // core with its specific "not supported in github mode" error, surfaced
  // unchanged, exactly like a daemon-mode real result would be.
  const githubCtx = github ? coreGithub.openApp(github) : null;

  if (!github) {
    if (!dataDir) {
      if (!app) {
        throw new Error('gitlive-client requires either { app } or { dataDir }');
      }
      dataDir = process.env.GITLIVE_DATA_DIR || path.join(os.homedir(), '.gitlive', 'data', app);
    }
  }
  const socketPath = githubCtx ? null : path.join(dataDir, 'backend.sock');

  let mode = githubCtx ? 'github' : null; // 'github' | 'standalone' | 'daemon' — the last two stay null until the first call resolves them
  let lastCheck = 0;
  let standaloneCtx = null; // opened lazily, memoized for this client's lifetime

  function getStandaloneCtx() {
    if (!standaloneCtx) standaloneCtx = core.openApp(dataDir);
    return standaloneCtx;
  }

  async function ensureMode() {
    const now = Date.now();
    if (mode === 'daemon') return mode; // stays optimistic; a failed call downgrades it immediately
    if (mode === 'standalone' && now - lastCheck < MODE_RECHECK_MS) return mode;
    mode = (await probeSocket(socketPath)) ? 'daemon' : 'standalone';
    lastCheck = now;
    return mode;
  }

  async function dispatch(op, args, payload = null) {
    if (githubCtx) return coreGithub.callOp(githubCtx, op, args, payload);
    const current = await ensureMode();
    if (current === 'daemon') {
      try {
        return await rpcCall(socketPath, op, args, payload);
      } catch (err) {
        if (CONNECTION_ERROR_CODES.has(err.code)) {
          mode = 'standalone';
          lastCheck = Date.now();
          if (IDEMPOTENT_OPS.has(op)) {
            return core.callOp(getStandaloneCtx(), op, args, payload);
          }
          // Do not retry a write whose outcome we don't actually know —
          // surface it. Future calls (including a real retry the caller
          // chooses to make) go through standalone, since `mode` above is
          // already downgraded.
          throw Object.assign(
            new Error(`gitlive-backend daemon connection lost during "${op}" — the write may or may not have completed; not retried automatically. ${err.message}`),
            { code: 'CONNECTION_LOST_DURING_WRITE', cause: err }
          );
        }
        throw err; // a real result from the daemon (e.g. CONFLICT) — surface it as-is
      }
    }
    return core.callOp(getStandaloneCtx(), op, args, payload);
  }

  return {
    // Mostly for tests/debugging — "am I talking to a daemon right now."
    mode: () => mode,

    // Releases the standalone SQLite handle, if one was opened. No-op in
    // daemon mode (RPC connections are already per-call, nothing held open).
    // Call this on an app's graceful shutdown so a `gitlive backend start`
    // run afterward isn't opening the same file against a connection this
    // process forgot to close.
    close: () => {
      if (standaloneCtx) {
        core.close(standaloneCtx);
        standaloneCtx = null;
      }
    },

    db: {
      query: (sql, params = []) => dispatch('db.query', { sql, params }),
      exec: (sql, params = []) => dispatch('db.exec', { sql, params }),
      migrate: (migrationsDir) => dispatch('db.migrate', { migrationsDir }),
    },
    auth: {
      createUser: ({ email, password }) => dispatch('auth.createUser', { email, password }),
      verifyPassword: ({ email, password }) => dispatch('auth.verifyPassword', { email, password }),
      createSession: (userId) => dispatch('auth.createSession', { userId }),
      verifySession: (token) => dispatch('auth.verifySession', { token }),
      revokeSession: (token) => dispatch('auth.revokeSession', { token }),
    },
    storage: {
      put: (key, buffer, opts = {}) =>
        dispatch('storage.put', { key, contentType: opts.contentType }, buffer),
      get: (key) => dispatch('storage.get', { key }),
      delete: (key) => dispatch('storage.delete', { key }),
      list: (prefix = '') => dispatch('storage.list', { prefix }),
    },

    // { userCount, fileCount, totalBytes } — a read-only summary, not a
    // window into gitlive's internal tables (see gitlive-backend-core's
    // getStats for why this is a supported call and raw queries against
    // _gitlive_* tables aren't).
    stats: () => dispatch('stats', {}),
  };
}

module.exports = gitliveClient;
