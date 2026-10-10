# ContextPick — Product & Engineering Build Charter

> **Status:** Authoritative specification, version 1.1
> **Prepared:** 2026-10-08; approved desktop UI and extension-policy revision 2026-10-09
> **Working product name:** ContextPick — *Select code. Export AI context.*
> **Audience:** Codex root orchestrator, delegated coding/review agents, human maintainers
> **Purpose:** Build a reliable, lightweight, open-source Windows/macOS desktop application from an empty repository, incrementally, with short feedback loops and long-horizon architectural integrity.

---

## 0. How to use this charter

**This is a product contract and a direction of travel, not permission to implement everything at once.** A Codex agent must use it to establish a small working product and then advance through independently testable, reviewable vertical slices. It must continue iterating after reviews unless a genuine human decision or unsafe external action is required.

At first start, the root agent shall:

1. Inspect the actual working tree and development environment. **Do not assume the repository is empty or overwrite existing work.** If empty, scaffold it. If not empty, assess existing code and preserve worthwhile work.
2. Read this charter, identify the current delivery state, and bootstrap the small operational documents described in §12. Do not stuff the entire charter into every subagent prompt.
3. Confirm currently installed toolchain versions and up-to-date Tauri/Codex interfaces. If documentation conflicts with this charter on APIs or configuration syntax, follow verified vendor docs and record the adaptation in an ADR.
4. Define the smallest end-to-end vertical slice, document acceptance tests, implement test-first, demonstrate a running UI, perform an independent review, fix material findings, and update progress.
5. Repeat, using the milestone ordering in §11, until MVP acceptance criteria in §10 are met. Then continue toward the release-ready criteria unless explicitly stopped.
6. Never claim something is built, tested, packaged, performant, reviewed, or working on an operating system without corresponding evidence.

### Authority and change rules

- **Non-negotiable product behaviours and constraints** in this charter are requirements. They may be changed only with a documented reason, impact assessment, tests, and a deliberate product-level decision. Do not silently weaken them because implementation is awkward.
- **Recommended implementation details** are defaults, not dogma. Validate them against small spikes and substitute better-supported solutions when justified. Document consequential deviations in an Architecture Decision Record (ADR).
- **Later/peripheral features** are not part of MVP acceptance. Do not jeopardize core quality or delivery by starting them early.
- Keep the product usable at each milestone. Architecture can evolve; the core domain semantics and safety invariants must remain correct.
- Resolve ordinary implementation choices autonomously. Escalate only truly consequential, ambiguous product trade-offs, licensing problems, credential/signing requirements, destructive actions, or irreversible external releases.

## 1. Product vision and sharp success definition

**Problem:** Developers using ChatGPT, Gemini, and other AI tools often need to provide a selected portion of a local codebase as context. Manually aggregating files is slow; dumping a repository wholesale includes irrelevant, ignored, generated, or sensitive material and makes context size hard to control.

**Primary job to be done:** Open a local project, visually select exactly the text files that matter, understand why files are included/excluded and roughly how much AI context the selection represents, then produce a deterministic Markdown export or clipboard copy.

**Core promise:** *Select code. Export AI context.*

**Target user:** Individual developers and technical leads handling local Git repositories, including large monorepos. No AI account or internet connectivity is necessary.

**Success means all of the following:**

1. On both Windows and macOS, a user can open a local folder and navigate a responsive directory tree while ignored or excluded content is visibly distinguished.
2. Git ignore processing, the text/extension eligibility mode, folder/file selection and explicit overrides behave deterministically. A file's status is explainable; changing a global filter does not destroy prior explicit choices.
3. The application exports the selected textual files to valid, deterministic, well-labelled Markdown, correctly handling nested code fences and pathological file paths. Copy-to-clipboard is available.
4. A prominent **estimated export bytes, selected-file count, and estimated token count** update as selections and files change, without rereading the whole repository synchronously. Estimates are clearly labelled; actual export size is measured and reported.
5. Scanning, preview, watchers, token analysis and exports are cancellable or bounded. Ignored subtrees are not recursively walked merely to display a muted folder. The UI never freezes waiting on filesystem work.
6. The app works offline, reads user source files without modifying them, and does not silently transmit code, collect telemetry, or access network services.
7. A reproducible clean build, tests and downloadable Windows/macOS installers exist; required signing/notarisation is documented honestly and handled before claiming a broadly distributable macOS release.
8. The codebase is easy for a new developer or agent to understand: few abstractions, pure domain rules, isolated platform adapters, documented architecture and meaningful regression tests.

**Failure means any of the following:** correct-looking UI with incorrect exports; wrong `.gitignore` semantics; selections unexpectedly reset; unchecked memory growth or long blocking scans; only screenshot-mocked functionality; no end-to-end proof; claiming cross-platform success based only on one OS; unchecked expansion into an AI-agent platform; or chronic architectural duplication.

### Explicit non-goals for MVP

No cloud backend, authentication, payments, subscriptions, embeddings, model calls, generated summaries, dependency graphs, remote repositories, MCP server, collaborative workspaces, rich code editing, multi-project workspaces, autonomous model selection of files, or full IDE integration. Do not introduce a database, server, account system, or plugin platform without a measured need.

## 2. Product scope and priority legend

- **P0 / critical:** Must work correctly to ship the MVP. Build and test before expanding scope.
- **P1 / important:** Necessary for a polished, reliable first public release, but may follow the functional MVP.
- **P2 / later:** Valuable differentiators after proven real-world usage.
- **OUT:** Explicitly outside scope unless requirements are changed.

### Requirements matrix

| ID | Priority | Requirement | Observable acceptance |
|---|---|---|---|
| WS-01 | P0 | Choose one local workspace root with native directory picker | Root path displayed; empty/cancelled picker safe |
| WS-02 | P0 | Expandable directory tree with folders before files | Nested navigation and stable path identity |
| WS-03 | P0 | Directories and files visually show effective selection | Included, excluded, partial, ignored, force-included distinguishable |
| WS-04 | P0 | File and folder selection; inherited intent | Folder choice applies to eligible descendants; nearest explicit choice resolves conflicts |
| WS-05 | P0 | Explicit per-file/folder force-include and force-exclude | User can override filters intentionally; reason is displayed; safety still enforced |
| FL-01 | P0 | Toggle `.gitignore` policy | Both states tested on nested ignore fixtures; explicit user intent persists |
| FL-02 | P0 | Text eligibility and include-only extension policy | Empty extension allowlist keeps existing default text classification; nonempty values restrict eligible files; normalization, extensionless files and mixed-case suffixes are deterministic; no extension-exclusion policy remains active |
| FL-03 | P0 | Explain every exclusion | UI displays effective reason and source rule when known |
| FL-04 | P0 | Hidden files and `.ignore` policy explicit | No accidental undisclosed matcher defaults |
| SC-01 | P0 | Fast, bounded metadata-first scanning | No eager full-file loading; no synchronous UI scan |
| SC-02 | P0 | Prune ignored subtrees; show muted placeholders | `node_modules/` not recursively scanned by default |
| SC-03 | P0 | Safe symlink/permission handling | No infinite traversal; outside-root traversal prohibited by default |
| TX-01 | P0 | Determine text eligibility cheaply | Known extensions + sample/sentinels + decode validation; binary never silently exported |
| TX-02 | P0 | Preview selected text file | Size-capped read; non-text/unreadable has an explanatory state |
| EX-01 | P0 | Streaming Markdown export | Stable relative paths, valid fences, ordering, encoding, and content |
| EX-02 | P0 | Clipboard export | Copy outcome and errors displayed; large selections handled safely |
| EX-03 | P0 | Errors and partial export are explicit | Never silently omit files; clear result report |
| MT-01 | P0 | Live metadata-based byte estimate | Selection changes update promptly; no full reread |
| MT-02 | P0 | Clear selected count + status | Correct when directories are only partly enumerated |
| PR-01 | P0 | Persist filters, selection overrides, most recent root | Restart restores state safely |
| QA-01 | P0 | Unit/integration/E2E and CI baseline | Critical domain contract fixtures pass; interactive app smoke-tested |
| RF-01 | P1 | Automatic filesystem monitoring + recovery | Changes observed; focus/wake/manual fallback and watcher-error status |
| MT-03 | P1 | Token estimate with selected local tokenizer | Background, cached, model-labelled and explicitly approximate |
| UX-01 | P1 | Virtualised tree, keyboard controls, accessibility | Usable with large visible trees and keyboard |
| UX-02 | P1 | Filename/path search, tree filtering | Search doesn't accidentally change selection |
| PR-02 | P1 | Named selection profiles | Save/load independently of transient UI state |
| RF-02 | P1 | Signed/notarised release strategy and artifacts | Release checklist and tested binaries for target platforms; the approved Windows Microsoft Store route uses an identity-correct MSIX, and is accepted only after Store certification and end-user installation are verified on supported Windows 10/11 targets. See M5.7 in the roadmap for staged acceptance gates. |
| SC-04 | P1 | Robust rename, watcher overflow and cache invalidation | Dedicated integration tests |
| SE-01 | P1 | Warnings for common secrets and private keys | Confirmation before intentional sensitive export |
| UX-03 | P1 | Collapsible/resizable preview and splitter | Preview can collapse/restore; export controls remain visible at supported window sizes |
| UX-04 | P1 | Compact desktop shell with collapsible sidebar, minimal Settings destination and persistent footer | Workspace toolbar displays canonical Windows paths in familiar drive/UNC notation; internal canonical paths remain unchanged. Toolbar, sidebar, tree, read-only preview and estimates/actions fit one window; panes scroll independently; Settings adds no speculative preferences; no marketing/dashboard chrome |
| UX-05 | P1 | All / Selected / Ignored file views | Views filter one indexed workspace and one selection state; Ignored means Git-ignored; unknown counts stay partial |
| UX-06 | P1 | Main-pane filter editor and compact two-mode eligibility picker | Sidebar Filter opens in the main work area; `All text` or `Selected extensions` replaces free-form/path-rule editing; common suffixes fit in a categorized multi-column grid without scrolling; no Apply button; eligibility and estimates update after a short debounce; keyboard focus and pending/error states remain clear |
| UX-07 | P1 | Legible tree hierarchy | Children are visibly indented from parents with subtle connector guides; expansion, virtualization, selection, keyboard navigation and supported window sizes remain correct |
| MT-05 | P1 | Per-folder discovered file-size totals | Folder rows show human-readable logical-byte sums for safely discovered regular files, whether selected or eligible; derive bounded totals from indexed metadata once per immutable scan snapshot, reuse them for selection-only views, and show partial/unknown state for pruned or unscanned descendants. Existing watcher coalescing, debounced refresh and generation cancellation govern updates; totals appear together, so no separate prioritized size worker is needed. |
| PR-03 | P1 | Optional fixed export folder | User can enable a persisted destination folder in Settings or keep Save As; fixed-folder export uses a safe workspace-derived `.md` name and never overwrites a source or escapes the chosen destination |
| PR-04 | P1 | Optional repeat overwrite for fixed exports | A separate, disabled-by-default preference allows every export to replace the same workspace-named output file without another prompt; when off, collisions receive a safe non-overwriting suffix |
| EX-04 | P1 | Explain fixed export target before use | Hover/focus on Export Markdown explains the exact target and whether each export will replace it; destination and failures are reported truthfully |
| DOC-01 | P1 | Product-facing README and current download link | README explains the local workflow and supported use, labels preview version accurately, and links to verified public release assets without promising AI outcomes or universal file caps |
| DOC-02 | P1 | Public GitHub Pages product site | A polished, accessible long-form product page at `docs/index.html` explains the product, workflow, benefits and limitations with real screenshots and current download links; it is served at the repository’s GitHub Pages URL |
| BR-01 | P1 | Approved ContextPick vector brand and application icons | Editable path-based SVG artwork matches the approved logo; generated platform icons remain legible at required sizes and are used by the app |
| MT-04 | P2 | User-defined token budget/indicator | Budget warnings without false exactness |
| GI-01 | P2 | Git changed-files selection | Optional status-based selection; Git CLI/library compatibility verified |
| CLI-01 | P2 | Headless CLI using same Rust core | Can export from a persisted profile without GUI |
| SE-02 | P2 | Full local secret scanning | Extensible scanner and false-positive UX, no external transmission |
| OPT-01 | P2 | Code compression/alternate output formats | Only when demand and quality tests justify |
| AI-01 | OUT | AI relevance ranking or chat inside app | No implementation in MVP |

