// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// redact.js — what leaves this machine, and in what shape.
//
// TWO DIFFERENT JOBS, deliberately kept apart:
//
//   redactSecrets()      credentials never survive a trip through a ledger, an
//                        API response, an error message or a report. This runs
//                        on EVERYTHING by default, with no way to switch it off.
//
//   redactIdentifiers()  the machine's identity — home paths, addresses, e-mail
//                        addresses, app and domain names — is masked in the two
//                        artifacts whose entire purpose is to be handed to
//                        somebody else: the support bundle and the weekly
//                        report. The owner can ask for the unmasked version
//                        when reading their own copy, and the artifact says
//                        which one it is.
//
// Why this file exists at all: the plane's own ledgers quoted an app's raw
// error line, that line contained `/Users/<name>/.gitlive/apps/…`, and the
// weekly report — a document meant to be pasted anywhere — carried it out of
// the machine. A self-hosted tool that leaks its owner's filesystem layout and
// public address in its "share this for help" artifacts is not self-hosted in
// any sense that matters.
//
// Everything here is a pure function over strings: no files, no network, no
// configuration, so it can be tested to the character.

// ── 1 · secrets (always applied) ───────────────────────────────────────────
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
// KEY=value / KEY: value where the key name says it is a credential
const SECRET_ASSIGN = /([A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("?)([^\s"',;]{4,})\3/gi;
// scheme://user:password@host
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]{1,64}):([^/\s@]{1,128})@/gi;
// Authorization: Bearer …  /  Basic …
const AUTH_HEADER = /\b(Authorization\s*:\s*)(Bearer|Basic|Token|token)\s+\S+/gi;
// password / token / key on a command line
const CLI_SECRET = /((?:--password|--passwd|--token|--secret|--api-key|--apikey|--auth-token)\s+|=)(\S{6,})/gi;
// query-string credentials
const QUERY_SECRET = /([?&](?:token|key|secret|password|passwd|api_key|apikey|access_token|auth)=)([^&\s"']+)/gi;
// JSON Web Tokens
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
// well-known key prefixes (OpenAI, GitHub, Slack, AWS, Google)
const KNOWN_KEY = /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g;
// gitlive's own credential material
const GITLIVE_SECRET = /\b(?:GKW1|GLSK)[A-Za-z0-9+/=_-]{20,}\b/g;

function redactSecrets(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(PRIVATE_KEY_BLOCK, '[private key redacted]');
  s = s.replace(SECRET_ASSIGN, (m, key, sep, q, val) => `${key}${sep}${q}[redacted]${q}`);
  s = s.replace(URL_CREDENTIALS, (m, scheme, user) => `${scheme}${user}:[redacted]@`);
  s = s.replace(AUTH_HEADER, (m, head, kind) => `${head}${kind} [redacted]`);
  s = s.replace(CLI_SECRET, (m, head, val) => `${head}[redacted]`);
  s = s.replace(QUERY_SECRET, (m, head) => `${head}[redacted]`);
  s = s.replace(JWT, '[jwt redacted]');
  s = s.replace(KNOWN_KEY, '[key redacted]');
  s = s.replace(GITLIVE_SECRET, '[gitlive secret redacted]');
  return s;
}

// ── 2 · identifiers (shareable artifacts only) ─────────────────────────────
// Masking is deliberately conservative: it must never mangle ordinary prose,
// versions ("1.2.3"), clock times ("12:30:45") or loopback.
const HOME_PATH = /\/(?:Users|home)\/[^/\s"'`,;)]+/g;
const WIN_HOME_PATH = /[A-Za-z]:\\Users\\[^\\\s"'`,;)]+/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// IPv6: at least three colons AND at least one hex letter in a group, so
// "12:30:45" and "1:2:3" survive
const IPV6 = /\b(?=[0-9a-fA-F:]{6,39}\b)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{1,4}\b/g;
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

function looksLikeV6(text) {
  if (!text.includes(':')) return false;
  if ((text.match(/:/g) || []).length < 3) return false;      // not an address
  return /[a-fA-F]/.test(text.replace(/:/g, ''));              // has a hex letter or is all digits
}

// `names` = the app/domain names this machine knows. They are replaced with
// stable placeholders so a report still reads sensibly ("app-1 is down") while
// naming nothing.
// `home` is the machine's actual home directory: wherever it lives (a real
// /Users/<name>, /home/<name>, or a temporary directory in a test), paths under
// it become `~`. Pattern-matching "looks like a home path" is not enough — the
// identifier is the specific directory this machine runs from.
function redactIdentifiers(input, { names = [], maskDomains = null, home = null } = {}) {
  let s = String(input == null ? '' : input);
  const map = new Map();
  if (home && typeof home === 'string' && home !== '/' && home.length > 3) {
    s = s.split(home).join('~');
    // The home prefix alone still names the owner's projects
    // (`~/Desktop/<private project>/…`), so everything deeper than the FIRST
    // directory under home is collapsed. Segments may contain spaces, so the
    // match runs to a delimiter that cannot be part of a path in prose, JSON
    // or a shell line — not to whitespace.
    s = s.replace(/~(?:\/[^/"',;)\]|>\n]+)+/g, (m) => {
      const parts = m.split('/');
      return parts.length > 2 ? `~/${parts[1]}/…` : m;
    });
  }
  const placeholder = (kind, value) => {
    const key = kind + ':' + value;
    if (!map.has(key)) map.set(key, kind + '-' + (map.size + 1));
    return map.get(key);
  };
  // longest first: a name that contains another must not be half-replaced
  for (const n of [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    s = s.split(n).join(placeholder('app', n));
  }
  for (const d of [...new Set(maskDomains || [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
    s = s.split(d).join(placeholder('domain', d));
  }
  s = s.replace(HOME_PATH, '~');
  s = s.replace(WIN_HOME_PATH, '~');
  s = s.replace(EMAIL, '<email>');
  s = s.replace(IPV6, (m) => (looksLikeV6(m) ? '<address>' : m));
  s = s.replace(IPV4, (m) => (m === '127.0.0.1' || m === '0.0.0.0' ? m : '<address>'));
  return s;
}

// the two combined, for anything that leaves the machine
function shareable(input, opts = {}) {
  return redactIdentifiers(redactSecrets(input), opts);
}

// deep, for JSON artifacts: every string field goes through the redactor,
// object KEYS are left alone (they are ours, not the app's)
function shareableDeep(value, opts = {}) {
  if (typeof value === 'string') return shareable(value, opts);
  if (Array.isArray(value)) return value.map((v) => shareableDeep(v, opts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shareableDeep(v, opts);
    return out;
  }
  return value;
}

module.exports = {
  redactSecrets, redactIdentifiers, shareable, shareableDeep,
  PATTERNS: { HOME_PATH, EMAIL, IPV6, IPV4, JWT },
};
