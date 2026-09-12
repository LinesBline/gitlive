'use strict';
// SPDX-License-Identifier: AGPL-3.0-or-later
// acme.js — automatic certificates (RFC 8555) with zero npm dependencies.
//
// Why DNS-01: the people this matters most for are behind NAT — a home
// connection, a phone hotspot, a machine where port forwarding isn't an
// option. HTTP-01 needs inbound :80; DNS-01 only needs the ability to write
// one TXT record, so a name can get a real certificate from anywhere.
//
// The client speaks the real protocol (JWS + nonce + order + challenge + CSR
// + finalize), so it is testable offline against a stub server and usable
// against Let's Encrypt when a real domain exists. Keys and CSRs come from the
// system openssl, so npm-side dependencies stay at zero.
//
// Providers: deSEC (free, EU, API-first) ships here; the interface is
// { createTxt, deleteTxt }, so other DNS APIs can be added later.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- DNS providers ---------------------------------------------------------
const providers = {
  desec: {
    name: 'deSEC',
    // general record writer (launch journey / name office): the same API the
    // ACME TXT dance uses, for A/AAAA records that publish an app's address.
    async createRecord({ token, zone, subname, type, value, ttl = 3600, fetchImpl }) {
      const url = `${process.env.GITLIVE_DESEC_API || 'https://desec.io/api/v1'}/domains/${zone}/rrsets/${subname}/${type}/`;
      const r = await fetchImpl(url, {
        method: 'PUT',
        headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subname, type, ttl, records: [value] }),
      });
      if (!r.ok) throw new Error(`deSEC refused the ${type} record: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return true;
    },
    async deleteRecord({ token, zone, subname, type, fetchImpl }) {
      const url = `${process.env.GITLIVE_DESEC_API || 'https://desec.io/api/v1'}/domains/${zone}/rrsets/${subname}/${type}/`;
      await fetchImpl(url, { method: 'DELETE', headers: { Authorization: `Token ${token}` } }).catch(() => {});
      return true;
    },
    async createTxt({ token, zone, record, value, fetchImpl }) {
      const url = `${process.env.GITLIVE_DESEC_API || 'https://desec.io/api/v1'}/domains/${zone}/rrsets/${record}/TXT/`;
      const r = await fetchImpl(url, {
        method: 'PUT',
        headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subname: record, type: 'TXT', ttl: 60, records: [`"${value}"`] }),
      });
      if (!r.ok) throw new Error(`deSEC refused the TXT record: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return true;
    },
    async deleteTxt({ token, zone, record, fetchImpl }) {
      const url = `${process.env.GITLIVE_DESEC_API || 'https://desec.io/api/v1'}/domains/${zone}/rrsets/${record}/TXT/`;
      await fetchImpl(url, { method: 'DELETE', headers: { Authorization: `Token ${token}` } }).catch(() => {});
      return true;
    },
  },
};

// --- ACME core -------------------------------------------------------------
class Acme {
  constructor({ directoryUrl, fetchImpl = fetch }) {
    this.directoryUrl = directoryUrl;
    this.fetch = fetchImpl;
    this.dir = null;
    this.kid = null;
  }

  async init(accountKeyPem) {
    this.dir = await (await this.fetch(this.directoryUrl)).json();
    this.accountKey = crypto.createPrivateKey(accountKeyPem);
    const jwk = crypto.createPublicKey(this.accountKey).export({ format: 'jwk' });
    this.jwk = { e: jwk.e, kty: jwk.kty, n: jwk.n };
    this.thumbprint = b64url(sha256(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })));
    await this.newAccount();
    return this;
  }

  async nonce() {
    const r = await this.fetch(this.dir.newNonce, { method: 'HEAD' });
    const n = r.headers.get('replay-nonce');
    if (!n) throw new Error('ACME server gave no nonce');
    return n;
  }

  async post(url, payload) {
    const nonce = await this.nonce();
    const protectedHeader = { alg: 'RS256', nonce, url, ...(this.kid ? { kid: this.kid } : { jwk: this.jwk }) };
    const protB64 = b64url(JSON.stringify(protectedHeader));
    const payloadB64 = payload === '' ? '' : b64url(JSON.stringify(payload));
    const sig = b64url(crypto.sign('sha256', Buffer.from(`${protB64}.${payloadB64}`), this.accountKey));
    const r = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jose+json' },
      body: JSON.stringify({ protected: protB64, payload: payloadB64, signature: sig }),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!r.ok) throw new Error(`ACME ${url} failed: ${r.status} ${text.slice(0, 200)}`);
    return { json, headers: r.headers, raw: text };
  }

  async newAccount() {
    const { json, headers } = await this.post(this.dir.newAccount, { termsOfServiceAgreed: true });
    this.kid = headers.get('location') || (json && json.kid) || null;
    if (!this.kid) throw new Error('ACME server did not return an account URL');
  }

  async order(domain) {
    const { json, headers } = await this.post(this.dir.newOrder, { identifiers: [{ type: 'dns', value: domain }] });
    return { order: json, url: headers.get('location') };
  }

  async fetchJson(url) {
    const { json } = await this.post(url, {});
    return json;
  }

  // Wildcard orders authorize the BASE domain, but the TXT record must live at
  // _acme-challenge.<base> — the caller passes the identifier it needs.
  async answerDnsChallenge(authzUrl, provider, ctx) {
    const authz = await this.fetchJson(authzUrl);
    const challenge = (authz.challenges || []).find((c) => c.type === 'dns-01');
    if (!challenge) throw new Error('no dns-01 challenge offered');
    const record = ctx.record || `_acme-challenge.${authz.identifier.value}`;
    const value = b64url(sha256(challenge.token, '.', this.thumbprint));
    await provider.createTxt({ ...ctx, record, value });
    await this.post(challenge.url, {});
    let state = authz;
    for (let i = 0; i < 30; i++) {
      state = await this.fetchJson(authzUrl);
      if (state.status === 'valid') return { record, value };
      if (state.status === 'invalid') throw new Error(`challenge failed: ${JSON.stringify(state.challenges || []).slice(0, 300)}`);
      await sleep(2000);
    }
    throw new Error('challenge did not validate in time (DNS still propagating?)');
  }

  // RFC 8555: the CSR goes to the order's `finalize` URL; the ORDER url is
  // what you poll afterwards.
  async finalize(orderUrl, finalizeUrl, csrDer) {
    await this.post(finalizeUrl || orderUrl, { csr: b64url(csrDer) });
    for (let i = 0; i < 30; i++) {
      const order = await this.fetchJson(orderUrl);
      if (order.status === 'valid' && order.certificate) return order.certificate;
      if (order.status === 'invalid') throw new Error('order became invalid');
      await sleep(2000);
    }
    throw new Error('order did not become valid in time');
  }

  async download(certUrl) {
    const { raw } = await this.post(certUrl, '');
    return raw;
  }
}

