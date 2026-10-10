# ContextPick

### Select code. Export AI context.

[![Latest release](https://img.shields.io/github/v/release/Sam7/ContentPick?display_name=tag&label=latest)](https://github.com/Sam7/ContentPick/releases/latest) · [Visit the ContextPick product site](https://sam7.github.io/ContentPick/) · [Download the current release](https://github.com/Sam7/ContentPick/releases/latest)

Useful project context is scattered across source files, documentation and configuration. Gathering it for an AI assistant can mean opening files, deciding what matters, and attaching them one by one. ContextPick gives you a faster, reviewable way to collect the parts of a local project that matter into one organized Markdown file.

Choose a project folder, select the relevant files, preview the text, and check the estimated export size and token count. Then copy the context or export it as Markdown for ChatGPT, Gemini, Claude, or another tool that accepts text. You decide what goes in and where it goes next.

ContextPick can save repetitive file-by-file preparation and keep related project material together. It does not choose content for you or promise a better model response. Upload rules, supported file types and context limits vary by service, plan and feature. [Gemini’s standard upload flow currently allows up to 10 files in one prompt, subject to availability, and documents a separate code-folder/repository workflow](https://support.google.com/gemini/answer/14903178?hl=en); check the current [ChatGPT upload guidance](https://help.openai.com/en/articles/8555545-file-uploads-faq) and [Claude document guidance](https://support.anthropic.com/en/articles/8241126-what-kinds-of-documents-can-i-upload-to-claude-ai) for their rules. A Markdown export does not bypass those rules or a model’s context window.

## Download

**Latest release: v0.9.0 · Windows x64.** [Download ContextPick](https://github.com/Sam7/ContentPick/releases/download/v0.9.0/ContextPick_0.9.0_x64-setup.exe) · [Release notes and SHA-256 checksum](https://github.com/Sam7/ContentPick/releases/tag/v0.9.0)

The Windows installer is unsigned. Verify the checksum linked on the release page before installing. If WebView2 Runtime is absent, setup downloads its bootstrapper and needs network access. This release does not include a verified macOS installer; see [project status](docs/project/STATUS.md).

## How it works

1. **Open a project folder.** ContextPick builds a searchable file tree on your device.
2. **Choose the context.** Select files or folders, use the include-extension filter, and see why a file is included, excluded or ignored.
3. **Review the size.** Preview selected text and inspect export bytes, an approximate token count, and logical size for each folder.
4. **Copy or export.** Copy Markdown, use Save As, or configure a fixed export folder for one-click output. Replacing that file requires the explicit overwrite setting.

## Built for local projects

- **Context you choose:** include text files or limit the tree by extension; `.gitignore` is respected by default.
- **A readable result:** deterministic Markdown with stable paths and safe code fences.
- **Size awareness:** see selected export bytes and a local, approximate `o200k_base` token estimate before sharing.
- **Safe by default:** previews are bounded, sources stay read-only, and export failures are reported instead of silently omitting content.
- **Local and offline:** no telemetry, cloud service or source upload. Review the output before sharing it with another service.

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

Choose a folder; eligible files are selected by default. Expand directories, preview a file, change selection, inspect filter reasons, then Copy context or Export Markdown. Filters apply automatically after a short debounce. Force include is an explicit menu action; it cannot bypass binary or link guards. Ignored folders are placeholders until you explicitly browse them. The native app watches the active workspace and automatically reconciles after observed changes settle. Copy and Export stay disabled while the snapshot is stale; manual Refresh remains available if watching or a scan fails. The footer shows selected-file count, estimated export size and a cached, approximate local `o200k_base` token estimate. Folder rows show logical content size, including files that are not currently selected.

Settings and path-bound intentions are stored in the OS application config directory. Hidden files are visible; `.gitignore` is enabled by default. `.ignore`, parent/global excludes and Git metadata traversal are disabled by documented policy. Gitignore is not a secret scanner. Previews are capped at 256 KiB UTF-8 output; clipboard at 8 MiB. UTF-8/BOM UTF-16 are supported; invalid/binary content makes an export fail explicitly. Sources are never edited. New exports inside the workspace are persistently excluded from source context; existing in-workspace files are never replaced. Save As asks before replacing an outside file. Fixed-folder exports can replace one outside file only when you opt in; in-workspace fixed exports use a new numbered filename instead. Publication requires filesystem hard-link support when creating a new output and fails safely if unavailable.

Invalid settings are preserved in a bounded recovery backup before defaults can be saved. If backup fails, the app starts with a visible recovery instruction and refuses settings changes until the original is protected and the app restarted. Settings reads, writes and recovery backups are capped at 4 MiB.

Index transfer uses generation-checked pages of at most 512 entries/256 KiB serialized JSON. Scanning caps raw directory attempts at 200k, depth at 128, retained path/reason text at 16 MiB and diagnostic text at 16 KiB. A cutoff is reported as incomplete; it is not a complete selection count for unknown descendants.

Example section (UTF-8 output, source line endings preserved):

````markdown
## src/main.rs

```rust
fn main() {}
```
````

Native Windows evidence and exact limitations: [status](docs/project/STATUS.md), smoke record (local ignored artifact: `docs/testing/2026-10-08-native-smoke.md`). The `v0.9.0` Windows installer is available above. Package-manager distribution remains paused.
