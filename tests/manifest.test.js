'use strict';
// Phase 2 (D4) manifest tests — REAL CLI child processes against a real git
// repo (same discipline as every other suite): keygen, sign, verify
// round-trip, tamper detection, wrong-key rejection.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const work = fs.mkdtempSync(path.join(shortTmp, 'gitlive-manifest-'));

// A real project dir with a real git commit — the manifest signs exact content.
const repoDir = path.join(work, 'myapp');
fs.mkdirSync(repoDir);
fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'myapp', scripts: { start: 'node server.js' } }, null, 2));
fs.writeFileSync(path.join(repoDir, 'server.js'), 'console.log("hi")\n');
execFileSync('git', ['init', '-q'], { cwd: repoDir });
execFileSync('git', ['add', '.'], { cwd: repoDir });
execFileSync('git', ['-c', 'user.email=test@gitlive.local', '-c', 'user.name=test', 'commit', '-qm', 'initial'], { cwd: repoDir });

const keyPath = path.join(work, 'owner-key.pem');
const env = { ...process.env, GITLIVE_MANIFEST_KEY: keyPath };
function cli(args) {
  return execFileSync('node', [GITLIVE_JS, 'manifest', ...args], { cwd: repoDir, env, encoding: 'utf8' });
}
function cliExpectFail(args) {
  try {
    execFileSync('node', [GITLIVE_JS, 'manifest', ...args], { cwd: repoDir, env, encoding: 'utf8' });
    return null; // did not fail — bad
  } catch (err) {
    return String(err.stdout || '') + String(err.stderr || '');
  }
}

(async () => {
  // 1 — keygen: creates the owner key (0600) and prints a fingerprint
  const kg = cli(['keygen', '--key', keyPath]);
  assert(/Generated owner manifest key/.test(kg), 'keygen output:\n' + kg);
  const fpMatch = kg.match(/Owner fingerprint: ([0-9A-F:]{39})/);
  assert(fpMatch, 'keygen must print a fingerprint:\n' + kg);
  const fp = fpMatch[1];
  const stat = fs.statSync(keyPath);
  assert((stat.mode & 0o777) === 0o600, 'owner key must be 0600, got ' + (stat.mode & 0o777).toString(8));

  // 2 — sign: writes .gitlive/app.manifest with the exact commit + policy defaults
  const sg = cli(['sign', '--key', keyPath, '--min-nodes', '2']);
  assert(/Signed manifest for "myapp"/.test(sg), 'sign output:\n' + sg);
  assert(sg.match(/Owner fingerprint: ([0-9A-F:]{39})/)[1] === fp, 'sign fingerprint must match keygen');
  const manifestPath = path.join(repoDir, '.gitlive', 'app.manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(manifest.format === 'gitlive-app-manifest/1', 'format marker');
  assert(manifest.owner.fingerprint === fp.replace(/:/g, ''), 'embedded fingerprint matches keygen');
  assert(manifest.policy.minNodes === 2 && manifest.policy.storage === 'host-may-read', 'policy honored + defaults');
  assert(manifest.repo.commit && manifest.repo.tree, 'git content recorded');
  assert(manifest.run && manifest.run.start === 'npm start', 'run contract inferred from package.json');

  // 3 — verify round-trip against the pinned key
  const vg = cli(['verify', '--dir', repoDir, '--key', keyPath]);
  assert(/OK: manifest "myapp"/.test(vg) && /signature valid/.test(vg), 'verify output:\n' + vg);

  // 4 — tamper detection: mutating a signed field must fail verification
  const forged = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  forged.policy.minNodes = 9; // signature covers minNodes:2 — must now fail
  const forgedPath = path.join(work, 'forged.json');
  fs.writeFileSync(forgedPath, JSON.stringify(forged));
  const tamperOut = cliExpectFail(['verify', '--manifest', forgedPath]);
  assert(tamperOut && /VERIFY FAILED/.test(tamperOut), 'tampered manifest must fail verification:\n' + (tamperOut || '(no error — VERIFY PASSED A FORGERY!)'));

  // 5 — wrong owner key must be rejected (pinned-key mismatch)
  const otherKey = path.join(work, 'other-key.pem');
  cli(['keygen', '--key', otherKey]);
  const pinOut = cliExpectFail(['verify', '--dir', repoDir, '--key', otherKey]);
  assert(pinOut && /does not match the pinned key/.test(pinOut), 'wrong pinned owner key must be rejected:\n' + (pinOut || '(no error — WRONG KEY ACCEPTED!)'));

  console.log('OK: keygen creates a 0600 owner key with a stable fingerprint');
  console.log('OK: sign records exact git content, run contract + policy');
  console.log('OK: verify round-trips against the pinned owner key');
  console.log('OK: post-signature field tampering is rejected');
  console.log('OK: wrong pinned owner key is rejected');
  console.log('\nALL MANIFEST TESTS PASSED');
})().catch((err) => {
  console.error('MANIFEST TEST FAILED:', (err && err.message) || err);
  process.exitCode = 1;
});
