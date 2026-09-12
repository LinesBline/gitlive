#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// entry.js — the public entry node for machines behind NAT (two-door plan).
//
// A home machine behind NAT cannot receive connections; an entry machine
// (the owner's own always-on machine with a public address — a small VPS,
// a friend's router box, anything with ports open) CAN. The entry is not a
// service and not a naming zone: it is dumb plumbing between two machines
// the owner controls. The home machine dials OUT to the entry (so no inbound
// port is ever opened at home), the entry holds public requests for the
// home machine's domains, the home machine polls them over the same outbound
// channel, answers from its own apps, and the entry relays the answer back
// to the browser. All connections originate on the NAT side; the entry holds
// no keys, no code, no data beyond a token hash and the domain list.
//
// Wire protocol (Node built-ins only):
//   POST /entry/hello  { token, machine, name, domains[] }   home → entry
//   POST /entry/bye    { token, machine }                    home → entry
//   GET  /entry/events?token&machine  long-poll: { kind:'request', id,
//        method, url, headers, body(base64) } or { kind:'idle' }
//   POST /entry/answer  x-entry-token/machine/id headers, body =
//        JSON line { status, headers } "\n" raw bytes        home → entry
// Browser traffic is Host-routed to whichever connected machine registered
// that hostname. Request bodies are buffered up to a cap (default 2 MB —
// the one buffered hop); response bodies stream through un-buffered.
//
// Commands: gitlive entry serve | connect | disconnect | stop | status |
// list | cert. The long-lived processes are `_entry-server` and
// `_entry-client`, spawned detached by serve/connect with pidfiles in
// ~/.gitlive/entry/. All entry auth is a shared bearer token generated at
// serve time (stored SHA-256-hashed on the entry, plaintext on the home
// machine, mode 600 both sides).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');

const HOME_DIR = path.join(os.homedir(), '.gitlive');
const ENTRY_DIR = path.join(HOME_DIR, 'entry');

const REQ_CAP = Number(process.env.GITLIVE_ENTRY_REQ_CAP) || 2 * 1024 * 1024; // buffered request body cap
const HOLD_MS = 25000;  // long-poll hold window
const ANSWER_MS = 30000; // browser request patience

function entryDir() {
  fs.mkdirSync(ENTRY_DIR, { recursive: true });
  return ENTRY_DIR;
}
function serverCfgPath() { return path.join(entryDir(), 'server.json'); }
function statePath() { return path.join(entryDir(), 'state.json'); }
function serverPidPath() { return path.join(entryDir(), 'server.pid'); }
function serverLogPath() { return path.join(entryDir(), 'server.log'); }
function clientCfgPath() { return path.join(entryDir(), 'client.json'); }
function clientPidPath() { return path.join(entryDir(), 'client.pid'); }
function clientLogPath() { return path.join(entryDir(), 'client.log'); }

function logTo(file, msg) {
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* log must never kill the process */ }
}
function pidAlive(pidPath) {
  try {
    const pid = fs.readFileSync(pidPath, 'utf8').trim();
    if (!pid) return false;
    process.kill(Number(pid), 0);
    return true;
  } catch { return false; }
}
function killPidFile(pidPath) {
  try {
    const pid = fs.readFileSync(pidPath, 'utf8').trim();
    if (pid) { try { process.kill(-Number(pid)); } catch { try { process.kill(Number(pid)); } catch { /* gone */ } } }
  } catch { /* no pidfile */ }
  try { fs.rmSync(pidPath, { force: true }); } catch { /* noop */ }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function tokenOk(storedHash, token) {
  if (!storedHash || !token) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function loadServerCfg() {
  try { return JSON.parse(fs.readFileSync(serverCfgPath(), 'utf8')); } catch { return {}; }
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return { machines: {} }; }
}
function saveState(state) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.chmodSync(statePath(), 0o600);
  } catch { /* cosmetic */ }
}

// ---------------------------------------------------------------------------
// Shared helpers used by both the server (SNI) and the client (local routing)
// ---------------------------------------------------------------------------
const routing = require('./control/name-routing.js');
const { targetOf, namePage, filterHeaders, publicCertPaths, loadApps, loadZones } = routing;

function hopSafe(headers) {
  const out = filterHeaders(headers || {});
  out.host = headers && headers.host; // the original host must survive the hop (routing depends on it)
  return out;
}

function entryDomains() {
  // Everything this machine's gateway would route for: attached public
  // domains plus every <app>.<zone> under a registered zone (same semantics
  // as control/name-routing.js zoneTarget — one routing brain).
  const domains = [];
  try {
    const apps = loadApps();
    for (const app of Object.values(apps)) {
      if (Array.isArray(app.domains)) for (const d of app.domains) domains.push(String(d).toLowerCase());
    }
    const zones = Object.keys(loadZones());
    for (const name of Object.keys(apps)) {
      if (apps[name].mode === 'connect') continue;
      for (const z of zones) domains.push(`${name}.${z}`);
    }
  } catch { /* no registry yet */ }
  return Array.from(new Set(domains)).sort().slice(0, 200);
}

