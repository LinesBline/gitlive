# Changelog

## 4.0.1 — what leaves this machine, and in what shape

An audit of every path by which information leaves the plane. Four real leaks
were confirmed with evidence, and each one is now closed by construction rather
than by remembering to be careful.

### Confirmed and fixed
- **The weekly report carried the owner's home layout.** It quoted the helper
  agents' ledger, which stores an app's failure line verbatim — and that line
  was `spawn /Users/<name>/.gitlive/apps/<app>-run/live/…`. A document meant to
  be pasted anywhere published the username, the project folder and the app
  name (14 times, in the sample). The report is now **masked by default**
  (paths → `~`, addresses → `<address>`, e-mails → `<email>`, app and domain
  names → `app-1`, `domain-1`) and says which copy it is at the top;
  `gitlive report --no-redact` prints the full one for the owner's own eyes.
- **The support bundle did the same, plus more.** "Copy this and send it to a
  helper" included `/Users/<name>/Desktop/<private project>`, the machine's
  **public IPv6 address**, every app name and raw event details. Masked by
  default now; a second click within five seconds copies the full one, the
  toast says which one you just put on the clipboard, and the payload itself
  carries `redacted: true|false` with a note.
- **Credentials could reach a ledger, a report or an error message.** An app
  that fails while printing its own environment (a connection string, a token
  in a command line) had that text written into `agent-actions.jsonl` and then
  quoted onward. `control/redact.js` now strips key blocks, `KEY=value`
  assignments whose name says credential, URL userinfo, `Authorization`
  headers, CLI `--token/--password` arguments, query-string credentials, JWTs
  and known key prefixes (`ghp_`, `sk-`, `AKIA`, `xox*`, …) — **before the
  receipt is written**, at the digest source, in every timeline detail, and at
  one central boundary for every error response the plane produces.
