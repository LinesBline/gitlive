---
name: gitlive-deploy
description: |
  Use when asked to set up, deploy, redeploy, check the status of, get logs for, stop, or
  diagnose install problems with a gitlive-managed app (git push -> live process, no PaaS/BaaS).
license: MIT
compatibility: |
  Designed for Claude Code and Agent Skills-compatible tools. Requires Node.js 18+ and git.
  `--safe` mode additionally requires curl (already present on macOS and most Linux distros).
metadata:
  version: "2.3.0"
  author: "Bline"
  tags:
    - gitlive
    - deploy
    - operations
    - agent-skills
allowed-tools: Read Bash
---

# gitlive Deploy Skill

Modeled on NVIDIA AI-Q's `aiq-deploy` skill pattern: one skill owns setup, deployment,
health verification, troubleshooting, and shutdown for gitlive-managed apps. It does not
write application code — that's a normal coding task. This skill's job ends at "the app is
live and verified," the same boundary `aiq-deploy` draws before handing off to `aiq-research`.

## CLI wiring invariant (learned 2026-09-08 — violated THREE times)

- Every subcommand handler receives the FULL argv after the command word:
  `cmdX(rest, flags)` where `rest[0]` IS the subcommand (gitlive.js's main()
  already stripped the command). NEVER call `cmdX(rest.slice(1), …)` — it
  silently discards the subcommand and every invocation falls into usage.
  Affected before: manifest, mesh, peer.
- After touching gitlive.js dispatch or usage: `node --check gitlive.js`,
  then run the subcommand's suite AND the CLI's own smoke (help text) before
  claiming done.

## When to Use This Skill

Use this skill for requests shaped like:

- "deploy this with gitlive" / "set up git-push deploy for this repo"
- "is <app> up?" / "check gitlive status for <app>"
- "why did my last gitlive push fail?"
- "stop <app>" / "remove the gitlive app for this repo"
- "which gitlive is actually installed" / "gitlive seems to be running old code"

Do not use this skill to write or fix application code, choose a framework, or decide what
the app should do — only to get a working app deploying via `git push`.

## Prerequisites

- `gitlive` installed globally (`npm install -g .` from the gitlive source directory) or
  reachable via `node <path-to-gitlive.js>`.
- The target project is a git repo with a commit on `main` and, for `--safe` mode, a start
  command that reads its listen port from the `PORT` environment variable.
- For `gitlive connect` (GitHub mode): a real `origin` remote on GitHub, and optionally the
  `gh` CLI logged in (skips one manual token-paste step).

Before assuming `gitlive` is installed and current, run `gitlive doctor` — see Step 0.

If the gitlive MCP server (`mcp/server.js`) is registered with this client, its
`gitlive_status` / `gitlive_logs` / `gitlive_deploy` / `gitlive_rollback` /
`gitlive_stop` / `gitlive_doctor` tools are the same underlying code as the CLI
commands below — prefer calling them directly over shelling out, since there's
no shell-quoting to get wrong. `gitlive init`, `gitlive connect`, and
`gitlive rm` (creating or destroying an app) are CLI-only by design; use Bash
for those steps even when the MCP server is available.

If that MCP server instance was registered with `GITLIVE_MCP_ALLOWLIST` set, every
one of its tools — reads included, not just deploy/rollback/stop — is scoped to
that fixed set of app names. A tool call for an app outside the allowlist returns
a clean error, not a crash; if that happens, say plainly that this MCP connection
isn't scoped to that app rather than retrying or falling back to Bash to route
around it (falling back would defeat the point of the scoping).

## Workflow

### Step 0 — Confirm which gitlive is actually running

This project has previously drifted across multiple stale local copies (different zips
extracted to different folders, `npm install -g .` picking up the wrong one silently). Do
not skip this step.

```bash
gitlive doctor
```

Expected output includes a version, the exact file path it's running from, and either
`OK — PATH and this file agree.` or an explicit `MISMATCH` warning with the fix command. If
`gitlive` is not on `PATH` at all, locate the source (ask the user, or check for a
`gitlive.js` + `package.json` pair with `"name": "gitlive"`) and install it:

