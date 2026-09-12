// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive keys — rotation core (ten-item program, item 3).
//
// Rotating a key is two operations: mint the replacement and prove
// possession of the old one. Every rotation appends a SIGNED handover
// record to ~/.gitlive/rotations.log (old key signs { kind, oldFingerprint,
// newFingerprint, at }) so the lineage is auditable and peers can accept the
// new fingerprint through the signature, never through a bare file swap.
//
// storage: data key — new raw key replaces the file (re-wrapped with the
//   same passphrase when the old key was passphrase-wrapped); optional
//   --reencrypt-dir walks *.glc files and re-encrypts them old→new in place.
//   Legacy snapshots in a git bus stay under the OLD key (superseded by the
//   next push under the new key) — documented, not silent.
// node:    Ed25519 identity key — new pair replaces the pem; handover signed
//   by the OLD key. Re-announce to peers after rotating (peer records embed
//   the node's public key).
// owner:   manifest key — new pair replaces the pem; handover signed by the
//   OLD key. Existing owner-signed artifacts stay verifiable via their
//   embedded public keys; peers must `peer trust add <new fingerprint>`.
//
// Honest v1 limits: rotation is local-file rotation with an audit trail —
// propagating new fingerprints across the mesh (re-announce/trust) is the
// operator step printed by each command, not automated yet.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const manifest = require('./manifest.js');
const crypt = require('./crypt.js');

const ROTATIONS_LOG = path.join(os.homedir(), '.gitlive', 'rotations.log');
const MANIFEST_KEY = process.env.GITLIVE_MANIFEST_KEY || manifest.DEFAULT_KEY_PATH;
const NODE_KEY = process.env.GITLIVE_NODE_KEY || path.join(os.homedir(), '.gitlive', 'node-key.pem');
const STORAGE_KEY = process.env.GITLIVE_STORAGE_KEY || crypt.DEFAULT_STORAGE_KEY;

function appendRotation(record, signerPriv) {
  fs.mkdirSync(path.dirname(ROTATIONS_LOG), { recursive: true });
  const sig = manifest.signBytes(signerPriv, Buffer.from(manifest.canonical(record), 'utf8'));
  fs.appendFileSync(ROTATIONS_LOG, JSON.stringify({ ...record, sig }) + '\n', { mode: 0o600 });
  return ROTATIONS_LOG;
}

function rotateStorageKey({ passphrase } = {}) {
  if (!fs.existsSync(STORAGE_KEY)) throw new Error('no storage key at ' + STORAGE_KEY);
  const oldBytes = fs.readFileSync(STORAGE_KEY);
  const wasWrapped = crypt.keyIsWrapped(STORAGE_KEY);
  if (wasWrapped && !passphrase) throw new Error('storage key is passphrase-wrapped — rotation needs --passphrase <phrase>');
  const oldRaw = wasWrapped ? crypt.unwrapKey(oldBytes, passphrase) : oldBytes;
  const oldFp = crypto.createHash('sha256').update(oldRaw).digest('hex').slice(0, 16).toUpperCase();
  const newRaw = crypto.randomBytes(32);
  const newFp = crypto.createHash('sha256').update(newRaw).digest('hex').slice(0, 16).toUpperCase();
  fs.writeFileSync(STORAGE_KEY, wasWrapped ? crypt.wrapKey(newRaw, passphrase) : newRaw, { mode: 0o600 });
  const record = { kind: 'storage-key-rotation', oldFingerprint: oldFp, newFingerprint: newFp, at: new Date().toISOString() };
  // sign with the OWNER key when present (lineage), else node key
  const signer = fs.existsSync(MANIFEST_KEY) ? manifest.loadPrivateKey(MANIFEST_KEY) : manifest.loadPrivateKey(NODE_KEY);
  appendRotation(record, signer.priv);
  return { ...record, wrapped: wasWrapped, log: ROTATIONS_LOG, oldRaw, newRaw };
}

function reencryptDir(dir, oldRaw, newRaw) {
  let count = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (abs.endsWith('.glc')) {
        const plain = crypt.decryptBytes(oldRaw, fs.readFileSync(abs));
        fs.writeFileSync(abs, crypt.encryptBytes(newRaw, plain));
        count++;
      }
    }
  };
  walk(dir);
  return count;
}

