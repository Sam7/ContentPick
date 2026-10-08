# P0 hardening and acceptance

User value: safely export repeatedly from a large real workspace with predictable selection, restart recovery and a responsive tree.

Requirements: WS-02, SC-01/02/03, FL-01/02/03, EX-01/03, PR-01, QA-01. Reuse the pure selection evaluator, pinned WorkspaceRoot, transactional export spool and existing typed bridge. No watcher/tokenizer/profile expansion until the functional P0 gate.

## Ordered slices

1. **Verified:** presentation/streaming correctness: folders before files, soft-excluded unknown files remain metadata-only, arbitrary backtick fences use bounded writes, safe language tags. RED → GREEN; independent review and 39 Rust / 15 RTL / 3 browser E2E checks passed.
2. **Verified:** safe generated outputs with persisted hard exclusions, pinned nofollow parents, no-clobber publication and cancellation. Settings recovery is bounded and preserves originals.59 Rust tests and native ten-file repeated copy/restart evidence; independent core review closed.
3. Bounded IPC: page index entries with generation validation, preserve UI request cancellation and virtualization; test page limits, stale generations and 20k-entry transfer.
4. Acceptance breadth: actual native restart/filters/deep selection/ignore override, fixture errors and exported Markdown evidence. Broader M2 architecture/correctness review, fix findings and checkpoint.

## Validation

Run affected tests red then green; full Rust workspace tests/fmt/clippy and frontend typecheck/lint/test/build/E2E before the gate. Record actual native smoke separately from browser fixture tests. Benchmark >=100k files, pruned traversal, time and peak memory; no inferred OS claims.

## Observations

- Initial reviewed checkpoint: `2715721`; Windows native folder/preview/copy/save proven.
- Release benchmark on Windows x64: 20,000 ordinary source files + 100,000 ignored files; 20,002 indexed/enumerated, 20,001 selected; scan 440 ms, view 3 ms, 100 manifest reevaluations 141 ms. Repeat scan 510 ms with observed OS peak working set 12.8 MiB. [Measurements and limits](../testing/2026-10-08-performance.md). This measures Rust core, not native IPC/UI latency.
- In-root export now works with a new filename and persistent exclusion. Full index still crosses IPC; current slice replaces it with max512-entry/256KiB generation-checked pages and progressive frontend loading.
