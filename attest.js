#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// attest.js — SLSA/in-toto attestation export (P4 pain-driven roadmap: the
// credibility wedge). The receipts spine already records every deploy as an
// owner-signed git tag; this module exports that provenance in the STANDARD
// envelope the supply-chain world verifies — an in-toto Statement inside a
// DSSE envelope signed with the same owner key. A stranger with the public
// key can verify what deployed, when, from which commit, with which
// dependency closure — without trusting gitlive's storage at all.
//
// `gitlive attest <app>`        export the latest deploy as provenance
// `gitlive attest verify <file>` check the signature + self-consistency
//
// Honest limits, said out loud: this is DEPLOY provenance (what ran where),
// not package provenance (who built which binary). It proves the deploy
// receipt is the owner's; it does not prove the source code's contents —
// that's the signed manifest's job, and the two verify together.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VERSION = (() => { try { return require('./gitlive.js').VERSION; } catch { return '2.6.1'; } })();
const IN_TOTO = 'https://in-toto.io/Statement/v1';
const SLSA_V1 = 'https://slsa.dev/provenance/v1';
const PAYLOAD_TYPE = 'application/vnd.in-toto+json';

function b64(buf) { return Buffer.from(buf).toString('base64'); }
function sha256Hex(obj) { return crypto.createHash('sha256').update(typeof obj === 'string' ? obj : JSON.stringify(obj)).digest('hex'); }

// DSSE PAE: "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body (body = base64 payload)
function pae(payloadType, bodyB64) {
  return `DSSEv1 ${payloadType.length} ${payloadType} ${bodyB64.length} ${bodyB64}`;
}

function latestDeployTag(barePath) {
  const { parseDeployTags } = require('./gitlive.js');
  const tags = parseDeployTags(barePath);
  if (!tags || !tags.length) {
    throw new Error(`"${barePath}" has no signed deploy receipts — push once (with the current hooks), then attest.`);
  }
  return tags[0]; // newest first (parseDeployTags contract)
}

function buildStatement({ appName, commit, closure, outcome, at, barePath, fingerprint }) {
  const external = { app: appName, commit, closure: closure || null, outcome, at };
  const predicate = {
    buildDefinition: {
      buildType: 'https://gitlive.dev/deploy/v1',
      externalParameters: { app: appName, commit, source: 'git push' },
      internalParameters: { closure: closure || null, outcome, at },
      resolvedDependencies: [{ uri: 'git+file://' + barePath, digest: { gitCommit: commit } }],
    },
    runDetails: {
      builder: { id: `gitlive/${VERSION}@${(() => { try { const w = require('./mesh.js').whoami(); return w.handle ? w.name + '@' + w.id : 'self'; } catch { return 'self'; } })()}` },
      metadata: { invocationId: sha256Hex(external).slice(0, 16) },
      byproducts: { outcome, deployReceiptSignedBy: fingerprint },
    },
  };
  return {
    _type: IN_TOTO,
    subject: [{ name: `gitlive:deploy:${appName}:${commit}`, digest: { sha256: sha256Hex(predicate) } }],
    predicateType: SLSA_V1,
    predicate,
  };
}

function envelope(statement, priv, keyid) {
  const payload = JSON.stringify(statement);
  const payloadB64 = b64(payload);
  const sig = crypto.sign(null, Buffer.from(pae(PAYLOAD_TYPE, payloadB64)), priv).toString('base64');
  return { payload: payloadB64, payloadType: PAYLOAD_TYPE, signatures: [{ keyid, sig }] };
}

