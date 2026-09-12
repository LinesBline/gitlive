'use strict';
// Structural guard for the recurring dispatch bug (violated 4x: manifest,
// mesh, peer, crypt): subcommand handlers must receive the FULL argv after
// the command word — rest[0] IS the subcommand. This test fails any new
// `cmdX(rest.slice(1), …)` wiring in gitlive.js on sight.

const path = require('path');
const fs = require('fs');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const src = fs.readFileSync(path.join(__dirname, '..', 'gitlive.js'), 'utf8');
// Known-good exceptions: cases that handle the subcommand INLINE in
// gitlive.js (checking rest[0] themselves) and pass only the trailing args
// to a names-only handler. Everything else must receive the full argv.
const KNOWN_GOOD = [
  "if (rest[0] === 'start') await backend.cmdBackendStart(rest.slice(1));",
  "if (rest[0] === 'connect') await agent.cmdAgentConnect(rest.slice(1), parseFlags(rest.slice(1)).flags);",
];
const offenders = [];
for (const line of src.split('\n')) {
  if (KNOWN_GOOD.includes(line.trim())) continue;
  if (/\.(cmd[A-Za-z]+)\(rest\.slice\(1\)/.test(line)) offenders.push(line.trim());
}
assert(offenders.length === 0, 'dispatch must never slice argv — pass rest whole so rest[0] is the subcommand:\n' + offenders.join('\n'));
console.log('OK: every cmd* dispatch passes the full argv (rest[0] = subcommand)');

// --help / -h anywhere after the command must print help and exit — never
// act (field finding: `gitlive init --help` used to START an init, and
// `gitlive audit --help` treated --help as a folder name).
assert(src.includes("rest.includes('--help')"), 'main() must short-circuit on --help before dispatch');
const { spawnSync } = require('child_process');
const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
for (const args of [['init', '--help'], ['init', '-h'], ['audit', '--help'], ['backup', '--help']]) {
  const tmp = fs.mkdtempSync(path.join('/tmp', 'glhelp-'));
  const r = spawnSync('node', [GITLIVE_JS, ...args], { cwd: tmp, encoding: 'utf8', timeout: 30000 });
  assert(r.status === 0, `"gitlive ${args.join(' ')}" must exit 0 (got ${r.status})\n${(r.stdout || r.stderr).slice(0, 200)}`);
  assert(/usage|Usage|gitlive init|gitlive audit|gitlive backup/i.test(r.stdout || ''), `"gitlive ${args.join(' ')}" must print help`);
  assert(!fs.existsSync(path.join(tmp, '.git')), `"gitlive ${args.join(' ')}" must not create a repo`);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('OK: --help/-h on any subcommand prints help, exits 0, touches nothing');

// per-command help: "restart --help" shows the RESTART block, not the whole
// page (field finding: every --help dumped the entire top-level usage).
{
  const rh = spawnSync('node', [GITLIVE_JS, 'restart', '--help'], { encoding: 'utf8' });
  assert(rh.status === 0 && /gitlive restart <name>/.test(rh.stdout) && !/gitlive init \[name\]/.test(rh.stdout), 'restart --help prints only the restart block:\n' + rh.stdout.slice(0, 200));
}
console.log('OK: <cmd> --help prints that command\'s section, not the whole page');

// Hook templates must QUOTE the install/build commands they assign
// (field finding: INSTALL_CMD=npm ci && npm run build ran /usr/bin/install).
assert(src.includes("INSTALL_CMD='${shQuoteSingle(installCmd)}'"), 'plain + safe hooks must single-quote the INSTALL_CMD assignment');
assert(src.includes("BUILD_CMD='${shQuoteSingle(buildCmd)}'"), 'plain + safe hooks must single-quote the BUILD_CMD assignment');
console.log('OK: hook templates quote INSTALL_CMD and BUILD_CMD assignments');

console.log('\nALL DISPATCH GUARD TESTS PASSED');
