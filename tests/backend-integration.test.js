'use strict';
// Full integration test against the REAL, patched gitlive.js CLI — not a
// simulation of it. Runs `node gitlive.js backend start/stop` and `status`
// as actual child processes against a fake $HOME, exactly like a real
// invocation, then drives gitlive-client against the same app to prove the
// daemon it started is actually reachable and adopts data correctly.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

// macOS's default $TMPDIR (/var/folders/.../T) is long enough that a
// gitlive daemon socket inside a fake $HOME under it exceeds the ~104-byte
// Unix socket path limit (listen EINVAL). /tmp is short on macOS and Linux.
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const fakeHome = fs.mkdtempSync(path.join(shortTmp, 'gitlive-home-'));
const env = { ...process.env, HOME: fakeHome };

function run(args) {
  return execFileSync('node', [GITLIVE_JS, ...args], { env, encoding: 'utf8' });
}

(async () => {
  // Hand-build a registry entry matching gitlive.js's real shape (as if
  // `gitlive init myapp --start "node server.js" --yes` had already run) —
  // avoids needing an actual git repo just to test the backend subcommand.
  const appsDir = path.join(fakeHome, '.gitlive', 'apps');
  const runPath = path.join(appsDir, 'myapp-run');
  fs.mkdirSync(runPath, { recursive: true });
  fs.mkdirSync(path.join(appsDir), { recursive: true });
  const registry = {
    myapp: {
      cwd: '/tmp/fake-myapp-source',
      barePath: path.join(appsDir, 'myapp.git'),
      runPath,
      installCmd: 'npm install',
      startCmd: 'node server.js',
      port: '3000',
      createdAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), JSON.stringify(registry, null, 2));

  // Status BEFORE the daemon starts: should say standalone, no data yet.
  const statusBefore = run(['status', 'myapp']);
  assert(statusBefore.includes('backend: standalone (no data yet)'), 'expected standalone/no-data before daemon FAIL:\n' + statusBefore);
  console.log('OK: gitlive status shows standalone/no-data before any client or daemon has touched the app');

  // Start the backend daemon via the real CLI.
  const startOut = run(['backend', 'start', 'myapp']);
  assert(startOut.includes('Backend daemon started, serving: myapp'), 'backend start output FAIL:\n' + startOut);
  console.log('OK: gitlive backend start ran via the real CLI');

  // Give the detached process a moment to actually bind its socket.
  await new Promise((r) => setTimeout(r, 400));

  const dataDir = path.join(runPath, 'data');
  const socketPath = path.join(dataDir, 'backend.sock');
  assert(fs.existsSync(socketPath), 'expected backend.sock to exist after backend start FAIL');
  console.log('OK: backend.sock exists at the real per-app data dir gitlive.js already uses ($TARGET/data)');

  // Status AFTER the daemon starts: should say daemon mode.
  const statusAfterStart = run(['status', 'myapp']);
  assert(/backend: daemon \(daemon pid \d+\)/.test(statusAfterStart), 'expected daemon mode in status FAIL:\n' + statusAfterStart);
  console.log('OK: gitlive status reflects daemon mode with a real pid');

  // Drive gitlive-client against this exact app the way a real deployed app
  // would (env var already matches what gitlive.js's hooks set for real).
  process.env.GITLIVE_DATA_DIR = dataDir;
  const gitliveClient = require('../gitlive-client/index.js');
  const client = gitliveClient({ app: 'myapp' });
  await client.db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)');
  await client.db.exec('INSERT INTO notes (text) VALUES (?)', ['hello from the real gitlive CLI daemon']);
  const rows = await client.db.query('SELECT * FROM notes');
  assert(rows.length === 1 && rows[0].text === 'hello from the real gitlive CLI daemon', 'client round-trip through the real-CLI-started daemon FAIL: ' + JSON.stringify(rows));
  assert(client.mode() === 'daemon', 'client should be in daemon mode FAIL, got ' + client.mode());
  console.log('OK: gitlive-client, using $GITLIVE_DATA_DIR the same way a real deploy sets it, talks to the daemon the real CLI started');

  // Status now shows hasData too.
  const statusWithData = run(['status', 'myapp']);
  assert(!statusWithData.includes('no data yet'), 'expected hasData true after a real write FAIL:\n' + statusWithData);
  console.log('OK: gitlive status shows data present after a real write');

  // Stop the daemon via the real CLI; client falls back automatically.
  const stopOut = run(['backend', 'stop']);
  assert(stopOut.includes('Backend daemon stopped'), 'backend stop output FAIL:\n' + stopOut);
  await new Promise((r) => setTimeout(r, 300));
  assert(!fs.existsSync(socketPath), 'expected backend.sock to be gone after backend stop FAIL');

  const rowsAfterStop = await client.db.query('SELECT * FROM notes');
  assert(rowsAfterStop.length === 1, 'fallback query after real CLI stopped the daemon FAIL: ' + JSON.stringify(rowsAfterStop));
  assert(client.mode() === 'standalone', 'expected client to fall back to standalone FAIL, got ' + client.mode());
  console.log('OK: gitlive backend stop (real CLI) + automatic client fallback both work, same data still there');

  const statusAfterStop = run(['status', 'myapp']);
  assert(statusAfterStop.includes('backend: standalone'), 'expected standalone in status after stop FAIL:\n' + statusAfterStop);
  console.log('OK: gitlive status reflects standalone again after the daemon stops');

  client.close();
  console.log('\nALL BACKEND-CLI INTEGRATION TESTS PASSED');
})().catch((err) => {
  console.error('INTEGRATION TEST FAILED:', err);
  process.exitCode = 1;
});