function cmdAttestExport(appName, flags) {
  const gitlive = require('./gitlive.js');
  const manifest = require('./manifest.js');
  const keyPath = flags.key || process.env.GITLIVE_MANIFEST_KEY || manifest.DEFAULT_KEY_PATH;
  if (!fs.existsSync(keyPath)) throw new Error('no owner key — run: gitlive manifest keygen (attestation signs with the key that signed the deploys)');
  const { priv, fingerprint } = manifest.loadPrivateKey(keyPath);
  const reg = gitlive.loadRegistry();
  const app = reg[appName];
  if (!app || !app.barePath) throw new Error(`No app named "${appName}" with a bare repo. Run "gitlive list".`);
  const tag = latestDeployTag(app.barePath);
  if (tag.legacy || !tag.sigValid) throw new Error('the newest deploy receipt is not a valid owner-signed receipt — push once with the current hooks, then attest.');
  const stmt = buildStatement({
    appName,
    commit: String(tag.commit || ''),
    closure: tag.closure || null,
    outcome: tag.outcome || 'success',
    at: tag.at || null,
    barePath: app.barePath,
    fingerprint,
  });
  const env = envelope(stmt, priv, fingerprint);
  const out = JSON.stringify(env, null, 1) + '\n';
  const outPath = flags.output ? String(flags.output) : null;
  if (outPath) {
    fs.writeFileSync(outPath, out);
    if (flags['pubkey-out']) {
      const manifest2 = require('./manifest.js');
      fs.writeFileSync(String(flags['pubkey-out']), manifest2.loadPrivateKey(keyPath).publicKeyPem, { mode: 0o644 });
      console.log(`public key → ${flags['pubkey-out']}`);
    }
    console.log(`attestation → ${outPath}  (in-toto Statement in a DSSE envelope, signed by ${fingerprint})`);
    console.log(`verify anywhere: gitlive attest verify ${outPath} --key <public-key.pem>`);
  } else {
    process.stdout.write(out);
  }
}

function cmdAttestVerify(filePath, flags) {
  const manifest = require('./manifest.js');
  let keyPem = null;
  if (flags.key) {
    keyPem = fs.readFileSync(String(flags.key), 'utf8');
  } else {
    const keyPath = process.env.GITLIVE_MANIFEST_KEY || manifest.DEFAULT_KEY_PATH;
    if (fs.existsSync(keyPath)) keyPem = manifest.loadPrivateKey(keyPath).publicKeyPem;
    else throw new Error('no key given — pass --key <public-key.pem> (gitlive attest wrote one with --pubkey-out)');
  }
  const env = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!env.payload || !env.payloadType || !Array.isArray(env.signatures) || !env.signatures.length) {
    throw new Error('not a DSSE envelope (missing payload/payloadType/signatures)');
  }
  if (env.payloadType !== PAYLOAD_TYPE) throw new Error(`unexpected payloadType "${env.payloadType}"`);
  const sigEntry = env.signatures[0];
  const valid = manifest.verifyBytes(keyPem, Buffer.from(pae(env.payloadType, env.payload)), sigEntry.sig);
  const stmt = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'));
  if (stmt._type !== IN_TOTO || stmt.predicateType !== SLSA_V1) throw new Error('statement is not an in-toto/SLSA statement');
  const selfConsistent = stmt.subject && stmt.subject[0] && stmt.subject[0].digest
    && stmt.subject[0].digest.sha256 === sha256Hex(stmt.predicate);
  const bd = stmt.predicate && stmt.predicate.buildDefinition || {};
  const rd = stmt.predicate && stmt.predicate.runDetails || {};
  console.log(`signature: ${valid ? 'VALID' : 'INVALID'}  (keyid ${sigEntry.keyid || '(none)'})`);
  console.log(`statement: ${selfConsistent ? 'self-consistent' : 'DIGEST MISMATCH — tampered'}`);
  const ext = bd.externalParameters || {};
  const int = bd.internalParameters || {};
  console.log(`app: ${ext.app || '?'} · commit ${ext.commit || '?'} · outcome ${int.outcome || '?'} · at ${int.at || '?'} · closure ${int.closure || 'unpinned'}`);
  console.log(`builder: ${(rd.builder && rd.builder.id) || '?'}`);
  if (!valid || !selfConsistent) process.exitCode = 1;
}

function cmdAttest(rest, flags) {
  const sub = rest[0];
  if (sub === 'verify') { cmdAttestVerify(String(rest[1] || ''), flags); return; }
  if (sub) { cmdAttestExport(String(sub), flags); return; }
  console.error('Usage: gitlive attest <app> [--output <file>] [--pubkey-out <file>]   export the latest deploy as SLSA/in-toto provenance');
  console.error('       gitlive attest verify <file> [--key <public-key.pem>]              verify signature + self-consistency');
  process.exitCode = 1;
}

module.exports = { cmdAttest, buildStatement, envelope, pae, latestDeployTag };

if (require.main === module) {
  const flags = (() => { try { return require('./gitlive.js').parseFlags(process.argv.slice(3)).flags; } catch { return {}; } })();
  try { cmdAttest(process.argv.slice(2), flags); } catch (err) { console.error('gitlive attest: ' + err.message); process.exit(1); }
}
