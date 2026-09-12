# ADR-001: gitlive Backend Layer — Data, Auth, Storage, and App "Fusion"

**Status:** Proposed
**Date:** 2026-09-02
**Deciders:** Bline

## Context

gitlive today (v2.3.2) solves process lifecycle: `git push` → build → health-checked blue-green swap → live, with rollback and deploy history. It does not give an app anywhere to put data, authenticate a user, or store a file. Every app still has to reach for a hosted BaaS (data + auth) and something else for storage, which is exactly the dependency gitlive was built to remove.

The stated goal: gitlive becomes a standalone, functional platform — comparisons drawn are hosted BaaS and edge platforms — with a real backend "body." Future apps should **fuse** with gitlive to get their backend, rather than each app standing up its own Postgres project or S3 bucket.

Constraints carried over from gitlive's existing design, because they should shape this too:
- Single machine, no provisioning/TLS/load balancing (stated limitation, not yet revisited).
- The core CLI is zero-runtime-dependency, Node built-ins only. The one exception so far is `mcp/`, which is its own npm package. Any real deps this layer needs should follow that same pattern — isolated, not bolted onto `gitlive.js` itself.
- "One command, any single repo" — gitlive has deliberately stayed out of Dokku-style multi-app orchestration territory. A backend layer shouldn't quietly turn it into one.
- Bline explicitly rejected being pointed at existing PaaS/BaaS platforms before — the point is understanding and owning this mechanism, not wrapping a hosted BaaS.

## Decision

Two architecturally distinct shapes are possible for "the backend body," and which one gets picked first determines everything downstream (data, auth, storage all live differently depending on the answer). This ADR lays out both, recommends a path, but leaves the actual call to Bline since it changes gitlive's scope.

### The fork: embedded library vs. shared local daemon

**Option A — Embedded library.** `gitlive-client` is just an npm package an app imports. It opens its own SQLite file directly (e.g. `~/.gitlive/data/<app>/app.db`), no separate process, no network hop. Auth and storage are functions in the same library, operating on that same per-app data directory.

| Dimension | Assessment |
|---|---|
| Complexity | Low — no new daemon, no new lifecycle to manage |
| Cost | None — no extra process running |
| Scalability | Fine for one app; no cross-app sharing by construction |
| Team familiarity | High — same shape as any embedded-DB library |
| Fits existing philosophy | Strong — mirrors how deploy history is already just a JSONL file per app |

**Pros:** ships fast, nothing new for `doctor` to diagnose, zero added attack surface, each app's data is trivially isolated and portable (it's just a file).
**Cons:** doesn't give you "log in once, use it everywhere" across apps — that's the part of the hosted-BaaS comparison this option doesn't deliver on. Harder to bolt on realtime/pub-sub later without a bigger rework.

**Option B — Shared local platform daemon.** A new long-running `gitlive-backend` process (managed by launchd/systemd, same pattern already built for the `connect` runner) owns the data layer and exposes a small local API (Unix socket or `localhost` port) that every gitlive app's process talks to. Auth becomes a real shared identity service; storage becomes a service apps call into rather than a directory they read.

| Dimension | Assessment |
|---|---|
| Complexity | Medium-high — new persistent service, new lifecycle, new failure mode |
| Cost | None in dollars, but real: another thing that can be down |
| Scalability | Shared auth/data across apps — the actual "platform" shape |
| Team familiarity | Medium — same launchd/systemd skills already proven on the `connect` runner |
| Fits existing philosophy | Weaker — this is the first genuinely new always-on service gitlive introduces |

**Pros:** this is what actually matches "whole body of git" and "fuse" — one platform, many apps, shared login, central place to back up or inspect everything. Room to grow into realtime later.
**Cons:** a crashed daemon takes every app's backend down with it; it's a second thing (after the `connect` runner) that needs its own health story, ironically the same class of problem `--safe` mode and the health sentinel exist to catch — this would need the same rigor applied to itself.

## Trade-off Analysis

