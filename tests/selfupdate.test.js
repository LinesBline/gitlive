'use strict';
// self-update flow — the guards proven offline against stub npm registries:
// newer version reported only when SEMVER-newer (never a downgrade), and the
// update REFUSES without a backup snapshot. The actual npm install is never
// run in tests (that is the one live step the owner's machine performs).
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const fakeHome = fs.mkdtempSync(path.join('/tmp', 'glself-'));
const controlDir = path.join(fakeHome, '.gitlive', 'control');
fs.mkdirSync(path.join(fakeHome, '.gitlive', 'apps'), { recursive: true });
fs.mkdirSync(controlDir, { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), '{}\n');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
async function waitForServer(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('control server did not come up in time');
}
function startServer(port, npmVersion) {
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: npmVersion }));
  });
  return new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => {
      const npmPort = stub.address().port;
      const env = { ...process.env, HOME: fakeHome, GITLIVE_CONTROL_DIR: controlDir, GITLIVE_HEALTH_INTERVAL_MS: '200', GITLIVE_PUBLIC_NPM_URL: `http://127.0.0.1:${npmPort}/gitlive/latest` };
      const child = spawn('node', [GITLIVE_JS, 'serve', '--port', String(port), '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d) => { output += d; });
      child.stderr.on('data', (d) => { output += d; });
      resolve({
        child,
        stub,
        url: `http://127.0.0.1:${port}`,
        log: () => output,
        stop: () => new Promise((r2) => { stub.close(); child.on('exit', r2); child.kill('SIGTERM'); }),
      });
    });
  });
}
async function req(url, method, { token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

(async () => {
  // plane A: registry newer (9.9.9) → version says newer, update refuses (no backups)
  const portA = await freePort();
  const planeA = await startServer(portA, '9.9.9');
  try {
    await waitForServer(planeA.url + '/');
    let r = await req(planeA.url + '/api/auth/register', 'POST', { body: { email: 'self@example.com', password: 'hunter22' } });
    assert(r.status === 200 && r.data.ok, 'admin registers');
    r = await req(planeA.url + '/api/auth/login', 'POST', { body: { email: 'self@example.com', password: 'hunter22' } });
    const token = r.data.data.token;
    r = await req(planeA.url + '/api/self/version', 'GET', { token });
    assert(r.status === 200 && r.data.data.newer === true && r.data.data.latest === '9.9.9', 'version reports semver-newer:\n' + JSON.stringify(r.data).slice(0, 200));
    r = await req(planeA.url + '/api/self/update', 'POST', { token, body: {} });
    assert(r.status === 409 && r.data.error.code === 'CONFLICT' && /back up first/.test(r.data.error.message), 'update refuses without a backup snapshot:\n' + JSON.stringify(r.data).slice(0, 200));
    console.log('OK: newer detected + backup-first refusal');
  } finally { await planeA.stop(); }

  // plane B: registry OLDER than this build → never offers a "downgrade" as
  // an update (computed from the real VERSION so a release bump cannot break
  // the meaning of this test)
  const installed = require(path.join(__dirname, '..', 'gitlive.js')).VERSION;
  const olderParts = String(installed).split('.').map(Number);
  olderParts[olderParts.length - 1] = Math.max(0, (olderParts[olderParts.length - 1] || 0) - 1);
  const portB = await freePort();
  const planeB = await startServer(portB, olderParts.join('.'));
  try {
    await waitForServer(planeB.url + '/');
    let r = await req(planeB.url + '/api/auth/register', 'POST', { body: { email: 'self@example.com', password: 'hunter22' } });
    r = await req(planeB.url + '/api/auth/login', 'POST', { body: { email: 'self@example.com', password: 'hunter22' } });
    const token = r.data.data.token;
    r = await req(planeB.url + '/api/self/version', 'GET', { token });
    assert(r.status === 200 && r.data.data.newer === false, 'older registry is never offered as an update');
    r = await req(planeB.url + '/api/self/update', 'POST', { token, body: {} });
    assert(r.status === 409 && /nothing newer/.test(r.data.error.message), 'update refused when nothing newer exists');
    console.log('OK: semver-honest — an older registry never becomes a "update"');
  } finally { await planeB.stop(); }

  console.log('\nALL SELF-UPDATE TESTS PASSED');
})().catch((err) => {
  console.error('SELF-UPDATE TEST FAILED: ' + (err && err.message));
  process.exit(1);
});
