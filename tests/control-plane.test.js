'use strict';
// Phase 1 control-plane end-to-end test — REAL server child process, REAL
// HTTP, fake $HOME (same discipline as backend-integration.test.js). Starts
// `gitlive serve` as an actual child, drives register/login/apps/actions/
// nodes through the wire, and runs `gitlive agent connect` as another real
// CLI child against the same control dir.

const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
// Long $TMPDIR paths overflow the Unix socket limit and slow sqlite; /tmp is
// short on macOS and Linux (same reasoning as backend-integration.test.js).
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const fakeHome = fs.mkdtempSync(path.join(shortTmp, 'gitlive-control-home-'));
const controlDir = path.join(fakeHome, '.gitlive', 'control');
fs.mkdirSync(controlDir, { recursive: true });

// Hand-build a registry entry (as if `gitlive init` had run) so list/status/
// logs have one real app to report, no git repo needed.
const appsDir = path.join(fakeHome, '.gitlive', 'apps');
const runPath = path.join(appsDir, 'myapp-run');
fs.mkdirSync(runPath, { recursive: true });
const registry = {
  myapp: {
    cwd: '/tmp/fake-myapp-source',
    barePath: path.join(appsDir, 'myapp.git'),
    runPath,
    installCmd: 'npm install',
    startCmd: 'node server.js',
    port: '3100',
    createdAt: new Date().toISOString(),
  },
};
fs.writeFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), JSON.stringify(registry, null, 2));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// an oversized serve.log exists BEFORE the plane starts — the boot-time
// rotation must trim it (a machine running for months must not fill its disk)
fs.mkdirSync(controlDir, { recursive: true });
fs.writeFileSync(path.join(controlDir, 'serve.log'), 'x'.repeat(6 * 1024 * 1024));

const env = { ...process.env, HOME: fakeHome, GITLIVE_CONTROL_DIR: controlDir, GITLIVE_HEALTH_INTERVAL_MS: '200', GITLIVE_CRON_INTERVAL_MS: '400', GITLIVE_MAINTENANCE: '0' };

function cli(args) {
  return execFileSync('node', [GITLIVE_JS, ...args], { env, encoding: 'utf8' });
}

async function waitForServer(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('control server did not come up in time');
}

// generic async predicate poller (used by the sandbox block)
async function waitFor(fn, what, tries = 40, gapMs = 400) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  throw new Error('timeout waiting for: ' + what);
}

