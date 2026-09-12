# gitlive

Deploy and backend your own apps on hardware you own — `git push` to go
live, auth + database + file storage built in. No platform in the middle.

## What gitlive is — two layers, one tool

1. **The deploy fabric** — your code becomes a live, health-checked process
   on *your* machine when you `git push`. Plain mode or safe blue-green.
2. **The backend layer** — `gitlive-client`: accounts, a per-app SQLite
   database, and file storage your app `require`s directly. Standalone by
   default; `gitlive backend start` shares one daemon across your apps.

Both run on hardware you control, at flat cost. Your success does not bill
you more.

## Quickstart — deploy + backend an app in ~10 minutes

**Prereqs:** a machine you own (a laptop, a $5 VPS, a Raspberry Pi) · Node
22.5 or newer (the built-in SQLite backend needs it; npm warns otherwise) ·
git.

**Platforms (honest):** gitlive is a POSIX tool. **macOS** is the daily
driver — every feature is battery-verified there. **Linux** runs the same
paths (systemd `--user` for connect mode, native `setsid`, the CA trust
step prints `update-ca-certificates`); solid by construction, less
daily-driven. **Windows is not supported** — the deploy hooks are bash and
process groups are POSIX; the supported path is WSL2 with a Linux home
inside it (`gitlive doctor` says so too).

**1 — install gitlive** (one command):

```
npm install -g gitlive
```

**2 — your app folder.** Normal code, three contract rules: runs from a
start command, reads `PORT` from the environment, answers `/health` when it
is truly ready.

**3 — check readiness (optional but recommended):**

```
gitlive audit          # stack · start cmd · PORT · health · lockfile · secrets
```

**4 — claim your deploy pipeline:**

```
cd your-app
gitlive init myapp             # creates the pipeline + a git remote
```

**5 — use the backend layer in code:**

```js
const gl = require('gitlive-client');     // your backend, on your machine
await gl.auth.signup(email, password);    // accounts + sessions
await gl.db.query('SELECT * FROM t');     // per-app SQLite
await gl.storage.put('doc.pdf', bytes);   // file storage
```

**6 — go live:**

```
git push myapp main
```

Every push passes gates that protect you: an **owner signature** check
(nobody else can push code to your app — enforcement is opt-in: run
`gitlive manifest sign && git push` once and every later push must carry
your signature), a **dependency closure** check
(only dependencies you pinned can install), and a **health check** in safe
mode (if the new version fails, the old one keeps serving). `--safe` mode
gives you blue-green deploys; `gitlive connect` wires a GitHub repo to your
machine instead.

**7 — see it, operate it, protect it:**

```
gitlive open               # dashboard: theater, logs, restart, rollback
gitlive status myapp       # what's running, from where, since when
gitlive crypt              # encrypt data at rest; split keys N-of-T
```

That is the whole product for a user: **push → live on my hardware, with
auth, database, and storage built in — no platform in the middle.**

---

> **v2.6.1** — private build: audit command + workflow docs. **v2.6.0** —
> the ten-item hardening program: key rotation, owner-key storage policy,
> outbound-only relay, mesh recover, `doctor --integrity`, the audit-card
> dashboard, owner registry + `mesh rm`, daemon boot supervision. Every
> release runs the full suite battery and ships a fresh integrity manifest.
> History: [`CHANGELOG.md`](./CHANGELOG.md).

- **`gitlive init`** — local mode. Creates a bare git repo on this machine with a
  `post-receive` hook, and a git remote in your project. `git push <name> main`
  checks the code out, installs deps, and (re)starts it, right here.
- **`gitlive connect`** — GitHub mode. Wires your project's *real* GitHub remote
  to a self-hosted GitHub Actions runner on this machine, so a normal
  `git push` to GitHub triggers a deploy here — no local bare repo involved.

Zero runtime dependencies. A modular core (`gitlive.js` plus the
backend/manifest/mesh/peer/crypt/keys/daemon modules and `control/`), Node's
built-ins only.

## License

AGPL-3.0-or-later — free software, with teeth: anyone who runs a modified
gitlive as a service must publish their changes under the same license.
No chokepoint, including this one. (Copyright 2026 Bline.)

## Deeper reading