```bash
cd <gitlive-source-dir> && npm install -g .
gitlive doctor
```

Do not proceed to deploy commands until `doctor` reports `OK` or the user explicitly accepts
the risk of a mismatched install.

### Step 1 — Choose local mode or GitHub mode

Ask if not already specified:

```text
How should this deploy?

1. Local mode (gitlive init) — a bare repo + hook on this machine. Deploy with
   `git push <name> main`. Simplest; no GitHub involved.
2. GitHub mode (gitlive connect) — your code stays on GitHub as the only remote; a
   self-hosted Actions runner on this machine deploys on every push to GitHub.
```

Do not ask when the user already said "connect", "GitHub mode", "init", or "local mode".

### Step 2 — Local mode: decide plain vs `--safe`

For `gitlive init`, ask (unless already specified) whether the app should redeploy with a
health-checked blue-green swap:

```text
Plain redeploy (kill-then-start, brief gap, no rollback on a broken push) or
--safe (health-checked, zero-downtime, a broken build never goes live — requires
the app to read its port from $PORT)?
```

Prefer recommending `--safe` for anything the user describes as "live", "production", or
"people other than me will hit this" — plain mode is fine for quick personal tools.

```bash
# plain
gitlive init [name] --install "<cmd>" --start "<cmd>" --port <n> --yes

# safe
gitlive init [name] --install "<cmd>" --start "<cmd>" --port <n> --safe [--health "<path>"] --yes
```

Always pass `--yes` when running non-interactively (no TTY) — without it, `gitlive init`
tries to prompt and will hang or fail in a harness.

Optional flags, either mode:

- `--env-file <path>` — load a `.env`-style file as the app's secrets, sourced into its
  process env at start time. Never displayed by `gitlive status` (shows only `secrets:
  present` or `none`) and never checked into git — ask the user for the file's path rather
  than inventing values. Re-running `init` without `--env-file` leaves an existing secrets
  file untouched.
- `--nice <n>` — deprioritize the app's CPU scheduling (`nice -n <n>`). Safe to suggest for
  anything not latency-critical.
- `--memory-limit-mb <n>` — a coarse memory ceiling (`ulimit -v`), opt-in only. It's a virtual-
  address-space cap, not a precise limit — a too-tight value can crash a legitimate app at
  startup. If the user asks for one, warn them it needs testing, don't just set-and-forget it.
- If `--port` collides with another gitlive app's public port, `init` fails with a clear error
  naming the conflicting app rather than silently picking a different port — that's expected,
  not a bug to work around; ask the user for a different port.

### Step 3 — Deploy and verify

```bash
git push <name> main
```

Read the push output. Local `--safe` mode reports outcome directly to the pusher:

- Success: `remote: gitlive: deployed <commit> — live and healthy on slot <A|B>`
- Failure: `remote: gitlive: DEPLOY FAILED — <commit> never became healthy at <path> within 10s.`
  followed by confirmation the previous version is still serving.

Plain (non-`--safe`) mode and `gitlive connect` do not emit this line — after those, verify
manually:

```bash
gitlive status <name>
curl -sf http://localhost:<port>/
```

If `--safe` reported a failure, do not report the deploy as successful. Read
`gitlive logs <name>` (or `gitlive status <name>`, which shows the last several deploys with
commit and outcome) to diagnose before retrying.

If a `--safe` deploy went live and healthy but the user reports it's actually broken in some
way the health check didn't catch, `gitlive rollback <name>` re-deploys the previous
successful commit through the same health-checked path — confirm with the user before
running it, since it changes what's live.

### Step 4 — GitHub mode (`gitlive connect`)

```bash
gitlive connect --install "<cmd>" --start "<cmd>" [--name <name>]
```

