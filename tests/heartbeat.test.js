'use strict';
// #3 heartbeat — the opt-in version check, proven offline against a local
// stub registry. The suite never touches the public registry: every call
// points GITLIVE_HEARTBEAT_URL at a local server (disposable discipline).

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glhb-'));

// async spawn: the stub registry lives in THIS process, so the CLI child
// must run while this loop is alive (spawnSync would freeze the server —
// the documented acme-stall lesson, applied here too).
function cli(args, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [GITLIVE_JS, ...args], {
      env: { ...process.env, HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: currentVersion }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/latest`;
  let currentVersion = '9.9.9';

  // ── 1) a newer published version is reported with the update path ───────
  const newer = await cli(['heartbeat'], { GITLIVE_HEARTBEAT_URL: url });
  assert(newer.code === 0 && /newer gitlive is available: 9\.9\.9/.test(newer.out), 'reports the newer version:\n' + newer.out);
  assert(/npm install -g \.\/gitlive-9\.9\.9\.tgz/.test(newer.out), 'points at the private tarball path, not the registry:\n' + newer.out);
  assert(/Zero telemetry/.test(newer.out) && /0 9 \* \* \*/.test(newer.out), 'says the zero-telemetry line and the optional cron:\n' + newer.out);

  // ── 2) up to date + ahead-of-published are both honest ───────────────────
  currentVersion = require('../gitlive.js').VERSION;
  const same = await cli(['heartbeat'], { GITLIVE_HEARTBEAT_URL: url });
  assert(new RegExp('latest gitlive: ' + currentVersion.replace(/\./g, '\\.')).test(same.out), 'same version is calm:\n' + same.out);
  currentVersion = '1.0.0';
  const ahead = await cli(['heartbeat'], { GITLIVE_HEARTBEAT_URL: url });
  assert(/ahead of the published 1\.0\.0/.test(ahead.out), 'dev builds report being ahead:\n' + ahead.out);

  // ── 3) unreachable registry → honest, non-zero, no panic ─────────────────
  const down = await cli(['heartbeat'], { GITLIVE_HEARTBEAT_URL: 'http://127.0.0.1:1/nope' });
  assert(down.code === 1 && /could not reach/.test(down.out) && /Nothing was sent/.test(down.out), 'unreachable registry is honest:\n' + down.out);

  // ── 4) the default URL is the public registry — and nothing else ─────────
  const mod = require(path.join(__dirname, '..', 'heartbeat.js'));
  assert(mod.DEFAULT_URL === 'https://registry.npmjs.org/gitlive/latest', 'the default is the npm registry lookup, not a telemetry endpoint');

  srv.close();
  console.log('ALL HEARTBEAT TESTS PASSED');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
