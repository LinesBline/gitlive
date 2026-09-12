// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive mesh — Phase 2 item 3: multi-node deploy policy (D1/D5).
//
// The mesh registry (mesh.json under the primary node's ~/.gitlive) lists
// member nodes as { name: { home, startCmd? } }. `gitlive mesh deploy <app>`
// takes the app's current commit and fans it out to the member nodes' own
// gitlive homes — each node gets its own bare repo + regenerated hooks +
// checked-out running copy, then the primary's state (sqlite snapshot +
// storage, item 2's sync transport) is pushed into a shared state bus and
// every replica restores from it.
//
// Cross-node work runs as child CLI processes with HOME=<node home> — every
// gitlive data function resolves its root from $HOME at load, so one machine
// can host several nodes for tests, and a real remote node is just a child
// over the Phase 3 agent channel with the same _replica-* contracts.
//
// v1 boundaries (honest): plain-mode apps only (safe/blue-green replicas are
// future work); secrets are NOT replicated; a replica is a full state mirror
// (last-writer-wins at directory level, D1).

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const gitlive = require('./gitlive.js');
const manifestModule = require('./manifest.js');
const sync = require(path.join(__dirname, 'gitlive-backend-core', 'sync.js'));

const MESH_PATH = path.join(os.homedir(), '.gitlive', 'mesh.json');
const STATE_BUS_DIR = path.join(os.homedir(), '.gitlive', 'state');
const REPLICA_SETUP_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// mesh registry
// ---------------------------------------------------------------------------
function loadMesh() {
  try { return JSON.parse(fs.readFileSync(MESH_PATH, 'utf8')); } catch { return { nodes: {} }; }
}

function saveMesh(mesh) {
  fs.mkdirSync(path.dirname(MESH_PATH), { recursive: true });
  fs.writeFileSync(MESH_PATH, JSON.stringify(mesh, null, 2) + '\n');
}

// Owner registry membership — remote nodes accepted over the wire (mesh join
// announce, or an owner-signed/trusted announce). Kept OUT of mesh.nodes:
// deploy/promote/syncMeshToPeers treat nodes as locally-hosted ({home}),
// while a remote member only has endpoints + a node-key fingerprint. The
// mesh.json copy every locally-hosted node keeps therefore carries the
// owner registry too — same file, separate section.

// ---------------------------------------------------------------------------
// F2 (Fabric program): distributed storage-key shares across mesh members.
// The storage key (which wraps everything at rest and unlocks owner-key
// ciphertext) is Shamir-split N-of-M and ONE share per member lives on a
// member's home — so no single home holds anything whole, and the local
// machine can restore its key after loss (or after a forced shred) by
// gathering N shares from surviving members. v1: locally-hosted mesh nodes
// only; remote/relay holders + the decoy share-set are the next slice.
// ---------------------------------------------------------------------------
const SHARES_FMT = 'gitlive-shares/2';
const SHARE_FMT = 'gitlive-share/2';
// F1 discipline applied to F2: EVERY share artifact is owner-signed (the
// same Ed25519 manifest key that signs deploys). A forged share or a
// swapped policy cannot pass verification — unseal checks the policy
// against the local owner key first, then each share against the policy's
// owner key. Version 2 format; v1 (unsigned) artifacts are refused with a
// clear "re-share" message (migration = mesh share --refresh).
function sharesRoot() { return path.join(os.homedir(), '.gitlive', 'shares'); }
function sharesPolicyPath() { return path.join(sharesRoot(), 'storage-policy.json'); }
function sharesMemberDir(home, ownerFp) { return path.join(home, '.gitlive', 'shares', 'gl-' + ownerFp); }
function sharesAttestDir(home, app) { return path.join(home, '.gitlive', 'attest', app); }

function loadSharesPolicy() {
  try { return JSON.parse(fs.readFileSync(sharesPolicyPath(), 'utf8')); } catch { return null; }
}
function saveSharesPolicy(policy) {
  fs.mkdirSync(sharesRoot(), { recursive: true });
  fs.writeFileSync(sharesPolicyPath(), JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });
}

// owner-signing helpers (manifest key = the single trust anchor)
function ownerSigner() {
  const m = require('./manifest.js');
  const keyPath = process.env.GITLIVE_MANIFEST_KEY || m.DEFAULT_KEY_PATH;
  if (!fs.existsSync(keyPath)) return null;
  try { return { m, key: m.loadPrivateKey(keyPath) }; } catch { return null; }
}
function ownerSign(signer, obj) {
  const body = { ...obj };
  delete body.ownerSig;
  return signer.m.signBytes(signer.key.priv, Buffer.from(signer.m.canonical(body), 'utf8'));
}
function ownerVerify(signerOrPk, obj, sig) {
  const body = { ...obj };
  delete body.ownerSig;
  const pub = signerOrPk.publicKeyPem || signerOrPk.publicKey || signerOrPk;
  try { return require('./manifest.js').verifyBytes(pub, Buffer.from(require('./manifest.js').canonical(body), 'utf8'), sig); }
  catch { return false; }
}
function sharesOwnerFp(signer) {
  return String(signer.key.fingerprint || '').replace(/:/g, '').slice(0, 8).toLowerCase();
}
function sharesSummary() {
  const p = loadSharesPolicy();
  if (!p) return { armed: false };
  return {
    armed: true,
    kind: p.kind || 'storage',
    subject: p.subject || null,
    n: p.n, m: p.m,
    memberCount: (p.members || []).length,
    refreshedAt: p.refreshedAt || null,
    createdAt: p.createdAt,
    ownerFp: p.ownerFp,
  };
}
function logShares(op, detail) {
  try { require('./crypt.js').logEvent('shares', { op, ...detail }); } catch { /* audit best-effort */ }
}
function scanMemberShares(policy) {
  // verified scan: valid = owner-signature ok; forged = file present but
  // signature invalid/absent (tampered, foreign, or pre-signing v1 format)
  const valid = [], forged = [];
  for (const mem of policy.members || []) {
    const f = path.join(sharesMemberDir(mem.home, policy.ownerFp), String(mem.index) + '.json');
    if (!fs.existsSync(f)) continue;
    try {
      const sh = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (sh.format !== SHARE_FMT || sh.ownerFp !== policy.ownerFp || sh.index !== mem.index || !sh.shareB64 || !sh.ownerSig) { forged.push({ index: mem.index, home: mem.home, file: f, reason: 'malformed or unsigned' }); continue; }
      if (!ownerVerify(policy.owner, sh, sh.ownerSig)) { forged.push({ index: mem.index, home: mem.home, file: f, reason: 'signature invalid' }); continue; }
      valid.push({ index: sh.index, data: Buffer.from(sh.shareB64, 'base64'), file: f });
    } catch { forged.push({ index: mem.index, home: mem.home, file: f, reason: 'unreadable' }); }
  }
  return { valid, forged };
}

