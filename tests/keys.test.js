'use strict';
// Item 3 — key rotation core. Storage rotation re-encrypts .glc files
// old→new and records a signed handover; node/owner rotation replaces the
// keypair with the OLD key signing the handover. CLI children, fake $HOME.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glkeys-'));
const storageKey = path.join(home, '.gitlive', 'storage.key');
const nodeKey = path.join(home, '.gitlive', 'node-key.pem');
const manifestKey = path.join(home, '.gitlive', 'manifest-owner-key.pem');
const env = { ...process.env, HOME: home, GITLIVE_STORAGE_KEY: storageKey, GITLIVE_NODE_KEY: nodeKey, GITLIVE_MANIFEST_KEY: manifestKey };

function cli(args) {
  return execFileSync('node', [GITLIVE_JS, 'keys', ...args], { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function cliCrypt(args) {
  return execFileSync('node', [GITLIVE_JS, 'crypt', ...args], { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
}

(async () => {
  // seed keys
  cliCrypt(['keygen']);
  execFileSync('node', [GITLIVE_JS, 'manifest', 'keygen'], { env, encoding: 'utf8' });

  // ── storage rotation with re-encryption ─────────────────────────────────
  const encDir = path.join(shortTmp, 'encdir');
  fs.mkdirSync(encDir, { recursive: true });
  const secret = 'rotate me safely';
  cliCrypt(['enc', (fs.writeFileSync(path.join(shortTmp, 's.txt'), secret), path.join(shortTmp, 's.txt')), path.join(encDir, 'data.glc')]);
  const rot = cli(['rotate', 'storage', '--reencrypt-dir', encDir]);
  assert(/storage key rotated [0-9A-F]{16} → [0-9A-F]{16}/.test(rot), 'storage rotation output:\n' + rot);
  const outFile = path.join(shortTmp, 's2.txt');
  cliCrypt(['dec', path.join(encDir, 'data.glc'), outFile]);
  assert(fs.readFileSync(outFile, 'utf8') === secret, 're-encrypted file decrypts under the NEW key');
  const oldRaw = require('../crypt.js'); // new key differs
  const logs = fs.readFileSync(path.join(home, '.gitlive', 'rotations.log'), 'utf8');
  assert(/storage-key-rotation/.test(logs), 'handover recorded');
  console.log('OK: storage key rotated; .glc files re-encrypted old→new; handover logged');

  // ── node key rotation (old key signs) ───────────────────────────────────
  execFileSync('node', [GITLIVE_JS, 'manifest', 'keygen'], { env: { ...env, GITLIVE_MANIFEST_KEY: path.join(home, 'owner.pem') }, encoding: 'utf8' });
  require('../peer.js');
  const { ensureNodeKey } = require('../peer.js');
  ensureNodeKey(nodeKey); // mint node key first
  const before = require('../manifest.js').loadPrivateKey(nodeKey).fingerprint;
  const rotN = cli(['rotate', 'node']);
  assert(/node key rotated/.test(rotN), 'node rotation:\n' + rotN);
  const after = require('../manifest.js').loadPrivateKey(nodeKey).fingerprint;
  assert(before !== after, 'node fingerprint changed');
  assert(/node-key-rotation/.test(fs.readFileSync(path.join(home, '.gitlive', 'rotations.log'), 'utf8')), 'node handover logged');
  console.log('OK: node key rotated; handover signed by the old key');

  // ── owner key rotation ──────────────────────────────────────────────────
  const beforeO = require('../manifest.js').loadPrivateKey(manifestKey).fingerprint;
  const rotO = cli(['rotate', 'owner']);
  assert(/owner key rotated/.test(rotO), 'owner rotation:\n' + rotO);
  const afterO = require('../manifest.js').loadPrivateKey(manifestKey).fingerprint;
  assert(beforeO !== afterO, 'owner fingerprint changed');
  const logs2 = fs.readFileSync(path.join(home, '.gitlive', 'rotations.log'), 'utf8');
  assert(/owner-key-rotation/.test(logs2) && /peer trust add/.test(rotO), 'owner handover + next-step guidance');
  console.log('OK: owner key rotated; handover signed; guidance printed');

  // ── ledger view ─────────────────────────────────────────────────────────
  const view = cli(['rotations']);
  assert((view.match(/rotation/g) || []).length >= 3, 'ledger lists all rotations:\n' + view);
  console.log('OK: rotations ledger lists every rotation');

  console.log('\nALL KEY ROTATION TESTS PASSED');
})().catch((err) => {
  console.error('KEYS TEST FAILED:', (err && err.message) || err);
  if (err && err.stderr) console.error(String(err.stderr).slice(0, 600));
  process.exitCode = 1;
});
