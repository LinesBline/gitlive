// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// intel.js — the plane's own intelligence: it MEASURES, it REMEMBERS, it
// EXPLAINS. This is the v4 headline, and it is deterministic on purpose.
//
// WHAT IT IS NOT: there is no model here, no network call, no key, no service.
// gitlive runs on Node built-ins with zero runtime dependencies, so "smart"
// has to mean something a machine can actually be: statistics over its own
// recorded history, with the sample size printed next to every claim.
//
// The three jobs:
//   1. MEASURE   — per-app reliability straight from the 1-minute health
//                  series: uptime over real covered time, every outage with
//                  its duration (an open one included), MTBF/MTTR, current
//                  streak. Gaps in the samples are gaps, never "up".
//   2. DETECT    — insights with evidence: flapping, failures clustered in a
//                  time-of-day window, a leaking/growing resource with a
//                  time-to-limit forecast, a failing deploy streak, a stale
//                  backup, a certificate running out. Every detector carries
//                  the minimum sample count it needs before it may speak.
//   3. EXPLAIN   — one 0-100 score whose factors are ALWAYS shown, an incident
//                  timeline merged from every ledger the machine already
//                  keeps, and a weekly digest in plain markdown.
//
// Honesty rules baked into the maths (each has a test):
//   · too few samples → `insufficient`, never 0% or 100%.
//   · a factor that cannot be computed is EXCLUDED from the score and its
//     weight redistributed — shown as n/a, never silently scored.
//   · every number carries its window and its sample count into the UI.

const fs = require('fs');
const path = require('path');
const os = require('os');
const redact = require('./redact.js');

const HOME = process.env.GITLIVE_HOME || path.join(os.homedir(), '.gitlive');
const CONTROL_DIR = process.env.GITLIVE_CONTROL_DIR || path.join(HOME, 'control');
const EVENTS_LOG = path.join(HOME, 'events.log');
const POLICIES = path.join(CONTROL_DIR, 'policies.json');
const AGENT_STATE = path.join(CONTROL_DIR, 'agent-state.json');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ── tiny helpers ───────────────────────────────────────────────────────────
function readJsonl(file, limit = 5000) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const slice = lines.slice(-limit);
    const out = [];
    for (const l of slice) { try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ } }
    return out;
  } catch { return []; }
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null; }

function pct(n, d) { return d > 0 ? (100 * n) / d : null; }

function appDir(name) {
  return path.join(HOME, 'apps', name + '-run');
}

function runPathOf(name) {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(HOME, 'apps.json'), 'utf8'));
    return (reg[name] || {}).runPath || appDir(name);
  } catch { return appDir(name); }
}

// ── 1 · MEASURE ────────────────────────────────────────────────────────────
// The health series is one line per minute: {at, app, up, status}. Two
// subtleties decide whether the number is honest:
//   · an app that was DOWN and then came up has an outage; an app whose
//     samples STOP (machine asleep, plane restarted) has a GAP — counting a
//     gap as uptime is how monitoring lies.
//   · the last sample being down means the outage is still OPEN, so its
//     duration runs to now instead of being dropped.

// health history grows to thousands of lines; the file only changes when the
// sampler appends (once a minute), so it is parsed once per change instead of
// once per call — the dashboard polls this
const SERIES_CACHE = new Map();
// every entry point accepts either epoch numbers or ISO strings: a caller that
// hands in raw JSON lines must not silently measure nothing (that bug produced
// a confident `uptimePct: null` for a perfectly healthy series)
function normalizeSamples(rows) {
  return (rows || [])
    .map((r) => ({ at: typeof r.at === 'number' ? r.at : new Date(r.at).getTime(), up: r.up === true, status: r.status == null ? null : r.status }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);
}

function healthSeries(appName, { sinceMs = null, limit = 20000 } = {}) {
  const file = path.join(runPathOf(appName), 'health-history.jsonl');
  let stamp = 'missing';
  try { const st = fs.statSync(file); stamp = st.size + ':' + st.mtimeMs; } catch { /* no file yet */ }
  const key = appName + '|' + limit;
  const cached = SERIES_CACHE.get(key);
  if (cached && cached.stamp === stamp) {
    return sinceMs ? cached.rows.filter((r) => r.at >= Date.now() - sinceMs) : cached.rows;
  }
  const rows = normalizeSamples(readJsonl(file, limit).filter((r) => r && r.at));
  SERIES_CACHE.set(key, { stamp, rows });
  if (SERIES_CACHE.size > 50) SERIES_CACHE.delete(SERIES_CACHE.keys().next().value);
  return sinceMs ? rows.filter((r) => r.at >= Date.now() - sinceMs) : rows;
}

// walk the samples once: sum covered time, collect outage spans, note gaps
function segmentSeries(rawSamples, { now = Date.now(), gapFactor = 3 } = {}) {
  const samples = rawSamples.length && typeof rawSamples[0].at === 'number' ? rawSamples : normalizeSamples(rawSamples);
  if (samples.length < 2) return { intervals: [], outages: [], coveredMs: 0, gapMs: 0, transitions: 0, step: null, samples };
  const deltas = [];
  for (let i = 1; i < samples.length; i++) deltas.push(samples[i].at - samples[i - 1].at);
  const step = median(deltas) || 60000;
  const gapLimit = Math.max(step * gapFactor, step + 120000);
  const intervals = [];
  const outages = [];
  let coveredMs = 0;
  let gapMs = 0;
  let transitions = 0;
  let openOutage = null;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const dt = cur.at - prev.at;
    if (dt > gapLimit) {
      // the meter was blind here: no claim about this stretch either way
      gapMs += dt;
      if (openOutage) { openOutage.to = prev.at; openOutage.ms = openOutage.to - openOutage.from; openOutage.endedByGap = true; outages.push(openOutage); openOutage = null; }
      continue;
    }
    coveredMs += dt;
    intervals.push({ from: prev.at, to: cur.at, up: cur.up, dt });
    if (cur.up !== prev.up) transitions++;
    if (!cur.up) {
      // the outage STARTS at the first observation of down, not at the last
      // healthy sample: we can only testify to what the meter saw, and
      // attributing it to the previous sample also mis-bins it by an hour
      if (!openOutage) openOutage = { from: cur.at, to: null, ms: null, ongoing: false };
      else openOutage.to = cur.at;
    } else if (openOutage) {
      openOutage.to = cur.at;
      openOutage.ms = openOutage.to - openOutage.from;
      outages.push(openOutage);
      openOutage = null;
    }
  }
  // still down at the end of the series → the outage is open right now
  if (openOutage) {
    const last = samples[samples.length - 1];
    if (!last.up && now - last.at <= gapLimit) {
      openOutage.to = now;
      openOutage.ms = now - openOutage.from;
      openOutage.ongoing = true;
    } else {
      openOutage.to = last.at;
      openOutage.ms = openOutage.to - openOutage.from;
    }
    outages.push(openOutage);
  }
  return { intervals, outages, coveredMs, gapMs, transitions, step };
}

// Wilson/rule-of-three style floor for a percentage measured from n samples:
// 1,440 clean samples cannot prove 100% — the honest 95% floor is 1 − 3/n.
function ruleOfThreeFloor(n) {
  if (!n) return null;
  return Math.round(Math.max(0, 1 - 3 / n) * 1000) / 10;
}

