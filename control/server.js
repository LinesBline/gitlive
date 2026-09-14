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
const { execFileSync, spawnSync } = require('node:child_process');

const gitlive = require(path.join(__dirname, '..', 'gitlive.js'));
const gitliveClient = require(path.join(__dirname, '..', 'gitlive-client'));
// the v4 intelligence layer: measurement, detection and explanation over the
// machine's own ledgers. Pure functions + two small files (policies, agent
// state) — it never touches the network and never invents a number.
const intel = require('./intel.js');

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
// ── access log: one line per request, never a body or a secret ────────────
// A local plane still needs to answer "what failed, when, how long" — the
// reference rule is log enough to debug, never enough to leak. Rotates at
// 5 MB so an idle machine cannot fill its disk with our own noise.
const ACCESS_LOG = path.join(os.homedir(), '.gitlive', 'control', 'access.log');
function accessLog(line) {
  try {
    fs.mkdirSync(path.dirname(ACCESS_LOG), { recursive: true });
    if (fs.existsSync(ACCESS_LOG) && fs.statSync(ACCESS_LOG).size > 5 * 1024 * 1024) {
      const buf = fs.readFileSync(ACCESS_LOG);
      fs.writeFileSync(ACCESS_LOG, buf.slice(Math.floor(buf.length / 2)));
    }
    fs.appendFileSync(ACCESS_LOG, line + '\n');
  } catch { /* the log must never break a request */ }
}
function newRequestId() { return crypto.randomBytes(4).toString('hex'); }

// delivery ids seen in the last 24h — bounded to 500 entries, oldest dropped
const REPLAY_LEDGER = path.join(os.homedir(), '.gitlive', 'control', 'webhook-deliveries.jsonl');
function replaySeen(delivery) {
  try {
    const now = Date.now();
    let rows = [];
    if (fs.existsSync(REPLAY_LEDGER)) {
      rows = fs.readFileSync(REPLAY_LEDGER, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .filter((r) => r.at && now - new Date(r.at).getTime() < 24 * 3600 * 1000)
        .slice(-500);
    }
    if (rows.some((r) => r.id === delivery)) {
      fs.writeFileSync(REPLAY_LEDGER, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return true;
    }
    rows.push({ id: delivery, at: new Date().toISOString() });
    fs.mkdirSync(path.dirname(REPLAY_LEDGER), { recursive: true });
    fs.writeFileSync(REPLAY_LEDGER, rows.slice(-500).map((r) => JSON.stringify(r)).join('\n') + '\n');
    return false;
  } catch {
    return false; // a broken ledger must not block legitimate deploys
  }
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
function fail(res, status, code, message, details) {
  // `details` is optional and additive: the dashboard reads it to show the
  // REAL process output behind a failure (e.g. the log of a `gitlive init`
  // the create-app form ran) instead of a one-line paraphrase of it.
  //
  // Every error that leaves the plane passes through the secret redactor: an
  // error message is exactly where a token ends up (a failed ACME call quotes
  // its URL, a failed app start quotes its command line with the credentials
  // in it). This is one boundary, so no route can forget it.
  const redact = require('./redact.js');
  json(res, status, {
    ok: false,
    error: {
      code,
      message: redact.redactSecrets(message),
      ...(details ? { details: redact.shareableDeep(details, { names: knownAppNames(), home: os.homedir() }) } : {}),
    },
  });
}
function knownAppNames() {
  try { return Object.keys(gitlive.loadRegistry()); } catch { return []; }
}

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
  if (!outboundAllowed()) throw new Error('outbound checks are switched off (GITLIVE_OFFLINE=1)');
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
// certificate visibility: every cert gitlive holds + its days-left (parsed
// with node's built-in X509 — no openssl dependency)
// scheduled tasks: the plane's own cron ticker. 5-field classic cron with an
// optional leading seconds field (tests use it). Every fire lands in the job
// ledger (kind 'cron') + the audit events log — never a silent run.
const CRON_INTERVAL_MS = Number(process.env.GITLIVE_CRON_INTERVAL_MS) || 60000;
function cronFieldMatch(field, val) {
  if (field === '*') return true;
  for (const part of String(field).split(',')) {
    if (part.includes('/')) {
      const [base, step] = part.split('/');
      if (base !== '*' || !Number(step)) continue;
      if (val % Number(step) === 0) return true;
    } else if (String(part) === String(val)) {
      return true;
    }
  }
  return false;
}
function cronDue(cron, now) {
  const parts = String(cron || '').trim().split(/\s+/);
  let sec = null;
  if (parts.length === 6) sec = parts.shift();
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  const base = cronFieldMatch(m, now.getMinutes()) && cronFieldMatch(h, now.getHours()) &&
    cronFieldMatch(dom, now.getDate()) && cronFieldMatch(mon, now.getMonth() + 1) && cronFieldMatch(dow, now.getDay());
  return base && (sec === null || cronFieldMatch(sec, now.getSeconds()));
}
const cronFired = new Map();
function cronTick() {
  try {
    const reg = gitlive.loadRegistry();
    const now = new Date();
    for (const [name, app] of Object.entries(reg)) {
      const sch = app.schedule;
      if (!sch || sch.enabled === false) continue;
      if (!cronDue(sch.cron, now)) continue;
      const key = name + '@' + now.toISOString().slice(0, 19);
      if (cronFired.get(key)) continue;
      cronFired.set(key, true);
      spawnDetached('/bin/bash', ['-c', String(sch.cmd)], 'cron', 'cron: ' + name);
      try { require('../crypt.js').logEvent('cron', { app: name, cron: sch.cron, cmd: String(sch.cmd).slice(0, 120) }); } catch { /* audit best-effort */ }
    }
  } catch { /* the ticker must never crash the plane */ }
}
let cronTimer = null;
let sessionPruneTimer = null;
function cronStart() { if (!cronTimer) cronTimer = setInterval(cronTick, CRON_INTERVAL_MS); }

function certsOverview() {
  const rows = [];
  const add = (domain, crtPath, kind) => {
    try {
      if (!fs.existsSync(crtPath)) { rows.push({ domain, kind, present: false, daysLeft: null, status: 'missing' }); return; }
      const pem = fs.readFileSync(crtPath, 'utf8');
      const cert = new crypto.X509Certificate(pem);
      const daysLeft = Math.round((new Date(cert.validTo).getTime() - Date.now()) / 86400000);
      // the lifetime travels with the row: renewal lead time is a fraction of
      // it, because CA lifetimes are shrinking (200d → 100d → 47d)
      const lifetimeDays = Math.max(1, Math.round((new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime()) / 86400000));
      const lead = Math.max(14, Math.min(30, Math.round(lifetimeDays * 0.15)));
      rows.push({ domain, kind, present: true, daysLeft, lifetimeDays, leadDays: lead, expiresAt: cert.validTo, status: daysLeft < 0 ? 'expired' : daysLeft <= lead ? 'expiring' : 'ok' });
    } catch (err) {
      rows.push({ domain, kind, present: true, daysLeft: null, status: 'unparsable', note: err.message || String(err) });
    }
  };
  // local gateway certs
  try {
    const tls = gitlive.domainTlsPaths();
    add('*.gitlive (local gateway)', tls.srvCrt, 'local');
  } catch { /* no local tls */ }
  // public-domain certs
  try {
    const dir = gitlive.publicCertDir();
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.crt')) add(f.slice(0, -4), path.join(dir, f), 'public');
      }
    }
  } catch { /* no public certs */ }
  // zone wildcard certs (stored per zone)
  try {
    const zones = gitlive.loadZones();
    for (const z of Object.keys(zones)) {
      const crt = path.join(gitlive.publicCertDir(), '*.' + z + '.crt');
      if (fs.existsSync(crt)) add('*.' + z, crt, 'wildcard');
    }
  } catch { /* zones optional */ }
  return { certs: rows };
}
let npmLatestCache = { at: 0, version: null };
// OUTBOUND IS OPT-IN-ABLE. Two things on this machine call out on their own:
// the npm version check and the public-repo check. Both are read-only and send
// nothing but the request — but a self-hosted machine should be able to say
// "never call out", and then the cockpit says it too instead of failing.
function outboundAllowed() { return String(process.env.GITLIVE_OFFLINE || '0') !== '1'; }
async function npmLatestVersion() {
  if (!outboundAllowed()) return null;
  if (Date.now() - npmLatestCache.at < 5 * 60 * 1000 && npmLatestCache.version) return npmLatestCache.version;
  try {
    const r = await publicFetch(PUBLIC_NPM_URL, 'application/json');
    if (!r.ok) return npmLatestCache.version;
    const j = await r.json();
    npmLatestCache = { at: Date.now(), version: String(j.version || '') || npmLatestCache.version };
  } catch { /* offline — keep the cache */ }
  return npmLatestCache.version;
}
function semverGt(a, b) {
  try {
    const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d > 0;
    }
    return false;
  } catch { return false; }
}
// dns write receipts: every publishAppDns/auto-name write lands in the app's
// own dns-history.jsonl — merged here newest-first so the naming section can
// show the paper trail.
function dnsHistoryData() {
  const reg = gitlive.loadRegistry();
  const rows = [];
  for (const [name, app] of Object.entries(reg)) {
    if (!app.runPath) continue;
    const f = path.join(app.runPath, 'dns-history.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) {
      try { rows.push({ app: name, ...JSON.parse(line) }); } catch { /* skip malformed */ }
    }
  }
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return { receipts: rows.slice(0, 20) };
}