function startServer(port) {
  const child = spawn('node', [GITLIVE_JS, 'serve', '--port', String(port), '--no-open'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return {
    child,
    url: `http://127.0.0.1:${port}`,
    log: () => output,
    stop: () => new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGTERM'); }),
  };
}

async function req(url, method, { token, body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; } // HTML (dashboard) stays a string
  return { status: res.status, data };
}

(async () => {
  const port = await freePort();
  const server = startServer(port);
  const base = server.url;
  try {
    await waitForServer(base + '/');

    // 0b — single-instance lock: a second `serve` reuses the running one
    const second = cli(['serve', '--port', String(port), '--no-open']);
    assert(/already running/.test(second), 'second serve must reuse the running instance:\n' + second);
    const urlFile = path.join(fakeHome, '.gitlive', 'control.url');
    assert(fs.existsSync(urlFile) && fs.readFileSync(urlFile, 'utf8').trim() === base, 'control.url marker carries the one URL');
    console.log('OK: second serve reuses the running instance — one localhost, not two');

    // 0c — node identity: meta carries the handle; whoami works
    const metaPub = await req(base + '/api/meta', 'GET');
    const metaInner = metaPub.data && metaPub.data.data;
    assert(metaInner && metaInner.node && typeof metaInner.node.handle === 'string' && metaInner.node.handle.length > 0, 'meta carries a node handle: ' + JSON.stringify(metaPub.data));
    const whoOut = cli(['mesh', 'whoami']);
    assert(/@/.test(whoOut), 'whoami prints handle@node:\n' + whoOut);
    console.log('OK: control plane identifies its node (handle in /api/meta, gitlive mesh whoami)');

    // 1 — unauthenticated access is refused
    let r = await req(base + '/api/apps', 'GET');
    assert(r.status === 401 && r.data.ok === false && r.data.error.code === 'UNAUTHENTICATED', 'apps without token must 401');

    // 2 — admin registration (first account), duplicate rejected
    r = await req(base + '/api/auth/register', 'POST', { body: { email: 'Admin@Example.com', password: 'hunter22' } });
    assert(r.status === 200 && r.data.ok && r.data.data.email === 'admin@example.com', 'first registration becomes admin (email normalized)');
    r = await req(base + '/api/auth/register', 'POST', { body: { email: 'other@example.com', password: 'hunter22' } });
    assert(r.status === 403 && r.data.error.code === 'REGISTRATION_CLOSED', 'second registration refused without --allow-register');

    // 3 — login: wrong password 401, right password gives a session
    r = await req(base + '/api/auth/login', 'POST', { body: { email: 'admin@example.com', password: 'wrong' } });
    assert(r.status === 401 && r.data.error.code === 'AUTH_ERROR', 'wrong password must 401');
    r = await req(base + '/api/auth/login', 'POST', { body: { email: 'admin@example.com', password: 'hunter22' } });
    assert(r.status === 200 && r.data.data.token, 'login returns a session token');
    let token = r.data.data.token;

    // 3b — logins land in the audit events log (login-fail for the wrong
    // password above, login for the success) — read the server's own file
    const loginEvts = JSON.parse('[' + fs.readFileSync(path.join(fakeHome, '.gitlive', 'events.log'), 'utf8').trim().split('\n').join(',') + ']');
    assert(loginEvts.some((e) => e.kind === 'login-fail' && /admin@example\.com/.test(JSON.stringify(e.detail))), 'failed login audited');
    assert(loginEvts.some((e) => e.kind === 'login' && /admin@example\.com/.test(JSON.stringify(e.detail))), 'successful login audited');
    console.log('OK: control-plane logins (success + failure) recorded in the audit events log');

    // 4 — /api/me
    r = await req(base + '/api/me', 'GET', { token });
    assert(r.data.ok && r.data.data.email === 'admin@example.com', '/api/me returns the session user');

    // 4b — ops views (redesign round): peers, keys, invite
    r = await req(base + '/api/peers', 'GET', { token });
    assert(r.data.ok && Array.isArray(r.data.data.peers), 'peers endpoint shape');
    r = await req(base + '/api/keys', 'GET', { token });
    assert(r.data.ok && r.data.data.ownerKey && r.data.data.nodeKey && r.data.data.storageKey, 'keys endpoint shape');
    // invite before any owner key exists → clean refusal
    r = await req(base + '/api/mesh/invite', 'POST', { token, body: { name: 'friend', ttlHours: 24 } });
    assert(r.status === 409 && r.data.ok === false, 'invite without owner key refused cleanly');
    // after keygen on the fake home, the invite mints
    cli(['manifest', 'keygen']);
    r = await req(base + '/api/mesh/invite', 'POST', { token, body: { name: 'friend', ttlHours: 24 } });
    assert(r.data.ok && typeof r.data.data.token === 'string' && r.data.data.token.length > 80, 'invite mints after keygen');
    r = await req(base + '/api/keys', 'GET', { token });
    assert(r.data.data.ownerKey.present === true && typeof r.data.data.ownerKey.fingerprint === 'string', 'keys reflect the new owner key');
    console.log('OK: ops views served — peers/keys/invite endpoints');

    // 4c — events tail + duress/dead-man/rotation status (audit card)
    // fixtures under the fake home: an event log, a rotation ledger, a future
    // dead-man deadline, and a passphrase-wrapped storage key
    const cryptMod = require('../crypt.js');
    const home = path.join(fakeHome, '.gitlive');
    fs.writeFileSync(path.join(home, 'events.log'),
      [JSON.stringify({ at: '2026-09-08T10:00:00.000Z', kind: 'duress', detail: 'duress trigger' }),
        JSON.stringify({ at: '2026-09-08T11:00:00.000Z', kind: 'deadman', detail: 'dead-man armed' }),
        JSON.stringify({ at: '2026-09-08T12:00:00.000Z', kind: 'keys', detail: 'storage key rotated' })].join('\n') + '\n');
    fs.writeFileSync(path.join(home, 'rotations.log'), '2026-09-08T10:00:00Z rotate\n2026-09-08T11:00:00Z rotate\n2026-09-08T12:00:00Z rotate\n');
    const dl = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(home, 'deadman.json'), JSON.stringify({ deadline: dl, intervalH: 24, armedAt: new Date().toISOString() }) + '\n');
    const skp = path.join(home, 'storage.key');
    fs.writeFileSync(skp, cryptMod.wrapKey(cryptMod.ensureStorageKey(skp), 'test-passphrase'), { mode: 0o600 });
    r = await req(base + '/api/events', 'GET', { token });
    assert(r.data.ok && r.data.data.entries.length === 3 && r.data.data.entries[0].kind === 'duress' && r.data.data.entries[2].kind === 'keys', 'events tail surfaces the log rows (duress/deadman/keys)');
    r = await req(base + '/api/keys', 'GET', { token });
    assert(r.data.data.duressArmed === true, 'duress armed flag reflects the wrapped storage key');
    assert(r.data.data.deadman && r.data.data.deadman.armed === true && r.data.data.deadman.hoursLeft >= 47 && r.data.data.deadman.deadline === dl, 'dead-man status carries deadline + hours left');
    assert(r.data.data.rotations === 3, 'rotation count reflects the ledger');
    console.log('OK: events tail + keys duress/dead-man/rotation status served');

    // 5 — apps list reflects the real registry (hand-built myapp)
    r = await req(base + '/api/apps', 'GET', { token });
    assert(r.data.ok && Array.isArray(r.data.data) && r.data.data.length === 1, 'apps list has exactly the one registered app');
    const app = r.data.data[0];
    assert(app.name === 'myapp' && app.alive === false && app.connect === false && app.port === '3100', 'app entry shape matches listAppsData');

    // 6 — status + logs for the real app
    r = await req(base + '/api/apps/myapp', 'GET', { token });
    assert(r.data.ok && r.data.data.cwd === '/tmp/fake-myapp-source' && r.data.data.startCmd === 'node server.js', 'status returns getStatusData shape');
    r = await req(base + '/api/apps/myapp/logs', 'GET', { token });
    assert(r.data.ok && r.data.data.exists === false, 'logs envelope for an app with no deploy log yet');

    // 7 — actions: unknown app → clean 404 envelope; rollback on plain app → data.ok false
    r = await req(base + '/api/apps/nope/stop', 'POST', { token, body: {} });
    assert(r.status === 404 && r.data.ok === false && r.data.error.code === 'NOT_FOUND', 'action on unknown app is a clean 404 envelope');
    r = await req(base + '/api/apps/myapp/rollback', 'POST', { token, body: {} });
    assert(r.data.ok && r.data.data.ok === false && /--safe/.test(r.data.data.reason), 'rollback on a plain app returns the CLI\'s honest reason');
    r = await req(base + '/api/apps/myapp/restart', 'POST', { token, body: {} });
    assert(r.data.ok && typeof r.data.data === 'object' && 'name' in r.data.data, 'restart action is served (deploy spine needs it for safe apps)');

    // 7c — env manager: values are written, NEVER returned; pending banner flag
    r = await req(base + '/api/apps/myapp/env', 'PUT', { token, body: { set: { FOO: 'bar baz', PLAIN: 'quiet' } } });
    assert(r.status === 200 && r.data.ok && r.data.data.pendingRestart === true, 'env set marks pending restart:\n' + JSON.stringify(r.data).slice(0, 200));
    r = await req(base + '/api/apps/myapp/secrets', 'GET', { token });
    const leaked = JSON.stringify(r.data);
    assert(r.status === 200 && r.data.data.keys.includes('FOO') && r.data.data.keys.includes('PLAIN') && r.data.data.count === 2, 'secrets GET returns the key names');
    assert(!leaked.includes('bar baz') && !leaked.includes('quiet'), 'secrets GET NEVER returns values:\n' + leaked.slice(0, 200));
    const rawFile = fs.readFileSync(path.join(fakeHome, '.gitlive', 'apps', 'myapp.secrets.env'), 'utf8');
    assert(/FOO="bar baz"/.test(rawFile) && /PLAIN=quiet/.test(rawFile), 'the file carries the real values (quoted when needed):\n' + rawFile);
    r = await req(base + '/api/apps/myapp/env', 'PUT', { token, body: { set: { 'BAD KEY': 'x' } } });
    assert(r.status === 400 && r.data.error.code === 'INVALID_ARGS', 'invalid key name refused');
    r = await req(base + '/api/apps/myapp/env', 'PUT', { token, body: { del: ['FOO'] } });
    assert(r.status === 200 && r.data.data.changed === true, 'env delete works');
    r = await req(base + '/api/apps/myapp/env', 'PUT', { token, body: { apply: true } });
    assert(r.status === 200 && r.data.data.applied === true, 'restart-to-apply clears the pending marker');

    // 7d — scheduled tasks: the plane's cron ticker fires, receipts land
    const cronMarker = path.join(fakeHome, 'cron-marker.txt');
    r = await req(base + '/api/apps/myapp/schedule', 'PUT', { token, body: { cron: '*/1 * * * * *', cmd: 'echo tick >> ' + cronMarker } });
    assert(r.status === 200 && r.data.ok && r.data.data.schedule.cron.includes('*/1'), 'schedule set');
    r = await req(base + '/api/apps/myapp/schedule', 'PUT', { token, body: { cron: 'not a cron', cmd: 'x' } });
    assert(r.status === 400 && r.data.error.code === 'INVALID_ARGS', 'invalid cron refused');
    await waitFor(() => fs.existsSync(cronMarker), 'cron marker file', 30, 300);
    assert(/tick/.test(fs.readFileSync(cronMarker, 'utf8')), 'the scheduled command ran:\n' + fs.readFileSync(cronMarker, 'utf8'));
    r = await req(base + '/api/jobs', 'GET', { token });
    assert(r.data.data.jobs.some((j) => j.kind === 'cron' && /cron: myapp/.test(j.label || '')), 'cron fire lands in the job ledger');
    r = await req(base + '/api/events', 'GET', { token });
    assert(r.data.data.entries.some((e) => e.kind === 'cron'), 'cron fire lands in the audit events');
    r = await req(base + '/api/apps/myapp/schedule', 'DELETE', { token });
    assert(r.status === 200 && r.data.data.removed === true, 'schedule removed');
    console.log('OK: scheduled tasks — ticker fires, jobs + events receipted, invalid cron refused');

    // 7b — status-rail data: /api/daemon + per-app lastDeploy enrichment
    r = await req(base + '/api/daemon', 'GET', { token });
    assert(r.data.ok && r.data.data.running === false, 'daemon reports not-running without a pid file');
    fs.appendFileSync(path.join(fakeHome, '.gitlive', 'apps', 'myapp-run', 'deploy-history.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), outcome: 'success', commit: 'abc1234def' }) + '\n');
    r = await req(base + '/api/apps', 'GET', { token });
    const withDeploy = r.data.data.find((a) => a.name === 'myapp');
    assert(withDeploy && withDeploy.lastDeploy && withDeploy.lastDeploy.commit === 'abc1234def' && withDeploy.lastDeploy.outcome === 'success' && withDeploy.lastDeploy.at, 'apps rows carry the newest deploy entry');
    const sleeper = spawn('sh', ['-c', 'sleep 300'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(fakeHome, '.gitlive', 'daemon.pid'), String(sleeper.pid) + '\n');
    r = await req(base + '/api/daemon', 'GET', { token });
    assert(r.data.ok && r.data.data.running === true && String(r.data.data.pid) === String(sleeper.pid), 'daemon reports running with the live pid');
    sleeper.kill('SIGKILL');
    await new Promise((res) => sleeper.on('exit', res));
    r = await req(base + '/api/daemon', 'GET', { token });
    assert(r.data.ok && r.data.data.running === false && /stale/.test(r.data.data.note || ''), 'daemon reports a stale pid file after the process dies');
    console.log('OK: status-rail data — /api/daemon states + lastDeploy column feed');

    // 7d — entry node view (two-door plan): /api/entry reports REAL state
    // from ~/.gitlive/entry + app rows carry domain/graduation metadata
    r = await req(base + '/api/entry', 'GET', { token });
    assert(r.data.ok && r.data.data.client.configured === false && r.data.data.server.configured === false, 'entry reports not-configured with no entry files');
    const entryDir = path.join(fakeHome, '.gitlive', 'entry');
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(path.join(entryDir, 'client.json'), JSON.stringify({ url: 'https://entry.example.test:8443', token: 't' }));
    fs.writeFileSync(path.join(entryDir, 'server.json'), JSON.stringify({ tokenHash: 'x'.repeat(64) }));
    fs.writeFileSync(path.join(entryDir, 'state.json'), JSON.stringify({ machines: { m1: { name: 'home-box', domains: ['notes.example.test'], connectedAt: '2026-09-10T00:00:00Z', lastSeen: '2026-09-10T00:00:00Z' } } }));
    fs.writeFileSync(path.join(entryDir, 'server.log'), '[2026-09-10T00:00:00.000Z] listening on 0.0.0.0:8080\n');
    r = await req(base + '/api/entry', 'GET', { token });
    assert(r.data.ok && r.data.data.client.configured === true && r.data.data.client.url === 'https://entry.example.test:8443', 'entry client config is surfaced:\n' + JSON.stringify(r.data.data));
    assert(r.data.data.server.configured === true && r.data.data.server.running === false && r.data.data.server.port === 8080, 'entry server state + port parsed from its log:\n' + JSON.stringify(r.data.data.server));
    assert(r.data.data.server.machines[0] && r.data.data.server.machines[0].name === 'home-box' && r.data.data.server.machines[0].domains[0] === 'notes.example.test', 'connected machines + domains are surfaced');
    const regNow = JSON.parse(fs.readFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), 'utf8'));
    regNow.myapp.domains = ['notes.example.test', 'myapp.own.example'];
    regNow.myapp.primaryDomain = 'myapp.own.example';
    regNow.myapp.graduatedFrom = 'example.test';
    regNow.myapp.graduatedAt = '2026-09-10T00:00:00Z';
    fs.writeFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), JSON.stringify(regNow, null, 2));
    r = await req(base + '/api/apps', 'GET', { token });
    const withH = r.data.data.find((a) => a.name === 'myapp');
    assert(withH && withH.h && typeof withH.h.sampled === 'boolean' && Array.isArray(withH.h.samples), 'app rows carry the health summary for the card sparkline');
    const withDom = r.data.data.find((a) => a.name === 'myapp');
    assert(withDom && withDom.primaryDomain === 'myapp.own.example' && withDom.graduatedFrom === 'example.test' && withDom.domains.length === 2, 'app rows carry own-domain + graduation metadata');
    r = await req(base + '/api/apps/myapp', 'GET', { token });
    assert(r.data.ok && r.data.data.primaryDomain === 'myapp.own.example' && r.data.data.graduatedFrom === 'example.test', 'app detail carries own-domain + graduation metadata');
    console.log('OK: entry view — /api/entry real state + app rows carry own domain and graduation');

    // 7f — health history (#8): the visible meter, local and honest
    const hh = path.join(runPath, 'health-history.jsonl');
    fs.writeFileSync(hh, [
      JSON.stringify({ at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), up: true, status: 200 }),
      JSON.stringify({ at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), up: false, status: null }),
    ].join('\n') + '\n');
    fs.appendFileSync(path.join(runPath, 'backup-history.jsonl'), JSON.stringify({ at: new Date().toISOString(), app: 'myapp', snapshot: 'stub-1', verify: true, outcome: 'verified' }) + '\n');
    r = await req(base + '/api/apps/myapp/health', 'GET', { token });
    const hd = r.data.data;
    assert(hd.samples.length === 2 && hd.window.uptimePct === 50 && hd.deploys >= 1, 'the health API computes the 24h window from real samples:\n' + JSON.stringify(hd));
    assert(hd.lastVerifiedBackup && hd.lastVerifiedBackup.snapshot === 'stub-1', 'the last VERIFIED backup rides the same receipt file');
    // the live sampler: a real server answers the app's health port
    const healthApp = http.createServer((q, s2) => s2.end('ok'));
    await new Promise((res) => healthApp.listen(3100, '127.0.0.1', res));
    const got = await waitFor(async () => {
      const hr = await req(base + '/api/apps/myapp/health', 'GET', { token });
      const s = hr.data.data.samples.filter((x) => x.up === true);
      return s.length >= 3 ? hr.data.data : null; // the sampler appended live "up" probes
    }, 'live health samples', 30, 200);
    assert(got && got.samples.length > 2, 'the sampler records REAL probes while the plane runs');
    healthApp.close();
    console.log('OK: health history — 24h window from real samples, verified-backup fact, live sampler');

    // 7e — settings body: domains aggregate + local on/off (explicit port,
    // isolated gateway on the fake home) + zones add/remove + registration
    // toggle + daemon ensure/stop, all through the same CLI-proven logic
    r = await req(base + '/api/domains', 'GET', { token });
    assert(r.data.ok && r.data.data.local.on === false && Array.isArray(r.data.data.zones) && r.data.data.zones.length === 0, 'domains overview starts empty:\n' + JSON.stringify(r.data.data));
    const gwPort = await freePort();
    r = await req(base + '/api/domains/local', 'POST', { token, body: { action: 'on', port: gwPort } });
    assert(r.data.ok && r.data.data.on === true && Number(r.data.data.port) === gwPort, 'local names on starts the gateway on the explicit port:\n' + JSON.stringify(r.data.data));
    const gwPid = Number(fs.readFileSync(path.join(fakeHome, '.gitlive', 'domain', 'gateway.pid'), 'utf8').trim());
    assert(gwPid > 0, 'the gateway pidfile lands on the fake home');
    r = await req(base + '/api/domains', 'GET', { token });
    assert(r.data.ok && r.data.data.local.on === true && r.data.data.local.port === gwPort, 'domains overview reflects the running gateway');
    r = await req(base + '/api/domains/local', 'POST', { token, body: { action: 'off' } });
    assert(r.data.ok && r.data.data.on === false, 'local names off stops the gateway');
    r = await req(base + '/api/domains/local', 'POST', { token, body: { action: 'tls' } });
    assert(r.data.ok && r.data.data.caCreated === true, 'local tls creates the CA on demand');
    r = await req(base + '/api/domains/zone', 'POST', { token, body: { action: 'add', domain: 'makers.test', dnsToken: 'tok' } });
    assert(r.data.ok && r.data.data.domain === 'makers.test' && r.data.data.extension === 'test' && r.data.data.records.length === 2 && r.data.data.records[1].name === '*.makers.test', 'zone add stores the zone and prints the wildcard records:\n' + JSON.stringify(r.data.data));
    r = await req(base + '/api/domains', 'GET', { token });
    assert(r.data.ok && r.data.data.zones.length === 1 && r.data.data.zones[0].hasToken === true, 'zones list reflects the add');
    r = await req(base + '/api/domains/zone', 'POST', { token, body: { action: 'add', domain: 'not a domain' } });
    assert(r.status === 400 && r.data.error.code === 'INVALID_ARGS', 'invalid zone domains are refused');
    r = await req(base + '/api/domains/zone', 'POST', { token, body: { action: 'remove', domain: 'makers.test' } });
    assert(r.data.ok && r.data.data.removed === true, 'zone remove works');
    // launch journey milestone 2: claiming a borrowed zone label
    r = await req(base + '/api/apps/myapp/name', 'POST', { token, body: { zone: 'example.app' } });
    assert(r.status === 404 && r.data.error.code === 'NOT_FOUND', 'naming against an unregistered zone is refused');
    r = await req(base + '/api/domains/zone', 'POST', { token, body: { action: 'add', domain: 'example.app' } });
    assert(r.data.ok && r.data.data.extension === 'app', 'zone registered for the naming test');
    r = await req(base + '/api/apps/myapp/name', 'POST', { token, body: { zone: 'example.app' } });
    assert(r.data.ok && r.data.data.label === 'myapp.example.app', 'claiming the label records <app>.<zone>:\n' + JSON.stringify(r.data));
    const regAfter = JSON.parse(fs.readFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), 'utf8'));
    assert((regAfter.myapp.domains || []).includes('myapp.example.app'), 'the label lands in the registry');
    r = await req(base + '/api/domains/zone', 'POST', { token, body: { action: 'remove', domain: 'example.app' } });
    assert(r.data.ok, 'naming-test zone cleaned up');
    // launch journey milestone 3: make public — own domain becomes canonical
    r = await req(base + '/api/apps/myapp/public', 'POST', { token, body: { domain: 'myapp.gitlive' } });
    assert(r.status === 400, 'the reserved name is refused as a public domain');
    r = await req(base + '/api/apps/myapp/public', 'POST', { token, body: { domain: 'myapp.own.example' } });
    assert(r.data.ok && r.data.data.primaryDomain === 'myapp.own.example', 'public attach makes the domain canonical:\n' + JSON.stringify(r.data.data));
    assert(r.data.data.records && r.data.data.records[0].type === 'A', 'prints the A record for the owner\u2019s registrar');
    const regPub = JSON.parse(fs.readFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), 'utf8'));
    assert(regPub.myapp.primaryDomain === 'myapp.own.example' && (regPub.myapp.domains || []).includes('myapp.own.example'), 'the canonical domain lands in the registry');
    // launch journey checkpoint 4: the master switch endpoint
    r = await req(base + '/api/up', 'POST', { token, body: {} });
    assert(r.data.ok && typeof r.data.data.planeUp === 'boolean' && Array.isArray(r.data.data.apps), 'the up endpoint reports plane + per-app rows:\n' + JSON.stringify(r.data.data));
    // checkpoint 5: the pool — list + the admission exam (5 honest checks)
    r = await req(base + '/api/pool', 'GET', { token });
    assert(r.data.ok && Array.isArray(r.data.data), 'the pool lists (empty until an app is admitted)');
    r = await req(base + '/api/apps/myapp/exam', 'POST', { token, body: {} });
    assert(r.data.ok && r.data.data.checks.length === 5 && Array.isArray(r.data.data.diagnosis) && r.data.data.admitted === false, 'the exam runs all five checks and diagnoses honestly:\n' + JSON.stringify(r.data.data).slice(0, 300));
    r = await req(base + '/api/settings', 'GET', { token });
    assert(r.data.ok && typeof r.data.data.registrationOpen === 'boolean', 'settings reports the registration state');
    r = await req(base + '/api/settings/registration', 'POST', { token, body: { open: true } });
    assert(r.data.ok && r.data.data.registrationOpen === true, 'registration can be opened at runtime');
    r = await req(base + '/api/settings', 'GET', { token });
    assert(r.data.data.registrationOpen === true && r.data.data.registrationExplicit === true, 'the toggle persists');
    r = await req(base + '/api/settings/registration', 'POST', { token, body: { open: false } });
    assert(r.data.ok && r.data.data.registrationOpen === false, 'registration can be closed again');
    // onboarding welcome (P7-1): real backup facts ride the domains overview
    fs.appendFileSync(path.join(runPath, 'backup-history.jsonl'), JSON.stringify({ at: new Date().toISOString(), app: 'myapp', snapshot: 'stub-1' }) + '\n');
    r = await req(base + '/api/domains', 'GET', { token });
    const myappRow = r.data.data.apps.find((a) => a.name === 'myapp');
    assert(myappRow && myappRow.backedUp === true, 'the domains overview carries the real backup receipt fact');
    r = await req(base + '/', 'GET');
    assert(r.data.includes('welcome-card') && r.data.includes('Make it yours'), 'the dashboard serves the onboarding welcome checklist');
    assert(r.data.includes('apps-grid') && r.data.includes('btn-viewmode'), 'the dashboard serves the projects card grid + view toggle');
    assert(r.data.includes('th-copy-receipt') && r.data.includes('copy the SLSA/in-toto attestation'), 'the theater carries the copy-receipt button');
    r = await req(base + '/api/apps/myapp/attest', 'GET', { token });
    assert(r.status === 404 && /no valid owner-signed deploy receipt|no owner key|No app named|no signed deploy receipts/.test(r.data.error.message), 'the attest endpoint answers honestly before any receipt exists: ' + JSON.stringify(r.data));
    r = await req(base + '/api/daemon', 'POST', { token, body: { action: 'ensure' } });
    assert(r.data.ok && r.data.data.running === true, 'daemon ensure through the API:\n' + JSON.stringify(r.data.data));
    const dPid = Number(fs.readFileSync(path.join(fakeHome, '.gitlive', 'daemon.pid'), 'utf8').trim());
    assert(dPid > 0, 'the supervisor pidfile lands on the fake home');
    r = await req(base + '/api/daemon', 'POST', { token, body: { action: 'stop' } });
    assert(r.data.ok && r.data.data.running === false, 'daemon stop through the API');
    console.log('OK: settings body — domains local on/off/tls, zones add/remove, registration toggle, daemon ensure/stop');

    // 7c — data map: real sqlite introspection + file area under the fake app
    const dmData = path.join(fakeHome, '.gitlive', 'apps', 'myapp-run', 'data');
    fs.mkdirSync(dmData, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const dbx = new DatabaseSync(path.join(dmData, 'app.db'));
    dbx.exec('CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT)');
    dbx.exec('INSERT INTO todos (title) VALUES (\'a\'), (\'b\')');
    dbx.close();
    fs.writeFileSync(path.join(dmData, 'note.txt'), 'hello');
    r = await req(base + '/api/apps/myapp/datamap', 'GET', { token });
    assert(r.data.ok && Array.isArray(r.data.data.databases) && r.data.data.databases.length === 1, 'datamap finds the sqlite db');
    const dbEntry = r.data.data.databases[0];
    assert(dbEntry.tables && dbEntry.tables[0] && dbEntry.tables[0].name === 'todos' && dbEntry.tables[0].rows === 2, 'datamap introspects tables + row counts');
    assert(r.data.data.files.present === true && r.data.data.files.fileCount >= 1 && typeof r.data.data.protection.storageKeyPresent === 'boolean' && r.data.data.protection.shares.armed === false, 'datamap file area + protection posture');
    assert(Array.isArray(r.data.data.files.entries) && r.data.data.files.entries.some((e) => e.rel === 'note.txt' && typeof e.sizeBytes === 'number'), 'the file area carries real entries for the visual tree');
    assert(Array.isArray(r.data.data.receipts), 'datamap carries the signed deploy-tag list (empty without a bare repo)');
    console.log('OK: data map — real sqlite tables/rows + file area + protection posture');

    // 7d — expired sessions are pruned, live ones are left alone. Sessions are
    // only deleted when their own token is presented again, so a long-lived
    // machine accumulates dead rows (the live plane had 23, three expired).
    const sdb = new DatabaseSync(path.join(controlDir, 'app.db'));
    const ownerId = sdb.prepare('SELECT id FROM _gitlive_users ORDER BY id LIMIT 1').get().id;
    const deadHash = 'dead'.repeat(16);
    const liveHash = 'live'.repeat(16);
    sdb.prepare('INSERT OR REPLACE INTO _gitlive_sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
      .run(deadHash, ownerId, new Date(Date.now() - 86400000).toISOString());
    sdb.prepare('INSERT OR REPLACE INTO _gitlive_sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
      .run(liveHash, ownerId, new Date(Date.now() + 86400000).toISOString());
    sdb.close();
    process.env.GITLIVE_CONTROL_DIR = controlDir; // the module reads it at require time
    const { pruneSessions } = require(path.join(__dirname, '..', 'control', 'server.js'));
    const pruned = pruneSessions('test');
    assert(pruned.pruned >= 1, 'prune removes the expired session: ' + JSON.stringify(pruned));
    const sdb2 = new DatabaseSync(path.join(controlDir, 'app.db'));
    const deadLeft = sdb2.prepare('SELECT COUNT(*) AS c FROM _gitlive_sessions WHERE token_hash = ?').get(deadHash).c;
    const liveLeft = sdb2.prepare('SELECT COUNT(*) AS c FROM _gitlive_sessions WHERE token_hash = ?').get(liveHash).c;
    sdb2.close();
    assert(deadLeft === 0, 'the expired row is gone');
    assert(liveLeft === 1, 'a live session is never pruned');
    // and the token that was pruned really is refused now
    const liveToken = 'live'.repeat(16);
    r = await req(base + '/api/apps', 'GET', { token: liveToken });
    assert(r.status === 401, 'the hash-only fixture is not a usable token (expected 401): ' + r.status);
    console.log('OK: expired dashboard sessions are pruned at boot/hourly, live ones untouched');

    // 8 — dashboard HTML is served
    r = await req(base + '/', 'GET');
    assert(r.status === 200 && typeof r.data === 'string' && r.data.includes('gitlive control plane') && r.data.includes('form-login'), 'dashboard HTML serves with the login form');

    // 9 — agent connect (real CLI child) registers + heartbeats the node
    const agentOut = cli(['agent', 'connect', base, '--name', 'tester', '--once']);
    assert(/registered/.test(agentOut) && /heartbeat ok/.test(agentOut), 'agent connect registers and heartbeats:\n' + agentOut);

    r = await req(base + '/api/nodes', 'GET', { token });
    assert(r.data.ok && r.data.data.length === 1 && r.data.data[0].name === 'tester' && r.data.data[0].last_seen_at, 'server lists the connected node with last_seen_at');
    assert(r.data.data[0].alive === true, 'a freshly heartbeated node is alive');
    const agentList = cli(['agent', 'list']);
    assert(/connected to /.test(agentList) && /tester/.test(agentList) && /plane reachable: yes/.test(agentList), 'agent list reports the local record + reachability:\n' + agentList);
    r = await req(base + '/', 'GET');
    assert(r.data.includes('nodes-view') && r.data.includes('Machines register here') && r.data.includes('public-card') && r.data.includes('spine-btn'), 'the dashboard serves the Nodes view + public-reach card + deploy spine');

    // 10 — agent re-connect is idempotent (same agent.json reused, no dup node)
    const agentAgain = cli(['agent', 'connect', base, '--name', 'tester', '--once']);
    assert(/already connected/.test(agentAgain), 're-connect reuses the stored registration:\n' + agentAgain);
    r = await req(base + '/api/nodes', 'GET', { token });
    assert(r.data.data.length === 1, 'no duplicate node on re-connect');

    // 11 — bad node secret heartbeat is refused
    r = await req(base + '/api/nodes/heartbeat', 'POST', { token, body: { nodeId: r.data.data[0].id, secret: 'wrong' } });
    assert(r.status === 403 && r.data.error.code === 'AUTH_ERROR', 'heartbeat with a bad secret is refused');

    // 11b — practice sandbox: a real disposable app, break/fix/destroy loop
    r = await req(base + '/api/sandbox/init', 'POST', { token, body: {} });
    assert(r.data.ok && r.data.data.name === 'practice-node', 'sandbox init:\n' + JSON.stringify(r.data));
    const sbReady = await waitFor(async () => {
      const apps = await req(base + '/api/apps', 'GET', { token });
      const found = apps.data.data.find((a) => a.name === 'practice-node');
      if (!found || !found.sandbox) return null;
      const st = await req(base + '/api/apps/practice-node', 'GET', { token });
      return st.data.data.proxyUp === true ? st.data.data : null;
    }, 'practice node healthy', 50, 400);
    assert(sbReady && sbReady.activeSlot, 'practice node is live behind its proxy');
    r = await req(base + '/api/sandbox/break', 'POST', { token, body: {} });
    assert(r.data.ok && r.data.data.outcome === 'failed' && r.data.data.stillServing === true, 'broken deploy fails and previous version keeps serving:\n' + JSON.stringify(r.data.data));
    r = await req(base + '/api/apps/practice-node', 'GET', { token });
    assert(r.data.data.proxyUp === true, 'proxy still serving after the failed deploy');
    r = await req(base + '/api/sandbox/fix', 'POST', { token, body: {} });
    assert(r.data.ok && r.data.data.outcome === 'success', 'fix deploy succeeds:\n' + JSON.stringify(r.data.data));
    r = await req(base + '/api/sandbox/destroy', 'POST', { token, body: {} });
    assert(r.data.ok && r.data.data.destroyed === true, 'destroy:\n' + JSON.stringify(r.data));
    r = await req(base + '/api/apps', 'GET', { token });
    assert(!r.data.data.some((a) => a.name === 'practice-node'), 'practice node gone from the registry after destroy');
    console.log('OK: practice sandbox — real disposable app, break keeps old version serving, fix recovers, destroy cleans up');

    // 11c — public-reach card: /api/public against a stub "internet" ──────
    // Three public surfaces (npm, github repo, head commit, formula) are
    // stubbed on localhost; the control server is pointed at them via the
    // GITLIVE_PUBLIC_*_URL envs (the heartbeat design line: owner-driven,
    // overridable, one lookup per surface).
    const pubHits = { npm: 0, repo: 0, commits: 0, formula: 0 };
    let pubFormulaOk = true;
    const stubNet = http.createServer((sreq, sres) => {
      const u = sreq.url;
      if (u === '/npm') { pubHits.npm += 1; sres.setHeader('content-type', 'application/json'); sres.end(JSON.stringify({ version: require('../gitlive.js').VERSION })); return; }
      if (u === '/repo') { pubHits.repo += 1; sres.setHeader('content-type', 'application/json'); sres.end(JSON.stringify({ visibility: 'public', default_branch: 'main', pushed_at: '2026-09-10T00:00:00Z' })); return; }
      if (u === '/commits') { pubHits.commits += 1; sres.setHeader('content-type', 'application/json'); sres.end(JSON.stringify({ sha: '99b6448cd0abfd62dc3abac6fcb36adc0df99888', commit: { message: 'gitlive snapshot' } })); return; }
      if (u === '/formula') { pubHits.formula += 1; if (!pubFormulaOk) { sres.statusCode = 404; sres.end('gone'); return; } sres.end('url "https://registry.npmjs.org/gitlive/-/gitlive-' + require('../gitlive.js').VERSION + '.tgz"\n  sha256 "48186509a04f328a0987dca45406d7711fa7381e42256154697e6fb6e1c0ea1e"'); return; }
      sres.statusCode = 404; sres.end('nope');
    });
    await new Promise((resolve) => stubNet.listen(0, '127.0.0.1', resolve));
    const stubBase = `http://127.0.0.1:${stubNet.address().port}`;
    const pubHome = fs.mkdtempSync(path.join(shortTmp, 'gitlive-public-home-'));
    const pubControl = path.join(pubHome, '.gitlive', 'control');
    fs.mkdirSync(pubControl, { recursive: true });
    const pubPort = await freePort();
    const pubEnv = {
      ...process.env, HOME: pubHome, GITLIVE_CONTROL_DIR: pubControl, GITLIVE_HEALTH_INTERVAL_MS: '200',
      GITLIVE_PUBLIC_NPM_URL: stubBase + '/npm',
      GITLIVE_PUBLIC_REPO_URL: stubBase + '/repo',
      GITLIVE_PUBLIC_COMMITS_URL: stubBase + '/commits',
      GITLIVE_PUBLIC_FORMULA_URL: stubBase + '/formula',
    };
    const pubChild = spawn('node', [GITLIVE_JS, 'serve', '--port', String(pubPort), '--no-open'], { env: pubEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const pubBase = `http://127.0.0.1:${pubPort}`;
    try {
      await waitForServer(pubBase + '/');
      let pr = await req(pubBase + '/api/public', 'GET');
      assert(pr.status === 401 && pr.data.error.code === 'UNAUTHENTICATED', 'public check without a session must 401');
      pr = await req(pubBase + '/api/auth/register', 'POST', { body: { email: 'pub@example.com', password: 'hunter22' } });
      assert(pr.status === 200, 'public-check server admin registration');
      pr = await req(pubBase + '/api/auth/login', 'POST', { body: { email: 'pub@example.com', password: 'hunter22' } });
      const pubToken = pr.data.data.token;
      pr = await req(pubBase + '/api/public', 'GET', { token: pubToken });
      const pd = pr.data.data;
      assert(pd.allOk === true, 'all three surfaces lit when the outside world answers:\n' + JSON.stringify(pd));
      assert(pd.npm.status === 'current' && pd.npm.published === require('../gitlive.js').VERSION, 'npm row reflects the registry version');
      assert(pd.github.status === 'public' && pd.github.head === '99b6448' && /snapshot/.test(pd.github.subject), 'github row carries visibility + head commit');
      assert(pd.formula.status === 'current' && pd.formula.sha256 === '48186509a04f328a0987dca45406d7711fa7381e42256154697e6fb6e1c0ea1e', 'formula row lit');
      assert(!('image' in pd), 'no image surface — container distribution removed');
      // 60s server cache: a second GET must not re-touch the stub internet
      const hitsBefore = JSON.stringify(pubHits);
      pr = await req(pubBase + '/api/public', 'GET', { token: pubToken });
      assert(pr.data.data.allOk === true && JSON.stringify(pubHits) === hitsBefore, 'cached GET does not re-query the registries');
      // refresh POST forces a re-check; the formula vanishes → warn, not fail
      pubFormulaOk = false;
      pr = await req(pubBase + '/api/public/refresh', 'POST', { token: pubToken, body: {} });
      assert(pr.data.data.formula.status === 'missing' && pr.data.data.allOk === false, 'refresh re-checks and flags the vanished formula:\n' + JSON.stringify(pr.data.data.formula));
      console.log('OK: public-reach card — three surfaces checked, 60s cache, refresh forces re-check, vanished formula flagged honestly');
    } finally {
      pubChild.kill('SIGTERM');
      stubNet.close();
    }

    // 12 — logout kills the session
    r = await req(base + '/api/auth/logout', 'POST', { token, body: {} });
    assert(r.data.ok, 'logout succeeds');
    r = await req(base + '/api/me', 'GET', { token });
    assert(r.status === 401, 'session is dead after logout');

    console.log('OK: unauthenticated access refused');
    console.log('OK: admin registration + closed second registration');
    console.log('OK: login rejects wrong password, issues working session');
    console.log('OK: /api/me + apps list mirror the real registry');
    console.log('OK: status/logs/actions envelopes (incl. clean 404 + honest rollback reason)');
    console.log('OK: dashboard HTML served');
    console.log('OK: gitlive agent connect registers + heartbeats + reconnects idempotently');
    console.log('OK: bad node secret refused; logout invalidates session');

    // 12 — observability: request id header + access log (never a secret)
    const healthRes = await fetch(base + '/health');
    const healthBody = await healthRes.json().catch(() => null);
    const rid = healthRes.headers.get('x-request-id');
    assert(healthRes.status === 200 && healthBody && healthBody.ok === true && typeof healthBody.uptime === 'number', 'unauthenticated /health answers status only: ' + JSON.stringify(healthBody));
    assert(!/key|handle|email|app/i.test(JSON.stringify(healthBody)), '/health leaks nothing but status');
    assert(/^[0-9a-f]{8}$/.test(String(rid)), 'every response carries a request id: ' + String(rid));
    const logPath = path.join(fakeHome, '.gitlive', 'control', 'access.log');
    assert(fs.existsSync(logPath), 'access log exists after requests');
    const logged = fs.readFileSync(logPath, 'utf8');
    assert(/GET \/health → 200/.test(logged), 'access log records method, path and status:\n' + logged.slice(-300));
    assert(logged.includes(String(rid)), 'the logged line carries the request id it answered with');
    assert(!/hunter22/.test(logged), 'the access log NEVER contains a password');
    console.log('OK: request ids + access log — debuggable, no secrets');

    // the logout test above revoked the session — get a fresh one for these
    const freshLogin = await req(base + '/api/auth/login', 'POST', { body: { email: 'admin@example.com', password: 'hunter22' } });
    assert(freshLogin.status === 200 && freshLogin.data.data.token, 'a fresh session for the observability checks');
    token = freshLogin.data.data.token;

    // 13 — serve.log rotation happened during boot
    const serveLogSize = fs.statSync(path.join(controlDir, 'serve.log')).size;
    assert(serveLogSize < 5 * 1024 * 1024, 'boot rotates an oversized serve.log (' + serveLogSize + ' bytes left)');
    console.log('OK: serve.log rotates at boot — ' + serveLogSize + ' bytes left of 6 MB');

    // 14 — a non-loopback bind is refused with an honest reason
    let wideErr = '';
    try { cli(['serve', '--host', '0.0.0.0', '--port', String(await freePort())]); } catch (err) {
      wideErr = String(err.stdout || '') + String(err.stderr || '');
    }
    assert(/refusing to bind 0\.0\.0\.0/.test(wideErr) && /GITLIVE_ALLOW_NON_LOOPBACK=1/.test(wideErr), 'binding wide is refused with the TLS reason:\n' + wideErr);
    console.log('OK: non-loopback bind refused — cleartext sessions are not silently exposed');

    // 15 — webhook replay guard: the same delivery id is refused the second time
    cli(['github', 'hook', 'myapp', '--repo', 'https://github.com/example/repo.git', '--secret', 'test-secret']);
    const hookBody = JSON.stringify({ ref: 'refs/heads/main', head_commit: { id: 'a'.repeat(40) } });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(hookBody).digest('hex');
    const delivery = 'delivery-' + crypto.randomBytes(6).toString('hex');
    const hookOnce = () => fetch(base + '/api/github/hook?app=myapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig, 'x-github-delivery': delivery },
      body: hookBody,
    });
    const hookFirst = await hookOnce();
    const hookSecond = await hookOnce();
    assert(hookFirst.status !== 409, 'the first delivery is processed (not a replay): ' + hookFirst.status);
    assert(hookSecond.status === 409, 'the same delivery id is refused as a replay: ' + hookSecond.status);
    const replayEvents = await req(base + '/api/events', 'GET', { token });
    const replayEntries = (replayEvents.data && replayEvents.data.data && replayEvents.data.data.entries) || [];
    assert(replayEntries.some((e) => e.kind === 'github-hook-replay'), 'the replay is an audit event: ' + JSON.stringify(replayEvents.data).slice(0, 200));
    console.log('OK: webhook replay refused + audit event written');

    // 16 — automatic maintenance fires on its own (state snapshot due, no repo → honest failure)
    const maintPort = await freePort();
    const maintHome = fs.mkdtempSync(path.join(shortTmp, 'gitlive-maint-'));
    fs.mkdirSync(path.join(maintHome, '.gitlive', 'control'), { recursive: true });
    const maint = spawn('node', [GITLIVE_JS, 'serve', '--port', String(maintPort), '--no-open'], {
      env: { ...process.env, HOME: maintHome, GITLIVE_CONTROL_DIR: path.join(maintHome, '.gitlive', 'control'),
        GITLIVE_MAINTENANCE: '1', GITLIVE_MAINT_STATE_HOURS: '0', GITLIVE_HEALTH_INTERVAL_MS: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForServer('http://127.0.0.1:' + maintPort + '/');
      const jobsFile = path.join(maintHome, '.gitlive', 'jobs.jsonl');
      await waitFor(() => fs.existsSync(jobsFile) && /maintenance: control-plane state/.test(fs.readFileSync(jobsFile, 'utf8')), 'maintenance job', 24, 400);
      const maintLog = fs.readFileSync(path.join(maintHome, '.gitlive', 'control', 'access.log'), 'utf8');
      assert(/maintenance/.test(maintLog), 'maintenance is recorded in the access log');
      console.log('OK: automatic maintenance fires on its own — receipts, not wishes');
    } finally {
      await new Promise((r2) => { maint.on('exit', r2); maint.kill('SIGTERM'); });
    }
    console.log('\nALL CONTROL-PLANE TESTS PASSED');
  } finally {
    await server.stop();
  }
})().catch((err) => {
  console.error('CONTROL-PLANE TEST FAILED:', err.message || err);
  process.exitCode = 1;
});