function reliabilityFrom(rawSamples, { now = Date.now(), windowMs = DAY } = {}) {
  const cutoff = now - windowMs;
  const samples = rawSamples.length && typeof rawSamples[0].at === 'number' ? rawSamples : normalizeSamples(rawSamples);
  const inWindow = samples.filter((s) => s.at >= cutoff);
  const seg = segmentSeries(inWindow, { now });
  const downMs = seg.outages.reduce((a, o) => a + (o.ms || 0), 0);
  const upMs = Math.max(0, seg.coveredMs - downMs);
  const coverage = pct(seg.coveredMs, windowMs);
  const enough = inWindow.length >= 5 && seg.coveredMs >= Math.min(windowMs, 10 * 60 * 1000);
  const failures = seg.outages.length;
  const closed = seg.outages.filter((o) => !o.ongoing);
  const uptimePct = seg.coveredMs > 0 ? Math.round((upMs / seg.coveredMs) * 1000) / 10 : null;
  const lastSample = inWindow.length ? inWindow[inWindow.length - 1] : null;
  const meterStaleMs = lastSample ? Math.max(0, now - lastSample.at) : null;
  const meterStale = meterStaleMs != null && meterStaleMs > Math.max(3 * (seg.step || 60000), 180000);
  const noteBits = [];
  if (!enough) noteBits.push(`only ${inWindow.length} sample(s) in this window — not enough to claim a rate`);
  // 4xx counts as up (statusCode < 500): say it, so a 404-heavy app is not
  // silently reported as perfectly healthy
  noteBits.push('"up" means the app answered with a status below 500');
  if (failures < 3) noteBits.push(failures === 0 ? 'no failures in this window, so MTBF/MTTR cannot be computed' : `only ${failures} failure(s) — MTBF/MTTR need at least 2-3 before they mean anything`);
  // a meter that stopped reporting cannot testify about the present: the last
  // reading being "down" is history, not a claim about right now
  if (meterStale) noteBits.push(`the meter has not reported for ${fmtDur(meterStaleMs)} — the app's state right now is unknown`);
  return {
    windowMs,
    samples: inWindow.length,
    coveragePct: coverage == null ? null : Math.round(coverage * 10) / 10,
    coveredMs: seg.coveredMs,
    unknownMs: seg.gapMs,
    sampleStepMs: seg.step || null,
    uptimePct,
    // a bare 100% is a claim the data cannot support: with n samples the 95%
    // floor is 1 − 3/n, so it is reported next to any near-perfect number
    uptimeFloorPct: failures === 0 && inWindow.length ? ruleOfThreeFloor(inWindow.length) : null,
    upMs,
    downMs,
    failures,
    outages: seg.outages.map((o) => ({ from: new Date(o.from).toISOString(), to: o.to ? new Date(o.to).toISOString() : null, ms: o.ms, ongoing: Boolean(o.ongoing) })),
    longestOutageMs: seg.outages.reduce((a, o) => Math.max(a, o.ms || 0), 0) || 0,
    // MTBF = how much healthy time we get per failure (the SRE definition:
    // uptime / number of failures). Needs at least 2 failures to mean anything.
    mtbfMs: failures >= 2 ? Math.round(upMs / failures) : null,
    mttrMs: closed.length >= 1 ? Math.round(mean(closed.map((o) => o.ms || 0))) : null,
    transitions: seg.transitions,
    lastSampleAt: lastSample ? new Date(lastSample.at).toISOString() : null,
    meterStaleMs,
    meterStale,
    insufficient: !enough,
    note: noteBits.join(' · '),
  };
}

// ── the daily roll-up ──────────────────────────────────────────────────────
// The raw series is pruned at 5,000 lines / 7 days, so a 30-day rate could
// never be computed from it. The sampler maintains one line per day per app
// (health-daily.jsonl) as it goes: up/down/unknown seconds, outages and
// transitions — small, mergeable and enough for month-scale honesty.
function dailyRollupPath(appName) { return path.join(runPathOf(appName), 'health-daily.jsonl'); }

function readDailyRollup(appName) {
  return readJsonl(dailyRollupPath(appName), 400);
}

