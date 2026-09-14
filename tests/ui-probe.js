'use strict';
// ui-probe — drive the real dashboard in a real browser over CDP and print a
// JSON verdict. This is the missing half of the invariant battery: the suites
// prove the API and the DOM strings, but only a browser proves the thing the
// owner actually sees (computed styles, click paths, console errors, layout at
// phone width).
//
// Zero dependencies: Node's global WebSocket + the Chrome DevTools Protocol.
// A throwaway session row is minted in the plane's own session database and
// deleted again on the way out — never a stored token, never a network call.
//
//   node tests/ui-probe.js <url> --script <probe.js> [--width 1280] [--height 900]
//                            [--port 9333] [--keep-open]
//
// The probe script is evaluated in the page (async IIFE allowed) and its return
// value is printed as JSON. `window.__probeDone` is set for it to signal
// readiness; the driver also collects console errors + page exceptions and
// includes them in the output, because a probe that "worked" while the console
// screamed is not a pass.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const CHROME_CANDIDATES = [
  process.env.GITLIVE_BROWSER,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? dflt : process.argv[i + 1];
}
const has = (name) => process.argv.includes('--' + name);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ── mint a throwaway session in the plane's own database ────────────────
// The dashboard authenticates with a bearer token whose sha256 lives in
// _gitlive_sessions. Minting a row is how every prior field check worked; the
// row is deleted in the finally block so no usable credential survives.
function mintSession(controlDir) {
  const dbPath = path.join(controlDir, 'app.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare('SELECT id FROM _gitlive_users ORDER BY id LIMIT 1').get();
  if (!row) throw new Error('no user in ' + dbPath + ' — register once, then probe');
  const expires = new Date(Date.now() + 3600 * 1000).toISOString();
  db.prepare('INSERT INTO _gitlive_sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(hash, row.id, expires);
  db.close();
  return {
    token,
    drop() {
      // retry: the plane may hold the write lock for a moment, and a probe
      // that leaves a live credential behind is not acceptable (the live
      // plane had accumulated 23 rows this way)
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const d = new DatabaseSync(dbPath);
          const gone = d.prepare('DELETE FROM _gitlive_sessions WHERE token_hash = ?').run(hash).changes;
          d.close();
          if (gone) return true;
        } catch { /* locked — retry */ }
        const until = Date.now() + 200;
        while (Date.now() < until) { /* brief spin: the driver is exiting anyway */ }
      }
      console.error('WARNING: could not delete the probe session row from ' + dbPath);
      return false;
    },
  };
}

// ── minimal CDP client over the global WebSocket ────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result && r.result.value;
  }
  consoleErrors() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        out.push(e.params.args.map((a) => a.value || a.description || '').join(' '));
      }
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        out.push('uncaught: ' + (d.exception && d.exception.description || d.text));
      }
    }
    return out;
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
  });
  return new CDP(ws);
}

async function main() {
  const url = process.argv[2];
  if (!url || !/^https?:\/\//.test(url)) {
    console.error('usage: node tests/ui-probe.js <url> --script <probe.js> [--width N] [--height N] [--port N]');
    process.exit(2);
  }
  const scriptPath = arg('script');
  if (!scriptPath) { console.error('--script is required'); process.exit(2); }
  const probe = fs.readFileSync(scriptPath, 'utf8');
  const width = Number(arg('width', 1280));
  const height = Number(arg('height', 900));
  const controlDir = process.env.GITLIVE_CONTROL_DIR || path.join(os.homedir(), '.gitlive', 'control');

  const browser = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!browser) { console.error('no Chromium-family browser found (set GITLIVE_BROWSER)'); process.exit(2); }

  const session = mintSession(controlDir);
  const debugPort = Number(arg('port', 0)) || await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlive-probe-'));
  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-gpu', '--hide-scrollbars', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let browserLog = '';
  child.stdout.on('data', (d) => { browserLog += d; });
  child.stderr.on('data', (d) => { browserLog += d; });

  let cdp = null;
  try {
    // wait for the debugging endpoint
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* not up yet */ }
      if (!target) await sleep(150);
    }
    if (!target) throw new Error('devtools endpoint never answered:\n' + browserLog.slice(-600));

    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await cdp.send('Page.navigate', { url });
    await sleep(400);

    // authenticate the way the dashboard itself does, then reload into the app
    await cdp.eval(`try { localStorage.setItem('gitlive.session', ${JSON.stringify(session.token)}); } catch (e) {}`);
    await cdp.send('Page.navigate', { url });
    // the shell renders asynchronously (poll /api/apps) — wait for the app view
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(250);
      ready = await cdp.eval("!!(document.querySelector('#app-view') && !document.querySelector('#app-view').classList.contains('hidden'))").catch(() => false);
    }

    const result = await cdp.eval(`(async () => { ${probe} })()`);
    const errors = cdp.consoleErrors().filter((e) => !/favicon|Download the React/i.test(e));
    const out = {
      ok: Boolean(result && result.ok),
      url,
      viewport: { width, height },
      ready,
      result: result || null,
      consoleErrors: errors,
    };
    console.log(JSON.stringify(out, null, 2));
    if (!has('keep-open')) process.exitCode = out.ok && errors.length === 0 ? 0 : 1;
    else process.exitCode = 0;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, url, error: err.message, browserLog: browserLog.slice(-800) }, null, 2));
    process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch { /* noop */ }
    child.kill('SIGKILL');
    session.drop();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
