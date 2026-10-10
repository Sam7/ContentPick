# ContextPick — approved desktop UI and brand

> **Status:** Approved design contract; M3.5 is verified locally on Windows. Delivery evidence and remaining platform/release gates are tracked in the [authoritative roadmap](project/ROADMAP.md).

## Authority and references

- [`PRODUCT_CHARTER.md`](PRODUCT_CHARTER.md) is authoritative for product behavior, engineering constraints and the single requirements matrix.
- [`docs/project/ROADMAP.md`](project/ROADMAP.md) is the single implementation checklist, with dependencies, acceptance criteria and verification for each slice.
- This document supplies the approved visual and interaction details for UX-04/05/06/07, BR-01, MT-05, PR-03, EX-04 and the revised FL-02. It does not add a second requirements matrix or override domain safety rules. The M5.5.2 follow-up below supersedes older references here to custom path rules.
- Approved desktop reference: [`docs/design/design-draft.png`](design/design-draft.png), 1536 × 1024.
- Current supplied logo source: [`docs/design/ContextPickLogo.svg`](design/ContextPickLogo.svg); the original approved raster reference remains [`docs/design/Logo.png`](design/Logo.png).
- Existing native baseline: `docs/testing/2026-10-08-current-ui.jpg` (local ignored artifact: `docs/testing/2026-10-08-current-ui.jpg`), 1200 × 800.

## Audited baseline before M3.5

The current application already has a real folder picker and refresh, progressive IPC paging, a virtualised tree, filename/path search, tri-state selection, force-include/force-exclude actions, exclusion reasons, lazy browsing of ignored folders, bounded read-only preview, selected-file and export-byte estimates, Copy, Export, visible outcomes and persisted workspace policy/intents. These remain the existing domain behavior and are adapted into the approved layout.

The audited native baseline had a website-like header and workspace row, marketing introduction, separate estimate strip, a two-panel tree/preview work area, and actions-only bottom dock. Filters opened in a top-level panel. It had no All / Selected / Ignored views, Settings destination, collapsible sidebar or new mark. The token field truthfully said `Unavailable`; no tokenizer existed. Version 1 persisted `excludeExtensions`, so removing it requires migration. M3.5 progress is recorded in STATUS and the roadmap.

## Product scope

### Reuse with visual adaptation

- Workspace selection, refresh, scan/cancel states and the typed native bridge.
- The Rust-owned selection engine, explicit file/folder selection intent, Git ignore behavior, reasons and persistence.
- Virtualised tree, search, folder/file selection, lazy ignored browsing, force actions and safe preview/export/copy.
- Selected-file count, estimated Markdown bytes, and honest status/error reporting.

### Change while preserving behavior

- Replace the marketing/two-panel composition with a compact desktop shell and the approved three-pane hierarchy.
- Move workspace selection and refresh into one compact toolbar; sidebar navigation opens Filter in the main work area; keep metrics and real export actions in a fixed bottom bar.
- Replace the free-form extension field with `All text` and `Selected extensions`; use a compact categorized picker. Remove custom include/exclude path controls and all extension-exclusion rules. Folder/file checkboxes are the user-facing path-selection mechanism; keep `.gitignore`.
- Apply filter changes automatically after a short debounce and update selection, byte and token estimates from authoritative results.
- Retire persisted path/exclusion rules through the safe M5.5.2 settings migration below.

### New, tightly scoped presentation behavior

- All / Selected / Ignored views over one workspace index and one selection state. `Ignored` means Git-ignored entries only; custom exclusions remain explained in All files. Unknown/lazy counts remain partial.
- A collapsible sidebar and a compact Settings destination. Settings initially reuses the existing Reset selections action and explains that preferences are stored locally; it adds no new preference toggles and does not duplicate the Filters editor. Reset filters and reset selections remain separate operations.
- Approved vector brand artwork and application icons derived from it.
- Metadata-only size totals on folder rows, prioritized for checked folders and then other visible folders.
- Optional persistent export-folder destination with clear target feedback, while preserving Save As as the default.
- More legible modest tree indentation and connector guides.

### Deferred

