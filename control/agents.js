// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// agents.js — the plane's own helpers: repair, diagnose, self-improve.
//
// WHAT THESE ARE, HONESTLY: deterministic workers, not language models. gitlive
// runs on Node built-ins with no runtime dependencies and no network keys, so
// an "agent" here is a bounded loop over facts the machine already has — the
// same diagnose chain and the same restart path the CLI proves, run on a
// cadence, with every action receipted. They can be switched off entirely
// (GITLIVE_AGENTS=0) and they never do anything destructive: no deletes, no key
// operations, no binding changes, no DNS writes without a zone token already
// present.
//
// WHO DECIDES WHAT THEY MAY DO: the owner, per app, in control/intel.js's
// policy file (`off` = hands off, `watch` = diagnose + recommend only,
// `repair` = restart). A maintenance window suspends repairs. After a repair
// that could not be verified the wait doubles (5m → 15m → 1h → 6h) instead of
// retrying on the cooldown forever, and the schedule is printed on the receipt.
//
// The three:
//   1. REPAIR     — an app that is down and has a run dir gets the same restart
//                   the card's button would do. Policy + cooldown per app, a
//                   hard cap of actions per pass, receipts in agent-actions.jsonl.
//   2. DIAGNOSE   — when an app flips up→down, run the full hop chain and store
//                   the result next to the app, so the reason is recorded even
//                   if nobody was looking at the dashboard.
//   3. IMPROVE    — hourly, read the machine's own history (restart counts,
//                   deploy failures, backup age, disk) and write
//                   RECOMMENDATIONS. It changes nothing: judgement stays with
//                   the owner, which is the only defensible place for it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const intel = require('./intel.js');
const redact = require('./redact.js');

const CONTROL_DIR = process.env.GITLIVE_CONTROL_DIR || path.join(os.homedir(), '.gitlive', 'control');
const LEDGER = path.join(CONTROL_DIR, 'agent-actions.jsonl');
const RECS = path.join(CONTROL_DIR, 'agent-recommendations.json');

const INTERVAL_MS = Number(process.env.GITLIVE_AGENT_INTERVAL_MS || 5 * 60 * 1000);
const MAX_ACTIONS_PER_PASS = Number(process.env.GITLIVE_AGENT_MAX_ACTIONS || 3);
const COOLDOWN_MS = Number(process.env.GITLIVE_AGENT_COOLDOWN_MS || 30 * 60 * 1000);
const IMPROVE_EVERY_MS = Number(process.env.GITLIVE_AGENT_IMPROVE_MS || 60 * 60 * 1000);
const LEDGER_MAX_BYTES = 2 * 1024 * 1024;

function enabled() { return String(process.env.GITLIVE_AGENTS || '1') !== '0'; }

function readLedger(limit = 200) {
  try {
    const rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.slice(-limit);
  } catch { return []; }
}