// ---------------------------------------------------------------------------
// _entry-server — the public machine's side
// ---------------------------------------------------------------------------
function entryServerMain() {
  const PIDFILE = process.env.GITLIVE_ENTRY_PIDFILE || serverPidPath();
  const LOGFILE = process.env.GITLIVE_ENTRY_LOG || serverLogPath();
  const PORT = Number(process.env.GITLIVE_ENTRY_PORT) || 0;
  const PORT_EXPLICIT = process.env.GITLIVE_ENTRY_PORT !== undefined;
  const TLS_PORT = Number(process.env.GITLIVE_ENTRY_TLS_PORT) || 0;
  const TLS_PORT_EXPLICIT = process.env.GITLIVE_ENTRY_TLS_PORT !== undefined;

  const cfg = loadServerCfg();
  if (!cfg.tokenHash) {
    logTo(LOGFILE, 'no entry token configured — run: gitlive entry serve');
    console.error('[gitlive-entry] no token configured on this machine — run: gitlive entry serve');
    process.exit(1);
  }
  const state = loadState();
  const machines = state.machines || {};
  const pending = new Map(); // id -> { machine, claimed, req, timer, browserRes }
  const waiters = new Map(); // machine -> [resolveFn]
  let idSeq = 0;

  const replyJson = (res, code, obj) => {
    if (res.destroyed) return;
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  function collectBody(req, cap, cb) {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (err, buf) => { if (settled) return; settled = true; cb(err, buf); };
    req.on('data', (d) => {
      if (settled) return;
      size += d.length;
      if (size > cap) {
        // too large: stop buffering, drain the rest, let the caller say 413
        req.pause();
        done(null, null);
        req.resume();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => { if (!settled) done(null, Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!settled) done(e, null); });
  }

  function nextPendingFor(machine) {
    for (const [id, p] of pending) {
      if (p.machine === machine && !p.claimed) { p.claimed = true; return { id, p }; }
    }
    return null;
  }
  function wake(machine) {
    const list = waiters.get(machine);
    if (!list || !list.length) return;
    const resolve = list.shift();
    const hit = nextPendingFor(machine);
    if (!hit) { waiters.get(machine).push(resolve); return; }
    resolve(hit);
  }

  function findMachineFor(host) {
    for (const [id, m] of Object.entries(machines)) {
      if (Array.isArray(m.domains) && m.domains.includes(host)) return id;
    }
    return null;
  }

  function directoryPage() {
    const rows = Object.entries(machines).map(([id, m]) => {
      const domains = (m.domains || []).map((d) => `<li><a href="http://${d}/">${d}</a></li>`).join('');
      return `<div class="card"><strong>${id.slice(0, 8)}${m.name ? ' (' + m.name + ')' : ''}</strong> · connected ${(m.connectedAt || '').slice(0, 10)}<ul>${domains || '<li>no domains yet</li>'}</ul></div>`;
    }).join('\n') || '<p>no home machine is connected — run `gitlive entry connect` on the machine behind NAT.</p>';
    return `<!doctype html><html><head><meta charset="utf-8"><title>gitlive entry</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1.25rem}
.card{border:1px solid #8883;border-radius:12px;padding:.9rem 1.1rem;margin:0 0 1rem}li{margin:.15rem 0}</style></head><body>
<h1>gitlive entry</h1>
<p>This machine forwards public requests to gitlive apps on machines behind NAT.
The apps themselves live on those machines; nothing runs here but this relay.</p>
${rows}
</body></html>\n`;
  }

  function answerBrowser(req, res, machine) {
    // Streaming upgrade (post-roadmap #5): requests WITH a body never get
    // buffered at the entry — the body is pulled by the home machine over
    // a dedicated outbound connection and streams straight through. The
    // 2 MB cap now applies only to bodyless buffered control reads; the
    // old "request too large" cliff is gone for real uploads.
    const len = req.headers['content-length'];
    const hasBody = len !== undefined ? (len !== '0' && Number(len) !== 0) : Boolean(req.headers['transfer-encoding']);
    if (hasBody) {
      req.pause(); // backpressure until the home machine pulls the body
      const id = 'r' + (++idSeq);
      const entry = {
        machine,
        claimed: false,
        streaming: true,
        bodySrc: req,
        req: { method: req.method, url: req.url, headers: hopSafe(req.headers), body: '' },
        browserRes: res,
        timer: null,
      };
      pending.set(id, entry);
      entry.timer = setTimeout(() => {
        pending.delete(id);
        if (!res.destroyed) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('no home machine answered in time — is "gitlive entry connect" running there?\n');
        }
      }, ANSWER_MS);
      wake(machine);
      return;
    }
    collectBody(req, REQ_CAP, (err, body) => {
      if (err || body === null) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`request too large for the entry relay (max ${Math.round(REQ_CAP / 1024 / 1024)} MB in one request)\n`);
        return;
      }
      const id = 'r' + (++idSeq);
      const entry = {
        machine,
        claimed: false,
        req: {
          method: req.method,
          url: req.url,
          headers: hopSafe(req.headers),
          body: body && body.length ? body.toString('base64') : '',
        },
        browserRes: res,
        timer: null,
      };
      pending.set(id, entry);
      entry.timer = setTimeout(() => {
        pending.delete(id);
        if (!res.destroyed) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('no home machine answered in time — is "gitlive entry connect" running there?\n');
        }
      }, ANSWER_MS);
      wake(machine);
    });
  }

  // The body pull: the home machine's OUTBOUND connection that carries the
  // browser's request body — E pipes the (possibly still arriving) body
  // straight into the response, so uploads stream instead of buffering.
  function handleBodyPull(req, res) {
    const u = new URL(req.url, 'http://x');
    const token = req.headers['x-entry-token'];
    const machine = u.searchParams.get('machine');
    const id = u.searchParams.get('id');
    if (!tokenOk(cfg.tokenHash, token)) return replyJson(res, 401, { error: 'bad token' });
    const pend = pending.get(id);
    if (!pend || pend.machine !== machine) return replyJson(res, 404, { error: 'no such pending request' });
    if (!pend.streaming || !pend.bodySrc) return replyJson(res, 409, { error: 'not a streaming request' });
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    pend.bodySrc.pipe(res);
    pend.bodySrc.resume();
  }

  function handleAnswer(req, res) {
    const token = req.headers['x-entry-token'];
    const machine = String(req.headers['x-entry-machine'] || '');
    const id = String(req.headers['x-entry-id'] || '');
    if (!tokenOk(cfg.tokenHash, token)) return replyJson(res, 401, { error: 'bad token' });
    const pend = pending.get(id);
    if (!pend || pend.machine !== machine) return replyJson(res, 404, { error: 'no such pending request' });
    clearTimeout(pend.timer);
    pending.delete(id);
    // body = one JSON line { status, headers } + "\n" + raw response bytes
    let buf = Buffer.alloc(0);
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > 65536) { settled = true; replyJson(res, 413, { error: 'answer header line too long' }); }
        return;
      }
      settled = true;
      req.removeListener('data', onData);
      req.pause();
      let meta = null;
      try { meta = JSON.parse(buf.slice(0, nl).toString('utf8')); } catch { /* fall through */ }
      const rest = buf.slice(nl + 1);
      if (!meta || !Number.isInteger(meta.status)) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('malformed answer\n');
        return;
      }
      const browserRes = pend.browserRes;
      if (browserRes.destroyed) { res.destroy(); return; }
      const pass = new PassThrough();
      if (rest.length) pass.write(rest);
      req.pipe(pass);
      browserRes.writeHead(meta.status, filterHeaders(meta.headers || {}));
      pass.pipe(browserRes);
      // the answer upload ends with the stream; nothing to send back
      res.writeHead(204);
      res.end();
    };
    req.on('data', onData);
    req.on('end', () => { if (!settled) replyJson(res, 400, { error: 'malformed answer' }); });
    req.on('error', () => { /* pending timer already cleared; browser gets whatever was written */ });
  }

  function handleEvents(req, res) {
    const u = new URL(req.url, 'http://x');
    // the token rides a HEADER, never the URL — query strings leak into
    // access logs and proxy histories, headers do not (pre-launch fix)
    const token = req.headers['x-entry-token'];
    const machine = u.searchParams.get('machine');
    if (!tokenOk(cfg.tokenHash, token)) return replyJson(res, 401, { error: 'bad token' });
    if (!machines[machine]) return replyJson(res, 403, { error: 'unknown machine' });
    const hit = nextPendingFor(machine);
    if (hit) {
      return replyJson(res, 200, {
        kind: 'request', id: hit.id,
        method: hit.p.req.method, url: hit.p.req.url,
        headers: hit.p.req.headers, body: hit.p.req.body,
        streaming: Boolean(hit.p.streaming),
      });
    }
    let done = false;
    const finish = (obj) => { if (done) return; done = true; replyJson(res, 200, obj); };
    const timer = setTimeout(() => finish({ kind: 'idle' }), HOLD_MS);
    const myResolve = (hit2) => {
      clearTimeout(timer);
      finish(hit2 ? { kind: 'request', id: hit2.id, method: hit2.p.req.method, url: hit2.p.req.url, headers: hit2.p.req.headers, body: hit2.p.req.body, streaming: Boolean(hit2.p.streaming) } : { kind: 'idle' });
    };
    const list = waiters.get(machine) || [];
    list.push(myResolve);
    waiters.set(machine, list);
    req.on('close', () => {
      if (done) return;
      clearTimeout(timer);
      const l = (waiters.get(machine) || []).filter((fn) => fn !== myResolve);
      waiters.set(machine, l);
    });
  }

  function handleHello(req, res) {
    collectBody(req, 65536, (err, body) => {
      if (err) return replyJson(res, 413, { error: 'hello too large' });
      let data = null;
      try { data = JSON.parse(body.toString('utf8') || '{}'); } catch { /* invalid */ }
      if (!data || !tokenOk(cfg.tokenHash, data.token)) return replyJson(res, 401, { error: 'bad token' });
      if (!data.machine || typeof data.machine !== 'string' || data.machine.length > 128) return replyJson(res, 400, { error: 'machine id required' });
      const domains = Array.isArray(data.domains) ? data.domains.filter((d) => typeof d === 'string').map((d) => d.toLowerCase()).slice(0, 200) : [];
      const prev = machines[data.machine] || {};
      machines[data.machine] = {
        name: typeof data.name === 'string' && data.name.length < 64 ? data.name : data.machine.slice(0, 8),
        domains,
        connectedAt: prev.connectedAt || new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
      saveState({ machines });
      logTo(LOGFILE, `hello from ${data.machine.slice(0, 8)}: ${domains.length} domain(s)`);
      replyJson(res, 200, { ok: true, id: data.machine });
    });
  }

  function handleBye(req, res) {
    collectBody(req, 65536, (err, body) => {
      let data = null;
      try { data = JSON.parse(body.toString('utf8') || '{}'); } catch { /* invalid */ }
      if (!data || !tokenOk(cfg.tokenHash, data.token)) return replyJson(res, 401, { error: 'bad token' });
      if (machines[data.machine]) {
        delete machines[data.machine];
        saveState({ machines });
        logTo(LOGFILE, `bye from ${String(data.machine).slice(0, 8)}`);
      }
      replyJson(res, 200, { ok: true });
    });
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/entry/hello' && req.method === 'POST') return handleHello(req, res);
    if (u.pathname === '/entry/bye' && req.method === 'POST') return handleBye(req, res);
    if (u.pathname === '/entry/events' && req.method === 'GET') return handleEvents(req, res);
    if (u.pathname === '/entry/body' && req.method === 'GET') return handleBodyPull(req, res);
    if (u.pathname === '/entry/answer' && req.method === 'POST') return handleAnswer(req, res);
    // browser traffic, Host-routed
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    if (host === '' || host === '127.0.0.1' || host === 'localhost') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(directoryPage());
    }
    const machine = findMachineFor(host);
    if (!machine) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`no connected gitlive app answers at "${host}" — the apps live on home machines, this machine only relays\n`);
    }
    answerBrowser(req, res, machine);
  });

  const tlsCache = new Map();
  function contextFor(servername) {
    const pick = (crtPath, keyPath) => {
      try {
        const stat = fs.statSync(crtPath);
        const stamp = `${crtPath}:${stat.mtimeMs}`;
        if (tlsCache.has(stamp)) return tlsCache.get(stamp);
        const ctx = require('tls').createSecureContext({ cert: fs.readFileSync(crtPath), key: fs.readFileSync(keyPath) });
        tlsCache.set(stamp, ctx);
        return ctx;
      } catch { return null; }
    };
    const name = String(servername || '').toLowerCase();
    if (name && !name.endsWith('.gitlive')) {
      const p = publicCertPaths(name);
      const ctx = pick(p.crt, p.key);
      if (ctx) return ctx;
    }
    if (process.env.GITLIVE_TLS_CERT && process.env.GITLIVE_TLS_KEY) return pick(process.env.GITLIVE_TLS_CERT, process.env.GITLIVE_TLS_KEY);
    return null;
  }
  function tlsMaterialExists() {
    if (process.env.GITLIVE_TLS_CERT && process.env.GITLIVE_TLS_KEY
      && fs.existsSync(process.env.GITLIVE_TLS_CERT) && fs.existsSync(process.env.GITLIVE_TLS_KEY)) return true;
    try {
      const files = fs.readdirSync(path.join(HOME_DIR, 'domain', 'public'));
      return files.some((f) => f.endsWith('.crt'));
    } catch { return false; }
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => { server.removeListener('error', reject); resolve(); });
    });
  }

  (async () => {
    let actualPort = PORT;
    if (PORT_EXPLICIT) {
      try { await listen(PORT); }
      catch (err) {
        logTo(LOGFILE, `could not bind ${PORT}: ${err.message}`);
        console.error(`[gitlive-entry] could not bind port ${PORT}: ${err.message}`);
        process.exit(1);
      }
    } else {
      let bound = false;
      for (const p of [80, 8080, 8081, 8082, 8083, 8084]) {
        try { await listen(p); actualPort = p; bound = true; break; } catch { /* try next */ }
      }
      if (!bound) {
        logTo(LOGFILE, 'could not bind 80 or 8080-8084');
        console.error('[gitlive-entry] could not bind 80 or any fallback port 8080-8084');
        process.exit(1);
      }
    }
    // HTTPS: SNI serves the certificate the owner installed for that domain
    // on THIS machine (`gitlive entry cert`); no cert material → no https
    // listener, said honestly (the entry is plumbing, not a CA).
    let actualTlsPort = null;
    if (tlsMaterialExists()) {
      // socket default: env cert if given, else the first installed public
      // cert — SNI replaces it per-name for every other domain
      let defCrt = null;
      let defKey = null;
      if (process.env.GITLIVE_TLS_CERT && process.env.GITLIVE_TLS_KEY
        && fs.existsSync(process.env.GITLIVE_TLS_CERT) && fs.existsSync(process.env.GITLIVE_TLS_KEY)) {
        defCrt = process.env.GITLIVE_TLS_CERT;
        defKey = process.env.GITLIVE_TLS_KEY;
      } else {
        const files = fs.readdirSync(path.join(HOME_DIR, 'domain', 'public')).filter((f) => f.endsWith('.crt'));
        if (files.length) {
          const p = publicCertPaths(files[0].replace(/\.crt$/, ''));
          defCrt = p.crt;
          defKey = p.key;
        }
      }
      if (!defCrt || !defKey) {
        logTo(LOGFILE, 'certificate files present but unusable — http only');
      } else {
        const tlsServer = https.createServer({
          cert: fs.readFileSync(defCrt),
          key: fs.readFileSync(defKey),
          SNICallback: (servername, cb) => {
            const ctx = contextFor(servername);
            if (ctx) cb(null, ctx);
            else cb(new Error('no certificate for ' + servername));
          },
        }, (req, res) => server.emit('request', req, res));
        const candidates = TLS_PORT_EXPLICIT ? [TLS_PORT] : [443, 8443, 8444, 8445, 8446];
        actualTlsPort = await new Promise((resolve) => {
          let i = 0;
          const tryNext = () => {
            if (i >= candidates.length) { logTo(LOGFILE, 'https: no free port (443 needs admin)'); resolve(null); return; }
            const p = candidates[i++];
            tlsServer.once('error', tryNext);
            tlsServer.listen(p, '0.0.0.0', () => {
              tlsServer.removeListener('error', tryNext);
              logTo(LOGFILE, `https listening on 0.0.0.0:${p}`);
              resolve(p);
            });
          };
          tryNext();
        });
      }
    } else {
      logTo(LOGFILE, 'no certificate material on this machine — http only (gitlive entry cert <domain> to add TLS)');
    }
    try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch { /* noop */ }
    logTo(LOGFILE, `listening on 0.0.0.0:${actualPort}${actualTlsPort ? ` + https 0.0.0.0:${actualTlsPort}` : ''} — ${Object.keys(machines).length} machine(s) connected`);
  })();
}