// the app troubleshoot chain — hops from process to public DNS, each with
// one honest fix. Reads and probes; never changes anything.
async function appDiagnose(appName) {
  const net = require('node:net');
  const reg = gitlive.loadRegistry();
  const app = reg[appName];
  if (!app) throw new Error('No app named "' + appName + '"');
  const rows = [];
  const push = (hop, status, title, detail, fix) => rows.push({ hop, status, title, detail, fix: fix || null });
  const alivePid = (p) => {
    if (!p) return false;
    try { process.kill(Number(p), 0); return true; } catch { return false; }
  };
  const portOpen = (port) => new Promise((resolve) => {
    if (!port) return resolve(false);
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1200, () => { s.destroy(); resolve(false); });
  });

  if (app.mode === 'connect') {
    push('runner', 'warn', 'Managed by its own runner', 'connect-mode apps are owned by launchd/systemd — gitlive holds the repo, the OS holds the process. Check that machine, not this dashboard.', null);
    return { app: appName, rows };
  }

  // hop 1 — the process (or proxy, for safe apps)
  const runPath = app.runPath;
  let proxyPid = null, slotPid = null;
  if (app.safe) {
    proxyPid = (() => { try { return fs.readFileSync(path.join(runPath, 'proxy.pid'), 'utf8').trim(); } catch { return null; } })();
    const slot = (() => { try { return fs.readFileSync(path.join(runPath, 'active-slot'), 'utf8').trim(); } catch { return ''; } })();
    slotPid = slot ? (() => { try { return fs.readFileSync(path.join(runPath, slot + '.pid'), 'utf8').trim(); } catch { return null; } })() : null;
    if (alivePid(proxyPid)) push('proxy', 'ok', 'The public proxy is alive', 'pid ' + proxyPid, null);
    else push('proxy', 'fail', 'The public proxy is down', 'the backend slot may be healthy but nobody is answering the public port', { kind: 'action', label: '↻ restart (revives the proxy)', action: 'restart' });
    if (alivePid(slotPid)) push('process', 'ok', 'The app process is alive', 'slot pid ' + slotPid, null);
    else push('process', 'fail', 'The app process is down', 'the proxy is up but the slot behind it is dead', { kind: 'action', label: '▲ deploy (brings the slot back)', action: 'deploy' });
  } else {
    const pid = (() => { try { return fs.readFileSync(path.join(runPath, 'app.pid'), 'utf8').trim(); } catch { return null; } })();
    if (alivePid(pid)) push('process', 'ok', 'The app process is alive', 'pid ' + pid, null);
    else push('process', 'fail', 'The app process is down', 'the pid file has no living process behind it', { kind: 'action', label: '↻ restart it', action: 'restart' });
  }

  // hop 2 — the port actually answers
  const port = app.safe ? app.publicPort : app.port;
  const open = await portOpen(port);
  if (!port) push('port', 'skip', 'No port recorded', 'the registry has no port for this app — reconnect it or re-init', null);
  else if (open) push('port', 'ok', 'The port is answering', 'port ' + port + ' accepts connections', null);
  else push('port', 'warn', 'The port is silent', 'the process may be up but not listening on ' + port + ' — check its own start log', { kind: 'link', label: 'open the deploy log', target: 'log' });

  // hop 3 — health probe (safe apps have a real health path)
  if (app.safe && port) {
    try {
      const hp = app.healthPath || '/';
      const r = await fetch('http://127.0.0.1:' + port + hp, { signal: AbortSignal.timeout(2500) });
      if (r.ok) push('health', 'ok', 'The health path answers', 'GET ' + hp + ' → ' + r.status, null);
      else push('health', 'warn', 'The health path answers, but not 2xx', 'GET ' + hp + ' → ' + r.status + ' — the app sees itself as unhealthy', null);
    } catch {
      push('health', 'warn', 'The health path does not answer', 'the port is open but the health probe timed out — the app may still be booting, or crashed mid-start', { kind: 'link', label: 'open the deploy log', target: 'log' });
    }
  } else {
    push('health', 'skip', 'No health probe for plain-mode apps', 'plain apps are trusted on their port alone — the exam adds probes when it goes public', null);
  }

  // hop 4 — local names gateway (how the machine reaches <app>.gitlive)
  try {
    const dn = domainsOverview().local;
    if (dn.on) push('name', 'ok', 'Local names are on', 'the gateway answers <app>.gitlive on port ' + (dn.port || '?'), null);
    else push('name', 'warn', 'Local names are off', 'the app runs, but <app>.gitlive does not answer', { kind: 'action', label: 'names on', action: 'local-on' });
  } catch (err) {
    push('name', 'warn', 'Local names status unknown', err.message || String(err), null);
  }

  // hop 5 — public path: domains + certs + LIVE DNS read-back (when a zone
  // with a token covers the name, the chain asks the zone what it answers)
  const domains = Array.isArray(app.domains) ? app.domains : [];
  if (!domains.length) {
    push('public', 'skip', 'No public name yet', 'claim a zone label on the card, or graduate to your own domain — then this hop lights up', { kind: 'link', label: 'open the card', target: 'apps' });
  } else {
    const tls = gitlive.domainTlsPaths();
    const certs = [];
    for (const d of domains) {
      const crt = path.join(gitlive.publicCertDir(), d + '.crt');
      if (fs.existsSync(crt)) certs.push(d);
    }
    if (certs.length === domains.length) push('public', 'ok', 'Every domain has its certificate installed', domains.length + ' domain(s)', null);
    else push('public', 'warn', 'Some domains lack a certificate', 'https will fail for: ' + domains.filter((d) => !certs.includes(d)).join(', '), { kind: 'link', label: 'open naming (wildcard cert)', target: 'naming' });
    // live DNS read-back — the honest truth of what the world sees
    const zones = gitlive.loadZones();
    const ip = (() => { try { return gitlive.publicIpv6(); } catch { return null; } })();
    for (const d of domains) {
      const zone = Object.keys(zones).find((z) => d === z || d.endsWith('.' + z));
      if (!zone) {
        push('dns', 'skip', 'DNS for ' + d + ' — no covering zone registered', 'the name is your own domain: check it at your registrar (A/AAAA → this machine or your entry)', null);
        continue;
      }
      const zc = zones[zone];
      if (!zc || !zc.dnsToken) {
        push('dns', 'warn', 'DNS for ' + d + ' — zone has no token', 'paste the zone\'s DNS token in Settings → naming and the chain can read the live record', { kind: 'link', label: 'open naming', target: 'naming' });
        continue;
      }
      try {
        const sub = d === zone ? '' : d.slice(0, -(zone.length + 1));
        const acme = require('../acme.js');
        const rec = await acme.providers.desec.getRecord({
          token: zc.dnsToken, zone, subname: sub || '', type: 'AAAA',
          fetchImpl: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(5000) }),
        });
        if (!rec.exists) {
          push('dns', 'fail', 'DNS for ' + d + ' — no AAAA published', 'the zone answers nothing for this name — publish it (the card\'s claim, or: gitlive name publish)', { kind: 'link', label: 'open the card', target: 'apps' });
        } else if (ip && rec.values.includes(ip)) {
          push('dns', 'ok', 'DNS for ' + d + ' answers with this machine', 'AAAA ' + rec.values.join(', ') + ' → your public IPv6', null);
        } else {
          push('dns', 'warn', 'DNS for ' + d + ' points elsewhere', 'the zone answers: ' + rec.values.join(', ') + (ip ? ' — this machine is ' + ip + '; re-publish to point the name here' : ' — and this machine has no public IPv6 right now'), { kind: 'link', label: 'open the card', target: 'apps' });
        }
      } catch (err) {
        push('dns', 'warn', 'DNS read for ' + d + ' could not complete', err.message || String(err), null);
      }
    }
  }

  return { app: appName, checkedAt: new Date().toISOString(), rows };
}

