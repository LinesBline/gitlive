// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive daemon — boot supervision v0 (ten-item program, item 10).
//
// A detached supervisor (its own setsid session, so no shell/job cleanup can
// reach it) that revives what CRASHED: a pidfile that exists but whose
// process is gone. Stopped apps have NO pidfile (gitlive stop removes it),
// so they stay stopped — user intent is respected. Connect-mode apps are
// skipped: their liveness belongs to launchd/systemd on the runner, not to a
// gitlive pidfile.
//
// What gets revived:
//   - plain apps: runPath/app.pid dead → `gitlive restart <name>`
//     (stop-then-start from the recorded run dir, exactly like the CLI).
//   - safe apps:  runPath/proxy.pid dead → `gitlive restart <name>`
//     (the documented proxy-revive path; code swaps stay push/rollback).
//
// Zero runtime dependencies; all state under ~/.gitlive (daemon.pid +
// daemon.log); env-HOME aware so the whole battery can run it under fake
// homes. Single-instance discipline mirrors the control plane: `gitlive
// daemon ensure` reuses a running supervisor, never spawns a second one.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const HOME_DIR = path.join(os.homedir(), '.gitlive');
const DAEMON_PID = path.join(HOME_DIR, 'daemon.pid');
const DAEMON_LOG = path.join(HOME_DIR, 'daemon.log');
const GITLIVE_JS = path.join(__dirname, 'gitlive.js');

// env overrides keep the E2E suite fast; defaults are the real cadence.
const TICK_MS = Math.max(300, Number(process.env.GITLIVE_DAEMON_TICK_MS) || 15000);
const COOLDOWN_MS = Math.max(1000, Number(process.env.GITLIVE_DAEMON_COOLDOWN_MS) || 90000);
const revives = new Map(); // app name → last revive attempt (cooldown guard)

function logLine(line) {
  const t = new Date().toISOString();
  try { fs.appendFileSync(DAEMON_LOG, `[${t}] ${line}\n`); } catch { /* log is best-effort */ }
}

function readPid(pidPath) {
  try {
    const v = fs.readFileSync(pidPath, 'utf8').trim();
    return /^\d+$/.test(v) ? v : null;
  } catch { return null; }
}

function isAlivePid(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* fall through */ }
}

// one supervision pass: find dead pidfiles, restart through the real CLI so
// every restart writes the same deploy.log lines it would if the owner had
// typed it (single source of truth for what "restart" means).
function superviseOnce() {
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'apps.json'), 'utf8')); } catch { return; }
  const now = Date.now();
  for (const [name, app] of Object.entries(reg)) {
    if (app.mode === 'connect' || !app.runPath || !fs.existsSync(app.runPath)) continue;
    const pidFile = app.safe ? path.join(app.runPath, 'proxy.pid') : path.join(app.runPath, 'app.pid');
    const deadPid = readPid(pidFile);
    if (!deadPid || isAlivePid(deadPid)) continue; // stopped (no pidfile) or healthy
    const last = revives.get(name) || 0;
    if (now - last < COOLDOWN_MS) continue;
    revives.set(name, now);
    const child = spawnSync('node', [GITLIVE_JS, 'restart', name], { encoding: 'utf8', timeout: 60000 });
    const head = String(child.stdout || '').split('\n')[0].trim() || String(child.stderr || '').split('\n')[0].trim() || '';
    const ok = child.status === 0;
    logLine(`revive ${name}: pidfile ${deadPid} was dead → restart ${ok ? 'ok' : 'FAILED (' + head + ')'}`);
    try { require('./crypt.js').logEvent('revive', { app: name, deadPid: Number(deadPid), ok }); } catch { /* events log optional */ }
  }
}

function runSupervisor() {
  logLine(`supervisor up (pid ${process.pid}) — tick ${TICK_MS}ms, revive cooldown ${COOLDOWN_MS}ms`);
  const tick = () => {
    try {
      superviseOnce();
    } catch (err) {
      logLine('tick error: ' + (err && err.message ? err.message : err));
    }
  };
  tick();
  setInterval(tick, TICK_MS);
}