// ---------------------------------------------------------------------------
// _entry-client — the NAT machine's side (outbound-only)
// ---------------------------------------------------------------------------
function loadClientCfg() {
  try { return JSON.parse(fs.readFileSync(clientCfgPath(), 'utf8')); } catch { return null; }
}
function machineId() {
  // the mesh node identity is the machine identity — one key, one name
  try {
    const peer = require('./peer.js');
    return peer.nodeIdOf(peer.ensureNodeKey());
  } catch {
    // fall back to a stable local secret if the peer module is unavailable
    const idPath = path.join(entryDir(), 'machine-id');
    let id = null;
    try { id = fs.readFileSync(idPath, 'utf8').trim(); } catch { /* first run */ }
    if (!id) { id = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(idPath, id, { mode: 0o600 }); }
    return 'm' + id;
  }
}

function postJson(url, data, headers = {}, timeout = 8000) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(timeout),
  });
}

async function helloEntry(cfg, { client } = {}) {
  const id = machineId();
  const domains = entryDomains();
  const res = await postJson(new URL('/entry/hello', cfg.url).href, {
    token: cfg.token, machine: id, name: cfg.name || id.slice(0, 8), domains,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`entry refused the hello (${res.status})${text ? ': ' + text.slice(0, 120) : ''}`);
  }
  return { id, domains };
}