function record(entry) {
  // the ledger outlives the moment: an app's failure line can quote its own
  // environment (a command with a token in it, a connection string), so
  // credentials are stripped BEFORE the receipt is written — not on display
  const row = { at: new Date().toISOString() };
  for (const [k, v] of Object.entries(entry || {})) row[k] = typeof v === 'string' ? redact.redactSecrets(v) : v;
  try {
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    if (fs.existsSync(LEDGER) && fs.statSync(LEDGER).size > LEDGER_MAX_BYTES) {
      const rows = readLedger(400);
      fs.writeFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n');
  } catch { /* the ledger must never break a repair */ }
  try { require('../crypt.js').logEvent('agent-' + (entry.agent || 'action'), { action: entry.action, app: entry.app || null, ok: entry.ok !== false, reason: entry.reason || null }); } catch { /* audit best-effort */ }
  return row;
}

function lastActionFor(predicate) {
  const rows = readLedger(400).reverse();
  for (const r of rows) if (predicate(r)) return r;
  return null;
}

function coolingDown(key) {
  const last = lastActionFor((r) => r.key === key);
  if (!last) return false;
  return Date.now() - new Date(last.at).getTime() < COOLDOWN_MS;
}

// ── 1 · repair ─────────────────────────────────────────────────────────────
// Only one kind of action exists on purpose: the restart the owner's own button
// performs. Anything else a repair could do (delete, rollback, redeploy) changes
// what the machine IS, and that decision stays with a human.
// A restart that returns without a live process is NOT a repair. The button
// (and so this agent) used to report "done ✓" the moment the spawn call came
// back — a live app whose start command died instantly (missing interpreter,
// crash on boot) was reported as repaired while staying down. Now the pass
// waits for the app to actually answer, and when it does not, the receipt says
// so and carries the last line of the app's own log.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// async on purpose: waiting must not block the plane's event loop (a busy
// wait here would freeze the dashboard for the length of the verification)
async function waitAlive(caps, name, timeoutMs) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const row = (caps.listApps() || []).find((a) => a.name === name);
      if (row && row.alive === true) return { ok: true, afterMs: Date.now() - started };
    } catch { /* keep waiting */ }
    await sleep(400);
  }
  return { ok: false, afterMs: Date.now() - started };
}

function lastLogLine(name) {
  try {
    const reg = require('../gitlive.js').loadRegistry();
    const runPath = (reg[name] || {}).runPath;
    if (!runPath) return null;
    const f = require('path').join(runPath, 'deploy.log');
    if (!require('fs').existsSync(f)) return null;
    const lines = require('fs').readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    // stack frames are noise ("at onErrorNT (...)" matches /error/i and would
    // win the search) — drop them, then take the last real error line
    const meaningful = lines.filter((l) => !/^\s*at\s/.test(l));
    // an error OBJECT dump trails the real message: "code: 'ENOENT'," is a
    // property line, "Error: spawn … ENOENT" is the sentence a human needs
    const isProperty = (l) => /^\s*(code|errno|syscall|path|spawnargs|cmd|stack|\w+_?code)\s*:/.test(l);
    const score = (l) => (/^\s*(Error|TypeError|RangeError|ReferenceError|SyntaxError)\b/.test(l) ? 3
      : (!isProperty(l) && /\b(ENOENT|EACCES|refused|cannot find|not found|failed|exception|missing|denied)\b/i.test(l) ? 2
        : (!isProperty(l) && /error/i.test(l) ? 1 : 0)));
    const best = [...meaningful].reverse().find((l) => score(l) >= 3)
      || [...meaningful].reverse().find((l) => score(l) >= 2)
      || [...meaningful].reverse().find((l) => score(l) >= 1)
      || meaningful[meaningful.length - 1] || lines[lines.length - 1];
    const pick = best;
    return redact.redactSecrets(String(pick || '').trim().slice(0, 220));
  } catch { return null; }
}

function repairsInLastHour(name, now = Date.now()) {
  return readLedger(400).filter((r) => r.agent === 'repair' && r.app === name && new Date(r.at || 0).getTime() >= now - 3600 * 1000).length;
}

