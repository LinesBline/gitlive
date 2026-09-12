'use strict';
// Item 10 — gitlive daemon ensure: boot supervision v0. A REAL detached
// supervisor under a fake $HOME revives CRASHED processes (pidfile exists,
// process gone) and leaves stopped apps alone. Plain-app revive + safe-mode
// proxy revive + single-instance ensure + stop, all through real CLI
// children, same discipline as every suite.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const fakeHome = fs.mkdtempSync(path.join(shortTmp, 'gldaemon-home-'));
const hl = path.join(fakeHome, '.gitlive');
const env = {
  ...process.env,
  HOME: fakeHome,
  GITLIVE_DAEMON_TICK_MS: '400',
  GITLIVE_DAEMON_COOLDOWN_MS: '1200',
};

function cli(args) {
  return execFileSync('node', [GITLIVE_JS, ...args], { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function cliFail(args) {
  try { cli(args); return null; } catch (err) { return String(err.stdout || '') + String(err.stderr || ''); }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* noop */ }
}
function waitFor(cond, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (cond()) return; } catch { /* keep polling */ }
    sleep(200);
  }
  throw new Error('TIMEOUT waiting for: ' + what);
}

// guaranteed-dead pid: a background `sleep` that has already exited
function deadPid() {
  return execFileSync('sh', ['-c', 'sleep 0.3 & echo $!'], { encoding: 'utf8' }).trim();
}

function registerApp(name, { safe, extra } = {}) {
  const runPath = path.join(hl, 'apps', name + '-run');
  const live = path.join(runPath, 'live');
  fs.mkdirSync(live, { recursive: true });
  // a real long-lived process so "alive" is a truthful check
  fs.writeFileSync(path.join(live, 'server.js'), "require('node:http').createServer((q, s) => s.end('ok')).listen(0);\nsetInterval(() => {}, 1000);\n");
  if (safe) {
    // gitlive proxies read PUBLIC_PORT + the slots from their env, but the
    // daemon only restarts the recorded process — a self-contained stand-in
    // with a pid file proves the revive path without any slot machinery.
    fs.writeFileSync(path.join(runPath, 'proxy.js'), "require('node:http').createServer((q, s) => s.end('ok')).listen(0);\nsetInterval(() => {}, 1000);\n");
  }
  const regPath = path.join(hl, 'apps.json');
  const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')) : {};
  reg[name] = {
    cwd: live,
    runPath,
    barePath: path.join(hl, 'apps', name + '.git'),
    installCmd: null,
    startCmd: 'node server.js',
    port: '0',
    safe: Boolean(safe),
    createdAt: new Date().toISOString(),
    ...(extra || {}),
  };
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  fs.writeFileSync(path.join(runPath, 'deploy.log'), '');
  return runPath;
}

(async () => {
  // plain app, "crashed" (dead pidfile) → the supervisor must restart it
  const plainRun = registerApp('crashy');
  const crashPid = deadPid();
  fs.writeFileSync(path.join(plainRun, 'app.pid'), crashPid + '\n');

  // safe app, dead proxy pidfile → proxy revive path
  const safeRun = registerApp('proxyapp', { safe: true });
  const proxyCrash = deadPid();
  fs.writeFileSync(path.join(safeRun, 'proxy.pid'), proxyCrash + '\n');

  // a third app that was cleanly STOPPED (no pidfile) must stay down
  registerApp('stoppedapp');

  // 1 — ensure starts one detached supervisor and is idempotent
  const up = cli(['daemon', 'ensure']);
  assert(/daemon supervisor up \(pid \d+\)/.test(up), 'ensure output:\n' + up);
  const pidFile = path.join(hl, 'daemon.pid');
  assert(fs.existsSync(pidFile) && /^\d+$/.test(fs.readFileSync(pidFile, 'utf8').trim()), 'daemon.pid written');
  const again = cli(['daemon', 'ensure']);
  assert(/already running \(pid \d+\)/.test(again), 'second ensure reuses the supervisor:\n' + again);
  const pid = fs.readFileSync(pidFile, 'utf8').trim();
  assert(alive(pid), 'supervisor session leader alive');
  console.log('OK: daemon ensure — one detached supervisor, re-ensure reuses it');

  // 2 — the supervisor revives the crashed plain app
  waitFor(() => {
    const p = fs.readFileSync(path.join(plainRun, 'app.pid'), 'utf8').trim();
    return p !== crashPid && alive(p);
  }, 'crashed plain app restarted with a live new pid');
  const deployLog = fs.readFileSync(path.join(plainRun, 'deploy.log'), 'utf8');
  assert(/restart: stopped old, started pid \d+/.test(deployLog), 'revive went through the real restart path:\n' + deployLog.slice(-400));
  console.log('OK: supervisor revived the crashed plain app via the real restart path');

  // 3 — safe app's dead proxy revived
  waitFor(() => {
    const p = fs.readFileSync(path.join(safeRun, 'proxy.pid'), 'utf8').trim();
    return p !== proxyCrash && alive(p);
  }, 'safe-mode proxy revived');
  const safeLog = fs.readFileSync(path.join(safeRun, 'deploy.log'), 'utf8');
  assert(/proxy revived/.test(safeLog), 'safe revive log line:\n' + safeLog.slice(-300));
  console.log('OK: supervisor revived the dead public proxy (safe mode)');

  // 4 — the cleanly stopped app stays stopped (no pidfile = user intent)
  sleep(1500); // let a few ticks pass
  assert(!fs.existsSync(path.join(path.join(hl, 'apps', 'stoppedapp-run'), 'app.pid')), 'stopped app untouched by supervision');
  const daemonLog = fs.readFileSync(path.join(hl, 'daemon.log'), 'utf8');
  assert(!/revive stoppedapp/.test(daemonLog), 'no revive attempt for the stopped app:\n' + daemonLog.slice(-300));
  console.log('OK: stopped apps stay stopped — supervision only revives crashes');

  // 5 — status + stop
  const st = cli(['daemon', 'status']);
  assert(new RegExp('running \\(pid ' + pid + '\\)').test(st), 'status output:\n' + st);
  const stopOut = cli(['daemon', 'stop']);
  assert(/daemon supervisor stopped/.test(stopOut), 'stop output:\n' + stopOut);
  assert(!fs.existsSync(pidFile), 'pidfile removed on stop');
  const st2 = cli(['daemon', 'status']);
  assert(/NOT running/.test(st2), 'status after stop:\n' + st2);
  console.log('OK: daemon status + stop — supervisor gone, pidfile cleaned');

  // cleanup: apps started by the supervisor are still running (by design) —
  // stop them so the fake home dies quietly
  for (const name of ['crashy', 'proxyapp']) {
    try { cli(['stop', name]); } catch { /* already gone */ }
  }
  try { cli(['daemon', 'stop']); } catch { /* already stopped */ }
  console.log('\nALL DAEMON TESTS PASSED');
})().catch((err) => {
  console.error('DAEMON TEST FAILED:', (err && err.message) || err);
  process.exitCode = 1;
});
