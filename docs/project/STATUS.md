# Status — 2026-10-09, M3 Windows closure

M0–M3 are verified locally on Windows. **Full P0 acceptance and production release readiness remain open.** M3.5 is next; its approved UI and branding are documented, but implementation has not started. M4/M5 and macOS, remote CI, installers and signing are not verified.

## Completed milestone evidence

- **M0:** Windows toolchains, Tauri/React shell, Rust core and CI baseline are recorded as locally verified. Remote CI was not run.
- **M1:** Actual Windows folder picker, preview, clipboard and file export passed. See [native smoke](../testing/2026-10-08-native-smoke.md).
- **M2:** 89 Rust tests, workspace fmt, strict Clippy and MSVC native build passed. Frontend typecheck, lint, 25 RTL, production build, 7 browser E2E and 2 actual WebView2 E2E passed. Independent Sol review closed the bounded-policy and selection findings. See [M2 reviews](REVIEW_LOG.md#m2-closure--2026-10-09) and [native P0 evidence](../testing/2026-10-08-native-p0.md).
- **M3.1 native scale:** actual Windows WebView2 loaded 20,004 entries (20,000 source files plus the fixture's root entries); 100,000 ignored files remained pruned; the tail file was searched and previewed; a marker added before refresh stayed unpublished after cancellation. Three launch-to-ready timings were 3,250 / 2,862 / 2,385 ms. The validated process tree peaked at 636.7 MiB across 8 processes and 15 successful samples. Results are local debug observations with sampling and cache limitations. [Full method, limitations, report and inspected screenshots](../testing/2026-10-09-native-scale.md).
- **M3.2 keyboard tree:** one roving tab stop; row controls do not add Tab stops; arrows, Home/End, Enter, Space and Shift+F10/ContextMenu; virtualized focus retention; tree checked/mixed and sibling metadata; visible 3:1 focus outline. Disabled-action races, boundary focus theft and menu-action focus loss were observed failing before their fixes. Native scale verified Home/End, opening/activating row actions and focus return. Independent Sol and Luna reviews found no remaining material issue.
- **Final local regression checks:** Rust workspace tests **89 passed**, fmt, strict Clippy and MSVC build passed. Frontend **28 RTL + 3 process-tree regression tests**, typecheck, lint, production build and **8 browser E2E** passed. Actual Windows native Playwright **2/2** and scale Playwright **1/1** passed. Exact commands and review dispositions are in [ROADMAP](ROADMAP.md), [scale evidence](../testing/2026-10-09-native-scale.md) and [REVIEW_LOG](REVIEW_LOG.md).

## M2 safety evidence preserved

Custom glob compilation and recursive Git ignore state/input are bounded and fail closed; actual body reads obey the cumulative budget plus one sentinel. Unknown or malformed rules preserve readable siblings and explicit force recovery, while hard safety guards still win. Persist-before-publish, settings recovery, output reservation, path/link containment and generation-checked IPC remain covered by the Rust/native suites. The independent M2 reproduction/fix history is preserved in [REVIEW_LOG](REVIEW_LOG.md).

## Approved UI plan and next task

The current app already has workspace selection/refresh, a searchable virtual tree, selection/reasons/force actions, lazy ignored browsing, bounded read-only preview, count/byte estimates, Copy/Export and persisted policy/intents. The compact three-pane composition, collapsible sidebar/views, fixed metrics/actions footer and vector brand remain M3.5 work. The active version-1 `excludeExtensions` field must be migrated transactionally into visible exclude-path rules before that policy is removed. See [redesign contract](../CONTEXTPICK_UI_REDESIGN.md) and the single authoritative [roadmap](ROADMAP.md).

Next implementation task: **M3.5.1, vector brand assets.** Generate an editable SVG icon/wordmark from the approved mark, wire generated application icons and inspect required sizes on light/dark backgrounds. Then proceed through M3.5.2–.6 in dependency order. Do not start M4 until the M3.5 gate and full P0 acceptance are verified.

## Platform and release limits

All current native evidence is from one Windows x64 host. Unix-only invalid-filename tests, macOS build/runtime, remote CI, installers, signing/notarisation and public publication are not evidenced. Keep these open in M5; do not claim cross-platform or public-release readiness.
