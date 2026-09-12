'use strict';
// `gitlive domain local` — Tier 1 naming: apps answer at <name>.gitlive.
//
// Owner direction (2026-09-09): apps are NAMED, not numbered; localhost
// naming takes away from the maker's effort. This suite proves the two
// local pieces end to end with real processes:
//   - hosts entries are surgically managed (the user's own hosts content
//     survives the rewrite),
//   - the routing gateway maps "Host: <name>.gitlive" to the right app
//     (two real servers, routed independently), unknown names 404, and the
//     directory page lists apps by name with no raw addresses or ports.
// Everything runs on fake homes and a fake hosts file (GITLIVE_HOSTS_FILE),
// never touching /etc/hosts or port 80.

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'gldom-'));
const hostsFile = path.join(shortTmp, `gldom-hosts-${Date.now()}`);
fs.writeFileSync(hostsFile, '127.0.0.1\tuser-owned.example\n');
const gatewayPort = 48000 + Math.floor(Math.random() * 1000);
const tlsPort = 49000 + Math.floor(Math.random() * 1000);
const env = { ...process.env, HOME: home, GITLIVE_HOSTS_FILE: hostsFile, GITLIVE_GATEWAY_PORT: String(gatewayPort), GITLIVE_GATEWAY_TLS_PORT: String(tlsPort) };

function cli(args, cwd) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: cwd || proj, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function hosts() { return fs.readFileSync(hostsFile, 'utf8'); }

// Two real target servers, each answering only when routed correctly.
const targets = {};
function serve(name, marker) {
  const srv = http.createServer((q, r) => r.end(`${marker}\n`));
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => {
    targets[name] = { srv, port: srv.address().port, marker };
    res();
  }));
}
function fetchHost(hostname, p, method, reqBody, pathName) {
  // Raw http.request: fetch/undici forbids overriding the Host header.
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: p, path: pathName || '/', method: method || 'GET', headers: { host: hostname } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}
function killPid(pid) {
  try { process.kill(-Number(pid)); } catch { try { process.kill(Number(pid)); } catch { /* gone */ } }
}

