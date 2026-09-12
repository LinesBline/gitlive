#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const https = require('https');
const net = require('net');
const { execSync, spawnSync, execFileSync } = require('child_process');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const VERSION = '2.6.2';

const HOME_DIR = path.join(os.homedir(), '.gitlive');
const APPS_DIR = path.join(HOME_DIR, 'apps');
const RUNNERS_DIR = path.join(HOME_DIR, 'runners');
const REGISTRY_PATH = path.join(HOME_DIR, 'apps.json');

// A secrets file always lives next to the bare repo — never inside a
// directory "git checkout -f" touches, so a redeploy can't silently wipe or
// version it. gitlive only ever stores and sources it; it never chooses,
// prompts for, or displays the values themselves.
function secretsPath(name) {
  return path.join(APPS_DIR, `${name}.secrets.env`);
}

function ensureHome() {
  fs.mkdirSync(APPS_DIR, { recursive: true });
  if (!fs.existsSync(REGISTRY_PATH)) fs.writeFileSync(REGISTRY_PATH, '{}\n');
}

function loadRegistry() {
  ensureHome();
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n');
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function ask(rl, question, fallback) {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || '';
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function detectStack(cwd) {
  // Docker first when the project IS docker: a compose file wins over
  // package.json (the owner chose containers); a lone Dockerfile wins over
  // "unknown" (dockerized apps with no other markers) but NOT over a real
  // Node/Python project that merely ships a Dockerfile for CI.
  for (const f of ['compose.yml', 'compose.yaml', 'docker-compose.yml']) {
    if (fs.existsSync(path.join(cwd, f))) {
      return { kind: 'docker-compose', installCmd: 'docker compose build --pull', startCmd: 'docker compose up -d', docker: 'compose' };
    }
  }
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch {}
    const start = (pkg.scripts && pkg.scripts.start) ? 'npm start' : (pkg.main ? `node ${pkg.main}` : null);
    return { kind: 'node', installCmd: 'npm install --omit=dev --silent', startCmd: start };
  }
  if (fs.existsSync(path.join(cwd, 'requirements.txt'))) {
    let startCmd = null;
    for (const candidate of ['app.py', 'main.py', 'server.py']) {
      if (fs.existsSync(path.join(cwd, candidate))) { startCmd = `python3 ${candidate}`; break; }
    }
    return { kind: 'python', installCmd: 'pip3 install -r requirements.txt --quiet', startCmd };
  }
  for (const candidate of ['app.py', 'main.py', 'server.py']) {
    if (fs.existsSync(path.join(cwd, candidate))) {
      return { kind: 'python (no requirements.txt found)', installCmd: '', startCmd: `python3 ${candidate}` };
    }
  }
  if (fs.existsSync(path.join(cwd, 'Dockerfile'))) {
    // EXPOSE declares the container's internal port — the one docker run must
    // map. First EXPOSE wins; absent EXPOSE the public port is assumed.
    let expose = null;
    try {
      const m = fs.readFileSync(path.join(cwd, 'Dockerfile'), 'utf8').match(/^\s*EXPOSE\s+(\d+)/m);
      if (m) expose = Number(m[1]);
    } catch { /* unreadable Dockerfile → default port */ }
    return { kind: 'docker (Dockerfile)', installCmd: '', startCmd: '', docker: 'dockerfile', dockerPort: expose };
  }
  return { kind: 'unknown', installCmd: '', startCmd: null };
}

// ---------------------------------------------------------------------------
// deploy history — structured, queryable record of what each push actually did
// (inspired by AI-Q's "preserve source attribution and auditability" pattern)
// ---------------------------------------------------------------------------

function appendHistory(runPath, entry) {
  const histPath = path.join(runPath, 'deploy-history.jsonl');
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(histPath, line + '\n');
}

function readHistory(runPath, limit = 5) {
  const histPath = path.join(runPath, 'deploy-history.jsonl');
  if (!fs.existsSync(histPath)) return [];
  const lines = fs.readFileSync(histPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// local mode (gitlive init): bare repo + post-receive hook on this machine
// ---------------------------------------------------------------------------

function shQuoteSingle(cmd) {
  // safe for embedding inside a bash -c '...' single-quoted string
  return cmd.replace(/'/g, `'\\''`);
}

// --memory-limit-mb is deliberately opt-in and separate from --nice: ulimit
// -v caps virtual address space, not real memory use, and V8 reserves large
// virtual ranges up front regardless of how much a Node app actually uses —
// so a tight cap can stop an ordinary app from starting at all, not just a
// runaway one. It's a coarse, honest safety net for genuinely pathological
// cases, not a precise memory limit. --nice has no such caveat: it's a
// portable, safe-by-default CPU deprioritization with no failure mode worse
// than "runs a little slower under contention."
function wrapStartCmd(startCmd, { memoryLimitMb } = {}) {
  if (!memoryLimitMb) return startCmd;
  const kb = Math.round(Number(memoryLimitMb) * 1024);
  return `ulimit -v ${kb} 2>/dev/null; ${startCmd}`;
}

function nicePrefix(nice) {
  return nice ? `nice -n ${Number(nice)} ` : '';
}

// ---------------------------------------------------------------------------
// docker deploys (P1 pain-driven roadmap): compose projects and lone
// Dockerfiles deploy through the SAME push/gate/receipt machinery — the
// runtime is just "docker" instead of a host process. Honest v1 shape:
// plain mode only (no blue-green slots yet — the swap has a brief downtime,
// said out loud), status reads REAL container state (compose ps / inspect),
// and no host pidfile exists (the daemon supervisor leaves docker apps
// alone: docker's own --restart policy is their safety net).
// ---------------------------------------------------------------------------
function buildDockerHook({ barePath, runPath, installCmd, startCmd, logPath, secretsPath, gitliveFile, name, docker, containerName, port }) {
  const isCompose = docker === 'compose';
  // The same PORT contract as every other mode: the deploy exports the
  // app's registered port, so compose files can map it (ports: ["${PORT}:3000"])
  // and Dockerfiles get -p 127.0.0.1:<port>:<internal>.
  const portAssign = port ? `PORT=${JSON.stringify(String(port))} ` : '';
  const stopStep = isCompose
    ? 'docker compose down >> "$LOG" 2>&1 || true'
    : `docker rm -f ${containerName} >> "$LOG" 2>&1 || true`;
  const startStep = isCompose
    ? 'docker compose up -d >> "$LOG" 2>&1'
    : `${startCmd} >> "$LOG" 2>&1`;
  const installBlock = installCmd
    ? `
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] building the image" >> "$LOG"
(cd "$CODE_DIR" && eval ${JSON.stringify(shQuoteSingle(installCmd))}) >> "$LOG" 2>&1
` : '';
  return `#!/bin/bash
TARGET=${JSON.stringify(runPath)}
BARE=${JSON.stringify(barePath)}
LOG=${JSON.stringify(logPath)}
SECRETS=${JSON.stringify(secretsPath)}
GITLIVE_FILE=${JSON.stringify(gitliveFile)}
CODE_DIR="$TARGET/live"

mkdir -p "$CODE_DIR" "$TARGET/data"
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] push received (docker ${docker})" >> "$LOG"

# stop the current containers BEFORE checking out new code — same ordering
# law as the process hooks, so no container serves files that are being
# rewritten underneath it.
(cd "$CODE_DIR" && ${stopStep}) 2>/dev/null || true

git --work-tree="$CODE_DIR" --git-dir="$BARE" checkout -f main >> "$LOG" 2>&1

# F1 closure gate runs for docker deploys too (a signed manifest may pin the
# lockfile inside the image build context).
CLOSURE_LINE=$(node "$GITLIVE_FILE" _closure-gate "$CODE_DIR" 2>&1)
if [ "$?" != "0" ]; then
  printf '%s\n' "$CLOSURE_LINE" >> "$LOG"
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] DEPLOY ABORTED — dependency closure drift (fix dependencies, then: gitlive manifest sign && git push)" >> "$LOG"
  echo "gitlive: deploy aborted — dependency closure does not match the signed manifest" >&2
  exit 1
fi
printf '%s\n' "$CLOSURE_LINE" >> "$LOG"
CLOSURE_SHA=$(printf '%s\n' "$CLOSURE_LINE" | sed -n 's/^closure_sha=//p')
${installBlock}
cd "$CODE_DIR"
if [ -f "$SECRETS" ]; then set -a; source "$SECRETS"; set +a; fi
${portAssign}${startStep}
echo ${JSON.stringify(docker)} > "$TARGET/mode"
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] containers started (${docker})" >> "$LOG"
node "$GITLIVE_FILE" _record-deploy ${JSON.stringify(name)} success "$(git --git-dir="$BARE" rev-parse HEAD | cut -c1-12)" "" "$CLOSURE_SHA" >> "$LOG" 2>&1 || true
node "$GITLIVE_FILE" _attest-deploy ${JSON.stringify(name)} >> "$LOG" 2>&1 || true
node "$GITLIVE_FILE" _deploy-tag ${JSON.stringify(name)} "$(git --git-dir="$BARE" rev-parse HEAD)" "$CLOSURE_SHA" success >> "$LOG" 2>&1 || true
`;
}

function buildHook({ barePath, runPath, installCmd, buildCmd, startCmd, logPath, secretsPath, nice, memoryLimitMb, gitliveFile, name, port }) {
  const quotedStart = shQuoteSingle(wrapStartCmd(startCmd, { memoryLimitMb }));
  const nicePfx = nicePrefix(nice);
  // Plain mode exports the app's registered port when it has one, so the
  // "reads PORT from the environment" contract holds in BOTH modes — without
  // it, `gitlive init`'s printed curl hint pointed at a port the app never
  // bound (field finding, stranger walk, 2026-09-09).
  const portAssign = port ? `PORT=${JSON.stringify(String(port))} ` : '';
  return `#!/bin/bash
TARGET=${JSON.stringify(runPath)}
BARE=${JSON.stringify(barePath)}
LOG=${JSON.stringify(logPath)}
DATA_DIR="$TARGET/data"
SECRETS=${JSON.stringify(secretsPath)}
GITLIVE_FILE=${JSON.stringify(gitliveFile)}
# Plain mode has no second slot to fall back to, so there's no health check —
# but it still gets its own checkout dir under $TARGET (not $TARGET itself),
# same as --safe, so the layout is consistent and a future health-checked
# swap could be added here without a directory-structure change.
CODE_DIR="$TARGET/live"

mkdir -p "$CODE_DIR" "$DATA_DIR"
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] push received" >> "$LOG"

# Stop the old process BEFORE touching its files. Checking out first (the
# original order) meant "git checkout -f" rewrote files in $CODE_DIR while
# the old process was still running and serving from that same directory —
# the identical shared-checkout race --safe mode had, just without a second
# slot to make it obvious. Plain mode already has a documented downtime gap
# between old and new; this just makes that gap also cover the checkout, so
# nothing gets mutated out from under a process still using it.
if [ -f "$TARGET/app.pid" ]; then
  OLD_PID=$(cat "$TARGET/app.pid")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] stopping old process group (pid $OLD_PID)" >> "$LOG"
    kill -- "-$OLD_PID" 2>/dev/null || kill "$OLD_PID" 2>/dev/null
    sleep 0.5
  fi
fi

git --work-tree="$CODE_DIR" --git-dir="$BARE" checkout -f main >> "$LOG" 2>&1

# F1 dependency-closure gate: when the signed manifest pins a lockfile
# closure, the checkout must match it BEFORE anything is installed —
# otherwise this deploy would run dependencies the owner never signed.
CLOSURE_LINE=$(node "$GITLIVE_FILE" _closure-gate "$CODE_DIR" 2>&1)
if [ "$?" != "0" ]; then
  printf '%s\n' "$CLOSURE_LINE" >> "$LOG"
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] DEPLOY ABORTED — dependency closure drift (fix dependencies, then: gitlive manifest sign && git push)" >> "$LOG"
  echo "gitlive: deploy aborted — dependency closure does not match the signed manifest" >&2
  exit 1
fi
printf '%s\n' "$CLOSURE_LINE" >> "$LOG"
PINNED=0
case "$CLOSURE_LINE" in *"closure: pinned"*) PINNED=1;; esac
CLOSURE_SHA=$(printf '%s\n' "$CLOSURE_LINE" | sed -n 's/^closure_sha=//p')
${installCmd ? `
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] installing dependencies" >> "$LOG"
INSTALL_CMD='${shQuoteSingle(installCmd)}'
if [ "$PINNED" = "1" ]; then
  case "$INSTALL_CMD" in
    "npm install"*) INSTALL_CMD=$(printf '%s' "$INSTALL_CMD" | sed 's/^npm install/npm ci/'); echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] pinned closure — strict install (npm ci)" >> "$LOG";;
  esac
fi
(cd "$CODE_DIR" && eval "$INSTALL_CMD") >> "$LOG" 2>&1
` : ''}
${buildCmd ? `
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] building" >> "$LOG"
BUILD_CMD='${shQuoteSingle(buildCmd)}'
(cd "$CODE_DIR" && eval "$BUILD_CMD") >> "$LOG" 2>&1
` : ''}

cd "$CODE_DIR"
if [ -f "$SECRETS" ]; then set -a; source "$SECRETS"; set +a; fi
# setsid makes the app a new process-group leader so a redeploy can kill the
# whole tree (e.g. "npm start"'s child node process) instead of orphaning it.
# macOS ships no setsid binary (it's Linux-only util-linux) so fall back to
# perl's POSIX::setsid(), which does the same thing.
if command -v setsid >/dev/null 2>&1; then
  ${portAssign}GITLIVE_DATA_DIR="$DATA_DIR" ${nicePfx}setsid bash -c '${quotedStart}' >> "$LOG" 2>&1 < /dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
else
  ${portAssign}GITLIVE_DATA_DIR="$DATA_DIR" ${nicePfx}perl -e 'use POSIX "setsid"; POSIX::setsid(); exec { $ARGV[0] } @ARGV' bash -c '${quotedStart}' >> "$LOG" 2>&1 < /dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
fi
NEW_PID=$!
echo $NEW_PID > "$TARGET/app.pid"
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] started new process (pid $NEW_PID, group leader)" >> "$LOG"
# Liveness gate (new-user field finding): a deploy must not be receipted
# "success" while the app is already dead. The process must simply SURVIVE
# six seconds — slow boots are fine (the pid is alive), instant crashes
# (missing deps, bad start command) fail the deploy honestly.
OUTCOME=success
REASON=""
for _ in 1 2 3 4 5 6; do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    OUTCOME=failed
    REASON="process exited within 6s of start — see deploy log"
    break
  fi
  sleep 1
done
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] liveness after start: $OUTCOME" >> "$LOG"
node "$GITLIVE_FILE" _record-deploy ${JSON.stringify(name)} "$OUTCOME" "$(git --git-dir="$BARE" rev-parse HEAD | cut -c1-12)" "$REASON" "$CLOSURE_SHA" >> "$LOG" 2>&1 || true
node "$GITLIVE_FILE" _attest-deploy ${JSON.stringify(name)} >> "$LOG" 2>&1 || true
node "$GITLIVE_FILE" _deploy-tag ${JSON.stringify(name)} "$(git --git-dir="$BARE" rev-parse HEAD)" "$CLOSURE_SHA" "$OUTCOME" >> "$LOG" 2>&1 || true
node "$GITLIVE_FILE" _publish-dns ${JSON.stringify(name)} >> "$LOG" 2>&1 || true
if [ "$OUTCOME" = "failed" ]; then echo "gitlive: deploy FAILED — the app exited within 6s of start (see the deploy log)" >&2; exit 1; fi
`;
}

// ---------------------------------------------------------------------------
// safe mode (gitlive init --safe --port N): health-checked blue-green swap.
//
// Modeled directly on NVIDIA AI-Q's aiq-deploy pattern: a new instance is
// started on the side, polled against a health endpoint, and only promoted
// to receive real traffic once it proves it's actually up. A local
// dependency-free TCP proxy (net.createServer, no npm packages) sits on the
// public port and forwards each new connection to whichever backend slot
// (A or B) is currently marked active in a state file. A failed health
// check never touches the state file, so a broken push leaves the previous
// version serving traffic instead of taking the site down.
// ---------------------------------------------------------------------------

function derivePorts(name, salt = 0) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const base = 30000 + ((h + salt * 2) % 9000); // 30000-38999
  return { portA: base, portB: base + 1 };
}

// Ground truth beats bookkeeping: a registry check alone can't see a port
// held by something gitlive never registered, so probe it for real too.
function portInUse(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(true));
    tester.once('listening', () => tester.close(() => resolve(false)));
    tester.listen(port, '127.0.0.1');
  });
}

function registryPortConflict(reg, port, excludeName) {
  for (const [otherName, app] of Object.entries(reg)) {
    if (otherName === excludeName) continue;
    if (String(app.port) === String(port)) return otherName;
    if (app.portA === port || app.portB === port) return otherName;
  }
  return null;
}

// Internal slot ports are never something the user chose, so a collision
// there is resolved automatically (salted re-hash) rather than surfaced as
// an error — the public port below is the one they explicitly typed, and
// that one is never silently overridden.
async function resolveSafePorts(reg, name) {
  for (let salt = 0; salt < 50; salt++) {
    const { portA, portB } = derivePorts(name, salt);
    if (registryPortConflict(reg, portA, name) || registryPortConflict(reg, portB, name)) continue;
    const [busyA, busyB] = await Promise.all([portInUse(portA), portInUse(portB)]);
    if (busyA || busyB) continue;
    return { portA, portB };
  }
  throw new Error(`Couldn't find two free internal ports for "${name}" after 50 attempts — check for something holding a wide port range.`);
}

async function checkPublicPort(reg, port, name) {
  const conflict = registryPortConflict(reg, port, name);
  if (conflict) throw new Error(`Port ${port} is already used by gitlive app "${conflict}". Pick a different --port.`);
  if (await portInUse(port)) throw new Error(`Port ${port} is already in use by something else on this machine. Pick a different --port.`);
}

function buildSafeHook({ barePath, runPath, installCmd, buildCmd, startCmd, healthPath, portA, portB, name, gitliveFile, logPath, secretsPath, nice, memoryLimitMb }) {
  const quotedStart = shQuoteSingle(wrapStartCmd(startCmd, { memoryLimitMb }));
  const nicePfx = nicePrefix(nice);
  return `#!/bin/bash
TARGET=${JSON.stringify(runPath)}
BARE=${JSON.stringify(barePath)}
LOG=${JSON.stringify(logPath)}
STATE="$TARGET/active-slot"
DATA_DIR="$TARGET/data"
SECRETS=${JSON.stringify(secretsPath)}
HEALTH_PATH=${JSON.stringify(healthPath)}
PORT_A=${portA}
PORT_B=${portB}
APP_NAME=${JSON.stringify(name)}
GITLIVE_FILE=${JSON.stringify(gitliveFile)}

mkdir -p "$TARGET" "$DATA_DIR"
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] push received (safe mode)" >> "$LOG"
COMMIT=$(git --git-dir="$BARE" rev-parse HEAD 2>/dev/null | cut -c1-12)

ACTIVE=$(cat "$STATE" 2>/dev/null || echo "")
if [ "$ACTIVE" = "A" ]; then NEW_SLOT=B; NEW_PORT=$PORT_B; OLD_SLOT=A; OLD_PORT=$PORT_A
else NEW_SLOT=A; NEW_PORT=$PORT_A; OLD_SLOT=B; OLD_PORT=$PORT_B
fi

# Each slot gets its own checkout directory — the old (still-serving) slot's
# files are never touched while it's live. The only thing the two slots ever
# share is $DATA_DIR, and only because an app opts in via $GITLIVE_DATA_DIR
# (e.g. a SQLite file or upload folder) — sharing is a named exception, not
# the default. Without this, "git checkout -f" into one shared directory
# would overwrite the old slot's files out from under it mid-request.
SLOT_DIR="$TARGET/$NEW_SLOT"
mkdir -p "$SLOT_DIR"
git --work-tree="$SLOT_DIR" --git-dir="$BARE" checkout -f main >> "$LOG" 2>&1

# F1 dependency-closure gate: when the signed manifest pins a lockfile
# closure, the checkout must match it BEFORE anything is installed —
# otherwise this deploy would run dependencies the owner never signed.
CLOSURE_LINE=$(node "$GITLIVE_FILE" _closure-gate "$SLOT_DIR" 2>&1)
if [ "$?" != "0" ]; then
  printf '%s\n' "$CLOSURE_LINE" >> "$LOG"
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] DEPLOY ABORTED — dependency closure drift (fix dependencies, then: gitlive manifest sign && git push)" >> "$LOG"
  echo "gitlive: deploy aborted — dependency closure does not match the signed manifest" >&2
  exit 1
fi
printf '%s\n' "$CLOSURE_LINE" >> "$LOG"
PINNED=0
case "$CLOSURE_LINE" in *"closure: pinned"*) PINNED=1;; esac
CLOSURE_SHA=$(printf '%s\n' "$CLOSURE_LINE" | sed -n 's/^closure_sha=//p')
${installCmd ? `
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] installing dependencies on slot $NEW_SLOT" >> "$LOG"
INSTALL_CMD='${shQuoteSingle(installCmd)}'
if [ "$PINNED" = "1" ]; then
  case "$INSTALL_CMD" in
    "npm install"*) INSTALL_CMD=$(printf '%s' "$INSTALL_CMD" | sed 's/^npm install/npm ci/'); echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] pinned closure — strict install (npm ci)" >> "$LOG";;
  esac