Automatic watching and recovery, local tokenization (MT-03), named profiles, secret scanning, context budgets, Git history/status tools, editing, IDE features, AI features, dashboards and additional export formats are outside M3.5. Until MT-03 exists, the footer shows `Unavailable` or `Calculating…`; it must not fabricate token counts. See the charter for P1/P2 and OUT priorities.

## Layout and interaction contract

```text
Native title bar
┌ ContextPick mark/name · workspace path/selector · Refresh · Change folder ┐
├ narrow collapsible sidebar ┬ searchable virtual file tree ┬ read-only preview ┤
│ All / Selected / Ignored  │ selection and reason states   │ bounded text      │
│ Filter destination        │ folder size totals            │ file details      │
│ Settings                  │                                │                   │
├ selected files · estimated Markdown bytes · token state · Copy · Export ┤
```

- Keep the operating system title bar and window controls. Do not draw fake controls, show a duplicate title bar, or add a permanent privacy/status badge.
- The sidebar is narrow at the reference size and can collapse to give the tree more room. The tree remains the primary work area; preview is secondary and may collapse or resize. Panes scroll independently; the app shell and footer stay fixed.
- All / Selected / Ignored are mutually exclusive view filters, not separate file lists or selection stores. Selected retains only effectively selected files and their minimal parents. Ignored shows Git-ignore decisions and lazily browsable ignored-directory placeholders; a file that does not match the active extension selection is not mislabeled as Git-ignored.
- Search only filters/reveals rows. It never changes selection. Switching views, collapsing panes, previewing a file, or resizing the window never changes saved intent.
- File/folder checkboxes keep the existing tri-state and eligible-descendant semantics. Force include remains an explicit action and cannot bypass binary, link, root-containment or other hard safety checks. Reasons remain available without relying on color alone.
- Selecting Filter in the sidebar replaces the main pane with the filter editor. It contains Respect `.gitignore`, `All text` / `Selected extensions`, a compact multi-column set grouped by a few recognizable types, and Reset filters. All common choices fit at minimum supported size without an internal scrolling list. In `Selected extensions`, selecting zero choices safely selects no files; it never silently behaves like `All text`. Filter changes debounce and apply automatically; no Apply button. Filter reset never clears manual selection intent.
- Folder rows show a human-readable logical-byte sum of safely discovered regular files, including non-text files and files not currently selected. Checked folders are evaluated first, then other visible folders. Totals use file metadata only; they are debounced, cancellable, bounded and display partial/calculating/unavailable honestly. Pruned ignored/unscanned descendants remain unknown. Explain that the value is logical file size, not allocated disk usage or exported Markdown size.
- Tree depth is visible through modest row indentation and subtle connector guides; every depth keeps checkbox/icon/name baselines aligned and remains readable under virtualization and resize.
- Settings includes a disabled-by-default “Always export to this folder” control and native directory picker. When off, current Save As behavior is unchanged. When on, Export Markdown writes `<sanitized-workspace-root-name>.md` to the chosen directory, selecting a deterministic non-overwriting suffix on collision. Hover/focus feedback states the exact target path before export. It never escapes the destination or overwrites an existing file silently.
- Preview stays read-only and bounded. It identifies the file, relative path, size and inclusion state, and reports truncated, binary, unreadable, deleted and empty states clearly. An accessible splitter supports pointer and keyboard resizing within bounds; collapse/restore preserves the current preview and selection. Long paths are visually limited to three header lines while the full path remains in the text and hover title, so the code viewport stays available. Preview contents never determine export contents.
- Footer metrics come from the real workspace state. The selected count and bytes retain their approximate/incomplete labels. Copy and Export use the same effective selection, report actual outcomes, and remain unavailable when there is nothing safe to export.
- Compare actual native screenshots with the supplied reference at 1536 × 1024 and 1200 × 800, plus the supported minimum window size. Verify keyboard use, focus visibility, accessible labels, contrast, high-DPI scaling, long paths and independent scrolling. Keep the restrained teal/green palette and compact row density; no full-window scrolling or hover-only critical action.

## Brand artwork contract

