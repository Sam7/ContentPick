$ErrorActionPreference = 'Stop'

# Tauri's currentUser NSIS uninstall registration is per-user. Resolve its
# actual registered uninstaller instead of assuming an install directory.
$entry = Get-UninstallRegistryKey -SoftwareName 'ContextPick' |
    Select-Object -First 1
if (-not $entry -or -not $entry.UninstallString) {
    throw 'ContextPick uninstall registration was not found; refusing to report a successful package uninstall.'
}

$uninstallString = [Environment]::ExpandEnvironmentVariables([string] $entry.UninstallString)
if ($uninstallString -match '^\s*"(?<path>[^"]+)"') {
    $uninstaller = $Matches.path
} elseif ($uninstallString -match '^\s*(?<path>\S+)') {
    $uninstaller = $Matches.path
} else {
    throw 'ContextPick uninstall registration contains no executable path.'
}

if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "ContextPick uninstaller was not found: $uninstaller"
}

$process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) {
    throw "ContextPick silent uninstaller exited with code $($process.ExitCode)."
}
