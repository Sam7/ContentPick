# ContextPick

### Turn a codebase into AI-ready context

Preparing a useful prompt from a real project often means hunting through files, deciding what matters, and attaching them one by one. ContextPick lets you choose the relevant parts of a local workspace, preview them, and export one organized Markdown file for ChatGPT, Gemini, Claude, or another tool that accepts text.

Select the files and folders that matter, see what is included and the estimated size, then copy or export the result. The source stays on your computer until you choose to export and share it. ContextPick does not upload files or promise a particular model response; it helps you give an assistant more of the related code and documentation together.

Upload workflows and limits vary by service, plan and feature. For example, [Gemini documents up to 10 files per prompt and a separate code-folder/repository workflow](https://support.google.com/gemini/answer/14903178?hl=en-GB); [ChatGPT](https://help.openai.com/en/articles/8555545-file-uploads-faq) and [Claude](https://support.anthropic.com/en/articles/8241126-what-kinds-of-documents-can-i-upload-to-claude-ai) have their own project, GPT and chat rules. ContextPick creates a single file you can review and use where it fits; it does not bypass upload policies or model context windows.

## Download

**Current preview: v0.1.0 for Windows x64.** [Download the installer](https://github.com/Sam7/ContentPick/releases/download/v0.1.0/ContextPick_0.1.0_x64-setup.exe) · [Release notes and SHA-256 checksum](https://github.com/Sam7/ContentPick/releases/tag/v0.1.0)

This is an unsigned preview, not the planned final `0.9` release. Verify the checksum linked on the release page before installing. macOS release packaging and Gatekeeper acceptance are not yet verified; see [project status](docs/project/STATUS.md).

## What it does

- Scans a chosen workspace locally and shows a searchable, virtualized file tree.
- Lets you select files and folders, respect `.gitignore`, preview bounded text and understand why files are included or excluded.
- Estimates export size and local token count, then copies or exports deterministic Markdown.
- Keeps sources read-only and reports export errors instead of silently skipping content.

The app is offline: no telemetry, cloud service or source upload. You decide what to include and where to share the exported file. Review the output before sending it to a third-party assistant.

## Development

The desktop app uses Tauri 2, React and a Rust core. The product contract is [PRODUCT_CHARTER.md](docs/PRODUCT_CHARTER.md), the delivery checklist is [ROADMAP.md](docs/project/ROADMAP.md), and current evidence/limitations are in [STATUS.md](docs/project/STATUS.md).

Prerequisites: Node 24, Corepack/pnpm 12.10.1, Rust 1.99 and [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows requires Visual Studio C++ Build Tools (Desktop development with C++, Windows SDK) and WebView2. macOS requires Xcode Command Line Tools.

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

On this Windows development host, `. ./scripts/env.ps1` adds existing Node/local Rust to this process's PATH. The script does not change global settings. `./scripts/check.ps1 all` runs the frontend/Rust checks. The browser bridge uses synthetic fixtures only and is not evidence of native filesystem, dialog or clipboard behavior.

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

Native Windows evidence and exact limitations: [status](docs/project/STATUS.md), smoke record (local ignored artifact: `docs/testing/2026-10-08-native-smoke.md`). The downloadable `v0.1.0` Windows preview is linked above; it is not final `0.9` or package-manager availability.
