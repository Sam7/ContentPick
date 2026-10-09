cask "contextpick" do
  version "0.1.0"

  # Candidate only: replace :no_check with each exact DMG SHA-256 before any
  # submission. No macOS DMG has been built or verified in this environment.
  sha256 :no_check

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