fi
(cd "$SLOT_DIR" && eval "$INSTALL_CMD") >> "$LOG" 2>&1
` : ''}
${buildCmd ? `
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] building on slot $NEW_SLOT" >> "$LOG"
BUILD_CMD='${shQuoteSingle(buildCmd)}'
(cd "$SLOT_DIR" && eval "$BUILD_CMD") >> "$LOG" 2>&1
` : ''}

cd "$SLOT_DIR"
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] starting new instance on slot $NEW_SLOT (port $NEW_PORT)" >> "$LOG"
if [ -f "$SECRETS" ]; then set -a; source "$SECRETS"; set +a; fi
if command -v setsid >/dev/null 2>&1; then
  PORT=$NEW_PORT GITLIVE_DATA_DIR="$DATA_DIR" ${nicePfx}setsid bash -c '${quotedStart}' >> "$TARGET/app-$NEW_SLOT.log" 2>&1 < /dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
else
  PORT=$NEW_PORT GITLIVE_DATA_DIR="$DATA_DIR" ${nicePfx}perl -e 'use POSIX "setsid"; POSIX::setsid(); exec { $ARGV[0] } @ARGV' bash -c '${quotedStart}' >> "$TARGET/app-$NEW_SLOT.log" 2>&1 < /dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
fi
NEW_PID=$!
echo $NEW_PID > "$TARGET/app-$NEW_SLOT.pid"

echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] health-checking http://127.0.0.1:$NEW_PORT$HEALTH_PATH" >> "$LOG"
OK=0
for i in $(seq 1 20); do
  sleep 0.5
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$NEW_PORT$HEALTH_PATH" 2>/dev/null)
  # curl's -w already prints "000" on a failed/refused connection, so no
  # extra "|| echo" fallback here — one previously concatenated into
  # "000000" on failure, which is NOT equal to "000" and caused a dead
  # backend to be reported healthy. Caught by the broken-build test below;
  # keep that test in place so this can't silently regress.
  if [ "$CODE" != "000" ] && [ -n "$CODE" ]; then OK=1; break; fi
done

if [ "$OK" = "1" ]; then
  echo "$NEW_SLOT" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] healthy — switched live traffic to slot $NEW_SLOT (port $NEW_PORT)" >> "$LOG"
  if [ -f "$TARGET/app-$OLD_SLOT.pid" ]; then
    OLD_PID=$(cat "$TARGET/app-$OLD_SLOT.pid")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] stopping old instance, slot $OLD_SLOT (pid $OLD_PID)" >> "$LOG"
      kill -TERM -- "-$OLD_PID" 2>/dev/null || kill -TERM "$OLD_PID" 2>/dev/null
      sleep 1
      kill -KILL -- "-$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$TARGET/app-$OLD_SLOT.pid"
  fi
  node "$GITLIVE_FILE" _record-deploy "$APP_NAME" success "$COMMIT" "" "$CLOSURE_SHA" >> "$LOG" 2>&1
  node "$GITLIVE_FILE" _attest-deploy "$APP_NAME" >> "$LOG" 2>&1 || true
  node "$GITLIVE_FILE" _deploy-tag "$APP_NAME" "$COMMIT" "$CLOSURE_SHA" success >> "$LOG" 2>&1 || true
  node "$GITLIVE_FILE" _publish-dns "$APP_NAME" >> "$LOG" 2>&1 || true
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] deploy succeeded (commit $COMMIT)" >> "$LOG"
  echo "gitlive: deployed $COMMIT — live and healthy on slot $NEW_SLOT"
else
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] new instance on slot $NEW_SLOT never became healthy — rolling back, previous version stays live" >> "$LOG"
  kill -TERM -- "-$NEW_PID" 2>/dev/null || kill -TERM "$NEW_PID" 2>/dev/null
  sleep 0.5
  kill -KILL -- "-$NEW_PID" 2>/dev/null || true
  rm -f "$TARGET/app-$NEW_SLOT.pid"
  node "$GITLIVE_FILE" _record-deploy "$APP_NAME" failed "$COMMIT" "health check never returned a response within 10s" >> "$LOG" 2>&1
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] DEPLOY FAILED (commit $COMMIT) — slot $OLD_SLOT is still serving traffic" >> "$LOG"
  echo "gitlive: DEPLOY FAILED — $COMMIT never became healthy at $HEALTH_PATH within 10s."
  echo "gitlive: the previous version is still live and serving traffic. See: gitlive logs $APP_NAME"
  exit 1
fi
`;
}

// ---------------------------------------------------------------------------
// docker blue-green (post-roadmap #4): the safe-mode choreography for
// compose apps. Each slot is its own compose PROJECT (-p <app>-a|b), so the
// old slot keeps serving untouched while the new one builds and is
// health-checked; the same host-level proxy swaps traffic. PORT is exported
// per slot for compose interpolation (ports: ["${PORT}:3000"]).
// ---------------------------------------------------------------------------
function buildSafeDockerHook({ barePath, runPath, name, healthPath, portA, portB, gitliveFile, logPath, secretsPath }) {
  return `#!/bin/bash
TARGET=${JSON.stringify(runPath)}
BARE=${JSON.stringify(barePath)}
LOG=${JSON.stringify(logPath)}
STATE="$TARGET/active-slot"
SECRETS=${JSON.stringify(secretsPath)}
HEALTH_PATH=${JSON.stringify(healthPath)}
PORT_A=${portA}
PORT_B=${portB}
APP_NAME=${JSON.stringify(name)}
GITLIVE_FILE=${JSON.stringify(gitliveFile)}

mkdir -p "$TARGET"
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] push received (docker safe mode)" >> "$LOG"
COMMIT=$(git --git-dir="$BARE" rev-parse HEAD 2>/dev/null | cut -c1-12)

ACTIVE=$(cat "$STATE" 2>/dev/null || echo "")
if [ "$ACTIVE" = "A" ]; then NEW_SLOT=B; NEW_PORT=$PORT_B; OLD_SLOT=A; OLD_PORT=$PORT_A
else NEW_SLOT=A; NEW_PORT=$PORT_A; OLD_SLOT=B; OLD_PORT=$PORT_B
fi
NEW_PROJ=$(echo "$APP_NAME-$NEW_SLOT" | tr 'A-Z' 'a-z')
OLD_PROJ=$(echo "$APP_NAME-$OLD_SLOT" | tr 'A-Z' 'a-z')

# per-slot checkout: the old slot's files are never touched while it serves
SLOT_DIR="$TARGET/$NEW_SLOT"
mkdir -p "$SLOT_DIR"
git --work-tree="$SLOT_DIR" --git-dir="$BARE" checkout -f main >> "$LOG" 2>&1

CLOSURE_LINE=$(node "$GITLIVE_FILE" _closure-gate "$SLOT_DIR" 2>&1)
if [ "$?" != "0" ]; then
  printf '%s\n' "$CLOSURE_LINE" >> "$LOG"
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] DEPLOY ABORTED — dependency closure drift (fix dependencies, then: gitlive manifest sign && git push)" >> "$LOG"
  echo "gitlive: deploy aborted — dependency closure does not match the signed manifest" >&2
  exit 1
fi
printf '%s\n' "$CLOSURE_LINE" >> "$LOG"
CLOSURE_SHA=$(printf '%s\n' "$CLOSURE_LINE" | sed -n 's/^closure_sha=//p')

cd "$SLOT_DIR"
if [ -f "$SECRETS" ]; then set -a; source "$SECRETS"; set +a; fi
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] building slot $NEW_SLOT (project $NEW_PROJ)" >> "$LOG"
PORT=$NEW_PORT docker compose -p "$NEW_PROJ" build --pull >> "$LOG" 2>&1
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] starting slot $NEW_SLOT (project $NEW_PROJ, port $NEW_PORT)" >> "$LOG"
PORT=$NEW_PORT docker compose -p "$NEW_PROJ" up -d >> "$LOG" 2>&1

echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] health-checking http://127.0.0.1:$NEW_PORT$HEALTH_PATH" >> "$LOG"
OK=0
for i in $(seq 1 20); do
  sleep 0.5
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$NEW_PORT$HEALTH_PATH" 2>/dev/null)
  if [ "$CODE" != "000" ] && [ -n "$CODE" ]; then OK=1; break; fi
done

if [ "$OK" = "1" ]; then
  echo "$NEW_SLOT" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] healthy — switched live traffic to slot $NEW_SLOT" >> "$LOG"
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] stopping old slot (project $OLD_PROJ)" >> "$LOG"
  docker compose -p "$OLD_PROJ" down >> "$LOG" 2>&1
  node "$GITLIVE_FILE" _record-deploy "$APP_NAME" success "$COMMIT" "" "$CLOSURE_SHA" >> "$LOG" 2>&1
  node "$GITLIVE_FILE" _attest-deploy "$APP_NAME" >> "$LOG" 2>&1 || true
  node "$GITLIVE_FILE" _deploy-tag "$APP_NAME" "$COMMIT" "$CLOSURE_SHA" success >> "$LOG" 2>&1 || true
  node "$GITLIVE_FILE" _publish-dns "$APP_NAME" >> "$LOG" 2>&1 || true
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] deploy succeeded (commit $COMMIT)" >> "$LOG"
  echo "gitlive: deployed $COMMIT — live and healthy on slot $NEW_SLOT"
else
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] slot $NEW_SLOT never became healthy — rolling back, previous version stays live" >> "$LOG"
  docker compose -p "$NEW_PROJ" down >> "$LOG" 2>&1
  node "$GITLIVE_FILE" _record-deploy "$APP_NAME" failed "$COMMIT" "health check never returned a response within 10s" >> "$LOG" 2>&1
  echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] DEPLOY FAILED (commit $COMMIT) — slot $OLD_SLOT is still serving traffic" >> "$LOG"
  echo "gitlive: DEPLOY FAILED — $COMMIT never became healthy at $HEALTH_PATH within 10s."
  echo "gitlive: the previous version is still live and serving traffic. See: gitlive logs $APP_NAME"
  exit 1
fi
`;
}

function buildProxyScript({ publicPort, portA, portB, statePath }) {
  return `#!/usr/bin/env node
'use strict';
const net = require('net');
const fs = require('fs');

const PUBLIC_PORT = ${publicPort};
const PORT_A = ${portA};
const PORT_B = ${portB};
const STATE_PATH = ${JSON.stringify(statePath)};

function activePort() {
  try {
    const slot = fs.readFileSync(STATE_PATH, 'utf8').trim();
    return slot === 'B' ? PORT_B : PORT_A;
  } catch { return PORT_A; }
}

const server = net.createServer((client) => {
  const target = net.createConnection({ host: '127.0.0.1', port: activePort() }, () => {
    client.pipe(target);
    target.pipe(client);
  });
  target.on('error', () => client.destroy());
  client.on('error', () => target.destroy());
});

server.on('error', (err) => {
  console.error('[gitlive-proxy] server error:', err.message);
});

server.listen(PUBLIC_PORT, () => {
  console.log(\`[gitlive-proxy] listening on \${PUBLIC_PORT}, forwarding to whichever slot is active\`);
});
`;
}

function startBackgroundNode(scriptPath, pidPath) {
  const isDarwin = os.platform() === 'darwin';
  const cmd = `node ${JSON.stringify(scriptPath)}`;
  const wrapped = isDarwin
    ? `perl -e 'use POSIX "setsid"; POSIX::setsid(); exec { $ARGV[0] } @ARGV' bash -c ${JSON.stringify(cmd)} >> ${JSON.stringify(scriptPath + '.log')} 2>&1 < /dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &`
    : `setsid bash -c ${JSON.stringify(cmd)} >> ${JSON.stringify(scriptPath + '.log')} 2>&1 < /dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &`;
  const pid = spawnSync('bash', ['-c', `${wrapped} echo $!`], { encoding: 'utf8' }).stdout.trim();
  if (pid) fs.writeFileSync(pidPath, pid);
  return pid;
}

async function cmdInit(argv) {
  const cwd = process.cwd();
  const { flags, positional } = parseFlags(argv);
  const defaultName = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, '-');
  // interactive prompting only makes sense at a real terminal; scripted/piped
  // runs must supply --install/--start/--port instead.
  const interactive = Boolean(input.isTTY) && !flags.yes;
  const rl = interactive ? readline.createInterface({ input, output }) : null;

  console.log(`Setting up git-push deploy for: ${cwd}\n`);
  const detected = detectStack(cwd);
  console.log(detected.kind === 'unknown'
    ? `Couldn't auto-detect the stack (no package.json / requirements.txt / app.py found).`
    : `Detected: ${detected.kind}`);
  // docker deploys (P1): auto-detected from compose files / a lone Dockerfile,
  // or forced with --docker. Blue-green for docker is a later step — plain
  // mode only, said out loud (the swap has a brief downtime).
  const hasComposeFile = ['compose.yml', 'compose.yaml', 'docker-compose.yml'].some((f) => fs.existsSync(path.join(cwd, f)));
  let dockerMode = null;
  let detectedDockerPort = null;
  if (flags.docker) {
    dockerMode = hasComposeFile ? 'compose' : 'dockerfile';
  } else if (detected.docker) {
    dockerMode = detected.docker;
    detectedDockerPort = detected.dockerPort || null;
  }
  if (dockerMode === 'dockerfile' && flags.safe) {
    console.log('--safe (blue-green) for Dockerfile-only deploys is a later step — use plain mode, or a compose.yml (compose apps DO support --safe).');
    if (rl) rl.close();
    return;
  }

  let name = flags.name || positional[0];
  if (!name) name = interactive ? await ask(rl, 'App name', defaultName) : defaultName;

  const reg = loadRegistry();
  if (reg[name] && interactive) {
    const ans = await ask(rl, `"${name}" already exists here. Reconfigure it? (y/N)`, 'N');
    if (!/^y/i.test(ans)) { console.log('Aborted.'); rl.close(); return; }
  }

  let installCmd = flags.install;
  if (installCmd === undefined) {
    installCmd = dockerMode
      ? (dockerMode === 'compose' ? 'docker compose build --pull' : `docker build -t ${name}:gitlive .`)
      : (interactive
        ? await ask(rl, 'Install command (blank = none)', detected.installCmd || '')
        : (detected.installCmd || ''));
  }

  // build step (new-user field finding): install → build → start; Vite and
  // similar apps keep dist/ out of git, so the build must run on the deploy
  // machine. Omitted by default — apps that commit their build output or
  // need no build stay exactly as before.
  const buildCmd = flags.build;

  let startCmd = flags.start;
  if (startCmd === undefined) {
    if (dockerMode === 'compose') {
      startCmd = 'docker compose up -d';
    } else if (dockerMode === 'dockerfile') {
      // built below once the port contract is known
      startCmd = null;
    } else {
      startCmd = interactive
        ? await ask(rl, 'Start command (required)', detected.startCmd || '')
        : (detected.startCmd || '');
    }
  }
  if (dockerMode !== 'dockerfile' && !startCmd) {
    console.log('No start command given or detected. Pass one explicitly: --start "node server.js"');
    if (rl) rl.close();
    return;
  }

  let port = flags.port || '';
  if (!port && interactive) port = await ask(rl, 'Port your app listens on (for your reference only, not enforced)', '');

  // dockerfile mode needs the port contract to build its run mapping —
  // same honest requirement as --safe: an explicit --port.
  const internalDockerPort = flags['docker-port'] !== undefined ? Number(flags['docker-port'])
    : (detectedDockerPort || (port ? Number(port) : null));
  if (dockerMode === 'dockerfile') {
    if (!port) {
      console.log('docker deploys need --port (the public port; the container port comes from EXPOSE or --docker-port).');
      if (rl) rl.close();
      return;
    }
    startCmd = `docker run -d --name ${name}-live --restart unless-stopped -p 127.0.0.1:${Number(port)}:${internalDockerPort} ${name}:gitlive`;
  }

  const safe = Boolean(flags.safe);
  if (safe && !port) {
    console.log('--safe requires --port (the public port your app should be reachable on).');
    if (rl) rl.close();
    return;
  }
  if (rl) rl.close();

  // Check (and resolve internal ports) BEFORE touching disk at all — a
  // rejected --port used to still leave an orphaned bare repo + run
  // directory behind, since the check ran after mkdirSync/git-init-bare.
  // A failed `init` should leave nothing on disk.
  let preflightPorts = null;
  if (safe) {
    await checkPublicPort(reg, Number(port), name);
    preflightPorts = await resolveSafePorts(reg, name);
  }

  const barePath = path.join(APPS_DIR, `${name}.git`);
  const runPath = path.join(APPS_DIR, `${name}-run`);
  const logPath = path.join(runPath, 'deploy.log');
  const secrets = secretsPath(name);

  fs.mkdirSync(runPath, { recursive: true });
  if (!fs.existsSync(barePath)) sh(`git init --bare -b main ${JSON.stringify(barePath)}`);

  // --env-file seeds (or replaces) the secrets file gitlive sources into the
  // process env at start time. gitlive never displays or logs its contents —
  // see secretsPath()'s comment. Re-running init without --env-file leaves
  // an existing secrets file alone (reconfiguring shouldn't wipe secrets).
  if (flags['env-file']) {
    const envFileContent = fs.readFileSync(String(flags['env-file']), 'utf8');
    fs.writeFileSync(secrets, envFileContent, { mode: 0o600 });
    fs.chmodSync(secrets, 0o600);
    console.log(`Loaded secrets from ${flags['env-file']} (stored at ${secrets}, chmod 600).`);
  }

  const hookPath = path.join(barePath, 'hooks', 'post-receive');
  const nice = flags.nice !== undefined ? Number(flags.nice) : undefined;
  const memoryLimitMb = flags['memory-limit-mb'] !== undefined ? Number(flags['memory-limit-mb']) : undefined;
  if (memoryLimitMb) {
    console.log(`\n--memory-limit-mb is a coarse safety net (ulimit -v), not a precise cap — it can`);
    console.log(`stop a legitimate app from starting if set too tight, since it limits virtual`);
    console.log(`address space rather than actual memory use. Test after setting it.`);
  }

  let safeInfo = null;
  if (safe) {
    const { portA, portB } = preflightPorts;
    const healthPath = flags.health || '/';
    const statePath = path.join(runPath, 'active-slot');
    if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, 'A');

    fs.writeFileSync(hookPath, dockerMode === 'compose'
      ? buildSafeDockerHook({
          barePath, runPath, name, healthPath, portA, portB,
          gitliveFile: __filename, logPath, secretsPath: secrets,
        })
      : buildSafeHook({
          barePath, runPath, installCmd, buildCmd, startCmd, healthPath, portA, portB, name,
          gitliveFile: __filename, logPath, secretsPath: secrets, nice, memoryLimitMb,
        }));

    const proxyPath = path.join(runPath, 'proxy.js');
    fs.writeFileSync(proxyPath, buildProxyScript({ publicPort: Number(port), portA, portB, statePath }));
    const proxyPidPath = path.join(runPath, 'proxy.pid');
    const existingProxyPid = fs.existsSync(proxyPidPath) ? fs.readFileSync(proxyPidPath, 'utf8').trim() : null;
    if (!existingProxyPid || !isAlive(existingProxyPid)) {
      startBackgroundNode(proxyPath, proxyPidPath);
      console.log(`Started the gitlive proxy on port ${port} (forwards to whichever backend slot is live).`);
    }
    safeInfo = { safe: true, publicPort: Number(port), portA, portB, healthPath };
    if (dockerMode === 'compose') {
      console.log(`\nDocker safe mode (blue-green): each slot is its own compose project — the deploy exports`);
      console.log(`PORT per slot, so map it in compose.yml: ports: ["\${PORT}:<internal>"]. The swap is`);
      console.log(`health-checked at "${healthPath}" and the previous slot keeps serving until the new one proves it.`);
    } else {
      console.log(`\nSafe mode: each deploy starts on an internal port, is health-checked at "${healthPath}", and`);
      console.log(`only takes over from the previous version once it responds. Your start command must read the`);
      console.log(`PORT environment variable (gitlive sets it per deploy) rather than a hardcoded port.`);
    }
  } else if (dockerMode) {
    fs.writeFileSync(hookPath, buildDockerHook({
      barePath, runPath, installCmd, startCmd, logPath, secretsPath: secrets,
      gitliveFile: __filename, name, docker: dockerMode,
      containerName: `${name}-live`,
      port: port !== undefined && port !== '' ? Number(port) : undefined,
    }));
  } else {
    fs.writeFileSync(hookPath, buildHook({ barePath, runPath, installCmd, buildCmd, startCmd, logPath, secretsPath: secrets, nice, memoryLimitMb, gitliveFile: __filename, name, port: port !== undefined ? Number(port) : undefined }));
  }
  fs.chmodSync(hookPath, 0o755);

  // Owner-signature enforcement (Phase 2 D4): a pre-receive hook rejects any
  // push whose tip commit carries an app manifest the owner key did not sign,
  // or whose signed content does not match the pushed commit. Commits without
  // a manifest pass (legacy apps keep working) — enforcement is opt-in by
  // signing. Existing apps can install it with "gitlive manifest hook-install".
  try {
    require('./manifest.js').installPreReceiveHook({ barePath, gitliveFile: __filename });
  } catch (err) {
    console.log(`note: manifest verification hook not installed: ${err.message}`);
  }

  try { sh('git rev-parse --is-inside-work-tree', { cwd }); }
  catch { sh('git init -b main', { cwd }); }

  try { sh(`git remote remove ${name}`, { cwd }); } catch {}
  sh(`git remote add ${name} ${JSON.stringify(barePath)}`, { cwd });

  reg[name] = {
    cwd, barePath, runPath, installCmd, startCmd, port, createdAt: new Date().toISOString(),
    ...(nice !== undefined ? { nice } : {}),
    ...(memoryLimitMb !== undefined ? { memoryLimitMb } : {}),
    ...(buildCmd !== undefined ? { buildCmd } : {}),
    ...(safeInfo || {}),
    ...(dockerMode ? { docker: dockerMode, dockerPort: internalDockerPort } : {}),
  };
  saveRegistry(reg);

  console.log(`\nDone. From this folder, deploy any time with:\n\n  git push ${name} main\n`);
  // The guided next steps — a stranger's first ten minutes should never
  // require reading docs to know what comes after the first push.
  console.log(`Next steps (each one is real, none is busywork):`);
  console.log(`  1. git push ${name} main        → your first deploy, receipted`);
  console.log(`  2. gitlive open                 → watch it live on the dashboard`);
  console.log(`  3. gitlive backup ${name}       → prove your data can be restored`);
  console.log(`  4. gitlive domain public ${name} --domain <yours>   → give it a real name (or gitlive domain local on for <name>.gitlive)`);
  // Unified voice: apps are named, not numbered. The dashboard is where an
  // app's life is seen; raw addresses stay out of user-facing copy (field
  // direction, 2026-09-09 — localhost naming "takes away from one's effort").
  console.log(`\n"${name}" will appear in your gitlive dashboard the moment it's healthy — see it with:\n\n  gitlive open\n`);
  if (dockerMode === 'compose') {
    console.log(`\nDocker mode (compose): your compose file maps the port itself — the deploy exports`);
    console.log(`PORT (${port || 'the registered port'}), so write ports: ["\${PORT}:<internal>"] in compose.yml.`);
    console.log(`Blue-green for docker is a later step: plain mode means a brief downtime on each swap.`);
  } else if (dockerMode === 'dockerfile') {
    console.log(`\nDocker mode (Dockerfile): each deploy rebuilds the image and runs it bound to`);
    console.log(`127.0.0.1:${port} → container ${internalDockerPort} (EXPOSE). Blue-green for docker comes later — plain swap only.`);
  }
  console.log(`Your apps keep their names here. Giving them real domain names (https://…) is the\nnext gitlive step — you attach a domain you own, gitlive does the plumbing.\n`);
}

// ---------------------------------------------------------------------------
// hook-regen: bring an EXISTING app's deploy hooks up to the current pipeline
// ---------------------------------------------------------------------------
// Apps created by older gitlive builds keep their original generated hooks
// forever: the hook that runs on the next push is the hook that was written
// at init time. A hook written before the F1 closure gate, attestation
// fan-out, or owner-signed deploy tags existed deploys fine but silently
// skips all of them — the deploy-time provenance chain is missing even
// though the current gitlive supports it. Regen rewrites the app's
// post-receive (and refreshes pre-receive) from the CURRENT templates.
//
// Safe by construction, for two reasons:
//  1. Hooks are inert between pushes — nothing runs until the next
//     `git push`, and the currently serving code is not touched at all.
//  2. The templates and the internal commands they call (_closure-gate,
//     _record-deploy, _attest-deploy, _deploy-tag) live in the SAME file
//     that implements hook-regen, so a hook-regen that exists is by
//     construction able to serve every internal command it emits. The
//     previous hook is preserved one generation deep at
//     hooks/post-receive.previous before anything is overwritten.

