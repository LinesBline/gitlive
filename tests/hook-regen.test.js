'use strict';
// `gitlive hook-regen <app>`: bring an EXISTING app's deploy hooks up to the
// current pipeline without touching the running app.
//
// Field finding (Sept 2026): real apps created by older gitlive builds keep
// their ORIGINAL generated hooks forever — the hook that runs on the next
// push is the hook that was written at init time. On the machine where this
// was found, one safe-mode app's hook carried _record-deploy only and one
// plain-mode app's hook carried NONE of the modern chain.
// So deploys to those apps silently skip the F1 closure gate, attestation
// fan-out, and owner-signed deploy tags even though current gitlive has them.
//
// This suite reproduces that drift (real `gitlive init`, then the era-stale
// signature is reconstructed by stripping the modern chain from the written
// hook, and the safe app's registry is reverted to the pre-persistence shape
// with no slot ports), then drives `hook-regen` through: rewrite, one-
// generation backup, idempotence, --dry-run, registry backfill, and the
// negative paths. Nothing is ever pushed: hooks are inert until a push, and
// the assertion that deploy.log was never created guards exactly that.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glregen-'));
const env = { ...process.env, HOME: home };

const appsDir = path.join(home, '.gitlive', 'apps');
let plainProj = null;

function cli(args, cwd) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: cwd || plainProj, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function cliFail(args, cwd) {
  let out = '';
  let code = 0;
  try {
    out = cli(args, cwd);
  } catch (err) {
    code = err.status || 1;
    out = String(err.stdout || '') + String(err.stderr || '');
  }
  return { code, out };
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function commitAll(cwd, msg) {
  git(['add', '.'], cwd);
  git(['-c', 'user.email=o@x.io', '-c', 'user.name=o', 'commit', '-qm', msg], cwd);
}
function mkServer(dir, portExpr) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hkrg', scripts: { start: 'node server.js' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'server.js'), `const http=require("http");const p=Number(process.env.PORT)||${portExpr};http.createServer((q,r)=>r.end("hkrg-ok\\n")).listen(p,()=>console.log("up "+p));\n`);
  git(['init', '-q', '-b', 'main'], dir);
  commitAll(dir, 'v1');
}

// Modern-chain markers as they appear in CURRENT generated hooks.
const MODERN = ['_closure-gate', '_attest-deploy', '_deploy-tag', '_record-deploy', 'CLOSURE_', 'PINNED'];
const eraStrip = (text) => text.split('\n').filter((l) => !MODERN.some((t) => l.includes(t))).join('\n');
const hookPathOf = (name) => path.join(appsDir, name + '.git', 'hooks', 'post-receive');
const hookOf = (name) => fs.readFileSync(hookPathOf(name), 'utf8');
const hasModern = (text) => ['_closure-gate', '_attest-deploy', '_deploy-tag', '_record-deploy'].every((t) => text.includes(t));

function killPid(pid) {
  try { process.kill(-Number(pid)); } catch { try { process.kill(Number(pid)); } catch { /* gone */ } }
}
function cleanup() {
  for (const f of fs.readdirSync(appsDir)) {
    const pidFile = path.join(appsDir, f, 'proxy.pid');
    if (fs.existsSync(pidFile)) killPid(fs.readFileSync(pidFile, 'utf8').trim());
  }
}

