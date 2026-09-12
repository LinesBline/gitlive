// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive-backend-core/github-store.js
//
// Low-level primitives for the GitHub-repo-as-storage backend mode (see
// github.js and DESIGN.md's addendum for the "why"). Every write here is a
// real commit to a real GitHub repo via the REST Contents API; every read
// is a real GET against it. No npm dependency — Node 18+'s built-in global
// `fetch`, base64 in/out by hand, matching this project's zero-runtime-
// dependency habit (see index.js's node:sqlite / node:crypto choice).
//
// This module is the wire format only (HTTP + base64 + sha-based optimistic
// concurrency) — it knows nothing about users, sessions, or storage keys.
// github.js builds that semantics on top, the same split as this file's own
// `db` (raw SQL) vs `auth`/`storage` (semantics) for the SQLite mode.
//
// Docs: https://docs.github.com/en/rest/repos/contents

const DEFAULT_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

// GitHub's Contents API is documented as topping out around 1MB for a
// single file read/write in one request (larger requires the separate Git
// Data / blobs API, which this mode deliberately doesn't reach for — see
// DESIGN.md). This is an approximate, conservative ceiling on the RAW file
// bytes; github.js's JSON envelope around a blob adds its own overhead on
// top and enforces the real limit at write time via putFileRaw below.
const MAX_FILE_BYTES = 1 * 1024 * 1024;

class GithubStoreError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message);
    this.name = 'GithubStoreError';
    // 'NOT_FOUND' is intentionally NOT one of these codes — a missing file
    // is a normal, expected outcome for get/list (see getFileRaw/listDirRaw
    // below returning null/[] instead of throwing), not an error condition.
    this.code = code; // 'CONFLICT' | 'AUTH_ERROR' | 'RATE_LIMITED' | 'INVALID_ARGS' | 'NETWORK_ERROR' | 'INTERNAL'
    this.status = status;
    this.cause = cause;
  }
}

function assertConfig(cfg) {
  if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) {
    throw new GithubStoreError('INVALID_ARGS', 'github mode requires { owner, repo, token }');
  }
}

// Each path segment is percent-encoded on its own so a key containing a
// literal "#", "?", or space survives the request; "/" itself stays
// unescaped since it's the segment separator — gitlive's own storage-key
// namespacing convention (e.g. "avatars/123.png") is meant to form real
// subdirectories in the repo tree, same as the SQLite mode's storage dir.
function encodePath(repoPath) {
  return repoPath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

function contentsUrl(cfg, repoPath) {
  const base = cfg.apiBase || DEFAULT_API_BASE;
  return `${base}/repos/${cfg.owner}/${cfg.repo}/contents/${encodePath(repoPath)}`;
}

async function githubFetch(cfg, url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        // A generic/missing User-Agent is not what caused the 403 seen
        // while building this (that was plain unauthenticated rate
        // limiting, confirmed via the response's own x-ratelimit-remaining
        // header) — but GitHub does reject requests with no User-Agent at
        // all, so this stays set regardless.
        'User-Agent': 'gitlive-backend-core',
        Authorization: `Bearer ${cfg.token}`,
        ...(opts.headers || {}),
      },
    });
  } catch (err) {
    throw new GithubStoreError('NETWORK_ERROR', `github request failed: ${err.message}`, { cause: err });
  }
  return res;
}

async function parseErrorMessage(res) {
  try {
    const body = await res.json();
    return (body && body.message) || res.statusText;
  } catch {
    return res.statusText;
  }
}

async function throwForStatus(res) {
  // A rate-limited response and a genuine auth failure are both 403s from
  // GitHub — the only way to tell them apart is the rate-limit headers
  // GitHub always includes. Confirmed for real while building this: an
  // unauthenticated test call against api.github.com came back 403 with
  // x-ratelimit-remaining: 0, not an auth problem at all.
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = res.headers.get('x-ratelimit-reset');
    const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : 'unknown';
    throw new GithubStoreError('RATE_LIMITED', `github API rate limit exceeded (resets ${resetAt})`, { status: 403 });
  }
  if (res.status === 401 || res.status === 403) {
    throw new GithubStoreError('AUTH_ERROR', `github API auth error: ${await parseErrorMessage(res)}`, { status: res.status });
  }
  if (res.status === 409) {
    throw new GithubStoreError('CONFLICT', `github API conflict (sha mismatch): ${await parseErrorMessage(res)}`, { status: 409 });
  }
  if (res.status === 422) {
    // The Contents API uses 422 for a few distinct problems (a stale/
    // missing sha against an existing path, a malformed request); the
    // stale-sha case is by far the one this codebase actually needs to
    // react to (optimistic-concurrency retry), so it's mapped the same as
    // 409 rather than added as a fourth code callers would have to branch on.
    throw new GithubStoreError('CONFLICT', `github API rejected the request (likely a stale or missing sha): ${await parseErrorMessage(res)}`, { status: 422 });
  }
  throw new GithubStoreError('INTERNAL', `github API error ${res.status}: ${await parseErrorMessage(res)}`, { status: res.status });
}

