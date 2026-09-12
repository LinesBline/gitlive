'use strict';
// WORKFLOW P1 — gitlive audit: the readiness front door. A good app passes
// (exit 0), a bad app is blocked with named verdicts (exit 1), a missing
// dir fails cleanly. Real fixtures under /tmp, no network.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();

function runAudit(dir) {
  try {
    return { exit: 0, out: execFileSync('node', [GITLIVE_JS, 'audit', dir], { encoding: 'utf8' }) };
  } catch (err) {
    return { exit: err.status || 1, out: String(err.stdout || '') + String(err.stderr || '') };
  }
}

function git(cwd, args) {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

(async () => {
  // 1 — a gitlive-ready app passes
  const good = fs.mkdtempSync(path.join(shortTmp, 'glaudit-good-'));
  fs.writeFileSync(path.join(good, 'package.json'), JSON.stringify({ name: 'goodapp', version: '1.0.0', scripts: { start: 'node server.js' }, dependencies: { x: '1.0.0' } }, null, 2));
  fs.writeFileSync(path.join(good, 'package-lock.json'), JSON.stringify({ name: 'goodapp', lockfileVersion: 3, packages: { '': {}, 'node_modules/x': {} } }));
  fs.writeFileSync(path.join(good, 'server.js'), "const http = require('http'); const PORT = Number(process.env.PORT) || 3000; http.createServer((q, s) => { if (q.url === '/health') { s.end('ok'); return; } s.end('hi'); }).listen(PORT);\n");
  fs.writeFileSync(path.join(good, '.gitignore'), 'node_modules/\n.env\n');
  git(good, ['init', '-q', '-b', 'main']);
  git(good, ['add', '-A']);
  git(good, ['-c', 'user.email=g@x.io', '-c', 'user.name=g', 'commit', '-qm', 'v1']);
  const goodRes = runAudit(good);
  assert(goodRes.exit === 0, 'good app exits 0:\n' + goodRes.out);
  for (const line of ['stack', 'start command', 'PORT from environment', 'health endpoint', 'lockfile', 'secret hygiene']) {
    assert(new RegExp('\\[' + (line.includes('health') || line.includes('PORT') || line.includes('start') || line.includes('lockfile') ? 'ok' : 'ok') + '\\] ' + line).test(goodRes.out) || goodRes.out.includes('[ok  ] ' + line), 'good audit names ' + line + ':\n' + goodRes.out);
  }
  console.log('OK: a gitlive-ready app audits clean (exit 0)');

  // 2 — a broken app is blocked with named blockers
  const bad = fs.mkdtempSync(path.join(shortTmp, 'glaudit-bad-'));
  fs.writeFileSync(path.join(bad, 'package.json'), JSON.stringify({ name: 'badapp', version: '1.0.0', scripts: { start: 'node server.js' }, dependencies: { x: '1.0.0' } }, null, 2));
  fs.writeFileSync(path.join(bad, 'server.js'), "const http = require('http'); http.createServer((q, s) => s.end('hi')).listen(8080);\n"); // hardcoded port, no /health
  fs.writeFileSync(path.join(bad, '.env'), 'SECRET=leaked\n');
  git(bad, ['init', '-q', '-b', 'main']);
  git(bad, ['add', '-A']);
  git(bad, ['-c', 'user.email=g@x.io', '-c', 'user.name=g', 'commit', '-qm', 'v1']);
  const badRes = runAudit(bad);
  assert(badRes.exit === 1, 'bad app exits 1:\n' + badRes.out);
  for (const check of ['lockfile (closure pinning)', 'secret hygiene']) {
    assert(badRes.out.includes('[FAIL] ' + check), 'bad audit flags ' + check + ':\n' + badRes.out);
  }
  assert(badRes.out.includes('2 blocker(s)'), 'counts the blockers:\n' + badRes.out);
  console.log('OK: a broken app is blocked — lockfile + secret hygiene named as blockers (exit 1)');

  // 3 — a /health string inside a vendored dependency tree is NOT the app's
  // health route (field finding: a vendored python file made audit claim
  // "[ok] health endpoint" for an app that had none).
  const vend = fs.mkdtempSync(path.join(shortTmp, 'glaudit-vend-'));
  fs.writeFileSync(path.join(vend, 'package.json'), JSON.stringify({ name: 'vendapp', version: '1.0.0', scripts: { start: 'node server.js' }, dependencies: { x: '1.0.0' } }, null, 2));
  fs.writeFileSync(path.join(vend, 'package-lock.json'), JSON.stringify({ name: 'vendapp', lockfileVersion: 3, packages: { '': {}, 'node_modules/x': {} } }));
  fs.writeFileSync(path.join(vend, 'server.js'), "const http = require('http'); const PORT = Number(process.env.PORT) || 3000; http.createServer((q, s) => s.end('hi')).listen(PORT);\n"); // no health route of its own
  fs.mkdirSync(path.join(vend, '.venv', 'lib', 'py'), { recursive: true });
  fs.writeFileSync(path.join(vend, '.venv', 'lib', 'py', '_client.py'), 'route = "/health"\n');
  git(vend, ['init', '-q', '-b', 'main']);
  git(vend, ['add', '-A']);
  git(vend, ['-c', 'user.email=g@x.io', '-c', 'user.name=g', 'commit', '-qm', 'v1']);
  const vendRes = runAudit(vend);
  assert(!/found \/health handling/.test(vendRes.out), 'a vendored "/health" string must not count as the app\'s health route:\n' + vendRes.out);
  console.log('OK: vendored "/health" strings are not the app\'s health route');

  // 4 — missing directory fails cleanly
  const miss = runAudit(path.join(shortTmp, 'glaudit-does-not-exist'));
  assert(miss.exit === 1 && /no such directory/.test(miss.out), 'missing dir fails cleanly:\n' + miss.out);
  console.log('OK: missing directory fails cleanly');

  console.log('\nALL AUDIT TESTS PASSED');
})().catch((err) => {
  console.error('AUDIT TEST FAILED:', (err && err.message) || err);
  process.exitCode = 1;
});