// Safe-mode slot ports and health path live in the generated hook's header
// (PORT_A=/PORT_B=/HEALTH_PATH=) as ground truth: early registry entries —
// created before safe-mode ports were persisted — don't carry them, so the
// running hook is the source for a regen, not the registry.
function hookHeaderEnv(barePath) {
  const hookPath = path.join(barePath, 'hooks', 'post-receive');
  const env = {};
  if (!fs.existsSync(hookPath)) return env;
  for (const m of fs.readFileSync(hookPath, 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

const HOOK_CAPABILITIES = [
  ['_closure-gate', 'F1 dependency-closure gate (rejects unsigned dependency drift before install)'],
  ['CLOSURE_SHA', 'closure sha threaded into history + deploy tags'],
  ['_attest-deploy', 'attestation fan-out to mesh members'],
  ['_deploy-tag', 'owner-signed deploy tags (history as signed git refs)'],
  ['_record-deploy', 'deploy history recording'],
];

function hookCapabilities(text) {
  return HOOK_CAPABILITIES.filter(([token]) => text.includes(token)).map(([, label]) => label);
}

function cmdHookRegen(rest) {
  const { flags, positional } = parseFlags(rest);
  const dryRun = Boolean(flags['dry-run']);
  const name = positional[0];
  if (!name) {
    console.error('Usage: gitlive hook-regen <app-name> [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const reg = loadRegistry();
  const app = reg[name];
  if (!app) {
    console.error(`No app named "${name}". Run "gitlive list".`);
    process.exitCode = 1;
    return;
  }
  if (app.mode === 'connect') {
    console.error(`gitlive hook-regen: "${name}" is a connect-mode app — its deploy pipeline lives in the GitHub runner's deploy.sh, not in local git hooks. Nothing to regenerate here.`);
    process.exitCode = 1;
    return;
  }
  const hookPath = path.join(app.barePath, 'hooks', 'post-receive');
  if (!fs.existsSync(hookPath)) {
    console.error(`gitlive hook-regen: no post-receive hook at ${hookPath} — is "${name}" a gitlive local-mode app?`);
    process.exitCode = 1;
    return;
  }

  // Pre-receive (owner-signature enforcement) is refreshed only when it does
  // not already match the current template — a regen run on an up-to-date app
  // must be read-only, not a gratuitous file rewrite.
  const manifestMod = require('./manifest.js');
  const ensurePreReceive = () => {
    const prePath = path.join(app.barePath, 'hooks', 'pre-receive');
    const expected = manifestMod.buildPreReceiveHook({ barePath: app.barePath, gitliveFile: __filename });
    let current = null;
    try { current = fs.readFileSync(prePath, 'utf8'); } catch { /* absent → needs install */ }
    if (current === expected) return false;
    manifestMod.installPreReceiveHook({ barePath: app.barePath, gitliveFile: __filename });
    return true;
  };

  const oldText = fs.readFileSync(hookPath, 'utf8');
  const header = hookHeaderEnv(app.barePath);
  const common = {
    barePath: app.barePath, runPath: app.runPath, name,
    installCmd: app.installCmd, buildCmd: app.buildCmd, startCmd: app.startCmd,
    logPath: path.join(app.runPath, 'deploy.log'),
    secretsPath: secretsPath(name),
    gitliveFile: __filename,
    nice: app.nice, memoryLimitMb: app.memoryLimitMb,
    port: app.port !== undefined ? Number(app.port) : undefined,
  };
  let freshText;
  if (app.safe) {
    const portA = Number(app.portA ?? header.PORT_A);
    const portB = Number(app.portB ?? header.PORT_B);
    if (!Number.isFinite(portA) || !Number.isFinite(portB)) {
      console.error(`gitlive hook-regen: can't determine slot ports for safe-mode app "${name}" (registry has none and the current hook header has no PORT_A/PORT_B). Re-run "gitlive init --safe" from the app folder instead.`);
      process.exitCode = 1;
      return;
    }
    freshText = buildSafeHook({ ...common, healthPath: app.healthPath || header.HEALTH_PATH || '/', portA, portB });
  } else {
    freshText = buildHook(common);
  }

  const before = hookCapabilities(oldText);
  const after = hookCapabilities(freshText);
  const added = after.filter((c) => !before.includes(c));
  const removed = before.filter((c) => !after.includes(c));

  if (freshText === oldText) {
    try {
      if (ensurePreReceive()) console.log(`hook-regen: ${name}: pre-receive refreshed to the current enforcement template`);
    } catch (err) {
      console.error(`note: pre-receive refresh failed: ${err.message}`);
    }
    console.log(`hook-regen: ${name}: post-receive already matches the current pipeline — nothing to change (${oldText.length} bytes, ${app.safe ? 'safe' : 'plain'} mode)`);
    return;
  }

  if (dryRun) {
    console.log(`hook-regen: ${name} [dry-run] — would rewrite ${hookPath} (${oldText.length} → ${freshText.length} bytes)`);
    for (const c of added) console.log('  + ' + c);
    for (const c of removed) console.log('  - ' + c);
    console.log('  (nothing written)');
    return;
  }

  const backupPath = path.join(app.barePath, 'hooks', 'post-receive.previous');
  fs.writeFileSync(backupPath, oldText, { mode: 0o755 });
  fs.chmodSync(backupPath, 0o755);
  fs.writeFileSync(hookPath, freshText, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  try {
    if (ensurePreReceive()) console.log(`  pre-receive refreshed to the current enforcement template`);
  } catch (err) {
    console.error(`note: pre-receive refresh failed: ${err.message}`);
  }

  // Registry backfill: apps created before safe-mode ports were persisted get
  // them recorded now, so the dashboard/status can report slots + proxy from
  // the registry instead of only reading live files.
  const regBefore = JSON.stringify(reg);
  if (app.safe) {
    if (app.portA === undefined) app.portA = Number(header.PORT_A);
    if (app.portB === undefined) app.portB = Number(header.PORT_B);
    if (app.publicPort === undefined && app.port !== undefined) app.publicPort = Number(app.port);
    if (app.healthPath === undefined) app.healthPath = header.HEALTH_PATH || '/';
  }
  if (JSON.stringify(reg) !== regBefore) saveRegistry(reg);

  console.log(`hook-regen: ${name}: post-receive rewritten (${oldText.length} → ${freshText.length} bytes, ${app.safe ? 'safe' : 'plain'} mode)`);
  console.log(`  previous hook saved at ${backupPath}`);
  for (const c of added) console.log('  + ' + c);
  for (const c of removed) console.log('  - ' + c);
  if (header.GITLIVE_FILE && header.GITLIVE_FILE !== __filename) {
    console.log(`  gitliveFile: ${header.GITLIVE_FILE} → ${__filename}`);
  }
  console.log('  nothing runs until the next push — the live app keeps serving its current code');
}

// ---------------------------------------------------------------------------
// domain local: apps answer at <name>.gitlive on this machine (Tier 1)
// ---------------------------------------------------------------------------
// Owner direction (2026-09-09): apps are named, not numbered. This manages
// two local pieces — hosts entries (name -> this machine) and the gateway
// (control/domain-gateway.js) that routes "Host: <name>.gitlive" to the
// app's live port. No ports and no localhost appear in the copy. Raw
// addresses still exist underneath (the engine needs them); users don't.
// Design law: local plumbing only, never a hosted name service — a gitlive
// zone would be a revocation chokepoint (WORKFLOW.md "The naming law").
const DOMAIN_START = '# gitlive local domains (managed — do not edit)';
const DOMAIN_END = '# end gitlive local domains';
function hostsFilePath() { return process.env.GITLIVE_HOSTS_FILE || '/etc/hosts'; }
function domainNames(reg) {
  return Object.keys(reg)
    .filter((n) => reg[n].mode !== 'connect' && !reg[n].practice && (reg[n].port || reg[n].publicPort))
    .sort();
}
function hostsBlock(names) {
  const body = names.map((n) => `127.0.0.1\t${n}.gitlive`).join('\n');
  return `${DOMAIN_START}\n${body}\n${DOMAIN_END}`;
}
function readHosts() {
  try { return fs.readFileSync(hostsFilePath(), 'utf8'); } catch { return ''; }
}
function applyHosts(names) {
  // Surgical rewrite, line-based (no regex — markers contain parens): drop
  // everything between the managed markers inclusive; keep the rest of the
  // user's hosts file untouched.
  const file = hostsFilePath();
  const lines = readHosts().split('\n');
  const kept = [];
  let inBlock = false;
  for (const line of lines) {
    if (line === DOMAIN_START) { inBlock = true; continue; }
    if (inBlock) { if (line === DOMAIN_END) inBlock = false; continue; }
    kept.push(line);
  }
  let base = kept.join('\n').replace(/\n*$/, '\n');
  if (names.length) base += `${hostsBlock(names)}\n`;
  fs.writeFileSync(file, base);
}
function domainGatewayPaths() {
  const dir = path.join(HOME_DIR, 'domain');
  fs.mkdirSync(dir, { recursive: true });
  return { dir, pidFile: path.join(dir, 'gateway.pid'), logFile: path.join(dir, 'gateway.log') };
}
// ---------------------------------------------------------------------------
// local TLS: a gitlive local CA signs certificates for <name>.gitlive, so
// browsers stop calling the gateway unsafe (HTTPS-first browsers upgrade
// plain HTTP and then fail the handshake). Uses the system openssl — still
// zero npm dependencies. One trust step for the owner (Keychain), then
// https://<name>.gitlive is green; the same plumbing a real public domain
// will need later.
// ---------------------------------------------------------------------------
function domainTlsPaths() {
  const { dir } = domainGatewayPaths();
  return {
    dir,
    caKey: path.join(dir, 'ca.key'),
    caCrt: path.join(dir, 'ca.pem'),
    srvKey: path.join(dir, 'server.key'),
    srvCrt: path.join(dir, 'server.crt'),
    sanFile: path.join(dir, 'server.san'),
  };
}
function openssl(args, label) {
  const r = spawnSync('openssl', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${label} failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop() || 'openssl error'}`);
  return r.stdout || '';
}
function ensureLocalCA() {
  const p = domainTlsPaths();
  if (fs.existsSync(p.caKey) && fs.existsSync(p.caCrt)) return { created: false, path: p.caCrt };
  const cfg = path.join(p.dir, 'ca.cnf');
  fs.writeFileSync(cfg, '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=gitlive local CA\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
    '-keyout', p.caKey, '-out', p.caCrt, '-config', cfg, '-extensions', 'v3_ca'], 'local CA creation');
  fs.chmodSync(p.caKey, 0o600);
  return { created: true, path: p.caCrt };
}
function issueServerCert(names) {
  const p = domainTlsPaths();
  const sans = [...names.map((n) => `DNS:${n}.gitlive`), 'DNS:gitlive', 'DNS:localhost', 'IP:127.0.0.1'].join(',');
  if (fs.existsSync(p.srvCrt) && fs.existsSync(p.srvKey) && fs.existsSync(p.sanFile) && fs.readFileSync(p.sanFile, 'utf8').trim() === sans) {
    return { changed: false, names, path: p.srvCrt };
  }
  const ext = path.join(p.dir, 'server.ext');
  fs.writeFileSync(ext, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${sans}\n`);
  const csr = path.join(p.dir, 'server.csr');
  const cn = names.length ? `${names[0]}.gitlive` : 'gitlive';
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', p.srvKey, '-out', csr, '-subj', `/CN=${cn}`], 'server key/CSR');
  openssl(['x509', '-req', '-in', csr, '-CA', p.caCrt, '-CAkey', p.caKey, '-CAcreateserial',
    '-out', p.srvCrt, '-days', '825', '-sha256', '-extfile', ext], 'server certificate signing');
  fs.chmodSync(p.srvKey, 0o600);
  fs.writeFileSync(p.sanFile, sans + '\n');
  fs.rmSync(csr, { force: true });
  return { changed: true, names, path: p.srvCrt };
}
// The one trust step, per platform (post-roadmap #2): the same CA, the
// right store. darwin = Keychain; linux = the system CA bundle; anything
// else gets the honest generic answer (Windows is unsupported — the hooks
// and process groups are POSIX).
function trustCommand(platform = os.platform()) {
  const p = domainTlsPaths();
  if (platform === 'darwin') {
    return `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${p.caCrt}`;
  }
  if (platform === 'linux') {
    return `sudo cp ${p.caCrt} /usr/local/share/ca-certificates/gitlive.crt && sudo update-ca-certificates`;
  }
  return `install ${p.caCrt} into your system's trusted CA store (gitlive supports macOS and Linux)`;
}
function gatewayAlive() {
  const { pidFile } = domainGatewayPaths();
  try {
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    return Boolean(pid && isAlive(pid));
  } catch { return false; }
}
function startDomainGateway(flags) {
  const { pidFile, logFile } = domainGatewayPaths();
  if (gatewayAlive()) return { started: false, actualPort: null };
  const script = path.join(__dirname, 'control', 'domain-gateway.js');
  // Only an EXPLICIT port is passed through (--port or an inherited override
  // like tests/GITLIVE_GATEWAY_PORT). With no explicit port the gateway owns
  // the decision: try 80 (admin), then the first free 8080+ port, and report
  // which one took the traffic.
  const explicitPort = flags.port !== undefined ? Number(flags.port)
    : (process.env.GITLIVE_GATEWAY_PORT !== undefined ? Number(process.env.GITLIVE_GATEWAY_PORT) : null);
  const portEnv = explicitPort ? `GITLIVE_GATEWAY_PORT=${explicitPort} ` : '';
  const isDarwin = os.platform() === 'darwin';
  const tls = domainTlsPaths();
  const tlsReady = fs.existsSync(tls.srvCrt) && fs.existsSync(tls.srvKey);
  const tlsEnv = tlsReady
    ? `GITLIVE_TLS_CERT=${JSON.stringify(tls.srvCrt)} GITLIVE_TLS_KEY=${JSON.stringify(tls.srvKey)} `
      + (flags['tls-port'] !== undefined ? `GITLIVE_GATEWAY_TLS_PORT=${Number(flags['tls-port'])} `
        : (process.env.GITLIVE_GATEWAY_TLS_PORT !== undefined ? `GITLIVE_GATEWAY_TLS_PORT=${Number(process.env.GITLIVE_GATEWAY_TLS_PORT)} ` : ''))
    : '';
  const envLine = `${portEnv}${tlsEnv}GITLIVE_GATEWAY_PIDFILE=${JSON.stringify(pidFile)} GITLIVE_GATEWAY_LOG=${JSON.stringify(logFile)}`;
  const cmd = `${envLine} node ${JSON.stringify(script)}`;
  const wrapped = isDarwin
    ? `perl -e 'use POSIX "setsid"; POSIX::setsid(); exec { $ARGV[0] } @ARGV' bash -c ${JSON.stringify(cmd)}`
    : `setsid bash -c ${JSON.stringify(cmd)}`;
  const out = spawnSync('bash', ['-c', `${wrapped} >> ${JSON.stringify(logFile)} 2>&1 < /dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- & echo started`], { encoding: 'utf8' }).stdout.trim();
  // Give the gateway a beat to bind, then report the ACTUAL port from its log
  // (port 80 needs admin — it falls back to the first free 8080+ port and
  // says so). If it died instead, surface the reason rather than claiming
  // success: a stale gateway squatting the port is exactly how this went
  // wrong in the field.
  try { spawnSync('sleep', ['0.4'], { encoding: 'utf8' }); } catch { /* noop */ }
  let actualPort = explicitPort;
  let logTail = '';
  try {
    logTail = fs.readFileSync(logFile, 'utf8');
    const lines = logTail.trim().split('\n');
    const last = lines[lines.length - 1] || '';
    if (/could not bind/.test(last)) return { started: false, failed: true, reason: last, actualPort: null };
    const m = logTail.match(/listening on 127\.0\.0\.1:(\d+)(?![\s\S]*listening)/);
    if (m) actualPort = Number(m[1]);
  } catch { /* log not ready */ }
  if (!gatewayAlive()) return { started: false, failed: true, reason: (logTail.trim().split('\n').pop() || 'gateway exited'), actualPort: null };
  let tlsPort = null;
  const tm = logTail.match(/https listening on 127\.0\.0\.1:(\d+)(?![\s\S]*https listening)/);
  if (tm) tlsPort = Number(tm[1]);
  const tlsFailed = /https: no free port/.test(logTail) && !tlsPort;
  return { started: out.includes('started'), actualPort, explicit: Boolean(explicitPort), tlsPort, tlsFailed, tlsReady };
}
function stopDomainGateway() {
  const { pidFile } = domainGatewayPaths();
  try {
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    if (pid) { try { process.kill(-Number(pid)); } catch { try { process.kill(Number(pid)); } catch { /* gone */ } } }
    fs.rmSync(pidFile, { force: true });
  } catch { /* no pidfile yet */ }
}
function cmdDomain(rest) {
  const { flags, positional } = parseFlags(rest);
  // rest[0] IS the subcommand (dispatch invariant) — `domain local on` arrives
  // as ['local','on'].
  const sub = positional[0];
  if (sub === 'public') { cmdDomainPublic(positional, flags); return; }
  if (sub === 'zone') { cmdDomainZone(positional, flags); return; }
  if (sub === 'cert') { cmdDomainCert(positional, flags); return; }
  if (sub === 'graduate') { cmdDomainGraduate(positional, flags); return; }
  if (sub !== 'local') {
    console.error('Usage: gitlive domain local <on|off|list|tls>   (apps answer at <name>.gitlive on this machine)');
    console.error('       gitlive domain public <app> --domain <your.domain>   (Tier 2: your own domain)');
    console.error('       gitlive domain graduate <app> --domain <your.domain>   (zone label → your own domain)');
    console.error('       gitlive domain zone <your-domain>    one wildcard domain names every app: <app>.<zone>');
    console.error('       gitlive domain cert <domain>         automatic certificate (ACME DNS-01; works behind NAT)');
    console.error('       gitlive domain local on  [--port <n>]   gateway port (default 80; admin needed below 1024)');
    console.error('       gitlive domain local tls [--tls-port <n>]  https with a gitlive local CA (one trust step)');
    console.error('       gitlive domain public <app> --domain <your.domain>   (Tier 2: your own domain)');
    console.error('       gitlive domain zone <your-domain>    one wildcard domain names every app: <app>.<zone>');
    console.error('       gitlive domain cert <domain>         automatic certificate (ACME DNS-01; works behind NAT)');
    process.exitCode = 1;
    return;
  }
  const verb = positional[1];
  const reg = loadRegistry();
  const names = domainNames(reg);
  // The dashboard is reachable by name too ("gitlive" is reserved), so no part
  // of the experience sends anyone to a numbered address.
  const hostNames = ['gitlive', ...names];
  const target = verb === 'off' ? [] : hostNames;
  if (verb === 'tls') {
    try {
      const ca = ensureLocalCA();
      const cert = issueServerCert(hostNames);
      console.log(`gitlive domain: local CA ${ca.created ? 'created' : 'present'} — ${ca.path}`);
      console.log(`certificate ${cert.changed ? 'issued' : 'already current'} for: ${cert.names.length ? cert.names.map((n) => `${n}.gitlive`).join(', ') : 'gitlive (add apps any time)'}`);
      console.log('\nTrust it once — your password, one time (Keychain):\n');
      console.log('  ' + trustCommand() + '\n');
      console.log('Browsers then show a padlock instead of "unsafe". Refresh names with:');
      console.log('  gitlive domain local tls        (re-issues automatically when your apps change)');
      const wasUp = gatewayAlive();
      if (wasUp) stopDomainGateway();
      const g = startDomainGateway(flags);
      if (g.failed) {
        console.error(`gitlive domain: the gateway could not start — ${g.reason}`);
        process.exitCode = 1;
        return;
      }
      if (!wasUp) console.log(`gateway ${g.started ? 'started' : 'already running'}`);
      else console.log('gateway restarted with TLS');
      if (g.tlsPort) {
        console.log(`\nhttps is live on port ${g.tlsPort} (port 443 needs admin):`);
        for (const n of names) console.log(`  https://${n}.gitlive:${g.tlsPort}/`);
      } else {
        console.log('https listener not up yet — retry: gitlive domain local on');
      }
      console.log('\nDo the trust step above, then open one of those URLs — padlock, no warning.');
    } catch (err) {
      console.error('gitlive domain tls: ' + err.message);
      process.exitCode = 1;
    }
    return;
  }
  if (verb === 'on' || verb === 'off') {
    let hostsReady = true;
    try {
      applyHosts(target);
    } catch (err) {
      hostsReady = false;
      const current = readHosts();
      const already = hostNames.every((n) => current.includes(`\t${n}.gitlive`) || current.includes(` ${n}.gitlive`));
      if (verb === 'off' || !already) {
        console.error(`gitlive domain: ${hostsFilePath()} is not writable (${err.code || err.message}).`);
        console.error(`One admin moment, then gitlive manages itself:\n`);
        console.error(`  1) append the block below once:   sudo sh -c 'cat >> ${hostsFilePath()}'   (paste, then Ctrl-D)\n`);
        console.error(hostsBlock(target) + '\n');
        console.error(`  2) re-run:  ${verb === 'off' ? 'gitlive domain local off' : 'gitlive domain local on --port 8080'}`);
        console.error(`(never run gitlive itself under sudo — it would read the wrong user's apps.)`);
        process.exitCode = 1;
        return;
      }
      // hosts already carry every name (admin-appended earlier): proceed.
    }
    if (verb === 'on') {
      // keep the certificate in step with the app list when a CA exists
      const tlsP = domainTlsPaths();
      if (fs.existsSync(tlsP.caCrt)) { try { issueServerCert(hostNames); } catch { /* serve anyway */ } }
      const g = startDomainGateway(flags);
      if (g.failed) {
        console.error(`gitlive domain: the gateway could not start — ${g.reason}`);
        console.error('(a stale gateway from an old run can hold the port: stop it with `gitlive domain local off`, then retry)');
        process.exitCode = 1;
        return;
      }
      if (!hostsReady) console.log('gitlive domain: /etc/hosts already carries your names (admin-appended) — gateway only.');
      console.log(`gitlive domain: local names ON for ${names.length} app${names.length === 1 ? '' : 's'}:`);
      for (const n of names) console.log(`  http://${n}.gitlive/   →   ${n}`);
      console.log(g.started ? 'gateway started' : 'gateway already running');
      if (g.actualPort && !g.explicit && g.actualPort !== 80) {
        console.log(`note: gateway is on port ${g.actualPort} (port 80 needs admin). Your names resolve;`);
        console.log(`point your browser at http://<name>.gitlive:${g.actualPort}/ until port 80 is enabled once.`);
      }
      console.log('These names work in your browser on this machine. Your apps keep their names;');
      console.log('a real public domain attaches through gitlive later — you own it, gitlive does the plumbing.');
      if (g.tlsPort) {
        console.log(`\nhttps (padlock) is live on port ${g.tlsPort}:`);
        for (const n of names) console.log(`  https://${n}.gitlive:${g.tlsPort}/`);
        console.log('first time only: trust the local CA — `gitlive domain local tls` prints the one command.');
      }
    } else {
      stopDomainGateway();
      console.log('gitlive domain: local names OFF — hosts entries removed, gateway stopped.');
    }
  } else if (verb === 'list' || verb === 'status') {
    const on = readHosts().includes(DOMAIN_START);
    console.log(`local names: ${on ? 'ON' : 'off'} · gateway: ${gatewayAlive() ? 'up' : 'down'}`);
    if (names.length) { console.log('apps:'); for (const n of names) console.log(`  ${n}`); }
    else console.log('no apps yet — gitlive init one, then gitlive domain local on');
  } else {
    console.error('Usage: gitlive domain local <on|off|list|tls>   (apps answer at <name>.gitlive on this machine)');
    console.error('       gitlive domain local on  [--port <n>]   gateway port (default 80; admin needed below 1024)');
    console.error('       gitlive domain local tls [--tls-port <n>]  https with a gitlive local CA (one trust step)');
    console.error('       gitlive domain public <app> --domain <your.domain>   (Tier 2: your own domain)');
    console.error('       gitlive domain zone <your-domain>    one wildcard domain names every app: <app>.<zone>');
    console.error('       gitlive domain cert <domain>         automatic certificate (ACME DNS-01; works behind NAT)');
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Tier 2: the owner's own public domain.
// gitlive never runs a naming zone (a name someone else can revoke is a
// chokepoint). The user registers and controls the domain; gitlive prints the
// exact DNS records, routes that hostname to the app on this machine, and
// installs the certificate THEY hold. Next after this: automatic issuance
// (ACME) and the optional public entry node for NAT'd machines.
// ---------------------------------------------------------------------------
function publicCertDir() {
  const dir = path.join(HOME_DIR, 'domain', 'public');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function validPublicDomain(d) {
  return typeof d === 'string'
    && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)
    && !d.endsWith('.gitlive');
}
function installPublicCert(domain, certPath, keyPath) {
  const cert = fs.readFileSync(certPath, 'utf8');
  const key = fs.readFileSync(keyPath, 'utf8');
  try {
    require('tls').createSecureContext({ cert, key }); // throws on mismatch/invalid
  } catch (err) {
    throw new Error(`certificate and key do not match (or are invalid): ${err.message}`);
  }
  const text = spawnSync('openssl', ['x509', '-in', certPath, '-noout', '-text'], { encoding: 'utf8' }).stdout || '';
  const sanLine = (text.match(/X509v3 Subject Alternative Name:[\s\S]{0,300}/) || [''])[0];
  if (!sanLine.includes(`DNS:${domain}`)) {
    throw new Error(`this certificate does not cover ${domain} — SANs present: ${(sanLine.match(/DNS:[^,\s]+/g) || []).join(', ') || '(none found)'}`);
  }
  const dir = publicCertDir();
  fs.writeFileSync(path.join(dir, `${domain}.crt`), cert, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, `${domain}.key`), key, { mode: 0o600 });
  return { crt: path.join(dir, `${domain}.crt`), key: path.join(dir, `${domain}.key`) };
}
// ---------------------------------------------------------------------------
// Naming zones: one domain the owner controls, wildcard-routed, so every app
// gets <app>.<zone> with no per-app DNS work. Two doors, one mechanism:
// bring your own domain, or take a name from a zone (yours, or a community's
// — a zone is a ROLE, never a monopoly). A name from a zone is a borrowed
// label: graduating to your own domain is `gitlive domain graduate`.
// ---------------------------------------------------------------------------
function zonesFile() {
  const { dir } = domainGatewayPaths();
  return path.join(dir, 'zones.json');
}
function loadZones() {
  try { return JSON.parse(fs.readFileSync(zonesFile(), 'utf8')); } catch { return {}; }
}
function saveZones(z) {
  const f = zonesFile();
  fs.writeFileSync(f, JSON.stringify(z, null, 2), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
}
// Automatic certificates (ACME, DNS-01 — works behind NAT: no inbound port
// needed, only the ability to write one TXT record through a DNS API).
// `*.zone` covers EVERY app under that zone in one command — the zone's
// stored DNS token does the per-app work automatically (post-roadmap #6).
async function issueCertFor(domain, { zone, token, staging, directory }) {
  const acme = require('./acme.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glacme-'));
  try {
    const res = await acme.issue({
      domain, zone, token, staging,
      dir: path.join(HOME_DIR, 'domain', 'acme'),
      fetchImpl: (url, opts) => fetch(url, opts),
      directoryUrl: directory,
    });
    const certPath = path.join(tmp, `${domain}.crt`);
    fs.writeFileSync(certPath, res.certPem, { mode: 0o644 });
    const installed = installPublicCert(domain, certPath, res.keyPath);
    console.log(`certificate installed: ${installed.crt}  (${domain})`);
    return { ok: true, domain, cert: installed.crt };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function cmdDomainCert(positional, flags) {
  const target = String(positional[1] || '').trim().toLowerCase();
  if (!target || !/^[*a-z0-9.-]+$/.test(target)) {
    console.error('Usage: gitlive domain cert <domain|*.zone> [--zone <zone>] [--dns-token <t>] [--staging]');
    console.error('       *.zone issues a certificate for EVERY app under that zone in one command');
    process.exitCode = 1;
    return;
  }
  const zones = loadZones();
  const isZoneWildcard = target.startsWith('*.');
  const baseZone = isZoneWildcard ? target.slice(2) : target;
  const zone = String(flags.zone || '').toLowerCase()
    || Object.keys(zones).find((z) => baseZone === z || baseZone.endsWith('.' + z))
    || baseZone.replace(/^\*\./, '').split('.').slice(-2).join('.');
  const token = flags['dns-token'] || (zones[zone] && zones[zone].dnsToken);
  if (!token) {
    console.error(`gitlive domain cert: no DNS API token for zone "${zone}".`);
    console.error(`Register it once: gitlive domain zone ${zone} --dns-token <token>   (deSEC token)`);
    process.exitCode = 1;
    return;
  }
  const staging = Boolean(flags.staging) || Boolean(process.env.GITLIVE_ACME_DIRECTORY);
  const directory = process.env.GITLIVE_ACME_DIRECTORY
    ? process.env.GITLIVE_ACME_DIRECTORY
    : (staging ? require('./acme.js').LE_STAGING : require('./acme.js').LE_PRODUCTION);
  const domains = isZoneWildcard
    ? Object.keys(loadRegistry()).filter((n) => loadRegistry()[n].mode !== 'connect').map((n) => `${n}.${zone}`)
    : [target];
  if (!domains.length) {
    console.log(`no apps under zone ${zone} yet — gitlive init one first.`);
    return;
  }
  console.log(`gitlive domain cert: requesting ${domains.length} certificate(s) for ${isZoneWildcard ? `every app under *.${zone}` : target}${staging ? ' (staging)' : ''}…`);
  let failed = 0;
  // Sequential on purpose: ACME rate-limits parallel issuance, and one
  // certificate per round trip keeps the challenge records deterministic.
  (async () => {
    for (const d of domains) {
      try {
        await issueCertFor(d, { zone, token, staging, directory });
      } catch (err) {
        console.error(`gitlive domain cert: ${d}: ${err.message}`);
        failed++;
      }
    }
    if (failed === 0 && domains.length > 1) console.log(`zone ${zone}: ${domains.length} certificate(s) installed — every app under *.${zone} answers over https.`);
    if (failed === 0 && domains.length === 1) console.log(`Renewal: ACME certificates last 90 days — run this again before then (or schedule it).`);
    // one-shot command: exit cleanly instead of lingering on keep-alive sockets
    process.exit(failed ? 1 : 0);
  })();
}

function cmdDomainZone(positional, flags) {
  const sub = positional[1];
  const zones = loadZones();
  if (!sub || sub === 'list') {
    const rows = Object.keys(zones);
    if (!rows.length) { console.log('no naming zone yet — gitlive domain zone <your-domain>'); return; }
    for (const z of rows) console.log(`  ${z}   →   every app answers at <app>.${z}`);
    return;
  }
  if (sub === 'remove') {
    const d = String(flags.domain || '').toLowerCase();
    if (!zones[d]) { console.error(`zone ${d || '(none given)'} is not registered`); process.exitCode = 1; return; }
    delete zones[d]; saveZones(zones);
    console.log(`gitlive domain: zone ${d} removed (existing app domains keep routing).`);
    return;
  }
  const zone = String(sub).toLowerCase();
  if (!validPublicDomain(zone)) { console.error('Usage: gitlive domain zone <your-domain> [--dns-token <token>]'); process.exitCode = 1; return; }
  zones[zone] = { addedAt: new Date().toISOString(), ...(flags['dns-token'] ? { dnsToken: String(flags['dns-token']) } : {}) };
  saveZones(zones);
  console.log(`gitlive domain: zone ${zone} registered — every app gets <app>.${zone}`);
  console.log(`\nOne wildcard DNS record at YOUR registrar covers all of them:\n`);
  console.log(`  A   ${zone}       →   ${flags.ip || '<your public IP>'}`);
  console.log(`  A   *.${zone}     →   ${flags.ip || '<your public IP>'}`);
  console.log(`\nNames are lent to apps, never owned by gitlive: bring your own domain any time`);
  console.log(`(gitlive domain public <app> --domain <your.domain>) and move with it.`);
  if (flags['dns-token']) {
    console.log(`\nDNS token stored (mode 600) — automatic certificates can now be issued:`);
    console.log(`  gitlive domain cert *.${zone}`);
  }
}

function cmdDomainPublic(positional, flags) {
  const appName = positional[1];
  const reg = loadRegistry();
  if (appName === 'list' || (!appName && !flags.remove)) {
    const rows = Object.entries(reg).flatMap(([name, app]) => (app.domains || []).map((d) => ({ name, d })));
    if (!rows.length) { console.log('no public domains attached yet — gitlive domain public <app> --domain <your.domain>'); return; }
    for (const r of rows) console.log(`  ${r.d}   →   ${r.name}`);
    return;
  }
  if (flags.remove) {
    const d = String(flags.remove).toLowerCase();
    let removed = false;
    for (const app of Object.values(reg)) {
      if (Array.isArray(app.domains) && app.domains.includes(d)) {
        app.domains = app.domains.filter((x) => x !== d);
        removed = true;
      }
    }
    saveRegistry(reg);
    for (const f of [`${d}.crt`, `${d}.key`]) { try { fs.rmSync(path.join(publicCertDir(), f), { force: true }); } catch { /* noop */ } }
    console.log(removed ? `gitlive domain: ${d} detached (the DNS record is yours to remove).` : `gitlive domain: ${d} was not attached.`);
    return;
  }
  const app = reg[appName];
  if (!app) { console.error(`No app named "${appName}". Run "gitlive list".`); process.exitCode = 1; return; }
  const domain = String(flags.domain || '').toLowerCase();
  if (!validPublicDomain(domain)) {
    console.error('Usage: gitlive domain public <app> --domain <your.domain> [--ip <your.public.ip>] [--cert <file> --key <file>] [--check]');
    console.error('       the domain must be one you own (not *.gitlive), e.g. notes.mydomain.com');
    process.exitCode = 1;
    return;
  }
  app.domains = Array.from(new Set([...(app.domains || []), domain]));
  saveRegistry(reg);
  let certNote = 'certificate: none installed yet — the name answers over http until you add one (--cert/--key; automatic issuance is the next step)';
  if (flags.cert || flags.key) {
    if (!flags.cert || !flags.key) { console.error('gitlive domain public: --cert and --key go together.'); process.exitCode = 1; return; }
    try {
      const installed = installPublicCert(domain, String(flags.cert), String(flags.key));
      certNote = `certificate installed: ${installed.crt} (key ${installed.key}, mode 600)`;
    } catch (err) {
      console.error('gitlive domain public: ' + err.message);
      process.exitCode = 1;
      return;
    }
  }
  const zones = loadZones();
  const zoneHost = Object.keys(zones).find((z) => domain === z || domain.endsWith('.' + z));
  console.log(`gitlive domain: ${domain} → ${appName}`);
  if (zoneHost) {
    console.log(`\nCovered by your zone ${zoneHost} — the wildcard record you published already points here`);
    console.log(`(nothing new to add at the registrar).`);
    if (zones[zoneHost] && zones[zoneHost].dnsToken) {
      console.log(`This zone has a DNS token stored — one command covers every app with https:`);
      console.log(`  gitlive domain cert *.${zoneHost}`);
    }
  } else {
    console.log(`\nYour DNS record (at YOUR registrar — this domain is yours, not gitlive's):\n`);
    console.log(`  A     ${domain}    →    ${flags.ip || '<your public IP>'}`);
    console.log(`\nThen make this machine reachable on ports 80/443 (a router setting you control),`);
    console.log(`or put it behind a tunnel / entry node that is yours.`);
  }
  console.log(`\n${certNote}`);
  if (flags.check) {
    checkDomainArrival(domain);
  } else {
    console.log(`\nVerify from anywhere: gitlive domain public ${appName} --domain ${domain} --check`);
  }
}

// Data-shaped version of `domain public` for the control plane (launch
// journey milestone 3): attach the owner's own domain, install the cert
// when one is held, record zone coverage, and make it the app's CANONICAL
// name (primaryDomain) — the URL headline the card shows when public.
// Same building blocks as the CLI (validPublicDomain, installPublicCert,
// loadZones); the endpoint test locks the behavior.
function domainPublicData(appName, opts = {}) {
  const reg = loadRegistry();
  const app = reg[appName];
  if (!app) { const e = new Error(`No app named "${appName}". Run "gitlive list".`); e.code = 'NOT_FOUND'; throw e; }
  const domain = String((opts.domain || '')).toLowerCase();
  if (!validPublicDomain(domain)) { const e = new Error('the domain must be one you own (not *.gitlive), e.g. notes.mydomain.com'); e.code = 'INVALID_ARGS'; throw e; }
  app.domains = Array.from(new Set([...(app.domains || []), domain]));
  app.primaryDomain = domain;
  saveRegistry(reg);
  let certInstalled = false;
  let certError = null;
  if (opts.cert || opts.key) {
    if (!opts.cert || !opts.key) { const e = new Error('cert and key go together.'); e.code = 'INVALID_ARGS'; throw e; }
    try { certInstalled = Boolean(installPublicCert(domain, String(opts.cert), String(opts.key))); }
    catch (err) { certError = err.message; }
  }
  const zones = loadZones();
  const zoneHost = Object.keys(zones).find((z) => domain === z || domain.endsWith('.' + z));
  return {
    app: appName,
    domain,
    primaryDomain: domain,
    coveredByZone: zoneHost || null,
    zoneHasToken: Boolean(zoneHost && zones[zoneHost] && zones[zoneHost].dnsToken),
    certInstalled,
    certError,
    records: zoneHost ? null : [{ type: 'A', name: domain, value: String(opts.ip || '<your public IP>') }],
    note: zoneHost
      ? `covered by your zone ${zoneHost} — nothing new to add at the registrar`
      : 'add this A record at your registrar, then make ports 80/443 reach this machine (or point your entry node at it)',
  };
}

// Shared end-to-end proof: does this name resolve AND arrive back at this
// machine (DNS → gateway/entry → /.well-known/gitlive)? Used by
// `domain public --check` and `domain graduate --check`.
function checkDomainArrival(domain) {
  const script = `
    const dns = require('node:dns').promises;
    const https = require('node:https');
    (async () => {
      try { console.log('DNS: ' + (await dns.resolve4(${JSON.stringify(domain)})).join(', ')); } catch (e) { console.log('DNS: not resolving yet (' + e.code + ')'); }
      await new Promise((res) => {
        const req = https.get({ host: ${JSON.stringify(domain)}, path: '/.well-known/gitlive', rejectUnauthorized: false, timeout: 8000 }, (r) => {
          let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { console.log('arrival: ' + b.trim()); res(); });
        });
        req.on('error', (e) => { console.log('arrival: not reachable yet (' + e.code + ')'); res(); });
      });
    })();
  `;
  const r = spawnSync('node', ['-e', script], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stdout.write(r.stderr);
}

// ---------------------------------------------------------------------------
// Graduation: an app living under a borrowed zone label (<app>.<zone>) moves
// to its OWN domain in one command. A zone name is a loan — it can be
// revoked by the zone, so the app's real home is a domain the owner
// registers and controls. Graduation attaches that domain, makes it the
// app's canonical name, installs the certificate if one is held, and leaves
// the borrowed label answering until the zone operator drops it (their
// wildcard is theirs to manage — gitlive never touches it).
// ---------------------------------------------------------------------------
function cmdDomainGraduate(positional, flags) {
  const appName = positional[1];
  const domain = String(flags.domain || '').toLowerCase();
  if (!appName || !domain) {
    console.error('Usage: gitlive domain graduate <app> --domain <your.domain> [--cert <file> --key <file>] [--from <zone>] [--ip <public-ip>] [--check]');
    process.exitCode = 1;
    return;
  }
  const reg = loadRegistry();
  const app = reg[appName];
  if (!app) { console.error(`No app named "${appName}". Run "gitlive list".`); process.exitCode = 1; return; }
  if (!validPublicDomain(domain)) {
    console.error('Usage: gitlive domain graduate <app> --domain <your.domain> [--cert <file> --key <file>] [--from <zone>] [--ip <public-ip>] [--check]');
    console.error('       the domain must be one you own (not *.gitlive), e.g. myapp.example.com');
    process.exitCode = 1;
    return;
  }
  for (const [other, a] of Object.entries(reg)) {
    if (other !== appName && Array.isArray(a.domains) && a.domains.includes(domain)) {
      console.error(`gitlive domain graduate: ${domain} is already attached to "${other}".`);
      process.exitCode = 1;
      return;
    }
  }
  app.domains = Array.from(new Set([...(app.domains || []), domain]));
  app.primaryDomain = domain;
  app.graduatedAt = new Date().toISOString();
  const zones = loadZones();
  const zoneHost = Object.keys(zones).find((z) => domain === z || domain.endsWith('.' + z));
  // the borrowed label this app is leaving (when it was living under a zone)
  const fromZone = String(flags.from || '').toLowerCase() || Object.keys(zones)[0] || '';
  if (fromZone && zones[fromZone]) app.graduatedFrom = fromZone;
  saveRegistry(reg);
  let certNote = 'certificate: none installed yet — add one with --cert/--key (or ACME: gitlive domain cert ' + domain + ')';
  if (flags.cert || flags.key) {
    if (!flags.cert || !flags.key) { console.error('gitlive domain graduate: --cert and --key go together.'); process.exitCode = 1; return; }
    try {
      const installed = installPublicCert(domain, String(flags.cert), String(flags.key));
      certNote = `certificate installed: ${installed.crt} (key ${installed.key}, mode 600)`;
    } catch (err) {
      console.error('gitlive domain graduate: ' + err.message);
      process.exitCode = 1;
      return;
    }
  }
  let entryUrl = null;
  try { entryUrl = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'entry', 'client.json'), 'utf8')).url; } catch { /* no entry connection */ }
  console.log(`gitlive domain: ${domain} → ${appName} (canonical — graduated${app.graduatedFrom ? ' from ' + appName + '.' + app.graduatedFrom : ''})`);
  if (zoneHost) {
    console.log(`\nCovered by your zone ${zoneHost} — the wildcard record you published already points here`);
    console.log(`(nothing new to add at the registrar).`);
  } else if (entryUrl) {
    console.log(`\nYour DNS record (at YOUR registrar — this domain is yours, not gitlive's):\n`);
    console.log(`  A     ${domain}    →    <the public IP of your entry machine>`);
    console.log(`\nYou're connected to your entry node (${entryUrl}) — point the record at the ENTRY machine,`);
    console.log(`not at this machine: the entry relays the traffic here automatically, no open ports needed here.`);
  } else {
    console.log(`\nYour DNS record (at YOUR registrar — this domain is yours, not gitlive's):\n`);
    console.log(`  A     ${domain}    →    ${flags.ip || '<your public IP>'}`);
    console.log(`\nThen make this machine reachable on ports 80/443 (a router setting you control),`);
    console.log(`or put it behind a tunnel / entry node that is yours.`);
  }
  console.log(`\n${certNote}`);
  if (app.graduatedFrom) {
    console.log(`\nThe borrowed label ${appName}.${app.graduatedFrom} keeps answering as a courtesy until the zone`);
    console.log(`operator drops it (the wildcard is theirs — gitlive never touches another zone's records).`);
  }
  if (flags.check) {
    checkDomainArrival(domain);
  } else {
    console.log(`\nVerify from anywhere: gitlive domain graduate ${appName} --domain ${domain} --check`);
  }
}

// ---------------------------------------------------------------------------
// Pure data functions (no console output) — reused by both the CLI wrappers
// below and the MCP server (mcp/server.js), which requires this file
// in-process and must never let a stray console.log corrupt its stdio
// JSON-RPC channel. Every cmd* function below is a thin console.log
// wrapper around one of these.
// ---------------------------------------------------------------------------

function getApp(reg, name) {
  if (!name) throw new Error('Usage: gitlive <status|logs|stop|rm> <app-name>');
  if (!reg[name]) throw new Error(`No app named "${name}". Run "gitlive list".`);
  return reg[name];
}

function requireApp(reg, name) {
  try {
    return getApp(reg, name);
  } catch (err) {
    console.log(err.message);
    process.exit(1);
  }
}

function listAppsData() {
  const reg = loadRegistry();
  return Object.keys(reg).map((name) => {
    const app = reg[name];
    // connect-mode liveness is owned by launchd/systemd, not by a pid file
    // gitlive holds itself — reporting up/down here would be a guess gitlive
    // can't actually back up, so it's reported as its own tri-state instead.
    if (app.mode === 'connect') {
      return { name, alive: null, connect: true, safe: false, port: null, cwd: app.cwd };
    }
    let alive;
    if (app.docker) {
      alive = dockerAppUp(app, name);
      return { name, alive, connect: false, safe: false, port: app.port || null, cwd: app.cwd, docker: app.docker };
    }
    if (app.safe) {
      const pidPath = path.join(app.runPath, 'proxy.pid');
      const pid = fs.existsSync(pidPath) ? fs.readFileSync(pidPath, 'utf8').trim() : null;
      alive = Boolean(pid && isAlive(pid));
    } else {
      const pidFile = path.join(app.runPath, 'app.pid');
      const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : null;
      alive = Boolean(pid && isAlive(pid));
    }
    return { name, alive, connect: false, safe: Boolean(app.safe), port: app.port || null, cwd: app.cwd };
  });
}

function cmdList() {
  const apps = listAppsData();
  if (!apps.length) { console.log('No apps yet. Run "gitlive init" inside a project.'); return; }
  for (const a of apps) {
    if (a.connect) {
      console.log(`?     ${a.name} [connect]  (liveness managed by launchd/systemd, not tracked here)  — ${a.cwd}`);
      continue;
    }
    const mode = a.docker ? ' [docker]' : (a.safe ? ' [safe]' : '');
    console.log(`${a.alive ? 'up  ' : 'down'}  ${a.name}${mode}${a.port ? ` (port ${a.port})` : ''}  — ${a.cwd}`);
  }
}

function getStatusData(name) {
  const reg = loadRegistry();
  const app = getApp(reg, name);
  const data = {
    name,
    cwd: app.cwd,
    runPath: app.runPath,
    startCmd: app.startCmd,
    safe: Boolean(app.safe),
    connect: app.mode === 'connect',
    createdAt: app.createdAt,
    history: readHistory(app.runPath, 5),
    // presence only — never the contents, see secretsPath()'s comment.
    hasSecrets: fs.existsSync(secretsPath(name)),
    nice: app.nice,
    memoryLimitMb: app.memoryLimitMb,
  };
  // Lazy require — backend.js requires this file too (for loadRegistry/
  // isAlive/startBackgroundNode), so this stays a function-body require, not
  // a top-level one, to avoid a load-order issue: by the time getStatusData
  // is actually called, both files are fully loaded regardless of which one
  // was required first. See backend.js's own header comment for the mirror
  // of this reasoning.
  data.backend = require('./backend.js').backendStatusData(name, app);

  if (data.connect) {
    return data; // no pid/slot/port bookkeeping to add — see cmdStatus for the honest framing
  }
  if (app.safe) {
    const active = fs.existsSync(path.join(app.runPath, 'active-slot'))
      ? fs.readFileSync(path.join(app.runPath, 'active-slot'), 'utf8').trim() : '(none yet)';
    const proxyPidPath = path.join(app.runPath, 'proxy.pid');
    const proxyPid = fs.existsSync(proxyPidPath) ? fs.readFileSync(proxyPidPath, 'utf8').trim() : null;
    data.healthPath = app.healthPath;
    data.publicPort = app.publicPort;
    data.portA = app.portA;
    data.portB = app.portB;
    data.activeSlot = active;
    data.proxyUp = Boolean(proxyPid && isAlive(proxyPid));
    data.proxyPid = data.proxyUp ? proxyPid : null;
  } else if (app.docker) {
    data.docker = app.docker;
    data.up = dockerAppUp(app, name);
    data.pid = null; // containers, not host processes — docker's restart policy is the safety net
  } else {
    const pidFile = path.join(app.runPath, 'app.pid');
    const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : null;
    data.up = Boolean(pid && isAlive(pid));
    data.pid = data.up ? pid : null;
  }
  return data;
}

function cmdStatus(name) {
  const reg = loadRegistry();
  requireApp(reg, name); // validates & exits with a friendly message if missing
  const data = getStatusData(name);
  console.log(`${data.name}`);
  console.log(`  source: ${data.cwd}`);
  console.log(`  running from: ${data.runPath}`);
  console.log(`  start command: ${data.startCmd}`);
  console.log(`  secrets: ${data.hasSecrets ? 'present (values never shown)' : 'none'}`);
  if (data.nice !== undefined || data.memoryLimitMb !== undefined) {
    const parts = [];
    if (data.nice !== undefined) parts.push(`nice ${data.nice}`);
    if (data.memoryLimitMb !== undefined) parts.push(`memory limit ~${data.memoryLimitMb}MB (coarse, ulimit -v)`);
    console.log(`  resource limits: ${parts.join(', ')}`);
  }

  if (data.connect) {
    console.log(`  mode: connect (GitHub Actions -> launchd/systemd)`);
    console.log(`  liveness: not tracked here — owned by launchd (macOS) / systemd --user (Linux), not gitlive`);
  } else if (data.safe) {
    console.log(`  mode: safe (blue-green, health path "${data.healthPath}")`);
    console.log(`  public port: ${data.publicPort}  (backend A: ${data.portA}, backend B: ${data.portB})`);
    console.log(`  active slot: ${data.activeSlot}`);
    console.log(`  proxy: ${data.proxyUp ? `up (pid ${data.proxyPid})` : 'down'}`);
  } else if (data.docker) {
    console.log(`  mode: docker (${data.docker === 'compose' ? 'compose' : 'Dockerfile'})`);
    console.log(`  status: ${data.up ? 'up (containers running)' : 'down'}`);
  } else {
    console.log(`  status: ${data.up ? `up (pid ${data.pid})` : 'down'}`);
  }
  if (data.backend) {
    console.log(`  backend: ${data.backend.mode}${data.backend.mode === 'daemon' ? ` (daemon pid ${data.backend.daemonPid})` : ''}${data.backend.hasData ? '' : ' (no data yet)'}`);
  }
  console.log(`  created: ${data.createdAt}`);

  if (data.history.length) {
    console.log(`  last ${data.history.length} deploy(s):`);
    for (const h of data.history.slice().reverse()) {
      const commit = h.commit ? h.commit : '(unknown)';
      const reason = h.reason ? ` — ${h.reason}` : '';
      console.log(`    ${h.at}  ${h.outcome}  ${commit}${reason}`);
    }
  }
}

function getLogsData(name) {
  const reg = loadRegistry();
  const app = getApp(reg, name);
  const logPath = path.join(app.runPath, 'deploy.log');
  if (!fs.existsSync(logPath)) return { exists: false, text: '', logPath };
  return { exists: true, text: fs.readFileSync(logPath, 'utf8'), logPath };
}

function cmdLogs(name, follow) {
  const reg = loadRegistry();
  const app = requireApp(reg, name);
  const logPath = path.join(app.runPath, 'deploy.log');
  if (follow) {
    if (!fs.existsSync(logPath)) { console.log('No logs yet — deploy first.'); return; }
    spawnSync('tail', ['-f', logPath], { stdio: 'inherit' });
    return;
  }
  const data = getLogsData(name);
  if (!data.exists) { console.log('No logs yet — deploy first.'); return; }
  console.log(data.text);
}

function stopPidFile(pidPath) {
  if (!fs.existsSync(pidPath)) return { found: false, pid: null, killed: false };
  const pid = fs.readFileSync(pidPath, 'utf8').trim();
  let killed = false;
  if (isAlive(pid)) {
    try { process.kill(-Number(pid)); killed = true; } catch {
      try { process.kill(Number(pid)); killed = true; } catch {}
    }
  }
  fs.unlinkSync(pidPath);
  return { found: true, pid, killed };
}

// docker deploys (P1): real container state, never a guess. compose apps
// answer `docker compose ps`; Dockerfile apps answer `docker inspect`. No
// host pidfile exists for docker modes — docker's own restart policy is the
// safety net, and the daemon supervisor leaves them alone.
function dockerAppUp(app, name) {
  const cwd = path.join(app.runPath, 'live');
  try {
    if (app.docker === 'compose') {
      const r = spawnSync('docker', ['compose', 'ps', '-q', '--status', 'running'], { cwd, encoding: 'utf8', timeout: 20000 });
      return Boolean(r.stdout && r.stdout.trim());
    }
    const r = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', `${name}-live`], { encoding: 'utf8', timeout: 20000 });
    return r.status === 0 && String(r.stdout || '').trim() === 'true';
  } catch { return false; }
}
function startDockerApp(app, name) {
  const cwd = path.join(app.runPath, 'live');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    if (app.docker === 'compose') {
      spawnSync('docker', ['compose', 'up', '-d'], { cwd, encoding: 'utf8', timeout: 120000 });
    } else {
      const runCmd = `docker run -d --name ${name}-live --restart unless-stopped -p 127.0.0.1:${app.port}:${app.dockerPort || app.port} ${name}:gitlive`;
      spawnSync('bash', ['-c', runCmd], { cwd, encoding: 'utf8', timeout: 120000 });
    }
  } catch { /* status below tells the truth */ }
  return dockerAppUp(app, name);
}

function stopAppData(name) {
  const reg = loadRegistry();
  const app = getApp(reg, name);
  const results = [];
  if (app.docker && app.safe) {
    // docker blue-green (#4): down both compose slot projects + the proxy
    results.push({ label: `${name} (proxy)`, ...stopPidFile(path.join(app.runPath, 'proxy.pid')) });
    for (const slot of ['a', 'b']) {
      const r = spawnSync('docker', ['compose', '-p', `${name}-${slot}`, 'down'], { cwd: app.runPath, encoding: 'utf8', timeout: 60000 });
      const ok = !r.error && r.status === 0;
      results.push({ label: `${name} (docker slot ${slot})`, found: ok, killed: ok, pid: null });
    }
    return { name, safe: true, docker: app.docker, results, anyFound: results.some((r) => r.found) };
  }
  if (app.docker) {
    const wasUp = dockerAppUp(app, name);
    try {
      const cwd = path.join(app.runPath, 'live');
      if (app.docker === 'compose') spawnSync('docker', ['compose', 'down'], { cwd, encoding: 'utf8', timeout: 60000 });
      else spawnSync('docker', ['rm', '-f', `${name}-live`], { encoding: 'utf8', timeout: 60000 });
    } catch { /* docker absent — the wasUp answer is still honest */ }
    return { name, docker: app.docker, results: [{ label: `${name} (docker)`, found: wasUp, killed: wasUp, pid: null }], anyFound: wasUp };
  }
  if (app.safe) {
    results.push({ label: `${name} (proxy)`, ...stopPidFile(path.join(app.runPath, 'proxy.pid')) });
    results.push({ label: `${name} (backend A)`, ...stopPidFile(path.join(app.runPath, 'app-A.pid')) });
    results.push({ label: `${name} (backend B)`, ...stopPidFile(path.join(app.runPath, 'app-B.pid')) });
  } else {
    results.push({ label: name, ...stopPidFile(path.join(app.runPath, 'app.pid')) });
  }
  return { name, safe: Boolean(app.safe), results, anyFound: results.some((r) => r.found) };
}

// start a plain-mode app's process from its run dir (same idiom as the
// generated post-receive hook: env + setsid/perl + pid file + log line).
function startPlainAppProcess(app, logPath) {
  const live = path.join(app.runPath, 'live');
  const dataDir = path.join(app.runPath, 'data');
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const start = app.startCmd || 'node server.js';
  const isDarwin = os.platform() === 'darwin';
  const wrapped = isDarwin
    ? `perl -e 'use POSIX "setsid"; POSIX::setsid(); exec { $ARGV[0] } @ARGV' bash -c ${JSON.stringify(start)}`
    : `setsid bash -c ${JSON.stringify(start)}`;
  // Same PORT contract as the generated hook (plain mode exports the app's
  // registered port when it has one) — restart must not change what the app
  // sees at first boot.
  const portAssign = app.port !== undefined ? `PORT=${JSON.stringify(String(app.port))} ` : '';
  const cmd = `${portAssign}GITLIVE_DATA_DIR=${JSON.stringify(dataDir)} ${wrapped} >> ${JSON.stringify(logPath)} 2>&1 < /dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- & echo $!`;

  let out = '';
  try { out = execFileSync('bash', ['-c', cmd], { cwd: live, encoding: 'utf8' }).trim(); } catch (e) { out = String(e.stdout || '').trim(); }
  const pid = out.split('\n').pop().trim();
  if (pid && /^\d+$/.test(pid)) fs.writeFileSync(path.join(app.runPath, 'app.pid'), pid);
  return pid;
}

// restart: plain = stop + start same code. safe = supervise the public proxy
// (revive it if dead — the field finding from 2026-09-08) and report; a code
// restart in safe mode is a redeploy (new commit) or rollback by design.
function restartAppData(name) {
  const reg = loadRegistry();
  const app = getApp(reg, name);
  const logPath = path.join(app.runPath, 'deploy.log');
  if (app.docker) {
    stopAppData(name);
    const up = startDockerApp(app, name);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] restart: docker ${app.docker} — containers ${up ? 'running' : 'did not come up'}\n`);
    return { name, docker: true, up };
  }
  if (app.safe) {
    const proxyPath = path.join(app.runPath, 'proxy.js');
    const proxyPidPath = path.join(app.runPath, 'proxy.pid');
    const proxyPid = fs.existsSync(proxyPidPath) ? fs.readFileSync(proxyPidPath, 'utf8').trim() : null;
    let revived = false;
    if (proxyPath && (!proxyPid || !isAlive(proxyPid))) {
      if (fs.existsSync(proxyPath)) {
        startBackgroundNode(proxyPath, proxyPidPath);
        revived = true;
      }
    }
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] restart: safe mode — proxy ${revived ? 'revived' : 'already up'}\n`);
    return { name, safe: true, proxyRevived: revived, note: 'safe mode: code swap = git push (new commit) or rollback; restart supervises the proxy' };
  }
  // plain: stop then start in place
  const stopped = stopAppData(name);
  const pid = startPlainAppProcess(app, logPath);
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] restart: stopped old, started pid ${pid}\n`);
  return { name, safe: false, stopped: stopped.anyFound, pid };
}

// ── the App Pool (launch journey checkpoint 5) ────────────────────────────
// Finished apps rest in the pool instead of competing for the yard. Entry
// is gated by the admission exam — the owner's "SaaS points of a healthy
// app": alive + answering, named + public + TLS, no leakage, receipts
// valid, backup on record. A failing check produces a diagnosis line, so
// the app's card can show what's wrong instead of a mystery.

function probeApp(app) {
  // one bounded HTTP probe against the app's public face — where the app
  // lives (plain port, safe public port, docker container port).
  const port = app.port || (app.publicPort || null);
  if (!port) return null;
  const base = `http://127.0.0.1:${port}`;
  const get = (p, timeoutMs = 2500) => new Promise((resolve) => {
    const ctrl = AbortSignal.timeout(timeoutMs);
    fetch(base + p, { signal: ctrl }).then(async (r) => {
      const text = await r.text().catch(() => '');
      resolve({ status: r.status, ok: r.ok, text: text.slice(0, 4000), headers: r.headers });
    }).catch(() => resolve(null));
  });
  return { base, get };
}

async function poolAdmissionData(name) {
  const reg = loadRegistry();
  const app = getApp(reg, name);
  const checks = [];
  const diagnosis = [];
  const add = (key, ok, note) => { checks.push({ key, ok, note }); if (!ok) diagnosis.push({ key, note }); };

  // 1 — alive + answering
  const states = listAppsData();
  const st = states.find((s) => s.name === name);
  const alive = Boolean(st && st.alive === true);
  const probe = alive ? probeApp(app) : null;
  let answering = false;
  if (probe) {
    const root = await probe.get('/');
    answering = Boolean(root && root.ok);
  }
  add('alive', alive && answering, alive && answering
    ? `running and answering on :${app.port || app.publicPort}`
    : (alive ? 'process is up but did not answer a probe' : 'not running — deploy it'));

  // 2 — named + public + TLS
  const primary = app.primaryDomain || (app.domains && app.domains[0]) || null;
  let certOk = false;
  if (primary) {
    try { certOk = fs.existsSync(path.join(publicCertDir(), `${primary}.crt`)); } catch { certOk = false; }
  }
  add('public', Boolean(primary) && certOk, primary
    ? (certOk ? `${primary} with a certificate on file` : `${primary} — no certificate yet (gitlive domain cert or --cert/--key)`)
    : 'not public yet — make it public from its card');

  // 3 — no leakage: the app must not serve its secrets or git internals
  let leakNote = 'no secrets or git internals served';
  let leakOk = true;
  if (probe && answering) {
    const bad = [];
    for (const p of ['/.env', '/.git/config', '/.git/HEAD', '/.env.local']) {
      const r = await probe.get(p, 1500);
      if (r && r.ok && r.text && r.text.length > 5 && !/not found|404|<!DOCTYPE html>/.test(r.text.slice(0, 60))) bad.push(p);
    }
    if (bad.length) { leakOk = false; leakNote = `LEAK: the app serves ${bad.join(', ')} — move secrets out of the web root and block .git`; }
    const poweredBy = probe ? await probe.get('/', 1500).then((r) => (r && r.headers && r.headers.get ? r.headers.get('x-powered-by') : null)) : null;
    if (poweredBy) leakNote += `; x-powered-by: ${poweredBy} (tells attackers the stack — remove it)`;
  } else if (probe) { leakOk = false; leakNote = 'could not probe — the app did not answer'; }
  add('leak', leakOk, leakNote);

  // 4 — receipts valid (owner-signed deploy history)
  let receiptOk = false;
  let receiptNote = 'no deploy receipt on record';
  try {
    const hist = readHistory(app.runPath, 20);
    const last = hist[hist.length - 1];
    if (last) {
      const tags = parseDeployTags(app.barePath, 5);
      const tag = Array.isArray(tags) ? tags.find((t) => t.commit === last.commit) : null;
      receiptOk = Boolean(tag && tag.sigValid);
      receiptNote = receiptOk ? `latest deploy ${last.commit.slice(0, 8)} — owner signature valid` : `latest deploy ${last.commit.slice(0, 8)} — ${last.outcome || 'no signature on record'}`;
    }
  } catch { /* leave honest failure */ }
  add('receipts', receiptOk, receiptNote);

  // 5 — backup on record (data provably restorable)
  let backupOk = false;
  let backupNote = 'no verified restore on record';
  try {
    const lines = fs.readFileSync(path.join(app.runPath, 'backup-history.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const verified = rows.find((r) => r.verify === true);
    backupOk = rows.length > 0 && Boolean(verified);
    backupNote = backupOk
      ? `backup on record${verified ? `, verified restore ${String(verified.at || '').slice(0, 10)}` : ''}`
      : (rows.length ? 'backups exist but none has been verified — run gitlive backup verify' : 'no backup yet — gitlive backup init && gitlive backup <app>');
  } catch { /* leave honest failure */ }
  add('backup', backupOk, backupNote);

  const admitted = checks.every((c) => c.ok);
  if (admitted) {
    app.admitted = { at: new Date().toISOString(), checks: checks.map((c) => c.key) };
  } else {
    delete app.admitted;
  }
  saveRegistry(reg);
  return { app: name, admitted, passed: checks.filter((c) => c.ok).length, total: checks.length, checks, diagnosis };
}

function poolListData() {
  const reg = loadRegistry();
  const states = listAppsData();
  return Object.entries(reg)
    .filter(([, a]) => a.mode !== 'connect' && a.admitted)
    .map(([name, a]) => ({
      name,
      url: a.primaryDomain || (a.domains && a.domains[0]) || null,
      admittedAt: a.admitted && a.admitted.at,
      port: a.port || a.publicPort || null,
      alive: Boolean((states.find((x) => x.name === name) || {}).alive === true),
    }));
}

// ── the name office (launch journey phase 1: gitlive as a DNS client) ─────
// One configured zone with a DNS token turns every app into a globally
// visible name: the deploy hook writes <app>.<zone> → this machine's public
// IPv6 through the provider's API (deSEC today; the provider table lives in
// acme.js and is the seam for phase 3, gitlive's own DNS server).
function publicIpv6() {
  try {
    const out = execFileSync('ifconfig', [], { encoding: 'utf8', timeout: 5000 });
    // prefer the STABLE "autoconf secured" address (the "temporary" privacy
    // address rotates and would break the record)
    for (const m of out.matchAll(/inet6 (2[0-9a-f]{3}:[0-9a-f:]+)(?:%\S+)? prefixlen \d+ autoconf secured/g)) {
      const a = m[1];
      if (!/^f[dc]/.test(a) && !a.startsWith('fe80')) return a;
    }
  } catch { /* no ifconfig — fall through */ }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv6' && !i.internal && /^(2|3)/.test(i.address) && !/^f[dc]/.test(i.address)) return i.address.split('%')[0];
    }
  }
  return null;
}

async function publishAppDns(appName) {
  const reg = loadRegistry();
  const app = getApp(reg, appName);
  const zones = loadZones();
  // which zone does this app live under? explicit app.zone, else any zone the
  // app's domains end with.
  let zone = app.zone || null;
  if (!zone) {
    zone = Object.keys(zones).find((z) => (app.domains || []).some((d) => d === z || d.endsWith('.' + z))) || null;
  }
  let autoNamed = false;
  if (!zone) {
    // phase 2: the first push claims a name automatically — the owner set up
    // a zone with a token exactly so apps never need per-app DNS steps.
    zone = Object.keys(zones).find((z) => zones[z] && zones[z].dnsToken) || null;
    if (zone) {
      app.domains = Array.from(new Set([...(app.domains || []), `${appName}.${zone}`]));
      app.zone = zone;
      saveRegistry(reg);
      autoNamed = true;
    }
  }
  if (!zone) return { ok: false, app: appName, reason: 'no zone label — register a zone with a DNS token (Settings → naming → zones) and the first push names the app automatically' };
  const token = zones[zone] && zones[zone].dnsToken;
  if (!token) return { ok: false, app: appName, zone, reason: `zone ${zone} has no DNS token — add it in Settings → naming → zones` };
  const ip = publicIpv6();
  if (!ip) return { ok: false, app: appName, zone, reason: 'this machine has no public IPv6 — set the record manually or point an entry node at the zone' };
  const { providers } = require('./acme.js');
  const provider = providers.desec;
  const record = `${appName}.${zone}`;
  await provider.createRecord({ token, zone, subname: appName, type: 'AAAA', value: ip, fetchImpl: fetch });
  if (autoNamed) {
    try { require('./crypt.js').logEvent('auto-named', { app: appName, zone, record }); } catch { /* noop */ }
  }
  // receipt: the DNS change is a fact, audited like everything else
  try {
    fs.appendFileSync(path.join(app.runPath, 'dns-history.jsonl'), JSON.stringify({ at: new Date().toISOString(), app: appName, zone, record, type: 'AAAA', value: ip, provider: provider.name }) + '\n');
  } catch { /* receipt is best-effort */ }
  try { require('./crypt.js').logEvent('dns-publish', { app: appName, zone, record, value: ip }); } catch { /* noop */ }
  return { ok: true, app: appName, zone, record, value: ip, provider: provider.name, autoNamed, note: (autoNamed ? 'auto-named on first push — ' : '') + 'globally visible over IPv6 — cert issuance is one command: gitlive domain cert *.' + zone };
}

function cmdName(rest) {
  const sub = rest[0];
  if (sub === 'publish') {
    const name = rest[1];
    if (!name) { console.error('Usage: gitlive name publish <app> — write <app>.<zone> → this machine\u2019s public IPv6'); process.exitCode = 1; return; }
    publishAppDns(name).then((r) => {
      if (r.ok) {
        console.log(`[name office] ${r.record} → ${r.value} (${r.provider})`);
        if (r.autoNamed) console.log('[name office] first push — the app claimed its name automatically');
      }
      else { console.error(`[name office] ${name}: ${r.reason}`); process.exitCode = 1; }
    }).catch((err) => { console.error('[name office] ' + err.message); process.exitCode = 1; });
    return;
  }
  if (sub === 'status') {
    const zones = loadZones();
    const ip = publicIpv6();
    console.log(`this machine: ${ip || 'no public IPv6'}`);
    const rows = Object.keys(zones);
    if (!rows.length) { console.log('no naming zones yet — gitlive name office add <your-domain> --token <deSEC-token>'); return; }
    for (const z of rows) {
      console.log(`  ${z}   dns token: ${zones[z].dnsToken ? 'stored ✓' : 'missing'}   →   every app answers at <app>.${z}`);
    }
    return;
  }
  console.error('Usage: gitlive name publish <app> | gitlive name status | gitlive name office add <domain> --token <t>');
  process.exitCode = 1;
}

// ── boot (the blindspot that trapped the owner: after a reboot nothing was
// running, and the first command had to come from a terminal). `gitlive boot
// install` writes a macOS LaunchAgent (no sudo) that starts the control
// plane at login and keeps it alive; the server, seeing GITLIVE_BOOT_RESTORE,
// runs the master switch once at boot so the whole machine restores itself.
// "Nothing automatic" was about the OUTSIDE world — this is the caretaker
// inside the house, receipted like everything else.
const BOOT_PLIST_PATH = () => path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.gitlive.control.plist');
function gitliveBin() {
  try { return execSync('which gitlive', { encoding: 'utf8' }).trim() || null; } catch { return null; }
}
function cmdBoot(rest) {
  const sub = rest[0];
  if (sub === 'status') {
    const p = BOOT_PLIST_PATH();
    console.log(fs.existsSync(p)
      ? `boot: installed at ${p} — the control plane starts at login and restores the machine`
      : 'boot: not installed — gitlive boot install (the control plane comes back on its own after a reboot)');
    return;
  }
  if (sub === 'remove') {
    try { execSync('launchctl bootout gui/$(id -u)/dev.gitlive.control 2>/dev/null', { shell: '/bin/bash' }); } catch { /* not loaded */ }
    try { fs.rmSync(BOOT_PLIST_PATH(), { force: true }); } catch { /* noop */ }
    console.log('boot: removed — after a reboot you start it yourself: gitlive serve --no-open');
    return;
  }
  if (sub !== 'install') {
    console.error('Usage: gitlive boot install | remove | status');
    process.exitCode = 1;
    return;
  }
  const bin = gitliveBin();
  if (!bin) { console.error('boot: could not find the gitlive binary on PATH — install it first (npm install -g gitlive)'); process.exitCode = 1; return; }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.gitlive.control</string>
  <key>ProgramArguments</key>
  <array><string>${bin}</string><string>serve</string><string>--no-open</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>GITLIVE_BOOT_RESTORE</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${path.join(os.homedir(), '.gitlive', 'control', 'serve.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), '.gitlive', 'control', 'serve.log')}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(BOOT_PLIST_PATH()), { recursive: true });
  fs.writeFileSync(BOOT_PLIST_PATH(), plist);
  let loaded = false;
  try { execSync('launchctl bootstrap gui/$(id -u) ' + JSON.stringify(BOOT_PLIST_PATH()), { shell: '/bin/bash' }); loaded = true; } catch { /* already bootstrapped — RunAtLoad will take effect next login */ }
  console.log(`boot: installed${loaded ? ' and loaded' : ' — takes effect at next login'}.`);
  console.log('After a reboot: the control plane starts on its own and the master switch restores every app (receipted).');
  console.log('Remove any time: gitlive boot remove');
}

function cmdPool(rest) {
  const sub = rest[0];
  if (sub === 'check') {
    const name = rest[1];
    if (!name) { console.error('Usage: gitlive pool check <app> — run the admission exam'); process.exitCode = 1; return; }
    poolAdmissionData(name).then((r) => {
      for (const c of r.checks) console.log(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.key} — ${c.note}`);
      console.log(r.admitted ? `\n${name}: admitted — resting in the pool` : `\n${name}: NOT admitted (${r.passed}/${r.total}) — the card will show what's wrong`);
      if (!r.admitted) process.exitCode = 1;
    }).catch((err) => { console.error('gitlive pool check: ' + err.message); process.exitCode = 1; });
    return;
  }
  const rows = poolListData();
  if (!rows.length) { console.log('the pool is empty — an app enters once it passes the admission exam: gitlive pool check <app>'); return; }
  for (const r of rows) console.log(`  ${r.name}   ${r.alive ? 'up' : 'DOWN'}   ${r.url || '(no url)'}`);
}

// ── reboot recovery (field lesson 2026-09-11: a macOS update rebooted the
// machine and every gitlive process died — plain apps, safe proxies, the
// control plane). `gitlive up` is the one-command answer: check the plane,
// then bring every local app back. The per-app recipe is the one proven on
// the real machine: down app → deploy (full pipeline) → safe apps also get
// a restart (revives the blue-green proxy that binds the public port). The
// control plane itself is deliberately NOT auto-spawned: its lifecycle
// stays the owner's explicit call (one instance, `gitlive serve --no-open`).
function upData() {
  const reg = loadRegistry();
  const names = Object.keys(reg).filter((n) => reg[n].mode !== 'connect');
  const states = listAppsData();
  const stateFor = (n) => states.find((s) => s.name === n);

  let planeUp = false;
  try {
    const marker = path.join(os.homedir(), '.gitlive', 'control.url');
    const planeUrl = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : 'http://127.0.0.1:5180';
    execFileSync('node', ['-e', `fetch(${JSON.stringify(planeUrl + '/')}, { signal: AbortSignal.timeout(1500) }).then(async (r) => { if (!r.ok) process.exit(2); const t = await r.text(); process.exit(t.includes('gitlive control plane') ? 0 : 3); }).catch(() => process.exit(4));`], { encoding: 'utf8', timeout: 5000 });
    planeUp = true; // the probe child exits 0 only when a gitlive control plane answered
  } catch { planeUp = false; }

  const rows = [];
  let failed = 0;
  for (const name of names) {
    const app = reg[name];
    const before = stateFor(name);
    const alive = before ? before.alive === true : false;
    if (alive) { rows.push({ name, wasUp: true, ok: true, note: 'already up' }); continue; }
    const dep = deployAppData(name);
    if (app.safe) restartAppData(name); // revive the blue-green proxy (public port)
    const after = listAppsData().find((s) => s.name === name); // fresh read — the snapshot above predates the deploy
    const up = after && after.alive === true;
    if (up) rows.push({ name, wasUp: false, ok: true, note: dep.ok ? 'revived' : 'revived (pipeline reported issues — verify)' });
    else { failed += 1; rows.push({ name, wasUp: false, ok: false, note: 'still down — check the deploy log' }); }
  }
  return { planeUp, apps: rows, failed, allUp: failed === 0 && rows.every((r) => r.ok) };
}

function cmdUp() {
  const r = upData();
  console.log(r.planeUp ? 'control plane: already up' : 'control plane: DOWN — start it yourself: gitlive serve --no-open');
  if (!r.apps.length) { console.log('no local apps registered — nothing to revive'); return; }
  for (const a of r.apps) {
    if (a.wasUp) console.log(`${a.name}: already up`);
    else console.log(`${a.name}: ${a.note}`);
  }
  if (r.failed) {
    console.error(`\ngitlive up: ${r.failed} app${r.failed === 1 ? '' : 's'} could not be revived.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll local apps are up.');
  }
}

function cmdRestart(name) {
  let data;
  try { data = restartAppData(name); } catch (err) { console.log(err.message); process.exit(1); }
  if (data.docker) {
    console.log(`${data.name}: docker ${data.up ? 'containers running' : 'start failed — check the deploy log'}`);
  } else if (data.safe) {
    console.log(`${data.name}: proxy ${data.proxyRevived ? 'revived' : 'already up'}. ${data.note}`);
  } else {
    console.log(`${data.name}: ${data.pid ? `restarted (pid ${data.pid})` : 'start failed — check the deploy log'}`);
  }
}

function cmdStop(name) {
  let data;
  try { data = stopAppData(name); } catch (err) { console.log(err.message); process.exit(1); }
  for (const r of data.results) {
    if (r.found && r.killed) console.log(`Stopped ${r.label} (pid ${r.pid}).`);
  }
  if (!data.anyFound) {
    console.log(data.safe ? `${data.name} was not running.` : `${data.name} is not running.`);
  }
}

async function cmdRm(name, flags) {
  const reg = loadRegistry();
  const app = requireApp(reg, name);
  const isConnect = app.mode === 'connect';
  const prompt = isConnect
    ? `Remove gitlive's record of "${name}" (deploy history + registry entry)? This does NOT touch the launchd/systemd service, the GitHub Actions workflow, or your repo. (y/N)`
    : `Delete "${name}" entirely — bare repo, running app, and its data? (y/N)`;
  if (!flags.yes) {
    const rl = readline.createInterface({ input, output });
    const ans = await ask(rl, prompt, 'N');
    rl.close();
    if (!/^y/i.test(ans)) { console.log('Aborted.'); return; }
  }
  if (isConnect) {
    // gitlive never owned the launchd plist / systemd unit / GitHub workflow
    // for a connect app — only its own bookkeeping (runPath, registry entry,
    // secrets file). Deleting those isn't gitlive's call to make silently.
    fs.rmSync(app.runPath, { recursive: true, force: true });
    fs.rmSync(secretsPath(name), { force: true });
    delete reg[name];
    saveRegistry(reg);
    console.log(`Removed gitlive's record of ${name}. The launchd/systemd service and .github/workflows/deploy.yml are untouched — remove those yourself if you want the app fully gone.`);
    return;
  }
  cmdStop(name);
  fs.rmSync(app.barePath, { recursive: true, force: true });
  fs.rmSync(app.runPath, { recursive: true, force: true });
  fs.rmSync(secretsPath(name), { force: true });
  delete reg[name];
  saveRegistry(reg);
  console.log(`Removed ${name}.`);
}

function getDoctorData() {
  const data = { version: VERSION, filename: __filename, linked: null, real: null, mismatch: false, apps: [] };
  let linked = null;
  try { linked = sh('command -v gitlive').trim(); } catch {}
  if (linked) {
    let real = linked;
    try { real = fs.realpathSync(linked); } catch {}
    data.linked = linked;
    data.real = real;
    data.mismatch = path.resolve(real) !== path.resolve(__filename);
  }
  const reg = loadRegistry();
  data.apps = Object.keys(reg).map((name) => {
    const app = reg[name];
    // connect-mode apps have no bare repo — that check only applies to
    // init-mode apps, so skip it rather than reporting a false "missing".
    const barePathOk = app.mode === 'connect' ? true : fs.existsSync(app.barePath);
    const runPathOk = fs.existsSync(app.runPath);
    return { name, mode: app.mode || 'init', barePathOk, runPathOk, ok: barePathOk && runPathOk };
  });
  return data;
}

// ── supply-chain integrity (item 7): shipped files verified against a
// committed hash manifest (INTEGRITY.json). GITLIVE_INTEGRITY_ROOT lets
// tests and installed copies point at any root that carries the manifest.
const INTEGRITY_ROOT = process.env.GITLIVE_INTEGRITY_ROOT || __dirname;

function integrityFileList() {
  const pkg = JSON.parse(fs.readFileSync(path.join(INTEGRITY_ROOT, 'package.json'), 'utf8'));
  const files = [];
  const walk = (rel) => {
    const abs = path.join(INTEGRITY_ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs)) walk(path.join(rel, e));
    } else {
      files.push(rel.split(path.sep).join('/'));
    }
  };
  for (const f of pkg.files || []) walk(f);
  if (fs.existsSync(path.join(INTEGRITY_ROOT, 'INTEGRITY.json')) && !files.includes('INTEGRITY.json')) files.push('INTEGRITY.json');
  return files.sort();
}

function hashFile(rel) {
  const data = fs.readFileSync(path.join(INTEGRITY_ROOT, rel));
  return crypto.createHash('sha256').update(data).digest('hex');
}

function integrityWrite() {
  const pkg = JSON.parse(fs.readFileSync(path.join(INTEGRITY_ROOT, 'package.json'), 'utf8'));
  const files = {};
  for (const rel of integrityFileList()) {
    if (rel === 'INTEGRITY.json') continue;
    files[rel] = hashFile(rel);
  }
  const manifest = { format: 'gitlive-integrity/1', version: pkg.version || VERSION, generatedAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(INTEGRITY_ROOT, 'INTEGRITY.json'), JSON.stringify(manifest, null, 2) + '\n');
  return Object.keys(files).length;
}

function integrityCheck() {
  const mPath = path.join(INTEGRITY_ROOT, 'INTEGRITY.json');
  if (!fs.existsSync(mPath)) return { ok: false, reason: 'no INTEGRITY.json at ' + INTEGRITY_ROOT + ' (run: gitlive doctor --integrity --write)' };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mPath, 'utf8')); } catch { return { ok: false, reason: 'INTEGRITY.json unparsable' }; }
  const changed = [];
  const missing = [];
  for (const [rel, want] of Object.entries(manifest.files || {})) {
    const abs = path.join(INTEGRITY_ROOT, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    if (hashFile(rel) !== want) changed.push(rel);
  }
  if (changed.length || missing.length) {
    return { ok: false, changed, missing, reason: `${changed.length} changed, ${missing.length} missing` };
  }
  return { ok: true, fileCount: Object.keys(manifest.files || {}).length, version: manifest.version };
}


// ── gitlive audit (WORKFLOW.md P1): the readiness front door ─────────────
// One command answers "is this folder gitlive-ready?" before the first
// push: stack, start command, PORT-from-env, health endpoint presence,
// lockfile (closure pinning), secret hygiene, git state. Verdicts are
// PASS / WARN / FAIL — never guesses: unknown = WARN with a question.
function scanFiles(cwd, re, excludeDirs) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // vendor/dependency trees are never the app's own answer: a /health
      // string inside a vendored library is not a health route.
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'chatter-model' || e.name === '.py312' || e.name.startsWith('.venv') || e.name.startsWith('.chrome-') || excludeDirs.includes(e.name)) continue;
      const full = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full);
      else {
        if (!/\.[a-z0-9]+$/i.test(e.name)) continue;
        try {
          if (Buffer.byteLength(fs.readFileSync(path.join(cwd, full))) > 400000) continue;
          if (re.test(fs.readFileSync(path.join(cwd, full), 'utf8'))) out.push(full);
        } catch { /* binary */ }
      }
    }
  };
  walk('');
  return out;
}

