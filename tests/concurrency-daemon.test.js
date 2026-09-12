'use strict';
// Daemon-side concurrency: many simultaneous gitlive-client calls (each its
// own socket connection, real RPC round-trips) against the daemon, and two
// different apps served by the same daemon process at once, checking for
// cross-contamination between them. Uses the real CLI (`node gitlive.js
// backend start`), same as tests/backend-integration.test.js, not a
// programmatic shortcut.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');

// Long $TMPDIR paths overflow the Unix socket limit (~104 bytes) — see
// backend-integration.test.js for the full reasoning; /tmp is short.
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();

async function main() {
  const fakeHome = fs.mkdtempSync(path.join(shortTmp, 'gitlive-daemon-home-'));
  const env = { ...process.env, HOME: fakeHome };
  const appsDir = path.join(fakeHome, '.gitlive', 'apps');

  const runPathA = path.join(appsDir, 'app-a-run');
  const runPathB = path.join(appsDir, 'app-b-run');
  fs.mkdirSync(runPathA, { recursive: true });
  fs.mkdirSync(runPathB, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.gitlive'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, '.gitlive', 'apps.json'),
    JSON.stringify(
      {
        'app-a': { cwd: '/tmp/a', barePath: path.join(appsDir, 'app-a.git'), runPath: runPathA, startCmd: 'node server.js', createdAt: new Date().toISOString() },
        'app-b': { cwd: '/tmp/b', barePath: path.join(appsDir, 'app-b.git'), runPath: runPathB, startCmd: 'node server.js', createdAt: new Date().toISOString() },
      },
      null,
      2
    )
  );

  console.log('Starting the real daemon (via gitlive.js CLI) serving BOTH app-a and app-b...');
  const startOut = execFileSync('node', [GITLIVE_JS, 'backend', 'start', 'app-a', 'app-b'], { env, encoding: 'utf8' });
  assert(startOut.includes('serving: app-a, app-b'), 'expected daemon to report serving both apps FAIL:\n' + startOut);
  await new Promise((r) => setTimeout(r, 400));

  const dataDirA = path.join(runPathA, 'data');
  const dataDirB = path.join(runPathB, 'data');
  const gitliveClient = require('../gitlive-client/index.js');

  try {
    // -- Test 1: many concurrent clients hitting the SAME app through the daemon --
    const CONCURRENCY = 50;
    console.log(`Firing ${CONCURRENCY} concurrent signups at app-a through the daemon...`);
    const clientsA = Array.from({ length: CONCURRENCY }, () => gitliveClient({ app: 'app-a', dataDir: dataDirA }));
    const results = await Promise.all(
      clientsA.map((c, i) => c.auth.createUser({ email: `user${i}@a.test`, password: 'x' }))
    );
    assert(results.length === CONCURRENCY, 'not all concurrent signups resolved FAIL');
    const ids = new Set(results.map((r) => r.id));
    assert(ids.size === CONCURRENCY, `expected ${CONCURRENCY} distinct user ids, got ${ids.size} — duplicate/collided ids under concurrency FAIL`);
    console.log(`OK: all ${CONCURRENCY} concurrent signups succeeded with distinct ids — no races, no lost writes`);

    const statsA = await clientsA[0].stats();
    assert(statsA.userCount === CONCURRENCY, `expected userCount ${CONCURRENCY}, got ${statsA.userCount} FAIL`);
    assert(clientsA[0].mode() === 'daemon', 'expected clientsA to be in daemon mode FAIL, got ' + clientsA[0].mode());
    console.log('OK: final user count matches exactly — daemon serialized every write correctly, confirmed running in daemon mode');

    // -- Test 2: two apps under ONE daemon, concurrent traffic, no cross-contamination --
    console.log('Firing concurrent traffic at app-a and app-b simultaneously...');
    const clientB = gitliveClient({ app: 'app-b', dataDir: dataDirB });
    await Promise.all([
      clientB.auth.createUser({ email: 'only-in-b@test.com', password: 'y' }),
      clientsA[0].auth.createUser({ email: 'another-in-a@test.com', password: 'z' }),
    ]);

    const finalStatsA = await clientsA[0].stats();
    const finalStatsB = await clientB.stats();
    assert(finalStatsA.userCount === CONCURRENCY + 1, `app-a should have ${CONCURRENCY + 1} users, got ${finalStatsA.userCount} FAIL`);
    assert(finalStatsB.userCount === 1, `app-b should have exactly 1 user, got ${finalStatsB.userCount} FAIL`);
    console.log('OK: app-a and app-b stayed fully isolated under one daemon — no cross-app leakage');

    const bUsers = await clientB.db.query('SELECT email FROM _gitlive_users');
    const leaked = bUsers.some((u) => u.email.endsWith('@a.test'));
    assert(!leaked, "app-a emails found inside app-b's database — real cross-app data leak FAIL");
    console.log("OK: confirmed directly — zero app-a data present in app-b's database");

    console.log('\nALL DAEMON CONCURRENCY TESTS PASSED');
  } finally {
    execFileSync('node', [GITLIVE_JS, 'backend', 'stop'], { env, encoding: 'utf8' });
  }
}

main().catch((err) => {
  console.error('DAEMON CONCURRENCY TEST FAILED:', err);
  process.exitCode = 1;
});