## 3. User experience and interaction model

### 3.1 Primary layout

Use the approved compact desktop layout shown in [`docs/design/design-draft.png`](design/design-draft.png): a compact workspace toolbar; a narrow, collapsible left sidebar for All / Selected / Ignored views, workspace filters and a minimal Settings destination; a searchable, virtualised file tree as the main work area; a secondary read-only preview; and a persistent bottom bar for selected-file count, estimated export bytes, honest token-estimate state, Copy and Export. Keep panes independently scrollable and adapt at the supported minimum window size. No obligatory onboarding wizard, marketing hero, dashboard cards or full-window scrolling.

Header: approved ContextPick mark/wordmark, chosen local workspace path, Change Folder and Refresh. Show only real scan state; do not invent watcher status.

Sidebar: mutually exclusive All / Selected / Ignored views and a Filter destination; selecting Filter opens the editor in the main work area. Settings contains the optional fixed export-folder preference. Selected and Ignored are projections over the same workspace index, not separate selection stores. Ignored means `.gitignore` policy only.

Tree: search bar; disclosure arrows; tri-state checkboxes; file/folder icons; selected/excluded/muted styles; reason detail; counts only when known. Existing domain and bridge results remain authoritative.

Preview: filename, relative path, file size and eligibility, bounded text content, truncation notice, non-text/unreadable/no-selection states. Preview is read-only, not an editor.

Footer: selected eligible file count, estimated Markdown bytes, and token estimate or an honest `Unavailable` / `Calculating…` state. `Copy` and `Export Markdown` use the same effective selection and existing export result reporting. Do not imply a tokenizer exists until MT-03 is implemented.

UI states must be designed for: no folder chosen; empty folder; scanning; scan cancelled; watcher unavailable; binary file; unknown encoding; permission denied; stale index; profile changed; large file; export errors. Don't replace explanatory states with blank space.

### 3.2 Key user journeys

**Journey A — simplest:** Open directory -> default rules select ordinary textual source files -> see counts -> export Markdown -> open or copy destination path.

**Journey B — focused context:** Expand `src`; select `src/services`; exclude `src/services/__tests__`; force-include one generated schema; inspect size changes; export only the effective selection.

**Journey C — ignore inspection:** `.gitignore` enabled -> `node_modules` shown as muted folder, not expanded or enumerated -> request *Browse ignored files* -> expand lazily, force-include one named text file -> see unmistakable override and security/size implications.

**Journey D — daily use:** Leave app open, edit files in IDE, watch status becomes `Updating...`, counters converge, export uses current file state. Manual refresh available.

**Journey E — save/reuse:** Configure filters and folder choices; close and reopen app; choices persist. If paths disappear or rename, display stale choices without crashing and prune only with user intent or a documented policy.

### 3.3 Selection appearance and accessibility

Five conceptual states: Included, Excluded by user, Partially selected, Filtered/ignored (muted), Force included (distinct badge or marker). Selection and eligibility must not be conflated. Use icons/labels as well as colour. A directory with unknown, unexpanded excluded descendants must not display false exact child counts.

Check a normal folder -> select **eligible** descendants, not indiscriminately bypass policy. Uncheck folder -> exclude descendants by inherited intent. Use a named menu command (not an ambiguous checkbox) for `Force include despite filter`. Display why a file is filtered: e.g., `.gitignore (dist/)`, `extension not selected`, `binary`, `unreadable`, or `size policy`. Provide `Reset override` and `Reset selections to defaults` separately.

Keyboard navigation should cover tree expansion, selection, search, filters, and export. Follow WCAG-relevant desktop UI principles: focus rings, accessible labels, non-colour-only states, screen-reader announcements for scan/export results, and sensible tab order.

## 4. Domain-driven design: bounded contexts, models and invariants

**Start with DDD in a pragmatic form**: ubiquitous language, domain invariants, explicit entities/value objects, pure policies and ports. Do **not** create an elaborate enterprise stack, event sourcing platform, microservices, or one repository/interface per small class. Keep complexity proportional to the domain.

### 4.1 Ubiquitous language

- **Workspace:** One user-selected root directory, with a stable workspace ID derived/stored locally.
- **Tree entry:** File or directory identified by a normalised relative path under the workspace (with an internal platform-safe identity).
- **Eligibility:** Whether a file may be included under technical constraints and the active filters.
- **Selection intent:** User's explicit include/exclude instruction for a path or subtree; distinct from effective selection.
- **Override:** An intentional bypass of ordinary filtering, subject to hard safety checks.
- **Effective selection:** Pure evaluation of eligibility, inherited/user intent and overrides at a version of the workspace index.
- **Policy:** Git-ignore handling, text/extension eligibility, safety limits, text classification and hidden-file handling.
- **Scan generation:** Immutable version token for one index update; stale generations cannot publish UI state.
- **Content snapshot / export manifest:** Frozen set of paths, expected metadata and output order used for one export.
- **Estimate:** A labelled, potentially stale or incomplete approximate count of bytes/tokens.
- **Profile:** Persisted selection intentions and policy configuration for a workspace.
- **Export result:** Destination, actual bytes, included files, skipped/changed/error entries, completion status.

### 4.2 Bounded contexts and their responsibilities

| Context/module | Owns | Must not own |
|---|---|---|
| Workspace Discovery | Root validation, directory enumeration, metadata, snapshot/index, lazy placeholders | Checkboxes, UI components, Markdown |
| Selection & Policy | Explicit path-based user intent, extension eligibility, ignore decision, reason resolution, effective-selection aggregate | Filesystem I/O, React state, export writing |
| Content & Export | Text classification adapter, bounded preview, streaming encoding, manifests and Markdown formatting | Selection UI, persistence implementation |
| Context Metrics | File byte aggregates, approximate token counts, caches, freshness | Deciding which files user selected |
| Change Monitoring | Watcher events, debounce, generation invalidation, rescan requests | Direct UI mutation or source edits |
| Preferences & Profiles | Versioned local settings, schema migrations, profile persistence | Rule policy calculation |
| Desktop Presentation | Tree, preview, filters, progress, status, dialogs, copy/export interactions | Source-of-truth file rules or recursive scans |

Bounded contexts may live as Rust modules/crates in a small workspace; there is no need for a crate per entity unless compilation/dependency boundaries benefit. React has presentation components, view models, and typed commands; it does not duplicate domain logic.

### 4.3 Suggested domain entities/value objects

`WorkspaceId`, `WorkspaceRoot`, `RelativePath`, `TreeEntry`, `FileMetadata`, `WorkspaceIndex`, `SelectionProfile`, `SelectionIntent`, `FilterPolicy`, `IgnorePolicy`, `EligibilityDecision`, `SelectionDecision`, `ExclusionReason`, `TextDetectionResult`, `ContentSnapshot`, `ExportManifest`, `ExportOptions`, `ExportResult`, `SizeEstimate`, `TokenEstimate`, `ScanGeneration`, `WatchStatus`.

Prefer one explicit typed result that explains selection over multiple independent booleans that may contradict each other. Example conceptual API, not binding syntax:

```text
evaluate_selection(path, entry_metadata, inherited_user_intent, policy, overrides)
  -> { is_eligible, is_selected, is_force_included,
       reason_code, matched_rule?, requires_confirmation? }
```

