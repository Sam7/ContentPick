# Microsoft Store MSIX

ContextPick keeps its GitHub NSIS installer. The Store candidate is a separate, unsigned x64 MSIX; Microsoft signs Store packages after certification. The package uses the existing Tauri executable, WebView2 loader, product icons and license notices.

## Build a candidate on Windows

Use PowerShell with the repository toolchain on `PATH` (`. .\scripts\env.ps1`). The manifest pins the reserved Partner Center identity: `DotSam.ContextPick`, publisher `CN=9CF819D8-048A-42F9-91C4-E85E76577891`, display name `DotSam`. These are public package metadata, not secrets. Set only the Windows versions actually supported and tested; never use the local test identity for Store submission.

```powershell
$env:CONTEXTPICK_MSIX_MIN_VERSION = '10.0.19045.0'
$env:CONTEXTPICK_MSIX_MAX_VERSION_TESTED = '10.0.26200.9457'
./scripts/package-msix.ps1
```

The script uses Microsoft `winapp` CLI `0.7.1` (pinned via `npm exec`), opts out of CLI telemetry, builds the current Tauri release, stages a clean layout under ignored `target/msix/`, and creates an unsigned `.msix`. The Store identity is fixed in the manifest template; tested OS bounds are mandatory and packaging fails on invalid values or missing files. Semver `0.9.1` maps to Store package version `1.9.1.0` because MSIX package major versions cannot be zero. Update packages must use a monotonically increasing package version. Do not replace an existing published Store binary in place.

## Runtime and install validation

The GitHub NSIS install still downloads the WebView2 bootstrapper when needed. MSIX does not run that NSIS prerequisite step. Microsoft documents Evergreen WebView2 as included with Windows 11 and with Windows 10 1803+ after its November 2022 update, while noting it can be missing on clean Windows 10, LTSC or server configurations. The manifest does not claim that a Store install chains the runtime: Microsoft's [`win32dependencies:ExternalDependency`](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-win32dependencies-externaldependency) applies only to Microsoft App Installer, not other install mechanisms. Verify the current [WebView2 distribution guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) when changing the minimum OS or runtime strategy.

Before Store submission, test the actual MSIX on supported Windows 10 and Windows 11 systems, including a clean Windows 10 machine without a previously installed WebView2 Runtime. Verify install, launch, workspace picker, scan, preview, file watching, settings persistence, export, upgrade and uninstall. If a supported configuration cannot launch without WebView2, resolve that distribution path or document the limitation before submission; do not treat successful packaging as install evidence.

To exercise package identity locally, unpack the candidate MSIX with the Windows SDK's `makeappx` and pass the resulting layout directory (not the `.msix` file) to `winapp run`:

```powershell
makeappx unpack /p target/msix/ContextPick-0.9.0.msix /d target/msix/unpacked
npm exec --yes --package=@microsoft/winappcli@0.7.1 -- winapp run target/msix/unpacked
```

This registers and launches the unpacked layout as a loose package; it is a package-identity development smoke test, not an install of the signed Store artifact. It requires Windows Developer Mode. On 2026-10-10 the command reached launch and was blocked because Developer Mode is off. `node --test scripts/prepare-msix.check.mjs` covers safe layout generation, identity escaping, OS bounds, version mapping, missing input and staging-path redirection. A successful `winapp package` only proves package creation; it is not Store certification or public availability.

## Store onboarding and update automation

The first app reservation, first submission and first publication must be completed in Partner Center. Microsoft says the [Store Developer CLI](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/overview) can automate subsequent submissions only after first publication. Before automating updates, record the reserved identity and product ID, complete the initial listing and age rating, associate an Entra application with Partner Center, and store its tenant/client IDs and client secret as GitHub Actions secrets. Never commit credentials or enable automatic publishing until the initial listing and package have been reviewed. Track package build, validation, submission, certification/acceptance and public Store installation as separate outcomes.

The reserved Store ID is `9NJ3T87DK1SJ` (`https://apps.microsoft.com/detail/9NJ3T87DK1SJ`); this identifies the product but does not mean it has been submitted or published. Use the public [ContextPick product site](https://sam7.github.io/ContentPick/) for the optional Website field and [GitHub Issues](https://github.com/Sam7/ContentPick/issues) for the optional support contact URL. Microsoft accepts a web page or support email; support contact is required only when the app is available on Xbox. See [MSIX support information](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/support-info).
