# GitHub preview and package candidates

The unsigned Windows x64 preview `v0.1.0` is public on GitHub. The initial
WinGet submission is open as [PR #449871](https://github.com/microsoft/winget-pkgs/pull/449871)
and awaits Microsoft review; it is not accepted or available from the WinGet
source. Chocolatey and Homebrew definitions remain unsubmitted candidates. The
final `0.9` release remains gated by the roadmap.

## Candidate identity and artifact

| Channel | Tentative identity | Candidate version | Artifact/status |
|---|---|---:|---|
| WinGet | `Sam7.ContextPick` | `0.1.0` | Initial PR [#449871](https://github.com/microsoft/winget-pkgs/pull/449871) open; review/acceptance and public-feed installation pending; SHA-256 `A372927F82057D62219A0EA6EE487F9FA282D2E7BDA90DA66566CAE7BCE7B6F9` |
| Chocolatey Community | `contextpick` | `0.1.0` | Same public preview asset and SHA-256; package not submitted |
| Homebrew project tap | `Sam7/homebrew-contextpick` / cask token `contextpick` | `0.1.0` | Temporary macOS x64/arm64 CI DMG hashes recorded in the cask; URLs remain provisional and not publicly downloadable |

Exact-name lookups on 2026-10-09 found no WinGet source result for
`Sam7.ContextPick`, no Chocolatey Community package with ID `contextpick`,
and no official Homebrew cask token `contextpick`. The WinGet initial PR was
submitted on 2026-10-10 and remains open; the lookup does not reserve names or
prove there is no unpublished, pending, or differently named entry.
The GitHub owner, package identifiers, publisher/author display name, and tap
name all need final maintainer confirmation before M5.6 submission. Recheck
each registry and its current naming rules immediately before submission.

The public Windows NSIS preview is 4,310,356 bytes. Its permanent asset and
checksum sidecar are [on GitHub](https://github.com/Sam7/ContentPick/releases/tag/v0.1.0),
and the public bytes were downloaded and matched to SHA-256
`A372927F82057D62219A0EA6EE487F9FA282D2E7BDA90DA66566CAE7BCE7B6F9`.
Earlier local standard-user installation and UI smoke evidence remains valid
for the current app source, but is not evidence that this exact CI-built binary
passed that smoke. In run `38007562399`, fresh Windows Server 2025 silent install,
registration, install location and notices passed; the installed Playwright
smoke timed out waiting for WebView2's loopback debugging endpoint, so app
interaction and uninstall were not verified. The runner already had WebView2
Runtime `153.0.4234.48`. See the [active M5.5 plan](../docs/plans/active-m55.md).

The Windows x64 output from temporary CI run `37932843273` has a different
SHA-256 (`5dbe4c973fbe9658cc0d42584ff0a8fafe501e6532169beae50875ae7a4c0b39`)
from this locally tested installer. It is build evidence only and is not the
installer currently referenced by the local WinGet and Chocolatey definitions.

The WinGet and Chocolatey URLs resolve to the immutable preview asset and the
installer SHA-256 now matches it. This verifies the download candidate only,
not an install through either package manager or channel acceptance. The
WinGet PR passed `winget validate` and repository checks 01–06 plus CLA;
installer scan is running and installation/metadata validations remain queued.
Repository review is still required. No install through the accepted WinGet
source has been demonstrated.

The Homebrew file lives under a project tap because the official cask
repository's current public-interest bar is not met. A project tap is opt-in
and Homebrew treats third-party taps as unsupported code requiring user trust.
The cask records the temporary CI candidate hashes from run `37932843273` for
Apple Silicon (`fcc8b7e4a9052af58eb2c02c9717af3b24cc6f7bc90839d8b697998650de9629`)
and Intel (`2183e0956578ece5e3d5010f5a964cfe4377799c45f681af8e1b7c1b69279742`).
The URLs remain provisional; before submission, publish the
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
is installed. `winget validate --manifest
packaging/winget/manifests/s/Sam7/ContextPick/0.1.0` passed, and the manifest
now points to the public asset with its verified SHA-256. A local WinGet install
was not run: this profile has existing ContextPick settings and a remembered
NSIS install path, and the smoke guard refuses to disturb them. The initial
registration was submitted as [PR #449871](https://github.com/microsoft/winget-pkgs/pull/449871)
with that limitation disclosed. At the latest check, validation steps 01–06
passed, installer scan was running, and steps 08–10 were queued. Review and
installation from the accepted source remain pending; the hosted installed-app
smoke failed at WebView2 debug-endpoint attachment.
Chocolatey CLI `2.7.4` was installed in a task-specific user-local test location.
The nuspec declares `admin` because the install script calls the elevation-only
`Install-ChocolateyPackage` helper. `choco pack` produced the `0.1.0` package
(3 validations: 2 passed, 0 errors, 1 pending-reboot warning), 3,146 bytes,
SHA-256 `8C5B3C3C0ED0A053773712EE2BE4CA462D5D41A5C7F7AC457CF12808B44C732C`.
The packaged nuspec and scripts were inspected. The package-manager lifecycle
is not tested or submitted: the current host has no disposable elevated
installation environment, and Chocolatey submission requires an API key.
Given the failed hosted installed-app smoke, further Chocolatey effort is
deferred until the Windows lifecycle gate is repaired. Ruby and
Homebrew are unavailable, so `brew audit`
and clean macOS cask installation remain open. Local packaging checks do not
replace external repository verification.

Before M5.6:

1. Confirm the owner/publisher and reserve or verify each final package ID.
2. Build supported macOS DMGs, record their exact architecture-specific hashes,
   sign/notarize as required, and replace the temporary Homebrew hash policy.
3. Publish the final authorized `0.9` assets; the `0.1.0` Windows preview is
   already public and its URL/hash are verified above.
4. Validate/install in independent clean environments, including WebView2
   first-run provisioning, silent upgrade/uninstall, and package-manager paths.
5. Track initial WinGet PR and Chocolatey moderation separately from generated
   candidates; track Homebrew tap use separately from official cask acceptance.
6. Record external verification, acceptance/publication, and clean public-feed
   installation evidence before calling a channel available.

See [distribution requirements](../docs/project/DISTRIBUTION_REQUIREMENTS.md)
for the authoritative acceptance, compatibility, signing, and evidence gates.
