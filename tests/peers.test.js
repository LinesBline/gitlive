'use strict';
// Phase 3 federation, slice 1 — two fake-home nodes talk over loopback HTTP
// as real peers: hello handshake, signed announce, tamper refusal, sticky
// peer store. Real CLI children + real HTTP, same discipline as every suite.

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
const homeA = fs.mkdtempSync(path.join(shortTmp, 'glpeer-a-'));
const homeB = fs.mkdtempSync(path.join(shortTmp, 'glpeer-b-'));
const keyA = path.join(homeA, '.gitlive', 'node-key.pem');
const keyB = path.join(homeB, '.gitlive', 'node-key.pem');
const sharedOwner = path.join(shortTmp, 'shared-owner.pem');

function env(home) {
  return { ...process.env, HOME: home, GITLIVE_NODE_KEY: home === homeA ? keyA : keyB, GITLIVE_MANIFEST_KEY: sharedOwner };
}
function cli(args, home, opts = {}) {
  return execFileSync('node', [GITLIVE_JS, ...args], { env: env(home), encoding: 'utf8', timeout: 15000, ...opts });
}
function cliFail(args, home, opts = {}) {
  try { cli(args, home, opts); return null; } catch (err) { return String(err.stdout || '') + String(err.stderr || ''); }
}
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function startPeer(home, port) {
  const child = spawn('node', [GITLIVE_JS, 'peer', 'start', '--port', String(port)], { env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, stop: () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); }) };
}

