'use strict';
// A REAL write/read/delete smoke test against a REAL GitHub repo — the one
// thing github-mode.test.js's in-process fake can't cover, because it needs
// an actual token. Deliberately NOT part of the `*.test.js` sweep the other
// suites match on casually — this one talks to real infrastructure and
// costs real API calls/commits, so it's opt-in and self-skips cleanly when
// no token is configured (never a hard failure just for being run without
// one — that would make it unsafe to include alongside the other tests).
//
// Usage:
//   GITHUB_TOKEN=ghp_xxx GITHUB_OWNER=you GITHUB_REPO=some-throwaway-repo \
//     node tests/live-github-smoke-test.js
//
// Run this on YOUR OWN machine, with YOUR OWN token, against a repo you're
// fine with a handful of test commits landing in (a fresh scratch repo, or
// a fine-grained token scoped to Contents:write on just one repo — never a
// classic token with broad access). This script cleans up everything it
// creates on success; if it fails partway, check the repo's `_gitlive/`
// folder for leftover test files.

const assert = require('node:assert/strict');
const github = require('../gitlive-backend-core/github');

const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = process.env;

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.log('SKIPPED live-github-smoke-test.js — set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO');
  console.log('(GITHUB_BRANCH optional, defaults to "main") to actually run this against a real repo.');
  process.exit(0);
}

const RUN_ID = Date.now().toString(36);
const TEST_EMAIL = `gitlive-smoke-test+${RUN_ID}@example.com`;
const TEST_KEY = `smoke-test/${RUN_ID}.txt`;

(async () => {
  const ctx = github.openApp({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    token: GITHUB_TOKEN,
    branch: GITHUB_BRANCH || 'main',
    dataPrefix: '_gitlive-smoke-test', // separate prefix from real _gitlive/ data, easy to spot and delete by hand if cleanup fails
  });

  console.log(`Running against real repo ${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH || 'main'} ...`);
  console.log(`(every commit this makes is tagged with run id ${RUN_ID} in its message)`);

  let sessionToken = null;
  try {
    const user = await github.auth.createUser(ctx, { email: TEST_EMAIL, password: 'smoke-test-password' });
    assert.equal(user.email, TEST_EMAIL);
    console.log('OK: created a real user via a real commit —', user.id);

    const badLogin = await github.auth.verifyPassword(ctx, { email: TEST_EMAIL, password: 'wrong' });
    assert.equal(badLogin, null);
    const goodLogin = await github.auth.verifyPassword(ctx, { email: TEST_EMAIL, password: 'smoke-test-password' });
    assert.ok(goodLogin);
    console.log('OK: real password hash round-tripped correctly (wrong password rejected, right one accepted)');

    const session = await github.auth.createSession(ctx, goodLogin.id);
    sessionToken = session.token;
    const verified = await github.auth.verifySession(ctx, sessionToken);
    assert.equal(verified.email, TEST_EMAIL);
    console.log('OK: real session created and verified against a real repo file');

    const put = await github.storage.put(ctx, TEST_KEY, Buffer.from('hello from a real gitlive github-mode write'), {
      contentType: 'text/plain',
    });
    assert.equal(put.key, TEST_KEY);
    const got = await github.storage.get(ctx, TEST_KEY);
    assert.equal(got.buffer.toString('utf8'), 'hello from a real gitlive github-mode write');
    console.log('OK: real file stored and read back byte-for-byte from a real commit');

    const listed = await github.storage.list(ctx, 'smoke-test/');
    assert.ok(listed.some((f) => f.key === TEST_KEY));
    console.log('OK: real storage.list found it via the real _gitlive-smoke-test/storage/_index.json');

    const stats = await github.getStats(ctx);
    assert.ok(stats.userCount >= 1 && stats.fileCount >= 1);
    console.log('OK: stats() reflects real repo state —', JSON.stringify(stats));
  } finally {
    // Best-effort cleanup so this doesn't leave permanent clutter in a real
    // repo — logged, not asserted, so a cleanup failure doesn't mask the
    // actual test result above it.
    console.log('Cleaning up test data...');
    try {
      if (sessionToken) await github.auth.revokeSession(ctx, sessionToken);
      await github.storage.delete(ctx, TEST_KEY);
    } catch (err) {
      console.log('cleanup warning (non-fatal):', err.message);
    }
  }

  console.log('\nALL LIVE GITHUB-MODE SMOKE TESTS PASSED — real reads and writes against a real repo confirmed working.');
})().catch((err) => {
  console.error('LIVE SMOKE TEST FAILED:', err);
  process.exitCode = 1;
});
