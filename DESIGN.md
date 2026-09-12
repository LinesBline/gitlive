# gitlive — design principles (v2.3.0 round)

> **v2.4.1 addendum:** two real bugs found by deliberately testing the
> backend layer under actual concurrency, not by re-reading the code — the
> same discipline the rest of this file has kept from the start.
>
> **1. `SQLITE_BUSY` under genuine multi-process concurrent writes.** WAL
> mode allows concurrent readers plus one writer, but a *second* writer —
> the real `--safe` blue-green scenario, where the old and new slot
> processes both hold their own standalone connection to the same
> `$GITLIVE_DATA_DIR` during the health-check window — hit `database is
> locked` immediately with no retry, because no `busy_timeout` was set.
> Reproduced directly: two real child processes, each with its own
> `gitlive-client` standalone connection, writing 200 rows apiece to the
> same file at once. Fixed with `PRAGMA busy_timeout = 5000` in `openApp` —
> re-ran the same two-process test clean afterward (400/400 rows, zero
> duplicates, zero loss).
>
> **2. A connection-error retry that could silently re-execute a write.**
> Firing 50 concurrent `auth.createUser` calls at the daemon surfaced this:
> some calls hit the client's 2s RPC timeout and got auto-retried against
> standalone (existing behavior — "daemon dead, fall back") — except the
> daemon *wasn't* dead, it was just slow, and had already committed several
> of those "timed out" writes by the time it got to them. The retry then
> re-submitted the same signup and hit a `UNIQUE constraint failed` crash.
> Root cause of the slowness: `scryptSync` password hashing is deliberately
> CPU-heavy and was blocking the single-threaded daemon's event loop —
> 50 concurrent hashes fully serialize on one thread. Two fixes, not one:
> (a) `auth.createUser`/`verifyPassword` now use async `crypto.scrypt`
> (runs on libuv's thread pool, doesn't block other requests), and
> (b) `gitlive-client`'s connection-error handling no longer auto-retries
> *writes* on a connection error — only idempotent reads (`db.query`,
> `verifySession`, `storage.get`/`list`, `stats`). A write whose response
> was lost surfaces a clear "connection lost mid-write, not retried
> automatically" error instead of silently re-executing — the caller
> decides whether retrying is safe, the same way a dropped HTTP POST
> anywhere else would be handled. Also hardened `auth.createUser` itself:
> the same-email race this could still trigger (two concurrent signups for
> one email, both passing the pre-check before either inserts) now maps a
> raw `UNIQUE constraint failed` to a clean `CONFLICT`, since the table's
> constraint — not the pre-check — is the real guard.
>
> Re-ran the full test suite after both fixes: 50 concurrent signups now
> succeed with distinct ids and no timeouts, two apps sharing one daemon
> stay fully isolated under concurrent load, and every existing test
> (CLI integration, HTTP, headless-browser) still passes.

