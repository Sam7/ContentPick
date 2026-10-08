# P0 hardening and acceptance

User value: safely export repeatedly from a large real workspace with predictable selection, restart recovery and a responsive tree.

Requirements: WS-02, SC-01/02/03, FL-01/02/03, EX-01/03, PR-01, QA-01. Reuse the pure selection evaluator, pinned WorkspaceRoot, transactional export spool and existing typed bridge. No watcher/tokenizer/profile expansion until the functional P0 gate.

The authoritative milestone order, task states and remaining work are in [`docs/project/ROADMAP.md`](../project/ROADMAP.md). This file preserves technical history; it is not a second checklist. M2 and M3 are verified locally on Windows. M3.5 follows before the full P0 gate can close.

## Ordered slices

1. **Verified:** presentation/streaming correctness: folders before files, soft-excluded unknown files remain metadata-only, arbitrary backtick fences use bounded writes, safe language tags. RED → GREEN; independent review and 39 Rust / 15 RTL / 3 browser E2E checks passed.
2. **Verified:** safe generated outputs with persisted hard exclusions, pinned nofollow parents, no-clobber publication and cancellation. Settings recovery is bounded and preserves originals.59 Rust tests and native ten-file repeated copy/restart evidence; independent core review closed.
3. **Verified M2/M3:** bounded512-entry/256KiB IPC pages, immutable generation views, progressive loading, cancellation reconciliation, scanner limits and truthful incompleteness. Selection policy compilation and recursive Git ignore state/body reads are bounded; matcher ownership is shared. Native WebView2 verifies 20k source/100k ignored scale, tail preview, keyboard navigation, cancellation marker non-publication, three launch timings and process-tree memory. M2/M3 test and architecture-review evidence are in [`docs/project/STATUS.md`](../project/STATUS.md), [`docs/project/REVIEW_LOG.md`](../project/REVIEW_LOG.md) and [`docs/testing/2026-10-09-native-scale.md`](../testing/2026-10-09-native-scale.md).
4. **Verified M2 selection/safety closure:** native restart/filters/deep selection/ignore override/recovery, child outside links/cycles, 128MiB export, WebView2 automation and deleted-source errors are recorded. Independent Sol review closed the custom-glob panic, recursive matcher-copy, cumulative body-read, force-recovery and diagnostic-budget findings. M3 is now closed locally on Windows; the approved M3.5 redesign and legacy `excludeExtensions` migration remain before full P0 acceptance.

## Validation

Run affected tests red then green; full Rust workspace tests/fmt/clippy and frontend typecheck/lint/test/build/E2E before the gate. Record actual native smoke separately from browser fixture tests. Benchmark >=100k files, pruned traversal, time and peak memory; no inferred OS claims.

## Observations

- Initial reviewed checkpoint: `2715721`; Windows native folder/preview/copy/save proven.
- Release benchmark on Windows x64: 20,000 ordinary source files + 100,000 ignored files; 20,002 indexed/enumerated, 20,001 selected; scan 440 ms, view 3 ms, 100 manifest reevaluations 141 ms. Repeat scan 510 ms with observed OS peak working set 12.8 MiB. [Measurements and limits](../testing/2026-10-08-performance.md). This measures Rust core, not native IPC/UI latency.
- In-root export works with a new filename and persistent exclusion. Full index no longer crosses IPC in one response; generation-checked bounded pages load progressively.
- Repeat optimized index benchmark:537ms scan/3ms view/139ms100reevaluations for20k source+100k ignored. Large export134,217,728sourcebytes→134,217,787Markdownbytes in861ms with7.64MiB observed core peak working set. These are core measurements, not native UI latency or whole-app memory.