// fold a window's raw samples into per-day buckets (used both by the sampler
// and by reads that predate the roll-up's first write)
function foldByDay(samples, { now = Date.now() } = {}) {
  const days = new Map();
  const seg = segmentSeries(samples, { now });
  for (const iv of seg.intervals) {
    const day = new Date(iv.to).toISOString().slice(0, 10);
    const cur = days.get(day) || { day, upMs: 0, downMs: 0, unknownMs: 0, transitions: 0, outages: 0 };
    if (iv.up) cur.upMs += iv.dt; else cur.downMs += iv.dt;
    days.set(day, cur);
  }
  for (const o of seg.outages) {
    const day = new Date(o.from).toISOString().slice(0, 10);
    const cur = days.get(day);
    if (cur) cur.outages++;
  }
  for (const d of days.values()) {
    const total = d.upMs + d.downMs;
    d.uptimePct = total > 0 ? Math.round((d.upMs / total) * 1000) / 10 : null;
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// called by the plane's sampler with the previous sample in hand: keeps one
// line per day without re-reading the whole series
function recordSampleInRollup(appName, prevSample, sample, { step = 60000 } = {}) {
  const day = new Date(sample.at).toISOString().slice(0, 10);
  const rows = readDailyRollup(appName);
  let row = rows.find((r) => r.day === day);
  if (!row) { row = { day, upMs: 0, downMs: 0, unknownMs: 0, transitions: 0, outages: 0 }; rows.push(row); }
  if (prevSample) {
    const dt = sample.at - prevSample.at;
    if (dt > Math.max(3 * step, 180000)) row.unknownMs += dt;        // the meter was blind: unknown, not up
    else if (sample.up) row.upMs += dt;
    else { row.downMs += dt; if (prevSample.up) row.outages += 1; }  // one outage per up→down edge
    if (sample.up !== prevSample.up) row.transitions += 1;
  }
  const total = row.upMs + row.downMs;
  row.uptimePct = total > 0 ? Math.round((row.upMs / total) * 1000) / 10 : null;
  rows.sort((a, b) => a.day.localeCompare(b.day));
  try {
    fs.mkdirSync(path.dirname(dailyRollupPath(appName)), { recursive: true });
    fs.writeFileSync(dailyRollupPath(appName), rows.slice(-400).map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch { /* the roll-up must never break the sampler */ }
  return row;
}

// a window built from the roll-up: exact about which days it covers, and
// explicit about being an aggregate rather than a sample
function reliabilityFromRollup(rows, { now = Date.now(), windowMs = 30 * DAY } = {}) {
  const cutoffDay = new Date(now - windowMs).toISOString().slice(0, 10);
  const inWindow = rows.filter((r) => r.day >= cutoffDay);
  if (!inWindow.length) return null;
  const windowDays = Math.round(windowMs / DAY);
  // an aggregate covering a fraction of the window answers a fraction of the
  // question — it is reported as insufficient rather than as a low number
  const enoughDays = inWindow.length >= Math.max(3, Math.ceil(windowDays * 0.5));
  const upMs = inWindow.reduce((n, r) => n + (r.upMs || 0), 0);
  const downMs = inWindow.reduce((n, r) => n + (r.downMs || 0), 0);
  const unknownMs = inWindow.reduce((n, r) => n + (r.unknownMs || 0), 0);
  const covered = upMs + downMs;
  return {
    windowMs,
    days: inWindow.length,
    source: 'daily roll-up',
    samples: inWindow.length,
    coveragePct: Math.round(pct(covered, windowMs) * 10) / 10,
    coveredMs: covered,
    unknownMs,
    uptimePct: covered > 0 ? Math.round((upMs / covered) * 1000) / 10 : null,
    upMs,
    downMs,
    failures: inWindow.reduce((n, r) => n + (r.outages || 0), 0),
    outages: [],
    longestOutageMs: null,
    mtbfMs: null,
    mttrMs: null,
    transitions: inWindow.reduce((n, r) => n + (r.transitions || 0), 0),
    insufficient: !enoughDays,
    note: `aggregated over ${inWindow.length} of ${windowDays} recorded day(s) — per-outage detail only exists for the last 7 days`,
    daysRecorded: inWindow.length,
    daysInWindow: windowDays,
  };
}

function reliabilityFor(appName, { windows = [DAY, 7 * DAY, 30 * DAY] } = {}) {
  const samples = healthSeries(appName);
  const rollup = readDailyRollup(appName);
  const out = { app: appName, samples: samples.length, firstAt: samples.length ? new Date(samples[0].at).toISOString() : null, lastAt: samples.length ? new Date(samples[samples.length - 1].at).toISOString() : null, rollupDays: rollup.length, windows: [] };
  for (const w of windows) {
    const label = w === DAY ? '24h' : w === 7 * DAY ? '7d' : w === 30 * DAY ? '30d' : Math.round(w / DAY) + 'd';
    const raw = reliabilityFrom(samples, { windowMs: w });
    // beyond what the raw series can still cover, the roll-up answers — and
    // the result says so, with the number of days it actually aggregates
    // the roll-up answers only when it can actually cover the window; a
    // two-day aggregate must never be printed as a 30-day rate
    const rolled = (raw.coveragePct != null && raw.coveragePct < 60) ? reliabilityFromRollup(rollup, { windowMs: w }) : null;
    const fromRollup = rolled && !rolled.insufficient ? rolled : null;
    const merged = fromRollup || raw;
    if (!fromRollup && raw.coveragePct != null && raw.coveragePct < 95) {
      merged.note = `${raw.note} · the raw history only reaches back ${Math.round(raw.coveragePct)}% of this window` +
        (rollup.length ? '' : ' — the daily roll-up fills the rest in as days accumulate');
    }
    out.windows.push({ label, ...merged, rawCoveragePct: raw.coveragePct });
  }
  return out;
}

// ── 2 · DETECT ─────────────────────────────────────────────────────────────
// Every detector returns null rather than a guess when it has too little data.

// 2a · flapping: a healthy app changes state a couple of times a day. The
// deploy hook itself treats "died within 6 s" as a failed deploy, so anything
// in the multiple-per-hour range is a crash loop, not noise.
function detectFlapping(appName, rawSamples, { now = Date.now(), explained = [] } = {}) {
  const samples = normalizeSamples(rawSamples);
  const recent = samples.filter((s) => s.at >= now - HOUR);
  if (recent.length < 10) return null;
  const seg = segmentSeries(recent, { now });
  if (seg.transitions < 4) return null;
  // a deploy or a deliberate restart flips the series by design — those
  // transitions are the machine's doing, not the app's, and must not be
  // counted against it (they still appear in the timeline, where they belong)
  const explainedCount = seg.intervals.filter((iv) => iv.up !== (seg.intervals[seg.intervals.indexOf(iv) - 1] || iv).up
    && explained.some((t) => Math.abs(t - iv.from) <= 3 * 60 * 1000)).length;
  const unexplained = Math.max(0, seg.transitions - explainedCount);
  if (unexplained < 4) return null;
  return {
    id: 'flapping:' + appName,
    kind: 'flapping',
    severity: unexplained >= 8 ? 'high' : 'medium',
    app: appName,
    title: `${appName} changed state ${unexplained}× in the last hour on its own`,
    detail: 'It is crashing and coming back in a loop. The helper agents back off automatically, but nothing on the machine can fix a start command that only sometimes works.',
    evidence: { transitions: unexplained, explainedByDeploys: explainedCount, samples: recent.length, window: '1h' },
    action: { label: 'open the log', kind: 'log', app: appName },
    samples: recent.length,
  };
}

// 2b · time-of-day clustering: are the failures random, or do they live in a
// particular window? Binomial tail against a uniform day; with a small number
// of failures this must stay quiet, so it needs 5+ failures and p < 0.05.
function normalCdf(z) {
  // Abramowitz & Stegun 7.1.26 — plenty for a tail test
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function detectHourClustering(appName, rawSamples, { now = Date.now(), days = 7 } = {}) {
  const samples = normalizeSamples(rawSamples);
  const window = samples.filter((s) => s.at >= now - days * DAY);
  const seg = segmentSeries(window, { now });
  const starts = seg.outages.map((o) => o.from);
  if (starts.length < 5) return null;
  const byHour = new Array(24).fill(0);
  for (const t of starts) byHour[new Date(t).getHours()]++;
  // best 3-hour bucket
  let best = { hour: 0, count: 0 };
  for (let h = 0; h < 24; h++) {
    const c = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24];
    if (c > best.count) best = { hour: h, count: c };
  }
  const n = starts.length;
  const p = 3 / 24;
  const expected = n * p;
  const sd = Math.sqrt(n * p * (1 - p));
  if (sd <= 0) return null;
  const z = (best.count - 0.5 - expected) / sd; // continuity correction
  const pValue = 1 - normalCdf(z);
  if (pValue >= 0.05 || best.count / n < 0.4) return null;
  const hh = (h) => String(h).padStart(2, '0') + ':00';
  return {
    id: 'hour-cluster:' + appName,
    kind: 'hour-cluster',
    severity: pValue < 0.01 ? 'high' : 'medium',
    app: appName,
    title: `${best.count} of ${n} failures start between ${hh(best.hour)} and ${hh((best.hour + 3) % 24)}`,
    detail: 'That is not random: something on a schedule (a cron job, a backup, a nightly process, a certificate renewal) is very likely involved. Set a maintenance window so the agents stop guessing, or move the culprit.',
    evidence: { failures: n, inWindow: best.count, window: `${days}d`, windowStartHour: best.hour, pValue: Math.round(pValue * 1000) / 1000 },
    action: { label: 'set a maintenance window', kind: 'policy', app: appName },
    samples: window.length,
  };
}

// 2c · linear trend with a forecast — used for RSS (leak) and free disk.
// Least squares on the samples, residual sigma for the confidence band, then
// "when does it cross the limit at this rate". Requires a real spread of time
// and a slope that beats its own standard error (t > 2).
function linearTrend(points) {
  const n = points.length;
  if (n < 8) return null;
  const meanT = mean(points.map((p) => p.t));
  const meanV = mean(points.map((p) => p.v));
  let sxx = 0, sxy = 0;
  for (const p of points) { sxx += (p.t - meanT) ** 2; sxy += (p.t - meanT) * (p.v - meanV); }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;             // units per ms
  const intercept = meanV - slope * meanT;
  let ss = 0;
  for (const p of points) { const fit = intercept + slope * p.t; ss += (p.v - fit) ** 2; }
  const sigma = Math.sqrt(ss / Math.max(1, n - 2));
  const seSlope = sigma / Math.sqrt(sxx);
  // a PERFECTLY linear series has zero residual sigma, which makes the t
  // statistic 0/0 — that is maximum significance, not none (an exact integer
  // leak was being rejected before this)
  const t = seSlope > 0 ? slope / seSlope : (slope === 0 ? 0 : Infinity);
  return { n, slope, intercept, sigma, seSlope, t, meanV, meanT, spanMs: points[n - 1].t - points[0].t };
}

function detectResourceTrend(appName, series, { label, unit, limit, inverse = false, minSamples = 12 } = {}) {
  const pts = series
    .filter((s) => typeof s.v === 'number' && Number.isFinite(s.v))
    .map((s) => ({ t: typeof s.at === 'number' ? s.at : new Date(s.at).getTime(), v: s.v }))
    .filter((p) => Number.isFinite(p.t));
  if (pts.length < minSamples) return null;
  const fit = linearTrend(pts);
  if (!fit) return null;
  const perDay = fit.slope * DAY;
  const significant = Math.abs(fit.t) >= 2;
  if (!significant || Math.abs(perDay) < 1) return null;
  const movingToward = inverse ? perDay < 0 : perDay > 0;
  if (!movingToward) return null;
  const current = pts[pts.length - 1].v;
  const msToLimit = limit != null && fit.slope !== 0 ? (limit - current) / fit.slope : Infinity;
  const within = Number.isFinite(msToLimit) && msToLimit > 0 ? msToLimit : null;
  // no configured limit (memory has none by default): the honest statement is
  // the RATE and how long the value takes to double, never a made-up ceiling
  const msToDouble = limit == null && fit.slope > 0 && current > 0 ? (current / fit.slope) : null;
  const rate = `${perDay > 0 ? '+' : ''}${Math.round(perDay * 10) / 10} ${unit}/day`;
  return {
    id: `${label}:${appName}`,
    kind: 'resource-trend',
    severity: within && within < 3 * DAY ? 'high' : 'medium',
    app: appName,
    title: within
      ? `${appName}: ${label} is ${perDay > 0 ? 'growing' : 'shrinking'} ${rate.replace('+', '')} — reaches ${limit} ${unit} in about ${Math.max(1, Math.round(within / DAY))} day(s)`
      : (msToDouble
        ? `${appName}: ${label} is growing ${rate.replace('+', '')} (now ${Math.round(current)} ${unit}) — it doubles in about ${Math.max(1, Math.round(msToDouble / DAY))} day(s)`
        : `${appName}: ${label} is trending ${rate} (now ${Math.round(current)} ${unit})`),
    detail: within
      ? 'This is a straight-line fit over the recorded samples, not a guess about causes. A steadily growing memory number usually means a leak; a shrinking disk number means something is filling it.'
      : (msToDouble
        ? 'A straight-line fit over the recorded samples beats its own margin of error, so the growth is real. Nothing is broken yet — this is a warning about a direction, with the sample count shown so you can judge it.'
        : 'The trend is real (it beats its own margin of error) but it has not crossed the limit yet.'),
    evidence: { samples: fit.n, spanHours: Math.round((fit.spanMs / HOUR) * 10) / 10, ratePerDay: Math.round(perDay * 100) / 100, current: Math.round(current), t: Math.round(fit.t * 10) / 10, limit: limit == null ? null : limit, doublesInDays: msToDouble ? Math.round(msToDouble / DAY) : null },
    action: { label: 'open the app', kind: 'app', app: appName },
    samples: fit.n,
  };
}

// 2d · deploy streak
function detectDeployStreak(appName, history) {
  const rows = history.filter((h) => h && h.outcome);
  const last = rows.slice(-3);
  if (last.length < 3 || last.some((h) => h.outcome === 'success')) return null;
  return {
    id: 'deploy-streak:' + appName,
    kind: 'deploy-streak',
    severity: 'high',
    app: appName,
    title: `${appName}: the last 3 deploys failed`,
    detail: 'The previous version is still serving, so nothing is down — but shipping is blocked. Fix the build, or roll back deliberately.',
    evidence: { failures: last.length, lastAt: last[last.length - 1].at || null },
    action: { label: 'open the app', kind: 'app', app: appName },
    samples: rows.length,
  };
}

// 2e · backup staleness (per app), plus "never backed up"
function detectBackupGap(appName, rows) {
  if (!rows.length) return null;
  const newest = rows[rows.length - 1];
  const age = Date.now() - new Date(newest.at || 0).getTime();
  if (age <= 48 * HOUR) return null;
  const verified = rows.some((r) => r.verify === true);
  return {
    id: 'backup-stale:' + appName,
    kind: 'backup-stale',
    severity: age > 7 * DAY ? 'high' : 'medium',
    app: appName,
    title: `${appName}: newest backup is ${Math.round(age / DAY)} day(s) old`,
    detail: verified ? 'A verified snapshot exists, but it is no longer recent — a restore would lose everything since then.' : 'No snapshot of this app has ever been restore-verified.',
    evidence: { snapshots: rows.length, newestAt: newest.at || null, verifiedEver: verified },
    action: { label: 'back up now', kind: 'backup', app: appName },
    samples: rows.length,
  };
}

// 2f · what changed? An outage that starts minutes after a deploy is the
// single most useful correlation this machine can make, because the fix is
// known (roll back) and the evidence is a commit hash.
function detectDeployCorrelation(appName, rawSamples, history, { now = Date.now(), windowMs = 7 * DAY, slackMs = 15 * 60 * 1000 } = {}) {
  const deploys = history.filter((h) => h && h.at && h.commit);
  if (!deploys.length) return null;
  const samples = normalizeSamples(rawSamples);
  const seg = segmentSeries(samples.filter((s) => s.at >= now - windowMs), { now });
  // an outage that is STILL OPEN after a deploy is the most useful case of
  // all, so ongoing outages are included, not filtered out
  const outages = seg.outages;
  if (!outages.length) return null;
  const last = outages[outages.length - 1];
  const prior = deploys.filter((d) => new Date(d.at).getTime() <= last.from);
  if (!prior.length) return null;
  const dep = prior[prior.length - 1];
  const delta = last.from - new Date(dep.at).getTime();
  if (delta < 0 || delta > slackMs) return null;
  const failures = prior.filter((d) => d.outcome !== 'success').length;
  return {
    id: 'deploy-correlation:' + appName,
    kind: 'deploy-correlation',
    severity: 'high',
    app: appName,
    title: `${appName} went down ${Math.max(1, Math.round(delta / 60000))} min after deploy ${String(dep.commit).slice(0, 8)}`,
    detail: dep.outcome === 'success'
      ? 'The deploy itself reported success and the app went down right after it — the new code is the first thing to look at, and rolling back is the fastest way back to a working app.'
      : `That deploy reported "${dep.outcome}" and the app has not recovered since. Rolling back to the previous commit is the deliberate next step.`,
    evidence: { commit: dep.commit, deployedAt: dep.at, outcome: dep.outcome || null, outageFrom: new Date(last.from).toISOString(), minutesAfter: Math.round(delta / 60000), failedDeploysRecently: failures },
    action: { label: 'roll back this app', kind: 'rollback', app: appName },
    samples: deploys.length,
  };
}

// 2g · the app's own words. When a verified repair failed, its receipt holds
// the last real error line from the app's log — surface it as an insight so
// the reason is visible without opening anything.
function detectCannotStart(appName, agentRows, { now = Date.now(), windowMs = 24 * HOUR } = {}) {
  const rows = agentRows.filter((r) => r.agent === 'repair' && r.app === appName && r.ok === false && new Date(r.at || 0).getTime() >= now - windowMs);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const backoff = backoffFor(appName);
  return {
    id: 'cannot-start:' + appName,
    kind: 'cannot-start',
    severity: 'high',
    app: appName,
    title: `${appName} is down and restarting did not fix it (${rows.length} attempt(s) in 24h)`,
    detail: `${last.detail ? 'The app says: ' + redact.redactSecrets(last.detail) + '. ' : ''}Restarting will not fix this one — something in the start path has to change.` +
      (backoff.failures ? ` The agents are backing off: next attempt no sooner than ${new Date(backoff.nextAllowedAt).toISOString()}.` : ''),
    evidence: { attempts: rows.length, lastAt: last.at, logLine: last.detail || null, consecutiveFailures: backoff.failures, nextAllowedAt: backoff.nextAllowedAt || null },
    action: { label: 'open the log', kind: 'log', app: appName },
    samples: rows.length,
  };
}

// 2h · certificate lead time
function detectCertExpiry(certs, { now = Date.now() } = {}) {
  const out = [];
  for (const c of certs || []) {
    if (typeof c.daysLeft !== 'number') continue;
    // lead time is a FRACTION of this certificate's own lifetime, not a fixed
    // two weeks: CA lifetimes are shrinking (200 days from 2026-03, 100 from
    // 2027-03, 47 from 2029), and 14 days of a 47-day certificate is a third
    // of its life — far too late to be a warning
    const lifetime = typeof c.lifetimeDays === 'number' && c.lifetimeDays > 0 ? c.lifetimeDays : 90;
    // never less than two weeks (renewal here is a manual step) and never more
    // than a month; longer-lived certificates earn the longer warning, which is
    // what the old fixed 14 days got wrong for 200/400-day certificates
    const lead = Math.max(14, Math.min(30, Math.round(lifetime * 0.15)));
    if (c.daysLeft > lead) continue;
    out.push({
      id: 'cert-expiry:' + (c.domain || c.file || '?'),
      kind: 'cert-expiry',
      severity: c.daysLeft <= Math.max(1, Math.round(lead / 3)) ? 'high' : 'medium',
      app: null,
      title: `${c.domain || c.file}: certificate expires in ${c.daysLeft} day(s) (of a ${lifetime}-day lifetime — renewal lead is ${lead})`,
      detail: 'Renewal is one button in naming (or one CLI command). A wildcard certificate needs its zone token; a public one needs the challenge to be reachable.',
      evidence: { domain: c.domain || null, daysLeft: c.daysLeft, lifetimeDays: lifetime, leadDays: lead, kindOfCert: c.kind || null },
      action: { label: 'renew it', kind: 'certs' },
      samples: 1,
    });
  }
  return out;
}

// log lines and event details are quoted into the timeline, the digest and
// the UI: strip control characters and newlines first (log-injection hygiene —
// OWASP Logging Cheat Sheet: data must be sanitized before it is rendered)
function oneLine(s, max = 240) {
  return String(s == null ? '' : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

// ── 3 · SCORE ──────────────────────────────────────────────────────────────
// A weighted sum, but the weights and the raw value of every factor travel
// with the number — a bare score is exactly the kind of thing that misleads.
// A factor with no data is EXCLUDED and its weight redistributed, and the
// caller is told which ones were excluded.
// Weights are visible to the owner in the UI, and `now` exists because a
// 95%-uptime average must never paper over an app that is down THIS MINUTE.
const SCORE_FACTORS = [
  { key: 'now', label: 'up right now', weight: 15 },
  { key: 'availability', label: 'availability (24h)', weight: 25 },
  { key: 'backups', label: 'backups fresh + verified', weight: 20 },
  { key: 'deploys', label: 'deploys succeeding', weight: 15 },
  { key: 'integrity', label: 'install integrity', weight: 10 },
  { key: 'headroom', label: 'disk headroom', weight: 10 },
  { key: 'certs', label: 'certificates valid', weight: 5 },
];

function band(score) {
  if (score == null) return 'unknown';
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'healthy';
  if (score >= 55) return 'degraded';
  if (score >= 30) return 'poor';
  return 'critical';
}

function computeScore(facts) {
  // facts: { apps: [{name, uptimePct, insufficient, deploys:{ok,total}, backedUp, backupVerified}], integrityOk, certs:[{daysLeft}], diskFreeMb, diskTotalMb }
  const factors = [];
  // `value` stays a raw 0..1 ratio (that is what the weighted mean needs) and
  // `pct` is the same number rendered for humans. Mixing the two scales here
  // produced a score of 6767/100 the first time this ran — the display scale
  // leaked into the arithmetic.
  const push = (key, value, detail, samples) => {
    const def = SCORE_FACTORS.find((f) => f.key === key);
    factors.push({
      key,
      label: def.label,
      weight: def.weight,
      value: value == null ? null : Math.round(value * 1000) / 1000,
      pct: value == null ? null : Math.round(value * 1000) / 10,
      detail,
      samples,
    });
  };

  // 1 · right now. A down app is a fact, not a statistic, so it is its own
  // factor and it cannot be averaged away.
  const supervised = (facts.apps || []).filter((a) => a.supervised !== false);
  if (supervised.length) {
    const down = supervised.filter((a) => a.upNow === false);
    // the machine area never prints an app's name (two-area law): the finding
    // is a count and a duration here, and the app's own card carries the name
    const longest = down.reduce((n, a) => Math.max(n, a.downForMs || 0), 0);
    push('now', down.length ? 0 : 1,
      down.length
        ? `${down.length} of ${supervised.length} app(s) down${longest ? ` — the longest for ${fmtDur(longest)}` : ''} (which ones is on the projects board)`
        : `all ${supervised.length} app(s) answering`,
      supervised.length);
  } else push('now', null, 'no supervised apps on this machine', 0);

  // 2 · availability over the shortest window that has enough samples (24h
  // preferred — a long average hides a bad day)
  const rated = (facts.apps || []).filter((a) => typeof a.uptimePct === 'number' && !a.insufficient);
  const worst = rated.length ? rated.reduce((a, b) => (a.uptimePct <= b.uptimePct ? a : b)) : null;
  push('availability', rated.length ? mean(rated.map((a) => a.uptimePct)) / 100 : null,
    rated.length
      ? `${rated[0].availabilityWindow || '24h'} average over ${rated.length} app(s) with enough samples — lowest ${worst.uptimePct}% (named on the projects board)`
      : 'no app has enough samples yet to claim a rate',
    rated.length);

  const appsWithBackupFacts = (facts.apps || []).filter((a) => a.backupKnown);
  if (appsWithBackupFacts.length) {
    const good = appsWithBackupFacts.filter((a) => a.backedUp && a.backupVerified).length;
    push('backups', good / appsWithBackupFacts.length, `${good} of ${appsWithBackupFacts.length} app(s) fresh + restore-verified`, appsWithBackupFacts.length);
  } else push('backups', null, 'no backup history yet', 0);

  const deployRows = (facts.apps || []).filter((a) => a.deploys && a.deploys.total > 0);
  if (deployRows.length) {
    const ok = deployRows.reduce((n, a) => n + a.deploys.ok, 0);
    const total = deployRows.reduce((n, a) => n + a.deploys.total, 0);
    push('deploys', ok / total, `${ok} of ${total} recorded deploys succeeded`, total);
  } else push('deploys', null, 'no deploys recorded yet', 0);

  push('integrity', typeof facts.integrityOk === 'boolean' ? (facts.integrityOk ? 1 : 0) : null,
    typeof facts.integrityOk === 'boolean' ? (facts.integrityOk ? 'every shipped file matches the manifest' : 'files differ from the signed manifest') : 'integrity not checked');

  if (Array.isArray(facts.certs) && facts.certs.length) {
    const worst = facts.certs.reduce((a, c) => Math.min(a, typeof c.daysLeft === 'number' ? c.daysLeft : 999), 999);
    const value = worst >= 30 ? 1 : worst <= 0 ? 0 : worst / 30;
    push('certs', value, `soonest expiry: ${worst === 999 ? 'n/a' : worst + ' day(s)'}`, facts.certs.length);
  } else push('certs', null, 'no certificates on this machine', 0);

  if (typeof facts.diskFreeMb === 'number' && typeof facts.diskTotalMb === 'number' && facts.diskTotalMb > 0) {
    const frac = facts.diskFreeMb / facts.diskTotalMb;
    const value = Math.max(0, Math.min(1, (frac - 0.02) / 0.18)); // full marks at 20% free, zero at 2%
    push('headroom', value, `${facts.diskFreeMb} MB free of ${Math.round(facts.diskTotalMb)} MB`, 1);
  } else push('headroom', null, 'disk size unknown', 0);

  const usable = factors.filter((f) => f.value != null);
  const totalWeight = usable.reduce((n, f) => n + f.weight, 0);
  // weighted mean of the raw 0..1 ratios, then scaled to 0..100 once
  const weighted = usable.reduce((n, f) => n + f.weight * f.value, 0);
  const score = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) : null;
  const lost = factors.filter((f) => f.value == null).map((f) => f.key);
  return {
    score,
    band: band(score),
    factors,
    excluded: lost,
    formula: totalWeight > 0 ? `weighted mean of ${usable.length} factor(s), weights renormalised to ${totalWeight} (of ${SCORE_FACTORS.reduce((n, f) => n + f.weight, 0)})` : 'no factor had enough data to score',
  };
}

// ── 4 · TIMELINE ───────────────────────────────────────────────────────────
// One merged, newest-first story of the machine, built from ledgers that
// already exist on disk. Nothing new is recorded to produce it: if it is not
// in a receipt somewhere, it did not happen.
const SEVERITY_BY_KIND = {
  deploy: (r) => (r.outcome === 'success' ? 'ok' : 'bad'),
  backup: () => 'ok',
  'agent-repair': (d) => (d && d.ok === false ? 'bad' : 'ok'),
  'agent-diagnose': () => 'info',
  revive: () => 'warn',
  'deploy-failed': () => 'bad',
  'manifest-denied': () => 'bad',
  'closure-denied': () => 'bad',
  dns: () => 'info',
  login: () => 'info',
  'login-fail': () => 'warn',
  'sessions-pruned': () => 'info',
  cron: () => 'info',
  maintenance: () => 'info',
  policy: () => 'info',
  insight: () => 'warn',
};

function timelineFor({ app = null, limit = 200, sinceMs = 7 * DAY, kinds = null } = {}) {
  const cutoff = Date.now() - sinceMs;
  const rows = [];
  const add = (at, kind, title, detail, extra) => {
    const t = new Date(at || 0).getTime();
    if (!Number.isFinite(t) || t < cutoff) return;
    if (kinds && !kinds.includes(kind)) return;
    const r = {
      at: new Date(t).toISOString(),
      kind,
      title: redact.redactSecrets(title),
      detail: detail ? redact.redactSecrets(String(detail)) : null,
      severity: typeof SEVERITY_BY_KIND[kind] === 'function' ? SEVERITY_BY_KIND[kind](extra || {}) : 'info',
      ...(extra || {}),
    };
    r.id = `${kind}:${r.at}:${r.app || ''}`;
    rows.push(r);
  };

  // the per-app ledgers are read FIRST so deploy events arriving from the
  // audit log can be de-duplicated against them (one deploy = one line in the
  // timeline, never two)
  const apps = app ? [app] : listAppsSafe();
  const deployKeys = new Set();
  const historyRows = [];
  for (const name of apps) {
    const rp = runPathOf(name);
    for (const h of readJsonl(path.join(rp, 'deploy-history.jsonl'), 400)) {
      if (h && h.commit) deployKeys.add(name + ':' + String(h.commit).slice(0, 8));
      historyRows.push({ name, h });
    }
  }

  // machine events (everything the audit ledger knows)
  for (const e of readJsonl(path.join(HOME, 'events.log'), 2000)) {
    const d = e.detail || {};
    const kindMap = { deploy: 'deploy', backup: 'backup', 'agent-repair': 'agent-repair', 'agent-diagnose': 'agent-diagnose', revive: 'revive', 'login-fail': 'login-fail', login: 'login', 'dns-publish': 'dns', 'dns-delete': 'dns', 'sessions-pruned': 'sessions-pruned', cron: 'cron', policy: 'policy' };
    const kind = kindMap[e.kind] || e.kind;
    if (app && d.app !== app) continue;
    const dupKey = d.app && d.commit ? d.app + ':' + String(d.commit).slice(0, 8) : null;
    if (dupKey && deployKeys.has(dupKey)) continue; // already in the timeline from history
    let title = e.kind;
    if (kind === 'agent-repair') title = d.ok === false ? `repair failed on ${d.app}` : `repaired ${d.app}`;
    else if (kind === 'agent-diagnose') title = `diagnosed ${d.app}`;
    else if (kind === 'deploy') title = `deployed ${d.app || ''}`.trim();
    else if (kind === 'backup') title = `backed up ${d.app || 'everything'}`;
    else if (kind === 'dns') title = `DNS ${String(e.kind).replace('dns-', '')} ${d.name || d.domain || ''}`.trim();
    else if (kind === 'sessions-pruned') title = `pruned ${d.pruned} expired session(s)`;
    add(e.at, kind, title, d.reason || d.detail || null, { app: d.app || null, ok: d.ok, reason: d.reason || null, source: 'events' });
  }

  // per-app deploy + backup history (the detailed receipts)
  for (const { name, h } of historyRows) {
    add(h.at, 'deploy', `${name}: deploy ${h.outcome || 'recorded'}`, (h.commit ? `commit ${String(h.commit).slice(0, 8)}` : null) + (h.reason ? ' · ' + String(h.reason).slice(0, 120) : ''), { app: name, commit: h.commit || null, outcome: h.outcome || null, source: 'deploy-history' });
  }
  for (const name of apps) {
    const rp = runPathOf(name);
    for (const b of readJsonl(path.join(rp, 'backup-history.jsonl'), 200)) {
      add(b.at, 'backup', `${name}: snapshot ${String(b.snapshot || '').slice(0, 8) || 'taken'}`, b.verify === true ? 'restore-verified' : (b.note || null), { app: name, snapshot: b.snapshot || null, verified: b.verify === true, source: 'backup-history' });
    }
  }

  // detached jobs (backups, checks, updates, scheduled tasks). The ledger
  // writes a start line and an end line per id, so they are merged back into
  // one entry here — and an app named inside a label ("backup <app>") is
  // attributed to that app instead of leaking into the machine's own story.
  const jobById = new Map();
  for (const j of readJsonl(path.join(HOME, 'jobs.jsonl'), 600)) {
    const id = j.id || '(no id)';
    const cur = jobById.get(id) || {};
    const merged = { ...cur };
    for (const [k, v] of Object.entries(j)) { if (v !== null && v !== undefined) merged[k] = v; }
    merged.startedAt = cur.startedAt || j.startedAt || null;
    merged.endedAt = j.endedAt || cur.endedAt || null;
    if (j.ok !== undefined) merged.ok = j.ok;
    jobById.set(id, merged);
  }
  for (const j of jobById.values()) {
    const label = j.label || j.kind || 'job';
    const named = apps.find((a) => label.includes(a)) || null;
    const appOfJob = j.app || named || null;
    if (app && appOfJob !== app) continue;
    // when it is attributed to an app, the label loses the app's name (the
    // two-area law: a machine surface never prints an app's name)
    const shown = named ? label.replace(named, '').replace(/\s{2,}/g, ' ').trim() || 'job' : label;
    add(j.endedAt || j.startedAt, 'job', `${shown} ${j.ok === false ? 'failed' : j.endedAt ? 'finished' : 'running'}`, j.note || null, { app: appOfJob, ok: j.ok, kindOfJob: j.kind || null, source: 'jobs' });
  }

  return rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}

function listAppsSafe() {
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(HOME, 'apps.json'), 'utf8'))); } catch { return []; }
}

// ── 5 · POLICIES ───────────────────────────────────────────────────────────
// The owner's rules for what the helper agents may do, per app. Stored as a
// plain file so it is inspectable, diffable and restorable with the rest of
// the control plane's memory.
const POLICY_MODES = ['off', 'watch', 'repair'];
const DEFAULT_POLICY = {
  mode: 'repair',            // off = hands off · watch = diagnose + recommend only · repair = restart
  notify: true,              // record a notifiable event when an agent acts
  maintenance: [],           // [{ days: [0-6], from: 'HH:MM', to: 'HH:MM' }] — no repair inside these
  maxActionsPerHour: 4,      // per app, counted from the agent ledger
};

function loadPolicies() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(POLICIES, 'utf8')); } catch { /* defaults */ }
  return {
    default: { ...DEFAULT_POLICY, ...(raw.default || {}) },
    apps: raw.apps || {},
    updatedAt: raw.updatedAt || null,
  };
}