// provenance stem: list + verify owner-signed deploy tags for an app

// provenance stem: parse + verify the owner-signed deploy tags in a bare
// repo; returns rows for both the CLI and the dashboard data map.
function parseDeployTags(barePath) {
  const manifestMod = require('./manifest.js');
  let key = null;
  const keyPath = process.env.GITLIVE_MANIFEST_KEY || manifestMod.DEFAULT_KEY_PATH;
  if (fs.existsSync(keyPath)) { try { key = manifestMod.loadPrivateKey(keyPath); } catch { key = null; } }
  let refs = [];
  try {
    refs = execFileSync('git', ['-C', barePath, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/tags/gitlive/deploys'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch { return []; }
  const rows = [];
  for (const line of refs.reverse()) { // newest first by ref listing order
    const [ref, obj] = line.split(' ');
    let msg = '';
    try { msg = execFileSync('git', ['-C', barePath, 'cat-file', 'tag', obj], { encoding: 'utf8' }); } catch { msg = ''; }
    const sep = msg.indexOf('\n\n');
    const body = sep >= 0 ? msg.slice(sep + 2) : msg;
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* legacy */ }
    if (!parsed || !parsed.ownerSig || !parsed.predicate) {
      rows.push({ ref, commit: null, outcome: null, closure: null, at: null, sigValid: false, legacy: true });
      continue;
    }
    const check = { ...parsed };
    delete check.owner; delete check.ownerSig;
    let sigOk = false;
    try {
      const pub = key ? key.publicKeyPem : (parsed.owner && (parsed.owner.publicKey || parsed.owner.publicKeyPem));
      if (pub) sigOk = manifestMod.verifyBytes(pub, Buffer.from(manifestMod.canonical(check), 'utf8'), parsed.ownerSig);
    } catch { sigOk = false; }
    rows.push({
      ref, sigValid: sigOk, legacy: false,
      commit: parsed.predicate.commit || null, outcome: parsed.predicate.outcome || null,
      closure: parsed.predicate.closure || null, at: parsed.predicate.at || null,
    });
  }
  return rows;
}


function cmdReceipts(appName) {
  const reg = loadRegistry();
  const app = reg[appName];
  if (!app || !app.barePath) { console.error('No app named "' + appName + '" (or no bare repo)'); process.exitCode = 1; return; }
  const rows = parseDeployTags(app.barePath);
  if (!rows.length) { console.log('no deploy tags for ' + appName + ' (first deploy writes one)'); return; }
  for (const r of rows) {
    if (r.legacy) { console.log(r.ref + ': NOT an owner-signed deploy receipt (legacy or corrupt)'); continue; }
    console.log(r.ref + '  commit ' + String(r.commit || '').slice(0, 12) + ' · ' + (r.outcome || '?') + (r.closure ? ' · closure pinned ' + String(r.closure).slice(0, 8) : ' · no closure') + ' · ' + (r.at || '') + ' · owner signature ' + (r.sigValid ? 'VALID' : 'INVALID'));
  }
}



function cmdAudit(rest) {
  const dir = path.resolve(rest[0] || '.');
  const rows = [];
  const add = (check, verdict, detail) => rows.push({ check, verdict, detail });
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('audit failed: no such directory: ' + dir);
    process.exitCode = 1;
    return;
  }
  const detected = detectStack(dir);
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } })();
  const hasGit = fs.existsSync(path.join(dir, '.git'));
  const tracked = (() => { try { return execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; } })();

  add('stack', detected.kind === 'unknown' ? 'WARN' : 'PASS', detected.kind);
  add('start command', detected.startCmd ? 'PASS' : 'FAIL', detected.startCmd || 'none — package.json needs scripts.start (or app.py/main.py/server.py)');
  add('install command', detected.kind === 'unknown' ? 'WARN' : 'PASS', detected.installCmd || 'none declared');
  const hasDeps = Boolean(pkg && (pkg.dependencies || pkg.devDependencies)) || fs.existsSync(path.join(dir, 'requirements.txt'));
  add('dependencies declared', hasDeps ? 'PASS' : 'WARN', hasDeps ? 'yes' : 'none declared');
  add('lockfile (closure pinning)', fs.existsSync(path.join(dir, 'package-lock.json')) ? 'PASS' : (hasDeps && !fs.existsSync(path.join(dir, 'requirements.txt')) ? 'FAIL' : 'WARN'),
    fs.existsSync(path.join(dir, 'package-lock.json')) ? 'package-lock.json present — F1 can pin the closure'
      : hasDeps ? 'missing while dependencies exist — run npm install once, commit the lockfile, then sign'
        : 'no dependencies declared — nothing to pin (fine)');
  const portHits = scanFiles(dir, /process\.env(?:\[['"]|\.)?PORT|os\.environ(?:\[|\()['"]?PORT|\$PORT/, ['dist', 'build', 'out', 'data']);
  add('PORT from environment', portHits.length ? 'PASS' : 'WARN', portHits.length ? 'reads PORT: ' + portHits.slice(0, 3).join(', ') : 'no code reads PORT from the environment — safe mode assigns per-slot ports');
  // health detection requires the app's OWN route handling: a quoted
  // "/health" path, a pathname comparison, or an explicit healthPath —
  // never a bare string match (that matched vendored python files).
  const healthHits = scanFiles(dir, /['"`]\/health['"`]|healthPath|pathname\s*===?\s*['"`]\/health/, ['dist', 'build', 'out', 'data']);
  add('health endpoint', healthHits.length ? 'PASS' : 'WARN', healthHits.length ? 'found /health handling: ' + healthHits.slice(0, 3).join(', ') : 'no /health route found — safe mode will health-check "/" instead (fine for simple apps)');
  const secretFiles = tracked.filter((f) => /\.env($|\.)|secret|credential|passw|id_rsa|id_ed25519/i.test(f));
  add('secret hygiene', secretFiles.length ? 'FAIL' : 'PASS', secretFiles.length ? 'tracked files look like secrets: ' + secretFiles.slice(0, 5).join(', ') + ' — move to --env-file, never commit' : 'no tracked env/secret files');
  const nmTracked = tracked.filter((f) => f.startsWith('node_modules/'));
  add('node_modules hygiene', nmTracked.length ? 'FAIL' : 'PASS', nmTracked.length ? nmTracked.length + ' tracked node_modules entries — add node_modules/ to .gitignore' : 'clean');
  add('git repo', hasGit ? 'PASS' : 'WARN', hasGit ? 'repo present' : 'not a git repo yet — gitlive init will create one');
  add('owner manifest', fs.existsSync(path.join(dir, '.gitlive', 'app.manifest')) ? 'PASS' : 'WARN', fs.existsSync(path.join(dir, '.gitlive', 'app.manifest')) ? 'signed manifest present' : 'none yet — sign after init (gitlive manifest sign)');

  console.log('gitlive audit — ' + dir);
  console.log('');
  for (const r of rows) {
    const icon = r.verdict === 'FAIL' ? 'FAIL' : r.verdict === 'WARN' ? 'warn' : 'ok  ';
    console.log('  [' + icon + '] ' + r.check);
    if (r.detail) console.log('         ' + r.detail);
  }
  console.log('');
  const fails = rows.filter((r) => r.verdict === 'FAIL').length;
  const warns = rows.filter((r) => r.verdict === 'WARN').length;
  console.log(fails ? fails + ' blocker(s) — the gates would refuse or strand this app; fix them before init'
    : warns ? warns + ' warning(s) — deployable, but read them before signing'
      : 'ready to init + sign + push.');
  process.exitCode = fails ? 1 : 0;
}


function cmdDoctor() {
  // integrity first: --write regenerates, plain --integrity verifies
  const argv = parseFlags(process.argv.slice(2));
  if (argv.flags.integrity) {
    if (argv.flags.write) {
      const n = integrityWrite();
      console.log(`integrity manifest written: ${n} file(s) → ${path.join(INTEGRITY_ROOT, 'INTEGRITY.json')}`);
      return;
    }
    const r = integrityCheck();
    if (!r.ok) {
      console.error(`INTEGRITY MISMATCH (${r.reason}):`);
      for (const f of r.changed || []) console.error(`  CHANGED: ${f}`);
      for (const f of r.missing || []) console.error(`  MISSING: ${f}`);
      if (!r.changed && !r.missing) console.error('  ' + (r.reason || ''));
      process.exitCode = 1;
      return;
    }
    console.log(`integrity OK — ${r.fileCount} file(s) match INTEGRITY.json (version ${r.version})`);
    return;
  }
  const data = getDoctorData();
  console.log(`gitlive doctor`);
  console.log(`  version: ${data.version}`);
  console.log(`  platform: ${os.platform()} (${os.platform() === 'win32' ? 'UNSUPPORTED — see below' : os.platform() === 'darwin' ? 'macOS — the owner\'s daily driver, battery-verified' : 'Linux — same POSIX paths, systemd/setsid native'})`);
  if (os.platform() === 'win32') {
    console.log('  Windows is not supported: the deploy hooks are bash + POSIX process groups.');
    console.log('  The supported path on Windows is WSL2 with a Linux home inside it.');
  }
  console.log(`  running from: ${data.filename}`);

  if (data.linked) {
    console.log(`  'gitlive' on PATH: ${data.linked}${data.real !== data.linked ? ` -> ${data.real}` : ''}`);
    if (data.mismatch) {
      console.log(`  MISMATCH: the "gitlive" your shell runs is a different file than this one.`);
      console.log(`  This is exactly the "which zip actually got installed" confusion — fix with:`);
      console.log(`    cd ${JSON.stringify(__dirname)} && npm install -g .`);
    } else {
      console.log(`  OK — PATH and this file agree.`);
    }
  } else {
    console.log(`  'gitlive' not found on PATH (not installed globally, or shell needs a restart).`);
  }

  console.log(`  apps registered: ${data.apps.length ? data.apps.map((a) => a.name).join(', ') : '(none)'}`);
  for (const a of data.apps) {
    if (!a.ok) {
      console.log(`  WARNING: "${a.name}" is registered but ${!a.barePathOk ? 'its bare repo is' : 'its run folder is'} missing.`);
    }
  }
}

function deployAppData(name) {
  const reg = loadRegistry();
  const app = getApp(reg, name);
  // Redeploy = re-run the FULL pipeline with the current commit as the ref —
  // the same mechanism the GitHub webhook deploy uses. A plain `git push`
  // is a no-op when nothing changed ("Everything up-to-date"), which used to
  // leave a new user stuck after a failed first deploy (field finding).
  const hookPath = path.join(app.barePath, 'hooks', 'post-receive');
  if (!fs.existsSync(hookPath)) {
    return { name, ok: false, reason: `no deploy hook at ${hookPath} — re-run gitlive init from the app folder` };
  }
  let head = '0'.repeat(40);
  try { head = execFileSync('git', ['--git-dir', app.barePath, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(); } catch { /* empty bare repo */ }
  const result = spawnSync('bash', [hookPath], { cwd: app.barePath, encoding: 'utf8', input: `${head} ${head} refs/heads/main\n` });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return { name, exitCode: result.status, output, ok: result.status === 0 && !/deploy FAILED/.test(output) };
}

function rollbackAppData(name) {
  const reg = loadRegistry();
  const app = getApp(reg, name);
  if (!app.safe) {
    return { ok: false, reason: 'rollback requires --safe mode (blue-green) — this app has no previous slot to fall back to.' };
  }
  const history = readHistory(app.runPath, 20);
  const successes = history.filter((h) => h.outcome === 'success' && h.commit);
  if (successes.length < 2) {
    return { ok: false, reason: 'No earlier successful deploy on record to roll back to.' };
  }
  const target = successes[successes.length - 2]; // most recent success before the current one
  // Force-push the old commit back onto main in gitlive's own internal bare repo — this
  // re-runs the normal --safe deploy machinery (health check, blue-green flip) against the
  // known-good commit, rather than reinventing the deploy path. Only rewinds gitlive's
  // private deploy remote, not the user's own branch history in app.cwd.
  const result = spawnSync('git', ['push', name, `${target.commit}:main`, '--force'], { cwd: app.cwd, encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    ok: result.status === 0 && /live and healthy/.test(output),
    targetCommit: target.commit,
    exitCode: result.status,
    output,
  };
}

function cmdRollback(name) {
  let data;
  try { data = rollbackAppData(name); } catch (err) { console.log(err.message); process.exit(1); }
  if (!data.ok && data.reason) { console.log(`Cannot roll back "${name}": ${data.reason}`); return; }
  const out = data.output.trim();
  if (out) console.log(out);
  if (data.ok) console.log(`Rolled back to ${data.targetCommit}.`);
  else console.log(`Rollback push completed but the deploy did not report healthy — check "gitlive status ${name}".`);
}

// ---------------------------------------------------------------------------
// connect mode (gitlive connect): GitHub push -> self-hosted runner -> live
// ---------------------------------------------------------------------------

function getGithubRemote(cwd) {
  let url;
  try { url = sh('git config --get remote.origin.url', { cwd }).trim(); } catch { return null; }
  if (!url) return null;
  let m = url.match(/^git@github\.com:([^/]+)\/(.+?)(\.git)?$/);
  if (!m) m = url.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, ''), url };
}

function mergeGitignore(cwd, entries) {
  const gi = path.join(cwd, '.gitignore');
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const lines = existing.split('\n').map((l) => l.trim());
  const added = entries.filter((e) => !lines.includes(e) && !lines.includes(e.replace(/\/$/, '')));
  if (added.length) {
    const sep = existing.length && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gi, existing + sep + added.join('\n') + '\n');
  }
  return added;
}

function buildWorkflowYaml() {
  return `name: Deploy via gitlive

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        run: bash deploy.sh
`;
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildDeployWrapperScript({ secretsPath, startCmd }) {
  // Same "set -a; source; set +a" pattern the local-mode hooks use — a
  // single, already-proven mechanism for getting secrets into a process,
  // reused here instead of a second implementation (inlining values into
  // launchd's plist XML) that would've been much harder to get right.
  return `#!/bin/bash
SECRETS=${JSON.stringify(secretsPath)}
if [ -f "$SECRETS" ]; then set -a; source "$SECRETS"; set +a; fi
exec bash -c '${shQuoteSingle(startCmd)}'
`;
}

function buildMacDeployScript({ name, installCmd, startCmd, gitliveFile, runPath, secretsPath }) {
  const label = `com.gitlive.${name}`;
  return `#!/bin/bash
set -e
CHECKOUT_DIR="$(pwd)"
RUN_DIR=${JSON.stringify(runPath)}
PLIST_LABEL="${label}"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
WRAPPER_PATH="$RUN_DIR/.gitlive-run.sh"
APP_NAME=${JSON.stringify(name)}
GITLIVE_FILE=${JSON.stringify(gitliveFile)}
mkdir -p "$RUN_DIR"
COMMIT=$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)

# connect mode has no health check (unlike --safe local mode) — a "success"
# here means the deploy script itself completed, not that the app is
# actually serving traffic. Still real progress: before this, connect-mode
# deploys weren't recorded anywhere at all, so "gitlive status" had nothing
# to show and nothing to roll back to.
record_failure() {
  node "$GITLIVE_FILE" _record-deploy "$APP_NAME" failed "$COMMIT" "deploy script exited with an error" >/dev/null 2>&1 || true
}
trap record_failure ERR

# Mirror the checkout into a stable directory OUTSIDE the ephemeral Actions
# job workspace. launchd runs the app from here, not from $CHECKOUT_DIR, so
# it survives past the job ending regardless of whether/when the runner
# reuses or cleans that workspace — a plist pointing straight at the
# checkout dir works only until the runner touches it again, then every
# restart fails immediately (launchd shows a "-" pid and a nonzero last exit
# status, e.g. 127, for the rest of KeepAlive's retries).
echo "[gitlive] syncing to stable run dir: $RUN_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude data --exclude .git --exclude deploy-history.jsonl "$CHECKOUT_DIR/" "$RUN_DIR/"
else
  [ -f "$RUN_DIR/deploy-history.jsonl" ] && cp "$RUN_DIR/deploy-history.jsonl" "/tmp/.gitlive-history-$$.jsonl" || true
  rm -rf "$RUN_DIR"
  mkdir -p "$RUN_DIR"
  cp -a "$CHECKOUT_DIR/." "$RUN_DIR/"
  rm -rf "$RUN_DIR/node_modules" "$RUN_DIR/data" "$RUN_DIR/.git" "$RUN_DIR/deploy-history.jsonl"
  [ -f "/tmp/.gitlive-history-$$.jsonl" ] && mv "/tmp/.gitlive-history-$$.jsonl" "$RUN_DIR/deploy-history.jsonl" || true
fi

${installCmd ? `echo "[gitlive] installing dependencies..."\n(cd "$RUN_DIR" && ${installCmd})\n` : ''}
cat > "$WRAPPER_PATH" <<'WRAPPER'
${buildDeployWrapperScript({ secretsPath, startCmd })}WRAPPER
chmod +x "$WRAPPER_PATH"

# $RUN_DIR/data is already protected from the rsync --delete above (see
# --exclude data), same convention as local-mode's $TARGET/data — but until
# now nothing actually created it or told the app process where it was.
# gitlive init's hooks export GITLIVE_DATA_DIR; this path never did, so a
# fused app deployed via connect would silently fall back to gitlive-client's
# default location instead of this stable, redeploy-surviving one. Fixed
# below alongside the PATH bake-in, same EnvironmentVariables dict.
mkdir -p "$RUN_DIR/data"

# launchd gives a LaunchAgent a minimal PATH by default — it never sources
# .zshrc/.bash_profile, so nvm/Homebrew-installed node/npm aren't found
# ("npm: command not found" in the app's own log, confirmed live). Bake in
# whatever PATH this deploy script itself is running with — it must already
# resolve node/npm, since installCmd just ran successfully — the same fix
# GitHub's own runner svc.sh applies to itself for the identical reason.
echo "[gitlive] writing launchd service..."
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$WRAPPER_PATH</string>
  </array>
  <key>WorkingDirectory</key><string>$RUN_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$RUN_DIR/gitlive-deploy.log</string>
  <key>StandardErrorPath</key><string>$RUN_DIR/gitlive-deploy.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH</string>
    <key>GITLIVE_DATA_DIR</key><string>$RUN_DIR/data</string>
  </dict>
</dict>
</plist>
PLIST

echo "[gitlive] (re)loading service..."
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

trap - ERR
node "$GITLIVE_FILE" _record-deploy "$APP_NAME" success "$COMMIT" "" >/dev/null 2>&1 || true
echo "[gitlive] deployed via launchd: $PLIST_LABEL"
`;
}

function buildLinuxDeployScript({ name, installCmd, startCmd, gitliveFile, runPath, secretsPath }) {
  const serviceName = `gitlive-${name}`;
  return `#!/bin/bash
set -e
CHECKOUT_DIR="$(pwd)"
RUN_DIR=${JSON.stringify(runPath)}
SERVICE_NAME="${serviceName}"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE_NAME.service"
WRAPPER_PATH="$RUN_DIR/.gitlive-run.sh"
APP_NAME=${JSON.stringify(name)}
GITLIVE_FILE=${JSON.stringify(gitliveFile)}
mkdir -p "$RUN_DIR"
COMMIT=$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)

record_failure() {
  node "$GITLIVE_FILE" _record-deploy "$APP_NAME" failed "$COMMIT" "deploy script exited with an error" >/dev/null 2>&1 || true
}
trap record_failure ERR

# Same reasoning as the macOS path: mirror the checkout into a stable
# directory outside the ephemeral Actions job workspace before wiring the
# service up to it, so a future checkout/cleanup doesn't pull the rug out
# from under the still-running (or restarting) unit.
echo "[gitlive] syncing to stable run dir: $RUN_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude data --exclude .git --exclude deploy-history.jsonl "$CHECKOUT_DIR/" "$RUN_DIR/"
else
  [ -f "$RUN_DIR/deploy-history.jsonl" ] && cp "$RUN_DIR/deploy-history.jsonl" "/tmp/.gitlive-history-$$.jsonl" || true
  rm -rf "$RUN_DIR"
  mkdir -p "$RUN_DIR"
  cp -a "$CHECKOUT_DIR/." "$RUN_DIR/"
  rm -rf "$RUN_DIR/node_modules" "$RUN_DIR/data" "$RUN_DIR/.git" "$RUN_DIR/deploy-history.jsonl"
  [ -f "/tmp/.gitlive-history-$$.jsonl" ] && mv "/tmp/.gitlive-history-$$.jsonl" "$RUN_DIR/deploy-history.jsonl" || true
fi

${installCmd ? `echo "[gitlive] installing dependencies..."\n(cd "$RUN_DIR" && ${installCmd})\n` : ''}
cat > "$WRAPPER_PATH" <<'WRAPPER'
${buildDeployWrapperScript({ secretsPath, startCmd })}WRAPPER
chmod +x "$WRAPPER_PATH"

# Same fix as the macOS path: $RUN_DIR/data is already protected from the
# rsync --delete above, but nothing created it or told the app process where
# it was — gitlive init's hooks export GITLIVE_DATA_DIR, this path never did.
mkdir -p "$RUN_DIR/data"

# systemd --user's default PATH can likewise miss a user-local node/npm
# install (nvm, linuxbrew) — bake in the PATH this deploy script has, same
# fix and same reasoning as the macOS path above.
echo "[gitlive] writing systemd --user service..."
mkdir -p "$HOME/.config/systemd/user"
cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=gitlive deploy: ${name}

[Service]
WorkingDirectory=$RUN_DIR
Environment="PATH=$PATH"
Environment="GITLIVE_DATA_DIR=$RUN_DIR/data"
ExecStart=/bin/bash $WRAPPER_PATH
Restart=always

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

trap - ERR
node "$GITLIVE_FILE" _record-deploy "$APP_NAME" success "$COMMIT" "" >/dev/null 2>&1 || true
echo "[gitlive] deployed via systemd --user: $SERVICE_NAME"
`;
}

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'gitlive-cli', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(httpGetJson(res.headers.location, headers));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GET ${url} failed: ${res.statusCode} ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'gitlive-cli', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(downloadFile(res.headers.location, dest, headers));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} failed: ${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function getLatestRunnerVersion() {
  const data = await httpGetJson('https://api.github.com/repos/actions/runner/releases/latest');
  const tag = data.tag_name || '';
  const m = tag.match(/^v?(\d+\.\d+\.\d+)$/);
  if (!m) throw new Error(`Could not parse runner release tag: ${tag}`);
  return m[1];
}

const RUNNER_VERSION_CACHE = path.join(HOME_DIR, 'runner-version.json');

async function resolveRunnerVersion(flags) {
  if (flags['runner-version']) return String(flags['runner-version']).replace(/^v/, '');
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(RUNNER_VERSION_CACHE, 'utf8')); } catch {}
  const fresh = cached && (Date.now() - new Date(cached.fetchedAt).getTime()) < 24 * 60 * 60 * 1000;
  if (fresh) return cached.version;
  try {
    const version = await getLatestRunnerVersion();
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(RUNNER_VERSION_CACHE, JSON.stringify({ version, fetchedAt: new Date().toISOString() }));
    return version;
  } catch (err) {
    if (cached) {
      console.log(`Couldn't check for a newer runner version (${err.message}); reusing last known version ${cached.version}.`);
      return cached.version;
    }
    throw new Error(`Couldn't determine the GitHub Actions runner version (${err.message}). Retry shortly, or pass --runner-version <x.y.z> to skip the lookup.`);
  }
}

function runnerPlatformArch() {
  const platform = os.platform(); // 'darwin' | 'linux'
  const arch = os.arch(); // 'arm64' | 'x64'
  const osPart = platform === 'darwin' ? 'osx' : platform === 'linux' ? 'linux' : null;
  const archPart = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!osPart || !archPart) throw new Error(`Unsupported platform for self-hosted runner: ${platform}/${arch}`);
  return { osPart, archPart };
}

