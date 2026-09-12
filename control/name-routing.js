'use strict';
// SPDX-License-Identifier: AGPL-3.0-or-later
// name-routing.js — the ONE routing brain for "which app answers this name".
//
// Shared by control/domain-gateway.js (local names, Tier 1) and entry.js
// (the public entry node for machines behind NAT). A hostname resolves to a
// target: the app's live port, its safe-mode public port with an active-slot
// fallback, the reserved "gitlive" dashboard name, or null (unknown name).
// Pure data + page building only — no listeners, no console output, so both
// server processes can require it freely.
//
// Design law (WORKFLOW.md "The naming law"): gitlive never runs a naming
// zone. Local names are this machine's own hosts file; public names are the
// owner's own domains; zone names are borrowed labels lent by a zone the
// owner or their community runs — revocable by the zone, never owned by
// gitlive.

const os = require('os');
const fs = require('fs');
const path = require('path');

const APPS_JSON = path.join(os.homedir(), '.gitlive', 'apps.json');
const CONTROL_URL_FILE = path.join(os.homedir(), '.gitlive', 'control.url');
const PUBLIC_DIR = path.join(os.homedir(), '.gitlive', 'domain', 'public');
const ZONES_FILE = path.join(os.homedir(), '.gitlive', 'domain', 'zones.json');

function loadApps() {
  try { return JSON.parse(fs.readFileSync(APPS_JSON, 'utf8')); } catch { return {}; }
}

function loadZones() {
  try { return JSON.parse(fs.readFileSync(ZONES_FILE, 'utf8')); } catch { return {}; }
}

function publicCertPaths(domain) {
  return { crt: path.join(PUBLIC_DIR, `${domain}.crt`), key: path.join(PUBLIC_DIR, `${domain}.key`) };
}

function slotFallback(app) {
  if (!app || !app.safe || !app.runPath || !app.portA || !app.portB) return null;
  try {
    const slot = fs.readFileSync(path.join(app.runPath, 'active-slot'), 'utf8').trim();
    return slot === 'B' ? Number(app.portB) : Number(app.portA);
  } catch { return null; }
}

// Tier 2: public domains the owner attached to their apps
// (app.domains = ["app.example.com"]) route exactly like local names — the
// difference is only where the name resolves (their registrar, their control)
// and which certificate answers (theirs, installed by `gitlive domain public`).
function publicTarget(hostname) {
  const apps = loadApps();
  for (const [appName, app] of Object.entries(apps)) {
    if (!Array.isArray(app.domains) || !app.domains.includes(hostname)) continue;
    if (app.mode === 'connect') continue;
    const port = app.safe ? app.publicPort : app.port;
    if (!port) continue;
    return { name: hostname, appName, port: Number(port), fallback: slotFallback(app), app, public: true };
  }
  return null;
}

// Naming zones: one wildcard domain covers every app — <app>.<zone> routes to
// the app named <app> automatically, no per-app DNS record and no per-app
// attach step. The zone can belong to this owner or to a community that lent
// the name; either way the name is a LABEL (revocable by the zone) while the
// app's identity stays its own keys and machine.
function zoneTarget(hostname) {
  const zones = loadZones();
  for (const zone of Object.keys(zones)) {
    if (!hostname.endsWith('.' + zone)) continue;
    const label = hostname.slice(0, -(zone.length + 1));
    if (!label || label.includes('.')) continue; // only single-label apps under a zone
    const apps = loadApps();
    const app = apps[label];
    if (!app || app.mode === 'connect') continue;
    const port = app.safe ? app.publicPort : app.port;
    if (!port) continue;
    return { name: hostname, appName: label, port: Number(port), fallback: slotFallback(app), app, public: true, zone };
  }
  return null;
}

// The dashboard gets a name too: "gitlive" is reserved and routes to the
// control plane, so no part of the experience needs a numbered address.
function controlPort() {
  try {
    const url = fs.readFileSync(CONTROL_URL_FILE, 'utf8').trim();
    const m = url.match(/:(\d+)/);
    return m ? Number(m[1]) : 5180;
  } catch { return 5180; }
}

function isPidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function appAlive(app) {
  if (!app || !app.runPath) return null;
  try {
    const pidFile = app.safe ? path.join(app.runPath, 'proxy.pid') : path.join(app.runPath, 'app.pid');
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    return Boolean(pid && isPidAlive(pid));
  } catch { return false; }
}