### 4.4 Selection precedence (normative semantic contract)

1. **Hard safety/technical guard:** A path outside the workspace, unresolved unsafe link, directory masquerading as file, unreadable content or confirmed binary data cannot be exported. An override does not bypass hard guards.
2. **Explicit force-exclude** a path always excludes it. For a directory, descendants inherit exclusion except where a more specific descendant intent exists **and its ancestor is safely traversable**.
3. **Explicit force-include** bypasses *soft* Gitignore and extension eligibility for a chosen target/subtree; it never bypasses hard guards. If conflicting explicit intents exist, the *most specific path wins*; at identical specificity the latest user action wins.
4. **Ordinary inherited manual include/exclude** selects/unselects only eligible content. Nearest explicit path decision wins; absent any decision use workspace/profile default.
5. **Include-extension allowlist**, then **Git ignore rules**, then default text eligibility define *soft eligibility*. Empty extension selection means all otherwise eligible text. The filter UI has no custom include/exclude path or extension-exclusion rules; folder and file selection express user intent. Extensionless and dotfile behavior is explicit.
6. If no manual intent is present, default **include eligible textual files**; files with uncertain type remain pending/excluded until validated. Make default conservative, configurable, and visible.

The implementation should formalise the above into a **truth table** and property tests; do not attempt to infer these semantics ad hoc from checkbox events. Folder checkbox state is derived, not persisted as UI-specific state.

**Special directory rule:** A force-included child inside an ignored directory requires explicit discovery of its ancestor path; don't recursively enumerate every skipped subtree to locate hypothetical overrides. Persist explicit user selection intent and open only necessary ancestors. If a parent is excluded from traversal by a *hard* safety rule, no descendant may be exported.

**Nested Gitignore rule:** Use real Git-compatible semantics for slash anchoring, `!` negation, nested rules, ignored-parent constraints, global and repository excludes where configured, and paths outside Git repositories. Git negation does not by itself guarantee discovery beneath an excluded parent; explicit *user* force include is a separate feature. Include fixtures compared to `git check-ignore` where meaningful. `.ignore`, hidden files, `.git/info/exclude`, global ignore and parent ignore have **separate explicit toggles** or explicit documented defaults; do not silently inherit all defaults of the chosen library.

### 4.5 Essential invariants

- A hard-rejected file never appears in the export manifest, even if force included.
- Effective selection is determined from **saved intent + current rules + current index**, never from CSS, rendered rows or stale checkbox states.
- Toggling Gitignore off and back on does not delete any manual intent.
- Included-file count describes *known and selected* files only; excluded unenumerated subtrees do not produce invented counts.
- Every exclusion reports the winning reason and, where available, the exact matched pattern/source.
- Exporting the same unchanged manifest with the same options produces byte-for-byte identical output.
- All paths in an export are workspace-relative with a canonical, cross-platform presentation convention (`/` separators); export order is stable.
- Stale scan generations never overwrite newer selection, metrics or tree state.
- Files are read only for sampling, preview, analysis or export; no workspace source file is modified by the application.

## 5. Native scanning and filesystem behaviour

### 5.1 Scanning strategy

Start metadata-first. Record paths, types, sizes, modification times, stable IDs when available, text classification status, filtering reasons and tree structure. **Do not read every file's contents on initial scan.** Virtualise the visible tree in React and page/batch results across the Tauri command/event bridge rather than serialising an enormous index in one call.

Use `ignore` crate matching where appropriate (not a handwritten Gitignore parser). Its `WalkBuilder`, `Gitignore`, and incremental matcher APIs are useful, but the app needs a custom *presentation tree* so ignored directories can be represented as muted placeholders. A pure `WalkBuilder` result stream alone will not expose every pruned directory. Investigate exact crate behaviour in a spike before committing to an adapter.

- Skip symlink traversal by default; show symlink with status, optionally allow deliberate file-target reading only when it resolves *inside* the root and policy permits. Handle junctions/reparse points on Windows and Unix symlinks on macOS.
- Avoid traversal above the selected root, via symlink, `..`, absolute-path injection or export-path alias.
- Decide and document case sensitivity according to filesystem reality, not OS name alone (macOS may be case-sensitive). Avoid path identity collisions and encoding loss, including non-UTF-8 filesystem names.
- Prune obviously ignored/unselected directories rather than descending. Show a placeholder row and a `Browse ignored files` action for intentional lazy exploration. Counts are `unknown` until visited.
- If there is a saved override for a deep path inside a pruned directory, explicitly traverse only required ancestors and selected targets, validating every step.
- Work queues use bounded concurrency, cancellation tokens, generation IDs and backpressure. Avoid an unbounded asynchronous task per file.
- Surface partial scan failures in the UI and diagnostics, without crashing the whole workspace.

### 5.2 Text detection and preview

Text eligibility is a staged classification:

1. Known text filename/extension or known binary signature/extension provides a cheap *candidate*.
2. For uncertain candidates, bounded sample read (suggest ~8–16 KiB; tune by benchmark) checks BOM, NUL-byte patterns, common binary signatures and encoding validity.
3. Full decoding is confirmed during export. No candidate classification guarantees successful complete read.

Support UTF-8 and BOM-marked UTF-8/UTF-16 in v1; choose explicit handling and warnings for unmarked legacy encoding (do not silently mangle characters). Extensionless text files, dotfiles, Dockerfiles, source and Markdown must work. `*.png` and arbitrary binary named `*.txt` must not pass export silently. Use an existing, maintained heuristic library if helpful; measure it on representative fixtures.

Preview reads on demand only, respects a configurable safe cap (suggest 256 KiB initially), displays truncation without implying the source itself is truncated, and cancels stale requests when selected file changes. A preview must never lock a large source file or freeze the UI. Syntax highlighting is optional and should be lazy-loaded; plain monospaced text is fine for MVP.

### 5.3 Change monitoring

The watcher is a **hint source**, not an infallible database. Use a cross-platform library such as `notify`, debounce and coalesce related events, update affected directories, and invalidate cached metadata/tokens. Add recovery on focus, wake, watcher errors and overflow; maintain a manual Refresh button. Avoid expensive rescans for each keystroke/save event.

Version rules and index updates: a change to `.gitignore` or filters invalidates the affected matcher/subtree; a file change invalidates that file's size/type/token entry; a rename moves or invalidates path-bound selection deliberately according to a documented policy. **The default policy is path-based saved intent**: a rename does not silently transfer a selection to an unrelated new path; a moved file may optionally be detected/relinked later. Test for a rapid succession of changes while a scan and export are in progress.

## 6. Metrics and export contract

### 6.1 Live estimates

Display at least: selected eligible file count, estimated Markdown output bytes, and estimated token count (token count becomes P1 if a real local tokenizer is not present in first functional slice). Use explicit labels: `Estimated`, `Calculating`, `Stale`, `Unavailable`; don't present a fabricated precise count.

**Fast path:** Maintain file metadata and per-directory aggregate contributions (count, bytes and known/unknown status). Selection changes should update the affected aggregate, not trigger a synchronous content reread. Add the formatting overhead for headings/fences, clearly approximate until measured. Aggregate correctness matters more than micro-optimisation; start with a simple incremental implementation proven by tests, then benchmark.

**Refinement:** Background tokenizer per file or chunk; cache keyed by workspace identity + normalised path + file metadata + tokenizer ID (optionally content hash if collisions matter). Do not hash every file on initial scan. Tokenisation across concatenation boundaries may differ, so sums of per-file tokens remain estimates; during/export after concatenation an optional exact count for the chosen tokenizer can be measured if feasible.

Tokenisation is provider/model-specific. Default to a labelled local tokenizer supported by an appropriate Rust crate; don't pretend the same number is exact for ChatGPT, Gemini and every model. Export never requires internet access or a model API key.

### 6.2 Markdown representation

Required format, conceptually:

``````markdown
# Repository Context

Root: <workspace display name>
Selected files: <count>

## `src/services/catalog.ts`

````typescript
// original UTF-8 code here
````

## `docs/overview.md`

````markdown
# Overview
````
``````

**Format implementation requirements:**

- All source paths are canonical **relative** paths, never leaked absolute home-directory paths by default.
- Stable, predictable sorting independent of scan iteration order.
- Language tag derived safely from known extension where appropriate, otherwise plain; never inject untrusted file names into raw fence delimiters.
- Generate a code fence longer than the longest run of relevant backticks in file contents (or use a verified alternate delimiter), so embedded Markdown cannot prematurely terminate a source section.
- Preserve source text semantics; specify UTF-8 output, newline normalisation, BOM behaviour, final-newline handling. Do not silently trim or summarise code.
- Escape special characters in headings/paths; ensure file content cannot structurally break the envelope.
- Streaming buffered write with bounded memory; export using a manifest and per-file read/validation, not one giant in-memory string.
- Output path excluded from scanning even if inside chosen root; prevent direct/indirect self-inclusion and accumulation across repeated exports.
- Write through a temporary sibling file; flush and atomically replace/rename where supported. Handle errors and clean up temporary files. Respect overwrite choices; don't destroy a destination unannounced.
- Record actual export bytes, successful files, changed files, unreadable files and any skips in structured `ExportResult`. On partial export, use an explicit warning and never silently report success.
- Clipboard export should have a reasonable size safety threshold/warning; any implementation-specific size caps must be documented. Use tested native clipboard integration.
- The output must never execute source code or follow source instructions; it is literal text packaging.

### 6.3 Snapshot correctness

At export start, freeze a deterministic manifest for a particular index/config generation. Revalidate each source before reading. If metadata changes during export, choose and document one reliable strategy: retry once and record the actual version read, or fail/mark partial with clear diagnostics. Do not assert perfectly atomic repo snapshots without filesystem snapshot support. If the user's source changes mid-export, expose that fact rather than silently producing inconsistent evidence.

