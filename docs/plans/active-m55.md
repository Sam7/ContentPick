# Active plan — M5.5 release preparation

The execution checklist is [`ROADMAP.md`](../project/ROADMAP.md); product requirements remain in [`PRODUCT_CHARTER.md`](../PRODUCT_CHARTER.md). This file records only the current checkpoint and next actions.

## Current candidate

- Local Windows x64 NSIS installer: `target/release/bundle/nsis/ContextPick_0.1.0_x64-setup.exe`, 8,044,295 bytes, SHA-256 `3B909396F5FDFF5509372E258C9588F04813ACD1578FB341A6F1A032EFD3C235`.
- Authenticode status: unsigned. No GitHub Release exists. `packaging/` contains unpublished `0.1.0` WinGet, Chocolatey and opt-in Homebrew-tap candidates; IDs are tentative. The Homebrew candidate has no DMG/hash and cannot be submitted as written.
- Tauri bundle: NSIS + DMG, Windows per-user install, WebView2 `downloadBootstrapper`, project/frontend/target-Rust/brand attribution resources.
- The user specified final release version `0.9` after the current plan is complete. Keep all M5.5 candidates at `0.1.0`.

## Verified locally

- Frontend: `corepack pnpm test` — 77 Vitest + 3 brand checks; `typecheck`; `lint`; `test:e2e` — 16/16.
- Rust: `cargo test --workspace --locked` — 185; `cargo fmt --all -- --check`; strict workspace Clippy.
- Actual Windows WebView2 suite: rerun after the release-configuration changes, **13/13**. Installed-candidate smoke: 1/1 under a non-elevated standard user; notice files, app restore/preview, uninstall registration and cleanup checked.
- Target dependency notices regenerate byte-for-byte with cargo-about 0.9.2 for Windows x64, macOS x64 and arm64. Independent Rust-license review found target graphs, notice text mapping and bundled resource selection consistent.
- WinGet manifest validator passed on schema 1.12.0. Chocolatey install/uninstall scripts parse; nuspec XML parses; local installer SHA-256 matches candidate metadata. Independent package review found no candidate hash/version drift or automated publish path.

## Remaining M5.5 gates

1. Verify the modified Windows/macOS architecture CI bundle matrix on the pushed candidate; retain and inspect exact bundle artifacts and hashes. No remote run for this workflow exists yet.
2. Obtain macOS x64/arm64 DMGs and complete clean supported-Mac install/Gatekeeper evidence; no DMG or local Mac GUI smoke exists.
3. On independent clean Windows environments, verify absent-WebView2 bootstrap and restricted-network failure/recovery, silent install with progress, supported standard/elevated contexts, registration, upgrade and uninstall. Current Windows host already had WebView2; only the standard-user install/uninstall path is evidenced.
4. Validate Chocolatey packaging and Homebrew cask with their actual tooling on supported clean hosts; test package-manager-initiated installation where tooling is available. Chocolatey/Ruby/Homebrew are unavailable on this Windows host. WinGet validates locally. Recheck final package IDs/schema immediately before later submission.
5. Run `git diff --check`, review the integrated diff and update this record. Keep M5.5 unchecked until every M5.5 acceptance criterion has evidence.

No packages may be submitted or public release published as part of this M5.5 candidate work. The user authorized a verified Windows GitHub Release in M5.6; package-manager submissions remain separately authorized. After the M5.5 gate passes, review/stage only that milestone scope and commit/push per the user’s standing instruction. Continue with M5.1/M5.2, M5.6 and the M5 review; do not stop at M5.5.

## Known verification limit

The installed-smoke timeout/process-tree cleanup branch is code-reviewed but not exercised. A synthetic hung-process harness was rejected by command policy. Do not treat that branch as tested or hide this limitation.
