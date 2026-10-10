$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
    $env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'

    corepack pnpm exec tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed with exit code $LASTEXITCODE." }

    node scripts/prepare-msix.mjs
    if ($LASTEXITCODE -ne 0) { throw "MSIX layout preparation failed with exit code $LASTEXITCODE." }

    $appVersion = (Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
    $output = Join-Path $repoRoot "target/msix/ContextPick-$appVersion.msix"
    npm exec --yes --package=@microsoft/winappcli@0.7.1 -- winapp package target/msix/package-layout --no-sign --output $output
    if ($LASTEXITCODE -ne 0) { throw "MSIX packaging failed with exit code $LASTEXITCODE." }

    if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw "MSIX package was not created: $output." }
    $hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Output "MSIX candidate: $output"
    Write-Output "SHA-256: $hash"
} finally {
    Pop-Location
}
