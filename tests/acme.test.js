'use strict';
// Automatic certificates (ACME DNS-01) — proven offline against a stub CA.
//
// The point of this suite: the client speaks the REAL protocol (JWS signing,
// nonces, order, dns-01 challenge, CSR, finalize, download) and its crypto is
// verified, not assumed — the stub recomputes the expected TXT value from the
// account thumbprint the client sent, and the certificate the stub issues is
// checked against the CA that signed it. Works behind NAT by design: nothing
// in this flow needs an inbound port.

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glacme-'));
const work = fs.mkdtempSync(path.join(shortTmp, 'glacme-work-'));
const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const acme = require(path.join(__dirname, '..', 'acme.js'));

const DOMAIN = 'notes.example.test';
const ZONE = 'example.test';
const CHALLENGE_TOKEN = 'stub-challenge-token';

function b64url(b) { return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

// --- a real CA to sign the stub's certificates -----------------------------
const caKey = path.join(work, 'ca.key');
const caCrt = path.join(work, 'ca.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '30', '-nodes', '-keyout', caKey, '-out', caCrt, '-subj', '/CN=stub ACME CA'], { stdio: 'pipe' });

// --- stub DNS API (stands in for deSEC) -----------------------------------
const dnsCalls = [];
const dnsServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    dnsCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

// --- stub ACME server ------------------------------------------------------
let accountThumbprint = null;
let challengeValidated = false;
let finalizedCertificate = null;
let dnsValueSeen = null;
const acmeServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString();
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', 'replay-nonce': 'nonce-' + Math.random().toString(36).slice(2), ...headers });
      res.end(obj === null ? '' : JSON.stringify(obj));
    };
    const base = `http://127.0.0.1:${acmeServer.address().port}`;
    if (req.url === '/directory') return send(200, { newNonce: `${base}/new-nonce`, newAccount: `${base}/new-account`, newOrder: `${base}/new-order`, revokeCert: `${base}/revoke`, keyChange: `${base}/key-change` });
    if (req.url === '/new-nonce' && req.method === 'HEAD') return send(200, null);
    if (req.url === '/new-account') {
      const prot = JSON.parse(Buffer.from(JSON.parse(body).protected, 'base64').toString());
      const jwk = prot.jwk;
      assert(jwk && jwk.kty === 'RSA' && jwk.n && jwk.e, 'new-account must carry a JWK');
      accountThumbprint = b64url(crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest());
      return send(201, { status: 'valid' }, { location: `${base}/acct/1` });
    }
    if (req.url === '/new-order') {
      // the body is a JWS envelope — the order identifiers live in the payload
      const bodyJson = JSON.parse(Buffer.from(JSON.parse(body).payload, 'base64').toString());
      const dom = (bodyJson.identifiers && bodyJson.identifiers[0] && bodyJson.identifiers[0].value) || DOMAIN;
      return send(201, {
        status: 'pending', identifiers: [{ type: 'dns', value: dom }],
        authorizations: [`${base}/authz/${dom}`], finalize: `${base}/order/${dom}/finalize`,
      }, { location: `${base}/order/${dom}` });
    }
    if (req.url.startsWith('/authz/')) {
      const dom = req.url.slice('/authz/'.length);
      return send(200, {
        status: challengeValidated ? 'valid' : 'pending', identifier: { type: 'dns', value: dom },
        challenges: [{ type: 'dns-01', url: `${base}/chall/${dom}`, token: CHALLENGE_TOKEN, status: challengeValidated ? 'valid' : 'pending' }],
      });
    }
    if (req.url.startsWith('/chall/')) {
      // the client must have published the right TXT value before triggering
      const expected = b64url(crypto.createHash('sha256').update(`${CHALLENGE_TOKEN}.${accountThumbprint}`).digest());
      const put = dnsCalls.find((c) => c.method === 'PUT');
      assert(put, 'the client must create the TXT record before triggering the challenge');
      dnsValueSeen = JSON.parse(put.body).records[0].replace(/"/g, '');
      assert(dnsValueSeen === expected, `TXT value must be sha256(token.thumbprint) — got ${dnsValueSeen}, expected ${expected}`);
      challengeValidated = true;
      return send(200, { status: 'valid' });
    }
    if (req.url.startsWith('/order/') && req.url.endsWith('/finalize')) {
      const payload = JSON.parse(Buffer.from(JSON.parse(body).payload, 'base64').toString());
      const der = Buffer.from(payload.csr.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const csr = path.join(work, 'order.csr');
      fs.writeFileSync(csr, der);
      const ext = path.join(work, 'order.ext');
      const dom = req.url.slice('/order/'.length, -'/finalize'.length);
      fs.writeFileSync(ext, `subjectAltName=DNS:${dom}\n`);
      finalizedCertificate = path.join(work, 'order.crt');
      execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial',
        '-out', finalizedCertificate, '-days', '90', '-sha256', '-extfile', ext], { stdio: 'pipe' });
      return send(200, { status: 'valid', certificate: `${base}/cert/1` });
    }
    if (req.url.startsWith('/order/')) return send(200, { status: finalizedCertificate ? 'valid' : 'ready', ...(finalizedCertificate ? { certificate: `${base}/cert/x` } : {}) });
    if (req.url.startsWith('/cert/')) {
      const pem = fs.readFileSync(finalizedCertificate, 'utf8');
      res.writeHead(200, { 'content-type': 'application/pem-certificate-chain', 'replay-nonce': 'n2' });
      return res.end(pem);
    }
    return send(404, { detail: 'not found' });
  });
});

