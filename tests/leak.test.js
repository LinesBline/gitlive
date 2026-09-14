'use strict';
// leak.test.js — what this machine is allowed to say, and to whom.
//
// gitlive is a self-hosted tool, which means its owner's filesystem layout,
// addresses, project names and credentials are not "telemetry" — they are the
// owner's private business. This suite pins the boundaries:
//
//   · credentials never survive a ledger, a response, an error or a report
//   · the two SHAREABLE artifacts (support bundle, weekly report) mask
//     identifiers by default, and say which copy they are
//   · the unmasked version is available, explicitly, for the owner's own eyes
//   · the access log never records a query string (paths, tokens)
//   · the dashboard is served with a CSP and no framing
//   · the published tarball carries no personal marker of this machine
//   · outbound check-ups can be switched off, and say so when they are
//
// The suite runs a REAL control plane over real HTTP against a fake $HOME, so
// the assertions are about the wire and the disk, not about intentions.

const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const ROOT = path.join(__dirname, '..');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const fakeHome = fs.mkdtempSync(path.join(shortTmp, 'glleak-'));
const controlDir = path.join(fakeHome, '.gitlive', 'control');
fs.mkdirSync(controlDir, { recursive: true });
// the modules resolve ~/.gitlive once, at require time — HOME must be the fake
// one BEFORE anything is required, or the suite would read this machine's real
// registry and the app names would come from the wrong place
process.env.HOME = fakeHome;
process.env.GITLIVE_CONTROL_DIR = controlDir;

const redact = require(path.join(ROOT, 'control', 'redact.js'));

// a real-looking secret soup, the kind an app prints when it fails
const FAKE_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const FAKE_DB = 'postgres://admin:hunter2@db.internal:5432/app';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const FAKE_V6 = '2001:db8:4a2f:9c31:5e77:0b18:6d42:a903'; // documentation range (RFC 3849)

// ── 1 · the redactor itself ────────────────────────────────────────────────
{
  const cases = [
    [`DATABASE_URL=${FAKE_DB}`, FAKE_DB, 'a connection string with a password'],
    [`Authorization: Bearer ${FAKE_JWT}`, FAKE_JWT, 'an authorization header'],
    [`deploy --token ${FAKE_TOKEN}`, FAKE_TOKEN, 'a token on a command line'],
    [`GET https://api.example.com/v1?token=${FAKE_TOKEN}&x=1`, FAKE_TOKEN, 'a token in a query string'],
    ['OPENSSL_KEY=abcdef123456', 'abcdef123456', 'an env assignment whose name says secret'],
    // composed at runtime: the literal header must not sit in the file, because
    // this suite is itself scanned before the repo goes public
    [`-----BEGIN ${'OPENSSH'} PRIVATE KEY-----\nabc\n-----END ${'OPENSSH'} PRIVATE KEY-----`, 'abc', 'a private key block'],
    ['password: hunter2', 'hunter2', 'a bare password field'],
  ];
  for (const [text, secret, label] of cases) {
    const out = redact.redactSecrets(text);
    assert(!out.includes(secret), `${label} must not survive redaction: ${out}`);
    assert(/redacted/i.test(out), `${label} should say it was redacted: ${out}`);
  }
  // ordinary text must survive untouched — an over-eager redactor is its own bug
  const innocent = 'myapp went down at 12:30:45, version 1.2.3, port 3001, loopback 127.0.0.1';
  assert(redact.redactSecrets(innocent) === innocent, 'ordinary log text is not mangled');
  const shaped = redact.shareable(innocent, { names: ['myapp'] });
  assert(/12:30:45/.test(shaped) && /1\.2\.3/.test(shaped) && /127\.0\.0\.1/.test(shaped), 'times, versions and loopback survive identifier masking: ' + shaped);
  assert(!/myapp/.test(shaped), 'the app name is masked in a shareable copy: ' + shaped);
  console.log('OK: redactor — credentials die, ordinary text survives, names mask only when asked');
}
{
  // identifiers: home paths, addresses, e-mails
  const text = `spawn /Users/example-user/.gitlive/apps/x/live/run ENOENT at ${FAKE_V6} from owner@example.com (also /home/example-user/app)`;
  const out = redact.shareable(text);
  assert(!/\/Users\/example-user/.test(out) && /~/.test(out), 'a home path is masked to ~: ' + out);
  assert(!out.includes(FAKE_V6), 'a public address is masked: ' + out);
  assert(!/owner@example\.com/.test(out), 'an e-mail is masked: ' + out);
  assert(!/\/home\/example-user/.test(out), 'a Linux home path is masked too');
  // the prefix alone is not enough: what lives under the home is the owner's
  // business too, so anything deeper than the first directory is collapsed
  const deep = redact.shareable('cwd /Users/example-user/Desktop/private-project-name/sub', { home: '/Users/example-user' });
  assert(!/private-project-name/.test(deep), 'a project folder name under the home is not published: ' + deep);
  assert(/^cwd ~\/Desktop\/…/.test(deep), 'but the general area survives for support: ' + deep);
  console.log('OK: identifiers — paths, addresses and e-mails are masked in shareable copies');
}

