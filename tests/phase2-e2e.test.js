'use strict';
// Phase 2 item 6 — the combined E2E. One scenario, everything wired:
// init → push → mesh add → mesh deploy → state sync → primary dies →
// promote → writes on new primary → re-sync → split-brain → conflict
// ledger → and the CONTROL PLANE serving mesh views of it all (apps meta,
// replica health, conflict ledger over the authenticated API).

const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { execFileSync, spawn } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const homeA = fs.mkdtempSync(path.join(shortTmp, 'glp2-a-'));
const homeB = fs.mkdtempSync(path.join(shortTmp, 'glp2-b-'));
const project = fs.mkdtempSync(path.join(shortTmp, 'glp2-proj-'));

fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'p2app', scripts: { start: 'node server.js' } }, null, 2));
fs.writeFileSync(path.join(project, 'server.js'), 'const http=require("http");const p=Number(process.env.PORT)||44990;http.createServer((q,r)=>r.end("p2 v1")).listen(p,()=>console.log("up "+p));\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
execFileSync('git', ['add', '.'], { cwd: project });
execFileSync('git', ['-c', 'user.email=p2@x.io', '-c', 'user.name=p2', 'commit', '-qm', 'v1'], { cwd: project });

const envA = { ...process.env, HOME: homeA, GITLIVE_CONTROL_DIR: path.join(homeA, '.gitlive', 'control') };
const envB = { ...process.env, HOME: homeB, GITLIVE_CONTROL_DIR: path.join(homeB, '.gitlive', 'control') };
function cli(args, env, cwd) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: cwd || project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd: cwd || project, encoding: 'utf8' });
}
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function killPids(home) {
  try {
    const f = path.join(home, '.gitlive', 'apps', 'p2app-run', 'app.pid');
    if (fs.existsSync(f)) {
      const pid = Number(fs.readFileSync(f, 'utf8').trim());
      try { process.kill(-pid); } catch { try { process.kill(pid); } catch { /* gone */ } }
    }
  } catch { /* ignore */ }
}

(async () => {
  const basePort = 44900 + Math.floor(Math.random() * 200);
  const clientFactory = require(path.join(__dirname, '..', 'gitlive-client'));

  // 1 — init + push on the primary
  const initOut = cli(['init', 'p2app', '--start', 'node server.js', '--install', 'true', '--port', String(basePort), '--yes'], envA);
  assert(/Done\./.test(initOut), 'init:\n' + initOut);
  git(['push', 'p2app', 'main']);
  const commit = git(['rev-parse', 'HEAD']).trim();

  // 2 — mesh add + deploy (policy >= 2)
  cli(['mesh', 'add', 'peer-b', '--home', homeB, '--start', 'PORT=' + (basePort + 1) + ' node server.js'], envA);
  const depOut = cli(['mesh', 'deploy', 'p2app', '--min-nodes', '2'], envA);
  assert(/node "peer-b" ok:/.test(depOut), 'deploy:\n' + depOut);

  // 3 — primary writes real state, sync pushes it to the replica
  const prim = clientFactory({ app: 'p2app', dataDir: path.join(homeA, '.gitlive', 'apps', 'p2app-run', 'data') });
  await prim.db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)');
  await prim.db.exec('INSERT INTO notes (text) VALUES (?)', ['row from primary']);
  await prim.storage.put('docs/plan.txt', Buffer.from('mesh plan'), { contentType: 'text/plain' });
  prim.close();
  const sync1 = cli(['mesh', 'sync', 'p2app'], envA);
  assert(/state synced from self/.test(sync1), 'sync1:\n' + sync1);

  // 4 — primary dies → promote peer-b → writes continue → re-sync
  killPids(homeA);
  await new Promise((r) => setTimeout(r, 300));
  cli(['mesh', 'promote', 'p2app', 'peer-b'], envA);
  const newPrim = clientFactory({ app: 'p2app', dataDir: path.join(homeB, '.gitlive', 'apps', 'p2app-run', 'data') });
  await newPrim.db.exec('INSERT INTO notes (text) VALUES (?)', ['row after failover']);
  newPrim.close();
  const sync2 = cli(['mesh', 'sync', 'p2app'], envA);
  assert(/state synced from peer-b/.test(sync2), 'sync2:\n' + sync2);

  // 5 — split-brain write on the old home, then re-sync → conflict ledger
  const stray = clientFactory({ app: 'p2app', dataDir: path.join(homeA, '.gitlive', 'apps', 'p2app-run', 'data') });
  await stray.storage.put('diverged/x.txt', Buffer.from('stray'), { contentType: 'text/plain' });
  stray.close();
  cli(['mesh', 'sync', 'p2app'], envA);

  // 6 — CONTROL PLANE in the loop: serve from homeA, check mesh views
  const port = await freePort();
  const server = spawn('node', [GITLIVE_JS, 'serve', '--port', String(port), '--no-open'], { env: envA, stdio: ['ignore', 'pipe', 'pipe'] });
  const srvOut = fs.createWriteStream('/tmp/p2-server.log');
  server.stdout.pipe(srvOut); server.stderr.pipe(srvOut);
  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const r = await fetch(base + '/'); if (r.ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  async function req(pathname, method, token, body) {
    const r = await fetch(base + pathname, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  }
  console.log('6c boot: starting');
  await req('/api/auth/register', 'POST', null, { email: 'p2@example.com', password: 'hunter22' });
  console.log('6d login: starting');
  const login = await req('/api/auth/login', 'POST', null, { email: 'p2@example.com', password: 'hunter22' });
  const token = login.data.token;
  const meshApi = await req('/api/mesh', 'GET', token);
  assert(meshApi.data && meshApi.data.present === true, 'mesh registry visible to the control plane');
  console.log('6e apps: starting');
  const apps = await req('/api/apps', 'GET', token);
  const p2 = apps.data.find((a) => a.name === 'p2app');
  assert(p2 && p2.mesh && p2.mesh.meshed === true, 'apps list marks p2app meshed: ' + JSON.stringify(p2 && p2.mesh));
  console.log('6f replicas: starting');
  const reps = await req('/api/apps/p2app/replicas', 'GET', token);
  assert(reps.data.meshed && reps.data.replicas.length === 1 && reps.data.replicas[0].node === 'peer-b' && reps.data.replicas[0].primary === true,
    'replicas endpoint reports peer-b as primary: ' + JSON.stringify(reps.data));
  console.log('6g conflicts: starting');
  const conf = await req('/api/apps/p2app/conflicts', 'GET', token);
  assert(conf.data.meshed && conf.data.entries.length >= 1 && conf.data.entries.some((e) => e.kind === 'local-writes-overwritten'),
    'conflict ledger served over the API: ' + JSON.stringify(conf.data));
  console.log('OK: control plane serves mesh meta + replica health + conflict ledger');
  await new Promise((resolve) => { server.on('exit', resolve); server.kill('SIGTERM'); });

  console.log('OK: init → push → mesh deploy (2 nodes)');
  console.log('OK: state sync primary → replica');
  console.log('OK: failover: primary dies → promote → writes continue → state flows back');
  console.log('OK: split-brain recorded in the D2 conflict ledger');
  console.log('OK: dashboard/API exposes it all (mesh meta, replicas, conflicts)');
  console.log('\nALL PHASE 2 COMBINED E2E TESTS PASSED');
})().catch((err) => {
  console.error('PHASE 2 E2E FAILED:', (err && err.message) || err);
  process.exitCode = 1;
}).finally(() => { killPids(homeA); killPids(homeB); });
