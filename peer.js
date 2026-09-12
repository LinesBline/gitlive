// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive peer protocol — Phase 3 federation, first slice.
//
// Two nodes become peers over plain HTTPS/JSON (Node built-ins only): each
// node runs a peer listener (`gitlive peer start`); a node announces itself
// to another (`gitlive peer announce <url>`); announced peers are stored in
// ~/.gitlive/peers.json (per node home). Deploy/state/promote-over-the-wire
// build on this base in later slices (DESIGN.md Phase 3).
//
// Identity (MVP, documented simplification): every node holds an Ed25519
// keypair at ~/.gitlive/node-key.pem (auto-generated, 0600). An announce is
// signed by the announcing node's key and verified against the public key it
// carries. That proves the message came from whoever holds that key — it
// does NOT yet prove the key belongs to a trusted member: owner-signing of
// membership (the v3 trust model) is the next slice, and until it lands
// peers.json is an untrusted address book, never an authorization list.
//
// Wire format mirrors manifest.js: canonical deep-sorted JSON, signature
// covers exactly what verification recomputes.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

const manifest = require('./manifest.js');

const DEFAULT_NODE_KEY = process.env.GITLIVE_NODE_KEY || path.join(os.homedir(), '.gitlive', 'node-key.pem');
const PEERS_PATH = path.join(os.homedir(), '.gitlive', 'peers.json');
const PEER_PROTOCOL = 'gitlive-peer/1';

// ---------------------------------------------------------------------------
// node identity
// ---------------------------------------------------------------------------
function ensureNodeKey(keyPath = DEFAULT_NODE_KEY) {
  if (!fs.existsSync(keyPath)) {
    const pair = manifest.generateOwnerKeyPair(); // Ed25519 pem pair
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, pair.privateKeyPem, { mode: 0o600 });
  }
  return manifest.loadPrivateKey(keyPath);
}

function nodeIdOf(key) {
  return 'node-' + key.fingerprint.slice(0, 16).toLowerCase();
}

function signMessage(priv, payload) {
  const data = Buffer.from(manifest.canonical(payload), 'utf8');
  return { ...payload, sig: manifest.signBytes(priv, data) };
}

function verifyMessage(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.sig !== 'string') return false;
  if (!payload.publicKey || typeof payload.publicKey !== 'string') return false;
  const body = { ...payload };
  delete body.sig;
  const data = Buffer.from(manifest.canonical(body), 'utf8');
  return manifest.verifyBytes(payload.publicKey, data, payload.sig);
}

// ---------------------------------------------------------------------------
// owner trust (slice 3): membership is cross-signed by the OWNER manifest key
// (~/.gitlive/manifest-owner-key.pem, env GITLIVE_MANIFEST_KEY aware). A node
// that has an owner key only trusts peers carrying that same owner's
// signature; ownerless nodes fall back to node-signatures-only (legacy
// mode, documented as untrusted-until-an-owner-exists).
// ---------------------------------------------------------------------------
function ensureOwnerKey() {
  const manifest = require('./manifest.js');
  const keyPath = process.env.GITLIVE_MANIFEST_KEY || manifest.DEFAULT_KEY_PATH;
  try {
    if (require('node:fs').existsSync(keyPath)) return manifest.loadPrivateKey(keyPath);
  } catch { /* fall through */ }
  return null;
}

function ownerVerify(payload) {
  if (!payload.ownerSig || !payload.ownerPublicKey) return { ok: false, reason: 'no owner signature on payload' };
  const core = { ...payload };
  delete core.sig; delete core.ownerSig; delete core.ownerPublicKey;
  const ok = manifest.verifyBytes(payload.ownerPublicKey, Buffer.from(manifest.canonical(core), 'utf8'), payload.ownerSig);
  if (!ok) return { ok: false, reason: 'owner signature does not verify' };
  const fp = manifest.fingerprintFromPublicKey(payload.ownerPublicKey);
  return { ok: true, fingerprint: fp };
}

// Multi-owner trust: a node trusts its OWN owner plus an explicit allowlist
// (~/.gitlive/trusted-owners.json → { owners: [fingerprint, …] }).
const TRUSTED_OWNERS_PATH = path.join(os.homedir(), '.gitlive', 'trusted-owners.json');
function loadTrustedOwners() {
  try { return JSON.parse(fs.readFileSync(TRUSTED_OWNERS_PATH, 'utf8')); } catch { return { owners: [] }; }
}
function saveTrustedOwners(store) {
  fs.mkdirSync(path.dirname(TRUSTED_OWNERS_PATH), { recursive: true });
  fs.writeFileSync(TRUSTED_OWNERS_PATH, JSON.stringify(store, null, 2) + '\n');
}

