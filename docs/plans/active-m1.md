# M0/M1: folder to Markdown

Goal: a runnable desktop slice that chooses a synthetic local folder, displays eligible files and a bounded preview, changes selection, and exports deterministic literal Markdown or copies it.

Requirements: WS-01/02, SC-01/03, TX-01/02, EX-01/02/03, QA-01. Scope: Rust core, thin Tauri adapter and React bridge/UI; no watcher/profile/tokenizer yet. Reuse: repository has no code; use established `ignore`, Tauri native dialogs and clipboard.

- [x] Inspect charter, repository, runtime and tools.
- [x] Establish domain, operating agreements and durable state.
- [x] Install usable local tooling; MSVC approved by user and installed.
- [x] Write red core fixtures: text/binary, nested files, deterministic fencing, deleted/changed source, no overwrite.
- [x] Implement initial discovery, pure selection, bounded preview and streaming export.
- [x] Build typed command bridge, native shell and browser fixture UI.
- [x] Run Rust/TS/UI tests, production build, E2E and available native smoke.
- [x] Independent review, fix significant findings, checkpoint and continue M2.

Test commands: README; exact results go into STATUS. Planned examples: two unchanged exports match; embedded backticks cannot close fence; binary cannot export; preview cap; outside-root and links fail; existing destination survives rejection; failed input never yields success.

Checkpoint: `2715721`. MSVC prerequisite resolved. 33 Rust tests (30 core, 3 native shell), 15 RTL and 3 browser E2E passed. Selection RED and custom-directory regression RED→GREEN observed. Actual Windows picker/preview/copy/save demonstrated (10 files/615 bytes). Independent review prompted pinned root capability, inherited filter, partial count, policy hydration and persist-before-publication fixes. See STATUS and native smoke evidence.

This proves the first vertical slice, not full P0. Continue with `active-p0-hardening.md`: safe in-root exports, bounded IPC and fixture/acceptance gaps.
