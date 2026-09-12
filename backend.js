#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive backend — the optional daemon that lets apps share auth/data/storage
// (ADR-001, resolved as a hybrid: gitlive-client works standalone with zero
// setup, and this daemon is what upgrades an app — or several — to a shared,
// always-on backend without any app code changing).
//
// Deliberately reuses gitlive.js's own `startBackgroundNode` (the same helper
// that launches the --safe mode reverse proxy) instead of a launchd/systemd
// plist, the way ADR-001 originally sketched it before this file existed.
// That design was written without seeing this codebase; now that the pattern
// for "a detached background node helper gitlive manages" already exists and
// is proven (the proxy), reusing it is simpler and more consistent than
// introducing a second, heavier daemon-lifecycle mechanism for a first cut.
//
// Loaded lazily (`require('./backend.js')`) from inside gitlive.js's main(),
// same as mcp/server.js loads gitlive.js — never required at gitlive.js's own
// top level, so there's no circular-require ordering issue: by the time this
// file's top-level `require('./gitlive.js')` runs, gitlive.js's own
// `module.exports` assignment has already executed (it now happens
// unconditionally, not just when required as a library — see the gitlive.js
// diff this ships with).

const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadRegistry, isAlive, startBackgroundNode } = require('./gitlive.js');

const HOME_DIR = path.join(os.homedir(), '.gitlive');
const BACKEND_CORE_DIR = path.join(__dirname, 'gitlive-backend-core');
const DAEMON_SCRIPT_PATH = path.join(HOME_DIR, 'backend-daemon-runner.js');
const DAEMON_PID_PATH = path.join(HOME_DIR, 'backend-daemon.pid');
const DAEMON_STATE_PATH = path.join(HOME_DIR, 'backend-daemon.json');

// Same convention buildSafeHook/buildHook already use for $GITLIVE_DATA_DIR —
// not a new location. This is what makes gitlive-client's existing
// `process.env.GITLIVE_DATA_DIR` fallback already correct for a real app with
// zero changes: gitlive already sets that env var to exactly this path on
// every start.
function appDataDir(app) {
  return path.join(app.runPath, 'data');
}

function loadDaemonState() {
  try { return JSON.parse(fs.readFileSync(DAEMON_STATE_PATH, 'utf8')); } catch { return null; }
}