// ── v4 · the intelligence layer's view of the machine ──────────────────
// Everything the score and the detectors need, gathered from the SAME sources
// the checkup reads (no second implementation of any fact).
function diskFacts() {
  try {
    const df = execFileSync('df', ['-k', os.homedir()], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[1];
    if (!df) return { diskFreeMb: null, diskTotalMb: null };
    const parts = df.split(/\s+/);
    const totalKb = Number(parts[1]);
    const availKb = Number(parts[3]);
    return {
      diskFreeMb: Number.isFinite(availKb) ? Math.round(availKb / 1024) : null,
      diskTotalMb: Number.isFinite(totalKb) ? Math.round(totalKb / 1024) : null,
    };
  } catch { return { diskFreeMb: null, diskTotalMb: null }; }
}

function integrityFact() {
  try { return gitlive.integrityCheck().ok === true; } catch { return null; }
}

function listAppsForIntel() {
  try { return Object.keys(gitlive.loadRegistry()); } catch { return []; }
}

// the resource series the trend detectors read: RSS, data size, log size and
// free disk, sampled on a slow cadence (5 min) and capped like health history
const STATS_INTERVAL_MS = Number(process.env.GITLIVE_STATS_INTERVAL_MS) || 5 * 60 * 1000;
function statsFileFor(app) { return path.join(app.runPath, 'stats-history.jsonl'); }
function sampleOneStats(app, name) {
  const out = { app: name, at: new Date().toISOString(), rssMb: null, dataBytes: null, logBytes: null, diskFreeMb: null };
  try {
    const pidFile = app.safe ? path.join(app.runPath, 'proxy.pid') : path.join(app.runPath, 'app.pid');
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    if (pid) {
      const rss = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
      if (rss) out.rssMb = Math.round(Number(rss) / 1024);
    }
  } catch { /* not running — an honest null, never a zero */ }
  try {
    const dataDir = path.join(app.runPath, 'data');
    if (fs.existsSync(dataDir)) {
      const du = execFileSync('du', ['-sk', dataDir], { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/)[0];
      if (du) out.dataBytes = Number(du) * 1024;
    }
    const logF = path.join(app.runPath, 'deploy.log');
    if (fs.existsSync(logF)) out.logBytes = fs.statSync(logF).size;
  } catch { /* honest nulls */ }
  const d = diskFacts();
  out.diskFreeMb = d.diskFreeMb;
  return out;
}
function appendStatsSample(app, entry) {
  try {
    const f = statsFileFor(app);
    fs.appendFileSync(f, JSON.stringify(entry) + '\n');
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length > 2000) fs.writeFileSync(f, lines.slice(-2000).join('\n') + '\n');
  } catch { /* history must never break the plane */ }
}
async function sampleStats() {
  try {
    for (const [name, app] of Object.entries(gitlive.loadRegistry())) {
      if (app.mode === 'connect' || !app.runPath) continue;
      appendStatsSample(app, sampleOneStats(app, name));
    }
  } catch { /* registry unavailable — skip a beat */ }
}
let statsTimer = null;
function startStatsSampler() {
  statsTimer = setInterval(sampleStats, Math.max(30000, STATS_INTERVAL_MS));
  statsTimer.unref();
  return statsTimer;
}

function certRowsForScore() {
  try { return certsOverview().filter((c) => c.present && typeof c.daysLeft === 'number'); } catch { return []; }
}

function intelFacts() {
  return {
    apps: listAppsForIntel(),
    integrityOk: integrityFact(),
    certs: certRowsForScore(),
    agentRows: intel.timelineFor ? undefined : undefined, // filled inside intelOverview
    ...diskFacts(),
    version: gitlive.VERSION,
  };
}

function doctorOverview() {
  return (async () => {
  const rows = [];
  const push = (key, status, title, detail, fix) => rows.push({ key, status, title, detail, fix: fix || null });
  // 1 — the plane binary: one install, one link
  const doc = gitlive.getDoctorData();
  if (doc.linked) {
    if (doc.mismatch) {
      // no version pinned into the fix: this command must stay true across
      // releases (it used to name one specific tarball)
      push('plane', 'fail', 'The gitlive command points at a different install than this control plane', doc.linked + ' → ' + doc.real, { kind: 'command', label: 'point the command at this install', command: 'ln -sf ~/.gitlive-app/bin/gitlive /usr/local/bin/gitlive' });
    } else {
      push('plane', 'ok', 'One install, one link — the gitlive command IS this plane', 'v' + doc.version + ' · ' + doc.linked, null);
    }
  } else {
    push('plane', 'fail', 'The gitlive command is not on your PATH', 'the dashboard works, but terminal commands will say "command not found"', { kind: 'command', label: 'link the command', command: 'ln -sf ~/.gitlive-app/bin/gitlive /usr/local/bin/gitlive' });
  }
  // 2 — shipped-file integrity
  try {
    const ic = gitlive.integrityCheck();
    if (ic.ok) push('integrity', 'ok', 'All shipped files verify against the signed manifest', ic.fileCount + ' files · manifest v' + ic.version, null);
    else push('integrity', 'fail', 'Shipped files drifted from the manifest', ic.reason + (ic.changed && ic.changed.length ? ' — changed: ' + ic.changed.slice(0, 3).join(', ') : '') + (ic.missing && ic.missing.length ? ' — missing: ' + ic.missing.slice(0, 3).join(', ') : ''), { kind: 'command', label: 're-verify the manifest', command: 'gitlive doctor --integrity' });
  } catch (err) {
    push('integrity', 'fail', 'Integrity check could not run', err.message || String(err), { kind: 'command', label: 'run it from the terminal', command: 'gitlive doctor --integrity' });
  }
  // 3 — every registered app's repos and run dirs
  const reg = gitlive.loadRegistry();
  const names = Object.keys(reg);
  if (!names.length) {
    push('apps', 'warn', 'No apps registered on this machine yet', 'the apps area shows how to push your first one', { kind: 'link', label: 'open apps', target: 'apps' });
  } else {
    const broken = (doc.apps || []).filter((a) => !a.ok);
    if (!broken.length) push('apps', 'ok', 'Every registered app has its repo and run dir intact', names.length + ' app' + (names.length === 1 ? '' : 's'), null);
    else push('apps', 'warn', 'Some apps lost their repo or run dir', broken.map((b) => b.name).join(', ') + ' — their cards in apps explain what is missing', { kind: 'link', label: 'open apps', target: 'apps' });
  }
  // 4 — the daemon supervisor
  const dm = daemonStatus();
  if (dm.running) push('daemon', 'ok', 'The supervisor is watching', 'pid ' + dm.pid, null);
  else if (dm.note === 'crashed') push('daemon', 'warn', 'The supervisor crashed — apps still run, nothing revives them', 'pid file present, process gone', { kind: 'action', label: 'ensure supervisor', action: 'daemon-ensure' });
  else push('daemon', 'warn', 'The supervisor is not running', 'apps keep running, but nothing restarts them after a crash', { kind: 'action', label: 'ensure supervisor', action: 'daemon-ensure' });
  // 5 — local names gateway
  try {
    const dn = domainsOverview().local;
    if (dn.on) push('gateway', 'ok', 'Local names gateway is on', 'port ' + (dn.port || '?') + (dn.tlsPort ? ' · https ' + dn.tlsPort : ''), null);
    else push('gateway', 'warn', 'Local names are off', 'apps still run on their ports, but <app>.gitlive stops answering', { kind: 'action', label: 'names on', action: 'local-on' });
  } catch (err) {
    push('gateway', 'warn', 'Local names status unknown', err.message || String(err), null);
  }
  // 6 — public IPv6 for the name office
  let ip = null;
  try { ip = gitlive.publicIpv6(); } catch { /* no stable public address */ }
  if (ip) push('ipv6', 'ok', 'A stable public IPv6 address is available for names', ip, null);
  else push('ipv6', 'warn', 'No stable public IPv6 right now', 'name publish would refuse; the address returns once the interface is back', null);
  // 7 — zones
  try {
    const zones = gitlive.loadZones();
    const zn = Object.keys(zones);
    if (!zn.length) push('zones', 'warn', 'No zones registered yet', 'a zone + a DNS token makes every new app globally reachable from its first push', { kind: 'link', label: 'open naming', target: 'machine:settings' });
    else {
      const withToken = zn.filter((z) => zones[z] && zones[z].dnsToken).length;
      push('zones', withToken === zn.length ? 'ok' : 'warn', (withToken === zn.length ? 'Every zone is ready to publish names' : 'Some zones lack their DNS token'), zn.length + ' zone' + (zn.length === 1 ? '' : 's') + ' · ' + withToken + ' with token', { kind: 'link', label: 'open naming', target: 'machine:settings' });
    }
  } catch (err) {
    push('zones', 'warn', 'Zones could not be read', err.message || String(err), null);
  }
  // 8 — backups: a backup that was never verified is a wish. The plane's own
  // state rides the same list but is NOT an app: it has no restore drill, so
  // counting it as one would make this row lie.
  try {
    const bu = backupsOverview();
    const appRows = bu.apps.filter((a) => !a.state);
    const stateRow = bu.apps.find((a) => a.state);
    const withSnap = appRows.filter((a) => a.snapshots > 0);
    const verified = withSnap.filter((a) => a.verified);
    const stateNote = stateRow ? ' · control-plane state backed up ✓ (secrets excluded)' : ' · control-plane state: none yet';
    if (!withSnap.length && !stateRow) push('backups', 'warn', 'Nothing is backed up yet', 'an app\'s data is only safe once a snapshot exists — run one now', { kind: 'link', label: 'open backups', target: 'machine:settings' });
    else if (!withSnap.length) push('backups', 'warn', 'Only the control plane is backed up', 'no app has a snapshot yet' + stateNote, { kind: 'link', label: 'open backups', target: 'machine:settings' });
    else if (verified.length === withSnap.length) push('backups', 'ok', 'Every app is backed up and restore-verified', withSnap.length + ' app' + (withSnap.length === 1 ? '' : 's') + ' · drills pass' + stateNote, null);
    else push('backups', 'warn', 'Backed up, but not restore-verified', verified.length + ' of ' + withSnap.length + ' app' + (withSnap.length === 1 ? '' : 's') + ' drilled — a backup that cannot be restored is a wish' + stateNote, { kind: 'link', label: 'open backups', target: 'machine:settings' });
  } catch (err) {
    push('backups', 'warn', 'Backup state unknown', err.message || String(err), null);
  }
  // 8b — certificates: expiry must never be a browser-warning surprise
  try {
    const cs = certsOverview().certs;
    const bad = cs.filter((c) => c.status !== 'ok');
    if (!cs.length) push('certs', 'skip', 'No certificates held yet', 'the local gateway cert issues on demand; wildcard certs appear once a zone has its token', null);
    else if (!bad.length) push('certs', 'ok', 'Every certificate is current', cs.length + ' cert' + (cs.length === 1 ? '' : 's') + ' · no expiry inside 14 days', null);
    else push('certs', 'warn', 'Certificates need attention', bad.map((c) => (c.present === false ? c.domain + ' missing' : c.domain + ' · ' + (c.daysLeft === null ? 'unparsable' : (c.daysLeft < 0 ? 'EXPIRED' : c.daysLeft + 'd left')))).join(', '), { kind: 'link', label: 'open naming', target: 'machine:settings' });
  } catch (err) {
    push('certs', 'warn', 'Certificate state unknown', err.message || String(err), null);
  }
  // 9 — is there a newer gitlive on npm? (semver-honest: never "update" DOWN)
  const latest = await npmLatestVersion();
  if (latest && semverGt(latest, gitlive.VERSION)) {
    push('update', 'warn', 'A newer gitlive is published', 'npm has ' + latest + ', this node runs ' + gitlive.VERSION + ' — the update flow backs up first, shows the changes, and refuses without a backup', { kind: 'action', label: 'update gitlive →', action: 'open-update' });
  } else if (latest && latest === gitlive.VERSION) {
    push('update', 'ok', 'This node runs the newest published gitlive', 'v' + gitlive.VERSION, null);
  } else if (latest && semverGt(gitlive.VERSION, latest)) {
    push('update', 'ok', 'This node is AHEAD of the npm registry', 'node ' + gitlive.VERSION + ' · registry ' + latest + ' (unpublished build — that is fine on this machine)', null);
  } else {
    push('update', 'skip', 'npm lookup did not answer', 'offline is fine — the node keeps working; the row returns when the registry answers', null);
  }
  return { checkedAt: new Date().toISOString(), rows };
  })();
}

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
    // the machine's stable public address — the target every AAAA write uses
    ipv6: (() => { try { return gitlive.publicIpv6(); } catch { return null; } })(),
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
    const row = { at: new Date().toISOString(), ...entry };
    // previous sample, read BEFORE the append: the daily roll-up needs the
    // interval it covers to tell up-time from down-time from unknown-time
    let prev = null;
    try {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
      if (lines.length) prev = JSON.parse(lines[lines.length - 1]);
    } catch { /* first sample of a fresh file */ }
    fs.appendFileSync(f, JSON.stringify(row) + '\n');
    if (prev && prev.at) {
      try {
        intel.recordSampleInRollup(app.name || entry.app, { at: new Date(prev.at).getTime(), up: prev.up === true }, { at: new Date(row.at).getTime(), up: row.up === true }, { step: HEALTH_INTERVAL_MS });
      } catch { /* the roll-up is an optimisation, never a requirement */ }
    }
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
let healthTimer = null; // module-scoped so shutdown can clear it
let agentCaps = null;   // capabilities handed to control/agents.js at boot
function startHealthSampler() {
  healthTimer = setInterval(sampleHealth, Math.max(1000, HEALTH_INTERVAL_MS));
  healthTimer.unref(); // the sampler must never hold the process open
  sampleHealth();
  return healthTimer;
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

// Expired dashboard sessions are only removed when that exact token is
// presented again (gitlive-client's verifySession does the same on a hit), so
// a machine that has been up for months keeps collecting dead rows — the live
// plane had 23 of them, three long expired. Pruning is bounded, cheap and
// receipted: one DELETE by expiry, at boot and on the maintenance tick.
function pruneSessions(why) {
  if (!DatabaseSync) return { pruned: 0, skipped: 'sqlite unavailable on this node' };
  const dbPath = path.join(CONTROL_ROOT, 'app.db');
  if (!fs.existsSync(dbPath)) return { pruned: 0, skipped: 'no session database yet' };
  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    const before = db.prepare('SELECT COUNT(*) AS c FROM _gitlive_sessions').get().c;
    const gone = db.prepare('DELETE FROM _gitlive_sessions WHERE expires_at IS NOT NULL AND expires_at < ?').run(new Date().toISOString()).changes;
    const after = db.prepare('SELECT COUNT(*) AS c FROM _gitlive_sessions').get().c;
    if (gone) {
      try { require('../crypt.js').logEvent('sessions-pruned', { why, pruned: gone, remaining: after }); } catch { /* audit best-effort */ }
    }
    return { pruned: gone, remaining: after, before };
  } catch (err) {
    return { pruned: 0, error: err.message };
  } finally { if (db) try { db.close(); } catch { /* noop */ } }
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

// ── create an app from the dashboard ────────────────────────────────────
// Registering a project folder used to be the ONE thing that still needed a
// terminal. These two helpers close that gap WITHOUT a second implementation:
// the browser runs the same `gitlive init` the CLI runs (same flags, same
// hooks, same registry entry, same output) with cwd set to the chosen folder,
// and the process output is handed back verbatim so the receipt is the real
// receipt. The folder picker is a plain read-only directory listing — the
// plane already owns this machine; it never writes anything while browsing.
const APP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const BROWSE_SKIP = new Set(['node_modules', '.git', '.cache', '.Trash', 'Library']);
// hidden folders are the machine's business, not the owner's project list: the
// picker skips every dot-folder plus the noisy build/dependency dirs
function browseHidden(name) { return String(name).startsWith('.') || BROWSE_SKIP.has(name); }

function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

// macOS resolves /tmp → /private/tmp: the child `gitlive init` records
// process.cwd() (already physical), so the plane must compare like with like
// or a folder would look unregistered the moment it is registered.
function realDir(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function appNameTaken(name) {
  try { return Boolean(gitlive.loadRegistry()[name]); } catch { return false; }
}

// directories only, plus what gitlive can tell about each one BEFORE the
// owner commits to it (is it a git repo already? what stack is in there?)
function browseData(rawPath) {
  const target = realDir(path.resolve(expandHome(rawPath) || os.homedir()));
  let st;
  try { st = fs.statSync(target); } catch { throw Object.assign(new Error(`no such folder: ${target}`), { code: 'INVALID_ARGS' }); }
  if (!st.isDirectory()) throw Object.assign(new Error(`${target} is a file, not a folder`), { code: 'INVALID_ARGS' });
  if (target === realDir(gitlive.HOME_DIR) || target.startsWith(realDir(gitlive.HOME_DIR) + path.sep)) {
    throw Object.assign(new Error('that is gitlive\'s own working folder — pick the folder your project code lives in'), { code: 'INVALID_ARGS' });
  }
  let entries = [];
  try { entries = fs.readdirSync(target, { withFileTypes: true }); }
  catch (err) { throw Object.assign(new Error(`cannot read ${target}: ${err.message}`), { code: 'INVALID_ARGS' }); }
  const dirs = entries
    .filter((e) => {
      if (!e.isDirectory() && !(e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(target, e.name)).isDirectory(); } catch { return false; } })())) return false;
      return !browseHidden(e.name);
    })
    .map((e) => {
      const full = path.join(target, e.name);
      let kind = 'unknown';
      try { kind = gitlive.detectStack(full).kind; } catch { /* unreadable → unknown */ }
      return { name: e.name, path: full, kind, git: fs.existsSync(path.join(full, '.git')) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const here = gitlive.detectStack(target);
  return {
    path: target,
    parent: path.dirname(target) === target ? null : path.dirname(target),
    home: os.homedir(),
    dirs,
    here: {
      kind: here.kind,
      installCmd: here.installCmd || '',
      startCmd: here.startCmd || '',
      docker: here.docker || null,
      git: fs.existsSync(path.join(target, '.git')),
      name: path.basename(target).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 63),
      registered: appNameTaken(path.basename(target)),
    },
  };
}

function createAppData(body) {
  const b = body || {};
  const name = String(b.name || '').trim();
  if (!APP_NAME_RE.test(name)) {
    throw Object.assign(new Error('app name: letters, digits, dot, dash or underscore (max 63 chars, must not start with a dot)'), { code: 'INVALID_ARGS' });
  }
  if (!String(b.dir || '').trim()) throw Object.assign(new Error('choose the folder your project lives in'), { code: 'INVALID_ARGS' });
  const dir = realDir(path.resolve(expandHome(b.dir)));
  let st;
  try { st = fs.statSync(dir); } catch { throw Object.assign(new Error(`no such folder: ${dir}`), { code: 'INVALID_ARGS' }); }
  if (!st.isDirectory()) throw Object.assign(new Error(`${dir} is a file, not a folder`), { code: 'INVALID_ARGS' });
  if (dir === realDir(gitlive.HOME_DIR) || dir.startsWith(realDir(gitlive.HOME_DIR) + path.sep)) {
    throw Object.assign(new Error('that is gitlive\'s own working folder — pick the folder your project code lives in'), { code: 'INVALID_ARGS' });
  }
  if (appNameTaken(name) && !b.reconfigure) {
    throw Object.assign(new Error(`"${name}" is already registered on this machine — pass reconfigure to point it at a new folder`), { code: 'CONFLICT' });
  }
  const detected = gitlive.detectStack(dir);
  const dockerMode = b.docker ? (detected.docker || 'dockerfile') : detected.docker;
  const start = String(b.start || '').trim();
  if (!start && !dockerMode) {
    throw Object.assign(new Error('a start command is required (e.g. "npm start") — gitlive runs it on every deploy'), { code: 'INVALID_ARGS' });
  }
  const port = b.port === undefined || b.port === null ? '' : String(b.port).trim();
  if (port && !/^\d{1,5}$/.test(port)) throw Object.assign(new Error('port must be a number (1-65535)'), { code: 'INVALID_ARGS' });
  if (port && (Number(port) < 1 || Number(port) > 65535)) throw Object.assign(new Error('port must be between 1 and 65535'), { code: 'INVALID_ARGS' });
  if (b.safe && !port) throw Object.assign(new Error('safe (blue-green) mode needs the public port — it starts each release on an internal port and swaps'), { code: 'INVALID_ARGS' });
  if (port && !b.safe) {
    const clash = gitlive.registryPortConflict(gitlive.loadRegistry(), Number(port), name);
    if (clash) throw Object.assign(new Error(`port ${port} already belongs to "${clash}" on this machine — pick another port`), { code: 'CONFLICT' });
  }

  const gitliveFile = path.join(__dirname, '..', 'gitlive.js');
  const args = [gitliveFile, 'init', name, '--yes', '--install', String(b.install === undefined ? (detected.installCmd || '') : b.install).trim()];
  if (start) args.push('--start', start);
  if (b.build !== undefined && String(b.build).trim()) args.push('--build', String(b.build).trim());
  if (port) args.push('--port', port);
  if (b.safe) args.push('--safe');
  if (b.health !== undefined && String(b.health).trim()) args.push('--health', String(b.health).trim());
  if (b.docker) args.push('--docker');

  // spawnSync (not the fire-and-forget job path): init is a local, bounded
  // operation — it writes a bare repo, a hook and one registry row. The owner
  // is watching the form, so the answer must arrive in the same breath, and
  // the output IS the receipt shown on screen.
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 120000, env: process.env });
  const log = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.error) throw Object.assign(new Error(`could not run gitlive init: ${r.error.message}`), { code: 'INTERNAL', details: { log } });
  if (r.status !== 0) {
    const lastLine = log.split('\n').filter(Boolean).pop() || `gitlive init exited ${r.status}`;
    throw Object.assign(new Error(lastLine), { code: 'INIT_FAILED', details: { log, dir, argv: args.slice(2).join(' ') } });
  }
  const reg = gitlive.loadRegistry();
  const app = reg[name] || null;
  try { require('../crypt.js').logEvent('app-created', { app: name, dir, mode: app && app.safe ? 'safe' : (app && app.docker) || 'plain' }); } catch { /* audit best-effort */ }
  return {
    ok: true,
    name,
    dir,
    mode: app && app.safe ? 'safe (blue-green)' : (app && app.docker) || 'plain',
    safe: Boolean(app && app.safe),
    port: app && app.port ? app.port : null,
    gatewayUrl: app && app.safe && app.port ? `http://127.0.0.1:${app.port}` : null,
    log,
    next: [`git push ${name} main`],
    // the browser has no terminal, so the copy-paste line is generated here
    // from the folder that was actually registered — never a guess
    pushHint: `cd ${JSON.stringify(dir)} && git add -A && git commit -m "first push" && git push ${name} main`,
    registered: Boolean(app),
  };
}
function sh(cmd, args, opts = {}) {
  // stdio 'ignore' on purpose: piped stdio makes execFileSync wait for EOF
  // on the pipes, and a deploy hook's detached app/proxy can hold them open
  // forever — the server's event loop freezes and the dashboard hangs
  // (field finding: the sandbox flow wedged the control plane exactly this
  // way). Server-side calls never need the captured output.
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'ignore', ...opts });
}
// fire-and-forget for long jobs (backups, entry) — never blocks the plane.
// Every spawn writes a ledger line (started) and a wrapper watches the child
// so the dashboard can show "running… / done ✓ / failed" instead of silence.
function jobsFile() { return path.join(os.homedir(), '.gitlive', 'jobs.jsonl'); }
function jobsTail() {
  try {
    const f = jobsFile();
    if (!fs.existsSync(f)) return { jobs: [] };
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    const byId = new Map();
    for (const l of lines) {
      let r = null;
      try { r = JSON.parse(l); } catch { /* skip malformed */ }
      if (!r || !r.id) continue;
      const cur = byId.get(r.id) || {};
      Object.assign(cur, r);
      byId.set(r.id, cur);
    }
    return { jobs: [...byId.values()].slice(-12).reverse() };
  } catch {
    return { jobs: [] };
  }
}
function spawnDetached(cmd, args, kind, label) {
  const id = crypto.randomBytes(5).toString('hex');
  const entry = { id, kind: kind || 'job', label: label || (args[args.length - 1] || 'job'), startedAt: new Date().toISOString(), endedAt: null, ok: null };
  try {
    fs.mkdirSync(path.dirname(jobsFile()), { recursive: true });
    fs.appendFileSync(jobsFile(), JSON.stringify(entry) + '\n');
  } catch { /* the ledger must never block the job */ }
  const wrapper = `
    const {spawn} = require('node:child_process');
    const fs = require('node:fs');
    const spec = JSON.parse(process.argv[1]);
    const child = spawn(spec[0], spec[1], {stdio:'ignore', detached:true});
    child.on('exit', (code) => {
      try {
        fs.appendFileSync(${JSON.stringify(jobsFile())}, JSON.stringify({id:${JSON.stringify(id)}, endedAt:new Date().toISOString(), ok: code === 0}) + '\\n');
      } catch { /* ledger best-effort */ }
      process.exit(0);
    });
  `;
  const w = require('node:child_process').spawn('node', ['-e', wrapper, JSON.stringify([cmd, args])], { detached: true, stdio: 'ignore', env: process.env });
  w.unref();
  return id;
}
// backup facts per app from its own receipt file — nothing is invented
function backupsOverview() {
  const reg = gitlive.loadRegistry();
  const apps = [];
  // the plane's own state is machinery: it belongs in this list, and its
  // receipt says out loud which secrets were deliberately excluded
  try {
    const f = path.join(os.homedir(), '.gitlive', 'control', 'backup-history.jsonl');
    if (fs.existsSync(f)) {
      const recs = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const latest = recs[recs.length - 1] || null;
      apps.push({ name: 'control-plane', snapshots: recs.length, latest, verified: recs.some((r) => r.outcome === 'verified' || r.verified === true), state: true });
    }
  } catch { /* state receipts optional */ }
  for (const [name, app] of Object.entries(reg)) {
    if (!app.runPath) continue;
    const f = path.join(app.runPath, 'backup-history.jsonl');
    if (!fs.existsSync(f)) { apps.push({ name, snapshots: 0, latest: null, verified: false }); continue; }
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const latest = recs[recs.length - 1] || null;
    const verified = recs.some((r) => r.outcome === 'verified' || r.verified === true);
    apps.push({ name, snapshots: recs.length, latest, verified });
  }
  return { apps };
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

// A plane bound to anything other than loopback carries session tokens in
// cleartext over the network. gitlive ships no TLS terminator of its own for
// the control plane, so binding wide is allowed ONLY with an explicit opt-in
// and a loud, honest warning on every boot (the operator may have a reverse
// proxy doing TLS; we cannot know, so we say what we know).
function nonLoopbackWarning(host) {
  const loopback = !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (loopback) return null;
  if (process.env.GITLIVE_ALLOW_NON_LOOPBACK === '1') {
    return `control plane bound to ${host} (GITLIVE_ALLOW_NON_LOOPBACK=1) — your session token crosses the network in cleartext unless something in front of this terminates TLS`;
  }
  return `refusing to bind ${host}: the control plane speaks plain HTTP, so sessions and keys would cross the network in the clear. `
    + `Put a TLS reverse proxy in front and set GITLIVE_ALLOW_NON_LOOPBACK=1, or keep it on 127.0.0.1.`;
}

// serve.log has no rotation (the boot agent appends forever). Trim it at
// startup — a machine that runs for months must not fill its disk with logs.
function rotateServeLog() {
  try {
    const f = path.join(os.homedir(), '.gitlive', 'control', 'serve.log');
    if (!fs.existsSync(f)) return;
    const max = Number(process.env.GITLIVE_SERVE_LOG_MAX_MB || 5) * 1024 * 1024;
    if (fs.statSync(f).size > max) {
      const buf = fs.readFileSync(f);
      fs.writeFileSync(f, buf.slice(Math.floor(buf.length / 2)));
    }
  } catch { /* rotation must never block a boot */ }
}

// ── automatic maintenance: backups that need a human are backups that stop ──
// The plane already has a ticker (scheduled tasks). This is the machine's OWN
// cadence: a state snapshot every 24h and a restic check every 7 days, both
// receipted the same way a manual run is. Off by default in tests, on by
// default on a real plane (GITLIVE_MAINTENANCE=0 disables it).
const MAINT_STATE_HOURS = Number(process.env.GITLIVE_MAINT_STATE_HOURS || 24);
const MAINT_CHECK_HOURS = Number(process.env.GITLIVE_MAINT_CHECK_HOURS || 24 * 7);
function lastReceiptAt(file) {
  try {
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const last = JSON.parse(rows[rows.length - 1]);
    return last.at ? new Date(last.at).getTime() : 0;
  } catch { return 0; }
}
function maintenanceDue() {
  const stateHist = path.join(os.homedir(), '.gitlive', 'control', 'backup-history.jsonl');
  const checkStamp = path.join(os.homedir(), '.gitlive', 'control', 'last-check.json');
  const now = Date.now();
  const stateDue = now - lastReceiptAt(stateHist) > MAINT_STATE_HOURS * 3600 * 1000;
  let checkDue = true;
  try { checkDue = now - new Date(JSON.parse(fs.readFileSync(checkStamp, 'utf8')).at).getTime() > MAINT_CHECK_HOURS * 3600 * 1000; } catch { /* never checked */ }
  return { stateDue, checkDue, checkStamp };
}
function runMaintenance() {
  if (String(process.env.GITLIVE_MAINTENANCE || '1') === '0') return;
  try {
    const gitliveJs = path.join(__dirname, '..', 'gitlive.js');
    const { stateDue, checkDue, checkStamp } = maintenanceDue();
    if (stateDue) spawnDetached('node', [gitliveJs, 'backup', 'state'], 'backup', 'maintenance: control-plane state');
    if (checkDue) {
      spawnDetached('node', [gitliveJs, 'backup', 'check'], 'check', 'maintenance: restic check');
      try { fs.writeFileSync(checkStamp, JSON.stringify({ at: new Date().toISOString(), by: 'maintenance' })); } catch { /* best effort */ }
    }
    if (stateDue || checkDue) accessLog(`${new Date().toISOString()} maintenance ${stateDue ? 'state-snapshot ' : ''}${checkDue ? 'restic-check' : ''}`.trim());
  } catch { /* maintenance must never break the plane */ }
}

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
    // identity + timing for every request; the id travels back in a header
    // so a failure the owner reports can be found in the access log
    const rid = newRequestId();
    const t0 = Date.now();
    const reqPath = String(req.url || '').split('?')[0];
    try { res.setHeader('x-request-id', rid); } catch { /* headers sent */ }
    try {
      // the dashboard is a single same-origin document with inline scripts and
      // styles: no third-party anything, no framing, no referrer, no ambient
      // permissions. `frame-ancestors 'none'` also kills clickjacking.
      res.setHeader('content-security-policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join('; '));
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('cross-origin-opener-policy', 'same-origin');
      res.setHeader('cross-origin-resource-policy', 'same-origin');
      res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    } catch { /* headers already sent — the request is still served */ }
    res.on('finish', () => {
      accessLog(`${new Date().toISOString()} ${rid} ${req.method} ${reqPath} → ${res.statusCode} ${Date.now() - t0}ms`);
    });
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
        // REPLAY GUARD: a valid signature only proves GitHub sent this body
        // ONCE — anyone who captured the request could send it again and
        // redeploy on demand. GitHub's delivery id is unique per event, so a
        // seen id is refused; a bounded ledger keeps this cheap and honest.
        const delivery = String(req.headers['x-github-delivery'] || '');
        if (delivery && replaySeen(delivery)) {
          try { require('../crypt.js').logEvent('github-hook-replay', { app: appName, delivery }); } catch { /* noop */ }
          return fail(res, 409, 'CONFLICT', 'this delivery was already processed — replays are refused (delivery ' + delivery.slice(0, 12) + ')');
        }
        let payload = null;
        try { payload = JSON.parse(raw.toString('utf8')); } catch { return fail(res, 400, 'INVALID_ARGS', 'invalid JSON payload'); }
        const commit = payload && payload.head_commit && payload.head_commit.id;
        const ref = payload && payload.ref;
        if (!commit || ref !== 'refs/heads/main') return fail(res, 400, 'INVALID_ARGS', 'only pushes to main deploy (the webhook should fire on the push event)');
        try { return ok(res, await githubHookDeploy(appName, commit)); }
        catch (err) { return fail(res, err.code === 'NOT_FOUND' ? 404 : 500, err.code || 'INTERNAL', err.message || String(err)); }
      }

      // ── liveness, UNAUTHENTICATED on purpose ───────────────────────────
      // supervision (the boot agent, an external watcher, a phone) needs to
      // know the plane is alive without holding a session. It answers with
      // status only — no node handle, no keys, no app names.
      if (reqPath === '/health' && req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ ok: true, version: gitlive.VERSION, uptime: Math.round(process.uptime()) }));
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
      // NOTE: this alternation is the route table for app actions — a segment
      // missing here is a button that 404s. tests/contract.test.js now derives
      // the segments from every dashboard api.call (including paths built by
      // string concatenation), so a mismatch fails the battery instead of the
      // owner discovering a dead button.
      const appsMatch = p.match(/^\/api\/apps\/([^/]+)\/(logs|stop|deploy|rollback|restart|replicas|conflicts|diagnose|secrets|env|stats|schedule|rm|restore|graduate|reliability)$/);
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
      if (p === '/api/doctor' && req.method === 'GET') {
        // the dashboard's self-checkup: the same facts the CLI's `doctor`
        // proves, plus the live machine checks the cockpit needs — rendered
        // as a fixable list, never a wall of text.
        try { return ok(res, await doctorOverview()); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
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
      if (p === '/api/entry/action' && req.method === 'POST') {
        // entry serve / connect / disconnect / stop — the SAME CLI the
        // owner's terminal runs, spawned by the plane (the CLI detaches its
        // long-lived server/client and returns immediately).
        try {
          const body = await readBody(req);
          const action = String(body && body.action || '');
          const gitliveJs = path.join(__dirname, '..', 'gitlive.js');
          const args = [gitliveJs, 'entry'];
          if (action === 'serve') {
            args.push('serve');
            if (body.port) args.push('--port', String(body.port));
          } else if (action === 'connect') {
            if (!body.url || !body.token) return fail(res, 400, 'INVALID_ARGS', 'connect needs url and token');
            args.push('connect', String(body.url), '--token', String(body.token));
          } else if (action === 'disconnect') {
            args.push('disconnect');
          } else if (action === 'stop') {
            args.push('stop');
          } else {
            return fail(res, 400, 'INVALID_ARGS', 'action must be serve | connect | disconnect | stop');
          }
          sh('node', args, { env: process.env });
          await new Promise((r) => setTimeout(r, 600));
          return ok(res, entryStatus());
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/entry/cert' && req.method === 'POST') {
        // https for a name on THIS machine — same validation as the CLI's
        // entry cert, never a second implementation
        try {
          const body = await readBody(req);
          const domain = String(body && body.domain || '').toLowerCase();
          if (!domain || !body.cert || !body.key) return fail(res, 400, 'INVALID_ARGS', 'cert needs domain + cert file path + key file path');
          const installed = gitlive.installPublicCert(domain, String(body.cert), String(body.key));
          return ok(res, { ok: true, domain, ...installed });
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/peers/announce' && req.method === 'POST') {
        // announce this machine to a peer, from the cockpit
        try {
          const body = await readBody(req);
          const peerUrl = String(body && body.url || '');
          const myUrl = String(body && body.myUrl || peerUrl);
          if (!peerUrl) return fail(res, 400, 'INVALID_ARGS', 'the peer url is required — the machine you want to see you');
          const peer = require('../peer.js');
          const meta = nodeIdentity();
          const r = await peer.peerAnnounce(peerUrl, { name: (meta && meta.handle) || 'self', endpoints: [myUrl] });
          return ok(res, { ok: true, announced: peerUrl, received: r });
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/backups' && req.method === 'GET') {
        try { return ok(res, backupsOverview()); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/agents' && req.method === 'GET') {
        try { return ok(res, require('./agents.js').status()); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/agents/run' && req.method === 'POST') {
        // run one pass on demand — the same pass the ticker runs
        try {
          const body = await readBody(req);
          const agents = require('./agents.js');
          const which = String(body && body.agent || 'all');
          let result = null;
          if (which === 'improve') result = agents.improvePass(agentCaps || {});
          else if (which === 'repair') result = { actions: agents.repairPass(agentCaps || {}) };
          else if (which === 'diagnose') result = { actions: await agents.diagnosePass(agentCaps || {}) };
          else result = await agents.tick(agentCaps || {});
          return ok(res, { ran: which, result, status: agents.status() });
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/jobs' && req.method === 'GET') {
        try { return ok(res, jobsTail()); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/support' && req.method === 'GET') {
        // one-click support bundle: every fact a helper would ask for, in one
        // copy — machine state, never secrets (no tokens, no key material).
        //
        // IDENTIFIERS ARE MASKED BY DEFAULT (v4.0.1): this artifact exists to
        // be handed to somebody else, and the unmasked version used to carry
        // the owner's home path, a private project folder name, the machine's
        // public IPv6 and every app name. `?full=1` returns the unmasked one
        // for the owner's own use, and the bundle says which it is.
        const full = new URL(req.url, 'http://x').searchParams.get('full') === '1';
        try {
          const bundle = {
            checkedAt: new Date().toISOString(),
            version: gitlive.VERSION,
            doctor: doctorOverview().rows,
            apps: gitlive.listAppsData(),
            jobs: jobsTail().jobs.slice(0, 8),
            events: eventsTail().entries.slice(-20),
            backups: backupsOverview(),
            boot: (() => {
              try { const p2 = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.gitlive.control.plist'); return { installed: fs.existsSync(p2) }; }
              catch { return { installed: null }; }
            })(),
            zones: (() => { try { const z = gitlive.loadZones(); return Object.keys(z).map((k) => ({ domain: k, hasToken: Boolean(z[k] && z[k].dnsToken) })); } catch { return []; } })(),
            ipv6: (() => { try { return gitlive.publicIpv6(); } catch { return null; } })(),
          };
          if (full) return ok(res, { ...bundle, redacted: false, note: 'unmasked — contains paths, addresses and names; do not post this publicly' });
          const redact = require('./redact.js');
          const names = knownAppNames();
          const domains = (() => { try { return Object.keys(gitlive.loadZones()); } catch { return []; } })();
          return ok(res, {
            ...redact.shareableDeep(bundle, { names, maskDomains: domains, home: os.homedir() }),
            redacted: true,
            note: 'identifiers masked (paths → ~, addresses → <address>, names → app-N) so this can be shared safely; the full version is one request away and is for your own eyes only',
          });
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/self/version' && req.method === 'GET') {
        // the update flow's front door: installed vs registry + the changes
        try {
          const latest = await npmLatestVersion();
          let changelog = '';
          try {
            changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8').slice(0, 1600);
          } catch { /* changelog optional */ }
          return ok(res, { installed: gitlive.VERSION, latest, newer: Boolean(latest && semverGt(latest, gitlive.VERSION)), changelog, offline: !outboundAllowed() });
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/self/update' && req.method === 'POST') {
        // the full update: refuse without a backup; refuse without a newer
        // version; then npm-install + restart the plane (the boot agent
        // revives it; the fallback restart covers machines without one).
        try {
          const latest = await npmLatestVersion();
          if (!latest || !semverGt(latest, gitlive.VERSION)) {
            return fail(res, 409, 'CONFLICT', 'nothing newer to update to — npm has ' + (latest || 'no answer') + ', this node runs ' + gitlive.VERSION);
          }
          const bu = backupsOverview();
          const withSnap = bu.apps.filter((a) => a.snapshots > 0).length;
          if (!withSnap) {
            return fail(res, 409, 'CONFLICT', 'back up first — the update refuses to run without at least one snapshot (operations → back up everything now)');
          }
          const bin = path.join(os.homedir(), '.gitlive-app', 'bin', 'gitlive');
          const script = `npm install -g --prefix ~/.gitlive-app gitlive@${latest} --force && sleep 1 && (lsof -ti tcp:5180 | xargs kill 2>/dev/null || true) && sleep 1 && (nohup ${bin} serve --no-open >> ~/.gitlive/control/serve.log 2>&1 &) && echo updated`;
          const id = spawnDetached('/bin/bash', ['-c', script], 'update', 'update to ' + latest);
          return ok(res, { started: true, to: latest, job: id, note: 'the plane restarts with the new version in a few seconds — the dashboard blinks once, then reload it' });
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/backup/init' && req.method === 'POST') {
        // initialize the encrypted backup repo (restic + a generated key).
        // The key file IS the backup key — the response says so out loud.
        try {
          const gitliveJs = path.join(__dirname, '..', 'gitlive.js');
          const out = sh('node', [gitliveJs, 'backup', 'init'], { env: process.env });
          const repo = path.join(os.homedir(), '.gitlive', 'backup-repo');
          const key = path.join(os.homedir(), '.gitlive', 'backup.key');
          return ok(res, {
            initialized: fs.existsSync(path.join(repo, 'config')),
            repo, key,
            note: 'the password file IS the backup key — copy it offsite with the repo, or the backups are unrecoverable',
            output: String(out || '').slice(-400),
          });
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/backup' && req.method === 'POST') {
        // backup run / verify / check — spawned detached (restic can take
        // minutes); receipts + the list above show the real progress.
        try {
          const body = await readBody(req);
          const action = String(body && body.action || 'run');
          const gitliveJs = path.join(__dirname, '..', 'gitlive.js');
          const reg = gitlive.loadRegistry();
          const names = Object.keys(reg);
          if (action === 'run') {
            if (!names.length) return fail(res, 400, 'INVALID_ARGS', 'no apps registered — nothing to back up');
            const targets = body.app ? names.filter((n) => n === String(body.app)) : names;
            if (!targets.length) return fail(res, 404, 'NOT_FOUND', 'No app named "' + body.app + '"');
            for (const n of targets) spawnDetached('node', [gitliveJs, 'backup', n], 'backup', 'backup ' + n);
            // the machine's own memory rides the same switch (secrets excluded
            // by design — see cmdBackupState's exclude list)
            if (!body.app) spawnDetached('node', [gitliveJs, 'backup', 'state'], 'backup', 'backup control-plane state');
            return ok(res, { started: true, apps: targets.length, note: 'snapshots are running (apps + control-plane state) — receipts appear in the backups list' });
          }
          if (action === 'verify') {
            if (!body.app) return fail(res, 400, 'INVALID_ARGS', 'verify needs the app name');
            spawnDetached('node', [gitliveJs, 'backup', 'verify', String(body.app)], 'drill', 'drill ' + String(body.app));
            return ok(res, { started: true, app: body.app, note: 'restore drill running — restores the newest snapshot to a throwaway dir and compares every file' });
          }
          if (action === 'check') {
            spawnDetached('node', [gitliveJs, 'backup', 'check'], 'check', 'restic check');
            return ok(res, { started: true, note: 'restic check running — a backup that cannot be verified is a wish' });
          }
          return fail(res, 400, 'INVALID_ARGS', 'action must be run | verify | check');
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/boot' && req.method === 'GET') {
        try {
          const { execFileSync } = require('node:child_process');
          const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.gitlive.control.plist');
          let loaded = false;
          try { execFileSync('launchctl', ['print', 'gui/' + String(process.getuid ? process.getuid() : '').replace(/^gui\//, ''), 'dev.gitlive.control'], { stdio: 'ignore', timeout: 3000 }); loaded = true; } catch { /* not loaded */ }
          return ok(res, { installed: fs.existsSync(plist), loaded, path: plist });
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/boot' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          const action = String(body && body.action || '');
          if (action !== 'install' && action !== 'remove') return fail(res, 400, 'INVALID_ARGS', 'action must be install | remove');
          const gitliveJs = path.join(__dirname, '..', 'gitlive.js');
          sh('node', [gitliveJs, 'boot', action], { env: process.env });
          const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.gitlive.control.plist');
          return ok(res, { installed: fs.existsSync(plist), action });
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
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
      if (p === '/api/domains/cert' && req.method === 'POST') {
        // wildcard ACME for a zone (DNS-01 through the zone's stored token —
        // works behind NAT). Long-running on purpose: the button waits.
        try {
          const body = await readBody(req);
          const zone = String(body && body.zone || '').toLowerCase();
          const staging = Boolean(body && body.staging);
          if (!zone) return fail(res, 400, 'INVALID_ARGS', 'zone is required');
          const zones = gitlive.loadZones();
          const z = zones[zone];
          if (!z) return fail(res, 404, 'NOT_FOUND', 'zone "' + zone + '" is not registered — add it in Settings → naming');
          const token = z.dnsToken || '';
          if (!token) return fail(res, 400, 'INVALID_ARGS', 'zone "' + zone + '" has no DNS token — paste its deSEC token in Settings → naming first');
          const r = await gitlive.issueCertFor('*.' + zone, { zone, token, staging });
          return ok(res, r);
        } catch (err) {
          // a failed certificate request is an audit fact, not just a toast
          try { require('../crypt.js').logEvent('cert-failed', { zone, reason: String(err.message || err).slice(0, 200) }); } catch { /* audit best-effort */ }
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
      }
      if (p === '/api/domains/dns-history' && req.method === 'GET') {
        try { return ok(res, dnsHistoryData()); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/certs' && req.method === 'GET') {
        // certificate visibility: every cert gitlive holds, with days-left —
        // expiry must never be a browser-warning surprise (CapRover pattern)
        try { return ok(res, certsOverview()); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
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
      if (p === '/api/keys/action' && req.method === 'POST') {
        // key material actions. Duress wrapping stays terminal-only: it needs a
        // passphrase, and a passphrase typed into a browser is one more place a
        // secret can leak — the CLI is the honest home for that one.
        try {
          const body = await readBody(req);
          const action = String(body && body.action || '');
          const gitliveJs = path.join(__dirname, '..', 'gitlive.js');
          const args = [gitliveJs, 'crypt'];
          if (action === 'keygen') args.push('keygen');
          else if (action === 'rotate') args.push('rotate');
          else if (action === 'deadman-arm') args.push('deadman', 'arm', '--hours', String(Number(body.hours) || 72));
          else if (action === 'deadman-disarm') args.push('deadman', 'disarm');
          else return fail(res, 400, 'INVALID_ARGS', 'action must be keygen | rotate | deadman-arm | deadman-disarm (duress wrapping stays terminal-only: it takes a passphrase)');
          const out = sh('node', args, { env: process.env });
          try { require('../crypt.js').logEvent('keys', { action }); } catch { /* best effort */ }
          return ok(res, { action, output: String(out || '').slice(-300) });
        } catch (err) {
          return fail(res, 500, 'INTERNAL', err.message || String(err));
        }
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
          const code = err.code || 'NOT_FOUND';
          return fail(res, code === 'INVALID_ARGS' ? 400 : 404, code, err.message || String(err));
        }
      };

      if (appsMatch && req.method === 'GET' && appsMatch[2] === 'diagnose') {
        // the app troubleshoot chain: why is it down / why no public traffic —
        // one hop per row, one honest fix per hop (the cockpit's question-first rule)
        return runAction(async (n) => appDiagnose(n));
      }
      if (appsMatch && req.method === 'PUT' && appsMatch[2] === 'env') {
        // the env manager: set/delete keys in the app's secrets file.
        // VALUES ARE WRITTEN, NEVER RETURNED — GET only reports key names
        // and masked lengths; nothing here ever logs a value.
        return runAction(async (n) => {
          const app = gitlive.loadRegistry()[n];
          if (!app) throw new Error('No app named "' + n + '"');
          const f = gitlive.secretsPath(n);
          const body = await readBody(req);
          if (body && body.apply === true) {
            // the owner pressed "restart to apply" — clear the pending marker
            if (app.envChangedAt) { delete app.envChangedAt; gitlive.saveRegistry(gitlive.loadRegistry()); }
            return { applied: true };
          }
          const set = (body && body.set && typeof body.set === 'object') ? body.set : {};
          const del = Array.isArray(body && body.del) ? body.del : [];
          const existing = fs.existsSync(f)
            ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
            : [];
          const map = new Map();
          for (const l of existing) {
            const eq = l.indexOf('=');
            if (eq < 0) continue;
            let k = l.slice(0, eq).trim().replace(/^export\s+/, '');
            if (!k) continue;
            map.set(k, l.slice(eq + 1).trim());
          }
          for (const k of del) map.delete(String(k));
          for (const [k, v] of Object.entries(set)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(k))) {
              const e = new Error('key names must match [A-Za-z_][A-Za-z0-9_]* — got "' + k + '"');
              e.code = 'INVALID_ARGS';
              throw e;
            }
            map.set(String(k), String(v));
          }
          const lines = [...map.entries()].map(([k, v]) => `${k}=${v.includes('#') || /["'\s]/.test(v) ? JSON.stringify(v) : v}`);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, lines.join('\n') + '\n', { mode: 0o600 });
          const reg = gitlive.loadRegistry();
          if (reg[n]) { reg[n].envChangedAt = new Date().toISOString(); gitlive.saveRegistry(reg); }
          return { changed: true, keys: map.size, pendingRestart: true, note: 'saved — restart the app to apply' };
        });
      }
      if (appsMatch && req.method === 'POST' && appsMatch[2] === 'rm') {
        // deleting an app is irreversible: the caller must echo the app's own
        // name, and the response states exactly what was destroyed
        return runAction(async (n) => {
          const body = await readBody(req);
          if (!body || String(body.confirm || '') !== n) {
            const e = new Error('refusing to delete without the app name typed back (confirm: "' + n + '")');
            e.code = 'INVALID_ARGS';
            throw e;
          }
          const gitliveJs = path.join(__dirname, '..', 'gitlive.js');
          const out = sh('node', [gitliveJs, 'rm', n, '--yes'], { env: process.env });
          try { require('../crypt.js').logEvent('app-removed', { app: n }); } catch { /* audit best-effort */ }
          return { removed: true, app: n, note: 'bare repo, run dir and secrets file deleted; registry entry gone', output: String(out || '').slice(-300) };
        });
      }
      if (appsMatch && req.method === 'POST' && appsMatch[2] === 'restore') {
        // restore a snapshot to a directory the owner names — the CLI refuses
        // to write into live data, and so do we (no default target)
        return runAction(async (n) => {
          const body = await readBody(req);
          const to = body && body.to ? String(body.to) : '';
          if (!to) {
            const e = new Error('a target directory is required — a restore never writes into the live app');
            e.code = 'INVALID_ARGS';
            throw e;
          }
          const gitliveJs = path.join(__dirname, '..', 'gitlive.js');
          const args = [gitliveJs, 'backup', 'restore', n, '--to', to];
          if (body.snapshot) args.push('--snapshot', String(body.snapshot));
          const out = sh('node', args, { env: process.env });
          return { restored: true, app: n, to, output: String(out || '').slice(-400) };
        });
      }
      if (appsMatch && req.method === 'GET' && appsMatch[2] === 'secrets') {
        // key NAMES only — values never leave the file or cross the wire
        return runAction(async (n) => {
          const app = gitlive.loadRegistry()[n];
          if (!app) throw new Error('No app named "' + n + '"');
          const f = gitlive.secretsPath(n);
          let keys = [], exists = fs.existsSync(f);
          if (exists) {
            keys = fs.readFileSync(f, 'utf8').split('\n')
              .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
              .map((l) => l.split('=')[0].trim().replace(/^export\s+/, ''))
              .filter(Boolean);
          }
          return { path: f, exists, keys, count: keys.length, note: 'values never shown — edit the file, then restart the app', pendingRestart: Boolean(app.envChangedAt) };
        });
      }
      // ── v4 intelligence: measure, remember, explain ────────────────────
      if (p === '/api/intel' && req.method === 'GET') {
        try { return ok(res, intel.intelOverview(intelFacts())); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/timeline' && req.method === 'GET') {
        // the merged story, filterable — app names only ever travel to the
        // caller that asked; the machine area asks without an app filter
        const q = new URL(req.url, 'http://x').searchParams;
        const app = q.get('app') || null;
        const days = Number(q.get('days') || 7);
        const kinds = q.get('kinds') ? String(q.get('kinds')).split(',').filter(Boolean) : null;
        try { return ok(res, { entries: intel.timelineFor({ app, sinceMs: Math.max(1, days) * 86400000, limit: Number(q.get('limit') || 200), kinds }) }); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/digest' && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const days = Number(q.get('days') || 7);
        const full = q.get('full') === '1';
        try {
          const d = intel.digestData({ days: Math.min(90, Math.max(1, days)) });
          if (full) return ok(res, { ...d, redacted: false });
          const redact = require('./redact.js');
          return ok(res, {
            ...d,
            markdown: redact.shareable(d.markdown, { names: knownAppNames(), home: os.homedir(), maskDomains: (() => { try { return Object.keys(gitlive.loadZones()); } catch { return []; } })() }),
            redacted: true,
            note: 'identifiers masked so this can be posted anywhere; gitlive report --no-redact prints the full one for your own eyes',
          });
        } catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/policies' && req.method === 'GET') {
        try { return ok(res, { policies: intel.loadPolicies(), agentState: intel.loadAgentState(), modes: intel.POLICY_MODES, backoffMs: intel.BACKOFF_MS }); }
        catch (err) { return fail(res, 500, 'INTERNAL', err.message || String(err)); }
      }
      if (p === '/api/policies' && req.method === 'PUT') {
        try {
          const body = await readBody(req);
          const current = intel.loadPolicies();
          const next = { default: { ...current.default }, apps: { ...current.apps } };
          if (body && body.default && typeof body.default === 'object') next.default = { ...next.default, ...body.default };
          if (body && body.app && typeof body.app === 'object') {
            const name = String(body.app.name || '');
            if (!name) return fail(res, 400, 'INVALID_ARGS', 'app name is required');
            if (!gitlive.loadRegistry()[name]) return fail(res, 404, 'NOT_FOUND', `No app named "${name}"`);
            if (body.app.remove) delete next.apps[name];
            else next.apps[name] = { ...(next.apps[name] || {}), ...body.app.policy };
            // validate before writing: a policy that cannot be honoured is
            // worse than no policy
            const merged = intel.policyFor(name, next);
            if (!intel.POLICY_MODES.includes(merged.mode)) return fail(res, 400, 'INVALID_ARGS', `mode must be one of ${intel.POLICY_MODES.join(', ')}`);
            for (const w of merged.maintenance) {
              if (!/^\d{2}:\d{2}$/.test(String(w.from || '')) || !/^\d{2}:\d{2}$/.test(String(w.to || ''))) {
                return fail(res, 400, 'INVALID_ARGS', 'maintenance windows need from/to as HH:MM');
              }
            }
          }
          const saved = intel.savePolicies(next);
          try { require('../crypt.js').logEvent('policy', { app: (body && body.app && body.app.name) || null, detail: 'updated' }); } catch { /* audit best-effort */ }
          return ok(res, { policies: saved });
        } catch (err) { return fail(res, 400, 'INVALID_ARGS', err.message || String(err)); }
      }

      // ── create an app from the dashboard (the last terminal-only step) ──
      if (p === '/api/browse' && req.method === 'GET') {
        // read-only folder listing so the create form can offer a picker
        // instead of asking the owner to type an absolute path from memory
        try { return ok(res, browseData(new URL(req.url, 'http://x').searchParams.get('path') || '')); }
        catch (err) { return fail(res, err.code === 'INVALID_ARGS' ? 400 : 500, err.code || 'INTERNAL', err.message); }
      }
      if (p === '/api/apps' && req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (err) { return fail(res, 400, 'INVALID_ARGS', err.message); }
        try {
          return ok(res, createAppData(body));
        } catch (err) {
          const status = err.code === 'INVALID_ARGS' ? 400 : err.code === 'CONFLICT' ? 409 : 500;
          return fail(res, status, err.code || 'INTERNAL', err.message, err.details);
        }
      }
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
          st.envChangedAt = (gitlive.loadRegistry()[n] || {}).envChangedAt || null;
          st.schedule = (gitlive.loadRegistry()[n] || {}).schedule || null;
          return st;
        });
      }
      if (appsMatch && req.method === 'GET' && appsMatch[2] === 'logs') {
        return runAction((n) => localExecutor.getLogs(n));
      }
      if (appsMatch && req.method === 'POST' && appsMatch[2] === 'logs') {
        // clear the deploy log OR set its retention cap (disk-full protection)
        return runAction(async (n) => {
          const app = gitlive.loadRegistry()[n];
          if (!app) throw new Error('No app named "' + n + '"');
          const body = await readBody(req);
          if (body && body.logMaxMb !== undefined) {
            const cap = Math.max(0, Number(body.logMaxMb) || 0);
            app.logMaxMb = cap || undefined;
            gitlive.saveRegistry(gitlive.loadRegistry());
            return { capSet: cap || null, note: cap ? 'log capped at ' + cap + ' MB — the oldest half is dropped when it grows past that' : 'cap off — the log grows without limit' };
          }
          const f = path.join(app.runPath, 'deploy.log');
          if (fs.existsSync(f)) fs.writeFileSync(f, '');
          return { cleared: true, note: 'deploy log emptied — the next push writes fresh lines' };
        });
      }
      if (appsMatch && (req.method === 'PUT' || req.method === 'DELETE') && appsMatch[2] === 'schedule') {
        // scheduled tasks: a cron string + one command, run by the plane's
        // own ticker (seconds field optional for tests; 5 fields = classic)
        return runAction(async (n) => {
          const reg = gitlive.loadRegistry();
          const app = reg[n];
          if (!app) throw new Error('No app named "' + n + '"');
          if (req.method === 'DELETE') {
            delete app.schedule;
            gitlive.saveRegistry(reg);
            return { removed: true };
          }
          const body = await readBody(req);
          const cron = String(body && body.cron || '').trim();
          const cmd = String(body && body.cmd || '').trim();
          if (!cron || !cmd) {
            const e = new Error('schedule needs a cron string and a command');
            e.code = 'INVALID_ARGS';
            throw e;
          }
          const parts = cron.split(/\s+/);
          if ((parts.length !== 5 && parts.length !== 6) || !/^[\d*/,\-\s]+$/.test(cron)) {
            const e = new Error('cron must be 5 fields (minute hour day month weekday) — an optional 6th seconds field is allowed');
            e.code = 'INVALID_ARGS';
            throw e;
          }
          app.schedule = { cron, cmd, enabled: body.enabled !== false, setAt: new Date().toISOString() };
          gitlive.saveRegistry(reg);
          return { ok: true, schedule: app.schedule };
        });
      }
      if (appsMatch && req.method === 'GET' && appsMatch[2] === 'reliability') {
        // the app's own measured record: uptime over covered time, every
        // outage, MTBF/MTTR, and its recent timeline — the same numbers the
        // intelligence section shows, scoped to one app
        return runAction(async (n) => {
          const rel = intel.reliabilityFor(n);
          const policy = intel.policyFor(n);
          return {
            ...rel,
            policy,
            backoff: intel.backoffFor(n),
            maintenanceNow: intel.inMaintenance(policy) || null,
            timeline: intel.timelineFor({ app: n, limit: 40, sinceMs: 14 * 86400000 }),
          };
        });
      }
      if (appsMatch && req.method === 'GET' && appsMatch[2] === 'stats') {
        // honest resource visibility: RSS + uptime from the pid, data/log
        // sizes from the disk — no agents, no invented numbers
        return runAction(async (n) => {
          const app = gitlive.loadRegistry()[n];
          if (!app) throw new Error('No app named "' + n + '"');
          const out = { pid: null, rssMb: null, uptime: null, dataBytes: null, logBytes: null, diskFreeMb: null };
          const pidFile = app.safe ? path.join(app.runPath, 'proxy.pid') : path.join(app.runPath, 'app.pid');
          try {
            const pid = fs.readFileSync(pidFile, 'utf8').trim();
            out.pid = Number(pid) || null;
          } catch { /* not running */ }
          if (out.pid) {
            try {
              const { execFileSync } = require('node:child_process');
              const rss = execFileSync('ps', ['-o', 'rss=', '-p', String(out.pid)], { encoding: 'utf8', timeout: 2000 }).trim();
              if (rss) out.rssMb = Math.round(Number(rss) / 1024);
              const etime = execFileSync('ps', ['-o', 'etime=', '-p', String(out.pid)], { encoding: 'utf8', timeout: 2000 }).trim();
              if (etime) out.uptime = etime;
            } catch { /* honest nulls */ }
          }
          try {
            const { execFileSync } = require('node:child_process');
            if (app.runPath && fs.existsSync(path.join(app.runPath, 'data'))) {
              const du = execFileSync('du', ['-sk', path.join(app.runPath, 'data')], { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/)[0];
              if (du) out.dataBytes = Number(du) * 1024;
            }
            const logF = path.join(app.runPath, 'deploy.log');
            if (fs.existsSync(logF)) out.logBytes = fs.statSync(logF).size;
            const df = execFileSync('df', ['-k', app.runPath || os.homedir()], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[1];
            if (df) { const avail = df.split(/\s+/)[3]; if (avail) out.diskFreeMb = Math.round(Number(avail) / 1024); }
          } catch { /* honest nulls */ }
          return out;
        });
      }
      if (appsMatch && req.method === 'POST' && appsMatch[2] === 'graduate') {
        // borrowed label → the owner's own domain, from the dashboard
        try {
          const body = await readBody(req);
          const r = gitlive.graduateAppData(decodeURIComponent(appsMatch[1]), body && body.domain, body || {});
          return ok(res, r);
        } catch (err) {
          return fail(res, err.code === 'INVALID_ARGS' ? 400 : 500, err.code || 'INTERNAL', err.message || String(err));
        }
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
      const warning = nonLoopbackWarning(host);
      if (warning) return Promise.reject(new Error(warning));
      rotateServeLog();
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          // eslint-disable-next-line no-console
          console.log(`gitlive control plane on ${instance.url}`);
          cronStart(); // the scheduled-task ticker rides the plane's lifetime
          // the plane's own helpers: repair / diagnose / recommend. Bounded,
          // receipted, and switchable (GITLIVE_AGENTS=0). They run the same
          // functions the buttons do — no second implementation.
          try {
            agentCaps = {
              listApps: () => gitlive.listAppsData(),
              restart: (n) => gitlive.restartAppData(n),
              diagnose: (n) => appDiagnose(n),
              deployHistory: (n) => { try { return gitlive.readHistory((gitlive.loadRegistry()[n] || {}).runPath, 5) || []; } catch { return []; } },
              backups: () => backupsOverview(),
              diskFreeMb: () => { try { const df = require('node:child_process').execFileSync('df', ['-k', os.homedir()], { encoding: 'utf8' }).trim().split('\n')[1]; const mb = Math.round(Number(df.split(/\s+/)[3]) / 1024); return mb; } catch { return null; } },
            };
            require('./agents.js').start(agentCaps);
          } catch { /* agents are optional helpers, never a boot dependency */ }
          installSignalHandlers(instance);
          // dead sessions never accumulate: prune at boot, then hourly with the
          // rest of the maintenance tick
          try { const p = pruneSessions('boot'); if (p.pruned) accessLog(`${new Date().toISOString()} pruned ${p.pruned} expired session(s)`); } catch { /* never block a boot */ }
          sessionPruneTimer = setInterval(() => { try { pruneSessions('hourly'); } catch { /* best effort */ } }, 60 * 60 * 1000);
          sessionPruneTimer.unref();
          // the resource series the v4 trend detectors read (RSS / data / log /
          // free disk every 5 min): without a history there is no forecast
          startStatsSampler();
          setTimeout(runMaintenance, 5000).unref(); // state snapshot + repo check, receipted
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
      try { clearInterval(healthTimer); } catch { /* not started */ }
      try { require('./agents.js').stop(); } catch { /* agents optional */ }
      try { clearInterval(cronTimer); cronTimer = null; } catch { /* not started */ }
      try { clearInterval(sessionPruneTimer); sessionPruneTimer = null; } catch { /* not started */ }
      try { clearInterval(statsTimer); statsTimer = null; } catch { /* not started */ }
      try { client.close(); } catch { /* already closed */ }
      // stop accepting, let in-flight requests finish, then resolve — a clean
      // exit is what lets the boot agent restart us without losing a receipt
      return new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
        setTimeout(resolve, 3000).unref(); // never hang a shutdown on a stuck socket
      });
    },
    // exposed for the signal handlers + tests
    shutdown: () => instance.close(),
  };
  return instance;
}

// ── signals: a clean stop instead of a hard death ────────────────────────
// SIGTERM (the boot agent restarting us) and SIGINT (Ctrl-C in a terminal)
// both drain: timers cleared, in-flight requests finished, then exit 0.
// Without this a restart could drop a receipt mid-write.
function installSignalHandlers(instance) {
  if (installSignalHandlers.installed) return;
  installSignalHandlers.installed = true;
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`gitlive control plane: ${sig} — draining`);
    instance.shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(0));
    setTimeout(() => process.exit(0), 3500).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

module.exports = { createControlServer, CONTROL_ROOT, accessLog, ACCESS_LOG, pruneSessions, intelFacts, sampleStats };