function policyFor(name, policies = loadPolicies()) {
  const p = { ...policies.default, ...((policies.apps || {})[name] || {}) };
  p.mode = POLICY_MODES.includes(p.mode) ? p.mode : DEFAULT_POLICY.mode;
  p.maintenance = Array.isArray(p.maintenance) ? p.maintenance : [];
  p.maxActionsPerHour = Number.isFinite(Number(p.maxActionsPerHour)) ? Number(p.maxActionsPerHour) : DEFAULT_POLICY.maxActionsPerHour;
  return p;
}

function savePolicies(next) {
  const payload = { default: { ...DEFAULT_POLICY, ...(next.default || {}) }, apps: next.apps || {}, updatedAt: new Date().toISOString() };
  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  fs.writeFileSync(POLICIES, JSON.stringify(payload, null, 2));
  return payload;
}

// is `now` inside a maintenance window for this app?
function inMaintenance(policy, now = new Date()) {
  for (const w of policy.maintenance || []) {
    const days = Array.isArray(w.days) && w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
    if (!days.includes(now.getDay())) continue;
    const [fh, fm] = String(w.from || '00:00').split(':').map(Number);
    const [th, tm] = String(w.to || '23:59').split(':').map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const from = (fh || 0) * 60 + (fm || 0);
    const to = (th || 0) * 60 + (tm || 0);
    if (from <= to ? cur >= from && cur <= to : cur >= from || cur <= to) return w; // windows may wrap midnight
  }
  return null;
}