// detached spawn: own session via perl setsid on macOS (no setsid binary) /
// setsid elsewhere; log grows at ~/.gitlive/daemon.log; the printed pid is
// the new session leader (kill the group to stop everything under it).
function spawnSupervisor() {
  const isDarwin = os.platform() === 'darwin';
  const cmd = `node ${JSON.stringify(__filename)} _run`;
  const wrapped = isDarwin
    ? `perl -e 'use POSIX "setsid"; POSIX::setsid(); exec { $ARGV[0] } @ARGV' bash -c ${JSON.stringify(cmd)} >> ${JSON.stringify(DAEMON_LOG)} 2>&1 < /dev/null &`
    : `setsid bash -c ${JSON.stringify(cmd)} >> ${JSON.stringify(DAEMON_LOG)} 2>&1 < /dev/null &`;
  return spawnSync('bash', ['-c', `${wrapped} echo $!`], { encoding: 'utf8' }).stdout.trim();
}

function registeredAppCount() {
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'apps.json'), 'utf8'))).length; } catch { return 0; }
}

// CLI dispatch invariant: receives the FULL argv after `daemon` — rest[0]
// is the subcommand, never sliced.
function cmdDaemon(rest) {
  const sub = rest[0];
  switch (sub) {
    case 'ensure': {
      const existing = readPid(DAEMON_PID);
      if (existing && isAlivePid(existing)) {
        console.log(`daemon supervisor already running (pid ${existing}) — one supervisor per machine, reusing it`);
        return;
      }
      const pid = spawnSupervisor();
      if (!/^\d+$/.test(String(pid))) {
        console.error(`daemon start failed (no session leader returned) — see ${DAEMON_LOG}`);
        process.exitCode = 1;
        return;
      }
      // let the supervisor come up, then confirm before claiming success
      let up = false;
      for (let i = 0; i < 15 && !up; i++) { sleepMs(100); up = isAlivePid(pid); }
      if (!up) {
        console.error('daemon start failed (process exited early) — see ' + DAEMON_LOG);
        process.exitCode = 1;
        return;
      }
      fs.mkdirSync(HOME_DIR, { recursive: true });
      fs.writeFileSync(DAEMON_PID, String(pid));
      console.log(`daemon supervisor up (pid ${pid}) — watching ${registeredAppCount()} registered app(s); revives crashed proxies/apps every ${Math.round(TICK_MS / 1000)}s`);
      console.log(`  log: ${DAEMON_LOG}   ·   stop: gitlive daemon stop`);
      return;
    }
    case 'status': {
      const pid = readPid(DAEMON_PID);
      if (pid && isAlivePid(pid)) console.log(`daemon supervisor running (pid ${pid})`);
      else console.log('daemon supervisor is NOT running (start it with: gitlive daemon ensure)');
      return;
    }
    case 'stop': {
      const pid = readPid(DAEMON_PID);
      if (!pid) { console.log('daemon supervisor is not running.'); return; }
      try { process.kill(-Number(pid), 'SIGTERM'); } catch { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }
      fs.rmSync(DAEMON_PID, { force: true });
      console.log(`daemon supervisor stopped (pid ${pid}). Registered apps keep running — only the supervisor is gone.`);
      return;
    }
    default:
      console.log(`usage:
  gitlive daemon ensure   start the detached supervisor if it is not already
                          running (single instance; reuses the running one)
  gitlive daemon status   report whether the supervisor is up
  gitlive daemon stop     stop the supervisor (registered apps keep running)

The supervisor revives what CRASHED — a pidfile that exists but whose process
is gone. Stopped apps (no pidfile) stay stopped: that is user intent. Safe
apps get their public proxy revived; plain apps are restarted from their run
dir. Connect-mode apps are left to launchd/systemd. Overrides for the E2E
suite: GITLIVE_DAEMON_TICK_MS, GITLIVE_DAEMON_COOLDOWN_MS.`);
      process.exitCode = 1;
  }
}

if (require.main === module && process.argv[2] === '_run') {
  runSupervisor();
}

module.exports = { cmdDaemon, runSupervisor, spawnSupervisor, superviseOnce, isAlivePid, DAEMON_PID, DAEMON_LOG };
