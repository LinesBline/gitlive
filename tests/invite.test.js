'use strict';
// Item 6 onboarding slice — owner-signed invite tokens: create, verify,
// tamper/expiry/foreign-owner rejection. Fake $HOME, real owner key.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const homeA = fs.mkdtempSync(path.join(shortTmp, 'glinv-a-'));
const ownerKey = path.join(shortTmp, 'inv-owner.pem');
const otherOwner = path.join(shortTmp, 'inv-owner-2.pem');
const envA = { ...process.env, HOME: homeA, GITLIVE_MANIFEST_KEY: ownerKey };
const envOther = { ...process.env, HOME: homeA, GITLIVE_MANIFEST_KEY: otherOwner };

function cli(args, env) {
  return execFileSync('node', [GITLIVE_JS, ...args], { env: env || envA, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function cliFail(args, env) {
  try { cli(args, env); return null; } catch (err) { return String(err.stdout || '') + String(err.stderr || ''); }
}

(async () => {
  cli(['manifest', 'keygen']); // owner A
  execFileSync('node', [GITLIVE_JS, 'manifest', 'keygen'], { env: envOther, encoding: 'utf8' }); // owner B

  // 1 — invite creates a token; verify accepts it
  const invOut = cli(['mesh', 'invite', '--name', 'friend-node', '--ttl-h', '24']);
  const token = invOut.split('\n').filter(Boolean).pop().trim();
  assert(token && token.length > 60, 'invite prints a token:\n' + invOut.slice(0, 200));
  const okOut = cli(['mesh', 'verify-invite', token]);
  assert(/OK: invite for "friend-node"/.test(okOut), 'verify output:\n' + okOut);
  console.log('OK: owner-signed invite created and verified');

  // 2 — tampered token rejected
  const bad = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  const badOut = cliFail(['mesh', 'verify-invite', bad]);
  assert(badOut && /invalid/.test(badOut), 'tampered token rejected:\n' + (badOut || '(accepted!)'));
  console.log('OK: tampered invite rejected');

  // 3 — foreign owner's token rejected by owner A
  const otherInv = cli(['mesh', 'invite', '--name', 'intruder'], envOther);
  const otherTok = otherInv.split('\n').filter(Boolean).pop().trim();
  const otherOut = cliFail(['mesh', 'verify-invite', otherTok]);
  assert(otherOut && /owner|invalid/.test(otherOut), 'foreign-owner invite rejected:\n' + (otherOut || '(accepted!)'));
  console.log('OK: foreign-owner invite rejected');

  // 4 — expired token rejected (module-level, ttl 0)
  const mesh = require('../mesh.js');
  const expTok = mesh.createInviteToken({ name: 'ghost', ttlHours: -1 });
  const expOut = cliFail(['mesh', 'verify-invite', expTok]);
  assert(expOut && /expired/.test(expOut), 'expired invite rejected:\n' + (expOut || '(accepted!)'));
  console.log('OK: expired invite rejected');

  console.log('\nALL INVITE TESTS PASSED');
})().catch((err) => {
  console.error('INVITE TEST FAILED:', (err && err.message) || err);
  process.exitCode = 1;
});
