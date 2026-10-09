# Contributing to ContextPick

ContextPick is an offline desktop utility. Read the [product charter](docs/PRODUCT_CHARTER.md) and [working agreements](AGENTS.md) before changing behavior. Keep domain rules in `crates/contextpick-core`, use synthetic fixtures, and preserve the guarantees that source files are never modified and user code is never uploaded or sent to telemetry/cloud services.

## Development setup

Install Node.js 24, Corepack with pnpm 12.10.1, Rust 1.99, and the platform prerequisites in the [Tauri guide](https://v2.tauri.app/start/prerequisites/). Windows needs Visual Studio C++ Build Tools (Desktop development with C++, Windows SDK) and WebView2. macOS needs Xcode Command Line Tools.

From the repository root:

```sh
corepack pnpm install --frozen-lockfile
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

On the configured Windows development host, run `. ./scripts/env.ps1` first in PowerShell to add the repository's existing Node and Rust toolchains to the current shell. The Windows native WebView2 suite also requires:

```powershell
cargo +stable-x86_64-pc-windows-msvc build -p contextpick --locked
corepack pnpm test:native
```

`pnpm test:e2e` uses synthetic browser fixtures; it does not validate native filesystem, dialog or clipboard behavior. `pnpm test:native` exercises real Windows WebView2 and is not evidence for macOS. Report checks skipped for platform or missing dependencies as unverified, not passed. The [README](README.md) describes current platform evidence and additional smoke-test limits.

For an unsigned release candidate, install the pinned notice generator and prepare notices for the bundle target before building:

```sh
cargo install cargo-about --version 0.9.2 --locked --root .tools/license-audit --features cli
corepack pnpm licenses:rust windows-x64 # or macos-x64 / macos-arm64
node licenses/generate-frontend-notices.mjs
corepack pnpm exec tauri build --bundles nsis # use dmg for macOS
```

The installer and its hash are written under `target/release/bundle`. The standard-user Windows install, launch and uninstall smoke is `scripts/test-installed.ps1`; it needs PowerShell 7, a disposable clean user profile, and the app's existing WebView2 runtime. It does not prove first-install WebView2 provisioning or restricted-network behavior. See the [distribution evidence checklist](docs/project/DISTRIBUTION_REQUIREMENTS.md#release-evidence-and-completion) for signing and external-channel gates.

## Change expectations

- Start with a focused failing behavior test where practical; implement the smallest correct change, then refactor and run relevant checks.
- Keep selection, filtering, path safety and export policy in the Rust core. Avoid duplicate policy in React or Tauri commands.
- Add synthetic tests for boundaries and failures. Do not use real source repositories or sensitive files as fixtures.
- Keep changes small and explain behavior, verification commands and platform limits in the pull request.
- Do not add network access, telemetry, source uploads, credentials or unrelated features. Do not edit users' source files.
- Do not publish releases, submit packages, sign/notarize artifacts or change repository settings as part of a contribution.
- New runtime or development dependencies need a documented reason and a license/permission review. Do not infer full third-party license compliance solely from package metadata.

The path-based wordmark in `docs/design/contextpick-brand.svg` contains outlined contours derived from Nunito Black. Its authorship and SIL Open Font License 1.1 attribution are recorded in [`docs/design/ATTRIBUTION.md`](docs/design/ATTRIBUTION.md); no font file is included.
