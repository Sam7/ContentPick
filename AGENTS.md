# ContextPick working agreements

- Authoritative product contract: `docs/PRODUCT_CHARTER.md`.
- Resume from `docs/project/NEXT_SESSION.md`, `STATUS.md`, and the active plan; reconcile with Git and actual test results.
- Root owns architecture, integration and checkpoints. Delegate focused disjoint tasks to Luna; use Sol for security and architecture review. No overlapping edits.
- Work in small vertical slices using red → green → refactor. Record real commands/results; skipped and unavailable checks are not passes.
- Domain rules live once in `crates/contextpick-core`, never in React or Tauri commands. Persist user intent separately from current policy.
- Hard guards override user force-inclusion. Keep paths inside the root, skip links, bound previews, prune ignored subtrees, stream deterministic exports, never mutate sources.
- Offline app: no telemetry, cloud services or source uploads. Use synthetic fixtures in tests.
- After each slice obtain independent review, fix significant findings, update status and continue toward P0. Architecture reviews at M2/M4/M5.
- The user requested a commit and push after each milestone. After its gate passes, review and stage only the verified milestone scope, confirm the branch/upstream, commit and push; record the resulting commit. This does not authorize release publication or signing.
- Prefer small modules and established libraries; avoid speculative interfaces, duplicate policies, and peripheral features.
- No destructive unrelated changes, credential use or public publishing without authorization.
- Commands and current environment limitations: README. Run affected tests during development and full checks at milestone gates.
- Prefer Playwright for repeatable UI tests and screenshots, including the real Windows WebView2 suite (`pnpm test:native`). Reserve desktop automation for native OS dialogs and short smoke checks. Run expensive scale fixtures at milestone gates, not after every small UI edit.