async function repairPass(caps) {
  const actions = [];
  if (!enabled()) return actions;
  let apps = [];
  try { apps = caps.listApps() || []; } catch { return actions; }
  const policies = intel.loadPolicies();
  const now = Date.now();
  for (const app of apps) {
    if (actions.length >= MAX_ACTIONS_PER_PASS) break;
    if (app.connect || app.alive !== false) continue;
    const policy = intel.policyFor(app.name, policies);
    const key = 'repair:restart:' + app.name;
    // a stopped app and a crashed app look the same on disk; the intent file
    // is what tells them apart, and a deliberate stop is never "repaired"
    if (app.stoppedByOwner) {
      actions.push(record({ agent: 'repair', action: 'held', app: app.name, key, ok: true, reason: 'stopped by hand — the agents leave it exactly as the owner left it' }));
      continue;
    }
    if (policy.mode === 'off') continue;         // the owner said hands off
    if (policy.mode === 'watch') continue;       // diagnose + recommend only
    const window = intel.inMaintenance(policy, new Date(now));
    if (window) {
      actions.push(record({ agent: 'repair', action: 'held', app: app.name, key, ok: true, reason: `inside a maintenance window (${window.from}–${window.to}) — hands off on purpose` }));
      continue;
    }
    const hourly = repairsInLastHour(app.name, now);
    if (hourly >= policy.maxActionsPerHour) {
      actions.push(record({ agent: 'repair', action: 'held', app: app.name, key, ok: true, reason: `already at the policy limit of ${policy.maxActionsPerHour} repair(s) per hour` }));
      continue;
    }
    // an app that has been up for six hours since its last failed repair is
    // new evidence: the backoff it earned is stale, so it is cleared
    const st0 = intel.loadAgentState();
    const row0 = (st0.apps || {})[app.name];
    if (app.alive === true && row0 && row0.lastFailAt && (now - new Date(row0.lastFailAt).getTime()) > 6 * 3600 * 1000) {
      intel.clearBackoff(app.name, { state: st0 });
    }
    // adaptive backoff: a repair that failed last time will very likely fail
    // again, so waiting is the honest move — and the reason is on the receipt
    const backoff = intel.backoffFor(app.name, intel.loadAgentState(), now);
    if (backoff.blocked) {
      actions.push(record({ agent: 'repair', action: 'held', app: app.name, key, ok: true, reason: `backing off after ${backoff.failures} failed repair(s) — next attempt after ${new Date(backoff.nextAllowedAt).toISOString()}`, nextAllowedAt: backoff.nextAllowedAt, consecutiveFailures: backoff.failures }));
      continue;
    }
    if (coolingDown(key)) continue;
    try {
      const out = caps.restart(app.name);
      const accepted = !out || out.ok !== false;
      if (!accepted) {
        actions.push(record({ agent: 'repair', action: 'restart', app: app.name, key, ok: false, reason: (out && out.reason) || 'restart refused' }));
        continue;
      }
      // SETTLE first: a pid file appears the instant the process is spawned, so
      // an immediate check can catch an app that is about to die (the deploy
      // hook itself uses "exited within 6s" as its failure test). Being alive
      // a few seconds later is the honest bar for calling a repair done.
      const settleMs = Number(process.env.GITLIVE_AGENT_SETTLE_MS || 3000);
      const verifyMs = Number(process.env.GITLIVE_AGENT_VERIFY_MS || 8000);
      await sleep(settleMs);
      const live = await waitAlive(caps, app.name, verifyMs);
      // the backoff state learns from this outcome: success clears it, failure
      // doubles the next wait (5m → 15m → 1h → 6h, then it stays put)
      const state = intel.noteRepairResult(app.name, live.ok, { state: intel.loadAgentState() });
      actions.push(record({
        agent: 'repair', action: 'restart', app: app.name, key,
        ok: live.ok,
        reason: live.ok
          ? 'app was down — restarted and answering'
          : `restarted, but the app is still down — backing off ${intel.fmtDur(state.lastWaitMs)} before the next attempt`,
        // the app's own words, so the owner does not have to go digging
        detail: live.ok ? null : lastLogLine(app.name),
        verified: live.ok,
        settledMs: settleMs + (live.afterMs || 0),
        consecutiveFailures: state.consecutiveFailures || 0,
        nextAllowedAt: state.nextAllowedAt ? new Date(state.nextAllowedAt).toISOString() : null,
      }));
    } catch (err) {
      actions.push(record({ agent: 'repair', action: 'restart', app: app.name, key, ok: false, reason: String(err.message || err).slice(0, 200) }));
    }
  }
  return actions;
}