- [`WORKFLOW.md`](./WORKFLOW.md) — the full path from code to sovereign
  live: audit → sign → push → gates → theater → operate → protect →
  recover (ships in the package).
- [`DESIGN.md`](./DESIGN.md) — why every decision exists: architecture,
  threat model, honest limits, roadmap (ships in the package).
- [`SECURITY.md`](./SECURITY.md) — the security model: trust anchors,
  what each signature proves, the ranked threat model.
- [`docs/guides/`](./docs/guides/) — command-level walkthroughs: escape
  the tunnel, deploy with receipts, two homes one mesh, back up what you
  can't lose, graduate your name.


## Why gitlive exists — positioning

The cloud platforms that run most of the internet were built for one
business model: **the chokepoint**. The PaaS owns your frontend deploys,
the BaaS owns your database, the CDN vendor owns your edge — and each one
monetizes the lock-in between the layers. That model has three structural
blind spots, and this project exists to be what they structurally cannot:

**1. The apps they priced out of existence.**
Serverless platforms monetize ephemerality: cold starts, duration caps,
per-invocation billing, egress taxes. The apps that need *real* compute —
media pipelines, TTS/ASR, ffmpeg, local ML models, long background jobs,
WebSockets — are the ones clouds make brutally expensive or simply forbid.
gitlive runs those workloads on hardware you own, natively, at flat cost:
**your success does not bill you more.**

**2. Data gravity as a hostage.**
Cloud databases are designed so your users' data never leaves. gitlive's
data plane inverts that: app state lives in a git repo you own — with
history, audit trail, diff, backup, and portability built into the format
itself. *"Your data is a repo you own"* is a sentence no cloud vendor can
say, because their revenue depends on it being false.

**3. The single point of failure that is a company.**
A hosting company, a BaaS, a registrar, a CA — every layer you rent is a
place where one legal order, one ToS change, or one pricing decision can
kill a project that has no other home. The v3 vision in
[`DESIGN.md`](./DESIGN.md) is the long answer: a member mesh of
user-owned nodes that host each other's apps, replicated across
jurisdictions, so **no institution — including a state with its own
machines — can easily take a lawful project away from the people running
it.**

### The wedge

> The serverless platforms were built for apps that fit in a
> serverless function. gitlive is for the apps they priced out — heavy,
> stateful, media and AI apps — deployed by an agent to hardware you own,
> with data in a repo you own. No chokepoint. No success-tax. No export
> fee.

### Honest status (what is true today)

- **Deploy engine** (init/connect/rollback/blue-green): working, tested.
- **Backend layer** (auth + SQLite + storage via `gitlive-client`, shared
  daemon): working, tested — this is the "no BaaS" answer.
- **GitHub-repo-as-storage** (v2.5): working, tested — the first slice of
  the "data is a repo" story.
- **Control plane** (authenticated dashboard + API for every app on one
  machine): working, tested.
- **Mesh (Phase 2)**: owner-signed manifests with push-time enforcement,
  two-node state sync, `mesh deploy`/`promote`/`sync` with failover and a
  conflict ledger: working, tested — one push, running on N nodes, primary
  death survived.
- **Federation core (Phase 3)**: peers over the wire — signed announce,
  deploy/state/promote, owner trust incl. multi-owner allowlist, sticky
  reboot recovery: working, tested (NAT/relay transport = additive).
- **Hardening core (Phase 4)**: AES-256-GCM at-rest encryption +
  Shamir N-of-T key split (`gitlive crypt`), owner-key state on the bus
  (ciphertext at rest, restore needs the key): working, tested.
- **Anti-coercion layer**: duress passphrase (key shred, exit 42), dead-man
  switch (missed deadline → shred, exit 43), decoy gate, key rotation with
  signed handover, audit events log: working, tested.
- **Relay transport**: outbound-only mailbox relay — peers behind NAT/CGNAT
  exchange byte-identical signed envelopes with no inbound ports: working,
  tested.
- **Mesh recover**: heartbeat-gap report + re-replication from a surviving
  node: working, tested.
- **Supply chain**: `doctor --integrity` SHA-256 manifest over the shipped
  whitelist, regenerated in every release, with a coverage guard that fails
  the battery if a shipped module is missing from the package: working,
  tested.
