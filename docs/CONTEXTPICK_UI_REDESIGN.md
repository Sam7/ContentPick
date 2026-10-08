# ContextPick — approved desktop UI and brand

> **Status:** Approved design contract; M3.5 is verified locally on Windows. Delivery evidence and remaining platform/release gates are tracked in the [authoritative roadmap](project/ROADMAP.md).

## Authority and references

- [`PRODUCT_CHARTER.md`](PRODUCT_CHARTER.md) is authoritative for product behavior, engineering constraints and the single requirements matrix.
- [`docs/project/ROADMAP.md`](project/ROADMAP.md) is the single implementation checklist, with dependencies, acceptance criteria and verification for each slice.
- This document supplies the approved visual and interaction details for UX-04, UX-05, BR-01 and the FL-02 extension-policy change. It does not add a second requirements matrix or override domain safety rules.
- Approved desktop reference: [`docs/design/design-draft.png`](design/design-draft.png), 1536 × 1024.
- Approved logo reference: [`docs/design/Logo.png`](design/Logo.png).
- Existing native baseline: [`docs/testing/2026-10-08-current-ui.jpg`](testing/2026-10-08-current-ui.jpg), 1200 × 800.

## Audited baseline before M3.5

The current application already has a real folder picker and refresh, progressive IPC paging, a virtualised tree, filename/path search, tri-state selection, force-include/force-exclude actions, exclusion reasons, lazy browsing of ignored folders, bounded read-only preview, selected-file and export-byte estimates, Copy, Export, visible outcomes and persisted workspace policy/intents. These remain the existing domain behavior and are adapted into the approved layout.

The audited native baseline had a website-like header and workspace row, marketing introduction, separate estimate strip, a two-panel tree/preview work area, and actions-only bottom dock. Filters opened in a top-level panel. It had no All / Selected / Ignored views, Settings destination, collapsible sidebar or new mark. The token field truthfully said `Unavailable`; no tokenizer existed. Version 1 persisted `excludeExtensions`, so removing it requires migration. M3.5 progress is recorded in STATUS and the roadmap.

## Product scope

### Reuse with visual adaptation

- Workspace selection, refresh, scan/cancel states and the typed native bridge.
- The Rust-owned selection engine, selection intent, Git ignore behavior, path rules, reasons and persistence.
- Virtualised tree, search, folder/file selection, lazy ignored browsing, force actions and safe preview/export/copy.
- Selected-file count, estimated Markdown bytes, and honest status/error reporting.

### Change while preserving behavior

- Replace the marketing/two-panel composition with a compact desktop shell and the approved three-pane hierarchy.
- Move workspace selection and refresh into one compact toolbar; move policy controls into a collapsible sidebar; keep metrics and real export actions in a fixed bottom bar.
- Remove Exclude Extensions from the UI, bridge contract and active policy. Keep Include Extensions, path inclusion/exclusion and `.gitignore`.
- Migrate existing saved exclusions into visible path rules without dropping any saved intent; see the compatibility contract below.

### New, tightly scoped presentation behavior

- All / Selected / Ignored views over one workspace index and one selection state. `Ignored` means Git-ignored entries only; custom exclusions remain explained in All files. Unknown/lazy counts remain partial.
- A collapsible sidebar and a compact Settings destination. Settings initially reuses the existing Reset selections action and explains that preferences are stored locally; it adds no new preference toggles and does not duplicate the Filters editor. Reset filters and reset selections remain separate operations.
- Approved vector brand artwork and application icons derived from it.

### Deferred

Automatic watching and recovery, local tokenization (MT-03), named profiles, secret scanning, context budgets, Git history/status tools, editing, IDE features, AI features, dashboards and additional export formats are outside M3.5. Until MT-03 exists, the footer shows `Unavailable` or `Calculating…`; it must not fabricate token counts. See the charter for P1/P2 and OUT priorities.

## Layout and interaction contract

```text
Native title bar
┌ ContextPick mark/name · workspace path/selector · Refresh · Change folder ┐
├ narrow collapsible sidebar ┬ searchable virtual file tree ┬ read-only preview ┤
│ All / Selected / Ignored  │ selection and reason states   │ bounded text      │
│ Filters                   │                                │ file details      │
│ Settings                  │                                │                   │
├ selected files · estimated Markdown bytes · token state · Copy · Export ┤
```

