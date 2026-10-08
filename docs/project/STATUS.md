# Status — 2026-10-09, M2 closure checkpoint

M0–M2 are verified locally on Windows. M3 remains open; **full P0 acceptance is not complete**. M3.5 has an approved, executable plan, but no redesign UI or brand implementation has started.

## Verified evidence to preserve

- **M2 final Windows/MSVC gate:** 89 Rust tests passed (`cargo +stable-x86_64-pc-windows-msvc test --workspace --locked`), plus workspace fmt check, strict Clippy and native debug build. This includes current custom-glob limits, shared/bounded `.gitignore` state and reads, selection truth table, Git parity, error and force-recovery fixtures. Two Unix-only invalid-filename tests are not exercised on Windows.
- **Frontend/native Playwright:** typecheck, ESLint, 25 RTL, production build and 7 browser E2E passed. After the final M2 core revision, the Windows native app was rebuilt and 2 actual WebView2 E2E passed. The isolated suite paged 605 entries, restored state, previewed the tail, exercised ignore/force/reset/copy/restart and reported deleted-source errors. Latest launch-to-ready observation was 2,684 ms; earlier 605-entry debug observations were 1,445 and 1,309 ms. These are local debug observations, not performance guarantees. [Evidence](../testing/2026-10-08-native-playwright.md).
- **Native Windows workflows:** picker, preview, clipboard, in-root Save As, persisted output exclusion, deep selection, restart, corrupt-settings recovery, `.gitignore` toggle and ignored-file force/reset journeys are recorded with exact synthetic byte counts. [P0 evidence](../testing/2026-10-08-native-p0.md), [initial smoke](../testing/2026-10-08-native-smoke.md).
- **Native scale history:** a previous build paged 20,002 entries (20k selected sources plus 100k ignored files), searched for and previewed the final file, and kept the ignored subtree pruned. That binary predates cancellation reconciliation; it did not measure startup latency. Do not treat it as the final M3 native gate. [Evidence and limits](../testing/2026-10-08-native-paging.md).
- **Core performance:** optimized 20k source + 100k ignored benchmark reached 537 ms scan / 3 ms view / 139 ms for 100 manifest reevaluations. A 128 MiB synthetic export completed in 861 ms with 134,217,787 actual Markdown bytes and 7.64 MiB observed core peak working set. These exclude WebView/Tauri process memory. [Measurements](../testing/2026-10-08-performance.md).
- Bounded IPC (512 entries / 256 KiB), progressive loading, authoritative cancellation reconciliation, scanner raw/text/diagnostic limits, safe in-root publication, bounded settings recovery, and Windows child-link/cycle safety remain implemented and have prior test/review evidence. See [REVIEW_LOG](REVIEW_LOG.md).

## M2 closure and M3 work still open

- Independent Sol M2 architecture review found and closed concrete edge cases before acceptance: depth-multiplied matcher clones; top-level force discovery under root cutoff; a third diagnostic notice overflowing reserved count/bytes; valid Git literal rules rejected by the parser but left selectable; and post-cutoff reads bypassing the cumulative source budget. The final implementation shares matchers, bounds cumulative source/rule counts and body reads (remaining budget plus a sentinel), fails closed on unknown/unreadable/oversized rule sources, preserves explicit force and readable siblings, and caps notices. Review and TDD evidence are in [REVIEW_LOG](REVIEW_LOG.md).
- M3 still needs a repeatable opt-in native 20k/100k fixture/spec: current native Playwright creates only 605 entries and does not exercise refresh/cancel. No three-run scale timing or whole-app process-tree memory sampler exists yet. Historical 20k native evidence used an older binary, omitted startup timing and sampled only the parent process. M3.1 explicitly includes creating the isolated fixture/spec and instrumentation before rerunning current native behavior.

## Approved UI plan

- Actual baseline: [current native UI](../testing/2026-10-08-current-ui.jpg); approved design and logo: [`design-draft.png`](../design/design-draft.png) and [`Logo.png`](../design/Logo.png). Existing picker, refresh, virtualized searchable tree, tri-state/force actions, reasons, ignored browsing, bounded preview, selected/byte estimates and real Copy/Export are reused.
- Missing or changed: compact three-pane composition, collapsible sidebar, All/Selected/Ignored views, Settings destination, fixed metrics-plus-actions footer, new vector brand and removal/migration of active persisted `excludeExtensions`.
- The authoritative roadmap puts M3.5 after open M2/M3 gates and before M4. Only its reference/current-state audit is complete; all implementation slices remain unchecked. See [roadmap](ROADMAP.md) and [design contract](../CONTEXTPICK_UI_REDESIGN.md).

## Next work and limits

Next implementation task: M3.1 in [`ROADMAP.md`](ROADMAP.md): add repeatable opt-in native 20k-source / 100k-ignored WebView2 coverage, current refresh/cancel checks, three launch-to-ready measurements and a whole-process-tree memory sampler. M2 is closed locally; do not start the redesign until M3 is closed.

Node 24.19/pnpm 12.10.1, Rust 1.99, MSVC Build Tools and WebView2 are available on this Windows host. No macOS execution, remote CI run, installers, signing or public publishing are evidenced. No external blocker prevents the next Windows M3.1 work; macOS and release evidence remain later platform gates.

The preserved implementation and approved redesign planning are in commit `8f48b96` on `origin/main`. Inspect `git status` before every change and continue to keep the roadmap, tests and actual release evidence aligned.