// getFileRaw -> { buffer, sha } for the file at repoPath, or null if it
// doesn't exist. Null-not-throw on 404 matches the SQLite mode's storage.get
// returning null for a missing key (see index.js) — a missing file is a
// normal outcome here, not an error.
async function getFileRaw(cfg, repoPath) {
  assertConfig(cfg);
  const url = `${contentsUrl(cfg, repoPath)}?ref=${encodeURIComponent(cfg.branch || 'main')}`;
  const res = await githubFetch(cfg, url);
  if (res.status === 404) return null;
  if (!res.ok) await throwForStatus(res);
  const body = await res.json();
  if (Array.isArray(body)) {
    // The Contents API returns an array, not an object, when the path is a
    // directory — a caller asking getFileRaw for a directory is a bug in
    // the caller, not a normal "not found."
    throw new GithubStoreError('INVALID_ARGS', `"${repoPath}" is a directory, not a file`);
  }
  return { buffer: Buffer.from(body.content, 'base64'), sha: body.sha };
}

// putFileRaw -> { sha } of the resulting commit's blob. Pass `sha` (from a
// prior getFileRaw) to update an existing file; omit it to create a new
// one. This function does not pre-check whether the path already exists —
// GitHub itself is the concurrency check: an update with a stale/omitted
// sha against an existing path comes back 409/422, mapped to CONFLICT by
// throwForStatus above, which is the real guard (same reasoning as the
// SQLite mode's UNIQUE-constraint-as-real-guard in auth.createUser).
async function putFileRaw(cfg, repoPath, buffer, { sha, message } = {}) {
  assertConfig(cfg);
  if (!Buffer.isBuffer(buffer)) {
    throw new GithubStoreError('INVALID_ARGS', 'putFileRaw requires a Buffer');
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new GithubStoreError(
      'INVALID_ARGS',
      `file is ${buffer.length} bytes, over this mode's ${MAX_FILE_BYTES}-byte limit (GitHub's Contents API isn't built for large blobs)`
    );
  }
  const res = await githubFetch(cfg, contentsUrl(cfg, repoPath), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || `gitlive-backend: write ${repoPath}`,
      content: buffer.toString('base64'),
      branch: cfg.branch || 'main',
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) await throwForStatus(res);
  const body = await res.json();
  return { sha: body.content.sha };
}

// deleteFileRaw -> void. GitHub's delete endpoint always requires the
// file's current sha, same optimistic-concurrency rule as an update.
// Deleting an already-gone path is treated as success (idempotent), not an
// error — a caller that already has "does it exist" info from getFileRaw
// shouldn't need a second check just to make delete safe to call twice.
async function deleteFileRaw(cfg, repoPath, { sha, message } = {}) {
  assertConfig(cfg);
  if (!sha) {
    throw new GithubStoreError('INVALID_ARGS', "deleteFileRaw requires the file's current sha");
  }
  const res = await githubFetch(cfg, contentsUrl(cfg, repoPath), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || `gitlive-backend: delete ${repoPath}`,
      sha,
      branch: cfg.branch || 'main',
    }),
  });
  if (res.status === 404) return;
  if (!res.ok) await throwForStatus(res);
}

// listDirRaw -> [{ name, path, sha, type, size }] for one directory level,
// or [] if the directory doesn't exist (also a normal outcome, not an
// error — mirrors getFileRaw's 404 handling). The Contents API is NOT
// recursive: this only ever sees one level. github.js works around that
// for storage.list with an explicit index file rather than a directory
// walk — see its storageIndexPath.
async function listDirRaw(cfg, repoPath) {
  assertConfig(cfg);
  const url = `${contentsUrl(cfg, repoPath)}?ref=${encodeURIComponent(cfg.branch || 'main')}`;
  const res = await githubFetch(cfg, url);
  if (res.status === 404) return [];
  if (!res.ok) await throwForStatus(res);
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new GithubStoreError('INVALID_ARGS', `"${repoPath}" is a file, not a directory`);
  }
  return body.map((e) => ({ name: e.name, path: e.path, sha: e.sha, type: e.type, size: e.size }));
}

module.exports = { getFileRaw, putFileRaw, deleteFileRaw, listDirRaw, GithubStoreError, MAX_FILE_BYTES };
