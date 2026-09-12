# Graduate your name

**The fear it answers:** a name someone else controls can be revoked by
that someone — the original chokepoint, just moved to the naming layer.
gitlive's two-door answer: borrow a label from a zone when a domain is
out of reach, and graduate to a domain YOU own with one command the
moment you want out.

## The two doors

1. **Bring your own domain** — you register, you pay, you control. gitlive
   prints the DNS record and does the plumbing.
2. **Borrow a zone label** — a zone (yours, or a community's) lends every
   app a name under one wildcard record. A loan, never an address: the
   exit is one command.

## Borrow (door two)

```bash
gitlive domain zone myzone.app      # on the zone operator's machine
```

Every app on that machine now answers at `<app>.myzone.app` — no per-app
DNS work. Offer names across every extension you own — `.app .dev .tech
.site .online .space .store .website` … — one zone per domain, one
wildcard record each. A zone is a role, not a product: the label resolves
to the app's machine, never to the zone.

## Graduate (the exit)

When you're ready for your own name:

```bash
gitlive domain graduate myapp --domain myapp.example.com [--from myzone.app]
```

One command: the domain attaches, becomes canonical (★own everywhere —
dashboard, name page, settings), the borrowed label keeps answering until
the zone operator drops it, and the record is printed for YOUR registrar.

With a certificate you hold:

```bash
gitlive domain graduate myapp --domain myapp.example.com --cert myapp.crt --key myapp.key
```

Or let gitlive issue it automatically — ACME DNS-01 works even behind NAT:

```bash
gitlive domain cert myapp.example.com
```

## How you know it worked

- `gitlive domain graduate` prints `canonical — graduated`.
- The dashboard shows `myapp.example.com ★own` on the app, and the name
  page says whose name it is.
- The old label still answers (the zone's wildcard is the zone's to
  manage) — nothing broke during the move.

## The policy, in five lines

A label is a loan, never a claim. Revocation is a fact, so honesty about
it is a rule. The exit is one command, and it is the borrower's. Zones
serve the apps, not the other way round. gitlive ships the mechanism,
never a zone.

## The philosophy in one line

A name you can't lose is a name nobody else can take. Borrow kindly,
graduate fast, own always.
