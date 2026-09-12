// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive control-plane server — Phase 1 (`gitlive serve`).
//
// Node built-ins only, no framework, no npm deps: one http server that
// (a) serves the single-file dashboard at /, (b) exposes the /api/* JSON
// envelope, (c) backs accounts+sessions with gitlive-client itself (v2.4
// auth, dogfooded), and (d) executes app actions in-process through
// gitlive.js's exported data functions — the exact pattern mcp/server.js
// already uses, so the API is a pass-through to logic the CLI proves, never
// a second implementation.
//
// Every gitlive-client call is a promise (the client dispatches through a
// daemon probe even in standalone mode) — this server awaits all of them.
// Registration is serialized through an in-process chain because the
// single-admin claim is a read-then-write that must not race.

const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* node < 22.5: datamap degrades to files-only */ }
const { execFileSync } = require('node:child_process');

const gitlive = require(path.join(__dirname, '..', 'gitlive.js'));
const gitliveClient = require(path.join(__dirname, '..', 'gitlive-client'));

const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');
const CONTROL_ROOT = process.env.GITLIVE_CONTROL_DIR || path.join(os.homedir(), '.gitlive', 'control');
const NODE_SECRET_HASH_SALT = 'gitlive-control-node:v1';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  }));
  res.end(payload);
}
// every response gets the leak-basic hygiene; the dashboard additionally
// gets a CSP that pins scripts/styles/fonts to this origin.
function securityHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
  };
}
function dashboardCsp() {
  return "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
}

