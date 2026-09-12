# gitlive formula — Homebrew tap recipe.
#
# url/SHA256 = the real published values for gitlive@2.6.2 (2026-09-10).
# Refresh after each publish:
#   VERSION=$(npm view gitlive version)
#   curl -sL "https://registry.npmjs.org/gitlive/-/gitlive-$VERSION.tgz" | shasum -a 256
# Then publish this formula in your tap repo (see homebrew-tap.md).

class Gitlive < Formula
  desc "git push -> live process on hardware you own — no PaaS, no BaaS"
  homepage "https://github.com/LinesBline/gitlive"
  url "https://registry.npmjs.org/gitlive/-/gitlive-2.6.2.tgz"
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
