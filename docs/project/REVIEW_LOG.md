# Reviews

## M3 scale, keyboard tree and architecture closure — 2026-10-09

M3.1 added an opt-in native Playwright fixture with 20,000 source files and 100,000 ignored files. Actual Windows WebView2 loaded 20,004 UI entries; tail search/preview and ignored pruning passed. Cancellation was distinguished from a completed refresh with a root-level marker created immediately before refresh; the retained generation stayed at 20,004 and the marker was absent. Final launch-to-ready runs measured 3,250 / 2,862 / 2,385 ms; validated process-tree working-set peak was 636.7 MiB across 8 processes and 15 successful one-second-scheduled samples. These are local debug-build observations using one workspace, OS cache and WebView2 profile; one-second sampling can miss brief peaks. Method, raw JSON and inspected screenshots are in [`2026-10-09-native-scale.md`](../testing/2026-10-09-native-scale.md).

A diagnostic rerun exposed a PID-reuse bug in the test harness: parent-PID-only ancestry included older Windows processes, inflated memory, and fed them to cleanup. That run is excluded from scale evidence. Read-only follow-up found 129 of its 133 recorded identities still present; four were absent, with no evidence to attribute their exit. The harness now requires child creation time to be no earlier than its verified parent, pins the launched root PID/path/creation time, and terminates only captured processes whose PID, start time and executable path match through an opened handle. The regression test reproduced the old-tree failure before the fix. Native smoke and scale then passed with bounded, expected process counts; independent Luna review found no material remaining issue. Do not claim the four absent identities were terminated or exited naturally.

Independent Sol M3 architecture review found keyboard Enter/Right could start preview or ignored browsing while the corresponding controls were disabled during export/refresh. Deferred-command RTL tests were observed RED (`README.md` preview started during export; `dist` browse started during refresh), then GREEN after keyboard dispatch matched `previewDisabled`/`busy`. A separate 10k-row regression caught stale pending focus after Home/Up at the first row; focus was made a no-op for the active path, and the regression passed. Focus outline was darkened to the existing green token for adequate contrast. The review then found no material remaining domain, performance, accessibility, race or roadmap issue. Independent Luna re-review confirmed process cleanup checks exact sampled PID/creation identities, verifies termination and prevents temp deletion when cleanup fails; no material findings remain.

The menu-action focus loss was reproduced RED after the portal closed, then fixed by returning focus to the row trigger. The browser regression passes and the scale scenario now activates Force include through Shift+F10/Enter, verifies the override, and confirms trigger focus without changing the effective count. Independent Sol review found no material remaining issue.

Final Windows-local verification: Rust workspace tests **89 passed**, fmt, strict Clippy and MSVC build; frontend **28 RTL + 3 process-tree tests**, typecheck, lint, production build and **8 browser E2E**; actual native WebView2 **2/2** and scale **1/1**. The final native keyboard-focus, tail-preview, ignored-pruning and post-cancel screenshots were inspected. M3 is verified locally on Windows only; this is not full P0, M3.5, macOS, CI or release signoff.

## M2 closure — 2026-10-09

Independent GPT-6.1 Sol architecture review found no remaining material findings after the fixes. The final implementation keeps one selection evaluator and persist-before-publish path. Custom glob compilation is fallible and bounded by rule count/size/aggregate text. Recursive `.gitignore` matchers share `Arc` ownership; cumulative input, rules and actual body reads are bounded. Unknown, oversized, unreadable or unparseable rules conservatively exclude their subtree, while explicit ForceInclude and readable siblings work and hard guards still win.

The review findings were reproduced red before correction: inherited matcher deep-copy memory (bounded-input analysis estimated 1 GiB at depth 128); root cutoff losing top-level force targets; a third limit notice overrunning the reserved diagnostic bound; a valid Git literal brace pattern becoming selected after parser rejection; and repeated post-cutoff `.gitignore` reads exceeding the cumulative budget. Injected tests now cover each behavior, including aggregate body reads <= budget plus one sentinel. Git anchor/parent-negation parity was checked with actual `git check-ignore`.

Final owner verification on Windows/MSVC: `cargo +stable-x86_64-pc-windows-msvc test --workspace --locked` — **89 passed**; `cargo +stable-x86_64-pc-windows-msvc fmt --all -- --check`; `cargo +stable-x86_64-pc-windows-msvc clippy --workspace --all-targets --locked -- -D warnings`; `cargo +stable-x86_64-pc-windows-msvc build -p contextpick --locked` — all passed. Frontend: typecheck, lint, 25 Vitest, production build and 7 browser Playwright E2E passed; rebuilt current native app and 2 actual WebView2 E2E passed (605-entry fixture). Independent Sol re-ran 44 core policy/contract tests and confirmed `{secret.ts` excluded by default but explicitly force-includable. M2 is locally verified on Windows only; Unix-only filename tests, macOS, remote CI and release artifacts remain unverified.