This writes `.github/workflows/deploy.yml` and `deploy.sh`, and registers a self-hosted
Actions runner (one `sudo` prompt for the service install — tell the user before running
this, don't try to suppress or auto-answer it). Then:

```bash
git add .github deploy.sh .gitignore
git commit -m "wire up gitlive connect"
git push
```

`gitlive connect` has no `--safe` equivalent yet — a deploy briefly interrupts the running
instance while launchd/systemd restarts it. Say so if asked about zero-downtime GitHub-mode
deploys; don't imply it already has the same guarantee as local `--safe` mode.

`gitlive connect` apps register in the same app registry as `gitlive init` apps — they show
up in `gitlive list`/`status`/`doctor` (liveness itself isn't tracked there since launchd/
systemd own that, but deploy history is) and `--env-file` works the same way for them.
`gitlive rm` on a connect app removes its gitlive-side bookkeeping only — it does not touch
the launchd/systemd service or `.github/workflows/deploy.yml`; say so plainly if asked to
remove one, since full teardown needs a manual step too.

## Available Commands

| Command | Purpose |
|---|---|
| `gitlive init [name]` | Set up local-mode deploy-on-push |
| `gitlive connect` | Set up GitHub-mode deploy-on-push |
| `gitlive list` | Show every local-mode app and up/down status |
| `gitlive status <name>` | Detail on one app: mode, active slot (safe mode), last deploys |
| `gitlive logs <name> [-f]` | Show or follow an app's deploy/runtime log |
| `gitlive stop <name>` | Stop an app's running process(es) |
| `gitlive rollback <name>` | Re-deploy the previous successful commit (`--safe` apps only) |
| `gitlive rm <name>` | Delete an app entirely (asks to confirm; `--yes` skips) |
| `gitlive doctor` | Diagnose install drift — always run this first |
| `gitlive --version` | Print version and the exact file it's running from |

## Security Best Practices

- Never print the GitHub Actions runner registration token to a location the user didn't
  ask for; it's short-lived but still a credential.
- `gitlive connect`'s one `sudo` prompt (runner service install) needs explicit user
  awareness before running — don't script around it or hide that it's coming.
- Confirm with the user before `gitlive rm`, which deletes the bare repo and all deploy data
  for an app; pass `--yes` only when the user has already confirmed.
- Never ask the user to paste secret values into chat so you can pass them as `--env-file`
  content inline — ask them to point you at the file's path instead, and read it directly.
  `gitlive status` never displays secret values; don't work around that by printing the
  secrets file's contents yourself.

## Limitations

- This skill does not write or debug application code — only gets a working app deploying.
- `--safe` mode is `gitlive init` only, and requires the app to honor `$PORT`; it cannot
  verify this in advance beyond the health check itself failing.
- `gitlive connect`'s runner registration and one `sudo` prompt cannot be scripted around.

## Common Issues

### Issue: `gitlive doctor` reports a MISMATCH

**Cause:** Multiple gitlive source copies exist locally and `npm install -g .` linked a
different (often stale) one than the file currently being edited.

**Fix:** `cd` into the source directory that should be canonical, then
`npm install -g .` and re-run `gitlive doctor` to confirm it now reports `OK`.

### Issue: `--safe` deploy always fails health check even though the app starts fine

**Cause:** Almost always the start command binds a hardcoded port instead of reading
`process.env.PORT` (or the language equivalent). gitlive sets `PORT` per deploy specifically
so the health check can reach the new instance on its internal slot port before it goes live.

**Fix:** Update the app to read its port from the environment; re-push.

### Issue: `git push` hangs

**Cause:** `gitlive init` was run without `--yes` in a non-interactive context and is
waiting on a prompt that will never be answered.

**Fix:** Re-run `gitlive init` with `--install`, `--start`, `--port` (if `--safe`), and
`--yes` all passed explicitly.

### Issue: `gitlive_*` MCP tools aren't available

**Cause:** Either the MCP server was never registered with this client, or `npm install`
was never run inside `mcp/` (it depends on `@modelcontextprotocol/sdk` and `zod`, unlike
the zero-dependency `gitlive.js` itself).

**Fix:** `cd <gitlive-source-dir>/mcp && npm install`, then register it — see the "gitlive
MCP server" section of `README.md` for the exact `claude mcp add` command. Until then, fall
back to the CLI commands in this skill.