(async () => {
  await new Promise((r) => dnsServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => acmeServer.listen(0, '127.0.0.1', r));
  const dnsUrl = `http://127.0.0.1:${dnsServer.address().port}/api/v1`;
  const directory = `http://127.0.0.1:${acmeServer.address().port}/directory`;
  process.env.GITLIVE_DESEC_API = dnsUrl;

  // ── 1) the client: real flow, verified crypto, real certificate ──────────
  const res = await acme.issue({
    domain: DOMAIN, zone: ZONE, token: 'test-token', dir: path.join(work, 'acme'),
    fetchImpl: (u, o) => fetch(u, o), directoryUrl: directory,
  });
  assert(/BEGIN CERTIFICATE/.test(res.certPem), 'a certificate chain must come back');
  const certFile = path.join(work, 'issued.crt');
  fs.writeFileSync(certFile, res.certPem);
  const verify = spawnSync('openssl', ['verify', '-CAfile', caCrt, certFile], { encoding: 'utf8' });
  assert(verify.status === 0, 'the issued certificate must verify against the CA: ' + verify.stdout + verify.stderr);
  const text = execFileSync('openssl', ['x509', '-in', certFile, '-noout', '-text'], { encoding: 'utf8' });
  assert(text.includes(`DNS:${DOMAIN}`), 'the certificate must cover the domain');
  assert(res.record === `_acme-challenge.${DOMAIN}`, 'the TXT record must be _acme-challenge.<domain>');
  assert(dnsCalls.some((c) => c.method === 'PUT' && c.url.includes('_acme-challenge')), 'the TXT record must be created through the DNS API');
  assert(dnsCalls.some((c) => c.method === 'DELETE'), 'the TXT record must be cleaned up afterwards');
  assert(/Token test-token/.test(dnsCalls[0].auth), 'the DNS API must be authenticated');
  console.log('OK: ACME dns-01 — JWS account, verified TXT value, CA-signed certificate installed, record cleaned up');

  // ── 2) the CLI path: `gitlive domain cert <domain>` end to end ───────────
  // Root cause of the former stall (documented, fixed 2026-09-10): the CLI
  // child was run through spawnSync, which FREEZES the parent's event loop —
  // and the stub ACME/DNS servers live in the parent. The child's first fetch
  // therefore never got an answer, and only the 30s timeout killed it. The
  // product was never at fault (phase 1 proves issue() against the same
  // stub); the plumbing was. spawn (async) keeps the parent's loop alive so
  // the stubs can serve the child, which is exactly how a real user runs it.
  dnsCalls.length = 0; // fresh account, fresh TXT value — reset the stub's view
  fs.mkdirSync(path.join(home, '.gitlive', 'domain'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gitlive', 'domain', 'zones.json'), JSON.stringify({ [ZONE]: { dnsToken: 'test-token' } }));
  const env = { ...process.env, HOME: home, GITLIVE_DESEC_API: dnsUrl, GITLIVE_ACME_DIRECTORY: directory };
  const { spawn } = require('child_process');
  const runChild = (args, opts = {}) => new Promise((resolve) => {
    const child = spawn('node', args, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), opts.timeout || 60000);
    child.on('close', (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
  const child = await runChild([GITLIVE_JS, 'domain', 'cert', DOMAIN], { env, cwd: work, timeout: 60000 });
  assert(child.code === 0 && /certificate installed/.test(child.out), `the CLI must issue and install end to end (exit ${child.code}):\n` + child.out);
  const installed = path.join(home, '.gitlive', 'domain', 'public', `${DOMAIN}.crt`);
  assert(fs.existsSync(installed), 'the certificate must land in the public cert dir for the gateway');
  const mode = fs.statSync(path.join(home, '.gitlive', 'domain', 'public', `${DOMAIN}.key`)).mode & 0o777;
  assert(mode === 0o600, `the private key must be mode 600 (got ${mode.toString(8)})`);
  console.log('OK: CLI — gitlive domain cert issues, installs, and keeps the key private');

  // ── 3) failures are honest: no token, no silent success ─────────────────
  const noToken = spawnSync('node', [GITLIVE_JS, 'domain', 'cert', 'other.example.test'], { env: { ...env, HOME: fs.mkdtempSync(path.join(shortTmp, 'glacme-none-')) }, encoding: 'utf8', cwd: work });
  assert(noToken.status !== 0 && /no DNS API token/.test(noToken.stderr + noToken.stdout), 'a missing DNS token must fail with instructions');
  console.log('OK: failures — missing DNS credentials are refused with instructions, not silent');

  // ── 4) *.zone: one command, every app under the zone, zero per-app steps ─
  dnsCalls.length = 0;
  challengeValidated = false; // fresh challenge state for the loop
  const zoneHome = fs.mkdtempSync(path.join(shortTmp, 'glacme-zone-'));
  fs.mkdirSync(path.join(zoneHome, '.gitlive', 'domain'), { recursive: true });
  fs.writeFileSync(path.join(zoneHome, '.gitlive', 'apps.json'), JSON.stringify({
    one: { mode: 'local', port: '1' },
    two: { mode: 'local', port: '2' },
    connapp: { mode: 'connect', port: '0' },
  }, null, 2));
  fs.writeFileSync(path.join(zoneHome, '.gitlive', 'domain', 'zones.json'), JSON.stringify({ 'example.test': { dnsToken: 'test-token' } }));
  const zoneEnv = { ...process.env, HOME: zoneHome, GITLIVE_DESEC_API: dnsUrl, GITLIVE_ACME_DIRECTORY: directory };
  const zoneChild = await runChild([GITLIVE_JS, 'domain', 'cert', '*.example.test'], { env: zoneEnv, cwd: work, timeout: 90000 });
  assert(zoneChild.code === 0, `the zone loop exits clean:\n` + zoneChild.out);
  assert(/2 certificate\(s\) installed/.test(zoneChild.out), 'the zone loop reports every app covered:\n' + zoneChild.out);
  for (const d of ['one.example.test', 'two.example.test']) {
    assert(fs.existsSync(path.join(zoneHome, '.gitlive', 'domain', 'public', `${d}.crt`)), `the certificate for ${d} lands in the public dir`);
    assert(dnsCalls.some((c) => c.method === 'PUT' && c.url.includes(`_acme-challenge.${d}`)), `the TXT record for ${d} was created`);
  }
  assert(!dnsCalls.some((c) => c.url.includes('connapp')), 'connect-mode apps get no certificate');
  assert(dnsCalls.filter((c) => c.method === 'DELETE').length === 2, 'both TXT records were cleaned up');
  console.log('OK: zone coverage — *.zone issues for every app with the stored token, connect apps skipped, records cleaned');

  dnsServer.close();
  acmeServer.close();
  console.log('ALL ACME TESTS PASSED');
})().catch((err) => { console.error(err.message); process.exit(1); });