function getRunnerTokenViaGh(owner, repo) {
  try { sh('gh --version'); } catch { return null; }
  try {
    const out = sh(`gh api repos/${owner}/${repo}/actions/runners/registration-token -X POST`);
    return JSON.parse(out).token || null;
  } catch { return null; }
}

async function getRunnerTokenManually(owner, repo) {
  console.log(`\nCouldn't get a runner token automatically (gh CLI missing or not logged in).`);
  console.log(`Open this page, click "New self-hosted runner", and copy the token shown in the ./config.sh line:`);
  console.log(`  https://github.com/${owner}/${repo}/settings/actions/runners/new\n`);
  const rl = readline.createInterface({ input, output });
  const token = await ask(rl, 'Paste the runner registration token');
  rl.close();
  if (!token) throw new Error('No token provided.');
  return token;
}

async function cmdConnect(argv) {
  const cwd = process.cwd();
  const { flags } = parseFlags(argv);

  const remote = getGithubRemote(cwd);
  if (!remote) {
    console.log('No GitHub origin remote found in this repo. Push it to GitHub first, then run "gitlive connect" again.');
    return;
  }
  console.log(`Repo: ${remote.owner}/${remote.repo}`);

  const detected = detectStack(cwd);
  const startCmd = flags.start || detected.startCmd;
  const installCmd = flags.install !== undefined ? flags.install : (detected.installCmd || '');
  if (!startCmd) {
    console.log('No start command detected. Pass one explicitly: --start "node server.js"');
    return;
  }
  const name = flags.name || path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, '-');
  const secrets = secretsPath(name);
  if (flags['env-file']) {
    fs.writeFileSync(secrets, fs.readFileSync(String(flags['env-file']), 'utf8'), { mode: 0o600 });
    fs.chmodSync(secrets, 0o600);
    console.log(`Loaded secrets from ${flags['env-file']} (stored at ${secrets}, chmod 600).`);
  }

  const addedIgnores = mergeGitignore(cwd, ['node_modules/', 'data/']);
  if (addedIgnores.length) console.log(`Added to .gitignore: ${addedIgnores.join(', ')}`);

  const workflowDir = path.join(cwd, '.github', 'workflows');
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(path.join(workflowDir, 'deploy.yml'), buildWorkflowYaml());
  console.log('Wrote .github/workflows/deploy.yml');

  // Register connect apps in the same registry init-mode apps use, so
  // "gitlive status"/"list" and deploy history aren't init-only. A distinct
  // runPath (suffix "-connect-run", not "-run") keeps it from ever colliding
  // with an init-mode app that happens to share a name.
  const runPath = path.join(APPS_DIR, `${name}-connect-run`);
  fs.mkdirSync(runPath, { recursive: true });
  const reg = loadRegistry();
  reg[name] = { ...reg[name], mode: 'connect', cwd, runPath, installCmd, startCmd, createdAt: reg[name]?.createdAt || new Date().toISOString() };
  saveRegistry(reg);

  const platform = os.platform();
  const deployScript = platform === 'darwin'
    ? buildMacDeployScript({ name, installCmd, startCmd, gitliveFile: __filename, runPath, secretsPath: secrets })
    : buildLinuxDeployScript({ name, installCmd, startCmd, gitliveFile: __filename, runPath, secretsPath: secrets });
  fs.writeFileSync(path.join(cwd, 'deploy.sh'), deployScript);
  fs.chmodSync(path.join(cwd, 'deploy.sh'), 0o755);
  console.log('Wrote deploy.sh');

  if (platform !== 'darwin' && platform !== 'linux') {
    console.log(`Warning: runner setup below is untested on ${platform}; macOS (launchd) and Linux (systemd --user) are the proven paths.`);
  }

  const runnerDir = path.join(RUNNERS_DIR, name);
  const alreadyConfigured = fs.existsSync(path.join(runnerDir, '.runner'));

  if (alreadyConfigured) {
    console.log(`\nRunner already registered for "${name}" at ${runnerDir} — skipping download/registration.`);
  } else {
    fs.mkdirSync(runnerDir, { recursive: true });

    console.log('\nResolving GitHub Actions runner version...');
    const version = await resolveRunnerVersion(flags);
    const { osPart, archPart } = runnerPlatformArch();
    const filename = `actions-runner-${osPart}-${archPart}-${version}.tar.gz`;
    const url = `https://github.com/actions/runner/releases/download/v${version}/${filename}`;
    const tarPath = path.join(runnerDir, filename);

    console.log(`Downloading ${filename}...`);
    await downloadFile(url, tarPath);
    sh(`tar xzf ${JSON.stringify(filename)}`, { cwd: runnerDir });

    let token = getRunnerTokenViaGh(remote.owner, remote.repo);
    if (token) console.log('Got a runner registration token via gh CLI.');
    else token = await getRunnerTokenManually(remote.owner, remote.repo);

    console.log('Registering runner...');
    sh(
      `./config.sh --url https://github.com/${remote.owner}/${remote.repo} --token ${JSON.stringify(token)} --name ${JSON.stringify(`${name}-runner`)} --work _work --unattended --replace`,
      { cwd: runnerDir, stdio: 'inherit' }
    );

    // macOS installs the runner as a per-user LaunchAgent — svc.sh actively
    // refuses sudo there ("Must not run with sudo"), since running it as
    // root points launchctl at root's session instead of the invoking
    // user's. Linux installs it as a systemd --user service via svc.sh,
    // which (unlike a system-wide unit) also runs as the invoking user, not
    // root, so it doesn't take sudo either. Confirmed on real hardware after
    // the sudo'd version registered a runner that then sat permanently
    // Offline — status/start both failing the same "must not run with sudo"
    // check, silently, since spawnSync's result here was never checked.
    console.log('\nInstalling the runner as a background service:');
    const svc = spawnSync('./svc.sh', ['install'], { cwd: runnerDir, stdio: 'inherit' });
    const svcStart = spawnSync('./svc.sh', ['start'], { cwd: runnerDir, stdio: 'inherit' });
    if (svc.status !== 0 || svcStart.status !== 0) {
      console.log(`\nWarning: svc.sh install/start exited non-zero (install: ${svc.status}, start: ${svcStart.status}).`);
      console.log(`Check manually: cd ${runnerDir} && ./svc.sh status`);
    } else {
      console.log('Runner installed and started as a service.');
    }
  }

  console.log(`\nWired up. Commit and push, and every push to main deploys automatically:\n`);
  console.log(`  git add .github deploy.sh .gitignore`);
  console.log(`  git commit -m "wire up gitlive connect"`);
  console.log(`  git push\n`);
}

