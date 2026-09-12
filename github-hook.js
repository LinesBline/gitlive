#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// github-hook.js — GitHub webhook deploys (post-roadmap #9: the repo pokes
// the machine, no Actions runner to babysit). The control plane's
// /api/github/hook endpoint verifies the X-Hub-Signature-256 (HMAC, the
// shared secret below), fetches the pushed commit into the app's bare
// repo, points main at it, and runs the SAME post-receive hook a git push
// would — so every gate, receipt and attestation is identical. The only
// new trust is the webhook signature; everything downstream is the same
// owner-signed pipeline.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME_DIR = path.join(os.homedir(), '.gitlive');
const SECRET_PATH = process.env.GITLIVE_GITHUB_HOOK_SECRET || path.join(HOME_DIR, 'github-hook-secret');

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'apps.json'), 'utf8')); } catch { return {}; }
}
function saveRegistry(reg) {
  fs.writeFileSync(path.join(HOME_DIR, 'apps.json'), JSON.stringify(reg, null, 2) + '\n');
}

function cmdGithubHook(rest, flags) {
  const sub = rest[0];
  if (sub === 'list') {
    const reg = loadRegistry();
    const rows = Object.entries(reg).filter(([, a]) => a.githubRepo);
    if (!rows.length) { console.log('no GitHub webhooks configured — gitlive github hook <app> --repo <url> --secret <s>'); return; }
    for (const [name, a] of rows) console.log(`  ${name}  ←  ${a.githubRepo}  (webhook: /api/github/hook?app=${name})`);
    return;
  }
  if (sub === 'remove') {
    const reg = loadRegistry();
    const app = reg[rest[1]];
    if (!app || !app.githubRepo) { console.error(`no webhook configured for "${rest[1] || '(none given)'}"`); process.exitCode = 1; return; }
    delete app.githubRepo;
    saveRegistry(reg);
    console.log(`gitlive github: webhook removed for ${rest[1]} (delete it in the repo's GitHub settings too).`);
    return;
  }
  const appName = sub === 'hook' ? rest[1] : sub;
  const reg = loadRegistry();
  const app = reg[appName];
  if (!app || !app.barePath) { console.error(`No app named "${appName}". Run "gitlive list".`); process.exitCode = 1; return; }
  const repo = String(flags.repo || '').trim();
  if (!repo) { console.error('--repo <github-url> is required (the clone URL of the repo that pushes).'); process.exitCode = 1; return; }
  if (!fs.existsSync(SECRET_PATH)) {
    const secret = flags.secret ? String(flags.secret) : crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
    fs.writeFileSync(SECRET_PATH, secret + '\n', { mode: 0o600 });
    fs.chmodSync(SECRET_PATH, 0o600);
    if (!flags.secret) console.log(`webhook secret generated: ${SECRET_PATH} (mode 600)`);
  }
  app.githubRepo = repo;
  saveRegistry(reg);
  console.log(`gitlive github: ${appName} ← ${repo}`);
  console.log(`\nIn the repo's GitHub settings → Webhooks → Add webhook:`);
  console.log(`  Payload URL : <your control-plane URL>/api/github/hook?app=${appName}   (the dashboard's URL, reachable by GitHub)`);
  console.log(`  Content type: application/json`);
  console.log(`  Secret      : ${fs.readFileSync(SECRET_PATH, 'utf8').trim()}`);
  console.log(`  Events      : just the push event`);
  console.log(`\nEvery push from GitHub now deploys through the same owner-signed gates as a local git push.`);
}

module.exports = { cmdGithubHook, SECRET_PATH };

if (require.main === module) {
  const flags = (() => { try { return require('./gitlive.js').parseFlags(process.argv.slice(3)).flags; } catch { return {}; } })();
  cmdGithubHook(process.argv.slice(2), flags);
}
