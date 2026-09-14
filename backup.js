#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// backup.js — receipted backups (P2 pain-driven roadmap: the portability
// trap). The #1 fear when leaving a managed platform is losing data, so
// gitlive backs up app data with a VERIFIED tool and writes a receipt for
// every snapshot — a backup you can't verify is a wish, not a backup.
//
// restic is an external binary (like openssl/docker — the zero-dependency
// law covers npm/runtime deps, not the user's toolbox). gitlive only
// orchestrates it: init, snapshot, list, verify (restic check), restore.
// Every snapshot lands in the app's backup-history.jsonl AND the audit
// events log, so the dashboard's inbox shows backups like any other fact.
//
// Honest v1 limits, said out loud:
//   - per-app DATA backups (runPath/data + deploy history) — whole-machine
//     snapshots come later.
//   - no scheduler inside gitlive: cron/launchd is yours (the command is
//     printed). Building a cron engine we don't supervise would be worse.
//   - restore NEVER writes into a live app's data dir — it restores to a
//     directory you choose, then you move it (stopping the app first is on
//     you, and the message says so).
//   - the repo's password file IS the backup key: losing it means the
//     backups are unrecoverable. Stored mode 600 next to the repo.
//   - offsite = your copy job (restic copy / rclone / a second disk). A
//     backup on the same disk as the app is a convenience, not a backup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME_DIR = path.join(os.homedir(), '.gitlive');
const REPO_DEFAULT = path.join(HOME_DIR, 'backup-repo');
const KEY_DEFAULT = path.join(HOME_DIR, 'backup.key');
// restic must be findable from a LAUNCHD context too: the boot agent starts the
// plane with a minimal PATH, so a plain 'restic' would vanish after a reboot
// even though the same command works in a terminal. Resolution order matters:
//   1. an explicit GITLIVE_RESTIC override (tests, custom installs) always wins
//   2. PATH — what the user configured (this is also the test seam)
//   3. the usual package-manager prefixes, for the launchd case
function resolveRestic() {
  if (process.env.GITLIVE_RESTIC) return process.env.GITLIVE_RESTIC;
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'restic');
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }
  for (const candidate of ['/opt/homebrew/bin/restic', '/usr/local/bin/restic', '/usr/bin/restic']) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return 'restic'; // resticOk() reports honestly when it is genuinely absent
}
const RESTIC = resolveRestic();

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 300000, ...opts });
}

function requireApp(reg, name) {
  if (!name) throw new Error('Usage: gitlive backup <app> — backup that app\'s data');
  if (!reg[name]) throw new Error(`No app named "${name}". Run "gitlive list".`);
  return reg[name];
}

function repoFor(app) {
  return (app && app.backupRepo) || REPO_DEFAULT;
}
function keyFor(app) {
  return (app && app.backupPasswordFile) || KEY_DEFAULT;
}

