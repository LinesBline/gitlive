// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive crypt — Phase 4 hardening, core slice (D3 owner-key policy + D4
// key split). Standard audited primitives only, zero dependencies:
//
//   - at-rest encryption: AES-256-GCM (node:crypto) with a random IV and a
//     16-byte auth tag; file format "GLC1" | iv(12) | tag(16) | ciphertext.
//     The storage key lives at ~/.gitlive/storage.key (0600) and is NOT the
//     manifest key — a seized node yields ciphertext, not keys (N7).
//
//   - Shamir Secret Sharing over GF(256): split any file into N shares of
//     which T reconstruct it. No share reveals anything alone; T-1 shares
//     reveal nothing (perfect secrecy per byte). Format "GLS1" | t | n | x
//     | bytes.
//
// Honest boundaries (v3 §9): this core proves the primitives; wiring the
// 'owner-key' storage policy through sync/restore (encrypt blobs +
// snapshots at rest on replicas) is the next slice. Nothing here claims
// protection against a compromised RUNNING process — it protects seized
// disks and curious hosts.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DEFAULT_STORAGE_KEY = process.env.GITLIVE_STORAGE_KEY || path.join(os.homedir(), '.gitlive', 'storage.key');
const ENC_HEADER = Buffer.from('GLC1');
const SSS_HEADER = Buffer.from('GLS1');

// ---------------------------------------------------------------------------
// AES-256-GCM at-rest encryption
// ---------------------------------------------------------------------------
function encryptBytes(key32, plaintext) {
  if (key32.length !== 32) throw new Error('storage key must be 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key32, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENC_HEADER, iv, tag, ct]);
}

function decryptBytes(key32, blob) {
  if (!blob.subarray(0, 4).equals(ENC_HEADER)) throw new Error('not a GLC1 encrypted blob');
  const iv = blob.subarray(4, 16);
  const tag = blob.subarray(16, 32);
  const ct = blob.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key32, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]); // throws on bad tag
}

function encryptFile(key32, src, dst) {
  fs.writeFileSync(dst, encryptBytes(key32, fs.readFileSync(src)));
  return dst;
}

function decryptFile(key32, src, dst) {
  fs.writeFileSync(dst, decryptBytes(key32, fs.readFileSync(src)));
  return dst;
}

function ensureStorageKey(keyPath = DEFAULT_STORAGE_KEY) {
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
  }
  return fs.readFileSync(keyPath);
}

function keyIsWrapped(keyPath = DEFAULT_STORAGE_KEY) {
  try {
    const b = fs.readFileSync(keyPath);
    return b.subarray(0, 4).toString('utf8') === 'GKW1';
  } catch { return false; }
}

function makeStorageKey(keyPath = DEFAULT_STORAGE_KEY, passphrase) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const raw = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, passphrase ? wrapKey(raw, passphrase) : raw, { mode: 0o600 });
  return raw;
}

// ---------------------------------------------------------------------------
// passphrase wrapping + duress (anti-coercion slice)
// ---------------------------------------------------------------------------
const DURESS_PREFIX = '!';
const EVENTS_LOG = path.join(os.homedir(), '.gitlive', 'events.log');

function logEvent(kind, detail) {
  try {
    fs.mkdirSync(path.dirname(EVENTS_LOG), { recursive: true });
    fs.appendFileSync(EVENTS_LOG, JSON.stringify({ at: new Date().toISOString(), kind, detail }) + '\n');
  } catch { /* logging must never break the op */ }
}

function wrapKey(raw, passphrase) {
  const salt = crypto.randomBytes(16);
  const kek = crypto.scryptSync(String(passphrase), salt, 32);
  const blob = encryptBytes(kek, raw);
  const meta = Buffer.from('GKW1' + String(salt.length).padStart(2, '0'));
  return Buffer.concat([meta, salt, blob]);
}