function entryClientMain() {
  const PIDFILE = process.env.GITLIVE_ENTRY_PIDFILE || clientPidPath();
  const LOGFILE = process.env.GITLIVE_ENTRY_LOG || clientLogPath();
  const cfg = loadClientCfg();
  if (!cfg || !cfg.url || !cfg.token) {
    logTo(LOGFILE, 'no client config — run: gitlive entry connect <entry-url> --token <t>');
    console.error('[gitlive-entry] no client config — run: gitlive entry connect <entry-url> --token <t>');
    process.exit(1);
  }
  try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch { /* noop */ }
  logTo(LOGFILE, `entry client starting → ${cfg.url}`);

  const id = machineId();
  let lastDomains = '';
  let running = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function hello() {
    const domains = entryDomains();
    const sig = domains.join(',');
    if (sig === lastDomains) return true;
    const res = await postJson(new URL('/entry/hello', cfg.url).href, {
      token: cfg.token, machine: id, name: cfg.name || id.slice(0, 8), domains,
    }, {}, 8000);
    if (!res.ok) throw new Error('entry refused the hello (' + res.status + ')');
    lastDomains = sig;
    logTo(LOGFILE, `hello ok — routing ${domains.length} domain(s)`);
    return true;
  }

  async function answer(reqId, status, headers, body) {
    const meta = JSON.stringify({ status, headers: filterHeaders(headers || {}) }) + '\n';
    return fetch(new URL('/entry/answer', cfg.url).href, {
      method: 'POST',
      headers: {
        'x-entry-token': cfg.token,
        'x-entry-machine': id,
        'x-entry-id': String(reqId),
      },
      body: meta + (body || ''),
      signal: AbortSignal.timeout(ANSWER_MS),
    });
  }

  // raw upload for streamed responses — honors https entry URLs
  function entryUpload(uploadUrl, headers, onResponse) {
    const parsed = new URL(uploadUrl, cfg.url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const up = mod.request({
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      method: 'POST', path: parsed.pathname + parsed.search,
      headers,
    }, onResponse);
    up.on('error', (e) => logTo(LOGFILE, `answer failed: ${e.message}`));
    return up;
  }

  // pull a streaming request body over a dedicated outbound connection —
  // the response of this GET IS the body (post-roadmap #5: no buffering)
  function bodyPull(ev) {
    return new Promise((resolve, reject) => {
      const u = new URL('/entry/body', cfg.url);
      u.searchParams.set('machine', id);
      u.searchParams.set('id', String(ev.id));
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({
        host: u.hostname,
        port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
        method: 'GET', path: u.pathname + u.search,
        headers: { accept: 'application/octet-stream', 'x-entry-token': cfg.token },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('body pull refused (' + res.statusCode + ')')); return; }
        resolve(res);
      });
      req.setTimeout(ANSWER_MS, () => { req.destroy(); reject(new Error('body pull timed out')); });
      req.on('error', (e) => reject(e));
      req.end();
    });
  }

  function serveLocally(ev, bodyStream) {
    return new Promise((resolve) => {
      const host = String((ev.headers && ev.headers.host) || '').split(':')[0].toLowerCase();
      const target = targetOf(host);
      if (!target) {
        return resolve({ status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `no gitlive app answers at "${host}" — check "gitlive list" and the attached domains\n` });
      }
      const body = (!bodyStream && ev.body) ? Buffer.from(ev.body, 'base64') : null;
      const isRoot = ev.method === 'GET' && (ev.url === '/' || ev.url === '');

      const attempt = (port, isRetry) => {
        const up = http.request({
          host: '127.0.0.1', port,
          method: ev.method, path: ev.url,
          headers: { ...filterHeaders(ev.headers || {}), host: ev.headers.host },
        }, (upstream) => {
          const code = upstream.statusCode || 502;
          if (isRoot && !target.reserved && code >= 400) {
            upstream.resume(); // the app has nothing at "/" — the gitlive name page answers
            const page = namePage(target, { url: ev.url, headers: ev.headers });
            return resolve({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: page });
          }
          resolve({ status: code, headers: filterHeaders(upstream.headers), body: null, stream: upstream });
        });
        up.on('error', (err) => {
          const refused = err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET');
          if (refused && !isRetry && target.fallback && target.fallback !== port) {
            logTo(LOGFILE, `"${target.name}": port ${port} refused — retrying the active slot on ${target.fallback}`);
            return attempt(target.fallback, true);
          }
          resolve({ status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `"${target.name}" is not answering right now — check it with: gitlive status ${target.name}\n` });
        });
        if (bodyStream) {
          bodyStream.pipe(up);
          bodyStream.on('error', () => up.destroy());
        } else if (body) {
          up.write(body);
        }
        if (!bodyStream) up.end();
      };
      attempt(target.port, false);
    });
  }

  async function serveOne(ev) {
    try {
      // streaming request: pull the body first, then serve with it as the
      // upload source — the response still streams back as before
      let bodyStream = null;
      if (ev.streaming) bodyStream = await bodyPull(ev);
      const r = await serveLocally(ev, bodyStream);
      if (r.stream) {
        const meta = JSON.stringify({ status: r.status, headers: r.headers }) + '\n';
        const up = entryUpload('/entry/answer', {
          'x-entry-token': cfg.token, 'x-entry-machine': id, 'x-entry-id': String(ev.id),
          'transfer-encoding': 'chunked',
        }, (res) => { res.resume(); });
        up.write(meta);
        r.stream.pipe(up);
        r.stream.on('error', () => up.destroy());
        return;
      }
      const res = await answer(ev.id, r.status, r.headers, r.body);
      if (!res.ok) logTo(LOGFILE, `answer rejected (${res.status})`);
    } catch (err) {
      logTo(LOGFILE, `serve failed: ${err.message}`);
    }
  }

  async function pollLoop() {
    while (running) {
      try {
        const eventsUrl = new URL('/entry/events', cfg.url);
        eventsUrl.searchParams.set('machine', id);
        const res = await fetch(eventsUrl.href, {
          headers: { 'x-entry-token': cfg.token },
          signal: AbortSignal.timeout(HOLD_MS + 8000),
        });
        if (res.status === 401 || res.status === 403) {
          logTo(LOGFILE, `entry rejected the token (${res.status}) — re-connect with the right --token`);
          await sleep(5000);
          continue;
        }
        const ev = await res.json();
        if (ev.kind === 'request') await serveOne(ev);
      } catch (err) {
        if (running) { logTo(LOGFILE, `poll failed (${err.name || err.message}) — retrying in 2s`); await sleep(2000); }
      }
    }
  }

  (async () => {
    // initial hello + refresh loop (domains change when a new domain attaches)
    try { await hello(); } catch (err) { logTo(LOGFILE, `hello failed: ${err.message}`); }
    const helloTimer = setInterval(() => { hello().catch(() => {}); }, 30000);
    helloTimer.unref && helloTimer.unref();
    await Promise.all([pollLoop(), pollLoop(), pollLoop()]);
  })();

  process.on('SIGTERM', () => { running = false; process.exit(0); });
  process.on('SIGINT', () => { running = false; process.exit(0); });
}