function resticOk() {
  const r = sh(RESTIC, ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0;
}

function runRestic(args, label) {
  const r = sh(RESTIC, args);
  if (r.status !== 0) {
    const tail = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').pop();
    throw new Error(`${label} failed: ${tail || 'restic error'}`);
  }
  return (r.stdout || '').trim();
}

// restic speaks JSON for snapshots — one stable parsing point.
function snapshots(app, tag) {
  const args = ['snapshots', '--json', '-r', repoFor(app), '--password-file', keyFor(app)];
  if (tag) args.push('--tag', tag);
  let out = '';
  try { out = runRestic(args, 'listing backups'); } catch (err) { throw new Error(err.message.replace(' failed:', ' failed (repo initialized? gitlive backup init):')); }
  try { return JSON.parse(out); } catch { return []; }
}

// The receipt: structured, append-only, next to the deploy history — and an
// audit event, so the dashboard's inbox carries backup facts like any other.
function writeReceipt(app, entry) {
  const histPath = path.join(app.runPath, 'backup-history.jsonl');
  fs.appendFileSync(histPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  try { require('./crypt.js').logEvent('backup', { app: entry.app, snapshot: entry.snapshot, bytes: entry.bytes || null }); } catch { /* audit must never mask the backup */ }
}

// ── the plane's own state ────────────────────────────────────────────────
// Apps had receipts; the CONTROL PLANE did not — losing apps.json, the
// session db or the audit log meant losing the machine's memory while every
// app's data was safe. This backs that state up under its own tag.
//
// SECRETS ARE EXCLUDED ON PURPOSE, and the receipt says so: zone DNS tokens
// (zones.json), key material (*.key, *.pem) and the backup key itself never
// enter a snapshot. A restore therefore needs the owner to re-add a DNS
// token — re-typing one secret is a better failure mode than a backup repo
// that carries every secret it protects.
function statePaths() {
  const control = path.join(HOME_DIR, 'control');
  const domain = path.join(HOME_DIR, 'domain');
  const include = [];
  const push = (p, what) => { if (fs.existsSync(p)) include.push({ path: p, what }); };
  push(path.join(HOME_DIR, 'apps.json'), 'app registry');
  push(path.join(HOME_DIR, 'events.log'), 'audit log');
  push(path.join(control, 'app.db'), 'control db (users + session hashes)');
  push(path.join(control, 'jobs.jsonl'), 'job ledger');
  push(path.join(domain, 'zones.list'), 'zone names (tokens excluded)');
  const excluded = ['zones.json (DNS tokens)', '*.key / *.pem (key material)', 'backup.key (the backup password)'];
  // zone NAMES only — the token is the secret
  try {
    const zones = require('./gitlive.js').loadZones();
    const names = Object.keys(zones || {});
    if (names.length) {
      const tmp = path.join(control, 'zones.list');
      fs.mkdirSync(control, { recursive: true });
      fs.writeFileSync(tmp, names.join('\n') + '\n');
      push(tmp, 'zone names');
    }
  } catch { /* zones optional */ }
  return { include, excluded };
}

function cmdBackupState(flags) {
  const repo = String(flags.repo || REPO_DEFAULT);
  const key = String(flags['password-file'] || KEY_DEFAULT);
  if (!resticOk()) throw new Error('restic is not installed — brew install restic (or apt install restic), then re-run.');
  if (!fs.existsSync(path.join(repo, 'config'))) throw new Error(`no backup repo at ${repo} — run: gitlive backup init`);
  const { include, excluded } = statePaths();
  if (!include.length) throw new Error('no control-plane state found to back up (nothing at ~/.gitlive yet).');
  const args = ['backup', ...include.map((f) => f.path), '--tag', 'gitlive:state', '-r', repo, '--password-file', key, '--quiet'];
  const r = sh(RESTIC, args);
  if (r.status !== 0) {
    const tail = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').pop();
    throw new Error('state backup failed: ' + (tail || 'restic error'));
  }
  const snaps = snapshots({ backupRepo: repo, backupPasswordFile: key }, 'gitlive:state').slice(-1);
  const latestId = snappedId(snaps);
  // receipt next to the control state, so the dashboard's backups row sees it
  const histPath = path.join(HOME_DIR, 'control', 'backup-history.jsonl');
  fs.mkdirSync(path.dirname(histPath), { recursive: true });
  fs.appendFileSync(histPath, JSON.stringify({ at: new Date().toISOString(), app: 'control-plane', snapshot: latestId, source: include.map((f) => f.what).join(' + '), excluded }) + '\n');
  try { require('./crypt.js').logEvent('backup', { app: 'control-plane', snapshot: latestId, bytes: null }); } catch { /* audit best-effort */ }
  console.log(`backed up control-plane state: snapshot ${latestId} → ${repo}`);
  console.log(`  included: ${include.map((f) => f.what).join(', ')}`);
  console.log(`  EXCLUDED (secrets, on purpose): ${excluded.join(', ')}`);
  console.log(`  a restore needs you to re-add a zone DNS token — re-typing one secret beats a repo that carries every secret`);
}

function snappedId(snaps) {
  return (snaps && snaps.length && (snaps[0].short_id || snaps[0].id)) || '(newest)';
}

function cmdBackupInit(flags) {
  const repo = String(flags.repo || REPO_DEFAULT);
  const key = String(flags['password-file'] || KEY_DEFAULT);
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  if (!fs.existsSync(key)) {
    fs.writeFileSync(key, crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
    fs.chmodSync(key, 0o600);
    console.log(`backup key generated: ${key} (mode 600)`);
  }
  if (!resticOk()) throw new Error('restic is not installed — brew install restic (or apt install restic), then re-run.');
  runRestic(['init', '-r', repo, '--password-file', key], 'backup init');
  console.log(`backup repo initialized: ${repo}`);
  console.log(`\nThe password file IS the backup key — without it the backups are unrecoverable.`);
  console.log(`Keep ${key} safe and COPY it offsite with the repo (restic copy / rclone / a second disk):`);
  console.log(`a backup on the same disk as the app is a convenience, not a backup.`);
  console.log(`\nBack one app up:            gitlive backup <app>`);
  console.log(`Nightly, from cron:         0 3 * * *  gitlive backup <app>   (cron/launchd is yours — gitlive prints the command, you schedule it)`);
}

function cmdBackupApp(appName, flags) {
  const reg = (() => { try { return require('./gitlive.js').loadRegistry(); } catch { return {}; } })();
  const app = requireApp(reg, appName);
  if (!app.runPath || !fs.existsSync(path.join(app.runPath, 'data'))) {
    throw new Error(`"${appName}" has no data area yet (runPath/data) — nothing to back up.`);
  }
  const repo = repoFor(app);
  const key = keyFor(app);
  if (!resticOk()) throw new Error('restic is not installed — brew install restic (or apt install restic), then re-run.');
  if (!fs.existsSync(path.join(repo, 'config'))) throw new Error(`no backup repo at ${repo} — run: gitlive backup init`);
  const tag = `gitlive:${appName}`;
  const args = ['backup', path.join(app.runPath, 'data'), path.join(app.runPath, 'deploy-history.jsonl'),
    '--tag', tag, '-r', repo, '--password-file', key, '--quiet'];
  const r = sh(RESTIC, args);
  if (r.status !== 0) {
    const tail = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').pop();
    throw new Error(`backup failed: ${tail || 'restic error'}`);
  }
  // the printed id is a hint; the newest tagged snapshot is ground truth
  const summary = ((r.stdout || '') + (r.stderr || '')).trim();
  const idMatch = summary.match(/snapshot ([0-9a-f]{8,})/i);
  const snaps = snapshots(app, tag).slice(-1);
  const latestId = (idMatch && idMatch[1]) || (snaps.length ? (snaps[0].short_id || snaps[0].id) : null) || '(newest)';
  writeReceipt(app, { app: appName, snapshot: latestId, bytes: null, source: 'data + deploy history' });
  console.log(`backed up ${appName}: snapshot ${latestId} → ${repo}`);
  console.log(`verify anytime:   gitlive backup check`);
  console.log(`restore:          gitlive backup restore ${appName}`);
}

function cmdBackupList(appName) {
  const reg = (() => { try { return require('./gitlive.js').loadRegistry(); } catch { return {}; } })();
  if (!appName) {
    let any = false;
    for (const [name, app] of Object.entries(reg)) {
      let hist = [];
      try { hist = fs.readFileSync(path.join(app.runPath, 'backup-history.jsonl'), 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
      if (hist.length) {
        any = true;
        const last = JSON.parse(hist[hist.length - 1]);
        console.log(`  ${name}  —  ${hist.length} snapshot(s), latest ${last.snapshot}`);
      }
    }
    if (!any) console.log('no backups yet — gitlive backup init, then gitlive backup <app>.');
    return;
  }
  const app = requireApp(reg, appName);
  if (!fs.existsSync(path.join(repoFor(app), 'config'))) throw new Error(`no backup repo at ${repoFor(app)} — run: gitlive backup init`);
  const snaps = snapshots(app, `gitlive:${appName}`);
  if (!snaps.length) { console.log(`no backups of ${appName} yet — run: gitlive backup ${appName}`); return; }
  for (const s of snaps.slice(-10)) {
    console.log(`  ${s.short_id || s.id}  ${s.time || ''}  ${(s.tags || []).join(', ')}`);
  }
}

function cmdBackupCheck() {
  const repo = REPO_DEFAULT;
  const key = KEY_DEFAULT;
  if (!fs.existsSync(path.join(repo, 'config'))) throw new Error(`no backup repo at ${repo} — run: gitlive backup init`);
  runRestic(['check', '-r', repo, '--password-file', key], 'backup check');
  console.log(`backup repo integrity OK: ${repo} — the snapshots verify.`);
}

// ── verified restores (post-roadmap #7): a backup you can't prove
// restores is a wish. The drill restores the newest snapshot into a
// throwaway directory, compares every file byte-for-byte against the
// LIVE data, receipts the outcome, and cleans up after itself. Live data
// is never touched — only read for comparison.
// ---------------------------------------------------------------------------
function walkFiles(dir, onFile, rel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? rel + '/' + e.name : e.name;
    const a = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(a, onFile, r);
    else onFile(r, a);
  }
}
function fileSha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function cmdBackupVerify(appName) {
  const reg = (() => { try { return require('./gitlive.js').loadRegistry(); } catch { return {}; } })();
  const names = appName ? [appName] : Object.keys(reg);
  if (!appName && !names.length) throw new Error('no apps registered — gitlive init one first.');
  if (appName && !reg[appName]) throw new Error(`No app named "${appName}". Run "gitlive list".`);
  let any = false;
  let failed = false;
  for (const n of names) {
    const app = reg[n];
    const histPath = path.join(app.runPath, 'backup-history.jsonl');
    if (!fs.existsSync(histPath)) continue;
    any = true;
    const repo = repoFor(app);
    const key = keyFor(app);
    if (!fs.existsSync(path.join(repo, 'config'))) throw new Error(`no backup repo at ${repo} — run: gitlive backup init`);
    const snaps = snapshots(app, `gitlive:${n}`);
    if (!snaps.length) { console.log(`  ${n}: no snapshots to verify — gitlive backup ${n}`); continue; }
    const snap = String(snaps[snaps.length - 1].short_id || snaps[snaps.length - 1].id);
    const target = path.join(os.tmpdir(), `gitlive-verify-${n}-${Date.now()}`);
    fs.mkdirSync(target, { recursive: true });
    runRestic(['restore', snap, '--target', target, '-r', repo, '--password-file', key], 'restore drill');
    const liveData = path.join(app.runPath, 'data');
    const restoredData = path.join(target, 'data');
    let checked = 0;
    let matched = 0;
    let skipped = 0;
    const mismatched = [];
    walkFiles(restoredData, (rel, abs) => {
      const liveF = path.join(liveData, rel);
      // A file that no longer exists in live data is a DELETION, not a
      // backup failure — the drill only judges files present in both.
      if (!fs.existsSync(liveF)) { skipped++; return; }
      checked++;
      if (fileSha(abs) === fileSha(liveF)) matched++;
      else mismatched.push(rel);
    });
    fs.rmSync(target, { recursive: true, force: true });
    const outcome = mismatched.length === 0 ? 'verified' : 'mismatch';
    writeReceipt(app, { app: n, snapshot: snap, verify: true, filesChecked: checked, matched, skipped, mismatches: mismatched.length, outcome });
    if (outcome === 'verified') {
      console.log(`  ${n}: VERIFIED — ${matched}/${checked} file(s) restore byte-identical${skipped ? ` (${skipped} skipped — not in live data)` : ''}. This backup restores.`);
    } else {
      failed = true;
      console.log(`  ${n}: MISMATCH — ${mismatched.length} of ${checked} file(s) differ after restore: ${mismatched.slice(0, 3).join(', ')}${mismatched.length > 3 ? ' …' : ''}`);
    }
  }
  if (!any) console.log('no backups recorded yet — gitlive backup init, then gitlive backup <app>.');
  if (failed) process.exitCode = 1;
}

function cmdBackupRestore(appName, flags) {
  const reg = (() => { try { return require('./gitlive.js').loadRegistry(); } catch { return {}; } })();
  const app = requireApp(reg, appName);
  const target = String(flags.to || path.join(os.homedir(), `gitlive-restore-${appName}-${Date.now()}`));
  fs.mkdirSync(target, { recursive: true });
  const snaps = snapshots(app, `gitlive:${appName}`);
  if (!snaps.length) throw new Error(`no backups of ${appName} — run: gitlive backup ${appName}`);
  const snap = String(flags.snapshot || snaps[snaps.length - 1].short_id || snaps[snaps.length - 1].id);
  runRestic(['restore', snap, '--target', target, '-r', repoFor(app), '--password-file', keyFor(app)], 'restore');
  console.log(`restored ${appName} snapshot ${snap} → ${target}`);
  console.log(`Deliberately NOT written into the live data dir — stop the app, then move the files:`);
  console.log(`  gitlive stop ${appName}`);
  console.log(`  cp -R ${target}/data/* ${app.runPath}/data/   (your move, your call)`);
}

function cmdBackup(rest) {
  const sub = rest[0];
  const flags = (() => { try { return require('./gitlive.js').parseFlags(rest.slice(1)).flags; } catch { return {}; } })();
  if (sub === 'init') { cmdBackupInit(flags); return; }
  if (sub === 'state') { cmdBackupState(flags); return; }
  if (sub === 'check') { cmdBackupCheck(); return; }
  if (sub === 'verify') { cmdBackupVerify(rest[1]); return; }
  if (sub === 'list') { cmdBackupList(rest[1]); return; }
  if (sub === 'restore') { cmdBackupRestore(rest[1], flags); return; }
  if (sub) { cmdBackupApp(sub, flags); return; }
  console.error('Usage: gitlive backup init            create the encrypted backup repo (restic, your disk)');
  console.error('       gitlive backup <app>           snapshot that app\'s data + deploy history, receipted');
  console.error('       gitlive backup list [app]      what is backed up, newest first');
  console.error('       gitlive backup state           snapshot the CONTROL PLANE\'s own state (registry, session db, audit log — secrets excluded)');
  console.error('       gitlive backup check           verify the repo (restic check) — a backup that can\'t be verified is a wish');
  console.error('       gitlive backup verify [app]    restore drill: restores the newest snapshot to a throwaway dir,');
  console.error('                                       compares every file byte-for-byte, receipts the outcome — a backup');
  console.error('                                       proven to restore, not just assumed');
  console.error('       gitlive backup restore <app> [--snapshot <id>] [--to <dir>]   restore to a directory, never over the live data');
  console.error('Nightly: 0 3 * * *  gitlive backup <app>   (cron is yours — gitlive prints the command, you schedule it)');
  process.exitCode = 1;
}

module.exports = { cmdBackup, snapshots, runRestic, writeReceipt, REPO_DEFAULT, KEY_DEFAULT, RESTIC };

if (require.main === module) {
  try { cmdBackup(process.argv.slice(2)); } catch (err) { console.error('gitlive backup: ' + err.message); process.exit(1); }
}