- **Control-plane audit card**: events view over the audit log + keys status
  (duress/dead-man/rotations), owner registry members, `mesh rm`: working,
  tested.
- **Boot supervision v0**: `gitlive daemon ensure|status|stop` — one
  detached supervisor per machine that revives crashed proxies/apps; stopped
  apps stay stopped: working, tested.
- **Not yet real**: the decoy layer's full flow, per-app storage-policy UX
  polish (the plumbing is shipped; the picker is CLI-first), the seizure
  runbook, and any claim of anti-takedown properties (the Phase 4 gate still
  stands — nothing before that gate claims them).

gitlive is a **resilience** system, not an anonymity system, and not an
escape hatch from the law. The guarantee it will earn, phase by phase, is
exactly this: *no middleman can kill your project.*

## `gitlive init` — local mode

```
cd your-project
gitlive init
```

Auto-detects Node (`package.json`) or Python (`requirements.txt` / `app.py` /
`main.py` / `server.py`), asks (or infers) an install command and a start
command, and sets up:

- a bare repo + `post-receive` hook under `~/.gitlive/apps/<name>.git`
- a git remote named `<name>` in your project

Deploy any time with `git push <name> main`.

Two honest notes about pushes: git ignores the `post-receive` hook's exit
code (the ref is already updated), so a deploy verdict appears as a
`remote: gitlive: deploy FAILED — …` line while the push itself exits 0 —
scripts should check `gitlive status <name>` or the receipt, not the push
exit code. And pushing the same commit again is a no-op ("Everything
up-to-date"); to re-run the full pipeline for the current commit, use
`gitlive deploy <name>` — install → build → start → liveness receipt,
exactly what a fresh push would do.

After a reboot (macOS update, power cut — anything that killed the
machine), one command brings everything back: `gitlive up` — deploys the
down apps, revives safe-mode proxies, and reports whether the control
plane is running (start it with `gitlive serve --no-open`).

Flags: `--install "<cmd>"` `--start "<cmd>"` `--port <n>` `--yes` (skip prompts,
for scripted/non-interactive runs) `--name <name>` `--env-file <path>`
`--build "<cmd>"` (runs between install and start — for apps whose build
output, e.g. `dist/`, is not committed) `--nice <n>` `--memory-limit-mb <n>`.

- `--env-file <path>` loads a `.env`-style file as the app's secrets (stored
  outside any directory a deploy touches, `chmod 600`, sourced into the
  process env at start time via `set -a; source; set +a`). `gitlive status`
  only ever reports `secrets: present` or `none` — it never prints values.
  Re-running `init` without `--env-file` leaves an existing secrets file
  alone.
- `--nice <n>` runs the app under `nice -n <n>` for CPU deprioritization.
- `--memory-limit-mb <n>` applies `ulimit -v` as a coarse safety net — it
  caps virtual address space, not real memory use, so a too-tight value can
  crash a legitimate app at startup. Test after setting it; it's opt-in for
  a reason.
- If `--port` is already used by another gitlive app, `init` fails with a
  clear error naming the conflict instead of silently choosing a different
  port for you — a port you set explicitly is never overridden. (Internal
  proxy-to-backend ports, which you never see or choose, resolve collisions
  automatically instead.)

Other commands: `gitlive list`, `gitlive status <name>`, `gitlive logs <name>
[-f]`, `gitlive stop <name>`, `gitlive rm <name>`, `gitlive backend start
[name...]` / `gitlive backend stop` (see "gitlive backend" below).

Redeploys kill the whole previous process group (not just the recorded pid),
so an app started via `npm start` doesn't leave an orphaned child process
holding the port. On macOS, which has no `setsid` binary, this falls back to
Perl's `POSIX::setsid()` to get the same process-group detachment.

### `--safe` — health-checked blue-green deploys

```
gitlive init --safe --port 3000 --start "npm start"
```

By default, a redeploy kills the old process and starts the new one in its
place — there's a brief gap where nothing is listening, and if the new build
is broken, the site goes down with no rollback. `--safe` fixes both:

- Your app must read its port from the `PORT` environment variable (gitlive
  sets it per deploy) instead of a hardcoded port.