const USAGE_TEXT = `gitlive — turn any git repo into a live process with "git push"

  gitlive init [name]      set up deploy-on-push for the repo in this folder (local bare repo)
                            flags: --install "<cmd>" --start "<cmd>" --port <n> --yes
                                   --build "<cmd>" (runs between install and start — for apps
                                   whose build output (dist/ etc.) is not in git)
                                   --safe (health-checked blue-green swap, requires --port;
                                   your start command must read the PORT env var)
                                   --health "<path>" (health-check path in safe mode, default "/")
                                   --env-file <path> (secrets sourced into the process env;
                                   never logged, never git-tracked, values never displayed)
                                   --nice <n> (CPU deprioritize the app process; safe default)
                                   --memory-limit-mb <n> (coarse ulimit -v safety net — NOT a
                                   precise cap, can stop legit apps if set too tight; opt-in only)
  gitlive connect          wire this repo's real GitHub remote to a self-hosted Actions
                            runner + deploy.sh, so "git push" to GitHub goes live here
                            flags: --install "<cmd>" --start "<cmd>" --name <name>
                                   --runner-version <x.y.z> (skip the GitHub API lookup)
                                   --env-file <path> (same secrets handling as init)
  gitlive list             show every local-mode app and whether it's up
  gitlive status <name>    detail on one local-mode app, incl. safe-mode state + deploy history
  gitlive logs <name> [-f] show (or follow) a local-mode app's deploy/runtime log
  gitlive stop <name>      stop a local-mode app's running process(es)
  gitlive restart <name>   plain: stop + start the same code; safe: revive the public
                            proxy if it died (code swaps remain push/rollback)
  gitlive deploy <app>     re-run the FULL deploy pipeline (install → build → start →
                            liveness receipt) for the current commit — the retry when
                            "git push" says everything up-to-date
  gitlive name <sub>      the name office: publish <app> (write <app>.<zone> → this
                            machine's public IPv6 through the zone's DNS token) /
                            status / office add <domain> --token <t> — one zone makes
                            every app globally visible, zero per-app DNS ever
  gitlive boot <sub>      boot recovery: install (macOS LaunchAgent, no sudo — the
                            control plane starts at login and restores every app) /
                            remove / status
  gitlive pool <sub>       the app pool: check <app> (the 5-point admission exam —
                            alive, public+TLS, no leakage, receipts, backup) / list
  gitlive up               after a reboot: bring every local app back — deploys the
                            down ones, revives safe-mode proxies — and reports whether
                            the control plane is running (start it: gitlive serve)
  gitlive rollback <name>  re-deploy the previous successful commit (--safe apps only)
  gitlive rm <name>        delete a local-mode app entirely (asks to confirm; --yes skips)
  gitlive receipts <app>   list + verify owner-signed deploy tags (git-native
                            provenance: history as signed git refs)
  gitlive hook-regen <app> upgrade an EXISTING app's deploy hooks to the current
                            pipeline (F1 closure gate, signed deploy tags, attestation
                            fan-out) — safe: hooks are inert until the next push, the
                            running app is untouched, the old hook is kept one generation
                            flags: --dry-run (show the diff without writing)
  gitlive domain local     give your apps names, not numbers: every app answers at
                            <name>.gitlive on this machine (hosts entries + local
                            routing gateway; on/off/list/tls — tls adds https with a
                            gitlive local CA and one trust step)
  gitlive domain public    attach YOUR OWN public domain to an app (Tier 2):
                            gitlive domain public <app> --domain <your.domain>
                            [--ip <public-ip>] [--cert <file> --key <file>] [--check];
                            list / --remove <domain>. gitlive never runs a naming zone
  gitlive audit [dir]      readiness front door (WORKFLOW P1): stack, start cmd,
                            PORT-from-env, health, lockfile, secret/node_modules hygiene
  gitlive doctor           diagnose "which gitlive is actually running" / install drift;
                            --integrity [--write] verifies/regenerates the file-hash manifest
  gitlive backend start [name...]  start the optional backend daemon (shared auth/data/storage)
                            for the named apps, or every registered app if none given —
                            apps using gitlive-client auto-detect it, no redeploy needed
  gitlive backend stop     stop the backend daemon; apps fall back to standalone automatically
  gitlive daemon ensure    detached supervisor: revives crashed proxies/apps
                            (ensure/status/stop; one supervisor per machine)
  gitlive serve            start the control plane: authenticated dashboard + JSON API for
                            every app on this machine (status/logs/stop/deploy/rollback)
                            flags: --port <n> (default 5180) --host <h> (default 127.0.0.1)
                                   --no-open (do not open the browser) --allow-register
  gitlive agent connect <url>  register THIS machine as a node of a control plane at <url>
                            (Phase 1: same-machine control; the node record is what Phase 2
                            remote control builds on). flags: --name <name>
  gitlive mesh <sub>       multi-node deploy policy (Phase 2 item 3): add / list /
                            deploy <app> [--min-nodes N] / status <app>
  gitlive manifest <sub>   owner-signed app manifests (Phase 2 D4): keygen / sign / verify /
                            show — run \"gitlive manifest\" alone for the flag list
  gitlive entry <sub>      the public entry node for machines behind NAT: serve (public
                            machine) / connect <url> --token <t> (NAT machine) / status /
                            list / disconnect / stop / cert <domain> --cert --key
  gitlive backup <sub>     receipted backups (restic, your disk): init / <app> / list /
                            check / restore <app> — verified snapshots, restore never
                            touches live data
  gitlive attest <sub>     SLSA/in-toto provenance export: attest <app> [--output --pubkey-out]
                            / verify <file> --key <pubkey> — the deploy receipts in the
                            standard envelope the supply-chain world verifies
  gitlive heartbeat        opt-in "is there a newer gitlive?" — ONE registry version
                            lookup, run only when you type it; zero telemetry, nothing
                            automatic
  gitlive github <sub>     GitHub webhook deploys: hook <app> --repo <url> [--secret <s>]
                            / list / remove — a push on GitHub pokes the machine through
                            the same owner-signed gates, no Actions runner needed
  gitlive keys <sub>       key rotation + handover ledger: rotate storage|node|owner /
                            rotations
  gitlive crypt <sub>      Phase 4 hardening primitives: keygen / enc / dec /
                            split (Shamir N-of-T) / join
  gitlive peer <sub>       federation listener + announcements (Phase 3): start /
                            announce <url> / hello <url> / list
  gitlive open              open the control-plane dashboard at its one recorded URL,
                            but ONLY if a healthy instance is answering there
  gitlive --version        print version and the exact file this command is running from
`;
function usage() { console.log(USAGE_TEXT); }
// per-command help: "gitlive <cmd> --help" prints just that command's block
// from the usage text instead of the whole page (field finding: restart
// --help and audit --help dumped everything).
function helpSection(cmd) {
  const lines = USAGE_TEXT.split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    const m = l.match(/^  gitlive ([a-z][a-z-]*)/);
    if (m) starts.push({ cmd: m[1], i });
  });
  const k = starts.findIndex((s) => s.cmd === cmd);
  if (k === -1) return null;
  const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
  return lines.slice(starts[k].i, end).join('\n');
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  // --help / -h anywhere after the command must print help and exit — never
  // act. (New-user field finding: `gitlive init --help` used to START an
  // init; `gitlive audit --help` treated --help as a folder name.)
  if (rest.includes('--help') || rest.includes('-h')) {
    const sec = cmd && !cmd.startsWith('-') ? helpSection(cmd) : null;
    console.log(sec || USAGE_TEXT);
    return;
  }
  const { flags } = parseFlags(rest);
  switch (cmd) {
    case 'init': await cmdInit(rest); break;
    case 'connect': await cmdConnect(rest); break;
    case 'list': cmdList(); break;
    case 'status': cmdStatus(rest[0]); break;
    case 'logs': cmdLogs(rest[0], rest.includes('-f')); break;
    case 'stop': cmdStop(rest[0]); break;
    case 'restart': cmdRestart(rest[0]); break;
    case 'up': cmdUp(); break;
    case 'pool': cmdPool(rest); break;
    case 'name': cmdName(rest); break;
    case 'boot': cmdBoot(rest); break;
    case 'deploy': {
      // redeploy the CURRENT commit through the full pipeline (field finding:
      // "push again" is a no-op, restart skips install/build — a failed first
      // deploy needs an honest retry command).
      const [depName] = rest;
      if (!depName) { console.error('Usage: gitlive deploy <app> — re-run the full deploy pipeline for the current commit'); process.exitCode = 1; break; }
      const dep = deployAppData(depName);
      if (dep.output) process.stdout.write(dep.output);
      if (dep.ok) console.log(`\n${depName}: current commit re-ran the full pipeline (install → build → start → liveness receipt).`);
      else { console.error(`\ngitlive deploy: ${depName} did not come up — ${dep.reason || 'the app exited within 6s of start; see the deploy log'}`); process.exitCode = 1; }
      break;
    }
    case 'rollback': cmdRollback(rest[0]); break;
    case 'rm': await cmdRm(rest[0], flags); break;
    case 'doctor': cmdDoctor(); break;
    case 'audit': cmdAudit(rest); break;
    case 'receipts': cmdReceipts(rest[0]); break;
    case 'hook-regen': cmdHookRegen(rest); break;
    case 'domain': cmdDomain(rest); break;
    case 'backup': {
      const backup = require('./backup.js');
      backup.cmdBackup(rest);
      break;
    }
    case 'attest': {
      const attest = require('./attest.js');
      attest.cmdAttest(rest, parseFlags(rest).flags);
      break;
    }
    case 'heartbeat': {
      const heartbeat = require('./heartbeat.js');
      heartbeat.cmdHeartbeat(rest, parseFlags(rest).flags);
      break;
    }
    case 'github': {
      const githubHook = require('./github-hook.js');
      githubHook.cmdGithubHook(rest, parseFlags(rest).flags);
      break;
    }
    case 'entry': {
      const entry = require('./entry.js');
      entry.cmdEntry(rest, parseFlags(rest).flags);
      break;
    }
    case 'backend': {
      const backend = require('./backend.js');
      if (rest[0] === 'start') await backend.cmdBackendStart(rest.slice(1));
      else if (rest[0] === 'stop') backend.cmdBackendStop();
      else console.log('Usage: gitlive backend <start|stop> [app-name...]');
      break;
    }
    case 'daemon': {
      const daemon = require('./daemon.js');
      daemon.cmdDaemon(rest);
      break;
    }
    case 'manifest': {
      const manifest = require('./manifest.js');
      manifest.cmdManifest(rest, parseFlags(rest).flags);
      break;
    }
    case 'mesh': {
      const mesh = require('./mesh.js');
      await mesh.cmdMesh(rest, parseFlags(rest).flags);
      break;
    }
    case '_replica-setup': {
      // child contract: HOME = the replica node's home
      const mesh = require('./mesh.js');
      mesh.replicaSetup(rest[0], rest[1], rest[2] || '');
      break;
    }
    case '_peer-status': {
      const mesh = require('./mesh.js');
      mesh.peerStatus(rest[0]);
      break;
    }
    case '_peer-restore': {
      const mesh = require('./mesh.js');
      mesh.peerRestore(rest[0], rest[1]);
      break;
    }
    case '_peer-set-primary': {
      const mesh = require('./mesh.js');
      mesh.peerSetPrimary(rest[0], rest[1]);
      break;
    }
    case 'serve': {
      // Control plane (Phase 1). Loaded lazily like backend.js — server.js
      // requires gitlive.js in-process, so requiring it eagerly up here
      // would not recurse (module cache), but lazy keeps CLI startup lean
      // for every other command.
      const control = require('./control/server.js');
      const argv = parseFlags(rest);
      const port = Number(argv.flags.port) || 5180;
      const host = argv.flags.host || '127.0.0.1';
      const url = `http://${host}:${port}`;

      // Single-instance discipline: if a gitlive control plane is ALREADY
      // answering on this port, never start a second one — reuse it (and
      // open the browser at the one existing URL). If the port is busy with
      // something that is not gitlive, fail loudly instead of colliding.
      let probe = null;
      try {
        const res = await fetch(url + '/', { signal: AbortSignal.timeout(1500) });
        const text = await res.text();
        probe = { ok: res.ok, gitlive: text.includes('gitlive control plane') };
      } catch {
        probe = null; // nothing answering — safe to start
      }
      if (probe && probe.gitlive) {
        console.log(`gitlive control plane is already running on ${url} — no second instance started, no new tab opened.`);
        console.log(`If you closed the tab: open ${url} manually.`);
        break;
      }
      if (probe && probe.ok) {
        console.error(`port ${port} is already serving something that is not gitlive — pick another port with --port.`);
        process.exitCode = 1;
        break;
      }

      const instance = await control.createControlServer({ port, host, allowRegister: Boolean(argv.flags['allow-register']) });
      await instance.listen();
      // The one URL this machine's launchers/agents should use.
      try {
        const urlFile = path.join(os.homedir(), '.gitlive', 'control.url');
        fs.mkdirSync(path.dirname(urlFile), { recursive: true });
        fs.writeFileSync(urlFile, url + '\n');
      } catch { /* cosmetic — never fail serve over the marker file */ }
      // --no-open (containers, restarts) skips the tab; a missing browser
      // (alpine images) must never kill serve — the open attempt is fire-and-forget.
      if (!argv.flags['no-open'] && argv.flags.open !== false) {
        const { spawn } = require('node:child_process');
        spawn('open', [instance.url], { stdio: 'ignore', detached: true }).unref()
          .on('error', () => { /* headless/container: no browser to open */ });
      }
      // Foreground by design (Phase 1): Ctrl-C stops the control plane. A
      // --daemon flag can follow the backend-daemon pattern later.
      break;
    }
    case 'keys': {
      const keys = require('./keys.js');
      keys.cmdKeys(rest, parseFlags(rest).flags);
      break;
    }
    case 'crypt': {
      const crypt = require('./crypt.js');
      crypt.cmdCrypt(rest, parseFlags(rest).flags);
      break;
    }
    case 'peer': {
      const peer = require('./peer.js');
      await peer.cmdPeer(rest, parseFlags(rest).flags);
      break;
    }
    case 'open': {
      // Deliberate dashboard opener: opens the control plane ONLY if a
      // healthy instance answers on the recorded URL. Never spawns tabs on
      // its own. GITLIVE_NO_BROWSER=1 (tests/headless) prints instead.
      const urlFile = path.join(os.homedir(), '.gitlive', 'control.url');
      let url = null;
      if (fs.existsSync(urlFile)) url = fs.readFileSync(urlFile, 'utf8').trim();
      if (!url) url = 'http://127.0.0.1:5180';
      let healthy = false;
      try {
        const res = await fetch(url + '/', { signal: AbortSignal.timeout(1500) });
        healthy = res.ok && (await res.text()).includes('gitlive control plane');
      } catch { healthy = false; }
      if (!healthy) {
        console.error(`no healthy control plane on ${url}. Start one first: gitlive serve (--no-open to skip the first tab).`);
        process.exitCode = 1;
        break;
      }
      if (process.env.GITLIVE_NO_BROWSER === '1') {
        console.log(`[no-browser] control plane healthy at ${url}`);
        break;
      }
      const { spawn } = require('node:child_process');
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
        .on('error', () => { /* headless: no browser available */ });
      console.log(`Opened the control plane: ${url}`);
      break;
    }
    case 'agent': {
      const agent = require('./control/agent.js');
      if (rest[0] === 'connect') await agent.cmdAgentConnect(rest.slice(1), parseFlags(rest.slice(1)).flags);
      else if (rest[0] === 'list') await agent.cmdAgentList();
      else console.log('Usage: gitlive agent connect <control-url> [--name <name>] | agent list');
      break;
    }
    case '_check-manifest': {
      // Called by the pre-receive hook with (barePath, commit). Exit code is
      // the enforcement decision: 0 = allowed, 1 = rejected.
      const manifestModule = require('./manifest.js');
      const [barePath, commit] = rest;
      if (!barePath || !commit) {
        console.error('usage: gitlive _check-manifest <bare-path> <commit>');
        process.exitCode = 1;
        break;
      }
      const result = manifestModule.checkCommitManifest(barePath, commit);
      if (result.absent) {
        console.log(result.message);
      } else if (result.ok) {
        console.log(`gitlive: ${result.message} — owner signature valid`);
      } else {
        // audit: a REJECTED push is the security-relevant record (unsigned
        // code drift or a stale signature is exactly what the hook exists to
        // stop); accepted pushes are routine and stay out of the events log.
        console.error('gitlive: manifest verification FAILED:');
        for (const e of result.errors) console.error('  - ' + e);
        process.exitCode = 1;
        try {
          require('./crypt.js').logEvent('manifest-denied', { bare: barePath, commit: String(commit).slice(0, 12), errors: result.errors });
        } catch { /* audit logging must never mask the rejection */ }
      }
      break;
    }
    case '_closure-gate': {
      // F1 (Fabric program): deploy-time dependency-closure gate. Called by
      // the generated post-receive hooks after checkout, before install,
      // with the checkout directory. The gate reads the checked-out
      // manifest; when it pins a closure (run.closure), the checkout's
      // lockfile MUST match the signed digest — otherwise the deploy would
      // install dependencies the owner never signed. Exit 0 = proceed
      // (pinned-ok or legacy), exit 1 = abort (drift).
      const dir = rest[0];
      if (!dir) { console.error('usage: gitlive _closure-gate <checkout-dir>'); process.exitCode = 1; break; }
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, '.gitlive', 'app.manifest'), 'utf8')); } catch { /* legacy */ }
      const closure = manifest && manifest.run && manifest.run.closure;
      if (!closure) {
        console.log('closure: legacy (no pinned dependency closure in the signed manifest)');
        break;
      }
      const lockPath = path.join(dir, closure.lockfile || 'package-lock.json');
      let sha = null;
      try { sha = crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex'); } catch { sha = null; }
      const failAudit = (reason) => {
        console.log('closure: drift — ' + reason);
        console.error('gitlive: deploy aborted — the dependency closure does not match the signed manifest');
        try {
          require('./crypt.js').logEvent('closure-denied', { dir, reason, expectedSha: closure.sha256 || null, gotSha: sha, lockfile: closure.lockfile });
        } catch { /* audit must never mask the abort */ }
        process.exitCode = 1;
      };
      if (sha === null) return failAudit('lockfile missing at deploy time (signed manifest pins ' + (closure.lockfile || 'package-lock.json') + ')');
      if (sha !== closure.sha256) return failAudit('lockfile changed since signing (expected ' + String(closure.sha256 || '').slice(0, 16) + '…, got ' + sha.slice(0, 16) + '…)');
      console.log(`closure: pinned (${closure.entries === null ? '?' : closure.entries} lockfile entr${closure.entries === 1 ? 'y' : 'ies'} via ${closure.lockfile})`);
      console.log('closure_sha=' + sha);
      break;
    }
    case '_deploy-tag': {
      // provenance stem: after a successful deploy, write an OWNER-SIGNED
      // annotated tag into the app's bare repo — deploy history becomes
      // git refs (pushable, loggable, machine-verifiable), not just a file.
      const [appName, commit, closure, outcome] = rest;
      if (!appName || !commit) { console.error("usage: gitlive _deploy-tag <app> <commit> <closure-sha|empty> <outcome>"); process.exitCode = 1; break; }
      try {
        const reg = loadRegistry();
        const app = reg[appName];
        if (!app || !app.barePath) { console.error('no bare repo for ' + appName); process.exitCode = 1; break; }
        const manifestMod = require('./manifest.js');
        const keyPath = process.env.GITLIVE_MANIFEST_KEY || manifestMod.DEFAULT_KEY_PATH;
        if (!fs.existsSync(keyPath)) { console.error('no owner key to sign the deploy tag'); process.exitCode = 1; break; }
        const key = manifestMod.loadPrivateKey(keyPath);
        const body = { predicateType: 'gitlive.deploy/1', predicate: { app: appName, outcome: outcome || 'success', commit: String(commit).slice(0, 40), closure: closure || null, at: new Date().toISOString() } };
        const ownerSig = manifestMod.signBytes(key.priv, Buffer.from(manifestMod.canonical(body), 'utf8'));
        const message = JSON.stringify({ ...body, owner: { fingerprint: key.fingerprint }, ownerSig }, null, 1) + '\n';
        const prefix = 'gitlive/deploys/' + String(commit).slice(0, 40);
        const existing = execFileSync('git', ['-C', app.barePath, 'for-each-ref', '--format=%(refname:short)', 'refs/tags/' + prefix], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        const n = existing.length + 1;
        const ref = prefix + '/' + n;
        const msgPath = path.join(app.runPath || os.tmpdir(), '.deploy-tag-msg-' + process.pid + '.json');
        fs.writeFileSync(msgPath, message);
        try { execFileSync('git', ['-C', app.barePath, 'tag', '-a', ref, '-F', msgPath], { encoding: 'utf8' }); }
        finally { try { fs.rmSync(msgPath, { force: true }); } catch { /* noop */ } }
        console.log('deploy tag ' + ref + ' signed and recorded');
      } catch (err) { console.error('deploy tag failed: ' + err.message); process.exitCode = 1; }
      break;
    }
    case '_attest-deploy': {
      // called by the generated hooks after a successful deploy: fan the
      // receipt + signed manifest out to mesh member homes (attestation tier)
      const meshMod = require('./mesh.js');
      meshMod.cmdAttestDeploy(rest[0]);
      break;
    }
    case '_record-deploy': {
      const [appName, outcome, commit, reason, closure] = rest;
      const reg = loadRegistry();
      const app = reg[appName];
      if (app) appendHistory(app.runPath, { outcome, commit, reason: reason || undefined, closure: closure || undefined });
      break;
    }
    case '_publish-dns': {
      // the deploy hook's name-office step: after a successful deploy, write
      // this machine's public IPv6 as the app's AAAA under its zone — the
      // app becomes globally visible with zero extra steps. Quiet + best-
      // effort: a missing zone/token/address is a log line, never a failed
      // deploy.
      const [appName] = rest;
      publishAppDns(appName).then((r) => {
        if (r.ok) console.log(`[name office] ${r.record} → ${r.value}`);
        else console.log(`[name office] ${appName}: skipped — ${r.reason}`);
      }).catch((err) => console.log(`[name office] ${appName}: ${err.message}`));
      break;
    }
    case '--version': case '-v':
      console.log(VERSION);
      console.log(`running from: ${__filename}`);
      break;
    default: usage();
  }
}

