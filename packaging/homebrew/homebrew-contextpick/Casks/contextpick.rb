cask "contextpick" do
  version "0.1.0"

  # Temporary unsigned candidates from CI run 37892810854. Confirm these
  # hashes against the exact public release assets before submission.
  sha256 arm:   "b4be90b08eba9c6e8b26b808ab71c43a776943f4c2a9614750ccc661c3f39521",
         intel: "38ba1bc6d0d58d5a8a9c1530ddca46f152ed5d01e455048d9a5bbb4aaa09ae58"

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