(async () => {
  // ── 1) plain app: era-stale hook → regen restores the full chain ─────────
  plainProj = fs.mkdtempSync(path.join(shortTmp, 'glregen-plain-'));
  const p1 = 47000 + Math.floor(Math.random() * 500);
  mkServer(plainProj, p1);
  cli(['init', 'rgplain', '--start', 'node server.js', '--install', 'true', '--port', String(p1), '--yes'], plainProj);

  const oldPlain = hookOf('rgplain');
  assert(hasModern(oldPlain), 'fresh init hook must carry the full modern chain (test premise)');
  const stalePlain = eraStrip(oldPlain);
  fs.writeFileSync(hookPathOf('rgplain'), stalePlain);
  assert(!hasModern(stalePlain) && !stalePlain.includes('CLOSURE_'), 'era-stale plain hook must lack the modern chain (test premise)');

  const regenOut = cli(['hook-regen', 'rgplain'], plainProj);
  assert(/post-receive rewritten/.test(regenOut), 'regen must report the rewrite:\n' + regenOut);
  assert(hasModern(hookOf('rgplain')), 'plain hook must carry the modern chain after regen');
  assert(/\+ F1 dependency-closure gate/.test(regenOut), 'regen must list the closure gate as added:\n' + regenOut);
  assert(/\+ owner-signed deploy tags/.test(regenOut), 'regen must list deploy tags as added:\n' + regenOut);
  assert(/\+ attestation fan-out to mesh members/.test(regenOut), 'regen must list attestation as added:\n' + regenOut);
  assert(/\+ deploy history recording/.test(regenOut), 'regen must list history recording as added:\n' + regenOut);
  assert(fs.existsSync(hookPathOf('rgplain') + '.previous'), 'previous hook must be preserved one generation deep');
  assert(fs.readFileSync(hookPathOf('rgplain') + '.previous', 'utf8') === stalePlain, 'backup must be byte-identical to the pre-regen hook');
  assert(hookOf('rgplain').includes(`PORT="${p1}" GITLIVE_DATA_DIR`), 'plain hook must export the registered port (PORT contract holds in plain mode)');

  const again = cli(['hook-regen', 'rgplain'], plainProj);
  assert(/nothing to change/.test(again), 'second regen must be a no-op:\n' + again);
  assert(hookOf('rgplain').length > 0, 'hook still present after no-op regen');
  const prePath = path.join(appsDir, 'rgplain.git', 'hooks', 'pre-receive');
  assert(fs.readFileSync(prePath, 'utf8').includes(GITLIVE_JS), 'pre-receive must bind to the current gitlive.js after regen');
  const preMtime = fs.statSync(prePath).mtimeMs;
  cli(['hook-regen', 'rgplain'], plainProj);
  assert(fs.statSync(prePath).mtimeMs === preMtime, 'a no-op regen must not rewrite the pre-receive hook (regens on up-to-date apps are read-only)');
  console.log('OK: plain app — era-stale hook upgraded, one-generation backup kept, regen idempotent + read-only');

  // ── 2) safe app: old-registry shape (no slot ports) + --dry-run first ────
  const safeProj = fs.mkdtempSync(path.join(shortTmp, 'glregen-safe-'));
  const pub = p1 + 1;
  mkServer(safeProj, 'process.env.PORT');
  cli(['init', 'rgsafe', '--start', 'node server.js', '--install', 'true', '--port', String(pub), '--safe', '--health', '/health', '--yes'], safeProj);

  // Revert the registry to the shape apps created before slot ports were
  // persisted (the pre-persistence-era registry shape): no portA/portB/publicPort.
  const regJson = path.join(home, '.gitlive', 'apps.json');
  const reg = JSON.parse(fs.readFileSync(regJson, 'utf8'));
  delete reg.rgsafe.portA; delete reg.rgsafe.portB; delete reg.rgsafe.publicPort;
  fs.writeFileSync(regJson, JSON.stringify(reg, null, 2));

  const staleSafe = eraStrip(hookOf('rgsafe'));
  fs.writeFileSync(hookPathOf('rgsafe'), staleSafe);
  assert(!hasModern(staleSafe), 'era-stale safe hook must lack the modern chain (test premise)');
  const headerPortA = Number(staleSafe.split('\n').find((l) => l.startsWith('PORT_A=')).split('=')[1]);
  const headerPortB = Number(staleSafe.split('\n').find((l) => l.startsWith('PORT_B=')).split('=')[1]);
  const proxyBefore = fs.readFileSync(path.join(appsDir, 'rgsafe-run', 'proxy.js'), 'utf8');
  const stateBefore = fs.readFileSync(path.join(appsDir, 'rgsafe-run', 'active-slot'), 'utf8');

  const dry = cli(['hook-regen', 'rgsafe', '--dry-run'], safeProj);
  assert(/would rewrite/.test(dry) && /\(nothing written\)/.test(dry), 'dry-run must announce without writing:\n' + dry);
  assert(hookOf('rgsafe') === staleSafe, 'dry-run must leave the hook untouched');

  const regenSafe = cli(['hook-regen', 'rgsafe'], safeProj);
  assert(/post-receive rewritten/.test(regenSafe), 'safe regen must report the rewrite:\n' + regenSafe);
  assert(hasModern(hookOf('rgsafe')), 'safe hook must carry the modern chain after regen');
  assert(fs.readFileSync(hookPathOf('rgsafe') + '.previous', 'utf8') === staleSafe, 'safe backup must be byte-identical to the pre-regen hook');
  assert(!fs.existsSync(path.join(appsDir, 'rgsafe-run', 'deploy.log')), 'regen must not deploy anything — deploy.log must not exist');

  // Registry backfill: slot ports + public port restored from the live hook.
  const reg2 = JSON.parse(fs.readFileSync(regJson, 'utf8'));
  assert(reg2.rgsafe.portA === headerPortA && reg2.rgsafe.portB === headerPortB, `safe registry must be backfilled with the hook's slot ports (${headerPortA}/${headerPortB})`);
  assert(reg2.rgsafe.publicPort === Number(pub), 'safe registry must be backfilled with the public port');
  assert(reg2.rgsafe.healthPath === '/health', 'existing healthPath must be preserved');
  assert(fs.readFileSync(path.join(appsDir, 'rgsafe-run', 'proxy.js'), 'utf8') === proxyBefore, 'regen must not touch the proxy script');
  assert(fs.readFileSync(path.join(appsDir, 'rgsafe-run', 'active-slot'), 'utf8') === stateBefore, 'regen must not touch the active-slot state');
  const againSafe = cli(['hook-regen', 'rgsafe'], safeProj);
  assert(/nothing to change/.test(againSafe), 'second safe regen must be a no-op:\n' + againSafe);
  console.log('OK: safe app — old-registry shape repaired, dry-run writes nothing, proxy/slot untouched');

  // ── 3) negative paths ─────────────────────────────────────────────────────
  const unknown = cliFail(['hook-regen', 'nosuchapp'], plainProj);
  assert(unknown.code !== 0 && /No app named "nosuchapp"/.test(unknown.out), 'unknown app must fail loudly');
  const noArg = cliFail(['hook-regen'], plainProj);
  assert(noArg.code !== 0 && /Usage: gitlive hook-regen/.test(noArg.out), 'missing app name must print usage');

  // connect-mode app: handcraft a registry entry — regen must refuse.
  const reg3 = JSON.parse(fs.readFileSync(regJson, 'utf8'));
  reg3.connapp = { mode: 'connect', cwd: '/tmp/unused', runPath: path.join(appsDir, 'connapp-run') };
  fs.writeFileSync(regJson, JSON.stringify(reg3, null, 2));
  const conn = cliFail(['hook-regen', 'connapp'], plainProj);
  assert(conn.code !== 0 && /connect-mode/.test(conn.out), 'connect-mode apps must be refused:\n' + conn.out);
  console.log('OK: negatives — unknown app, missing arg, connect-mode refusal');

  // ── 4) cleanup: stop the safe app's proxy, nothing left running ──────────
  cleanup();
  console.log('ALL HOOK-REGEN TESTS PASSED');
})().catch((err) => {
  cleanup();
  console.error(err.message);
  process.exit(1);
});
