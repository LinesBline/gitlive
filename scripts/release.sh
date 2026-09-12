#!/bin/bash
# gitlive release automation (item 1): battery → optional version bump →
# pack → publish dry-run → prints the account-side publish steps.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1/4 full battery ==="
fail=0
for t in tests/*.test.js; do
  name=$(basename "$t" .test.js)
  out=$(node "$t" 2>&1 | tail -1)
  printf "  %-24s %s\n" "$name:" "$out"
  case "$out" in *PASSED*) ;; *) fail=1 ;; esac
done
if [ "$fail" = 1 ]; then echo "BATTERY FAILED — aborting release"; exit 1; fi

VERSION=$(node -p "require('./package.json').version")
if [ "${1:-}" != "" ]; then
  NEW=$1
  echo "=== version bump $VERSION → $NEW ==="
  node -e "
    const fs=require('fs');
    const p=JSON.parse(fs.readFileSync('package.json','utf8'));
    p.version='$NEW'; fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
    let g=fs.readFileSync('gitlive.js','utf8');
    g=g.replace(/const VERSION = '[^']+'/, \"const VERSION = '$NEW'\");
    fs.writeFileSync('gitlive.js',g);
  "
  VERSION=$NEW
fi

echo "=== 1b/4 integrity manifest (always ship a fresh one) ==="
node gitlive.js doctor --integrity --write
node gitlive.js doctor --integrity

echo "=== 2/4 pack (version $VERSION) ==="
rm -f gitlive-*.tgz
TARBALL=$(npm pack 2>/dev/null | tail -1)
echo "  → $TARBALL"

echo "=== 3/4 publish dry-run ==="
npm publish --dry-run 2>&1 | grep -E "package size|total files|invalid and removed|warn publish" || true

echo "=== 4/4 publish steps (account-side, you) ==="
cat <<STEPS
  npm whoami
  # browser: npmjs.com → Access Tokens → Granular → All packages →
  #          Read and write → 2FA: Bypass 2FA → copy npm_... token
  npm config set //registry.npmjs.org/:_authToken=npm_YOUR_TOKEN
  npm publish $TARBALL
STEPS
echo "release candidate ready: $TARBALL (version $VERSION)"
