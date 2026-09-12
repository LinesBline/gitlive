'use strict';
// `gitlive domain graduate` — an app under a borrowed zone label moves to
// its OWN domain in one command (two-door naming plan).
//
// Proves: the domain attaches and becomes canonical (primaryDomain), the
// borrowed label is recorded (graduatedFrom) and stays answering (the
// zone's wildcard is the zone operator's to manage), the copy prints the
// owner's own DNS record (never a gitlive-operated name), a certificate is
// installed when held, the entry-node aware path prints entry routing, and
// conflicts/usage fail honestly. Fake home only.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glgrad-'));
const env = { ...process.env, HOME: home };

function cli(args) {
  return execFileSync('node', [GITLIVE_JS, ...args], { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function registry() {
  return JSON.parse(fs.readFileSync(path.join(home, '.gitlive', 'apps.json'), 'utf8'));
}

(async () => {
  const regDir = path.join(home, '.gitlive');
  fs.mkdirSync(path.join(regDir, 'domain'), { recursive: true });
  fs.writeFileSync(path.join(regDir, 'apps.json'), JSON.stringify({
    one: { mode: 'local', port: '41234', installCmd: 'true', startCmd: 'node s.js', createdAt: new Date().toISOString() },
    two: { mode: 'local', port: '41235', installCmd: 'true', startCmd: 'node s.js', domains: ['taken.example.test'], createdAt: new Date().toISOString() },
  }, null, 2));
  fs.writeFileSync(path.join(regDir, 'domain', 'zones.json'), JSON.stringify({ 'makers.test': { addedAt: new Date().toISOString() } }, null, 2));

  // ── 1) graduate: own domain attaches, canonical, borrowed label recorded ──
  const out = cli(['domain', 'graduate', 'one', '--domain', 'one.own.example', '--from', 'makers.test']);
  assert(/one\.own\.example → one/.test(out), 'graduate must report the mapping:\n' + out);
  assert(/canonical — graduated from one\.makers\.test/.test(out), 'graduate must record the graduation from the borrowed label:\n' + out);
  assert(/YOUR registrar/.test(out), "the copy must say the domain is the owner's:\n" + out);
  assert(/borrowed label one\.makers\.test keeps answering/.test(out), 'the borrowed label must stay until the zone drops it:\n' + out);
  const reg = registry();
  assert(reg.one.domains.includes('one.own.example'), 'the domain must be attached');
  assert(reg.one.primaryDomain === 'one.own.example', 'the new domain must be canonical');
  assert(reg.one.graduatedFrom === 'makers.test', 'the left zone must be recorded');
  assert(Boolean(reg.one.graduatedAt), 'the graduation time must be recorded');
  console.log('OK: graduate — own domain canonical, borrowed label recorded and left answering');

  // ── 2) a domain another app already holds is refused ─────────────────────
  let refused = false;
  try { cli(['domain', 'graduate', 'one', '--domain', 'taken.example.test']); } catch (err) { refused = true; }
  assert(refused, 'a domain attached to another app must be refused');
  console.log('OK: graduate refuses a domain another app already holds');

  // ── 3) entry-aware path: connected to an entry → the record points there ──
  fs.mkdirSync(path.join(regDir, 'entry'), { recursive: true });
  fs.writeFileSync(path.join(regDir, 'entry', 'client.json'), JSON.stringify({ url: 'https://entry.own.example:8443', token: 't' }));
  const entryOut = cli(['domain', 'graduate', 'one', '--domain', 'one2.own.example']);
  assert(/entry machine/.test(entryOut), 'with an entry connection, the DNS record must point at the entry machine:\n' + entryOut);
  assert(/entry\.own\.example/.test(entryOut), 'the entry address must be named in the copy:\n' + entryOut);
  console.log('OK: graduate is entry-aware — NAT machines get the right DNS story');

  // ── 4) a held certificate is installed with the graduation ───────────────
  const tls = path.join(regDir, 'domain');
  const ext = path.join(tls, 'g.ext');
  fs.writeFileSync(ext, 'subjectAltName=DNS:one3.own.example\n');
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tls, 'g.key'), '-out', path.join(tls, 'g.csr'), '-subj', '/CN=one3.own.example'], { encoding: 'utf8' });
  execFileSync('openssl', ['x509', '-req', '-in', path.join(tls, 'g.csr'), '-signkey', path.join(tls, 'g.key'), '-out', path.join(tls, 'g.crt'), '-days', '30', '-sha256', '-extfile', ext], { encoding: 'utf8' });
  const certOut = cli(['domain', 'graduate', 'one', '--domain', 'one3.own.example', '--cert', path.join(tls, 'g.crt'), '--key', path.join(tls, 'g.key')]);
  assert(/certificate installed/.test(certOut), 'graduate must install a held certificate:\n' + certOut);
  assert(fs.existsSync(path.join(tls, 'public', 'one3.own.example.crt')), 'the cert must land in the public dir');
  console.log('OK: graduate installs the certificate the owner holds');

  // ── 5) usage fails honestly ──────────────────────────────────────────────
  let usage = false;
  try { cli(['domain', 'graduate', 'one']); } catch { usage = true; }
  assert(usage, 'graduate without --domain must fail with usage');
  console.log('ALL GRADUATE TESTS PASSED');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