function unwrapKey(wrapped, passphrase) {
  const head = wrapped.subarray(0, 4).toString('utf8');
  if (head !== 'GKW1') throw new Error('not a GKW1 wrapped key');
  const saltLen = Number(wrapped.subarray(4, 6).toString('utf8'));
  const salt = wrapped.subarray(6, 6 + saltLen);
  const blob = wrapped.subarray(6 + saltLen);
  const kek = crypto.scryptSync(String(passphrase), salt, 32);
  return decryptBytes(kek, blob); // throws on wrong phrase
}

// irreversible: overwrite + unlink the key file, log it
function shredKeyFile(keyPath, reason) {
  const abs = path.resolve(keyPath);
  if (fs.existsSync(abs)) {
    const stat = fs.statSync(abs);
    const buf = crypto.randomBytes(Math.max(32, stat.size));
    try { fs.writeFileSync(abs, buf); fs.rmSync(abs, { force: true }); } catch (e) {
      fs.rmSync(abs, { force: true }); // best effort overwrite then remove
    }
  }
  logEvent('duress', { reason: reason || 'manual', key: abs, at: new Date().toISOString() });
  return abs;
}

// ---------------------------------------------------------------------------
// dead-man switch (anti-coercion, next slice): arm → must tick before the
// deadline or the storage key is crypto-shredded. Runs wherever a cron /
// LaunchAgent / boot script calls `crypt deadman check`.
// ---------------------------------------------------------------------------
const DEADMAN_PATH = path.join(os.homedir(), '.gitlive', 'deadman.json');