// ── 6 · ADAPTIVE BACKOFF ───────────────────────────────────────────────────
// A restart that failed last time will very likely fail again, so hammering it
// every cooldown is noise. Each consecutive failure doubles the wait; the
// schedule is printed in the receipt so the behaviour is never a mystery.
const BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, HOUR, 6 * HOUR];

function loadAgentState() {
  try { return JSON.parse(fs.readFileSync(AGENT_STATE, 'utf8')); } catch { return { apps: {} }; }
}

function saveAgentState(state) {
  try {
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    fs.writeFileSync(AGENT_STATE, JSON.stringify(state, null, 2));
  } catch { /* agent state must never break a pass */ }
  return state;
}

function backoffFor(name, state = loadAgentState(), now = Date.now()) {
  const row = (state.apps || {})[name] || {};
  const failures = Number(row.consecutiveFailures) || 0;
  const until = Number(row.nextAllowedAt) || 0;
  const waitMs = failures > 0 ? BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)] : 0;
  return { failures, nextAllowedAt: until, blocked: until > now, waitMs, schedule: BACKOFF_MS };
}

function noteRepairResult(name, ok, { state = loadAgentState(), now = Date.now() } = {}) {
  const apps = { ...(state.apps || {}) };
  const row = { ...(apps[name] || {}) };
  if (ok) {
    row.consecutiveFailures = 0;
    row.nextAllowedAt = 0;
    delete row.escalated; // the app is back: the escalation is history
    row.lastOkAt = new Date(now).toISOString();
  } else {
    row.consecutiveFailures = (Number(row.consecutiveFailures) || 0) + 1;
    const base = BACKOFF_MS[Math.min(row.consecutiveFailures - 1, BACKOFF_MS.length - 1)];
    // ±10% jitter: without it, every app on a machine retries in lockstep
    const wait = Math.round(base * (0.9 + Math.random() * 0.2));
    row.nextAllowedAt = now + wait;
    row.lastFailAt = new Date(now).toISOString();
    row.lastWaitMs = wait;
    // from the third consecutive failure the waiting is no longer the story —
    // the app needs a human, and the receipt says so
    if (row.consecutiveFailures >= 3) row.escalated = true;
  }
  apps[name] = row;
  const next = { ...state, apps, updatedAt: new Date(now).toISOString() };
  saveAgentState(next);
  return row;
}

