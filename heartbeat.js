#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// heartbeat.js — an opt-in "is there a newer gitlive?" check (post-roadmap
// #3, the upgrade-fragility fear). The design line, held hard:
//   - it runs ONLY when the owner types it (or schedules it) — nothing
//     automatic, ever;
//   - it sends ONE query to the npm registry for the package's latest
//     version — a public registry lookup, not telemetry: nothing about
//     this machine, its apps, or its owner is transmitted;
//   - the check endpoint is overridable (GITLIVE_HEARTBEAT_URL) so tests
//     and private mirrors never touch the public registry.
//
// The dashboard shows nothing automatic either — the owner decides when
// the machine may phone home, even for a version number.

const { spawnSync } = require('child_process');

const VERSION = (() => { try { return require('./gitlive.js').VERSION; } catch { return '2.6.1'; } })();
const DEFAULT_URL = 'https://registry.npmjs.org/gitlive/latest';

function fetchVersion(url) {
  // zero-dependency fetch via the runtime the CLI already requires;
  // node 22+ has global fetch, but spawnSync keeps this module boring.
  const r = spawnSync('node', ['-e', `
    fetch(${JSON.stringify(url)}, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      .then(async (res) => {
        if (!res.ok) process.exit(2);
        const j = await res.json();
        console.log(j.version || '');
      })
      .catch(() => process.exit(3));
  `], { encoding: 'utf8', timeout: 12000 });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function compare(v1, v2) {
  const a = String(v1).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(v2).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
  }
  return 0;
}

function cmdHeartbeat(rest, flags) {
  const url = flags.url || process.env.GITLIVE_HEARTBEAT_URL || DEFAULT_URL;
  const latest = fetchVersion(url);
  if (!latest) {
    console.log(`gitlive heartbeat: could not reach the registry (${url}).`);
    console.log(`You are on ${VERSION}. Nothing was sent about this machine — this check is just a version lookup.`);
    process.exitCode = 1;
    return;
  }
  const cmp = compare(latest, VERSION);
  if (cmp > 0) {
    console.log(`A newer gitlive is available: ${latest} (you are on ${VERSION}).`);
    console.log(`Update when YOU choose:  npm install -g ./gitlive-${latest}.tgz   (the private tarball, not the registry).`);
  } else if (cmp < 0) {
    console.log(`You are on ${VERSION} — ahead of the published ${latest} (dev build).`);
  } else {
    console.log(`You are on the latest gitlive: ${VERSION}.`);
  }
  console.log(`\nZero telemetry: this was ONE registry lookup for a version number. Nothing about`);
  console.log(`this machine was sent, and nothing runs automatically — schedule it if you want it:`);
  console.log(`  0 9 * * *  gitlive heartbeat   (cron is yours; the command only reads)`);
}

module.exports = { cmdHeartbeat, fetchVersion, compare, DEFAULT_URL };

if (require.main === module) {
  const flags = (() => { try { return require('./gitlive.js').parseFlags(process.argv.slice(2)).flags; } catch { return {}; } })();
  cmdHeartbeat(process.argv.slice(2), flags);
}
