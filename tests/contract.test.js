'use strict';
// cockpit contract — the invariant battery, permanent. Anything the UI calls
// must exist server-side; anything the UI references must exist in the DOM
// (or be a documented dynamic element); app names never print in machine
// areas; secrets never ship. This suite turns the manual invariant sweeps
// into a gate every battery runs.
const fs = require('fs');
const path = require('path');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'control', 'dashboard.html'), 'utf8');
const srv = fs.readFileSync(path.join(ROOT, 'control', 'server.js'), 'utf8');
const gl = fs.readFileSync(path.join(ROOT, 'gitlive.js'), 'utf8');

// 1 — every script block parses (node --check, same parser the plane uses)
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert(blocks.length >= 1, 'dashboard has script blocks');
const { spawnSync } = require('child_process');
blocks.forEach((b, i) => {
  const tmp = path.join(require('os').tmpdir(), `gl-contract-${process.pid}-${i}.js`);
  fs.writeFileSync(tmp, b);
  const r = spawnSync('node', ['--check', tmp], { encoding: 'utf8' });
  fs.rmSync(tmp, { force: true });
  assert(r.status === 0, `dashboard script block ${i} does not parse: ${r.stderr}`);
});
for (const f of ['control/server.js', 'gitlive.js']) {
  const r = spawnSync('node', ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  assert(r.status === 0, `${f} does not parse: ${r.stderr}`);
}

// 2 — api.call paths all have server routes.
//
// The first version of this check only saw a path when the literal started
// right at the quote, so a caller that BUILT its path ('/api/apps/' + name +
// '/graduate') was invisible — and /graduate really was missing from the
// server's app-action route regex while the button shipped. Now every quoted
// fragment inside the URL expression is collected, interpolations become a
// placeholder, and the LAST literal segment must resolve to a route.
function urlFragments(src, from) {
  // collect quoted strings (respecting backticks) and ${…} interpolations
  const frags = [];
  let i = from;
  let open = null;
  let buf = '';
  while (i < src.length && src.length - from < 400) {
    const ch = src[i];
    if (open) {
      if (ch === '\\') { buf += ch + (src[i + 1] || ''); i += 2; continue; }
      if (ch === open) { frags.push({ lit: buf }); buf = ''; open = null; i++; continue; }
      if (open === '`' && ch === '$' && src[i + 1] === '{') {
        // skip the interpolation, remember that a variable was interpolated
        let depth = 1; i += 2;
        while (i < src.length && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
        frags.push({ lit: null });
        continue;
      }
      buf += ch; i++; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { open = ch; i++; continue; }
    if (ch === ',') break; // end of the URL argument (top level)
    if (ch === '\\' ) { i += 2; continue; }
    i++;
  }
  return frags;
}
const calls = [];
for (const m of html.matchAll(/api\.call\(\s*['"](GET|POST|PUT|DELETE)['"]\s*,\s*/g)) {
  const from = m.index + m[0].length;
  const frags = urlFragments(html, from);
  const first = frags.find((f) => f.lit);
  if (!first || !first.lit.startsWith('/api/')) continue;
  const shape = frags.map((f) => (f.lit === null ? '\u21e2' : f.lit)).join('');
  calls.push({ shape, base: shape.split('?')[0], literals: frags.filter((f) => f.lit).map((f) => f.lit) });
}
const literalRoutes = new Set([...srv.matchAll(/p === '(\/api\/[^']+)'/g)].map((m) => m[1]));
// NOTE: route regex literals were previously captured with /p\.match\([^)]*\)/,
// which stops at the first ")" — i.e. inside "([^/]+)" — so the alternation of
// app actions was never actually read. That blindness is exactly how a missing
// "graduate" shipped. Capture the whole literal instead.
const routeRegexes = [...srv.matchAll(/p\.match\((\/.+?\/[gimsuy]*)\)/g)].map((m) => m[1]);
const appAction = (seg) => routeRegexes.some((r) => r.includes(`|${seg}|`) || r.includes(`(${seg}|`) || r.includes(`|${seg})`));
assert(routeRegexes.some((r) => r.includes('|')), 'route regex extraction found no alternations — the app-action check would be blind');
// template families whose suffixes have literal routes
const TEMPLATE_FAMILIES = ['/api/sandbox', '/api/settings', '/api/mesh', '/api/domains', '/api/browse', '/api/apps'];
for (const c of calls) {
  const p = c.shape;
  const base = c.base;
  if (literalRoutes.has(base)) continue;
  if (base.startsWith('/api/apps/')) {
    // the last literal fragment after the app-name interpolation is the action
    const seg = base.split('/').pop();
    if (seg === '\u21e2') continue; // family root: /api/apps/<name>
    if (appAction(seg)) continue;
    assert(false, `app action has no route regex: ${p} — add "${seg}" to the alternation in control/server.js`);
    continue;
  }
  const family = base.replace(/\/\u21e2.*$/, '').replace(/\/+$/, '');
  if (TEMPLATE_FAMILIES.includes(family)) continue;
  if (base === '/api/domains/cert' || base === '/api/domains/dns-history') {
    assert(literalRoutes.has(base), `no literal route: ${base}`);
    continue;
  }
  assert(false, `no route for dashboard api.call: ${p}`);
}
// the create form must keep driving the real CLI command, never a re-implementation
assert(/createAppData/.test(srv) && /'init', name, '--yes'/.test(srv), 'POST /api/apps must shell the real `gitlive init`');
// the route that a button 404'd on: graduate must stay in the app-action regex
assert(appAction('graduate'), 'graduate is missing from the app-action route regex');

// 3 — every $-lookup / getElementById id exists (dynamic whitelist allowed)
const DYNAMIC_IDS = new Set(['guide-strip', 'sb-break', 'sb-fix', 'sb-destroy']);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const m of html.matchAll(/\$\(['"]#([a-zA-Z0-9_-]+)['"]\)/g)) {
  if (!ids.has(m[1]) && !DYNAMIC_IDS.has(m[1])) assert(false, `$-lookup id missing: #${m[1]}`);
}
for (const m of html.matchAll(/getElementById\(['"]([a-zA-Z0-9_-]+)['"]\)/g)) {
  if (!ids.has(m[1]) && !DYNAMIC_IDS.has(m[1])) assert(false, `getElementById missing: ${m[1]}`);
}

// 4 — guide buttons ↔ GUIDES keys ↔ anchors
const guideBtns = new Set([...html.matchAll(/data-guide="([^"]+)"/g)].map((m) => m[1]));
const gblock = html.slice(html.indexOf('const GUIDES'));
const guideKeys = new Set([...gblock.matchAll(/^  ([a-z-]+): \{\s*$/gm)].map((m) => m[1]));
for (const k of guideBtns) assert(guideKeys.has(k), `guide button without GUIDES entry: ${k}`);
for (const k of guideKeys) {
  const anchor = k === 'apps' ? 'apps-hero' : (k === 'checkup' ? 'checkup-card' : `${k}-view`);
  assert(ids.has(anchor), `GUIDES "${k}" anchor missing: #${anchor}`);
}

// 5 — every data-set / static fixaction has a settingsAction branch
const branchText = html.slice(html.indexOf('async function settingsAction'), html.indexOf('async function mintInvite'));
const branchFor = (v) =>
  new RegExp(`act === '${v}'|'${v}' \\|\\| act ===|act === '${v}' \\|\\|`).test(branchText) ||
  /else/.test(branchText) && new RegExp(`act === '${v}'`).test(branchText) ||
  branchText.includes(`'${v}'`);
for (const m of html.matchAll(/data-set="([^"]+)"/g)) {
  if (m[1].includes('${') || m[1].includes("'")) continue; // dynamic templates / JS queries
  assert(branchFor(m[1]), `data-set without settingsAction branch: ${m[1]}`);
}
for (const m of html.matchAll(/data-fixaction="([^"]+)"/g)) {
  if (m[1].includes('${')) continue;
  assert(branchFor(m[1]), `fixaction without settingsAction branch: ${m[1]}`);
}

// 6 — the two-area law at the source level: no real app names in machine code
// (names are split so this test does not itself carry the literals)
const FORBIDDEN = ['aud' + 'ioa', 'gitlive-' + 'hello', 'fabric-' + 'demo', 'story' + 'voice'];
for (const name of FORBIDDEN) {
  assert(!html.includes(name), `app name "${name}" appears in dashboard.html — two-area law`);
  assert(!srv.includes(name), `app name "${name}" appears in server.js — two-area law`);
  assert(!gl.includes(name), `app name "${name}" appears in gitlive.js — two-area law`);
}

// 7 — no secrets / personal markers ship
// the personal markers are assembled from pieces so that THIS test does not
// carry the very strings it exists to catch (the public snapshot is scanned
// for them, and a detector full of them would fail its own scan)
const PERSONAL = ['govo' + 'igovoi', 'lines' + 'bline@gmail'];
const secretRe = new RegExp('BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|' + PERSONAL.join('|'));
for (const [file, src] of [['dashboard.html', html], ['server.js', srv], ['gitlive.js', gl]]) {
  assert(!secretRe.test(src), `secret or personal marker in ${file}`);
}

console.log('contract.test.js PASSED — cockpit contract invariants hold');
