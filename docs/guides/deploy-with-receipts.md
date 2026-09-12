# Deploy with receipts

**The fear it answers:** platforms meter you on axes you can't see, and
when something breaks you can't prove what was running. gitlive's answer:
every deploy is authorized by YOUR key at push time, and every deploy
leaves a receipt — signed, queryable, verifiable by a stranger holding
only your public key. A meter you can see, on hardware that bills you
nothing per request.

## The flow

```bash
cd your-project
gitlive manifest keygen        # once — your owner key (guard it, mode 600)
gitlive init myapp --port 3000 # registers the app, writes the gates
gitlive manifest sign          # sign the app manifest (code + dependency closure)
git push myapp main            # the push IS the deploy
```

What happens at that push, in order:

1. **pre-receive gate** — the tip commit's manifest must be signed by your
   owner key and match the pushed content. Unsigned drift is rejected
   before anything runs, and the refusal is audited.
2. **closure gate** — if the manifest pins your lockfile, the checkout
   must match it before install (drift aborts with a logged reason).
3. **deploy** — plain or safe (blue-green, health-checked swap).
4. **receipts** — the deploy is recorded as an OWNER-SIGNED git tag
   (`refs/tags/gitlive/deploys/<commit>/<n>`) plus the deploy history.

## Read the receipts

```bash
gitlive receipts myapp          # list + verify every deploy tag
gitlive attest myapp --output provenance.json --pubkey-out owner.pub
gitlive attest verify provenance.json --key owner.pub
```

The attestation is an in-toto Statement in a DSSE envelope — the standard
the supply-chain world verifies. Give `provenance.json` + `owner.pub` to
anyone who asks "what exactly is running there?"

## How you know it worked

- `git push` rejected a commit you didn't sign → the gate is real.
- `gitlive receipts myapp` shows VALID for the owner signature.
- `gitlive attest verify` prints `signature: VALID · self-consistent` with
  the commit, outcome, and closure.

## Honest limits

- This is **deploy provenance** (what ran, where, who authorized it) —
  not package provenance (who built which binary). The signed manifest is
  the other half; the two verify together.
- The owner key is the whole trust anchor. Guard it like the root it is.
- Receipts prove history, not that a machine was never compromised after
  signing.

## The philosophy in one line

A bill you can't see is how platforms surprise you. A receipt you can
verify is how you prove what your own machine did — to yourself, to a
partner, to an auditor.