// ── 2 · diagnose ───────────────────────────────────────────────────────────
// The hop chain, run for the record when an app goes down while nobody is
// watching. Stored per app (diagnose-history.jsonl) AND as an audit event.
async function diagnosePass(caps) {
  const actions = [];
  if (!enabled()) return actions;
  let apps = [];
  try { apps = caps.listApps() || []; } catch { return actions; }
  const policies = intel.loadPolicies();
  for (const app of apps) {
    if (app.connect || app.alive !== false) continue;
    if (app.stoppedByOwner) continue;                                  // deliberate: not an incident
    if (intel.policyFor(app.name, policies).mode === 'off') continue; // nothing is even recorded
    const key = 'diagnose:' + app.name;
    if (coolingDown(key)) continue;
    if (actions.length >= MAX_ACTIONS_PER_PASS) break;
    try {
      const d = await caps.diagnose(app.name, { record: true });
      const worst = (d.rows || []).find((r) => r.status === 'fail') || (d.rows || []).find((r) => r.status === 'warn') || null;
      actions.push(record({ agent: 'diagnose', action: 'chain', app: app.name, key, ok: true, reason: worst ? worst.title : 'all hops clean' }));
    } catch (err) {
      actions.push(record({ agent: 'diagnose', action: 'chain', app: app.name, key, ok: false, reason: String(err.message || err).slice(0, 200) }));
    }
  }
  return actions;
}

// ── explainable transitions ────────────────────────────────────────────────
// A deploy or an agent restart flips the health series by design. Counting
// those as "flapping" would blame the app for the machine's own actions, so
// the moments we caused are collected and handed to the detector.
function explainedTransitions(name, { now = Date.now(), windowMs = 3600 * 1000 } = {}) {
  const since = now - windowMs;
  const moments = [];
  for (const r of readLedger(200)) {
    if (r.app !== name) continue;
    const t = new Date(r.at || 0).getTime();
    if (t >= since && ['repair', 'restart', 'deploy'].includes(r.action)) moments.push(t);
  }
  try {
    const intelMod = require('./intel.js');
    for (const d of intelMod.timelineFor({ app: name, kinds: ['deploy'], sinceMs: windowMs, limit: 20 })) moments.push(new Date(d.at).getTime());
  } catch { /* history optional */ }
  return moments;
}

// ── 3 · improve (recommendations only) ─────────────────────────────────────
function improvePass(caps) {
  if (!enabled()) return { recommendations: [] };
  const rows = readLedger(400);
  const hourAgo = Date.now() - 3600 * 1000;
  const recs = [];
  const restarts = {};
  for (const r of rows) {
    if (r.agent === 'repair' && r.app && new Date(r.at).getTime() >= hourAgo) restarts[r.app] = (restarts[r.app] || 0) + 1;
  }
  for (const [app, n] of Object.entries(restarts)) {
    if (n >= 3) recs.push({ severity: 'high', app, kind: 'flapping', text: `${app} was restarted ${n}× in the last hour — it is crashing in a loop. Read its deploy log, then roll back to the last good commit.` });
  }
  // a restart the agent could not verify is the strongest signal the machine
  // can produce about itself: the app is down and restarting does not fix it,
  // so a human has to change something. The app's own error line is quoted.
  const sixHoursAgo = Date.now() - 6 * 3600 * 1000;
  const broken = new Map();
  for (const r of rows) {
    if (r.agent !== 'repair' || r.ok !== false || !r.app) continue;
    if (new Date(r.at).getTime() < sixHoursAgo) continue;
    broken.set(r.app, r); // newest wins (readLedger is oldest→newest)
  }
  for (const [app, r] of broken) {
    recs.push({
      severity: 'high', app, kind: 'cannot-start',
      text: `${app} is down and a restart did not bring it back${r.detail ? ' — the log says: ' + r.detail : ''}. Restarting will not fix this one; the start command itself is failing.`,
    });
  }
  try {
    for (const app of caps.listApps() || []) {
      const hist = caps.deployHistory(app.name) || [];
      const recent = hist.slice(-3);
      if (recent.length === 3 && recent.every((h) => h.outcome !== 'success')) {
        recs.push({ severity: 'high', app: app.name, kind: 'deploy-failing', text: `${app.name}: the last 3 deploys failed. The previous version is still serving — fix the build, or roll back deliberately.` });
      }
    }
  } catch { /* history optional */ }
  try {
    const bu = caps.backups ? caps.backups() : null;
    if (bu) {
      const stale = (bu.apps || []).filter((a) => a.snapshots > 0 && a.latest && (Date.now() - new Date(a.latest.at || 0).getTime()) > 48 * 3600 * 1000);
      for (const s of stale) recs.push({ severity: 'medium', app: s.name, kind: 'backup-stale', text: `${s.name}: newest snapshot is over 48h old. Backups that stop are discovered at the worst moment.` });
      if (!(bu.apps || []).some((a) => a.snapshots > 0)) recs.push({ severity: 'high', kind: 'no-backups', text: 'Nothing on this machine is backed up yet. One button in operations fixes that.' });
    }
  } catch { /* backups optional */ }
  try {
    const disk = caps.diskFreeMb ? caps.diskFreeMb() : null;
    if (disk != null && disk < 2048) recs.push({ severity: 'high', kind: 'disk-low', text: `Only ${disk} MB free on the volume holding your apps. Deploys fail in confusing ways when the disk fills.` });
  } catch { /* disk optional */ }
  const payload = { at: new Date().toISOString(), recommendations: recs };
  try {
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    fs.writeFileSync(RECS, JSON.stringify(payload, null, 2));
  } catch { /* recommendations must never break the plane */ }
  return payload;
}

