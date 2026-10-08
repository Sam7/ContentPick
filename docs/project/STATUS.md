# Status — 2026-10-08, safe export checkpoint

M0/M1 native slice verified; M2/M3 hardening in progress. **Full P0 acceptance is not complete.**

## Verified

- Windows native picker, bounded Rust preview, Copy and Save As. Latest in-root export: ten files, 673 actual UTF-8 bytes; clipboard byte-identical; ignored sentinel and prior generated output absent. Deep selections and generated exclusion restored after actual relaunch. [Native evidence](../testing/2026-10-08-native-p0.md), [current UI](../testing/2026-10-08-current-ui.jpg).
- **59 Rust tests passed**: `cargo +stable-x86_64-pc-windows-msvc test --workspace --locked`. Formatting, strict workspace/all-target Clippy and native debug build passed after all core edits. Tests include Git parity, selection, encoding/fences, root/destination races, no-clobber publication, output reservation and bounded settings recovery.
- Frontend checkpoint: **18 RTL / 5 browser E2E passed**, typecheck/lint/build passed. Geometry tests reproduced hidden error notices, now fixed by a shared footer/notice dock. Browser fixtures are not native filesystem evidence. Paging work now modifies frontend; rerun before next checkpoint.
- New in-root exports use pinned nofollow parents and atomic no-clobber publication; final paths are persisted as hard exclusions before output creation. Existing workspace paths cannot be overwritten. Outside-root overwrite requires confirmation. Filesystems without hard-link support fail safely.
- Settings load/save/recovery use a shared 4 MiB cap. Invalid originals are backed up before defaults may be saved; backup failure blocks saving with correct restart instructions. Independent Sol review has no remaining material core findings.
- Earlier core benchmark: 20k source + 100k ignored files; scan 440–910 ms, 20,002 entries enumerated, observed peak working set 12.8 MiB. [Scope and limits](../testing/2026-10-08-performance.md); not native IPC/UI evidence.

## Current work / next three

1. Generation-checked bounded IPC pages and progressive UI loading, with stale-page/cancel tests. Root owns native; Luna toolchain owns frontend. Long-path notice wrapping followup included.
2. Native ignore/override/recovery and large workspace acceptance; remaining contract/fault fixtures, repeat measurements.
3. Broader M2 architecture gate, fix findings; then P1 reliability/tokenizer/watchers and release readiness.

## Environment / limitations

Node24.19/pnpm12.10.1 via Corepack, Rust1.99, installed user-authorized MSVC Build Tools and WebView2. `. ./scripts/env.ps1` changes process environment only. Explicit MSVC toolchain is verified. Vite session45064 may still run; native app was closed through UI for build. Isolated debug config `.tools/smoke-config`, fixture `.tools/smoke-repo`.

No macOS execution, installers, signing, remote CI or public publishing verified. No watcher/tokenizer. Full index still crosses IPC until current slice lands. Scanner limits 200k entries /128 depth; complete memory bounds and diagnostic budget need review. These are ongoing work, not external blockers.

Reviewed earlier commits: `2715721`, `5fe1934`. Current core checkpoint follows these; use Git log for hash. Charter: docs/PRODUCT_CHARTER.md; active plan: docs/plans/active-p0-hardening.md; see REVIEW_LOG for dispositions.
