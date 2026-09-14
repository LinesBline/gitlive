'use strict';
// agents.test.js — the plane's helpers must be safe by construction: they
// restart (nothing else), they cool down, they cap their actions, they record
// every move, they recommend without acting, and they can be switched off.
// Proven against fakes — no real app, no real restart path.
const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glagents-'));
const controlDir = path.join(home, '.gitlive', 'control');
fs.mkdirSync(controlDir, { recursive: true });

process.env.HOME = home;
process.env.GITLIVE_CONTROL_DIR = controlDir;
process.env.GITLIVE_AGENT_COOLDOWN_MS = '60000';
process.env.GITLIVE_AGENT_MAX_ACTIONS = '1';
// a repair now WAITS for the app to answer before it claims success; the test
// must not wait 8 seconds for that
process.env.GITLIVE_AGENT_VERIFY_MS = '1200';
process.env.GITLIVE_AGENT_SETTLE_MS = '300';

const agents = require('../control/agents.js');

(async () => {
  // ── 1) repair: one restart for a down app, capped, cooled down ────────────
  const restarted = [];
  const alive = new Set(['up-c']); // a restart actually brings the app back here
  const caps = {
    listApps: () => ([
      { name: 'down-a', alive: alive.has('down-a'), connect: false },
      { name: 'down-b', alive: alive.has('down-b'), connect: false },
      { name: 'up-c', alive: true, connect: false },
      { name: 'remote-d', alive: null, connect: true },
    ]),
    restart: (n) => { restarted.push(n); alive.add(n); return { ok: true }; },
    diagnose: async (n) => ({ rows: [{ status: 'fail', title: 'The public proxy is down' }] }),
    deployHistory: () => [],
    backups: () => ({ apps: [{ name: 'down-a', snapshots: 1, latest: { at: new Date().toISOString() }, verified: true }] }),
    diskFreeMb: () => 50000,
  };
  const pass1 = await agents.repairPass(caps);
  assert(pass1.length === 1, 'the cap of 1 action per pass is respected (got ' + pass1.length + ')');
  assert(restarted.length === 1 && restarted[0] === 'down-a', 'it restarted the first down app only: ' + JSON.stringify(restarted));
  assert(pass1[0].agent === 'repair' && pass1[0].ok === true && pass1[0].key, 'the action carries agent, outcome and cooldown key');
  assert(pass1[0].verified === true, 'a repair is only called done once the app actually answers');
  const pass2 = await agents.repairPass(caps);
  assert(restarted.length === 2 && restarted[1] === 'down-b', 'the next pass helps the NEXT down app, not the cooling one: ' + JSON.stringify(restarted));
  assert(!restarted.slice(1).includes('down-a'), 'the cooldown stops it hammering the same app again');
  const pass3 = await agents.repairPass(caps);
  assert(pass3.length === 0, 'once every down app has had its turn inside the cooldown, the pass does nothing');
  console.log('OK: repair — capped, cooled down, receipted, verified alive');

  // ── 2) the ledger is the audit trail, on disk ────────────────────────────
  const ledger = fs.readFileSync(agents.LEDGER, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(ledger.length === 2 && ledger[0].app === 'down-a' && ledger[0].action === 'restart', 'agent-actions.jsonl holds every receipt');
  console.log('OK: every action is written to the ledger');

  // ── 2b) a restart that does NOT bring the app back is a failure, not a
  //        repair — the receipt says so and carries the app's own last error
  const stubbornHome = path.join(home, '.gitlive');
  const stuckRun = path.join(stubbornHome, 'apps', 'stubborn-run');
  fs.mkdirSync(stuckRun, { recursive: true });
  fs.writeFileSync(path.join(stuckRun, 'deploy.log'),
    "spawn /opt/missing/bin/python ENOENT\n    at onErrorNT (node:internal/child_process:524:16)\n");
  const regFile = path.join(stubbornHome, 'apps.json');
  const reg0 = fs.existsSync(regFile) ? JSON.parse(fs.readFileSync(regFile, 'utf8')) : {};
  reg0.stubborn = { cwd: '/tmp/nowhere', barePath: path.join(stubbornHome, 'apps', 'stubborn.git'), runPath: stuckRun, installCmd: '', startCmd: 'node server.js', port: '3999' };
  fs.writeFileSync(regFile, JSON.stringify(reg0, null, 2));
  const stuckCaps = {
    ...caps,
    listApps: () => ([{ name: 'stubborn', alive: false, connect: false }]),
    restart: () => ({ ok: true }), // the spawn "succeeds" — the process dies at once
  };
  const stuck = await agents.repairPass(stuckCaps);
  assert(stuck.length === 1 && stuck[0].ok === false, 'a restart that leaves the app down is recorded as a failure: ' + JSON.stringify(stuck));
  assert(stuck[0].settledMs >= 300, 'the verification waits past the spawn before it believes a pidfile');
  assert(/still down/.test(stuck[0].reason || ''), 'the reason says the app never came back: ' + stuck[0].reason);
  assert(/ENOENT/.test(stuck[0].detail || ''), "the receipt carries the app's own last error line: " + JSON.stringify(stuck[0].detail));
  assert(stuck[0].verified === false, 'verified=false marks it unproven');
  console.log('OK: repair never claims a repair it could not verify — the log line rides the receipt');

  // ── 3) diagnose: the chain runs for a down app and is recorded ───────────
  process.env.GITLIVE_AGENT_COOLDOWN_MS = '0';
  alive.delete('down-a'); alive.delete('down-b'); // they go down again later: that is the point of diagnose
  const diag = await agents.diagnosePass(caps);
  assert(diag.length >= 1 && diag[0].agent === 'diagnose', 'diagnose pass ran for down apps');
  assert(/proxy is down/.test(diag[0].reason || ''), 'the recorded reason is the worst hop: ' + diag[0].reason);
  console.log('OK: diagnose — the reason is on record, not just in a toast');

  // ── 4) improve: recommendations, never actions ───────────────────────────
  const flapping = {
    ...caps,
    listApps: () => ([{ name: 'flappy', alive: true, connect: false }]),
    restart: () => { throw new Error('improve must never restart anything'); },
    deployHistory: () => ([{ outcome: 'failed' }, { outcome: 'failed' }, { outcome: 'failed' }]),
    backups: () => ({ apps: [] }),
    diskFreeMb: () => 1024,
  };
  // three repair receipts for one app in the window → flapping must be recommended
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(agents.LEDGER, JSON.stringify({ at: new Date().toISOString(), agent: 'repair', action: 'restart', app: 'flappy', key: 'k' + i, ok: true }) + '\n');
  }
  const recs = agents.improvePass(flapping);
  const kinds = (recs.recommendations || []).map((r) => r.kind);
  assert(kinds.includes('flapping'), 'a crash loop is recommended, not silently restarted forever: ' + JSON.stringify(kinds));
  assert(kinds.includes('deploy-failing'), 'a failing deploy streak is recommended: ' + JSON.stringify(kinds));
  assert(kinds.includes('no-backups'), 'no backups at all is recommended: ' + JSON.stringify(kinds));
  assert(kinds.includes('disk-low'), 'low disk is recommended: ' + JSON.stringify(kinds));
  // the failed repair from 2b is still in the ledger window: the machine must
  // say out loud that restarting will not fix that app, quoting its log line
  assert(kinds.includes('cannot-start'), 'an app that a restart could not fix is recommended, not quietly retried: ' + JSON.stringify(kinds));
  const stuckRec = (recs.recommendations || []).find((r) => r.kind === 'cannot-start');
  assert(/ENOENT/.test(stuckRec.text), "the recommendation quotes the app's own error: " + stuckRec.text);
  assert(fs.existsSync(agents.RECS), 'recommendations are written for the dashboard to show');
  console.log('OK: improve — recommends (flapping, deploy streak, no backups, low disk), changes nothing');

  // ── 4b) a deliberately stopped app is never "repaired" ──────────────────
  const stoppedRestarts = [];
  const stoppedCaps = {
    ...caps,
    listApps: () => ([{ name: 'parked', alive: false, connect: false, stoppedByOwner: true }]),
    restart: (n) => { stoppedRestarts.push(n); return { ok: true }; },
  };
  process.env.GITLIVE_AGENT_COOLDOWN_MS = '0';
  const held = await agents.repairPass(stoppedCaps);
  assert(stoppedRestarts.length === 0, 'the agent must not restart an app the owner stopped: ' + JSON.stringify(stoppedRestarts));
  assert(held.length === 1 && held[0].action === 'held', 'it records a HOLD instead: ' + JSON.stringify(held));
  assert(/stopped by hand/.test(held[0].reason || ''), 'and says why: ' + held[0].reason);
  const heldDiag = await agents.diagnosePass(stoppedCaps);
  assert(heldDiag.length === 0, 'a deliberate stop is not an incident to diagnose either');
  console.log('OK: owner intent — a stopped app is held, never restarted, never diagnosed as an incident');

  // ── 5) off means off ────────────────────────────────────────────────────
  process.env.GITLIVE_AGENTS = '0';
  const offRepair = await agents.repairPass(caps);
  const offDiag = await agents.diagnosePass(caps);
  assert(offRepair.length === 0 && offDiag.length === 0, 'GITLIVE_AGENTS=0 stops every agent');
  assert(agents.status().enabled === false, 'status reports them switched off');
  process.env.GITLIVE_AGENTS = '1';
  console.log('OK: GITLIVE_AGENTS=0 — the helpers can be switched off entirely');

  console.log('\nALL AGENT TESTS PASSED');
})().catch((err) => {
  console.error('AGENT TEST FAILED: ' + (err && err.message));
  process.exit(1);
});
