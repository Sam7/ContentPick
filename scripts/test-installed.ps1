param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [string]$ExpectedUserSid,
    [uint32]$ExpectedSessionId
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required for bounded process-tree cleanup.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$appDataRoot = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData))
$appConfigDir = Join-Path $appDataRoot 'dev.contextpick.desktop'
$localAppDataRoot = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData))
$installDir = Join-Path $localAppDataRoot 'ContextPick'
$installedExe = Join-Path $installDir 'contextpick.exe'
$nsisPreferencePath = 'HKCU:\Software\contextpick\ContextPick'
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
function Find-MachineContextPickInstallations {
    $matches = [System.Collections.Generic.List[object]]::new()
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $baseKey = $null
        $uninstallKey = $null
        try {
            $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
            $uninstallKey = $baseKey.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
            if (-not $uninstallKey) { continue }
            foreach ($subkeyName in $uninstallKey.GetSubKeyNames()) {
                $entry = $null
                try {
                    $entry = $uninstallKey.OpenSubKey($subkeyName)
                    $displayName = [string]$entry.GetValue('DisplayName')
                    if ($displayName -like 'ContextPick*') {
                        $matches.Add([pscustomobject]@{ View = $view; DisplayName = $displayName; Subkey = $subkeyName })
                    }
                } finally {
                    if ($entry) { $entry.Dispose() }
                }
            }
        } finally {
            if ($uninstallKey) { $uninstallKey.Dispose() }
            if ($baseKey) { $baseKey.Dispose() }
        }
    }
    return $matches.ToArray()
}
function Get-DescendantProcessIds {
    param([Parameter(Mandatory = $true)] [int]$RootProcessId)
    $processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId)
    $tree = [System.Collections.Generic.HashSet[int]]::new()
    $null = $tree.Add($RootProcessId)
    do {
        $changed = $false
        foreach ($candidate in $processes) {
            if ($tree.Contains([int]$candidate.ParentProcessId) -and $tree.Add([int]$candidate.ProcessId)) { $changed = $true }
        }
    } while ($changed)
    return @($tree | Where-Object { $_ -ne $RootProcessId })
}
function Wait-ForProcessTreeExit {
    param(
        [Parameter(Mandatory = $true)] [int]$RootProcessId,
        [Parameter(Mandatory = $true)] [int[]]$DescendantProcessIds,
        [Parameter(Mandatory = $true)] [int]$TimeoutSeconds
    )
    $expected = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($processId in $DescendantProcessIds) { $null = $expected.Add($processId) }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $running = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId)
        if (-not ($running | Where-Object { $expected.Contains([int]$_.ProcessId) })) {
            $rootRunning = $running | Where-Object { [int]$_.ProcessId -eq $RootProcessId }
            if (-not $rootRunning) { return $true }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}