- **No content-security policy.** The dashboard is same-origin with inline
  scripts and the session token in `localStorage`, so a single injected string
  would have been a stolen session with nothing standing in the way. Every
  response now carries a CSP (`default-src 'self'`, `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, no third-party
  anything), plus `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy`,
  `Cross-Origin-Resource-Policy` and a `Permissions-Policy` that switches off
  camera, microphone, geolocation, payment and USB.

### Advanced
- **Outbound is switchable.** Two things called out on their own (the npm
  version check and the public-repo check). `GITLIVE_OFFLINE=1` turns them
  off, the version endpoint reports `offline: true` and stops pretending to
  know the registry, and nothing else on the machine calls anywhere except
  where the owner explicitly asks (publishing a name, requesting a
  certificate, joining a mesh).
- **`tests/leak.test.js`** — a ninth-block permanent suite that runs a real
  plane over real HTTP against a fake `$HOME` and pins seven boundaries:
  credentials die in the redactor (and ordinary text survives untouched: clock
  times, versions and loopback are not mangled), the ledger/report/timeline
  carry no credential, the dashboard is served with a CSP and refuses framing,
  the bundle and report are masked by default with an explicit full copy, the
  access log records method + path + status and **never a query string**, error
  responses keep the paths an owner needs while stripping the credentials they
  must never see, `GITLIVE_OFFLINE=1` really stops the call-outs, and **no file
  that npm ships carries a marker of this machine** — the shipped list comes
  from `npm pack --dry-run`, so widening `files` widens the check.

### Deliberate, and now stated
- **Secrets are always stripped; identifiers are masked only in artifacts meant
  to leave the machine.** An error message the owner reads on their own screen
  keeps `/Users/<name>/typo` (they need it to fix the typo); the moment the
  same facts go into a bundle or a report, the path becomes `~`.
- `/api/events` still returns raw audit detail to an authenticated session.
  That is the owner's own machine and the dashboard already redacts app names
  for display in the machine area; masking the API itself would take away the
  detail the owner opened it for.

## 4.0.0 — the plane that knows itself

The number finally matches the product. Everything below shipped after 2.6.2
without a version to show for it, so this release numbers the whole arc and
adds the part that was missing: a machine that MEASURES itself, DETECTS what
its own numbers mean, and EXPLAINS it in the owner's language.

### Intelligence (new: `control/intel.js`)
- **Reliability per app, from the real health series.** Uptime over covered
  time (not over wall-clock), every outage with its duration — including one
  that is still happening, counted up to now — longest outage, MTBF/MTTR,
  transitions and current streak. A gap in the meter (machine asleep, plane
  restarted) is recorded as UNKNOWN time and never as uptime; coverage is
  printed next to every percentage; fewer than five samples refuses to be a
  rate at all. A meter that has gone silent says so: the last reading being
  "down" is history, not a claim about now.
- **A daily roll-up** (`health-daily.jsonl`, one line per day per app) because
  the raw series is pruned at 5,000 lines: 30-day numbers are now possible, and
  they say they are an aggregate.
- **A rule-of-three floor** beside any perfect score: 1,440 clean samples
  cannot prove 100%, so the honest 95% floor (99.8%) is printed with it.
- **Deterministic detectors, with evidence and minimum sample counts:**
  flapping (transitions the machine did NOT cause — deploys and deliberate
  restarts are excluded, so the app is never blamed for our own actions);
  time-of-day clustering (binomial tail, needs 5+ failures and p<0.05, and
  says which window); resource trends (least squares with a significance test —
  a memory leak reports its doubling time, a shrinking disk forecasts the day
  it hits the floor); a failing deploy streak; a stale or never-verified
  backup; certificate expiry with a lead time proportional to the
  certificate's own lifetime (14–30 days, because CA lifetimes are shrinking
  toward 47 days); **the outage that started minutes after a deploy — with the
  commit hash and a rollback action**; and the app a restart could not fix,
  quoting the app's own error line.
- **One 0-100 health score whose factors are always shown.** Every factor
  carries its weight, its raw value and its sample count; a factor with no data
  is EXCLUDED and its weight redistributed, never scored as zero. "Up right
  now" is its own factor, so a good week cannot hide an app that is down this
  minute.
- **A timeline merged from every ledger already on disk** — deploys with their
  outcome and reason, backups, agent actions, jobs, audit events — de-duplicated
  (one deploy = one line even though two ledgers record it), with job start/end
  rows merged and app attribution resolved. Per app on its card; the machine's
  own machinery in the machine area (a project's name belongs in projects).
- **Policies the owner sets, per app:** `off` (hands off) · `watch` (diagnose
  and recommend only) · `repair` (restart, verified), plus maintenance windows
  (midnight-wrapping, day-filtered) and an hourly action limit.
- **Adaptive backoff with escalation:** after a repair that could not be
  verified the wait is 5m → 15m → 1h → 6h with ±10% jitter, cleared by a
  verified repair, by a new deploy, or by six hours of uptime; from the third
  consecutive failure the receipt says a human is needed instead of retrying.
- **Owner intent is recorded.** A stopped app and a crashed app look identical
  on disk, so `gitlive stop` now writes the intent next to the app, the status
  API reports `stoppedByOwner`, and the helper agents hold instead of
  restarting something the owner deliberately turned off.
- **The weekly report** (`gitlive report`, or ⧉ weekly report in the cockpit):
  availability per project, every incident with its duration, deploys, backup
  state, what the helpers did — markdown, with the file each number came from.
  Quoted log lines are sanitized, so an app cannot inject structure into it.

### Two rules the live probe enforced
- **The machine score never prints an app's name** (two-area law): its factor
  details say "1 of 2 app(s) down — the longest for 4h 3m", and the names live
  on the projects board where they belong. The test asserts it.
- **An aggregate that covers a fraction of a window cannot answer the whole
  window:** ten recorded days do not make a 30-day rate, so the roll-up result
  is marked insufficient and the UI prints its note instead of a number.

### Surfaces
- New **Intelligence** section in the machine area: score with its factor
  breakdown, machine findings, the machine timeline with kind filters, and the
  weekly-report button — plus a guide that states the honesty rules outright.
- The projects board carries the findings that name a project, and each app's
  card gained **reliability**, **agent policy** (mode, hourly limit,
  maintenance window) and **its own timeline**.
- CLI: `gitlive intel`, `gitlive report [--days N] [--out file]`,
  `gitlive timeline [app]`, `gitlive policy …`.
- A **what's-new** panel on first open of 4.0: a release this size should not
  be a secret.

### Numbering the rest (what shipped after 2.6.2 without a version)
- **3.0 — the member mesh:** federation protocol, peers/nodes, the entry and
  its outbound relay, storage shares, replication and mesh recovery.
- **3.x — the name office and the front door:** zones, per-zone wildcard ACME,
  publish/graduate, the admission exam and the pool, boot recovery.
- **3.x — the self-sufficient cockpit:** node checkup with one fix per row, the
  per-app diagnose chain with a live DNS read-back, env manager, backups with
  restore drills and a job ledger, schedule, guarded self-update, support
  bundle, in-app guides.
- **3.x — the helper agents:** repair (verified), diagnose, improve.

### 2.6.2-era detail that shipped unnumbered
- `GET /health` without a session, request ids, a rotating access log, a clean
  SIGTERM drain, `gitlive backup state` (secrets excluded by design), restic
  resolution that survives a reboot's PATH, automatic maintenance snapshots,
  webhook replay guard, non-loopback bind refusal, serve.log rotation.
- The dashboard can now **create an app** (＋ new project): a folder picker with
  stack detection that runs the same `gitlive init` the CLI runs and shows its
  output verbatim. Graduating a borrowed label to your own domain was fixed
  (its route was implemented but missing from the action regex, and the
  contract suite was blind to it in two independent ways — both closed).

## 2.6.2 — public launch (npm + GitHub)

### Operability (audited against the Node.js backend references)
- `GET /health` — unauthenticated liveness answering status only.
- Request ids on every response + a rotating access log (never bodies or secrets).
- Graceful SIGTERM/SIGINT drain: timers cleared, in-flight finished, exit 0.
- `gitlive backup state` — the control plane's own memory (registry, session db,
  audit log) with an explicit exclusion list: DNS tokens, key material and the
  backup key never enter a snapshot.

### The self-sufficient cockpit
- Node checkup: the machine checks itself (install link, integrity, apps,
  supervisor, gateway, IPv6, zones, certs, backups, update) — one honest
  fix per row.
- Diagnose chain per app: process → port → health → names → live DNS
  read-back (deSEC), each hop with one fix.
- Env manager: set/delete keys from the app detail; values are written,
  never returned, and a banner tracks the pending restart.
- Backups: run / restic check / restore drills with a job ledger
  (running → done/failed); rollback restores code AND the env its commit
  ran with.
- Naming & certs: deSEC setup wizard, per-zone wildcard ACME, cert
  days-left visibility, DNS write receipts, graduation from the card.
- Scheduled tasks: per-app cron run by the plane's ticker, receipted in
  jobs + events.
- Self-update: semver-honest (never offers a downgrade), changelog modal,
  refuses without a backup, restarts through the boot agent.
- In-app knowledge: every section carries a guide with copyable commands;
  a support bundle button copies machine facts (never secrets).

- First public release: gitlive@2.6.2 on the npm registry and the public
  repo at github.com/LinesBline/gitlive (owner-clean single-commit
  snapshots, AGPL-3.0-or-later). No platform deployment anywhere — npm
  and GitHub only; container-image distribution was deliberately
  dropped, and the product itself keeps zero runtime dependencies.
- Dashboard: the new "Is it all set?" card in Projects checks the three
  public surfaces (npm registry version, GitHub repo visibility + head
  commit, Homebrew formula sha) — owner-driven only, 60s server cache,
  nothing about the machine is sent.
- Marketing/positioning copy no longer names third-party platforms —
  "no platform in the middle" says it without advertising anyone.
- `gitlive serve` no longer crashes on machines without a browser
  (containers, headless boxes): --no-open is actually honored, and a
  missing `open` binary is a no-op instead of a crash.
- Homebrew formula carries the real registry tarball sha.

## Unreleased — helper agents + the last terminal-only step
- A repair is now VERIFIED before it is called done. The restart call returning
  used to be enough to write "done ✓"; a live app whose start command dies
  instantly (missing interpreter, crash on boot) was reported as repaired while
  staying down — observed on the live plane, where a restart "succeeded" and
  the app never came up. The pass now waits for the app to actually answer,
  settles past the spawn (a pidfile appears before a process can die), then
  records `verified` honestly and carries the app's own last error line on the
  receipt (stack frames filtered out), which the agents card shows under the
  row. A restart the agent could not verify also becomes a `cannot-start`
  recommendation quoting that line: the machine says out loud that restarting
  will not fix this one.
- **Helper agents inside the plane** (`control/agents.js`): deterministic, no
  LLM, no network, no keys. *repair* restarts an app that went down (the SAME
  restart the button performs, at most `GITLIVE_AGENT_MAX_ACTIONS` per pass
  with a per-app cooldown so a crash loop is never hammered), *diagnose* runs
  the full hop chain the moment an app flips down and records the reason even
  if nobody was watching, *improve* reads restarts-per-hour, deploy-failure
  streaks, backup age and disk headroom and writes RECOMMENDATIONS only —
  judgement stays with the owner. Every action lands in
  `~/.gitlive/control/agent-actions.jsonl` and in the audit ledger; the
  dashboard has an agents card (status, cadence, ledger, recommendations,
  "run a pass now") and a guide. `GITLIVE_AGENTS=0` switches them off.
- **Create an app from the dashboard.** ＋ new project → pick a folder (a
  read-only picker listing directories, with the stack gitlive detects in
  each) → name, start/install/build commands and port are prefilled from that
  detection → create. The plane shells the SAME `gitlive init` the CLI runs
  with cwd set to the chosen folder and returns its output verbatim, so the
  receipt on screen is the real one; the bare repo, deploy hook, registry row
  and git remote are all created by that one command, never by a second
  implementation. A name collision asks before re-pointing; a refused create
  leaves no repo and no registry row (proven in `tests/create-app.test.js`,
  which drives the real HTTP surface and a real `gitlive init` child).
- Expired dashboard sessions are pruned at boot and hourly (they were only
  deleted when their own token came back, so the live plane had quietly
  collected 23 dead rows). Live sessions are never touched, and the prune is
  receipted in the audit ledger.
- `tests/ui-probe.js` — a dependency-free CDP driver for verifying the REAL
  dashboard in a REAL browser (computed styles, click paths, console errors,
  phone-width layout). It mints a throwaway session row in the plane's own
  database, deletes it on the way out, and prints a JSON verdict, so "it looks
  right in the code" stops being the standard of proof.
- `GET /api/browse` — read-only folder listing for that picker: directories
  only, hidden folders and gitlive's own working folder excluded, per-folder
  stack/`git` hints, behind the session gate.
- **A registered app that has never been pushed now reads "not deployed yet"**
  (violet pill) instead of "offline" — the old wording alarmed the owner about
  an app that was never broken. Same fact on the board: the hero counts
  "awaiting first push" separately from "offline".
- Fixed: **graduating a borrowed label to your own domain 404'd.** The
  `/api/apps/<name>/graduate` action was implemented and wired to the button,
  but missing from the server's app-action route regex. The contract suite
  could not see it either — it only recognised api.call paths whose literal
  began at the quote, so paths BUILT from pieces were invisible, and it read
  route regexes with `/p\.match\([^)]*\)/`, which stops at the first `)` —
  inside `([^/]+)` — so the app-action alternation was never actually checked.
  Both holes are closed: the suite now assembles every quoted fragment of
  every URL expression (interpolations become a placeholder) and requires the
  action segment to resolve, and it fails loudly if the route-regex extraction
  finds no alternation at all.

## Unreleased — verified restores (post-roadmap #7: backups PROVEN to restore)
- `gitlive backup verify [app]` — the restore drill: restores the newest
  snapshot to a throwaway directory, compares every file byte-for-byte
  against the live data (files that only exist in the backup are skipped,
  not judged — live deletions are not backup failures), receipts the
  outcome with real numbers, cleans up, and exits non-zero on any
  mismatch. "VERIFIED — N/N files restore byte-identical" is a claim
  nobody else in self-hosting can print truthfully.
- backup.test.js's stub now snapshots CONTENT at backup time and
  materializes it at restore, so the drill is proven against real
  byte-comparison — including catching a file changed after the snapshot.
- The backup guide gained the verify command and the "how you know it
  worked" line. Battery 36/36.

## Unreleased — the entry streams (post-roadmap #5: no buffering, real uploads)
- Requests WITH a body now stream through the entry un-buffered: the entry
  pauses the browser request, the home machine pulls the body over a
  dedicated outbound connection (`GET /entry/body`), and the bytes pipe
  straight into the local app — the old 2 MB "request too large" cliff is
  gone for uploads (the cap now covers only bodyless control reads).
- SSE passes through progressively with content-type intact (responses
  were already streamed; the suite now PROVES progressive arrival, not
  just content). Websockets remain unsupported — said honestly.
- entry.test.js: a 3 MB POST round-trips with an exact byte count, and an
  SSE stream arrives chunk-by-chunk (timed, not just compared). Battery
  36/36.

## Unreleased — docker blue-green (post-roadmap #4: the last P1 limit closed)
- Compose apps now support `--safe`: each slot is its own compose project
  (`docker compose -p <app>-a|b`), the deploy builds and starts the new
  slot with PORT exported for interpolation, health-checks it, and only
  then swaps live traffic (same host-level proxy as node safe mode) and
  takes the old slot down. Failed health checks roll back: the previous
  slot keeps serving, the deploy is recorded failed.
- `gitlive stop` downs BOTH slot projects + the proxy. Dockerfile-only
  apps keep the honest plain-mode refusal (compose is the path to
  blue-green for containers).
- compose.test.js proves the whole choreography: init --safe contract,
  per-slot projects, health-checked swap to slot B (real servers answer
  the probe — the push runs ASYNC, the acme lesson applied a third time),
  old-slot teardown, stop downs both. Battery 36/36.

## Unreleased — ACME through zones (post-roadmap #6: zero per-app cert work)
- `gitlive domain cert *.zone` — ONE command issues a certificate for
  EVERY app under that zone, using the DNS token stored at
  `gitlive domain zone <zone> --dns-token <t>`: no per-app DNS steps, no
  per-app tokens, works behind NAT (DNS-01). Sequential issuance on
  purpose (ACME rate limits + deterministic challenge records); connect
  apps are skipped; failed domains are reported individually.
- `gitlive domain public` now prints the one-liner hint when the covering
  zone has a token stored.
- acme.test.js: the stub speaks dynamic orders (any domain — including
  the JWS-payload decode the loop needs), and phase 4 proves the zone
  loop end to end (two certs installed, two TXT records created/cleaned,
  connect apps skipped). Battery 36/36.

## Unreleased — health history (post-roadmap #8: the visible meter)
- The control plane now samples every app's health port every minute
  (env-tunable) and appends to the app's health-history.jsonl — pruned to
  7 days / 5000 lines, local only, nothing leaves the machine. `GET
  /api/apps/<name>/health` returns the 24h window (samples, up/down,
  uptime %), the deploy count, and the last backup + last VERIFIED backup
  — all read from the same receipt files everything else uses.
- The app detail view gained a **health history card**: 24h uptime %, the
  probe strip (green = answered, red = did not), deploy count, and the
  verified-backup chip — the visible meter on one screen, never invented.
- control-plane.test.js proves the window math, the verified-backup fact,
  and the LIVE sampler (a real server answers the app's health port while
  the plane runs). Also stabilized the recurring peers-suite re-announce
  flake: the check now polls to stability (a dup is structurally
  impossible — the store is nodeId-keyed and saved before responding;
  a transient read is not a failure). Battery 36/36.

## Unreleased — platform honesty (post-roadmap #2: claims that hold up in public)
- The CA trust step is now per-platform: Keychain on macOS, the system CA
  bundle on Linux (`update-ca-certificates`), and a plain "macOS and
  Linux" answer elsewhere — never a macOS-only command printed on a Linux
  box again.
- `gitlive doctor` reports the platform, with the Windows answer said out
  loud (bash hooks + POSIX process groups; WSL2 with a Linux home is the
  path) instead of hidden in a README footnote.
- README prereqs gained the honest platform paragraph: macOS =
  battery-verified daily driver; Linux = same POSIX paths, solid by
  construction, less daily-driven; Windows = unsupported, WSL2 is the
  path.
- tests/platform.test.js unit-tests all three trust branches + the doctor
  platform line. Battery 37/37.

## Unreleased — GitHub webhook deploys (post-roadmap #9: no Actions runner)
- `gitlive github hook <app> --repo <url> [--secret <s>]` — the repo pokes
  the machine: the control plane's `/api/github/hook?app=<name>` endpoint
  verifies the X-Hub-Signature-256 HMAC (shared secret, mode 600), fetches
  the pushed commit into the app's bare repo, points main at it, and runs
  the SAME post-receive hook a local push would — identical gates,
  receipts, attestations. `list` / `remove` manage the wiring.
- The signature is the only new trust: wrong secret → 403 + audited
  (github-hook-denied), unknown apps → 404, non-main refs → the honest
  rule. The webhook answers 202-style immediately; the deploy log tells
  the story.
- tests/github-hook.test.js: real repo + real control plane — config,
  mode-600 secret, signed push deploys with a receipt, wrong secret
  audited, unknown app, non-main refs. Battery 38/38.

## Unreleased — one dashboard, many machines (post-roadmap #10: the last item)
- The dashboard grew a **Nodes view** (nav + ⌘K): every machine registered
  with the control plane — name, hostname, node id, online/offline LED,
  last seen — computed from REAL heartbeats (`/api/nodes` now carries
  `alive` within two heartbeat windows). The honest seam stays stated:
  identity + liveness today, remote actions are the next transport.
- `gitlive agent list` reports this machine's node record + plane
  reachability over the node-secret channel (no user session needed).
- control-plane.test.js covers alive-after-register, agent list output,
  and the served Nodes view. Also stabilized the peers suite's join/remove
  list checks with the same stability poll as the re-announce fix (the
  flake was a warm-machine timing read, not a product bug). Battery 39/39.

## Unreleased — projects become cards (UI wave #1)
- The projects surface grew app CARDS: name, status LED, mode/domain/mesh
  tags, port, source, last deploy, a 24h uptime chip and a real health
  sparkline (the last 24 samples from the local sampler — same facts the
  detail view uses). A list/cards toggle remembers the choice per browser;
  the table still exists for density lovers; row-flash works in both.
- `/api/apps` rows now carry a cheap `h` summary (24h up% + last samples)
  computed from the same health-history file — nothing computed twice.
- control-plane.test.js covers the h shape + the served grid.

## Unreleased — the theater's moment + the receipt button (UI wave #2)
- The theater pane got its cinematic pass: full-width stage, larger pills,
  and a card glow that follows the moment — mint when the last deploy
  succeeded, amber when replaying history.
- **⧉ copy receipt** in the theater header: `GET /api/apps/<name>/attest`
  returns the SAME SLSA/in-toto DSSE envelope a terminal `gitlive attest`
  produces (same bytes, different transport), straight to the clipboard —
  the demo ends with proof anyone can verify. Honest 404s when there is
  no owner key or no signed receipt yet.
- control-plane.test.js covers the endpoint's honest answers + the served
  button.

## Unreleased — ⌘K becomes the center of power (UI wave #3)
- Every palette item carries its group's icon (view/app/system), recent
  commands rank higher when they match your typing (recency boost on top
  of the fuzzy score), and two new per-app actions: **receipt for <app>**
  (copies the SLSA attestation straight to the clipboard) and
  **health of <app>** (jumps to the 24h meter) — deploy/stop/restart/
  rollback already lived there.
- The copy logic is shared between the theater button and the palette —
  one receipt path, two doors.

## Unreleased — the front door breathes (UI wave #4)
- The auth hero moved: the mark pulses on a slow 4.5s breath, and the
  "Your rules." gradient shimmers across itself on a 7s sweep (light skin
  included). Pure CSS — everything bows to the motion toggle like the
  rest of the system.

## Unreleased — the rail's node pulse (UI wave #5)
- The status rail grew a 24-hour event strip: one bar per hour,
  severity-colored (red/warn/cyan) with opacity by count, hoverable per
  bar — the same real events the inbox shows, bucketed hourly. The rail
  is now a living heartbeat strip, not status text.

## Unreleased — the settings control room (UI wave #6)
- Settings gained a sticky anchor nav (node / naming / protection /
  operations / danger zone / about) with smooth jumps, the destructive
  actions (zone remove, names off, stop supervisor) now ask twice
  ("sure?" for 3s — the two-step pattern, done properly), and the About
  line carries the node key fingerprint with a copy button.

## Unreleased — no blank panes (UI wave #7)
- Every detail tab explains itself when empty: the theater says why it has
  nothing to replay (connect mode or no deploys yet), the data map says
  "this app keeps no data here" (itself a fact) instead of vanishing, and
  the log's empty line became a designed note with the next command.

## Unreleased — the inbox grows up (UI wave #8)
- Notifications now group by kind with counts, filter by severity
  (all / crit / warn / info chips with live counts), and app-scoped events
  deep-link straight to the app's page (falling back to the events view
  when the app isn't local).

## Unreleased — the data map earns its name (UI wave #9)
- Databases render as cards: file name + size in the head, each table with
  its row count as a big display numeral. The file area is now a mini tree
  (real entries from the datamap API — capped at 30, honestly) with
  sizes, and protection stays the badge row. The plain-words promise
  finally looks plain.

## Unreleased — the dashboard survives a phone (UI wave #10)
- One disciplined responsive layer (≤860px): compact header (clock/kbd
  hidden), scrollable nav/rail/tabs, full-width notification drawer and
  toasts, stacking heroes and grids, single-column cards and empty-state
  steps. The whole surface works on a phone without a second code path.

## Unreleased — pre-launch security: the leakage audit, every fix shipped
- **Zero third-party requests:** the Google Fonts CDN is gone — Space
  Grotesk + JetBrains Mono are SELF-HOSTED (bundled variable woff2 in
  control/fonts/, OFL, served same-origin via /fonts/*.woff2). No CDN
  ever sees a dashboard visitor again.
- **No secrets in URLs:** the entry relay token moved from query strings
  to the x-entry-token header (URLs leak into access logs; headers do not).
- **No hostnames in public artifacts:** /api/meta's fallback identity is
  this-machine@self, and the SLSA builder.id uses the mesh handle — the
  attestation no longer embeds the machine hostname.
- **Web hygiene everywhere:** nosniff + no-referrer on all responses, a
  CSP pinning scripts/styles/fonts to the origin + frame-ancestors none +
  X-Frame-Options DENY on the dashboard.
- **Auth abuse slowed + audited:** identical auth error copy (no username
  oracle — already true) plus a 10-fail/10-minute login lockout, audited.
- The full audit with the Browser & Identity Attacks Matrix mapping lives
  in the owner archive (prelaunch-security.md); SECURITY.md now states
  the guarantees. Battery 39/39.

## Unreleased — heartbeat (post-roadmap #3: updates without telemetry)
- `gitlive heartbeat` — an opt-in "is there a newer gitlive?" check: ONE
  registry lookup for a version number, run only when the owner types it
  (or schedules it), nothing automatic, nothing about the machine sent.
  Reports newer/current/ahead-of-published honestly, points at the
  PRIVATE tarball for updates (never the unpublished registry name), and
  prints the optional cron line. Endpoint overridable
  (GITLIVE_HEARTBEAT_URL) for tests and private mirrors.
- tests/heartbeat.test.js: async-spawned against a local stub registry
  (the acme-stall lesson applied — the server lives in the test process),
  covers all three verdicts + the unreachable case + the default URL.
  Battery 36/36.

## Unreleased — onboarding: the first ten minutes (post-roadmap #1)
- `gitlive init` now ends with a guided next-steps block (push → dashboard
  → backup → name) — a stranger's first ten minutes need no docs.
- The dashboard greets new owners with a **Make it yours** checklist card:
  four rows that flip only when the FACT exists — first deploy (receipt),
  a name (attached domain/zone), proven backups (backup receipt), practice
  (sandbox) — with jumps to the right place, dismissal, ⌘K reopen, and
  self-retirement once everything is done. Backed by real state:
  `/api/domains` now carries per-app `backedUp`.
- control-plane.test.js covers the receipt fact + the served welcome card.

## Unreleased — home-server store templates (P7: distribution without ads)
- `packaging/stores/` — installable gitlive for the places "hardware I own"
  people already live: **CasaOS/ZimaOS, Cosmos, Tipi, Unraid** — each a
  containerized control plane (dashboard on :5180, persistent ~/.gitlive)
  written to the store's current spec, plus `packaging/Dockerfile` (the
  image build) and an honest README: ready, NOT yet submitted — the image
  push and the per-store PRs are owner actions, listed in order.
- tests/stores.test.js validates every template stays spec-shaped (JSON
  parses, XML well-formed, compose files reference the image + port +
  volume + restart policy) so a rejected store PR is caught in the battery,
  not by the store maintainer. Battery 35/35.
- (These artifacts live in the public repo snapshot but stay OUT of the
  npm tarball — distribution files, not runtime.)

## Unreleased — the name office (P6: zones become a public face)
- A zone's apex now answers with a **name office** page (served by the
  local gateway): what a zone IS in plain words, the one-command
  graduation, the five-line policy — and a live name check
  (`/.well-known/gitlive/zone-check?name=x`) honestly scoped to THIS
  machine (a stranger can see taken/free without an account). Read-only by
  design: nothing a visitor types writes anything anywhere.
- The app always wins: `<app>.<zone>` keeps routing to the app — the
  office only answers at the bare apex. A non-zone host gets no check.
- domain.test.js covers the office page, taken/free checks, app-wins
  routing, and the 404 for non-zone hosts. Battery 34/34.

## Unreleased — SLSA/in-toto attestation (P4: the credibility wedge)
- `gitlive attest <app> [--output <f>] [--pubkey-out <f>]` — exports the
  newest owner-signed deploy receipt as an **in-toto Statement inside a
  DSSE envelope** (`application/vnd.in-toto+json`), signed with the same
  owner key. A stranger with only the public key can verify what deployed,
  when, from which commit, with which dependency closure — no trust in
  gitlive's storage required. `gitlive attest verify <file> --key <pubkey>`
  checks the DSSE signature AND the statement's self-consistency (subject
  digest covers the predicate); tampering fails loudly.
- Honest boundary stated in SECURITY.md (ships in the package): this is
  DEPLOY provenance (what ran, where, who authorized it), not package
  provenance (who built which binary) — the signed manifest is the other
  half, and the two verify together.
- SECURITY.md — the public security model: trust anchors, a
  signature-means-what table, a ranked threat model (loss → drift →
  compromise → coercion → malicious relay), engineering guarantees (zero
  deps, zero telemetry, battery as proof), reporting.
- tests/attest.test.js: keygen → real commit → signed deploy tag → attest
  → verify with the public key alone → tampered envelope refused → honest
  refusals (no receipts, no owner key). Battery 34/34.

## Unreleased — receipted backups (P2: the portability-trap killer)
- `gitlive backup init` — encrypted restic repo (external binary, like
  openssl — the zero-npm-deps law is untouched) with a mode-600 key file;
  the copy says it out loud: the key IS the backup, offsite is your copy job.
- `gitlive backup <app>` — snapshots the app's data dir + deploy history,
  tagged `gitlive:<app>`, and writes a receipt (backup-history.jsonl) AND
  an audit event — so the dashboard inbox shows backups like any other
  fact. `list` / `check` (restic check — a backup that can't be verified
  is a wish) / `restore <app> [--snapshot --to]` round it out.
- Restore NEVER writes into a live app's data dir (target directory only,
  the message explains the move); no scheduler inside gitlive — the exact
  cron line is printed and cron stays the owner's tool.
- tests/backup.test.js: stub restic, offline — init/key mode, tagged
  snapshot + receipt + audit event, list/check/restore, live-data safety,
  and the three honest errors (unknown app, missing repo, missing restic).
  Battery 33/33.

## Unreleased — docker deploys (P1: inherit the whole ecosystem, no catalog)
- Compose projects and lone Dockerfiles now deploy through the SAME push →
  gate → receipts machinery as Node/Python apps: `gitlive init` auto-detects
  compose.yml (or `--docker` to force; a lone Dockerfile is detected when no
  other stack marker exists), builds on push (`docker compose build --pull` /
  `docker build`), stops containers before checking out new code, exports the
  registered PORT for compose interpolation (`ports: ["${PORT}:3000"]`), and
  maps `EXPOSE` (or `--docker-port`) for Dockerfile mode's run binding.
- Status reads REAL container state (`docker compose ps` / `docker inspect`),
  never a guess; stop/restart drive compose down/up and rm -f/run. No host
  pidfile: docker's own restart policy is the safety net and the daemon
  supervisor leaves docker apps alone. Honest v1 limits, said out loud:
  plain mode only (no blue-green slots yet — the swap has a brief downtime),
  `--safe` is refused for docker with the reason.
- tests/compose.test.js: stub docker, offline — detection, hook contract
  (PORT export), build→up, down-before-up redeploy ordering, real-state
  status, stop/restart, EXPOSE mapping, both honest refusals. Dashboard +
  `gitlive list` mark docker mode.

## Unreleased — Aurora II: the ten-part design pass
- **Detail view became the app's product page**: hero band (big display name,
  domain/mesh/practice chips, actions), then tabs — overview (status +
  kv + deploy ledger), theater (the flagship), data map, log, mesh
  (appears when meshed). Deploying jumps to the theater tab so you watch
  the swap happen.
- **Motion language, one choreography**: drifting aurora, staggered rise-ins
  for heroes and cards, breathing LEDs, and a heartbeat on the status rail —
  every effect bows to the motion toggle.
- **First-class light skin**: different physics (white frost, softer
  shadows, adjusted glows/contrast), not a recolor.
- **⌘K became the center of power**: grouped results, matched letters
  highlighted, per-item kbd hints (⏎⏎ for destructive), history intact.
- **Designed empty states everywhere** (mesh, peers, entry, events): one
  icon, one plain-language line, one command — never a bare "no X yet".
- **Theater flagship pass**: orbiting state halos on the active stage,
  completion bloom, pod ripple — the demo moment looks like one.
- **Notifications center**: a bell with an unread dot fed by the real events
  log (deploy outcomes, audits, protection events), drawer with severity
  dots, seen-state in localStorage — the machine's inbox, nothing invented.
- **Status rail as an instrument**: per-segment plain-language tooltips, a
  live heartbeat, hover glow on live LEDs.
- **Typography craft**: tabular numerals, optical sizing, tuned kickers and
  label case, feature-settings on data rows.
- **Settings became the Control Room**: sectioned with icons and plain-word
  intros, a red Danger Zone (duress/dead-man — read-only by design: shred
  stays a terminal command on purpose), and an About line (version, node,
  AGPL, zero telemetry).
- Integration fixes along the way: entry/settings views + notification
  drawer now properly hidden on the auth screen; deploy ledger got its own
  card in the tab layout. Battery 31/31.

## Unreleased — Aurora: the dashboard redesigned as a product
- The whole dashboard got a design system, not a restyle — "Aurora": a calm,
  precise glass instrument. One token spine (9 core colors + derived
  surfaces via color-mix, so custom skins still work), native type (system
  UI for reading, Space Grotesk for display, JetBrains Mono for data),
  refined aurora background with a whisper dot-grid, quiet glass cards with
  hairline edges, a sticky command-center header (live clock, session chip,
  ⌘K), an SVG icon set for the segmented nav, spring easings, LED pulses and
  staggered rise-ins — everything bows to the motion toggle and density
  settings, all four skins (aurora / synthwave / light paper / high
  contrast) rebuilt on the same spine.
- New homes for missing UI: the **auth screen is now a split front door**
  (brand hero — "Your software. Your hardware. Your rules." — with the
  three honest promises, beside a quiet glass sign-in), the **projects view
  grew a hero** (display headline + live stat chips: online / offline /
  projects / domains / meshed), the **empty state became a three-step
  guide**, and a **footer** carries node identity + version + the one-liner.
- Every JS contract preserved (ids, classes, test-asserted strings, theme
  engine); battery green. Honest limits unchanged: zero telemetry, zero
  external assets beyond the two font files (system fallbacks first-class).

## Unreleased — Settings body: the dashboard is the app's real surface
- Settings is now a FULL VIEW (nav + ⌘K), not a cosmetic drawer — the body
  of the app on the dashboard, every row real state or a real action:
  - **node & control** — node identity, admin account, registration
    open/closed toggle (persisted; `--allow-register` still overrides).
  - **naming & domains** — local names on/off (gateway port, local https,
    the one CA trust step printed for the owner's terminal, the /etc/hosts
    admin block shown inline when admin is needed), local TLS re-issue,
    **zones add/remove with the registrar records printed** — offer names
    across every extension you own (.app .dev .tech .site .online .space
    .store .website …), one wildcard per zone — plus every app's attached
    domains with ★own + graduation history.
  - **protection** — key presence + duress/dead-man chips, jumps to Keys.
  - **operations** — daemon supervisor ensure/stop.
  - **appearance** — the existing skin/density/motion cockpit, folded in.
- New API (session-gated, all executing the SAME gitlive.js logic the CLI
  proves — never a second implementation): `GET /api/domains`,
  `POST /api/domains/local {on|off|tls}`, `POST /api/domains/zone
  {add|remove}`, `POST /api/daemon {ensure|stop}`, `GET /api/settings`,
  `POST /api/settings/registration`. Registration now consults the
  persisted toggle at claim time.
- control-plane.test.js: gateway starts on an explicit port under the fake
  home, CA on demand, zone add/remove + wildcard records + validation,
  registration toggle persistence, daemon ensure/stop — all through the API.

## Unreleased — entry + graduation on the dashboard
- The dashboard now shows the two-door plan: a new **Entry** view (nav +
  ⌘K + status rail) reporting REAL state — is this machine relaying to an
  entry (`client` role: entry url, live pid, routed domains), is it itself
  serving as the entry (`server` role: ports from the server log, connected
  machines + their domains), with the one-line commands under it. Backed by
  `GET /api/entry` (control/server.js, same files entry.js writes — no
  second source of truth).
- Apps now carry their naming facts in the UI: attached domains as a tag in
  the app table, and in the detail view a **domains** row where the app's
  own domain (after `gitlive domain graduate`) is marked ★own with the
  borrowed label it graduated from. `/api/apps` + `/api/apps/<name>` carry
  `domains` / `primaryDomain` / `graduatedFrom` / `graduatedAt`.
- control-plane.test.js: /api/entry states (absent → configured → machines
  + log-parsed port) + domain/graduation enrichment on both app endpoints.

## Unreleased — entry node + graduation (two-door plan complete)
- `gitlive entry serve` — THIS machine becomes the public entry node: the
  owner's own always-on machine with a public address holds browser requests
  for domains served by machines behind NAT. `gitlive entry connect <url>
  --token <t>` on the NAT machine dials OUT (no inbound port at home, ever):
  a token-authenticated long-poll channel carries requests down and answers
  back, responses stream un-buffered (request bodies buffered to a 2 MB cap —
  the one honest limit). Routing follows the registry (attached domains +
  zone labels); the app always wins, API-style apps get the gitlive name
  page, unknown names 404, the bare address is a directory. `entry status /
  list / disconnect / stop` manage both sides; `entry cert <domain>
  --cert --key` installs the owner's certificate on the ENTRY machine
  (SNI-served, https listener appears when certs exist). The entry holds no
  keys and no code — a token hash and a domain list.
- `gitlive domain graduate <app> --domain <your.domain> [--from <zone>]
  [--cert --key]` — an app under a borrowed zone label moves to its OWN
  domain in one command: the domain attaches and becomes canonical
  (primaryDomain), the left zone is recorded (graduatedFrom), the borrowed
  label keeps answering until the zone operator drops it (their wildcard is
  theirs), a held certificate installs, and with an entry connection the DNS
  copy points at the entry machine. Graduated apps show their own domain on
  the name page.
- Fixed the `domain cert` CLI stall (tracked gap): the test drove the CLI
  through spawnSync, which freezes the parent event loop — and the stub
  ACME/DNS servers live in the parent, so the child's first fetch could
  never be answered. The product was never at fault; the suite now spawns
  the CLI asynchronously and phase 2 fully passes (issue + install + key
  mode 600 verified end to end).
- entry.test.js (fake machines, real processes: serve/connect/relay GET +
  POST bodies + streaming, token refusal, zone labels, name page, directory,
  disconnect drops routes) and graduate.test.js (canonical record, conflict
  refusal, entry-aware copy, cert install). Routing now lives in one shared
  module (control/name-routing.js) used by the gateway AND the entry, so
  the two can never drift.

## Unreleased — naming zones + automatic certificates (the two doors)
- `gitlive domain zone <your-domain>` — one wildcard domain names every app:
  `<app>.<zone>` routes automatically (one DNS record, no per-app work).
  Zones are a ROLE, not a monopoly: yours, or a community's. A zone name is a
  borrowed label (the app's identity stays its own keys/machine).
- `gitlive domain cert <domain>` — automatic certificates via ACME DNS-01
  (acme.js, still zero npm deps): works BEHIND NAT, no inbound port needed —
  only the ability to write one TXT record through a DNS API (deSEC ships).
- Zone-covered attaches print no further DNS instructions.
- acme.test.js: real protocol against a stub CA (JWS account, TXT value
  recomputed from the account thumbprint, CSR → CA-signed chain verified,
  record cleanup). KNOWN GAP (tracked, reported by the suite): the
  `domain cert` CLI path stalls as a child process; issue() itself is verified.

## Unreleased — Tier 2: your own public domain, attached through gitlive
- `gitlive domain public <app> --domain <your.domain> [--ip <public-ip>]
  [--cert <file> --key <file>] [--check]` — routes a domain YOU own (and
  registered, and pay for) to the app on your machine: prints the exact DNS
  record, installs the certificate you hold (SAN-verified, mismatch refused),
  serves it over SNI, and verifies end-to-end arrival at
  `/.well-known/gitlive`. `list` / `--remove <domain>` manage attachments.
  gitlive still never runs a naming zone: the name is yours and cannot be
  revoked by this project. Automatic issuance (ACME) and the optional public
  entry node for NAT'd machines are the remaining Tier-2 steps.
- domain.test.js: public routing, owner-certificate TLS verified against a CA,
  wrong-domain certificate refused, detach clean.

## Unreleased — Tier 1 local naming: apps answer at <name>.gitlive
- `gitlive domain local on|off|list` — apps are NAMED, not numbered
  (owner direction: localhost naming takes away from the maker's effort).
  `on` manages hosts entries (surgical, line-based — the user's own hosts
  content survives) and starts a tiny zero-dep routing gateway
  (control/domain-gateway.js) that maps "Host: <name>.gitlive" to the
  app's live port; connect-mode apps never get local names. The bare
  gateway address serves a directory page listing apps by name only.
  Port 80 needs one admin moment; the gateway falls back to 8080 and says
  so. WORKFLOW.md gains "The naming law": app names, the domain layers
  (local → your own domain), and the no-gitlive-zone rule.
- domain.test.js: surgical hosts rewrite (user content survives on/off),
  real routing per name, unknown-name 404, directory page, honest list.

## Unreleased — unified voice: apps are named, not numbered
- `gitlive init` no longer prints a raw-address hint ("Once it's up: curl
  http://localhost:PORT/"). The closing message is name-first and
  dashboard-first: the app appears in the dashboard (`gitlive open`) when
  healthy, and real domain names are the stated next step (attach a domain
  you own; gitlive does the plumbing). Field direction: localhost naming
  takes away from the maker's effort (2026-09-09).

## Unreleased — plain mode honors the PORT contract
- Field finding (scripted stranger walk, 2026-09-09): plain-mode deploys
  never exported PORT — an app following the one-line contract ("reads
  PORT from the environment") came up on its coded fallback port while
  `gitlive init` printed a curl hint for the registered port. A stranger's
  first health check 404'd against a healthy app. Fix: the generated plain
  post-receive hook now exports the app's registered port when it has one
  (same contract safe mode already had), and `gitlive restart`'s plain
  start path does the same so first boot and restart see identical env.
  Apps with no registered port and replica hooks are unchanged.

## Unreleased — hook-regen: upgrade existing apps to the current pipeline
- `gitlive hook-regen <app>` rewrites an EXISTING app's generated hooks from
  the current templates (the hook that runs on the next push is the hook
  written at init time, so older apps deployed fine but silently skipped the
  F1 closure gate, attestation fan-out, and owner-signed deploy tags).
  Nothing runs until the next push; the running app is untouched; the
  previous hook is preserved at hooks/post-receive.previous; `--dry-run`
  shows the change without writing.
- Safe-mode slot ports are read from the live hook's header when the
  registry predates port persistence, and the registry entry is backfilled
  (portA/portB/publicPort/healthPath) so status + dashboard can report them.
- hook-regen.test.js: era-stale plain + safe hooks (reconstructed), backup
  fidelity, idempotence, dry-run, registry backfill, negatives.

## Unreleased — provenance stem: deploys as owner-signed git refs
- After every successful deploy, hooks write an owner-signed annotated tag
  (`refs/tags/gitlive/deploys/<commit>/<n>`) into the app's bare repo — a
  structured receipt (`gitlive.deploy/1`: app/outcome/commit/closure/at +
  owner signature). Deploy history is now signed git refs.
- `gitlive receipts <app>` lists and verifies the deploy tags (owner
  signature VALID/INVALID per tag).
- Dashboard: the data map card shows the signed deploy history — per-tag
  chips (commit · outcome · closure-pinned · sig VALID/INVALID) from
  /api/apps/<name>/datamap `receipts` (shared parser with the CLI).

## Unreleased — P1 relay delivery guarantees
- Envelopes are content-addressed (sha256 id) and the mailbox dedupes
  byte-identical pushes; `/relay/send` accepts `from`; polls return
  `{id, from, message}`.
- Sender-holds-until-ack: `relaySendGuaranteed` persists to
  `~/.gitlive/outbox.json`; receivers auto-ack signed `relay-ack`
  receipts; polling clears the outbox entry ("receipt … confirmed").
- `relayRetryOutbox` re-routes unacked envelopes across the mailbox list
  (kill-before-forward survival).
- relay.test.js: dedupe, hold-until-receipt, retry-to-another-peer.

## Unreleased — license: AGPL-3.0-or-later
- Core re-licensed from MIT to **AGPL-3.0-or-later** (owner decision,
  2026-09-09, pre-public): canonical license text + copyright preamble in
  LICENSE, SPDX headers on every shipped module, package.json updated,
  README license section. Anyone offering a modified gitlive as a network
  service must publish their changes under the same license.

## 2.6.1 — private release (2026-09-09)
Private distribution build for the owner + invited users. Everything since
2.6.0 ships in one artifact:
- Audit log coverage: manifest-denied + login/login-fail events.
- F1 signed dependency closure: manifests pin the npm-lockfile digest;
  generated hooks gate deploys before install (npm ci when pinned;
  closure-denied audits); receipts carry the attested closure.
- Engagement UI program: theme engine (4 skins + custom editor +
  density/motion/sound, persisted), ⌘K command bar with two-step
  destructive confirm, deploy theater over real logs with history
  scrubber + honest failure states, practice sandbox (disposable real
  practice-node app), live cross-linked event ticker.
- F2 distributed shares: storage key Shamir-split N-of-M across member
  homes with owner-signed policy + share files (swap/forge refusal);
  mesh unseal/--check/--refresh; keys-card visibility.
- F1×F2 synthesis: attestation tier — hooks fan deploy receipts + signed
  manifests to members after every success; `mesh verify` reports
  owner-verified provenance per member.
- Battery now 27 suites incl. shares/closure; integrity manifest fresh.

## 2.6.0 — ten-item program shipped (2026-09-09)

## Unreleased — F1×F2 synthesis: owner-signed distribution + attestation tier
- Share policies and every member share file are now owner-signed (manifest key) — swapped policies and forged shares are refused before any data is read; `mesh share --refresh` migrates v1 sets and heals forged members.
- Attestation tier: after every successful deploy, hooks fan the receipt + signed manifest out to member homes (`_attest-deploy`); `gitlive mesh verify <app>` reports what the owner last ran per member with owner-signature verification — provenance survives the primary and tampering is flagged.

## Unreleased — F2 distributed shares (fabric)
- `gitlive mesh share [app] [--n --m]`: the storage key is Shamir-split N-of-M and one share lives on each mesh member home — no single home holds anything whole. `mesh unseal [app] [--check]` restores after local loss/shred from N surviving members, digest-verified against the policy; tampered shares fail loudly and are audited; `--refresh` re-splits. Keys card + /api/keys show the policy. v1: locally-hosted member homes; relay holders + decoy set next.

## Unreleased — F1 signed dependency closure + audit log coverage
- F1 (Fabric program, lane 1): signed manifests now PIN the npm-lockfile closure (`run.closure`, sha256 + entry count). Generated post-receive hooks gate every deploy against it before install (`gitlive _closure-gate`); drift or a missing lockfile aborts with an audit `closure-denied` event; pinned deploys install strictly via `npm ci`; the deploy receipt records the attested closure sha. `manifest sign --no-closure` is the loud escape hatch. Connect-mode deploys defer the gate (roadmap).

## Unreleased — audit log coverage
- `manifest-denied`: every rejected manifest push lands in the events log (app, commit, errors) — accepted pushes stay out (routine).
- `login` / `login-fail`: control-plane logins (success + failure) recorded with email + source.
- Test discipline: hook-side audit events write to the hook process's HOME — rejection tests push under the fake home.

## 2.6.0 — ten-item program shipped (2026-09-09)
- Release automation (item 1): `scripts/release.sh` — full battery → version bump → integrity regen → pack → publish dry-run → prints the account-side publish steps; `npm test` runs it.
- Public-repo prep (item 2): local git history, clean tree, first commits — ready for a public push when the owner says so.
- Key rotation (item 3): `gitlive keys rotate <storage|node|owner>` with re-encryption + signed-handover record (`keys rotations`); old keys shred after handover.
- Per-app owner-key storage policy (item 4): `gitlive mesh deploy --storage owner-key` — replicas hold ciphertext only; restore requires the owner key; control-plane visibility.
- Relay transport (item 5): outbound-only mailbox relay (`gitlive peer relay`) — byte-identical envelopes between peers that never accept inbound connections; `/relay/send` + `/relay/poll`.
- Mesh recovery (item 6): `gitlive mesh recover <app> [--from <node>]` — heartbeat-gap report + re-replication from a surviving node; dead nodes regain newer state.
- Supply-chain verification (item 7): `gitlive doctor --integrity [--write]` — SHA-256 file-hash manifest over the shipped whitelist; regenerated inside every release; coverage guard (test 1b) fails the battery if a shipped module is missing from the package whitelist.
- Audit card (item 8): dashboard ◉ events view over `~/.gitlive/events.log` (duress/dead-man rows flagged) + Keys card shows duress/dead-man/rotation status; `GET /api/events` + extended `GET /api/keys`.
- Owner registry (item 9): accepted `mesh join` announces register the joiner in the owner mesh registry (`mesh.json` `members` — fingerprint + endpoints, kept out of locally-hosted deploy `nodes`); Mesh view + `mesh list` show them; `gitlive mesh rm <name>` cleans a node or member and its peer row.
- Boot supervision v0 (item 10): `gitlive daemon ensure|status|stop` — one detached supervisor per machine that revives crashed proxies/apps (pidfile exists, process gone); stopped apps stay stopped; revives land in the events log.
- Regression suite (field finding): deploy history survives redeploys — generated sync scripts exclude `deploy-history.jsonl`; the suite runs the real sync block.
- Packaging fix: `crypt.js`/`keys.js`/`peer.js`/`daemon.js` were absent from package.json `files` — the tarball would not have loaded them; whitelist extended (26 files ship).
- Battery: 23 disposable suites, all green.

## 2.5.0 — Phase 2 + federation + hardening core (2026-09-08)
- Owner-signed app manifests (`gitlive manifest keygen/sign/verify`) with **push-time enforcement** via pre-receive hook — unsigned code drift is rejected atomically.
- State sync transport: SQLite `VACUUM INTO` snapshots + storage blobs over a member-controlled git bus (`gitlive-backend-core/sync.js`), with synced-at markers and the D2 conflict ledger.
- Mesh deploy: `gitlive mesh add/list/deploy/status` — one push to N nodes, each with its own regenerated hooks and running copy; `--min-nodes` policy enforced.
- Failover: `gitlive mesh promote <app> <node>` + `gitlive mesh sync` — single-writer (primary) model; state follows the primary; split-brain writes are LWW + logged, never silent.
- Control plane (Phase 1): `gitlive serve` — accounts on gitlive-client (dogfooded auth), dashboard with mesh/replica/conflict views, agent connect with node registry.
- Single-instance discipline: `serve` never starts a second instance on a busy port, never opens extra tabs; `gitlive open` opens only when healthy; `~/.gitlive/control.url` is the one address.
- Peer federation (Phase 3 core): `gitlive peer` listener + signed
  announce/hello + peer store; deploy/state-refresh/promote OVER THE WIRE
  (git bundles); owner cross-signing of membership with multi-owner trust
  allowlist (`peer trust`); sticky reboot recovery (`peer resync`).
- Cooperative onboarding (item 6): owner-signed invite tokens
  (`mesh invite / verify-invite / join`) — invited nodes with no owner key
  join over the wire; strict owner-side verification.
- Hardening primitives (Phase 4 core): `gitlive crypt` — AES-256-GCM
  at-rest encryption + Shamir N-of-T key split; owner-key encryption wired
  through the state bus (replicas hold ciphertext; restore requires the key).
- Ops reliability: `gitlive restart` (plain restart + safe-mode proxy
  revival); dashboard proxy-down banner; node identity (`mesh whoami`,
  `set-name`) surfaced in the control plane; version 2.5.0.
- Phase 2 fixes found by the disposable suites: sqlite cold-start busy race, path-length EINVAL in long TMPDIRs, admin-claim race, node-plane auth split, appName path-regex gap.

## 2.4.1 — pre-Phase-2 baseline
- Single-file CLI (init/connect/list/status/logs/stop/rollback/doctor/backend), gitlive-client backend layer, GitHub-repo-as-storage (v2.5 docs), MCP server, control-plane first cut.

## Unreleased — anti-coercion modes (duress slice)
- `gitlive crypt keygen --passphrase` — storage key wrapped (scrypt → AES-GCM, GKW1).
- `gitlive crypt unlock --passphrase <p>` — correct phrase unwraps; a phrase with
  prefix `!` is DURESS: it crypto-shreds the key irreversibly (exit 42, event
  logged) — all encrypted data becomes unrecoverable noise. `gitlive crypt duress --yes`
  shreds unwrapped keys manually. DESIGN.md carries the full anti-coercion design
  (dead-man switch + decoy layer next) and its honest legal/forensic limits.

## Unreleased — dead-man switch + memory + closeout
- `gitlive crypt deadman <arm|tick|check>` — arm with an interval; missing the
  deadline crypto-shreds the storage key (exit 43). Decoy layer designed
  (acceptance in DESIGN.md), relay/rotation/supply-chain/seizure-runbook
  documented as the Phase-4 gate.
