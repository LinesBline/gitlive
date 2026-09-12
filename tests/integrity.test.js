'use strict';
// Item 7 — doctor --integrity: file-hash verification. Real check on the
// real repo + hermetic tamper test on a synthetic root
// (GITLIVE_INTEGRITY_ROOT): manifest written, verify ok, tampered file
// detected with exit 1.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');

// 1 — real repo: manifest exists and verifies (written during dev)
const realOut = execFileSync('node', [GITLIVE_JS, 'doctor', '--integrity'], { encoding: 'utf8' });
assert(/integrity OK/.test(realOut), 'real repo integrity:\n' + realOut);
console.log('OK: real repo integrity manifest verifies');

// 1b — whitelist coverage: every runtime module the shipped code requires
// must be in package.json's files whitelist. A module can't load from a
// tarball that lacks it (the daemon.js miss during item 10 would have
// shipped a broken installed CLI).
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const repoJs = [];
for (const dir of ['', 'control/']) {
  for (const f of fs.readdirSync(path.join(__dirname, '..', dir))) {
    if (f.endsWith('.js')) repoJs.push(dir + f);
  }
}
const unlisted = [];
for (const f of repoJs) {
  const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const m of src.matchAll(/require\(['"](\.\.?\/[^'"]+)['"]\)/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
    if (target.startsWith('..')) continue; // escapes the package tree
    if (!fs.existsSync(path.join(__dirname, '..', target))) continue; // not a file require
    const listed = (pkg.files || []).some((w) => w === target || target.startsWith(w.endsWith('/') ? w : w + '/'));
    if (!listed) unlisted.push(f + ' → ' + target);
  }
}
assert(unlisted.length === 0, 'runtime modules missing from the package whitelist: ' + unlisted.join(', '));
console.log('OK: every runtime module the shipped code requires sits in the package whitelist');

// 2 — hermetic synthetic root: write → verify → tamper → mismatch
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-'));
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'intprobe', version: '9.9.9', files: ['gitlive.js', 'readme.txt', 'INTEGRITY.json'] }));
fs.writeFileSync(path.join(root, 'gitlive.js'), '#!/usr/bin/env node\nconsole.log("probe")\n');
fs.writeFileSync(path.join(root, 'readme.txt'), 'pristine content\n');
const env = { ...process.env, GITLIVE_INTEGRITY_ROOT: root };

const writeOut = execFileSync('node', [GITLIVE_JS, 'doctor', '--integrity', '--write'], { env, encoding: 'utf8' });
assert(/integrity manifest written: 2 file/.test(writeOut), 'write output:\n' + writeOut);
const okOut = execFileSync('node', [GITLIVE_JS, 'doctor', '--integrity'], { env, encoding: 'utf8' });
assert(/integrity OK — 2 file/.test(okOut), 'verify output:\n' + okOut);

fs.appendFileSync(path.join(root, 'readme.txt'), 'TAMPERED');
let mismatch = null;
try {
  execFileSync('node', [GITLIVE_JS, 'doctor', '--integrity'], { env, encoding: 'utf8' });
} catch (err) {
  mismatch = String(err.stdout || '') + String(err.stderr || '');
}
assert(mismatch && /INTEGRITY MISMATCH/.test(mismatch) && /CHANGED: readme\.txt/.test(mismatch), 'tamper detected:\n' + (mismatch || '(no error!)'));
console.log('OK: synthetic root — write/verify round-trip; tampered file detected (exit 1)');

// 3 — missing manifest → actionable error
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-empty-'));
let noManifest = null;
try {
  execFileSync('node', [GITLIVE_JS, 'doctor', '--integrity'], { env: { ...process.env, GITLIVE_INTEGRITY_ROOT: emptyRoot }, encoding: 'utf8' });
} catch (err) {
  noManifest = String(err.stdout || '') + String(err.stderr || '');
}
assert(noManifest && /no INTEGRITY.json/.test(noManifest), 'missing manifest guidance:\n' + (noManifest || '(no error!)'));
console.log('OK: missing manifest produces actionable guidance');

console.log('\nALL INTEGRITY TESTS PASSED');
