'use strict';
// P1 — docker deploys (compose + Dockerfile): push-time plumbing proven
// against a STUB docker (offline, disposable-test discipline — the suite
// never needs real containers or image pulls). It proves gitlive drives
// docker correctly: build→up on push, down→up ordering on redeploy,
// REAL container state for status, stop/restart semantics, the PORT
// contract, the EXPOSE→run mapping, and the honest safe-mode refusal.

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'gldocker-'));
const binDir = fs.mkdtempSync(path.join(shortTmp, 'gldocker-bin-'));
const stubState = fs.mkdtempSync(path.join(shortTmp, 'gldocker-state-'));
const marker = path.join(stubState, 'running');
const callLog = path.join(stubState, 'calls.log');

// The stub docker: a bash script that records every invocation and fakes the
// container lifecycle with a marker file — compose ps / docker inspect report
// "running" only when the marker exists, exactly like real containers would.
fs.writeFileSync(path.join(binDir, 'docker'), `#!/bin/bash
log() { echo "$*" >> ${JSON.stringify(callLog)}; }
case "$1" in
  compose)
    PROJ=""; SUB=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) PROJ="$2"; shift 2;;
        up|down|build|ps) SUB="$1"; shift; break;;
        *) shift;;
      esac
    done
    case "$SUB" in
      ps) [ -f ${JSON.stringify(marker)} ] && echo "stub-container-1"; exit 0;;
      up) log "up:$PROJ"; touch ${JSON.stringify(marker)}; exit 0;;
      down) log "down:$PROJ"; rm -f ${JSON.stringify(marker)}; exit 0;;
      build) log "build:$PROJ"; exit 0;;
      *) exit 0;;
    esac;;
  inspect) [ -f ${JSON.stringify(marker)} ] && echo "true" || echo "false"; exit 0;;
  run) log "run $4"; touch ${JSON.stringify(marker)}; exit 0;;
  rm) log "rm $3"; rm -f ${JSON.stringify(marker)}; exit 0;;
  *) exit 0;;
esac
`);
fs.chmodSync(path.join(binDir, 'docker'), 0o755);

