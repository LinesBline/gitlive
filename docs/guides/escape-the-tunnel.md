# Escape the tunnel

**The fear it answers:** you want your app reachable from the internet,
your machine is behind NAT, and the usual answers are a company's tunnel
(tunnel vendors. terms ban streaming your own media; some meter you), or
raw tunnels that know nothing about your apps. gitlive's answer: an
**entry node** — a machine YOU control with a public address, that relays
traffic to your home machine. It holds a token hash and a domain list.
Nothing else.

## The two machines

- **The entry machine** — any always-on box with a public address: a small
  VPS, a friend's router box, anything with ports open.
- **The home machine** — where your apps actually run, behind NAT. It
  dials OUT to the entry; it never opens a port.

## On the entry machine

```bash
gitlive entry serve
```

That prints the exact one-line command for the home machine, including a
token shown **once**. The entry is now listening and holding browser
requests for whatever domains home machines register.

Give the domain an https certificate on the ENTRY machine (the browser
connects there, so the certificate lives there):

```bash
gitlive entry cert myapp.example.com --cert myapp.crt --key myapp.key
```

## On the home machine

```bash
gitlive entry connect https://<entry-address>:8443 --token <the-token>
```

Then attach the domain (point the DNS record at the ENTRY machine's IP,
not the home machine's):

```bash
gitlive domain public myapp --domain myapp.example.com --ip <entry-public-ip>
```

## How you know it worked

- `gitlive entry status` on both machines: the home side says
  `connected`, the entry side lists your domains.
- Open `https://myapp.example.com` from anywhere — the request traveled
  browser → entry → home app → back.
- The app answers even though the home machine has **no open ports**.

## Honest limits

- Requests are buffered up to 2 MB at the entry (one honest buffered
  hop); responses stream un-buffered.
- Websockets and long-lived streams are not relayed (polling transport).
- If the home machine goes away, its routes answer 502 with a plain
  message until it reconnects.
- The token rides the channel — use https on the entry (`entry cert`)
  before treating it as public.

## The philosophy in one line

A tunnel is plumbing. Yours is plumbing you own — the naming zone, the
certificate, the domain, the machines. Nothing here can be revoked by a
company, because no company is in the loop.
