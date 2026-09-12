# Two homes, one mesh

**The fear it answers:** one machine is daytime uptime. A dead disk, a
stolen laptop, a sleeping box — and the app is gone. gitlive's answer: a
mesh of machines YOU own, where state follows the deploy, writes are
logged with conflicts instead of silently lost, and a survivor can
restore a fallen node.

## The flow

On machine B (your second home):

```bash
gitlive mesh join <token> <your-peer-url>   # minted on A: gitlive mesh invite
```

On machine A:

```bash
gitlive mesh add peer-b --home <path-to-Bs-home> --start "PORT=3001 node server.js"
gitlive mesh deploy myapp --min-nodes 2
```

One push now lands on both machines. State travels over a git bus; every
write is LWW with a **conflict ledger** — conflicts are logged, never
silent.

## When a machine dies

```bash
gitlive mesh status myapp          # the roster: who is up, who is down
gitlive mesh recover myapp         # run FROM the survivor's home
```

Recovery reports the roster, picks the alive survivor holding the newest
state, and restores the fallen node. After recovery, promote the source
so the mesh has a primary again.

## Keys across the mesh

```bash
gitlive mesh share myapp --n 2 --m 3      # split the storage key, one share per member
gitlive mesh unseal --check               # verify the shares can restore it
```

Replicas hold ciphertext only; the owner's shares are signed, so a
swapped or forged share is refused before anything is read.

## How you know it worked

- `gitlive mesh status myapp` lists both nodes with their commits.
- Kill machine A. B keeps serving. `gitlive mesh recover myapp` from B
  brings A back with the newer state.
- The dashboard's Mesh view shows members and replicas; the conflict
  ledger is visible per app.

## Honest limits

- Two machines you control are the honest 99% — not the cloud's 99.99%,
  which is machines you DON'T control. That trade is yours, in the open.
- The mesh is owner-run plumbing: no directory, no company, no arbiter —
  which means YOU supervise it (the daemon helps: `gitlive daemon ensure`).

## The philosophy in one line

The cloud's uptime is other people's machines. The mesh's uptime is
yours — worse by a decimal point, better by an order of trust.
