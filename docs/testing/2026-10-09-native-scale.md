# Native scale evidence — 2026-10-09

**Result:** Windows 10.0.26200 x64, actual Tauri/WebView2 process with the test suite's local Vite frontend. No macOS or remote CI result is implied.

## Run

- `cargo +stable-x86_64-pc-windows-msvc build -p contextpick --locked` — passed.
- `corepack pnpm test:native` — **2 passed** on the real WebView2 app.
- `corepack pnpm test:native:scale` — **1 passed** (about 1 minute).
- Scale fixture: 20,000 small source files plus 100,000 files under `.gitignore`'d `ignored-scale`; exactly 20,004 entries were published to the UI. The last source file was searched and previewed; ignored files remained pruned. A root marker created immediately before refresh was absent after cancellation, the original generation remained usable, and Copy/Refresh controls recovered.
- Keyboard verification reached the first and last matching virtual rows with Home/End and left selection unchanged; Shift+F10 opened the row action menu and Escape returned focus. Screenshot shows the focused tree row and visible outline.
- Process-tree sampling filters descendants by parent PID and creation-time ordering, pins the launched root PID/path/creation time, and sums only that tree. Cleanup verifies PID, creation time and executable path through opened process handles; access errors fail closed and prevent fixture removal.

## Measurements

- Launch to fully hydrated UI, first and two repeated launches (ms): **3,250 / 2,862 / 2,385**.
- Peak summed process-tree working set: **636.7 MiB**, with **8 processes** and **15 successful samples**.
- Sampling uses Windows CIM snapshots scheduled once per second. Descendants must have a matching parent PID and a creation time no earlier than that parent; the launched root identity remains pinned across samples. A query that overlaps the prior snapshot is skipped. Peak memory is an observation, not a guarantee or a defined release threshold.

The launches reuse the same synthetic workspace, OS cache and WebView2 profile; they are not cold-start comparisons. The debug-build timings and sampled working set describe this Windows host only. One-second sampling may miss brief peaks. The fixture's file sizes and distribution do not represent arbitrary repositories.

## Screenshots and raw report

- Tail file preview: [PNG](2026-10-09-native-scale-tail-preview.png)
- Ignored subtree remains pruned: [PNG](2026-10-09-native-scale-ignored-pruned.png)
- Virtual tree keyboard focus: [PNG](2026-10-09-native-scale-keyboard-focus.png)
- Reconciled state after cancellation: [PNG](2026-10-09-native-scale-after-cancel.png)
- Structured host and measurement record: [JSON](2026-10-09-native-scale.json)

## M3.5 final UI build rerun — 2026-10-09

After rebuilding the Tauri debug app with the final redesigned frontend and splitter, the actual Windows WebView2 20k/100k scenario passed again. Launch-to-ready was **5,397 / 2,153 / 2,005 ms**; sampled process-tree working set peaked at **612.8 MiB** across 8 processes and 15 successful samples. The method and limitations above still apply. Raw run: [initial M3.5 JSON](2026-10-09-m35-native-scale-initial.json). The three launch measurements describe repeated local debug runs and do not establish a general performance threshold.

## M3.5 final review build rerun — 2026-10-09

After the splitter, preview metadata, collapsed-pane geometry and contrast fixes, the actual Windows WebView2 20k source / 100k ignored fixture passed again. Launch-to-ready was **2,834 / 2,051 / 2,226 ms**; sampled process-tree working set peaked at **587 MiB**, across 8 processes and 14 successful samples. Raw report: [final M3.5 JSON](2026-10-09-m35-native-scale.json); the preceding accessibility build report is preserved as [pre-final-review JSON](2026-10-09-m35-native-scale-pre-final-review.json). Final native screenshots show the [tail-file preview](2026-10-09-m35-scale-tail-preview.png), [ignored subtree pruned](2026-10-09-m35-scale-ignored-pruned.png), [keyboard focus](2026-10-09-m35-scale-keyboard-focus.png) and [authoritative state after refresh cancellation](2026-10-09-m35-scale-after-cancel.png). Measurement conditions and limits above apply; these are local debug-build observations, not release thresholds.