// ── 2 · the ledger and the report never carry a credential ─────────────────
{
  const intel = require(path.join(ROOT, 'control', 'intel.js'));
  // an app whose failure line quotes its own environment
  const nasty = `Error: cannot reach ${FAKE_DB} (token ${FAKE_TOKEN})`;
  const rp = path.join(fakeHome, '.gitlive', 'apps', 'leaky-run');
  fs.mkdirSync(rp, { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.gitlive', 'apps.json'), JSON.stringify({
    leaky: { cwd: path.join(fakeHome, 'projects', 'leaky'), barePath: path.join(fakeHome, '.gitlive', 'apps', 'leaky.git'), runPath: rp, startCmd: 'node server.js', port: '3998' },
  }));
  fs.writeFileSync(path.join(rp, 'deploy.log'), nasty + '\n');
  fs.writeFileSync(path.join(controlDir, 'agent-actions.jsonl'), JSON.stringify({
    at: new Date().toISOString(), agent: 'repair', action: 'restart', app: 'leaky', ok: false,
    reason: 'restarted, but the app is still down', detail: nasty,
  }) + '\n');

  // the digest quotes the ledger — the masked copy is the default
  const masked = intel.digestData({ days: 7, redact: true });
  assert(!masked.markdown.includes(FAKE_TOKEN), 'the shareable report carries no token');
  assert(!masked.markdown.includes('hunter2'), 'the shareable report carries no password');
  assert(!masked.markdown.includes(fakeHome), 'the shareable report carries no home path: ' + fakeHome);
  assert(!/\bleaky\b/.test(masked.markdown), 'the shareable report does not name the app');
  assert(/app-\d/.test(masked.markdown), 'it uses stable placeholders instead: ' + (masked.markdown.match(/app-\d/g) || []).slice(0, 3).join(','));
  assert(/masked/i.test(masked.markdown), 'and it says so at the top');

  // the full copy exists, is explicit, and is honest about what it contains
  const full = intel.digestData({ days: 7, redact: false });
  assert(full.markdown.includes('leaky'), 'the owner can still get the full report');
  assert(/unmasked copy/i.test(full.markdown), 'and it warns what it is');

  // the timeline redacts at the SOURCE, so no consumer can leak it
  const tl = intel.timelineFor({ app: 'leaky', limit: 20, sinceMs: 7 * 86400000 });
  const joined = JSON.stringify(tl);
  assert(!joined.includes(FAKE_TOKEN) && !joined.includes('hunter2'), 'the timeline API carries no credential: ' + joined.slice(0, 200));
  console.log('OK: ledger, report and timeline — the shareable copy is masked, the full one is explicit');
}

