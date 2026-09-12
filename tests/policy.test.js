'use strict';
// Item 4 — per-app owner-key storage policy through the mesh. Deploy with
// --storage owner-key: bus holds ciphertext; replicas WITH their own storage
// key restore and serve the data; a keyless replica keeps ciphertext only.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const homeA = fs.mkdtempSync(path.join(shortTmp, 'glpol-a-'));
const homeB = fs.mkdtempSync(path.join(shortTmp, 'glpol-b-'));
const homeC = fs.mkdtempSync(path.join(shortTmp, 'glpol-c-'));
const project = fs.mkdtempSync(path.join(shortTmp, 'glpol-proj-'));

const envA = { ...process.env, HOME: homeA, GITLIVE_STORAGE_KEY: path.join(homeA, '.gitlive', 'storage.key') };
const envB = { ...process.env, HOME: homeB, GITLIVE_STORAGE_KEY: path.join(homeB, '.gitlive', 'storage.key') };
const envC = { ...process.env, HOME: homeC, GITLIVE_STORAGE_KEY: path.join(homeC, '.gitlive', 'storage.key') };

function cli(args, env) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: project, env: env || envA, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args) {
  return execFileSync('git', args, { cwd: project, encoding: 'utf8' });
}
function commitAll(msg) {
  git(['add', '.']);
  git(['-c', 'user.email=p@x.io', '-c', 'user.name=p', 'commit', '-qm', msg]);
}

(async () => {
  const basePort = 48000 + Math.floor(Math.random() * 300);
  // app on A
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'polapp', scripts: { start: 'node server.js' } }, null, 2));
  fs.writeFileSync(path.join(project, 'server.js'), `const http=require("http");const p=Number(process.env.PORT)||${basePort};http.createServer((q,r)=>r.end("pol\\n")).listen(p);\n`);
  git(['init', '-q', '-b', 'main']);
  commitAll('v1');
  cli(['init', 'polapp', '--start', 'node server.js', '--install', 'true', '--port', String(basePort), '--yes'], envA);
  git(['push', 'polapp', 'main']);

  // storage key: minted on A (in-process, explicit path); the OWNER
  // distributes it to B (same key); C stays keyless → ciphertext only.
  const cryptMod = require('../crypt.js');
  cryptMod.ensureStorageKey(path.join(homeA, '.gitlive', 'storage.key'));
  fs.mkdirSync(path.join(homeB, '.gitlive'), { recursive: true });
  fs.copyFileSync(path.join(homeA, '.gitlive', 'storage.key'), path.join(homeB, '.gitlive', 'storage.key'));
  const clientFactory = require(path.join(__dirname, '..', 'gitlive-client'));
  const writer = clientFactory({ app: 'polapp', dataDir: path.join(homeA, '.gitlive', 'apps', 'polapp-run', 'data') });
  await writer.db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)');
  await writer.db.exec('INSERT INTO notes (text) VALUES (?)', ['sensitive row']);
  await writer.storage.put('docs/plan.txt', Buffer.from('owner-key plan'), { contentType: 'text/plain' });
  writer.close();

  // peers: B keyed, C keyless
  cli(['mesh', 'add', 'peer-b', '--home', homeB, '--start', 'PORT=' + (basePort + 1) + ' node server.js'], envA);
  cli(['mesh', 'add', 'peer-c', '--home', homeC, '--start', 'PORT=' + (basePort + 2) + ' node server.js'], envA);

  // owner-key deploy (stderr passes through so restore diagnostics show)
  execFileSync('node', [GITLIVE_JS, 'mesh', 'deploy', 'polapp', '--min-nodes', '3', '--storage', 'owner-key'],
    { cwd: project, env: envA, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'inherit', 'inherit'] });

  // bus tree is ciphertext
  const bus = path.join(homeA, '.gitlive', 'state', 'polapp.git');
  const treeLines = execFileSync('git', ['--git-dir=' + bus, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert(treeLines.length > 0 && treeLines.every((l) => l.endsWith('.glc') || l === '.glc-mode'), 'bus holds only ciphertext paths: ' + treeLines.join(' | '));
  assert(treeLines.some((l) => l.includes('plan')), 'the plan blob is on the bus (encrypted): ' + treeLines.join(' | '));

  // registries carry the policy
  for (const h of [homeA, homeB, homeC]) {
    const reg = JSON.parse(fs.readFileSync(path.join(h, '.gitlive', 'apps.json'), 'utf8'));
    assert(reg.polapp.mesh && reg.polapp.mesh.storage === 'owner-key', 'policy recorded on ' + h);
  }

  // B (keyed) can read the restored data; C cannot (no key → restore refused)
  const bReader = clientFactory({ app: 'polapp', dataDir: path.join(homeB, '.gitlive', 'apps', 'polapp-run', 'data') });
  const got = await bReader.storage.get('docs/plan.txt');
  assert(got && got.buffer.toString('utf8') === 'owner-key plan', 'keyed replica read the decrypted blob');
  bReader.close();
  const cData = path.join(homeC, '.gitlive', 'apps', 'polapp-run', 'data');
  assert(!fs.existsSync(path.join(cData, 'app.db')) || fs.readdirSync(path.join(cData, 'storage')).length === 0, 'keyless replica did not materialize plaintext data');

  console.log('OK: owner-key deploy — encrypted bus, policy recorded everywhere');
  console.log('OK: keyed replica restored + decrypted; keyless replica holds no plaintext');
  console.log('\nALL STORAGE POLICY TESTS PASSED');
})().catch((err) => {
  console.error('POLICY TEST FAILED:', (err && err.message) || err);
  if (err && err.stdout) console.error(String(err.stdout).slice(0, 800));
  if (err && err.stderr) console.error(String(err.stderr).slice(0, 800));
  process.exitCode = 1;
});
