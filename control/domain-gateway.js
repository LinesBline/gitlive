'use strict';
// SPDX-License-Identifier: AGPL-3.0-or-later
// domain-gateway.js — Tier 1 local naming: apps answer at <name>.gitlive.
//
// A tiny Host-routing HTTP proxy (Node built-ins only, zero deps): it maps
// "Host: <name>.gitlive" to the app's live port and forwards the request.
// Safe-mode apps are reached through their public port (the proxy that does
// the blue-green swap); plain apps through their registered port. Unknown
// names get a plain 404; unreachable apps a plain 502 — both name apps, no
// raw addresses in the copy. The bare gateway address (http://127.0.0.1:port)
// serves a directory page listing apps by name only.
//
// The routing brain (which app answers which name) lives in
// control/name-routing.js, shared with entry.js (the NAT entry node) so the
// two can never drift apart.
//
// Owned by `gitlive domain local on|off|list`; spawned detached with a
// pidfile. Env: GITLIVE_GATEWAY_PORT (default 80 — falls back to 8080 and
// says so when binding needs privileges), GITLIVE_GATEWAY_PIDFILE,
// GITLIVE_GATEWAY_LOG. HOME decides which registry/apps.json is routed.
//
// Design law: this is local plumbing on the user's own machine. It is never
// a hosted service, and nothing in gitlive depends on a gitlive-operated
// name zone (WORKFLOW.md "The naming law").

const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { URL } = require('node:url');

const routing = require('./name-routing.js');
const { loadApps, loadZones, publicTarget, zoneTarget, targetOf, namePage, publicCertPaths, esc } = routing;

const PORT = Number(process.env.GITLIVE_GATEWAY_PORT) || 80;
const PORT_EXPLICIT = process.env.GITLIVE_GATEWAY_PORT !== undefined;
const TLS_PORT = Number(process.env.GITLIVE_GATEWAY_TLS_PORT) || 443;
const TLS_PORT_EXPLICIT = process.env.GITLIVE_GATEWAY_TLS_PORT !== undefined;
const TLS_CERT = process.env.GITLIVE_TLS_CERT;
const TLS_KEY = process.env.GITLIVE_TLS_KEY;
const PIDFILE = process.env.GITLIVE_GATEWAY_PIDFILE;
const LOGFILE = process.env.GITLIVE_GATEWAY_LOG || path.join(os.homedir(), '.gitlive', 'domain', 'gateway.log');