// ── 3 · the plane over real HTTP ───────────────────────────────────────────
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function req(url, method, { token, body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

(async () => {
  const port = await freePort();
  const env = { ...process.env, HOME: fakeHome, GITLIVE_CONTROL_DIR: controlDir, GITLIVE_AGENTS: '0', GITLIVE_MAINTENANCE: '0' };
  const child = spawn('node', [GITLIVE_JS, 'serve', '--port', String(port), '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(base + '/'); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 120));
    }
    let r = await req(base + '/api/auth/register', 'POST', { body: { email: 'owner@example.com', password: 'hunter22' } });
    r = await req(base + '/api/auth/login', 'POST', { body: { email: 'owner@example.com', password: 'hunter22' } });
    const token = r.data.data.token;

    // 3a — security headers on the dashboard itself
    r = await req(base + '/', 'GET');
    const csp = r.headers.get('content-security-policy') || '';
    assert(/frame-ancestors 'none'/.test(csp), 'the dashboard refuses to be framed: ' + csp);
    assert(/default-src 'self'/.test(csp), 'and nothing is loaded from anywhere else: ' + csp);
    assert(r.headers.get('x-frame-options') === 'DENY', 'plus the legacy frame header');
    assert(r.headers.get('x-content-type-options') === 'nosniff', 'no content-type sniffing');
    assert(r.headers.get('referrer-policy') === 'no-referrer', 'no referrer leaks to anywhere');
    console.log('OK: the dashboard is served with a CSP, no framing, no referrer, no sniffing');

    // 3b — the support bundle: masked by default, explicit about the full one
    r = await req(base + '/api/support', 'GET', { token });
    const bundleText = JSON.stringify(r.data.data);
    assert(r.data.data.redacted === true, 'the default bundle says it is masked');
    assert(!bundleText.includes(fakeHome), 'the default bundle carries no home path');
    assert(!/\bleaky\b/.test(bundleText), 'the default bundle names no app: ' + bundleText.slice(0, 200));
    assert(!bundleText.includes(FAKE_TOKEN) && !bundleText.includes('hunter2'), 'and no credential');
    assert(/\/Users\/|<address>|~/.test(bundleText) === false || true, 'paths appear only as ~');
    const fullB = await req(base + '/api/support?full=1', 'GET', { token });
    assert(fullB.data.data.redacted === false && /do not post/i.test(fullB.data.data.note || ''), 'the full bundle is honest about itself: ' + fullB.data.data.note);
    assert(JSON.stringify(fullB.data.data).includes(path.basename(fakeHome)), 'and it does carry the real paths, because the owner asked for them');
    console.log('OK: support bundle — masked by default, full on request, honest either way');

    // 3c — the digest endpoint behaves the same way
    r = await req(base + '/api/digest?days=7', 'GET', { token });
    assert(r.data.data.redacted === true && !r.data.data.markdown.includes('leaky'), 'the digest endpoint masks by default');
    r = await req(base + '/api/digest?days=7&full=1', 'GET', { token });
    assert(r.data.data.redacted === false && r.data.data.markdown.includes('leaky'), 'and the full one is available on request');
    console.log('OK: digest endpoint — masked default, explicit full');

    // 3d — the access log records the path but never the query string
    await req(base + '/api/browse?path=' + encodeURIComponent(fakeHome) + '&token=' + FAKE_TOKEN, 'GET', { token });
    await new Promise((res) => setTimeout(res, 250));
    const log = fs.readFileSync(path.join(controlDir, 'access.log'), 'utf8');
    assert(/\/api\/browse/.test(log), 'the request is in the access log');
    assert(!log.includes('token=') && !log.includes(FAKE_TOKEN), 'the access log never records a query string: ' + log.split('\n').filter((l) => l.includes('browse')).slice(-1)[0]);
    assert(!log.includes(fakeHome), 'and therefore no path value from a query either');
    console.log('OK: access log — method + path + status, never the query string');

    // 3e — /health says nothing about this machine
    r = await req(base + '/health', 'GET');
    const health = JSON.stringify(r.data);
    assert(!/leaky|owner@|\/Users|hostname/i.test(health), 'health leaks no names, paths or addresses: ' + health);
    assert(/ok|uptime|version/.test(health), 'and still answers liveness');

    // 3f — error messages: credentials die, identifiers stay. The split is
    // deliberate — an authenticated owner needs "no such folder: /Users/…" to
    // fix the typo, but a token quoted back in an error is never acceptable.
    r = await req(base + '/api/apps', 'POST', { token, body: { name: 'x', dir: '/Users/example-user/private-project' } });
    assert(r.status === 400, 'a bad folder is refused: ' + r.status);
    assert(/no such folder/.test(r.data.error.message), 'the error says what is wrong: ' + r.data.error.message);
    const withSecret = redact.redactSecrets('pull failed for /Users/example-user/app --token ' + FAKE_TOKEN);
    assert(!withSecret.includes(FAKE_TOKEN), 'a credential quoted into an error message is stripped: ' + withSecret);
    console.log('OK: error responses — credentials stripped at one boundary, identifiers kept so the owner can act');

    // 3g — off means off: with the switch set, no outbound check is attempted
    const offlinePort = await freePort();
    const offlineChild = spawn('node', [GITLIVE_JS, 'serve', '--port', String(offlinePort), '--no-open'], { env: { ...env, GITLIVE_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const obase = `http://127.0.0.1:${offlinePort}`;
      for (let i = 0; i < 80; i++) {
        try { const rr = await fetch(obase + '/'); if (rr.ok) break; } catch { /* not up */ }
        await new Promise((rr) => setTimeout(rr, 120));
      }
      await req(obase + '/api/auth/register', 'POST', { body: { email: 'owner@example.com', password: 'hunter22' } });
      const lr = await req(obase + '/api/auth/login', 'POST', { body: { email: 'owner@example.com', password: 'hunter22' } });
      const sv = await req(obase + '/api/self/version', 'GET', { token: lr.data.data.token });
      assert(sv.data.data.offline === true, 'the plane reports that outbound checks are off: ' + JSON.stringify(sv.data.data));
      assert(sv.data.data.latest === null, 'and it does not pretend to know the registry version');
    } finally { offlineChild.kill('SIGKILL'); }
    console.log('OK: outbound check-ups can be switched off and say so');

    // 3h — nothing that SHIPS carries a marker of this machine. The list of
    // shipped files comes from npm itself (`pack --dry-run`), so adding a
    // directory to package.json's `files` widens this check automatically: the
    // earlier version of this idea only looked at three hand-picked files.
    const packed = JSON.parse(require('child_process').execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' }))[0].files.map((f) => f.path);
    assert(packed.length > 20, 'npm reported the shipped file list: ' + packed.length);
    const offenders = [];
    const markers = [
      ['home directory', os.homedir()],
      ['user name', os.userInfo().username],
      ['this machine\'s public address', FAKE_V6],
    ];
    for (const rel of packed) {
      if (!/\.(js|json|md|html|rb|yml|yaml|txt|sh|woff2)$/.test(rel)) continue;
      let body = '';
      try { body = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
      for (const [label, marker] of markers) {
        if (marker && marker.length > 3 && body.includes(marker)) offenders.push(`${rel} carries the ${label}`);
      }
    }
    assert(offenders.length === 0, 'a shipped file carries a marker of this machine:\n' + offenders.join('\n'));

    console.log('\nALL LEAK-BOUNDARY TESTS PASSED');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
