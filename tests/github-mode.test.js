'use strict';
// Tests for the GitHub-repo-as-storage backend mode (github-store.js +
// github.js). No GitHub token exists in this sandbox, so this drives the
// real modules against a small fake implementation of the Contents API
// (paths, base64 content, sha-based optimistic concurrency, 404/409/422/403
// semantics) rather than a live repo — global.fetch is swapped out, nothing
// inside github-store.js or github.js is mocked or bypassed. This is the
// same "everything downstream of the network call is real" approach the
// project already uses for gitlive.js's own CLI in
// backend-integration.test.js (real subprocess) — here the only stand-in is
// the actual HTTP boundary, because a real repo/token isn't available here.
//
// A real 403 WAS observed live during development (see DESIGN.md's
// addendum): an unauthenticated call from this sandbox to
// api.github.com/repos/octocat/Hello-World hit GitHub's own unauthenticated
// rate limit (x-ratelimit-remaining: 0), not an auth or header problem —
// the RATE_LIMITED-vs-AUTH_ERROR test below reproduces exactly that
// response shape to prove github-store.js classifies it correctly.

const assert = require('node:assert/strict');
const store = require('../gitlive-backend-core/github-store');
const github = require('../gitlive-backend-core/github');

// ---------------------------------------------------------------------------
// Fake GitHub Contents API — enough of the real surface (get/put/delete a
// file, list a directory, sha concurrency, 404/409/422/403) to exercise
// every code path in github-store.js/github.js for real.
// ---------------------------------------------------------------------------
function makeFakeGithub({ rateLimited = false } = {}) {
  const files = new Map(); // repoPath -> { sha, contentBase64 }
  let shaCounter = 0;
  const nextSha = () => 'sha' + (shaCounter += 1);

  function isDir(repoPath) {
    const prefix = repoPath === '' ? '' : repoPath + '/';
    for (const key of files.keys()) {
      if (key.startsWith(prefix) && key !== repoPath) return true;
    }
    return false;
  }

  function listChildren(repoPath) {
    const prefix = repoPath === '' ? '' : repoPath + '/';
    const byName = new Map();
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const name = rest.split('/')[0];
      if (byName.has(name)) continue;
      const childPath = prefix + name;
      const isFile = childPath === key;
      const f = files.get(key);
      byName.set(name, {
        name,
        path: childPath,
        sha: isFile ? f.sha : 'tree-' + name,
        type: isFile ? 'file' : 'dir',
        size: isFile ? Buffer.from(f.contentBase64, 'base64').length : 0,
      });
    }
    return Array.from(byName.values());
  }

  const headers = {
    get(name) {
      const n = name.toLowerCase();
      if (n === 'x-ratelimit-remaining') return rateLimited ? '0' : '4999';
      if (n === 'x-ratelimit-reset') return String(Math.floor(Date.now() / 1000) + 3600);
      return null;
    },
  };

  async function fetch(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const m = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.*)$/);
    assert.ok(m, `fake github: unrecognized URL ${url}`);
    const repoPath = decodeURIComponent(m[1] || '');

    if (rateLimited) {
      return { status: 403, ok: false, headers, json: async () => ({ message: 'API rate limit exceeded' }) };
    }

    if (method === 'GET') {
      if (files.has(repoPath)) {
        const f = files.get(repoPath);
        return { status: 200, ok: true, headers, json: async () => ({ content: f.contentBase64, sha: f.sha }) };
      }
      if (isDir(repoPath)) {
        return { status: 200, ok: true, headers, json: async () => listChildren(repoPath) };
      }
      return { status: 404, ok: false, headers, json: async () => ({ message: 'Not Found' }) };
    }

    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      const existing = files.get(repoPath);
      if (existing && existing.sha !== body.sha) {
        return { status: 409, ok: false, headers, json: async () => ({ message: 'sha does not match' }) };
      }
      if (!existing && body.sha) {
        return { status: 422, ok: false, headers, json: async () => ({ message: "sha wasn't supplied" }) };
      }
      const sha = nextSha();
      files.set(repoPath, { sha, contentBase64: body.content });
      return { status: existing ? 200 : 201, ok: true, headers, json: async () => ({ content: { sha } }) };
    }

    if (method === 'DELETE') {
      const body = JSON.parse(opts.body);
      const existing = files.get(repoPath);
      if (!existing) return { status: 404, ok: false, headers, json: async () => ({ message: 'Not Found' }) };
      if (existing.sha !== body.sha) {
        return { status: 409, ok: false, headers, json: async () => ({ message: 'sha does not match' }) };
      }
      files.delete(repoPath);
      return { status: 200, ok: true, headers, json: async () => ({}) };
    }

    throw new Error('fake github: unsupported method ' + method);
  }

  return { fetch, files };
}

