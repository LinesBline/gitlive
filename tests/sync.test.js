'use strict';
// Two-node sync transport (Phase 2 D1) — node A writes app state, pushes a
// snapshot into the members' git bus, node B restores from that bus and sees
// identical data. Real sqlite (VACUUM INTO), real storage blobs, real git
// bare repo, two separate data dirs — no mocks.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const work = fs.mkdtempSync(path.join(shortTmp, 'gitlive-sync-'));
const clientFactory = require(path.join(__dirname, '..', 'gitlive-client'));
const sync = require(path.join(__dirname, '..', 'gitlive-backend-core', 'sync.js'));

const dirA = path.join(work, 'nodeA');
const dirB = path.join(work, 'nodeB');
const bus = path.join(work, 'state.git');
const stagingA = path.join(work, 'stageA');
const stagingB = path.join(work, 'stageB');

(async () => {
  // ── Node A writes real state ────────────────────────────────────────────
  const a = clientFactory({ app: 'syncapp', dataDir: dirA });
  const u = await a.auth.createUser({ email: 'sync@example.com', password: 'hunter22' });
  const blob = crypto.randomBytes(2048);
  await a.storage.put('avatars/u1.png', blob, { contentType: 'image/png' });
  await a.storage.put('notes/hello.txt', Buffer.from('hello from node A'));
  await a.db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)');
  await a.db.exec('INSERT INTO notes (text) VALUES (?)', ['node A row']);
  a.close();

  // ── Primary pushes into the members' git bus ────────────────────────────
  const pushed = sync.pushSnapshot({ dataDir: dirA, stagingDir: stagingA, barePath: bus });
  assert(pushed.ok && pushed.commit, 'push must return a commit sha');
  const commit1 = pushed.commit;
  execFileSync('git', ['--git-dir=' + bus, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf8' }).trim();
  console.log('OK: node A state snapshot pushed to the git bus (' + commit1.slice(0, 8) + ')');

  // ── Node B restores and sees identical state ────────────────────────────
  const restored = sync.restoreLatest({ dataDir: dirB, barePath: bus, stagingDir: stagingB });
  assert(restored.ok, 'restore must succeed: ' + JSON.stringify(restored));
  assert(restored.commit === commit1, 'restore reports the pushed commit');

  const b = clientFactory({ app: 'syncapp', dataDir: dirB });
  const got = await b.storage.get('avatars/u1.png');
  assert(got && got.buffer.equals(blob), 'restored blob bytes must match exactly');
  assert(got.contentType === 'image/png', 'content type survives the round trip');
  const txt = await b.storage.get('notes/hello.txt');
  assert(txt && txt.buffer.toString('utf8') === 'hello from node A', 'second blob restored');
  const users = await b.db.query('SELECT id, email FROM _gitlive_users');
  assert(users.length === 1 && users[0].email === 'sync@example.com', 'sqlite state restored (users intact)');
  const rows = await b.db.query('SELECT text FROM notes');
  assert(rows.length === 1 && rows[0].text === 'node A row', 'app table restored');
  console.log('OK: node B restored identical sqlite + storage state from the bus');
  b.close(); // node B releases its handles before the next restore replaces its db

  // ── A second write wave pushes; B re-restores and sees only the newest ──
  const a2 = clientFactory({ app: 'syncapp', dataDir: dirA });
  await a2.db.exec('INSERT INTO notes (text) VALUES (?)', ['second wave']);
  await a2.storage.delete('notes/hello.txt'); // deletion must propagate too
  a2.close();

  const pushed2 = sync.pushSnapshot({ dataDir: dirA, stagingDir: stagingA, barePath: bus });
  assert(pushed2.commit !== commit1, 'second push advances the bus');
  sync.restoreLatest({ dataDir: dirB, barePath: bus, stagingDir: stagingB });

  const b2 = clientFactory({ app: 'syncapp', dataDir: dirB });
  const rows2 = await b2.db.query('SELECT text FROM notes ORDER BY id');
  assert(rows2.length === 2 && rows2[1].text === 'second wave', 'second wave present on node B');
  assert(await b2.storage.get('notes/hello.txt') === null, 'deleted blob is gone on node B (mirror semantics)');
  assert((await b2.storage.list('notes/')).length === 0, 'storage index consistent after mirror restore');
  console.log('OK: second push advances; B reflects new writes AND deletions (whole-state LWW)');
  b2.close();

  // ── Snapshot files stay bounded in the staging mirror ───────────────────
  const snaps = fs.readdirSync(stagingA).filter((f) => /^app\.db\.snap-.*\.db$/.test(f));
  assert(snaps.length <= sync.MAX_KEPT_SNAPSHOTS, 'staging keeps at most ' + sync.MAX_KEPT_SNAPSHOTS + ' snapshots');

  console.log('OK: snapshot files bounded in staging');

  // ── D3: owner-key encrypted push/restore ────────────────────────────────
  const key = crypto.randomBytes(32);
  const dirC = path.join(work, 'nodeA-enc');
  const busEnc = path.join(work, 'state-enc.git');
  const stageEnc = path.join(work, 'stage-enc');
  const c = clientFactory({ app: 'syncapp', dataDir: dirC });
  await c.storage.put('enc/secret.bin', Buffer.from('ciphertext-me'), { contentType: 'application/octet-stream' });
  await c.db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)');
  await c.db.exec('INSERT INTO notes (text) VALUES (?)', ['encrypted wave']);
  c.close();

  const pushedEnc = sync.pushSnapshot({ dataDir: dirC, stagingDir: stageEnc, barePath: busEnc, encryptKey: key });
  assert(pushedEnc.ok, 'encrypted push');
  // the bus holds ciphertext: every storage blob + snapshot is a .glc file
  const tree = execFileSync('git', ['--git-dir=' + busEnc, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
  const blobPaths = tree.split('\n').filter((l) => l.startsWith('storage/'));
  assert(blobPaths.length === 1 && blobPaths[0].endsWith('.glc'), 'storage blob stored as ciphertext: ' + blobPaths.join(','));
  assert(/app\.db\.snap-.*\.glc/.test(tree), 'snapshot stored as ciphertext');
  assert(!tree.split('\n').some((l) => l.endsWith('secret.bin')), 'no plaintext path leaks');

  // restore without the key must fail loudly (ciphertext stays ciphertext)
  const noKey = sync.restoreLatest({ dataDir: path.join(work, 'nodeD-nokey'), barePath: busEnc, stagingDir: path.join(work, 'stage-nokey') });
  assert(noKey.ok === false && /owner-key encrypted/.test(noKey.reason), 'restore without key refused: ' + JSON.stringify(noKey));

  // restore with the key yields identical state
  const dirD = path.join(work, 'nodeD');
  const restoredEnc = sync.restoreLatest({ dataDir: dirD, barePath: busEnc, stagingDir: path.join(work, 'stageD'), decryptKey: key });
  assert(restoredEnc.ok && restoredEnc.encrypted === true, 'encrypted restore ok');
  const d = clientFactory({ app: 'syncapp', dataDir: dirD });
  const sec = await d.storage.get('enc/secret.bin');
  assert(sec && sec.buffer.toString('utf8') === 'ciphertext-me', 'encrypted blob restored exactly');
  const rowsE = await d.db.query('SELECT text FROM notes ORDER BY id');
  assert(rowsE.some((r) => r.text === 'encrypted wave'), 'encrypted snapshot restored');
  d.close();
  console.log('OK: owner-key state — bus holds ciphertext only; restore refused without key; identical with key');

  console.log('\nALL SYNC TRANSPORT TESTS PASSED');
})().catch((err) => {
  console.error('SYNC TEST FAILED:', (err && err.stack) || err);
  process.exitCode = 1;
});