> **v2.4.0 addendum:** the backend layer — data, auth, and storage an app can
> "fuse" with instead of standing up its own. Three new pieces
> (`gitlive-backend-core`, `gitlive-client`, `backend.js`) plus one real bug
> found in the existing code while integrating them, documented here in the
> same spirit as the addenda below: what was decided, what broke, and how it
> was actually verified.
>
> **The core decision:** not embedded-library vs. shared-daemon, but both,
> with one API. `gitlive-client` opens the app's own SQLite file directly by
> default (zero setup — this is what every app gets today). Running
> `gitlive backend start` launches a daemon that adopts an app's existing
> database in place and starts listening on a Unix socket at
> `$GITLIVE_DATA_DIR/backend.sock`; every `gitlive-client` for that app
> auto-detects the socket on its next call (checked at most every 5s, so a
> hot path isn't `stat`-ing it per call) and switches from opening the file
> itself to talking to the daemon over IPC — same functions underneath
> (`gitlive-backend-core`), just a different transport. If the daemon dies or
> is stopped, the next call detects the broken connection and falls back to
> standalone automatically; there's no separate failure mode to design, since
> "socket absent" is already the default path. An earlier version of this
> design assumed the daemon would need launchd/systemd, the same as the
> `connect` runner — dropped once `startBackgroundNode` (the helper the
> `--safe` proxy already uses) turned out to already be the right shape for
> "a detached background helper gitlive manages": simpler, and it's gitlive's
> own existing pattern rather than a second lifecycle mechanism.
>
> **A real bug found by asking "how will the next app know to do this,"
> not by testing:** `gitlive connect`'s generated `deploy.sh` never set
> `$GITLIVE_DATA_DIR` for the app process — only `gitlive init`'s hooks
> (plain and `--safe`) did. A connect-mode app using `gitlive-client` would
> have silently written its data to `gitlive-client`'s fallback location
> (`~/.gitlive/data/<app>`) instead of `$RUN_DIR/data`, the stable,
> redeploy-surviving directory connect mode already protects from its own
> `rsync --delete` (`--exclude data`) but never actually created or told the
> app process about. Fixed in both `buildMacDeployScript` and
> `buildLinuxDeployScript`: `mkdir -p "$RUN_DIR/data"` alongside the existing
> `mkdir`s, and `GITLIVE_DATA_DIR` added to the plist's
> `EnvironmentVariables` / the systemd unit's `Environment=`, the same place
> `PATH` was already baked in for the identical class of reason. This is the
> kind of gap that doesn't show up in a working demo — `gitlive-hello`,
> deployed via `connect`, would have looked fine right up until someone
> actually checked where its data landed.
>
> **A second real bug, this one caught by testing:** the module.exports
> assignment for this file's pure functions used to live only in the
> `if (require.main === module) { main() } else { module.exports = {...} }`
> branch's `else` — meaning it only ran when `gitlive.js` was required as a
> library (by `mcp/server.js`). `backend.js` also needs a few of these
> (`loadRegistry`, `isAlive`, now `startBackgroundNode`), and it's loaded
> lazily from inside `main()` — i.e. while `gitlive.js` *is* the CLI entry
> point, the branch that never assigned exports. Fixed by moving the
> assignment out of the `else`, unconditional, with `main()` gated
> separately on `require.main === module` below it. No behavior change for
> the existing consumer (`mcp/server.js`, which only ever requires this file
> as a library).
>
> **Proof this actually works, not just that it compiles:** `gitlive backend
> start`/`stop` and `gitlive status`'s new backend line were run as real
> subprocesses against a fake `$HOME` (not simulated — the actual patched
> CLI, spawned), with a real `gitlive-client` driven against the daemon
> those subprocess calls started. Caught one more bug this way: the daemon's
> shutdown handler killed the process without closing its sockets, so
> `backend.sock` was left on disk even after `backend stop` — harmless
> (clients still correctly saw the socket as unreachable and fell back) but
> sloppy, fixed to close servers and unlink sockets properly before exiting.
> Separately, `gitlive-hello` was fused with `gitlive-client` (replacing its
> own hand-rolled `auth.js`/`db.js`/`storage.js`) and its `/` route turned
> into a real dashboard, driven through an actual headless browser — typed
> input, real clicks, a real file upload, a real download of what was
> uploaded — not just curl. That caught a UI bug unrelated to gitlive itself
> (a logout button nested inside a `<form>` that gets hidden on login was
> unreachable despite its own `hidden` attribute being cleared — an
> ancestor's `[hidden]` still wins), worth remembering as a pattern: a
> child's visibility isn't independent of its container's.

> **v2.3.1/2.3.2 addendum:** two more real bugs, found live on real hardware
> hours after v2.3.0 shipped, while actually using `gitlive connect` end to
> end for the first time since this round of fixes. Both are below, appended
> rather than folded silently into the sections above, because catching them
> only by actually running the thing — not by re-reading the code — is
> itself the point worth keeping visible.
>
> 1. **`gitlive connect`'s runner install always used `sudo`, which is wrong
>    on both platforms it supports.** macOS's `svc.sh` installs a per-user
>    LaunchAgent and actively refuses to run under `sudo` ("Must not run
>    with sudo") — running install under sudo anyway didn't error loudly, it
>    just left the service silently unstarted, so the runner registered on
>    GitHub but sat permanently Offline. Linux's `svc.sh --user` mode is the
>    same story: it's a per-user systemd unit, not a system one, so it
>    doesn't want root either. Fix: drop `sudo` entirely from both
>    `install` and `start`, and actually check `spawnSync`'s exit status
>    instead of trusting `stdio: 'inherit'` to surface a failure — the
>    original code never looked at whether the commands it ran actually
>    succeeded.
> 2. **The generated `deploy.sh` pointed the launchd/systemd service straight
>    at the GitHub Actions checkout directory itself**, not at a stable
>    location outside it — despite `runPath` already being computed and
>    `mkdir -p`'d for exactly this purpose, it was never actually used to
>    hold the deployed code. The very first real redeploy through this path
>    confirmed the failure mode directly: `launchctl list` showed the
>    service with no running pid and a last exit status of 127 ("command not
>    found") — the wrapper script it was trying to exec had stopped existing
>    once the runner's workspace moved on. This is, verbatim, the problem an
>    *earlier*, hand-tested version of this exact deploy path had already
>    solved (its comment even said so: "this is the actual fix") — v2.3.0's
>    rewrite of the deploy scripts dropped that safeguard without anyone
>    noticing, because nothing exercised a real `gitlive connect` deploy
>    before shipping. Fix: rsync (with a `cp -a` fallback for machines
>    without rsync — including, it turned out, the very sandbox this was
>    tested in) the checkout into `runPath` before writing the wrapper
>    script and service file, and point the service at that copy instead.
>
> **A third, found immediately after fixing the second:** with the checkout
> now mirrored into a stable run directory and the runner's own `sudo` bug
> fixed, the very next real redeploy still failed — this time with
> `npm: command not found`, over and over, in the app's own log. launchd
> gives a LaunchAgent a minimal default environment; it never sources
> `.zshrc`/`.bash_profile`, so an nvm- or Homebrew-installed node/npm isn't
> on it, even though the *runner's* own process (which ran `npm install`
> during the same deploy, successfully) clearly had a working PATH. GitHub's
> own `svc.sh` works around this exact problem for itself by capturing PATH
> at install time and baking it into its LaunchAgent's
> `EnvironmentVariables` — our generated plist had no `EnvironmentVariables`
> key at all. Fixed the same way, for both platforms: the deploy script
> captures its own `$PATH` (already known-good, since `installCmd` just
> ran successfully under it) and writes it into the plist's
> `EnvironmentVariables` on macOS and an `Environment=` line in the
> systemd unit on Linux.
>
> The lesson underneath all three: the v2.3.0 regression pass tested `gitlive
> init`'s `--safe` mode thoroughly, combined with the new flags, because
> that path is fast and repeatable to test from a sandbox. `gitlive
> connect` — the GitHub Actions + launchd/systemd path — was touched by
> three of the seven fixes (secrets, deploy history, MCP scoping) but never
> actually driven through a real end-to-end deploy before shipping, because
> doing so needs a real Mac, a real GitHub repo, and a human in the loop.
> Untested code paths don't announce themselves as untested — they look
> exactly like tested ones until someone runs them for real.

This file exists because seven independent fixes landed in one version bump,
and a version number alone can't tell future-you *why* each one looks the
way it does. Each entry below is a converged decision — reached by arguing
it out from three angles (what could go wrong / what's the simplest real
fix / what am I about to get wrong) before writing code, then proven with a
real, throwaway end-to-end test, not just read back and trusted. The dialogue
itself isn't preserved here; the decisions it produced are.

## 1. Isolation is the default; sharing is opt-in and named

Blue-green deploys had both backend slots writing into one shared checkout
directory. `git checkout -f` mutated files out from under the still-serving
old process during the health-check window — a genuine race, not a
theoretical one.

Fix: each slot gets its own checkout directory (`$TARGET/A`, `$TARGET/B` in
safe mode; `$TARGET/live` in plain mode, with kill-before-checkout instead of
checkout-then-kill to close the same race there too). Anything an app
actually needs to persist across deploys — a SQLite file, an upload
directory — gets an explicit, separate `$TARGET/data` directory, exposed via
`$GITLIVE_DATA_DIR`. The app opts in to sharing by using that variable; it
never happens by accident of directory layout.

## 2. Reuse a proven mechanism for secrets instead of inventing a new one per platform

Secrets needed to reach three different launch paths (a bash post-receive
hook, a macOS launchd plist, a Linux systemd unit) without ever being
displayed, logged, or checked into git. The tempting shortcut — generating
XML that embeds secret values directly into the plist's
`EnvironmentVariables` — was abandoned mid-implementation: it needs three
layers of quoting (JS template → bash heredoc → XML) with no way to test it
in this environment, for a real credential.

Fix: one small wrapper script (`.gitlive-run.sh`) that does
`set -a; source "$SECRETS"; set +a` before exec-ing the start command — the
same pattern the local hook already used and had already been tested.
launchd and systemd both just point at the wrapper instead of the raw start
command. Same mechanism everywhere, not one bespoke path per platform.

## 3. Every mode registers, or its own tooling can't see it

`gitlive connect` (GitHub Actions mode) was never writing to the app
registry at all — `status`/`list`/`doctor` had no idea connect-mode apps
existed, and `gitlive rm` on one would crash (`fs.rmSync(undefined, ...)`).
An app that exists but isn't registered isn't a smaller version of a
gitlive app — it's invisible to everything else gitlive does.

Fix: connect-mode apps register with `mode: 'connect'`, get deploy history
recorded via a bash `trap ... ERR` (since the deploy scripts run under
`set -e`, which would otherwise skip an explicit "record failure" line), and
every registry consumer (`status`, `list`, `doctor`, `rm`) branches on mode
instead of assuming init-mode's shape.

## 4. A port the user chose gets a hard error; a port gitlive chose gets a silent retry

Two different kinds of ports needed collision handling, and they needed
different failure behavior. The public `--port` is a decision the user made
on purpose — silently picking a different one for them would be surprising
and wrong, so it's a hard `checkPublicPort` error naming the exact
conflicting app. The internal A/B slot ports are gitlive's own
implementation detail, derived from a hash of the app name — the user never
chose them and shouldn't have to think about them, so `resolveSafePorts`
just salts the hash and retries until it finds two free ports.

Corollary, found by the final combined-fixes regression test rather than by
design: the public-port check has to run *before* any directory is created
or any bare repo initialized, not after. It originally ran after — a
rejected `--port` still left an orphaned bare repo and run directory on
disk, unregistered and invisible to `gitlive rm`. Fixed by hoisting the
check (and the internal-port resolution) to before any filesystem write in
`cmdInit`. A failed `init` now leaves nothing behind — verified directly:
a second app deliberately given a colliding `--port` left zero trace on
disk and the registry untouched.

## 5. A safety net gets tested to where it actually breaks, not just documented

`--memory-limit-mb` uses `ulimit -v`, which caps virtual address space, not
real memory use — a real but easy-to-hand-wave caveat. Rather than just
writing that down, it was tested at both ends: a generous limit ran cleanly;
a deliberately too-tight one caused a real segfault. The existing `--safe`
health check caught the failure and kept the previous version live,
reporting `DEPLOY FAILED` — proving the two mechanisms (a coarse resource
cap, and a health-checked rollback path) actually reinforce each other
instead of just coexisting on paper.

## 6. A scope boundary applies to reading, not just to acting

The MCP server originally gave any connected client blanket power over
every registered app — deploy, rollback, stop, but also just *read the
status and logs of* an app that client should never have known about.
`GITLIVE_MCP_ALLOWLIST` (an env var set at MCP registration time, not a
managed config file — zero new state to keep in sync, and unset behaves
exactly as before) scopes every app-specific tool, not just the mutating
ones: `status`, `logs`, `list`, and `doctor`'s per-app health list are
filtered the same as `deploy`/`rollback`/`stop`. A client that can read an
app's logs but not touch it isn't actually scoped away from that app.

## 7. Unattended memory is a disposable cache, not a source of truth

The health sentinel used to run stateless — every 4-hour firing re-derived
its findings from scratch, so a known, already-reported problem got
re-alarmed on forever. It now reads and writes
`~/.gitlive/sentinel-observations.json`: a per-app record of dedup keys for
issues already flagged, so a run can tell new from recurring from resolved.
The one rule that makes this safe rather than fragile: if that file is
missing or fails to parse, the sentinel treats it as a cold start and keeps
going — it never lets its own memory file block the actual health check.
State that can silently corrupt has to be allowed to silently reset.

## Cutting across all seven

Every fix above was validated with a real, disposable end-to-end test in an
isolated sandbox — not read back and trusted. Several of the real bugs
here (the plain-mode race reappearing after an incomplete first fix, the
`gitlive rm` crash on connect apps, `doctor`'s false-positive on connect
apps, the orphaned-directory-on-rejected-port bug) were only found *because*
something was actually run and its output actually checked, not because
they were anticipated up front. The combined regression pass at the end —
one app, `--safe` + `--nice` + `--memory-limit-mb` + `--env-file` all
together, two consecutive deploys — exists because passing seven isolated
tests doesn't prove the seven fixes are safe *together*, and it's what
caught #4's ordering bug. Individually-correct changes can still interact
badly; only running them combined proves otherwise.

---

# v3.0 vision addendum — the member mesh: gitlive as the anti-chokepoint fabric

> Written 2026-09-08. Status: **vision + architecture + honest limits**. This is
> the roadmap's destination, not a promise about what ships next. Phase 1 (the
> control-plane MVP in the README's roadmap) is still the next build; phases 2-4
> below land on top of it. Anything marked [DECIDE] is an open product/technical
> decision, not yet resolved.

## 1. Why this exists

People are running their own small servers again — but each one is an island:
no standard way for one person's server to host part of another person's
project, no way for projects to survive a machine (or a company, or a
government leaning on that company) going away. The cloud era centralized
"who can kill your project" into a handful of chokepoints: a hosting company,
a BaaS, a registrar, a CA. Any institution that pressures one company can stop
a project that has no other home.

gitlive's v3 thesis: **an open, self-sovereign deploy fabric** — nodes that
belong to their users, a protocol that lets them host each other's apps, and
replication built in from the start, so no single institution — including a
state with its own machines — can easily take a lawful project away from the
people running it.

Scope discipline: this document is about *resilience against takedown of
lawful projects* — censorship resistance, platform independence, owner
sovereignty. It is explicitly **not** an anonymity system, and no design in
this document can keep criminal content above the law, hide an operator who is
personally targeted, or defeat an adversary who seizes people rather than
machines. Those limits are restated in §9 so the design never overpromises.

## 2. Threat model — ranked, honest

| # | Adversary capability | Example | gitlive answer |
|---|---|---|---|
| T1 | A company you depend on revokes you | PaaS kills account, BaaS freezes data | No company is load-bearing anywhere (self-hosting + open protocol) |
| T2 | A state pressures a company you depend on | Legal order to host/registrar/CA | Jurisdictional diversity; members own infra; no single registrar/CA is load-bearing |
| T3 | A state blocks at the network level | DNS poisoning, IP blocking, SNI filtering, BGP | Multi-homed serving, multi-name resolution, encrypted/opportunistic channels, member relays |
| T4 | A state seizes or subverts *machines* | Node confiscation, hosting provider compromise, supply-chain attack | At-rest encryption with keys not on the node, N-of-M key split, replicas elsewhere, hash-pinned supply chain |
| T5 | A state compels *people* | Operator arrested, membership raided | Outside this design's reach (§9). The mesh helps the *project* outlive one operator, not protect that operator |

Explicit consequence of T4/T5 honesty: the mesh's promise is *"no middleman
can kill your project"*, not *"you are unfindable"*. Design for that promise
and it holds; design for the other and it breaks.

## 3. Principles (each maps to a §-implementation)

1. **No single chokepoint at any layer.** Not in identity, discovery, naming,
   storage, or serving. The cooperative directory is *convenience*, never an
   arbiter: a node ejected from the directory keeps running and keeps talking
   to the peers it already knows.
2. **Members own their infrastructure; the owner is sovereign.** Every node
   decides what it hosts, replicates, and relays. Protocol participation is
   always opt-in per node. [DECIDE] reputation & resource-sharing rules.
3. **The protocol is open and the code is source-available.** A fabric people
   bet their projects on cannot have a closed implementation. Spec-first:
   every wire message is documented before it ships.
4. **Standard, audited primitives only; zero homebrew crypto.**
   Ed25519 signatures (node:crypto), X25519 + ChaCha20-Poly1305 (via libsodium
   bindings or Node's crypto) for transport encryption, age-style file
   encryption for at-rest data, Shamir secret sharing for key split. No
   bespoke algorithms, ever.
5. **Replication is the default posture, not a feature.** Any app may declare
   "run on ≥ N nodes across ≥ M jurisdictions" and gitlive treats that as a
   first-class deployment target, same as one machine today.
6. **Data minimization per node.** A node stores what it must to serve its
   role — full replicas live only on explicitly trusted members. [DECIDE]
   whether "can serve without being able to read" (encrypt-then-serve via
   per-viewer keys) is worth its complexity in v1 of the mesh.
7. **Failure is graceful and visible.** If N nodes are down, the app serves
   from the survivors; the dashboard shows replication health, never a
   silent single point.

## 4. Layered architecture

### Layer N1 — identity & trust (self-sovereign node identity)
- Each node holds an **Ed25519 keypair** minted at first boot; the public key
  is the node's canonical identity (a bare key id, e.g. `node:ed25519:<zbase32>`).
- No CA, no registry grants identity. A **membership card** = the cooperative's
  signature over (node key, human alias, contact proofs), purely a
  convenience for discovery and trust bootstrapping.
- A member may be *ejected from the directory*; the protocol then simply has
  one fewer directory entry. Ejection cannot revoke keys, remove replicas the
  node hosts, or stop its peers from talking to it. (This sentence is the
  constitutional core of the mesh — design everything so it stays true.)
- Human aliases are mutable and non-authoritative; keys are the authority.
  [DECIDE] alias namespace (git-style `handle@node` vs DID-style).

### Layer N2 — presence & discovery (outbound-only by default)
- Nodes connect **outbound** (WebSocket/QUIC) to known peers, exactly like the
  v2.5 control-plane agent — no inbound ports, NAT-friendly, works behind
  home routers. Peer sets are *sticky*: once two nodes know each other they
  keep a signed peer record and can find each other again with no directory.
- The directory (cooperative-run, or any member-run replica of it) helps new
  nodes find their first peers. Directory downtime = slower onboarding, never
  loss of an existing mesh. Gossip (bounded, signed) propagates presence and
  app manifests.
- [DECIDE] rendezvous via DHT-lite vs signed peer-list gossip vs both; T3
  hardening (Tor/.onion or I2P endpoints as *additional* transport addrs on
  the same peer record) is designed in but optional per node.

### Layer N3 — deploy & portability (apps that can live anywhere)
- Apps already carry everything gitlive needs to run them (stack detection,
  zero-dep install/start, `--env-file`). v3 adds a **portable app manifest**
  (`.gitlive/app.manifest`): artifacts content-hashed, run contract declared,
  required capabilities listed (storage, cron, ports-none-by-default).
- Deploy target becomes a *policy*, not a path: `gitlive deploy --mesh
  ">=2 nodes, >=2 jurisdictions, prefer members with <80% load"`. The
  same `git push` that deploys to one node today fans out to the policy's
  node set.
- Content-addressed artifact store per node (reuse git itself — git already
  content-hashes everything and every node already speaks git).

### Layer N4 — state & data (no single source of truth)
- App data syncs between replicas over **git remotes the members control**
  (a member's bare repo, not necessarily GitHub). The sha-concurrency +
  LWW patterns already proven in `github-store.js`/`github.js` are the
  correctness core; the transport generalizes from "GitHub Contents API" to
  "any reachable git remote".
- Writes are versioned; conflicts resolve last-writer-wins with tombstones and
  a conflict log the app/dashboard can surface (same philosophy as the
  storage index the github mode already maintains).
- At-rest: app data and node state are encrypted with keys that do **not**
  live on the node (see N7). A seized node yields ciphertext, not data —
  and replicas elsewhere keep serving while the owner rotates identity and
  re-provisions.

### Layer N5 — serving & naming (the honest weak link)
- Legacy DNS registrars and CAs are chokepoints (§2 T2/T3). Mitigations, in
  order of effort:
  1. **Multi-homed serving**: the app listens on every replica; the domain's
     records point at multiple member nodes via multiple DNS providers
     (registrar lock + DNSSEC + multi-provider = already far beyond one
     company's reach).
  2. **Replicated gateway**: any node can serve the app's *pointer page*
     (and, where the app allows, proxy) under its own name — so the project
     stays reachable by name even if the primary domain is taken down.
  3. **Decentralized names** [DECIDE, advanced]: ENS/Handshake integration so
     a name exists that no registrar controls.
  4. TLS: automate multi-CA issuance (Let's Encrypt + alternates) and pin
     certificates into the replicated manifest so a hostile CA's issuance
     for the app's names is detectable. Honest limit: clients must verify
     pins for this to defeat interception; default web trust still leans on
     the CA system. State this plainly, don't paper over it.

### Layer N6 — takeover of the app itself
- Ownership of an app = the app manifest's signing key, held by the owner
  (off-machine). Nodes run what the signed manifest says. A host that turns
  hostile can stop *serving* a copy but cannot *steal* the app: updated
  artifacts and data flow only between parties the manifest key trusts.
- Rotation: owner keys, node keys, and membership cards all have rotation
  flows with signed handover, so "this node is now run by the wrong people"
  has a protocol answer (exclude + rotate + re-replicate).

### Layer N7 — machine seizure & subversion (T4)
- **At-rest encryption**: node storage encrypted (age-style, or native
  FileVault/LUKS layered under gitlive's own per-app encryption for data
  that must not be readable by a host at all). Host-readability is a
  per-app policy: an app owner chooses "host may read" (shared app, cheap)
  vs "host may serve but not read" (owner-key encryption, more moving
  parts) [DECIDE] per-app default.
- **Key split**: owner keys split via Shamir across ≥2 other trusted members
  + the owner's offline copy — any N-of-M can restore, so losing one machine
  (or one country) never loses the project.
- **Supply chain** (T4 subversion of tooling): hash-pinned dependency locks,
  offline package cache on every node, reproducible install (the zero-dep
  rule already shrinks this surface enormously — the mesh keeps it), signed
  gitlive releases the nodes refuse to auto-update past without signature
  checks. [DECIDE] update policy (signed tags + opt-in auto-update window).
- Seizure playbook (documented, rehearsed): detect via heartbeat gap →
  owner rotates node identity → members re-replicate from surviving copies →
  seized node holds ciphertext of nothing current. The dashboard exposes the
  runbook step-by-step.

## 5. The constitutional invariants (tests the protocol must enforce)

1. No protocol message is *required* to pass through any single node.
2. Ejection from the directory does not terminate existing peer relationships.
3. A node's hosted replicas are controlled by the app owner's keys, not the
   host's good will alone.
4. Every replicated write is attributable (signed) and conflict-resolvable
   without a central arbiter.
5. Any two nodes that have ever exchanged signed peer records can re-establish
   contact with no third party.
6. Data at rest on a node is recoverable by its owner without that node.

Each invariant gets a disposable test in the same spirit as v2.3's §7
(real runs, not read-back trust) before the phase that implements it ships.

## 6. Reuse map — what already exists, what's new

| Already built & green | Becomes |
|---|---|
| `gitlive.js` deploy/supervise/rollback | node runtime of a mesh member |
| `gitlive-client` auth/db/storage + daemon | per-app data plane, reusable for the dashboard's own accounts |
| `github-store.js` sha-concurrency/LWW semantics | correctness core of N4 sync (transport generalizes) |
| control-plane agent (v2.5 roadmap, WebSocket) | first peer of N2 — one protocol, one agent codebase |
| MCP server + SKILL.md | management surface for human and AI operators |
| Zero-dep + hash-locked style | supply-chain posture of §N7 |

New: peer protocol + records, app manifest, placement policy engine,
replication scheduler, directory service, key-split tooling, naming layer.

## 7. Phased roadmap (each phase ends test-green, disposable-test discipline)

- **Phase 1 — control plane MVP** (current): accounts, project list, live
  status/logs, start/stop/rollback from a dashboard. One agent (this Mac).
  Deliverable: `gitlive serve` + `gitlive agent connect`.
- **Phase 2 — two-node replication**: deploy one app to 2 members; data sync
  (git-remote based); manual failover + health-driven switch. Proves N3/N4
  on the smallest possible mesh.
- **Phase 3 — federation protocol**: peer records, signed presence gossip,
  outbound-only transport, directory as convenience-only. The mesh exists
  without the company running anything.
- **Phase 4 — hardening**: at-rest encryption + key split, jurisdiction-aware
  placement, multi-CA/pinned TLS, decentralized names, seizure runbook,
  supply-chain locks. This is where §2 T3/T4 promises are actually tested —
  nothing before this phase claims them.

## 8. What "advanced" does and doesn't buy (be honest with users)

gitlive's docs and dashboard should state the guarantee exactly:
**"No company, registry, or government that pressures one of them can take
your project down by taking down one thing."** It should not imply: hiding
from a state that targets you personally, immunity for unlawful content, or
protection from physical seizure of the operator. Users who need anonymity
should be pointed to actual anonymity tools — gitlive is a *resilience*
system, and saying so is what keeps it trustworthy.

## 9. Standing limits (do not let these rot)

1. Personal targeting of the operator is out of scope (T5).
2. Default web PKI still trusts CAs; pinning only helps clients that verify.
3. DNS is the weakest link; legacy domains are convenience, not sovereignty.
4. Replication trades confidentiality for availability per host; per-app
   policy decides the balance, nothing global.
5. Lawful content assumption: the mesh does not make anyone above the law,
   and no design here should be read as helping evade it.

## 10. First decisions needed before Phase 2 code

[D1] Replication transport: pure git-remote sync vs git-remote + object store.
[D2] Conflict surfacing: last-writer-wins log for v1 vs per-app conflict hooks.
[D3] Node storage: native FileVault/LUKS + per-app encryption policy (N7) —
     which apps default to "host may read"?
[D4] Manifest signing key handling: age key on owner offline media for v1.
[D5] Whether the cooperative runs a directory node in Phase 1 (recommended:
     yes — it doubles as the demo of "directory is convenience only").

---

# Phase 1 design — the control plane MVP (`gitlive serve` + `gitlive agent connect`)

> Written 2026-09-08. Status: **build spec for Phase 1** (see the v3.0 vision
> addendum above for the destination this is the first step of). Everything
> here ships test-green with disposable end-to-end tests in the established
> style (real child processes + real HTTP, fake `$HOME`).

## 1. Goal

One dashboard that shows every gitlive-managed project on this machine with
live status, logs, and start/stop/deploy/rollback actions — the same
in-process action surface the MCP server already uses, exposed as an
authenticated HTTP API, with accounts backed by gitlive-client itself
(dogfood: the control plane's own auth is v2.4's auth).

## 2. Components

- `control/server.js` — Node http server, no framework, Node built-ins only
  (matches the repo's zero-dependency habit). Routes under `/api/*` (JSON
  envelope `{ok:true,data}` / `{ok:false,error:{code,message}}`), serves
  `control/dashboard.html` at `/`. Actions execute in-process through
  gitlive.js's exported data functions (same pattern as mcp/server.js — no
  shelling out to itself). Deploy/rollback are locally synchronous git
  pushes (documented latency); everything else is instant.
- `gitlive serve [--port N] [--host H] [--open|--no-open] [--allow-register]`
  — CLI entry: boot the server, print the URL, open the dashboard.
- `gitlive agent connect <url> [--name NAME]` — Phase 1 registers *this
  machine* as a node: mints an Ed25519 node keypair (node:crypto), stores
  `agent.json` under `~/.gitlive/control/`, registers with the server,
  then heartbeats. The server executes local commands directly; the agent
  record exists so Phase 2 (remote nodes) only changes the executor, not
  the API.
- `control/dashboard.html` — single-file UI (repo's established style),
  no build step: login/register screen, project table, per-project detail
  with history + live log tail + action buttons.

## 3. State & auth (dogfood)

- Control data dir: `~/.gitlive/control/` (env `GITLIVE_CONTROL_DIR` for
  tests). Accounts + sessions: `gitlive-client` standalone against that dir
  (scrypt, sessions — v2.4, already green).
- Control schema (created via the client's own db.exec, migration-style):
  `nodes(id TEXT PK, public_key TEXT, name TEXT, hostname TEXT, last_seen_at
  TEXT, created_at TEXT)`; node secret = random 32 bytes, returned once at
  registration, stored server-side as sha256.
- First registered account is the admin; further registrations need
  `--allow-register` until real multi-user lands.

## 4. API (all Bearer session tokens except auth)

`POST /api/auth/register|login|logout` · `GET /api/me` ·
`POST /api/nodes/register` (agent key, returns nodeId+secret once) ·
`POST /api/nodes/heartbeat` · `GET /api/nodes` ·
`GET /api/apps` · `GET /api/apps/:name` · `GET /api/apps/:name/logs` ·
`POST /api/apps/:name/stop|deploy|rollback`

App data = `listAppsData()`/`getStatusData()`/`getLogsData()` output —
no duplicate model, the API is a pass-through to functions the CLI already
proves.

## 5. Acceptance (each a real run)

1. Register → login → session works; wrong password rejected; no token = 401.
2. `GET /api/apps` lists a hand-registered fake app with correct up/down.
3. Stop/rollback on a missing app → clean `{ok:false}` envelope, not a crash.
4. Dashboard HTML serves at `/`; unauthenticated browser gets the login view.
5. Agent connect registers a node; heartbeat updates `last_seen_at`;
   `GET /api/nodes` shows it.
6. Full suite green in one command; regression battery (all existing tests)
   stays green.

---

> **Positioning & narrative:** the "why gitlive exists" positioning story
> lives at the top of [`README.md`](./README.md) (read that before this file). This file holds the
> engineering reasoning: v2.3-v2.5 design principles above, the Phase 1 control-plane spec, and the
> v3.0 member-mesh vision addendum (federation, replication, hardening phases, honest limits).

---

# Phase 2 design — two-node replication (decisions [D1]–[D5] resolved)

> Written 2026-09-08. Status: **design, decisions resolved — code not
> started.** Phase 2 converts "deploy to my machine" into "deploy to my
> fabric": the same app running on ≥2 member nodes with data sync and
> failover. It is also the first provable difference from any cloud vendor
> (see README positioning) and the prerequisite for Phase 3 federation.

## The model

- **One app, one manifest, N nodes.** The portable app manifest (v3 §N3,
  `.gitlive/app.manifest`, content-hashed) declares the run contract; a
  deploy *policy* (`>=2 nodes, >=2 jurisdictions`) picks replicas.
- **One writer at a time per app (primary/replica).** SQLite is not
  multi-master and this design does not pretend otherwise. Each app has a
  *primary* node that owns writes; replicas serve reads and stand ready.
  Failover promotes a replica by owner policy (below). True multi-writer
  is a later, app-opted-in concern (the conflict machinery in D2 is the
  seed of it).
- **State = two kinds, two sync paths** (see D1).

## [D1] Replication transport — resolved: hybrid git + snapshot

Pure git for everything fails on one case: the SQLite `app.db` is one
constantly-changing binary file — whole-file churn, no meaningful diffs,
git is the wrong bus. Blob storage, by contrast, is already
content-addressed and immutable (hash-named files + an index), which is
exactly what git is good at. Resolution:

- **Storage blobs + storage index + auth hashes: git-remote sync.** The
  correctness core already proven in `github-store.js` (sha-based
  optimistic concurrency, LWW + tombstones) generalizes from the GitHub
  Contents API to *any reachable git remote* (a member's bare repo; GitHub
  stays supported as one transport). Immutable content-addressed blobs
  make git's tree model perfect; conflicts are impossible at blob level.
- **SQLite state: consistent snapshots over the same bus.** The primary
  periodically ships `VACUUM INTO` snapshots of `app.db` (SQLite's own
  consistent-copy primitive — no locking dance, no partial files), stored
  as content-addressed git blobs with a pointer file naming the newest
  snapshot. A replica restores by downloading the pointer + snapshot.
- **No new dependencies.** git + node built-ins only — same habit as
  everything else in this repo. An object store (media-scale blobs) is
  deferred until a real workload demands it (D1 reconsideration trigger:
  first app with >1 GB storage).

Snapshot cadence: default 30 s after last write, configurable; failover
data loss bound = snapshot interval (documented per app, never hidden).

## [D2] Conflicts — resolved: LWW + tombstone log now, hooks later

Writes already carry version/attribution (github-store discipline). For
Phase 2 with one primary, conflicts arrive only on *split-brain* (both
nodes believed themselves primary after a network partition):

- Every write logs `(key, version, node, ts)`; on reconciliation, LWW wins
  and the loser's entry is recorded in an explicit **conflict log** — never
  silently dropped.
- The conflict log is surfaced in the control plane (dashboard badge +
  ledger view) so an owner sees "2 conflicting writes reconciled at
  14:03:12, B won" and can act.
- Per-app conflict hooks = post-Phase-2 (an app may register a callback
  instead of accepting LWW); the log is the schema that makes hooks
  possible later without migration.

## [D3] Node storage policy — resolved: per-app policy, host-may-read default

Replication is a deliberate availability/confidentiality trade (v3 §N7).
Phase 2 makes it explicit and per-app, never global:

- `storage: host-may-read` (default) — replicas hold plaintext; cheapest,
  matches most shared/community apps.
- `storage: owner-key` (opt-in) — blobs + snapshots are encrypted at rest
  (age-style, XChaCha20-Poly1305) with a key the owner holds off-node;
  nodes can store/replicate but not read. Serving still needs the key in
  memory, so this protects *seized disks and curious hosts*, not
  interception of live traffic.
- Baseline host-level note: FileVault/LUKS remains the node owner's
  choice; gitlive policy sits above it, not instead of it.

## [D4] Manifest signing — resolved: age key on owner offline media

- The app manifest and every artifact hash are signed (Ed25519) by an
  **owner manifest key**. The private key lives on the owner's offline
  media (USB, printed QR backup) — never on a node.
- Nodes verify signatures before accepting a deploy or snapshot; a
  hostile or compromised node can stop serving a copy but cannot
  substitute code or data the owner's key did not sign.
- Rotation: signed handover document (old key signs new key's
  fingerprint) + control-plane UI to walk it; revocation list rides the
  same sync bus.

## [D5] Directory node — resolved: yes, a control plane role

- Phase 1's `gitlive serve` becomes the first **directory node**: it
  already holds accounts, node registry, heartbeats, and the app ledger —
  the directory's Phase-2 job is *discovery + policy view*, never
  mediation of app traffic.
- Running it also dogfoods the v3 invariant "directory is convenience,
  not arbiter": Phase 3 peers keep talking when a directory node is down.
- Any node may run a directory; cooperative-run directory = Phase 4
  concern. One `serve` instance per home is the Phase-2 norm.

## Phase 2 build list (each test-green, disposable-test discipline)

1. `gitlive manifest sign/verify` — artifact manifest + signing (D4).
2. Remote-git transport for storage blobs (github-store generalization) +
   snapshot shipper/restorer on the primary (D1).
3. Deploy policy: `gitlive deploy --mesh ">=2 nodes"` targets N replicas;
   replicas health-reported to the directory (D5).
4. Failover: heartbeat-gap detection → owner policy decides promotion;
   manual override in dashboard; data-loss bound = snapshot interval (D1).
5. Control plane: replica health, conflict-log badge, snapshot lag readout.
6. E2E: two fake-home nodes on one machine sync a real app's storage +
   sqlite; kill primary → promote replica → writes continue; conflict
   injection reconciles with a logged LWW entry.

---

# Field findings — real-app operations (2026-09-08) fed back into the roadmap

First real-world day on the user's own machine (a test app deployed through the
whole Phase 1/2 stack). Findings that code should own later:

1. **The safe-mode public proxy is not supervised.** The proxy process
   (started once at `init`, `proxy.pid` under the run dir) does not survive
   reboots/process death, and nothing restarts it — the backend slots can be
   healthy while the public port stays dead, and the dashboard honestly
   reports `alive: false` with no hint that the *proxy* is the missing piece.
   Roadmap: proxy supervision belongs to the same daemon/supervisor story as
   app processes (reboot-survival pass); until then, `Start`-style manual
   restart is the documented recovery. A dashboard-side hint ("backend
   healthy, proxy down") is a cheap interim improvement.
2. **Deploying an already-deployed commit is a no-op** ("Everything
   up-to-date") — correct git behavior, but there is no first-class
   "restart this app" command for plain/safe apps (`stop` + redeploy of the
   same commit needs an empty commit today). Roadmap: `gitlive restart
   <name>` = re-run the current commit through the existing deploy machinery
   without a new commit.
3. **Enforcement hook validated on a real app end-to-end**: unsigned pushes
   pass (legacy), a signed push is accepted with `manifest OK … owner
   signature valid`, and the deploy lands healthy. The sign → commit
   manifest → push workflow holds in practice.
4. **Manifest hygiene is easy to get wrong by hand**: the `.gitlive/`
   manifest file is untracked until explicitly committed, so "I signed it"
   can silently mean "nothing enforced." Roadmap: `gitlive manifest sign`
   should print the exact next two commands (`git add … && git commit`) and
   a pre-push friendly reminder when HEAD moved past the signed commit.

---

# Status — Phase 2 complete (2026-09-08)

All six Phase 2 build items shipped and green (10/10 suites, disposable-test
discipline): manifest signing + deploy enforcement (1), sync transport (2),
mesh deploy policy (3), failover (4), control-plane replica/conflict views
(5), combined E2E (6). Field findings recorded above remain open roadmap
items (proxy supervision, `restart` command, sign-workflow hints). Next:
Phase 3 (federation protocol) — see the v3.0 addendum and the Phase 3
design below.

---

# Phase 3 design — federation protocol (peers, no directory required)

> Written 2026-09-08. Status: **design; code not started.** Phase 2 proved
> N nodes can run one app with state sync and failover — but the nodes were
> homes on ONE machine orchestrated by the CLI. Phase 3 is the transport
> that makes those nodes real machines: peers that talk to each other over
> the network, keep working when the directory is gone, and need nothing
> from gitlive-the-company (there is none) to exist.

## Goals (what "works" means after Phase 3)

1. Two gitlive nodes on two machines can mesh-deploy an app to each other
   with no third party in the request path.
2. A node that has ever known a peer can reach it again with no directory
   (sticky peer records — Phase 2's mesh.json copies already embody this
   locally).
3. Every protocol message is authenticated (node Ed25519 keys, signed by
   the owner's manifest key at membership time) — a directory can vouch,
   never dictate.
4. State sync (Phase 2 bus) works between peers; the bus itself may live on
   any peer.

## Transport decisions (zero-dependency stays law)

[P1] **Transport: HTTPS/JSON + SSE, Node built-ins only.** No WebSocket
dependency: each node runs its control listener (node:http), peers call its
`/peer/*` endpoints with fetch (outbound from the caller), and long-running
events (deploy progress, log tails) use SSE on the same HTTP stack. Phase 3
tests run over loopback; NAT traversal/relay is a later, additive transport
(an optional relay role) — outbound-first design keeps that door open.

[P2] **Peer identity = Ed25519 node key** (reuse the control-plane agent's
keypair). Peer record: `{ nodeId, name, endpoints: [https://host:port],
publicKey, ownerFingerprint, addedAt }`, signed by the adding side's owner
key. Stored in mesh.json (already replicated to every node).

[P3] **Presence = signed heartbeat, gossip-bounded.** Each peer heartbeats
its known peers every N seconds (record: `{nodeId, seq, ts}` signed).
Presence is advisory only — deploy/state ops never require a live heartbeat,
they require a reachable endpoint (honest: reachability is tested by the op
itself).

## Protocol surface (peer listener endpoints)

- `GET /peer/hello` — identity + version handshake (no auth; hello is public).
- `POST /peer/announce` — signed peer record exchange (mutual add).
- `POST /peer/deploy` — owner-signed manifest + commit ref; receiver runs
  its own hooks (Phase 2 machinery unchanged — the hook IS the deploy).
- `POST /peer/state-refresh` — asks receiver to pull the app state bus
  (bus URL + signed snapshot ref). Receiver restores via Phase 2 sync.
- `POST /peer/promote` — signed primary-change notice (owner key), updates
  the receiver's registry.
- `GET /peer/apps` — receiver's app roster (signed listing).

## Discovery

[P4] Directory stays a **convenience**: a node may register itself at one or
more directory nodes (any peer can play that role) so new nodes can find
their first peers. Once any two nodes hold each other's signed peer
records, the directory is out of the path (v3 invariant #2, #5).

## Failover across machines (owner policy, Phase 2 semantics)

[P5] Promotion stays owner-decided: `mesh promote` sends the signed notice
to every peer; a peer that cannot reach the old primary may, after the
owner's configured grace window, accept the notice from the new primary
(counter-signed). Auto-promotion stays OFF by default (v3: owner policy
decides; machines never self-promote without the owner's key).

## Honest limits (carried from v3 addendum §9)

- Same-machine loopback tests prove the protocol, not the internet: NAT,
  reboots, and hostile networks are additive hardening, not Phase 3 scope.
- Trust model: a compromised node can stop serving copies but cannot forge
  owner-signed deploys/promotions (keys off-node, D4).

## Acceptance (each a real two-process run, disposable-test discipline)

1. Node A and node B (two fake homes, loopback listeners) exchange
   `/peer/hello` + `/peer/announce`; each lists the other with no directory.
2. A mesh-deploys an app to B over `/peer/deploy`; B's hooks run it; state
   syncs over `/peer/state-refresh`.
3. A dies (process killed); B still serves; owner promotes B from A's
   surviving copy of the registry or from B itself.
4. Reboot test: A restarts, finds B from its sticky peer record alone, and
   re-syncs state.
5. Tamper test: an unsigned `/peer/deploy` is refused; a forged promote is
   refused (owner signature check).

---

# Phase 3 progress (2026-09-08)

Slice 1 (peer identity + hello + signed announce + peer store) and slice 2
(deploy / state-refresh / promote OVER THE WIRE — git bundles over HTTP,
receiver-side apply with manifest check, loopback E2E incl. tamper refusal)
are shipped and green (`peers.test.js`, `wire.test.js`). Remaining Phase 3
slices: owner-signing of membership (peer records cross-signed by the owner
key — the trust model the MVP currently defers), reboot/sticky re-sync over
the wire, NAT/relay transport, and the full acceptance list of the Phase 3
design above.

---

# Phase 3 progress (slice 3, 2026-09-08) — owner trust closed

Peer membership is now cross-signed by the OWNER manifest key: announces and
peer ops carry an `ownerSig` when the sender has an owner key, and a node
that has an owner key refuses peers that do not carry its owner's signature
(`peers.test.js`, `wire.test.js` both green, incl. ownerless-attacker
refusals on announce and on ops). MVP trust gap (peer.js header comment)
is closed for the single-owner case. Remaining Phase 3: multi-owner trust
lists, reboot/sticky re-sync over the wire, NAT/relay transport, full
acceptance list of the Phase 3 design.

---

# Phase 3 progress (slice 4, 2026-09-08) — sticky reboot recovery

`peer resync <app>` restores the newest state from the first reachable STORED
peer (no URL, no directory): the receiver snapshots its state into its local
bus (`state-pull`) and the restarting node restores from it. Wire E2E proves
"A was down while B gained a newer write → A resyncs from its sticky record
and recovers it." Announce records now carry the ANNOUNCER's own endpoint
(`--endpoint`), fixing a self-pull bug caught by the test. Remaining Phase 3:
multi-owner trust lists, NAT/relay transport, and the Phase 3 design's
remaining acceptance items (hello/announce/deploy/promote/tamper/reboot all
covered).

---

# Item 4 progress (2026-09-08) — operational reliability

`gitlive restart <name>` shipped: plain mode stops + starts the same code
(no commit needed — closes field finding #2); safe mode supervises the
public proxy and revives it when dead (field finding #1) while leaving
healthy backend slots running; code swaps in safe mode remain
push/rollback by design. The dashboard now carries a proxy-down banner on
the app detail (`proxyDownHint` — "backend may be healthy but the public
port is dead; run gitlive restart <app>"). `ops.test.js` green for both
paths. Reboot-survival/supervision-at-boot remains a documented roadmap
item (daemon story) — restart is the operator remedy today.

---

# Item 2 progress (2026-09-08) — Phase 4 hardening primitives

`gitlive crypt` shipped: AES-256-GCM at-rest encryption (keygen/enc/dec,
0600 storage key) and Shamir Secret Sharing over GF(256) (split N-of-T /
join, file formats GLC1/GLS1). `crypt.test.js` green: round-trips, wrong
key + tamper rejection, 3-of-5 reconstruction, threshold enforcement,
tampered-share detection, CLI end-to-end. Also added
`tests/dispatch.test.js` — a structural guard that fails any future
`cmdX(rest.slice(1))` wiring (the bug class hit FOUR times), with the two
known-good inline-sub patterns allowlisted.
Next slices (roadmap): wire the 'owner-key' storage policy through
sync/restore so replicas hold ciphertext (D3), owner manifest-key split +
rotation UX (D4), seizure runbook + supply-chain locks (Phase 4 gate).

# Reboot-survival note (item 4 remainder, 2026-09-08)

Apps do NOT auto-start after a Mac reboot today: plain/safe apps and the
safe proxy die with the session. Operator remedies: `gitlive restart <app>`
(revives proxy / restarts code) and double-click/terminal relaunch after
reboot. Real supervision at boot (launchd LaunchAgent + the daemon story)
is tracked roadmap — macOS TCC blocks launchd from Desktop paths, so the
documented interim is: after reboot run `gitlive restart` per app, or wrap
the app in a Start-*.command user-session launcher (the same pattern used by
session-scoped projects on macOS).

---

# Items 5 & 6 design (2026-09-08) — beyond localhost + the cooperative

## Item 5 — control plane beyond localhost (named, reachable)

Problem: today the dashboard is http://127.0.0.1:5180 — a number, not a
name. Two distinct needs:
(a) the OWNER reaching their own node from anywhere;
(b) OTHER people reaching a public app (already solved by apps themselves).

Design for (a), in three layers:
1. **Names come from the mesh, not from a registrar.** Each node registers
   a human name with its directory/peers (peer records already carry
   `name`). `gitlive whoami` prints the node's canonical handle
   (`name@nodeId-short`); `~/.gitlive/control.url` stays the local address
   and a new `~/.gitlive/node.name` holds the handle.
2. **Reachability = outbound relay, not inbound ports.** Phase 3 transport
   is outbound-first; the missing piece is a RELAY role: any always-on
   member node (or the owner's own second node) can relay HTTPS between
   the dashboard and the owner's device. Relay = additive transport
   (documented in the Phase 3 design), never a requirement for
   same-LAN/loopback use.
3. **Accounts story (near term, honest):** single-admin today by design
   (registration closes after first account). The path to "other people
   with multiple projects" is: multi-owner trust (shipped in peer trust),
   then invite-based onboarding (item 6) so the owner — not an open
   registration form — admits members. A public signup page stays OFF
   until billing/abuse posture exists (v3 honesty rules).

## Item 6 — the cooperative layer (design + first onboarding slice)

Members join by INVITE, never by open registration:
1. Owner runs `gitlive mesh invite --name <friend-node>` → owner-signed
   token (Ed25519, TTL, role). The token is the ONLY thing a new node
   needs to introduce itself.
2. New node runs `gitlive mesh join <token>` → verifies owner signature +
   TTL → registers its peer record with the owner's node(s).
3. Directory nodes are members too (D5) — running a directory is a role,
   not a company.
4. Reputation/resource-sharing rules are explicitly deferred (v3 addendum)
   until >1 real external member exists — no speculative governance.

Invite token format: base64url(JSON {v:1, role:'node', name, iat, exp,
ownerFingerprint, sig}) where sig = owner manifest key over the canonical
JSON minus sig (same discipline as peer ops). Slice ships the
create/verify core + CLI; registry wiring lands with the first external
member.

---

# Item 3 progress (2026-09-08) — public face assets

npm package: ready + verified (101 KB tarball, bin clean, all runtime files
incl. mesh/peer/crypt). Publishing awaits the owner's registry-account fix
(four documented lines). Homebrew: `packaging/gitlive.rb` formula +
`packaging/homebrew-tap.md` publish steps (version/sha256 fill-ins marked).
Landing: `site/index.html` single-file draft (wedge, features, honest
status, install command). Remaining when the repo goes public: point the
formula/homepage at the real repo, CHANGELOG hygiene, demo video.

---

# Item 6 progress (2026-09-08) — onboarding loop complete

Invite tokens now embed the owner's public key, so a joining node (which has
no owner key) can verify the invite itself; announce carries the invite and
the owner's node accepts it as one-time introduction (name must match).
`gitlive mesh invite / verify-invite / join` = the full onboarding loop,
proven over the wire in peers.test.js: owner invites "joiner" → joiner joins
with no owner key → owner lists it. Reputation/resource-sharing rules stay
deferred until a real external member exists (no speculative governance).

---

# Item 5 progress (2026-09-08) — node identity slice

`gitlive mesh whoami` / `set-name` + `~/.gitlive/node.name` give every node a
handle (`name@node`), and the control plane exposes it in `/api/meta` →
the dashboard header shows "node name@node". Version aligned to 2.5.0
(internal const + package.json + CHANGELOG). Relay transport and the
directory naming layer remain the documented additive next slices.

---

# Program status (2026-09-09) — six roadmap items at their scoped milestones

All six items delivered and verified with the disposable battery (16/16
suites green): (1) Phase 3 federation core incl. owner trust + sticky
recovery; (2) Phase 4 hardening primitives + owner-key state on the bus;
(3) public face assets (npm-ready, Homebrew formula/guide, landing draft);
(4) ops reliability (restart, proxy revival, dashboard hint, reboot notes);
(5) beyond-localhost design + node identity slice; (6) cooperative design +
invite onboarding loop. Remaining work is explicitly additive or
owner-side, recorded above: relay/NAT transport, per-app policy UX +
rotation, supply-chain locks + seizure runbook (Phase 4 gate), npm
publish (owner's registry-account action), first external member
registry polish.

---

# Anti-coercion modes for gitlive crypt (2026-09-09, design + duress slice)

Motivation (owner's words): if an agency forces the key, the data should
become numbers that never connect to anything — with a trigger the user
controls ("if I ever enter my key with this number, I am compromised").

## The real mechanism (why this works)

Data is encrypted with key K (AES-256-GCM). Destroying K makes every .glc
blob computationally unrecoverable — ciphertext is noise without the key.
Crypto-shredding one small key therefore beats "erasing" data. Guaranteed
by the math, not by effort.

## Three modes (in order of strength)

1. **Duress trigger (slice now):** the storage key can be wrapped by a
   passphrase (scrypt → AES-GCM). A marked duress entry (passphrase with a
   configurable prefix, default `!`) does NOT unwrap — it crypto-shreds the
   key file (overwrite + unlink) and logs the event with a timestamp. After
   that, decryption is impossible forever. User chooses the moment; the
   data is lost with the key by design.
2. **Dead-man switch (next slice):** a check-in cadence — if the owner does
   not tick before the deadline (or a designated contact sends the signal),
   keys auto-shred. Protects against "unconscious/absent while seized".
3. **Decoy layer (later slice):** a second, plausible dataset under a
   second key; under coercion the owner reveals the decoy passphrase, the
   real volume stays hidden (plausible deniability pattern). Stronger than
   destruction when the agency inspects disk state.

## Honest limits (do not let these rot)

- **Pre-seizure imaging beats every app-level trigger.** If the machine is
  imaged before the owner acts, the key is in the image. The real defense
  is keys that never leave the Secure Enclave/TPM (hardware-bound keys,
  future slice) — "jailbreak-proof" is a hardware property, not software.
- **"Another machine got my key" is undetectable client-side** (the disk or
  memory was copied). Only enclave keys + remote attestation address it.
- **Legal:** destroying evidence under compulsion can itself be a crime
  (obstruction) in some jurisdictions; these features ship with that
  stated, and never silently — duress actions are logged and loud.
- Duress = irreversible by design. No "oops" recovery, no backdoor — a
  backdoor would defeat the entire point. Test the ritual with a throwaway
  key first.

## Acceptance (duress slice)

1. `gitlive crypt keygen --passphrase` wraps the key (unwrappable only with
   the phrase; fingerprint stable).
2. `gitlive crypt unlock --passphrase <correct>` → ok, key intact.
3. `gitlive crypt unlock --passphrase !<anything>` → key shredded, event
   logged, later decrypt fails with missing key.
4. `gitlive crypt duress --yes` → explicit shred + log for file-based keys.

---

# Closeout docs (2026-09-09) — decoy layer, relay, rotation, Phase-4 gate

## Decoy layer (anti-coercion, design + acceptance — not yet built)

Plausible deniability pattern: two datasets under two keys in the SAME
storage root. Under coercion the owner reveals the decoy passphrase; the
agency sees a real-looking, consistent dataset and leaves; the real
dataset stays hidden (its existence is not provable without the real key —
disk-use inference is the known leak, mitigated by pre-allocated decoy
capacity).

Acceptance (when built): 1) `gitlive crypt decoy init` creates a decoy
profile + second wrapped key; 2) writes under the armed profile go to the
REAL dataset by default, but `--decoy` writes go to the decoy; 3)
unlocking with the decoy phrase presents ONLY decoy data, never errors,
never hints a second dataset exists; 4) events log records the decoy
unlock loudly (auditability for the owner's later recovery of "what did
they see").

## Relay / NAT transport (Phase 3 additive — design note)

Peers today talk over direct loopback/LAN HTTP. For two nodes on different
networks: any always-on member (or the owner's own second node) may run a
RELAY role: outbound-only clients connect to it, and it forwards signed
/peer/* messages between them without seeing plaintext app data (all
payloads are already owner/node-signed and state is encrypted at rest).
Relay never holds keys; it holds ciphertext-in-transit only. Acceptance:
relay-forwarded deploy + resync between two nodes that cannot reach each
other directly.

## Key rotation UX (Phase 4 slice — design note)

`gitlive keys rotate <owner|node|storage>`: mints a new key, re-wraps
replicable state (snapshots/blobs re-encrypted via decrypt-old →
encrypt-new streaming pass), updates peer/mesh trust records with a signed
handover (old key signs new key's fingerprint — v3 D4), and logs the
rotation. Renunciation list rides the state bus. Acceptance: rotate +
verify old ciphertext still readable + peers accept the new fingerprint
only via the signed handover.

## Supply-chain locks + seizure runbook (the Phase-4 honesty gate)

NOT CLAIMED until these land: (a) hash-pinned dependency locks + offline
package cache on every node (the zero-dep law already shrinks this
surface); (b) signed gitlive releases nodes refuse to auto-update past;
(c) seizure runbook (detect heartbeat gap → rotate node identity →
re-replicate from survivors → seized node holds ciphertext of nothing
current) documented and rehearsed per node; (d) per-app at-rest policy
enforcement (owner-key default for sensitive apps). README explicitly says
nothing before this gate claims anti-takedown properties.

---

# Item 3 (ten-item program, 2026-09-09) — key rotation core shipped

`gitlive keys rotate <storage|node|owner>` + `keys rotations`: every rotation
appends a SIGNED handover (old key signs {kind, old→new fingerprints, at})
to ~/.gitlive/rotations.log. Storage rotation re-wraps (passphrase-aware)
and can re-encrypt .glc trees old→new in place (--reencrypt-dir). Node and
owner rotations replace the keypair with the OLD key signing the handover;
operator next-steps printed (re-announce / `peer trust add`). Legacy bus
snapshots stay under the old key until superseded by the next push —
documented. keys.test.js green; dispatch guard re-verified after the 5th
occurrence of the argv-slice class (fix + guard run).

---

# Item 4 (ten-item program, 2026-09-09) — per-app owner-key policy shipped

`gitlive mesh deploy --storage owner-key` records the policy in every node's
registry, encrypts the state bus with the node's storage key (AES-256-GCM,
`.glc` tree + `.glc-mode` marker), and peers restore with THEIR OWN storage
key — owner-distributed keys decrypt; keyless replicas hold ciphertext only
with an explicit unlock message. `mesh sync` honors the recorded policy.
Control plane exposes `mesh.storage` (dashboard chip: "enc owner-key").
policy.test.js green (encrypted bus, keyed restore, keyless refusal).
Mesh deploy sync now writes the self-registry marker BEFORE state sync (TDZ
fix) and peer children no longer inherit the orchestrator's key env
(peerChildEnv) — both found by the test.

---

# Item 5 (ten-item program, 2026-09-09) — relay transport slice shipped

Outbound-only peer comms through a mailbox relay: any peer listener serves
`/relay/send` + `/relay/poll?node=`; `peer relay announce|ping|poll` lets
two nodes that never share URLs exchange signed messages via an always-on
relay. The relay holds no keys, verifies nothing, cannot forge: mailboxes
store metadata BESIDE the message so envelopes round-trip byte-identical
and edge signatures survive (found + fixed by the test). Pollers verify
signature + owner policy before acting; unsigned mail is dropped.
relay.test.js green. Full op relay (deploy bundles through a relay) reuses
the same mailbox transport with the existing signed-op handlers.

---

# Item 6 (ten-item program, 2026-09-09) — mesh recover shipped

`gitlive mesh recover <app> [--from <node>]` prints a heartbeat + state
roster for every node (UP/down · ★primary · data present · commit), picks a
source automatically (explicit --from > alive primary > alive node with
data > any node with data as last resort), snapshots it onto the state bus
(owner-key aware) and restores every other node that has the app. When the
recorded primary is down it prints the promote hint (owner decides).
_peer-status now reports dataPresent. recover.test.js green: primary dies,
survivor drives recovery from its own home, dead node regains the newer
state.

---

# Item 7 (ten-item program, 2026-09-09) — doctor --integrity shipped

`gitlive doctor --integrity [--write]` verifies/regenerates INTEGRITY.json
(SHA-256 per shipped file from package.json's files whitelist, format
gitlive-integrity/1, versioned). GITLIVE_INTEGRITY_ROOT supports installed
copies and hermetic tests. release.sh regenerates the manifest inside every
release run so a shipped tarball always matches. integrity.test.js green
(real repo verify, synthetic write/verify/tamper/missing-manifest paths).

---

# Item 8 (ten-item program, 2026-09-09) — dashboard audit card (events) + keys duress status

Control plane gains the audit surface the CLI already records:
- `GET /api/events` — tail of `~/.gitlive/events.log` (last 50 lines,
  env-HOME aware, JSON rows; malformed lines degrade to `{kind:'raw'}`).
- `GET /api/keys` extended with `duressArmed` (storage key starts `GKW1`),
  `deadman` (`{armed, deadline, intervalH, hoursLeft}` from deadman.json) and
  `rotations` (line count of the rotations ledger).
- Dashboard: new ◉ events view rendering kind chips (duress/dead-man rows
  flagged off-color) + timestamp/detail, refresh button, wired into the
  ops-nav view map and both showAuth/showApp hide lists. Keys card now shows
  the duress/dead-man/rotation status chips above the hint line.
- control-plane.test.js drives all three endpoints against real fixtures
  (events.log rows, rotations ledger, wrapped storage key, future dead-man
  deadline) — green.

---

# Item 9 (ten-item program, 2026-09-09) — mesh join registers into the owner registry; mesh rm cleanup

The fabric gained an owner-side membership record distinct from deploy targets:
- mesh.json grows a `members` section (OUT of `nodes`, which stays
  locally-hosted `{home}` deploy targets — deploy/promote/syncMeshToPeers are
  untouched by remote membership): `{name: {fingerprint, endpoints,
  joinedAt, lastSeenAt, remote: true}}`.
- `/peer/announce` acceptance (invite-carried joins AND owner-signed/trusted
  announces) best-effort registers the node via `meshRegisterRemote` — a
  registry write can never fail an accepted announce; name/key collisions are
  refused without clobbering.
- `gitlive mesh list` prints `owner registry members (remote, joined over the
  wire)`; the control-plane `/api/mesh` summary + dashboard Mesh view now
  carry members (name · endpoints · key prefix) and a join hint line.
- `gitlive mesh rm <name>` cleanup: removes a locally-hosted node or a remote
  member, and for members also drops the matching peers.json row (removed
  members cannot keep announcing as known). `self` and unknown names are
  refused.
- peers.test.js section 6 drives the whole loop over the wire (fresh node
  joins with an invite → owner registry carries the member → list/Mesh view →
  rm removes member + peer row). mesh/policy/relay/invite/wire/dispatch
  regression suites stay green.

---

# Item 10 (ten-item program, 2026-09-09) — gitlive daemon ensure: boot supervision v0

`gitlive daemon` (ensure/status/stop) — one detached supervisor per machine:
- `daemon.js`: zero-dependency supervisor. `ensure` spawns a session-leader
  child (perl-POSIX setsid on macOS, setsid elsewhere — same detached idiom
  as app starts), writes `~/.gitlive/daemon.pid`, and reuses the running
  supervisor on repeat calls (single-instance, mirroring the control plane).
  `stop` kills the supervisor's process group; registered apps keep running.
- Tick loop (default 15 s; `GITLIVE_DAEMON_TICK_MS` / `..._COOLDOWN_MS`
  overrides keep the E2E suite fast) revives only what CRASHED — pidfile
  present but process gone: plain apps (`app.pid`) and safe-mode public
  proxies (`proxy.pid`) get `gitlive restart <name>` through the real CLI, so
  every revive writes the same deploy.log lines as a manual restart.
  Stopped apps (no pidfile — `gitlive stop` removes it) stay stopped, and
  connect-mode apps are left to launchd/systemd: liveness is never guessed.
  Revives land in `~/.gitlive/daemon.log` + the events log (kind `revive`).
- tests/daemon.test.js (fake $HOME, real children): ensure idempotence,
  crashed plain app revived, dead safe proxy revived, stopped app untouched,
  status/stop lifecycle — green. Battery note: the supervisor must never run
  against a real HOME inside the battery (fake homes only).

Packaging fix discovered while shipping this item: `crypt.js`, `keys.js`,
`peer.js` and now `daemon.js` were NOT in package.json's `files` whitelist —
the tarball could never load them (a silently broken installed CLI).
Whitelist extended; integrity.test.js gained a coverage guard that fails the
battery whenever a shipped .js requires a module missing from the whitelist.
Dry-run pack now carries all 26 files.


---

# Audit log coverage (2026-09-08, post-2.6.0)

The events log (`~/.gitlive/events.log`, Events view) answered three kinds
today — duress, deadman, revive. Two gaps closed so the log can answer the
"who did what" questions an audit record exists for:
- `manifest-denied` — the pre-receive hook's `_check-manifest` now records
  every REJECTED push (app, short commit, errors). Accepted pushes stay out
  of the log: routine success is noise; a refusal is the security event.
  Logging is best-effort and never masks the rejection (exit 1 stands even
  if the audit write fails).
- `login` / `login-fail` — the control plane records successful and failed
  dashboard logins (email + source address). Failed-login events are the
  signal for brute-force attempts; successes answer "who was in when".

Test discipline note: hook-side events write to the hook process's HOME — a
rejection test must push under the FAKE home or the audit line lands in the
real `~/.gitlive/events.log` (caught live: the first run wrote a
`manifest-denied` line for a /tmp fake repo into the real log; expectPushFail
now keeps HOME=fake for the failing push, and the stray line was removed).

---

# Mission-control UI pass (2026-09-08, post-2.6.0)

Dashboard advance (chosen direction: mission-control upgrade — keep the
ops-terminal soul, add hierarchy and live state):
- **Status rail** under the ops nav, visible across all views: PLANE (node
  handle + version), APPS (registered/up/down/connect counts), MESH
  (nodes/members), DAEMON (supervising pid or off), with a semantic
  ok/warn/crit/dim dot language (down apps = amber, daemon off = amber,
  plane link lost = red). Refreshes on its own 6 s tick independent of the
  per-view polling.
- **/api/daemon** (server): supervisor state straight from daemon.pid —
  running (live pid), stale (pid file, process gone), or not ensured.
- **/api/apps enrichment**: every row now carries `lastDeploy`
  ({outcome, commit, at} from deploy-history.jsonl via the registry's
  runPath — listAppsData has no runPath, so enrichment resolves it from
  loadRegistry()).
- **Projects table**: new "Last deploy" column (short commit + relative
  time, red on failure); empty state now teaches the onboarding commands
  (gitlive init / git push / connect / list) instead of a bare "none" row.
- control-plane.test.js drives /api/daemon (absent → stale → live pid via a
  real sleeper child) and the lastDeploy enrichment — green; dispatch +
  syntax + marker checks green.

---

# Strategy decisions (2026-09-08) — after the three-scan market reality check

The three-scan market reality check lives in the owner's private archive
— strategy docs never ship). Decisions locked from it:

1. **Verified empty lanes** (no tool of 15+ surveyed does any): per-push
   cryptographic authorization; enforced auditable blue-green; mesh
   failover with conflict ledger; outbound-only NAT relay federation;
   coercion-resistant crypto. These are the product spine, not marketing
   adjectives.
2. **Wedge = the 2025-26 metering/free-tier backlash.** The conversion
   message: "commercial PaaS metered your bill and deprioritized your tier;
   here is deploy infrastructure you control, with receipts." Never market
   as "another PaaS alternative" — that shelf is full (Coolify 61.6k★,
   Dokploy 37.2k★ own it).
3. **Customer (first draft):** post-bill-shock developers/small teams who
   own hardware and have been burned; second wave = EU residency-sensitive
   professionals once the sovereignty story + channels exist. Not the
   mainstream hobbyist (Coolify's turf), not cloud natives.
4. **Friends as channels:** containerized gitlive distributes through the
   Docker-based home-server stores (Unraid templates, CasaOS/ZimaOS +
   Cosmos third-party stores, Tipi) — free reach into "hardware I own"
   people. Coolify-class tools = competitive baseline; Cloudron =
   cautionary tale (closed paid moat); StartOS = spiritual twin, watch it.
5. **Business shape:** thin, local, single-maintainer-sustainable (Dokku
   13y + Piku survive; Porter/Flynn died with hosted control planes).
   Monetization later via optional paid extras — never by becoming the
   chokepoint (that would restate the contradiction).
6. **License: MIT (standing, LICENSE © 2026 Bline)** — adoption-friendly,
   consistent with the Dokku/MIT + Coolify/Apache ecosystem. Revisit only
   if anti-rent-seeking becomes the explicit goal.
7. **Three curves adopted as direction:** (a) receipts/provenance as the
   product spine — every running app answers "who signed what, when, and is
   the running artifact identical" (the AI-agent-deploy era makes this the
   question); (b) media/residency beachhead — film post, clinics, law,
   agencies fleeing US-cloud data gravity (the founder's own media practice
   is the domain knowledge); (c) the flagship demo = the owner's own media
   pipeline deployed by gitlive on owned hardware — proof beats copy.
8. **Open gates (owner actions, not code):** create the public GitHub repo
   and decide the public-phase date; distribution stance today = private
   tarball (Option A) which blocks adoption metrics — the heartbeat and the
   public phase are linked decisions.

---

# The Fabric program (2026-09-08) — beyond the empty lanes

Adversarial self-analysis of gitlive's five verified-empty lanes. Every
lane protects against OUTSIDERS; the shared loophole is the insider — the
compromised owner, the coerced owner, the single machine. The program's
rule: distribute trust, bound time, make loss survivable.

## Lane-by-lane loopholes + advances

1. PER-PUSH SIGNATURES. Holes: a signature proves a KEY signed, not intent;
   stolen key = forge anything; coerced owner signs normally; and the deep
   one — we sign the SOURCE, not what RUNS (deploy-time `npm install`
   fetches an unsigned dependency closure). Advance: signed dependency
   closure (below, slice F1); threshold-signed deploys (N-of-M via the
   existing Shamir primitive) so no single human can be coerced into a
   deploy. Impossible-end: behavioral canaries + post-quantum signatures.
2. ENFORCED BLUE-GREEN. Holes: health check = shallow HTTP 200 (semantically
   broken app passes); the DATA plane isn't blue-green (shared DB — a bad
   migration breaks both slots; code rollback + forward-migrated DB = broken
   rollback); external side effects (emails/webhooks/payments) are never
   rollbackable. Advance: shadow-traffic verification of the new slot,
   migration dry-runs in a data fork, side-effect ledger (outbox) with
   replay/compensation. Impossible-end: manifest-declared invariants that
   the platform reasons over before allowing a swap.
3. MESH FAILOVER + CONFLICT LEDGER. Holes: LWW is data loss by design;
   partitioned-but-alive primary is indistinguishable from dead (split-brain
   is real); two nodes have no majority; a compromised node can lie.
   Advance: relay as EPOCH NOTARY (arbitrates who-wrote-when via signed
   epoch votes, never content — consistent with no-custody); CRDT state for
   collaborative data; every merge a signed commit with both parents (the
   ledger becomes a forensic DAG — nothing deleted, only forked+merged).
4. OUTBOUND-ONLY RELAY. Holes: relay is a new dependency (down/blocked/
   coerced = mute); it sees metadata; discovery is out-of-band; a hostile
   relay can drop mail selectively. Advance: relay SETS with deterministic
   rendezvous (no single relay can silence a pair); signed delivery
   receipts on a public mailbox ledger (dropping relays can be challenged);
   `mesh sync --bundle` — physical transport (USB) as the final fallback
   sync mode, git's native superpower. Impossible-end: onion-lite
   federation — every node a router that only dials out; no single relay
   sees both endpoints.
5. COERCION-RESISTANCE. Holes: duress works only if the adversary accepts
   the shred; decoys must be indistinguishable AND lived-in; dead-man only
   fires on absence — coercion happens while present; the owner is the
   single point under a gun. Advance: LIVING DECOYS (repos make perfect
   fake homes — full fake projects with real history and plausible signed
   activity); chained custody (shares across people/jurisdictions); use-once
   keys with scheduled rotation. Impossible-end: data that never exists
   whole anywhere (below).

## The convergence: the fabric

The endgame shape all five lanes point to: content-addressed signed
deploys, outbound-only onion relays, threshold-signed production, an
epoch-notary arbitration layer, CRDT truth, Shamir-split state across peer
homes, living decoy identities — so that no single machine, person,
company, or state can see, stop, seize, or take anything, because nothing
whole exists anywhere.

> The cloud was many machines you don't own. Coolify is one machine you do.
> The fabric is many machines you and your friends own, none of which alone
> holds anything.

## Buildable slices (scoped, NOT built — roadmap)

### Slice F1 — signed dependency closure (lane 1; the only hole where a
current claim is technically incomplete) — SHIPPED v1 2026-09-09

Status v1: `manifest sign` pins the npm-lockfile closure (sha256 + entry
count) into `run.closure` when a package-lock.json is present (--no-closure
opts out loudly); generated plain + safe + mesh-replica post-receive hooks
gate the checkout through `gitlive _closure-gate` BEFORE install (drift or
missing lockfile aborts the deploy and audits `closure-denied`); pinned
deploys switch `npm install` → `npm ci` (strict, integrity-verified);
successful deploys record the attested closure sha into the deploy receipt.
tests/closure.test.js covers sign-pinning, hook generation, gated deploy +
receipt, drift abort + audit, missing-lockfile abort, legacy pass-through,
and the escape hatch — green. Note: connect-mode (GitHub runner) deploys
still defer the gate (they do not install via the local hook).

Goal: "signed commit" and "running bytes" become the same claim. A deploy
attests the RESOLVED dependency closure, not just the source tree.
- At deploy/sign time: resolve + pin the dependency graph (lockfile +
  per-package content hashes), store the closure digest in the manifest
  (`run.closure`).
- At install time: verify every fetched package against the pinned hashes
  before it touches disk; any drift fails the deploy with a signed record
  (audit event `closure-denied`).
- Deploy record gains the attested closure so "what ran" is queryable
  later (receipts).
- Modes: strict (default for signed apps) + explicit `--unpinned` escape
  hatch logged loudly (legacy).
- Works for Node (npm lockfile → content hashes) first; Python later.
- Tests: closure drift rejection, pinned replay acceptance, escape hatch
  path, audit entries. Battery discipline unchanged.
- Open questions: lockfile-less projects, native builds, monorepos.

### Slice F2 — distributed shares across the mesh (lane 5; first fabric
slice) — SHIPPED v1 2026-09-09

Status v1: `gitlive mesh share [app] [--n --m]` Shamir-splits the local
storage key (which wraps everything at rest and unlocks owner-key
ciphertext) N-of-M and writes ONE share per mesh member home (0600, under
`.gitlive/shares/gl-<nodefp>/`), storing policy (n/m/subject/key sha256/
created/refreshed) at `~/.gitlive/shares/storage-policy.json`. `mesh
unseal [app] [--check]` restores ONLY when the local key is absent —
gathering N surviving member shares, Lagrange-joining, and verifying the
recovered bytes against the policy digest; tampered or mixed sets fail
with an audit `unseal-fail`, and the refusal-to-overwrite guard keeps a
present key sacred. `--refresh` re-splits (new polynomial) and stamps
refreshedAt. Every op is audited (`shares` kind). The keys card + /api/keys
surface the policy (armed/n/m/homes). tests/shares.test.js: split, refusal,
loss restore (byte-identical, digest-verified), refresh, tamper
(no write + audit), discard-and-restore, lost-member tolerance, fresh-home
recovery — green. Honest v1 limits: locally-hosted mesh member homes only
(remote/relay holders + the decoy share-set are the next slice), and the
unseal route deliberately exists so a FORCED local shred is recoverable
later by the owner from their own shares — the coercer still gets nothing
from this machine alone.

Goal: no single machine holds anything whole. Per-app storage key is
Shamir-split N-of-M and the shares live on member nodes + one relay, with
policy; local machine holds at most a threshold-missing subset.
- Extend `crypt split` + mesh: `mesh share <app>` distributes key shares to
  chosen member homes (signed, encrypted per-node) with a policy record
  (M total, N required, refresh interval).
- Restore path: `mesh unseal <app>` gathers N shares from surviving
  members after local loss (recovery story upgrade: recover = unseal).
- Under coercion: release the decoy share-set (ties into living decoys).
- Policy visible in the control plane keys card; audit events on every
  share/unseal/refresh.
- v1 scope: shares of the storage WRAPPING key for owner-key apps
  (ciphertext already at rest on replicas); plain apps untouched.
- Tests: N-of-M restore across fake homes, lost-node tolerance, refresh,
  tamper detection.
- Open questions: share refresh cadence, member churn, relay-as-shareholder
  trust model (relay holds one share max, never content).

## Sequencing note

F1 first: it closes the only place today's claims are technically
incomplete (we attest source, not the executing closure). F2 second: it is
the first real fabric behavior users can feel (an app whose key no single
machine holds). Everything else in this program stays design until those
two land.

---

# Engagement program — stage 1 shipped (2026-09-09): theme engine + command bar

Dashboard turns from watch-only to drive-able. Stage 1 (all client-side,
single file, zero server changes):
- THEME ENGINE: four skins (ops-terminal default · synthwave · light paper ·
  high-contrast) implemented as CSS-token overrides; custom-skin editor with
  nine color tokens applied as live CSS custom properties; theme JSON
  export/import; density (compact/normal/relaxed), animation kill-switch,
  and WebAudio synth blips (no asset files) — all persisted per-browser in
  localStorage (`gitlive.ui.v1`). Custom tokens are removed from the root
  when leaving the custom skin so tints never leak across themes.
- COMMAND BAR (⌘K): fuzzy subsequence matching over views + live app
  commands (open/restart/stop/deploy/rollback from the real registry),
  arrow-key navigation, first-enter-confirm for destructive actions (a warn
  command requires Enter twice — verified that a single pick never executes
  `stop`), executed-command history (last 8), Esc to close. API surface
  exposed as window.gitliveCmd for tests + later stages.
- Verified in a real headless-browser session: theme switch + persistence
  across reload, density/motion toggles, custom tokens applied and
  restored, palette open/query/confirm-flow; control-plane suite green.
- Advanced notes: no fake gamification; sound is off by default and
  synthesized; every viewer configures their own cockpit locally.

---

# Engagement program — stage 2 shipped (2026-09-09): deploy theater

The per-app schematic that turns the blue-green dance into something you can
watch, click, and understand — driven by REAL deploy data, never invented:
- State-machine rail (PUSH → GATE → INSTALL → BOOT → HEALTH → SWAP → LIVE)
  with per-phase pipes that animate during replay; plain apps get a
  single-process variant.
- Pods render live truth: public proxy (online/offline), slot A/B
  (SERVING / idle / BOOTING / draining), straight from status + parsed
  deploy log.
- Every stage is clickable: it explains itself in plain language and shows
  the real matching log line underneath (verified against a live deploy —
  clicking HEALTH surfaced the actual
  "health-checking http://127.0.0.1:35833/health" line).
- Live behavior: when a fresh deploy completes, the theater replays it once
  then settles (with a soft sound blip when sound is enabled); when a
  deploy is IN FLIGHT it animates live and settles on the outcome.
- History scrubber: the ledger (up to 5 entries, incl. closure-pinned
  markers) renders as buttons; clicking one shows the recorded outcome
  honestly — "slot choreography is exact for the latest deploy only".
- Failure truth: failed/aborted deploys mark the failing stage ✕ and say
  "the previous version kept serving. the failure is logged, not hidden."
- Verified in a headless-browser session against a real test app
  (7 stage nodes, 3 pods, 4 history buttons, excerpt + replay flow);
  JS parse checks + control-plane suite green. No server changes.

---

# Engagement program — stage 3 shipped (2026-09-09): practice sandbox

A REAL disposable app — `practice-node`, flagged `sandbox:true` — created
under a throwaway project dir with the full machinery (safe blue-green,
proxy, hooks, closure gate) so it appears in the table, the rail, the
detail view AND the deploy theater. Nothing real can break: destroy removes
the registry entry AND the app's bare repo + run dirs (a stale bare repo
made re-init pushes non-fast-forward — caught live and fixed), plus a boot
sweep cleans crash leftovers.
- Server: `/api/sandbox/init|break|fix|destroy`. init builds the toy app
  (health-checked node server reading version.txt), runs real `gitlive
  init --safe`, pushes v1; break pushes a server that exits before it can
  answer (deploy fails, previous slot keeps serving); fix pushes the good
  code again; destroy + sweep deep-clean entry, bare repo, run dir, proxy.
- Dashboard: ▶ practice button in Projects; the app shows with a
  "practice · disposable" tag; the detail action bar gains ✕ break it /
  ✓ fix it / ✕ destroy (id-guarded against the 4s action-bar re-render).
- Theater honesty: failed deploys now settle with the health stage marked
  ✕ and the message "this deploy failed — the new version never proved
  itself, so the previous one kept serving."
- Verified: battery block (init → healthy → break keeps serving → fix →
  destroy → gone) + full headless UI loop with screenshots (healthy /
  broken / fixed). The first UI destroy miss was a poll/render race on the
  click target, not a logic fault — re-verified clean.

---

# Engagement program — stage 4 (final) shipped (2026-09-09): live cross-linked event ticker

The audit log stops being a list and becomes a living instrument:
- AUTO-REFRESHING ticker while the events view is open (4s, visibility
  guarded): a newly arrived event flashes its row on the next refresh.
- EVERY row is clickable: it opens the EVENT INSPECTOR with a plain-language
  explanation per kind (duress → "the storage key was shredded irreversibly
  — logged on purpose", login-fail → "repeated failures are the
  brute-force signal"), severity-colored dot (crit/warn/ok/dim), and the
  raw signed payload beneath.
- CROSS-LINKS: revive/manifest-denied/closure-denied events resolve their
  app from the payload and offer "open <app> → deploy theater"; key events
  (duress/dead-man/login/keys) offer "keys status"; the payload is never
  guessed — extraction is per-kind and falls back to raw JSON.
- STATUS RAIL gains an AUDIT segment showing the newest event kind +
  relative time (colored by severity); clicking it opens the events view.
- Verified live: 25 real rows rendered; a fresh login-fail fired while the
  view was open flashed on the next auto-refresh; row → inspector →
  context jump all exercised in a headless-browser session with
  screenshots. Battery subset + integrity green.

## Program completion (goal items 1-5 → commits)

1. Theme engine + settings (skins/custom editor/density/motion/sound) —
   50fa4aa (with the ⌘K command bar).
2. Command bar — 50fa4aa (fuzzy palette, two-step destructive confirm,
   history).
3. Deploy theater — 888e0f5 (animated state machine over real deploy
   logs, clickable explainers, history scrubber, honest failure settle).
4. Practice sandbox — 740f575 (disposable real practice-node app,
   break/fix/destroy, boot sweep).
5. Live event ticker — (this stage's commit).

Every stage: client-side single-file (plus additive server endpoints for
sandbox + sandbox flag), existing API preserved, battery green, verified in
real headless-browser sessions, screenshots delivered to the owner. No fake
gamification — the fun is real state, real controls, real feedback.

---

# F1 × F2 synthesis shipped (2026-09-09): owner-signed distribution + attestation tier

F1's discipline (everything security-relevant is owner-signed at the
artifact level) applied to F2's distribution (nothing whole on one
machine):
- SIGNED SHARE SET (format v2): the share policy AND every member share
  file carry the owner manifest key's Ed25519 signature. `mesh unseal`
  verifies in order: policy owner fingerprint against the local key →
  policy signature → each share's signature against the policy's owner
  key → Lagrange join → digest check. A swapped policy (attacker edits
  keySha256/members without the key) is refused before any share is read;
  a forged or pre-signing v1 share is refused with a "re-share to heal"
  message and an audit `unseal-fail`. Migration = `mesh share --refresh`
  (re-signs everything).
- ATTESTATION TIER: after every successful deploy, the generated hooks
  (plain + safe; replicas inherit plain) call `_attest-deploy <app>` —
  the latest receipt (commit/outcome/at/closure sha) plus the signed
  manifest from the run dir fan out to every mesh member home under
  `.gitlive/attest/<app>/`. `gitlive mesh verify <app>` asks the members
  what the owner last ran and reports per member: commit, outcome,
  closure-pinned marker, and owner-signature VALID/INVALID on the
  manifest. Provenance now survives the primary's loss, and tampering
  with any member's copy is flagged, not trusted.
- tests/shares.test.js now runs 11 scenarios (split + refusal + loss
  restore + refresh + tamper-forged refusal + discard-restore + lost-node
  + heal-refresh + fresh-home recovery + policy-swap refusal + forged
  member refusal + attestation fan-out/verify/tamper-flag). Full
  push-touching battery green. Honest v1 boundaries unchanged: locally
  hosted member homes only; relays/remotes + decoys are the next slice.

---

# WORKFLOW.md is canonical (2026-09-09)

[`WORKFLOW.md`](./WORKFLOW.md) is the canonical USER path — "the gitlive
way": materialize → audit → init/sign → push (gates) → theater → operate →
protect → recover/distribute, plus the app contract (start/PORT/health,
env-file secrets) and the SaaS runbook extensions (name, inbound
reachability, second home). DESIGN.md remains the canonical DESIGN truth
(why); WORKFLOW.md is the how-for-everyone. The doc ships in the package
whitelist so installed copies carry it. Owner-only context (strategy,
funding, market scan) is archived privately, never shipped.
Planned executor for P1: `gitlive audit <dir>` — the readiness check as a
real command.

---

# Data Map shipped (2026-09-09): plain-word data awareness over real state

The dashboard gains per-app **Data Map** awareness — a card in the detail
view that says, in plain words, where an app's data lives and how it is
organized, generated ONLY from real disk/sqlite state (never guessed):
- databases discovered under the run dir (*.db/*.sqlite, slots and
  node_modules excluded) with table names + row counts via node:sqlite
  read-only introspection; the shared file-storage area (count + bytes).
- plain-language summary ("1 table holding about 0 rows… lives on
  FadKwia.local at …"), protection posture chips (storage key present /
  wrapped / owner-key policy / key split N-of-M homes), last verified
  deploy (commit, outcome, closure-pinned), and a "show raw truth"
  toggle exposing the full JSON.
- Server: GET /api/apps/<name>/datamap (control-plane.test drives it with
  a real sqlite db: table + rows + file area + protection).
- Live comparison: the map reports a test app's real state — data.db with
  one table showing 0 rows, empty file area, storage key present
  but host-readable, no split. The 0-row finding is REAL state worth
  investigating (where does the app actually keep content?).

The Data Map adds awareness without subtracting depth — the machinery
(signing, closure, mesh, splits, attestation) stays exactly as advanced;
this is its honest reflection layer. Next per roadmap: simple/cockpit
toggle to fold the whole dashboard into the same plain-word front.


---

# License decision (2026-09-09): AGPL-3.0-or-later

Owner decision (pre-public, the cleanest moment): the core moves from MIT
to **AGPL-3.0-or-later** — the standard anti-rent-seeking copyleft: anyone
offering a modified gitlive as a network service must publish their
changes under the same license. Canonical AGPL-3.0 text in LICENSE with a
copyright preamble (© 2026 Bline); SPDX headers on all shipped modules;
package.json license field updated. Rationale recorded in the owner's
private archive.
(strategic baseline, license tradeoff sheet): closes the silent
hosted-clone business, consistent with the ethos, keeps the door open to
EU/NGI grant credibility. Registered trademark remains the name
protection; dual-license for closed embedding may follow later.

---

# Network architecture note (2026-09-09) — the fabric's delivery law

Status: design law, NOT a build. Captures the delivery-reliability model,
its blindspots, and the phased sequence — decided after an adversarial
review that pruned a premature multi-hop/erasure build.

## Vision (the destination, unchanged)

Peers exchange content-addressed, signed objects through outbound-only
mailboxes — "dead-drop git": deploys, state, key shares, receipts, and any
future letter all ride ONE git-native transport. Wide, not deep: one
logical hop to a resilient set of mailboxes, replicated in parallel, never
long fragile chains. Community postal model: relays route letters without
ever opening them.

## The reliability law (already governing F2 shares + attestation)

- Replication: P(at least one of k independent holders survives) =
  1 − (1−p)^k — exponential convergence (k=5 at p=0.95 ⇒ failure ≈3e−7).
- Erasure (Shamir, already in the codebase): split into n fragments,
  threshold m — P = Σ C(n,i)·pⁱ·(1−p)^(n−i), i=m..n (n=7,m=4,p=0.9 ⇒
  ≈0.997). Messages-as-secrets = key-shares math, one abstraction up.
- Handoff rules: ack-before-forward · sender holds until ≥1 (ideally m)
  acks · content-addressed idempotent receive (at-least-once delivery ⇒
  exactly-once EFFECT — true exactly-once is provably impossible async).
- Professional target, never certainty: P ≥ 1−10⁻⁹; real deployments:
  99.9% with retry already beats most home setups.

## Blindspots (accepted, must be revisited before any build)

1. Correlated failure breaks the independence assumption (one power cut,
   one ISP, ONE codebase bug kills every node) — diversity is load-bearing.
2. Acks are messages too; an ack proves receipt, never future retention —
   m-of-n acks before deletion is the only real answer.
3. Fragments multiply metadata (m correlated events across paths) — helps
   against node death, not surveillance.
4. Relays are storage you don't control — quotas, expiry, sender
   accountability are product layers, not protocol lines.
5. Topology centralization: owner-chosen mailbox sets make the owner the
   routing chokepoint; distributed discovery is the unsolved problem every
   such network dies on (Radicle's lesson).
6. Complexity budget: single-maintainer systems die from complexity.
7. Timing: remote members don't exist yet — build the postman when there
   are letters.
8. Framing: multi-hop no-custody networks smell like anonymity networks —
   attracts the scrutiny this project exists to avoid.

## Phased sequence (the honest order)

P0 (done conceptually): reliability law documented; existing F2/attestation
already implements it for keys and receipts.
P1 (next build, scoped below): minimal delivery guarantees on the EXISTING
relay — retries, signed acks, idempotent receive — with deterministic
fault injection tests (kill-before-forward, duplicate delivery).
P1 SHIPPED (2026-09-09): delivery guarantees live on the existing relay —
   content-addressed envelope ids (sha256 of the exact bytes) with mailbox
   dedupe; `from` stamped beside the envelope so receivers know whom to
   ack; persistent outbox (`~/.gitlive/outbox.json`) with
   sender-holds-until-ack; signed `relay-ack` receipts consumed on poll
   (`receipt … confirmed` clears the entry); `relayRetryOutbox` re-routes
   unacked envelopes across the mailbox list. relay.test.js proves:
   byte-identical duplicates deliver once, sender holds until B acks then
   releases, and kill-before-forward (recipient never polls) retains the
   envelope until retry delivers it to another peer which acks it.
P2 (when ≥2 real machines exist): cross-machine smoke over the relay.
P3 (when remote members are real users): object/ref exchange over
mailboxes (dead-drop git v1), then erasure only where measured loss
demands it. Multi-hop routing and distributed discovery remain design
until P3 shows the need.

---

# Experiment scope — P1: delivery guarantees on the existing relay

Goal: measure and guarantee delivery semantics of the CURRENT mailbox
transport before any architectural step. Success = deterministic tests
prove: ack-before-forward, sender-holds-until-ack, idempotent dedupe,
retry across a second mailbox when the first holder dies pre-ack.

Scope (minimal, zero new topology):
- Existing surface: /relay/send (mailPush) + /relay/poll?node= (mailDrain),
  byte-identical signed envelopes; metadata beside the message
  ({queuedAt, message}).
- Additions:
  1. Delivery receipts: poller returns signed ack ids; sender keeps
     envelopes until acks received (persistent outbox per node).
  2. Idempotency: envelope id = sha256(bytes) — poller dedupes; replay is
     harmless (at-least-once semantics made exactly-once-effect).
  3. Retry across holders: when a mailbox dies before ack, the outbox
     re-routes to the next configured mailbox (owner-defined order).
  4. Fault injection in tests: B polls once, dies pre-ack → sender retains
     and retries; duplicate delivery → deduped; ack loss → re-poll safe.
- Explicitly OUT of scope: erasure splitting, routing tables, discovery,
  multi-hop, any new topology. (Blindspot law: complexity only when
  measured loss demands it.)

Hardware precondition for P2 (not this build): a second real machine —
any device the owner controls (second computer, a VPS as their own node,
a friend's box via invite). P2 is a checklist, not code: two real hosts,
one behind NAT-only, relay on a third or on the reachable host, delivery
of a share/receipt envelope both directions, kill tests mid-transfer.

---

# Provenance stem — deploys as owner-signed git refs SHIPPED (2026-09-09)

The git-native half of the committed direction: after every successful
deploy, the generated hooks (plain + safe + replicas) write an
OWNER-SIGNED annotated tag into the app's bare repo —
`refs/tags/gitlive/deploys/<commit>/<n>` — whose message is a structured
receipt: `{predicateType: 'gitlive.deploy/1', predicate: {app, outcome,
commit, closure, at}, owner, ownerSig}` signed with the manifest owner key
(`gitlive _deploy-tag`, owner-signed via the same canonical-JSON scheme as
manifests and shares). Deploy history is now git refs: pushable, loggable,
forkable, machine-verifiable — rollback/recovery map onto ref moves.

`gitlive receipts <app>` lists every deploy tag and verifies each embedded
owner signature against the local owner key (VALID/INVALID), printing
commit, outcome, closure pinning, and timestamp. closure.test.js now
asserts the tag exists in the bare repo after a gated deploy and that
receipts verifies it. Battery subset green (closure, manifest-deploy,
mesh, phase2-e2e, control-plane, dispatch, integrity).

With this slice the provenance story is uniform across the fabric: code =
signed manifests at push; what runs = closure-pinned, receipt-bearing,
attested deploys; history = signed git refs; keys = signed N-of-M shares.
Dashboard surfacing SHIPPED: /api/apps/<name>/datamap now carries
`receipts` (parseDeployTags shared with the CLI), and the data map card
renders the signed deploy history — per-tag chips with commit, outcome,
closure-pinned marker and owner-signature VALID/INVALID — plus a terminal
hint (`gitlive receipts <app>`). NOTE: live apps whose post-receive hooks
predate this slice emit no tags until their hooks are regenerated
(`gitlive hook-regen <app>`) and a new deploy lands; suite + API verified.

# Two-door naming complete (2026-09-10): entry node + graduation SHIPPED

The two-door plan's last pieces. Door one stays "bring your own domain";
door two stays "borrow a label from a zone, then leave it" — and now the
machines behind NAT have their path.

## The entry node (NAT machines reach the public internet)

`gitlive entry serve` on a public machine the owner controls; `gitlive
entry connect <url> --token <t>` on the NAT machine. Design law:

1. **Outbound-only, like the relay.** The home machine never opens a port;
   it dials the entry and long-polls a token-authenticated channel. The
   entry holds a browser request (request bodies buffered, 2 MB cap — the
   one honest buffered hop), the home client serves it against its own
   registry routing and streams the answer back un-buffered.
2. **One routing brain.** Which app answers which name is
   control/name-routing.js, shared with the local gateway — the entry can
   never drift from local routing semantics (domains, zone labels,
   active-slot fallback, the name page, "the app always wins").
3. **Dumb plumbing.** The entry stores a token hash and a domain list —
   no keys, no code, no data. TLS is the owner's own certificate installed
   on the entry (`gitlive entry cert`, SNI); the token rides the same
   channel (honest note: use https when the domain has a cert).
4. **Honest v1 limits.** Request bodies cap at 2 MB (else 413); websockets
   and long-lived streams are not relayed (polling transport); a home
   machine that goes away leaves routes that 502 with a plain message.

## Graduation: borrowed label → own domain, one command

`gitlive domain graduate <app> --domain <your.domain>`: attaches the
domain, makes it canonical (primaryDomain), records the left zone
(graduatedFrom), installs a held certificate, prints the owner's own DNS
record — entry-aware when a connection exists. The borrowed label keeps
answering until the zone operator drops it: the wildcard is theirs,
gitlive never touches another zone's records. A name can be lent, but an
app's address is its owner's.

## Community-zone policy (the two-door social contract, stated)

Zones are a role, not a product: a label is a loan, never a claim (the
app's keys, code, data stay the app owner's); revocation is a fact, so a
zone must be honest about it up front (that honesty is why the label is
never the app's address); the exit is one command and the borrower's
(`domain graduate` must always work — lock-in at the name layer turns a
courtesy into a cage); a zone serves apps and gets nothing back (no
traffic, no data, no metrics — the label resolves to the app's machine or
entry, never to the zone); and gitlive ships the mechanism, never a zone
(WORKFLOW.md "The naming law" carries the full five-point text).