// a new deploy changes the code, so a stale backoff must not keep the agents
// away from an app that may now work
function clearBackoff(name, { state = loadAgentState() } = {}) {
  const apps = { ...(state.apps || {}) };
  delete apps[name];
  return saveAgentState({ ...state, apps, updatedAt: new Date().toISOString() });
}

// ── 7 · INSIGHTS (all detectors, one call) ─────────────────────────────────
function insightEngine(facts) {
  const out = [];
  const { apps = [], deployHistory = {}, backupHistory = {}, statsHistory = {}, certs = [], now = Date.now(), explainedFor = null } = facts;
  for (const a of apps) {
    const samples = a.samples || [];
    const flap = detectFlapping(a.name, samples, { now, explained: explainedFor ? explainedFor(a.name) : [] });
    if (flap) out.push(flap);
    const cluster = detectHourClustering(a.name, samples, { now });
    if (cluster) out.push(cluster);
    const streak = detectDeployStreak(a.name, deployHistory[a.name] || []);
    if (streak) out.push(streak);
    const stale = detectBackupGap(a.name, backupHistory[a.name] || []);
    if (stale) out.push(stale);
    const correlation = detectDeployCorrelation(a.name, samples, deployHistory[a.name] || [], { now });
    if (correlation) out.push(correlation);
    const cannotStart = detectCannotStart(a.name, facts.agentRows || [], { now });
    if (cannotStart) out.push(cannotStart);
    const stats = (statsHistory[a.name] || []).map((s) => ({ at: s.at, v: s.rssMb }));
    const leak = detectResourceTrend(a.name, stats, { label: 'memory', unit: 'MB', limit: a.memoryLimitMb || null });
    if (leak) out.push(leak);
    const diskSeries = (statsHistory[a.name] || []).filter((s) => typeof s.diskFreeMb === 'number').map((s) => ({ at: s.at, v: s.diskFreeMb }));
    const disk = detectResourceTrend(a.name, diskSeries, { label: 'free disk', unit: 'MB', limit: 512, inverse: true, minSamples: 24 });
    if (disk) out.push(disk);
  }
  for (const c of detectCertExpiry(certs, { now })) out.push(c);
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(a.title).localeCompare(String(b.title)));
}