function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)] [string]$FilePath,
        [Parameter(Mandatory = $true)] [string[]]$ArgumentList,
        [Parameter(Mandatory = $true)] [string]$Operation,
        [Parameter(Mandatory = $true)] [int]$TimeoutSeconds
    )
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $script:processTreeStopped = $false
        try {
            $descendants = @(Get-DescendantProcessIds -RootProcessId $process.Id)
            $process.Kill($true)
            if (-not $process.WaitForExit(5000) -or -not (Wait-ForProcessTreeExit -RootProcessId $process.Id -DescendantProcessIds $descendants -TimeoutSeconds 5)) {
                throw 'The timed-out process tree did not exit after termination.'
            }
            $script:processTreeStopped = $true
        } catch {
            Write-Warning "Could not stop the timed-out $Operation process tree rooted at PID $($process.Id): $_"
        }
        throw "$Operation timed out after $TimeoutSeconds seconds (PID $($process.Id))."
    }
    $process.Refresh()
    return [int]$process.ExitCode
}
function Wait-ForContextPickRemoval {
    param([Parameter(Mandatory = $true)] [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $registration = @(
            Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue |
                Get-ItemProperty -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -like 'ContextPick*' -or $_.InstallLocation -eq $installDir }
        )
        if (-not (Test-Path -LiteralPath $installedExe) -and $registration.Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}
if (Test-Path -LiteralPath $appConfigDir) {
    throw "Refusing to use existing ContextPick settings at $appConfigDir. Run this smoke test under a clean Windows user profile."
}
$existingPreference = Get-Item -LiteralPath $nsisPreferencePath -ErrorAction SilentlyContinue
if ($existingPreference) {
    throw "Refusing to test with a remembered NSIS install path at $nsisPreferencePath. Use a clean Windows user profile."
}
$expectedUninstall = @(
    Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue |
        Get-ItemProperty -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'ContextPick*' }
)
if ($expectedUninstall.Count -gt 0 -or (Test-Path -LiteralPath $installDir)) {
    throw "Refusing to replace an existing ContextPick installation at $installDir."
}
$machineInstallations = @(Find-MachineContextPickInstallations)
if ($machineInstallations.Count -gt 0) {
    $found = ($machineInstallations | ForEach-Object { "$($_.DisplayName) ($($_.View), $($_.Subkey))" }) -join ', '
    throw "Refusing to test because the NSIS installer may remove a matching machine-wide installation: $found."
}
$cleanupSafe = $false
$installationAttempted = $false
$script:processTreeStopped = $true

try {
    $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
    Write-Output "Installer: $installer"
    Write-Output "SHA-256: $hash"
    $isElevated = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Write-Output "Administrator role enabled: $isElevated"
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $sessionId = [uint32][Diagnostics.Process]::GetCurrentProcess().SessionId
    if ([string]::IsNullOrWhiteSpace($ExpectedUserSid)) { $ExpectedUserSid = $identity.User.Value }
    if (-not $PSBoundParameters.ContainsKey('ExpectedSessionId')) { $ExpectedSessionId = $sessionId }
    $groupsCsv = & whoami.exe /groups /fo csv /nh
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the lifecycle token integrity level.' }
    $mediumIntegrity = @($groupsCsv | Where-Object { $_ -match 'S-1-16-8192' }).Count -gt 0
    Write-Output "User SID: $($identity.User.Value)"
    Write-Output "Session ID: $sessionId"
    Write-Output "Medium integrity (S-1-16-8192): $mediumIntegrity"
    Write-Output 'Token context: reduced-token lifecycle test; this is not a security sandbox.'
    if ($identity.User.Value -ne $ExpectedUserSid) { throw "Lifecycle SID $($identity.User.Value) does not match parent SID $ExpectedUserSid." }
    if ($sessionId -ne $ExpectedSessionId) { throw "Lifecycle session $sessionId does not match parent session $ExpectedSessionId." }
    if ($isElevated) { throw 'The installed-app lifecycle must run without the Administrators role.' }
    if (-not $mediumIntegrity) { throw 'The installed-app lifecycle must run at medium integrity (S-1-16-8192).' }

    $installationAttempted = $true
    $installExitCode = Invoke-BoundedProcess -FilePath $installer -ArgumentList @('/S') -Operation 'Silent NSIS install' -TimeoutSeconds 1200
    if ($installExitCode -ne 0) { throw "Silent NSIS install failed with exit code $installExitCode." }
    $registration = @(
        Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue |
            Get-ItemProperty -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like 'ContextPick*' }
    )
    if ($registration.Count -ne 1) { throw "Expected one per-user uninstall registration, found $($registration.Count)." }
    $registeredLocation = [string]$registration[0].InstallLocation
    if (-not [string]::IsNullOrWhiteSpace($registeredLocation)) {
        $registeredPath = [System.IO.Path]::GetFullPath($registeredLocation.Trim().Trim('"'))
        if (-not $registeredPath.Equals($installDir, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Installer registered an unexpected location: $registeredLocation."
        }
    }
    if (-not $installDir.StartsWith($localAppDataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Expected a per-user install below LocalAppData, received $installDir."
    }
    if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw 'Installed contextpick.exe is missing.' }
    foreach ($relativePath in @('licenses\LICENSE', 'licenses\frontend.txt', 'licenses\rust.html', 'licenses\ATTRIBUTION.md')) {
        $resourcePath = Join-Path $installDir $relativePath
        if (-not (Test-Path -LiteralPath $resourcePath -PathType Leaf)) { throw "Installed third-party/project notice is missing: $relativePath" }
    }
    if (Test-Path -LiteralPath (Join-Path $installDir 'LICENSE')) { throw 'The project license should only be installed under licenses\LICENSE.' }

    . (Join-Path $repoRoot 'scripts/env.ps1')
    Push-Location $repoRoot
    $previousNativeExecutable = $env:CONTEXTPICK_NATIVE_EXECUTABLE
    $previousNativeConfigDir = $env:CONTEXTPICK_NATIVE_CONFIG_DIR
    try {
        $env:CONTEXTPICK_NATIVE_EXECUTABLE = $installedExe
        $env:CONTEXTPICK_NATIVE_CONFIG_DIR = $appConfigDir
        corepack pnpm test:native:installed
        if ($LASTEXITCODE -ne 0) { throw "Installed-app Playwright smoke failed with exit code $LASTEXITCODE." }
    } finally {
        if ($null -eq $previousNativeExecutable) {
            Remove-Item Env:\CONTEXTPICK_NATIVE_EXECUTABLE -ErrorAction SilentlyContinue
        } else {
            $env:CONTEXTPICK_NATIVE_EXECUTABLE = $previousNativeExecutable
        }
        if ($null -eq $previousNativeConfigDir) {
            Remove-Item Env:\CONTEXTPICK_NATIVE_CONFIG_DIR -ErrorAction SilentlyContinue
        } else {
            $env:CONTEXTPICK_NATIVE_CONFIG_DIR = $previousNativeConfigDir
        }
        Pop-Location
    }

    $uninstaller = Join-Path $installDir 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'NSIS uninstaller is missing.' }
    $removeExitCode = Invoke-BoundedProcess -FilePath $uninstaller -ArgumentList @('/S') -Operation 'Silent NSIS uninstall' -TimeoutSeconds 300
    if ($removeExitCode -ne 0) { throw "Silent NSIS uninstall failed with exit code $removeExitCode." }
    if (-not (Wait-ForContextPickRemoval -TimeoutSeconds 30)) { throw 'Uninstall did not remove the application and its registration within 30 seconds.' }
    $remaining = @(
        Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue |
            Get-ItemProperty -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like 'ContextPick*' -or $_.InstallLocation -eq $installDir }
    )
    if ($remaining.Count -gt 0) { throw 'Uninstall left ContextPick registered for this user.' }
    if (Test-Path -LiteralPath $installDir) {
        $remainingFiles = @(Get-ChildItem -LiteralPath $installDir -Force)
        if ($remainingFiles.Count -eq 0) {
            Remove-Item -LiteralPath $installDir
        } else {
            throw 'Uninstall left files in the application install directory.'
        }
    }
    $cleanupSafe = $true
} finally {
    if (-not $script:processTreeStopped) {
        Write-Warning 'Preserving the installation for diagnosis because a timed-out installer process tree could not be confirmed stopped.'
    } elseif (-not $cleanupSafe -and (Test-Path -LiteralPath $installDir)) {
        $uninstaller = Join-Path $installDir 'uninstall.exe'
        if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
            try {
                $removeExitCode = Invoke-BoundedProcess -FilePath $uninstaller -ArgumentList @('/S') -Operation 'Cleanup NSIS uninstall' -TimeoutSeconds 300
                if ($removeExitCode -eq 0 -and (Wait-ForContextPickRemoval -TimeoutSeconds 30)) { $cleanupSafe = $true }
            } catch {
                Write-Warning "Could not safely uninstall the smoke-test application: $_"
            }
        }
    }
    if ($cleanupSafe -and $installationAttempted) {
        $preference = Get-Item -LiteralPath $nsisPreferencePath -ErrorAction SilentlyContinue
        if ($preference) {
            $rememberedPath = [string]$preference.GetValue('')
            if ([System.IO.Path]::GetFullPath($rememberedPath).Equals($installDir, [System.StringComparison]::OrdinalIgnoreCase) -and $preference.SubKeyCount -eq 0 -and $preference.ValueCount -eq 1) {
                Remove-Item -LiteralPath $nsisPreferencePath
            } else {
                $cleanupSafe = $false
                Write-Warning "Preserving unexpected NSIS install preference for diagnosis: $rememberedPath"
            }
        }
    }
    if ($cleanupSafe -and (Test-Path -LiteralPath $appConfigDir)) {
        try {
            $resolvedAppConfig = [System.IO.Path]::GetFullPath($appConfigDir)
            $resolvedAppData = $appDataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
            $settings = Get-Content -LiteralPath (Join-Path $resolvedAppConfig 'settings.json') -Raw | ConvertFrom-Json
            $recentRootValue = [string]$settings.recentRoot
            if ($recentRootValue.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
                $recentRootValue = '\\' + $recentRootValue.Substring(8)
            } elseif ($recentRootValue.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
                $recentRootValue = $recentRootValue.Substring(4)
            }
            $recentRoot = [System.IO.Path]::GetFullPath($recentRootValue)
            $fixtureDir = Split-Path -Parent $recentRoot
            $fixtureName = Split-Path -Leaf $fixtureDir
            $insideTemp = $recentRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)
            $ownedFixture = $fixtureName.StartsWith('contextpick-native-playwright-', [System.StringComparison]::Ordinal)
            $isExpectedPath = $resolvedAppConfig.Equals((Join-Path $resolvedAppData 'dev.contextpick.desktop'), [System.StringComparison]::OrdinalIgnoreCase)
            $isReparsePoint = (Get-Item -LiteralPath $resolvedAppConfig -Force).Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)
            if (-not ($insideTemp -and $ownedFixture -and $isExpectedPath -and -not $isReparsePoint)) {
                throw 'The app config directory did not contain only the expected disposable smoke-test state.'
            }

            $configEntries = @(Get-ChildItem -LiteralPath $resolvedAppConfig -Force -Recurse)
            if (@($configEntries | Where-Object { $_.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint) }).Count -gt 0) {
                throw 'The app config directory contains a reparse point; preserving it for diagnosis.'
            }
            $rootEntries = @(Get-ChildItem -LiteralPath $resolvedAppConfig -Force)
            if (@($rootEntries | Where-Object { $_.Name -notin @('settings.json', 'settings-recovery') }).Count -gt 0) {
                throw 'The app config directory contains unexpected files; preserving it for diagnosis.'
            }
            $settingsFile = Join-Path $resolvedAppConfig 'settings.json'
            if (-not (Test-Path -LiteralPath $settingsFile -PathType Leaf)) {
                throw 'The smoke-test settings file is missing; preserving the app config directory.'
            }
            $recoveryDir = Join-Path $resolvedAppConfig 'settings-recovery'
            $recoveryFiles = @()
            if (Test-Path -LiteralPath $recoveryDir) {
                if (-not (Test-Path -LiteralPath $recoveryDir -PathType Container)) {
                    throw 'The settings-recovery path is not a directory; preserving app settings.'
                }
                $recoveryEntries = @(Get-ChildItem -LiteralPath $recoveryDir -Force -Recurse)
                if (@($recoveryEntries | Where-Object { $_.PSIsContainer -or $_.Name -notmatch '^settings-[0-9]+-[0-9]+\.json$' }).Count -gt 0) {
                    throw 'The settings-recovery directory contains unexpected entries; preserving app settings.'
                }
                $recoveryFiles = @($recoveryEntries)
                foreach ($recoveryFile in $recoveryFiles) {
                    $snapshot = Get-Content -LiteralPath $recoveryFile.FullName -Raw | ConvertFrom-Json
                    $snapshotRootValue = [string]$snapshot.recentRoot
                    if ($snapshotRootValue.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
                        $snapshotRootValue = '\\' + $snapshotRootValue.Substring(8)
                    } elseif ($snapshotRootValue.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
                        $snapshotRootValue = $snapshotRootValue.Substring(4)
                    }
                    $snapshotRoot = [System.IO.Path]::GetFullPath($snapshotRootValue)
                    $snapshotFixture = Split-Path -Parent $snapshotRoot
                    $snapshotFixtureName = Split-Path -Leaf $snapshotFixture
                    if (-not ($snapshotRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and $snapshotFixtureName.StartsWith('contextpick-native-playwright-', [System.StringComparison]::Ordinal))) {
                        throw 'A recovery snapshot does not point to the disposable Playwright fixture; preserving app settings.'
                    }
                }
            }

            foreach ($recoveryFile in $recoveryFiles) { Remove-Item -LiteralPath $recoveryFile.FullName -Force }
            if (Test-Path -LiteralPath $recoveryDir) { Remove-Item -LiteralPath $recoveryDir }
            Remove-Item -LiteralPath $settingsFile -Force
            Remove-Item -LiteralPath $resolvedAppConfig
            Write-Output 'Removed the disposable smoke-test app settings.'
        } catch {
            $cleanupSafe = $false
            Write-Warning "Preserving app settings for diagnosis: $_"
        }
    }
    if ($cleanupSafe -and (Test-Path -LiteralPath $installDir)) {
        $remainingFiles = @(Get-ChildItem -LiteralPath $installDir -Force)
        if ($remainingFiles.Count -eq 0 -and $installDir.StartsWith($localAppDataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $installDir
        } else {
            $cleanupSafe = $false
            Write-Warning "Preserving non-empty install directory for diagnosis: $installDir"
        }
    }
}