- Use the supplied `docs/design/ContextPickLogo.svg` as the current editable vector artwork for the toolbar lockup and derive application icon artwork from its icon group. Do not redraw or maintain a competing active mark.
- Generate the existing Tauri/Windows/macOS icon assets from that source; do not maintain hand-edited duplicate marks. Preserve the former `contextpick-brand.svg` source as inactive historical artwork with its existing font attribution.
- Check 16, 24, 32, 48, 64 and 128 px renderings on light and dark backgrounds. Use a simplified small-size variant only if it preserves the same recognizable mark. Review the header, title-bar/taskbar and installer assets together against the supplied vector and original `docs/design/Logo.png` reference.
- Do not embed raster imagery or font software in the supplied vector artwork.

## Historical M3.5 migration of persisted Exclude Extensions

The existing migration in M3.5 converted the version-1 `excludeExtensions` field to visible `file-ext:` path selectors. That behavior is already implemented and its evidence remains historical. M5.5.2 retires those selectors and custom path patterns from active policy, so use the separate versioned migration contract below; do not reintroduce path-rule controls.

The current version-1 settings serialize `excludeExtensions`; this is real user state, not dead code. The implementation must:

1. Convert each saved extension exclusion to a visible file-targeted rule in `excludePaths`: `file-ext:rs` matches `.rs` files regardless of ASCII case; `file-ext:<none>` matches extensionless/trailing-dot files; reserved punctuation is percent-encoded (for example, `file-ext:%2A%3F%5B`). These selectors do not prune same-named directories and never interpret extension characters as glob operators.
2. Preserve all other workspace settings, include-extension/path rules, manual intents, generated-output reservations and recent root. Put migrated selectors before the legacy `excludePaths` while preserving those paths' relative order; this retains version-1 path-rule explanation precedence. Escape legacy path rules that start with reserved `file-ext:` or `glob:` by adding one `glob:` prefix; the compiler removes exactly one escape prefix and interprets the original glob.
3. Validate the complete migrated policy with the same core compiler before publishing it. Create the bounded recovery backup before atomic save; migration is idempotent. Successful migration writes settings version 2, whose active policy and storage have no `excludeExtensions` field.
4. If any legacy value cannot be represented exactly, or backup/validation/save fails, preserve the original file and backup, block saving defaults or a partial conversion, and show an actionable recovery error. Recognizable damaged v1 markers (including escaped keys and malformed version encodings) must also fail closed. Never silently drop or continue applying a hidden exclude-extension policy.

Acceptance fixtures for the historical M3.5 migration cover v1 absent/single/multiple exclusions; root and nested files; mixed-case extensions; dotfiles and `<none>`; literal glob metacharacters and reserved-prefix collisions; overlap/explanation precedence with existing path rules; corrupt, truncated and unrepresentable settings; failed backup and failed migration save; restart; and repeated migration. These cases remain historical regression evidence.

## M5.5.2 safe removal of legacy path rules

Before clearing legacy custom path rules or migrated `file-ext:` exclusion selectors, write and verify a bounded recovery copy. Preserve explicit saved file/folder selection intent and the selected-extension allowlist; an empty prior allowlist maps to `All text` and a nonempty one maps to `Selected extensions`. After migration, active settings contain no custom path-rule or extension-exclusion policy; show a one-time notice that those unsupported filters were reset and where the recovery copy is stored. The migration is atomic, idempotent and restart-safe; a backup or save failure leaves original settings untouched and blocks partial defaults from replacing them.

## Engineering and evidence

Use the existing DDD boundaries and typed bridge; Rust remains the only selection/policy authority. Each roadmap slice starts from a failing behavior or screenshot/interaction assertion, makes the smallest coherent change, runs focused regressions, receives independent review, and records evidence before its checkbox is marked. Keep the app runnable. At the M3.5 gate run the full Rust and frontend suites, native WebView2 E2E, build/lint/type checks, visual comparison and accessibility checks; record unavailable macOS evidence without claiming it passed. Update STATUS/NEXT_SESSION after each accepted slice. The roadmap defines the exact slice owners, dependencies and gate.
