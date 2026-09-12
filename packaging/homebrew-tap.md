# Homebrew tap — publish steps

1. `npm publish` gitlive first (the formula installs the npm tarball).
2. Get the real version + checksum:
   ```bash
   VERSION=$(npm view gitlive version)
   echo $VERSION
   curl -sL "https://registry.npmjs.org/gitlive/-/gitlive-$VERSION.tgz" | shasum -a 256
   ```
3. Fill those into `packaging/gitlive.rb`.
4. Create a repo named `homebrew-gitlive` on GitHub (or any owner:
   `homebrew-<name>`), and put the formula at `Formula/gitlive.rb`.
5. Users install with:
   ```bash
   brew tap <owner>/gitlive
   brew install gitlive
   ```
6. On every release: bump the version + sha256 in the formula and push.

Alternative without a tap repo: `brew install <owner>/gitlive/gitlive` needs the
repo anyway; a plain local install is:
`brew install --formula packaging/gitlive.rb` (after filling sha).