function logLine(msg) {
  try { fs.appendFileSync(LOGFILE, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* log must never kill the gateway */ }
}

// Forward one request to a target port; retry the ACTIVE SLOT once when the
// primary port refuses the connection (nothing was delivered — a refused
// connection never reached the app, so this is safe for any method).
function forward(req, res, target, port, isRetry) {
  // Root requests are special: the APP always wins when it has something to
  // show (any 2xx/3xx passes through untouched); only when the app has no
  // page at "/" does the gitlive name page appear in its place. Buffering is
  // limited to root GETs, which are tiny.
  const isRoot = req.method === 'GET' && (req.url === '/' || req.url === '');
  const upstream = http.request({
    host: '127.0.0.1', port,
    method: req.method, path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${port}` },
  }, (up) => {
    const code = up.statusCode || 502;
    if (isRoot && !target.reserved && code >= 400) {
      up.resume(); // drain, then replace the app's "nothing here" with the name page
      const body = namePage(target, req);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(code, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    const refused = err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET');
    if (refused && !isRetry && target.fallback && target.fallback !== port) {
      logLine(`"${target.name}": port ${port} refused — serving the active slot on ${target.fallback} (proxy down?)`);
      return forward(req, res, target, target.fallback, true);
    }
    if (isRoot && !target.reserved) {
      const body = namePage({ ...target, alive: false }, req);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`"${target.name}" is not answering right now — check it with: gitlive status ${target.name}\n`);
  });
  req.pipe(upstream);
}

// The name office (two-door plan, P6): a zone's APEX hosts the offering
// page — what a zone is, whether a name is free ON THIS MACHINE, and the
// one-command graduation. Read-only: nothing a visitor types writes
// anything anywhere; the zone is a role, never a monopoly.
function zoneApexOf(hostname) {
  const zones = loadZones();
  return Object.keys(zones).includes(hostname) ? hostname : null;
}
function nameOfficePage(zone) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(zone)} — name office</title>
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1.25rem}
 h1{font-size:2.1rem;letter-spacing:-.02em;margin:0 0 .3rem}
 .sub{color:#888;margin:0 0 1.6rem}
 .card{border:1px solid #8883;border-radius:12px;padding:1.1rem 1.3rem;margin:0 0 1rem}
 input{font:15px ui-monospace,monospace;padding:.55rem .8rem;border-radius:8px;border:1px solid #8885;width:12rem}
 button{font:15px system-ui;padding:.55rem 1rem;border-radius:8px;border:1px solid #8885;background:none;cursor:pointer}
 #result{font:14px ui-monospace,monospace;margin-top:.8rem;min-height:1.4em}
 .free{color:#1a9d68}.taken{color:#c05050}
 code{background:#8882;padding:.1rem .35rem;border-radius:5px}
 ol{padding-left:1.2rem}
 .foot{color:#888;font-size:12.5px;margin-top:2rem}
</style></head><body>
<h1>${esc(zone)}</h1>
<p class="sub">a naming zone · names are loans, graduation is one command</p>
<div class="card">
  <p>This zone lends names: an app living here answers at <code>&lt;name&gt;.${esc(zone)}</code>.
  A borrowed label is a <b>loan</b> — the zone can stop resolving it, which is exactly why the
  label is never your address. Your own domain is always one command away:</p>
  <p style="margin:0"><code>gitlive domain graduate &lt;app&gt; --domain &lt;your.domain&gt;</code></p>
</div>
<div class="card">
  <p style="margin-top:0">Check a name on this machine:</p>
  <input id="nm" placeholder="name" onkeydown="if(event.key==='Enter')check()"><button onclick="check()">check</button>
  <div id="result"></div>
</div>
<div class="card">
  <b>The policy, in five lines</b>
  <ol style="margin:.6rem 0 0">
    <li>A label is a loan, never a claim — the app's keys, code and data stay its owner's.</li>
    <li>Revocation is a fact, so honesty about it is a rule.</li>
    <li>The exit is one command, and it is the borrower's.</li>
    <li>Zones serve the apps, not the other way round — no traffic, no data, no metrics.</li>
    <li>gitlive ships the mechanism, never a zone.</li>
  </ol>
</div>
<p class="foot">gitlive · this page comes from gitlive, the zone itself is run by whoever registered ${esc(zone)}</p>
<script>
async function check() {
  const name = document.getElementById('nm').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const r = document.getElementById('result');
  if (!name) { r.textContent = ''; return; }
  try {
    const res = await fetch('/.well-known/gitlive/zone-check?name=' + encodeURIComponent(name));
    const d = await res.json();
    r.className = d.taken ? 'taken' : 'free';
    r.textContent = d.taken
      ? d.host + ' is taken on this machine (' + (d.appName || 'an app') + ')'
      : d.host + ' is free on this machine — ask the zone operator before building on it';
  } catch (e) { r.textContent = 'could not check — is the gateway up?'; }
}
</script>
</body></html>`;
}

function handler(req, res) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  // Proof of arrival: `gitlive domain public --check` fetches this over the
  // public name to confirm the request really landed on this machine's
  // gateway and reached this app.
  if (req.url === '/.well-known/gitlive') {
    const t = targetOf(host);
    const body = JSON.stringify({ gitlive: true, host, app: t ? (t.appName || t.name) : null, at: new Date().toISOString() }, null, 1) + '\n';
    res.writeHead(t ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  // the name office (P6): a zone's apex answers with the offering page and
  // an honest name check scoped to THIS machine. The app always wins below
  // this branch — <app>.<zone> keeps routing to the app untouched.
  const apex = zoneApexOf(host);
  if (apex && req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/.well-known/gitlive/zone-check') {
      const name = String(u.searchParams.get('name') || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      const t = name ? targetOf(`${name}.${apex}`) : null;
      const body = JSON.stringify({ zone: apex, name: name || null, host: name ? `${name}.${apex}` : null, taken: Boolean(t), appName: t ? (t.appName || t.name) : null }, null, 1) + '\n';
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }
    if (u.pathname === '/' || u.pathname === '') {
      const body = nameOfficePage(apex);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
  }
  // The bare gateway address is the directory: every app, by name only.
  if (host === '127.0.0.1' || host === 'localhost' || host === '') {
    const apps = loadApps();
    const scheme = req.socket && req.socket.encrypted ? 'https' : 'http';
    const portPart = String(req.headers.host || '').includes(':') ? ':' + String(req.headers.host).split(':').pop() : '';
    const rows = Object.entries(apps)
      .filter(([, a]) => a.mode !== 'connect' && (a.port || a.publicPort))
      .map(([name]) => `  <li><a href="${scheme}://${name}.gitlive${portPart}/">${name}</a></li>`)
      .join('\n');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>gitlive — your apps</title></head>
<body style="font-family:system-ui;max-width:30rem;margin:3rem auto">
<h1>Your apps</h1><ul>\n${rows || '  <li>no apps yet</li>'}\n  <li><a href="${scheme}://gitlive.gitlive${portPart}/">gitlive — dashboard</a></li>\n</ul>
<p style="color:#666;font-size:13px">Each app keeps its name; a real domain for it attaches through gitlive later.</p>
</body></html>\n`);
    return;
  }
  const target = targetOf(host);
  if (!target) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`no gitlive app answers at "${host}" — see the dashboard (gitlive open) or "gitlive list" for your apps\n`);
    return;
  }
  forward(req, res, target, target.port, false);
}

const server = http.createServer(handler);

// TLS: one listener, many names. SNI decides which certificate answers —
// the gitlive local CA for <name>.gitlive, the owner's installed certificate
// for a public domain they attached (Tier 2). Contexts are cached by
// (files + mtime) so a fresh `gitlive domain public ... --cert` takes effect
// without a restart.
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
  if (TLS_CERT && TLS_KEY) return pick(TLS_CERT, TLS_KEY);
  return null;
}

function start(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
}

(async () => {
  logLine('gateway starting');
  let actualPort = PORT;
  // HTTPS listener: same routing, certificate from the gitlive local CA
  // (issued by `gitlive domain local tls`). Its failure must never take the
  // HTTP listener down — it is logged, not fatal.
  function startTls() {
    if (!TLS_CERT || !TLS_KEY || !fs.existsSync(TLS_CERT) || !fs.existsSync(TLS_KEY)) return Promise.resolve(null);
    const creds = {
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY),
      SNICallback: (servername, cb) => {
        const ctx = contextFor(servername);
        if (ctx) cb(null, ctx);
        else cb(new Error('no certificate for ' + servername));
      },
    };
    const tlsServer = https.createServer(creds, handler);
    const candidates = TLS_PORT_EXPLICIT ? [TLS_PORT] : [443, 8443, 8444, 8445, 8446];
    return new Promise((resolve) => {
      let i = 0;
      const tryNext = () => {
        if (i >= candidates.length) { logLine('https: no free port (443 needs admin)'); resolve(null); return; }
        const p = candidates[i++];
        tlsServer.once('error', tryNext);
        tlsServer.listen(p, '127.0.0.1', () => {
          tlsServer.removeListener('error', tryNext);
          logLine(`https listening on 127.0.0.1:${p} (requested ${TLS_PORT})`);
          resolve(p);
        });
      };
      tryNext();
    });
  }
  if (PORT_EXPLICIT) {
    // An explicit port is a contract (tests, --port): never silently move to
    // another one — a fallback here once left zombie gateways squatting 8080
    // after failed test runs, fighting the real machine's gateway for it.
    try {
      await start(PORT);
    } catch (err) {
      logLine(`could not bind ${PORT}: ${err.message}`);
      console.error(`[gitlive-domain] could not bind port ${PORT}: ${err.message}`);
      process.exit(1);
    }
  } else {
    // Defaulting to 80 (needs admin): try 80, then the first free port from
    // 8080 upwards, and report which one actually took the traffic.
    const candidates = [80, 8080, 8081, 8082, 8083, 8084];
    let bound = false;
    for (const p of candidates) {
      try { await start(p); actualPort = p; bound = true; break; } catch { /* try next */ }
    }
    if (!bound) {
      logLine('could not bind 80 or 8080-8084');
      console.error('[gitlive-domain] could not bind 80 or any fallback port 8080-8084');
      process.exit(1);
    }
  }
  const actualTlsPort = await startTls();
  if (PIDFILE) { try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch { /* noop */ } }
  logLine(`listening on 127.0.0.1:${actualPort} (requested ${PORT})${actualTlsPort ? ` + https 127.0.0.1:${actualTlsPort}` : ''}`);
  if (actualPort !== 80) console.error(`[gitlive-domain] gateway on port ${actualPort} (port 80 needs admin) — hosts entries still resolve names to this gateway`);
  if (actualTlsPort && actualTlsPort !== 443) console.error(`[gitlive-domain] https on port ${actualTlsPort} (port 443 needs admin)`);
})();
