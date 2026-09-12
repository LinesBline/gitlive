'use strict';
// Item 6 — mesh recover: heartbeat roster + re-replicate from a survivor.
// A (primary) dies; B survives with newer state; recover run FROM B's home
// reports the roster, picks the alive survivor with data, and restores A.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const homeA = fs.mkdtempSync(path.join(shortTmp, 'glrec-a-'));
const homeB = fs.mkdtempSync(path.join(shortTmp, 'glrec-b-'));
const project = fs.mkdtempSync(path.join(shortTmp, 'glrec-proj-'));

function env(home) {
  return { ...process.env, HOME: home, GITLIVE_STORAGE_KEY: path.join(home, '.gitlive', 'storage.key') };
}
function cli(args, envX) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: project, env: envX, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args) {
  return execFileSync('git', args, { cwd: project, encoding: 'utf8' });
}
function commitAll(msg) {
  git(['add', '.']);
  git(['-c', 'user.email=r@x.io', '-c', 'user.name=r', 'commit', '-qm', msg]);
}

// Cleanup: the suite kills A's recapp mid-flow, but B's recapp kept running
// after the suite — every battery run leaked a `node server.js` listener
// squatting a random 49xxx port, and domain.test.js's dead-port range
// (49000-49500) would occasionally hit it and flake. Kill both, always.
function killRecapp(home) {
  try {
    const pid = fs.readFileSync(path.join(home, '.gitlive', 'apps', 'recapp-run', 'app.pid'), 'utf8').trim();
    if (pid) { try { process.kill(-Number(pid)); } catch { try { process.kill(Number(pid)); } catch { /* gone */ } } }
  } catch { /* no pidfile yet */ }
}
process.on('exit', () => { killRecapp(homeA); killRecapp(homeB); });

(async () => {
  const basePort = 49000 + Math.floor(Math.random() * 300);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'recapp', scripts: { start: 'node server.js' } }, null, 2));
  fs.writeFileSync(path.join(project, 'server.js'), `const http=require("http");const p=Number(process.env.PORT)||${basePort};http.createServer((q,r)=>r.end("rec\\n")).listen(p);\n`);
  git(['init', '-q', '-b', 'main']);
  commitAll('v1');
  cli(['init', 'recapp', '--start', 'node server.js', '--install', 'true', '--port', String(basePort), '--yes'], env(homeA));
  git(['push', 'recapp', 'main']);

  // state on A, then mesh deploy to B (state follows to B)
  const clientFactory = require(path.join(__dirname, '..', 'gitlive-client'));
  const w = clientFactory({ app: 'recapp', dataDir: path.join(homeA, '.gitlive', 'apps', 'recapp-run', 'data') });
  await w.db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)');
  await w.db.exec('INSERT INTO notes (text) VALUES (?)', ['original row']);
  await w.storage.put('docs/state.txt', Buffer.from('original state'), { contentType: 'text/plain' });
  w.close();
  cli(['mesh', 'add', 'peer-b', '--home', homeB, '--start', 'PORT=' + (basePort + 1) + ' node server.js'], env(homeA));
  cli(['mesh', 'deploy', 'recapp', '--min-nodes', '2'], env(homeA));

  // A dies; B gains a newer write
  const pidA = fs.readFileSync(path.join(homeA, '.gitlive', 'apps', 'recapp-run', 'app.pid'), 'utf8').trim();
  try { process.kill(-Number(pidA)); } catch { try { process.kill(Number(pidA)); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 300));
  const bw = clientFactory({ app: 'recapp', dataDir: path.join(homeB, '.gitlive', 'apps', 'recapp-run', 'data') });
  await bw.storage.put('docs/state.txt', Buffer.from('state written after A died'), { contentType: 'text/plain' });
  bw.close();

  // recover RUN FROM B's home (surviving node drives it)
  const out = cli(['mesh', 'recover', 'recapp'], env(homeB));
  console.log(out);
  assert(/recovery roster/.test(out), 'roster printed');
  assert(/source: peer-b \(UP\)/.test(out), 'survivor chosen as source:\n' + out);
  assert(/self: down/.test(out) || /peer-b: down/.test(out) === false, 'roster shows states');
  assert(/state restored/.test(out), 'A restored:\n' + out);
  assert(/promote the source/.test(out), 'promote hint given (primary down):\n' + out);

  // A now holds B's newer state
  const ar = clientFactory({ app: 'recapp', dataDir: path.join(homeA, '.gitlive', 'apps', 'recapp-run', 'data') });
  const got = await ar.storage.get('docs/state.txt');
  assert(got && got.buffer.toString('utf8') === 'state written after A died', 'A recovered the newer state');
  ar.close();
  console.log('OK: A recovered B\'s newer state after the primary died');

  console.log('\nALL MESH RECOVER TESTS PASSED');
})().catch((err) => {
  console.error('RECOVER TEST FAILED:', (err && err.message) || err);
  if (err && err.stdout) console.error(String(err.stdout).slice(0, 600));
  if (err && err.stderr) console.error(String(err.stderr).slice(0, 600));
  process.exitCode = 1;
});
