'use strict';
// Deploy-time manifest enforcement (Phase 2 D4) — REAL `gitlive init` against
// a fake $HOME, then real `git push`es through the pre-receive hook:
//   1. unsigned push (no manifest) → allowed (legacy behavior)
//   2. signed push (manifest matches the pushed commit) → allowed
//   3. push with stale signed content (code moved past the signed commit) →
//      REJECTED atomically by the hook, remote ref stays at the old head

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const fakeHome = fs.mkdtempSync(path.join(shortTmp, 'gitlive-deploymanifest-home-'));
const project = fs.mkdtempSync(path.join(shortTmp, 'gitlive-dm-proj-'));

fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'dmapp', scripts: { start: 'node server.js' } }, null, 2));
fs.writeFileSync(path.join(project, 'server.js'), 'console.log("v1")\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
execFileSync('git', ['add', '.'], { cwd: project });
execFileSync('git', ['-c', 'user.email=t@x.io', '-c', 'user.name=t', 'commit', '-qm', 'v1'], { cwd: project });

const env = { ...process.env, HOME: fakeHome, GITLIVE_MANIFEST_KEY: path.join(fakeHome, '.gitlive', 'manifest-owner-key.pem') };
function cli(args, opts = {}) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: opts.cwd || project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: project, env: { ...env, HOME: undefined }, encoding: 'utf8' });
}
function expectPushFail(args) {
  try {
    // HOME stays fake for the push so hook-side audit logging (logEvent)
    // writes into the FAKE events log, never the real home.
    execFileSync('git', args, { cwd: project, env: { ...env, HOME: fakeHome }, encoding: 'utf8' });
    return null;
  } catch (err) {
    return String(err.stdout || '') + String(err.stderr || '');
  }
}
function head() { return git(['rev-parse', 'HEAD']).trim(); }