const originalFetch = global.fetch;
function withFakeGithub(opts, run) {
  const fake = makeFakeGithub(opts);
  global.fetch = fake.fetch;
  return run(fake).finally(() => {
    global.fetch = originalFetch;
  });
}

const CFG = { owner: 'bline', repo: 'gitlive-hello', token: 'fake-token', branch: 'main' };

(async () => {
  // -------------------------------------------------------------------
  // github-store.js — low-level Contents API primitives
  // -------------------------------------------------------------------
  await withFakeGithub({}, async () => {
    const missing = await store.getFileRaw(CFG, '_gitlive/nope.json');
    assert.equal(missing, null, 'getFileRaw returns null for a path that does not exist (not a throw)');
    console.log('OK: getFileRaw returns null on 404, matches storage.get\'s missing-key contract');

    const created = await store.putFileRaw(CFG, '_gitlive/thing.json', Buffer.from('{"a":1}'));
    assert.ok(created.sha, 'putFileRaw returns a sha on create');
    const read = await store.getFileRaw(CFG, '_gitlive/thing.json');
    assert.equal(read.buffer.toString('utf8'), '{"a":1}', 'round-tripped content matches exactly');
    console.log('OK: putFileRaw (create) + getFileRaw round-trip real bytes through base64');

    const updated = await store.putFileRaw(CFG, '_gitlive/thing.json', Buffer.from('{"a":2}'), { sha: read.sha });
    assert.notEqual(updated.sha, read.sha, 'a real update produces a new sha');
    console.log('OK: putFileRaw (update) with the correct sha succeeds and advances the sha');

    let conflictErr = null;
    try {
      await store.putFileRaw(CFG, '_gitlive/thing.json', Buffer.from('{"a":3}'), { sha: read.sha }); // stale sha now
    } catch (err) {
      conflictErr = err;
    }
    assert.ok(conflictErr && conflictErr.code === 'CONFLICT', 'a stale sha on update is a CONFLICT, not a silent overwrite');
    console.log('OK: stale-sha update is rejected as CONFLICT — this is the real optimistic-concurrency guard');

    let deleteConflict = null;
    try {
      await store.deleteFileRaw(CFG, '_gitlive/thing.json', { sha: read.sha }); // stale sha
    } catch (err) {
      deleteConflict = err;
    }
    assert.ok(deleteConflict && deleteConflict.code === 'CONFLICT', 'delete with a stale sha is also a CONFLICT');
    await store.deleteFileRaw(CFG, '_gitlive/thing.json', { sha: updated.sha });
    assert.equal(await store.getFileRaw(CFG, '_gitlive/thing.json'), null, 'file is actually gone after delete');
    console.log('OK: deleteFileRaw enforces sha concurrency and actually removes the file');

    await store.deleteFileRaw(CFG, '_gitlive/thing.json', { sha: 'anything' }); // already gone
    console.log('OK: deleting an already-absent path is idempotent (no throw)');

    await store.putFileRaw(CFG, '_gitlive/users/aaa.json', Buffer.from('{}'));
    await store.putFileRaw(CFG, '_gitlive/users/bbb.json', Buffer.from('{}'));
    const listing = await store.listDirRaw(CFG, '_gitlive/users');
    assert.equal(listing.length, 2, 'listDirRaw sees both files in the directory');
    assert.deepEqual(listing.map((e) => e.name).sort(), ['aaa.json', 'bbb.json']);
    console.log('OK: listDirRaw lists a real directory level');

    assert.deepEqual(await store.listDirRaw(CFG, '_gitlive/nonexistent-dir'), [], 'listDirRaw returns [] for a missing dir, not a throw');
    console.log('OK: listDirRaw on a missing directory returns [] (not an error)');

    let invalidArgs = null;
    try {
      await store.putFileRaw(CFG, '_gitlive/big.json', Buffer.alloc(store.MAX_FILE_BYTES + 1));
    } catch (err) {
      invalidArgs = err;
    }
    assert.ok(invalidArgs && invalidArgs.code === 'INVALID_ARGS', 'a file over MAX_FILE_BYTES is rejected before any request is even worth making');
    console.log('OK: putFileRaw enforces MAX_FILE_BYTES client-side');
  });

  // The real 403 hit while building this (see DESIGN.md) — confirm it's
  // classified as RATE_LIMITED, not AUTH_ERROR, exactly the distinction
  // that mattered when diagnosing the live failure.
  await withFakeGithub({ rateLimited: true }, async () => {
    let err = null;
    try {
      await store.getFileRaw(CFG, '_gitlive/anything.json');
    } catch (e) {
      err = e;
    }
    assert.ok(err && err.code === 'RATE_LIMITED', 'a 403 with x-ratelimit-remaining: 0 is classified RATE_LIMITED');
    console.log('OK: rate-limited 403 (the actual response observed live) is distinguished from an auth failure');
  });

  // -------------------------------------------------------------------
  // github.js — auth/storage/stats semantics on top of the store
  // -------------------------------------------------------------------
  await withFakeGithub({}, async () => {
    const ctx = github.openApp({ ...CFG, dataPrefix: '_gitlive' });

    const created = await github.auth.createUser(ctx, { email: 'Bline@Example.com', password: 'hunter2' });
    assert.equal(created.email, 'bline@example.com', 'email is normalized to lowercase, matching the SQLite mode');
    assert.equal(created.id, created.email, 'id === email is the deliberate cross-mode createSession(user.id) trick');
    console.log('OK: auth.createUser normalizes email and returns an id createSession can use directly');

    let conflict = null;
    try {
      await github.auth.createUser(ctx, { email: 'bline@example.com', password: 'anything' });
    } catch (err) {
      conflict = err;
    }
    assert.ok(conflict && conflict.code === 'CONFLICT', 'signing up the same email twice is a CONFLICT');
    console.log('OK: duplicate signup is rejected as CONFLICT (real GitHub sha-concurrency guard underneath)');

    const badLogin = await github.auth.verifyPassword(ctx, { email: 'bline@example.com', password: 'wrong' });
    assert.equal(badLogin, null, 'wrong password returns null, not a throw');
    const goodLogin = await github.auth.verifyPassword(ctx, { email: 'bline@example.com', password: 'hunter2' });
    assert.ok(goodLogin && goodLogin.id === 'bline@example.com', 'correct password returns the user');
    console.log('OK: verifyPassword round-trips a real scrypt hash (shared with the SQLite mode via index.js)');

    const session = await github.auth.createSession(ctx, goodLogin.id);
    assert.ok(session.token && session.expiresAt, 'createSession returns a real token');
    const verified = await github.auth.verifySession(ctx, session.token);
    assert.equal(verified.email, 'bline@example.com', 'verifySession resolves the token back to the user');
    console.log('OK: session create/verify round-trip works');

    assert.equal(await github.auth.verifySession(ctx, 'not-a-real-token'), null, 'a bogus token verifies to null');
    await github.auth.revokeSession(ctx, session.token);
    assert.equal(await github.auth.verifySession(ctx, session.token), null, 'revoked session no longer verifies');
    console.log('OK: bogus and revoked sessions both correctly fail verification');

    const put1 = await github.storage.put(ctx, 'notes/hello.txt', Buffer.from('hello gitlive'), { contentType: 'text/plain' });
    assert.equal(put1.size, Buffer.byteLength('hello gitlive'));
    const got = await github.storage.get(ctx, 'notes/hello.txt');
    assert.equal(got.buffer.toString('utf8'), 'hello gitlive', 'stored bytes round-trip exactly');
    assert.equal(got.contentType, 'text/plain');
    console.log('OK: storage.put/get round-trips real bytes and content-type through the JSON envelope');

    await github.storage.put(ctx, 'notes/second.txt', Buffer.from('second file'));
    const listed = await github.storage.list(ctx, 'notes/');
    assert.equal(listed.length, 2, 'storage.list finds both files via the index, despite hashed blob paths');
    assert.deepEqual(listed.map((f) => f.key).sort(), ['notes/hello.txt', 'notes/second.txt']);
    console.log('OK: storage.list works via the explicit index file (GitHub dir listing alone could not do this — blob paths are hashed)');

    const deleted = await github.storage.delete(ctx, 'notes/hello.txt');
    assert.equal(deleted, true);
    assert.equal(await github.storage.get(ctx, 'notes/hello.txt'), null, 'deleted file is actually gone');
    assert.equal((await github.storage.list(ctx, 'notes/')).length, 1, 'index correctly drops the deleted key too, not just the blob');
    assert.equal(await github.storage.delete(ctx, 'notes/hello.txt'), false, 'deleting an already-gone key returns false, not a throw');
    console.log('OK: storage.delete removes both the blob and its index entry, and is idempotent');

    const stats = await github.getStats(ctx);
    assert.equal(stats.userCount, 1, 'stats sees the one real user created above');
    assert.equal(stats.fileCount, 1, 'stats sees the one file remaining after the delete above');
    assert.equal(stats.totalBytes, Buffer.byteLength('second file'));
    console.log('OK: stats() reflects real state (userCount via dir listing, fileCount/totalBytes via the storage index)');

    for (const op of ['db.query', 'db.exec', 'db.migrate']) {
      let dbErr = null;
      try {
        await github.callOp(ctx, op, {});
      } catch (err) {
        dbErr = err;
      }
      assert.ok(dbErr && dbErr.code === 'INVALID_ARGS' && /not supported in github mode/.test(dbErr.message), `${op} must reject with a clear, specific error`);
    }
    console.log('OK: db.* ops are rejected with a clear "not supported in github mode" error, not silently missing');
  });

  // -------------------------------------------------------------------
  // gitlive-client wiring — same public API surface, github transport
  // -------------------------------------------------------------------
  await withFakeGithub({}, async () => {
    delete require.cache[require.resolve('../gitlive-client')];
    const gitliveClient = require('../gitlive-client');
    const client = gitliveClient({ github: { ...CFG, dataPrefix: '_gitlive' } });
    assert.equal(client.mode(), 'github', 'client reports github mode, no probing/auto-detection involved');

    await client.auth.createUser({ email: 'via-client@example.com', password: 'p@ss' });
    const user = await client.auth.verifyPassword({ email: 'via-client@example.com', password: 'p@ss' });
    const session = await client.auth.createSession(user.id);
    const verified = await client.auth.verifySession(session.token);
    assert.equal(verified.email, 'via-client@example.com');
    console.log('OK: gitlive-client\'s public auth API works unchanged against github mode');

    await client.storage.put('avatars/via-client.png', Buffer.from('pretend-png-bytes'));
    const file = await client.storage.get('avatars/via-client.png');
    assert.equal(file.buffer.toString('utf8'), 'pretend-png-bytes');
    console.log('OK: gitlive-client\'s public storage API works unchanged against github mode');

    let dbErr = null;
    try {
      await client.db.query('SELECT 1');
    } catch (err) {
      dbErr = err;
    }
    assert.ok(dbErr && /not supported in github mode/.test(dbErr.message), 'db.query through the client still surfaces github mode\'s real rejection, unmodified');
    console.log('OK: db.query through gitlive-client surfaces github mode\'s rejection unchanged (no swallowing/rewriting at the client layer)');
  });

  console.log('\nALL GITHUB-MODE TESTS PASSED');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