function cmdMeshShare(subject, flags) {
  const crypt = require('./crypt.js');
  const storagePath = crypt.DEFAULT_STORAGE_KEY;
  const signer = ownerSigner();
  if (!signer) { console.error('no owner manifest key — shares must be owner-signed (create one: gitlive manifest keygen)'); process.exitCode = 1; return; }
  let key;
  try { key = fs.readFileSync(storagePath); } catch {
    console.error('no storage key at ' + storagePath + ' — create one first: gitlive crypt keygen');
    process.exitCode = 1;
    return;
  }
  if (key.length !== 32) { console.error('storage key is not a 32-byte key — refusing to share it'); process.exitCode = 1; return; }
  const mesh = loadMesh();
  const members = Object.entries(mesh.nodes).filter(([, n]) => n.home && n.home !== os.homedir() && fs.existsSync(n.home));
  const prev = loadSharesPolicy();
  const refresh = flags.refresh ? Boolean(prev) : false;
  if (!refresh && members.length === 0) { console.error('no mesh member homes to hold shares — add members: gitlive mesh add <name> --home <path>'); process.exitCode = 1; return; }
  const m = Number(flags.m) || Math.min(3, refresh ? prev.m || members.length : members.length);
  const n = Number(flags.n) || Math.min(2, m);
  if (m < 2 || m > members.length) { console.error('share count m=' + m + ' needs at least that many member homes (have ' + members.length + ')'); process.exitCode = 1; return; }
  if (n < 2 || n > m) { console.error('threshold n must satisfy 2 <= n <= m (got n=' + n + ', m=' + m + ')'); process.exitCode = 1; return; }

  const ownerFp = sharesOwnerFp(signer);
  const membersList = members.slice(0, m).map(([name, node], i) => ({ name, home: node.home, index: i + 1 }));
  const policyCore = {
    format: SHARES_FMT, kind: 'storage', subject: subject || null,
    n, m, ownerFp, keySha256: crypto.createHash('sha256').update(key).digest('hex'),
    createdAt: refresh ? (prev.createdAt || new Date().toISOString()) : new Date().toISOString(),
    refreshedAt: refresh ? new Date().toISOString() : null,
    type: 'real',
    members: membersList,
  };
  const policy = { ...policyCore, owner: { fingerprint: signer.key.fingerprint, publicKey: signer.key.publicKeyPem }, ownerSig: ownerSign(signer, policyCore) };
  const shares = crypt.splitSecretBytes(key, m, n);
  for (const mem of membersList) {
    const dir = sharesMemberDir(mem.home, ownerFp);
    fs.mkdirSync(dir, { recursive: true });
    const shareCore = { format: SHARE_FMT, ownerFp, index: mem.index, subject: policy.subject, shareB64: shares[mem.index - 1].toString('base64') };
    const shareFile = path.join(dir, String(mem.index) + '.json');
    fs.writeFileSync(shareFile, JSON.stringify({ ...shareCore, ownerSig: ownerSign(signer, shareCore) }, null, 2) + '\n', { mode: 0o600 });
  }
  for (const mem of membersList) {
    const dir = sharesMemberDir(mem.home, ownerFp);
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const idx = Number(String(f).replace(/\.json$/, ''));
      if (idx >= 1 && idx <= m) continue;
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* best effort */ }
    }
  }
  saveSharesPolicy(policy);
  logShares(refresh ? 'share-refresh' : 'share', { subject: policy.subject, n, m, members: membersList.map((x) => x.name), ownerFp: policy.ownerFp });
  console.log((refresh ? 'Refreshed' : 'Split') + ' the storage key (owner-signed): ' + n + '-of-' + m + ' across ' + m + ' member home(s)');
  for (const mem of membersList) console.log('  share #' + mem.index + ' → ' + mem.name + ' (' + mem.home + ')');
  console.log('policy: ' + sharesPolicyPath());
  console.log('restore after local loss:  gitlive mesh unseal' + (subject ? ' ' + subject : '') + (n !== m ? '  (needs ' + n + ' surviving members)' : ''));
}

