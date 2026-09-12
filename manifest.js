// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive app manifest — owner-signed deployment identity (Phase 2, D4).
//
// A portable app manifest (`.gitlive/app.manifest`) records what an app IS:
// its run contract, its deploy policy (min nodes / jurisdictions / storage
// mode / snapshot cadence), the exact git content it was signed over, and
// the owner's Ed25519 signature over all of that. Nodes verify the
// signature before accepting a deploy or a snapshot, so a hostile or
// compromised node can stop serving a copy but cannot substitute code or
// data the owner's key did not sign.
//
// Key model (D4): the OWNER manifest key is the trust anchor. The private
// key belongs on the owner's offline media; gitlive's default key path is
// a convenience for single-machine operation and MUST be documented as
// such. Rotation = a signed handover document (future work); the
// fingerprint below is what humans compare out-of-band.
//
// Canonical form: deep-sorted JSON without the `signature` field —
// signature covers exactly what verify recomputes. Ed25519 only.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const MANIFEST_FORMAT = 'gitlive-app-manifest/1';
const DEFAULT_KEY_PATH = process.env.GITLIVE_MANIFEST_KEY || path.join(os.homedir(), '.gitlive', 'manifest-owner-key.pem');
const DEFAULT_MANIFEST_PATH = path.join('.gitlive', 'app.manifest');
const NPM_LOCKFILE = 'package-lock.json';

// F1 (Fabric program): the signed dependency closure. The manifest's
// signature covers SOURCE; this covers what will actually RUN — the
// resolved dependency graph as pinned by the lockfile (npm lockfiles carry
// per-package content hashes). Deploy-time enforcement (gitlive.js
// `_closure-gate`, generated hooks) verifies the checkout's lockfile
// against this digest and installs strictly (npm ci) when pinned.
function lockfileClosure(dir) {
  try {
    const abs = path.join(dir, NPM_LOCKFILE);
    if (!fs.existsSync(abs)) return null;
    const raw = fs.readFileSync(abs);
    const data = JSON.parse(raw.toString('utf8'));
    const entries = (data && typeof data === 'object' && data.packages)
      ? Object.keys(data.packages).length
      : null;
    return {
      kind: 'npm-lockfile',
      lockfile: NPM_LOCKFILE,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      entries,
    };
  } catch {
    return null; // unreadable lockfile → no closure pinned (legacy allowed)
  }
}

// ---------------------------------------------------------------------------
// canonicalization
// ---------------------------------------------------------------------------
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

function canonical(obj) {
  return JSON.stringify(sortDeep(obj));
}

function fingerprintFromPublicKey(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32).toUpperCase();
}

function formatFingerprint(fp) {
  return fp.match(/.{1,4}/g).join(':');
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------
function generateOwnerKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function cmdKeygen(flags) {
  const keyPath = flags.key || DEFAULT_KEY_PATH;
  if (fs.existsSync(keyPath)) {
    console.log(`Manifest key already exists at ${keyPath}`);
    console.log(`Owner fingerprint: ${formatFingerprint(fingerprintFromPublicKey(fs.readFileSync(keyPath, 'utf8')))}`);
    return;
  }
  const { publicKeyPem, privateKeyPem } = generateOwnerKeyPair();
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  const fp = fingerprintFromPublicKey(publicKeyPem);
  console.log(`Generated owner manifest key: ${keyPath} (mode 0600)`);
  console.log(`Owner fingerprint: ${formatFingerprint(fp)}`);
  console.log('Store the private key on your offline media (D4). The default path is a single-machine convenience.');
}

function loadPrivateKey(keyPath) {
  const pem = fs.readFileSync(keyPath, 'utf8');
  const priv = crypto.createPrivateKey(pem);
  const pubDer = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
  const publicKeyPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString();
  return { priv, publicKeyPem, fingerprint: fingerprintFromPublicKey(publicKeyPem) };
}

function signBytes(priv, data) {
  return crypto.sign(null, data, priv).toString('base64');
}

function verifyBytes(publicKeyPem, data, signatureB64) {
  try {
    return crypto.verify(null, data, publicKeyPem, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// manifest build / sign / verify
// ---------------------------------------------------------------------------
function gitHead(dir) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).trim();
    return { commit: head, tree };
  } catch {
    return null; // not a git repo (or no commit yet) — manifest records null and still signs
  }
}

function detectRunContract(dir) {
  // Lightweight, zero-dependency: mirror the CLI's spirit. Only fields the
  // user explicitly flags or that are safely inferable land here; the app
  // registry remains the runtime authority in Phase 1/2.
  const run = {};
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.start) run.start = 'npm start';
      if (pkg.name) run.pkg = String(pkg.name);
    } catch { /* unparsable package.json — leave run contract empty */ }
  } else if (fs.existsSync(path.join(dir, 'requirements.txt'))) {
    run.start = 'python app.py';
  }
  return Object.keys(run).length ? run : null;
}

