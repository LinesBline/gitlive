# WORKFLOW.md — the gitlive way: from session code to sovereign live

The single path any app takes to live on hardware the owner controls — the
same whether the code was written by hand, by an AI harness session, or by
a team on a deadline. Everything else in gitlive (mesh, shares, the
theater, attestation) exists to make this loop safe, observable, and
recoverable.

## The app contract (gitlive-ready, three lines)

An app is gitlive-ready when it honours three rules — they are what the
gates and the theater can reason about:

1. **Runs from a start command** (`npm start`, `node server.js`, …) with no
   hidden setup beyond what the repo itself declares.
2. **Reads `PORT` from the environment** — never hardcodes it (safe mode
   assigns internal ports per slot).
3. **Answers a health endpoint** (`/health` by default) when it is truly
   ready — not when the process merely started.

Secrets never live in the repo: they go in an `--env-file`, which gitlive
sources at run time and never displays, logs, or tracks.

## The loop

```
    build              ship                verify                live
┌───────────┐   ┌───────────────┐   ┌───────────────┐   ┌──────────────────┐
│ session / │ → │ git push      │ → │ pre-receive:  │ → │ safe slot swap    │
│ folder /  │   │ (git/agent)   │   │ owner sig     │   │ + health check    │
│ repo      │   │               │   │ post-receive: │   │ + closure pinned  │
└───────────┘   └───────────────┘   │ closure gate  │   │ + receipt fanned  │
                                    └───────────────┘   └──────────────────┘
```

## Phases

### P0 — materialize (session code → a folder)

An app that exists only inside a chat/agent session is not yet a project.
Materialize it: write the files into a real folder with a `package.json`
that declares `start` (and `install` when dependencies exist), commit it to
git. This is the only phase an agent cannot skip for you.

Agent-session note: harness sessions can emit the folder directly; treat
the folder as the source of truth from then on — never keep building in a
session without syncing back to the folder.

### P1 — audit (the readiness check)

Before the first deploy, the app should pass a readiness audit:

- stack detected, start command present, install command known
- `PORT` is read from the environment (safe mode will otherwise strand the
  app on the wrong port)
- health endpoint answers `200` when ready
- a lockfile exists when there are dependencies (this is what pins the
  signed closure — F1)
- no secrets or local state are committed; `.gitignore` covers
  `node_modules`, data, env files

(Planned: `gitlive audit <dir>` runs all of this in one command.)

### P2 — initialize & sign (owner intent)

```sh
cd your-project
gitlive init myapp            # or: gitlive init myapp --safe --port 8080 --health /health
gitlive manifest sign         # pins repo content + npm-lockfile closure under YOUR owner key
git commit -am "sign manifest"
```

What this establishes, before any code runs:

- an owner key that is the trust anchor for this app forever
- a manifest that binds: name, run contract, policy, exact git content,
  dependency closure (sha256 of the lockfile)
- push-time enforcement hooks on the bare repo

### P3 — ship (push is the deploy)

```sh
git push myapp main
```

The gates fire in order, and each one can stop the ship without breaking
the served version:

| Gate | Where | Rejects |
|---|---|---|
| owner signature | pre-receive | unsigned code drift, stale signatures (audit: `manifest-denied`) |
| content match | pre-receive | changes outside `.gitlive` since the signed commit |
| closure | post-receive, before install | lockfile drift from the signed closure (audit: `closure-denied`) |
| strict install | post-receive | unpinned dependency fetch — `npm install` becomes `npm ci` when pinned |
| health | safe mode | a new slot that does not answer its health endpoint — the old version keeps serving |

Only a push that passes every gate becomes live.

### P4 — observe (the app is now evidence, not hope)

- **Deploy theater**: watch push → gate → boot → health → swap live, driven
  by the real deploy log; every stage explains itself and shows its log
  lines.
- **Ledger + receipts**: every deploy is recorded with commit, outcome,
  and the attested closure sha.
- **Audit events**: security-relevant moments land in the events log —
  manifest refusals, closure aborts, logins, key actions, daemon revives.
- **Rail**: plane / apps / mesh / daemon / audit at one glance.

### P5 — operate (the boring superpowers)

```sh
gitlive restart myapp     # plain: stop+start · safe: revive the proxy
gitlive rollback myapp    # safe: previous successful commit, health-gated
gitlive daemon ensure     # one detached supervisor: revives crashes only
gitlive logs myapp        # deploy + runtime log
```

Rules of operation: a stopped app stays stopped (no pidfile = intent); a
crashed app is revived (pidfile exists, process gone); connect-mode apps
are launchd/systemd's business, not gitlive's.

### P6 — protect (nothing whole on one machine)

- **At rest**: `gitlive crypt` — AES-256-GCM; Shamir N-of-T split for keys.
- **Owner-key storage policy**: replicas hold ciphertext; restore needs the
  owner key.
- **Distributed key shares (F2)**: `gitlive mesh share [app] [--n --m]`
  splits the storage key N-of-M across member homes — every share and the
  policy are owner-signed; a forged share or swapped policy is refused
  before anything is read.
- **Coercion**: duress passphrase (`!`), dead-man switch, decoy layer —
  irreversible by design, event-logged, with the honest legal framing in
  DESIGN.md.
- **Attestation**: after every successful deploy, the receipt + signed
  manifest fan out to member homes; `gitlive mesh verify <app>` answers
  "what actually ran, owner-verified" from survivors when the primary's
  own history is gone.

### P7 — recover & distribute

- Local key lost or force-shredded? `gitlive mesh unseal [app] [--check]`
  restores from N surviving members, digest-verified.
