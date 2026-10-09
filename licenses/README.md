# Third-party notices

These files are generated from the locked application dependency graph for M5.5. They report package metadata and source license texts; they do not determine legal compatibility or replace maintainer review.

## Rust

Generator: `cargo-about 0.9.2`, pinned for repeatable installation:

Install the pinned tool and use the cross-platform wrapper. It generates the selected target report and copies it to the Tauri bundle input `licenses/generated/rust.html`:

```sh
cargo install cargo-about --version 0.9.2 --locked --root .tools/license-audit --features cli
corepack pnpm licenses:rust windows-x64
corepack pnpm licenses:rust macos-x64
corepack pnpm licenses:rust macos-arm64
```

It requires `cargo-about 0.9.2` and fails on other versions. On Windows, source `. ./scripts/env.ps1` first if the repository Rust toolchain is not already on `PATH`.

The `accepted` priority list contains SPDX identifiers present in the locked Windows/macOS runtime graphs. BSD-3-Clause then MIT are prioritized to select the exact texts present in two clarified crate archives. The list lets cargo-about select an option from `OR` expressions and render the corresponding full text; it is an inventory for disclosure, not a legal compatibility determination. `--fail` keeps generation closed for expressions outside this reviewed inventory. Do not use `--offline` for final reports: cargo-about documents that it cannot query external license sources in offline mode and may lose crate-specific license text or copyright details. Generate each architecture separately because cargo-about evaluates target lists as a union.

Two published Cargo.toml expressions use `/` where SPDX requires `OR`. The checked-in hash-bound clarifications render the license text actually present in each locked crate archive while preserving the original declaration here:

| Crate | Cargo.toml declaration | Reported text | Evidence |
|---|---|---|---|
| `ident_case 1.0.1` | `MIT/Apache-2.0` | MIT | `LICENSE`, SHA-256 `508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1` |
| `brotli-decompressor 6.0.1` | `BSD-3-Clause/MIT` | BSD-3-Clause | `LICENSE`, SHA-256 `c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae` |

`cargo-about` clarifications override the package expression in generated output; the report labels the resolved notice expression, not raw Cargo metadata. Review each target report's crate/version associations and full texts whenever `Cargo.lock` changes. Do not claim license compatibility from metadata or these notices alone.

## Frontend

Generate the production frontend notices directly from pnpm's installed production dependency report and each package's license files:

```powershell
node licenses/generate-frontend-notices.mjs
```

The script fails closed for missing/mismatched package metadata, unknown license identifiers, or missing texts. It includes both available license texts for `OR` expressions and preserves each package's original expression. Review the generated file after every lockfile change. This graph is shared by the Windows and macOS builds.

The frontend notice is reproducible from the pnpm lockfile and installed package contents. Regenerate and inspect both frontend and target-specific Rust notices whenever their lockfiles or package contents change.
