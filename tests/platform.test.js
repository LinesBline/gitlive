'use strict';
// #2 platform honesty — the parity claims stay true in the CODE, not just
// the README: the CA trust step is platform-aware (Keychain on macOS, the
// system CA bundle on Linux, a plain refusal elsewhere), and `gitlive
// doctor` says which platform it is on — with the Windows answer said out
// loud instead of hidden. Battery-verified where it can be (this machine
// is macOS; the other branches are unit-tested, the Linux claims are
// reviewed POSIX paths, not claimed to be daily-driven).

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');

(async () => {
  const gitlive = require(GITLIVE_JS);

  // ── 1) the trust command is per-platform, never a macOS-only lie ─────────
  const darwin = gitlive.trustCommand('darwin');
  assert(darwin.includes('security add-trusted-cert') && darwin.includes('Keychain'), 'darwin trusts via Keychain:\n' + darwin);
  const linux = gitlive.trustCommand('linux');
  assert(linux.includes('update-ca-certificates') && linux.includes('gitlive.crt'), 'linux trusts via the system CA bundle:\n' + linux);
  const other = gitlive.trustCommand('win32');
  assert(!other.includes('security ') && !other.includes('update-ca-certificates') && /supports macOS and Linux/.test(other), 'unsupported platforms get the honest answer:\n' + other);

  // ── 2) doctor says the platform, with the Windows answer out loud ────────
  const home = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'glplat-'));
  const doctor = execFileSync('node', [GITLIVE_JS, 'doctor'], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 60000 });
  assert(/platform: (darwin|linux|win32)/.test(doctor), 'doctor reports the real platform:\n' + doctor.split('\n').find((l) => l.includes('platform:')));
  if (os.platform() !== 'win32') {
    assert(!/UNSUPPORTED/.test(doctor), 'non-Windows platforms are not told they are unsupported');
  }

  console.log('ALL PLATFORM HONESTY TESTS PASSED');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