- Node lost? `gitlive mesh recover <app> [--from <survivor>]` re-replicates.
- Share the app with specific people: invite tokens → join (the owner
  registry) → the app lives at their home too. Private distribution of
  gitlive itself = the tarball + checksum (see DESIGN).

## SaaS and always-on apps — the runbook extensions

The loop above is the same; a public, always-on SaaS adds three explicit
extensions (honest prerequisites, not promises):

1. **A name** — a domain the app answers on. Decide per app; gitlive's
   privacy is not your apps' privacy.
2. **Inbound reachability** — a home machine without public ports uses an
   entry node you control (`gitlive entry`); the relay itself stays an
   outbound mailbox (deploys, control).
3. **A second home** — one machine = daytime uptime; two machines you
   control (mesh) = the honest 99%; the cloud's 99.99% is machines you
   don't control — that trade is the owner's to make, in the open.

## The naming law (apps, domains, accounts)

Owner direction (2026-09-09): apps are NAMED, not numbered. Raw addresses
(localhost, ports) stay out of user-facing copy; localhost-style naming
"takes away from the maker's effort".

**App names.** One name per app: lowercase letters, digits and `-`, derived
from the project folder at `init`, unique per machine and identical across
an owner's own nodes (mesh). The name is the identity everywhere —
dashboard, deploy history, receipts, logs. Local name and public name may
differ: the mapping is user-chosen when a domain attaches.

**Domain layers** (in order of dependence):
1. *Local names (this machine / home network)* — every app answers at
   `<name>.gitlive`, resolved locally (hosts entries) and routed by the
   local gateway (Host header → app). Ports never appear to the user.
2. *Your own domain (public)* — the app answers at `<sub>.<your-domain>`:
   a domain you register, pay for, and control. `gitlive domain public <app>
   --domain <your.domain>` prints the DNS record you publish, routes that
   hostname to the app on your machine, and installs the certificate you hold
   (verified against the domain's SANs). Certificates can also be issued
   automatically (`gitlive domain cert`, ACME DNS-01 — works behind NAT).
   Still yours; gitlive is plumbing.
3. *The entry node (machines behind NAT)* — an app on a machine without a
   public address answers through an entry machine YOU control
   (`gitlive entry serve` there, `gitlive entry connect` here): the home
   machine dials out, the entry relays. The entry is dumb plumbing on your
   own hardware — never a service, never a naming zone.
4. *Borrowed zone labels, then graduation* — a zone (yours or a community's)
   can lend `<app>.<zone>` with one wildcard record; a loaned label is a
   courtesy, not an address. `gitlive domain graduate <app> --domain
   <your.domain>` moves an app to its own domain in one command; the
   borrowed label keeps answering until the zone operator drops it.
5. *No gitlive-operated naming zone.* Not even optionally: a name under a
   zone someone else controls can be revoked by that someone — a single
   point of failure that is a company, which is exactly what this project
   exists against. If hosted naming is ever asked for, the only acceptable
   form is user-hosted mirrors, never a default.

**The community-zone policy** (what a zone IS allowed to be, when someone
other than the app's owner runs one): a zone is a ROLE, not a product and
not a company — it lends labels under one wildcard record. The policy,
stated plainly so both sides know the deal:

1. *A label is a loan, never a claim.* The zone registers and controls its
   own domain; the app's identity, keys, code and data stay the app
   owner's. A zone that pretends otherwise is a naming zone wearing a mask
   — the thing this law exists against.
2. *Revocation is a fact, so honesty about it is a rule.* A zone CAN stop
   resolving a label (that is the whole chokepoint argument) — which is
   exactly why it must say so up front and why the label is never the
   app's address. Borrowing a label is choosing a courtesy, with the exit
   always one command away.
3. *The exit is one command, and it is the borrower's.* `gitlive domain
   graduate` must always work against any zone: nothing a zone does may
   make leaving hard, slow, or paid. Lock-in at the name layer is how a
   courtesy becomes a cage.
4. *Zones serve the apps, not the other way round.* A zone's only job is
   the wildcard record it published. It gets no traffic, no data, no
   metrics from the apps it lends to — the label resolves to the app's own
   machine (or its entry node), not to the zone.
5. *gitlive ships the mechanism, never a zone.* Any zone is run by people —
   an owner, a cooperative, a community — with whatever governance they
   choose. gitlive provides the plumbing and this policy; it never runs,
   recommends, or authenticates a zone.

**Accounts — two layers, deliberately separate.** Operator accounts are
whoever runs gitlive on a machine (dashboard: email + password, scrypt-
hashed, sessions, per-machine, signed by the owner key). End-user
accounts of a deployed app belong to the APP: they live in the app's own
database on the owner's hardware, encryptable with the owner's keys. There
is no central account system — nothing to compromise, leak, or subpoena;
the app's users belong to the app.

## Roles in the loop

- **The app** declares its contract (start, PORT, health) and nothing else.
- **The owner** is the trust anchor: signs, invites, decides policy.
- **The harness/agent** builds and pushes like any other author — the gates
  do not care who wrote the code, only who signed it.
- **gitlive** is the neutral executor: it never guesses intent, never
  overwrites a present key, never claims properties it hasn't earned.

## Why this order matters

Sign before ship (or the gate is theater). Gate before install (or the
closure is fiction). Observe before operate (or you're flying blind).
Protect before you need it (coercion is not scheduled). Attest as you go
(provenance after loss is archaeology). Every phase exists because its
absence was a real failure mode somewhere in the field.
