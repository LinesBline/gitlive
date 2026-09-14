'use strict';
// intel.test.js — the v4 intelligence layer must be ARITHMETICALLY honest.
// Every claim it makes about the machine is checked here against synthetic
// histories whose right answer is known by construction: gaps are not uptime,
// an open outage runs to now, a flat series has no trend, a uniform failure
// pattern has no time-of-day cluster, a score with a missing factor is
// renormalised (never silently zeroed), and a percentage measured from too few
// samples refuses to be a percentage.
//
// No app, no plane, no network: pure functions over files in a fake $HOME.

const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }
function near(a, b, tol, msg) {
  if (a == null || Math.abs(a - b) > tol) throw new Error('ASSERTION FAILED: ' + msg + ` (got ${a}, wanted ${b}±${tol})`);
}

const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glintel-'));
const controlDir = path.join(home, '.gitlive', 'control');
fs.mkdirSync(controlDir, { recursive: true });
process.env.HOME = home;
process.env.GITLIVE_CONTROL_DIR = controlDir;

const intel = require('../control/intel.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// a synthetic app whose history we control completely
const RUN = path.join(home, '.gitlive', 'apps', 'alpha-run');
fs.mkdirSync(RUN, { recursive: true });

function writeSeries(name, rows) {
  fs.mkdirSync(RUN, { recursive: true });
  fs.writeFileSync(path.join(RUN, 'health-history.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function registry(extra = {}) {
  fs.writeFileSync(path.join(home, '.gitlive', 'apps.json'), JSON.stringify({
    alpha: { cwd: '/tmp/alpha', barePath: path.join(home, '.gitlive', 'apps', 'alpha.git'), runPath: RUN, startCmd: 'node server.js', port: '3999', ...extra },
  }, null, 2));
}
registry();

// samples every minute for `mins`, with `downFrom`..`downTo` (minute indices)
// reporting down. `skip` drops minutes (a gap in the meter).
function sampleRun(mins, { downFrom = null, downTo = null, skip = [], startAt = Date.now() - mins * MIN, upTo = null } = {}) {
  const rows = [];
  for (let i = 0; i <= mins; i++) {
    if (skip.includes(i)) continue;
    const at = new Date(startAt + i * MIN).toISOString();
    const down = downFrom != null && i >= downFrom && i <= (downTo == null ? mins : downTo);
    if (upTo != null && i > upTo) break;
    rows.push({ at, app: 'alpha', up: !down, status: down ? null : 200 });
  }
  return rows;
}

// ── 1 · reliability ────────────────────────────────────────────────────────
{
  // 240 minutes of clean history: uptime is 100%, and a bare "100%" must come
  // with the rule-of-three floor rather than standing on its own
  const now = Date.now();
  const clean = sampleRun(240, { startAt: now - 240 * MIN });
  const r = intel.reliabilityFrom(clean, { now, windowMs: 4 * HOUR });
  assert(r.uptimePct === 100, 'a clean run measures 100%: ' + r.uptimePct);
  assert(r.failures === 0, 'no failures recorded');
  assert(r.mtbfMs === null && r.mttrMs === null, 'with no failures MTBF/MTTR are absent, not invented');
  assert(r.uptimeFloorPct != null && r.uptimeFloorPct < 100 && r.uptimeFloorPct > 97, 'the 95% floor is printed beside a perfect number: ' + r.uptimeFloorPct);
  assert(r.coveragePct > 99, 'coverage is reported: ' + r.coveragePct);
  assert(/status below 500/.test(r.note), 'the note says what "up" means (4xx counts as up)');

  // 30 minutes down in the middle of 4 hours → 87.5% up over covered time
  const withOutage = sampleRun(240, { startAt: now - 240 * MIN, downFrom: 100, downTo: 129 });
  const r2 = intel.reliabilityFrom(withOutage, { now, windowMs: 4 * HOUR });
  near(r2.uptimePct, 87.5, 0.6, 'uptime is computed over covered time');
  assert(r2.failures === 1, 'one outage detected: ' + r2.failures);
  near(r2.longestOutageMs / MIN, 30, 1.5, 'the outage duration is real minutes');
  assert(r2.uptimeFloorPct === null, 'no floor is printed when a failure WAS observed');
  console.log('OK: reliability — uptime over covered time, rule-of-three floor, no invented MTBF');
}
{
  // an OPEN outage with FRESH samples runs to now, not to the last sample
  const now = Date.now();
  const open = sampleRun(120, { startAt: now - 120 * MIN, downFrom: 60 });
  const r = intel.reliabilityFrom(open, { now: now + 30 * 1000, windowMs: 4 * HOUR });
  const live = r.outages.find((o) => o.ongoing);
  assert(live, 'the open outage is marked ongoing');
  near((new Date(live.to).getTime() - new Date(live.from).getTime()) / MIN, 60, 2, 'it is counted up to now, not dropped');
  assert(r.uptimePct < 55, 'a machine that has been down for half the window cannot look healthy: ' + r.uptimePct);
  console.log('OK: an outage that is still happening is counted up to now');
}
{
  // a meter that went silent cannot testify about the present: the last
  // reading being "down" is history, and the honest answer says so
  const now = Date.now();
  const stale = sampleRun(120, { startAt: now - 120 * MIN, downFrom: 60 });
  const r = intel.reliabilityFrom(stale, { now: now + 30 * MIN, windowMs: 4 * HOUR });
  assert(!r.outages.some((o) => o.ongoing), 'a stale down reading is not claimed as an ongoing outage');
  assert(r.meterStale === true && r.meterStaleMs > 25 * MIN, 'the silence is measured: ' + intel.fmtDur(r.meterStaleMs));
  assert(/state right now is unknown/.test(r.note), 'and the note says the present is unknown: ' + r.note);
  console.log('OK: a silent meter is reported as unknown, never as "still down"');
}
{
  // a GAP in the meter (machine asleep) must never be scored as uptime
  const now = Date.now();
  const gapped = sampleRun(240, { startAt: now - 240 * MIN, skip: Array.from({ length: 120 }, (_, i) => i + 60) });
  const r = intel.reliabilityFrom(gapped, { now, windowMs: 4 * HOUR });
  assert(r.unknownMs > 100 * MIN, 'the blind stretch is recorded as unknown time: ' + intel.fmtDur(r.unknownMs));
  assert(r.coveragePct < 55, 'coverage reflects it: ' + r.coveragePct);
  assert(r.uptimePct === 100, 'what was covered WAS up — the honest answer is high uptime at low coverage');
  console.log('OK: a gap in the meter is unknown time, never uptime');
}
{
  // too few samples must refuse to be a percentage
  const now = Date.now();
  const tiny = sampleRun(2, { startAt: now - 2 * MIN });
  const r = intel.reliabilityFrom(tiny, { now, windowMs: DAY });
  assert(r.insufficient === true && r.uptimePct != null, 'two samples claim no rate: ' + JSON.stringify({ i: r.insufficient, u: r.uptimePct }));
  assert(/not enough to claim a rate/.test(r.note), 'and it says why: ' + r.note);
  console.log('OK: insufficient samples are reported, never rounded into a healthy-looking number');
}

// ── 2 · the daily roll-up (what makes 30-day numbers possible at all) ──────
{
  const base = Date.now() - 3 * DAY;
  const prev = (i) => ({ at: base + (i - 1) * MIN, up: true });
  let row = null;
  for (let i = 1; i <= 10; i++) row = intel.recordSampleInRollup('alpha', prev(i), { at: base + i * MIN, up: true }, { step: MIN });
  near(row.upMs / MIN, 10, 0.01, 'ten covered minutes of uptime accumulate (one per interval)');
  // an up→down edge counts exactly one outage
  intel.recordSampleInRollup('alpha', { at: base + 10 * MIN, up: true }, { at: base + 11 * MIN, up: false }, { step: MIN });
  intel.recordSampleInRollup('alpha', { at: base + 11 * MIN, up: false }, { at: base + 12 * MIN, up: false }, { step: MIN });
  const rows = intel.readDailyRollup('alpha');
  assert(rows.length === 1, 'one line per day: ' + rows.length);
  assert(rows[0].outages === 1, 'one outage for one up→down edge: ' + rows[0].outages);
  assert(rows[0].transitions === 1, 'one transition: ' + rows[0].transitions);
  // a 30-minute hole is unknown, not down and not up
  intel.recordSampleInRollup('alpha', { at: base + 12 * MIN, up: false }, { at: base + 42 * MIN, up: true }, { step: MIN });
  const rows2 = intel.readDailyRollup('alpha');
  assert(rows2[0].unknownMs >= 29 * MIN, 'the hole is unknown time: ' + intel.fmtDur(rows2[0].unknownMs));
  const agg = intel.reliabilityFromRollup(rows2, { windowMs: 30 * DAY });
  assert(agg && agg.source === 'daily roll-up', 'the aggregate says where it came from');
  assert(agg.coveredMs > 0 && agg.uptimePct != null, 'and it can compute a rate: ' + agg.uptimePct + '%');
  assert(agg.insufficient === true && /1 of 30 recorded day/.test(agg.note), 'but ONE day of aggregate refuses to answer a 30-day question: ' + agg.note);
  // ten recorded days is still not half of a 30-day window; sixteen is
  const mkDays = (n) => Array.from({ length: n }, (_, i) => ({ day: new Date(Date.now() - (n - i) * DAY).toISOString().slice(0, 10), upMs: 23 * HOUR, downMs: HOUR, unknownMs: 0, outages: 1, transitions: 2 }));
  assert(intel.reliabilityFromRollup(mkDays(10), { windowMs: 30 * DAY }).insufficient === true, 'ten recorded days cannot answer a 30-day question');
  const agg16 = intel.reliabilityFromRollup(mkDays(16), { windowMs: 30 * DAY });
  assert(agg16.insufficient === false, 'sixteen recorded days can');
  assert(agg16.uptimePct > 90 && agg16.uptimePct < 100, 'and its rate is the aggregate of those days: ' + agg16.uptimePct);
  console.log('OK: the daily roll-up accumulates uptime, outages and unknown time per day');
}

// ── 3 · detectors ──────────────────────────────────────────────────────────
{
  const now = Date.now();
  // flapping: 8 transitions inside the last hour
  const flip = [];
  for (let i = 0; i <= 60; i++) flip.push({ at: new Date(now - 60 * MIN + i * MIN).toISOString(), app: 'alpha', up: Math.floor(i / 8) % 2 === 0, status: 200 });
  const f = intel.detectFlapping('alpha', flip.filter((r) => new Date(r.at).getTime() >= now - HOUR), { now });
  assert(f && f.kind === 'flapping' && f.severity, 'flapping is detected: ' + JSON.stringify(f && f.title));
  assert(f.evidence.transitions >= 4 && f.samples >= 10, 'with its evidence and sample count');
  // a calm hour stays quiet
  const calm = flip.map((r) => ({ ...r, up: true }));
  assert(intel.detectFlapping('alpha', calm, { now }) === null, 'a calm hour is not flapping');
  console.log('OK: flapping detector — fires on a crash loop, silent on a calm hour');
}
{
  const now = Date.now();
  // failures clustered at 03:00 LOCAL every day for a week (the detector bins
  // by local hour, so the fixture must be built in local time too)
  const rows = [];
  for (let t = now - 7 * DAY; t <= now; t += MIN) {
    const d = new Date(t);
    const down = d.getHours() === 3 && d.getMinutes() < 20; // 20 minutes every night
    rows.push({ at: new Date(t).toISOString(), app: 'alpha', up: !down, status: down ? null : 200 });
  }
  const c = intel.detectHourClustering('alpha', rows, { now });
  assert(c && c.kind === 'hour-cluster', 'a nightly pattern is detected: ' + JSON.stringify(c && c.title));
  assert(c.evidence.pValue < 0.05, 'with a p-value under 0.05: ' + (c && c.evidence.pValue));
  const startHour = c.evidence.windowStartHour;
  const covers3 = ((3 - startHour) % 24 + 24) % 24 < 3;
  assert(covers3, 'and the named window contains the cluster: ' + c.title + ' (starts ' + startHour + ':00)');
  assert(c.evidence.failures === 7, 'one failure per night, not two: ' + c.evidence.failures);
  assert(/policy|maintenance/.test(c.action.label), 'and it offers the maintenance window: ' + c.action.label);
  // failures scattered across the day must NOT be called a pattern
  const uniform = [];
  for (let t = now - 7 * DAY; t <= now; t += MIN) {
    const d = new Date(t);
    const scattered = [1, 5, 9, 13, 17, 21].includes(d.getHours()) && d.getMinutes() < 8;
    uniform.push({ at: new Date(t).toISOString(), app: 'alpha', up: !scattered, status: scattered ? null : 200 });
  }
  assert(intel.detectHourClustering('alpha', uniform, { now }) === null, 'six scattered failures across the day are not a nightly pattern');
  console.log('OK: time-of-day clustering — needs 5+ failures and p<0.05, silent on scattered ones');
}
{
  // a genuine leak: +10 MB/hour for 8 hours; a flat series must stay silent
  const now = Date.now();
  const leak = [];
  const flat = [];
  for (let i = 0; i < 48; i++) {
    const at = now - (48 - i) * 10 * MIN;
    leak.push({ at, v: 100 + i * (10 / 6) });      // ≈ +1.67 MB per 10 min = 10 MB/h
    flat.push({ at, v: 100 + (i % 2) });           // noise, no trend
  }
  const l = intel.detectResourceTrend('alpha', leak, { label: 'memory', unit: 'MB', limit: null });
  assert(l && l.kind === 'resource-trend', 'a leak is detected: ' + JSON.stringify(l && l.title));
  assert(/doubles in about/.test(l.title), 'with no configured limit it reports a doubling time, never a made-up ceiling: ' + l.title);
  assert(l.evidence.t > 2, 'and it only fires when the slope beats its own margin of error: t=' + l.evidence.t);
  assert(intel.detectResourceTrend('alpha', flat, { label: 'memory', unit: 'MB', limit: null }) === null, 'a flat series has no trend');
  // a shrinking disk forecasts time-to-limit
  const disk = [];
  for (let i = 0; i < 60; i++) disk.push({ at: now - (60 - i) * 10 * MIN, v: 5000 - i * 20 });
  const d = intel.detectResourceTrend('alpha', disk, { label: 'free disk', unit: 'MB', limit: 512, inverse: true, minSamples: 24 });
  assert(d && /reaches 512 MB/.test(d.title), 'a shrinking disk forecasts the limit: ' + (d && d.title));
  console.log('OK: trend detector — significant slope only, doubling time or forecast, silent on noise');
}
{
  // "went down 4 minutes after deploy X" — the correlation that names a commit
  const now = Date.now();
  const deployAt = now - 2 * HOUR;
  const rows = [];
  for (let i = 0; i <= 120; i++) {
    const t = deployAt - 60 * MIN + i * MIN;
    const down = t > deployAt + 4 * MIN;
    rows.push({ at: new Date(t).toISOString(), app: 'alpha', up: !down, status: down ? null : 200 });
  }
  const hist = [{ at: new Date(deployAt).toISOString(), commit: 'abcdef123456', outcome: 'failed', reason: 'process exited within 6s of start' }];
  const c = intel.detectDeployCorrelation('alpha', rows, hist, { now: deployAt + 60 * MIN });
  assert(c && c.kind === 'deploy-correlation', 'an outage after a deploy is correlated: ' + JSON.stringify(c && c.title));
  assert(c.evidence.commit === 'abcdef123456' && c.evidence.minutesAfter <= 15, 'the commit and the delay travel with it');
  assert(/^\d{4}-\d{2}-\d{2}T/.test(c.evidence.outageFrom), 'the evidence carries an ISO timestamp, not a raw epoch: ' + c.evidence.outageFrom);
  assert(c.action && c.action.kind === 'rollback', 'and the offered action is the rollback');
  // a deploy from three days ago is not the cause of today's outage
  const old = [{ at: new Date(now - 3 * DAY).toISOString(), commit: 'older', outcome: 'success' }];
  assert(intel.detectDeployCorrelation('alpha', rows, old, { now: deployAt + 60 * MIN }) === null, 'a stale deploy is not blamed');
  console.log('OK: deploy correlation — names the commit, offers the rollback, ignores stale deploys');
}
{
  // the app's own error line, from a verified-failed repair receipt
  const now = Date.now();
  const rows = [{ at: new Date(now - 30 * MIN).toISOString(), agent: 'repair', action: 'restart', app: 'alpha', ok: false, reason: 'restarted, but the app is still down', detail: "Error: Cannot find module '/tmp/alpha/missing.js'", verified: false }];
  const s = intel.detectCannotStart('alpha', rows, { now });
  assert(s && s.kind === 'cannot-start', 'a failed repair becomes a finding');
  assert(/Cannot find module/.test(s.detail), "the app's own words are quoted: " + s.detail);
  assert(intel.detectCannotStart('alpha', [{ ...rows[0], ok: true }], { now }) === null, 'a successful repair is not a finding');
  console.log("OK: a restart that could not fix an app is raised with the app's own error line");
}
{
  // certificates: lead time scales with the certificate's own lifetime
  const shortLived = intel.detectCertExpiry([{ domain: 'a.example', daysLeft: 10, lifetimeDays: 47, kind: 'public' }]);
  assert(shortLived.length === 1, 'a short-lived certificate at 10 days left is inside the (never-less-than-two-weeks) renewal window');
  assert(shortLived[0].evidence.leadDays === 14, 'and the lead it used is printed: ' + shortLived[0].evidence.leadDays);
  const longLived = intel.detectCertExpiry([{ domain: 'b.example', daysLeft: 40, lifetimeDays: 400, kind: 'public' }]);
  assert(longLived.length === 0, 'a 400-day certificate at 40 days left is not yet — the lead is at most a month');
  const midLived = intel.detectCertExpiry([{ domain: 'c.example', daysLeft: 25, lifetimeDays: 200, kind: 'public' }]);
  assert(midLived.length === 1, 'but a 200-day certificate at 25 days IS — 14 days would have been too late');
  console.log('OK: certificate lead time is a fraction of the lifetime, not a fixed two weeks');
}

// ── 4 · the score ──────────────────────────────────────────────────────────
{
  const facts = {
    apps: [
      { name: 'alpha', upNow: true, uptimePct: 100, insufficient: false, deploys: { ok: 4, total: 4 }, backupKnown: true, backedUp: true, backupVerified: true },
      { name: 'beta', upNow: true, uptimePct: 100, insufficient: false, deploys: { ok: 4, total: 4 }, backupKnown: true, backedUp: true, backupVerified: true },
    ],
    integrityOk: true,
    certs: [{ daysLeft: 80, lifetimeDays: 90 }],
    diskFreeMb: 50000,
    diskTotalMb: 100000,
  };
  const good = intel.computeScore(facts);
  assert(good.score > 0 && good.score <= 100, 'the score is a 0-100 number: ' + good.score);
  assert(good.score >= 95, 'a healthy machine scores high: ' + good.score);
  assert(good.factors.length === intel.SCORE_FACTORS.length, 'every factor is present in the breakdown');
  assert(good.factors.every((f) => f.weight > 0 && 'pct' in f), 'each factor carries its weight and its rendered value');

  // a good WEEK cannot hide an app that is down THIS MINUTE
  const downNow = intel.computeScore({ ...facts, apps: [{ ...facts.apps[0], upNow: false, downForMs: 3 * HOUR }, facts.apps[1]] });
  assert(downNow.score < good.score - 10, 'being down right now costs real points: ' + good.score + ' → ' + downNow.score);
  const nowFactor = downNow.factors.find((f) => f.key === 'now');
  // the machine area never prints an app name (two-area law): a count and a
  // duration, with the names left to the projects board
  assert(nowFactor.value === 0 && /1 of 2 app\(s\) down/.test(nowFactor.detail), 'and the factor explains it without naming the app: ' + nowFactor.detail);
  assert(!/alpha/.test(nowFactor.detail), 'no app name leaks into a machine-level factor');

  // a missing factor is EXCLUDED and the weights renormalised, never zeroed
  const partial = intel.computeScore({ apps: facts.apps, integrityOk: null, certs: [], diskFreeMb: null, diskTotalMb: null });
  assert(partial.excluded.includes('integrity') && partial.excluded.includes('certs'), 'unavailable factors are listed: ' + partial.excluded.join(','));
  assert(partial.score > 90, 'and they do not drag the score down: ' + partial.score);
  assert(/renormalised/.test(partial.formula), 'the formula says the weights moved: ' + partial.formula);
  assert(partial.factors.find((f) => f.key === 'integrity').value === null, 'the excluded factor reads n/a, not 0');

  assert(intel.band(96) === 'excellent' && intel.band(80) === 'healthy' && intel.band(60) === 'degraded' && intel.band(10) === 'critical' && intel.band(null) === 'unknown', 'bands map the way the UI prints them');
  console.log('OK: score — 0-100, factors always shown, down-now cannot hide, missing factors renormalised');
}

// ── 5 · timeline ───────────────────────────────────────────────────────────
{
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  // one deploy recorded BOTH as an audit event and in the deploy history
  fs.writeFileSync(path.join(home, '.gitlive', 'events.log'), [
    JSON.stringify({ at: iso(2 * HOUR), kind: 'deploy', detail: { app: 'alpha', commit: 'deadbeef', outcome: 'success' } }),
    JSON.stringify({ at: iso(90 * MIN), kind: 'agent-repair', detail: { app: 'alpha', ok: false, reason: 'restarted, but the app is still down' } }),
    JSON.stringify({ at: iso(60 * MIN), kind: 'login', detail: {} }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(RUN, 'deploy-history.jsonl'), JSON.stringify({ at: iso(2 * HOUR), outcome: 'success', commit: 'deadbeef' }) + '\n');
  // a per-app job (its label names the app, which the machine view must not print)
  fs.writeFileSync(path.join(home, '.gitlive', 'jobs.jsonl'), [
    JSON.stringify({ id: 'j1', kind: 'backup', label: 'backup alpha', startedAt: iso(45 * MIN) }),
    JSON.stringify({ id: 'j1', endedAt: iso(44 * MIN), ok: true }),
  ].join('\n') + '\n');

  const tl = intel.timelineFor({ limit: 50, sinceMs: DAY });
  const deploys = tl.filter((e) => e.kind === 'deploy');
  assert(deploys.length === 1, 'a deploy appears ONCE even though two ledgers record it: ' + deploys.length);
  assert(deploys[0].severity === 'ok', 'its severity follows the outcome');
  const job = tl.find((e) => e.kind === 'job');
  assert(job && /finished/.test(job.title), 'job start/end rows are merged into one entry: ' + (job && job.title));
  assert(job.app === 'alpha', 'the job is attributed to the app named in its label');
  assert(!/alpha/.test(job.title), 'and the label no longer prints the app name (machine surface): ' + job.title);
  const rep = tl.find((e) => e.kind === 'agent-repair');
  assert(rep && rep.severity === 'bad', 'a failed repair reads as bad');
  const scoped = intel.timelineFor({ app: 'alpha', limit: 50, sinceMs: DAY });
  assert(scoped.every((e) => !e.app || e.app === 'alpha'), 'an app-scoped timeline only carries that app');
  console.log('OK: timeline — merged, de-duplicated, app-attributed, machine-safe labels');
}

// ── 6 · digest ─────────────────────────────────────────────────────────────
{
  // a poisoned log line must not be able to forge structure in the report
  const evil = 'ok\n## Fake section\n- injected: true';
  assert(!/\n/.test(intel.oneLine(evil)), 'control characters and newlines are stripped before rendering');
  assert(intel.oneLine(evil).startsWith('ok'), 'the text survives, only the structure does not: ' + intel.oneLine(evil));
  fs.appendFileSync(path.join(controlDir, 'agent-actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), agent: 'repair', action: 'restart', app: 'alpha', ok: false, reason: 'restarted, but the app is still down', detail: evil }) + '\n');
  const d = intel.digestData({ days: 7 });
  assert(/# gitlive report/.test(d.markdown), 'the digest has a title');
  for (const section of ['## Availability', '## Incidents', '## Deploys', '## Backups', '## What the helpers did', '## Numbers this report is made of']) {
    assert(d.markdown.includes(section), 'digest section present: ' + section);
  }
  const injected = d.markdown.split('\n').filter((l) => l.trim() === '## Fake section');
  assert(injected.length === 0, 'a log line cannot forge a section in the report');
  assert(/gitlive report/.test(d.markdown), 'the report names itself');
  console.log('OK: digest — every section, and log lines cannot inject structure into it');
}

// ── 7 · policies + backoff ─────────────────────────────────────────────────
{
  const saved = intel.savePolicies({ default: { mode: 'repair', maxActionsPerHour: 2 }, apps: { alpha: { mode: 'watch' } } });
  assert(saved.apps.alpha.mode === 'watch', 'a per-app override is stored');
  const p = intel.policyFor('alpha');
  assert(p.mode === 'watch' && p.maxActionsPerHour === 2, 'the override merges over the default: ' + JSON.stringify(p));
  assert(intel.policyFor('other').mode === 'repair', 'an app without an override follows the default');
  intel.savePolicies({ default: { mode: 'repair' }, apps: { alpha: { mode: 'nonsense' } } });
  assert(intel.policyFor('alpha').mode === 'repair', 'an unknown mode falls back to the default instead of disabling the agent by accident');
  // maintenance windows, including one that wraps midnight
  const night = { maintenance: [{ from: '22:00', to: '06:00', days: [1, 2, 3, 4, 5] }] };
  const monday2am = new Date('2026-09-14T02:00:00');
  const mondayNoon = new Date('2026-09-14T12:00:00');
  assert(intel.inMaintenance(night, monday2am), 'a window that wraps midnight covers the small hours');
  assert(!intel.inMaintenance(night, mondayNoon), 'and not the middle of the day');
  assert(!intel.inMaintenance({ maintenance: [{ from: '22:00', to: '06:00', days: [0] }] }, monday2am), 'the day filter is respected');
  assert(!intel.inMaintenance({ maintenance: [] }, monday2am), 'no windows means no suspension');
  console.log('OK: policies — per-app override, safe fallback, maintenance windows incl. midnight wrap');
}
{
  // adaptive backoff: 5m → 15m → 1h → 6h, reset by a verified repair
  const t0 = Date.now();
  fs.rmSync(intel.PATHS.AGENT_STATE, { force: true });
  const waits = [];
  for (let i = 0; i < 5; i++) {
    const row = intel.noteRepairResult('alpha', false, { state: intel.loadAgentState(), now: t0 });
    waits.push(row.lastWaitMs);
  }
  const expect = intel.BACKOFF_MS;
  waits.forEach((w, i) => {
    const base = expect[Math.min(i, expect.length - 1)];
    assert(w >= base * 0.85 && w <= base * 1.15, `attempt ${i + 1} waits ≈ ${intel.fmtDur(base)} (±10% jitter), got ${intel.fmtDur(w)}`);
  });
  const blocked = intel.backoffFor('alpha', intel.loadAgentState(), t0);
  assert(blocked.blocked === true && blocked.failures === 5, 'the app is blocked while the backoff runs: ' + JSON.stringify(blocked.failures));
  // jitter can stretch the last wait by 10%, so step past the worst case
  const after = intel.backoffFor('alpha', intel.loadAgentState(), t0 + expect[expect.length - 1] * 1.2 + 1000);
  assert(after.blocked === false, 'and free again once it elapses');
  const okRow = intel.noteRepairResult('alpha', true, { state: intel.loadAgentState(), now: t0 });
  assert(okRow.consecutiveFailures === 0 && okRow.nextAllowedAt === 0, 'a verified repair clears the backoff');
  const escal = intel.loadAgentState().apps.alpha;
  assert(!escal || !escal.escalated, 'the escalation flag is dropped on success');
  // a new deploy clears it too (new code is new evidence)
  intel.noteRepairResult('beta', false, { state: intel.loadAgentState(), now: t0 });
  intel.clearBackoff('beta', { state: intel.loadAgentState() });
  assert(!intel.loadAgentState().apps.beta, 'a deploy clears the backoff for that app');
  console.log('OK: backoff — 5m/15m/1h/6h with jitter, cleared by a verified repair or a new deploy');
}

// ── 8 · the overview ties it together ──────────────────────────────────────
{
  registry();
  writeSeries('alpha', sampleRun(180, { startAt: Date.now() - 180 * MIN, downFrom: 170 }));
  fs.writeFileSync(path.join(RUN, 'backup-history.jsonl'), JSON.stringify({ at: new Date(Date.now() - 3 * DAY).toISOString(), snapshot: 's1' }) + '\n');
  fs.writeFileSync(path.join(RUN, 'stats-history.jsonl'), Array.from({ length: 40 }, (_, i) => JSON.stringify({ at: new Date(Date.now() - (40 - i) * 5 * MIN).toISOString(), rssMb: 80 + i })).join('\n') + '\n');
  const o = intel.intelOverview({ apps: ['alpha'], integrityOk: true, certs: [], diskFreeMb: 40000, diskTotalMb: 100000, version: '4.0.0' });
  assert(o.version === '4.0.0' && o.score && Array.isArray(o.insights), 'the overview carries version, score and insights');
  assert(o.apps.length === 1 && o.apps[0].reliability, 'and a per-app reliability block');
  const kinds = o.insights.map((i) => i.kind);
  assert(kinds.includes('backup-stale'), 'a three-day-old backup is flagged: ' + JSON.stringify(kinds));
  assert(kinds.includes('resource-trend'), 'a growing memory series is flagged: ' + JSON.stringify(kinds));
  assert(o.score.factors.find((f) => f.key === 'now').value === 0, 'the app is down at the end of the series, and the score says so');
  console.log('OK: overview — score, insights and per-app reliability in one call');
}

console.log('\nALL INTELLIGENCE TESTS PASSED');
