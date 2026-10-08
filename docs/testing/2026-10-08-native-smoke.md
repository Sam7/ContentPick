# Native Windows smoke — 2026-10-08

Host: Windows x64, Node 24.19.0, Rust 1.99.0 MSVC, Tauri 2.12.1, WebView2 154. Build Tools 2022 installed with VC Tools workload and SDK after user authorization. Started `. ./scripts/env.ps1; $env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'; corepack pnpm dev` with isolated debug `CONTEXTPICK_CONFIG_DIR` under `.tools`.

Used Computer Use against the actual `target/debug/contextpick.exe` window, not the browser fixture. Native Windows folder dialog selected `.tools/smoke-repo`. The fixture has ten eligible text files, a self-ignored `.gitignore`, and ignored `dist/deep/generated.ts`.

- Actual native UI displayed **10 selected files**, **14 discovered entries**, and a pruned muted `dist` placeholder with source rule.
- Clicking README displayed its actual synthetic source via Rust preview.
- Native Copy returned **10 files / 615 bytes**. Read clipboard after this known synthetic write and asserted 10 Markdown sections, UTF-8 byte length 615, no ignored sentinel.
- Native Save As wrote `.tools/smoke-output/context.md`. UI reported **10 files / 615 bytes**; filesystem measurement and section count matched, ignored sentinel absent.
- Initial file verification was attempted before the save dialog had actually closed and failed (file absent); after clicking the visible Save button, verification passed. This was automation geometry/timing, not a passed initial check.

Observed UX issue: export controls were clipped at the default size; frontend fix made the bar persistent and is being regression tested. Directory ordering and virtualisation are still being improved. Windows extended-path prefix is currently shown in location display; cosmetic refinement pending.

Not yet established by this smoke: restart restoration, complete P0 fixture catalogue, performance, watcher behavior, release packaging or any macOS behavior. No public release was created.
