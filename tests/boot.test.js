'use strict';
// boot recovery — the blindspot that trapped the owner: after a reboot
// nothing was running and the first command had to come from a terminal.
// `gitlive boot install` writes a macOS LaunchAgent (fake HOME in tests, so
// nothing real is touched) and the control plane, started with
// GITLIVE_BOOT_RESTORE=1, runs the master switch once at boot.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const fakeHome = fs.mkdtempSync(path.join(shortTmp, 'glboot-'));
const env = { ...process.env, HOME: fakeHome };

function cli(args) {
  return execFileSync('node', [GITLIVE_JS, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

(async () => {
  // 1 — install writes a valid LaunchAgent plist under the fake home
  const out = cli(['boot', 'install']);
  assert(/installed/.test(out), 'install reports:\n' + out);
  const plistPath = path.join(fakeHome, 'Library', 'LaunchAgents', 'dev.gitlive.control.plist');
  assert(fs.existsSync(plistPath), 'the plist lands under ~/Library/LaunchAgents');
  const text = fs.readFileSync(plistPath, 'utf8');
  for (const need of ['dev.gitlive.control', 'RunAtLoad', 'KeepAlive', 'serve', '--no-open', 'GITLIVE_BOOT_RESTORE', '<string>1</string>']) {
    assert(text.includes(need), `the plist carries ${need}`);
  }
  assert(!text.includes('undefined'), 'no unresolved template values in the plist');
  console.log('OK: boot install writes a valid LaunchAgent (no sudo, boot-restore env)');

  // 2 — status sees it; remove takes it away
  const st = cli(['boot', 'status']);
  assert(/installed/.test(st), 'status sees the installed agent:\n' + st);
  cli(['boot', 'remove']);
  assert(!fs.existsSync(plistPath), 'remove deletes the plist');
  console.log('OK: boot status + remove');

  // 3 — the caretaker: serve with GITLIVE_BOOT_RESTORE=1 runs the master
  // switch once at boot (a down app gets checked; nothing crashes)
  fs.mkdirSync(path.join(fakeHome, '.gitlive', 'control'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.gitlive', 'apps'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), JSON.stringify({
    bootapp: {
      cwd: '/tmp/nonexistent-source', barePath: path.join(fakeHome, '.gitlive', 'apps', 'bootapp.git'),
      runPath: path.join(fakeHome, '.gitlive', 'apps', 'bootapp-run'),
      installCmd: 'true', startCmd: 'node server.js', port: '32001',
      createdAt: new Date().toISOString(),
    },
  }, null, 2));
  fs.mkdirSync(path.join(fakeHome, '.gitlive', 'apps', 'bootapp-run'), { recursive: true });
  const child = spawn('node', [GITLIVE_JS, 'serve', '--port', '5211', '--no-open'], {
    env: { ...env, GITLIVE_BOOT_RESTORE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch('http://127.0.0.1:5211/'); up = r.ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert(up, 'the control plane comes up with boot-restore set');
  await new Promise((r) => setTimeout(r, 1500));
  assert(/\[boot\] machine restore: 1 app\(s\) checked/.test(log), 'the caretaker ran the master switch at boot:\n' + log.slice(-400));
  child.kill('SIGKILL');
  console.log('OK: the caretaker — GITLIVE_BOOT_RESTORE runs the master switch once at boot');

  console.log('\nALL BOOT TESTS PASSED');
})().catch((err) => {
  console.error('BOOT TEST FAILED:', (err && err.message) || err);
  if (err && err.stdout) console.error(String(err.stdout).slice(0, 400));
  if (err && err.stderr) console.error(String(err.stderr).slice(0, 400));
  process.exitCode = 1;
});
