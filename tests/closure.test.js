'use strict';
// F1 — signed dependency closure (Fabric program). A signed manifest that
// finds a package-lock.json pins the lockfile digest; the generated
// post-receive hooks gate the checkout against it BEFORE install (abort on
// drift, audit `closure-denied`), install strictly (npm ci) when pinned,
// and record the closure digest into the deploy receipt. Real init + real
// push under a fake $HOME — same discipline as every suite.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const fakeHome = fs.mkdtempSync(path.join(shortTmp, 'glclosure-home-'));
const project = fs.mkdtempSync(path.join(shortTmp, 'glclosure-proj-'));
const env = { ...process.env, HOME: fakeHome };
const hl = path.join(fakeHome, '.gitlive');

function cli(args, opts = {}) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: opts.cwd || project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function cliFail(args, opts = {}) {
  try { cli(args, opts); return null; } catch (err) { return String(err.stdout || '') + String(err.stderr || ''); }
}
function git(args) {
  return execFileSync('git', args, { cwd: project, env: { ...env, HOME: fakeHome }, encoding: 'utf8' });
}
function commitAll(msg) {
  git(['add', '-A']);
  git(['-c', 'user.email=t@x.io', '-c', 'user.name=t', 'commit', '-qm', msg]);
}
function lockfileSha() {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(project, 'package-lock.json'))).digest('hex');
}

// minimal but structurally real npm lockfile (v3): root + one dependency
const LOCK = {
  name: 'closapp', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'closapp', version: '1.0.0' },
    'node_modules/leftpad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/leftpad/-/leftpad-1.3.0.tgz', integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
  },
};