- Keep the operating system title bar and window controls. Do not draw fake controls, show a duplicate title bar, or add a permanent privacy/status badge.
- The sidebar is narrow at the reference size and can collapse to give the tree more room. The tree remains the primary work area; preview is secondary and may collapse or resize. Panes scroll independently; the app shell and footer stay fixed.
- All / Selected / Ignored are mutually exclusive view filters, not separate file lists or selection stores. Selected retains only effectively selected files and their minimal parents. Ignored shows Git-ignore decisions and lazily browsable ignored-directory placeholders; a custom path or extension exclusion is not mislabeled as Git-ignored.
- Search only filters/reveals rows. It never changes selection. Switching views, collapsing panes, previewing a file, or resizing the window never changes saved intent.
- File/folder checkboxes keep the existing tri-state and eligible-descendant semantics. Force include remains an explicit action and cannot bypass binary, link, root-containment or other hard safety checks. Reasons remain available without relying on color alone.
- Filters contain Respect `.gitignore`, Include Extensions, ordered include/exclude path rules, validation and Reset filters to defaults. Empty Include Extensions means no extension allowlist. Keep extensionless and dotfile behavior explicit. Filter reset never clears manual selection intent.
- Preview stays read-only and bounded. It identifies the file, relative path, size and inclusion state, and reports truncated, binary, unreadable, deleted and empty states clearly. An accessible splitter supports pointer and keyboard resizing within bounds; collapse/restore preserves the current preview and selection. Long paths are visually limited to three header lines while the full path remains in the text and hover title, so the code viewport stays available. Preview contents never determine export contents.
- Footer metrics come from the real workspace state. The selected count and bytes retain their approximate/incomplete labels. Copy and Export use the same effective selection, report actual outcomes, and remain unavailable when there is nothing safe to export.
- Compare actual native screenshots with the supplied reference at 1536 × 1024 and 1200 × 800, plus the supported minimum window size. Verify keyboard use, focus visibility, accessible labels, contrast, high-DPI scaling, long paths and independent scrolling. Keep the restrained teal/green palette and compact row density; no full-window scrolling or hover-only critical action.

## Brand artwork contract

- Reconstruct the approved folder/C/checkmark mark as genuine, editable SVG paths/shapes. Preserve its teal/green geometry, rounded folder, generous white negative space and visible tick. Do not embed a raster image in SVG or trace the raster into a lumpy contour.
- Provide an icon-only mark and horizontal ContextPick lockup from one maintained vector source. Generate the existing Tauri/Windows/macOS icon assets from that source; do not maintain hand-edited duplicate marks.
- Check 16, 24, 32, 48, 64 and 128 px renderings on light and dark backgrounds. Use a simplified small-size variant only if it preserves the same recognizable mark. Review the header, title-bar/taskbar and installer assets together against `docs/design/Logo.png`.
- Use a documented, permissively licensed font or paths for the wordmark. Do not redistribute proprietary font files.

## Safe removal of persisted Exclude Extensions

The current version-1 settings serialize `excludeExtensions`; this is real user state, not dead code. The implementation must:

1. Convert each saved extension exclusion to a visible file-targeted rule in `excludePaths`: `file-ext:rs` matches `.rs` files regardless of ASCII case; `file-ext:<none>` matches extensionless/trailing-dot files; reserved punctuation is percent-encoded (for example, `file-ext:%2A%3F%5B`). These selectors do not prune same-named directories and never interpret extension characters as glob operators.
2. Preserve all other workspace settings, include-extension/path rules, manual intents, generated-output reservations and recent root. Put migrated selectors before the legacy `excludePaths` while preserving those paths' relative order; this retains version-1 path-rule explanation precedence. Escape legacy path rules that start with reserved `file-ext:` or `glob:` by adding one `glob:` prefix; the compiler removes exactly one escape prefix and interprets the original glob.
3. Validate the complete migrated policy with the same core compiler before publishing it. Create the bounded recovery backup before atomic save; migration is idempotent. Successful migration writes settings version 2, whose active policy and storage have no `excludeExtensions` field.
4. If any legacy value cannot be represented exactly, or backup/validation/save fails, preserve the original file and backup, block saving defaults or a partial conversion, and show an actionable recovery error. Recognizable damaged v1 markers (including escaped keys and malformed version encodings) must also fail closed. Never silently drop or continue applying a hidden exclude-extension policy.

Acceptance fixtures cover v1 absent/single/multiple exclusions; root and nested files; mixed-case extensions; dotfiles and `<none>`; literal glob metacharacters and reserved-prefix collisions; overlap/explanation precedence with existing path rules; corrupt, truncated and unrepresentable settings; failed backup and failed migration save; restart; and repeated migration. If an exact mapping cannot be demonstrated for a legacy value, migration remains blocked for that profile until explicit recovery rather than weakening its behavior.

## Engineering and evidence

Use the existing DDD boundaries and typed bridge; Rust remains the only selection/policy authority. Each roadmap slice starts from a failing behavior or screenshot/interaction assertion, makes the smallest coherent change, runs focused regressions, receives independent review, and records evidence before its checkbox is marked. Keep the app runnable. At the M3.5 gate run the full Rust and frontend suites, native WebView2 E2E, build/lint/type checks, visual comparison and accessibility checks; record unavailable macOS evidence without claiming it passed. Update STATUS/NEXT_SESSION after each accepted slice. The roadmap defines the exact slice owners, dependencies and gate.
