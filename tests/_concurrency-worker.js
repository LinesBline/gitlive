'use strict';
// Child process for concurrency-multiprocess.test.js — opens its own
// standalone gitlive-client connection (same as a real app process would)
// and writes a batch of rows, some with a tiny random delay to increase the
// chance of actually interleaving with the other worker process rather than
// finishing before it even starts.

const path = require('path');
const core = require(path.join(__dirname, '..', 'gitlive-backend-core', 'index.js'));

const label = process.env.WORKER_LABEL;
const count = Number(process.env.WRITE_COUNT);
const dataDir = process.env.GITLIVE_DATA_DIR;

async function main() {
  const ctx = core.openApp(dataDir);
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS concurrency_test (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker TEXT NOT NULL,
      seq INTEGER NOT NULL,
      written_at TEXT NOT NULL
    )
  `);

  let written = 0;
  for (let seq = 0; seq < count; seq++) {
    // Occasionally yield to the event loop so this process's writes actually
    // interleave with the other worker's, rather than one process racing
    // through all 200 writes before the other even gets scheduled by the OS.
    if (seq % 10 === 0) await new Promise((r) => setImmediate(r));
    core.db.exec(ctx, 'INSERT INTO concurrency_test (worker, seq, written_at) VALUES (?, ?, ?)', [
      label,
      seq,
      new Date().toISOString(),
    ]);
    written++;
  }

  core.close(ctx);
  process.send({ label, ok: true, written });
  process.exit(0);
}

main().catch((err) => {
  process.send({ label, ok: false, written: 0, error: err.message });
  process.exit(1);
});