// --- openssl helpers (key + CSR carrying the SANs) -------------------------
function openssl(args) {
  const r = spawnSync('openssl', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  return r.stdout || '';
}
function makeKeyAndCsr(domain, dir) {
  const keyPath = path.join(dir, `${domain}.key`);
  const csrPath = path.join(dir, `${domain}.csr`);
  const cfgPath = path.join(dir, `${domain}.cnf`);
  openssl(['genrsa', '-out', keyPath, '2048']);
  fs.chmodSync(keyPath, 0o600);
  fs.writeFileSync(cfgPath, `[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=req_ext\n[dn]\nCN=${domain}\n[req_ext]\nsubjectAltName=DNS:${domain}\n`);
  openssl(['req', '-new', '-key', keyPath, '-config', cfgPath, '-out', csrPath, '-outform', 'DER']);
  const der = fs.readFileSync(csrPath);
  fs.rmSync(csrPath, { force: true });
  fs.rmSync(cfgPath, { force: true });
  return { keyPath, der, keyPem: fs.readFileSync(keyPath, 'utf8') };
}

// --- the one call the CLI makes -------------------------------------------
async function issue(opts) {
  const {
    domain, zone, providerName = 'desec', token, staging = false,
    dir = path.join(os.homedir(), '.gitlive', 'domain', 'acme'),
    fetchImpl = fetch, keepTxt = false, directoryUrl,
  } = opts;
  if (!domain) throw new Error('issue() needs a domain');
  if (!zone) throw new Error('issue() needs the DNS zone that holds the record');
  const provider = providers[providerName];
  if (!provider) throw new Error(`unknown DNS provider "${providerName}" (have: ${Object.keys(providers).join(', ')})`);
  if (!token) throw new Error(`no DNS API token for ${providerName}`);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const accountKeyPath = path.join(dir, 'account.key');
  if (!fs.existsSync(accountKeyPath)) {
    openssl(['genrsa', '-out', accountKeyPath, '2048']);
    fs.chmodSync(accountKeyPath, 0o600);
  }
  const resolvedDirectory = directoryUrl || (staging ? LE_STAGING : LE_PRODUCTION);
  const acme = await new Acme({ directoryUrl: resolvedDirectory, fetchImpl })
    .init(fs.readFileSync(accountKeyPath, 'utf8'));

  const { order, url: orderUrl } = await acme.order(domain);
  let answered = null;
  for (const authzUrl of order.authorizations || []) {
    // The record name comes from the AUTHORIZATION's identifier (for a
    // wildcard that is the base domain), never from the URL.
    answered = await acme.answerDnsChallenge(authzUrl, provider, { token, zone, fetchImpl });
  }
  const { keyPath, der } = makeKeyAndCsr(domain, dir);
  const certUrl = await acme.finalize(orderUrl, order.finalize, der);
  const certPem = await acme.download(certUrl);
  if (answered && !keepTxt) await provider.deleteTxt({ token, zone, record: answered.record, fetchImpl }).catch(() => {});
  return { certPem, keyPath, accountKeyPath, record: answered && answered.record, value: answered && answered.value };
}

module.exports = { issue, providers, Acme, b64url, sha256, LE_PRODUCTION, LE_STAGING };
