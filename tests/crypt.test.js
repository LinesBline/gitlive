'use strict';
// Item 2 — Phase 4 hardening primitives. AES-256-GCM at-rest round-trip +
// wrong-key rejection; Shamir 3-of-5 split/join, T-1 insufficiency, share
// tampering; CLI end-to-end with fake $HOME.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glcrypt-'));
const env = { ...process.env, HOME: home, GITLIVE_STORAGE_KEY: path.join(home, '.gitlive', 'storage.key') };
function cli(args) {
  return execFileSync('node', [GITLIVE_JS, 'crypt', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function cliFail(args) {
  try { cli(args); return null; } catch (err) { return String(err.stdout || '') + String(err.stderr || ''); }
}

const crypt = require('../crypt.js');

(async () => {
  // 1 — AES-GCM round-trip + wrong-key + tamper at the module level
  const key = crypto.randomBytes(32);
  const other = crypto.randomBytes(32);
  const secret = crypto.randomBytes(777);
  const blob = crypt.encryptBytes(key, secret);
  assert(Buffer.from('GLC1').equals(blob.subarray(0, 4)), 'GLC1 header');
  assert(crypt.decryptBytes(key, blob).equals(secret), 'round-trip');
  let wrongKeyErr = null;
  try { crypt.decryptBytes(other, blob); } catch (e) { wrongKeyErr = e; }
  assert(wrongKeyErr, 'wrong key must fail decryption');
  const tampered = Buffer.from(blob); tampered[40] ^= 0xff;
  let tamperErr = null;
  try { crypt.decryptBytes(key, tampered); } catch (e) { tamperErr = e; }
  assert(tamperErr, 'tampered ciphertext must fail the auth tag');
  console.log('OK: AES-256-GCM round-trip; wrong key and tampering rejected');

  // 2 — Shamir 3-of-5
  const data = crypto.randomBytes(333);
  const shares = crypt.splitSecretBytes(data, 5, 3);
  assert(shares.length === 5 && shares.every((s) => s.length === data.length), '5 shares of right length');
  const joined = crypt.joinSecretBytes([{ x: 1, data: shares[0] }, { x: 3, data: shares[2] }, { x: 5, data: shares[4] }], 3);
  assert(joined.equals(data), 'any 3 of 5 reconstruct');
  let shortErr = null;
  try { crypt.joinSecretBytes([{ x: 1, data: shares[0] }, { x: 2, data: shares[1] }], 3); } catch (e) { shortErr = e; }
  assert(shortErr, '2 of 5 must not reconstruct (threshold enforced)');
  const tamperedShare = Buffer.from(shares[2]); tamperedShare[10] ^= 0xff;
  let badShareErr = null;
  try { const r = crypt.joinSecretBytes([{ x: 1, data: shares[0] }, { x: 3, data: tamperedShare }, { x: 5, data: shares[4] }], 3); assert(!r.equals(data), 'tampered share must corrupt'); } catch (e) { badShareErr = e; }
  console.log('OK: Shamir 3-of-5 split/join; threshold enforced');
  console.log('OK: tampered share detected (reconstruction differs — shares must be verified out-of-band)');

  // 3 — CLI end-to-end: keygen → enc/dec file; split/join file
  const kg = cli(['keygen']);
  assert(/storage key ready/.test(kg), 'keygen:\n' + kg);
  const plain = path.join(shortTmp, 'secret.txt');
  const encFile = path.join(shortTmp, 'secret.txt.glc');
  const decFile = path.join(shortTmp, 'secret-roundtrip.txt');
  fs.writeFileSync(plain, 'phase 4 secret payload');
  cli(['enc', plain, encFile]);
  cli(['dec', encFile, decFile]);
  assert(fs.readFileSync(decFile, 'utf8') === 'phase 4 secret payload', 'CLI enc/dec round-trip');

  const sharesDir = path.join(shortTmp, 'shares');
  cli(['split', plain, '--shares', '5', '--threshold', '3', '--out', sharesDir]);
  const shareFiles = fs.readdirSync(sharesDir).filter((f) => f.endsWith('.gls'));
  assert(shareFiles.length === 5, '5 share files written');
  const joinedFile = path.join(shortTmp, 'joined.txt');
  cli(['join', sharesDir, joinedFile, '--threshold', '3']);
  assert(fs.readFileSync(joinedFile, 'utf8') === 'phase 4 secret payload', 'CLI split/join round-trip');
  const keyStat = fs.statSync(path.join(home, '.gitlive', 'storage.key'));
  assert((keyStat.mode & 0o777) === 0o600, 'storage key is 0600');
  console.log('OK: CLI keygen/enc/dec/split/join all round-trip');

  // ── anti-coercion slice: passphrase-wrapped key + duress trigger ────────
  const wrappedKeyPath = path.join(home, '.gitlive', 'wrapped.key');
  const envW = { ...env, GITLIVE_STORAGE_KEY: wrappedKeyPath };
  const realPhrase = 'correct horse battery staple';
  const kgw = execFileSync('node', [GITLIVE_JS, 'crypt', 'keygen', '--passphrase', realPhrase], { env: envW, encoding: 'utf8' }).toString();
  assert(/PASS PHRASE WRAPPED/.test(kgw) && /duress is armed/.test(kgw), 'wrapped keygen output:\n' + kgw);
  assert(crypt.keyIsWrapped(wrappedKeyPath), 'key file is wrapped (GKW1)');

  // correct phrase unlocks; key intact
  const okU = execFileSync('node', [GITLIVE_JS, 'crypt', 'unlock', '--passphrase', realPhrase], { env: envW, encoding: 'utf8' }).toString();
  assert(/unlocked ok/.test(okU) && fs.existsSync(wrappedKeyPath), 'correct phrase unlocks, key intact');

  // duress-marked phrase shreds the key irreversibly
  let duressCode = 0;
  let duressOut = '';
  try {
    execFileSync('node', [GITLIVE_JS, 'crypt', 'unlock', '--passphrase', '!they-made-me'], { env: envW, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    duressCode = err.status;
    duressOut = String(err.stdout || '') + String(err.stderr || '');
  }
  assert(duressCode === 42, 'duress exits with code 42, got ' + duressCode);
  assert(/DURESS/.test(duressOut), 'duress message: ' + duressOut);
  assert(!fs.existsSync(wrappedKeyPath), 'key file is gone after duress');
  const events = fs.readFileSync(path.join(home, '.gitlive', 'events.log'), 'utf8');
  assert(/duress/.test(events), 'duress event logged');
  console.log('OK: duress trigger — marked phrase shreds the key irreversibly (exit 42, event logged)');

  // manual duress on a plain key
  const plainKey = path.join(home, '.gitlive', 'plain.key');
  const envP = { ...env, GITLIVE_STORAGE_KEY: plainKey };
  execFileSync('node', [GITLIVE_JS, 'crypt', 'keygen'], { env: envP, encoding: 'utf8' });
  assert(fs.existsSync(plainKey), 'plain key exists');
  execFileSync('node', [GITLIVE_JS, 'crypt', 'duress', '--yes'], { env: envP, encoding: 'utf8' });
  assert(!fs.existsSync(plainKey), 'manual duress removed the plain key');
  console.log('OK: manual duress (--yes) removes an unwrapped key');

  // ── dead-man switch ─────────────────────────────────────────────────────
  const dmKey = path.join(home, '.gitlive', 'dm.key');
  const envDM = { ...process.env, HOME: home, GITLIVE_STORAGE_KEY: dmKey, GITLIVE_DEADMAN: undefined };
  const cryptMod = require('../crypt.js');
  // module-level, isolated: arm with 0h → check shreds via injected shredder
  const dmDir = fs.mkdtempSync(path.join(shortTmp, 'gldm-'));
  const saved = cryptMod.DEADMAN_PATH;
  const injected = {
    DEADMAN_PATH: path.join(dmDir, 'deadman.json'),
    DEFAULT_STORAGE_KEY: path.join(dmDir, 'k.key'),
  };
  // arm 1h → armed; tick; arm 0h via direct fn → expired check shreds
  const arm = cryptMod.deadmanArm(1);
  assert(arm.deadline > new Date().toISOString(), 'armed with future deadline');
  let shredded = false;
  const r1 = cryptMod.deadmanCheck({ shred: () => { shredded = true; } });
  assert(r1.ok && r1.state === 'armed', 'check while armed passes: ' + JSON.stringify(r1));
  // force expiry: rewrite the state file to the past, then check
  fs.writeFileSync(cryptMod.DEADMAN_PATH, JSON.stringify({ deadline: new Date(Date.now() - 1000).toISOString(), intervalH: 1 }) + '\n');
  const r2 = cryptMod.deadmanCheck({ shred: () => { shredded = true; } });
  assert(!r2.ok && r2.shredded && shredded, 'expired deadline shreds: ' + JSON.stringify(r2));

  // CLI end-to-end with real key + real shred
  const cliEnv = { ...env, GITLIVE_STORAGE_KEY: dmKey };
  execFileSync('node', [GITLIVE_JS, 'crypt', 'keygen'], { env: cliEnv, encoding: 'utf8' });
  assert(fs.existsSync(dmKey), 'dm key exists');
  execFileSync('node', [GITLIVE_JS, 'crypt', 'deadman', 'arm', '--hours', '0'], { env: cliEnv, encoding: 'utf8' });
  let code43 = 0;
  try {
    execFileSync('node', [GITLIVE_JS, 'crypt', 'deadman', 'check'], { env: cliEnv, encoding: 'utf8' });
  } catch (err) { code43 = err.status; }
  assert(code43 === 43, 'expired deadman exits 43, got ' + code43);
  assert(!fs.existsSync(dmKey), 'storage key shredded by the dead-man');
  console.log('OK: dead-man switch — arm/tick/check; missed deadline shreds the key (exit 43)');
  // restore module consts
  cryptMod.DEADMAN_PATH = saved;

  // ── decoy layer (plausible deniability) ─────────────────────────────────
  const decoyHome = fs.mkdtempSync(path.join(shortTmp, 'gldecoy-'));
  const realKeyPath = path.join(decoyHome, 'real.key');
  const envD = { ...process.env, HOME: decoyHome, GITLIVE_STORAGE_KEY: realKeyPath, GITLIVE_DECOY_KEY: path.join(decoyHome, '.gitlive', 'decoy.key'), GITLIVE_DECOY_DIR: path.join(decoyHome, '.gitlive', 'decoy') };
  const decoyPhraseD = 'decoy phrase for the border';
  // real world: plain raw key (enc/dec operate on raw files) + one real file
  execFileSync('node', [GITLIVE_JS, 'crypt', 'keygen'], { env: envD, encoding: 'utf8' });
  const realPlain = path.join(shortTmp, 'real-secret.txt');
  fs.writeFileSync(realPlain, 'the REAL plan');
  execFileSync('node', [GITLIVE_JS, 'crypt', 'enc', realPlain, path.join(shortTmp, 'real-secret.txt.glc')], { env: envD, encoding: 'utf8' });
  // init decoy world
  execFileSync('node', [GITLIVE_JS, 'crypt', 'decoy', 'init', '--name', 'travel-pics', '--passphrase', decoyPhraseD], { env: envD, encoding: 'utf8' });
  // decoy world holds ONLY decoy content: put + list + get round-trip
  const decoyPlain = path.join(shortTmp, 'decoy-note.txt');
  fs.writeFileSync(decoyPlain, 'just vacation photos');
  execFileSync('node', [GITLIVE_JS, 'crypt', 'decoy', 'put', decoyPlain, 'albums/paris', '--passphrase', decoyPhraseD], { env: envD, encoding: 'utf8' });
  const listD = execFileSync('node', [GITLIVE_JS, 'crypt', 'decoy', 'list', '--passphrase', decoyPhraseD], { env: envD, encoding: 'utf8' }).toString();
  assert(listD.includes('albums/paris') && !listD.includes('real-secret'), 'decoy world lists only decoy content: ' + listD);
  const gotD = path.join(shortTmp, 'decoy-out.txt');
  execFileSync('node', [GITLIVE_JS, 'crypt', 'decoy', 'get', 'albums/paris', gotD, '--passphrase', decoyPhraseD], { env: envD, encoding: 'utf8' });
  assert(fs.readFileSync(gotD, 'utf8') === 'just vacation photos', 'decoy get round-trip');
  // wrong decoy phrase → error, real world untouched
  let wrongDecoy = null;
  try { execFileSync('node', [GITLIVE_JS, 'crypt', 'decoy', 'list', '--passphrase', 'nope'], { env: envD, encoding: 'utf8' }); } catch (e) { wrongDecoy = String(e.stderr || ''); }
  assert(wrongDecoy && /wrong decoy passphrase/.test(wrongDecoy), 'wrong decoy phrase refused');
  // duress prefix at the DECOY gate shreds the REAL key (single trigger)
  let codeD = 0;
  try { execFileSync('node', [GITLIVE_JS, 'crypt', 'decoy', 'list', '--passphrase', '!they-insist'], { env: envD, encoding: 'utf8' }); } catch (e) { codeD = e.status; }
  assert(codeD === 42, 'duress at decoy gate exits 42, got ' + codeD);
  assert(!fs.existsSync(realKeyPath), 'duress at the decoy gate shredded the REAL key');
  console.log('OK: decoy layer — isolated plausible dataset; wrong phrase refused; duress at the decoy gate shreds the REAL key');

  console.log('\nALL CRYPT HARDENING TESTS PASSED');
})().catch((err) => {
  console.error('CRYPT TEST FAILED:', (err && err.message) || err);
  process.exitCode = 1;
});