const env = { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}`, GITLIVE_DOCKER_STUB_STATE: stubState };
function cli(args, cwd) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args, cwd) {
  // env matters: the push's hooks inherit it — fake HOME + the stub docker
  // must ride along or the hooks read the REAL home and call the REAL docker
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}
function registry() {
  return JSON.parse(fs.readFileSync(path.join(home, '.gitlive', 'apps.json'), 'utf8'));
}
function gitAsync(args, cwd) {
  return new Promise((resolve) => {
    const c = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    c.on('close', (code) => resolve(code));
  });
}
function calls() {
  try { return fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}

(async () => {
  // ── 1) compose app: auto-detected, push → build + up, status = REAL state ──
  const proj = fs.mkdtempSync(path.join(shortTmp, 'gldocker-proj-'));
  fs.writeFileSync(path.join(proj, 'compose.yml'), 'services:\n  web:\n    image: busybox\n    ports: ["${PORT}:8080"]\n');
  git(['init', '-q', '-b', 'main'], proj);
  git(['-c', 'user.email=d@x.io', '-c', 'user.name=d', 'add', '.', '-A'], proj);
  git(['-c', 'user.email=d@x.io', '-c', 'user.name=d', 'commit', '-qm', 'v1'], proj);
  const initOut = cli(['init', 'compapp', '--port', '4567', '--yes'], proj);
  assert(/Detected: docker-compose/.test(initOut), 'init must detect the compose stack:\n' + initOut);
  assert(registry().compapp.docker === 'compose', 'the registry records docker=compose');
  const hook = fs.readFileSync(path.join(home, '.gitlive', 'apps', 'compapp.git', 'hooks', 'post-receive'), 'utf8');
  assert(hook.includes('docker compose up -d') && hook.includes('docker compose down'), 'the hook drives compose up/down');
  assert(/PORT="4567" docker compose up -d/.test(hook), 'the hook exports the registered PORT for compose interpolation:\n' + hook.slice(hook.indexOf('PORT='), hook.indexOf('PORT=') + 60));
  git(['push', 'compapp', 'main'], proj);
  const c1 = calls();
  assert(c1.some((l) => l.startsWith('build:')) && c1.some((l) => l.startsWith('up:')), 'push builds then starts:\n' + c1.join('\n'));
  let list = cli(['list'], proj);
  assert(/up  .*compapp \[docker\]/.test(list), 'status reads REAL container state (up):\n' + list);
  const status = cli(['status', 'compapp'], proj);
  assert(/mode: docker \(compose\)/.test(status) && /up \(containers running\)/.test(status), 'status reports docker mode honestly:\n' + status);

  // ── 2) redeploy: down BEFORE up (no container serves rewritten files) ─────
  fs.appendFileSync(path.join(proj, 'compose.yml'), '\n# v2\n');
  git(['-c', 'user.email=d@x.io', '-c', 'user.name=d', 'commit', '-qam', 'v2'], proj);
  git(['push', 'compapp', 'main'], proj);
  const c2 = calls();
  const lastDown = c2.lastIndexOf('down:');
  const lastUp = c2.lastIndexOf('up:');
  assert(lastDown !== -1 && lastUp !== -1 && lastDown < lastUp, 'redeploy stops containers before starting new ones:\n' + c2.join('\n'));

  // ── 3) stop / restart round-trip ──────────────────────────────────────────
  cli(['stop', 'compapp'], proj);
  list = cli(['list'], proj);
  assert(/down  .*compapp/.test(list), 'stop takes the containers down (real state):\n' + list);
  assert(!fs.existsSync(marker), 'the stub marker is gone after stop');
  cli(['restart', 'compapp'], proj);
  list = cli(['list'], proj);
  assert(/up  .*compapp/.test(list), 'restart brings the containers back:\n' + list);

  // ── 4) Dockerfile app: EXPOSE → internal port mapping, inspect-based status ─
  const proj2 = fs.mkdtempSync(path.join(shortTmp, 'gldocker-proj2-'));
  fs.writeFileSync(path.join(proj2, 'Dockerfile'), 'FROM busybox\nEXPOSE 8080\nCMD ["httpd", "-f"]\n');
  git(['init', '-q', '-b', 'main'], proj2);
  git(['-c', 'user.email=d@x.io', '-c', 'user.name=d', 'add', '-A'], proj2);
  git(['-c', 'user.email=d@x.io', '-c', 'user.name=d', 'commit', '-qm', 'v1'], proj2);
  const init2 = cli(['init', 'dockapp', '--port', '4568', '--yes'], proj2);
  assert(/Detected: docker \(Dockerfile\)/.test(init2), 'a lone Dockerfile is detected:\n' + init2);
  const r2 = registry().dockapp;
  assert(r2.docker === 'dockerfile' && String(r2.dockerPort) === '8080', 'EXPOSE is parsed as the internal port');
  assert(/127\.0\.0\.1:4568:8080/.test(r2.startCmd), 'the run mapping uses the public + internal ports:\n' + r2.startCmd);
  git(['push', 'dockapp', 'main'], proj2);
  assert(calls().some((l) => l.startsWith('run dockapp-live')), 'push runs the container:\n' + calls().join('\n'));
  list = cli(['list'], proj2);
  assert(/up  .*dockapp \[docker\]/.test(list), 'inspect-based status reports up:\n' + list);
  cli(['stop', 'dockapp'], proj2);
  assert(calls().includes('rm dockapp-live'), 'stop removes the container');
  assert(cli(['list'], proj2).includes('down'), 'status reports down after stop');

  // ── 4b) docker blue-green (#4): compose slots + health-checked swap ────────
  const proj3 = fs.mkdtempSync(path.join(shortTmp, 'gldocker-proj3-'));
  fs.writeFileSync(path.join(proj3, 'compose.yml'), 'services:\n  web:\n    image: busybox\n    ports: ["${PORT}:8080"]\n');
  git(['init', '-q', '-b', 'main'], proj3);
  git(['-c', 'user.email=d@x.io', '-c', 'user.name=d', 'add', '-A'], proj3);
  git(['-c', 'user.email=d@x.io', '-c', 'user.name=d', 'commit', '-qm', 'v1'], proj3);
  const safeInit = cli(['init', 'safecomp', '--safe', '--port', '4570', '--health', '/health', '--yes'], proj3);
  assert(/Docker safe mode/.test(safeInit), 'compose apps accept --safe with the honest contract:\n' + safeInit);
  const sreg = registry().safecomp;
  assert(sreg.docker === 'compose' && sreg.safe === true && sreg.portA && sreg.portB, 'the registry records docker compose + safe slots');
  // real health servers on both slot ports (the hook probes them)
  const healthA = http.createServer((q, r) => r.end('ok'));
  await new Promise((r) => healthA.listen(sreg.portA, '127.0.0.1', r));
  const healthB = http.createServer((q, r) => r.end('ok'));
  await new Promise((r) => healthB.listen(sreg.portB, '127.0.0.1', r));
  const pushCode = await gitAsync(['push', 'safecomp', 'main'], proj3);
  assert(pushCode === 0, 'the safe push succeeds (health servers answer because the push runs ASYNC — the acme lesson)');
  const safeCalls = calls();
  assert(safeCalls.some((l) => l === 'build:safecomp-b'), 'the new slot builds as its own compose project:\n' + safeCalls.join('\n'));
  assert(safeCalls.some((l) => l === 'up:safecomp-b'), 'the new slot starts as its own compose project:\n' + safeCalls.join('\n'));
  assert(safeCalls.some((l) => l === 'down:safecomp-a'), 'the old slot is taken down after the swap:\n' + safeCalls.join('\n'));
  const slotFile = path.join(home, '.gitlive', 'apps', 'safecomp-run', 'active-slot');
  assert(fs.readFileSync(slotFile, 'utf8').trim() === 'B', 'traffic switched to the health-checked slot B');
  const proxyPid = Number(fs.readFileSync(path.join(home, '.gitlive', 'apps', 'safecomp-run', 'proxy.pid'), 'utf8').trim());
  assert(proxyPid > 0, 'the public proxy runs (same proxy as node safe mode)');
  cli(['stop', 'safecomp'], proj3);
  assert(calls().filter((l) => l === 'down:safecomp-a').length >= 2 && calls().filter((l) => l === 'down:safecomp-b').length >= 1, 'stop downs BOTH slot projects (A twice: swap + stop):\n' + calls().join('\n'));
  healthA.close(); healthB.close();

  // ── 5) honest refusal: Dockerfile-only deploys stay plain for now ────────
  const refused = cli(['init', 'compapp', '--safe', '--port', '4569', '--yes'], proj2);
  assert(/Dockerfile-only/.test(refused), '--safe for a lone Dockerfile is refused with the honest reason:\n' + refused);

  // ── 6) no-port dockerfile init is refused with instructions ───────────────
  const noPort = cli(['init', 'dockapp2', '--yes'], proj2);
  assert(/need --port/.test(noPort), 'dockerfile mode without --port explains itself:\n' + noPort);

  console.log('ALL DOCKER DEPLOY TESTS PASSED');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