## 7. Performance, robustness and accessibility acceptance

The following are **initial engineering targets, not measured claims**. Run reproducible benchmarks on local SSDs and real projects, and adjust only with documented evidence.

| Area | Target / test |
|---|---|
| UI responsiveness | No blocking synchronous native work on rendering thread; target visible input response <100 ms under normal load |
| Initial tree | For a ~20,000-entry representative project, a usable partial tree in a few seconds on an SSD; progressively disclose scanning |
| Large repo | Benchmark ≥100k files, including ignored dependency trees, with bounded peak memory |
| Very large ignored subtree | 100k simulated entries beneath ignored directory must not all be walked for collapsed display |
| Tree rendering | Virtualise rows; expanded 10k-row tree remains scrollable and interactive |
| File type | Small bounded sample, no eager full repo reads |
| Preview | Default cap; stale preview cancellation; non-text state |
| Selection | No full deep traversal solely because a checkbox was toggled |
| Export | Streaming bounded-memory test with large generated source contents; deterministic fixture snapshots |
| Watch | Burst events coalesced; overflow/focus/manual recovery tests |
| Stability | Corrupt settings, unreadable files, interrupted export, malformed ignore rules, inaccessible volumes handled gracefully |
| Accessibility | Keyboard navigation, focus, readable contrast, non-colour state semantics |

Collect timings and peak RSS through a small repeatable benchmark harness with disposable fixture generators. Benchmark **cold vs warm**, scanning vs enumeration, initial load vs visible UI, rule reevaluation, estimates, full export, memory and watcher churn. Record hardware/OS and actual numbers, not invented numbers. Investigate regressions rather than layering caches prematurely.

## 8. Technology choices and engineering trade-offs

**Recommended stack, subject to short initial validation spike:**

| Layer | Default choice | Rationale |
|---|---|---|
| Desktop shell | Tauri 2 | Windows/macOS bundling, narrow native command API, local filesystem/clipboard/dialog integration |
| UI | React + TypeScript + Vite | Fast HMR, AI-assisted iteration, browser-based testing |
| Styling | Tailwind CSS; shadcn/ui selectively | Cohesive UI without writing a design framework |
| UI state | Zustand or small React stores only when needed | Keep interaction state simple; backend is the domain source of truth |
| Tree | TanStack Virtual when needed | Bounded DOM rendering |
| Native core | Rust | Typed, performant scanning/indexing/streaming and cross-platform filesystem handling |
| Git ignore | Rust `ignore` crate | Mature semantics; build presentation adapter rather than reimplementing matcher |
| Monitoring | Rust `notify` | Cross-platform change signals, with recovery logic |
| Async | Tauri-supported async/tasks; bounded queue | Cancellation and responsive command/event APIs |
| Settings | Versioned JSON in OS application config directory | Simple and portable; no database required |
| Tokenisation | `tiktoken-rs` or verified alternative | Background local approximate model-specific token counts |
| Native tests | Rust built-in tests + integration/property tests | Domain rules and filesystem fixture correctness |
| UI tests | Vitest + React Testing Library | Component/view-model behaviour |
| Browser E2E | Playwright with mocked/test command bridge | Fast repeatable UI journeys, screenshots |
| Desktop integration | Platform-appropriate native Tauri testing | Verify picker, clipboard, actual file I/O and packaging |
| CI/release | GitHub Actions / Tauri release tooling | Repeatable checks and installers |

**Decision principle:** Minimise additional dependencies; favour standard libraries and established maintained components. Each new runtime dependency needs a one-sentence reason, maintenance/licence/security check, and removal/alternative cost. Avoid custom parser, custom renderer, custom tokeniser and custom platform wrappers where suitable libraries exist.

Tauri's WebView2 on Windows and WKWebView on macOS can render differently: ensure layout/functionality coverage on both. Don't use a plain browser build as proof that native integration works. The Rust ↔ TypeScript IPC contract should use typed request/response DTOs, generated types if beneficial, explicit error enums and cancellation/progress semantics. Keep Tauri commands thin; no large business rules in command handlers.

### 8.1 Security posture

- Offline/local-first by default; no analytics, remote content upload, telemetry or model calls. No remote code execution by design.
- Follow least-privilege Tauri capabilities: expose only necessary native commands and picker/clipboard permissions; avoid generic unbounded file-management permissions.
- The only default writable target is chosen export destination and the app's local configuration/cache directory; source code is always read-only.
- Treat filesystem names/content as untrusted input. Prevent traversal, link escapes, Unicode/path confusion, oversized reads and unsafe Markdown framing.
- `.gitignore` is a relevance feature, **not a secret-protection system**. Provide filename warnings for `.env`, `.pem`, private keys, credential locations, but avoid promising complete detection. Never auto-export secrets found in a newly unignored subtree without showing selection status and relevant warning.
- No external downloads/updates without appropriate configuration and user trust; automatic updater is P2 and must be signed, not improvised in MVP.
- Never ask Codex subagents to inspect or transmit real personal secrets; all tests use synthetic fixtures.

## 9. Proposed repository structure and ownership

Prefer a **small modular monorepo**; revise if Tauri scaffolding makes a different layout simpler, but preserve boundaries.

```text
/
├── AGENTS.md                       # SHORT operating instructions, generated from this charter
├── README.md                       # user-facing purpose, run/test/build/release links
├── PRODUCT_CHARTER.md              # this document (or equivalent name)
├── package.json                    # scripts for local DX
├── pnpm-lock.yaml                   # chosen single package manager lockfile
├── src/                              # React presentation
│   ├── app/                          # boot, routing/screen composition, providers
│   ├── features/
│   │   ├── workspace/               # picker, location, scan status
│   │   ├── explorer/                # virtual tree, checkboxes, search
│   │   ├── filters/                 # filter controls & reasons
│   │   ├── preview/                 # text preview states
│   │   └── export/                  # status, metrics, copy/export UI
│   ├── shared/                       # only demonstrated reuse: ui/, ipc/, types/
│   └── tests/
├── src-tauri/                        # Tauri shell (keep command handlers thin)
│   ├── src/                          # command bridge, lifecycle, permissions/events
│   ├── capabilities/
│   └── tauri.conf.json
├── crates/
│   └── contextpick-core/
│       ├── src/
│       │   ├── workspace/            # enumeration/index and port
│       │   ├── selection/            # pure policies, intent, reason resolution
│       │   ├── content/              # text classification/preview API
│       │   ├── export/               # manifest/formatter/writer
│       │   ├── metrics/              # metadata/token estimates
│       │   ├── monitoring/           # watcher/reconciliation port
│       │   └── preferences/          # settings domain/serialization port
│       └── tests/                   # integration contract & fixture tests
├── tests/
│   ├── fixtures/                     # synthetic repos: ignores, encoding, links, globs
│   ├── e2e/                          # UI smoke/behaviour journeys
│   └── performance/                  # deterministic fixture generators/benchmarks
├── docs/
│   ├── project/
│   │   ├── STATUS.md                 # durable checkpoint; top-level single status source
│   │   ├── ROADMAP.md                # milestones / priority / acceptance map
│   │   ├── RISK_REGISTER.md          # current blockers and mitigations
│   │   ├── REVIEW_LOG.md             # milestone & architecture reviews
│   │   └── NEXT_SESSION.md           # concise resume instructions
│   ├── plans/                         # one active ExecPlan; completed plans archived
│   ├── adr/                           # numbered architecture decisions
│   ├── architecture/                  # boundaries, domain semantics, sequence diagrams
│   ├── testing/                       # test matrix & performance evidence
│   └── releases/                      # signing/distribution checklist
├── .codex/
│   ├── config.toml                    # scoped Codex model/subagent defaults
│   └── agents/                        # focused scoped roles (if supported)
└── .github/workflows/                 # build/test/quality/release automation
```

Don't create every empty directory or placeholder document on day one. Establish files only when they have a concrete owner/use. Avoid barrel-export webs, duplicate `utils`, large generic frameworks and UI components that take domain decisions. **A named module should have a comprehensible single reason to change.**

### 9.1 Dependency direction

```text
React components -> typed client services -> Tauri IPC DTOs
                                             |
Tauri command adapter -> application use cases -> domain policies/models
                                             |
                  platform adapters (fs, ignore, clipboard, settings, watchers)
```

Domain modules have no React, Tauri or OS-specific dependencies. Application use cases coordinate policy and adapters. Platform adapters implement interfaces/traits only where replaceability/tests genuinely justify them. Do not invert dependencies merely to satisfy an architectural diagram.

### 9.2 Readable-code rules

1. Optimise for the next maintainer: expressive names, short cohesive functions, clear data flow; prefer explicit types and guard clauses over deeply nested cleverness.
2. Single responsibility at the meaningful module/function level. Avoid god components, god services, boolean-argument jungles, and mixing I/O, policy and rendering.
3. Prefer the *simplest implementation that satisfies the present contract*. Do not design for imaginary future platforms or scale without evidence.
4. Use pure functions for rule precedence, path mapping, tree aggregate calculations and Markdown fence selection.
5. No copy-pasted policy logic between Rust and TypeScript; native core decides effective state, UI renders typed results.
6. Avoid verbosity: no redundant comments narrating code, excessive wrappers, interfaces with one implementation without a seam need, giant documentation dumps, or unnecessary generic frameworks.
7. No speculative abstraction: require at least two real use cases or a concrete testability/portability need, otherwise favour a direct function.
8. Use errors as typed outcomes, not broad silent catches. No swallowed exceptions; diagnostics must preserve path/context while avoiding exposing source content in logs.
9. Do not change dozens of unrelated files in a slice. Keep diffs reviewable. Refactor proactively only when reducing actual complexity or enabling the next verified feature.
10. External dependency updates are intentional and documented, not opportunistic rewrites.