let proj;
(async () => {
  proj = fs.mkdtempSync(path.join(shortTmp, 'gldom-proj-'));
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'domproj' }));
  await serve('one', 'ONE-OK');
  await serve('two', 'TWO-OK');
  // an API-style app: nothing at "/", 404 everywhere
  await new Promise((res) => {
    const srv = http.createServer((q, r) => { r.writeHead(404, { 'content-type': 'text/plain' }); r.end('no route\n'); });
    srv.listen(0, '127.0.0.1', () => { targets.api = { srv, port: srv.address().port, marker: 'API-404' }; res(); });
  });
  // the control plane stand-in, reached through the reserved gitlive name
  await serve('control', 'CONTROL-OK');

  // Handcraft a registry with two plain apps pointing at the real servers
  // (routing reads only name + port — hooks/deploys are out of scope here).
  const regDir = path.join(home, '.gitlive');
  fs.mkdirSync(regDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.gitlive', 'domain'), { recursive: true });
  fs.writeFileSync(path.join(regDir, 'apps.json'), JSON.stringify({
    one: { mode: 'local', port: String(targets.one.port), installCmd: 'true', startCmd: 'node s.js', createdAt: new Date().toISOString() },
    two: { mode: 'local', port: String(targets.two.port), installCmd: 'true', startCmd: 'node s.js', createdAt: new Date().toISOString() },
    api: { mode: 'local', port: String(targets.api.port), installCmd: 'true', startCmd: 'node s.js', createdAt: new Date().toISOString() },
    connapp: { mode: 'connect', port: '1', cwd: '/tmp' }, // must never be routed or listed
  }, null, 2));
  // reserved name: the dashboard answers at gitlive.gitlive via control.url
  fs.writeFileSync(path.join(regDir, 'control.url'), `http://127.0.0.1:${targets.control.port}`);

  // ── 1) on: hosts entries added surgically, gateway up, routing works ──
  // (tls first, so the gateway comes up with its https listener too)
  const tlsOut = cli(['domain', 'local', 'tls'], proj);
  assert(/local CA created/.test(tlsOut) && /certificate issued/.test(tlsOut), 'tls must create the CA and issue a cert:\n' + tlsOut);
  assert(/security add-trusted-cert/.test(tlsOut), 'tls must print the one-time trust command');
  const tlsDir = path.join(regDir, 'domain');
  assert(fs.existsSync(path.join(tlsDir, 'ca.pem')) && fs.existsSync(path.join(tlsDir, 'server.crt')), 'CA + server cert files must exist');
  const verify = execFileSync('openssl', ['verify', '-CAfile', path.join(tlsDir, 'ca.pem'), path.join(tlsDir, 'server.crt')], { encoding: 'utf8' });
  assert(/OK/.test(verify), 'server cert must verify against the local CA: ' + verify);
  const certText = execFileSync('openssl', ['x509', '-in', path.join(tlsDir, 'server.crt'), '-noout', '-text'], { encoding: 'utf8' });
  assert(certText.includes('DNS:one.gitlive') && certText.includes('DNS:two.gitlive'), 'cert must cover the app names');
  assert(certText.includes('DNS:gitlive.gitlive'), 'cert must cover the reserved gitlive name (the dashboard)');

  const onOut = cli(['domain', 'local', 'on'], proj);
  assert(/local names ON for 3 apps/.test(onOut), 'on must report the app count:\n' + onOut);
  const h = hosts();
  assert(h.includes('127.0.0.1\tone.gitlive') && h.includes('127.0.0.1\ttwo.gitlive'), 'hosts entries for both apps must exist:\n' + h);
  assert(!h.includes('connapp.gitlive'), 'connect-mode apps must not get local names');
  assert(h.includes('127.0.0.1\tuser-owned.example'), 'user hosts content must survive the managed rewrite:\n' + h);
  assert(!h.includes('localhost'), 'managed block must not mention localhost');

  // gateway pid appears (spawned detached); poll for routing readiness
  const pidFile = path.join(regDir, 'domain', 'gateway.pid');
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    try {
      if (fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8').trim()) > 0) {
        const r = await fetchHost('one.gitlive', gatewayPort);
        up = r.status === 200 && r.body.trim() === 'ONE-OK';
      }
    } catch { /* not ready */ }
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  assert(up, 'gateway must route one.gitlive to the one server');
  const twoR = await fetchHost('two.gitlive', gatewayPort);
  assert(twoR.status === 200 && twoR.body.trim() === 'TWO-OK', 'gateway must route two.gitlive to the two server');
  const unknownR = await fetchHost('nope.gitlive', gatewayPort);
  assert(unknownR.status === 404 && /no gitlive app answers/.test(unknownR.body), 'unknown names must 404 with a plain message');
  const dirR = await fetchHost('127.0.0.1', gatewayPort); // no Host → directory page
  const dirBody = dirR.body;
  assert(dirBody.includes('http://one.gitlive/') && dirBody.includes('http://two.gitlive/'), 'directory page must list apps by name');
  assert(!dirBody.includes('connapp') && !dirBody.includes('localhost'), 'directory page must omit connect apps and raw addresses');
  console.log('OK: local names on — hosts managed surgically, gateway routes each app by name, unknown 404s, directory lists names only');

  // ── 1a) https: same routing over TLS with the local CA's certificate ──
  const tlsRes = await new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: tlsPort, path: '/', headers: { host: 'one.gitlive' }, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  assert(tlsRes.status === 200 && tlsRes.body.trim() === 'ONE-OK', 'https must route one.gitlive to the one server');
  console.log('OK: https — the same names answer over TLS with the local CA certificate');

  // ── 1b-page) the name page: apps with nothing at "/" get a gitlive page,
  // apps that DO have a page pass through untouched.
  const page = await fetchHost('api.gitlive', gatewayPort);
  assert(page.status === 200 && page.body.includes('<h1>api</h1>'), 'an app with no root page must get the gitlive name page:\n' + page.body.slice(0, 200));
  assert(/no page of its own here/.test(page.body), 'the name page must explain why it is showing');
  assert(page.body.includes('node s.js') && page.body.includes('plain'), 'the name page must carry the app\'s real facts');
  assert(!page.body.includes('localhost'), 'the name page must not leak raw addresses');
  const passthrough = await fetchHost('one.gitlive', gatewayPort);
  assert(passthrough.status === 200 && passthrough.body.trim() === 'ONE-OK', 'an app WITH a root page must pass through untouched (the app always wins)');
  const dash = await fetchHost('gitlive.gitlive', gatewayPort);
  assert(dash.status === 200 && dash.body.trim() === 'CONTROL-OK', 'the reserved gitlive name must route to the dashboard');
  const dir2 = await fetchHost('127.0.0.1', gatewayPort);
  assert(dir2.body.includes('gitlive — dashboard'), 'the directory must offer the dashboard by name');
  console.log('OK: name page for apps with no page of their own; real pages pass through; dashboard answers at gitlive.gitlive');

  // ── 1b) admin-appended path: hosts read-only but ALREADY carrying the
  // names → `on` must start the gateway anyway, not demand another admin.
  cli(['domain', 'local', 'off'], proj); // clean state (writable fake hosts)
  fs.appendFileSync(hostsFile, '# gitlive local domains (managed — do not edit)\n127.0.0.1\tgitlive.gitlive\n127.0.0.1\tapi.gitlive\n127.0.0.1\tone.gitlive\n127.0.0.1\ttwo.gitlive\n# end gitlive local domains\n');
  fs.chmodSync(hostsFile, 0o444); // the user appended as admin; gitlive can no longer write
  const onReadonly = cli(['domain', 'local', 'on'], proj);
  assert(/already carries your names/.test(onReadonly), 'read-only-but-present hosts must proceed:\n' + onReadonly);
  let up2 = false;
  for (let i = 0; i < 30 && !up2; i++) {
    try { const r = await fetchHost('one.gitlive', gatewayPort); up2 = r.status === 200 && r.body.trim() === 'ONE-OK'; } catch { /* retry */ }
    if (!up2) await new Promise((r) => setTimeout(r, 200));
  }
  assert(up2, 'gateway must route after the admin-appended path');
  fs.chmodSync(hostsFile, 0o644);
  console.log('OK: admin-appended hosts — gateway proceeds without another admin moment');

  // ── 1c) proxy-down resilience: a safe app whose proxy port refuses must be
  // served from its ACTIVE slot (same code the proxy would have forwarded to)
  // instead of 502ing — the field failure "proxy died, every name breaks".
  const deadPort = 49000 + Math.floor(Math.random() * 500); // nothing listens here
  const slotDir = path.join(home, '.gitlive', 'apps', 'safeapp-run');
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, 'active-slot'), 'A');
  const regNow = JSON.parse(fs.readFileSync(path.join(regDir, 'apps.json'), 'utf8'));
  regNow.safeapp = { mode: 'local', safe: true, port: String(deadPort), publicPort: deadPort, portA: targets.one.port, portB: targets.two.port, runPath: slotDir, installCmd: 'true', startCmd: 'node s.js', createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(regDir, 'apps.json'), JSON.stringify(regNow, null, 2));
  const viaSlot = await fetchHost('safeapp.gitlive', gatewayPort);
  assert(viaSlot.status === 200 && viaSlot.body.trim() === 'ONE-OK', `proxy-down fallback must serve the active slot (got ${viaSlot.status} ${JSON.stringify(viaSlot.body.slice(0, 60))})`);
  console.log('OK: proxy-down resilience — gateway serves the active slot when the proxy port refuses');

  // ── 1d) Tier 2: the owner's own public domain ────────────────────────────
  const pubOut = cli(['domain', 'public', 'one', '--domain', 'notes.example.test', '--ip', '203.0.113.9'], proj);
  assert(/notes\.example\.test → one/.test(pubOut), 'public attach must report the mapping:\n' + pubOut);
  assert(/YOUR registrar/.test(pubOut), "the copy must make clear the domain is the owner's, not gitlive's");
  const routed = await fetchHost('notes.example.test', gatewayPort);
  assert(routed.status === 200 && routed.body.trim() === 'ONE-OK', 'a public domain must route to its app');
  const listPub = cli(['domain', 'public', 'list'], proj);
  assert(/notes\.example\.test\s+→\s+one/.test(listPub), 'public list must show the mapping');

  const pubKey = path.join(tlsDir, 'pub.key');
  const pubCsr = path.join(tlsDir, 'pub.csr');
  const pubCrt = path.join(tlsDir, 'pub.crt');
  const pubExt = path.join(tlsDir, 'pub.ext');
  fs.writeFileSync(pubExt, 'subjectAltName=DNS:notes.example.test\nextendedKeyUsage=serverAuth\n');
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', pubKey, '-out', pubCsr, '-subj', '/CN=notes.example.test'], { encoding: 'utf8' });
  execFileSync('openssl', ['x509', '-req', '-in', pubCsr, '-CA', path.join(tlsDir, 'ca.pem'), '-CAkey', path.join(tlsDir, 'ca.key'),
    '-CAcreateserial', '-out', pubCrt, '-days', '365', '-sha256', '-extfile', pubExt], { encoding: 'utf8' });
  const certOut = cli(['domain', 'public', 'one', '--domain', 'notes.example.test', '--cert', pubCrt, '--key', pubKey], proj);
  assert(/certificate installed/.test(certOut), 'installing a certificate must be confirmed:\n' + certOut);
  const pubTls = await new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: tlsPort, path: '/', headers: { host: 'notes.example.test' }, servername: 'notes.example.test', ca: fs.readFileSync(path.join(tlsDir, 'ca.pem')), rejectUnauthorized: true }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
  assert(pubTls.status === 200 && pubTls.body.trim() === 'ONE-OK', "the public domain must answer over TLS with the owner's certificate (SNI)");

  const badExt = path.join(tlsDir, 'bad.ext');
  fs.writeFileSync(badExt, 'subjectAltName=DNS:other.example.test\n');
  const badKey = path.join(tlsDir, 'bad.key');
  const badCrt = path.join(tlsDir, 'bad.crt');
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', badKey, '-out', path.join(tlsDir, 'bad.csr'), '-subj', '/CN=other.example.test'], { encoding: 'utf8' });
  execFileSync('openssl', ['x509', '-req', '-in', path.join(tlsDir, 'bad.csr'), '-CA', path.join(tlsDir, 'ca.pem'), '-CAkey', path.join(tlsDir, 'ca.key'),
    '-CAcreateserial', '-out', badCrt, '-days', '365', '-sha256', '-extfile', badExt], { encoding: 'utf8' });
  let refused = false;
  let refusedOut = '';
  try { cli(['domain', 'public', 'one', '--domain', 'notes.example.test', '--cert', badCrt, '--key', badKey], proj); }
  catch (err) { refused = true; refusedOut = String(err.stdout || '') + String(err.stderr || ''); }
  assert(refused && /does not cover/.test(refusedOut), 'a certificate for another domain must be refused:\n' + refusedOut);

  // ── 1e) naming zone: one wildcard domain covers every app ───────────────
  const zoneOut = cli(['domain', 'zone', 'makers.test', '--ip', '203.0.113.9'], proj);
  assert(/zone makers\.test registered/.test(zoneOut), 'zone registration must be confirmed:\n' + zoneOut);
  assert(/\*\.makers\.test/.test(zoneOut), 'zone must print the wildcard record');
  assert(/lent to apps, never owned by gitlive/.test(zoneOut), 'the copy must say zone names are borrowed labels');
  // every app answers under the zone with no per-app attach step
  const viaZone = await fetchHost('one.makers.test', gatewayPort);
  assert(viaZone.status === 200 && viaZone.body.trim() === 'ONE-OK', 'a zone name must route to the app of that name automatically');
  const viaZone2 = await fetchHost('api.makers.test', gatewayPort);
  assert(viaZone2.status === 200 && viaZone2.body.includes('<h1>api</h1>'), 'zone names work for the name page too');
  // attaching under a zone needs no new DNS instructions
  const inZone = cli(['domain', 'public', 'two', '--domain', 'two.makers.test'], proj);
  assert(/Covered by your zone makers\.test/.test(inZone), 'a zone-covered attach must not ask for another DNS record:\n' + inZone);
  const zoneList = cli(['domain', 'zone', 'list'], proj);
  assert(/makers\.test/.test(zoneList), 'zone list must show the zone');
  console.log('OK: naming zone — one wildcard record, every app named under it, no per-app DNS work');

  // ── 1f) the name office (P6): the zone apex hosts the offering page ──────
  const office = await fetchHost('makers.test', gatewayPort);
  assert(office.status === 200 && /name office/.test(office.body), 'the zone apex serves the name office:\n' + office.body.slice(0, 120));
  assert(/graduate/.test(office.body) && /loan, never a claim/.test(office.body), 'the office states the loan + graduation story');
  const checkTaken = await fetchHost('makers.test', gatewayPort, 'GET', null, '/.well-known/gitlive/zone-check?name=one');
  assert(checkTaken.status === 200 && JSON.parse(checkTaken.body).taken === true && JSON.parse(checkTaken.body).appName === 'one', 'the name check reports taken apps:\n' + checkTaken.body);
  const checkFree = await fetchHost('makers.test', gatewayPort, 'GET', null, '/.well-known/gitlive/zone-check?name=freebie');
  assert(checkFree.status === 200 && JSON.parse(checkFree.body).taken === false, 'the name check reports free names:\n' + checkFree.body);
  const viaZoneStill = await fetchHost('one.makers.test', gatewayPort);
  assert(viaZoneStill.status === 200 && viaZoneStill.body.trim() === 'ONE-OK', 'the app ALWAYS wins — <app>.<zone> keeps routing to the app, not the office');
  const nonZoneCheck = await fetchHost('nope.example.test', gatewayPort, 'GET', null, '/.well-known/gitlive/zone-check?name=x');
  assert(nonZoneCheck.status === 404, 'a non-zone host gets no name check');
  console.log('OK: name office — the zone apex offers names honestly, checks scoped to this machine, the app always wins');

  const detach = cli(['domain', 'public', '--remove', 'notes.example.test'], proj);
  assert(/detached/.test(detach), 'detach must confirm:\n' + detach);
  const afterRemove = await fetchHost('notes.example.test', gatewayPort);
  assert(afterRemove.status === 404, 'a detached domain must stop routing');
  console.log('OK: Tier 2 — public routing, owner certificate over SNI (CA-verified), mismatch refused, detach clean');

  // ── 2) off: entries gone, gateway stopped ──
  const offOut = cli(['domain', 'local', 'off'], proj);
  assert(/local names OFF/.test(offOut), 'off must confirm:\n' + offOut);
  const h2 = hosts();
  assert(!h2.includes('one.gitlive') && !h2.includes('two.gitlive'), 'hosts entries must be removed on off');
  assert(h2.includes('user-owned.example'), 'user hosts content must survive off too:\n' + h2);
  let dead = true;
  try { const pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); process.kill(pid, 0); dead = false; } catch { dead = true; }
  assert(dead, 'gateway process must be stopped on off');
  console.log('OK: local names off — entries removed, gateway stopped, user hosts content intact');

  // ── 3) list reflects state; no-arg prints usage ──
  const listOut = cli(['domain', 'local', 'list'], proj);
  assert(/local names: off/.test(listOut), 'list must report off state:\n' + listOut);
  let usageFailed = false;
  try { cli(['domain', 'local'], proj); } catch { usageFailed = true; }
  assert(usageFailed, 'bare `domain local` must fail with usage');
  console.log('OK: list reports state honestly, bare subcommand fails with usage');

  // ── 4) cleanup: kill any leftover gateway + servers ──
  try { const pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); killPid(pid); } catch { /* none */ }
  for (const t of Object.values(targets)) t.srv.close();
  console.log('ALL DOMAIN NAME TESTS PASSED');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
