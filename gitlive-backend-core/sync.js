// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive two-node sync transport — Phase 2 D1 (hybrid git + snapshot).
//
// Node A (the app's current primary) ships its state to a git bare repo the
// members control; node B pulls from that repo and restores. Two kinds of
// state, two paths, one bus:
//
//   - SQLite app.db   → consistent snapshots via VACUUM INTO (SQLite's own
//     atomic copy primitive), named app.db.snap-<iso>.db, newest kept in the
//     staging mirror, older ones pruned on the next push.
//   - storage blobs   → already content-addressed files; copied verbatim
//     into the same staging mirror and committed with the snapshot.
//
// The bus is a plain git bare repo (no new dependencies, same habit as the
// rest of the repo): push = add -A + commit into the bare; restore = check
// out main into staging, take the newest snapshot + the storage tree.
//
// Write model (D1): one primary per app writes; a restore is whole-state
// last-writer-wins at the directory level (mirror). Split-brain LWW + the
// conflict log (D2) layer on top of this transport in the replication
// scheduler, not here.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const SNAPSHOT_GLOB = /^app\.db\.snap-.*\.db(\.glc)?$/;
const GLC_MODE_MARKER = '.glc-mode';

function walkFiles(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walkFiles(path.join(dir, e.name), rel));
    else out.push({ rel, abs: path.join(dir, e.name) });
  }
  return out;
}
const SYNC_AUTHOR = 'gitlive-sync <sync@gitlive.local>';
const MAX_KEPT_SNAPSHOTS = 3;

