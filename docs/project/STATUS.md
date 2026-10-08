# Status — 2026-10-09, approved UI planning checkpoint

M0/M1 are verified. M2 and M3 are still open; **full P0 acceptance is not complete**. M3.5 now has an approved, executable plan, but no UI or brand implementation has started.

## Verified evidence to preserve

- **Rust checkpoint:** 76 Windows/MSVC tests passed (62 core / 14 shell), with workspace formatting, strict Clippy and native debug build. This full run predates the current uncommitted M2 policy/fixture edits; those edits have not yet had a new full root validation. Two Unix-only invalid-filename tests are not exercised on Windows.
- **Frontend/native Playwright checkpoint:** 25 RTL, 7 browser E2E and 2 real Windows WebView2 E2E passed; typecheck, ESLint and production build passed. The native suite used isolated app/settings/source/profile copies, paged 605 entries, restored state, previewed the tail entry, exercised filter/force/reset/copy/restart and displayed a deleted-source error. One 605-entry launch-to-ready observation was 1,445 ms; an earlier run was 1,309 ms. These are local debug observations, not performance guarantees. [Evidence](../testing/2026-10-08-native-playwright.md).
- **Native Windows workflows:** picker, preview, clipboard, in-root Save As, persisted output exclusion, deep selection, restart, corrupt-settings recovery, `.gitignore` toggle and ignored-file force/reset journeys are recorded with exact synthetic byte counts. [P0 evidence](../testing/2026-10-08-native-p0.md), [initial smoke](../testing/2026-10-08-native-smoke.md).
- **Native scale history:** a previous build paged 20,002 entries (20k selected sources plus 100k ignored files), searched for and previewed the final file, and kept the ignored subtree pruned. That binary predates cancellation reconciliation; it did not measure startup latency. Do not treat it as the final M3 native gate. [Evidence and limits](../testing/2026-10-08-native-paging.md).
- **Core performance:** optimized 20k source + 100k ignored benchmark reached 537 ms scan / 3 ms view / 139 ms for 100 manifest reevaluations. A 128 MiB synthetic export completed in 861 ms with 134,217,787 actual Markdown bytes and 7.64 MiB observed core peak working set. These exclude WebView/Tauri process memory. [Measurements](../testing/2026-10-08-performance.md).
- Bounded IPC (512 entries / 256 KiB), progressive loading, authoritative cancellation reconciliation, scanner raw/text/diagnostic limits, safe in-root publication, bounded settings recovery, and Windows child-link/cycle safety remain implemented and have prior test/review evidence. See [REVIEW_LOG](REVIEW_LOG.md).

## M2 / M3 work still open

- Current working-tree changes include fallible glob-set construction, policy limits (256 rules / 4 KiB per rule / 64 KiB aggregate), a regression for the reproduced 200 kB glob panic, `.gitignore` error diagnostics, and expanded selection/Git fixtures. They need final full test, formatting, Clippy, build and independent review before acceptance.
- Sol's M2 review found a concrete aggregate-ignore memory issue still to fix: recursive `parents.to_vec()` deep-clones inherited `Gitignore` matchers. At depth 128, 128 valid 64 KiB ignore files can retain about 1 GiB of copied matcher strings. This estimate is based on library structure and bounded input analysis, not a giant-memory reproduction. Use shared matcher ownership and a cumulative source/rule budget, then prove cutoffs and readable sibling traversal with a small injected-budget fixture.
- M3 also needs a repeatable opt-in native 20k/100k fixture/spec: current native Playwright creates only 605 entries and does not exercise refresh/cancel. No three-run scale timing or whole-app process-tree memory sampler exists yet. The historical 20k native result used an older binary, omitted startup timing and sampled only the parent process. M3.1 now explicitly includes building the missing safe fixture/spec and instrumentation before rerunning current native behavior.

## Approved UI plan

- Actual baseline: [current native UI](../testing/2026-10-08-current-ui.jpg); approved design and logo: [`design-draft.png`](../design/design-draft.png) and [`Logo.png`](../design/Logo.png). Existing picker, refresh, virtualized searchable tree, tri-state/force actions, reasons, ignored browsing, bounded preview, selected/byte estimates and real Copy/Export are reused.
- Missing or changed: compact three-pane composition, collapsible sidebar, All/Selected/Ignored views, Settings destination, fixed metrics-plus-actions footer, new vector brand and removal/migration of active persisted `excludeExtensions`.
- The authoritative roadmap puts M3.5 after open M2/M3 gates and before M4. Only its reference/current-state audit is complete; all implementation slices remain unchecked. See [roadmap](ROADMAP.md) and [design contract](../CONTEXTPICK_UI_REDESIGN.md).

## Next work and limits

Next implementation task: resume M2.1–M2.2 in [`ROADMAP.md`](ROADMAP.md): validate the current checked glob-policy changes, then bound shared inherited `.gitignore` state and re-run the M2 contract/review gate. Do not start the UI redesign until M2 and M3 are closed.

Node 24.19/pnpm 12.10.1, Rust 1.99, MSVC Build Tools and WebView2 are available on this Windows host. No macOS execution, remote CI run, installers, signing or public publishing are evidenced. There is no external blocker for the next M2 work; macOS/release evidence remains a later platform gate.

The repository already contains substantial **uncommitted P0 implementation work** across Rust, Tauri, React, tests and docs. Preserve it; inspect `git status` before every change. This planning checkpoint changed documentation only. Last recorded reviewed commits: `2715721`, `5fe1934`, `b4b2e01`.