## 10. Definition of done and executable acceptance tests

A feature is **done** only when its acceptance contract is demonstrated, not when an agent says it is implemented. The baseline Definition of Done for each vertical slice:

- A short written behaviour/acceptance example exists **before implementation**; it is connected to a requirement ID.
- At least one meaningful test failed for the intended missing behaviour before production code was added or changed (TDD red step), unless the work is exclusively exploratory; record the exception.
- Smallest maintainable change makes the test pass (green), then code is refactored if needed; tests stay green.
- Relevant Rust tests, frontend tests, type checks, formatting/lint and applicable E2E checks run; actual commands/results recorded. CI is green before a milestone is marked complete.
- A separate reviewer agent or separate context has examined the diff for correctness, security, cross-platform paths, selection rules, maintainability, duplication and missing cases. Findings are triaged and high/critical issues fixed.
- User-facing behaviour can be demonstrated in an actually running UI, using synthetic fixture repositories where possible. Screenshot evidence is useful but does not substitute for functional checks.
- Documentation, state files and ADRs updated where behaviour/architecture changed. Unfinished work is clearly marked, not hidden by optimistic completion language.
- The working tree and version control history are clean enough for another developer to resume and understand the change; commits are logically scoped with descriptive messages.

### 10.1 Mandatory contract fixture catalogue

Create disposable synthetic repositories and test these exact classes of behaviour:

1. **Nested `.gitignore`:** root ignores `dist/`, nested ignore of `*.generated.ts`, nested negation, slash-anchored patterns, escaped spaces, and ignore effects when Gitignore toggle switches.
2. **Parent ignored directory:** confirm `!nested/file` does not magically enumerate an ignored parent under normal Git semantics; explicit manual inclusion of a known file is separately supported by controlled path discovery.
3. **Conflicting selection intent:** select root, unselect tests folder, include one specific test file; unselect root, include one nested directory; change filters and restore prior choices.
4. **Eligibility and upgrade migration:** `All text` versus selected extension allowlist, extensionless `Dockerfile`, dotfiles and mixed-case extensions. M5.5.2 migration preserves explicit user intents and selected extensions, backs up and retires legacy path/exclusion rules, informs the user, and is atomic/idempotent across restart and failure.
5. **Ignored large subtree:** generate an ignored subtree with tens of thousands of entries; test enumeration counter proving pruning, not merely checking screen appearance.
6. **Binary/encoding:** UTF-8, UTF-8 BOM, UTF-16LE/BE BOM, CRLF, NUL-containing `.txt`, PNG renamed `.cs`, arbitrary extensionless text and invalid encodings.
7. **Markdown injection/fencing:** source containing triple, quadruple and long backticks; Markdown-like headings; Unicode names; unusual spaces; file paths containing Markdown formatting characters.
8. **Root safety:** link to outside root, symlink/junction cycle, `..`, deleted target, inaccessible directory, invalid/deleted workspace and symlink swap between scan/export.
9. **Export changes:** file modified/deleted after manifest creation, destination already exists, interrupted write, disk full simulation, output in source tree, clipboard failure, empty selection.
10. **Watcher churn:** rapid save events, create-delete races, rename, `.gitignore` change, lost watcher, rapid double refresh, cancellation, focus recovery.
11. **Persistent profiles:** restart, settings version migration, corrupted JSON, stale paths, multiple named configurations (P1) and rename behaviour.
12. **Cross-platform:** Unicode Windows paths, long Windows paths where supported, path separators, case-sensitive vs insensitive FS, macOS permissions, differing line endings and file locks.
13. **Large memory:** huge text file; many metadata-only files; bounded preview, export and tokenisation; UI remains interactive.

### 10.2 Product-level end-to-end acceptance scenarios

**E2E-01 — Quick export:** Given a fixture repo with 10 eligible text files and an ignored `dist/`, when the root is selected, then all and only the 10 eligible files appear in the exported Markdown, in stable relative-path order.

**E2E-02 — Transparent rules:** When a file is excluded by `.gitignore`, it is visibly muted and the reason references the ignore source; disabling Gitignore reevaluates it, re-enabling restores the original policy without losing manual intentions.

**E2E-03 — Manual exception:** When the user explicitly force-includes an otherwise softly excluded text file, it appears in the manifest with an override marker. If it is binary or outside root, export still refuses it and explains why.

**E2E-04 — Deep selection:** When the user selects `src/`, excludes `src/tests/`, and includes one individual `src/tests/sample.ts`, effective selection matches the contract irrespective of tree expansion state.

**E2E-05 — Accurate output:** Exported bytes are valid Markdown; embedded fences cannot break structure; actual exported byte size matches filesystem measurement; all file failures are visible.

**E2E-06 — Ongoing development:** When a file changes on disk while the app is open, the app updates the relevant metadata/preview/count without losing selection, or marks refresh required if watcher coverage is unavailable.

**E2E-07 — Crash/relaunch:** Settings and intentions reload, and a corrupt settings file fails gracefully with a recover/reset action rather than startup failure.

**E2E-08 — Large ignored subtree:** Opening a repository containing an enormous ignored `node_modules/` stays responsive and does not enumerate every entry. Lazy browse remains opt-in.

### 10.3 MVP release gate — strict and binary

The **functional MVP is complete only when** all P0 requirements in §2 are either (a) demonstrated with passing automated and manual tests, or (b) explicitly reclassified with an ADR and human-approved product change. All E2E-01 through E2E-05 and E2E-07/08 pass. The README contains working developer setup, build/test commands and a sample export. At least one target-OS native build is actually smoke-tested; state platform gaps without falsely saying both are complete.

The **public desktop release is complete only when** the additional P1 reliability, token-estimate, watching, UX and packaging gates selected for v1 are met; signed installer status and macOS notarisation are verified or correctly documented as unavailable. Do not label a local dev binary “public-ready.”

## 11. Adaptive roadmap: vertical slices, reviews, and decision gates

**No waterfall.** Treat this entire charter as the backlog and invariant contract, but implement **one small user-visible capability at a time**, with tests and inspection. Milestones are gates, not fixed-duration phases. Reorder work when new evidence warrants it, recording why; never silently drop critical scope.

This section defines the high-level milestone intent. Current milestone states, task checkboxes, dependencies and implementation acceptance are maintained only in [`docs/project/ROADMAP.md`](project/ROADMAP.md); do not maintain a second execution checklist here.

### M0 — Discovery, feasibility, architecture sketch

**Deliver:** Running minimal Tauri 2 + React app; Rust core skeleton; `AGENTS.md`; short status/roadmap; first ADR; automated test commands in CI. Validate native picker, OS paths, typed IPC, core testability and development HMR. Compare feasible alternatives briefly and explicitly choose stack. No premature styling.

**Gate:** A dev can clone, install dependencies, run the app, run both Rust/UI tests and understand core boundaries. Stop adding tools if tooling cost exceeds value.

### M1 — First real vertical slice: folder → files → export

**Deliver:** Native folder picker, metadata scan, basic visible tree, selectable text files, minimal preview, streaming deterministic Markdown export and clipboard copy; first real fixture E2E. No elaborate rule editor yet. Basic UI should look deliberate, not be a disconnected demonstration.

**Gate:** Real source files from a synthetic repository produce correct Markdown. Export does not block rendering or mutate source. Independent correctness review, then refactor if needed.

### M2 — Selection domain and filtering semantics

**Deliver:** Pure policy/intent engine, folder inheritance and tri-state results, extensions/globs, Gitignore semantics, muted placeholders, force-include/exclude, matched-reason UI, persistence. Exhaustive truth-table, fixture and property tests.

**Gate — architecture review #1:** Verify **there is exactly one selection implementation**, policy is separate from enumeration and React, reason resolution is deterministic, and storage schema can evolve. Review alternatives only if a measured pain point exists. Fix structural problems before more features.

### M3 — Live size, polished browsing and text preview

**Deliver:** Incremental metadata aggregates, prominent estimate panel, responsive virtualised tree, search, bounded preview, sensible empty/error states and accessibility baseline. Tokenisation may initially remain `estimated from bytes` with honest label until local tokenizer is implemented in P1.

**Gate:** Main workflows tested on ≥20k-entry fixtures; no full content scan for UI estimates; responsive interaction measured. Run UX walkthrough, capture screenshots and log specific usability flaws; implement the meaningful findings.

### M3.5 — Approved desktop UI and brand adoption

**Deliver:** Implement the approved compact desktop composition and genuine vector logo in small, testable slices while reusing the M0–M3 workspace, selection, preview, estimate and export behaviours. Add the All / Selected / Ignored view projections, a minimal honest Settings destination, and a safe one-time migration from persisted exclude-extension settings. The detailed visual contract is [`CONTEXTPICK_UI_REDESIGN.md`](CONTEXTPICK_UI_REDESIGN.md); the single execution checklist and dependencies are [`docs/project/ROADMAP.md`](project/ROADMAP.md).

**Gate:** Approved vector assets are used by the UI and app icon pipeline; all views and filters operate on the existing selection engine; saved user intent survives migration/restart; actual native screenshots match the supplied reference at large and compact supported sizes; UI and domain regression suites pass; independent review finds no duplicate selection/filter state or unnecessary UI framework. M3.5 closed the then-current FL-02 contract and triggered the original §10.3 P0 check; M5.5.2's newer filter interaction is a UX-06 follow-up and does not rewrite the historical M3.5 evidence. Tokenization, watchers and unrelated features remain outside this gate.

### M4 — Resilience and background freshness

**Deliver:** Watcher + debounce, changed-file reconciliation, cache invalidation, generation cancellation, focus/recovery/manual refresh, error reporting, watcher tests and native integration. Move from approximate to local tokenizer estimates in background.

**Gate — architecture review #2:** Identify races, duplicate scanning, unbounded concurrency, stale results, cache invalidation bugs and overly coupled code. Check measured memory/time. If performance regressed, fix before feature expansion.