function ok(res, data) { json(res, 200, { ok: true, data }); }
function fail(res, status, code, message) { json(res, status, { ok: false, error: { code, message } }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim() || null;
}

function requireFields(body, fields) {
  for (const f of fields) {
    const v = body[f];
    if (v === undefined || v === null || String(v).trim() === '') {
      throw Object.assign(new Error(`${f} is required`), { code: 'INVALID_ARGS' });
    }
  }
}

// ── public-reach check (launch card) ─────────────────────────────────────
// Owner-driven ONLY — nothing automatic, ever (the heartbeat design line):
// the three public-surface checks below run when the dashboard asks for
// /api/public (page load) or the card's refresh button POSTs. Results are
// cached 60s so an offline machine is not hammered and a busy one is not
// rate-limited. Each check is ONE public registry/page lookup — nothing
// about this machine, its apps, or its owner is ever transmitted. All URLs
// are env-overridable so tests never touch the real registries.
const PUBLIC_NPM_URL = process.env.GITLIVE_PUBLIC_NPM_URL || 'https://registry.npmjs.org/gitlive/latest';
const PUBLIC_REPO_URL = process.env.GITLIVE_PUBLIC_REPO_URL || 'https://api.github.com/repos/LinesBline/gitlive';
const PUBLIC_COMMITS_URL = process.env.GITLIVE_PUBLIC_COMMITS_URL || 'https://api.github.com/repos/LinesBline/gitlive/commits/main';
const PUBLIC_FORMULA_URL = process.env.GITLIVE_PUBLIC_FORMULA_URL || 'https://raw.githubusercontent.com/LinesBline/gitlive/main/packaging/gitlive.rb';
const PUBLIC_CHECK_TTL_MS = 60 * 1000;
const PUBLIC_CHECK_TIMEOUT_MS = 6000;

const publicUa = () => `gitlive-control-plane/${gitlive.VERSION}`;
async function publicFetch(url, accept) {
  const r = await fetch(url, {
    headers: { ...(accept ? { accept } : {}), 'user-agent': publicUa() },
    signal: AbortSignal.timeout(PUBLIC_CHECK_TIMEOUT_MS),
  });
  return r;
}

async function publicReachRun() {
  const sha256re = /sha256\s+"([0-9a-f]{64})"/;
  const [npmR, repoR, commitsR, formulaR] = await Promise.allSettled([
    (async () => {
      const r = await publicFetch(PUBLIC_NPM_URL, 'application/json');
      if (r.status === 404) return { status: 'missing', detail: 'not on the npm registry' };
      if (!r.ok) return { status: 'unreachable', detail: 'npm answered HTTP ' + r.status };
      const j = await r.json();
      const published = String(j.version || '');
      return published === gitlive.VERSION
        ? { status: 'current', published, detail: 'registry has ' + published }
        : { status: 'behind', published, detail: `registry has ${published}, this node runs ${gitlive.VERSION}` };
    })(),
    (async () => {
      const r = await publicFetch(PUBLIC_REPO_URL, 'application/vnd.github+json');
      if (r.status === 404) return { status: 'missing', detail: 'no repo at that address' };
      if (!r.ok) return { status: 'unreachable', detail: 'github answered HTTP ' + r.status };
      const j = await r.json();
      const vis = String(j.visibility || '');
      if (vis !== 'public') return { status: 'private', visibility: vis, detail: 'repo visibility is "' + vis + '" — should be public' };
      return { status: 'public', visibility: vis, pushedAt: j.pushed_at || null, detail: 'public repo on main' };
    })(),
    (async () => {
      const r = await publicFetch(PUBLIC_COMMITS_URL, 'application/vnd.github+json');
      if (!r.ok) return { status: 'unreachable', detail: 'head commit lookup HTTP ' + r.status };
      const j = await r.json();
      const sha = String((j && j.sha) || '');
      const subject = String((j && j.commit && j.commit.message) || '').split('\n')[0];
      return { status: 'ok', head: sha.slice(0, 7), subject, detail: sha ? `main @ ${sha.slice(0, 7)}` : 'no commits' };
    })(),
    (async () => {
      const r = await publicFetch(PUBLIC_FORMULA_URL, 'text/plain');
      if (r.status === 404) return { status: 'missing', detail: 'no formula in the public repo' };
      if (!r.ok) return { status: 'unreachable', detail: 'formula fetch HTTP ' + r.status };
      const text = await r.text();
      const m = text.match(sha256re);
      const sha = m ? m[1] : null;
      const hasTarball = text.includes(`/gitlive-${gitlive.VERSION}.tgz`);
      if (!sha) return { status: 'stale', detail: 'formula sha256 is still the placeholder' };
      if (!hasTarball) return { status: 'stale', detail: 'formula tarball url is not for ' + gitlive.VERSION };
      return { status: 'current', sha256: sha, detail: 'formula sha256 ' + sha.slice(0, 12) + '…' };
    })(),
  ]);
  const pick = (r, fallback) => (r.status === 'fulfilled' ? r.value : Object.assign({}, fallback, { status: 'unreachable', detail: 'no answer from the network' }));
  const npm = pick(npmR, {});
  const github = pick(repoR, {});
  const commits = pick(commitsR, {});
  const formula = pick(formulaR, {});
  const allOk = npm.status === 'current' && github.status === 'public' && commits.status === 'ok' && formula.status === 'current';
  return {
    checkedAt: new Date().toISOString(),
    localVersion: gitlive.VERSION,
    allOk,
    npm,
    github: { status: github.status, visibility: github.visibility || null, pushedAt: github.pushedAt || null, head: commits.head || null, subject: commits.subject || null, detail: github.detail },
    formula,
  };
}

let publicCheckCache = null; // { at: number, data }
let publicCheckInflight = null;
function publicReachCheck(force) {
  if (!force && publicCheckCache && Date.now() - publicCheckCache.at < PUBLIC_CHECK_TTL_MS) {
    return Promise.resolve(publicCheckCache.data);
  }
  if (!publicCheckInflight) {
    publicCheckInflight = publicReachRun().then((data) => {
      publicCheckCache = { at: Date.now(), data };
      return data;
    }).finally(() => { publicCheckInflight = null; });
  }
  return publicCheckInflight;
}

// ── mesh enrichment (Phase 2 item 5) ──────────────────────────────────────
function meshMetaFor(appName) {
  try {
    const reg = gitlive.loadRegistry();
    const app = reg[appName];
    if (!app || !app.mesh) return { meshed: false };
    return {
      meshed: true,
      primary: app.mesh.primary || null,
      replicas: app.mesh.replicas || [],
      storage: app.mesh.storage || 'host-may-read',
    };
  } catch {
    return { meshed: false };
  }
}

// domain/graduation metadata for the app table + detail view (two-door
// plan): attached domains, the canonical own domain after `domain
// graduate`, and which borrowed zone label it left. Registry facts only.
function domainMeta(app) {
  return {
    domains: Array.isArray(app.domains) ? app.domains : [],
    primaryDomain: app.primaryDomain || null,
    graduatedFrom: app.graduatedFrom || null,
    graduatedAt: app.graduatedAt || null,
  };
}

function meshRegistrySummary() {
  try {
    const mesh = require('../mesh.js');
    const m = mesh.loadMesh();
    const members = Object.entries(m.members || {}).map(([name, r]) => ({
      name,
      remote: true,
      fingerprint: r.fingerprint || null,
      endpoints: r.endpoints || [],
      joinedAt: r.joinedAt || null,
      lastSeenAt: r.lastSeenAt || null,
    }));
    return { present: true, selfKey: mesh.selfKey(m), nodes: Object.keys(m.nodes), members };
  } catch {
    return { present: false };
  }
}

function nodeIdentity() {
  try {
    const mesh = require('../mesh.js');
    const w = mesh.whoami();
    return { name: w.name, id: w.id, handle: w.name + '@' + w.id };
  } catch {
    return { name: 'this-machine', id: 'self', handle: 'this-machine@self' };
  }
}

function hashNodeSecret(secret) {
  return crypto.createHash('sha256').update(NODE_SECRET_HASH_SALT + ':' + secret).digest('hex');
}

// ---------------------------------------------------------------------------
// Executor — the local node. Phase 1: the server itself is the only node and
// executes through gitlive.js's data functions (never shelling out to
// itself). Phase 2 swaps this for a per-agent command channel; the API
// shape above it does not change.
// ---------------------------------------------------------------------------
const localExecutor = {
  listApps: () => gitlive.listAppsData(),
  getApp: (name) => gitlive.getStatusData(name),
  getLogs: (name) => gitlive.getLogsData(name),
  stop: (name) => gitlive.stopAppData(name),
  deploy: (name) => gitlive.deployAppData(name),
  restart: (name) => gitlive.restartAppData(name),
  rollback: (name) => gitlive.rollbackAppData(name),
};

// ── ops views (dashboard redesign, round 2026-09-09) ─────────────────────
function peersOverview() {
  try {
    const peer = require('../peer.js');
    const store = peer.loadPeers();
    return { peers: Object.values(store.peers || {}).map((p) => ({
      name: p.name, nodeId: p.nodeId, endpoints: p.endpoints || [],
      ownerFingerprint: p.ownerFingerprint, receivedAt: p.receivedAt,
    })) };
  } catch {
    return { peers: [] };
  }
}

function keysStatus() {
  const manifest = require('../manifest.js');
  const peer = require('../peer.js');
  const crypt = require('../crypt.js');
  const fsx = require('node:fs');
  const probe = (p, loader, raw) => {
    try {
      if (!fsx.existsSync(p)) return { present: false };
      if (raw) {
        const b = fsx.readFileSync(p);
        return { present: true, fingerprint: crypto.createHash('sha256').update(b).digest('hex').slice(0, 16).toUpperCase() };
      }
      return { present: true, fingerprint: loader(p).fingerprint };
    } catch {
      return { present: false };
    }
  };
  const mk = process.env.GITLIVE_MANIFEST_KEY || manifest.DEFAULT_KEY_PATH;
  const nk = process.env.GITLIVE_NODE_KEY || peer.DEFAULT_NODE_KEY;
  const sk = process.env.GITLIVE_STORAGE_KEY || crypt.DEFAULT_STORAGE_KEY;
  const crypt2 = crypt;
  const duressArmed = fs.existsSync(sk) ? crypt2.keyIsWrapped(sk) : false;
  let deadman = null;
  try {
    const st = crypt2.deadmanState();
    if (st) {
      const deadline = new Date(st.deadline).getTime();
      deadman = { armed: true, deadline: st.deadline, intervalH: st.intervalH, hoursLeft: Math.max(0, Math.round((deadline - Date.now()) / 3600000 * 10) / 10) };
    }
  } catch { deadman = null; }
  let rotations = 0;
  try {
    const logPath = path.join(os.homedir(), '.gitlive', 'rotations.log');
    if (fs.existsSync(logPath)) rotations = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch { rotations = 0; }
  let shares = { armed: false };
  try { shares = require('../mesh.js').sharesSummary() || shares; } catch { /* mesh optional */ }
  return {
    ownerKey: probe(mk, (p) => manifest.loadPrivateKey(p), false),
    nodeKey: probe(nk, (p) => manifest.loadPrivateKey(p), false),
    storageKey: probe(sk, null, true),
    duressArmed,
    deadman,
    rotations,
    shares,
  };
}

function eventsTail() {
  try {
    const logPath = path.join(os.homedir(), '.gitlive', 'events.log');
    if (!fs.existsSync(logPath)) return { exists: false, entries: [] };
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    return { exists: true, entries: lines.slice(-50).map((l) => { try { return JSON.parse(l); } catch { return { at: null, kind: 'raw', detail: l }; } }) };
  } catch {
    return { exists: false, entries: [] };
  }
}

// supervisor state for the status rail: pid file alive = running, a stale
// pid file (process gone) = crashed, no file = never ensured (or stopped).
function daemonStatus() {
  try {
    const pidPath = path.join(os.homedir(), '.gitlive', 'daemon.pid');
    if (!fs.existsSync(pidPath)) return { running: false, pid: null, note: 'not ensured' };
    const pid = fs.readFileSync(pidPath, 'utf8').trim();
    if (!/^\d+$/.test(pid)) return { running: false, pid: null, note: 'stale pid file' };
    try { process.kill(Number(pid), 0); return { running: true, pid, note: 'supervising' }; }
    catch { return { running: false, pid, note: 'pid file stale — supervisor died' }; }
  } catch {
    return { running: false, pid: null, note: 'unreadable' };
  }
}

// entry node (two-door plan): REAL state only — is this machine relaying to
// an entry (client role), is it itself serving as the entry (server role),
// and what routes/machines are on record. Reads the same files entry.js
// writes; never guesses, never prompts.
function entryStatus() {
  const dir = path.join(os.homedir(), '.gitlive', 'entry');
  const out = {
    client: { configured: false, running: false },
    server: { configured: false, running: false },
  };
  const pidAlive = (p) => {
    try {
      const pid = fs.readFileSync(p, 'utf8').trim();
      if (!/^\d+$/.test(pid)) return false;
      process.kill(Number(pid), 0);
      return true;
    } catch { return false; }
  };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'client.json'), 'utf8'));
    out.client.configured = true;
    out.client.url = cfg.url || null;
    out.client.running = pidAlive(path.join(dir, 'client.pid'));
    try { out.client.domains = require('../entry.js').entryDomains(); } catch { out.client.domains = []; }
  } catch { /* no client config */ }
  try {
    const srv = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
    if (srv.tokenHash) {
      out.server.configured = true;
      out.server.running = pidAlive(path.join(dir, 'server.pid'));
      const log = (() => { try { return fs.readFileSync(path.join(dir, 'server.log'), 'utf8'); } catch { return ''; } })();
      const pm = log.match(/listening on 0\.0\.0\.0:(\d+)/);
      const tm = log.match(/https listening on 0\.0\.0\.0:(\d+)/);
      out.server.port = pm ? Number(pm[1]) : null;
      out.server.tlsPort = tm ? Number(tm[1]) : null;
      try {
        const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
        out.server.machines = Object.values(st.machines || {}).map((m) => ({
          name: m.name || null,
          domains: Array.isArray(m.domains) ? m.domains : [],
          connectedAt: m.connectedAt || null,
          lastSeen: m.lastSeen || null,
        }));
      } catch { out.server.machines = []; }
    }
  } catch { /* no server config */ }
  return out;
}