function rotateNodeKey() {
  if (!fs.existsSync(NODE_KEY)) throw new Error('no node key at ' + NODE_KEY);
  const oldKey = manifest.loadPrivateKey(NODE_KEY);
  const pair = manifest.generateOwnerKeyPair(); // Ed25519 pem pair
  fs.writeFileSync(NODE_KEY, pair.privateKeyPem, { mode: 0o600 });
  const newKey = manifest.loadPrivateKey(NODE_KEY);
  const record = { kind: 'node-key-rotation', oldFingerprint: oldKey.fingerprint, newFingerprint: newKey.fingerprint, at: new Date().toISOString() };
  appendRotation(record, oldKey.priv); // old key proves possession
  return { ...record, log: ROTATIONS_LOG, next: 're-announce to peers: gitlive peer announce <url> --endpoint <my-url>' };
}

function rotateOwnerKey() {
  if (!fs.existsSync(MANIFEST_KEY)) throw new Error('no owner manifest key at ' + MANIFEST_KEY);
  const oldKey = manifest.loadPrivateKey(MANIFEST_KEY);
  const pair = manifest.generateOwnerKeyPair();
  fs.writeFileSync(MANIFEST_KEY, pair.privateKeyPem, { mode: 0o600 });
  const newKey = manifest.loadPrivateKey(MANIFEST_KEY);
  const record = { kind: 'owner-key-rotation', oldFingerprint: oldKey.fingerprint, newFingerprint: newKey.fingerprint, at: new Date().toISOString() };
  appendRotation(record, oldKey.priv);
  return { ...record, log: ROTATIONS_LOG, next: 'distribute the new fingerprint; peers run: gitlive peer trust add ' + newKey.fingerprint };
}

function cmdKeys(rest, flags) {
  const kind = rest[0];
  const fail = (m) => { console.error(m); process.exitCode = 1; };
  try {
    if (kind === 'rotate' && rest[1] === 'storage') {
      const r = rotateStorageKey({ passphrase: flags.passphrase });
      console.log(`storage key rotated ${r.oldFingerprint} → ${r.newFingerprint}${r.wrapped ? ' (re-wrapped with your passphrase)' : ''}`);
      if (flags['reencrypt-dir']) {
        const n = reencryptDir(String(flags['reencrypt-dir']), r.oldRaw, r.newRaw);
        console.log(`re-encrypted ${n} file(s) in ${flags['reencrypt-dir']}`);
      }
      console.log(`handover recorded: ${r.log}`);
      console.log('next: push a fresh state snapshot under the new key (mesh sync) so replicas re-encrypt.');
      return;
    }
    if (kind === 'rotate' && rest[1] === 'node') {
      const r = rotateNodeKey();
      console.log(`node key rotated ${r.oldFingerprint} → ${r.newFingerprint}`);
      console.log(`handover recorded: ${r.log}`);
      console.log('next: ' + r.next);
      return;
    }
    if (kind === 'rotate' && rest[1] === 'owner') {
      const r = rotateOwnerKey();
      console.log(`owner key rotated ${r.oldFingerprint} → ${r.newFingerprint}`);
      console.log(`handover recorded: ${r.log}`);
      console.log('next: ' + r.next);
      return;
    }
    if (kind === 'rotations') {
      if (!fs.existsSync(ROTATIONS_LOG)) { console.log('(no rotations on record)'); return; }
      const lines = fs.readFileSync(ROTATIONS_LOG, 'utf8').trim().split('\n').filter(Boolean);
      for (const l of lines) {
        const r = JSON.parse(l);
        console.log(`${r.at}  ${r.kind}  ${r.oldFingerprint} → ${r.newFingerprint}`);
      }
      return;
    }
    fail('usage: gitlive keys rotate <storage|node|owner> [--passphrase <p>] [--reencrypt-dir <d>]\n       gitlive keys rotations');
  } catch (err) {
    fail('keys: ' + err.message);
  }
}

module.exports = { rotateStorageKey, rotateNodeKey, rotateOwnerKey, reencryptDir, appendRotation, cmdKeys, ROTATIONS_LOG };
