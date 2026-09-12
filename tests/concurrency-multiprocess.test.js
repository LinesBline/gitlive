'use strict';
// The realistic multi-process concurrency scenario: during a --safe blue-green
// deploy, the OLD (still serving) and NEW (being health-checked) instances
// are two SEPARATE Node processes, each with their own gitlive-client
// standalone connection, both pointed at the SAME $GITLIVE_DATA_DIR (shared
// on purpose — see DESIGN.md #1). This has never actually been tested:
// everything so far has been single-process. This spawns two real child
// processes and hammers the same SQLite file from both at once.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const WORKER_SCRIPT = path.join(__dirname, '_concurrency-worker.js');

const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();

async function main() {
  const dataDir = fs.mkdtempSync(path.join(shortTmp, 'gitlive-mp-'));
  const WRITES_PER_PROCESS = 200;

  console.log(`Spawning 2 real child processes, each writing ${WRITES_PER_PROCESS} rows to the same SQLite file concurrently...`);

  const results = await Promise.all([
    runWorker('A', dataDir, WRITES_PER_PROCESS),
    runWorker('B', dataDir, WRITES_PER_PROCESS),
  ]);

  for (const r of results) {
    assert(r.ok, `worker ${r.label} reported failure: ${r.error}`);
    assert(r.written === WRITES_PER_PROCESS, `worker ${r.label} only confirmed ${r.written}/${WRITES_PER_PROCESS} writes`);
  }
  console.log('OK: both processes completed all writes with no errors, no crashes');

  // Verify from a third, fresh connection that every row from both processes
  // actually landed — this is the real question: does WAL mode's promise of
  // "concurrent processes, no corruption" actually hold, or did some writes
  // silently get lost/overwritten under real concurrent multi-process access.
  const core = require('../gitlive-backend-core/index.js');
  const ctx = core.openApp(dataDir);
  const rows = core.db.query(ctx, 'SELECT COUNT(*) AS n FROM concurrency_test');
  const expected = WRITES_PER_PROCESS * 2;
  assert(rows[0].n === expected, `expected ${expected} total rows, found ${rows[0].n} — data loss under concurrent multi-process writes FAIL`);
  console.log(`OK: all ${expected} rows from both processes present and correct — no data loss, no corruption`);

  const distinct = core.db.query(ctx, 'SELECT COUNT(DISTINCT worker || \':\' || seq) AS n FROM concurrency_test');
  assert(distinct[0].n === expected, `expected ${expected} distinct rows, found ${distinct[0].n} — possible duplicate/overwritten rows FAIL`);
  console.log('OK: every row is distinct — no overwritten/duplicated writes');

  core.close(ctx);
  console.log('\nALL MULTI-PROCESS CONCURRENCY TESTS PASSED');
}

function runWorker(label, dataDir, count) {
  return new Promise((resolve) => {
    const child = fork(WORKER_SCRIPT, [], {
      env: { ...process.env, GITLIVE_DATA_DIR: dataDir, WORKER_LABEL: label, WRITE_COUNT: String(count) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', (d) => process.stdout.write(`[worker ${label}] ` + d));
    child.stderr.on('data', (d) => process.stdout.write(`[worker ${label} err] ` + d));
    child.on('message', (msg) => resolve(msg));
    child.on('exit', (code) => {
      if (code !== 0) resolve({ label, ok: false, error: `exited with code ${code}` });
    });
  });
}

main().catch((err) => {
  console.error('CONCURRENCY TEST FAILED:', err);
  process.exitCode = 1;
});