function deadmanArm(hours) {
  const intervalH = Number.isFinite(Number(hours)) ? Number(hours) : 24;
  const deadline = new Date(Date.now() + intervalH * 3600 * 1000).toISOString();
  fs.mkdirSync(path.dirname(DEADMAN_PATH), { recursive: true });
  fs.writeFileSync(DEADMAN_PATH, JSON.stringify({ deadline, intervalH, armedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return { deadline, intervalH };
}

function deadmanTick() {
  const st = deadmanState();
  if (!st) return { ok: false, reason: 'not armed — gitlive crypt deadman arm --hours N' };
  return deadmanArm(st.intervalH || 24);
}

function deadmanState() {
  try { return JSON.parse(fs.readFileSync(DEADMAN_PATH, 'utf8')); } catch { return null; }
}

function deadmanCheck({ shred = shredKeyFile, keyPath = DEFAULT_STORAGE_KEY } = {}) {
  const st = deadmanState();
  if (!st) return { ok: true, state: 'disarmed' };
  const deadline = new Date(st.deadline).getTime();
  const now = Date.now();
  if (now > deadline) {
    const p = shred ? shred(keyPath, 'deadman switch expired ' + st.deadline) : null;
    logEvent('deadman', { deadline: st.deadline, key: keyPath });
    try { fs.rmSync(DEADMAN_PATH, { force: true }); } catch { /* gone */ }
    return { ok: false, shredded: true, reason: 'deadline ' + st.deadline + ' passed — storage key shredded' };
  }
  return { ok: true, state: 'armed', hoursLeft: Math.max(0, Math.round((deadline - now) / 3600000 * 10) / 10) };
}

// ---------------------------------------------------------------------------
// decoy layer (anti-coercion): a second, plausible dataset behind its own
// wrapped key. Under coercion the owner reveals the DECOY phrase — the gate
// opens ONLY the decoy world (list/put/get), never the real one. A duress
// prefix at the decoy gate still shreds the REAL storage key (single
// trigger, consistent with unlock). Decoy data is stored ciphertext under
// the decoy key so the world looks consistent if inspected.
// ---------------------------------------------------------------------------
const DECOY_DIR = process.env.GITLIVE_DECOY_DIR || path.join(os.homedir(), '.gitlive', 'decoy');
const DECOY_KEY_PATH = process.env.GITLIVE_DECOY_KEY || path.join(os.homedir(), '.gitlive', 'decoy.key');
const DECOY_META_PATH = path.join(path.dirname(DECOY_KEY_PATH), 'decoy.json');

function decoyMeta() {
  try { return JSON.parse(fs.readFileSync(DECOY_META_PATH, 'utf8')); } catch { return null; }
}

// gate: duress prefix shreds the REAL key; otherwise unwrap the decoy key.
function decoyGate(passphrase) {
  if (String(passphrase).startsWith(DURESS_PREFIX)) {
    if (fs.existsSync(DEFAULT_STORAGE_KEY)) {
      shredKeyFile(DEFAULT_STORAGE_KEY, 'duress passphrase entered at the DECOY gate');
      return { duress: true };
    }
    return { duress: true, note: 'no real storage key present' };
  }
  if (!fs.existsSync(DECOY_KEY_PATH)) return { error: 'no decoy key — gitlive crypt decoy init --name <n> --passphrase <p>' };
  try {
    const raw = unwrapKey(fs.readFileSync(DECOY_KEY_PATH), passphrase);
    return { ok: true, key: raw };
  } catch {
    return { error: 'wrong decoy passphrase' };
  }
}

function decoyInit(name, passphrase) {
  if (decoyMeta()) throw new Error('decoy already initialized');
  if (!name || !passphrase) throw new Error('decoy init needs --name and --passphrase');
  fs.mkdirSync(DECOY_DIR, { recursive: true });
  const raw = crypto.randomBytes(32);
  fs.writeFileSync(DECOY_KEY_PATH, wrapKey(raw, String(passphrase)), { mode: 0o600 });
  fs.writeFileSync(DECOY_META_PATH, JSON.stringify({ name: String(name), createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return { name: String(name), dir: DECOY_DIR };
}

function decoyPut(src, rel, passphrase) {
  const gate = decoyGate(passphrase);
  if (gate.duress) return { duress: true };
  if (gate.error) throw new Error(gate.error);
  if (!rel || rel.includes('..')) throw new Error('bad rel path');
  const dst = path.join(DECOY_DIR, rel + '.glc');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, encryptBytes(gate.key, fs.readFileSync(src)));
  return { ok: true, rel };
}

function decoyGet(rel, passphrase, out) {
  const gate = decoyGate(passphrase);
  if (gate.duress) return { duress: true };
  if (gate.error) throw new Error(gate.error);
  const src = path.join(DECOY_DIR, rel + '.glc');
  if (!fs.existsSync(src)) throw new Error('no decoy file ' + rel);
  fs.writeFileSync(out, decryptBytes(gate.key, fs.readFileSync(src)));
  return { ok: true, rel };
}

function decoyList(passphrase) {
  const gate = decoyGate(passphrase);
  if (gate.duress) return { duress: true };
  if (gate.error) throw new Error(gate.error);
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.glc')) out.push(path.relative(DECOY_DIR, abs).slice(0, -4));
    }
  };
  if (fs.existsSync(DECOY_DIR)) walk(DECOY_DIR);
  return { ok: true, files: out.sort() };
}

// ---------------------------------------------------------------------------
// Shamir Secret Sharing over GF(256)
// ---------------------------------------------------------------------------
const GF = (() => {
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  return {
    mul(a, b) { if (!a || !b) return 0; return exp[log[a] + log[b]]; },
    div(a, b) { if (!b) throw new Error('gf div by zero'); if (!a) return 0; return exp[(log[a] + 255 - log[b]) % 255]; },
    polyEval(coeffs, xv) {
      let y = 0;
      for (let i = coeffs.length - 1; i >= 0; i--) y = GF.mul(y, xv) ^ coeffs[i];
      return y;
    },
  };
})();

function splitSecretBytes(secret, total, threshold) {
  if (threshold > total) throw new Error('threshold cannot exceed share count');
  if (threshold < 2) throw new Error('threshold must be >= 2 (a 1-of-N split is a copy, not a secret)');
  if (total > 254) throw new Error('at most 254 shares (x in 1..254)');
  const shares = Array.from({ length: total }, () => Buffer.alloc(secret.length));
  for (let i = 0; i < secret.length; i++) {
    const coeffs = new Uint8Array(threshold);
    coeffs[0] = secret[i];
    for (let c = 1; c < threshold; c++) coeffs[c] = crypto.randomBytes(1)[0];
    for (let s = 0; s < total; s++) shares[s][i] = GF.polyEval(coeffs, s + 1);
  }
  return shares;
}

function joinSecretBytes(parts, threshold) {
  // parts: [{x, data}] with x = 1..total
  if (parts.length < threshold) throw new Error(`need ${threshold} shares, have ${parts.length}`);
  const secret = Buffer.alloc(parts[0].data.length);
  for (const p of parts) if (p.data.length !== secret.length) throw new Error('share length mismatch');
  const chosen = parts.slice(0, threshold);
  for (let i = 0; i < secret.length; i++) {
    // Lagrange interpolation at x=0 over the chosen points
    let y = 0;
    for (const a of chosen) {
      let num = 1;
      let den = 1;
      for (const b of chosen) {
        if (a.x === b.x) continue;
        num = GF.mul(num, b.x);
        den = GF.mul(den, b.x ^ a.x);
      }
      y ^= GF.mul(a.data[i], GF.div(num, den));
    }
    secret[i] = y;
  }
  return secret;
}

function splitFile(filePath, { total, threshold }) {
  const data = fs.readFileSync(filePath);
  const shares = splitSecretBytes(data, total, threshold);
  return shares.map((bytes, idx) => Buffer.concat([SSS_HEADER, Buffer.from([threshold, total, idx + 1]), bytes]));
}

function joinFiles(sharePaths) {
  const parts = sharePaths.map((p) => {
    const buf = fs.readFileSync(p);
    if (!buf.subarray(0, 4).equals(SSS_HEADER)) throw new Error(p + ' is not a GLS1 share');
    const threshold = buf[4];
    const x = buf[6];
    if (x < 1) throw new Error('bad share x');
    return { x, data: buf.subarray(7), threshold };
  });
  const threshold = parts[0].threshold;
  for (const p of parts) if (p.threshold !== threshold) throw new Error('shares disagree on threshold');
  if (parts.length < threshold) throw new Error(`need ${threshold} shares, have ${parts.length}`);
  return joinSecretBytes(parts, threshold);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function cmdCrypt(rest, flags) {
  const sub = rest[0];
  const fail = (msg) => { console.error(msg); process.exitCode = 1; };
  switch (sub) {
    case 'keygen': {
      if (flags.passphrase) {
        const raw = makeStorageKey(DEFAULT_STORAGE_KEY, String(flags.passphrase));
        const fp = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16).toUpperCase();
        console.log(`storage key ready at ${DEFAULT_STORAGE_KEY} — PASS PHRASE WRAPPED (GKW1)`);
        console.log(`fingerprint: ${fp}`);
        console.log(`duress is armed: entering a passphrase starting with "${DURESS_PREFIX}" at unlock shreds the key irreversibly`);
      } else {
        const key = ensureStorageKey();
        const fp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16).toUpperCase();
        console.log(`storage key ready at ${DEFAULT_STORAGE_KEY} (0600, 32 bytes random)`);
        console.log(`fingerprint: ${fp}`);
      }
      return;
    }
    case 'unlock': {
      // anti-coercion: correct phrase unwraps; a DURESS-marked phrase
      // (prefix !) shreds the key instead — data becomes unrecoverable.
      const phrase = flags.passphrase;
      if (!phrase) return fail('usage: gitlive crypt unlock --passphrase <phrase>');
      if (!fs.existsSync(DEFAULT_STORAGE_KEY)) return fail(`no storage key at ${DEFAULT_STORAGE_KEY}`);
      if (!keyIsWrapped()) return fail('storage key is not passphrase-wrapped (keygen --passphrase) — nothing to unlock');
      if (String(phrase).startsWith(DURESS_PREFIX)) {
        shredKeyFile(DEFAULT_STORAGE_KEY, 'duress passphrase entered at unlock');
        console.error('DURESS: key shredded irreversibly. All encrypted data is now unrecoverable noise.');
        process.exitCode = 42; // distinct code: automation can react
        return;
      }
      try {
        const raw = unwrapKey(fs.readFileSync(DEFAULT_STORAGE_KEY), phrase);
        const fp = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16).toUpperCase();
        console.log(`unlocked ok — fingerprint ${fp}`);
      } catch {
        return fail('wrong passphrase');
      }
      return;
    }
    case 'decoy': {
      const action = rest[1];
      const pass = flags.passphrase;
      if (action === 'init') {
        try {
          const r = decoyInit(flags.name, pass);
          console.log(`decoy world "${r.name}" initialized at ${r.dir} — revealing its passphrase shows ONLY this dataset`);
        } catch (e) { return fail('decoy init failed: ' + e.message); }
        return;
      }
      if (action === 'list') {
        if (!pass) return fail('usage: gitlive crypt decoy list --passphrase <p>');
        try {
          const r = decoyList(pass);
          if (r.duress) { console.error('DURESS: real storage key shredded.'); process.exitCode = 42; return; }
          console.log(r.files.length ? r.files.join('\n') : '(decoy world is empty)');
        } catch (e) { return fail(e.message); }
        return;
      }
      if (action === 'put') {
        if (!pass || !rest[2] || !rest[3]) return fail('usage: gitlive crypt decoy put <src> <rel> --passphrase <p>');
        try {
          const r = decoyPut(rest[2], rest[3], pass);
          if (r.duress) { console.error('DURESS: real storage key shredded.'); process.exitCode = 42; return; }
          console.log(`stored in the decoy world: ${r.rel}`);
        } catch (e) { return fail(e.message); }
        return;
      }
      if (action === 'get') {
        if (!pass || !rest[2] || !rest[3]) return fail('usage: gitlive crypt decoy get <rel> <out> --passphrase <p>');
        try {
          const r = decoyGet(rest[2], pass, rest[3]);
          if (r.duress) { console.error('DURESS: real storage key shredded.'); process.exitCode = 42; return; }
          console.log(`decrypted from the decoy world: ${r.rel}`);
        } catch (e) { return fail(e.message); }
        return;
      }
      return fail('usage: gitlive crypt decoy <init|list|put|get> … (see code)');
    }
    case 'deadman': {
      const action = rest[1];
      if (action === 'arm') {
        const r = deadmanArm(flags.hours);
        console.log(`dead-man armed: must tick by ${r.deadline} (interval ${r.intervalH}h)`);
        console.log(`schedule: gitlive crypt deadman check (e.g. every hour via cron/launchd) — missing it shreds the storage key`);
      } else if (action === 'tick') {
        const r = deadmanTick();
        if (!r.ok) return fail(r.reason);
        console.log(`ticked — next deadline ${r.deadline}`);
      } else if (action === 'check') {
        const r = deadmanCheck();
        if (!r.ok) { console.error('DEADMAN: ' + r.reason); process.exitCode = 43; return; }
        console.log(r.state === 'disarmed'
          ? 'dead-man disarmed (no deadline set)'
          : `dead-man armed — ${r.hoursLeft}h left before crypto-shred`);
      } else { return fail('usage: gitlive crypt deadman <arm --hours N | tick | check>'); }
      return;
    }
    case 'duress': {
      // explicit manual shred for file-based (unwrapped) keys
      if (!flags.yes) return fail('gitlive crypt duress is IRREVERSIBLE — confirm with --yes');
      if (!fs.existsSync(DEFAULT_STORAGE_KEY)) return fail('no storage key present');
      shredKeyFile(DEFAULT_STORAGE_KEY, 'manual duress --yes');
      console.error('DURESS: storage key shredded. Encrypted data is unrecoverable.');
      return;
    }
    case 'enc': {
      const src = rest[1]; const dst = rest[2];
      if (!src || !dst) return fail('usage: gitlive crypt enc <in> <out> [--key <path>]');
      try { encryptFile(ensureStorageKey(flags.key), src, dst); console.log(`encrypted ${src} → ${dst}`); } catch (e) { return fail('enc failed: ' + e.message); }
      return;
    }
    case 'dec': {
      const src = rest[1]; const dst = rest[2];
      if (!src || !dst) return fail('usage: gitlive crypt dec <in> <out> [--key <path>]');
      try { decryptFile(ensureStorageKey(flags.key), src, dst); console.log(`decrypted ${src} → ${dst}`); } catch (e) { return fail('dec failed (wrong key or corrupt?): ' + e.message); }
      return;
    }
    case 'split': {
      const file = rest[1];
      const total = Number(flags.shares) || 5;
      const threshold = Number(flags.threshold) || 3;
      const outDir = flags.out;
      if (!file || !outDir) return fail('usage: gitlive crypt split <file> --shares N --threshold T --out <dir>');
      try {
        fs.mkdirSync(outDir, { recursive: true });
        const shares = splitFile(file, { total, threshold });
        shares.forEach((b, i) => fs.writeFileSync(path.join(outDir, `share-${i + 1}.gls`), b, { mode: 0o600 }));
        console.log(`split ${file} into ${total} shares (need ${threshold}) in ${outDir}`);
      } catch (e) { return fail('split failed: ' + e.message); }
      return;
    }
    case 'join': {
      const dir = rest[1];
      const out = rest[2];
      const threshold = Number(flags.threshold) || 3;
      if (!dir || !out) return fail('usage: gitlive crypt join <shares-dir> <out-file> --threshold T');
      try {
        const paths = fs.readdirSync(dir).filter((f) => f.endsWith('.gls')).sort().slice(0, threshold).map((f) => path.join(dir, f));
        const secret = joinFiles(paths);
        fs.writeFileSync(out, secret, { mode: 0o600 });
        console.log(`joined ${paths.length} shares → ${out}`);
      } catch (e) { return fail('join failed: ' + e.message); }
      return;
    }
    default:
      console.log(`usage:
  gitlive crypt keygen [--passphrase <phrase>]   (wrapped key + duress armed)
  gitlive crypt deadman <arm --hours N | tick | check>  (miss the deadline → shred)
  gitlive crypt unlock --passphrase <phrase>     (prefix ${DURESS_PREFIX} = duress → shred)
  gitlive crypt duress --yes                     (manual shred of an unwrapped key)
  gitlive crypt enc <in> <out> [--key <path>]
  gitlive crypt dec <in> <out> [--key <path>]
  gitlive crypt split <file> --shares N --threshold T --out <dir>
  gitlive crypt join <shares-dir> <out-file> --threshold T`);
      process.exitCode = 1;
  }
}

module.exports = {
  encryptBytes, decryptBytes, encryptFile, decryptFile,
  ensureStorageKey, DEFAULT_STORAGE_KEY,
  makeStorageKey, keyIsWrapped, wrapKey, unwrapKey, shredKeyFile, logEvent,
  deadmanArm, deadmanTick, deadmanState, deadmanCheck, DEADMAN_PATH,
  decoyInit, decoyPut, decoyGet, decoyList, decoyGate, DECOY_DIR, DECOY_KEY_PATH,
  splitSecretBytes, joinSecretBytes, splitFile, joinFiles,
  cmdCrypt,
};
