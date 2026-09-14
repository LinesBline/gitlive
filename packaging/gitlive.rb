# gitlive formula — Homebrew tap recipe.
#
# url/SHA256 = the published values for gitlive@4.0.0. The sha256 below is a
# PLACEHOLDER until the 4.0.0 tarball is on the registry — the dashboard's
# "Is it all set?" card reports the formula as stale while it is, on purpose.
# Refresh after each publish:
#   VERSION=$(npm view gitlive version)
#   curl -sL "https://registry.npmjs.org/gitlive/-/gitlive-$VERSION.tgz" | shasum -a 256
# Then publish this formula in your tap repo (see homebrew-tap.md).

class Gitlive < Formula
  desc "git push -> live process on hardware you own — no PaaS, no BaaS"
  homepage "https://github.com/LinesBline/gitlive"
  url "https://registry.npmjs.org/gitlive/-/gitlive-4.0.1.tgz"
  sha256 "REPLACE_WITH_REAL_SHA256"
  license "AGPL-3.0-or-later"
  depends_on "node" => ">=22.5"

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"gitlive.js" => "gitlive"
  end

  test do
    assert_match "gitlive", shell_output("#{bin}/gitlive --version")
  end
end
