'use strict';
// Item 5 — relay transport, loopback slice. A and B never know each
// other's listener URLs — both know ONLY the relay. Announce + ping/pong
// flow through the relay mailboxes with signatures verified at the edges;
// the relay sees only opaque envelopes. Unsigned messages are dropped by
// the poller (relay itself verifies nothing by design).

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
const homeR = fs.mkdtempSync(path.join(shortTmp, 'glrelay-r-'));
const homeA = fs.mkdtempSync(path.join(shortTmp, 'glrelay-a-'));
const homeB = fs.mkdtempSync(path.join(shortTmp, 'glrelay-b-'));
const homeC = fs.mkdtempSync(path.join(shortTmp, 'glrelay-c-'));
const sharedOwner = path.join(shortTmp, 'relay-owner.pem');

function env(home) {
  return { ...process.env, HOME: home, GITLIVE_NODE_KEY: path.join(home, '.gitlive', 'node-key.pem'), GITLIVE_MANIFEST_KEY: sharedOwner };
}
function cliPeer(args, home) {
  return execFileSync('node', [GITLIVE_JS, 'peer', ...args], { env: env(home), encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function cliManifest(args, home) {
  return execFileSync('node', [GITLIVE_JS, 'manifest', ...args], { env: env(home), encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // shared owner key (one owner, three nodes) + relay node R
  cliManifest(['keygen'], homeR);
  const portR = await freePort();
  const relayUrl = 'http://127.0.0.1:' + portR;
  const relay = startPeer(homeR, portR);
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try { const r = await fetch(relayUrl + '/peer/hello'); if (r.ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 120));
  }

  // real node ids (fingerprint-derived) so mailboxes line up
  const peerMod = require('../peer.js');
  const keyA = peerMod.ensureNodeKey(path.join(homeA, '.gitlive', 'node-key.pem'));
  const keyB = peerMod.ensureNodeKey(path.join(homeB, '.gitlive', 'node-key.pem'));
  const idA = peerMod.nodeIdOf(keyA);
  const idB = peerMod.nodeIdOf(keyB);

  // A announces itself to B THROUGH the relay (B never sees A's URL)
  const ann = cliPeer(['relay', 'announce', relayUrl, idB, '--name', 'node-a', '--endpoint', 'relay://a@relay'], homeA);
  assert(/announce queued/.test(ann), 'A announces via relay:\n' + ann);
  // B announces itself to A through the relay too (mutual)
  const annB = cliPeer(['relay', 'announce', relayUrl, idA, '--name', 'node-b', '--endpoint', 'relay://b@relay'], homeB);
  assert(/announce queued/.test(annB), 'B announces via relay:\n' + annB);

  // B polls: registers node-a (signature + owner verified)
  const pollB = cliPeer(['relay', 'poll', relayUrl], homeB);
  assert(/registered peer "node-a"/.test(pollB), 'B registers A through the relay:\n' + pollB);
  const peersB = fs.readFileSync(path.join(homeB, '.gitlive', 'peers.json'), 'utf8');
  assert(/node-a/.test(peersB) && /relay:\/\/a@relay/.test(peersB), 'B stored A with the relay endpoint');

  // A polls: registers node-b
  const pollA = cliPeer(['relay', 'poll', relayUrl], homeA);
  assert(/registered peer "node-b"/.test(pollA), 'A registers B through the relay:\n' + pollA);

  // ping/pong round-trip through the relay
  const ping = cliPeer(['relay', 'ping', relayUrl, idB, '--echo', 'roundtrip-42'], homeA);
  assert(/ping queued/.test(ping), 'A pings B via relay');
  const pollB2 = cliPeer(['relay', 'poll', relayUrl], homeB);
  assert(new RegExp('pong from ' + idA + '.*roundtrip-42').test(pollB2), 'B answers pong through the relay:\n' + pollB2);
  const pollA2 = cliPeer(['relay', 'poll', relayUrl], homeA);
  assert(new RegExp('pong from ' + idB + '.*roundtrip-42').test(pollA2), 'A receives the pong through the relay:\n' + pollA2);
  console.log('OK: announce + ping/pong round-trip through the relay (A and B never share URLs)');

  // tamper: an unsigned message sits in the mailbox but the poller drops it
  const unsigned = JSON.stringify({ op: 'announce', nodeId: 'node-of-c', name: 'evil', publicKey: 'bogus', ts: new Date().toISOString() });
  await fetch(relayUrl + '/relay/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: idA, message: JSON.parse(unsigned) }) });
  const pollA3 = cliPeer(['relay', 'poll', relayUrl], homeA);
  assert(/dropped message: bad signature/.test(pollA3), 'unsigned relayed message dropped at the edge:\n' + pollA3);
  console.log('OK: unsigned relayed message dropped by the poller (edge verification)');

  // ── P1 delivery guarantees on the existing relay ─────────────────────────
  // Hermetic rule: stateful relay ops run as CLI children under fake homes
  // (module-level paths bind to the requiring process's HOME). Snippets
  // require the real peer.js but run with HOME=<home>.
  const PEER_ABS = JSON.stringify(path.join(__dirname, '..', 'peer.js'));
  function runNode(home, body, args) {
    const script = 'const p=require(' + PEER_ABS + ');(async()=>{' + body + '})().catch(e=>{console.error(e.message);process.exit(1)})';
    return execFileSync('node', ['-e', script, ...(args || [])], { env: { ...process.env, HOME: home, GITLIVE_MANIFEST_KEY: sharedOwner }, encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const keyC = peerMod.ensureNodeKey(path.join(homeC, '.gitlive', 'node-key.pem'));
  const idC = peerMod.nodeIdOf(keyC);

  // 1 — content-addressed envelopes: byte-identical pushes dedupe at the
  // mailbox (fixed timestamp → identical bytes → identical id)
  const dup = peerMod.signMessage(keyA.priv, { op: 'ping', nodeId: idA, publicKey: keyA.publicKeyPem, ts: '2026-09-09T00:00:00.000Z', echo: 'dedupe-y' });
  const postDup = (m) => fetch(relayUrl + '/relay/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: idB, message: m }) }).then((r) => r.json());
  const d1 = await postDup(dup);
  const d2 = await postDup(dup);
  assert(d1.data && d1.data.queued === true && d1.data.dedup === false, 'first push queued: ' + JSON.stringify(d1.data));
  assert(d2.data && d2.data.dedup === true, 'identical second push deduped: ' + JSON.stringify(d2.data));
  const pollBD = cliPeer(['relay', 'poll', relayUrl], homeB);
  assert((pollBD.match(/dropped message/g) || []).length === 1, 'mailbox held exactly ONE copy:\n' + pollBD);
  console.log('OK: envelope ids are content-addressed — duplicate pushes deliver once');

  // 2 — guaranteed send + receipt: sender holds until B acks, then releases
  const sendBody = "const k=p.ensureNodeKey();const core={op:'ping',nodeId:p.nodeIdOf(k),publicKey:k.publicKeyPem,ts:new Date().toISOString(),echo:'g-42'};const m=p.signPeerPayload(core,k);const r=await p.relaySendGuaranteed(process.argv[1],process.argv[2],m);console.log(JSON.stringify({id:r.id,pending:p.outboxSummary().pending}));";
  const g = JSON.parse(runNode(homeA, sendBody, [relayUrl, idB]));
  assert(g.id && g.pending >= 1, 'guaranteed send held in the outbox:\n' + JSON.stringify(g));
  const pollBG = cliPeer(['relay', 'poll', relayUrl], homeB);
  assert(/pong from .*g-42/.test(pollBG), 'B received the guaranteed ping:\n' + pollBG);
  const pollAG = cliPeer(['relay', 'poll', relayUrl], homeA);
  assert(/receipt .*confirmed/.test(pollAG), 'A collects the delivery receipt:\n' + pollAG);
  const after = JSON.parse(runNode(homeA, "console.log(JSON.stringify(p.outboxSummary()));"));
  assert(!after.entries.some((e) => e.id === g.id && !e.acked), 'sender released the envelope after the receipt');
  console.log('OK: guaranteed send — sender holds until the receipt, then releases');

  // 3 — kill-before-forward: the recipient never polls; retry routes the
  //     SAME envelope (same id) to another peer, which acks it
  const g3 = JSON.parse(runNode(homeA, sendBody.replace("'g-42'", "'r-77'"), [relayUrl, idC]));
  const retried = JSON.parse(runNode(homeA, "const r=await p.relayRetryOutbox([process.argv[1]],{minAgeMs:0});console.log(JSON.stringify(r));", [relayUrl]));
  assert(retried.retried.includes(g3.id), 'retry re-sent the pending envelope');
  const pollCR = cliPeer(['relay', 'poll', relayUrl], homeC);
  assert(/pong from .*r-77/.test(pollCR), 'peer C received the retried envelope:\n' + pollCR);
  const pollAR = cliPeer(['relay', 'poll', relayUrl], homeA);
  assert(/receipt .*confirmed/.test(pollAR), 'A clears the retried envelope after C\'s receipt:\n' + pollAR);
  const afterR = JSON.parse(runNode(homeA, "console.log(JSON.stringify(p.outboxSummary()));"));
  assert(!afterR.entries.some((e) => e.id === g3.id && !e.acked), 'retried envelope released after receipt');
  console.log('OK: kill-before-forward — sender retains; retry delivers to another peer');

  await relay.stop();
  console.log('\nALL RELAY TESTS PASSED');
})().catch((err) => {
  console.error('RELAY TEST FAILED:', (err && err.message) || err);
  if (err && err.stderr) console.error(String(err.stderr).slice(0, 600));
  process.exitCode = 1;
});