// ---------------------------------------------------------------------------
// Settings body (the dashboard as the app's real surface): naming & domains,
// daemon, registration — every action executes the SAME gitlive.js logic the
// CLI proves; the API never re-implements it.
// ---------------------------------------------------------------------------
function gatewayPortFromLog() {
  try {
    const log = fs.readFileSync(path.join(os.homedir(), '.gitlive', 'domain', 'gateway.log'), 'utf8');
    const m = log.match(/listening on 127\.0\.0\.1:(\d+)(?![\s\S]*listening)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
function gatewayTlsPortFromLog() {
  try {
    const log = fs.readFileSync(path.join(os.homedir(), '.gitlive', 'domain', 'gateway.log'), 'utf8');
    const m = log.match(/https listening on 127\.0\.0\.1:(\d+)(?![\s\S]*https listening)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function domainsOverview() {
  const reg = gitlive.loadRegistry();
  const tls = gitlive.domainTlsPaths();
  const zones = gitlive.loadZones();
  const localOn = gitlive.gatewayAlive();
  return {
    local: {
      on: localOn,
      port: localOn ? gatewayPortFromLog() : null,
      tlsPort: localOn ? gatewayTlsPortFromLog() : null,
      names: gitlive.domainNames(reg),
      caPresent: fs.existsSync(tls.caCrt) && fs.existsSync(tls.caKey),
      certPresent: fs.existsSync(tls.srvCrt) && fs.existsSync(tls.srvKey),
      trustCommand: (fs.existsSync(tls.caCrt) && os.platform() === 'darwin') ? gitlive.trustCommand() : null,
    },
    zones: Object.entries(zones).map(([domain, z]) => ({ domain, addedAt: z.addedAt || null, hasToken: Boolean(z.dnsToken) })),
    apps: Object.entries(reg).map(([name, app]) => ({
      name,
      domains: Array.isArray(app.domains) ? app.domains : [],
      primaryDomain: app.primaryDomain || null,
      graduatedFrom: app.graduatedFrom || null,
      graduatedAt: app.graduatedAt || null,
      // the onboarding checklist needs real backup facts — a receipt file
      // exists per app, nothing is guessed
      backedUp: Boolean(app.runPath && fs.existsSync(path.join(app.runPath, 'backup-history.jsonl'))),
    })),
  };
}

function domainLocalAction(body) {
  const action = body && body.action;
  if (action === 'on') {
    const names = gitlive.domainNames(gitlive.loadRegistry());
    // hosts write may need admin — the same surgical applyHosts the CLI uses;
    // on failure the owner gets the exact paste block, never a gitlive sudo.
    let adminHint = null;
    try {
      gitlive.applyHosts(names);
    } catch (err) {
      adminHint = {
        reason: (err && err.code) || 'hosts file not writable',
        block: gitlive.hostsBlock(names),
      };
    }
    const g = gitlive.startDomainGateway(body && body.port !== undefined ? { port: Number(body.port) } : {});
    if (g.failed) throw new Error(g.reason || 'gateway failed to start');
    return {
      on: true, names,
      port: g.actualPort || null, tlsPort: g.tlsPort || null,
      adminHint,
      note: adminHint
        ? 'The gateway is up, but /etc/hosts needs the admin block below before names resolve.'
        : 'Names resolve and route on this machine.',
    };
  }
  if (action === 'off') {
    gitlive.stopDomainGateway();
    try { gitlive.applyHosts([]); } catch { /* hosts block stays — admin's to remove */ }
    return { on: false, names: [] };
  }
  if (action === 'tls') {
    // re-issue the local certificate to match the current app list (the
    // gateway picks it up on restart of its https listener — safe to say so)
    const names = gitlive.domainNames(gitlive.loadRegistry());
    const ca = gitlive.ensureLocalCA();
    const cert = gitlive.issueServerCert(names);
    return {
      caCreated: ca.created,
      certChanged: cert.changed,
      names,
      note: cert.changed
        ? 'Certificate re-issued for the current apps. The gateway reads it on its next start (gitlive domain local on / restart the gateway).'
        : 'Certificate already current — nothing to change.',
    };
  }
  throw Object.assign(new Error('action must be on, off, or tls'), { code: 'INVALID_ARGS' });
}

function domainZoneAction(body) {
  const action = body && body.action;
  const domain = String((body && body.domain) || '').trim().toLowerCase();
  if (!gitlive.validPublicDomain(domain)) throw Object.assign(new Error('that is not a valid domain'), { code: 'INVALID_ARGS' });
  const zones = gitlive.loadZones();
  if (action === 'add') {
    const prev = zones[domain];
    zones[domain] = {
      addedAt: prev && prev.addedAt ? prev.addedAt : new Date().toISOString(),
      ...(body && body.dnsToken ? { dnsToken: String(body.dnsToken) } : {}),
    };
    gitlive.saveZones(zones);
    const ext = domain.split('.').pop();
    return {
      domain,
      extension: ext,
      dnsTokenStored: Boolean(zones[domain].dnsToken),
      records: [
        { type: 'A', name: domain, value: String((body && body.ip) || '<your public IP>') },
        { type: 'A', name: '*.' + domain, value: String((body && body.ip) || '<your public IP>') },
      ],
      note: `One wildcard record names every app: <app>.${domain}. Borrowed labels, never owned — ` +
        'apps graduate to their own domain in one command.',
    };
  }
  if (action === 'remove') {
    if (!zones[domain]) throw Object.assign(new Error(`zone ${domain} is not registered`), { code: 'NOT_FOUND' });
    delete zones[domain];
    gitlive.saveZones(zones);
    return { domain, removed: true, note: 'Existing app domains keep routing; the wildcard record is yours to delete at the registrar.' };
  }
  throw Object.assign(new Error('action must be add or remove'), { code: 'INVALID_ARGS' });
}

async function daemonEnsure() {
  const daemon = require('../daemon.js');
  const existing = (() => { try { return fs.readFileSync(daemon.DAEMON_PID, 'utf8').trim(); } catch { return null; } })();
  if (existing && daemon.isAlivePid(existing)) return { running: true, pid: existing, note: 'already supervising' };
  const pid = daemon.spawnSupervisor();
  if (!/^\d+$/.test(String(pid))) throw new Error('daemon start failed (no session leader returned) — see the daemon log');
  let up = false;
  for (let i = 0; i < 15 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    up = daemon.isAlivePid(pid);
  }
  if (!up) throw new Error('daemon start failed (process exited early) — see the daemon log');
  fs.writeFileSync(daemon.DAEMON_PID, String(pid));
  return { running: true, pid: String(pid), note: 'supervising' };
}

function daemonStop() {
  const daemon = require('../daemon.js');
  const pid = (() => { try { return fs.readFileSync(daemon.DAEMON_PID, 'utf8').trim(); } catch { return null; } })();
  if (pid) {
    try { process.kill(-Number(pid), 'SIGTERM'); } catch { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }
    try { fs.rmSync(daemon.DAEMON_PID, { force: true }); } catch { /* noop */ }
  }
  return { running: false, note: 'Apps keep running — only the supervisor is gone.' };
}

// newest deploy-history entry per app, for the table's "last deploy" column
function lastDeployFor(app) {
  try {
    if (!app || !app.runPath) return null;
    const e = gitlive.readHistory(app.runPath, 1)[0];
    return e ? { outcome: e.outcome || null, commit: e.commit || null, at: e.at || null } : null;
  } catch {
    return null;
  }
}

async function issueInvite(body) {
  const mesh = require('../mesh.js');
  const name = (body && body.name) || 'friend-node';
  const ttl = Number((body && body.ttlHours)) || 24;
  return { token: mesh.createInviteToken({ name, ttlHours: ttl }) };
}



// ── health history (post-roadmap #8): the visible meter, local only ──────
// The control plane samples each app's health port every minute and appends
// one line per app to its runPath/health-history.jsonl. Nothing leaves the
// machine; the file is the history. Pruned to 7 days / 5000 lines on write.
// Deploy and backup facts ride the SAME files they always have — the meter
// never invents a number.
const HEALTH_INTERVAL_MS = Number(process.env.GITLIVE_HEALTH_INTERVAL_MS) || 60000;
function healthFileFor(app) {
  return path.join(app.runPath, 'health-history.jsonl');
}
function sampleOneHealth(app, name) {
  return new Promise((resolve) => {
    const port = app.safe ? app.publicPort : app.port;
    if (!port || app.mode === 'connect') return resolve(null);
    const healthPath = app.healthPath || '/';
    const req = http.get({ host: '127.0.0.1', port: Number(port), path: healthPath, timeout: 2000 }, (res) => {
      res.resume();
      resolve({ app: name, up: res.statusCode < 500, status: res.statusCode });
    });
    req.on('error', () => resolve({ app: name, up: false, status: null }));
    req.on('timeout', () => { req.destroy(); resolve({ app: name, up: false, status: null }); });
  });
}
function appendHealthSample(app, entry) {
  try {
    const f = healthFileFor(app);
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const kept = lines.slice(-5000).filter((l) => {
      try { const j = JSON.parse(l); return !j.at || new Date(j.at).getTime() >= cutoff; } catch { return false; }
    });
    if (kept.length !== lines.length) fs.writeFileSync(f, kept.join('\n') + '\n');
  } catch { /* history must never break the plane */ }
}
async function sampleHealth() {
  try {
    const reg = gitlive.loadRegistry();
    for (const [name, app] of Object.entries(reg)) {
      if (app.mode === 'connect' || !app.runPath) continue;
      const entry = await sampleOneHealth(app, name);
      if (entry) appendHealthSample(app, entry);
    }
  } catch { /* registry unavailable — skip a beat */ }
}
function startHealthSampler() {
  const timer = setInterval(sampleHealth, Math.max(1000, HEALTH_INTERVAL_MS));
  timer.unref(); // the sampler must never hold the process open
  sampleHealth();
  return timer;
}
function healthHistoryData(appName) {
  const gitliveMod = gitlive;
  const reg = gitliveMod.loadRegistry();
  const app = reg[appName];
  if (!app || !app.runPath) throw new Error('No app named "' + appName + '"');
  let samples = [];
  try {
    const lines = fs.readFileSync(healthFileFor(app), 'utf8').trim().split('\n').filter(Boolean);
    samples = lines.slice(-500).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no samples yet */ }
  let lastVerifiedBackup = null;
  let lastBackup = null;
  try {
    const lines = fs.readFileSync(path.join(app.runPath, 'backup-history.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (rows.length) lastBackup = rows[rows.length - 1];
    for (const r of rows.slice().reverse()) { if (r.verify === true) { lastVerifiedBackup = r; break; } }
  } catch { /* no backups yet */ }
  let deployCount = 0;
  try {
    deployCount = fs.readFileSync(path.join(app.runPath, 'deploy-history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
  } catch { /* no deploys yet */ }
  const windowMs = 24 * 3600 * 1000;
  const cutoff = Date.now() - windowMs;
  const day = samples.filter((s) => s.at && new Date(s.at).getTime() >= cutoff);
  const ups = day.filter((s) => s.up).length;
  return {
    app: appName,
    sampled: samples.length > 0,
    intervalMs: HEALTH_INTERVAL_MS,
    window: { hours: 24, samples: day.length, up: ups, down: day.length - ups, uptimePct: day.length ? Math.round((ups / day.length) * 1000) / 10 : null },
    samples: day.slice(-96), // last 96 samples for the timeline strip
    deploys: deployCount,
    lastBackup: lastBackup ? { at: lastBackup.at, snapshot: lastBackup.snapshot, verify: Boolean(lastBackup.verify), outcome: lastBackup.outcome || null } : null,
    lastVerifiedBackup: lastVerifiedBackup ? { at: lastVerifiedBackup.at, snapshot: lastVerifiedBackup.snapshot, outcome: lastVerifiedBackup.outcome } : null,
  };
}

// ── GitHub webhook deploys (post-roadmap #9) ────────────────────────────
// GitHub pokes the machine; the machine deploys through the SAME
// post-receive hook a local git push would run. The only new trust is the
// X-Hub-Signature-256 HMAC (shared secret, mode 600) — every gate,
// receipt and attestation downstream is unchanged.
const GITHUB_HOOK_SECRET_PATH = path.join(os.homedir(), '.gitlive', 'github-hook-secret');
function githubHookSecret() {
  try { return fs.readFileSync(GITHUB_HOOK_SECRET_PATH, 'utf8').trim(); } catch { return null; }
}
function verifyGithubSignature(rawBody, sigHeader) {
  const secret = githubHookSecret();
  if (!secret || !sigHeader || !String(sigHeader).startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = String(sigHeader).slice(7);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(got, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function githubHookDeploy(appName, commit) {
  const reg = gitlive.loadRegistry();
  const app = reg[appName];
  if (!app || !app.barePath) { const e = new Error(`No app named "${appName}"`); e.code = 'NOT_FOUND'; throw e; }
  if (!app.githubRepo) { const e = new Error(`no GitHub webhook configured for "${appName}" — gitlive github hook ${appName} --repo <url>`); e.code = 'NOT_FOUND'; throw e; }
  const old = (() => { try { return execFileSync('git', ['--git-dir', app.barePath, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(); } catch { return '0'.repeat(40); } })();
  execFileSync('git', ['--git-dir', app.barePath, 'fetch', app.githubRepo, commit], { encoding: 'utf8', timeout: 120000 });
  execFileSync('git', ['--git-dir', app.barePath, 'update-ref', 'refs/heads/main', commit], { encoding: 'utf8' });
  const hookPath = path.join(app.barePath, 'hooks', 'post-receive');
  if (!fs.existsSync(hookPath)) { const e = new Error(`no deploy hook in ${app.barePath} — run gitlive init first`); e.code = 'NOT_FOUND'; throw e; }
  // run the hook detached — the deploy (build + health + swap) takes
  // seconds; the webhook answers 202 and the deploy log tells the story.
  const { spawn } = require('node:child_process');
  const child = spawn('bash', [hookPath], {
    cwd: app.barePath,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: process.env,
  });
  child.stdin.end(`${old} ${commit} refs/heads/main\n`);
  child.unref();
  return { ok: true, deploying: true, app: appName, commit: String(commit).slice(0, 12), via: 'github webhook' };
}

// cheap health summary for the projects surface: the tail of the app's
// sampled history — up% over the last 24h + the last few probes for the
// card sparkline. Same files, same facts; nothing computed twice.
function healthSummaryFor(app) {
  try {
    const lines = fs.readFileSync(healthFileFor(app), 'utf8').trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const day = lines.slice(-500).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((s) => s && s.at && new Date(s.at).getTime() >= cutoff);
    const ups = day.filter((s) => s.up).length;
    return {
      sampled: day.length > 0,
      up24: day.length ? Math.round((ups / day.length) * 1000) / 10 : null,
      samples: day.slice(-24),
    };
  } catch { return { sampled: false, up24: null, samples: [] }; }
}

// ── data map (plain-language data awareness per app) ────────────────────
// Surfaces REAL state only: where data physically lives, sqlite tables +
// row counts, file areas, encryption posture, key-share policy, last
// attested deploy. Never guesses; every number is read from disk.
const DM_SKIP_DIRS = new Set(['live', 'node_modules', 'A', 'B', '.git', '.gitlive']);
function dmWalk(root, rel, maxDepth, onFile) {
  const abs = path.join(root, rel);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || DM_SKIP_DIRS.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    const a = path.join(abs, e.name);
    if (e.isDirectory()) { if (maxDepth > 0) dmWalk(root, r, maxDepth - 1, onFile); }
    else onFile(r, a);
  }
}
function datamapTables(dbPath) {
  if (!DatabaseSync) return null;
  const out = [];
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const r of rows.slice(0, 60)) {
      let count = null;
      try { count = db.prepare('SELECT COUNT(*) AS c FROM "' + String(r.name).replace(/"/g, '""') + '"').get().c; } catch { /* skip */ }
      out.push({ name: String(r.name), rows: count });
    }
  } catch { return null; } finally { if (db) try { db.close(); } catch { /* noop */ } }
  return out;
}
function datamapFor(appName) {
  const reg = gitlive.loadRegistry();
  const app = reg[appName];
  if (!app || !app.runPath) throw new Error('No app named "' + appName + '"');
  const rp = app.runPath;
  const databases = [];
  const seen = new Set();
  dmWalk(rp, '', 2, (rel, abs) => {
    if (!/\.(db|sqlite|sqlite3)$/i.test(rel)) return;
    const key = rel.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(abs).size; } catch { /* noop */ }
    databases.push({ file: rel, path: abs, sizeBytes, tables: datamapTables(abs) });
  });
  // the file-storage area (the shared data dir apps opt into)
  let files = { present: false };
  const dataDir = path.join(rp, 'data');
  if (fs.existsSync(dataDir)) {
    let fileCount = 0;
    let sizeBytes = 0;
    const entries = [];
    dmWalk(dataDir, '', 6, (rel, abs) => {
      fileCount++;
      let sz = 0;
      try { sz = fs.statSync(abs).size; } catch { /* noop */ }
      sizeBytes += sz;
      if (entries.length < 30) entries.push({ rel, sizeBytes: sz });
    });
    files = { present: true, path: dataDir, fileCount, sizeBytes, entries };
  }
  let shares = { armed: false };
  try { shares = require('../mesh.js').sharesSummary() || shares; } catch { /* mesh optional */ }
  let wrapped = false;
  try { wrapped = require('../crypt.js').keyIsWrapped(require('../crypt.js').DEFAULT_STORAGE_KEY); } catch { /* noop */ }
  const history = (() => { try { return gitlive.readHistory(rp, 1)[0] || null; } catch { return null; } })();
  let meshMeta = null;
  try { meshMeta = meshMetaFor(appName); } catch { /* noop */ }
  return {
    app: appName,
    location: { machine: os.hostname(), runPath: rp, dataDir: files.present ? files.path : null },
    databases,
    files,
    protection: {
      storageKeyPresent: fs.existsSync(require('../crypt.js').DEFAULT_STORAGE_KEY),
      storageKeyWrapped: wrapped,
      ownerKeyPolicy: Boolean(meshMeta && meshMeta.storage === 'owner-key'),
      shares,
    },
    lastDeploy: history ? { outcome: history.outcome, commit: history.commit, at: history.at, closure: history.closure || null } : null,
    receipts: (() => {
      try {
        if (!app.barePath || !fs.existsSync(app.barePath)) return [];
        return gitlive.parseDeployTags(app.barePath).slice(0, 10);
      } catch { return []; }
    })(),
  };
}

// ── sandbox practice node (engagement program) ──────────────────────────
// A REAL, disposable app named "practice-node" flagged sandbox:true in the
// registry — same hooks, same proxy, same theater — created under a
// throwaway project dir and destroyed on demand or at server boot (sweep).
// Nothing real can break: the registry entry is removed with it.
const SANDBOX_NAME = 'practice-node';
function sandboxRoot() { return path.join(os.homedir(), '.gitlive', 'sandbox'); }
function sandboxProject() { return path.join(sandboxRoot(), 'project'); }
function isSandboxCwd(cwd) { return cwd && String(cwd).startsWith(sandboxRoot()); }

const SANDBOX_GOOD = `const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let v = 'v1';
try { v = fs.readFileSync(path.join(process.cwd(), 'version.txt'), 'utf8').trim(); } catch {}
http.createServer((q, s) => {
  s.setHeader('content-type', 'text/plain');
  if (q.url === '/health') { s.end('ok'); return; }
  s.end('practice node ' + v + ' is live — served by gitlive on hardware you own');
}).listen(Number(process.env.PORT) || 0);
`;
const SANDBOX_BROKEN = `// practice break: exits before it can ever answer a health check
console.error('practice break: process exits before answering');
process.exit(1);
`;

function freePortAsync() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function sh(cmd, args, opts = {}) {
  // stdio 'ignore' on purpose: piped stdio makes execFileSync wait for EOF
  // on the pipes, and a deploy hook's detached app/proxy can hold them open
  // forever — the server's event loop freezes and the dashboard hangs
  // (field finding: the sandbox flow wedged the control plane exactly this
  // way). Server-side calls never need the captured output.
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'ignore', ...opts });
}
function sandboxProjectGit(args) { return sh('git', args, { cwd: sandboxProject(), env: process.env }); }
function sandboxCommit(msg) {
  sandboxProjectGit(['add', '-A']);
  sandboxProjectGit(['-c', 'user.email=sandbox@gitlive.local', '-c', 'user.name=gitlive practice', 'commit', '-qm', msg]);
}
function sandboxPush() {
  sh('git', ['push', SANDBOX_NAME, 'main'], { cwd: sandboxProject(), env: process.env });
}
function waitFor(fn, what, tries = 40, gapMs = 400) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      try {
        const v = fn();
        if (v) return resolve(v);
      } catch { /* keep polling */ }
      if (Date.now() - t0 > tries * gapMs) return reject(new Error('timeout waiting for ' + what));
      setTimeout(tick, gapMs);
    };
    tick();
  });
}

function sandboxDestroy() {
  const reg = gitlive.loadRegistry();
  const app = reg[SANDBOX_NAME];
  if (app) {
    try { gitlive.stopAppData(SANDBOX_NAME); } catch { /* already dead */ }
    // remove the app's OWN dirs too — a stale bare repo or run dir would make
    // the next practice init's push non-fast-forward (rejected) and litter
    // ~/.gitlive/apps with a zombie the sweep cannot see (flag already gone)
    for (const d of [app.barePath, app.runPath]) {
      if (d && String(d).startsWith(path.join(os.homedir(), '.gitlive', 'apps'))) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    delete reg[SANDBOX_NAME];
    gitlive.saveRegistry(reg);
  }
  try { fs.rmSync(sandboxRoot(), { recursive: true, force: true }); } catch { /* gone */ }
  return { ok: true, destroyed: true };
}

async function sandboxInit() {
  sandboxDestroy();
  fs.mkdirSync(sandboxRoot(), { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot(), 'version.txt'), 'v1');
  fs.writeFileSync(sandboxProject() + '.version', 'v1'); // marker unused
  fs.mkdirSync(sandboxProject(), { recursive: true });
  fs.writeFileSync(path.join(sandboxProject(), 'package.json'), JSON.stringify({ name: 'practice-node', version: '1.0.0', scripts: { start: 'node server.js' } }, null, 2));
  fs.writeFileSync(path.join(sandboxProject(), 'server.js'), SANDBOX_GOOD);
  fs.writeFileSync(path.join(sandboxProject(), 'version.txt'), 'v1');
  sh('git', ['init', '-q', '-b', 'main'], { cwd: sandboxProject() });
  sandboxCommit('practice v1');
  const port = await freePortAsync();
  const gitliveFile = path.join(__dirname, '..', 'gitlive.js');
  sh('node', [gitliveFile, 'init', SANDBOX_NAME, '--safe', '--port', String(port), '--install', 'true', '--start', 'node server.js', '--yes'], { cwd: sandboxProject(), env: process.env });
  const reg = gitlive.loadRegistry();
  if (!reg[SANDBOX_NAME]) throw new Error('practice init did not register the app');
  reg[SANDBOX_NAME].sandbox = true;
  gitlive.saveRegistry(reg);
  sandboxPush();
  await waitFor(() => { const st = gitlive.getStatusData(SANDBOX_NAME); return st.proxyUp ? st : null; }, 'practice node healthy', 40);
  return { ok: true, name: SANDBOX_NAME, publicPort: port };
}

async function sandboxStep(broken) {
  const reg = gitlive.loadRegistry();
  if (!reg[SANDBOX_NAME]) throw new Error('no practice node — start one first');
  const version = broken ? 'v1-broken' : 'v2';
  fs.writeFileSync(path.join(sandboxProject(), 'server.js'), broken ? SANDBOX_BROKEN : SANDBOX_GOOD);
  fs.writeFileSync(path.join(sandboxProject(), 'version.txt'), broken ? 'v1' : 'v2');
  sandboxCommit('practice ' + (broken ? 'break' : 'fix'));
  const sha = sh('git', ['rev-parse', 'HEAD'], { cwd: sandboxProject(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  sandboxPush();
  // wait for the RECEIPT OF THIS COMMIT to land (a previous record always
  // exists — matching by commit is what makes the read honest; the broken
  // deploy's health-check timeout settles at ~10s)
  const last = await waitFor(() => {
    const h = gitlive.readHistory(reg[SANDBOX_NAME].runPath, 10).find((r) => r.commit === sha.slice(0, 12));
    return h || null;
  }, 'deploy record for ' + sha.slice(0, 8), 45, 400);
  return { ok: true, outcome: String(last.outcome), commit: String(last.commit || '').slice(0, 8), stillServing: gitlive.getStatusData(SANDBOX_NAME).proxyUp === true };
}

function sandboxSweep() {
  const reg = gitlive.loadRegistry();
  let cleaned = 0;
  for (const [name, app] of Object.entries(reg)) {
    if (app.sandbox === true && isSandboxCwd(app.cwd)) {
      try { gitlive.stopAppData(name); } catch { /* dead */ }
      for (const d of [app.barePath, app.runPath]) {
        if (d && String(d).startsWith(path.join(os.homedir(), '.gitlive', 'apps'))) {
          try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      }
      delete reg[name];
      cleaned++;
    }
  }
  if (cleaned) gitlive.saveRegistry(reg);
  try { if (!Object.keys(reg).some((n) => reg[n].sandbox)) fs.rmSync(sandboxRoot(), { recursive: true, force: true }); } catch { /* noop */ }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Server factory (async: control-schema migration must complete before the
// first request can be served)
// ---------------------------------------------------------------------------
const loginAttempts = new Map(); // email -> { fails, until } (in-memory, per-process)

async function createControlServer({ port = 5180, host = '127.0.0.1', allowRegister = false } = {}) {
  fs.mkdirSync(CONTROL_ROOT, { recursive: true });

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    // eslint-disable-next-line no-console
    console.warn('[gitlive-control] WARNING: node registration is unauthenticated (public-key bootstrap). ' +
      'Binding to a non-loopback host exposes /api/nodes/register to your network — do not expose this port publicly until node auth lands (Phase 2).');
  }

  const client = gitliveClient({ app: 'gitlive-control', dataDir: CONTROL_ROOT });

  // One statement per exec — the client's db.exec wrapper prepares a single
  // statement (no multi-statement strings).
  await client.db.exec(`CREATE TABLE IF NOT EXISTS control_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await client.db.exec(`CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    last_seen_at TEXT,
    created_at TEXT NOT NULL)`);
  await client.db.exec(`INSERT OR IGNORE INTO control_meta (key, value) VALUES ('admin_email', '')`);

  try { sandboxSweep(); } catch { /* sweep is best-effort at boot */ }

  startHealthSampler();

  // boot restore (the caretaker): when the LaunchAgent starts the plane with
  // GITLIVE_BOOT_RESTORE=1, run the master switch once — every app comes
  // back through its own pipeline, receipted like any deploy. Best-effort:
  // a missing hook is a skip, never a crash.
  if (process.env.GITLIVE_BOOT_RESTORE === '1') {
    try {
      const restored = gitlive.upData();
      console.log(`[boot] machine restore: ${restored.apps.length} app(s) checked, ${restored.failed} still down`);
    } catch (err) {
      console.log('[boot] machine restore skipped: ' + (err && err.message ? err.message : err));
    }
  }

  async function adminEmail() {
    const rows = await client.db.query(`SELECT value FROM control_meta WHERE key = 'admin_email'`);
    return (rows[0] && rows[0].value) || null;
  }

  // Runtime registration toggle (settings body): persists in control_meta and
  // is consulted at registration time — `--allow-register` at startup stays
  // the override. Unset = the original behavior (open until the first admin
  // claims the instance, then closed).
  async function registrationOpenSetting() {
    const rows = await client.db.query(`SELECT value FROM control_meta WHERE key = 'registration_open'`);
    return rows[0] ? rows[0].value === '1' : null;
  }
  async function setRegistrationOpen(open) {
    await client.db.exec(
      `INSERT INTO control_meta (key, value) VALUES ('registration_open', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [open ? '1' : '0'],
    );
  }

  // Atomic single-admin claim: only succeeds while the slot is still empty,
  // so two concurrent first registrations cannot both claim it.
  async function claimAdmin(email) {
    const info = await client.db.exec(
      `UPDATE control_meta SET value = ? WHERE key = 'admin_email' AND value = ''`,
      [email],
    );
    return info.changes > 0 ? email : adminEmail();
  }

  // Serializes registrations so claimAdmin's read-claim-verify never races.
  let registerChain = Promise.resolve();
  function serializeRegister(fn) {
    const run = registerChain.then(fn, fn);
    registerChain = run.catch(() => {});
    return run;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    try {
      // ── self-hosted fonts (pre-launch leak fix): served same-origin,
      // no third-party CDN ever sees a dashboard visitor ─────────────────
      const fontMatch = p.match(/^\/fonts\/([a-z0-9-]+\.woff2)$/);
      if (fontMatch && req.method === 'GET') {
        const fp = path.join(__dirname, 'fonts', fontMatch[1]);
        if (!fs.existsSync(fp)) return fail(res, 404, 'NOT_FOUND', 'no such font');
        const buf = fs.readFileSync(fp);
        res.writeHead(200, securityHeaders({ 'content-type': 'font/woff2', 'content-length': buf.length, 'cache-control': 'public, max-age=2592000' }));
        return res.end(buf);
      }

      // ── static dashboard ────────────────────────────────────────────────
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(DASHBOARD_PATH, 'utf8');
        res.writeHead(200, securityHeaders({
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          'content-security-policy': dashboardCsp(),
          'x-frame-options': 'DENY',
          // the dashboard is a live app shell — a stale cached copy meant the
          // operator never saw shipped fixes (field incident 2026-09-12)
          'cache-control': 'no-store',
        }));
        res.end(html);
        return;
      }

      // ── public metadata: lets the dashboard render the right auth view ──
      if (p === '/api/meta' && req.method === 'GET') {
        const adminSet = Boolean(await adminEmail());
        const regOpenSetting = await registrationOpenSetting();
        const effectiveOpen = allowRegister || regOpenSetting === true || !adminSet;
        return ok(res, { registrationOpen: effectiveOpen, adminSet, version: gitlive.VERSION, node: nodeIdentity() });
      }

      // ── auth ────────────────────────────────────────────────────────────
      if (p === '/api/auth/register' && req.method === 'POST') {
        const body = await readBody(req);
        requireFields(body, ['email', 'password']);
        const user = await serializeRegister(async () => {
          const adminSet = Boolean(await adminEmail());
          const regOpenSetting = await registrationOpenSetting();
          if (!allowRegister && regOpenSetting !== true && adminSet) {
            throw Object.assign(new Error('Registration is closed — this instance is single-admin. Start with --allow-register to open it.'), { code: 'REGISTRATION_CLOSED' });
          }
          const created = await client.auth.createUser({ email: body.email, password: body.password });
          await claimAdmin(created.email);
          return created;
        });
        return ok(res, { email: user.email, id: user.id });
      }

      if (p === '/api/auth/login' && req.method === 'POST') {
        const body = await readBody(req);
        requireFields(body, ['email', 'password']);
        const emailKey = String(body.email).toLowerCase();
        const now = Date.now();
        const rec = loginAttempts.get(emailKey);
        if (rec && rec.until > now && rec.fails >= 10) {
          try { require('../crypt.js').logEvent('login-rate-limited', { email: emailKey }); } catch { /* noop */ }
          return fail(res, 429, 'RATE_LIMITED', 'too many attempts — wait ' + Math.ceil((rec.until - now) / 60000) + ' min, or the account stays single-admin anyway');
        }
        const user = await client.auth.verifyPassword({ email: body.email, password: body.password });
        if (!user) {
          // audit: failed logins answer the "who tried and when" question;
          // best-effort — logging never changes the auth verdict.
          try { require('../crypt.js').logEvent('login-fail', { email: String(body.email).toLowerCase(), via: req.socket && req.socket.remoteAddress }); } catch { /* noop */ }
          const e = loginAttempts.get(emailKey) || { fails: 0, until: 0 };
          e.fails += 1;
          if (e.fails >= 10) e.until = now + 10 * 60 * 1000;
          loginAttempts.set(emailKey, e);
          return fail(res, 401, 'AUTH_ERROR', 'Invalid email or password.');
        }
        loginAttempts.delete(emailKey);
        try { require('../crypt.js').logEvent('login', { email: user.email, via: req.socket && req.socket.remoteAddress }); } catch { /* noop */ }
        const session = await client.auth.createSession(user.id);
        return ok(res, { token: session.token, expiresAt: session.expiresAt, email: user.email });
      }

      if (p === '/api/auth/logout' && req.method === 'POST') {
        const token = bearerToken(req);
        if (token) await client.auth.revokeSession(token);
        return ok(res, { loggedOut: true });
      }

      // ── node plane (agent auth, NOT user sessions) ──────────────────────
      // An agent's first contact is /api/nodes/register with its freshly
      // minted public key — no session can exist yet, so registration is
      // unauthenticated by design. The node secret issued once at
      // registration is the real credential for everything after (heartbeat
      // is verified against it). Safe on loopback; exposing the control port
      // publicly lets anyone register a node — hence the warning below.
      if (p === '/api/nodes/register' && req.method === 'POST') {
        const body = await readBody(req);
        requireFields(body, ['publicKey', 'hostname', 'name']);
        const nodeId = 'node-' + crypto.randomUUID();
        const secret = crypto.randomBytes(24).toString('base64url');
        await client.db.exec(
          `INSERT INTO nodes (id, public_key, name, hostname, secret_hash, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [nodeId, body.publicKey, body.name, body.hostname, hashNodeSecret(secret), new Date().toISOString(), new Date().toISOString()],
        );
        return ok(res, { nodeId, secret, name: body.name }); // secret returned exactly once
      }

      if (p === '/api/nodes/heartbeat' && req.method === 'POST') {
        const body = await readBody(req);
        requireFields(body, ['nodeId', 'secret']);
        const rows = await client.db.query(`SELECT secret_hash FROM nodes WHERE id = ?`, [body.nodeId]);
        if (!rows.length || rows[0].secret_hash !== hashNodeSecret(String(body.secret))) {
          return fail(res, 403, 'AUTH_ERROR', 'Unknown node or bad secret.');
        }
        await client.db.exec(`UPDATE nodes SET last_seen_at = ? WHERE id = ?`, [new Date().toISOString(), body.nodeId]);
        return ok(res, { lastSeenAt: new Date().toISOString() });
      }

      // ── GitHub webhook (HMAC plane — GitHub has no user session) ────────
      if (p === '/api/github/hook' && req.method === 'POST') {
        const appName = url.searchParams.get('app');
        if (!appName) return fail(res, 400, 'INVALID_ARGS', 'app is required: /api/github/hook?app=<name>');
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 1_000_000) return fail(res, 413, 'INVALID_ARGS', 'webhook body too large');
          chunks.push(c);
        }
        const raw = Buffer.concat(chunks);
        if (!verifyGithubSignature(raw, req.headers['x-hub-signature-256'])) {
          try { require('../crypt.js').logEvent('github-hook-denied', { app: appName }); } catch { /* noop */ }
          return fail(res, 403, 'AUTH_ERROR', 'bad webhook signature — the secret must match (gitlive github hook <app> --secret <s>)');
        }
        let payload = null;
        try { payload = JSON.parse(raw.toString('utf8')); } catch { return fail(res, 400, 'INVALID_ARGS', 'invalid JSON payload'); }
        const commit = payload && payload.head_commit && payload.head_commit.id;
        const ref = payload && payload.ref;
        if (!commit || ref !== 'refs/heads/main') return fail(res, 400, 'INVALID_ARGS', 'only pushes to main deploy (the webhook should fire on the push event)');
        try { return ok(res, await githubHookDeploy(appName, commit)); }
        catch (err) { return fail(res, err.code === 'NOT_FOUND' ? 404 : 500, err.code || 'INTERNAL', err.message || String(err)); }
      }

      // ── everything below requires a user session ────────────────────────
      const token = bearerToken(req);
      if (!token) return fail(res, 401, 'UNAUTHENTICATED', 'Missing Bearer token.');
      const sessionUser = await client.auth.verifySession(token);
      if (!sessionUser) return fail(res, 401, 'UNAUTHENTICATED', 'Invalid or expired session.');

      // /api/me
      if (p === '/api/me' && req.method === 'GET') {
        return ok(res, { email: sessionUser.email, id: sessionUser.id });
      }

      // /api/nodes (session view of registered nodes — heartbeat & register
      // live in the node plane above and authenticate with node secrets)
      if (p === '/api/nodes' && req.method === 'GET') {
        const rows = await client.db.query(`SELECT id, name, hostname, last_seen_at, created_at FROM nodes ORDER BY created_at`);
        // alive = the node heartbeated within two heartbeat windows (30s each)
        const aliveWindow = 65 * 1000;
        for (const r of rows) {
          r.alive = Boolean(r.last_seen_at && (Date.now() - new Date(r.last_seen_at).getTime()) < aliveWindow);
        }
        return ok(res, rows);
      }

      // ── apps (local executor) ───────────────────────────────────────────
      const appsMatch = p.match(/^\/api\/apps\/([^/]+)\/(logs|stop|deploy|rollback|restart|replicas|conflicts)$/);
      const nameMatch = p.match(/^\/api\/apps\/([^/]+)\/name$/);
      const publicMatch = p.match(/^\/api\/apps\/([^/]+)\/public$/);
      if (publicMatch && req.method === 'POST') {
        // launch journey, milestone 3: make it public — the owner's own
        // domain becomes the app's canonical name (the URL headline).
        const body = await readBody(req);
        try { return ok(res, gitlive.domainPublicData(decodeURIComponent(publicMatch[1]), { domain: body && body.domain, ip: body && body.ip, cert: body && body.cert, key: body && body.key })); }
        catch (err) { return fail(res, err.code === 'INVALID_ARGS' ? 400 : 404, err.code || 'INTERNAL', err.message || String(err)); }
      }
      if (nameMatch && req.method === 'POST') {
        // launch journey, milestone 2: claim the borrowed zone label
        // <app>.<zone> (zones are wildcard-routed — the label is recorded on
        // the app so the card and graduate can show it).
        const body = await readBody(req);
        const zone = String((body && body.zone) || '').trim().toLowerCase().replace(/^\./, '');
        if (!zone) return fail(res, 400, 'INVALID_ARGS', 'zone is required (e.g. ".app")');
        const zones = gitlive.loadZones();
        if (!zones[zone]) return fail(res, 404, 'NOT_FOUND', `zone "${zone}" is not registered — add it in Settings → naming, or: gitlive domain zone ${zone}`);
        const reg = gitlive.loadRegistry();
        const app = reg[decodeURIComponent(nameMatch[1])];
        if (!app) return fail(res, 404, 'NOT_FOUND', `No app named "${decodeURIComponent(nameMatch[1])}"`);
        if (app.mode === 'connect') return fail(res, 409, 'CONFLICT', 'connect-mode apps are managed by their runner — no local zone label to claim');
        const label = `${decodeURIComponent(nameMatch[1])}.${zone}`;
        app.domains = Array.from(new Set([...(app.domains || []), label]));
        app.zone = zone;
        gitlive.saveRegistry(reg);
        return ok(res, { app: app.name, label, zone, borrowed: true, note: 'borrowed label — one command graduates it to your own domain' });
      }
      const appNameMatch = p.match(/^\/api\/apps\/([^/]+)$/);
      const appName = decodeURIComponent((appsMatch || appNameMatch || [])[1] || '');

      // ── ops views (redesign round) ─────────────────────────────────────
      if (p === '/api/peers' && req.method === 'GET') return ok(res, peersOverview());
      if (p === '/api/events' && req.method === 'GET') return ok(res, eventsTail());
      if (p === '/api/daemon' && req.method === 'GET') return ok(res, daemonStatus());
      if (p === '/api/daemon' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          return ok(res, body && body.action === 'stop' ? daemonStop() : await daemonEnsure());
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/entry' && req.method === 'GET') return ok(res, entryStatus());
      if (p === '/api/public' && req.method === 'GET') return ok(res, await publicReachCheck(false));
      if (p === '/api/public/refresh' && req.method === 'POST') return ok(res, await publicReachCheck(true));
      if (p === '/api/up' && req.method === 'POST') {
        // the master switch: bring every local app back (the CLI's `gitlive up`,
        // same logic, same receipts). Synchronous by design — the button waits
        // for the real result.
        try { return ok(res, gitlive.upData()); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/pool' && req.method === 'GET') return ok(res, gitlive.poolListData());
      const examMatch = p.match(/^\/api\/apps\/([^/]+)\/exam$/);
      if (examMatch && req.method === 'POST') {
        // the admission exam: the five checks that gate entry into the pool.
        try { return ok(res, await gitlive.poolAdmissionData(decodeURIComponent(examMatch[1]))); }
        catch (err) { return fail(res, err.code === 'NOT_FOUND' ? 404 : 500, err.code || 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/domains' && req.method === 'GET') return ok(res, domainsOverview());
      if (p === '/api/domains/local' && req.method === 'POST') {
        try { return ok(res, domainLocalAction(await readBody(req))); }
        catch (err) { return fail(res, err.code === 'INVALID_ARGS' ? 400 : 500, err.code || 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/domains/zone' && req.method === 'POST') {
        try { return ok(res, domainZoneAction(await readBody(req))); }
        catch (err) { return fail(res, err.code === 'INVALID_ARGS' ? 400 : (err.code === 'NOT_FOUND' ? 404 : 500), err.code || 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/settings' && req.method === 'GET') {
        const adminSet = Boolean(await adminEmail());
        const regOpenSetting = await registrationOpenSetting();
        return ok(res, {
          registrationOpen: allowRegister || regOpenSetting === true || !adminSet,
          registrationExplicit: regOpenSetting !== null,
          allowRegister,
          adminSet,
        });
      }
      if (p === '/api/settings/registration' && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.open !== 'boolean') return fail(res, 400, 'INVALID_ARGS', 'open (boolean) is required');
        if (!allowRegister) await setRegistrationOpen(body.open);
        const adminSet = Boolean(await adminEmail());
        return ok(res, { registrationOpen: allowRegister || body.open || !adminSet, note: allowRegister ? 'startup flag --allow-register is set; this toggle is inert until the flag is removed' : null });
      }
      if (p === '/api/keys' && req.method === 'GET') return ok(res, keysStatus());
      if (p === '/api/mesh/invite' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          return ok(res, await issueInvite(body));
        } catch (err) {
          return fail(res, err.code === 'INVALID_ARGS' ? 400 : 409, err.code || 'NO_OWNER_KEY', err.message);
        }
      }

      // ── mesh views (Phase 2 item 5) ────────────────────────────────────
      if (p === '/api/mesh' && req.method === 'GET') {
        return ok(res, meshRegistrySummary());
      }
      if (p === '/api/sandbox/init' && req.method === 'POST') {
        try { return ok(res, await sandboxInit()); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/sandbox/break' && req.method === 'POST') {
        try { return ok(res, await sandboxStep(true)); }
        catch (err) { return fail(res, err.code === 'ENOENT' ? 409 : 500, err.code === 'ENOENT' ? 'CONFLICT' : 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/sandbox/fix' && req.method === 'POST') {
        try { return ok(res, await sandboxStep(false)); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/sandbox/destroy' && req.method === 'POST') {
        try { return ok(res, sandboxDestroy()); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      const dmMatch = p.match(/^\/api\/apps\/([^/]+)\/datamap$/);
      if (dmMatch && req.method === 'GET') {
        try { return ok(res, datamapFor(decodeURIComponent(dmMatch[1]))); }
        catch (err) { return fail(res, 404, 'NOT_FOUND', err.message || String(err)); }
      }
      // the receipt in the standard envelope (theater's copy button): the
      // SAME attest.js statement a terminal `gitlive attest` produces —
      // only the transport differs, never the bytes.
      const attestMatch = p.match(/^\/api\/apps\/([^/]+)\/attest$/);
      if (attestMatch && req.method === 'GET') {
        try {
          const attest = require('../attest.js');
          const manifest = require('../manifest.js');
          const keyPath = process.env.GITLIVE_MANIFEST_KEY || manifest.DEFAULT_KEY_PATH;
          if (!fs.existsSync(keyPath)) throw new Error('no owner key on this machine — run gitlive manifest keygen');
          const { priv, fingerprint } = manifest.loadPrivateKey(keyPath);
          const appName = decodeURIComponent(attestMatch[1]);
          const reg = gitlive.loadRegistry();
          const app = reg[appName];
          if (!app || !app.barePath) throw new Error(`No app named "${appName}"`);
          const tag = attest.latestDeployTag(app.barePath);
          if (tag.legacy || !tag.sigValid) throw new Error('no valid owner-signed deploy receipt yet — push once with the current hooks');
          const stmt = attest.buildStatement({
            appName, commit: String(tag.commit || ''), closure: tag.closure || null,
            outcome: tag.outcome || 'success', at: tag.at || null, barePath: app.barePath, fingerprint,
          });
          return ok(res, attest.envelope(stmt, priv, fingerprint));
        } catch (err) {
          return fail(res, 404, 'NOT_FOUND', err.message || String(err));
        }
      }
      const healthMatch = p.match(/^\/api\/apps\/([^/]+)\/health$/);
      if (healthMatch && req.method === 'GET') {
        try { return ok(res, healthHistoryData(decodeURIComponent(healthMatch[1]))); }
        catch (err) { return fail(res, 404, 'NOT_FOUND', err.message || String(err)); }
      }
      const meshMatch = p.match(/^\/api\/apps\/([^/]+)\/(replicas|conflicts)$/);
      if (meshMatch && req.method === 'GET') {
        const view = meshMatch[2];
        const meta = meshMetaFor(appName);
        if (!meta.meshed) return ok(res, view === 'replicas' ? { meshed: false, replicas: [] } : { meshed: false, entries: [] });
        if (view === 'replicas') {
          const meshMod = require('../mesh.js');
          const mesh = meshMod.loadMesh();
          const rows = [];
          for (const [key, node] of Object.entries(mesh.nodes)) {
            if (node.home === os.homedir()) continue;
            try {
              const r = meshMod.peerReport(node.home, appName);
              rows.push({ node: key, alive: r.alive, primary: r.primary === key, commit: r.commit.slice(0, 8), runPath: r.runPath });
            } catch {
              rows.push({ node: key, alive: null, error: 'unreachable' });
            }
          }
          return ok(res, { meshed: true, primary: meta.primary, replicas: rows });
        }
        // conflicts ledger (D2) — lives next to the state bus under this home
        const ledger = path.join(os.homedir(), '.gitlive', 'state', `${appName}.conflicts.jsonl`);
        if (!fs.existsSync(ledger)) return ok(res, { meshed: true, entries: [] });
        const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
        return ok(res, { meshed: true, entries: lines.slice(-50).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) });
      }


      const runAction = async (fn) => {
        try {
          return ok(res, await fn(appName));
        } catch (err) {
          return fail(res, 404, 'NOT_FOUND', err.message || String(err));
        }
      };

      if (p === '/api/apps' && req.method === 'GET') {
        const apps = localExecutor.listApps();
        const reg = gitlive.loadRegistry();
        for (const a of apps) {
          a.mesh = meshMetaFor(a.name);
          a.lastDeploy = lastDeployFor(reg[a.name] || a);
          a.sandbox = Boolean(reg[a.name] && reg[a.name].sandbox);
          Object.assign(a, domainMeta(reg[a.name] || {}));
          if (reg[a.name] && reg[a.name].runPath) a.h = healthSummaryFor(reg[a.name]);
        }
        return ok(res, apps);
      }
      if (appNameMatch && req.method === 'GET') {
        return runAction(async (n) => {
          const st = await localExecutor.getApp(n);
          st.mesh = meshMetaFor(n);
          st.sandbox = Boolean((gitlive.loadRegistry()[n] || {}).sandbox);
          Object.assign(st, domainMeta(gitlive.loadRegistry()[n] || {}));
          // proxy-down hint (field finding): backend slots healthy, public
          // port dead — tell the owner the fix is proxy supervision/restart
          st.proxyDownHint = Boolean(st.safe && st.proxyUp === false);
          return st;
        });
      }
      if (appsMatch && req.method === 'GET' && appsMatch[2] === 'logs') {
        return runAction((n) => localExecutor.getLogs(n));
      }
      if (appsMatch && req.method === 'POST') {
        const action = appsMatch[2];
        if (!['stop', 'deploy', 'rollback', 'restart'].includes(action)) {
          return fail(res, 400, 'INVALID_ARGS', `Unknown action "${action}".`);
        }
        return runAction((n) => localExecutor[action](n));
      }

      fail(res, 404, 'NOT_FOUND', `No such endpoint: ${req.method} ${p}`);
    } catch (err) {
      const code = err.code || 'INTERNAL';
      const status =
        code === 'CONFLICT' ? 409
          : code === 'REGISTRATION_CLOSED' ? 403
            : code === 'INVALID_ARGS' ? 400
              : code === 'AUTH_ERROR' ? 401
                : 500;
      if (status >= 500) {
        // eslint-disable-next-line no-console
        console.error('[gitlive-control] ' + (err.stack || err.message));
      }
      fail(res, status, code, err.message || String(err));
    }
  });

  const instance = {
    server,
    client,
    allowRegister,
    port,
    host,
    url: `http://${host}:${port}`,
    adminEmail: () => adminEmail(),
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          // eslint-disable-next-line no-console
          console.log(`gitlive control plane on ${instance.url}`);
          adminEmail().then((admin) => {
            // eslint-disable-next-line no-console
            console.log(admin
              ? `Dashboard: ${instance.url}  (admin: ${admin})`
              : `First run: register the admin account at ${instance.url}`);
          }).catch(() => {});
          resolve(instance);
        });
      });
    },
    close() {
      try { client.close(); } catch { /* already closed */ }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return instance;
}

module.exports = { createControlServer, CONTROL_ROOT };
