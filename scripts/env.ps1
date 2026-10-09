$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeHome = 'C:\Program Files\nodejs'
$localRustup = Join-Path $repoRoot '.tools\rustup'
$localCargo = Join-Path $repoRoot '.tools\cargo'
$localCargoBin = Join-Path $localCargo 'bin'
$localGccBin = Join-Path $repoRoot '.tools\gcc\w64devkit\bin'

$pathEntries = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath (Join-Path $nodeHome 'node.exe')) {
    $pathEntries.Add($nodeHome)
}

if (Test-Path -LiteralPath $localRustup) {
    $env:RUSTUP_HOME = $localRustup
}
if (Test-Path -LiteralPath $localCargo) {
    $env:CARGO_HOME = $localCargo
}
if (Test-Path -LiteralPath $localCargoBin) {
    $pathEntries.Add($localCargoBin)
}

$gnuToolchain = Join-Path $localRustup 'toolchains\stable-x86_64-pc-windows-gnu'
$msvcToolchain = Join-Path $localRustup 'toolchains\stable-x86_64-pc-windows-msvc'
$msvcAvailable = (Get-Command 'cl.exe' -ErrorAction SilentlyContinue) -or $env:VCToolsInstallDir
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not $msvcAvailable -and (Test-Path -LiteralPath $vswhere)) {
    $msvcAvailable = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if ($msvcAvailable -and (Test-Path -LiteralPath $msvcToolchain)) {
    $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
} elseif ((Test-Path -LiteralPath $gnuToolchain) -and (Test-Path -LiteralPath (Join-Path $localCargoBin 'rustup.exe'))) {
    $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
    if (Test-Path -LiteralPath $localGccBin) {
        $pathEntries.Add($localGccBin)
    }
}

$existingPath = @($env:PATH -split ';' | Where-Object { $_ })
foreach ($entry in $existingPath) {
    if (-not $pathEntries.Contains($entry)) {
        $pathEntries.Add($entry)
    }
}
$env:PATH = $pathEntries -join ';'

Remove-Variable repoRoot, nodeHome, localRustup, localCargo, localCargoBin, localGccBin, gnuToolchain, msvcToolchain, msvcAvailable, existingPath, pathEntries
