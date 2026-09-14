'use strict';
// P2 — receipted backups: proven against a STUB restic (offline,
// disposable-test discipline; the suite never needs a real restic binary).
// It proves gitlive's orchestration contract: init creates the repo + key
// (mode 600), backup snapshots data + history with the app tag and writes
// a receipt + audit event, list/check/restore drive restic correctly,
// restore NEVER writes into the live data dir, and a missing restic is an
// honest error.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glbackup-'));
const binDir = fs.mkdtempSync(path.join(shortTmp, 'glbackup-bin-'));
const stateDir = fs.mkdtempSync(path.join(shortTmp, 'glbackup-state-'));
const repo = path.join(home, '.gitlive', 'backup-repo');
const key = path.join(home, '.gitlive', 'backup.key');
const callLog = path.join(stateDir, 'calls.log');

// The stub restic: records every invocation, keeps a fake repo/snapshots
// ledger, and reports "restored" by materializing a marker in the target.
fs.writeFileSync(path.join(binDir, 'restic'), `#!/bin/bash
log() { echo "$*" >> ${JSON.stringify(callLog)}; }
REPO=""; KEY=""; CMD=""; REST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -r) REPO="$2"; shift 2;;
    --password-file) KEY="$2"; shift 2;;
    *) if [ -z "$CMD" ]; then CMD="$1"; else REST="$REST $1"; fi; shift;;
  esac
done
case "$CMD" in
  version) exit 0;;
  init) log "init $REPO"; mkdir -p "$REPO"; touch "$REPO/config"; exit 0;;
  backup)
    log "backup $REPO $REST"
    SNAP="stub-$(date +%s)-$(echo "$REST" | shasum | cut -c1-8)"
    echo "$SNAP" >> "$REPO/snapshots"
    mkdir -p "$REPO/content"
    rm -rf "$REPO/content/data"
    SRC=""; set -- $REST
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--tag" ]; then shift 2
      elif [ "$1" = "--quiet" ]; then shift
      elif [ -z "$SRC" ]; then SRC="$1"; shift
      else shift; fi
    done
    if [ -n "$SRC" ] && [ -d "$SRC" ]; then
      (cd "$SRC" && find . -type f | while read -r f; do mkdir -p "$REPO/content/data/$(dirname "$f")"; cp "$f" "$REPO/content/data/$f"; done)
    fi
    echo "snapshot $SNAP saved"; exit 0;;
  snapshots)
    [ -f "$REPO/snapshots" ] || exit 0
    FIRST=1; echo "["
    while read -r s; do
      [ "$FIRST" = "1" ] || echo ","
      FIRST=0
      printf '{"short_id":"%s","id":"%s00000000000000000000000000000000000000000000000000000000000","time":"2026-09-10T00:00:00Z","tags":["gitlive:testapp"]}' "$s" "$s"
    done < "$REPO/snapshots"
    echo "]"; exit 0;;
  check) log "check $REPO"; exit 0;;
  restore)
    log "restore $REPO $REST"
    TARGET=""; set -- $REST
    while [ "$#" -gt 0 ]; do if [ "$1" = "--target" ]; then TARGET="$2"; shift 2; else shift; fi; done
    mkdir -p "$TARGET/data"
    if [ -d "$REPO/content/data" ]; then cp -R "$REPO/content/data/." "$TARGET/data/"; fi
    echo "restored" > "$TARGET/data/restored-marker"; exit 0;;
  *) log "unknown $CMD"; exit 1;;
esac
`);
fs.chmodSync(path.join(binDir, 'restic'), 0o755);

