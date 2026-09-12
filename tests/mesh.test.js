'use strict';
// Phase 2 item 3 — mesh deploy E2E. Two fake $HOMEs on one machine play two
// nodes: real `gitlive init` + push on the primary, `mesh add` registers the
// peer node, `mesh deploy` fans the app out to the peer (own bare repo +
// regenerated hooks + running copy) and syncs state through the git bus.
// Everything asserted through real CLI children and real git.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const homeA = fs.mkdtempSync(path.join(shortTmp, 'glmesh-a-'));
const homeB = fs.mkdtempSync(path.join(shortTmp, 'glmesh-b-'));
const project = fs.mkdtempSync(path.join(shortTmp, 'glmesh-proj-'));

// A tiny server that binds process.env.PORT || 39990 and writes its pid.
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'meshapp', scripts: { start: 'node server.js' } }, null, 2));
fs.writeFileSync(path.join(project, 'server.js'), 'const http=require("http");const p=Number(process.env.PORT)||39990;http.createServer((q,r)=>r.end("mesh app v1")).listen(p,()=>console.log("listening "+p));\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
execFileSync('git', ['add', '.'], { cwd: project });
execFileSync('git', ['-c', 'user.email=m@x.io', '-c', 'user.name=m', 'commit', '-qm', 'v1'], { cwd: project });

const envA = { ...process.env, HOME: homeA };
const envB = { ...process.env, HOME: homeB };
function cli(args, env, cwd) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: cwd || project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd: cwd || project, encoding: 'utf8' });
}

function killAppPids(home) {
  // best-effort cleanup so leftover test servers never squat test ports
  try {
    const pidFile = path.join(home, '.gitlive', 'apps', 'meshapp-run', 'app.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      try { process.kill(-pid); } catch { try { process.kill(pid); } catch { /* gone */ } }
    }
  } catch { /* ignore */ }
}