// membership policy for the RECEIVER: with an owner key, only peers signed by
// the owner itself or an allowlisted owner are accepted; without one,
// node-signed payloads pass (legacy ownerless mode).
function ownerPolicy(payload) {
  const mine = ensureOwnerKey();
  const v = ownerVerify(payload);
  if (mine) {
    if (v.ok && v.fingerprint === mine.fingerprint) return { ok: true };
    // invitation path (item 6): a peer without my owner signature may present
    // a valid, unexpired invite issued by MY owner key, name must match.
    if (payload.invite && typeof payload.invite === 'string') {
      try {
        const inv = meshMod.verifyInviteToken(payload.invite, { keyPath: process.env.GITLIVE_MANIFEST_KEY });
        if (inv.ok && inv.name === payload.name) return { ok: true, invited: true };
        if (!inv.ok) return { ok: false, reason: 'invite invalid: ' + inv.reason };
        return { ok: false, reason: 'invite name mismatch' };
      } catch (err) {
        return { ok: false, reason: 'invite check failed: ' + err.message };
      }
    }
    if (v.ok) {
      const trusted = loadTrustedOwners().owners || [];
      if (trusted.includes(v.fingerprint)) return { ok: true, trusted: true };
      return { ok: false, reason: `peer owner ${v.fingerprint.slice(0, 12)}… not trusted (mine: ${mine.fingerprint.slice(0, 12)}…). Trust it: gitlive peer trust add <fingerprint>` };
    }
    return { ok: false, reason: v.reason };
  }
  if (!v.ok) return { ok: false, reason: v.reason }; // ownerSig present but broken
  return { ok: true, ownerless: true };
}

// sender-side: attach owner signature over the payload core when an owner key
// exists; always node-sign the envelope last.
function signPeerPayload(core, nodeKey) {
  const owner = ensureOwnerKey();
  const base = { ...core };
  if (owner) {
    base.ownerPublicKey = owner.publicKeyPem;
    base.ownerSig = manifest.signBytes(owner.priv, Buffer.from(manifest.canonical(core), 'utf8'));
  }
  return signMessage(nodeKey.priv, base);
}

// ---------------------------------------------------------------------------
// peer store
// ---------------------------------------------------------------------------
function loadPeers() {
  try { return JSON.parse(fs.readFileSync(PEERS_PATH, 'utf8')); } catch { return { peers: {} }; }
}

function savePeers(store) {
  fs.mkdirSync(path.dirname(PEERS_PATH), { recursive: true });
  fs.writeFileSync(PEERS_PATH, JSON.stringify(store, null, 2) + '\n');
}

function recordFor(key, name, endpoints) {
  const publicKeyPem = key.publicKeyPem;
  return {
    protocol: PEER_PROTOCOL,
    nodeId: nodeIdOf(key),
    name: name || os.hostname(),
    endpoints: Array.isArray(endpoints) ? endpoints : [endpoints],
    publicKey: publicKeyPem,
    ownerFingerprint: key.fingerprint,
    ts: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// relay (item 5): peers that cannot reach each other talk through an
// always-on relay node. The relay only queues/forwards opaque signed
// envelopes (mailboxes by nodeId) — it holds no keys, verifies nothing,
// and cannot forge anything. Outbound-only for the clients: they POST to
// the relay and POLL their mailbox.
// ---------------------------------------------------------------------------
const RELAY_MAIL_PATH = path.join(os.homedir(), '.gitlive', 'relay-mail.json');

function relayMailbox() {
  try { return JSON.parse(fs.readFileSync(RELAY_MAIL_PATH, 'utf8')); } catch { return {}; }
}
function saveMailbox(mb) {
  fs.mkdirSync(path.dirname(RELAY_MAIL_PATH), { recursive: true });
  fs.writeFileSync(RELAY_MAIL_PATH, JSON.stringify(mb));
}
function envelopeId(message) {
  // content-addressed identity: sha256 of the exact bytes that will round-trip
  return crypto.createHash('sha256').update(typeof message === 'string' ? message : JSON.stringify(message)).digest('hex');
}
function mailPush(nodeId, envelope, fromNode) {
  const mb = relayMailbox();
  mb[nodeId] = mb[nodeId] || [];
  // metadata lives BESIDE the message — the message must round-trip
  // byte-identical so edge signatures survive the relay untouched.
  const id = envelopeId(envelope);
  if (mb[nodeId].some((e) => e.id === id)) return { queued: true, id, dedup: true };
  mb[nodeId].push({ queuedAt: new Date().toISOString(), id, from: fromNode || null, message: envelope });
  saveMailbox(mb);
  return { queued: true, id, dedup: false };
}
function mailDrain(nodeId) {
  const mb = relayMailbox();
  const out = (mb[nodeId] || []).splice(0);
  saveMailbox(mb);
  return out; // [{queuedAt, id, from, message}]
}

async function relaySend(relayUrl, toNode, message) {
  const res = await fetch(new URL('/relay/send', relayUrl).href, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: toNode, message }), signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || 'HTTP ' + res.status);
  return data.data;
}