function cmdMeshUnseal(subject, flags) {
  const crypt = require('./crypt.js');
  const storagePath = crypt.DEFAULT_STORAGE_KEY;
  const signer = ownerSigner();
  const policy = loadSharesPolicy();
  if (!policy || policy.kind !== 'storage') { console.error('no storage share policy — run: gitlive mesh share'); process.exitCode = 1; return; }
  if (subject && policy.subject && policy.subject !== subject) { console.error('policy is for "' + policy.subject + '", not "' + subject + '"'); process.exitCode = 1; return; }
  // 1) the policy itself must be owner-signed by THIS owner key (local anchor)
  if (!signer) { console.error('no owner manifest key to verify the share policy against'); process.exitCode = 1; return; }
  const localFp = String(signer.key.fingerprint || '');
  if (!policy.owner || policy.owner.fingerprint !== localFp) { console.error('policy owner fingerprint does not match this machine\'s owner key — foreign or swapped policy'); process.exitCode = 1; return; }
  const policyCore = { ...policy }; delete policyCore.owner; delete policyCore.ownerSig;
  if (!ownerVerify({ publicKeyPem: policy.owner.publicKey }, policyCore, policy.ownerSig)) { console.error('policy signature INVALID — the policy was tampered with or is not from your owner key'); logShares('unseal-fail', { reason: 'policy-sig-invalid' }); process.exitCode = 1; return; }
  const { valid, forged } = scanMemberShares(policy);
  const ready = valid.length >= policy.n;
  if (flags.check) {
    console.log(ready
      ? 'unseal READY — ' + valid.length + ' of ' + policy.n + ' verified shares present (m=' + policy.m + ')' + (forged.length ? '; ' + forged.length + ' forged/failed share(s) present' : '')
      : 'unseal NOT ready — ' + valid.length + ' of ' + policy.n + ' verified shares present (m=' + policy.m + ')' + (forged.length ? '; ' + forged.length + ' forged/failed share(s) present' : ''));
    process.exitCode = ready ? 0 : 1;
    return;
  }
  if (fs.existsSync(storagePath)) { console.error('storage key already present at ' + storagePath + ' — refusing to overwrite (a restore is for after loss/shred; remove the local key first if this is deliberate)'); process.exitCode = 1; return; }
  if (forged.length) {
    console.error('cannot unseal: ' + forged.length + ' member share(s) failed owner-signature verification (forged, foreign, or pre-signing v1 format) — re-share to heal: gitlive mesh share --refresh');
    logShares('unseal-fail', { reason: 'forged-shares', count: forged.length });
    process.exitCode = 1;
    return;
  }
  if (!ready) {
    console.error('cannot unseal: ' + valid.length + ' of ' + policy.n + ' verified shares present (missing indexes: ' + ((policy.members || []).map((x) => x.index).filter((i) => !valid.some((v) => v.index === i)).join(',')) + ')');
    logShares('unseal-fail', { reason: 'insufficient-shares', have: valid.length, need: policy.n });
    process.exitCode = 1;
    return;
  }
  let key;
  try {
    key = crypt.joinSecretBytes(valid.slice(0, policy.n).map((sh) => ({ x: sh.index, data: sh.data })), policy.n);
  } catch (err) { console.error('unseal failed: ' + err.message); logShares('unseal-fail', { reason: err.message }); process.exitCode = 1; return; }
  const sha = crypto.createHash('sha256').update(key).digest('hex');
  if (sha !== policy.keySha256) {
    console.error('unseal failed: recovered key does not match the policy digest — a signed share is from a different split; re-share to heal');
    logShares('unseal-fail', { reason: 'digest-mismatch' });
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(storagePath, key, { mode: 0o600 });
  logShares('unseal', { subject: policy.subject, n: policy.n, from: valid.slice(0, policy.n).map((x) => '#' + x.index) });
  console.log('storage key restored from ' + policy.n + ' verified share(s) — owner-signed policy + shares confirmed.');
  console.log('recovered key matches: ' + sha.slice(0, 16) + '…');
}

// ── attestation tier (F1 receipts made F2-distributed): after every
// successful deploy the latest receipt + the signed manifest fan out to
// member homes; `mesh verify <app>` reconstructs what actually ran from
// surviving members with owner verification.
function attestMembers() {
  return Object.entries(loadMesh().nodes || {}).filter(([, n]) => n.home && n.home !== os.homedir());
}
function cmdAttestDeploy(appName) {
  const reg = gitlive.loadRegistry();
  const app = reg[appName];
  if (!app || !app.runPath) { console.error('no registered app "' + appName + '"'); process.exitCode = 1; return; }
  const latest = gitlive.readHistory(app.runPath, 1)[0];
  if (!latest) { console.error('no deploy receipt for "' + appName + '" yet'); process.exitCode = 1; return; }
  const manifestPath = path.join(app.runPath, 'live', '.gitlive', 'app.manifest');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* unsigned apps attest receipt-only */ }
  const members = attestMembers();
  if (!members.length) { console.error('no member homes to attest to — add members: gitlive mesh add'); process.exitCode = 1; return; }
  for (const [name, node] of members) {
    const dir = sharesAttestDir(node.home, appName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ app: appName, at: new Date().toISOString(), ...latest }, null, 2) + '\n', { mode: 0o600 });
    if (manifest) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  }
  logShares('attest', { app: appName, commit: String(latest.commit || '').slice(0, 12), members: members.map(([n]) => n) });
  console.log('attested ' + appName + ' → ' + members.length + ' member home(s) (' + String(latest.commit || '').slice(0, 12) + (latest.closure ? ' · closure pinned' : ' · no closure') + (manifest ? ' · signed manifest' : ' · unsigned/legacy') + ')');
}
function cmdMeshVerify(appName) {
  if (!appName) { console.error('usage: gitlive mesh verify <app-name>'); process.exitCode = 1; return; }
  const members = attestMembers();
  if (!members.length) { console.error('no member homes to verify against'); process.exitCode = 1; return; }
  let found = 0;
  for (const [name, node] of members) {
    const dir = sharesAttestDir(node.home, appName);
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      const m = require('./manifest.js');
      const v = m.verifyManifest(manifest, {});
      const sig = v.ok ? 'owner signature VALID' : 'owner signature INVALID (' + (v.errors || []).join('; ') + ')';
      console.log('member ' + name + ': commit ' + String(rec.commit || '—').slice(0, 12) + ' · ' + String(rec.outcome || '') + ' · ' + (rec.at ? rec.at : '') + (rec.closure ? ' · closure pinned ' + String(rec.closure).slice(0, 8) : ' · no closure recorded') + ' · ' + sig);
      found++;
    } catch {
      console.log('member ' + name + ': no attestation record for ' + appName + ' (or record is unreadable)');
    }
  }
  if (!found) { console.error('no member holds an attestation for ' + appName); process.exitCode = 1; return; }
}

function meshRegisterRemote(name, { fingerprint, endpoints = [] } = {}) {
  if (!name || name === 'self') return { registered: false, reason: 'no remote member name' };
  const mesh = loadMesh();
  if (!mesh.nodes.self) mesh.nodes.self = { home: os.homedir() };
  const members = mesh.members || (mesh.members = {});
  const existing = members[name];
  if (existing && existing.fingerprint && existing.fingerprint !== fingerprint) {
    return { registered: false, reason: `member name "${name}" is already taken by a different node key` };
  }
  const rec = existing || { fingerprint, remote: true, joinedAt: new Date().toISOString() };
  rec.fingerprint = fingerprint;
  rec.endpoints = endpoints.length ? endpoints : rec.endpoints || [];
  rec.lastSeenAt = new Date().toISOString();
  members[name] = rec;
  saveMesh(mesh);
  syncMeshToPeers(mesh);
  return { registered: true };
}

function cmdMeshAdd(name, flags) {
  if (!name || !flags.home) {
    console.log('usage: gitlive mesh add <node-name> --home <path> [--start "<cmd>"]');
    process.exitCode = 1;
    return;
  }
  const home = path.resolve(String(flags.home));
  if (!fs.existsSync(home)) {
    console.error(`node home does not exist: ${home}`);
    process.exitCode = 1;
    return;
  }
  if (home === os.homedir()) {
    console.error('a node home must differ from this machine\'s own home (self is implicit)');
    process.exitCode = 1;
    return;
  }
  const mesh = loadMesh();
  if (mesh.nodes[name]) {
    console.error(`node "${name}" already registered`);
    process.exitCode = 1;
    return;
  }
  mesh.nodes[name] = { home, ...(flags.start ? { startCmd: String(flags.start) } : {}) };
  // 'self' is implicit; every node (incl. self) gets a copy of mesh.json so
  // failover can be driven from any surviving node.
  if (!mesh.nodes.self) mesh.nodes.self = { home: os.homedir() };
  saveMesh(mesh);
  syncMeshToPeers(mesh);
  console.log(`Added mesh node "${name}" → ${home}`);
}