## M3 evidence audit — 2026-10-09

Independent read-only audit: current native Playwright harness validates real WebView2 and Rust IPC on 605 entries, but no opt-in 20k/100k native fixture/spec or process-tree sampler exists; it also has no refresh/cancel scenario or three-run scale timing. Historical 20k evidence used a pre-cancellation binary, omitted timing, and measured only the parent. Audit sources: `tests/native/native.fixture.ts`, `tests/native/workspace.spec.ts`, `docs/testing/2026-10-08-native-paging.md`.

- **Disposition:** expanded M3.1 to include building the isolated scale fixture/spec and measurement method before rerunning current behavior. M3 remains open; no gate or requirement is marked complete.

## Approved desktop redesign planning and consistency review — 2026-10-09

Planning-only audit reviewed the existing React/Tauri/core paths, requirements matrix, native screenshot and test evidence. The app already supports folder selection/refresh, virtualised tree/search, selection and override reasons, lazy ignored browsing, bounded read-only preview, selected/byte estimates, Copy/Export and persistence. The compact toolbar/sidebar/views/footer and vector brand require adaptation; All/Selected/Ignored and a Settings destination are absent. Tokenization remains unavailable.

The audit confirmed `excludeExtensions` is active in the Rust policy, bridge and persisted settings v1; it is not dead code. The charter now requires Include Extensions only and a transactional migration to visible path rules. No migration or UI code was implemented. M3.5 is placed after still-open M2/M3 gates and before M4. The charter contains the only requirements matrix; ROADMAP contains the only task checklist; the redesign document is the visual/interaction contract.

Independent consistency pass checked every redesign item against a charter requirement and M3.5 task, dependencies, objective acceptance and verification; checked M0/M1 evidence remains verified and M2/M3 remain open; checked tokenization/watchers and other out-of-scope features remain deferred; checked the actual asset paths and the historical-vs-current limits of test evidence. No contradiction or scope expansion remained. This review covered planning documents only and is not a code review or implementation gate.

## Bounded IPC, cancellation and scanner checkpoint — 2026-10-08

Independent Sol reviews covered native paging, frontend progressive loading, cancellation reconciliation, scanner limits and the export benchmark. Root integrated fixes and reran the full Windows suite:76 Rust tests, strict Clippy, formatting and native debug build passed.25 RTL/7 browser E2E passed; native Playwright automation is being added following the user's request to reduce repetitive desktop automation.

- Native pages have512-entry/256KiB serialized limits, immutable cached generations and stale request rejection. Scanner diagnostic flooding is bounded to64 messages/16KiB so initial headers remain usable. Unit fixtures cover20k complete ordered transfer and escaped Unicode byte costs.
- Cancellation returns the authoritative retained native workspace. Tests cover already-published new roots with in-flight original responses, unpublished scans, obsolete pages and UI reconciliation. Unknown cancellation outcomes disable export until refresh. First-root policy hydration also fixed.
- Clipboard preflight uses checked addition, and a final cancellation check precedes OS clipboard mutation; both regressions were observed RED before fixing. Partial writer failure propagates without success accounting.
- Native ignored-file inspection found the action menu occluded by virtual rows. A portal fixed pointer targeting (compact-window RED→GREEN). Independent review found portal keyboard focus missing; first enabled action now receives focus, Escape returns focus, and outside pointer closing preserves its target. Keyboard RED→GREEN; final source review clear.
- Scanner caps global raw directory attempts at200k and retained path/reason text at16MiB. Index clones share an Arc; hierarchy ordering no longer builds keys proportional to path depth. Injected-limit tests cover cutoffs and ancestor incompleteness. Sol found local read/depth failures conflated with global exhaustion; ScanOutcome distinguishes these. A depth-limited branch hiding a readable sibling was observed RED→GREEN. Invalid filename/iterator/metadata omissions also mark ancestors incomplete. Unix-only invalid-filename fixtures are not executed on Windows.
- Windows child junction/outside-root and link-cycle coverage passed; previews and forged-manifest exports cannot follow them. This extends the earlier root-replacement test.

No release or full-P0 signoff is implied; the broad M2 gate and remaining native fault/performance evidence still need closure.