function buildManifest({ dir = process.cwd(), name, version, keyPath, install, start, port, safe, health, minNodes = 1, jurisdictions = [], storage = 'host-may-read', snapshotSecs = 30, skipClosure = false } = {}) {
  const key = loadPrivateKey(keyPath);
  const repo = gitHead(dir);
  const run = { install: install || null, start: start || null, port: port || null, safe: safe || null, health: health || null };
  for (const k of Object.keys(run)) if (run[k] === null) delete run[k];
  const inferred = detectRunContract(dir);
  if (!run.start && inferred && inferred.start) run.start = inferred.start;
  const closure = skipClosure ? null : lockfileClosure(dir);
  if (closure) run.closure = closure;

  const body = {
    format: MANIFEST_FORMAT,
    name: name || (inferred && inferred.pkg) || path.basename(path.resolve(dir)),
    version: version || '0.1.0',
    generatedAt: new Date().toISOString(),
    repo, // { commit, tree } or null when the dir is not a git repo
    run: Object.keys(run).length ? run : null,
    policy: { minNodes, jurisdictions, storage, snapshotSecs },
    owner: { fingerprint: key.fingerprint, publicKey: key.publicKeyPem },
  };
  const signature = signBytes(key.priv, Buffer.from(canonical(body), 'utf8'));
  return { ...body, signature };
}

function manifestToFile(manifest, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
  return outPath;
}

