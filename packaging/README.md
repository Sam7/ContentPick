# Unpublished package candidates

These files are M5.5 package-definition candidates only. They have not been
submitted, accepted, or published. There is no public ContextPick GitHub
Release yet. Every release URL below is a **provisional URL** and must be
checked against the exact immutable public asset before any submission.

## Candidate identity and artifact

| Channel | Tentative identity | Candidate version | Artifact/status |
|---|---|---:|---|
| WinGet | `Sam7.ContextPick` | `0.1.0` | Current local MSVC Windows x64 NSIS EXE; SHA-256 `C6781E0C9393B8D11F924CC57DE595FB75FCD7EEA9670D95D5B9137C43EC52BD` |
| Chocolatey Community | `contextpick` | `0.1.0` | Same local Windows x64 NSIS EXE and SHA-256 |
| Homebrew project tap | `Sam7/homebrew-contextpick` / cask token `contextpick` | `0.1.0` | Temporary macOS x64/arm64 CI DMG hashes recorded in the cask; URLs remain provisional and not publicly downloadable |

Exact-name lookups on 2026-10-09 found no WinGet source result for
`Sam7.ContextPick`, no Chocolatey Community package with ID `contextpick`,
and no official Homebrew cask token `contextpick`. These lookups do not reserve
names or prove there is no unpublished, pending, or differently named entry.
The GitHub owner, package identifiers, publisher/author display name, and tap
name all need final maintainer confirmation before M5.6 submission. Recheck
each registry and its current naming rules immediately before submission.

The current Windows NSIS candidate is
`target/release/bundle/nsis/ContextPick_0.1.0_x64-setup.exe` (4,301,999 bytes;
SHA-256 `C6781E0C9393B8D11F924CC57DE595FB75FCD7EEA9670D95D5B9137C43EC52BD`).
Its local SHA-256 matches the WinGet and Chocolatey definitions. Two full local
release-build/normalization/bundle paths produced identical app and installer
hashes. A standard-user silent install verified all four notice files under
`licenses/`, no root-level `LICENSE`, and complete uninstall/registration
cleanup. The current candidate also passed installed Playwright UI smoke **1/1**
with fresh app settings in the existing Windows profile and its existing
WebView2. Independent clean-profile, missing-runtime/restricted-network, and
upgrade checks remain open.
The WinGet and Chocolatey URLs point at
the expected future GitHub Release asset path, but that release does not
currently exist and the URL has not been downloaded or validated. Do not treat
these definitions as installable packages.

The Homebrew file lives under a project tap because the official cask
repository's current public-interest bar is not met. A project tap is opt-in
and Homebrew treats third-party taps as unsupported code requiring user trust.
The cask records the temporary CI candidate hashes for Apple Silicon
(`b4be90b08eba9c6e8b26b808ab71c43a776943f4c2a9614750ccc661c3f39521`) and Intel
(`38ba1bc6d0d58d5a8a9c1530ddca46f152ed5d01e455048d9a5bbb4aaa09ae58`) from
run `37892810854`. The URLs remain provisional; before submission, publish the
exact tested artifacts and confirm their public bytes still match. Homebrew
audit and clean macOS installation/Gatekeeper checks remain open. Developer ID
signing, notarization, and Gatekeeper acceptance remain release gates; do not
bypass quarantine or advise users to disable Gatekeeper.

## Windows installer behavior

Tauri is configured for NSIS `currentUser` install mode with WebView2
`downloadBootstrapper`. The candidate manifests therefore specify a user-scope
NSIS installer and `/S` for unattended install/uninstall. The installer is
expected to detect the WebView2 runtime and download/provision it when absent;
that network-dependent behavior has not yet been proven on a clean machine.
The package manager does not separately install WebView2. Confirm bootstrapper
behavior, offline/restricted-network failure, silent progress compatibility,
install registration, standard/elevated contexts, upgrade, and uninstall
against actual clean Windows environments before submission. Keep the actual
Windows support floor separate from each repository's verifier OS.

## Local checks and M5.6 prerequisites

On the Windows host used to prepare these candidates, WinGet CLI `v1.29.380`
is installed and `winget validate --manifest
packaging/winget/manifests/s/Sam7/ContextPick/0.1.0` passed. This checks the
local manifest/schema only; it does not install the unpublished candidate.
Chocolatey CLI `2.7.4` was installed in a task-specific user-local test location.
The nuspec declares `admin` because the install script calls the elevation-only
`Install-ChocolateyPackage` helper. `choco pack` produced the `0.1.0` package
(3 validations: 2 passed, 0 errors, 1 pending-reboot warning), 3,146 bytes,
SHA-256 `8C5B3C3C0ED0A053773712EE2BE4CA462D5D41A5C7F7AC457CF12808B44C732C`.
The packaged nuspec and scripts were inspected. The package-manager lifecycle
is not yet tested: this host has a standard-user token, and Tauri's `currentUser`
NSIS registration/uninstall must be tested under Chocolatey elevation, including
whether UAC keeps or switches the account. The GitHub asset URL is unpublished;
M5.5 testing needs a disposable local test package that changes only the
installer URL while retaining the candidate bytes and checksum. Verify the
immutable public URL in M5.6. Ruby and Homebrew are unavailable, so `brew audit`
and clean macOS cask installation remain open. Local packaging checks do not
replace external repository verification.

Before M5.6:

1. Confirm the owner/publisher and reserve or verify each final package ID.
2. Build supported macOS DMGs, record their exact architecture-specific hashes,
   sign/notarize as required, and replace the temporary Homebrew hash policy.
3. Publish only the authorized immutable GitHub Release assets; download each
   URL and verify its bytes against these definitions.
4. Validate/install in independent clean environments, including WebView2
   first-run provisioning, silent upgrade/uninstall, and package-manager paths.
5. Track initial WinGet PR and Chocolatey moderation separately from generated
   candidates; track Homebrew tap use separately from official cask acceptance.
6. Record external verification, acceptance/publication, and clean public-feed
   installation evidence before calling a channel available.

See [distribution requirements](../docs/project/DISTRIBUTION_REQUIREMENTS.md)
for the authoritative acceptance, compatibility, signing, and evidence gates.