// ---------------------------------------------------------------------------
// CLI — the entry command (function-based, like daemon.js)
// ---------------------------------------------------------------------------
function spawnDetached(args, env, logFile) {
  const script = __filename;
  const isDarwin = os.platform() === 'darwin';
  const envLine = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(' ');
  const cmd = `${envLine} node ${JSON.stringify(script)} ${args.map((a) => JSON.stringify(a)).join(' ')}`;
  const wrapped = isDarwin
    ? `perl -e 'use POSIX "setsid"; POSIX::setsid(); exec { $ARGV[0] } @ARGV' bash -c ${JSON.stringify(cmd)}`
    : `setsid bash -c ${JSON.stringify(cmd)}`;
  spawnSync('bash', ['-c', `${wrapped} >> ${JSON.stringify(logFile)} 2>&1 < /dev/null & echo started`], { encoding: 'utf8' });
  try { spawnSync('sleep', ['0.4'], { encoding: 'utf8' }); } catch { /* noop */ }
}
function logTail(logFile, n) {
  try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; }
}
function portFromLog(logFile, pattern) {
  const tail = logTail(logFile, 12);
  const m = tail.match(pattern);
  return m ? Number(m[1]) : null;
}

function entryServe(flags) {
  const dir = entryDir();
  const cfgPath = serverCfgPath();
  let cfg = loadServerCfg();
  // Single-instance discipline (same law as `gitlive serve`): never start a
  // second entry on this machine — reuse the running one. Token rotation
  // while running is refused too: changing the hash under a live server
  // would strand its connected machines without ever starting a new one.
  if (pidAlive(serverPidPath())) {
    if (flags.token) {
      console.error('gitlive entry: an entry server is running — stop it first (gitlive entry stop), then serve again with the new token.');
      process.exitCode = 1;
      return;
    }
    const port = portFromLog(serverLogPath(), /listening on 0\.0\.0\.0:(\d+)/);
    const tlsPort = portFromLog(serverLogPath(), /https listening on 0\.0\.0\.0:(\d+)/);
    console.log('gitlive entry: already running on this machine (no second instance started).');
    console.log(`  http : port ${port || '?'}${tlsPort ? ` · https: port ${tlsPort}` : ''}`);
    return;
  }
  let token = null;
  if (flags.token) {
    cfg.tokenHash = hashToken(flags.token);
    token = flags.token;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.chmodSync(cfgPath, 0o600);
  } else if (!cfg.tokenHash) {
    token = crypto.randomBytes(24).toString('base64url');
    cfg.tokenHash = hashToken(token);
    cfg.createdAt = new Date().toISOString();
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.chmodSync(cfgPath, 0o600);
  }
  const env = {};
  if (flags.port !== undefined) env.GITLIVE_ENTRY_PORT = String(Number(flags.port));
  else if (process.env.GITLIVE_ENTRY_PORT !== undefined) env.GITLIVE_ENTRY_PORT = process.env.GITLIVE_ENTRY_PORT;
  if (flags['tls-port'] !== undefined) env.GITLIVE_ENTRY_TLS_PORT = String(Number(flags['tls-port']));
  else if (process.env.GITLIVE_ENTRY_TLS_PORT !== undefined) env.GITLIVE_ENTRY_TLS_PORT = process.env.GITLIVE_ENTRY_TLS_PORT;
  env.GITLIVE_ENTRY_PIDFILE = serverPidPath();
  env.GITLIVE_ENTRY_LOG = serverLogPath();
  spawnDetached(['_entry-server'], env, serverLogPath());
  const tail = logTail(serverLogPath(), 6);
  if (!pidAlive(serverPidPath()) || /could not bind/.test(tail)) {
    console.error('gitlive entry: the entry server could not start — ' + (tail.trim().split('\n').pop() || 'no log output'));
    process.exitCode = 1;
    return;
  }
  const port = portFromLog(serverLogPath(), /listening on 0\.0\.0\.0:(\d+)/);
  const tlsPort = portFromLog(serverLogPath(), /https listening on 0\.0\.0\.0:(\d+)/);
  console.log('gitlive entry: running on this machine (public requests arrive here and relay to your NAT machines)');
  if (port) console.log(`  http : port ${port}`);
  if (tlsPort) console.log(`  https: port ${tlsPort}`);
  else console.log('  https: off — install a certificate first: gitlive entry cert <domain> --cert <file> --key <file>');
  if (token) {
    console.log('\nOn the machine behind NAT, run (token shown once — this is the one place it appears):');
    console.log(`  gitlive entry connect http${tlsPort ? 's' : ''}://<this-machine>${tlsPort && tlsPort !== 443 ? ':' + tlsPort : port && tlsPort === undefined && port !== 80 ? ':' + port : ''} --token ${token}`);
    console.log('  (<this-machine> = the DNS name or public IP that reaches THIS machine)');
  } else {
    console.log('\nThe entry token was set earlier — machines already connected keep working.');
    console.log('To rotate it (old connections stop): gitlive entry stop && gitlive entry serve --token <new-token>');
  }
}