// ── 8 · DIGEST ─────────────────────────────────────────────────────────────
// The weekly report: what happened, what it cost, what changed, what to look
// at. Markdown so it can be pasted anywhere, and every number is traceable to
// a ledger on this machine.
function digestData({ days = 7, now = Date.now(), redact: doRedact = false } = {}) {
  const since = now - days * DAY;
  const apps = listAppsSafe();
  const perApp = [];
  const deployHistory = {};
  const backupHistory = {};
  for (const name of apps) {
    const rp = runPathOf(name);
    const samples = healthSeries(name);
    perApp.push({ name, samples, reliability: reliabilityFrom(samples, { windowMs: days * DAY, now }) });
    deployHistory[name] = readJsonl(path.join(rp, 'deploy-history.jsonl'), 400).filter((h) => new Date(h.at || 0).getTime() >= since);
    backupHistory[name] = readJsonl(path.join(rp, 'backup-history.jsonl'), 200);
  }
  const timeline = timelineFor({ sinceMs: days * DAY, limit: 500 });
  const incidents = [];
  for (const a of perApp) {
    for (const o of a.reliability.outages) incidents.push({ app: a.name, ...o });
  }
  incidents.sort((x, y) => (y.ms || 0) - (x.ms || 0));
  const deploys = timeline.filter((t) => t.kind === 'deploy');
  const agentRows = readJsonl(path.join(CONTROL_DIR, 'agent-actions.jsonl'), 400).filter((r) => new Date(r.at || 0).getTime() >= since);
  const lines = [];
  lines.push(`# gitlive report — last ${days} day(s)`);
  lines.push('');
  lines.push(`_generated ${new Date(now).toISOString()} from this machine's own ledgers_`);
  lines.push(doRedact
    ? '_identifiers masked (paths → ~, addresses → <address>, names → app-N): this copy is safe to post. `gitlive report --no-redact` prints the full one._'
    : '_unmasked copy — contains paths, addresses and names. Do not post this publicly._');
  lines.push('');
  lines.push('## Availability');
  if (!perApp.length) lines.push('- no apps registered on this machine.');
  for (const a of perApp) {
    const r = a.reliability;
    lines.push(`- **${a.name}** — ${r.insufficient ? 'not enough samples to claim a rate' : r.uptimePct + '% up'} ` +
      `(${r.samples} samples, ${Math.round((r.coveragePct || 0))}% of the window covered) · ${r.failures} outage(s)` +
      (r.longestOutageMs ? `, longest ${fmtDur(r.longestOutageMs)}` : '') +
      (r.mttrMs ? `, mean recovery ${fmtDur(r.mttrMs)}` : '') +
      (r.mtbfMs ? `, MTBF ${fmtDur(r.mtbfMs)}` : ''));
  }
  lines.push('');
  lines.push('## Incidents');
  if (!incidents.length) lines.push('- nothing went down in this window.');
  for (const i of incidents.slice(0, 12)) {
    lines.push(`- **${i.app}** down for ${fmtDur(i.ms || 0)}${i.ongoing ? ' (STILL DOWN)' : ''} — from ${i.from}`);
  }
  lines.push('');
  lines.push('## Deploys');
  lines.push(deploys.length ? deploys.slice(0, 12).map((d) => `- ${d.at} · ${d.title}${d.detail ? ' · ' + d.detail : ''}`).join('\n') : '- no deploys in this window.');
  lines.push('');
  lines.push('## Backups');
  for (const a of perApp) {
    const rows = backupHistory[a.name] || [];
    const newest = rows[rows.length - 1];
    const verified = rows.filter((r) => r.verify === true).length;
    lines.push(`- **${a.name}** — ${rows.length} snapshot(s), ${verified} restore-verified${newest ? `, newest ${newest.at}` : ' — never backed up'}`);
  }
  lines.push('');
  lines.push('## What the helpers did');
  if (!agentRows.length) lines.push('- the helper agents had nothing to do.');
  for (const r of agentRows.slice(-12)) {
    lines.push(oneLine(`- ${r.at} · ${r.agent} ${r.action}${r.app ? ' on ' + r.app : ''} — ${r.ok === false ? 'FAILED: ' : ''}${r.reason || ''}${r.detail ? ` (${r.detail})` : ''}`, 400));
  }
  lines.push('');
  lines.push('## Numbers this report is made of');
  lines.push('- health samples: `~/.gitlive/apps/<app>-run/health-history.jsonl` (1/minute)');
  lines.push('- deploys: `~/.gitlive/apps/<app>-run/deploy-history.jsonl`');
  lines.push('- backups: `~/.gitlive/apps/<app>-run/backup-history.jsonl`');
  lines.push('- agent actions: `~/.gitlive/control/agent-actions.jsonl`');
  lines.push('- audit events: `~/.gitlive/events.log`');
  const markdown = lines.join('\n');
  return {
    markdown: doRedact ? redact.shareable(markdown, { names: apps, home: os.homedir() }) : markdown,
    redacted: Boolean(doRedact),
    window: { days, since: new Date(since).toISOString(), until: new Date(now).toISOString() },
    apps: perApp.map((a) => ({ name: doRedact ? redact.shareable(a.name, { names: apps }) : a.name, reliability: a.reliability })),
    incidents: incidents.slice(0, 50),
  };
}

