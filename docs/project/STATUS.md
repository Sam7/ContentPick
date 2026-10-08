# Status — 2026-10-08, P0 hardening checkpoint

Milestone: M0/M1 native slice working; M2 review fixes and M3 bounded tree in progress. Full P0 acceptance is NOT complete.

## Verified

- Native Windows MSVC Tauri dev app runs. Actual native picker, Rust preview, Copy and Save As smoke passed on ten-file fixture. Both outputs 615 UTF-8 bytes; 10 sections, ignored sentinel absent. [Evidence](../testing/2026-10-08-native-smoke.md).
- `cargo +stable-x86_64-pc-windows-msvc test --workspace --locked`: **39 passed** (36 core, 3 shell). Git parity requires actual Git and fails clearly if missing. Selection, custom ancestor exclusion, folder ordering, long fences and language tags have recorded RED → GREEN evidence.
- Frontend lint/typecheck/build pass, **15 RTL / 3 Playwright tests passed**, including bounded 10k-entry DOM, saved-policy hydration, native string errors and compact footer. Browser tests are synthetic.
- Native cargo check/build previously passed; current workspace formatting and strict clippy rerun pass. CI Windows/macOS configured but not executed remotely.
- Folders precede sibling files in a stable hierarchical view; manifest order remains lexical. Filtered unknown extensions are not sampled unless force included. Export handles >16 KiB backtick runs with bounded, cancellable delimiter writes and safe language tags.
- 20k source + 100k ignored core benchmark: 440–910 ms scan, 20,002 entries enumerated, observed peak working set 12.8 MiB. [Scope/limits](../testing/2026-10-08-performance.md). Native UI screenshot saved at user request; recent-root restoration observed on launch.

## Current work / next 3

1. Finish current checks/review checkpoint; implement safely excluded in-root generated outputs with pinned destination parent and no-clobber publication.
2. Bound IPC transfer with generation-checked pages, then verify restoration/error recovery and remaining native P0 journeys.
3. Complete fixture breadth, repeat relevant performance measurements, close M2 architecture gate, then P1 reliability.

## Review disposition

Independent Sol reviews found root ambient-reopen redirect, lost custom directory exclusions, stale policy editor, commit-before-save and incomplete-directory partial state. All fixed with regressions. Current streaming review found missing cancellation during long delimiter writes; fixed with deterministic test. No further material findings in folder-order/export diff. See REVIEW_LOG.

## Environment and gaps

Node 24.19.0 at C:\Program Files\nodejs; pnpm 12.10.1 via Corepack. Rust 1.99.0 local under .tools (user also installed Rust globally). User-authorized MSVC Build Tools installed; WebView2 154. scripts/env.ps1 changes process env and prefers detected MSVC. Initial GNU tests used local libgcc alias; not standard supported setup.

Native HMR session 64314 stopped during an intermediate compiler error (fixed). Independent Vite session 45064 and last successful native binary were started for the requested screenshot, using isolated CONTEXTPICK_CONFIG_DIR=.tools/smoke-config. Fixture .tools/smoke-repo; output .tools/smoke-output/context.md. Windows only verified; macOS/installer/signing unverified. No watcher/tokenizer. Scanner prunes/cancels but returns full index; IPC paging/progressive results remain an engineering gap. In-root export currently rejected pending next fix. No public publishing performed.

Initial reviewed checkpoint: `2715721`. Current agents have completed implementation/review; root integrates and checkpoints. ADR 0001. Charter remains docs/PRODUCT_CHARTER.md. Active plan: `docs/plans/active-p0-hardening.md`.
