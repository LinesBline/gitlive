#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// gitlive MCP server — wraps gitlive's own commands (deploy/status/logs/stop/
// rollback/doctor) as real MCP tool calls instead of shell commands, so an
// agent can drive them directly. Modeled on the NVIDIA AI-Q Blueprint's
// pattern of a dedicated mcp/ service that talks to the same core logic the
// CLI uses, rather than duplicating it.
//
// Loads gitlive.js in-process (no subprocess, no shelling out to itself) via
// the pure data functions gitlive.js exports for exactly this purpose. Those
// functions never call console.log — only this file does, and only for
// fatal startup errors on stderr — because stdout is the MCP JSON-RPC
// channel over the stdio transport this server uses, and anything else
// written there corrupts the protocol stream.

const path = require('path');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const gitlive = require(path.join(__dirname, '..', 'gitlive.js'));

// Unscoped by default (unchanged from before) — set GITLIVE_MCP_ALLOWLIST at
// registration time (e.g. `claude mcp add gitlive --env
// GITLIVE_MCP_ALLOWLIST=app1,app2 -- ...`) to restrict every app-specific
// tool on this server instance to a fixed set of apps. Applies to read tools
// too (status/logs), not just deploy/rollback/stop — a client that can read
// an app's logs but not act on it isn't actually scoped away from it.
const ALLOWLIST = process.env.GITLIVE_MCP_ALLOWLIST
  ? new Set(process.env.GITLIVE_MCP_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

function checkAllowed(name) {
  if (ALLOWLIST && !ALLOWLIST.has(name)) {
    throw new Error(`"${name}" is outside this MCP server's allowlist (GITLIVE_MCP_ALLOWLIST). Not permitted from this client.`);
  }
}

function textResult(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

function errorResult(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }], isError: true };
}

const server = new McpServer(
  { name: 'gitlive', version: gitlive.VERSION },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'gitlive_list',
  {
    title: 'List gitlive apps',
    description: 'List every gitlive-managed app (local `gitlive init` mode) and whether each is currently up.'
      + (ALLOWLIST ? ' This server instance is scoped to a fixed set of apps — others are omitted.' : ''),
  },
  async () => {
    try {
      const apps = gitlive.listAppsData().filter((a) => !ALLOWLIST || ALLOWLIST.has(a.name));
      return textResult(apps);
    } catch (err) { return errorResult(err); }
  },
);

server.registerTool(
  'gitlive_status',
  {
    title: 'gitlive app status',
    description: 'Detailed status for one gitlive app: source path, start command, safe-mode blue-green state '
      + '(active slot, proxy, backend ports) if applicable, and its last several deploys with commit and outcome.',
    inputSchema: { name: z.string().describe('App name, as registered with `gitlive init`') },
  },
  async ({ name }) => {
    try { checkAllowed(name); return textResult(gitlive.getStatusData(name)); } catch (err) { return errorResult(err); }
  },
);

server.registerTool(
  'gitlive_logs',
  {
    title: 'gitlive app logs',
    description: 'Read a gitlive app\'s deploy/runtime log. One-time snapshot — does not follow/tail.',
    inputSchema: {
      name: z.string().describe('App name'),
      lines: z.number().int().positive().optional().describe('Only return the last N lines (default: whole log)'),
    },
  },
  async ({ name, lines }) => {
    try {
      checkAllowed(name);
      const data = gitlive.getLogsData(name);
      if (!data.exists) return textResult('No logs yet — deploy first.');
      const text = lines ? data.text.split('\n').slice(-lines).join('\n') : data.text;
      return textResult(text);
    } catch (err) { return errorResult(err); }
  },
);

server.registerTool(
  'gitlive_deploy',
  {
    title: 'Deploy a gitlive app',
    description: 'Deploy the current commit on main for a gitlive app (equivalent to `git push <name> main` from '
      + 'its source directory). In --safe mode this is a health-checked, zero-downtime blue-green swap that never '
      + 'puts a broken build live and reports the outcome directly; in plain mode there is a brief restart gap. '
      + 'Requires the commit to deploy to already exist on main in the app\'s source directory — this tool does not '
      + 'stage, commit, or push new changes there itself.',
    inputSchema: { name: z.string().describe('App name') },
  },
  async ({ name }) => {
    try { checkAllowed(name); return textResult(gitlive.deployAppData(name)); } catch (err) { return errorResult(err); }
  },
);

server.registerTool(
  'gitlive_rollback',
  {
    title: 'Roll back a gitlive app',
    description: 'Re-deploy the most recent previous successful commit for a --safe (blue-green) gitlive app, '
      + 'through the same health-checked deploy path as a normal push. Fails cleanly (does not touch the running '
      + 'app) if it is not a --safe app or has no earlier successful deploy on record.',
    inputSchema: { name: z.string().describe('App name') },
  },
  async ({ name }) => {
    try { checkAllowed(name); return textResult(gitlive.rollbackAppData(name)); } catch (err) { return errorResult(err); }
  },
);

server.registerTool(
  'gitlive_stop',
  {
    title: 'Stop a gitlive app',
    description: 'Stop a gitlive app\'s running process(es). In --safe mode this stops the proxy and both backend slots.',
    inputSchema: { name: z.string().describe('App name') },
  },
  async ({ name }) => {
    try { checkAllowed(name); return textResult(gitlive.stopAppData(name)); } catch (err) { return errorResult(err); }
  },
);

server.registerTool(
  'gitlive_doctor',
  {
    title: 'Diagnose gitlive install',
    description: 'Report which gitlive.js is actually running vs. what "gitlive" on PATH resolves to (catches '
      + 'stale/duplicate local installs going out of sync), plus every registered app\'s on-disk health.'
      + (ALLOWLIST ? ' The install-sanity check is unscoped, but the per-app health list is filtered to this server\'s allowlist.' : ''),
  },
  async () => {
    try {
      const data = gitlive.getDoctorData();
      if (ALLOWLIST && Array.isArray(data.apps)) {
        data.apps = data.apps.filter((a) => ALLOWLIST.has(a.name));
      }
      return textResult(data);
    } catch (err) { return errorResult(err); }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr only — never stdout, which is the MCP protocol channel.
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