function readRecommendations() {
  try { return JSON.parse(fs.readFileSync(RECS, 'utf8')); } catch { return { at: null, recommendations: [] }; }
}

// ── the ticker ─────────────────────────────────────────────────────────────
let timer = null;
let lastImprove = 0;
const state = { lastRunAt: null, lastActions: [], running: false };

async function tick(caps) {
  if (state.running) return state; // never overlap passes
  state.running = true;
  try {
    const actions = [];
    actions.push(...await repairPass(caps));
    actions.push(...await diagnosePass(caps));
    if (Date.now() - lastImprove > IMPROVE_EVERY_MS) { lastImprove = Date.now(); improvePass(caps); }
    state.lastRunAt = new Date().toISOString();
    state.lastActions = actions;
  } finally { state.running = false; }
  return state;
}

function start(caps) {
  if (!enabled() || timer) return null;
  timer = setInterval(() => { tick(caps).catch(() => { /* a pass must never crash the plane */ }); }, INTERVAL_MS);
  timer.unref();
  return timer;
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

function status() {
  const rows = readLedger(60).reverse();
  const counts = { repair: 0, diagnose: 0 };
  for (const r of rows) if (counts[r.agent] != null && r.ok !== false) counts[r.agent]++;
  const policies = intel.loadPolicies();
  const agentState = intel.loadAgentState();
  return {
    enabled: enabled(),
    intervalMs: INTERVAL_MS,
    cooldownMs: COOLDOWN_MS,
    maxActionsPerPass: MAX_ACTIONS_PER_PASS,
    lastRunAt: state.lastRunAt,
    running: state.running,
    recent: rows.slice(0, 20),
    counts,
    recommendations: readRecommendations(),
    policies,
    backoff: Object.entries(agentState.apps || {}).map(([app, row]) => ({
      app,
      consecutiveFailures: row.consecutiveFailures || 0,
      nextAllowedAt: row.nextAllowedAt ? new Date(row.nextAllowedAt).toISOString() : null,
      blocked: (row.nextAllowedAt || 0) > Date.now(),
    })),
  };
}

module.exports = { start, stop, tick, status, improvePass, repairPass, diagnosePass, enabled, LEDGER, RECS, readLedger };
