'use strict';
// Deploy history must survive a redeploy.
//
// Field finding (Sept 8 2026): gitlive-hello's control-plane "Deploy Ledger"
// showed exactly ONE entry after 16 real, successful Actions deploys. Not a
// display bug — connect mode's deploy script mirrors the Actions checkout into
// the stable run dir with `rsync -a --delete`, and deploy-history.jsonl lives
// in that run dir but was never in the --exclude list. So every deploy wiped
// the whole history, then _record-deploy wrote exactly one fresh line back.
// The ledger was never a history; it was always "the last deploy only."
//
// This test runs the REAL sync block extracted from the REAL generated deploy
// script (not a copy of it), so it fails again if the exclude is ever dropped.
// Both branches are exercised: the rsync path, and the no-rsync fallback
// (forced by running it with a PATH where rsync doesn't exist).
//
// It also runs a control: the pre-fix rsync line MUST wipe history. A guard
// test that can't reproduce the bug it guards against isn't proving anything.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const gitlive = require(path.join(__dirname, '..', 'gitlive.js'));
const { appendHistory, readHistory, buildMacDeployScript, buildLinuxDeployScript } = gitlive;

const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const scratch = fs.mkdtempSync(path.join(shortTmp, 'glhist-'));

// --- pull the real sync block out of the real generated script ---------------

function generatedScript(builder) {
  return builder({
    name: 'histprobe',
    installCmd: '',
    startCmd: 'npm start',
    gitliveFile: path.join(__dirname, '..', 'gitlive.js'),
    runPath: path.join(scratch, 'unused-run'),
    secretsPath: null,
  });
}

function extractSyncBlock(script) {
  const lines = script.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('if command -v rsync'));
  assert(start !== -1, 'could not find the rsync sync block in the generated deploy script');
  const end = lines.findIndex((l, i) => i > start && l.trim() === 'fi');
  assert(end !== -1, 'could not find the end of the rsync sync block');
  return lines.slice(start, end + 1).join('\n');
}

const macScript = generatedScript(buildMacDeployScript);
const linuxScript = generatedScript(buildLinuxDeployScript);
const syncBlock = extractSyncBlock(macScript);

// --- one deploy cycle: sync the checkout in, then record the deploy ----------

function freshCheckout() {
  const dir = fs.mkdtempSync(path.join(scratch, 'checkout-'));
  fs.writeFileSync(path.join(dir, 'server.js'), 'console.log("app")\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"histprobe"}\n');
  return dir;
}

function deployCycle(runDir, block, { commit, pathOverride } = {}) {
  const script = `set -e\nCHECKOUT_DIR="${freshCheckout()}"\nRUN_DIR="${runDir}"\nmkdir -p "$RUN_DIR"\n${block}\n`;
  const file = path.join(scratch, `cycle-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, script);
  const env = { ...process.env };
  if (pathOverride) env.PATH = pathOverride;
  execFileSync('bash', [file], { env, stdio: 'pipe' });
  // this is what deploy.sh's trailing `_record-deploy` ends up calling
  appendHistory(runDir, { outcome: 'success', commit });
}

function runThreeDeploys(block, pathOverride) {
  const runDir = fs.mkdtempSync(path.join(scratch, 'run-'));
  deployCycle(runDir, block, { commit: 'aaaaaaaaaaaa', pathOverride });
  deployCycle(runDir, block, { commit: 'bbbbbbbbbbbb', pathOverride });
  deployCycle(runDir, block, { commit: 'cccccccccccc', pathOverride });
  return readHistory(runDir, 10);
}

// --- 1. rsync path: history accumulates -------------------------------------

const viaRsync = runThreeDeploys(syncBlock);
assert(viaRsync.length === 3, `rsync path: expected 3 history entries after 3 deploys, got ${viaRsync.length} — the run dir's deploy-history.jsonl is being wiped by the sync`);
assert(viaRsync[0].commit === 'aaaaaaaaaaaa', 'rsync path: oldest entry should be the first deploy');
assert(viaRsync[2].commit === 'cccccccccccc', 'rsync path: newest entry should be the last deploy');
console.log('OK: history survives 3 redeploys through the real rsync sync block');

// --- 2. no-rsync fallback path: history also survives ------------------------

const shim = fs.mkdtempSync(path.join(scratch, 'shim-'));
for (const bin of ['rm', 'mkdir', 'cp', 'mv', 'bash', 'cat', 'sed']) {
  for (const dir of ['/bin', '/usr/bin']) {
    const src = path.join(dir, bin);
    if (fs.existsSync(src) && !fs.existsSync(path.join(shim, bin))) fs.symlinkSync(src, path.join(shim, bin));
  }
}
assert(!fs.existsSync(path.join(shim, 'rsync')), 'shim PATH must not contain rsync, or the fallback branch is not being tested');

const viaFallback = runThreeDeploys(syncBlock, shim);
assert(viaFallback.length === 3, `fallback path: expected 3 history entries after 3 deploys, got ${viaFallback.length} — the rm -rf/cp -a fallback is destroying deploy-history.jsonl`);
assert(viaFallback[0].commit === 'aaaaaaaaaaaa', 'fallback path: oldest entry should be the first deploy');
console.log('OK: history survives 3 redeploys through the no-rsync fallback branch');

// --- 3. control: the pre-fix line MUST lose history --------------------------
// If this stops failing, the test above has stopped being able to detect the bug.

const preFixBlock = `if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude data --exclude .git "$CHECKOUT_DIR/" "$RUN_DIR/"
else
  exit 1
fi`;
const viaPreFix = runThreeDeploys(preFixBlock);
assert(viaPreFix.length === 1, `control: the pre-fix rsync line was expected to wipe history down to 1 entry, but produced ${viaPreFix.length} — this test can no longer detect the regression it guards`);
console.log('OK: control — the pre-fix rsync line does destroy history (test can detect the regression)');

// --- 4. both generated scripts carry the exclude -----------------------------

for (const [label, script] of [['macOS', macScript], ['Linux', linuxScript]]) {
  const rsyncLine = script.split('\n').find((l) => l.trim().startsWith('rsync '));
  assert(rsyncLine, `${label}: no rsync line found in the generated deploy script`);
  assert(/--exclude deploy-history\.jsonl/.test(rsyncLine), `${label}: generated deploy script's rsync is missing --exclude deploy-history.jsonl`);
}
console.log('OK: both generated deploy scripts exclude deploy-history.jsonl from the sync');

fs.rmSync(scratch, { recursive: true, force: true });
console.log('\nALL DEPLOY-HISTORY TESTS PASSED');