function manifestFromFile(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function verifyManifest(manifest, { pinnedKeyPath } = {}) {
  const errors = [];
  if (manifest.format !== MANIFEST_FORMAT) errors.push(`unsupported manifest format "${manifest.format}"`);
  if (!manifest.signature || typeof manifest.signature !== 'string') errors.push('manifest is not signed');
  if (!manifest.owner || !manifest.owner.publicKey || !manifest.owner.fingerprint) errors.push('manifest has no owner key block');

  let result = { ok: errors.length === 0, errors, fingerprint: null, pinned: false };
  if (errors.length) return result;

  const data = Buffer.from(canonical({ ...manifest, signature: undefined }), 'utf8');
  const signatureValid = verifyBytes(manifest.owner.publicKey, data, manifest.signature);
  const fp = fingerprintFromPublicKey(manifest.owner.publicKey);
  const fpMatches = fp === String(manifest.owner.fingerprint).toUpperCase();

  if (!signatureValid) errors.push('signature does not verify against the embedded owner key');
  if (!fpMatches) errors.push(`embedded fingerprint mismatch (computed ${formatFingerprint(fp)})`);

  if (pinnedKeyPath && fs.existsSync(pinnedKeyPath)) {
    const pinned = loadPrivateKey(pinnedKeyPath);
    result.pinned = true;
    if (pinned.fingerprint !== fp) errors.push(`manifest owner (${formatFingerprint(fp)}) does not match the pinned key (${formatFingerprint(pinned.fingerprint)})`);
  }

  return { ok: errors.length === 0, errors, fingerprint: fp, pinned: result.pinned };
}

// ---------------------------------------------------------------------------
// deploy-time enforcement (D4): pre-receive hook + commit checker
// ---------------------------------------------------------------------------
function buildPreReceiveHook({ barePath, gitliveFile }) {
  return `#!/bin/bash
# gitlive owner-signature enforcement (Phase 2 D4): rejects any push whose
# tip commit carries a .gitlive/app.manifest the owner key did not sign, or
# whose signed content does not match the pushed commit. Commits WITHOUT a
# manifest pass — enforcement is opt-in by signing, and legacy apps keep
# working. Installed by "gitlive init" and "gitlive manifest hook-install".
GITLIVE_FILE=${JSON.stringify(gitliveFile)}
BARE=${JSON.stringify(barePath)}
while read OLD NEW REF; do
  case "$REF" in
    refs/heads/*)
      if [ "$NEW" != "0000000000000000000000000000000000000000" ]; then
        node "$GITLIVE_FILE" _check-manifest "$BARE" "$NEW" || {
          echo "gitlive: push rejected — manifest verification failed (see messages above)."
          echo "gitlive: after committing new code, run: gitlive manifest sign"
          exit 1
        }
      fi
      ;;
  esac
done
exit 0
`;
}

function installPreReceiveHook({ barePath, gitliveFile }) {
  const hookPath = path.join(barePath, 'hooks', 'pre-receive');
  fs.writeFileSync(hookPath, buildPreReceiveHook({ barePath, gitliveFile }));
  fs.chmodSync(hookPath, 0o755);
  return hookPath;
}

// Read + verify the manifest as git sees it at a pushed commit. Absent
// manifest = allowed (legacy); present manifest must verify AND name exactly
// the pushed commit (the signature is meaningless if it signed other code).
function checkCommitManifest(barePath, commit) {
  const errors = [];
  let raw = null;
  try {
    raw = execFileSync('git', ['show', `${commit}:.gitlive/app.manifest`], { cwd: barePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { raw = null; }
  if (raw === null) {
    return { ok: true, absent: true, errors, message: `no .gitlive/app.manifest at ${commit.slice(0, 12)} — unsigned push allowed (legacy). Lock it once so every later push must carry your owner signature: gitlive manifest sign && git push` };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { ok: false, absent: false, errors: ['manifest at the pushed commit is not valid JSON'], message: '' };
  }
  const result = verifyManifest(manifest, { pinnedKeyPath: fs.existsSync(DEFAULT_KEY_PATH) ? DEFAULT_KEY_PATH : undefined });
  if (!result.ok) errors.push(...result.errors);
  const signed = manifest.repo && manifest.repo.commit;
  if (signed) {
    // The manifest is committed on top of the signed commit (sign → commit
    // the manifest → push), so the pushed tip legitimately differs from
    // repo.commit by at most the manifest itself. Enforce that exactly:
    // repo.commit must be an ancestor, and nothing OUTSIDE .gitlive/ may
    // have changed between the signed commit and the pushed tip.
    const ancestorCheck = spawnSyncGit(['merge-base', '--is-ancestor', manifest.repo.commit, commit], barePath);
    if (!ancestorCheck.ok) {
      errors.push(`signed content commit ${manifest.repo.commit.slice(0, 12)} is not an ancestor of pushed commit ${commit.slice(0, 12)}`);
    } else {
      const diffCheck = spawnSyncGit(['diff', '--quiet', manifest.repo.commit, commit, '--', '.', ':(exclude).gitlive'], barePath);
      if (!diffCheck.ok) {
        errors.push(`code changed since the signed commit ${manifest.repo.commit.slice(0, 12)} — re-run "gitlive manifest sign" after committing, then commit the manifest`);
      }
    }
  } else {
    errors.push('manifest records no git content — sign it inside the repo (gitlive manifest sign)');
  }
  return { ok: errors.length === 0, absent: false, errors, message: `manifest OK at ${commit.slice(0, 12)}` };

  function spawnSyncGit(args, cwd) {
    const r = execFileSync ? { status: 0 } : { status: 0 };
    try {
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
      return { ok: true };
    } catch (err) {
      // exit 1 = the check failed (not an ancestor / diff exists); other
      // failures (exit >1) surface as errors too — both mean "not allowed".
      return { ok: false, code: err.status };
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function cmdManifest(rest, flags) {
  const sub = rest[0];
  switch (sub) {
    case 'keygen':
      cmdKeygen(flags);
      return;
    case 'sign': {
      const dir = flags.dir || process.cwd();
      const out = flags.out || path.join(dir, DEFAULT_MANIFEST_PATH);
      const keyPath = flags.key || DEFAULT_KEY_PATH;
      if (!fs.existsSync(keyPath)) {
        console.error(`No owner manifest key at ${keyPath}. Generate one first: gitlive manifest keygen${flags.key ? '' : '  (default path — or pass --key <path>)'}`);
        process.exitCode = 1;
        return;
      }
      const manifest = buildManifest({ dir, keyPath, name: flags.name, install: flags.install, start: flags.start, port: flags.port ? Number(flags.port) : null, safe: flags.safe, health: flags.health, minNodes: Number(flags['min-nodes']) || 1, skipClosure: Boolean(flags['no-closure']) });
      manifestToFile(manifest, out);
      console.log(`Signed manifest for "${manifest.name}" → ${out}`);
      console.log(`Owner fingerprint: ${formatFingerprint(manifest.owner.fingerprint)}`);
      console.log(`Policy: ${manifest.policy.minNodes} node${manifest.policy.minNodes === 1 ? '' : 's'}, storage ${manifest.policy.storage}, snapshot every ${manifest.policy.snapshotSecs}s`);
      const cl = manifest.run && manifest.run.closure;
      if (cl) {
        console.log(`Dependency closure PINNED: ${cl.entries === null ? '?' : cl.entries} lockfile entr${cl.entries === 1 ? 'y' : 'ies'} via ${cl.lockfile} (sha256 ${cl.sha256.slice(0, 16)}…) — deploys install strictly from it`);
      } else if (flags['no-closure']) {
        console.log(`--no-closure: dependency closure intentionally NOT pinned (deploys fall back to legacy install)`);
      } else {
        console.log(`No ${NPM_LOCKFILE} found — dependency closure NOT pinned (legacy install allowed; add a lockfile and re-sign to pin)`);
      }
      return;
    }
    case 'verify': {
      const manifestPath = flags.manifest || (flags.dir ? path.join(flags.dir, DEFAULT_MANIFEST_PATH) : DEFAULT_MANIFEST_PATH);
      let manifest;
      try {
        manifest = manifestFromFile(manifestPath);
      } catch (err) {
        console.error(`verify failed: cannot read ${manifestPath}: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      const result = verifyManifest(manifest, { pinnedKeyPath: flags.key });
      if (result.ok) {
        console.log(`OK: manifest "${manifest.name}" v${manifest.version || '?'} — signature valid`);
        console.log(`Owner fingerprint: ${formatFingerprint(result.fingerprint)}`);
        const repo = manifest.repo;
        if (repo && repo.commit) console.log(`Signed content: commit ${repo.commit.slice(0, 12)} (tree ${repo.tree.slice(0, 12)})`);
        else console.log('Signed content: no git repo recorded (unsigned-content manifest)');
        console.log(`Policy: ${manifest.policy.minNodes} node${manifest.policy.minNodes === 1 ? '' : 's'}, storage ${manifest.policy.storage}, snapshot every ${manifest.policy.snapshotSecs}s`);
      } else {
        console.error(`VERIFY FAILED:`);
        for (const e of result.errors) console.error(`  - ${e}`);
        process.exitCode = 1;
      }
      return;
    }
    case 'hook-install': {
      // Install the pre-receive enforcement hook onto an app's bare repo
      // (apps created by init already have it; this adds it to older ones).
      const name = rest[1] || flags.app;
      if (!name) {
        console.error('usage: gitlive manifest hook-install <app-name>');
        process.exitCode = 1;
        return;
      }
      const gitliveMod = require('./gitlive.js');
      const reg = gitliveMod.loadRegistry();
      const app = reg[name];
      if (!app || !app.barePath) {
        console.error(`No registered app named "${name}".`);
        process.exitCode = 1;
        return;
      }
      const hookPath = installPreReceiveHook({ barePath: app.barePath, gitliveFile: path.join(__dirname, 'gitlive.js') });
      console.log(`Installed manifest verification hook for "${name}" → ${hookPath}`);
      return;
    }
    case 'show': {
      const manifestPath = flags.manifest || (flags.dir ? path.join(flags.dir, DEFAULT_MANIFEST_PATH) : DEFAULT_MANIFEST_PATH);
      try {
        const m = manifestFromFile(manifestPath);
        console.log(JSON.stringify(m, null, 2));
      } catch (err) {
        console.error(`show failed: ${err.message}`);
        process.exitCode = 1;
      }
      return;
    }
    default:
      console.log(`Usage: gitlive manifest <keygen|sign|verify|show>
  keygen                generate the owner Ed25519 manifest key
  hook-install <app>     install the pre-receive enforcement hook onto an existing app
                         (gitlive init installs it automatically for new apps)
                         flags: --key <path> (default ~/.gitlive/manifest-owner-key.pem)
  sign                  sign this project's manifest (.gitlive/app.manifest)
                         flags: --dir <path> --name <n> --install "<cmd>" --start "<cmd>"
                                --port <n> --safe --health <path> --min-nodes <n>
                                --key <path> --out <path> --no-closure
                                (--no-closure: skip pinning the npm-lockfile
                                dependency closure — deploys fall back to
                                legacy install; prefer keeping a lockfile)
  verify                verify a signed manifest
                         flags: --manifest <path> or --dir <path>; --key <path> to pin the owner key
  show                  print the manifest as-is (debugging)
                         flags: --manifest <path> or --dir <path>`);
      process.exitCode = 1;
  }
}

module.exports = {
  MANIFEST_FORMAT,
  DEFAULT_KEY_PATH,
  canonical,
  sortDeep,
  fingerprintFromPublicKey,
  formatFingerprint,
  generateOwnerKeyPair,
  loadPrivateKey,
  signBytes,
  verifyBytes,
  gitHead,
  buildManifest,
  verifyManifest,
  manifestToFile,
  manifestFromFile,
  buildPreReceiveHook,
  installPreReceiveHook,
  checkCommitManifest,
  cmdManifest,
};