function cmdMeshList() {
  const mesh = loadMesh();
  const names = Object.keys(mesh.nodes);
  console.log(`mesh nodes (self = ${os.hostname()}, ${os.homedir()}):`);
  if (!names.length) { console.log('  (none — add with: gitlive mesh add <name> --home <path>)'); }
  for (const n of names) {
    console.log(`  ${n}  →  ${mesh.nodes[n].home}${mesh.nodes[n].startCmd ? `  (start: ${mesh.nodes[n].startCmd})` : ''}`);
  }
  const members = Object.entries(mesh.members || {});
  if (members.length) {
    console.log('owner registry members (remote, joined over the wire):');
    for (const [name, m] of members) {
      console.log(`  ${name}  →  ${(m.endpoints || []).join(', ')}  (key ${String(m.fingerprint || '').slice(0, 12)}…)`);
    }
  }
}

// Cleanup for either kind of entry: a locally-hosted mesh node, or a remote
// owner-registry member (whose peer row is dropped too, so a removed member
// cannot keep announcing itself as known).
function cmdMeshRm(name) {
  if (!name) { console.log('usage: gitlive mesh rm <node-name|member-name>'); process.exitCode = 1; return; }
  if (name === 'self') { console.error('"self" is implicit — it cannot be removed'); process.exitCode = 1; return; }
  const mesh = loadMesh();
  let removed = false;
  let where = '';
  if (mesh.nodes[name]) {
    delete mesh.nodes[name];
    removed = true;
    where = 'mesh registry';
  } else if (mesh.members && mesh.members[name]) {
    const fp = mesh.members[name].fingerprint || null;
    delete mesh.members[name];
    removed = true;
    where = 'owner registry';
    try {
      const peerMod = require('./peer.js');
      const store = peerMod.loadPeers();
      let hit = false;
      for (const [k, v] of Object.entries(store.peers || {})) {
        if ((fp && k === fp) || (v && v.name === name)) { delete store.peers[k]; hit = true; }
      }
      if (hit) peerMod.savePeers(store);
    } catch { /* peer store is optional on a bare node */ }
  }
  if (!removed) { console.error(`no mesh node or member named "${name}"`); process.exitCode = 1; return; }
  saveMesh(mesh);
  syncMeshToPeers(mesh);
  console.log(`Removed "${name}" from the ${where}.`);
}

// ---------------------------------------------------------------------------
// policy deploy (runs on the primary node)
// ---------------------------------------------------------------------------
function cmdMeshDeploy(appName, flags) {
  const reg = gitlive.loadRegistry();
  const app = reg[appName];
  if (!app) {
    console.error(`No app named "${appName}". Run "gitlive list".`);
    process.exitCode = 1;
    return;
  }
  if (app.safe) {
    console.error(`mesh replicas v1 support plain-mode apps only — "${appName}" is safe (blue-green).`);
    process.exitCode = 1;
    return;
  }
  const mesh = loadMesh();
  const peers = Object.entries(mesh.nodes).filter(([, n]) => n.home !== os.homedir());
  const minNodes = Number(flags['min-nodes']) || 2;
  const total = peers.length + 1; // self + peers
  if (total < minNodes) {
    console.error(`mesh policy needs >= ${minNodes} nodes; this machine has ${peers.length} peer(s) + self = ${total}. Add nodes: gitlive mesh add`);
    process.exitCode = 1;
    return;
  }

  console.log(`mesh deploy "${appName}" → ${total} nodes (policy >=${minNodes})`);
  const storagePolicy = flags.storage === 'owner-key' ? 'owner-key' : (app.mesh && app.mesh.storage) || 'host-may-read';
  const entryBase = {
    port: app.port || null,
    installCmd: app.installCmd || null,
    startCmd: app.startCmd || null,
    storage: storagePolicy,
  };
  const results = [];
  for (const [name, node] of peers) {
    console.log(`  → deploying to node "${name}" (${node.home})...`);
    const startOverride = node.startCmd || null;
    const child = spawnSync('node', [path.join(__dirname, 'gitlive.js'), '_replica-setup', appName,
      Buffer.from(JSON.stringify(entryBase)).toString('base64'),
      startOverride ? Buffer.from(startOverride).toString('base64') : '',
    ], {
      env: { ...process.env, HOME: node.home, GITLIVE_MESH_SOURCE_BARE: app.barePath, GITLIVE_MESH_PRIMARY_HOME: os.homedir() },
      encoding: 'utf8', timeout: REPLICA_SETUP_TIMEOUT_MS,
    });
    const out = (child.stdout || '') + (child.stderr || '');
    if (child.status !== 0) {
      console.error(`    node "${name}" FAILED: ${out.split('\n').slice(0, 4).join('\n    ')}`);
      results.push({ node: name, ok: false, error: out.split('\n')[0] });
      continue;
    }
    console.log(`    node "${name}" ok: ${out.trim().split('\n').pop()}`);
    results.push({ node: name, ok: true });
  }

  // mark the SELF registry entry as meshed (replicas already record their side)
  const selfEntry = gitlive.loadRegistry();
  if (selfEntry[appName]) {
    selfEntry[appName] = { ...selfEntry[appName], mesh: { ...(selfEntry[appName].mesh || {}), primary: 'self', replicas: peers.map(([k]) => k), storage: storagePolicy } };
    gitlive.saveRegistry(selfEntry);
  }

  // State bus: push primary state once, restore on every replica.
  const bus = path.join(STATE_BUS_DIR, `${appName}.git`);
  const primaryData = path.join(app.runPath, 'data');
  if (fs.existsSync(path.join(primaryData, 'app.db')) || fs.existsSync(path.join(primaryData, 'storage'))) {
    const regNow = gitlive.loadRegistry();
    const policy = (regNow[appName] && regNow[appName].mesh && regNow[appName].mesh.storage) || 'host-may-read';
    const encryptKey = policy === 'owner-key' ? readStorageKeyOrDie() : undefined;
    console.log(`  syncing state → replicas (sqlite snapshot + storage)${encryptKey ? ' [owner-key: encrypted on the bus]' : ''}`);
    sync.pushSnapshot({ dataDir: primaryData, stagingDir: path.join(STATE_BUS_DIR, `${appName}-stage`), barePath: bus, encryptKey });
    for (const [name, node] of peers) {
      const child = spawnSync('node', [path.join(__dirname, 'gitlive.js'), '_peer-restore', appName, bus],
        { env: peerChildEnv(node.home), encoding: 'utf8', timeout: REPLICA_SETUP_TIMEOUT_MS });
      const out = (child.stdout || '') + (child.stderr || '');
      if (child.status !== 0) console.error(`    state restore on "${name}" FAILED: ${out.split('\n')[0]}`);
      else console.log(`    state restored on "${name}": ${out.trim().split('\n').pop()}`);
    }
  } else {
    console.log('  (no state yet on the primary — nothing to sync)');
  }

  console.log('\nmesh deploy done. Check every node with: gitlive mesh status ' + appName);
}