function fmtDur(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

// ── 9 · the whole picture in one call (the dashboard's front door) ─────────
function intelOverview(facts = {}) {
  const apps = facts.apps || listAppsSafe();
  const now = Date.now();
  const perApp = [];
  const deployHistory = {};
  const backupHistory = {};
  const statsHistory = {};
  for (const name of apps) {
    const rp = runPathOf(name);
    const samples = healthSeries(name);
    deployHistory[name] = readJsonl(path.join(rp, 'deploy-history.jsonl'), 200);
    backupHistory[name] = readJsonl(path.join(rp, 'backup-history.jsonl'), 100);
    statsHistory[name] = readJsonl(path.join(rp, 'stats-history.jsonl'), 2000);
    const rel = reliabilityFrom(samples, { windowMs: 7 * DAY, now });
    const day = reliabilityFrom(samples, { windowMs: DAY, now });
    // prefer the 24h window for the score; fall back to 7d when the machine
    // has not been sampling for a day yet, and SAY which one was used
    const chosen = day.insufficient ? rel : day;
    const chosenWindow = day.insufficient ? '7d' : '24h';
    const last = samples.length ? samples[samples.length - 1] : null;
    const downSince = last && !last.up ? segmentSeries(samples, { now }).outages.filter((o) => o.ongoing)[0] : null;
    const deploys = deployHistory[name].slice(-10);
    perApp.push({
      name,
      samples,
      reliability: rel,
      scoreFacts: {
        name,
        upNow: last ? last.up : null,
        downForMs: downSince ? now - downSince.from : 0,
        availabilityWindow: chosenWindow,
        uptimePct: chosen.uptimePct,
        insufficient: chosen.insufficient,
        deploys: { ok: deploys.filter((d) => d.outcome === 'success').length, total: deploys.length },
        backupKnown: backupHistory[name].length > 0,
        backedUp: backupHistory[name].length > 0 && (now - new Date(backupHistory[name][backupHistory[name].length - 1].at || 0).getTime()) < 48 * HOUR,
        backupVerified: backupHistory[name].some((b) => b.verify === true),
      },
    });
  }
  const score = computeScore({
    apps: perApp.map((a) => a.scoreFacts),
    integrityOk: typeof facts.integrityOk === 'boolean' ? facts.integrityOk : null,
    certs: facts.certs || [],
    diskFreeMb: facts.diskFreeMb,
    diskTotalMb: facts.diskTotalMb,
  });
  const insights = insightEngine({ apps: perApp, deployHistory, backupHistory, statsHistory, certs: facts.certs || [], agentRows: facts.agentRows || readJsonl(path.join(CONTROL_DIR, 'agent-actions.jsonl'), 400), now });
  return {
    at: new Date(now).toISOString(),
    version: facts.version || null,
    score,
    insights,
    apps: perApp.map((a) => ({
      name: a.name,
      samples: a.samples.length,
      lastAt: a.samples.length ? new Date(a.samples[a.samples.length - 1].at).toISOString() : null,
      reliability: a.reliability,
    })),
  };
}

module.exports = {
  // measurement
  healthSeries, normalizeSamples, segmentSeries, reliabilityFrom, reliabilityFor, runPathOf,
  foldByDay, readDailyRollup, dailyRollupPath, reliabilityFromRollup, ruleOfThreeFloor, recordSampleInRollup, oneLine,
  // detection
  detectFlapping, detectHourClustering, detectResourceTrend, detectDeployStreak, detectBackupGap, detectCertExpiry,
  detectDeployCorrelation, detectCannotStart,
  linearTrend, normalCdf, insightEngine,
  // scoring
  computeScore, band, SCORE_FACTORS,
  // memory
  timelineFor, digestData, fmtDur,
  // policy + backoff
  POLICY_MODES, DEFAULT_POLICY, loadPolicies, policyFor, savePolicies, inMaintenance,
  BACKOFF_MS, loadAgentState, saveAgentState, backoffFor, noteRepairResult, clearBackoff,
  // redaction (one implementation, shared with the server and the CLI)
  redact,
  // overview
  intelOverview,
  PATHS: { HOME, CONTROL_DIR, EVENTS_LOG, POLICIES, AGENT_STATE },
};
