'use strict';
// P4 — SLSA/in-toto attestation export: the deploy receipts spine exported
// as a DSSE-wrapped in-toto Statement signed with the SAME owner key —
// provable offline by a stranger holding only the public key. This suite
// runs the whole CLI path: keygen → real bare repo → signed deploy tag →
// attest → verify → tamper → refused. Fake home, disposable discipline.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glattest-'));
const env = { ...process.env, HOME: home };

function cli(args) {
  return execFileSync('node', [GITLIVE_JS, ...args], { env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

(async () => {
  // owner key + a real bare repo + registry app
  cli(['manifest', 'keygen']);
  const keyPath = path.join(home, '.gitlive', 'manifest-owner-key.pem');
  assert(fs.existsSync(keyPath), 'the owner key exists');
  const bare = path.join(home, '.gitlive', 'apps', 'myapp.git');
  git(['init', '--bare', '-b', 'main', bare]);
  // annotated tags need a real commit in the repo — push one in (the same
  // shape a real gitlive push leaves behind)
  const src = fs.mkdtempSync(path.join(shortTmp, 'glattest-src-'));
  git(['init', '-q', '-b', 'main'], src);
  fs.writeFileSync(path.join(src, 'server.js'), '// app\n');
  git(['-c', 'user.email=t@x.io', '-c', 'user.name=t', 'add', '-A'], src);
  git(['-c', 'user.email=t@x.io', '-c', 'user.name=t', 'commit', '-qm', 'c1'], src);
  git(['remote', 'add', 'myapp', bare], src);
  git(['push', 'myapp', 'main'], src);
  const runPath = path.join(home, '.gitlive', 'apps', 'myapp-run');
  fs.mkdirSync(runPath, { recursive: true });
  fs.writeFileSync(path.join(home, '.gitlive', 'apps.json'), JSON.stringify({
    myapp: { cwd: '/tmp/src', barePath: bare, runPath, installCmd: 'true', startCmd: 'node s.js', port: '4100', createdAt: new Date().toISOString() },
  }, null, 2));

  // a signed deploy receipt (the same hook machinery writes these)
  const tagOut = cli(['_deploy-tag', 'myapp', 'a'.repeat(40), 'abc123', 'success']);
  assert(/deploy tag gitlive\/deploys/.test(tagOut), 'the deploy tag is written:\n' + tagOut);

  // ── 1) attest: DSSE envelope, owner-signed, SLSA statement ────────────────
  const outPath = path.join(home, 'provenance.json');
  const pubPath = path.join(home, 'owner.pub');
  const att = cli(['attest', 'myapp', '--output', outPath, '--pubkey-out', pubPath]);
  assert(/in-toto Statement in a DSSE envelope/.test(att), 'attest reports the envelope:\n' + att);
  assert(fs.existsSync(outPath) && fs.existsSync(pubPath), 'the envelope and public key are written');
  const env2 = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert(env2.payloadType === 'application/vnd.in-toto+json' && env2.signatures && env2.signatures.length === 1, 'it is a DSSE envelope with a signature');
  const stmt = JSON.parse(Buffer.from(env2.payload, 'base64').toString('utf8'));
  assert(stmt._type === 'https://in-toto.io/Statement/v1' && stmt.predicateType === 'https://slsa.dev/provenance/v1', 'it is an in-toto/SLSA statement');
  assert(stmt.subject[0].name.includes('myapp') && stmt.subject[0].digest.sha256 === crypto.createHash('sha256').update(JSON.stringify(stmt.predicate)).digest('hex'), 'the subject digest covers the predicate (self-consistency)');
  assert(stmt.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit === 'a'.repeat(40), 'the statement pins the deploy commit');

  // ── 2) verify: signature + self-consistency, with ONLY the public key ────
  const ver = cli(['attest', 'verify', outPath, '--key', pubPath]);
  assert(/signature: VALID/.test(ver) && /self-consistent/.test(ver), 'verify accepts the envelope with the public key alone:\n' + ver);
  assert(/commit aaaaaaaa/.test(ver) && /closure abc123/.test(ver), 'verify reports the proven facts:\n' + ver);

  // ── 3) tampered payload → refused ────────────────────────────────────────
  const tampered = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const stmt2 = JSON.parse(Buffer.from(tampered.payload, 'base64').toString('utf8'));
  stmt2.predicate.buildDefinition.externalParameters.commit = 'f'.repeat(40);
  tampered.payload = Buffer.from(JSON.stringify(stmt2)).toString('base64');
  fs.writeFileSync(path.join(home, 'tampered.json'), JSON.stringify(tampered, null, 1));
  let bad = '';
  try { cli(['attest', 'verify', path.join(home, 'tampered.json'), '--key', pubPath]); } catch (err) { bad = String(err.stdout || '') + String(err.stderr || ''); }
  assert(/INVALID/.test(bad) || /MISMATCH/.test(bad), 'a tampered envelope is refused:\n' + bad);

  // ── 4) no receipts → honest refusal ──────────────────────────────────────
  fs.writeFileSync(path.join(home, '.gitlive', 'apps.json'), JSON.stringify({
    emptyapp: { cwd: '/tmp/src', barePath: path.join(home, 'empty.git'), runPath: path.join(home, 'empty-run'), installCmd: 'true', startCmd: 'node s.js', port: '4101', createdAt: new Date().toISOString() },
  }, null, 2));
  git(['init', '--bare', '-b', 'main', path.join(home, 'empty.git')]);
  let noTags = '';
  try { cli(['attest', 'emptyapp']); } catch (err) { noTags = String(err.stdout || '') + String(err.stderr || ''); }
  assert(/no signed deploy receipts/.test(noTags), 'attesting an app without receipts is an honest refusal:\n' + noTags);

  // ── 5) no owner key → honest refusal ─────────────────────────────────────
  const noKeyHome = fs.mkdtempSync(path.join(shortTmp, 'glattest-nokey-'));
  let noKey = '';
  try {
    execFileSync('node', [GITLIVE_JS, 'attest', 'myapp'], { env: { ...process.env, HOME: noKeyHome }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) { noKey = String(err.stdout || '') + String(err.stderr || ''); }
  assert(/no owner key/.test(noKey), 'attesting without an owner key is an honest refusal:\n' + noKey);

  console.log('ALL ATTESTATION TESTS PASSED');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
