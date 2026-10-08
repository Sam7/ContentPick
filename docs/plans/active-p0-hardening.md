# P0 hardening and acceptance

User value: safely export repeatedly from a large real workspace with predictable selection, restart recovery and a responsive tree.

Requirements: WS-02, SC-01/02/03, FL-01/02/03, EX-01/03, PR-01, QA-01. Reuse the pure selection evaluator, pinned WorkspaceRoot, transactional export spool and existing typed bridge. No watcher/tokenizer/profile expansion until the functional P0 gate.

The authoritative milestone order and current completion states are in [`docs/project/ROADMAP.md`](../project/ROADMAP.md). This plan holds the technical details for P0 only; M2 must close before M3, and M3 before the planned M3.5 visual redesign.

## Ordered slices

1. **Verified:** presentation/streaming correctness: folders before files, soft-excluded unknown files remain metadata-only, arbitrary backtick fences use bounded writes, safe language tags. RED → GREEN; independent review and 39 Rust / 15 RTL / 3 browser E2E checks passed.
2. **Verified:** safe generated outputs with persisted hard exclusions, pinned nofollow parents, no-clobber publication and cancellation. Settings recovery is bounded and preserves originals.59 Rust tests and native ten-file repeated copy/restart evidence; independent core review closed.
3. **Implemented and independently reviewed:** bounded512-entry/256KiB IPC pages, cached immutable generation views, progressive UI loading and authoritative cancellation reconciliation. Scanner raw/text/diagnostic budgets and local incompleteness are explicit.76 Rust/25RTL/7browser E2E checks passed. Native20k paged transfer/search/preview verified; final native cancel/timing evidence pending.
4. **Partly verified; gate open:** native restart/filters/deep selection/ignore override/recovery verified. Child outside links/cycles and128MiB export covered. Actual WebView2 Playwright harness and deleted-source error check pass. Before accepting M2, validate the current fallible bounded custom-glob implementation and address recursive deep copies of inherited `.gitignore` matchers with shared ownership plus a cumulative input/rule budget; reviewer estimated the current bounded-depth copying can retain about1GiB for nested 64KiB ignore files. Then rerun M2 tests/review. Before accepting M3, rerun native scale/cancel against the current binary and record startup timing and whole app process-tree memory. See ROADMAP for exact order and criteria.

## Validation

Run affected tests red then green; full Rust workspace tests/fmt/clippy and frontend typecheck/lint/test/build/E2E before the gate. Record actual native smoke separately from browser fixture tests. Benchmark >=100k files, pruned traversal, time and peak memory; no inferred OS claims.

## Observations

- Initial reviewed checkpoint: `2715721`; Windows native folder/preview/copy/save proven.
- Release benchmark on Windows x64: 20,000 ordinary source files + 100,000 ignored files; 20,002 indexed/enumerated, 20,001 selected; scan 440 ms, view 3 ms, 100 manifest reevaluations 141 ms. Repeat scan 510 ms with observed OS peak working set 12.8 MiB. [Measurements and limits](../testing/2026-10-08-performance.md). This measures Rust core, not native IPC/UI latency.
- In-root export works with a new filename and persistent exclusion. Full index no longer crosses IPC in one response; generation-checked bounded pages load progressively.
- Repeat optimized index benchmark:537ms scan/3ms view/139ms100reevaluations for20k source+100k ignored. Large export134,217,728sourcebytes→134,217,787Markdownbytes in861ms with7.64MiB observed core peak working set. These are core measurements, not native UI latency or whole-app memory.