### M5 — Profiles, testing breadth, security and release engineering

**Deliver:** Profile UX, persistence migrations, secret warnings, complete fixture suite, platform-specific smoke tests, documentation, licensing/dependency audit, installer builds, release checklist, distributable artifacts where permitted.

### M5.5.2 — Filter and tree usability refinement

**Deliver:** Move filter editing into the main pane; replace the free-form filter panel with an explicit `All text` / `Selected extensions` mode and a compact, categorized extension grid; remove custom path include/exclude controls and extension-exclusion rules; apply filter changes automatically after a short debounce; show safe per-folder discovered-file byte totals; improve tree indentation/guides; add an optional persistent fixed export folder with safe workspace-derived Markdown names and a clear target hint; refresh the README as a concise product page with accurate preview downloads. Preserve `.gitignore`, the Rust selection authority, explicit folder/file choices, source safety, token estimates and Save As when fixed-folder mode is off.

**Migration:** A versioned settings migration must preserve a bounded recovery copy before changing storage. Preserve explicit file/folder intents and selected extensions; map an empty legacy extension list to `All text` and a nonempty list to `Selected extensions`. Legacy path patterns and migrated exclusion selectors have no equivalent in the new UI; remove them from active policy only after backup and show a one-time notice explaining the reset and recovery location. Migration is idempotent, restart-safe and never silently claims that an old pattern is still active.

**Gate:** Each slice has focused failing behavior tests, independent review, relevant Rust/UI/browser/native regressions and actual screenshots at reference and minimum sizes. Folder-size work reuses metadata for safely discovered regular files (including non-text files), updates only affected ancestors on file changes, prioritizes selected folders, debounces/cancels stale requests and obeys scan bounds. It identifies logical size, not allocated disk use; pruned ignored or unscanned descendants remain partial/unknown. Fixed-folder output never escapes the chosen directory or overwrites silently. README links only to verified assets and describes third-party file limits as variable.

**Gate — architecture review #3 / release readiness:** Audit whole architecture, dependencies, test gaps, developer onboarding, binary size/memory/performance, failure UX and cross-platform correctness. Remove dead code/duplicate abstractions. Resolve all critical/high findings; explicitly record remaining limitations. Distribution and macOS release tasks may remain backlogged if external requirements or authorization are unavailable; do not imply they passed.

### M6 — Optional expansion **only after feedback**

Context budgets, Git-diff selection, headless CLI, more output formats, full secret scanning. Every feature needs evidence from user workflows, a focused acceptance contract and a fresh small plan. Do not convert peripheral ideas into foundational requirements.

### Slice rhythm inside each milestone

```text
Select next highest-value acceptance gap
    ↓
Write observable example(s) / red test
    ↓
Implement smallest complete vertical path
    ↓
Run focused tests → refactor → verify
    ↓
Independent review & targeted fixes
    ↓
Demo or E2E proof; record evidence
    ↓
Update STATUS / next slice / ADR as needed
    ↺
```

Stop at *natural validated boundaries*, not halfway through a failing change. The agent may continue autonomously across slice/milestone gates after completing reviews; the review gate is not automatically a human approval pause.

## 12. Long-horizon Codex operating system: avoid drift, reinvention and context bloat

### 12.1 Three document layers (progressive disclosure)

1. **Product charter (this file):** Authoritative long-term *what* and critical constraints. Read initially and when discussing a requirement or milestone; do not push its entire content into every task.
2. **`AGENTS.md` (target 40–80 focused lines):** Operational *how*: source-of-truth pointers, build/test commands, core invariants, change/review rules, working agreement. Keep it short and revise when superseded; no copy of every requirement.
3. **Active ExecPlan + status files:** *What's next and what happened*: one scoped plan at `docs/plans/active-<slug>.md` (small or medium, not a novel), `docs/project/STATUS.md`, `NEXT_SESSION.md`, `ROADMAP.md`, concise ADRs. Archive completed plans. For a one-line bug fix, a separate plan is unnecessary.

This follows OpenAI's documented ExecPlan pattern and its later guidance to keep `AGENTS.md` concise, only load context relevant to the current task, and avoid redundant skills or mandatory reading of every document for trivial edits.

### 12.2 Required persistent state (small and truthful)

Create and maintain:

**`docs/project/STATUS.md`** — most recent update timestamp, overall milestone, evidence-based completed items with requirement IDs, in progress, next 3 tasks, blockers, commands run/results, current risks, outstanding review findings, recent ADR links, known OS/build gaps, and last known good commit/hash. No unbounded diary.

**`docs/project/NEXT_SESSION.md`** — <=~30 lines, specifically: first commands to run, where the active plan is, what was last verified, what remains broken, which requirement is next, how to resume without repeating discovery.

**`docs/project/ROADMAP.md`** — compact table of P0/P1/P2 requirements, milestone owner, status and acceptance-evidence links; update status only based on evidence.

**`docs/project/REVIEW_LOG.md`** — date/scope/reviewer, review checklist findings, severity, disposition, verification result, architecture decision if necessary.

**`docs/adr/NNNN-<slug>.md`** — decision, context, considered alternatives, selected approach, consequences, revisit trigger, date. Create for meaningful design changes, not every naming choice.

**`docs/plans/active-<slug>.md`** — goal, user value, affected requirement IDs, boundaries, existing code to reuse, ordered small tasks, planned test examples, exact run commands, assumptions/risks, validation observations, completed/uncompleted checklist. Keep this file current. Separate architecture spikes (timeboxed) from feature delivery.

The log/files are not a substitute for Git history; never store transient full agent reasoning, huge command output or a chronology of every trivial edit. Use links, concise evidence and reproducible commands.

### 12.3 Strict resumption and anti-drift loop

At each new working session or context compaction:

1. Read `AGENTS.md` and `docs/project/NEXT_SESSION.md` first, then the active plan and affected parts of the charter/architecture. Read more only as needed.
2. Check `git status`, recent commits and the actual working tree. Reconcile discrepancies between docs and code; **code/tests/history beat optimistic status text**.
3. Identify the current requirement IDs and concrete acceptance gap. Write a one-paragraph next-slice objective and a stop condition.
4. Search for existing implementation, relevant tests and maintained libraries **before creating a new helper or abstraction**. Trace the actual code path; avoid duplicate implementations.
5. Run the narrow existing tests needed to establish baseline. Preserve existing working behaviour.
6. Implement/validate/review the slice and update durable state. Stop reading and start coding when the task is clear; do not get trapped in permanent research.
7. Before ending, leave a clean handoff: exact state, tests, next task, blockers. No unsupported claims.

**Periodic north-star check, after every 2–4 slices and every architecture gate:** Does this change directly improve selection correctness, performance, transparent context size or reliable export? What can be removed? Is scope expanding? Did the agent solve a problem twice? Did any layer gain unrelated responsibility? Are real users closer to exporting context?

### 12.4 Avoiding reinvention of the wheel

For every new utility/package/framework proposal, perform a brief buy/reuse/build check:

- Search this repo for an equivalent implementation first.
- Prefer Rust `ignore` to custom Gitignore parsing, battle-tested watchers instead of home-grown polling, native Tauri APIs instead of ad hoc OS command shells, proven virtualisation instead of custom row recycling, established tokenizer instead of fabricated token math.
- Check the vendor API/maintenance status and licences when relevant. Compare 1–2 alternatives when a choice is consequential; do not launch open-ended tool surveys.
- Add dependencies only if they simplify **the present requirement**. Avoid adding general-purpose infrastructure for a hypothetical future feature.
- When refactoring duplicates, consolidate behind one tested domain-level function rather than introducing a second abstraction with similar behaviour.

### 12.5 Refactoring and complexity budgets

At each milestone review, inspect the following indicators **qualitatively and with evidence**, not arbitrary file-size dogma:

- Modules with more than one clear reason to change; files that simultaneously scan, apply rules and render UI.
- Duplicate rule evaluators, duplicate pathname normalisers, duplicate frontend/native DTOs and cross-boundary leakages.
- Interfaces/traits/wrappers used once without a clear test seam or portability need.
- Excessive generic types, deeply nested callbacks, magic strings/boolean parameter flags, repeated error handling and noisy comments.
- Expensive full scans when only one file changed; overcomplicated caching without measured benefit.
- Test suites coupled to exact internal implementation rather than behaviour, slow/flaky tests, brittle snapshots, and mocks that make incorrect behaviour pass.
- Dead options, unused configuration, abandoned experiments, side-effectful components or heavyweight packages brought in for one tiny use.
- Documentation that repeats itself or conflicts with tests or code.

For a meaningful concern, choose **one** of: retain with rationale; simplify now with a measured/small refactor; create a named, prioritised debt item with trigger. Avoid endless speculative cleanup. Measure change impact; a refactor must leave tests green and should make the architecture easier to follow.

### 12.6 Decision and escalation policy

**Proceed without human approval** for ordinary code changes, unit/integration tests, local fixture generation, documentation, local benchmark scripts, and running/reviewing safe checks inside the repository's configured sandbox.

**Request explicit approval or stop at a safe boundary** for destructive repository operations (force push, deleting unrelated user data/history), opening real secrets to external services, new network access or telemetry, paid services/API use, licence exceptions, material product-scope changes, signing/notarisation using private credentials, public GitHub release/publication, or changing unsafe execution permissions. Do not bypass a denied approval by using another tool or agent.

If a blocker requires a person: document the precise issue, attempted safe workarounds, impact, and a small concrete decision request; continue with independent safe tasks if possible. “Set and forget” means no unnecessary requests for routine implementation decisions, **not** permission to take irreversible external actions.

## 13. Test-driven delivery and review standards

### 13.1 TDD as behaviour discovery, not theatre

