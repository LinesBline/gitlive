// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive agent — Phase 1 (`gitlive agent connect <url>`).
//
// Registers THIS machine as a node of a control plane and heartbeats it.
// Phase 1 the control server executes app actions locally in-process, so the
// agent's job is identity + liveness: an Ed25519 node keypair (minted once,
// stored in agent.json), a node secret issued by the server (returned
// exactly once at registration, kept in agent.json), and a heartbeat loop.
// Phase 2 turns this agent into the remote executor (the server sends
// commands over the same authenticated channel); the agent.json record is
// the seam that makes that a transport change, not an API change.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const CONTROL_ROOT = process.env.GITLIVE_CONTROL_DIR || path.join(os.homedir(), '.gitlive', 'control');
const AGENT_CONFIG_PATH = path.join(CONTROL_ROOT, 'agent.json');

function loadAgentConfig() {
  try { return JSON.parse(fs.readFileSync(AGENT_CONFIG_PATH, 'utf8')); } catch { return null; }
}

function saveAgentConfig(cfg) {
  fs.mkdirSync(path.dirname(AGENT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(AGENT_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function nodeKeypair() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

async function postJson(url, body, { token } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data.data;
}

// Resolve an idempotent registration for one control plane: reuse an
// existing agent.json when it already points at the same URL, otherwise
// mint a node keypair and register (the server returns the node secret
// exactly once — from then on we hold it locally).
async function ensureRegistered(controlUrl, name) {
  const hostname = os.hostname();
  const existing = loadAgentConfig();
  if (existing && existing.controlUrl === controlUrl) {
    return { ...existing, reused: true };
  }
  const publicKey = nodeKeypair();
  const registered = await postJson(new URL('/api/nodes/register', controlUrl).href, {
    publicKey,
    hostname,
    name: name || hostname,
  });
  const cfg = {
    controlUrl,
    nodeId: registered.nodeId,
    secret: registered.secret,
    publicKey,
    name: registered.name,
    hostname,
    registeredAt: new Date().toISOString(),
  };
  saveAgentConfig(cfg);
  return { ...cfg, reused: false };
}

async function heartbeat(cfg) {
  return postJson(new URL('/api/nodes/heartbeat', cfg.controlUrl).href, {
    nodeId: cfg.nodeId,
    secret: cfg.secret,
  });
}

async function cmdAgentConnect(rest, flags) {
  const controlUrl = rest[0];
  if (!controlUrl) {
    console.log('Usage: gitlive agent connect <control-url> [--name <name>] [--once]');
    process.exitCode = 1;
    return;
  }
  try {
    const cfg = await ensureRegistered(controlUrl, flags.name);
    if (cfg.reused) {
      console.log(`gitlive agent: already connected to ${controlUrl} as "${cfg.name}" (${cfg.nodeId}) — heartbeating.`);
    } else {
      console.log(`gitlive agent: registered ${cfg.hostname} as "${cfg.name}" (${cfg.nodeId}) with ${controlUrl}`);
    }

    const beat = await heartbeat(cfg);
    console.log(`gitlive agent: heartbeat ok (server last_seen_at ${beat.lastSeenAt})`);

    if (flags.once) return; // tests + one-shot checks

    // Foreground heartbeat loop (Phase 1). Deliberately NOT unref'd: a
    // foreground agent must keep the process alive between beats (Ctrl-C
    // stops it). A --daemon form follows the backend-daemon pattern later.
    const intervalMs = 30_000;
    console.log(`gitlive agent: heartbeating every ${intervalMs / 1000}s — Ctrl-C to stop.`);
    const timer = setInterval(async () => {
      try {
        await heartbeat(cfg);
      } catch (err) {
        console.error(`gitlive agent: heartbeat failed: ${err.message}`);
      }
    }, intervalMs);
    if (process.env.GITLIVE_AGENT_TEST === '1') timer.unref(); // test harness only
  } catch (err) {
    console.error(`gitlive agent: connect failed: ${err.message}`);
    process.exitCode = 1;
  }
}

// `gitlive agent list` — this machine's node record + plane reachability:
// the local identity from agent.json, the liveness from one heartbeat (the
// node-secret-authenticated channel, no user session needed). The full
// roster of machines lives on the dashboard's Nodes view (authenticated).
async function cmdAgentList() {
  const cfg = loadAgentConfig();
  if (!cfg) {
    console.log('gitlive agent: this machine is not connected to a control plane — gitlive agent connect <control-url>');
    process.exitCode = 1;
    return;
  }
  console.log(`gitlive agent: connected to ${cfg.controlUrl}`);
  console.log(`  node: ${cfg.name} (${cfg.nodeId}) · hostname ${cfg.hostname} · registered ${cfg.registeredAt}`);
  try {
    const beat = await heartbeat(cfg);
    console.log(`  plane reachable: yes — last seen ${beat.lastSeenAt}`);
  } catch (err) {
    console.log(`  plane reachable: no (${err.message})`);
  }
}

module.exports = { cmdAgentConnect, cmdAgentList, ensureRegistered, heartbeat, AGENT_CONFIG_PATH };