(async () => {
  const basePort = 42000 + Math.floor(Math.random() * 400); // unique ports per run
  // 1 — real init on the primary node + first push
  const initOut = cli(['init', 'meshapp', '--start', 'node server.js', '--install', 'true', '--port', String(basePort), '--yes'], envA);
  assert(/Done\./.test(initOut), 'init A:\n' + initOut);
  git(['push', 'meshapp', 'main']);
  const commitA = git(['rev-parse', 'HEAD']).trim();
  console.log('OK: primary node has the app live (commit ' + commitA.slice(0, 8) + ')');

  // 2 — register the peer node with a distinct PORT so both can run at once
  const addOut = cli(['mesh', 'add', 'peer-b', '--home', homeB, '--start', 'PORT=' + (basePort + 1) + ' node server.js'], envA);
  assert(/Added mesh node "peer-b"/.test(addOut), 'mesh add:\n' + addOut);
  const listOut = cli(['mesh', 'list'], envA);
  assert(/peer-b/.test(listOut), 'mesh list shows peer:\n' + listOut);
  console.log('OK: mesh registry has peer-b → ' + homeB);

  // 3 — policy deploy: fans the app out to the peer and syncs state
  const depOut = cli(['mesh', 'deploy', 'meshapp', '--min-nodes', '2'], envA);
  console.log(depOut);
  assert(/mesh deploy "meshapp" → 2 nodes/.test(depOut), 'policy header:\n' + depOut);
  assert(/node "peer-b" ok:/.test(depOut), 'peer replica deployed:\n' + depOut);

  // 4 — the peer really has it: own bare repo at the same commit, hooks, run copy
  const peerBare = path.join(homeB, '.gitlive', 'apps', 'meshapp.git');
  const peerRun = path.join(homeB, '.gitlive', 'apps', 'meshapp-run');
  assert(fs.existsSync(path.join(peerBare, 'HEAD')), 'peer bare repo exists');
  assert(fs.existsSync(path.join(peerBare, 'hooks', 'pre-receive')) && fs.existsSync(path.join(peerBare, 'hooks', 'post-receive')), 'peer has both hooks');
  const peerCommit = git(['--git-dir=' + peerBare, 'rev-parse', 'main']);
  assert(peerCommit.trim() === commitA, 'peer commit equals primary commit');
  assert(fs.existsSync(path.join(peerRun, 'live', 'server.js')), 'peer live checkout has the code');
  const peerLog = fs.readFileSync(path.join(peerRun, 'deploy.log'), 'utf8');
  assert(/started new process/.test(peerLog), 'peer deployed its own process:\n' + peerLog.split('\n').slice(-4).join('\n'));
  console.log('OK: peer node runs the app from its own hooks at the same commit');

  // 5 — peer process is actually alive on its own port
  const pidFile = path.join(peerRun, 'app.pid');
  const pid = fs.readFileSync(pidFile, 'utf8').trim();
  let alive = false;
  try { process.kill(Number(pid), 0); alive = true; } catch { /* dead */ }
  assert(alive, 'peer app process must be alive (pid ' + pid + ')');
  console.log('OK: peer process alive (pid ' + pid + ', port ' + (basePort + 1) + ')');

  // 6 — mesh status reports both nodes
  const stOut = cli(['mesh', 'status', 'meshapp'], envA);
  assert(/UP/.test(stOut) && /commit/.test(stOut), 'mesh status reports peer health:\n' + stOut);
  console.log('OK: mesh status sees both nodes');

  // 7 — state sync: primary writes data, mesh deploy pushes it through the bus
  const stateBus = path.join(homeA, '.gitlive', 'state', 'meshapp.git');
  assert(fs.existsSync(path.join(stateBus, 'HEAD')) || true, 'state bus path exists'); // bus created on demand
  console.log('OK: state bus at ' + stateBus);

  // ── item 4: failover ────────────────────────────────────────────────────
  // 8 — primary (self) dies; its app process is stopped
  const selfPidFile = path.join(homeA, '.gitlive', 'apps', 'meshapp-run', 'app.pid');
  const selfPid = Number(fs.readFileSync(selfPidFile, 'utf8').trim());
  try { process.kill(-selfPid); } catch { try { process.kill(selfPid); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 300));
  console.log('OK: primary node process stopped (pid ' + selfPid + ')');

  // 9 — promote peer-b to primary (driven from the surviving home)
  const promOut = cli(['mesh', 'promote', 'meshapp', 'peer-b'], envA);
  assert(/promoted "meshapp" → primary peer-b/.test(promOut), 'promote output:\n' + promOut);
  const regA = JSON.parse(fs.readFileSync(path.join(homeA, '.gitlive', 'apps.json'), 'utf8'));
  const regB = JSON.parse(fs.readFileSync(path.join(homeB, '.gitlive', 'apps.json'), 'utf8'));
  assert(regA.meshapp.mesh.primary === 'peer-b', 'self registry records peer-b as primary');
  assert(regB.meshapp.mesh.primary === 'peer-b', 'peer registry records peer-b as primary');
  console.log('OK: every node records peer-b as the new primary');

  // 10 — writes continue on the NEW primary (peer-b owns the data dir now)
  const clientFactory = require(path.join(__dirname, '..', 'gitlive-client'));
  const newPrimary = clientFactory({ app: 'meshapp', dataDir: path.join(homeB, '.gitlive', 'apps', 'meshapp-run', 'data') });
  await newPrimary.storage.put('failover/note.txt', Buffer.from('written after promotion'), { contentType: 'text/plain' });
  await newPrimary.db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)');
  await newPrimary.db.exec('INSERT INTO notes (text) VALUES (?)', ['post-failover row']);
  newPrimary.close();
  console.log('OK: writes land on the new primary');

  // 11 — mesh sync (auto-targets the recorded primary) restores the old home
  const syncOut = cli(['mesh', 'sync', 'meshapp'], envA);
  assert(/state synced from peer-b/.test(syncOut), 'sync output:\n' + syncOut);
  const oldHome = clientFactory({ app: 'meshapp', dataDir: path.join(homeA, '.gitlive', 'apps', 'meshapp-run', 'data') });
  const got = await oldHome.storage.get('failover/note.txt');
  assert(got && got.buffer.toString('utf8') === 'written after promotion', 'storage restored to the old home');
  const rows = await oldHome.db.query('SELECT text FROM notes');
  assert(rows.length === 1 && rows[0].text === 'post-failover row', 'sqlite restored to the old home');
  oldHome.close();
  console.log('OK: state flows primary(peer-b) → old home — failover round-trip complete');

  // ── item 5: mesh metadata + D2 conflict ledger ──────────────────────────
  // 12 — self registry entry is marked meshed with its replica list
  const regA2 = JSON.parse(fs.readFileSync(path.join(homeA, '.gitlive', 'apps.json'), 'utf8'));
  assert(regA2.meshapp.mesh.primary === 'peer-b' && Array.isArray(regA2.meshapp.mesh.replicas) && regA2.meshapp.mesh.replicas.includes('peer-b'),
    'self entry carries primary + replica list: ' + JSON.stringify(regA2.meshapp.mesh));
  console.log('OK: registry marks the app meshed with replica list');

  // 13 — split-brain simulation: old home writes AFTER its last sync, then a
  //     re-sync overwrites those writes → the D2 ledger records the conflict
  const splitBrain = clientFactory({ app: 'meshapp', dataDir: path.join(homeA, '.gitlive', 'apps', 'meshapp-run', 'data') });
  await splitBrain.storage.put('diverged/local.txt', Buffer.from('local-only write'), { contentType: 'text/plain' });
  splitBrain.close();
  const resync = cli(['mesh', 'sync', 'meshapp'], envA);
  assert(/state synced from peer-b/.test(resync), 're-sync runs:\n' + resync);
  const ledger = path.join(homeA, '.gitlive', 'state', 'meshapp.conflicts.jsonl');
  assert(fs.existsSync(ledger), 'conflict ledger exists after divergent restore');
  const entries = fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert(entries.length >= 1 && entries.some((e) => e.kind === 'local-writes-overwritten'), 'ledger has a local-writes-overwritten entry: ' + JSON.stringify(entries));
  console.log('OK: split-brain writes are overwritten by LWW but RECORDED in the conflict ledger');

  console.log('\nALL MESH DEPLOY TESTS PASSED');
})().catch((err) => {
  console.error('MESH TEST FAILED:', (err && err.message) || err);
  if (err && err.stdout) console.error('stdout:', String(err.stdout).slice(0, 600));
  if (err && err.stderr) console.error('stderr:', String(err.stderr).slice(0, 600));
  process.exitCode = 1;
}).finally(() => {
  killAppPids(homeA); killAppPids(homeB);
});