(async () => {
  cli(['manifest', 'keygen']);

  // 1 — a project with a lockfile signs a manifest that PINS the closure
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'closapp', version: '1.0.0', scripts: { start: 'node server.js' } }, null, 2));
  fs.writeFileSync(path.join(project, 'package-lock.json'), JSON.stringify(LOCK, null, 2));
  fs.writeFileSync(path.join(project, 'server.js'), "require('node:http').createServer((q, s) => s.end('ok')).listen(0);\nsetInterval(() => {}, 1000);\n");
  const initOut = cli(['init', 'closapp', '--start', 'node server.js', '--install', 'true', '--yes']);
  assert(/Done\./.test(initOut), 'init output:\n' + initOut);
  commitAll('app v1 with lockfile');

  const signOut = cli(['manifest', 'sign']);
  assert(/Dependency closure PINNED/.test(signOut), 'sign reports the pinned closure:\n' + signOut);
  const manifest = JSON.parse(fs.readFileSync(path.join(project, '.gitlive', 'app.manifest'), 'utf8'));
  const closure = manifest.run && manifest.run.closure;
  assert(closure && closure.kind === 'npm-lockfile' && closure.sha256 === lockfileSha() && closure.entries === 2, 'manifest pins the lockfile digest: ' + JSON.stringify(closure));
  commitAll('sign manifest with closure');

  // 2 — the generated hook carries the gate + strict-install logic
  const barePath = path.join(hl, 'apps', 'closapp.git');
  const hook = fs.readFileSync(path.join(barePath, 'hooks', 'post-receive'), 'utf8');
  assert(hook.includes('_closure-gate'), 'post-receive runs the closure gate');
  assert(hook.includes('npm ci') && hook.includes('PINNED'), 'post-receive switches npm install to npm ci when pinned');
  console.log('OK: sign pins the lockfile closure; generated hook gates + strict-installs');

  // 3 — push deploys through the gate; the receipt records the closure sha
  // (git push reports progress on stderr; execFileSync throws on refusal,
  // so a successful return IS the assertion that the hook chain passed)
  execFileSync('git', ['push', 'closapp', 'main'], { cwd: project, env: { ...env, HOME: fakeHome }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const runPath = path.join(hl, 'apps', 'closapp-run');
  const log = fs.readFileSync(path.join(runPath, 'deploy.log'), 'utf8');
  assert(/closure: pinned \(2 lockfile entries via package-lock\.json\)/.test(log), 'deploy log shows the pinned gate pass:\n' + log.split('\n').slice(-6).join('\n'));
  const hist = fs.readFileSync(path.join(runPath, 'deploy-history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const last = hist[hist.length - 1];
  assert(last && last.outcome === 'success' && last.closure === lockfileSha(), 'deploy receipt carries the attested closure sha:\n' + JSON.stringify(last));
  console.log('OK: push deploys through the gate; receipt records the closure');

  // 3b — provenance stem: the deploy also wrote an OWNER-SIGNED git tag;
  // `gitlive receipts` lists and verifies it (history as signed refs)
  const headCommit = git(['rev-parse', 'HEAD']).trim();
  const tagList = execFileSync('git', ['--git-dir=' + barePath, 'for-each-ref', '--format=%(refname:short)', 'refs/tags/gitlive/deploys'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert(tagList.length >= 1 && tagList.some((t) => t.includes(headCommit)), 'deploy tag refs exist in the bare repo:\n' + tagList.join('\n'));
  const recOut = cli(['receipts', 'closapp']);
  assert(/owner signature VALID/.test(recOut) && /closure pinned/.test(recOut), 'receipts verify the signed deploy tag:\n' + recOut);
  console.log('OK: provenance stem — deploys recorded as owner-signed git refs (receipts verifies)');

  // 4 — drift aborts at the gate with an audit event (direct gate, since the
  // pre-receive hook already blocks non-.gitlive changes between sign+push)
  const driftDir = fs.mkdtempSync(path.join(shortTmp, 'glclosure-drift-'));
  fs.mkdirSync(path.join(driftDir, '.gitlive'), { recursive: true });
  fs.writeFileSync(path.join(driftDir, '.gitlive', 'app.manifest'), JSON.stringify({ run: { closure: { kind: 'npm-lockfile', lockfile: 'package-lock.json', sha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } } }));
  fs.writeFileSync(path.join(driftDir, 'package-lock.json'), JSON.stringify(LOCK, null, 2));
  const driftOut = cliFail(['_closure-gate', driftDir]);
  assert(driftOut && /drift|does not match/.test(driftOut), 'drift aborts with a reason:\n' + (driftOut || '(accepted!)'));
  const evts = fs.readFileSync(path.join(hl, 'events.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(evts.some((e) => e.kind === 'closure-denied' && /deadbeef/.test(JSON.stringify(e.detail))), 'closure-denied lands in the audit log');
  console.log('OK: closure drift aborts the gate + audits closure-denied');

  // 5 — missing lockfile aborts; legacy (no closure pinned) passes through
  const noLockDir = fs.mkdtempSync(path.join(shortTmp, 'glclosure-nolock-'));
  fs.mkdirSync(path.join(noLockDir, '.gitlive'), { recursive: true });
  fs.writeFileSync(path.join(noLockDir, '.gitlive', 'app.manifest'), JSON.stringify({ run: { closure: { kind: 'npm-lockfile', lockfile: 'package-lock.json', sha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } } }));
  const noLockOut = cliFail(['_closure-gate', noLockDir]);
  assert(noLockOut && /lockfile missing/.test(noLockOut), 'missing lockfile aborts:\n' + (noLockOut || '(accepted!)'));
  const legacyDir = fs.mkdtempSync(path.join(shortTmp, 'glclosure-legacy-'));
  const legacyOut = cli(['_closure-gate', legacyDir]);
  assert(/closure: legacy/.test(legacyOut), 'no manifest = legacy pass-through:\n' + legacyOut);
  const unpinnedDir = fs.mkdtempSync(path.join(shortTmp, 'glclosure-unpinned-'));
  fs.mkdirSync(path.join(unpinnedDir, '.gitlive'), { recursive: true });
  fs.writeFileSync(path.join(unpinnedDir, '.gitlive', 'app.manifest'), JSON.stringify({ run: {} }));
  const unpinnedOut = cli(['_closure-gate', unpinnedDir]);
  assert(/closure: legacy/.test(unpinnedOut), 'manifest without closure = legacy pass-through:\n' + unpinnedOut);
  console.log('OK: missing lockfile aborts; legacy and unpinned manifests pass through');

  // 6 — --no-closure signs without pinning (documented escape hatch)
  fs.mkdtempSync(project); // no-op to keep structure obvious
  const plainDir = fs.mkdtempSync(path.join(shortTmp, 'glclosure-noclose-'));
  fs.writeFileSync(path.join(plainDir, 'package.json'), JSON.stringify({ name: 'ncapp', version: '1.0.0' }));
  fs.writeFileSync(path.join(plainDir, 'package-lock.json'), JSON.stringify(LOCK, null, 2));
  fs.mkdirSync(path.join(plainDir, '.git'));
  const noClosureOut = cli(['manifest', 'sign', '--dir', plainDir, '--no-closure']);
  assert(/--no-closure: dependency closure intentionally NOT pinned/.test(noClosureOut), '--no-closure warns loudly:\n' + noClosureOut);
  const ncManifest = JSON.parse(fs.readFileSync(path.join(plainDir, '.gitlive', 'app.manifest'), 'utf8'));
  assert(!(ncManifest.run && ncManifest.run.closure), '--no-closure omits the closure block');
  console.log('OK: --no-closure escape hatch works and warns');

  try { cli(['stop', 'closapp']); } catch { /* already gone */ }
  console.log('\nALL CLOSURE TESTS PASSED');
})().catch((err) => {
  console.error('CLOSURE TEST FAILED:', (err && err.message) || err);
  process.exitCode = 1;
});