function entryConnect(rest, flags) {
  const url = String(rest[1] || '').trim();
  const token = flags.token ? String(flags.token) : '';
  if (!/^https?:\/\//.test(url)) {
    console.error('Usage: gitlive entry connect <entry-url> [--token <t>] [--name <label>]');
    console.error('       the entry machine printed the exact command at "gitlive entry serve".');
    process.exitCode = 1;
    return;
  }
  if (!token) {
    console.error('gitlive entry connect: --token is required (the entry machine printed it once at serve time).');
    console.error('Lost it? Rotate on the entry machine: gitlive entry serve --token <new-token>');
    process.exitCode = 1;
    return;
  }
  const cfg = { url: url.replace(/\/$/, ''), token, name: flags.name ? String(flags.name) : undefined };
  // Pre-flight hello: prove the url + token BEFORE spawning a daemon — a
  // bad token must fail loudly here, not silently retry in a detached loop.
  let preflight = null;
  try {
    preflight = helloEntry(cfg);
  } catch (err) {
    console.error(`gitlive entry connect: cannot reach the entry (${err.message})`);
    process.exitCode = 1;
    return;
  }
  const dir = entryDir();
  fs.writeFileSync(clientCfgPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(clientCfgPath(), 0o600);
  const env = { GITLIVE_ENTRY_PIDFILE: clientPidPath(), GITLIVE_ENTRY_LOG: clientLogPath() };
  spawnDetached(['_entry-client'], env, clientLogPath());
  preflight.then(({ id, domains }) => {
    console.log(`gitlive entry: connected to ${cfg.url} as ${id.slice(0, 8)}`);
    console.log(domains.length
      ? `  routing ${domains.length} domain(s) through the entry: ${domains.join(', ')}`
      : '  no domains attached yet — gitlive domain public <app> --domain <your.domain> (they route automatically)');
    if (!pidAlive(clientPidPath())) console.error('  (the background client did not stay up — check "gitlive entry status")');
  }).catch((err) => {
    console.error('gitlive entry connect: ' + err.message);
    process.exitCode = 1;
  });
}

function entryDisconnect() {
  const cfg = loadClientCfg();
  if (cfg && cfg.url) {
    // best-effort bye, so the entry drops this machine's routes right away
    try {
      const id = machineId();
      postJson(new URL('/entry/bye', cfg.url).href, { token: cfg.token, machine: id }, {}, 4000).catch(() => {});
    } catch { /* offline entry: routes expire on their own */ }
  }
  const was = pidAlive(clientPidPath());
  killPidFile(clientPidPath());
  console.log(was
    ? 'gitlive entry: disconnected — this machine no longer answers through the entry.'
    : 'gitlive entry: no connected client was running.');
}

function entryStop() {
  const was = pidAlive(serverPidPath());
  killPidFile(serverPidPath());
  console.log(was
    ? 'gitlive entry: entry server stopped on this machine (home machines will retry until you serve again).'
    : 'gitlive entry: no entry server was running.');
}

function entryStatus() {
  const dir = entryDir();
  const cfg = loadClientCfg();
  if (cfg) {
    console.log('entry client (this machine behind NAT):');
    console.log(`  entry: ${cfg.url}`);
    console.log(`  state: ${pidAlive(clientPidPath()) ? 'connected (client running)' : 'stopped'}`);
    const domains = entryDomains();
    console.log(`  domains: ${domains.length ? domains.join(', ') : '(none attached yet)'}`);
    const tail = logTail(clientLogPath(), 1);
    if (tail) console.log(`  last: ${tail.trim()}`);
  }
  const srvCfg = loadServerCfg();
  if (srvCfg.tokenHash) {
    const port = portFromLog(serverLogPath(), /listening on 0\.0\.0\.0:(\d+)/);
    const tlsPort = portFromLog(serverLogPath(), /https listening on 0\.0\.0\.0:(\d+)/);
    console.log('entry server (this machine is the public entry):');
    console.log(`  state: ${pidAlive(serverPidPath()) ? `running (http ${port}, https ${tlsPort || 'off'})` : 'stopped'}`);
    const machines = Object.values(loadState().machines || {});
    console.log(`  machines: ${machines.length}${machines.length ? ' — see gitlive entry list' : ''}`);
  }
  if (!cfg && !srvCfg.tokenHash) console.log('gitlive entry: nothing here yet — gitlive entry serve (public machine) or gitlive entry connect (NAT machine).');
}

function entryList() {
  const machines = Object.values(loadState().machines || {});
  if (!machines.length) { console.log('no home machine has connected yet — run "gitlive entry connect" on the machine behind NAT.'); return; }
  for (const m of machines) {
    console.log(`  ${(m.name || '?')}  (${(m.domains || []).length} domain(s), last seen ${(m.lastSeen || '').slice(0, 19).replace('T', ' ')})`);
    for (const d of (m.domains || [])) console.log(`    ${d}`);
  }
}

function entryCert(rest, flags) {
  if (rest[1] === 'list') {
    const files = (() => { try { return fs.readdirSync(path.join(HOME_DIR, 'domain', 'public')); } catch { return []; } })();
    const certs = files.filter((f) => f.endsWith('.crt')).map((f) => f.replace(/\.crt$/, ''));
    if (!certs.length) { console.log('no certificates on this entry machine yet — gitlive entry cert <domain> --cert <file> --key <file>'); return; }
    for (const d of certs) console.log(`  ${d}`);
    return;
  }
  const domain = String(rest[1] || '').trim().toLowerCase();
  if (!domain || !flags.cert || !flags.key) {
    console.error('Usage: gitlive entry cert <domain> --cert <file> --key <file>');
    console.error('       gitlive entry cert list');
    console.error('Installs the certificate YOU hold for that domain on THIS entry machine,');
    console.error('so https works here (the app lives on the NAT machine — the cert lives where');
    console.error('the browser connects). SANs are verified; mismatches are refused.');
    process.exitCode = 1;
    return;
  }
  try {
    // reuse the one install path (validation + SAN check) shared with
    // `gitlive domain public` — same public dir the SNI callback reads
    const gitlive = require('./gitlive.js');
    if (!gitlive.validPublicDomain(domain)) throw new Error(`not a valid domain: ${domain}`);
    const installed = gitlive.installPublicCert(domain, String(flags.cert), String(flags.key));
    console.log(`gitlive entry: certificate installed for ${domain} → ${installed.crt}`);
    console.log('The https listener picks it up by name (SNI) without a restart.');
  } catch (err) {
    console.error('gitlive entry cert: ' + err.message);
    process.exitCode = 1;
  }
}

function cmdEntry(rest, flags) {
  const sub = rest[0];
  if (sub === 'serve') { entryServe(flags); return; }
  if (sub === 'connect') { entryConnect(rest, flags); return; }
  if (sub === 'disconnect') { entryDisconnect(); return; }
  if (sub === 'stop') { entryStop(); return; }
  if (sub === 'status') { entryStatus(); return; }
  if (sub === 'list') { entryList(); return; }
  if (sub === 'cert') { entryCert(rest, flags); return; }
  console.error('Usage: gitlive entry serve          run THIS machine as the public entry node');
  console.error('       gitlive entry connect <url> --token <t>   join from a machine behind NAT');
  console.error('       gitlive entry status | list   who is connected, what routes');
  console.error('       gitlive entry disconnect      stop answering through the entry (NAT side)');
  console.error('       gitlive entry stop            stop the entry server (public side)');
  console.error('       gitlive entry cert <domain> --cert <file> --key <file>   https for that name on THIS machine');
  process.exitCode = 1;
}

module.exports = { cmdEntry, helloEntry, entryDomains, machineId, tokenOk, hashToken, entryServerMain, entryClientMain };

// Standalone long-lived modes (spawned detached by the CLI above)
if (require.main === module) {
  const mode = process.argv[2];
  if (mode === '_entry-server') entryServerMain();
  else if (mode === '_entry-client') entryClientMain();
  else cmdEntry(process.argv.slice(2), {});
}