- `gitlive` runs a tiny local reverse proxy (`net.createServer`, no
  dependencies) on your public `--port`. It forwards each new connection to
  whichever internal backend slot — A or B — is currently marked active.
- Each deploy checks out the new build into its *own* directory per slot
  (`A`/`B`) — never the same directory the still-serving old process is
  running from — then starts it on the inactive slot's port and polls a
  health path (default `/`, override with `--health "<path>"`) for up to
  10 seconds. If your app needs to persist something across deploys (a
  SQLite file, uploads), don't rely on the checkout directory — write it to
  `$GITLIVE_DATA_DIR` instead, a separate directory shared by both slots on
  purpose, and only for what you explicitly put there. (This is also the
  directory `gitlive-client`, below, reads and writes automatically.)
- **Healthy:** the proxy is flipped to the new slot, then — only then — the
  old instance is stopped. In-flight connections finish against the old
  instance; every new connection after the flip goes to the new one. No gap.
- **Unhealthy:** the new instance is killed, the proxy keeps pointing at the
  old (still-running) instance, and the push is reported back to you as
  failed:
  ```
  remote: gitlive: DEPLOY FAILED — <commit> never became healthy at / within 10s.
  remote: gitlive: the previous version is still live and serving traffic.
  ```
  The site never goes down for a broken build.

Every deploy — success or failure — is recorded with its commit and outcome;
see it with `gitlive status <name>`. `gitlive stop <name>` and `gitlive rm
<name>` stop the proxy and both backend slots.

If a deploy went live and healthy but is misbehaving in some way the health
check doesn't catch, `gitlive rollback <name>` re-deploys the most recent
previous successful commit through the same health-checked path — it does
not just flip back to whatever is still running (the old slot may already be
stopped), it re-runs a real deploy of the last known-good commit. Fails
cleanly, without touching the live app, if there's no earlier successful
deploy on record.

`--safe` (and `rollback`) are currently `gitlive init` (local mode) only;
`gitlive connect` does not yet have a blue-green equivalent — see Known
limitations.

## `gitlive connect` — GitHub mode

```
cd your-project   # must already have a GitHub remote (origin)
gitlive connect
```

This:

1. Detects your GitHub `origin` remote (https or ssh form).
2. Detects the stack the same way `init` does (override with `--install` /
   `--start` if needed).
3. Merges `node_modules/` and `data/` into `.gitignore`.
4. Writes `.github/workflows/deploy.yml` (runs `deploy.sh` on `self-hosted`,
   on every push to `main`).
5. Writes an OS-aware `deploy.sh`:
   - **macOS** — installs deps, then writes and loads a `launchd`
     `LaunchAgent` (`~/Library/LaunchAgents/com.gitlive.<name>.plist`) with
     `RunAtLoad` + `KeepAlive`, so the app survives past the Actions job
     ending, restarts on crash, and comes back on reboot/login.
   - **Linux** — same idea via a `systemd --user` service
     (`~/.config/systemd/user/gitlive-<name>.service`), `enable`d +
     `restart`ed.

   Both matter because a self-hosted Actions runner kills the whole process
   tree it spawned once the job step finishes — a plain backgrounded process
   does not survive job completion, regardless of `nohup`/`setsid` tricks.
   Handing it to the OS's own service manager sidesteps that entirely.
6. Downloads the latest GitHub Actions self-hosted runner release for your
   OS/arch into `~/.gitlive/runners/<name>/` (skipped if one's already
   registered there), registers it against your repo, and installs +
   starts it as a background service (`svc.sh install` / `start`) — no
   foreground terminal tab required.
7. Creates `$RUN_DIR/data` (the same stable, redeploy-surviving location
   `--safe` mode uses via `$GITLIVE_DATA_DIR`) and exports that path to the
   app process the same way — see "gitlive backend" below.

Then:

```
git add .github deploy.sh .gitignore
git commit -m "wire up gitlive connect"
git push
```

...and every push to `main` deploys automatically.