(async () => {
  // 1 — real init installs the pre-receive hook
  const port = String(31000 + Math.floor(Math.random() * 500));
  const initOut = cli(['init', 'dmapp', '--start', 'node server.js', '--install', 'true', '--port', port, '--yes']);
  assert(/Done\./.test(initOut), 'init output:\n' + initOut);
  const barePath = path.join(fakeHome, '.gitlive', 'apps', 'dmapp.git');
  assert(fs.existsSync(path.join(barePath, 'hooks', 'pre-receive')), 'init must install the pre-receive hook');
  const hookStat = fs.statSync(path.join(barePath, 'hooks', 'pre-receive'));
  assert((hookStat.mode & 0o111) !== 0, 'pre-receive must be executable');

  // 2 — unsigned push allowed (legacy)
  git(['push', 'dmapp', 'main']);
  console.log('OK: unsigned push passes (legacy behavior preserved)');

  // 3 — keygen then sign + commit + push → allowed through the enforcement hook
  cli(['manifest', 'keygen']);
  const sg = cli(['manifest', 'sign']);
  assert(/Signed manifest/.test(sg), 'sign:\n' + sg);
  git(['add', '.gitlive/app.manifest']);
  git(['-c', 'user.email=t@x.io', '-c', 'user.name=t', 'commit', '-qm', 'add signed manifest']);
  const signedHead = head();
  git(['push', 'dmapp', 'main']);
  console.log('OK: signed push passes (manifest matches pushed commit)');

  // 4 — code moves past the signed commit → push REJECTED, ref unchanged
  fs.appendFileSync(path.join(project, 'server.js'), 'console.log("v2 — unsigned change")\n');
  git(['add', 'server.js']);
  git(['-c', 'user.email=t@x.io', '-c', 'user.name=t', 'commit', '-qm', 'v2 code past the signature']);
  const rejectOut = expectPushFail(['push', 'dmapp', 'main']);
  assert(rejectOut && /push rejected/.test(rejectOut), 'stale-signature push must be rejected:\n' + (rejectOut || '(push succeeded — ENFORCEMENT BROKEN)'));
  const remoteHead = git(['ls-remote', path.join(fakeHome, '.gitlive', 'apps', 'dmapp.git'), 'main']).split(/\s+/)[0];
  assert(remoteHead === signedHead, `remote must stay at signed head ${signedHead.slice(0, 8)}, got ${String(remoteHead).slice(0, 8)}`);

  // 4b — the rejection lands in the audit events log (manifest-denied)
  const evtLog = path.join(fakeHome, '.gitlive', 'events.log');
  assert(fs.existsSync(evtLog), 'events log exists after a rejection');
  const evts = fs.readFileSync(evtLog, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const denied = evts.find((e) => e.kind === 'manifest-denied');
  assert(denied && /dmapp/.test(JSON.stringify(denied.detail)) && /stale|changed/.test(JSON.stringify(denied.detail.errors || [])), 'manifest-denied event carries app + reason:\n' + JSON.stringify(evts).slice(0, 400));
  console.log('OK: manifest rejection recorded in the audit events log');

  // 5 — re-sign after the new commit → push passes again
  cli(['manifest', 'sign']);
  git(['add', '.gitlive/app.manifest']);
  git(['-c', 'user.email=t@x.io', '-c', 'user.name=t', 'commit', '-qm', 're-sign for v2']);
  git(['push', 'dmapp', 'main']);
  console.log('OK: re-signing after the new commit restores push (documented workflow works)');

  // 6 — liveness gate: a deploy whose app dies instantly is receipted
  // "failed" and the push reports failure (field finding: a dead app used
  // to receive a signed "success" receipt).
  const deadProj = fs.mkdtempSync(path.join(shortTmp, 'gitlive-dead-proj-'));
  fs.writeFileSync(path.join(deadProj, 'x.txt'), 'x\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: deadProj });
  execFileSync('git', ['add', '.'], { cwd: deadProj });
  execFileSync('git', ['-c', 'user.email=d@x.io', '-c', 'user.name=d', 'commit', '-qm', 'v1'], { cwd: deadProj });
  const deadPort = String(32000 + Math.floor(Math.random() * 500));
  cli(['init', 'deadapp', '--start', 'false', '--install', 'true', '--port', deadPort, '--yes'], { cwd: deadProj });
  // post-receive exit codes do not fail the client push (the ref is already
  // updated — that's why manifest enforcement lives in pre-receive); the
  // honest surfaces are the loud remote message + the failed receipt.
  const deadPush = spawnSync('git', ['push', 'deadapp', 'main'], { cwd: deadProj, env: { ...env, HOME: fakeHome }, encoding: 'utf8' });
  const deadPushOut = (deadPush.stdout || '') + (deadPush.stderr || ''); // git prints "remote:" lines on stderr
  assert(/deploy FAILED/.test(deadPushOut), 'the push must print the deploy-failed verdict:\n' + deadPushOut);
  const deadHist = fs.readFileSync(path.join(fakeHome, '.gitlive', 'apps', 'deadapp-run', 'deploy-history.jsonl'), 'utf8');
  const deadLast = JSON.parse(deadHist.trim().split('\n').filter(Boolean).pop());
  assert(deadLast.outcome === 'failed' && /6s/.test(deadLast.reason || ''), 'receipt outcome failed with the honest reason:\n' + JSON.stringify(deadLast));
  console.log('OK: liveness gate — dead app → loud failed verdict + failed receipt (no phantom success)');

  console.log('OK: init installs the enforcement pre-receive hook');
  console.log('OK: stale signed content is rejected atomically (remote ref unchanged)');
  console.log('\nALL MANIFEST DEPLOY-ENFORCEMENT TESTS PASSED');
})().catch((err) => {
  console.error('MANIFEST DEPLOY TEST FAILED:', (err && err.message) || err);
  if (err && err.stdout) console.error(String(err.stdout).slice(0, 800));
  if (err && err.stderr) console.error(String(err.stderr).slice(0, 800));
  process.exitCode = 1;
});