The real trade-off isn't data-store choice — it's timing. Option A is buildable now, in days, using patterns gitlive already has proven (file-per-app state, Node built-ins where possible). Option B is the actual end state the vision describes, but it's a second always-on service, and gitlive's whole design philosophy so far has been "no extra daemons, no orchestration" — Option B walks directly into the thing it avoided.

Recommendation: **build Option A first**, deliberately shaped so it can grow into Option B later without a rewrite — specifically, put the SQLite access, auth functions, and storage functions behind the same interface a future daemon-backed client would implement. That means: ship the fusion story for a single app now, keep the door open to "shared login across apps" once more than one app actually needs it.

## Sub-decisions (assuming Option A ships first)

### Data
- **SQLite per app** (via `node:sqlite`, Node 22+ built-in — stays true to the zero-dependency core, no native compile step) over a shared Postgres instance. A shared Postgres is the more hosted-BaaS-like choice, but it's a new service to install, run, and back up — exactly the kind of thing gitlive replaces, not adds. SQLite file lives at `~/.gitlive/data/<app>/app.db`, WAL mode for concurrent reads during writes.

### Auth
- **gitlive-issued sessions**, backed by the same SQLite file — a `users` table, `node:crypto`'s built-in `scrypt` for password hashing (no bcrypt dependency needed), signed session tokens using a per-app secret already generated the way `--env-file` secrets are today (chmod 600, never displayed by `status`). GitHub OAuth as a lower-effort alternative worth keeping in mind for `connect`-mode apps specifically, since gitlive already assumes a GitHub identity there — but it doesn't help local-mode apps, so it's a complement, not a replacement.

### Storage
- **Local disk directory per app** (`~/.gitlive/data/<app>/storage/`), served through the existing local reverse-proxy pattern already built for blue-green slots — no new networking primitive, just a new route on infrastructure that already exists. An S3-compatible bucket is the more "real platform" answer but reintroduces the external-service dependency this whole effort is meant to avoid; worth a documented escape hatch later, not a v1 requirement.

### The "fuse" mechanism
- A thin `gitlive-client` npm package, the app's only new dependency: `db.query()`, `auth.verify()` / `auth.createSession()`, `storage.put()` / `storage.get()`. Lives as its own package the same way `mcp/` does — isolated dependency footprint, not bolted onto `gitlive.js`. `gitlive init`/`connect` would optionally scaffold the app's `.env` with what the client needs (data dir path, auth secret) the same way `--env-file` already works.

## Consequences

- **Easier:** a new app gets data + auth + storage for free at `gitlive init` time, no separate BaaS project to create, no separate bill.
- **Harder:** cross-app features (single sign-on across two of Bline's apps, one app reading another's data) aren't possible under Option A without a migration to Option B later — this is the real cost of shipping fast.
- **Will need to revisit:** the moment two apps need to share a login or a dataset, that's the trigger to build the Option B daemon — at that point the sub-decisions above (SQLite, scrypt auth, local storage) mostly carry over, just moved behind a socket instead of opened as a local file.
- **New failure mode either way:** a corrupted SQLite file is now a real thing `gitlive doctor` or the health sentinel should probably know how to check for — not scoped in this ADR, worth its own follow-up.

## Action Items

1. [ ] Bline: confirm Option A (embedded library, ship fast) vs. going straight for Option B (shared daemon, matches the vision more literally but bigger scope) — this ADR recommends A but the call is his.
2. [ ] Design `gitlive-client`'s exact API surface (`db`/`auth`/`storage` namespaces) before writing code, so the interface survives the later move to Option B.
3. [ ] Prototype the SQLite + `node:sqlite` path on his Mac specifically — confirm Node 22+ is what's actually installed there (v2.3.0's `date`/`setsid` incidents are a reminder that "works on my machine" assumptions about his exact environment have burned this project before).
4. [ ] Decide whether `gitlive init` gains new flags (e.g. `--with-backend`) or whether the backend is opt-in via a separate `gitlive backend init <name>` command — scope question, not yet decided.
5. [ ] Once shipped, add a "backend" section to `gitlive status` (schema present? last migration? data dir size?) mirroring how deploy history already surfaces there.