Flags: `--install "<cmd>"` `--start "<cmd>"` `--name <name>` `--runner-version
<x.y.z>` (skip the GitHub API lookup — also useful if you hit GitHub's
unauthenticated rate limit; the resolved version is cached for 24h either
way, so repeat runs don't re-hit the API) `--env-file <path>` (same secrets
handling as `gitlive init` — see above).

Connect-mode apps register in the same app registry `gitlive init` uses, so
`gitlive list` / `status` / `doctor` all see them (liveness itself isn't
polled there — that's launchd's/systemd's job, not gitlive's — but deploy
history is recorded via the same mechanism as local mode, through a wrapper
script both the launchd plist and the systemd unit point at instead of
embedding the start command directly). `gitlive rm <name>` on a connect app
removes gitlive's own bookkeeping (registry entry, secrets, recorded
history) only — it does not stop or unregister the launchd/systemd service
or touch `.github/workflows/deploy.yml`; tear those down manually if you
want the app fully gone.

### What isn't automated

- **Runner registration token.** If the `gh` CLI is installed and logged in,
  `gitlive connect` fetches it for you silently. Otherwise it pauses once and
  shows you the exact GitHub settings page to grab it from manually.
- **One `sudo` prompt**, for `svc.sh install` (registering the runner as an
  OS-level background service). This is the one step that genuinely can't be
  scripted around — approve it when it comes up.

## `gitlive backend` — shared auth, data, and storage

Any app can get a per-app SQLite database, password/session auth, and file
storage with zero setup, by importing `gitlive-client` (its own small
package, vendored alongside your app — not published, just copied in):

```js
const gitlive = require('./gitlive-client')({ app: 'my-app' })

const rows = await gitlive.db.query('SELECT * FROM todos WHERE done = ?', [0])
const user = await gitlive.auth.createUser({ email, password })
const session = await gitlive.auth.createSession(user.id)
await gitlive.storage.put('avatars/123.png', buffer, { contentType: 'image/png' })
const { userCount, fileCount, totalBytes } = await gitlive.stats()
```

No environment variable to set yourself — both `gitlive init` and `gitlive
connect` already export `$GITLIVE_DATA_DIR` pointing at a stable, per-app
directory (`$TARGET/data` for `init`, `$RUN_DIR/data` for `connect`), and
`gitlive-client` reads it automatically. Standalone mode (the default) opens
that app's own SQLite file directly, in-process — nothing else running,
nothing to install.

To share auth/data across more than one app on the same machine, run:

```
gitlive backend start [name...]   # every registered app if no names given
gitlive backend stop
```

This starts one daemon (via the same background-process mechanism `--safe`
mode's proxy already uses, not a new service to install) that adopts each
named app's existing database in place — no export/import, no data loss —
and listens on a Unix socket per app. Every `gitlive-client` for those apps
detects the socket on its next call and switches from standalone to talking
to the daemon, transparently — no app code change, no redeploy. Stopping the
daemon (or a crash) makes every client fall back to standalone again,
automatically, on its next call.

`gitlive status <name>` shows a `backend:` line reporting `standalone` or
`daemon (pid ...)` for that app.

This is CLI-only for now, like `init`/`connect`/`rm` — no MCP tool for it
yet.

## `gitlive doctor`

Diagnoses "which gitlive is actually running" — the exact class of bug that
comes from multiple installs/zips drifting out of sync. Prints the version
and file path this command is running from, resolves whatever `gitlive` on
your `PATH` actually points to, and flags a mismatch between the two
(with the `npm install -g .` fix) instead of leaving you to guess why a
change you made doesn't seem to be running.

## `gitlive name` — the name office (globally visible by default)

One zone with a DNS token turns every app into a public name — the first
push claims `<app>.<zone>` automatically and writes this machine's public
IPv6 as the app's address, so new projects are reachable from the internet
with zero per-app DNS steps:

- `gitlive name office add <your-domain> --token <deSEC-token>` (or add the
  zone in the dashboard: ⚙ → naming → zones) — deSEC is the provider today;
  the provider table is the seam where gitlive's own DNS server plugs in.
- `git push` → the deploy hook publishes the app (auto-claims its label on
  the very first push). `gitlive name publish <app>` does it on demand;
  `gitlive name status` shows this machine's address and every zone.
- Certificates: `gitlive domain cert *.your-domain` — one command, real
  Let's Encrypt certs for every app under the zone (DNS-01 through the same
  token, so it works behind NAT).