(async () => {
  const portA = await freePort();
  const portB = await freePort();
  const urlA = 'http://127.0.0.1:' + portA;
  const urlB = 'http://127.0.0.1:' + portB;

  // 0 — the owner key exists (shared by both nodes — one owner, two nodes)
  cli(['manifest', 'keygen'], homeA);
  assert(fs.existsSync(sharedOwner), 'owner key generated');

  // 1 — both nodes run listeners; hello works both ways (public handshake)
  const peerA = startPeer(homeA, portA);
  const peerB = startPeer(homeB, portB);
  const deadline = Date.now() + 6000;
  let helloA = null;
  while (Date.now() < deadline) {
    try { helloA = await fetch(urlA + '/peer/hello').then((r) => r.json()); if (helloA.ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  assert(helloA && helloA.ok && helloA.data.protocol === 'gitlive-peer/1', 'A answers hello');
  const helloOut = cli(['peer', 'hello', urlB], homeA);
  assert(/hello from /.test(helloOut), 'A reaches B over /peer/hello:\n' + helloOut);
  console.log('OK: hello handshake works in both directions (loopback HTTP)');

  // 2 — signed announce: A announces to B; B stores the peer record
  const annOut = cli(['peer', 'announce', urlB, '--name', 'node-a'], homeA);
  assert(/announced; that peer now knows 1 peer/.test(annOut), 'announce output:\n' + annOut);
  const listOut = cli(['peer', 'list'], homeB);
  assert(/node-a/.test(listOut), 'B lists A as a known peer:\n' + listOut);
  console.log('OK: owner-signed announce lands in the peer store');

  // 3 — tamper refusal: an unsigned announce must be rejected (403)
  const tampered = JSON.stringify({ protocol: 'gitlive-peer/1', nodeId: 'node-fake', name: 'fake', endpoints: [urlA], publicKey: 'bogus', ts: new Date().toISOString() });
  const res = await fetch(urlA + '/peer/announce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: tampered });
  assert(res.status === 403, 'unsigned announce must be refused, got ' + res.status);

  // 3b — ownerless node (no owner key) is refused by an owner-trusting node
  const homeC = fs.mkdtempSync(path.join(shortTmp, 'glpeer-c-'));
  const envC = { ...process.env, HOME: homeC, GITLIVE_NODE_KEY: path.join(homeC, '.gitlive', 'node-key.pem'), GITLIVE_MANIFEST_KEY: path.join(shortTmp, 'definitely-missing-owner.pem') };
  try {
    execFileSync('node', [GITLIVE_JS, 'peer', 'announce', urlB, '--name', 'rogue'], { env: envC, encoding: 'utf8', timeout: 10000 });
    assert(false, 'ownerless announce must be refused by an owner-trusting node');
  } catch (err) {
    assert(/refused|announce failed/.test(String(err.stdout || '') + String(err.stderr || '')), 'ownerless refusal message');
  }
  console.log('OK: unsigned/tampered announce refused (403)');
  console.log('OK: ownerless node refused by an owner-trusting peer');

  // 3c — multi-owner: a SECOND owner is refused until allowlisted
  const owner2 = path.join(shortTmp, 'owner-2.pem');
  const homeD = fs.mkdtempSync(path.join(shortTmp, 'glpeer-d-'));
  const envD = { ...process.env, HOME: homeD, GITLIVE_NODE_KEY: path.join(homeD, '.gitlive', 'node-key.pem'), GITLIVE_MANIFEST_KEY: owner2 };
  execFileSync('node', [GITLIVE_JS, 'manifest', 'keygen'], { env: envD, encoding: 'utf8' });
  const fp2Out = execFileSync('node', [GITLIVE_JS, 'manifest', 'keygen'], { env: envD, encoding: 'utf8' }).toString(); // idempotent: prints existing
  const fp2 = (fp2Out.match(/fingerprint: ([0-9A-F:]{39})/) || [])[1];
  try {
    execFileSync('node', [GITLIVE_JS, 'peer', 'announce', urlB, '--name', 'other-owner-node'], { env: envD, encoding: 'utf8', timeout: 10000 });
    assert(false, 'foreign-owner announce must be refused before trust');
  } catch (err) {
    assert(/not trusted/.test(String(err.stdout || '') + String(err.stderr || '')), 'foreign owner refusal message');
  }
  // allowlist the second owner → announce accepted
  const trustOut = cli(['peer', 'trust', 'add', fp2.replace(/:/g, '')], homeB);
  assert(/trusted owners: 1/.test(trustOut), 'trust add:\n' + trustOut);
  const annD = execFileSync('node', [GITLIVE_JS, 'peer', 'announce', urlB, '--name', 'other-owner-node'], { env: envD, encoding: 'utf8', timeout: 10000 }).toString();
  assert(/announced/.test(annD), 'foreign-owner announce accepted after trust:\n' + annD);
  console.log('OK: multi-owner trust — foreign owner refused, then accepted after allowlist');

  // 4 — node keys are stable + 0600
  const stA = fs.statSync(keyA);
  assert((stA.mode & 0o777) === 0o600, 'node key must be 0600');
  const annAgain = cli(['peer', 'announce', urlB, '--name', 'node-a'], homeA);
  assert(/announced/.test(annAgain), 're-announce succeeds:\n' + annAgain);
  // poll to stability: the announce is persisted sync BEFORE the response,
  // but under battery load a list can land on the in-flight write — a dup
  // is structurally impossible (nodeId-keyed store), a transient 0 is not.
  let listAfter = '';
  for (let i = 0; i < 10; i++) {
    listAfter = cli(['peer', 'list'], homeB);
    if ((listAfter.match(/node-a/g) || []).length === 1) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert((listAfter.match(/node-a/g) || []).length === 1, 're-announce does not duplicate the peer row (stable):\n' + listAfter);
  console.log('OK: node keys 0600 and stable; re-announce is idempotent');

  // 5 — onboarding loop (item 6): owner invites, a fresh node JOINS over the
  //     wire carrying the invite, and the owner's listener accepts it
  const invOut = cli(['mesh', 'invite', '--name', 'joiner', '--ttl-h', '24']);
  const inviteTok = invOut.split('\n').filter(Boolean).pop().trim();
  const homeJ = fs.mkdtempSync(path.join(shortTmp, 'glpeer-j-'));
  const envJ = { ...process.env, HOME: homeJ, GITLIVE_NODE_KEY: path.join(homeJ, '.gitlive', 'node-key.pem'), GITLIVE_MANIFEST_KEY: path.join(shortTmp, 'joiner-has-no-owner.pem') };
  const joinOut = execFileSync('node', [GITLIVE_JS, 'mesh', 'join', inviteTok, urlB, '--name', 'joiner'], { env: envJ, encoding: 'utf8', timeout: 15000 }).toString();
  assert(/joined as "joiner"/.test(joinOut), 'join output:\n' + joinOut);
  let listJ = '';
  for (let i = 0; i < 10; i++) {
    listJ = cli(['peer', 'list'], homeB);
    if (/joiner/.test(listJ)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(/joiner/.test(listJ), 'owner node lists the invited joiner (stable):\n' + listJ);
  console.log('OK: invited joiner (no owner key) accepted over the wire; owner lists it');

  // 6 — item 9: the accepted join lands in the OWNER mesh registry as a
  //     remote member (mesh list + Mesh view), and `mesh rm` cleans up both
  //     the registry entry and the peer row
  const ownerMesh = JSON.parse(fs.readFileSync(path.join(homeB, '.gitlive', 'mesh.json'), 'utf8'));
  const member = ownerMesh.members && ownerMesh.members.joiner;
  assert(member && member.remote === true && member.fingerprint && Array.isArray(member.endpoints) && member.endpoints.length > 0, 'owner mesh registry carries the joiner as a remote member:\n' + JSON.stringify(ownerMesh.members || null).slice(0, 300));
  assert(!ownerMesh.nodes.joiner, 'remote members never enter mesh.nodes (no home):\n' + JSON.stringify(ownerMesh.nodes || null));
  const meshListB = cli(['mesh', 'list'], homeB);
  assert(/owner registry members/.test(meshListB) && /joiner/.test(meshListB), 'mesh list shows the remote member:\n' + meshListB);
  console.log('OK: joiner registered in the owner mesh registry (members), visible in mesh list');

  // `mesh rm` (registry cleanup): refuses self + unknown names, then removes
  // the member AND its peer row in one shot
  const rmSelf = cliFail(['mesh', 'rm', 'self'], homeB);
  assert(rmSelf && /cannot be removed/.test(rmSelf), 'rm self refused:\n' + (rmSelf || '(accepted!)'));
  const rmGhost = cliFail(['mesh', 'rm', 'ghost'], homeB);
  assert(rmGhost && /no mesh node or member/.test(rmGhost), 'rm unknown name refused:\n' + (rmGhost || '(accepted!)'));
  const rmOut = cli(['mesh', 'rm', 'joiner'], homeB);
  assert(/Removed "joiner" from the owner registry/.test(rmOut), 'rm output:\n' + rmOut);
  const ownerMeshAfter = JSON.parse(fs.readFileSync(path.join(homeB, '.gitlive', 'mesh.json'), 'utf8'));
  assert(!(ownerMeshAfter.members || {}).joiner, 'member entry gone after rm');
  let listAfterRm = '';
  for (let i = 0; i < 10; i++) {
    listAfterRm = cli(['peer', 'list'], homeB);
    if (!/joiner/.test(listAfterRm)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(!/joiner/.test(listAfterRm), 'peer row dropped with the member (stable):\n' + listAfterRm);
  console.log('OK: mesh rm refuses self/unknown; removes member + peer row together');

  await peerA.stop();
  await peerB.stop();
  console.log('\nALL PEER PROTOCOL TESTS PASSED');
})().catch((err) => {
  console.error('PEER TEST FAILED:', (err && err.message) || err);
  process.exitCode = 1;
});
