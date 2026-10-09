# Unpublished package candidates

These files are M5.5 package-definition candidates only. They have not been
submitted, accepted, or published. There is no public ContextPick GitHub
Release yet. Every release URL below is a **provisional URL** and must be
checked against the exact immutable public asset before any submission.

## Candidate identity and artifact

| Channel | Tentative identity | Candidate version | Artifact/status |
|---|---|---:|---|
| WinGet | `Sam7.ContextPick` | `0.1.0` | Windows x64 NSIS EXE; SHA-256 `3B909396F5FDFF5509372E258C9588F04813ACD1578FB341A6F1A032EFD3C235` |
| Chocolatey Community | `contextpick` | `0.1.0` | Same Windows x64 NSIS EXE and SHA-256 |
| Homebrew project tap | `Sam7/homebrew-contextpick` / cask token `contextpick` | `0.1.0` | macOS DMGs have not been built or hashed in this environment; filenames and URLs are provisional and the cask intentionally uses `sha256 :no_check` until exact hashes exist |

Exact-name lookups on 2026-10-09 found no WinGet source result for
`Sam7.ContextPick`, no Chocolatey Community package with ID `contextpick`,
and no official Homebrew cask token `contextpick`. These lookups do not reserve
names or prove there is no unpublished, pending, or differently named entry.
The GitHub owner, package identifiers, publisher/author display name, and tap
name all need final maintainer confirmation before M5.6 submission. Recheck
each registry and its current naming rules immediately before submission.

The current Windows NSIS candidate is
`target/release/bundle/nsis/ContextPick_0.1.0_x64-setup.exe`. Its local SHA-256
was verified against the value above. The WinGet and Chocolatey URLs point at
the expected future GitHub Release asset path, but that release does not
currently exist and the URL has not been downloaded or validated. Do not treat
these definitions as installable packages.

The Homebrew file lives under a project tap because the official cask
repository's current public-interest bar is not met. A project tap is opt-in
and Homebrew treats third-party taps as unsupported code requiring user trust.
The candidate must not be submitted with `sha256 :no_check`: replace it with
the exact architecture-specific DMG hash, then run Homebrew audit and clean
macOS installation/Gatekeeper checks. Developer ID signing, notarization, and
Gatekeeper acceptance remain release gates; do not bypass quarantine or advise
users to disable Gatekeeper.

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

On the Windows host used to prepare these candidates, `winget` is installed;
Chocolatey, Ruby, and Homebrew are not. As a result, `winget search` can check
the exact ID, but WinGet manifest validation, Chocolatey pack/validator and
install tests, and Homebrew `brew audit`/cask installation are unavailable
locally. PowerShell syntax/XML and YAML structure checks can still catch
candidate-definition errors; these are not equivalent to repository
validation.

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
