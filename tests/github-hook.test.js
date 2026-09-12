'use strict';
// #9 GitHub webhook deploys — GitHub pokes the machine, the machine runs
// the SAME post-receive hook as a local push. Proven end to end with a
// real git repo + a real control plane: the CLI configures the hook, the
// HMAC signature gates the endpoint, the pushed commit lands in the bare
// repo and the deploy receipt records it. Fake home, disposable discipline.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const GITLIVE_JS = path.join(__dirname, '..', 'gitlive.js');
const shortTmp = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const home = fs.mkdtempSync(path.join(shortTmp, 'glgh-'));
const env = { ...process.env, HOME: home };

function cli(args, cwd) {
  return execFileSync('node', [GITLIVE_JS, ...args], { cwd: cwd || home, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}
function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

(async () => {
  // ── setup: a source repo, an app, a control plane ───────────────────────
  const src = fs.mkdtempSync(path.join(shortTmp, 'glgh-src-'));
  git(['init', '-q', '-b', 'main'], src);
  fs.writeFileSync(path.join(src, 'app.txt'), 'v1\n');
  git(['-c', 'user.email=g@x.io', '-c', 'user.name=g', 'add', '-A'], src);
  git(['-c', 'user.email=g@x.io', '-c', 'user.name=g', 'commit', '-qm', 'v1'], src);
  // the liveness gate (a deploy must not receipt "success" while the app
  // is dead) means the fixture app has to actually SURVIVE — sleep does.
  const initOut = cli(['init', 'hookapp', '--start', 'sleep 300', '--install', 'true', '--port', '4999', '--yes'], src);
  assert(/Done/.test(initOut), 'init succeeds:\n' + initOut);

  const port = 46000 + Math.floor(Math.random() * 500);
  const plane = spawn('node', [GITLIVE_JS, 'serve', '--port', String(port), '--no-open'], { env, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/meta`); up = r.ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 120));
  }
  assert(up, 'the control plane comes up');

  // ── 1) the CLI configures the hook: registry + mode-600 secret ──────────
  const hookOut = cli(['github', 'hook', 'hookapp', '--repo', src, '--secret', 's3cret']);
  assert(/hookapp ← /.test(hookOut) && /api\/github\/hook\?app=hookapp/.test(hookOut), 'the hook config prints the webhook URL + secret:\n' + hookOut);
  const reg = JSON.parse(fs.readFileSync(path.join(home, '.gitlive', 'apps.json'), 'utf8'));
  assert(reg.hookapp.githubRepo === src, 'the repo URL lands in the registry');
  const secretPath = path.join(home, '.gitlive', 'github-hook-secret');
  assert(fs.existsSync(secretPath) && (fs.statSync(secretPath).mode & 0o777) === 0o600 && fs.readFileSync(secretPath, 'utf8').trim() === 's3cret', 'the secret is stored mode 600');

  // ── 2) a signed push webhook deploys through the same hook ──────────────
  fs.writeFileSync(path.join(src, 'app.txt'), 'v2\n');
  git(['-c', 'user.email=g@x.io', '-c', 'user.name=g', 'commit', '-qam', 'v2'], src);
  const sha = git(['rev-parse', 'HEAD'], src).trim();
  const body = { ref: 'refs/heads/main', head_commit: { id: sha } };
  const res = await fetch(`http://127.0.0.1:${port}/api/github/hook?app=hookapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 's3cret') },
    body: JSON.stringify(body),
  });
  const resText = await res.text();
  assert(res.status === 200, 'the webhook is accepted:\n' + resText);
  const j = JSON.parse(resText);
  assert(j.ok && j.data.deploying === true && j.data.commit === sha.slice(0, 12), 'the webhook reports the deploy:\n' + JSON.stringify(j));
  let deployed = null;
  for (let i = 0; i < 60 && !deployed; i++) {
    try {
      const hist = fs.readFileSync(path.join(home, '.gitlive', 'apps', 'hookapp-run', 'deploy-history.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      const last = JSON.parse(hist[hist.length - 1]);
      if (last.commit === sha.slice(0, 12)) deployed = last;
    } catch { /* not yet */ }
    if (!deployed) await new Promise((r) => setTimeout(r, 150));
  }
  assert(deployed && deployed.outcome === 'success', `the pushed commit deployed with a receipt (${deployed ? deployed.commit : 'none'})`);

  // ── 3) the signature is the gate: wrong secret → 403, audited ───────────
  const bad = await fetch(`http://127.0.0.1:${port}/api/github/hook?app=hookapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 'wrong') },
    body: JSON.stringify(body),
  });
  assert(bad.status === 403, 'a wrong signature is refused (' + bad.status + ')');
  const events = fs.readFileSync(path.join(home, '.gitlive', 'events.log'), 'utf8');
  assert(/github-hook-denied/.test(events), 'refused webhooks are audited');

  // ── 4) unknown app + non-main refs are refused honestly ─────────────────
  const noApp = await fetch(`http://127.0.0.1:${port}/api/github/hook?app=ghost`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 's3cret') },
    body: JSON.stringify(body),
  });
  assert(noApp.status === 404, 'unknown apps are a clean 404 (' + noApp.status + ')');
  const wrongRef = await fetch(`http://127.0.0.1:${port}/api/github/hook?app=hookapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign({ ...body, ref: 'refs/heads/dev' }, 's3cret') },
    body: JSON.stringify({ ...body, ref: 'refs/heads/dev' }),
  });
  assert(wrongRef.status === 400 && /only pushes to main/.test(await wrongRef.text()), 'non-main refs are refused with the honest rule');

  // ── cleanup ─────────────────────────────────────────────────────────────
  plane.kill('SIGKILL');
  console.log('ALL GITHUB WEBHOOK TESTS PASSED');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