function shGit(args, { cwd, allowFail = false } = {}) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    if (allowFail) return { ok: false, out: String(err.stdout || '') + String(err.stderr || '') };
    throw new Error(`git ${args[0]} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

function ensureBare(barePath) {
  if (!fs.existsSync(path.join(barePath, 'HEAD'))) {
    fs.mkdirSync(barePath, { recursive: true });
    shGit(['init', '--bare', '-q', '-b', 'main', barePath]);
  }
}

function newestSnapshot(stagingDir) {
  if (!fs.existsSync(stagingDir)) return null;
  const snaps = fs.readdirSync(stagingDir).filter((f) => SNAPSHOT_GLOB.test(f)).sort();
  return snaps.length ? path.join(stagingDir, snaps[snaps.length - 1]) : null;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function mirrorInto(srcDir, dstDir) {
  // Replace dst contents with src contents (delete dst extras) — whole-state
  // LWW at directory level (D1): the pushed state wins, nothing lingers.
  if (fs.existsSync(dstDir)) {
    for (const entry of fs.readdirSync(dstDir)) {
      fs.rmSync(path.join(dstDir, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(dstDir, { recursive: true });
  }
  copyDir(srcDir, dstDir);
}

// A synced-at marker per data dir (content: last snapshot/restore identity).
const MARKER_NAME = '.gitlive-synced-at';

function markerPath(dataDir) { return path.join(dataDir, MARKER_NAME); }

function writeMarker(dataDir, commit) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(markerPath(dataDir), `${new Date().toISOString()} ${commit || ''}\n`);
}

function readMarker(dataDir) {
  try {
    const t = fs.readFileSync(markerPath(dataDir), 'utf8').trim();
    return { at: new Date(t.split(' ')[0]).getTime() || 0, raw: t };
  } catch { return null; }
}

// The D2 conflict ledger lives next to the state bus (bus dir owner keeps the
// single copy in v1; cross-node aggregation is a Phase 3 directory concern).
function conflictsLedgerPath(barePath) {
  return path.join(path.dirname(barePath), path.basename(barePath, '.git') + '.conflicts.jsonl');
}

function appendConflict(barePath, entry) {
  try {
    fs.mkdirSync(path.dirname(conflictsLedgerPath(barePath)), { recursive: true });
    fs.appendFileSync(conflictsLedgerPath(barePath), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* ledger write must never break a restore */ }
}

function takeSnapshot(sourceDbPath, destPath) {
  // VACUUM INTO produces a consistent copy even while other connections
  // hold the source in WAL mode. SQLite requires a literal path here, so
  // quote-escape and inline it.
  const { DatabaseSync } = require('node:sqlite');
  const escaped = destPath.replace(/'/g, "''");
  const db = new DatabaseSync(sourceDbPath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
  if (!fs.existsSync(destPath)) throw new Error(`snapshot did not materialize at ${destPath}`);
}

// ---------------------------------------------------------------------------
// Primary side — push current state into the members' git bus
// ---------------------------------------------------------------------------
function pushSnapshot({ dataDir, stagingDir, barePath, encryptKey }) {
  ensureBare(barePath);
  fs.mkdirSync(stagingDir, { recursive: true });

  // 1. Prune old snapshots in staging (keep newest MAX_KEPT_SNAPSHOTS), so
  //    history stays bounded — the snapshot files are the bulk of each commit.
  const existing = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir).filter((f) => SNAPSHOT_GLOB.test(f)).sort() : [];
  const drop = existing.slice(0, Math.max(0, existing.length - (MAX_KEPT_SNAPSHOTS - 1)));
  for (const f of drop) fs.rmSync(path.join(stagingDir, f), { force: true });

  // 2. Fresh consistent snapshot of the live sqlite file.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapName = `app.db.snap-${ts}.db`;
  takeSnapshot(path.join(dataDir, 'app.db'), path.join(stagingDir, snapName));

  // 3. Mirror the storage tree (content-addressed blobs — verbatim copy).
  const storageSrc = path.join(dataDir, 'storage');
  if (fs.existsSync(storageSrc)) {
    mirrorInto(storageSrc, path.join(stagingDir, 'storage'));
  } else {
    fs.mkdirSync(path.join(stagingDir, 'storage'), { recursive: true });
  }

  // 3b. Owner-key policy (D3): encrypt snapshot + every storage file with
  //     AES-256-GCM before the commit, so the bus (and any replica that
  //     lacks the key) holds ciphertext only. Marker file records the mode.
  if (encryptKey) {
    if (encryptKey.length !== 32) throw new Error('encryptKey must be 32 bytes');
    const crypt = require('../crypt.js');
    const snapAbs = path.join(stagingDir, snapName);
    const encSnap = snapAbs + '.glc';
    fs.writeFileSync(encSnap, crypt.encryptBytes(encryptKey, fs.readFileSync(snapAbs)));
    fs.rmSync(snapAbs, { force: true });
    for (const f of walkFiles(path.join(stagingDir, 'storage'))) {
      const dst = f.abs + '.glc';
      fs.writeFileSync(dst, crypt.encryptBytes(encryptKey, fs.readFileSync(f.abs)));
      fs.rmSync(f.abs, { force: true });
    }
    fs.writeFileSync(path.join(stagingDir, GLC_MODE_MARKER), 'aes-256-gcm\n');
  }

  // 4. Commit into the bare bus (staging is the worktree).
  shGit(['--git-dir=' + barePath, '--work-tree=' + stagingDir, 'add', '-A']);
  shGit(['--git-dir=' + barePath, '--work-tree=' + stagingDir, '-c', 'user.name=gitlive-sync', '-c', 'user.email=sync@gitlive.local', 'commit', '-q', '-m', `state snapshot ${ts}`]);
  const head = shGit(['--git-dir=' + barePath, 'rev-parse', 'HEAD']).out.trim();
  writeMarker(dataDir, head);
  return { ok: true, commit: head, snapshot: snapName, pushedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Replica side — restore the newest pushed state into a data dir
// ---------------------------------------------------------------------------
function restoreLatest({ dataDir, barePath, stagingDir, decryptKey }) {
  if (!fs.existsSync(path.join(barePath, 'HEAD'))) {
    return { ok: false, reason: 'no sync repo yet at ' + barePath };
  }
  const log = shGit(['--git-dir=' + barePath, 'log', '-1', '--format=%H %s'], { allowFail: true });
  if (!log.ok) return { ok: false, reason: 'sync repo has no snapshots yet' };

  // The worktree must exist before git will touch it.
  fs.mkdirSync(stagingDir, { recursive: true });
  // Check out the latest committed staging state.
  shGit(['--git-dir=' + barePath, '--work-tree=' + stagingDir, 'checkout', '-f', 'main', '--', '.']);
  // checkout -f of the whole tree leaves removed files behind; hard reset is
  // the reliable mirror. Ensure an index exists for the bare repo first.
  shGit(['--git-dir=' + barePath, '--work-tree=' + stagingDir, 'add', '-A'], { allowFail: true });
  shGit(['--git-dir=' + barePath, '--work-tree=' + stagingDir, 'reset', '-q', '--hard', 'main']);

  const snap = newestSnapshot(stagingDir);
  if (!snap) return { ok: false, reason: 'latest sync commit contains no sqlite snapshot' };
  const encrypted = snap.endsWith('.glc') || fs.existsSync(path.join(stagingDir, GLC_MODE_MARKER));

  fs.mkdirSync(dataDir, { recursive: true });
  // D3: owner-key encrypted state needs the key even to restore. Without it
  // the replica holds ciphertext only (that is the policy's promise).
  if (encrypted) {
    if (!decryptKey || decryptKey.length !== 32) {
      return { ok: false, reason: 'state is owner-key encrypted — provide the 32-byte storage key (gitlive crypt keygen on the owner side)' };
    }
    const crypt = require('../crypt.js');
    const plain = snap.slice(0, -4);
    fs.writeFileSync(plain, crypt.decryptBytes(decryptKey, fs.readFileSync(snap)));
    const storageEnc = path.join(stagingDir, 'storage');
    const storagePlain = path.join(stagingDir, 'storage-plain');
    fs.rmSync(storagePlain, { recursive: true, force: true });
    for (const f of walkFiles(storageEnc)) {
      if (!f.rel.endsWith('.glc')) continue;
      const rel = f.rel.slice(0, -4);
      const dst = path.join(storagePlain, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, crypt.decryptBytes(decryptKey, fs.readFileSync(f.abs)));
    }
    fs.copyFileSync(plain, path.join(dataDir, 'app.db'));
    if (fs.existsSync(storagePlain)) mirrorInto(storagePlain, path.join(dataDir, 'storage'));
    writeMarker(dataDir, '');
    const head = shGit(['--git-dir=' + barePath, 'rev-parse', 'HEAD']).out.trim();
    return { ok: true, encrypted: true, commit: head, snapshot: path.basename(snap), restoredAt: new Date().toISOString() };
  }
  // D2 divergence check: if this node has an app.db written after its last
  // sync marker, restoring over it silently drops those writes — that is a
  // conflict, so it is logged (LWW still wins the data; the log is the
  // guarantee that nothing disappears without a trace).
  const localDb = path.join(dataDir, 'app.db');
  if (fs.existsSync(localDb)) {
    const marker = readMarker(dataDir);
    const localMtime = fs.statSync(localDb).mtimeMs;
    if (!marker || localMtime > marker.at) {
      appendConflict(barePath, { kind: 'local-writes-overwritten', node: os.hostname(), detail: 'restore replaced an app.db written after this node\'s last sync marker' });
    }
  }
  // Live app.db replaced by the newest snapshot (caller must have closed its
  // own handles — the replication scheduler owns that ordering).
  fs.copyFileSync(snap, path.join(dataDir, 'app.db'));
  // Storage tree mirrored from the sync state.
  mirrorInto(path.join(stagingDir, 'storage'), path.join(dataDir, 'storage'));

  const head = shGit(['--git-dir=' + barePath, 'rev-parse', 'HEAD']).out.trim();
  writeMarker(dataDir, head);
  return { ok: true, commit: head, snapshot: path.basename(snap), restoredAt: new Date().toISOString() };
}

module.exports = {
  pushSnapshot, restoreLatest, ensureBare, newestSnapshot,
  SNAPSHOT_GLOB, MAX_KEPT_SNAPSHOTS, conflictsLedgerPath, appendConflict,
};
