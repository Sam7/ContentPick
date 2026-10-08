# Actual Windows app automation — 2026-10-08

Following the user's request to reduce desktop automation, the separate Playwright suite attaches to the actual Tauri WebView2 through an ephemeral loopback CDP endpoint. No IPC mocks, test commands, production hooks or additional dependencies were added. Sources, settings, WebView2 profile and a copy of the debug executable are isolated in an owned temporary directory. Cleanup verifies canonical identity/containment before removing it, and terminates only its own process tree.

```powershell
. ./scripts/env.ps1
cargo +stable-x86_64-pc-windows-msvc build -p contextpick --locked
corepack pnpm test:native
```

Root independently ran the full frontend checks after integration: typecheck, ESLint,25 RTL, production build and7 browser E2E passed. **Native Playwright2/2 passed in9.8 seconds**, including app startup/relaunch/teardown and synthetic fixture creation. The605 discovered entries require multiple512-entry IPC pages; tail-file599 was found and previewed through the real Rust bridge.

Native coverage:

- Restore recent synthetic root, load pages, search tail file, bounded preview.
- Exclude README, toggle Gitignore off/on while retaining that intent.
- Browse two ignored directory levels, force include a named file, reset its override.
- Copy reports601 files; no alert. Real restart restores selection and policy.
- Delete a selected fixture source after scanning; Copy shows a visible filename-specific error and no copied-success status.

Root measured **1,445ms** from launching the debug app until the restored605-entry tree was ready, Copy enabled and Cancel absent. Earlier agent run:1,309ms. These are individual local Windows debug/Vite observations, not percentile targets or20k workspace timing.

Independent Sol source review found no material harness issue. Native folder picker/Save As remain short manual smoke checks. These tests do not read clipboard bytes (the separate native smoke did), automate20k timing, establish whole-app peak memory, validate macOS, or close the entire P0 gate. The browser fixture tests remain the fast path for layout/interaction regressions. [Playwright's documented WebView2 attachment](https://playwright.dev/docs/webview2).
