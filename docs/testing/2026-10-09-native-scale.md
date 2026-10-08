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
