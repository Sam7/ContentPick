cask "contextpick" do
  version "0.1.0"

  # Temporary unsigned candidates from CI run 37932843273. Confirm these
  # hashes against the exact public release assets before submission.
  sha256 arm:   "fcc8b7e4a9052af58eb2c02c9717af3b24cc6f7bc90839d8b697998650de9629",
         intel: "2183e0956578ece5e3d5010f5a964cfe4377799c45f681af8e1b7c1b69279742"

  on_arm do
    url "https://github.com/Sam7/ContentPick/releases/download/v0.1.0/ContextPick_0.1.0_aarch64.dmg"
  end
  on_intel do
    url "https://github.com/Sam7/ContentPick/releases/download/v0.1.0/ContextPick_0.1.0_x64.dmg"
  end

  name "ContextPick"
  desc "Select project files and export context for AI tools"
  homepage "https://github.com/Sam7/ContentPick"

  app "ContextPick.app"
end
