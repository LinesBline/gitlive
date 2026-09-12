'use strict';
// F2 — distributed storage-key shares across mesh members (Fabric program).
// The storage key is Shamir-split N-of-M; ONE share per member home. After
// local loss (or a forced shred) `mesh unseal` restores the key from N
// surviving members, verifying the recovered bytes against the policy
// digest. Each scenario starts from a fresh share set (as a real owner
// would re-share after member churn) so no scenario depends on leftovers.

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
const homeA = fs.mkdtempSync(path.join(shortTmp, 'glshare-a-'));
const homeB = fs.mkdtempSync(path.join(shortTmp, 'glshare-b-'));
const homeC = fs.mkdtempSync(path.join(shortTmp, 'glshare-c-'));
const homeD = fs.mkdtempSync(path.join(shortTmp, 'glshare-d-'));
const homes = { b: homeB, c: homeC, d: homeD };

function cli(args, home, cwd) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: cwd || home, env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function cliFail(args, home) {
  try { cli(args, home); return null; } catch (err) { return String(err.stdout || '') + String(err.stderr || ''); }
}
const keyPath = (h) => path.join(h, '.gitlive', 'storage.key');
const memberShare = (h) => {
  const d = path.join(h, '.gitlive', 'shares');
  if (!fs.existsSync(d)) return null;
  for (const sub of fs.readdirSync(d)) {
    const dir = path.join(d, sub);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) return path.join(dir, f);
    }
  }
  return null;
};
const allShares = () => [homeB, homeC, homeD].map(memberShare).filter(Boolean);
const eventsOf = (h) => fs.readFileSync(path.join(h, '.gitlive', 'events.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const hasEvent = (h, op) => eventsOf(h).some((e) => e.kind === 'shares' && e.detail.op === op);

(async () => {
  cli(['crypt', 'keygen'], homeA);
  cli(['manifest', 'keygen'], homeA);
  for (const [n, h] of Object.entries(homes)) cli(['mesh', 'add', 'member-' + n, '--home', h], homeA);
  const origKey = fs.readFileSync(keyPath(homeA));
  const origSha = crypto.createHash('sha256').update(origKey).digest('hex');

  // S1 — split 2-of-3: one share per member home, policy carries the digest
  const shareOut = cli(['mesh', 'share', 'demoapp', '--m', '3', '--n', '2'], homeA);
  assert(/Split the storage key \(owner-signed\): 2-of-3/.test(shareOut), 'share output:\n' + shareOut);
  const policy = JSON.parse(fs.readFileSync(path.join(homeA, '.gitlive', 'shares', 'storage-policy.json'), 'utf8'));
  assert(policy.n === 2 && policy.m === 3 && policy.subject === 'demoapp' && policy.keySha256 === origSha, 'policy records n/m/subject/digest');
  assert(policy.owner && policy.ownerSig && policy.owner.fingerprint, 'policy is owner-signed');
  const shB1 = JSON.parse(fs.readFileSync(memberShare(homeB), 'utf8'));
  assert(shB1.ownerSig && shB1.ownerFp === policy.ownerFp, 'share files are owner-signed');
  assert(allShares().length === 3, 'one share per member home, got ' + allShares().length);
  assert(hasEvent(homeA, 'share'), 'share audited');
  console.log('OK: storage key split 2-of-3 — one share per member home, policy with digest');

  // S2 — unseal refuses while the local key still exists
  const refuse = cliFail(['mesh', 'unseal', 'demoapp'], homeA);
  assert(refuse && /refusing to overwrite/.test(refuse), 'unseal refuses over an existing key:\n' + (refuse || '(accepted!)'));
  console.log('OK: unseal refuses over an existing key');

  // S3 — loss restore: remove the local key, unseal from surviving members
  fs.rmSync(keyPath(homeA));
  const check = cli(['mesh', 'unseal', 'demoapp', '--check'], homeA);
  assert(/READY — 3 of 2 verified shares/.test(check), 'check reports ready:\n' + check);
  const unsealOut = cli(['mesh', 'unseal', 'demoapp'], homeA);
  assert(/storage key restored from 2 verified share/.test(unsealOut), 'unseal output:\n' + unsealOut);
  assert(origKey.equals(fs.readFileSync(keyPath(homeA))), 'restored key is byte-identical');
  assert(hasEvent(homeA, 'unseal'), 'unseal audited');
  console.log('OK: after local loss the key is restored from member shares (digest-verified)');

  // S4 — refresh re-splits (new share bytes), keeps the digest, stays usable
  const bShareBefore = fs.readFileSync(memberShare(homeB), 'utf8');
  const refreshOut = cli(['mesh', 'share', 'demoapp', '--refresh'], homeA);
  assert(/Refreshed/.test(refreshOut), 'refresh output:\n' + refreshOut);
  assert(bShareBefore !== fs.readFileSync(memberShare(homeB), 'utf8'), 'refresh rewrites share bytes (new polynomial)');
  const pol2 = JSON.parse(fs.readFileSync(path.join(homeA, '.gitlive', 'shares', 'storage-policy.json'), 'utf8'));
  assert(pol2.refreshedAt && pol2.keySha256 === origSha, 'refresh stamps refreshedAt and keeps the digest');
  assert(hasEvent(homeA, 'share-refresh'), 'refresh audited');
  console.log('OK: refresh re-splits shares and keeps the digest');

  // S5 — tamper: corrupt b's share, remove the local key → digest mismatch,
  // nothing written, attempt audited
  fs.rmSync(keyPath(homeA));
  const bShare = memberShare(homeB);
  const shB = JSON.parse(fs.readFileSync(bShare, 'utf8'));
  shB.shareB64 = Buffer.from(crypto.randomBytes(32)).toString('base64');
  fs.writeFileSync(bShare, JSON.stringify(shB, null, 2));
  const tamper = cliFail(['mesh', 'unseal', 'demoapp'], homeA);
  assert(tamper && /forged|signature/.test(tamper), 'tampered share detected (owner-signature check):\n' + (tamper || '(accepted!)'));
  assert(!fs.existsSync(keyPath(homeA)), 'no key written on a failed unseal');
  assert(eventsOf(homeA).some((e) => e.kind === 'shares' && e.detail.op === 'unseal-fail' && /forged/.test(JSON.stringify(e.detail))), 'tamper attempt audited');
  console.log('OK: a tampered share fails the owner-signature check (F1 discipline on F2), is audited, writes nothing');

  // S6 — recovery: discard the bad share, restore from the two honest ones
  fs.rmSync(bShare);
  cli(['mesh', 'unseal', 'demoapp'], homeA);
  assert(origKey.equals(fs.readFileSync(keyPath(homeA))), 'restore works after discarding the tampered share');
  console.log('OK: discarding the tampered share restores from the honest ones');

  // S7 — lost-node tolerance: member-d vanishes entirely, restore still works
  // (a re-share first repairs the set — the real owner action after churn)
  cli(['mesh', 'share', 'demoapp', '--refresh'], homeA);
  fs.rmSync(keyPath(homeA));
  fs.rmSync(path.join(homeD, '.gitlive', 'shares'), { recursive: true, force: true });
  const checkLost = cli(['mesh', 'unseal', 'demoapp', '--check'], homeA);
  assert(/READY — 2 of 2 verified shares/.test(checkLost), 'lost node leaves enough shares:\n' + checkLost);
  cli(['mesh', 'unseal', 'demoapp'], homeA);
  assert(origKey.equals(fs.readFileSync(keyPath(homeA))), 'restore works with one member gone');
  cli(['mesh', 'share', 'demoapp', '--refresh'], homeA); // heal the lost member back
  assert(memberShare(homeD) !== null, 'refresh re-signed the lost member home back into the set');
  console.log('OK: a lost member home does not block restore; refresh heals it back');

  // S8 — a fresh owner home restores from the SAME member homes (recover story)
  const homeE = fs.mkdtempSync(path.join(shortTmp, 'glshare-e-'));
  fs.mkdirSync(path.join(homeE, '.gitlive', 'shares'), { recursive: true });
  fs.copyFileSync(path.join(homeA, '.gitlive', 'shares', 'storage-policy.json'), path.join(homeE, '.gitlive', 'shares', 'storage-policy.json'));
  fs.copyFileSync(path.join(homeA, '.gitlive', 'manifest-owner-key.pem'), path.join(homeE, '.gitlive', 'manifest-owner-key.pem'));
  cli(['mesh', 'unseal', 'demoapp'], homeE);
  assert(origKey.equals(fs.readFileSync(keyPath(homeE))), 'fresh home restores the key from member shares');
  console.log('OK: a fresh owner home restores the key from surviving member shares');

  // S9 — policy swap attack: tampering with the policy (without the owner
  // key to re-sign) is refused before any share is read
  fs.copyFileSync(path.join(homeA, '.gitlive', 'shares', 'storage-policy.json'), path.join(homeA, '.gitlive', 'shares', 'storage-policy.bak'));
  const polSwap = JSON.parse(fs.readFileSync(path.join(homeA, '.gitlive', 'shares', 'storage-policy.json'), 'utf8'));
  polSwap.keySha256 = '0'.repeat(64); // attacker swaps the digest
  fs.writeFileSync(path.join(homeA, '.gitlive', 'shares', 'storage-policy.json'), JSON.stringify(polSwap, null, 2));
  fs.rmSync(keyPath(homeA));
  const swapOut = cliFail(['mesh', 'unseal', 'demoapp'], homeA);
  assert(swapOut && /signature INVALID|does not match/.test(swapOut), 'swapped policy refused:\n' + (swapOut || '(accepted!)'));
  fs.copyFileSync(path.join(homeA, '.gitlive', 'shares', 'storage-policy.bak'), path.join(homeA, '.gitlive', 'shares', 'storage-policy.json'));
  fs.rmSync(path.join(homeA, '.gitlive', 'shares', 'storage-policy.bak'));
  console.log('OK: a swapped policy (no owner re-signature) is refused before any share is read');

  // S10 — forged member share refusal (valid JSON, no owner signature);
  // the key is still absent from S9's swap-attack, so this is a clean
  // refusal-then-heal cycle
  const cShare = memberShare(homeC);
  const forgedSh = JSON.parse(fs.readFileSync(cShare, 'utf8'));
  delete forgedSh.ownerSig;
  fs.writeFileSync(cShare, JSON.stringify(forgedSh, null, 2));
  const forgedOut = cliFail(['mesh', 'unseal', 'demoapp'], homeA);
  assert(forgedOut && /forged|signature/.test(forgedOut), 'unsigned share refused:\n' + (forgedOut || '(accepted!)'));
  fs.rmSync(cShare); // discard the forged member share
  cli(['mesh', 'unseal', 'demoapp'], homeA);
  assert(origKey.equals(fs.readFileSync(keyPath(homeA))), 'discarding the forged share restores from the honest ones');
  cli(['mesh', 'share', 'demoapp', '--refresh'], homeA); // re-share re-signs a healed set
  const healed = JSON.parse(fs.readFileSync(memberShare(homeC), 'utf8'));
  assert(healed.ownerSig && healed.ownerFp, 're-shared member file is owner-signed again');
  console.log('OK: forged member share refused; discard + re-share heals the set');

  // S11 — attestation tier: signed deploy receipts fan out to members and
  // verify from a member's copy (provenance survives the primary)
  const attRun = path.join(homeA, '.gitlive', 'apps', 'attapp-run');
  fs.mkdirSync(path.join(attRun, 'live', '.gitlive'), { recursive: true });
  fs.mkdirSync(path.join(homeA, '.gitlive'), { recursive: true });
  if (!fs.existsSync(path.join(homeA, '.gitlive', 'apps.json'))) fs.writeFileSync(path.join(homeA, '.gitlive', 'apps.json'), '{}');
  const reg = JSON.parse(fs.readFileSync(path.join(homeA, '.gitlive', 'apps.json'), 'utf8'));
  reg.attapp = { cwd: attRun, runPath: attRun, barePath: path.join(homeA, '.gitlive', 'apps', 'attapp.git'), installCmd: null, startCmd: 'node server.js', port: '31990', createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(homeA, '.gitlive', 'apps.json'), JSON.stringify(reg, null, 2));
  const fakeClosure = 'a'.repeat(64);
  fs.writeFileSync(path.join(attRun, 'deploy-history.jsonl'), JSON.stringify({ at: new Date().toISOString(), outcome: 'success', commit: 'feedface1234', closure: fakeClosure }) + '\n');
  // signed manifest for attapp (sign into a scratch dir, then place in the run dir)
  const scratch = fs.mkdtempSync(path.join(shortTmp, 'glshare-sign-'));
  cli(['manifest', 'sign', '--dir', scratch, '--name', 'attapp'], homeA);
  fs.copyFileSync(path.join(scratch, '.gitlive', 'app.manifest'), path.join(attRun, 'live', '.gitlive', 'app.manifest'));
  const attestOut = cli(['_attest-deploy', 'attapp'], homeA);
  assert(/attested attapp → 3 member home/.test(attestOut), 'attest output:\n' + attestOut);
  const verifyOut = cli(['mesh', 'verify', 'attapp'], homeA);
  assert(/owner signature VALID/.test(verifyOut) && /closure pinned aaaaaaaa/.test(verifyOut), 'verify from members:\n' + verifyOut);
  assert((verifyOut.match(/member/g) || []).length >= 3, 'all members report:\n' + verifyOut);
  // tamper one member's manifest → verify flags it
  const tamperedMember = Object.values(homes)[0];
  const tamperedManifest = path.join(tamperedMember, '.gitlive', 'attest', 'attapp', 'manifest.json');
  fs.writeFileSync(tamperedManifest, JSON.stringify({ tampered: true }));
  const verifyTampered = cli(['mesh', 'verify', 'attapp'], homeA);
  assert(/owner signature INVALID/.test(verifyTampered), 'tampered member attestation flagged:\n' + verifyTampered);
  console.log('OK: attestation tier — receipts fan out on deploy; members verify the owner signature; tampering is flagged');

  console.log('\nALL SHARES TESTS PASSED');
})().catch((err) => {
  console.error('SHARES TEST FAILED:', (err && err.message) || err);
  process.exitCode = 1;
});
