'use strict';
// create-an-app-from-the-dashboard end-to-end — REAL server child, REAL HTTP,
// REAL `gitlive init` child process, fake $HOME (same discipline as
// control-plane.test.js). This is the last step that used to require a
// terminal: the suite proves the form drives the same command the CLI runs,
// that a refusal leaves nothing behind, and that the folder picker cannot
// wander into gitlive's own working directory.

const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const fakeHome = fs.mkdtempSync(path.join(shortTmp, 'gitlive-create-home-'));
const controlDir = path.join(fakeHome, '.gitlive', 'control');
fs.mkdirSync(controlDir, { recursive: true });
const env = { ...process.env, HOME: fakeHome, GITLIVE_CONTROL_DIR: controlDir, GITLIVE_AGENTS: '0', GITLIVE_MAINTENANCE: '0' };

// a real little project the form can register
const projectDir = fs.mkdtempSync(path.join(shortTmp, 'gitlive-create-proj-'));
fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0', scripts: { start: 'node server.js' } }, null, 2));
fs.writeFileSync(path.join(projectDir, 'server.js'), "require('node:http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT||0);\n");
// a folder with no recognisable stack at all — start command is then required
const bareDir = fs.mkdtempSync(path.join(shortTmp, 'gitlive-create-bare-'));
fs.writeFileSync(path.join(bareDir, 'notes.txt'), 'nothing to detect here\n');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function startServer(port) {
  const child = spawn('node', [GITLIVE_JS, 'serve', '--port', String(port), '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return { child, url: `http://127.0.0.1:${port}`, log: () => output, stop: () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); }) };
}

async function waitForServer(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('control server did not come up in time');
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
  const port = await freePort();
  const server = startServer(port);
  const base = server.url;
  try {
    await waitForServer(base + '/');

    // ── login (first account is the admin)
    let r = await req(base + '/api/auth/register', 'POST', { body: { email: 'admin@example.com', password: 'hunter22' } });
    assert(r.status === 200 || r.status === 201 || r.status === 409, 'register: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200));
    r = await req(base + '/api/auth/login', 'POST', { body: { email: 'admin@example.com', password: 'hunter22' } });
    const token = r.data && r.data.data && (r.data.data.token || r.data.data.session && r.data.data.session.token);
    assert(token, 'login returns a session token: ' + JSON.stringify(r.data).slice(0, 200));

    // ── the new surface is NOT public: browsing and creating need a session
    let anon = await req(base + '/api/browse', 'GET');
    assert(anon.status === 401, 'browse without a session must 401: ' + anon.status);
    anon = await req(base + '/api/apps', 'POST', { body: { name: 'anon-app', dir: projectDir, start: 'npm start' } });
    assert(anon.status === 401, 'create without a session must 401: ' + anon.status);
    console.log('OK: the folder picker and the create action are behind the session gate');

    // ── folder picker: detection, hidden folders, and the guard rail
    r = await req(base + '/api/browse?path=' + encodeURIComponent(projectDir), 'GET', { token });
    assert(r.status === 200, 'browse fixture: ' + r.status);
    const here = r.data.data.here;
    assert(here.kind === 'node', 'browse detects the node stack: ' + here.kind);
    assert(here.startCmd === 'npm start', 'browse reports the detected start command: ' + here.startCmd);
    assert(here.name === path.basename(projectDir), 'browse suggests the folder name: ' + here.name);
    console.log('OK: folder picker detects the stack and suggests name + commands before anything is created');

    // the listing shows PROJECT folders, not the machine's plumbing: a hidden
    // folder and node_modules are skipped (a browser probe caught the first
    // version listing dot-folders, and the first assertion here was too weak
    // to notice because the fixture had no sub-folders at all)
    const browseDir = fs.mkdtempSync(path.join(shortTmp, 'gitlive-create-tree-'));
    for (const d of ['visible-app', '.hidden-app', 'node_modules', 'Library']) fs.mkdirSync(path.join(browseDir, d));
    fs.writeFileSync(path.join(browseDir, 'visible-app', 'package.json'), JSON.stringify({ scripts: { start: 'node x.js' } }));
    r = await req(base + '/api/browse?path=' + encodeURIComponent(browseDir), 'GET', { token });
    const names = r.data.data.dirs.map((d) => d.name);
    assert(names.join(',') === 'visible-app', 'the picker lists exactly the project folders: ' + JSON.stringify(names));
    assert(r.data.data.dirs[0].kind === 'node', 'each listed folder carries its detected stack: ' + JSON.stringify(r.data.data.dirs[0]));
    assert(r.data.data.dirs[0].git === false, 'each listed folder says whether it is already a git repo');

    r = await req(base + '/api/browse?path=' + encodeURIComponent(path.join(fakeHome, '.gitlive')), 'GET', { token });
    assert(r.status === 400 && r.data.error.code === 'INVALID_ARGS', 'browsing gitlive\'s own folder must be refused: ' + r.status);
    console.log('OK: the picker refuses to wander into gitlive\'s own working folder');

    r = await req(base + '/api/browse?path=' + encodeURIComponent(path.join(shortTmp, 'definitely-not-here-' + Date.now())), 'GET', { token });
    assert(r.status === 400, 'browsing a missing folder is a 400, not a crash: ' + r.status);

    // ── refusals happen BEFORE anything is written
    r = await req(base + '/api/apps', 'POST', { token, body: { name: '../evil', dir: projectDir, start: 'npm start' } });
    assert(r.status === 400 && r.data.error.code === 'INVALID_ARGS', 'path-ish app name must be refused: ' + r.status);
    r = await req(base + '/api/apps', 'POST', { token, body: { name: 'nofolder', dir: path.join(shortTmp, 'nope-' + Date.now()), start: 'npm start' } });
    assert(r.status === 400, 'missing folder must be a 400: ' + r.status);
    r = await req(base + '/api/apps', 'POST', { token, body: { name: 'nostart', dir: bareDir } });
    assert(r.status === 400 && /start command is required/.test(r.data.error.message), 'no detectable stack + no start command must be refused: ' + JSON.stringify(r.data));
    r = await req(base + '/api/apps', 'POST', { token, body: { name: 'badport', dir: projectDir, start: 'npm start', port: '99999' } });
    assert(r.status === 400, 'out-of-range port must be refused: ' + r.status);
    r = await req(base + '/api/apps', 'POST', { token, body: { name: 'safeless', dir: projectDir, start: 'npm start', safe: true } });
    assert(r.status === 400 && /safe \(blue-green\) mode needs the public port/.test(r.data.error.message), 'safe mode without a port must be refused: ' + JSON.stringify(r.data));
    assert(!fs.existsSync(path.join(fakeHome, '.gitlive', 'apps', 'nostart.git')), 'a refused create leaves no bare repo behind');
    const regAfterRefusals = JSON.parse(fs.readFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), 'utf8'));
    assert(Object.keys(regAfterRefusals).length === 0, 'a refused create leaves no registry row behind');
    console.log('OK: every refusal is a validation error and leaves nothing half-created on disk');

    // ── the real thing: the form creates an app through the same gitlive init
    const appPort = await freePort();
    r = await req(base + '/api/apps', 'POST', { token, body: { name: 'fixture-app', dir: projectDir, start: 'npm start', install: 'npm install --omit=dev', port: String(appPort) } });
    assert(r.status === 200 && r.data.data.ok, 'create: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 300));
    const made = r.data.data;
    assert(made.name === 'fixture-app' && made.registered, 'create reports the registered app');
    assert(/git push fixture-app main/.test(made.pushHint), 'create hands back the exact push line: ' + made.pushHint);
    assert(/Done\./.test(made.log), 'the raw gitlive init output is returned verbatim: ' + made.log.slice(0, 200));
    const barePath = path.join(fakeHome, '.gitlive', 'apps', 'fixture-app.git');
    assert(fs.existsSync(barePath), 'the bare repo exists');
    const hook = path.join(barePath, 'hooks', 'post-receive');
    assert(fs.existsSync(hook), 'the deploy hook was written');
    assert((fs.statSync(hook).mode & 0o111) !== 0, 'the deploy hook is executable');
    const reg = JSON.parse(fs.readFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), 'utf8'));
    // /tmp is a symlink to /private/tmp on macOS: gitlive records the physical
    // path it actually ran in, so compare like with like
    assert(reg['fixture-app'] && reg['fixture-app'].cwd === fs.realpathSync(projectDir), 'the registry row points at the chosen folder: ' + (reg['fixture-app'] || {}).cwd);
    assert(String(reg['fixture-app'].port) === String(appPort), 'the registry keeps the port the owner typed');
    const remotes = execFileSync('git', ['-C', projectDir, 'remote', '-v'], { encoding: 'utf8' });
    assert(new RegExp('fixture-app\\s+' + barePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(remotes), 'the project folder got the deploy remote:\n' + remotes);
    console.log('OK: POST /api/apps runs the real gitlive init — bare repo, hook, registry row, remote, output');

    // ── the new app is on the board immediately (awaiting its first push)
    r = await req(base + '/api/apps', 'GET', { token });
    const listed = r.data.data.find((a) => a.name === 'fixture-app');
    assert(listed, 'the created app is listed right away');
    assert(!listed.lastDeploy || !listed.lastDeploy.commit, 'a never-pushed app has no deploy receipt (the UI reads "not deployed yet", not "offline")');
    console.log('OK: the app appears on the board immediately, honestly marked as not-yet-deployed');

    // ── duplicates: refused, then allowed only on an explicit reconfigure
    r = await req(base + '/api/apps', 'POST', { token, body: { name: 'fixture-app', dir: projectDir, start: 'npm start', port: String(appPort) } });
    assert(r.status === 409 && r.data.error.code === 'CONFLICT', 'duplicate name must be a 409: ' + r.status);
    r = await req(base + '/api/apps', 'POST', { token, body: { name: 'fixture-app', dir: projectDir, start: 'npm start', port: String(appPort), reconfigure: true } });
    assert(r.status === 200 && r.data.data.registered, 'an explicit reconfigure is accepted: ' + r.status);
    console.log('OK: a name collision is refused, and re-pointing needs an explicit reconfigure');

    // ── two apps cannot claim one port
    const otherDir = fs.mkdtempSync(path.join(shortTmp, 'gitlive-create-proj2-'));
    fs.writeFileSync(path.join(otherDir, 'package.json'), JSON.stringify({ name: 'second', version: '1.0.0', scripts: { start: 'node server.js' } }));
    r = await req(base + '/api/apps', 'POST', { token, body: { name: 'second-app', dir: otherDir, start: 'npm start', port: String(appPort) } });
    assert(r.status === 409 && /already belongs to/.test(r.data.error.message), 'port collision must be a 409 naming the owner: ' + JSON.stringify(r.data));
    console.log('OK: a port already owned by another app is refused with the owner named');

    // ── the create form is a real UI path: button, modal, ids all present
    const html = fs.readFileSync(path.join(__dirname, '..', 'control', 'dashboard.html'), 'utf8');
    for (const id of ['btn-newapp', 'newapp-modal', 'na-dir', 'na-name', 'na-start', 'na-install', 'na-build', 'na-port', 'na-safe', 'btn-na-create', 'btn-na-browse', 'na-browse-list', 'btn-na-use', 'na-out']) {
      assert(html.includes(`id="${id}"`), 'dashboard is missing #' + id);
    }
    assert(/api\.call\('POST', '\/api\/apps'/.test(html), 'the create form must post to /api/apps');
    console.log('OK: the create form is wired in the dashboard (button → modal → POST /api/apps)');

    console.log('create-app.test.js PASSED — an app can be created from the dashboard, by the real command');
  } finally {
    await server.stop();
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(bareDir, { recursive: true, force: true });
    if (typeof browseDir !== 'undefined') fs.rmSync(browseDir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
