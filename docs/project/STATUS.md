# Status — 2026-10-08 12:15 Australia/Sydney

Milestone: M0/M1 native slice working; M2 review fixes and M3 bounded tree in progress. Full P0 acceptance is NOT complete.

## Verified

- Native Windows MSVC Tauri dev app runs. Actual native picker, Rust preview, Copy and Save As smoke passed on ten-file fixture. Both outputs 615 UTF-8 bytes; 10 sections, ignored sentinel absent. [Evidence](../testing/2026-10-08-native-smoke.md).
- `cargo +stable-x86_64-pc-windows-msvc test --workspace --locked`: **33 passed** (30 core, 3 shell). Git parity and fixtures pass with actual Git. Selection stub initially failed all five tests; custom ancestor exclusion regression initially failed then passed.
- Frontend lint/typecheck/build pass, **15 RTL / 3 Playwright tests passed**, including bounded 10k-entry DOM, saved-policy hydration, native string errors and compact footer. Browser tests are synthetic.
- Native cargo check, full workspace clippy -D warnings and formatting pass. CI Windows/macOS configured but not executed remotely.

## Current work / next 3

1. Benchmark 20k source + 100k ignored fixture (release benchmark running), add backend folders-first presentation ordering.
2. Support safe in-root output exclusion and arbitrarily long fences with bounded memory; add native persistence/generation tests.
3. Run broad fixture/performance tests, independent review, full checks, checkpoint, then remaining P0 gaps and P1 reliability.

## Review disposition

Independent Sol review found root ambient-reopen redirect and lost custom directory exclusions. Fixed with pinned WorkspaceRoot, anchor validation, inherited soft reasons and regressions. Follow-up found missing editor policy hydration (fix underway), commit-before-save (candidate flow implemented; native regression pending), incomplete-directory partial flag (fixed/test extended). See REVIEW_LOG.

## Environment and gaps

Node 24.19.0 at C:\Program Files\nodejs; pnpm 12.10.1 via Corepack. Rust 1.99.0 local under .tools (user also installed Rust globally). User-authorized MSVC Build Tools installed; WebView2 154. scripts/env.ps1 changes process env and prefers detected MSVC. Initial GNU tests used local libgcc alias; not standard supported setup.

Native dev tool session 64314 uses isolated CONTEXTPICK_CONFIG_DIR=.tools/smoke-config. Fixture .tools/smoke-repo; output .tools/smoke-output/context.md. Windows only verified; macOS/installer/signing unverified. No watcher/tokenizer. Scanner prunes/cancels but returns full index; IPC paging/progressive results remain an engineering gap. In-root export currently rejected pending next fix. No public publishing performed.

Initial reviewed checkpoint: this commit (resolve with git log). ADR 0001. Charter remains docs/PRODUCT_CHARTER.md. All implementation agents are idle except the running benchmark command.