Start each feature with one failing, externally observable behaviour. Write tests at the **lowest useful level**: pure selection/domain unit tests; fixture-based filesystem integration tests for scanner/ignore/export; component tests for UI display; E2E for user flows. Use red → green → refactor, keeping the cycle short. Tests should prove requirements, not the implementation's own assumptions.

Do not over-test trivial getters or chase 100% coverage for its own sake. High-risk rule precedence, path safety, encoding and export fidelity require broad boundary and property-test coverage. Keep test helpers reusable, small and deterministic. A test that skipped due to missing dependencies or OS support is **not passed**; report skipped/unverified explicitly.

### 13.2 Tests to run, when

- Every small change: affected unit/fixture tests, formatting and types/lint for touched language.
- Before merging each slice: relevant integration tests + UI tests + diff review.
- Before milestone gate: full suite, production build, E2E core journeys, native smoke test on available OS, benchmark deltas on applicable fixtures.
- Before public release: CI matrix on Windows and macOS, clean install smoke, signed/notarisation proof or honest gap, dependency/licence/security scan, threat-model/security review.

Standardise commands (for example `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `cargo test --workspace`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and a `pnpm test:e2e` target); verify actual commands and document them in `README.md`/`AGENTS.md`. Never invent a successful result or configure CI to ignore failures.

### 13.3 Independent review protocol

After each meaningfully complete vertical slice, assign a **different reviewer agent in a fresh task context**, ideally read-only and given the diff + acceptance criteria, not the implementing agent's confidence statement. Require concrete file/line and reproduction/test evidence, ordered by severity:

- P0: correctness of export/selection, path traversal, unsafe reads, secret leakage, data loss, persistent state destruction, silent partial success.
- P1: races, stale UI, performance/memory, inadequate errors, accessibility, cross-platform assumptions, absent regression tests.
- P2: maintainability, naming, duplication, unnecessary layers, unnecessary dependencies and readability.

Reviewer output: `finding`, `risk`, `evidence`, `reproduction`, `suggested fix`, `severity`, or explicitly `no findings with limitations`. Parent triages findings, fixes substantial issues, adds regression test, reruns applicable checks, records disposition. Prefer genuine review disagreement and evidence over rubber-stamp praise. Run two independent review perspectives (architecture and correctness/security) at M2/M4/M5.

### 13.4 Automated CI gates

CI should initially require Rust unit/integration suite, TS typecheck, Vitest, lint/format and build; expand to platform matrix, E2E, coverage report and dependency/secret scanning without making routine local iteration painfully slow. Keep lockfiles pinned and ensure reproducible dependency installation. Separate fast pre-commit-like checks from slower release checks.

## 14. Multi-agent orchestration: Sol parent, Luna specialists

**Design intent:** Use **GPT-6.1 Sol** for the root/orchestrator if available; use **GPT-6 Luna** for bounded, cheaper investigations, fixture/test generation, focused implementation and exploratory reviews. Escalate domain-semantic conflicts, security decisions, difficult cross-module design and independent architecture reviews to Sol (or a stronger available model if genuinely necessary). A cheap wrong answer that generates rework is not an optimisation.

**Actual availability is client/account-dependent.** Verify installed Codex version and which models it can access at runtime. `gpt-6.1-sol` and `gpt-6-luna` are currently documented model IDs; do not assume every chat or Codex distribution supports them. Never fabricate a role or model selector. If a setting is unsupported, adapt using verified current docs and preserve the intended *division of labour*.

### 14.1 Root agent responsibilities

The root orchestrator **owns** requirement interpretation, priorities, scope, contracts/interfaces, ADRs, task allocation, agent boundaries, integration, merge conflict resolution, independent review and final evidence. It should avoid doing large batches of trivially delegable work itself. It also must not outsource overarching coherence: after receiving child work, compare it against existing architecture, integrate, run tests, correct problems and update progress.

**Typical Luna delegation:** inspect existing symbols; investigate one library API; add focused failing fixture tests to a specified module; implement a tightly bounded component; improve a small test fixture; gather independent performance evidence; run read-only lint/security/test-gap reconnaissance; verify docs. Give child agents a **small set of paths**, a precise goal, expected evidence and no authority to modify architecture outside scope.

**Typical Sol work:** first DDD policy specification, tricky Git-ignore semantics, IPC contract and significant ADR; high-risk merge/architecture review; reconcile agent outputs; debug complex asynchronous races; security/path decisions; final release gate.

### 14.2 Do not create agent swarms

Spawn subagents when tasks are actually independent or benefit from fresh isolated review. Limit concurrency initially to **three subagents**; increase only if integration/cost/latency data justify it. A five-minute sequential task with dependent steps may be cheaper and safer in the root than delegating it. Never have two agents concurrently edit the same file in the same worktree without explicit coordination; prefer separate worktrees/isolated branches for parallel modifications or constrain ownership to disjoint files. Parent alone integrates overlapping changes.

### 14.3 Standard task contract for a delegated agent

Each delegation should state:

```text
Role: [explorer / focused implementer / test author / independent reviewer]
Goal: [one sentence, observable outcome]
Requirement IDs: [e.g. FL-01, WS-05]
Context: [only relevant interfaces, paths, contract/test references]
Allowed paths: [exact modules; read-only if review]
Forbidden: [scope changes, external secrets/network, unrelated edits]
Expected output: [patch/tests or findings with evidence]
Checks: [exact relevant commands]
Stop when: [acceptance condition or clearly recorded blocker]
Handoff: [what changed, test evidence, risk, follow-ups]
```

Child may ask root for contract clarification rather than invent another selection engine or framework. Return concise, evidence-based output; don't paste a thousand lines of code or re-explain the entire charter.

### 14.4 Model choice for review, not just cost

Use Luna for first-pass broad lint/test inventory and narrow API checks; for critical or architectural decisions, use a separate Sol reviewer **after** implementation, and have the parent verify the findings. Independent review may be more valuable than generating a second candidate implementation. If a Luna task repeatedly fails or needs more than one substantial correction, escalate rather than accumulating low-quality retries.

### 14.5 Codex configuration bootstrap — documented as of 2026-10-08

Current Codex documentation describes project-scoped `.codex/config.toml` and custom roles under `.codex/agents/*.toml`. **Check your installed CLI/model entitlements before applying verbatim.** The following is a proposed config, not a claim it has been tested in this user's environment:

**`.codex/config.toml`**

```toml
model = "gpt-6.1-sol"
model_reasoning_effort = "high"

[agents]
enabled = true
max_concurrent_threads_per_session = 3
default_subagent_model = "gpt-6-luna"
default_subagent_reasoning_effort = "medium"
```

**`.codex/agents/explorer-lite.toml`**

```toml
name = "explorer_lite"
description = "Read-only, narrow code search and documented API verification."
model = "gpt-6-luna"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"
developer_instructions = """
Locate existing implementations and relevant tests using targeted search.
Return exact symbols/paths, evidence, reuse opportunities and uncertainty.
Do not modify files, invent APIs, redesign modules, or broaden the task.
"""
```

**`.codex/agents/test-specialist.toml`**

```toml
name = "test_specialist"
description = "Focused behavioural tests and synthetic fixtures for assigned contract."
model = "gpt-6-luna"
model_reasoning_effort = "medium"
developer_instructions = """
Write minimal, robust contract tests for the assigned requirement IDs.
Follow red-green-refactor; do not rewrite application architecture.
Use only allowed test/fixture paths unless the parent authorises otherwise.
Report commands, actual failures/pass results and uncovered edge cases.
"""
```

**`.codex/agents/architecture-reviewer.toml`**

```toml
name = "architecture_reviewer"
description = "Independent read-only architecture review at milestone gates."
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """
Independently evaluate actual code against the charter's bounded contexts,
selection invariants, portability, dependency direction, complexity and tests.
Find evidence-backed risks and duplication; propose the smallest improvements.
Do not change files; distinguish observed defects from opinions.
"""
```

These templates are illustrative; agent config precedence, reasoning settings and available permission options must be checked on the target runtime. In particular, subagents can inherit the parent's live approval/sandbox policy; do not assume a child role is a security boundary stronger than actual runtime permissions.

### 14.6 Agent cost and quality guardrails

- Root plans one concrete slice before spawning; don't create child tasks for the sake of spawning.
- Use narrow read-only exploration and concise responses; avoid sending the entire repo or charter to each child.
- Batch independent investigative questions when useful; parallelise **bounded** tasks, not intertwined implementation work.
- Track expensive retries, repeated tool calls and integration churn; if delegating costs more than it saves, stop.
- Do not allow a child to commit to main, update global settings, publish releases or overrule core domain contracts.
- Root stops an unproductive line of work, records its findings, and chooses a smaller test/spike rather than endlessly looping.

## 15. Development ergonomics and release management

### 15.1 Local developer experience

The repository must have one documented setup path for Windows and one for macOS. Make `pnpm dev` start the frontend and appropriate desktop runner through predictable scripts. For UI work, support a browser/mock-bridge mode so Codex and developers can take fast Playwright screenshots without compiling Rust after every CSS change. Keep IPC contracts shared/typed, use deterministic mock responses/fixtures, and run native integration tests separately. A browser mocked UI is a tool for fast iteration, **not** proof of native behaviour.

Use standard Rust formatting and clippy; ESLint/TypeScript strict mode/formatting for frontend; clear imports, no circular dependencies, and focused tests. Prefer simple debuggable state transitions. Avoid a complicated global event bus unless measurable cross-feature coordination requires it.

### 15.2 UX validation

At M1 onward, run the application and actually try every user journey, including narrow window widths and high-DPI scaling. Capture representative screenshots, compare with prior milestone output, fix obvious layout regressions. At M3 run keyboard navigation and accessibility checks. Do not polish gradients/icons at the expense of reliable selection and export.

### 15.3 Build artefacts and licensing

Use an OS CI matrix. Publish Windows and macOS builds as appropriate for architecture (Windows x64; macOS arm64 and x64 or universal if practical), with verified Tauri bundling. Determine signing and notarisation requirements from current Apple/Microsoft guidance; keep secrets in CI secret storage, never commit them. An unsigned development build is not a fully vetted public installer. Include licence (MIT/Apache-2.0 subject to dependency audit), `CONTRIBUTING.md`, issue templates when useful, and minimal release notes. Do not add a complex installer/update platform during MVP.

## 16. Architecture and product review questions (must be answered at gates)

**At M2 — selection and domain:**

1. Can a new contributor understand and modify selection precedence without touching React?
2. Is selection a pure function of explicit intent, policy and current index? Are all exclusion reasons surfaced?
3. Are Gitignore negation, parent ignore, force-include and traversal behaviours proven by fixture tests?
4. Did we create one selection engine, or has the logic been copied into scanner, frontend and exporter?
5. Are data structures and interfaces proportionate to one desktop application? What can be deleted?

**At M4 — concurrency and performance:**

1. Are cancellation, generation, watcher recovery and stale events safe under races?
2. Are scans metadata-first? Does a collapsed ignored subtree avoid descent? Are memory/latency measurements real?
3. Is index ownership obvious? Do estimates distinguish unknown, stale, approximate and actual?
4. Are content reads bounded when previewing and streaming when exporting? Any unbounded task fan-out?
5. What is the most costly unnecessary abstraction, dependency or cache? Can it be simplified now?

**At M5 — whole-app architecture and release:**

1. What paths can read/write the filesystem? Could an untrusted link or path cause an escape?
2. What happens when a file changes mid-export, user loses permission, drive unmounts or watcher overflows?
3. Does the output remain valid Markdown for adversarial source content? Can the app accidentally include itself?
4. Are platform-specific issues truly tested? Does README match working commands and installer requirements?
5. Which modules have diverged from SRP? Where is duplication? Could a newcomer implement one filter without editing six layers?
6. Have we delivered the user job cleanly, or over-built future AI capabilities?
7. What evidence demonstrates release readiness, and what still requires manual acceptance?

## 17. Definition of effective autonomy

The root agent should run through **multiple independent, validated slices** without requesting approval for routine technical decisions or stopping merely to show progress. It should still checkpoint after each reviewed slice so the repository is always resumable. Independent review is an *internal quality control*, not an automatic invitation for the user to restate requirements.

The goal is a product that gets better with each iteration, not a giant single-shot generated codebase. When an implementation discovery changes the plan, adjust the roadmap and ADR, keep critical user outcomes intact, and choose the next vertical slice. Preserve readable code and a consistently working main branch over maximum simultaneous activity.

**Task-completion conditions for Codex:**

- For an individual slice: acceptance evidence + green relevant checks + independent review + updated checkpoint.
- For the P0 MVP: all P0 requirements and applicable E2E scenarios actually demonstrated, native smoke proof, usable UI and Markdown export.
- For a public release: selected P1 reliability gates, both target-platform validation, packaging/signing compliance or explicit block, licence/security checks and reproducible release artefacts.

If environment permissions prevent installers or external publishing, proceed through all safe implementation/CI steps and write a single clear release blocker with exact remaining actions. Never call the project complete while essential criteria are unverified.

## 18. First-session execution checklist for Codex

1. Inspect directory; preserve any existing user files and Git state.
2. Verify tools: Node, pnpm/Corepack, Rust/Cargo, Tauri prerequisites, available OS target, supported Codex agent model/config.
3. Create concise root `AGENTS.md`, `README.md`, basic `docs/project` checkpoints, and this charter under the repo name `PRODUCT_CHARTER.md` if not already present.
4. Create the first ADR recording Tauri 2/React/Rust, source-of-truth domain boundary and why no server/database.
5. Scaffold a **running** Tauri + React app and a small Rust core crate, with typed IPC smoke test and minimal UI.
6. Build a tiny synthetic repository fixture (text source, binary, `dist/`, nested folders).
7. Write the first failing domain/export test, implement the end-to-end folder → selected text → Markdown output slice.
8. Verify actual application behaviour, then delegate an independent read-only review to a capable subagent.
9. Fix material findings, commit logically, update STATUS and NEXT_SESSION, then begin the next slice without asking for routine permission.

---

## 19. Research basis and sources (verified October 2026)

These are **implementation references**, not blanket guarantees that APIs remain unchanged. The agent should re-check the exact runtime versions when implementing.

1. OpenAI, **Using PLANS.md for multi-hour problem solving** — durable ExecPlans and `AGENTS.md` working contracts: https://developers.openai.com/cookbook/articles/codex_exec_plans
2. OpenAI, **Modernizing your Codebase with Codex** — incremental plans and operational agent scaffolding: https://developers.openai.com/cookbook/examples/codex/code_modernization
3. OpenAI, **Rethinking skills and prompts for GPT-6 Astra** (2026-09-11) — shorter instructions, progressive disclosure, avoiding indiscriminate mandatory context reads and explicit completion boundaries: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra
4. OpenAI, **Codex subagents** — current project-level role files, model inheritance, subagent defaults and permission caveats: https://developers.openai.com/codex/agent-configuration/subagents
5. OpenAI, **Codex custom instructions with AGENTS.md** — root and nested instructions, loading order: https://developers.openai.com/codex/agent-configuration/agents-md
6. OpenAI, **Models** — `gpt-6.1-sol` and `gpt-6-luna` IDs and role/cost positioning: https://developers.openai.com/api/docs/models
7. OpenAI, **Codex safety** — technical boundaries and review/approval principles: https://openai.com/index/running-codex-safely/
8. Rust `ignore` crate — hierarchical Gitignore/`WalkBuilder` and incremental matchers: https://docs.rs/ignore/latest/ignore/struct.WalkBuilder.html and https://docs.rs/ignore/latest/ignore/struct.IncrementalIgnore.html
9. Git documentation — `.gitignore` pattern and negation semantics: https://git-scm.com/docs/gitignore
10. Tauri 2 docs — architecture, native APIs and bundling: https://v2.tauri.app/
11. Rust `notify` crate — filesystem events and platform limitations: https://docs.rs/notify/latest/notify/
12. OpenAI, **Running Codex safely** and coding workflows, plus the repository's future CI/reviews, inform the risk-based execution model, rather than providing a guarantee that AI-written code is correct.

---

## Appendix A — Suggested minimal root `AGENTS.md`

Generate this **as a separate file in the repository**. Keep it short. Update script names after scaffolding.

```markdown
# ContextPick — agent working agreements

- Product contract: `PRODUCT_CHARTER.md`. Read relevant sections for current requirement IDs; do not blindly reread all sections for every change.
- Resume first from `docs/project/NEXT_SESSION.md`, `docs/project/STATUS.md`, and the active plan. Reconcile docs with actual code/tests and `git status`.
- Root agent owns architecture, scope, integration, reviews and durable checkpoints. Delegate independent narrow tasks to Luna when available; use Sol for high-risk design/reviews. Never let simultaneous agents edit the same files unsupervised.
- Work in reviewable vertical slices. State requirement IDs and observable tests. Red → green → refactor; run relevant checks and record real outcomes before marking done.
- Core invariants: a single pure selection-policy implementation, explicit user intent independent of filters, correct Gitignore semantics, bounded filesystem reads, streaming deterministic export, no external telemetry, no source mutation.
- Domain rules live in Rust core, not React or Tauri command handlers. Search existing code/libraries before implementing a new helper. Prefer maintainable simple code over speculative abstractions.
- After each slice run independent diff review, fix important findings, update `STATUS.md`/`NEXT_SESSION.md`, and continue toward the next P0 acceptance gap.
- At M2, M4 and M5 perform an architecture review and record findings/decisions. Never misrepresent unrun tests, operating-system support or publishing/signing success.
- No force pushes, unrelated destructive changes, external uploads of user code, purchases, telemetry or public releases without explicit approval.
- Build/test commands: see README; keep them verified and current.
```

## Appendix B — Recommended launch prompt (copy into Codex Goal)

The prompt below is deliberately concise because the contract resides in this charter.

```text
Build ContextPick from this repository using PRODUCT_CHARTER.md as the authoritative product and engineering contract.

Act as a long-horizon lead engineer and orchestrator, preferably GPT-6.1 Sol. Delegate narrow, independent implementation, research, tests and exploration to GPT-6 Luna subagents when available; reserve Sol for architecture, difficult integration, security and independent reviews. Verify the available Codex model and subagent configuration rather than inventing features.

Start by inspecting the actual repository and tools, preserve existing work, then establish minimal AGENTS.md, a durable STATUS/ROADMAP/NEXT_SESSION system and a small ExecPlan for the first vertical slice. Design the domain and core invariants before scattering code through the UI. Build iteratively with red-green-refactor, real UI smoke tests, independently reviewed diffs and working CI. Deliver usable slices, not a waterfall-sized batch. At M2, M4 and M5 perform whole-architecture reviews; simplify duplication, abstraction bloat and drift before proceeding.

Keep working autonomously through ordinary implementation and internal review checkpoints. Do not ask me to approve routine technical choices. Treat no-cloud privacy, accurate selection and Gitignore semantics, safe filesystem handling, responsive operation and deterministic Markdown export as non-negotiable. Don't start peripheral AI features.

At each checkpoint, update durable status with requirement IDs, actual commands/test results, review findings, benchmark evidence, current risks and the next three tasks. If blocked, document the exact reason and continue with independent safe work; request human input only for material product changes, privileged/unsafe actions or release credentials. Never claim a feature, platform or release works without evidence.

Aim first for the full P0 functional MVP acceptance gate, then selected P1 release-readiness criteria. Finish only at a genuine verified goal boundary or an explicitly documented external blocker. Begin now with M0 and the smallest real end-to-end slice.
```