// Exports are unconditional now (used to live only in the `else` branch,
// "exposed for tests only" / for mcp/server.js's in-process require) because
// backend.js also needs a handful of these — loadRegistry, isAlive, and now
// startBackgroundNode — and backend.js is loaded lazily from inside main()
// below, i.e. while gitlive.js IS the CLI entry point (require.main ===
// module). Under the old structure module.exports stayed the default empty
// object in that case, since the assignment only ran in the else branch —
// backend.js's require('./gitlive.js') would have gotten nothing. Moving the
// assignment here, unconditional, fixes that with no change in behavior for
// the existing consumer (mcp/server.js), which only ever requires this file
// as a library in the first place.
module.exports = {
  getGithubRemote, mergeGitignore, xmlEscape, shQuoteSingle, runnerPlatformArch,
  buildWorkflowYaml, buildMacDeployScript, buildLinuxDeployScript, buildHook,
  buildSafeHook, buildProxyScript, buildDeployWrapperScript, derivePorts, appendHistory, readHistory,
  parseFlags, detectStack, secretsPath, portInUse, registryPortConflict, resolveSafePorts, checkPublicPort,
  // pure data functions — used directly by mcp/server.js (in-process require,
  // must never console.log or it corrupts the MCP stdio JSON-RPC channel)
  // and now also by backend.js (loadRegistry, isAlive, startBackgroundNode).
  VERSION, loadRegistry, saveRegistry, isAlive, getApp,
  integrityWrite, integrityCheck, integrityFileList, INTEGRITY_ROOT,
  listAppsData, getStatusData, getLogsData, getDoctorData, stopAppData,
  deployAppData, rollbackAppData, restartAppData, startBackgroundNode, APPS_DIR, HOME_DIR,  parseDeployTags,
  // shared by entry.js (the entry machine installs certificates for domains
  // whose apps live on NAT machines — same validation, same public dir)
  installPublicCert, validPublicDomain, publicCertDir,
  // shared by control/server.js — the dashboard's Settings body performs
  // domain actions (local on/off, zones add/remove) through the SAME logic
  // the CLI proves, never a second implementation
  domainNames, applyHosts, hostsBlock, startDomainGateway, stopDomainGateway,
  gatewayAlive, loadZones, saveZones, domainTlsPaths, ensureLocalCA,
  issueServerCert, trustCommand, domainPublicData, upData, poolAdmissionData, poolListData, publishAppDns, publicIpv6,
};

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