function targetOf(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.gitlive$/, '');
  const raw = String(hostname || '').toLowerCase();
  if (h === 'gitlive') return { name: 'gitlive', port: controlPort(), fallback: null, reserved: true };
  if (raw && !raw.endsWith('.gitlive')) return publicTarget(raw) || zoneTarget(raw); // Tier 2: own domain or a zone name
  if (!h || h === raw) return null; // not a <name>.gitlive host
  const apps = loadApps();
  const app = apps[h];
  if (!app || app.mode === 'connect') return null;
  const port = app.safe ? app.publicPort : app.port;
  if (!port) return null;
  // Resilience for the field-proven failure "the safe-mode proxy died, so
  // every name 502s although the app itself is healthy": when the proxy port
  // refuses the connection, fall back to the app's ACTIVE slot (same code,
  // same data dir — the slot the proxy itself would have forwarded to).
  return { name: h, port: Number(port), fallback: slotFallback(app), app, alive: appAlive(app) };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The name page: what an app IS, at its own name, when it has no page of its
// own. Real facts only (status, mode, start command, recent deploys) — no
// invented features, no addresses the user has to parse. `reqLike` only needs
// url + headers (both http.IncomingMessage and the entry client's relayed
// request objects carry those).
function namePage(target, reqLike) {
  const req = reqLike || {};
  const host = String((req.headers && req.headers.host) || '');
  const scheme = req.socket && req.socket.encrypted ? 'https' : 'http';
  const portPart = host.includes(':') ? ':' + host.split(':').pop() : '';
  const app = target.app || {};
  let history = [];
  try {
    const raw = fs.readFileSync(path.join(app.runPath, 'deploy-history.jsonl'), 'utf8').trim().split('\n');
    history = raw.slice(-5).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { /* no history yet */ }
  const rows = history.map((h) => `<tr><td>${esc((h.commit || '').slice(0, 12))}</td><td class="${h.outcome === 'success' ? 'ok' : 'bad'}">${esc(h.outcome || '?')}</td><td>${esc(h.closure ? 'pinned' : '—')}</td><td>${esc((h.at || '').slice(0, 19).replace('T', ' '))}</td></tr>`).join('');
  const status = target.alive === true ? '<span class="ok">live</span>' : target.alive === false ? '<span class="bad">not running</span>' : '<span class="warn">unknown</span>';
  // The app's NAME is its identity — a zone or a borrowed domain is only where
  // it currently lives, so the page is titled with the name and mentions the
  // hostname separately.
  const label = target.appName || target.name;
  const hostNoPort = String((req.headers && req.headers.host) || '').split(':')[0];
  const where = (target.public || target.zone) && hostNoPort !== label ? ` · answering at ${esc(hostNoPort)}` : '';
  const canonical = app.primaryDomain ? `<p>Its own domain is <code>${esc(app.primaryDomain)}</code>${app.graduatedFrom ? ` (graduated from the borrowed label ${esc(label)}.${esc(app.graduatedFrom)})` : ''}.</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(label)} — gitlive</title>
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1.25rem}
 h1{margin:0 0 .25rem;font-size:2.25rem;letter-spacing:-.02em}
 .sub{color:#888;margin:0 0 1.75rem}
 .card{border:1px solid #8883;border-radius:12px;padding:1rem 1.25rem;margin:0 0 1rem}
 table{border-collapse:collapse;width:100%;font-size:14px}
 th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #8882}
 .ok{color:#1a7f37}.bad{color:#b3261e}.warn{color:#9a6700}
 code{background:#8881;padding:.1rem .35rem;border-radius:5px}
 .foot{color:#888;font-size:13px;margin-top:2rem}
 a{color:inherit}
</style></head><body>
<h1>${esc(label)}</h1>
<p class="sub">a gitlive app on this machine · ${status}${where}</p>
<div class="card">
  <p>This app has no page of its own here — it answered <code>${esc(req.url || '/')}</code> with nothing to show.
  That usually means it is an API or a service rather than a website.</p>
  <p style="margin-bottom:0">Still useful to know: start command <code>${esc(app.startCmd || '—')}</code>,
  mode <code>${esc(app.safe ? 'safe (blue-green)' : 'plain')}</code>, created ${esc((app.createdAt || '').slice(0, 10) || '—')}.</p>
</div>
${canonical ? `<div class="card">${canonical}</div>` : ''}
${rows ? `<div class="card"><strong>Recent deploys</strong><table><thead><tr><th>commit</th><th>result</th><th>closure</th><th>when</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
<div class="card">
  <a href="/health">/health</a> · <a href="${scheme}://gitlive.gitlive${portPart}/">open the gitlive dashboard</a>
</div>
<p class="foot">gitlive · your machine, your keys, your data · this page comes from gitlive, not from ${esc(label)}</p>
</body></html>`;
}

// Hop-by-hop headers must never survive a relay hop (RFC 7230 §6.1): each
// hop recomputes transfer framing, so forwarding them corrupts the stream.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);

function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(String(k).toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

module.exports = {
  APPS_JSON, CONTROL_URL_FILE, PUBLIC_DIR, ZONES_FILE,
  loadApps, loadZones, publicCertPaths, publicTarget, zoneTarget,
  controlPort, targetOf, appAlive, slotFallback, namePage, esc, filterHeaders, HOP_BY_HOP,
};