async function relayPoll(relayUrl, nodeId) {
  const res = await fetch(new URL('/relay/poll?node=' + encodeURIComponent(nodeId), relayUrl).href, { signal: AbortSignal.timeout(5000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || 'HTTP ' + res.status);
  return data.data;
}


// ── P1 delivery guarantees: outbox + receipts (ack-before-delete) ────────
const OUTBOX_PATH = path.join(os.homedir(), '.gitlive', 'outbox.json');
const OUTBOX_RETRY_MS = Number(process.env.GITLIVE_OUTBOX_RETRY_MS) || 5000;
function loadOutbox() {
  try { return JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')); } catch { return { entries: {} }; }
}
function saveOutbox(ob) {
  fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
  fs.writeFileSync(OUTBOX_PATH, JSON.stringify(ob, null, 2));
}
function outboxSummary() {
  const ob = loadOutbox();
  const entries = Object.values(ob.entries || {});
  return { pending: entries.filter((e) => !e.acked).length, acked: entries.filter((e) => e.acked).length, entries: entries.map((e) => ({ id: e.id, to: e.to, acked: e.acked, sentAt: e.sentAt, mailbox: e.mailbox })) };
}
function outboxAck(id) {
  const ob = loadOutbox();
  const e = ob.entries && ob.entries[id];
  if (!e) return false;
  e.acked = true; e.ackedAt = new Date().toISOString();
  saveOutbox(ob);
  return true;
}
// sender-holds-until-ack: persist the envelope, then push to the FIRST
// reachable mailbox in the list; the entry survives until a relay-ack.
async function relaySendGuaranteed(relayUrls, toNode, message) {
  const key = ensureNodeKey();
  const me = nodeIdOf(key);
  const id = envelopeId(message);
  const ob = loadOutbox();
  ob.entries = ob.entries || {};
  if (!ob.entries[id]) {
    ob.entries[id] = { id, to: toNode, message, sentAt: new Date().toISOString(), mailbox: null, acked: false, attempts: 0 };
  }
  saveOutbox(ob);
  const urls = Array.isArray(relayUrls) ? relayUrls : [relayUrls];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(new URL('/relay/send', url).href, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: toNode, from: me, message }), signal: AbortSignal.timeout(5000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { lastErr = new Error((data.error && data.error.message) || 'HTTP ' + res.status); continue; }
      const fresh = loadOutbox();
      if (fresh.entries && fresh.entries[id]) { fresh.entries[id].mailbox = url; fresh.entries[id].attempts += 1; }
      saveOutbox(fresh);
      return { id, queued: data.data && data.data.queued !== false, mailbox: url, dedup: Boolean(data.data && data.data.dedup) };
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('no mailbox reachable');
}
// resend unacked outbox entries (retry across the mailbox list)
async function relayRetryOutbox(relayUrls, { minAgeMs = OUTBOX_RETRY_MS } = {}) {
  const urls = Array.isArray(relayUrls) ? relayUrls : [relayUrls];
  const ob = loadOutbox();
  const retried = [];
  const now = Date.now();
  for (const e of Object.values(ob.entries || {})) {
    if (e.acked) continue;
    if (now - new Date(e.sentAt).getTime() < minAgeMs) continue;
    try { await relaySendGuaranteed(urls, e.to, e.message); retried.push(e.id); }
    catch { /* stays pending */ }
  }
  return { retried };
}
// receiver side: poll + auto-ack. ack envelopes are consumed locally;
// real messages go to onMessage and (when the sender is known) earn a
// signed relay-ack back through the mailbox.
async function relaySendAck(relayUrl, fromNode, id) {
  const key = ensureNodeKey();
  const ack = signPeerPayload({ kind: 'relay-ack', ackId: String(id), nodeId: nodeIdOf(key), publicKey: key.publicKeyPem, ts: new Date().toISOString() }, key);
  await relaySend(relayUrl, fromNode, ack);
}
async function relayPollAndAck(relayUrl, onMessage) {
  const got = await relayPoll(relayUrl, nodeIdOf(ensureNodeKey()));
  const handled = [];
  for (const entry of got.messages || []) {
    const payload = entry.message;
    if (payload && typeof payload === 'object' && payload.kind === 'relay-ack' && payload.ackId) {
      const acked = verifyMessage(payload) && outboxAck(String(payload.ackId));
      handled.push({ id: entry.id, action: acked ? 'acked' : 'ack-ignored' });
      continue;
    }
    let rep = null;
    if (typeof onMessage === 'function') {
      try { rep = await onMessage(payload); } catch (err) { rep = { action: 'error', reason: err.message }; }
    }
    if (entry.from && rep && rep.action !== 'dropped' && rep.action !== 'error') {
      try { await relaySendAck(relayUrl, entry.from, entry.id); } catch { /* ack best-effort */ }
    }
    handled.push({ id: entry.id, action: rep ? rep.action : 'handled' });
  }
  return { handled };
}

// process one relayed message as the receiving node would: only signed,
// policy-accepted payloads act; 'announce' stores the peer; 'ping' replies
// pong through the relay. Returns a human-readable report.
async function handleRelayMessage(payload, relayUrl) {
  if (!payload || typeof payload !== 'object') return { action: 'dropped', reason: 'not a message' };
  if (!verifyMessage(payload)) return { action: 'dropped', reason: 'bad signature' };
  const policy = ownerPolicy(payload);
  if (!policy.ok) return { action: 'dropped', reason: 'policy: ' + policy.reason };
  if (payload.op === 'pong') {
    return { action: 'ponged', from: payload.nodeId, echo: payload.echo || null };
  }
  if (payload.op === 'ping') {
    // echo pong back through the relay to the sender's mailbox
    const key = ensureNodeKey();
    const pong = signPeerPayload({ op: 'pong', nodeId: nodeIdOf(key), publicKey: key.publicKeyPem, ts: new Date().toISOString(), echo: payload.echo || null }, key);
    await relaySend(relayUrl, payload.nodeId, pong);
    return { action: 'ponged', to: payload.nodeId };
  }
  if (payload.op === 'announce') {
    const store = loadPeers();
    const id = payload.nodeId || payload.keyFingerprint;
    if (!id) return { action: 'dropped', reason: 'announce has no nodeId' };
    const entry = { ...payload, receivedAt: new Date().toISOString() };
    delete entry.sig; delete entry.ownerSig; delete entry.ownerPublicKey;
    store.peers[id] = entry;
    savePeers(store);
    return { action: 'registered', name: payload.name };
  }
  return { action: 'ignored', reason: 'op ' + (payload.op || '?') + ' not relay-handled' };
}

// ---------------------------------------------------------------------------
// peer listener
// ---------------------------------------------------------------------------
function startPeerServer({ port = 5280, host = '127.0.0.1', keyPath = DEFAULT_NODE_KEY } = {}) {
  const key = ensureNodeKey(keyPath);
  const nodeId = nodeIdOf(key);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };
    try {
      if (url.pathname === '/relay/send' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 100_000_000) return send(413, { ok: false, error: { code: 'TOO_LARGE', message: 'too large' } }); }
        let b;
        try { b = JSON.parse(body); } catch { return send(400, { ok: false, error: { code: 'INVALID_ARGS', message: 'invalid JSON' } }); }
        if (!b.to || !b.message) return send(400, { ok: false, error: { code: 'INVALID_ARGS', message: 'need to + message' } });
        const pushed = mailPush(String(b.to), b.message, b.from ? String(b.from) : null);
        return send(200, { ok: true, data: { queued: pushed.queued, to: b.to, id: pushed.id, dedup: pushed.dedup } });
      }
      if (url.pathname === '/relay/poll' && req.method === 'GET') {
        const node = url.searchParams.get('node');
        if (!node) return send(400, { ok: false, error: { code: 'INVALID_ARGS', message: 'need ?node=' } });
        return send(200, { ok: true, data: { messages: mailDrain(node).map((e) => ({ id: e.id, from: e.from, message: e.message })) } });
      }
      if (url.pathname === '/peer/hello' && req.method === 'GET') {
        return send(200, { ok: true, data: { protocol: PEER_PROTOCOL, nodeId, name: os.hostname(), ts: new Date().toISOString(), keyFingerprint: key.fingerprint } });
      }
      if (url.pathname === '/peer/op' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 100_000_000) return send(413, { ok: false, error: { code: 'TOO_LARGE', message: 'op too large' } });
        }
        let payload;
        try { payload = JSON.parse(body); } catch { return send(400, { ok: false, error: { code: 'INVALID_ARGS', message: 'invalid JSON' } }); }
        if (!verifyMessage(payload)) {
          return send(403, { ok: false, error: { code: 'AUTH_ERROR', message: 'unsigned or bad signature on peer op' } });
        }
        const policy = ownerPolicy(payload);
        if (!policy.ok) {
          return send(403, { ok: false, error: { code: 'AUTH_ERROR', message: 'peer op refused: ' + policy.reason } });
        }
        try {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glop-'));
          let result;
          switch (payload.op) {
            case 'deploy': result = receiveDeploy(payload, tmpDir); break;
            case 'promote': result = receivePromote(payload); break;
            case 'state-refresh': result = receiveRefresh(payload); break;
            case 'state-pull': result = receiveStatePull(payload); break;
            default: return send(400, { ok: false, error: { code: 'INVALID_ARGS', message: 'unknown op ' + payload.op } });
          }
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
          return send(200, { ok: true, data: result });
        } catch (err) {
          const code = err.code || 'INTERNAL';
          return send(code === 'NOT_FOUND' ? 404 : code === 'AUTH_ERROR' ? 403 : code === 'INVALID_ARGS' ? 400 : 500,
            { ok: false, error: { code, message: err.message } });
        }
      }
      if (url.pathname === '/peer/announce' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1_000_000) return send(413, { ok: false, error: { code: 'TOO_LARGE', message: 'announce too large' } });
        }
        let payload;
        try { payload = JSON.parse(body); } catch { return send(400, { ok: false, error: { code: 'INVALID_ARGS', message: 'invalid JSON' } }); }
        if (!verifyMessage(payload)) {
          return send(403, { ok: false, error: { code: 'AUTH_ERROR', message: 'unsigned or bad announce signature' } });
        }
        const policy = ownerPolicy(payload);
        if (!policy.ok) {
          return send(403, { ok: false, error: { code: 'AUTH_ERROR', message: 'announce refused: ' + policy.reason } });
        }
        const store = loadPeers();
        const id = payload.nodeId || payload.keyFingerprint;
        if (!id) return send(400, { ok: false, error: { code: 'INVALID_ARGS', message: 'announce has no nodeId' } });
        const entry = { ...payload, sig: undefined, receivedAt: new Date().toISOString() };
        delete entry.sig;
        store.peers[id] = entry;
        savePeers(store);
        // accepted announces join the OWNER mesh registry as remote members
        // (item 9): mesh list + the control-plane Mesh view see them; a
        // registry write must never fail an already-accepted announce.
        if (entry.name) {
          try {
            meshMod.meshRegisterRemote(String(entry.name), { fingerprint: String(id), endpoints: Array.isArray(entry.endpoints) ? entry.endpoints : [] });
          } catch { /* owner registry is best-effort at announce time */ }
        }
        return send(200, { ok: true, data: { peers: Object.keys(store.peers).length } });
      }
      send(404, { ok: false, error: { code: 'NOT_FOUND', message: `no such peer endpoint ${req.method} ${url.pathname}` } });
    } catch (err) {
      send(500, { ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
  });
  return { server, nodeId, key, port, host, url: `http://${host}:${port}`, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); }), close: () => new Promise((r) => server.close(r)) };
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------
async function peerHello(url) {
  const res = await fetch(new URL('/peer/hello', url).href, { signal: AbortSignal.timeout(3000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
  return data.data;
}

async function peerAnnounce(url, { name, keyPath = DEFAULT_NODE_KEY, endpoints, invite } = {}) {
  const key = ensureNodeKey(keyPath);
  const ep = endpoints || [url];
  const record = recordFor(key, name, ep);
  const signed = signPeerPayload(invite ? { ...record, invite } : record, key);
  const res = await fetch(new URL('/peer/announce', url).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed),
    signal: AbortSignal.timeout(3000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
  return data.data;
}

// ---------------------------------------------------------------------------
// federation ops (Phase 3, slice 2): deploy / state-refresh / promote over
// the wire. Receiver side runs inside the peer LISTENER process (its HOME is
// the receiving node's home, so registry/bare paths resolve locally). Sender
// side runs as `gitlive peer <deploy|refresh|promote>` children.
//
// Transport for code: git bundles (sender packs its bare's main into a
// bundle, receiver fetches it) — git-native, works over any HTTP hop, no
// remote machinery required on the receiver. State refresh keeps Phase 2's
// bus semantics: the sender pushes a snapshot into its state bus and the
// receiver restores from the given bus path (loopback-truthful today;
// cross-machine bus access is the documented next transport swap).
// ---------------------------------------------------------------------------
const gitlive = require('./gitlive.js');
const sync = require(path.join(__dirname, 'gitlive-backend-core', 'sync.js'));
const meshMod = require('./mesh.js');

function runShGit(args, cwd) {
  return require('node:child_process').execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// plain-mode apply: mirrors what the generated post-receive hook does —
// stop old process group, checkout main into runPath/live, install, start.
function applyCommit(appName, commit) {
  const reg = gitlive.loadRegistry();
  const app = reg[appName];
  if (!app) throw Object.assign(new Error(`no app "${appName}" on this node`), { code: 'NOT_FOUND' });
  const bare = app.barePath;
  const runPath = app.runPath;
  const live = path.join(runPath, 'live');
  const logPath = path.join(runPath, 'deploy.log');
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(path.join(runPath, 'data'), { recursive: true });
  const log = (m) => fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${m}\n`);
  // stop old group
  const pidFile = path.join(runPath, 'app.pid');
  if (fs.existsSync(pidFile)) {
    const oldPid = fs.readFileSync(pidFile, 'utf8').trim();
    try { process.kill(-Number(oldPid)); } catch { try { process.kill(Number(oldPid)); } catch { /* gone */ } }
  }
  log('peer apply: deploying ' + commit.slice(0, 12));
  runShGit(['--git-dir=' + bare, '--work-tree=' + live, 'checkout', '-f', 'main'], '.');
  const { execFileSync } = require('node:child_process');
  if (app.installCmd) {
    log('peer apply: installing');
    execFileSync('bash', ['-c', app.installCmd], { cwd: live, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const start = app.startCmd || 'node server.js';
  // same start idiom as the generated hooks: setsid when present, perl fallback
  const isDarwin = os.platform() === 'darwin';
  const wrapped = isDarwin
    ? `perl -e 'use POSIX "setsid"; POSIX::setsid(); exec { $ARGV[0] } @ARGV' bash -c ${JSON.stringify(start)}`
    : `setsid bash -c ${JSON.stringify(start)}`;
  const cmd = `GITLIVE_DATA_DIR=${JSON.stringify(path.join(runPath, 'data'))} ${wrapped} >> ${JSON.stringify(logPath)} 2>&1 < /dev/null & echo $!`;
  let out = '';
  try { out = execFileSync('bash', ['-c', cmd], { cwd: live, encoding: 'utf8' }).trim(); } catch (e) { out = String(e.stdout || '').trim(); }
  const pid = out.split('\n').pop().trim();
  if (pid && /^\d+$/.test(pid)) fs.writeFileSync(pidFile, pid);
  log('peer apply: started (pid ' + pid + ')');
  return { ok: true, commit: commit.slice(0, 12), pid };
}

// receiver: create-or-update the app entry then fetch bundle + apply
function receiveDeploy(payload, tmpDir) {
  const appName = payload.app;
  if (!appName || !payload.commit || !payload.bundleB64) {
    throw Object.assign(new Error('deploy needs app, commit, bundleB64'), { code: 'INVALID_ARGS' });
  }
  const reg = gitlive.loadRegistry();
  let created = false;
  if (!reg[appName]) {
    const spec = payload.spec || {};
    const appsDir = path.join(os.homedir(), '.gitlive', 'apps');
    const runPath = path.join(appsDir, appName + '-run');
    const barePath = path.join(appsDir, appName + '.git');
    fs.mkdirSync(runPath, { recursive: true });
    fs.mkdirSync(barePath, { recursive: true });
    runShGit(['init', '--bare', '-q', '-b', 'main', barePath], '.');
    const startCmd = payload.startOverride || spec.startCmd || 'node server.js';
    reg[appName] = {
      cwd: path.join(runPath, 'live'), barePath, runPath,
      installCmd: spec.installCmd || null, startCmd,
      port: spec.port || null, createdAt: new Date().toISOString(),
      mesh: { primary: payload.nodeId || 'peer' },
    };
    gitlive.saveRegistry(reg);
    created = true;
  }
  // manifest enforcement (mirrors pre-receive): present at commit → must verify
  const app = gitlive.loadRegistry()[appName];
  const check = manifest.checkCommitManifest(app.barePath, payload.commit);
  if (!check.ok) throw Object.assign(new Error('manifest check failed: ' + check.errors.join('; ')), { code: 'AUTH_ERROR' });
  // fetch bundle → main
  const bundlePath = path.join(tmpDir, appName + '-' + payload.commit.slice(0, 8) + '.bundle');
  fs.writeFileSync(bundlePath, Buffer.from(payload.bundleB64, 'base64'));
  runShGit(['--git-dir=' + app.barePath, 'fetch', bundlePath, 'main'], '.');
  runShGit(['--git-dir=' + app.barePath, 'update-ref', 'refs/heads/main', 'FETCH_HEAD'], '.');
  const applied = applyCommit(appName, payload.commit);
  return { ok: true, created, ...applied };
}

function receivePromote(payload) {
  const reg = gitlive.loadRegistry();
  const app = reg[payload.app];
  if (!app) throw Object.assign(new Error('no app ' + payload.app), { code: 'NOT_FOUND' });
  reg[payload.app] = { ...app, mesh: { ...(app.mesh || {}), primary: payload.primary || payload.nodeId } };
  gitlive.saveRegistry(reg);
  return { ok: true, app: payload.app, primary: reg[payload.app].mesh.primary };
}

function receiveRefresh(payload) {
  const reg = gitlive.loadRegistry();
  const app = reg[payload.app];
  if (!app) throw Object.assign(new Error('no app ' + payload.app), { code: 'NOT_FOUND' });
  const r = sync.restoreLatest({ dataDir: path.join(app.runPath, 'data'), barePath: payload.busPath, stagingDir: path.join(app.runPath, 'sync-stage') });
  if (!r.ok) throw Object.assign(new Error(r.reason), { code: 'INVALID_ARGS' });
  return { ok: true, restored: r.commit.slice(0, 12), snapshot: r.snapshot };
}

// receiver side of resync: snapshot MY state into MY bus and hand the bus
// path back, so a restarting peer can pull the latest state from me.
function receiveStatePull(payload) {
  const reg = gitlive.loadRegistry();
  const app = reg[payload.app];
  if (!app) throw Object.assign(new Error('no app ' + payload.app), { code: 'NOT_FOUND' });
  const dataDir = path.join(app.runPath, 'data');
  if (!fs.existsSync(path.join(dataDir, 'app.db')) && !fs.existsSync(path.join(dataDir, 'storage'))) {
    return { ok: true, empty: true, note: 'no state on this node yet' };
  }
  const bus = path.join(os.homedir(), '.gitlive', 'state', payload.app + '.git');
  const r = sync.pushSnapshot({ dataDir, stagingDir: path.join(os.homedir(), '.gitlive', 'state', payload.app + '-stage'), barePath: bus });
  return { ok: true, busPath: bus, commit: r.commit };
}

// sender helpers (run as CLI children with the SENDER's HOME)
function bundleMain(barePath) {
  const tmp = require('node:os').tmpdir();
  const f = path.join(tmp, 'glbundle-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.bundle');
  runShGit(['--git-dir=' + barePath, 'bundle', 'create', f, 'main'], '.');
  const b64 = fs.readFileSync(f).toString('base64');
  fs.rmSync(f, { force: true });
  return b64;
}

async function sendPeerOp(url, op, body) {
  const key = ensureNodeKey();
  const payload = signPeerPayload({ op, nodeId: nodeIdOf(key), publicKey: key.publicKeyPem, ts: new Date().toISOString(), ...body }, key);
  const res = await fetch(new URL('/peer/op', url).href, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || 'HTTP ' + res.status);
  return data.data;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function cmdPeer(rest, flags) {
  const sub = rest[0];
  switch (sub) {
    case 'start': {
      const port = Number(flags.port) || 5280;
      const host = flags.host || '127.0.0.1';
      const inst = startPeerServer({ port, host });
      inst.listen().then(() => {
        console.log(`gitlive peer listener on ${inst.url} (node ${inst.nodeId.slice(0, 12)}…)`);
      });
      break; // listener keeps the process alive
    }
    case 'announce': {
      const url = rest[1];
      if (!url) { console.error('usage: gitlive peer announce <peer-url> [--name <name>] [--endpoint <my-url>]'); process.exitCode = 1; return; }
      // endpoints must be the ANNOUNCER's own reachable address; defaulting to
      // the target is the documented two-node convenience.
      peerAnnounce(url, { name: flags.name, endpoints: flags.endpoint ? [String(flags.endpoint)] : [url], invite: flags.invite ? String(flags.invite) : undefined }).then((d) => {
        console.log(`announced; that peer now knows ${d.peers} peer(s)`);
      }).catch((err) => { console.error(`announce failed: ${err.message}`); process.exitCode = 1; });
      break;
    }
    case 'hello': {
      const url = rest[1];
      if (!url) { console.error('usage: gitlive peer hello <peer-url>'); process.exitCode = 1; return; }
      peerHello(url).then((d) => {
        console.log(`hello from ${d.name}: ${d.nodeId} · ${d.protocol} · key ${d.keyFingerprint.slice(0, 12)}…`);
      }).catch((err) => { console.error(`hello failed: ${err.message}`); process.exitCode = 1; });
      break;
    }
    case 'deploy': {
      // gitlive peer deploy <peer-url> <app> [--start "<cmd>"]
      const url = rest[1]; const appName = rest[2];
      if (!url || !appName) { console.error('usage: gitlive peer deploy <peer-url> <app> [--start "<cmd>"]'); process.exitCode = 1; return; }
      try {
        const reg = gitlive.loadRegistry();
        const app = reg[appName];
        if (!app) { throw new Error('no app "' + appName + '" on this node'); }
        const commit = runShGit(['--git-dir=' + app.barePath, 'rev-parse', 'main'], '.').trim();
        const spec = { installCmd: app.installCmd || null, startCmd: app.startCmd || null, port: app.port || null };
        const bundleB64 = bundleMain(app.barePath);
        const r = await sendPeerOp(url, 'deploy', { app: appName, commit, spec, startOverride: flags.start || null, bundleB64 });
        console.log(`deployed "${appName}" ${r.commit} to ${url}${r.created ? ' (created replica)' : ''} — receiver pid ${r.pid || '?'}`);
      } catch (err) { console.error('deploy over wire failed: ' + err.message); process.exitCode = 1; }
      return;
    }
    case 'refresh': {
      // gitlive peer refresh <peer-url> <app> <state-bus-path>
      const url = rest[1]; const appName = rest[2]; const busPath = rest[3];
      if (!url || !appName || !busPath) { console.error('usage: gitlive peer refresh <peer-url> <app> <state-bus-path>'); process.exitCode = 1; return; }
      try {
        const r = await sendPeerOp(url, 'state-refresh', { app: appName, busPath });
        console.log(`state refreshed on peer: restored ${r.restored} (${r.snapshot})`);
      } catch (err) { console.error('state refresh failed: ' + err.message); process.exitCode = 1; }
      return;
    }
    case 'promote': {
      // gitlive peer promote <peer-url> <app> [--primary <node-id>]
      const url = rest[1]; const appName = rest[2];
      if (!url || !appName) { console.error('usage: gitlive peer promote <peer-url> <app> [--primary <node-id>]'); process.exitCode = 1; return; }
      try {
        const key = ensureNodeKey();
        const primary = flags.primary || nodeIdOf(key);
        const r = await sendPeerOp(url, 'promote', { app: appName, primary });
        console.log(`peer now records primary ${r.primary} for "${r.app}"`);
      } catch (err) { console.error('promote failed: ' + err.message); process.exitCode = 1; }
      return;
    }
    case 'resync': {
      // gitlive peer resync <app> — no URL: finds peers from the sticky
      // peer store and pulls the newest state from the first reachable one
      // (reboot recovery, Phase 3 acceptance 4).
      const appName = rest[1];
      if (!appName) { console.error('usage: gitlive peer resync <app>'); process.exitCode = 1; return; }
      const reg = gitlive.loadRegistry();
      if (!reg[appName]) { console.error('no app "' + appName + '" on this node'); process.exitCode = 1; return; }
      const store = loadPeers();
      const peers = Object.values(store.peers || {});
      if (!peers.length) { console.error('no stored peers — announce first (gitlive peer announce <url>)'); process.exitCode = 1; return; }
      let lastErr = null;
      for (const p of peers) {
        const ep = (p.endpoints || [])[0];
        if (!ep) continue;
        try {
          const r = await sendPeerOp(ep, 'state-pull', { app: appName });
          if (r.empty) { console.log(`peer ${p.name}: no state yet — trying next`); continue; }
          const mine = reg[appName];
          const res = sync.restoreLatest({ dataDir: path.join(mine.runPath, 'data'), barePath: r.busPath, stagingDir: path.join(mine.runPath, 'sync-stage') });
          if (!res.ok) throw new Error(res.reason);
          console.log(`resynced "${appName}" from ${p.name}: restored ${res.commit.slice(0, 12)} (${res.snapshot})`);
          return;
        } catch (err) {
          lastErr = err;
          console.error(`  peer ${p.name || '?'} unreachable or refused: ${err.message}`);
        }
      }
      console.error('resync failed: no reachable peer had state (' + (lastErr ? lastErr.message : 'no peers tried') + ')');
      process.exitCode = 1;
      return;
    }
    case 'trust': {
      const action = rest[1];
      const fp = rest[2] ? String(rest[2]).toUpperCase() : null;
      const store = loadTrustedOwners();
      if (action === 'add') {
        if (!fp) { console.error('usage: gitlive peer trust add <fingerprint>'); process.exitCode = 1; return; }
        if (!store.owners.includes(fp)) { store.owners.push(fp); saveTrustedOwners(store); }
        console.log(`trusted owners: ${store.owners.length}`);
      } else if (action === 'remove') {
        if (!fp) { console.error('usage: gitlive peer trust remove <fingerprint>'); process.exitCode = 1; return; }
        store.owners = store.owners.filter((o) => o !== fp);
        saveTrustedOwners(store);
        console.log(`trusted owners: ${store.owners.length}`);
      } else if (action === 'list' || !action) {
        console.log(`trusted owners (${store.owners.length}):`);
        for (const o of store.owners) console.log('  ' + o);
        if (!store.owners.length) console.log('  (own owner only — peers with other owners are refused)');
      } else { console.error('usage: gitlive peer trust <add|remove|list> [fingerprint]'); process.exitCode = 1; }
      return;
    }
    case 'relay': {
      const rsub = rest[1];
      const relayUrl = rest[2];
      if (rsub === 'announce') {
        // gitlive peer relay announce <relay-url> <to-node> [--name n] [--endpoint u]
        const to = rest[3];
        if (!relayUrl || !to) { console.error('usage: gitlive peer relay announce <relay-url> <to-node> [--name <n>] [--endpoint <u>]'); process.exitCode = 1; return; }
        try {
          const key = ensureNodeKey();
          const ep = flags.endpoint ? [String(flags.endpoint)] : ['relay://' + nodeIdOf(key) + '@' + relayUrl.replace(/^https?:\/\//, '')];
          const rec = recordFor(key, flags.name || os.hostname(), ep);
          const signed = signPeerPayload({ ...rec, op: 'announce' }, key);
          const r = await relaySend(relayUrl, to, signed);
          console.log(`announce queued to ${to} via relay (${JSON.stringify(r)})`);
        } catch (err) { console.error('relay announce failed: ' + err.message); process.exitCode = 1; }
        return;
      }
      if (rsub === 'ping') {
        const to = rest[3];
        if (!relayUrl || !to) { console.error('usage: gitlive peer relay ping <relay-url> <to-node> [--echo <s>]'); process.exitCode = 1; return; }
        try {
          const key = ensureNodeKey();
          const signed = signPeerPayload({ op: 'ping', nodeId: nodeIdOf(key), publicKey: key.publicKeyPem, ts: new Date().toISOString(), echo: flags.echo || String(Date.now()) }, key);
          await relaySend(relayUrl, to, signed);
          console.log(`ping queued to ${to} via relay`);
        } catch (err) { console.error('relay ping failed: ' + err.message); process.exitCode = 1; }
        return;
      }
      if (rsub === 'poll') {
        if (!relayUrl) { console.error('usage: gitlive peer relay poll <relay-url>'); process.exitCode = 1; return; }
        try {
          const key = ensureNodeKey();
          const me = nodeIdOf(key);
          const got = await relayPoll(relayUrl, me);
          const msgs = got.messages || [];
          if (!msgs.length) { console.log('mailbox empty'); return; }
          for (const entry of msgs) {
            const m = entry.message;
            if (m && typeof m === 'object' && m.kind === 'relay-ack' && m.ackId) {
              const acked = verifyMessage(m) && outboxAck(String(m.ackId));
              console.log(acked ? `receipt ${String(m.ackId).slice(0, 8)}… confirmed — outbox entry cleared` : `ignored stale receipt ${String(m.ackId).slice(0, 8)}…`);
              continue;
            }
            const rep = await handleRelayMessage(m, relayUrl);
            if (rep.action === 'ponged') console.log(`pong from ${m.nodeId || '?'}${m.echo ? ' (echo ' + String(m.echo).slice(0, 12) + ')' : ''} — signature verified`);
            else if (rep.action === 'registered') console.log(`registered peer "${rep.name}" — signature + owner verified`);
            else if (rep.action === 'dropped') console.log(`dropped message: ${rep.reason}`);
            else console.log(`ignored message: ${rep.reason}`);
            if (entry.from && rep.action !== 'dropped' && rep.action !== 'error') {
              try { await relaySendAck(relayUrl, entry.from, entry.id); } catch { /* best-effort */ }
            }
          }
        } catch (err) { console.error('relay poll failed: ' + err.message); process.exitCode = 1; }
        return;
      }
      console.error('usage: gitlive peer relay <announce|ping|poll> …');
      process.exitCode = 1;
      return;
    }
    case 'list': {
      const store = loadPeers();
      const ids = Object.keys(store.peers);
      console.log(`known peers (${ids.length}):`);
      for (const id of ids) {
        const p = store.peers[id];
        console.log(`  ${id.slice(0, 12)}…  ${p.name}  ${(p.endpoints || []).join(' ')}  owner ${(p.ownerFingerprint || '').slice(0, 12)}…`);
      }
      if (!ids.length) console.log('  (none yet — gitlive peer announce <peer-url>)');
      return;
    }
    default:
      console.log(`usage:
  gitlive peer start [--port N]
  gitlive peer announce <peer-url> [--name <name>]
  gitlive peer hello <peer-url>
  gitlive peer deploy <peer-url> <app> [--start "<cmd>"]
  gitlive peer refresh <peer-url> <app> <state-bus-path>
  gitlive peer promote <peer-url> <app> [--primary <node-id>]
  gitlive peer resync <app>        (pull latest state from the first reachable stored peer)
  gitlive peer relay <sub>          announce|ping|poll — outbound-only via a relay node
  gitlive peer trust <add|remove|list> [fingerprint]   (multi-owner allowlist)
  gitlive peer list`);
      process.exitCode = 1;
  }
}

module.exports = { ensureNodeKey, nodeIdOf, signMessage, verifyMessage, signPeerPayload, startPeerServer, peerHello, peerAnnounce, loadPeers, savePeers, cmdPeer, DEFAULT_NODE_KEY, PEERS_PATH, relaySend, relayPoll, relaySendGuaranteed, relayPollAndAck, relayRetryOutbox, relaySendAck, envelopeId, outboxSummary };