## Faster native UI tests and M2 gate followup

User requested reducing desktop automation. Luna added actual WebView2 Playwright attachment using owned synthetic settings/source/profile/app copy and loopback-only CDP. No dependencies, production hooks or IPC mocks. Independent Sol review clear; root corrected unit-test discovery and included native/browser tests in typechecking. Full frontend checks passed:25RTL/7browserE2E/2nativeE2E, typecheck/lint/build. Native suite9.8s total;605-entry launch→Copy-ready1,445ms. Dialogs and clipboard-byte comparisons remain separate native smoke evidence.

Broader M2 review confirms one pure selection engine, explainable DTOs, proportionate modules/index ownership and no necessary framework refactor. It found valid complex custom globs can panic inside globset's infallible matcher API before persistence limits apply. Sol reproduced200kB valid pattern panic using installed MSVC artifact. Fallible policy compilation and explicit aggregate/per-rule/count bounds are being implemented. Truth-table and exact ignored-parent-negation parity fixtures are also being added before the gate closes.

2026-10-08: charter/environment exploration delegated to Luna.

## M1 correctness / M2 architecture — 2026-10-08

Independent GPT-6.1 Sol review; supplementary Luna review and root reproduction. One pure selection evaluator and proportionate core/shell/UI boundaries confirmed; full gate is not yet closed.

| Severity | Finding | Disposition/evidence |
|---|---|---|
| High | Root path reopen could redirect later reads | Pinned capability; preview/export/refresh share it; Windows regression passes (handle prevents rename on host) |
| High | Forced child discovery lost custom parent exclusion | Inherited soft reasons/targeted traversal; regression failed with two files before fix, passes with only forced file |
| High | Policy editor not hydrated from saved settings | Fixed; policy echoed in view and 15-test RTL suite includes hydration regression |
| High | Persistence error could leave backend/UI diverged | Fixed; persist candidate before publication; native failed-save regression passes |
| Medium | Incomplete directory's own status omitted from partial state | Fixed; force-discovery test asserts incomplete+partial |
| Medium | Default native window clipped export controls | Fixed; persistent footer; 3 browser E2E include compact layout; native screenshot captured after restart |

Validation at initial checkpoint: 30 core + 3 native shell tests, 15 RTL + 3 browser E2E passed; native picker/preview/copy/file export demonstrated. No macOS host. Performance measurements now recorded separately; remaining P0 breadth and IPC work pending. Not release signoff.

## In-root export design review

Independent Sol read-only review recommends pinned, nofollow destination parent; atomic no-clobber hard-link publication for new in-root output; no replacement of existing in-root paths; persisted final-output reservation and reserved temporary prefix; reservation bound to captured root/generation. Implemented and tested. Subsequent reviews fixed cancellation after flush, post-publication cleanup semantics, canonical case spelling, and a stale canonicalization/junction replacement race. Deterministic race regression passes; final Sol source review found no material findings.59 Rust tests, strict Clippy/fmt/native build green. Native in-root output and repeated copy/relaunch verified separately.

## Recovery and visible outcomes

Luna implemented bounded settings recovery. Root review found unbounded backup copying; bounded to4MiB+1/16name attempts, reject oversized originals. Independent Sol review found oversized saves could create unloadable settings; shared4MiB limited writer and prior-file-preservation test fix this. Native save-block regression observed RED then GREEN. Recovery wording now correctly distinguishes blocked manual recovery. Final core source review closed.

Native smoke found successful outcome hidden in a clipped live region. Luna made it visible; independent review then found errors behind footer and narrow notice overlap. Shared notice/footer dock fixes both; actual browser geometry test observed RED then GREEN (18RTL/5E2E checkpoint). Long unbroken paths need wrapping; included in upcoming frontend paging slice. Search-revealed folders now announce actual expansion and preserve prior disclosure state. Raw filter drafts fix commas being lost during typing; extensionless sentinel supported and tested.

## Folder ordering and bounded fences slice

Independent Sol diff review: no remaining material findings. Found cancellation missing during unbounded fence emission; fixed with checks every 4 KiB and deterministic writer-triggered cancellation regression. Reviewer independently ran 13 workspace/Git fixture tests. Root ran 39 workspace Rust tests, formatting and strict clippy; frontend typecheck/lint/build, 15 RTL and 3 browser E2E all passed. Long-fence/tag and folder-order tests were observed RED before implementation. Native screenshot uses the previous successful binary; current core behavior is proven by automated tests, not that screenshot.
