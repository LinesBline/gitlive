'use strict';
// `gitlive entry` — the public entry node for machines behind NAT.
//
// Two fake machines, real processes: E (entry) runs `gitlive entry serve`;
// H (behind NAT) runs `gitlive entry connect` against it and serves a real
// app on its loopback. The suite proves the whole relay end to end:
//   - browser traffic reaches E's port, E holds it, H's client polls it
//     over the OUTBOUND-only channel, serves from its own app, and E
//     relays the answer back (GET, POST bodies, streaming responses),
//   - domain routing follows the registry (attached domains + zone labels),
//   - unknown names 404, the bare address shows the directory,
//   - the token guards every control endpoint (bad token → 401),
//   - disconnect says bye and the routes drop.
// Everything runs on fake homes and explicit ports — never the real
// ~/.gitlive, never port 80/443.

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const homeE = fs.mkdtempSync(path.join(shortTmp, 'glentry-e-'));
const homeH = fs.mkdtempSync(path.join(shortTmp, 'glentry-h-'));
const entryPort = 45000 + Math.floor(Math.random() * 1000);

function cliE(args) { return execFileSync('node', [GITLIVE_JS, ...args], { env: { ...process.env, HOME: homeE }, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); }
function cliH(args) { return execFileSync('node', [GITLIVE_JS, ...args], { env: { ...process.env, HOME: homeH }, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); }

function fetchHost(hostname, port, method, reqBody, pathName) {
  // Raw http.request: fetch/undici forbids overriding the Host header.
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: method || 'GET',
      path: pathName || '/', headers: { host: hostname },
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function poll(fn, tries, every) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(every || 200);
  }
  return null;
}

(async () => {
  // ── machine H: registry + a real app + an API-style app + a zone ────────
  const appSrv = http.createServer((req, res) => {
    if (req.url === '/echo') {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => res.end('ECHO:' + Buffer.concat(chunks).toString()));
      return;
    }
    if (req.url === '/len') {
      let n = 0;
      req.on('data', (d) => { n += d.length; });
      req.on('end', () => res.end('LEN:' + n));
      return;
    }
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        setTimeout(() => res.end('data: three\n\n'), 250);
      }, 250);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('NOTES-OK\n');
  });
  await new Promise((r) => appSrv.listen(0, '127.0.0.1', r));
  const apiSrv = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no route\n'); });
  await new Promise((r) => apiSrv.listen(0, '127.0.0.1', r));
  const regDirH = path.join(homeH, '.gitlive');
  fs.mkdirSync(regDirH, { recursive: true });
  fs.mkdirSync(path.join(regDirH, 'domain'), { recursive: true });
  fs.writeFileSync(path.join(regDirH, 'apps.json'), JSON.stringify({
    notes: { mode: 'local', port: String(appSrv.address().port), installCmd: 'true', startCmd: 'node s.js', domains: ['notes.example.test'], createdAt: new Date().toISOString() },
    api: { mode: 'local', port: String(apiSrv.address().port), installCmd: 'true', startCmd: 'node s.js', domains: ['api.example.test'], createdAt: new Date().toISOString() },
  }, null, 2));
  fs.writeFileSync(path.join(regDirH, 'domain', 'zones.json'), JSON.stringify({ 'makers.test': { addedAt: new Date().toISOString() } }, null, 2));

  // ── 1) serve on E ────────────────────────────────────────────────────────
  const serveOut = cliE(['entry', 'serve', '--port', String(entryPort)]);
  assert(/running on this machine/.test(serveOut), 'serve must confirm:\n' + serveOut);
  const token = (serveOut.match(/--token ([A-Za-z0-9_-]+)/) || [])[1];
  assert(token, 'serve must print the connect command with a token:\n' + serveOut);
  const base = `http://127.0.0.1:${entryPort}`;
  let dirPage = await poll(async () => {
    const r = await fetchHost('127.0.0.1', entryPort).catch(() => null);
    return r && r.status === 200 && /gitlive entry/.test(r.body) ? r : null;
  }, 40);
  assert(dirPage, 'the entry server must answer its directory page');
  assert(/no home machine is connected/.test(dirPage.body), 'the directory must say no machine yet');

  // ── 1a) the token guards the control endpoints ───────────────────────────
  const badHello = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: entryPort, method: 'POST', path: '/entry/hello', headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ token: 'wrong-token', machine: 'x', domains: [] }));
  });
  assert(badHello === 401, `a wrong token must be refused (got ${badHello})`);

  // ── 2) connect from H (outbound only) ────────────────────────────────────
  const connectOut = cliH(['entry', 'connect', base, '--token', token]);
  assert(/connected to/.test(connectOut), 'connect must confirm:\n' + connectOut);
  assert(/notes\.example\.test/.test(connectOut) && /api\.example\.test/.test(connectOut), 'connect must list the routing domains:\n' + connectOut);
  assert(/notes\.makers\.test/.test(connectOut), 'zone labels must route too:\n' + connectOut);
  const pidFileH = path.join(regDirH, 'entry', 'client.pid');
  assert(fs.existsSync(pidFileH) && /^\d+$/.test(fs.readFileSync(pidFileH, 'utf8').trim()), 'the client must run detached with a pidfile');

  // ── 3) a browser on the internet reaches the app through the relay ──────
  const got = await poll(async () => {
    const r = await fetchHost('notes.example.test', entryPort).catch(() => null);
    return r && r.status === 200 && r.body.trim() === 'NOTES-OK' ? r : null;
  }, 60, 200);
  assert(got, 'the app must answer through the entry relay (E holds, H polls, serves, answers)');
  console.log('OK: entry relay — GET travels browser → entry → NAT machine → app and back');

  // ── 3a) POST bodies travel both ways; streaming responses too ────────────
  const echoed = await fetchHost('notes.example.test', entryPort, 'POST', 'ping-body', '/echo');
  assert(echoed.status === 200 && echoed.body === 'ECHO:ping-body', `POST bodies must relay intact (got ${JSON.stringify(echoed.body)})`);
  const zoneR = await fetchHost('notes.makers.test', entryPort);
  assert(zoneR.status === 200 && zoneR.body.trim() === 'NOTES-OK', 'a zone label must route through the entry too');

  // ── 3d) streaming: a 3 MB upload streams through (no 413 cliff) ──────────
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
  const lenRes = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: entryPort, method: 'POST', path: '/len', headers: { host: 'notes.example.test', 'content-length': String(big.length) } }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(big);
    req.end();
  });
  assert(lenRes.status === 200 && lenRes.body === 'LEN:' + big.length, `a 3 MB upload streams through un-buffered (got ${lenRes.status} ${lenRes.body.slice(0, 20)})`);

  // ── 3e) SSE streams through progressively, content-type preserved ────────
  const t0 = Date.now();
  const sse = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: entryPort, path: '/sse', headers: { host: 'notes.example.test' } }, (res) => {
      let b = '';
      let firstAt = null;
      res.on('data', (d) => { if (!firstAt) firstAt = Date.now(); b += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, firstAt }));
    });
    req.on('error', reject);
    req.end();
  });
  assert(sse.status === 200 && sse.headers['content-type'] === 'text/event-stream', 'SSE content-type survives the relay');
  assert(sse.body === 'data: one\n\ndata: two\n\ndata: three\n\n', 'the SSE stream arrives intact:\n' + JSON.stringify(sse.body));
  assert(sse.firstAt - t0 < Date.now() - t0 - 150, `SSE arrives PROGRESSIVELY (first chunk at +${sse.firstAt - t0}ms of ${Date.now() - t0}ms) — it is not buffered`);

  // ── 3b) the app always wins; an API-style app gets the name page ────────
  const apiR = await fetchHost('api.example.test', entryPort);
  assert(apiR.status === 200 && /<h1>api<\/h1>/.test(apiR.body), 'an app with no root page must get the gitlive name page over the entry:\n' + apiR.body.slice(0, 120));
  assert(/no page of its own here/.test(apiR.body), 'the name page must explain itself');

  // ── 3c) unknown names 404, no leaks ──────────────────────────────────────
  const unknown = await fetchHost('nope.example.test', entryPort);
  assert(unknown.status === 404 && /no connected gitlive app answers/.test(unknown.body), 'unknown hosts must 404 honestly');
  const dir2 = await fetchHost('127.0.0.1', entryPort);
  assert(dir2.body.includes('notes.example.test') && !dir2.body.includes('127.0.0.1'), 'the entry directory lists domains by name, not addresses');

  // ── 4) status on both sides ──────────────────────────────────────────────
  const statusH = cliH(['entry', 'status']);
  assert(/connected \(client running\)/.test(statusH), 'status on H must show the running client:\n' + statusH);
  const listE = cliE(['entry', 'list']);
  assert(/notes\.example\.test/.test(listE), 'entry list on E must show the routed domains:\n' + listE);

  // ── 5) disconnect says bye, routes drop ──────────────────────────────────
  const disc = cliH(['entry', 'disconnect']);
  assert(/disconnected/.test(disc), 'disconnect must confirm:\n' + disc);
  const dropped = await poll(async () => {
    const r = await fetchHost('notes.example.test', entryPort).catch(() => null);
    return r && r.status === 404 ? r : null;
  }, 40, 200);
  assert(dropped, 'after disconnect the entry must stop routing the domains');
  console.log('OK: token refused, connect/disconnect lifecycle, zone labels, name page, directory — all green');

  // ── cleanup ──────────────────────────────────────────────────────────────
  try { cliE(['entry', 'stop']); } catch { /* already gone */ }
  try {
    const p = fs.readFileSync(path.join(regDirH, 'entry', 'client.pid'), 'utf8').trim();
    process.kill(-Number(p));
  } catch { /* noop */ }
  appSrv.close(); apiSrv.close();
  console.log('ALL ENTRY TESTS PASSED');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