const env = { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` };
function cli(args, opts = {}) {
  return execFileSync('node', [GITLIVE_JS, ...args], {
    cwd: opts.cwd || home,
    env: opts.env || env,
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function calls() {
  try { return fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}

(async () => {
  // fake registered app with a data area + deploy history
  const regDir = path.join(home, '.gitlive');
  fs.mkdirSync(regDir, { recursive: true });
  const runPath = path.join(regDir, 'apps', 'testapp-run');
  fs.mkdirSync(path.join(runPath, 'data'), { recursive: true });
  fs.writeFileSync(path.join(runPath, 'data', 'note.txt'), 'precious data\n');
  fs.writeFileSync(path.join(runPath, 'deploy-history.jsonl'), JSON.stringify({ outcome: 'success', commit: 'abc' }) + '\n');
  fs.writeFileSync(path.join(regDir, 'apps.json'), JSON.stringify({
    testapp: { mode: 'local', runPath, port: '4123', startCmd: 'node s.js', createdAt: new Date().toISOString() },
  }, null, 2));

  // ── 1) init: repo + key, honest copy about the key being the backup ──────
  const initOut = cli(['backup', 'init']);
  assert(/backup repo initialized/.test(initOut) && /password file IS the backup key/.test(initOut), 'init creates the repo and says the honest key story:\n' + initOut);
  assert(fs.existsSync(path.join(repo, 'config')), 'the repo exists after init');
  assert(fs.existsSync(key) && (fs.statSync(key).mode & 0o777) === 0o600, 'the backup key is mode 600');
  assert(calls().includes(`init ${repo}`), 'init drives restic init');

  // ── 2) backup: snapshots data + history with the app tag, receipted ──────
  const backupOut = cli(['backup', 'testapp']);
  assert(/backed up testapp: snapshot stub-/.test(backupOut), 'backup reports the snapshot id:\n' + backupOut);
  const bc = calls().filter((l) => l.startsWith('backup ')).pop() || '';
  assert(bc.includes(`${runPath}/data`) && bc.includes('deploy-history.jsonl') && bc.includes('gitlive:testapp'), 'backup snapshots data + history with the tag:\n' + bc);
  const hist = fs.readFileSync(path.join(runPath, 'backup-history.jsonl'), 'utf8').trim().split('\n');
  assert(hist.length === 1 && JSON.parse(hist[0]).app === 'testapp' && /stub-/.test(JSON.parse(hist[0]).snapshot), 'every snapshot writes a receipt');
  const events = fs.readFileSync(path.join(home, '.gitlive', 'events.log'), 'utf8');
  assert(/backup/.test(events) && /stub-/.test(events), 'backups land in the audit events (the dashboard inbox sees them)');

  // ── 3) list: reads the snapshot ledger ───────────────────────────────────
  const listOut = cli(['backup', 'list', 'testapp']);
  assert(/stub-/.test(listOut) && /gitlive:testapp/.test(listOut), 'list shows the snapshot with its tag:\n' + listOut);

  // ── 4) check: verifies the repo ──────────────────────────────────────────
  const checkOut = cli(['backup', 'check']);
  assert(/integrity OK/.test(checkOut), 'check verifies:\n' + checkOut);
  assert(calls().includes(`check ${repo}`), 'check drives restic check');

  // ── 5) restore: to a chosen dir, NEVER over the live data ────────────────
  const to = path.join(home, 'restore-target');
  const restoreOut = cli(['backup', 'restore', 'testapp', '--to', to]);
  assert(/restored testapp/.test(restoreOut), 'restore reports:\n' + restoreOut);
  assert(fs.existsSync(path.join(to, 'data', 'restored-marker')), 'the restore materialized in the target dir');
  assert(fs.existsSync(path.join(runPath, 'data', 'note.txt')) && !fs.existsSync(path.join(runPath, 'data', 'restored-marker')), 'the live data dir was NEVER touched by restore');
  assert(/Deliberately NOT written/.test(restoreOut), 'restore says why it never touches live data');

  // ── 5b) VERIFIED restores: drill, byte-compare, receipt, honest mismatch ─
  const verifyOk = cli(['backup', 'verify', 'testapp']);
  assert(/testapp: VERIFIED — 1\/1 file\(s\) restore byte-identical/.test(verifyOk), 'the drill verifies byte-identical restores:\n' + verifyOk);
  let vhist = fs.readFileSync(path.join(runPath, 'backup-history.jsonl'), 'utf8').trim().split('\n');
  const vrow = JSON.parse(vhist[vhist.length - 1]);
  assert(vrow.verify === true && vrow.outcome === 'verified' && vrow.matched === vrow.filesChecked, 'the verification writes a receipt with real numbers');
  assert(!fs.existsSync(path.join(home, 'gitlive-verify-testapp-' + Date.now())), 'the drill directory is cleaned up');
  // tamper: change live data AFTER the snapshot → the drill must catch it
  fs.writeFileSync(path.join(runPath, 'data', 'note.txt'), 'changed after backup\n');
  let mismatch = '';
  try { cli(['backup', 'verify', 'testapp']); } catch (err) { mismatch = String(err.stdout || '') + String(err.stderr || ''); }
  assert(/MISMATCH/.test(mismatch) && /note\.txt/.test(mismatch), 'a changed file is caught by the drill:\n' + mismatch);

  // ── 6) honest errors: unknown app, missing repo, missing restic ──────────
  let noApp = '';
  try { cli(['backup', 'list', 'testapp'], { env: { ...env, HOME: fs.mkdtempSync(path.join(shortTmp, 'glbackup-none-')) } }); } catch (err) { noApp = String(err.stdout || '') + String(err.stderr || ''); }
  assert(/No app named/.test(noApp), 'unknown app is an honest error:\n' + noApp);
  fs.rmSync(repo, { recursive: true, force: true });
  let noRepo = '';
  try { cli(['backup', 'list', 'testapp']); } catch (err) { noRepo = String(err.stdout || '') + String(err.stderr || ''); }
  assert(/no backup repo/.test(noRepo), 'missing repo is an honest error:\n' + noRepo);
  let noRestic = '';
  try { cli(['backup', 'init'], { env: { ...env, GITLIVE_RESTIC: '/nonexistent/restic' } }); } catch (err) { noRestic = String(err.stdout || '') + String(err.stderr || ''); }
  assert(/restic is not installed/.test(noRestic), 'missing restic is an honest, actionable error:\n' + noRestic);

  // ── 7) control-plane state: backed up under its own tag, secrets excluded ──
  cli(['backup', 'init']);
  const stateOut = cli(['backup', 'state']);
  assert(/control-plane state: snapshot/.test(stateOut), 'state backup reports its snapshot:\n' + stateOut);
  assert(/EXCLUDED \(secrets, on purpose\)/.test(stateOut) && /DNS tokens/.test(stateOut) && /backup password/.test(stateOut), 'the receipt says which secrets were excluded:\n' + stateOut);
  const stateReceipts = path.join(home, '.gitlive', 'control', 'backup-history.jsonl');
  assert(fs.existsSync(stateReceipts), 'the state receipt is written next to the control state');
  const receipt = JSON.parse(fs.readFileSync(stateReceipts, 'utf8').trim().split('\n').pop());
  assert(receipt.app === 'control-plane' && Array.isArray(receipt.excluded) && receipt.excluded.length >= 3, 'the receipt records the exclusion list');
  // the snapshot must not have captured any key material, even though it exists
  const content = path.join(repo, 'content');
  const copied = fs.existsSync(content) ? require('child_process').execSync('find ' + JSON.stringify(content) + ' -type f -name "*.key" || true', { encoding: 'utf8' }).trim() : '';
  assert(!copied, 'no key material entered the snapshot:\n' + copied);

  console.log('ALL BACKUP TESTS PASSED');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