Every DNS write is receipted (`dns-history.jsonl`) and audited. Honest
refusals: no zone, no token, or no public IPv6 — each prints exactly what
to fix. Names are borrowed labels, never owned by gitlive: `gitlive domain
graduate <app> --domain <your.domain>` moves an app to a domain you
registered, in one command.

## gitlive MCP server

`mcp/` is a small [Model Context Protocol](https://modelcontextprotocol.io)
server that wraps gitlive's own commands as real tool calls, so an agent
(Claude Code, Claude Desktop, or any other MCP client) can deploy/check/roll
back an app directly instead of shelling out to the `gitlive` CLI. It loads
`gitlive.js` in-process — same code path as the CLI, not a re-implementation
— and only ever writes to stderr, never stdout, since stdout is the MCP
JSON-RPC channel on the stdio transport it uses.

Setup:

```
cd mcp
npm install
```

Then register it with your MCP client. For Claude Code:

```
claude mcp add gitlive -- node /absolute/path/to/gitlive_3/mcp/server.js
```

(use `claude mcp add --scope user gitlive -- ...` to make it available in
every project, not just the one you run this from.) For Claude Desktop or
any other client that reads a JSON config, add:

```json
{
  "mcpServers": {
    "gitlive": {
      "command": "node",
      "args": ["/absolute/path/to/gitlive_3/mcp/server.js"]
    }
  }
}
```

Tools exposed:

| Tool | Wraps | Notes |
|---|---|---|
| `gitlive_list` | `gitlive list` | |
| `gitlive_status` | `gitlive status <name>` | |
| `gitlive_logs` | `gitlive logs <name>` | one-time snapshot, optional `lines` cap — no `-f` follow |
| `gitlive_deploy` | `git push <name> main` | the commit must already be on `main` in the app's source dir |
| `gitlive_rollback` | `gitlive rollback <name>` | `--safe` apps only |
| `gitlive_stop` | `gitlive stop <name>` | |
| `gitlive_doctor` | `gitlive doctor` | |

There's no `gitlive_rm` / `gitlive_init` / `gitlive_backend_*` tool on
purpose — app creation/deletion and the backend daemon's lifecycle stay on
the CLI, so an agent can't register, permanently delete, or reshape an app's
shared backend through a single tool call.

### Scoping a server instance to specific apps

By default an MCP client that has `gitlive` registered can act on (and see)
every app on the machine. To scope one server instance to a fixed set of
apps, set `GITLIVE_MCP_ALLOWLIST` (comma-separated app names) when
registering it:

```
claude mcp add gitlive --env GITLIVE_MCP_ALLOWLIST=app1,app2 -- node /absolute/path/to/gitlive_3/mcp/server.js
```

This applies to every app-specific tool, not just the mutating ones —
`gitlive_status` and `gitlive_logs` on an out-of-allowlist app fail the same
clean way `gitlive_deploy`/`rollback`/`stop` do, `gitlive_list` omits
disallowed apps entirely, and `gitlive_doctor`'s per-app health list is
filtered the same way (its install-sanity check is unaffected — that's not
app-specific). A client that could read an app's logs but not act on it
wouldn't actually be scoped away from it, so read tools are covered too.
Unset (the default), nothing changes from prior versions.

### Known limitations

- Self-hosted runner setup is proven on macOS (launchd) and Linux (systemd
  --user); other platforms aren't supported.
- `--safe` blue-green deploys (and `rollback`) are `gitlive init` (local
  mode) only. `gitlive connect` deploys still briefly interrupt the running
  instance while launchd/systemd restarts it — no proxy/health-check layer
  there yet.
- Plain (non-`--safe`) `gitlive init` redeploys still have the original
  brief gap between stopping the old process and the new one coming up.
- The MCP server's `gitlive_deploy` requires the commit to already exist on
  `main` in the app's source directory — it doesn't stage or commit changes.
- Single machine only — no provisioning, TLS, or load balancing.
- `gitlive backend`'s daemon serves one machine, one process — no
  clustering, no replication. Fine for what it's for; worth knowing before
  assuming it scales past that.
