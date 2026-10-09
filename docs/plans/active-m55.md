# Active plan — M5.5 release preparation

The execution checklist is [`ROADMAP.md`](../project/ROADMAP.md); product requirements remain in [`PRODUCT_CHARTER.md`](../PRODUCT_CHARTER.md). This file records only the current checkpoint and next actions.

## Current candidate

- Local Windows x64 NSIS installer: `target/release/bundle/nsis/ContextPick_0.1.0_x64-setup.exe`, 8,044,295 bytes, SHA-256 `3B909396F5FDFF5509372E258C9588F04813ACD1578FB341A6F1A032EFD3C235`. This candidate predates M5.2 and must be rebuilt before M5.5 closes.
- Authenticode status: unsigned. No GitHub Release exists. `packaging/` contains unpublished `0.1.0` WinGet, Chocolatey and opt-in Homebrew-tap candidates; IDs are tentative. The Homebrew definition still lacks a stable public DMG URL/hash; the CI DMGs are temporary artifacts and cannot be submitted as written.
- Tauri bundle: NSIS + DMG, Windows per-user install, WebView2 `downloadBootstrapper`, project/frontend/target-Rust/brand attribution resources.
- The user specified final release version `0.9` after the current plan is complete. Keep all M5.5 candidates at `0.1.0`.

## Verified locally

- Frontend: `corepack pnpm test` — 82 Vitest + 3 brand checks; `typecheck`; `lint`; `test:e2e` — 16/16.
- Rust: `cargo test --workspace --locked` — 200 passed; `cargo fmt --all -- --check`; strict workspace Clippy. M5.1 profile persistence is locally verified; see the roadmap and review log.
- Actual Windows WebView2 suite: **14/14** after M5.2 profile operations were added. Installed-candidate smoke: 1/1 under a non-elevated standard user; notice files, app restore/preview, uninstall registration and cleanup checked.
- Target dependency notices regenerate byte-for-byte with cargo-about 0.9.2 for Windows x64, macOS x64 and arm64. Independent Rust-license review found target graphs, notice text mapping and bundled resource selection consistent.
- WinGet manifest validator passed on schema 1.12.0. Chocolatey install/uninstall scripts parse; nuspec XML parses; local installer SHA-256 matches candidate metadata. Independent package review found no candidate hash/version drift or automated publish path.

## Remaining M5.5 gates

1. [x] Verify the corrected Windows/macOS architecture CI bundle matrix and retain candidate artifacts with raw bundle hashes. Run `37887028410` exposed a clean-checkout ordering defect on macOS arm64; the workflow now prepares target notices before all Tauri-compiling Cargo steps. Follow-up run `37887405550` passed Ubuntu and Windows x64 but both Mac jobs failed the Rust notice comparison because upstream license text differed only by CRLF/LF. The fix uses `git diff --ignore-cr-at-eol` for Rust notices only; frontend comparison remains exact. Rerun [`37889616361`](https://github.com/Sam7/ContentPick/actions/runs/37889616361) on `dacce65` passed all four jobs and retained unsigned `0.1.0` candidates: Windows x64 NSIS `99c1191b0903ddb60c56018d0db36596af52f741932f95bef77cef6e721c177b`, macOS x64 DMG `449be15ab6bae974ccfe73250fe22502120b246b593c5cf1557b86e7c580f8db`, and macOS arm64 DMG `2e4fb3d912a4f0ab5f12f2f62cf28fd5805099271a6177bc5d56e973336fedb`. The [workflow artifacts](https://github.com/Sam7/ContentPick/actions/runs/37889616361) expire after 14 days. These are CI build/hash results, not signature, notarization, local Mac GUI or clean-install evidence. This run predates M5.2; refresh candidate artifacts at the current source commit before M5.5 can pass.
2. Inspect the macOS x64/arm64 DMGs on a supported Mac and complete clean supported-Mac install/Gatekeeper evidence. DMGs now exist as CI artifacts; no local Mac GUI smoke has been performed.
3. On independent clean Windows environments, verify absent-WebView2 bootstrap and restricted-network failure/recovery, silent install with progress, supported standard/elevated contexts, registration, upgrade and uninstall. Current Windows host already had WebView2; only the standard-user install/uninstall path is evidenced.
4. Validate Chocolatey packaging and Homebrew cask with their actual tooling on supported clean hosts; test package-manager-initiated installation where tooling is available. Chocolatey/Ruby/Homebrew are unavailable on this Windows host. WinGet validates locally. Recheck final package IDs/schema immediately before later submission.
5. After the M5.2 push, rerun the Windows/macOS architecture matrix against the current source and retain/verify its artifact hashes.
6. Run `git diff --check`, review the integrated diff and update this record. Keep M5.5 unchecked until every M5.5 acceptance criterion has evidence.

No packages may be submitted or public release published as part of this M5.5 candidate work. The user authorized a verified Windows GitHub Release in M5.6; package-manager submissions remain separately authorized. After the M5.5 gate passes, review/stage only that milestone scope and commit/push per the user’s standing instruction. M5.1–M5.4 are verified. Continue the open M5.5 clean-install and package-tool checks, then M5.6 and the M5 review; do not stop at M5.5.

## Known verification limit

The installed-smoke timeout/process-tree cleanup branch is code-reviewed but not exercised. A synthetic hung-process harness was rejected by command policy. Do not treat that branch as tested or hide this limitation.
