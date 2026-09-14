'use strict';
// name office, phase 1 — gitlive as a DNS client: one zone with a DNS token
// turns every app into a globally visible name. A stub deSEC API (the same
// override seam acme.test.js uses, GITLIVE_DESEC_API) proves gitlive writes
// <app>.<zone> → this machine's public IPv6 through the provider, and that
// the honest failure paths (no zone, no token) never fabricate success.

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const fakeHome = fs.mkdtempSync(path.join(shortTmp, 'glname-'));
const env = { ...process.env, HOME: fakeHome };

// async spawn, NOT execFileSync — the documented acme lesson: a spawnSync
// parent freezes its loop and the child's fetch to the stub never lands.
function cli(args) {
  return new Promise((resolve) => {
    const child = spawn('node', [GITLIVE_JS, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

(async () => {
  // ── the stub deSEC API: records it receives, over a real HTTP server ────
  const received = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stub.unref(); // a failing assert must still let the process exit
  env.GITLIVE_DESEC_API = `http://127.0.0.1:${stub.address().port}/api/v1`;

  // a registered app under a zone with a token
  const appsDir = path.join(fakeHome, '.gitlive', 'apps');
  const runPath = path.join(appsDir, 'myapp-run');
  fs.mkdirSync(runPath, { recursive: true });
  const registry = {
    myapp: {
      cwd: '/tmp/fake-source', barePath: path.join(appsDir, 'myapp.git'), runPath,
      installCmd: 'npm install', startCmd: 'node server.js', port: '3100',
      domains: ['myapp.example.app'], createdAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), JSON.stringify(registry, null, 2));
  fs.mkdirSync(path.join(fakeHome, '.gitlive', 'domain'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.gitlive', 'domain', 'zones.json'), JSON.stringify({
    'example.app': { addedAt: new Date().toISOString(), dnsToken: 'tok-123' },
  }, null, 2));

  // 1 — publish writes the AAAA through the provider + receipts the fact
  const pub = await cli(['name', 'publish', 'myapp']);
  assert(pub.code === 0 && /\[name office\] myapp\.example\.app → [0-9a-f:]+/.test(pub.out), 'publish prints the record:\n' + pub.out);
  const put = received.find((r) => r.method === 'PUT' && /rrsets\/myapp\/AAAA/.test(r.url));
  assert(put, 'the provider received the AAAA write:\n' + JSON.stringify(received));
  assert(put.auth === 'Token tok-123', 'the zone token authorizes the call');
  assert(put.body && put.body.type === 'AAAA' && /^[0-9a-f:]+$/.test(String(put.body.records[0])), 'the record body is the machine\u2019s IPv6:\n' + JSON.stringify(put.body));
  assert(fs.existsSync(path.join(runPath, 'dns-history.jsonl')), 'the DNS write lands in a receipt file');
  const evts = fs.readFileSync(path.join(fakeHome, '.gitlive', 'events.log'), 'utf8');
  assert(/dns-publish/.test(evts), 'the DNS write is audited as an event');
  console.log('OK: name publish writes <app>.<zone> → public IPv6 through the token, receipted + audited');

  // 2 — phase 2: the first push auto-names the app (zone + token present)
  registry.myapp.domains = [];
  delete registry.myapp.zone;
  fs.writeFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), JSON.stringify(registry, null, 2));
  const auto = await cli(['name', 'publish', 'myapp']);
  assert(auto.code === 0 && /myapp\.example\.app → [0-9a-f:]+/.test(auto.out) && /claimed its name automatically/.test(auto.out), 'first push claims the name automatically:\n' + auto.out);
  const regAuto = JSON.parse(fs.readFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), 'utf8'));
  assert(regAuto.myapp.zone === 'example.app' && (regAuto.myapp.domains || []).includes('myapp.example.app'), 'the claimed label lands in the registry');
  const evts2 = fs.readFileSync(path.join(fakeHome, '.gitlive', 'events.log'), 'utf8');
  assert(/auto-named/.test(evts2), 'the auto-claim is audited');
  console.log('OK: first push auto-names the app — label claimed, published, audited');

  // 3 — honest refusal: zone registered but WITHOUT a token (nothing claimable)
  registry.myapp.domains = [];
  delete registry.myapp.zone;
  fs.writeFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), JSON.stringify(registry, null, 2));
  fs.writeFileSync(path.join(fakeHome, '.gitlive', 'domain', 'zones.json'), JSON.stringify({
    'example.app': { addedAt: new Date().toISOString() },
  }, null, 2));
  const noTok = await cli(['name', 'publish', 'myapp']);
  assert(noTok.code !== 0 && /register a zone with a DNS token/.test(noTok.out), 'publish without any token-bearing zone refuses honestly:\n' + noTok.out);

  // 4 — status reports the machine address + zones
  const st = await cli(['name', 'status']);
  assert(st.code === 0 && /this machine:/.test(st.out) && /example\.app/.test(st.out) && /missing/.test(st.out), 'status reports the machine + zone token state:\n' + st.out);
  console.log('OK: name status — machine address, zones, token state');

  // 5 — live DNS read-back (the diagnose chain): getRecord reports the zone's truth
  const readStub = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/missing\/AAAA\//.test(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return;
    }
    if (req.method === 'GET' && /\/live\/AAAA\//.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ records: ['2a00:ffff::1'] })); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  await new Promise((r) => readStub.listen(0, '127.0.0.1', r));
  const readApi = 'http://127.0.0.1:' + readStub.address().port;
  const prov = require('../acme.js').providers.desec;
  const got404 = await prov.getRecord({ token: 't', zone: 'example.app', subname: 'missing', type: 'AAAA', fetchImpl: (u, o) => fetch(readApi + new URL(u).pathname, o) });
  assert(got404.exists === false, 'getRecord reports a missing rrset honestly');
  const gotLive = await prov.getRecord({ token: 't', zone: 'example.app', subname: 'live', type: 'AAAA', fetchImpl: (u, o) => fetch(readApi + new URL(u).pathname, o) });
  assert(gotLive.exists === true && gotLive.values.includes('2a00:ffff::1'), 'getRecord returns the live values');
  readStub.close();
  console.log('OK: dns read-back (getRecord) — 404 + live values');

  stub.close();
  console.log('\nALL NAME OFFICE TESTS PASSED');
})().catch((err) => {
  console.error('NAME OFFICE TEST FAILED:', (err && err.message) || err);
  if (err && err.stdout) console.error(String(err.stdout).slice(0, 400));
  if (err && err.stderr) console.error(String(err.stderr).slice(0, 400));
  process.exitCode = 1;
});
