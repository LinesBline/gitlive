'use strict';
// Item 4 — operational reliability: `gitlive restart`.
// 1) plain app: stop → restart brings the SAME code back up (no new commit).
// 2) safe app: kill the public proxy → restart revives it (field finding).
// Real `gitlive init` + real pushes, fake $HOME, disposable style.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glops-'));
const env = { ...process.env, HOME: home };
const plainProj = fs.mkdtempSync(path.join(shortTmp, 'glops-plain-'));
const safeProj = fs.mkdtempSync(path.join(shortTmp, 'glops-safe-'));

function cli(args, cwd) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: cwd || plainProj, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd: cwd || plainProj, encoding: 'utf8' });
}
function commitAll(cwd, msg) {
  git(['add', '.'], cwd);
  git(['-c', 'user.email=o@x.io', '-c', 'user.name=o', 'commit', '-qm', msg], cwd);
}
function mkServer(dir, portExpr) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'opapp', scripts: { start: 'node server.js' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'server.js'), `const http=require("http");const p=Number(process.env.PORT)||${portExpr};http.createServer((q,r)=>r.end("op-ok\\n")).listen(p,()=>console.log("up "+p));\n`);
  git(['init', '-q', '-b', 'main'], dir);
  commitAll(dir, 'v1');
}
function killPid(pid) {
  try { process.kill(-Number(pid)); } catch { try { process.kill(Number(pid)); } catch { /* gone */ } }
}
function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
async function httpOk(port) {
  for (let i = 0; i < 25; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/'); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  // ── 1) plain restart ───────────────────────────────────────────────────
  const p1 = 47000 + Math.floor(Math.random() * 300);
  mkServer(plainProj, p1);
  cli(['init', 'opapp', '--start', 'node server.js', '--install', 'true', '--port', String(p1), '--yes'], plainProj);
  git(['push', 'opapp', 'main'], plainProj);
  assert(await httpOk(p1), 'plain app up after push');
  const runPath = path.join(home, '.gitlive', 'apps', 'opapp-run');
  const pidFile = path.join(runPath, 'app.pid');
  const pidBefore = fs.readFileSync(pidFile, 'utf8').trim();
  cli(['stop', 'opapp'], plainProj);
  assert(!pidAlive(pidBefore), 'stopped');
  const restOut = cli(['restart', 'opapp'], plainProj);
  assert(/restarted \(pid \d+\)/.test(restOut), 'restart output:\n' + restOut);
  assert(await httpOk(p1), 'plain app serves again after restart (same code, no new commit)');
  const pidAfter = fs.readFileSync(pidFile, 'utf8').trim();
  assert(pidAfter !== pidBefore && pidAlive(pidAfter), 'new pid alive');
  console.log('OK: plain restart brings the same code back up (new pid, no commit)');

  // ── 2) safe proxy revival ──────────────────────────────────────────────
  const pub = p1 + 1;
  mkServer(safeProj, 'process.env.PORT');
  cli(['init', 'safep', '--start', 'node server.js', '--install', 'true', '--port', String(pub), '--safe', '--yes'], safeProj);
  git(['push', 'safep', 'main'], safeProj);
  assert(await httpOk(pub), 'safe app public port up after push');
  const safeRun = path.join(home, '.gitlive', 'apps', 'safep-run');
  const proxyPidFile = path.join(safeRun, 'proxy.pid');
  const proxyPid = fs.readFileSync(proxyPidFile, 'utf8').trim();
  killPid(proxyPid); // proxy dies (reboot/crash simulation)
  await new Promise((r) => setTimeout(r, 400));
  assert(!pidAlive(proxyPid), 'proxy is dead');
  const restSafe = cli(['restart', 'safep'], safeProj);
  assert(/proxy revived/.test(restSafe), 'safe restart revives proxy:\n' + restSafe);
  assert(await httpOk(pub), 'public port responds again after proxy revival');
  console.log('OK: safe restart revives a dead public proxy (backend kept running)');

  // ── 3) reboot recovery: gitlive up brings everything back ──────────────
  // simulate a full reboot: kill the plain app pid, the safe slot pid AND
  // the safe proxy pid — then one `gitlive up` must restore the machine.
  killPid(fs.readFileSync(pidFile, 'utf8').trim());                       // opapp (plain)
  killPid(fs.readFileSync(proxyPidFile, 'utf8').trim());                  // safep proxy
  const slotPidFile = path.join(safeRun, 'app-A.pid');
  if (fs.existsSync(slotPidFile)) killPid(fs.readFileSync(slotPidFile, 'utf8').trim()); // safep slot
  await new Promise((r) => setTimeout(r, 500));
  const upOut = cli(['up'], plainProj);
  assert(/opapp: (revived|already up)/.test(upOut) && /safep: (revived|already up)/.test(upOut), 'up reports both apps:\n' + upOut);
  assert(await httpOk(p1), 'plain app serves after gitlive up');
  assert(await httpOk(pub), 'safe app serves after gitlive up');
  const listOut = cli(['list'], plainProj);
  assert(/up\s+opapp/.test(listOut) && /up\s+safep/.test(listOut), 'list shows both apps up:\n' + listOut);
  console.log('OK: gitlive up — one command recovers the whole machine after a reboot');

  // ── 4) OWNER INTENT: a stopped app must never be "repaired" by a helper ──
  // A stopped app and a crashed app look identical on disk (no pid). v4 writes
  // the intent, so the agents can tell them apart instead of fighting the owner.
  cli(['stop', 'opapp'], plainProj);
  const intentFile = path.join(runPath, 'intent.json');
  assert(fs.existsSync(intentFile), 'stopping an app records the owner\'s intent next to it');
  const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
  assert(intent.stopped === true && intent.at, 'the intent says stopped, with a timestamp: ' + JSON.stringify(intent));
  // and it reaches the API the agents and the dashboard read (HOME is set
  // before the require because the module resolves ~/.gitlive once, at load)
  process.env.HOME = home;
  const gl = require(path.join(__dirname, '..', 'gitlive.js'));
  const row = gl.listAppsData().find((a) => a.name === 'opapp');
  assert(row && row.stoppedByOwner === true, 'the app reports stoppedByOwner so no agent restarts it: ' + JSON.stringify(row));
  cli(['restart', 'opapp'], plainProj);
  const cleared = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
  assert(cleared.stopped === false, 'starting the app clears the intent');
  const row2 = gl.listAppsData().find((a) => a.name === 'opapp');
  assert(row2 && row2.stoppedByOwner === false && row2.alive === true, 'and the app is up and no longer marked as deliberately stopped');
  console.log('OK: owner intent — a deliberate stop is recorded, visible, and cleared by a restart');

  console.log('\nALL OPS RELIABILITY TESTS PASSED');
})().catch((err) => {
  console.error('OPS TEST FAILED:', (err && err.message) || err);
  if (err && err.stdout) console.error(String(err.stdout).slice(0, 600));
  if (err && err.stderr) console.error(String(err.stderr).slice(0, 600));
  process.exitCode = 1;
}).finally(() => {
  for (const d of [path.join(home, '.gitlive', 'apps', 'opapp-run'), path.join(home, '.gitlive', 'apps', 'safep-run')]) {
    try {
      const f = path.join(d, 'app.pid');
      if (fs.existsSync(f)) killPid(fs.readFileSync(f, 'utf8').trim());
      const pf = path.join(d, 'proxy.pid');
      if (fs.existsSync(pf)) killPid(fs.readFileSync(pf, 'utf8').trim());
    } catch { /* ignore */ }
  }
});
