# ContextPick

Select code. Export AI context.

An offline Windows/macOS desktop app being built with Tauri 2, React and a Rust core. The authoritative specification is [the charter](docs/PRODUCT_CHARTER.md). This repository is in active development; MVP and platform acceptance are not yet verified.

## Development

Prerequisites: Node 24, Corepack/pnpm 12.10.1, Rust 1.99, and [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows requires Visual Studio C++ Build Tools (Desktop development with C++, Windows SDK) and WebView2. macOS requires Xcode Command Line Tools. Windows is tested locally; macOS CI is configured but has not been run from this repository.

From a shell with Node and Cargo on PATH:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev                  # real desktop app
corepack pnpm dev:web              # synthetic browser fixture
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm build
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e
cargo test --workspace --locked
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
```

On this Windows development host, `. ./scripts/env.ps1` adds existing Node/local Rust to this process's PATH. The script does not change global settings. `./scripts/check.ps1 all` runs the frontend/Rust checks. On macOS use standard Node/Rust installs and the commands above.

The browser bridge uses synthetic fixtures only and is not evidence of native filesystem, dialog, or clipboard behavior.

### Windows native UI automation

Playwright can also drive the **real Windows Tauri WebView2** and Rust bridge. Build the debug app, then run the separate suite:

```powershell
. ./scripts/env.ps1
cargo +stable-x86_64-pc-windows-msvc build -p contextpick --locked
corepack pnpm test:native
```

The harness starts its own app with disposable synthetic sources, settings and WebView2 profile. A loopback debugging endpoint is enabled only for that test process; it does not change production app configuration. Tests and screenshots use Playwright locators and assertions. Native folder/save dialogs remain a short manual smoke check; source safety and transactional export faults are covered in Rust tests. This follows [Playwright's WebView2 setup](https://playwright.dev/docs/webview2). Windows only; not evidence for macOS.

## Current behavior

Choose a folder; eligible files are selected by default. Expand directories, preview a file, change selection, inspect filter reasons, then Copy context or Export Markdown. Force include is an explicit menu action; it cannot bypass binary or link guards. Ignored folders are placeholders until you explicitly browse them. The native app watches the active workspace and automatically reconciles after observed changes settle. Copy and Export stay disabled while the snapshot is stale; manual Refresh remains available if watching or a scan fails. The footer shows a cached, approximate local `o200k_base` token estimate for the selected files.

Settings and path-bound intentions are stored in the OS application config directory. Hidden files are visible; `.gitignore` is enabled by default. `.ignore`, parent/global excludes and Git metadata traversal are disabled by documented policy. Gitignore is not a secret scanner. Previews are capped at 256 KiB UTF-8 output; clipboard at 8 MiB. UTF-8/BOM UTF-16 are supported; invalid/binary content makes an export fail explicitly. Sources are never edited. New exports inside the workspace are persistently excluded from source context. Existing workspace paths cannot be overwritten; choose a new filename. Outside the workspace, replacing an existing file requires confirmation. Publication requires filesystem hard-link support when creating a new output and fails safely if unavailable.

Invalid settings are preserved in a bounded recovery backup before defaults can be saved. If backup fails, the app starts with a visible recovery instruction and refuses settings changes until the original is protected and the app restarted. Settings reads, writes and recovery backups are capped at 4 MiB.

Index transfer uses generation-checked pages of at most512 entries/256KiB serialized JSON. Scanning caps raw directory attempts at200k, depth at128, retained path/reason text at16MiB and diagnostic text at16KiB. A cutoff is reported as incomplete; it is not a complete selection count for unknown descendants.

Example section (UTF-8 output, source line endings preserved):

````markdown
## src/main.rs

```rust
fn main() {}
```
````

Native Windows evidence and exact limitations: [status](docs/project/STATUS.md), smoke record (local ignored artifact: `docs/testing/2026-10-08-native-smoke.md`). No installer or public release is claimed.