// ---------------------------------------------------------------------------
// replica contracts (child processes with HOME=<node home>)
// ---------------------------------------------------------------------------
function replicaSetup(appName, entryB64, startB64) {
  const entry = JSON.parse(Buffer.from(entryB64, 'base64').toString('utf8'));
  const startOverride = startB64 ? Buffer.from(startB64, 'base64').toString('utf8') : null;
  const reg = gitlive.loadRegistry();
  if (reg[appName]) {
    throw new Error(`app "${appName}" already exists on this node — refusing to overwrite`);
  }
  // This child runs with HOME=<node home>, so the primary's registry is not
  // visible here: the deploy orchestrator passes the primary's bare repo
  // through GITLIVE_MESH_SOURCE_BARE.
  const primaryBare = process.env.GITLIVE_MESH_SOURCE_BARE;
  if (!primaryBare || !fs.existsSync(path.join(primaryBare, 'HEAD'))) {
    throw new Error('missing primary bare repo (GITLIVE_MESH_SOURCE_BARE)');
  }

  const appsDir = path.join(os.homedir(), '.gitlive', 'apps');
  const runPath = path.join(appsDir, `${appName}-run`);
  const barePath = path.join(appsDir, `${appName}.git`);
  const logPath = path.join(runPath, 'deploy.log');

  fs.mkdirSync(runPath, { recursive: true });
  fs.mkdirSync(barePath, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', barePath]);

  const startCmd = startOverride || entry.startCmd || 'node server.js';
  const installCmd = entry.installCmd || null;
  const hook = gitlive.buildHook({ barePath, runPath, installCmd, startCmd, logPath, secretsPath: gitlive.secretsPath(appName), nice: undefined, memoryLimitMb: undefined, gitliveFile: path.join(__dirname, 'gitlive.js'), name: appName });
  fs.writeFileSync(path.join(barePath, 'hooks', 'post-receive'), hook);
  fs.chmodSync(path.join(barePath, 'hooks', 'post-receive'), 0o755);
  manifestModule.installPreReceiveHook({ barePath, gitliveFile: path.join(__dirname, 'gitlive.js') });

  // Fan the primary's current commit into this replica's bare repo — the
  // regenerated hooks do the checkout/install/start on this node.
  const push = execFileSync('git', ['--git-dir=' + primaryBare, 'push', barePath, 'main'], { encoding: 'utf8' });

  reg[appName] = {
    cwd: path.join(runPath, 'live'),
    barePath,
    runPath,
    installCmd,
    startCmd,
    port: entry.port,
    createdAt: new Date().toISOString(),
    mesh: { replicaOf: appName, primaryHome: process.env.GITLIVE_MESH_PRIMARY_HOME || null, primary: 'self', storage: entry.storage || 'host-may-read' },
  };
  gitlive.saveRegistry(reg);

  const commit = execFileSync('git', ['--git-dir=' + barePath, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  console.log(`replica "${appName}" live on this node at ${commit.slice(0, 12)}`);
}

function peerStatus(appName) {
  const reg = gitlive.loadRegistry();
  const app = reg[appName];
  if (!app) throw new Error(`no app "${appName}" on this node`);
  const pidFile = path.join(app.runPath, 'app.pid');
  const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : null;
  const alive = Boolean(pid && gitlive.isAlive(pid));
  const commit = execFileSync('git', ['--git-dir=' + app.barePath, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const dataDir = path.join(app.runPath, 'data');
  console.log(JSON.stringify({
    name: appName, node: os.hostname(), home: os.homedir(),
    selfKey: selfKey(loadMesh()),
    primary: (app.mesh && app.mesh.primary) || null,
    pid: alive ? pid : null, alive, commit, runPath: app.runPath, dataDir,
    dataPresent: fs.existsSync(path.join(dataDir, 'app.db')) || fs.existsSync(path.join(dataDir, 'storage')),
  }));
}

function peerRestore(appName, bus) {
  const reg = gitlive.loadRegistry();
  const app = reg[appName];
  if (!app) throw new Error(`no app "${appName}" on this node`);
  const dataDir = path.join(app.runPath, 'data');
  const staging = path.join(app.runPath, 'sync-stage');
  // owner-key policy: try THIS node's storage key; without it the node keeps
  // ciphertext only (the policy's promise) and says so.
  const crypt = require('./crypt.js');
  const keyPath = process.env.GITLIVE_STORAGE_KEY || crypt.DEFAULT_STORAGE_KEY;
  const decryptKey = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : undefined;
  const r = sync.restoreLatest({ dataDir, barePath: bus, stagingDir: staging, decryptKey });
  if (!r.ok) {
    const msg = /owner-key encrypted/.test(r.reason)
      ? 'state is owner-key ciphertext and this node has no storage key — stored encrypted; unlock by placing the key (gitlive crypt keygen or copy)'
      : r.reason;
    throw new Error(msg);
  }
  console.log(`restored state ${r.commit.slice(0, 12)} (${r.snapshot})${r.encrypted ? ' [decrypted with this node\'s storage key]' : ''}`);
}

// ---------------------------------------------------------------------------
// PRIMARY BOOKKEEPING (item 4 failover)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// primary bookkeeping + failover (item 4)
// ---------------------------------------------------------------------------
// node identity (item 5): a human handle + short node id, stored locally
const NODE_NAME_PATH = path.join(os.homedir(), '.gitlive', 'node.name');
function nodeName() {
  try {
    const n = fs.readFileSync(NODE_NAME_PATH, 'utf8').trim();
    if (n) return n;
  } catch { /* fall through */ }
  return os.hostname();
}
function setNodeName(name) {
  fs.mkdirSync(path.dirname(NODE_NAME_PATH), { recursive: true });
  fs.writeFileSync(NODE_NAME_PATH, String(name).trim() + '\n');
  return String(name).trim();
}
function whoami() {
  const mesh = loadMesh();
  const key = selfKey(mesh);
  return { name: nodeName(), nodeKey: key, id: key === 'self' ? 'self' : key };
}

function selfKey(mesh) {
  for (const [k, n] of Object.entries(mesh.nodes)) {
    if (n.home === os.homedir()) return k;
  }
  return 'self';
}

// Every node keeps a copy of mesh.json (self included) so failover can be
// driven from ANY surviving node — the registry is part of the mesh state.
function syncMeshToPeers(mesh) {
  for (const n of Object.values(mesh.nodes)) {
    const dst = path.join(n.home, '.gitlive', 'mesh.json');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, JSON.stringify(mesh, null, 2) + '\n');
  }
}

function nodeHome(mesh, key) {
  const n = mesh.nodes[key];
  if (!n) throw new Error(`no mesh node "${key}" (run gitlive mesh list)`);
  return n.home;
}

function runPeer(args, home) {
  const child = spawnSync('node', [path.join(__dirname, 'gitlive.js'), ...args],
    { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: REPLICA_SETUP_TIMEOUT_MS });
  const out = ((child.stdout || '') + (child.stderr || '')).trim();
  if (child.status !== 0) throw new Error(`peer op on ${home} failed: ${(out.split('\n')[0] || 'unknown').trim()}`);
  return out;
}

function peerReport(home, appName) {
  const out = runPeer(['_peer-status', appName], home);
  return JSON.parse(out.split('\n').pop());
}

function cmdMeshPromote(appName, targetKey, flags) {
  const mesh = loadMesh();
  const key = selfKey(mesh);
  const homes = new Set([os.homedir(), ...Object.values(mesh.nodes).map((n) => n.home)]);
  for (const home of homes) {
    try { peerReport(home, appName); } catch {
      console.error(`app "${appName}" is not present on ${home} — deploy it first (gitlive mesh deploy)`);
      process.exitCode = 1;
      return;
    }
  }
  const targetHome = nodeHome(mesh, targetKey);
  for (const home of homes) {
    runPeer(['_peer-set-primary', appName, targetKey], home);
  }
  console.log(`promoted "${appName}" → primary ${targetKey} (${targetHome})`);
  console.log(`data-loss bound: time since last state sync. Sync now with: gitlive mesh sync ${appName}`);
}

function meshRoster(appName) {
  const mesh = loadMesh();
  const rows = [];
  const seen = new Set([os.homedir()]);
  try { rows.push({ key: selfKey(mesh), home: os.homedir(), ...peerReport(os.homedir(), appName) }); }
  catch { rows.push({ key: selfKey(mesh), home: os.homedir(), alive: false, dataPresent: false, error: 'not present on self' }); }
  for (const [key, node] of Object.entries(mesh.nodes)) {
    if (seen.has(node.home)) continue;
    seen.add(node.home);
    try { rows.push({ key, home: node.home, ...peerReport(node.home, appName) }); }
    catch { rows.push({ key, home: node.home, alive: false, dataPresent: false, error: 'unreachable' }); }
  }
  return rows;
}

function cmdMeshRecover(appName, fromKey, flags) {
  const rows = meshRoster(appName);
  const aliveRows = rows.filter((r) => r.alive);
  const dataRows = rows.filter((r) => r.dataPresent);

  console.log(`recovery roster for "${appName}" (heartbeat + state report):`);
  for (const r of rows) {
    const star = r.primary === r.key ? ' ★primary' : '';
    console.log(`  ${r.key}: ${r.alive === undefined ? '? (no app)' : r.alive ? 'UP' : 'down'}${star} · data ${r.dataPresent ? 'present' : 'none'} · commit ${r.commit ? r.commit.slice(0, 8) : '—'}${r.error ? ' (' + r.error + ')' : ''}`);
  }

  let src = null;
  if (fromKey) {
    src = rows.find((r) => r.key === fromKey) || null;
    if (!src) { console.error(`no roster row for --from "${fromKey}"`); process.exitCode = 1; return; }
  } else {
    src = aliveRows.find((r) => r.primary === r.key) || aliveRows.find((r) => r.dataPresent) || dataRows[0] || null;
  }
  if (!src || !src.dataPresent) {
    console.error('no node holds state — nothing to recover (run the app somewhere first)');
    process.exitCode = 1;
    return;
  }
  const bus = path.join(os.homedir(), '.gitlive', 'state', `${appName}.git`);
  const crypt = require('./crypt.js');
  let encryptKey;
  try {
    const reg = gitlive.loadRegistry();
    const meta = reg[appName] && reg[appName].mesh;
    if (meta && meta.storage === 'owner-key') {
      const kp = process.env.GITLIVE_STORAGE_KEY || crypt.DEFAULT_STORAGE_KEY;
      if (fs.existsSync(kp)) encryptKey = fs.readFileSync(kp);
    }
  } catch { /* plaintext */ }
  console.log(`  source: ${src.key} (${src.alive ? 'UP' : 'DOWN — last-resort copy'}) — snapshotting + fanning out`);
  sync.pushSnapshot({ dataDir: src.dataDir, stagingDir: path.join(os.homedir(), '.gitlive', 'state', `${appName}-stage`), barePath: bus, encryptKey });
  let restored = 0;
  for (const r of rows) {
    if (r.key === src.key || !r.commit) continue;
    try {
      const child = spawnSync('node', [path.join(__dirname, 'gitlive.js'), '_peer-restore', appName, bus],
        { env: peerChildEnv(r.home), encoding: 'utf8', timeout: REPLICA_SETUP_TIMEOUT_MS });
      const out = ((child.stdout || '') + (child.stderr || '')).trim();
      if (child.status !== 0) { console.error(`  ${r.key}: restore failed: ${out.split('\n')[0]}`); continue; }
      console.log(`  ${r.key}: state restored (${out.split('\n').pop()})`);
      restored++;
    } catch (err) { console.error(`  ${r.key}: restore failed: ${err.message}`); }
  }
  const deadPrimary = rows.find((r) => r.primary === r.key && !r.alive);
  console.log(`recovery complete — ${restored} node(s) restored from ${src.key}`);
  if (deadPrimary && src.key !== deadPrimary.key) {
    console.log(`note: the recorded primary "${deadPrimary.key}" is down — promote the source: gitlive mesh promote ${appName} ${src.key} (owner decides)`);
  }
}

function cmdMeshSync(appName, fromKey, flags) {
  const mesh = loadMesh();
  let from = fromKey || null;
  if (!from) {
    // default: whichever node's registry records itself as primary
    const candidates = [['self', os.homedir()], ...Object.entries(mesh.nodes).map(([k, n]) => [k, n.home])];
    for (const [key, home] of candidates) {
      try {
        if (peerReport(home, appName).primary === key) { from = key; break; }
      } catch { /* absent on this node */ }
    }
    if (!from) from = 'self';
  }
  const srcHome = from === 'self' ? os.homedir() : nodeHome(mesh, from);
  const src = peerReport(srcHome, appName);
  if (!src.alive) console.log(`note: primary source (${from}) is down — syncing its last written state anyway`);
  const bus = path.join(os.homedir(), '.gitlive', 'state', `${appName}.git`);
  let encryptKey;
  try {
    const reg = gitlive.loadRegistry();
    const meta = reg[appName] && reg[appName].mesh;
    if (meta && meta.storage === 'owner-key') encryptKey = readStorageKeyOrDie();
  } catch { /* fall back to plaintext push */ }
  sync.pushSnapshot({ dataDir: src.dataDir, stagingDir: path.join(os.homedir(), '.gitlive', 'state', `${appName}-stage`), barePath: bus, encryptKey });
  for (const [k, n] of Object.entries(mesh.nodes)) {
    if (n.home === srcHome) continue;
    try {
      const r = (() => {
        const child = spawnSync('node', [path.join(__dirname, 'gitlive.js'), '_peer-restore', appName, bus],
          { env: peerChildEnv(n.home), encoding: 'utf8', timeout: REPLICA_SETUP_TIMEOUT_MS });
        const out = ((child.stdout || '') + (child.stderr || '')).trim();
        if (child.status !== 0) throw new Error(out.split('\n')[0] || 'restore failed');
        return out;
      })();
      console.log(`  ${k}: ${r.split('\n').pop()}`);
    } catch (err) {
      console.error(`  ${k}: restore failed — ${err.message}`);
    }
  }
  console.log(`state synced from ${from} to every other node`);
}

// owner-key policy: the mesh master reads ITS storage key; peers try THEIR
// home storage key (present = can restore/unlock; absent = ciphertext only).

// peer children must resolve keys from THEIR home, never inherit the
// orchestrator's storage key env (owner-key policy integrity).
function peerChildEnv(home) {
  const e = { ...process.env, HOME: home };
  delete e.GITLIVE_STORAGE_KEY;
  delete e.GITLIVE_DECOY_KEY;
  delete e.GITLIVE_DECOY_DIR;
  return e;
}

function readStorageKeyOrDie() {
  const crypt = require('./crypt.js');
  const p = process.env.GITLIVE_STORAGE_KEY || crypt.DEFAULT_STORAGE_KEY;
  if (!fs.existsSync(p)) throw new Error('storage policy is owner-key but no storage key at ' + p + ' — gitlive crypt keygen');
  return fs.readFileSync(p);
}

function peerSetPrimary(appName, primaryKey) {
  const reg = gitlive.loadRegistry();
  const app = reg[appName];
  if (!app) throw new Error(`no app "${appName}" on this node`);
  reg[appName] = { ...app, mesh: { ...(app.mesh || {}), primary: primaryKey } };
  gitlive.saveRegistry(reg);
  console.log(`primary for "${appName}" on this node → ${primaryKey}`);
}
// ---------------------------------------------------------------------------
// cooperative onboarding slice (item 6): owner-signed invite tokens
// ---------------------------------------------------------------------------
function loadOwnerKeyOrDie() {
  const manifest = require('./manifest.js');
  const keyPath = process.env.GITLIVE_MANIFEST_KEY || manifest.DEFAULT_KEY_PATH;
  if (!fs.existsSync(keyPath)) {
    throw new Error(`no owner manifest key at ${keyPath} — run "gitlive manifest keygen" first`);
  }
  return manifest.loadPrivateKey(keyPath);
}

function createInviteToken({ name, ttlHours = 24, keyPath } = {}) {
  const manifest = require('./manifest.js');
  const key = keyPath ? manifest.loadPrivateKey(keyPath) : loadOwnerKeyOrDie();
  const now = Math.floor(Date.now() / 1000);
  // ownerPublicKey is embedded so a JOINING node (which has no owner key yet)
  // can verify the signature against the embedded key; the fingerprint lets
  // an owner-side verifier confirm identity without trusting the payload.
  const core = { v: 1, role: 'node', name: name || 'friend-node', iat: now, exp: now + ttlHours * 3600, ownerFingerprint: key.fingerprint, ownerPublicKey: key.publicKeyPem };
  const sig = manifest.signBytes(key.priv, Buffer.from(manifest.canonical(core), 'utf8'));
  return Buffer.from(JSON.stringify({ ...core, sig })).toString('base64url');
}

// keyPath given → the OWNER verifies (fingerprint must equal my owner key).
// No keyPath → the JOINER verifies against the embedded public key (the
// fingerprint is then self-descriptive, which is fine for introduction —
// real trust is established when the owner's node accepts the announce).
function verifyInviteToken(token, { keyPath } = {}) {
  const manifest = require('./manifest.js');
  let payload;
  try { payload = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'token is not valid base64url JSON' }; }
  const core = { ...payload };
  delete core.sig;
  const now = Math.floor(Date.now() / 1000);
  if (!payload.sig) return { ok: false, reason: 'token is not signed' };
  if (!payload.exp || !payload.ownerPublicKey) return { ok: false, reason: 'token lacks expiry/owner fields' };
  if (now > payload.exp) return { ok: false, reason: `token expired ${Math.floor((now - payload.exp) / 60)}m ago` };
  const verifyOk = manifest.verifyBytes(payload.ownerPublicKey, Buffer.from(manifest.canonical(core), 'utf8'), payload.sig);
  if (!verifyOk) return { ok: false, reason: 'owner signature does not verify' };
  const fp = manifest.fingerprintFromPublicKey(payload.ownerPublicKey);
  if (payload.ownerFingerprint !== fp) return { ok: false, reason: 'token fingerprint does not match its key' };
  if (keyPath) {
    const key = manifest.loadPrivateKey(keyPath);
    if (fp !== key.fingerprint) return { ok: false, reason: `token owner ${fp.slice(0, 12)}… != my owner ${key.fingerprint.slice(0, 12)}…` };
  }
  return { ok: true, name: payload.name, role: payload.role, exp: payload.exp, fingerprint: fp };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function cmdMesh(rest, flags) {
  const sub = rest[0];
  const appName = rest[1];
  switch (sub) {
    case 'add': return cmdMeshAdd(appName, flags);
    case 'list': return cmdMeshList();
    case 'rm': {
      if (!appName) { console.error('usage: gitlive mesh rm <node-name|member-name>'); process.exitCode = 1; return; }
      return cmdMeshRm(appName);
    }
    case 'share': {
      return cmdMeshShare(appName, flags); // app name optional — labels the policy
    }
    case 'unseal': {
      return cmdMeshUnseal(appName, flags);
    }
    case 'verify': {
      return cmdMeshVerify(appName, flags);
    }
    case 'deploy': return cmdMeshDeploy(appName, flags);
    case 'join': {
      // gitlive mesh join <token> <owner-peer-url> [--name <n>] — run on the
      // NEW node: verifies the invite (embedded owner key, no local key
      // needed) then announces itself carrying the invite, which the owner's
      // node accepts as introduction.
      const token = rest[1];
      const ownerUrl = rest[2];
      if (!token || !ownerUrl) { console.error('usage: gitlive mesh join <token> <owner-peer-url> [--name <n>]'); process.exitCode = 1; return; }
      try {
        const check = verifyInviteToken(token); // joiner-side: embedded key
        if (!check.ok) { console.error('join refused: ' + check.reason); process.exitCode = 1; return; }
        const name = flags.name || check.name || os.hostname();
        const peer = require('./peer.js'); // lazy: peer.js requires mesh.js
        const r = await peer.peerAnnounce(ownerUrl, { name, endpoints: flags.endpoint ? [String(flags.endpoint)] : [ownerUrl], invite: token });
        console.log(`joined as "${name}" — owner node accepted the invite (${r.peers} peer(s) known there)`);
      } catch (err) { console.error('join failed: ' + err.message); process.exitCode = 1; }
      return;
    }
    case 'whoami': {
      const w = whoami();
      console.log(`${w.name}@${w.id}`);
      return;
    }
    case 'set-name': {
      const name = rest[1];
      if (!name) { console.error('usage: gitlive mesh set-name <name>'); process.exitCode = 1; return; }
      setNodeName(name);
      console.log(`this node is now "${name}"`);
      return;
    }
    case 'invite': {
      try {
        const ttl = Number(flags['ttl-h']) || 24;
        const name = flags.name || 'friend-node';
        const token = createInviteToken({ name, ttlHours: ttl });
        console.log(`invite for "${name}" (owner-signed, ${ttl}h, valid until ${new Date(Date.now() + ttl * 3600 * 1000).toISOString()}):`);
        console.log(token);
      } catch (err) { console.error('invite failed: ' + err.message); process.exitCode = 1; }
      return;
    }
    case 'verify-invite': {
      const token = rest[1];
      if (!token) { console.error('usage: gitlive mesh verify-invite <token>'); process.exitCode = 1; return; }
      // owner-side verification is STRICT: the token must carry MY owner
      // key's signature (keyPath), not merely a self-consistent one.
      const keyPath = process.env.GITLIVE_MANIFEST_KEY;
      let r;
      try {
        r = keyPath ? verifyInviteToken(token, { keyPath }) : verifyInviteToken(token);
      } catch (err) {
        r = { ok: false, reason: err.message };
      }
      if (r.ok) console.log(`OK: invite for "${r.name}" (role ${r.role}) — signed by my owner key, unexpired`);
      else { console.error('invite invalid: ' + r.reason); process.exitCode = 1; }
      return;
    }
    case 'recover': {
      if (!appName) { console.error('usage: gitlive mesh recover <app> [--from <node>]'); process.exitCode = 1; return; }
      return cmdMeshRecover(appName, flags.from || null, flags);
    }
    case 'promote': {
      if (!appName || !rest[2]) { console.error('usage: gitlive mesh promote <app-name> <node-name>'); process.exitCode = 1; return; }
      return cmdMeshPromote(appName, rest[2], flags);
    }
    case 'sync': {
      if (!appName) { console.error('usage: gitlive mesh sync <app-name> [--from <node>]'); process.exitCode = 1; return; }
      return cmdMeshSync(appName, flags.from || null, flags);
    }
    case 'status': {
      if (!appName) { console.error('usage: gitlive mesh status <app-name>'); process.exitCode = 1; return; }
      const mesh = loadMesh();
      const peers = Object.entries(mesh.nodes).filter(([, n]) => n.home !== os.homedir());
      console.log(`self (${os.hostname()}):`);
      try {
        const st = gitlive.getStatusData(appName);
        console.log(`  ${appName}: runPath ${st.runPath}${st.up ? ' (up)' : ' (down)'}`);
      } catch (err) {
        console.log(`  ${appName}: not present on self (${err.message})`);
      }
      for (const [name, node] of peers) {
        const child = spawnSync('node', [path.join(__dirname, 'gitlive.js'), '_peer-status', appName],
          { env: { ...process.env, HOME: node.home }, encoding: 'utf8', timeout: 10_000 });
        const out = ((child.stdout || '') + (child.stderr || '')).trim();
        if (child.status !== 0) { console.log(`  ${name}: ${out.split('\n')[0] || 'unreachable'}`); continue; }
        const j = JSON.parse(out.split('\n').pop());
        const star = j.primary === name ? ' ★primary' : '';
        console.log(`  ${name}: ${j.alive ? 'UP' : 'down'}${star} · commit ${j.commit.slice(0, 8)} · ${j.runPath}`);
      }
      return;
    }
    default:
      console.log(`usage:
  gitlive mesh add <node-name> --home <path> [--start "<cmd>"]
  gitlive mesh list
  gitlive mesh rm <node-name|member-name>          (registry cleanup)
  gitlive mesh share [app] [--n <req> --m <total>]   split the storage key N-of-M
                            across member homes (--refresh re-splits)
  gitlive mesh unseal [app] [--check]                restore the storage key from
                            surviving member shares after local loss/shred
  gitlive mesh verify <app>                          ask member homes what the owner
                            last ran (attested receipts, owner-verified)
  gitlive mesh deploy <app> [--min-nodes N] [--storage owner-key]
  gitlive mesh status <app>
  gitlive mesh recover <app> [--from <node>]   (heartbeat report + re-replicate from a survivor)
  gitlive mesh invite [--name <n>] [--ttl-h <hours>]     (owner-signed join token)
  gitlive mesh verify-invite <token>
  gitlive mesh join <token> <owner-peer-url> [--name <n>]  (run on the NEW node)
  gitlive mesh whoami | set-name <name>                     (node identity)`);
      process.exitCode = 1;
  }
}

module.exports = {
  cmdMesh, replicaSetup, peerStatus, peerRestore, peerSetPrimary,
  loadMesh, saveMesh, MESH_PATH, selfKey, syncMeshToPeers, nodeHome, peerReport, runPeer,
  meshRegisterRemote, sharesSummary, cmdAttestDeploy, cmdMeshVerify,
  createInviteToken, verifyInviteToken,
};