function saveDaemonState(state) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(DAEMON_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function daemonPid() {
  if (!fs.existsSync(DAEMON_PID_PATH)) return null;
  const pid = fs.readFileSync(DAEMON_PID_PATH, 'utf8').trim();
  return pid && isAlive(pid) ? pid : null;
}

function stopDaemonIfRunning() {
  const pid = daemonPid();
  if (pid) {
    try { process.kill(-Number(pid)); } catch { try { process.kill(Number(pid)); } catch {} }
  }
  fs.rmSync(DAEMON_PID_PATH, { force: true });
  return Boolean(pid);
}

// Generates the actual daemon entry point, the same way buildProxyScript
// generates proxy.js — a small, self-contained file written to disk and then
// launched detached. Embeds BACKEND_CORE_DIR as an absolute path (same trick
// buildSafeHook uses for `gitliveFile: __filename`) so the daemon never needs
// npm/node_modules resolution — gitlive-backend-core is Node built-ins only
// (node:sqlite, node:crypto), so this stays true to "zero runtime
// dependencies" even though it's a second file beyond gitlive.js itself.
function buildDaemonScript(apps) {
  const appsLiteral = JSON.stringify(apps.map((a) => ({ name: a.name, dataDir: a.dataDir })));
  return `#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const core = require(${JSON.stringify(path.join(BACKEND_CORE_DIR, 'index.js'))});
const { createRpcServer } = require(${JSON.stringify(path.join(BACKEND_CORE_DIR, 'rpc.js'))});

const APPS = ${appsLiteral};

if (APPS.length === 0) {
  console.error('[gitlive-backend] no apps to serve, exiting');
  process.exit(1);
}

const contexts = new Map();
const servers = new Map(); // tracked so shutdown() can close them — see below
for (const { name, dataDir } of APPS) {
  const ctx = core.openApp(dataDir); // adopts an existing app.db in place if one exists
  contexts.set(name, ctx);
  const socketPath = path.join(dataDir, 'backend.sock');
  const server = createRpcServer(socketPath, () => contexts.get(name), core.callOp);
  server.on('error', (err) => {
    console.error(\`[gitlive-backend] socket error for "\${name}":\`, err.message);
  });
  servers.set(name, { server, socketPath });
  console.log(\`[gitlive-backend] serving "\${name}" at \${socketPath}\`);
}

// server.close() alone does NOT remove a Unix domain socket's file from
// disk — that's a real gotcha, caught by this project's own integration
// test: an earlier version of this script called process.exit() straight
// after core.close(), leaving every backend.sock orphaned on disk even
// though nothing was listening on it. gitlive-client's probeSocket() still
// correctly saw it as unreachable (connection refused) and fell back to
// standalone, so nothing broke functionally — but a stale socket file sitting
// around is exactly the kind of loose-file mess this project has flagged as
// a recurring problem before, so it gets cleaned up properly here.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[gitlive-backend] shutting down');
  let pending = servers.size;
  if (pending === 0) return finish();
  for (const { server, socketPath } of servers.values()) {
    server.close(() => {
      try { fs.unlinkSync(socketPath); } catch {}
      if (--pending === 0) finish();
    });
  }
  function finish() {
    for (const ctx of contexts.values()) core.close(ctx);
    process.exit(0);
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;
}

function resolveTargetApps(reg, names) {
  const targetNames = names.length ? names : Object.keys(reg);
  const apps = [];
  for (const name of targetNames) {
    if (!reg[name]) throw new Error(`No app named "${name}". Run "gitlive list".`);
    apps.push({ name, dataDir: appDataDir(reg[name]) });
  }
  if (apps.length === 0) {
    throw new Error('No apps registered yet — nothing for the backend daemon to serve. Run "gitlive init" first.');
  }
  return apps;
}

async function cmdBackendStart(rest) {
  const reg = loadRegistry();
  let apps;
  try {
    apps = resolveTargetApps(reg, rest.filter((a) => !a.startsWith('--')));
  } catch (err) {
    console.log(err.message);
    process.exitCode = 1;
    return;
  }

  const wasRunning = stopDaemonIfRunning(); // restart-with-new-list is simpler than hot-reloading sockets for v1
  if (wasRunning) console.log('Stopping previous backend daemon...');

  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(DAEMON_SCRIPT_PATH, buildDaemonScript(apps));
  startBackgroundNode(DAEMON_SCRIPT_PATH, DAEMON_PID_PATH);
  saveDaemonState({ apps: apps.map((a) => a.name), startedAt: new Date().toISOString() });

  console.log(`Backend daemon started, serving: ${apps.map((a) => a.name).join(', ')}`);
  for (const a of apps) {
    console.log(`  ${a.name} -> ${path.join(a.dataDir, 'backend.sock')}`);
  }
  console.log(`\nApps using gitlive-client for these will auto-detect the socket on their next call`);
  console.log(`and switch from standalone SQLite to this daemon — no app code or redeploy needed.`);
}

function cmdBackendStop() {
  const wasRunning = stopDaemonIfRunning();
  fs.rmSync(DAEMON_STATE_PATH, { force: true });
  console.log(wasRunning
    ? 'Backend daemon stopped. Apps fall back to standalone mode automatically on their next call.'
    : 'Backend daemon was not running.');
}

// Pure, synchronous, fs-only — deliberately does not import gitlive-backend-core
// (no node:sqlite needed just to answer "is a daemon serving this app right
// now"). Used by gitlive.js's getStatusData so `gitlive status <name>` and the
// MCP server's gitlive_status both show it for free.
function backendStatusData(name, app) {
  const dataDir = appDataDir(app);
  const socketPath = path.join(dataDir, 'backend.sock');
  const state = loadDaemonState();
  const pid = daemonPid();
  const servedByDaemon = Boolean(pid && state && state.apps.includes(name) && fs.existsSync(socketPath));
  return {
    mode: servedByDaemon ? 'daemon' : 'standalone',
    dataDir,
    hasData: fs.existsSync(path.join(dataDir, 'app.db')),
    daemonPid: servedByDaemon ? pid : null,
  };
}

module.exports = { cmdBackendStart, cmdBackendStop, backendStatusData, appDataDir };
