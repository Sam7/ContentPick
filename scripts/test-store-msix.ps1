param(
    [switch]$AllowLocalWin11X64
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)] [string]$FilePath,
        [Parameter(Mandatory = $true)] [string[]]$ArgumentList,
        [Parameter(Mandatory = $true)] [string]$LogPath,
        [int]$TimeoutSeconds = 0
    )

    if ($TimeoutSeconds -le 0) {
        Write-Output "Running: $FilePath"
        & $FilePath @ArgumentList 2>&1 | Tee-Object -FilePath $LogPath
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) { throw "Command failed with exit code $exitCode; see $LogPath." }
        return
    }

    $quotedArguments = @($ArgumentList | ForEach-Object { ConvertTo-PowerShellLiteral -Value $_ }) -join ', '
    $runnerPath = "$LogPath.runner.ps1"
    $runnerScript = '& ' + (ConvertTo-PowerShellLiteral -Value $FilePath) + ' @(' + $quotedArguments + ') 2>&1' + [Environment]::NewLine + 'exit $LASTEXITCODE'
    [IO.File]::WriteAllText($runnerPath, $runnerScript, [Text.UTF8Encoding]::new($false))
    $powerShellPath = (Get-Command 'pwsh.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $stderrPath = "$LogPath.stderr"
    Remove-Item -LiteralPath $LogPath, $stderrPath -Force -ErrorAction SilentlyContinue

    Write-LifecyclePhase "Starting bounded command: $FilePath (timeout ${TimeoutSeconds}s; log $LogPath)."
    $runnerArgument = '-NoLogo -NoProfile -NonInteractive -File "' + $runnerPath.Replace('"', '\"') + '"'
    $process = Start-Process -FilePath $powerShellPath -ArgumentList $runnerArgument -WorkingDirectory $PWD.Path -RedirectStandardOutput $LogPath -RedirectStandardError $stderrPath -PassThru
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $nextHeartbeatSeconds = 30
    while (-not $process.WaitForExit(5000)) {
        $process.Refresh()
        if ($timer.Elapsed.TotalSeconds -ge $nextHeartbeatSeconds) {
            $logBytes = 0L
            foreach ($path in @($LogPath, $stderrPath)) {
                if (Test-Path -LiteralPath $path -PathType Leaf) { $logBytes += (Get-Item -LiteralPath $path).Length }
            }
            Write-LifecyclePhase "Command still running after $([Math]::Round($timer.Elapsed.TotalSeconds))s; output=${logBytes}B: $FilePath."
            $nextHeartbeatSeconds += 30
        }
        if ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) { continue }
        $process.Refresh()
        if ($process.HasExited) { break }

        Write-LifecyclePhase "Command exceeded ${TimeoutSeconds}s; terminating its process tree: $FilePath."
        $ownedProcessIds = @()
        $treeSnapshotError = $null
        try { $ownedProcessIds = @(Get-ProcessTreeIds -RootProcessId $process.Id) } catch { $treeSnapshotError = $_ }
        try {
            $process.Refresh()
            if (-not $process.HasExited) { $process.Kill($true) }
        } catch { throw "Could not terminate timed-out command process tree for $FilePath`: $_. Logs: $LogPath and $stderrPath." }
        if (-not $process.WaitForExit(10000)) {
            throw "Timed-out command process tree did not stop: $FilePath. Logs: $LogPath and $stderrPath."
        }
        if ($treeSnapshotError) { throw "Timed-out command was terminated, but its process tree could not be captured for exit verification: $treeSnapshotError. Logs: $LogPath and $stderrPath." }
        if (-not (Wait-ForProcessIdsExit -ProcessIds $ownedProcessIds -TimeoutSeconds 10)) {
            throw "Timed-out command process tree did not stop: $FilePath. Logs: $LogPath and $stderrPath."
        }
        throw "Command exceeded its ${TimeoutSeconds}s timeout and was terminated: $FilePath. Logs: $LogPath and $stderrPath."
    }
    $process.WaitForExit()
    $timer.Stop()
    $exitCode = $process.ExitCode
    if (Test-Path -LiteralPath $LogPath -PathType Leaf) { Get-Content -LiteralPath $LogPath | Write-Output }
    if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { Get-Content -LiteralPath $stderrPath | ForEach-Object { Write-Warning $_ } }
    if ($exitCode -ne 0) { throw "Command failed with exit code $exitCode after $([Math]::Round($timer.Elapsed.TotalSeconds, 1))s; see $LogPath and $stderrPath." }
    Write-LifecyclePhase "Bounded command completed in $([Math]::Round($timer.Elapsed.TotalSeconds, 1))s: $FilePath."
}

function Write-ValidationReport {
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
}

function ConvertTo-PowerShellLiteral {
    param([Parameter(Mandatory = $true)] [string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Get-MsixIdentity {
    param([Parameter(Mandatory = $true)] [string]$PackagePath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($PackagePath)
    try {
        $entry = $archive.GetEntry('AppxManifest.xml')
        if (-not $entry) { throw "MSIX has no AppxManifest.xml: $PackagePath." }
        $stream = $entry.Open()
        try {
            $manifest = [xml]::new()
            $manifest.Load($stream)
        } finally { $stream.Dispose() }
        $identity = $manifest.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']")
        if (-not $identity) { throw "MSIX identity element is missing: $PackagePath." }
        return [pscustomobject]@{
            Name = [string]$identity.GetAttribute('Name')
            Publisher = [string]$identity.GetAttribute('Publisher')
            Version = [string]$identity.GetAttribute('Version')
            ProcessorArchitecture = [string]$identity.GetAttribute('ProcessorArchitecture')
        }
    } finally { $archive.Dispose() }
}

function Get-SignToolPath {
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    if (-not (Test-Path -LiteralPath $sdkRoot)) { throw "Windows SDK bin directory not found: $sdkRoot." }
    $candidates = @(
        Get-ChildItem -LiteralPath $sdkRoot -Directory |
            Sort-Object Name -Descending |
            ForEach-Object {
                foreach ($architecture in @('arm64', 'x64', 'x86')) {
                    $candidate = Join-Path $_.FullName "$architecture\signtool.exe"
                    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate }
                }
            }
    )
    if ($candidates.Count -eq 0) { throw 'No Windows SDK SignTool.exe was found on the hosted runner.' }
    return $candidates[0]
}

function Sign-TestPackage {
    param(
        [Parameter(Mandatory = $true)] [string]$PackagePath,
        [Parameter(Mandatory = $true)] [string]$SignToolPath,
        [Parameter(Mandatory = $true)] [string]$PfxPath,
        [Parameter(Mandatory = $true)] [string]$Password,
        [Parameter(Mandatory = $true)] [string]$LogPrefix
    )
    Invoke-NativeCommand -FilePath $SignToolPath -ArgumentList @('sign', '/fd', 'SHA256', '/f', $PfxPath, '/p', $Password, $PackagePath) -LogPath "$LogPrefix-sign.log" -TimeoutSeconds 180
    Invoke-NativeCommand -FilePath $SignToolPath -ArgumentList @('verify', '/pa', '/v', $PackagePath) -LogPath "$LogPrefix-verify.log" -TimeoutSeconds 180
}

function Write-LifecyclePhase {
    param([Parameter(Mandatory = $true)] [string]$Message)
    Write-Output "[$([DateTime]::UtcNow.ToString('o'))] $Message"
}

function Grant-TemporaryAccess {
    param(
        [Parameter(Mandatory = $true)] [string]$Path,
        [Parameter(Mandatory = $true)] [string]$Rights,
        [switch]$Recursive
    )
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $inheritance = if ($Recursive -and (Test-Path -LiteralPath $Path -PathType Container)) { '(OI)(CI)' } else { '' }
    $scope = if ($Recursive) { 'recursively' } else { 'at this path' }
    Write-LifecyclePhase "Granting temporary $Rights access $scope`: $Path"
    $script:aclPaths.Add([pscustomobject]@{ Path = $Path; Recursive = [bool]$Recursive })
    if ($Recursive) {
        & icacls.exe $Path /grant "*$script:userSid`:$inheritance($Rights)" /T /L /Q | Out-Null
    } else {
        & icacls.exe $Path /grant "*$script:userSid`:$inheritance($Rights)" /Q | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw "Could not grant temporary $Rights access to $Path (icacls exit $LASTEXITCODE)." }
    $timer.Stop()
    Write-LifecyclePhase "Granted temporary $Rights access in $([Math]::Round($timer.Elapsed.TotalSeconds, 1))s: $Path"
}

function Revoke-TemporaryAccess {
    foreach ($entry in $script:aclPaths) {
        $arguments = @($entry.Path, '/remove:g', "*$script:userSid", '/Q')
        if ($entry.Recursive) { $arguments += @('/T', '/L') }
        & icacls.exe @arguments | Out-Null
        if ($LASTEXITCODE -ne 0) { $script:cleanupErrors.Add("Could not remove temporary standard-user access from $($entry.Path) (icacls exit $LASTEXITCODE).") }
    }
}

function Get-ProcessTreeIds {
    param([Parameter(Mandatory = $true)] [int]$RootProcessId)
    $processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId)
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    $null = $owned.Add($RootProcessId)
    do {
        $changed = $false
        foreach ($process in $processes) {
            if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $changed = $true }
        }
    } while ($changed)
    return @($owned)
}

function Wait-ForProcessIdsExit {
    param([Parameter(Mandatory = $true)] [int[]]$ProcessIds, [Parameter(Mandatory = $true)] [int]$TimeoutSeconds)
    $known = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($processId in $ProcessIds) { $null = $known.Add($processId) }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $running = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId)
        if (-not ($running | Where-Object { $known.Contains([int]$_.ProcessId) })) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Wait-ForProcessTreeExit {
    param([Parameter(Mandatory = $true)] [int]$RootProcessId, [Parameter(Mandatory = $true)] [int]$TimeoutSeconds)
    return Wait-ForProcessIdsExit -ProcessIds (Get-ProcessTreeIds -RootProcessId $RootProcessId) -TimeoutSeconds $TimeoutSeconds
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$previousRunnerTemp = $env:RUNNER_TEMP
$isLocalFallback = [bool]$AllowLocalWin11X64
$isElevated = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isLocalFallback) {
    if ($env:GITHUB_ACTIONS -eq 'true') { throw 'The local fallback switch is not valid inside GitHub Actions.' }
    if (-not $isElevated) { throw 'The local fallback must be started as Administrator to provision its disposable standard-user account.' }
    if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) { throw 'The local fallback requires Windows.' }
    $runnerTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('ContextPick-Msix-' + [Guid]::NewGuid().ToString('N'))
    $executionEnvironment = 'local-admin-fallback'
    $env:RUNNER_TEMP = $runnerTemp
    $null = New-Item -ItemType Directory -Path $runnerTemp
} else {
    $runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
    $executionEnvironment = $env:RUNNER_ENVIRONMENT
}
$resultRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp 'contextpick-msix-validation'))
$privateRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp ('contextpick-msix-private-' + [Guid]::NewGuid().ToString('N'))))
$runnerTempPrefix = $runnerTemp.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resultRoot.StartsWith($runnerTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'MSIX lifecycle evidence must remain below the dedicated test-runner temp directory.'
}
if (-not $isLocalFallback) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or $executionEnvironment -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
        throw 'Store-identity MSIX signing and installation require an ephemeral GitHub-hosted Windows runner unless the explicit local fallback switch is used.'
    }
    if (-not $isElevated) { throw 'The hosted runner must be elevated only to provision the disposable standard-user test account.' }
}
if (Test-Path -LiteralPath $resultRoot) { throw "Refusing to reuse an existing lifecycle evidence directory: $resultRoot." }
$null = New-Item -ItemType Directory -Path $resultRoot
$reportPath = Join-Path $resultRoot 'lifecycle-evidence.json'
$logRoot = Join-Path $resultRoot 'logs'
$null = New-Item -ItemType Directory -Path $logRoot

$identityName = 'DotSam.ContextPick'
$publisher = 'CN=9CF819D8-048A-42F9-91C4-E85E76577891'
$minimumBuild = 26200
$msixBuildRoot = Join-Path $repoRoot ('target\msix\lifecycle-' + [Guid]::NewGuid().ToString('N'))
$packageLayout = Join-Path $msixBuildRoot 'package-layout'
$appVersionText = (Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
if ($appVersionText -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "Expected stable three-part app version, received $appVersionText." }
$parts = $appVersionText.Split('.') | ForEach-Object { [int]$_ }
$appVersion = [version]$appVersionText
$packageVersion = '{0}.{1}.{2}.0' -f ($parts[0] + 1), $parts[1], $parts[2]
$upgradeVersion = '{0}.{1}.{2}.1' -f ($parts[0] + 1), $parts[1], $parts[2]
$registry = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$osBuild = [int]$registry.CurrentBuildNumber
$osUbr = [int]$registry.UBR
$hostVersion = "10.0.$osBuild.$osUbr"
$hostArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$existingPackages = @(Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue)
$existingPackagesAllUsers = @(Get-AppxPackage -AllUsers -Name $identityName -ErrorAction SilentlyContinue)
$candidateUnsigned = Join-Path $msixBuildRoot "ContextPick-$appVersionText.msix"
$upgradeUnsigned = Join-Path $msixBuildRoot 'ContextPick-upgrade-test.msix'
$candidateSigned = Join-Path $resultRoot "ContextPick-$appVersionText-test-signed.msix"
$upgradeSigned = Join-Path $resultRoot 'ContextPick-upgrade-test-signed.msix'
$candidateEvidence = Join-Path $resultRoot "ContextPick-$appVersionText.msix"
$pfxPath = Join-Path $privateRoot 'runner-only-test-signing.pfx'
$cerPath = Join-Path $resultRoot 'runner-only-test-signing.cer'
$pfxPassword = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))
$certificateCreated = $false
$machineTrustInstalled = $false
$childExited = $true
$accountCreated = $false
$script:userSid = $null
$script:aclPaths = [System.Collections.Generic.List[object]]::new()
$script:cleanupErrors = [System.Collections.Generic.List[string]]::new()
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
$pwshPath = (Get-Process -Id $PID).Path
$bootstrapPath = Join-Path $resultRoot 'standard-user-bootstrap.ps1'
$stdoutPath = Join-Path $logRoot 'standard-user.stdout.log'
$stderrPath = Join-Path $logRoot 'standard-user.stderr.log'
$userName = 'cpMsix' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$standardUserReportPath = Join-Path $resultRoot 'standard-user-lifecycle.json'
$userProfile = $null
$securePassword = $null
$child = $null
$certThumbprint = $null
$previousMsixAppBinary = $env:CONTEXTPICK_MSIX_APP_BINARY
$report = [ordered]@{
    status = 'in_progress'
    runner = [ordered]@{ environment = $executionEnvironment; image = $env:ImageOS; imageVersion = $env:ImageVersion; architecture = $hostArchitecture; windowsVersion = $hostVersion; minimumBuild = $minimumBuild; buildTokenElevated = $isElevated; testTokenElevated = $null }
    package = [ordered]@{ identity = $identityName; publisher = $publisher; architecture = 'x64'; appVersion = $appVersionText; version = $packageVersion; sha256Unsigned = $null; sha256TestSigned = $null; sha256UpgradeUnsigned = $null; sha256UpgradeTestSigned = $null }
    wack = [ordered]@{ result = 'pending'; reportPath = $null; detail = $null }
    standardUser = $null
    cleanup = [ordered]@{ temporaryUserRemoved = $false; temporaryProfileRemoved = $false; repositoryAclRestored = $false; signingCertificateRemoved = $false; privateSigningKeyRemoved = $false }
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    failure = $null
}
Write-ValidationReport

try {
    if ($isLocalFallback) {
        if ($hostArchitecture -ne 'X64') { throw "The explicit local fallback supports Windows 11 x64 only; actual OS architecture is $hostArchitecture." }
        if ($osBuild -lt $minimumBuild) { throw "Local Windows build $osBuild is below the supported minimum $minimumBuild." }
    } elseif ($hostArchitecture -ne 'Arm64') { throw "Expected a Windows 11 ARM64 runner; actual OS architecture is $hostArchitecture." }
    if ($osBuild -lt $minimumBuild) { throw "Windows build $osBuild is below the Store package minimum $minimumBuild." }
    if ($existingPackages.Count -ne 0 -or $existingPackagesAllUsers.Count -ne 0) { throw "A prior $identityName package exists on this runner; refusing to replace it." }
    if (Test-Path -LiteralPath $msixBuildRoot) { throw "Isolated MSIX build directory already exists; refusing to reuse it: $msixBuildRoot." }

    Write-Output "Windows MSIX lifecycle: $hostVersion ($hostArchitecture), environment $executionEnvironment, image $($env:ImageOS) $($env:ImageVersion)."
    Push-Location $repoRoot
    try {
        . (Join-Path $repoRoot 'scripts/env.ps1')
        # env.ps1 removes its temporary repoRoot variable in this dot-sourced scope.
        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
        $env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'
        $env:CONTEXTPICK_MSIX_MAX_VERSION_TESTED = $hostVersion
        Invoke-NativeCommand -FilePath 'corepack' -ArgumentList @('pnpm', 'licenses:rust', 'windows-x64') -LogPath (Join-Path $logRoot 'rust-licenses.log')
        Invoke-NativeCommand -FilePath 'node' -ArgumentList @('licenses/generate-frontend-notices.mjs') -LogPath (Join-Path $logRoot 'frontend-licenses.log')
        Invoke-NativeCommand -FilePath 'corepack' -ArgumentList @('pnpm', 'exec', 'tauri', 'build', '--target', 'x86_64-pc-windows-msvc', '--no-bundle') -LogPath (Join-Path $logRoot 'tauri-x64-build.log')

        $targetRelease = Join-Path $repoRoot 'target\x86_64-pc-windows-msvc\release'
        $appBinary = Join-Path $targetRelease 'contextpick.exe'
        if (-not (Test-Path -LiteralPath $appBinary -PathType Leaf)) { throw "x64 release build output is missing: $appBinary." }
        $env:CONTEXTPICK_MSIX_APP_BINARY = [System.IO.Path]::GetRelativePath($repoRoot, $appBinary).Replace('\', '/')
        Invoke-NativeCommand -FilePath 'node' -ArgumentList @('scripts/prepare-msix.mjs', $packageLayout) -LogPath (Join-Path $logRoot 'prepare-msix.log')
        Invoke-NativeCommand -FilePath 'npm' -ArgumentList @('exec', '--yes', '--package=@microsoft/winappcli@0.7.1', '--', 'winapp', 'package', $packageLayout, '--no-sign', '--output', $candidateUnsigned) -LogPath (Join-Path $logRoot 'package-msix.log') -TimeoutSeconds 1200
    } finally { Pop-Location }

    if (-not (Test-Path -LiteralPath $candidateUnsigned -PathType Leaf)) { throw 'The Store-identity candidate MSIX was not created.' }
    Write-LifecyclePhase 'Validating candidate package manifest and identity.'
    $candidateIdentity = Get-MsixIdentity -PackagePath $candidateUnsigned
    if ($candidateIdentity.Name -ne $identityName -or $candidateIdentity.Publisher -cne $publisher -or $candidateIdentity.Version -ne $packageVersion) {
        throw "Candidate MSIX identity mismatch: $($candidateIdentity | ConvertTo-Json -Compress)."
    }
    if ($candidateIdentity.ProcessorArchitecture -notmatch 'x64') { throw "Candidate MSIX is not an x64 package: $($candidateIdentity.ProcessorArchitecture)." }
    $unsignedHash = (Get-FileHash -LiteralPath $candidateUnsigned -Algorithm SHA256).Hash.ToLowerInvariant()
    Copy-Item -LiteralPath $candidateUnsigned -Destination $candidateEvidence
    $report.package.sha256Unsigned = $unsignedHash
    $report.package.sha256TestSigned = $null
    $report.package.sizeBytes = (Get-Item -LiteralPath $candidateUnsigned).Length
    $report.package.manifestArchitecture = $candidateIdentity.ProcessorArchitecture
    Write-LifecyclePhase 'Candidate package manifest, identity, hash, and copy verified.'
    Write-Output "Unsigned Store candidate: $unsignedHash ($($report.package.sizeBytes) bytes)."

    $upgradeLayout = Join-Path $msixBuildRoot 'upgrade-test-layout'
    Copy-Item -LiteralPath $packageLayout -Destination $upgradeLayout -Recurse
    $upgradeManifestPath = Join-Path $upgradeLayout 'Package.appxmanifest'
    [xml]$upgradeManifest = Get-Content -LiteralPath $upgradeManifestPath -Raw
    $identityNode = $upgradeManifest.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']")
    if (-not $identityNode) { throw 'Could not locate the MSIX Identity element in the upgrade package layout.' }
    $identityNode.SetAttribute('Version', $upgradeVersion)
    $upgradeManifest.Save($upgradeManifestPath)
    Push-Location $repoRoot
    try {
        Invoke-NativeCommand -FilePath 'npm' -ArgumentList @('exec', '--yes', '--package=@microsoft/winappcli@0.7.1', '--', 'winapp', 'package', $upgradeLayout, '--no-sign', '--output', $upgradeUnsigned) -LogPath (Join-Path $logRoot 'package-upgrade-msix.log') -TimeoutSeconds 1200
    } finally { Pop-Location }
    Write-LifecyclePhase 'Validating higher-version upgrade package manifest and identity.'
    if (-not (Test-Path -LiteralPath $upgradeUnsigned -PathType Leaf)) { throw 'The higher-version upgrade test MSIX was not created.' }
    $upgradeIdentity = Get-MsixIdentity -PackagePath $upgradeUnsigned
    if ($upgradeIdentity.Name -ne $identityName -or $upgradeIdentity.Publisher -cne $publisher -or $upgradeIdentity.Version -ne $upgradeVersion -or $upgradeIdentity.ProcessorArchitecture -notmatch 'x64') {
        throw "Upgrade package identity mismatch: $($upgradeIdentity | ConvertTo-Json -Compress)."
    }
    $report.package.sha256UpgradeUnsigned = (Get-FileHash -LiteralPath $upgradeUnsigned -Algorithm SHA256).Hash.ToLowerInvariant()
    Copy-Item -LiteralPath $upgradeUnsigned -Destination (Join-Path $resultRoot (Split-Path -Leaf $upgradeUnsigned))
    Write-LifecyclePhase 'Upgrade package manifest, identity, hash, and copy verified.'

    Write-LifecyclePhase 'Creating temporary package-test signing certificate.'
    $null = New-Item -ItemType Directory -Path $privateRoot
    $certificateThumbprintPath = Join-Path $privateRoot 'certificate-thumbprint.txt'
    $certificateHelper = Join-Path $PSScriptRoot 'create-msix-test-certificate.ps1'
    $env:CONTEXTPICK_TEST_CERT_PFX_PASSWORD = $pfxPassword
    try {
        Invoke-NativeCommand -FilePath $pwshPath -ArgumentList @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $certificateHelper,
            '-Subject', $publisher, '-PfxPath', $pfxPath, '-CerPath', $cerPath,
            '-ThumbprintPath', $certificateThumbprintPath
        ) -LogPath (Join-Path $logRoot 'create-test-certificate.log') -TimeoutSeconds 120
    } finally {
        Remove-Item Env:CONTEXTPICK_TEST_CERT_PFX_PASSWORD -ErrorAction SilentlyContinue
        Write-LifecyclePhase 'Reading temporary certificate result for cleanup.'
        if (Test-Path -LiteralPath $certificateThumbprintPath -PathType Leaf) {
            $certThumbprint = (Get-Content -LiteralPath $certificateThumbprintPath -Raw).Trim()
            if ($certThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Temporary certificate helper returned an invalid thumbprint.' }
            $certificateCreated = $true
        }
    }
    if (-not $certificateCreated) { throw 'Test certificate helper completed without recording a temporary certificate for cleanup.' }
    Write-LifecyclePhase 'Validating temporary signing certificate.'
    $report.signing = [ordered]@{ subject = $publisher; thumbprint = $certThumbprint; temporaryStores = @('Build-user CurrentUser My', 'Runner LocalMachine Root (SignTool verification only)', 'Runner LocalMachine TrustedPeople (temporary MSIX deployment trust)'); privateKeyRetainedOnlyInRunner = $true }

    Copy-Item -LiteralPath $candidateUnsigned -Destination $candidateSigned
    Copy-Item -LiteralPath $upgradeUnsigned -Destination $upgradeSigned
    Write-LifecyclePhase 'Locating Windows SDK SignTool.'
    $signTool = Get-SignToolPath
    Write-LifecyclePhase 'Installing temporary runner machine-root trust for SignTool verification.'
    $certificateStoreHelper = Join-Path $PSScriptRoot 'manage-msix-test-certificate-store.ps1'
    Invoke-NativeCommand -FilePath $pwshPath -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $certificateStoreHelper, '-Operation', 'AddMachineRoot', '-CertificatePath', $cerPath, '-Thumbprint', $certThumbprint, '-ExpectedSubject', $publisher) -LogPath (Join-Path $logRoot 'install-machine-root-trust.log') -TimeoutSeconds 120
    Write-LifecyclePhase 'Signing and verifying Store candidate and test upgrade packages.'
    Sign-TestPackage -PackagePath $candidateSigned -SignToolPath $signTool -PfxPath $pfxPath -Password $pfxPassword -LogPrefix (Join-Path $logRoot 'candidate')
    Sign-TestPackage -PackagePath $upgradeSigned -SignToolPath $signTool -PfxPath $pfxPath -Password $pfxPassword -LogPrefix (Join-Path $logRoot 'upgrade')
    Invoke-NativeCommand -FilePath $pwshPath -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $certificateStoreHelper, '-Operation', 'RemoveMachineRoot', '-CertificatePath', $cerPath, '-Thumbprint', $certThumbprint, '-ExpectedSubject', $publisher) -LogPath (Join-Path $logRoot 'remove-machine-root-trust.log') -TimeoutSeconds 120
    $report.package.sha256TestSigned = (Get-FileHash -LiteralPath $candidateSigned -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.package.sha256UpgradeTestSigned = (Get-FileHash -LiteralPath $upgradeSigned -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-ValidationReport

    # MSIX deployment validates the signer against machine TrustedPeople. This test
    # certificate is scoped by exact thumbprint and removed with the runner cleanup.
    Write-LifecyclePhase 'Installing temporary machine TrustedPeople trust for MSIX deployment.'
    Invoke-NativeCommand -FilePath $pwshPath -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $certificateStoreHelper, '-Operation', 'AddMachineTrustedPeople', '-CertificatePath', $cerPath, '-Thumbprint', $certThumbprint, '-ExpectedSubject', $publisher) -LogPath (Join-Path $logRoot 'install-machine-trusted-people.log') -TimeoutSeconds 120
    $machineTrustInstalled = $true

    Write-LifecyclePhase 'Creating disposable standard-user account and profile.'
    $userSid = $null
    $userPasswordBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    $passwordString = 'Cp1!' + [Convert]::ToBase64String($userPasswordBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [Array]::Clear($userPasswordBytes, 0, $userPasswordBytes.Length)
    $securePassword = ConvertTo-SecureString -String $passwordString -AsPlainText -Force
    $null = New-LocalUser -Name $userName -Password $securePassword -Description 'ContextPick Store MSIX test account'
    $accountCreated = $true
    $userSid = (Get-LocalUser -Name $userName).SID.Value
    $script:userSid = $userSid
    $userProfile = Join-Path ([Environment]::ExpandEnvironmentVariables([string](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList').ProfilesDirectory)) $userName
    $accountName = "$env:COMPUTERNAME\$userName"
    $credential = [PSCredential]::new($accountName, $securePassword)

    $nodeCommand = Get-Command node.exe -ErrorAction Stop | Select-Object -First 1
    $nodeHome = Split-Path -Parent $nodeCommand.Source
    $pnpmHome = if (-not [string]::IsNullOrWhiteSpace($env:PNPM_HOME)) { $env:PNPM_HOME } else { Split-Path -Parent ((Get-Command pnpm -ErrorAction Stop | Select-Object -First 1).Source) }
    $null = New-Item -ItemType Directory -Path (Join-Path $resultRoot 'corepack') -Force
    $null = New-Item -ItemType Directory -Path (Join-Path $resultRoot 'standard-user-temp') -Force
    $playwrightResults = Join-Path $resultRoot 'playwright-results'
    $screenshots = Join-Path $resultRoot 'screenshots'
    $viteCache = Join-Path $resultRoot 'vite-cache'
    foreach ($directory in @($playwrightResults, $screenshots, $viteCache)) {
        $null = New-Item -ItemType Directory -Path $directory -Force
    }
    $null = New-Item -ItemType File -Path $standardUserReportPath -Force
    Write-LifecyclePhase 'Granting the disposable standard user access to required test inputs and tools.'
    Grant-TemporaryAccess -Path $repoRoot -Rights 'RX'
    foreach ($relativeDirectory in @('node_modules', 'src', 'tests\native', 'scripts')) {
        Grant-TemporaryAccess -Path (Join-Path $repoRoot $relativeDirectory) -Rights 'RX' -Recursive
    }
    $playwrightPackageLink = Get-Item -LiteralPath (Join-Path $repoRoot 'node_modules\@playwright\test') -Force
    if (($playwrightPackageLink.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $nodeModulesRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'node_modules'))
        $nodeModulesPrefix = $nodeModulesRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $playwrightPackageTarget = [string]$playwrightPackageLink.Target
        if (-not [IO.Path]::IsPathRooted($playwrightPackageTarget)) {
            $playwrightPackageTarget = Join-Path (Split-Path -Parent $playwrightPackageLink.FullName) $playwrightPackageTarget
        }
        $playwrightPackageTarget = [IO.Path]::GetFullPath($playwrightPackageTarget)
        if (-not $playwrightPackageTarget.StartsWith($nodeModulesPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to grant access through an unexpected Playwright package link target: $playwrightPackageTarget."
        }
        $playwrightTargetAncestor = $playwrightPackageTarget
        while ($playwrightTargetAncestor.StartsWith($nodeModulesPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $targetAncestorItem = Get-Item -LiteralPath $playwrightTargetAncestor -Force
            if (($targetAncestorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to grant access through a nested reparse point in the Playwright target: $playwrightTargetAncestor."
            }
            $playwrightTargetAncestor = Split-Path -Parent $playwrightTargetAncestor
        }
        # pnpm exposes this dependency graph through junctions. Follow only links
        # whose resolved targets remain inside node_modules, then grant exact paths.
        $playwrightPackageManifest = Join-Path $playwrightPackageTarget 'package.json'
        if (-not (Test-Path -LiteralPath $playwrightPackageManifest -PathType Leaf)) {
            throw "The resolved Playwright package has no package manifest: $playwrightPackageManifest."
        }
        $playwrightPackageDirectories = [System.Collections.Generic.List[string]]::new()
        $playwrightPackageFiles = [System.Collections.Generic.List[string]]::new()
        $playwrightVisitedDirectories = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $playwrightVisitedFiles = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $playwrightDirectoryQueue = [System.Collections.Generic.Queue[string]]::new()
        $playwrightDirectoryQueue.Enqueue($playwrightPackageTarget)
        while ($playwrightDirectoryQueue.Count -gt 0) {
            $playwrightDirectory = $playwrightDirectoryQueue.Dequeue()
            if (-not $playwrightVisitedDirectories.Add($playwrightDirectory)) { continue }
            $playwrightPackageDirectories.Add($playwrightDirectory)
            foreach ($playwrightItem in Get-ChildItem -LiteralPath $playwrightDirectory -Force) {
                $playwrightItemPath = [IO.Path]::GetFullPath($playwrightItem.FullName)
                if (($playwrightItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    $playwrightLinkTarget = $playwrightItem.ResolveLinkTarget($true)
                    if ($null -eq $playwrightLinkTarget) {
                        throw "Could not resolve a Playwright package link: $($playwrightItem.FullName)."
                    }
                    $playwrightItemPath = [IO.Path]::GetFullPath($playwrightLinkTarget.FullName)
                }
                if (-not $playwrightItemPath.StartsWith($nodeModulesPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Refusing to grant access through a Playwright package link outside node_modules: $playwrightItemPath."
                }
                $playwrightItemAncestor = $playwrightItemPath
                while ($playwrightItemAncestor.StartsWith($nodeModulesPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    $playwrightItemAncestorEntry = Get-Item -LiteralPath $playwrightItemAncestor -Force
                    if (($playwrightItemAncestorEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                        throw "Refusing to grant access through an unresolved Playwright package link: $playwrightItemAncestor."
                    }
                    $playwrightItemAncestor = Split-Path -Parent $playwrightItemAncestor
                }
                $playwrightResolvedItem = Get-Item -LiteralPath $playwrightItemPath -Force
                if ($playwrightResolvedItem.PSIsContainer) {
                    if (-not $playwrightVisitedDirectories.Contains($playwrightItemPath)) {
                        $playwrightDirectoryQueue.Enqueue($playwrightItemPath)
                    }
                } elseif ($playwrightVisitedFiles.Add($playwrightItemPath)) {
                    $playwrightPackageFiles.Add($playwrightItemPath)
                }
            }
        }
        if (-not $playwrightVisitedFiles.Contains([IO.Path]::GetFullPath($playwrightPackageManifest))) {
            throw "The resolved Playwright package manifest was not included in its regular file list: $playwrightPackageManifest."
        }
        Write-LifecyclePhase "Granting access to $($playwrightPackageDirectories.Count) Playwright package directories and $($playwrightPackageFiles.Count) files."
        foreach ($playwrightPackageDirectory in $playwrightPackageDirectories) {
            Grant-TemporaryAccess -Path $playwrightPackageDirectory -Rights 'RX'
        }
        foreach ($playwrightPackageFile in $playwrightPackageFiles) {
            Grant-TemporaryAccess -Path $playwrightPackageFile -Rights 'RX'
        }
    }
    foreach ($relativeFile in @('index.html', 'package.json', 'pnpm-lock.yaml', 'playwright.native.config.ts', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json')) {
        Grant-TemporaryAccess -Path (Join-Path $repoRoot $relativeFile) -Rights 'RX'
    }
    Grant-TemporaryAccess -Path $resultRoot -Rights 'RX' -Recursive
    foreach ($directory in @($logRoot, $playwrightResults, $screenshots, $viteCache, (Join-Path $resultRoot 'standard-user-temp'), (Join-Path $resultRoot 'corepack'))) {
        Grant-TemporaryAccess -Path $directory -Rights 'M' -Recursive
    }
    Grant-TemporaryAccess -Path $standardUserReportPath -Rights 'M'
    Grant-TemporaryAccess -Path $nodeHome -Rights 'RX'
    if (-not [string]::IsNullOrWhiteSpace($pnpmHome) -and (Test-Path -LiteralPath $pnpmHome)) { Grant-TemporaryAccess -Path $pnpmHome -Rights 'RX' }

    $helperPath = Join-Path $PSScriptRoot 'test-store-msix-standard-user.ps1'
    $bootstrapLines = @(
        '& ' + (ConvertTo-PowerShellLiteral $helperPath) + ' -CandidatePackagePath ' + (ConvertTo-PowerShellLiteral $candidateSigned) + ' -UpgradePackagePath ' + (ConvertTo-PowerShellLiteral $upgradeSigned) + ' -TestCertificatePath ' + (ConvertTo-PowerShellLiteral $cerPath) + ' -ExpectedPackageVersion ' + (ConvertTo-PowerShellLiteral $packageVersion) + ' -ExpectedUpgradeVersion ' + (ConvertTo-PowerShellLiteral $upgradeVersion) + ' -IdentityName ' + (ConvertTo-PowerShellLiteral $identityName) + ' -Publisher ' + (ConvertTo-PowerShellLiteral $publisher) + ' -EvidenceRoot ' + (ConvertTo-PowerShellLiteral $resultRoot) + ' -RepositoryRoot ' + (ConvertTo-PowerShellLiteral $repoRoot)
        'exit $LASTEXITCODE'
    )
    [System.IO.File]::WriteAllText($bootstrapPath, [string]::Join([Environment]::NewLine, $bootstrapLines), [Text.UTF8Encoding]::new($false))
    $childArguments = '-NoLogo -NoProfile -File "' + $bootstrapPath.Replace('"', '\"') + '"'
    $childCommandLineLength = ('"' + $pwshPath + '" ' + $childArguments).Length
    if ($childCommandLineLength -ge 1024) { throw "Standard-user bootstrap command exceeds CreateProcessWithLogonW's 1,024-character limit ($childCommandLineLength)." }

    $environment = @{}
    foreach ($variable in Get-ChildItem Env:) { $environment[$variable.Name] = $null }
    $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot', 'Machine')
    if ([string]::IsNullOrWhiteSpace($systemRoot)) { $systemRoot = $env:SystemRoot }
    if ([string]::IsNullOrWhiteSpace($systemRoot)) { throw 'Could not determine the Windows system directory for the standard-user smoke environment.' }
    $windowsPowerShellPath = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0'
    if (-not (Test-Path -LiteralPath (Join-Path $windowsPowerShellPath 'powershell.exe') -PathType Leaf)) {
        throw "Windows PowerShell executable was not found: $(Join-Path $windowsPowerShellPath 'powershell.exe')."
    }
    $systemDriveRoot = [System.IO.Path]::GetPathRoot($systemRoot)
    $systemDrive = $systemDriveRoot.TrimEnd('\')
    $environmentOverrides = @{
        ALLUSERSPROFILE = Join-Path $systemDriveRoot 'ProgramData'
        APPDATA = Join-Path $userProfile 'AppData\Roaming'
        CI = 'true'
        COMPUTERNAME = $env:COMPUTERNAME
        COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
        COREPACK_HOME = Join-Path $resultRoot 'corepack'
        GITHUB_WORKSPACE = $repoRoot
        HOMEDRIVE = $systemDrive
        HOMEPATH = $userProfile.Substring($systemDrive.Length)
        LOCALAPPDATA = Join-Path $userProfile 'AppData\Local'
        PATH = "$nodeHome;$pnpmHome;$PSHOME;$windowsPowerShellPath;$systemRoot\System32;$systemRoot"
        PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
        PNPM_HOME = $pnpmHome
        PROCESSOR_ARCHITECTURE = if ($hostArchitecture -eq 'Arm64') { 'ARM64' } else { 'AMD64' }
        ProgramData = Join-Path $systemDriveRoot 'ProgramData'
        ProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
        'ProgramFiles(x86)' = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
        ProgramW6432 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
        PUBLIC = Join-Path $systemDriveRoot 'Users\Public'
        RUNNER_ENVIRONMENT = $executionEnvironment
        RUNNER_OS = 'Windows'
        RUNNER_TEMP = $runnerTemp
        CONTEXTPICK_LOCAL_MSIX_FALLBACK = if ($isLocalFallback) { '1' } else { '0' }
        GITHUB_ACTIONS = if ($isLocalFallback) { 'false' } else { 'true' }
        SystemDrive = $systemDrive
        SystemRoot = $systemRoot
        TEMP = Join-Path $resultRoot 'standard-user-temp'
        TMP = Join-Path $resultRoot 'standard-user-temp'
        USERDOMAIN = $env:COMPUTERNAME
        USERNAME = $userName
        USERPROFILE = $userProfile
        WINDIR = $systemRoot
    }
    foreach ($entry in $environmentOverrides.GetEnumerator()) { $environment[$entry.Key] = $entry.Value }

    Write-LifecyclePhase 'Starting installed-app lifecycle under the disposable standard user.'
    $child = Start-Process -FilePath $pwshPath -ArgumentList $childArguments -Credential $credential -LoadUserProfile -Environment $environment -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $childTimer = [Diagnostics.Stopwatch]::StartNew()
    $childCompleted = $false
    while (-not $childCompleted -and $childTimer.Elapsed -lt [TimeSpan]::FromMinutes(55)) {
        $childCompleted = $child.WaitForExit(30 * 1000)
        if (-not $childCompleted) {
            $phase = 'unknown'
            if (Test-Path -LiteralPath $standardUserReportPath -PathType Leaf) {
                try {
                    $childReport = Get-Content -LiteralPath $standardUserReportPath -Raw | ConvertFrom-Json
                    if (-not [string]::IsNullOrWhiteSpace([string]$childReport.phase)) { $phase = [string]$childReport.phase }
                } catch { $phase = 'reading child report failed' }
            }
            $stdoutBytes = if (Test-Path -LiteralPath $stdoutPath) { (Get-Item -LiteralPath $stdoutPath).Length } else { 0 }
            $stderrBytes = if (Test-Path -LiteralPath $stderrPath) { (Get-Item -LiteralPath $stderrPath).Length } else { 0 }
            Write-LifecyclePhase "Standard-user lifecycle still running after $([Math]::Round($childTimer.Elapsed.TotalMinutes, 1))m; phase=$phase; stdout=${stdoutBytes}B; stderr=${stderrBytes}B."
        }
    }
    $childTimer.Stop()
    if (-not $childCompleted) {
        $childExited = $false
        try {
            $child.Kill($true)
            if (-not $child.WaitForExit(10000) -or -not (Wait-ForProcessTreeExit -RootProcessId $child.Id -TimeoutSeconds 10)) {
                throw 'Timed-out standard-user MSIX test process tree did not stop.'
            }
            $childExited = $true
        } catch { throw "Standard-user MSIX lifecycle exceeded 55 minutes and its process tree could not be confirmed stopped: $_" }
        throw 'Standard-user MSIX lifecycle exceeded 55 minutes.'
    }
    $child.Refresh()
    $childExited = $false
    if (-not (Wait-ForProcessTreeExit -RootProcessId $child.Id -TimeoutSeconds 10)) { throw 'The standard-user helper exited while one of its descendants remained active.' }
    $childExited = $true
    if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath | Write-Output }
    if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath | ForEach-Object { Write-Warning $_ } }
    if ($child.ExitCode -ne 0) { throw "Standard-user MSIX lifecycle failed with exit code $($child.ExitCode)." }
    if (-not (Test-Path -LiteralPath $standardUserReportPath -PathType Leaf)) { throw 'Standard-user helper did not emit its lifecycle evidence JSON.' }
    $standardUserReport = Get-Content -LiteralPath $standardUserReportPath -Raw | ConvertFrom-Json
    $report.standardUser = $standardUserReport
    Write-LifecyclePhase "Standard-user lifecycle exited with status '$($standardUserReport.status)' after $([Math]::Round($childTimer.Elapsed.TotalMinutes, 1))m."
    $report.runner.testTokenElevated = $standardUserReport.token.isElevated
    if ($standardUserReport.status -ne 'passed' -or $standardUserReport.token.isElevated -ne $false) {
        throw 'The MSIX lifecycle did not pass under a verified non-elevated standard-user token.'
    }

    # Record the exact trust prerequisite required by Windows for self-signed MSIX
    # deployment. The disposable standard-user profile still has no app registration
    # or app data before install, and package operations remain non-elevated.
    $report.cleanFirstInstall = [ordered]@{
        packageRegistrationsForAllUsersBeforeInstall = $existingPackagesAllUsers.Count
        machineRootTrustPresentBeforeInstall = $false
        machineTrustedPeoplePresentBeforeInstall = $true
        lifecycleCompletedBeforeWack = $true
    }
    Write-LifecyclePhase 'Retaining temporary machine TrustedPeople trust through WACK.'

    $appCertPath = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\App Certification Kit\appcert.exe'
    if (Test-Path -LiteralPath $appCertPath -PathType Leaf) {
        $wackReportPath = Join-Path $resultRoot 'wack-report.xml'
        $report.wack.reportPath = $wackReportPath
        $report.wack.result = 'running'
        Write-ValidationReport
        & $appCertPath reset 2>&1 | Tee-Object -FilePath (Join-Path $logRoot 'wack-reset.log')
        $resetExitCode = $LASTEXITCODE
        if ($resetExitCode -ne 0) { throw "WACK reset failed with exit code $resetExitCode." }
        & $appCertPath test -appxpackagepath $candidateSigned -reportoutputpath $wackReportPath 2>&1 | Tee-Object -FilePath (Join-Path $logRoot 'wack-test.log')
        $wackExitCode = $LASTEXITCODE
        if (-not (Test-Path -LiteralPath $wackReportPath -PathType Leaf)) { throw "WACK did not produce the expected report: $wackReportPath." }
        [xml]$wackXml = Get-Content -LiteralPath $wackReportPath -Raw
        $overallResult = [string]$wackXml.REPORT.OVERALL_RESULT
        $report.wack.result = if ($overallResult -eq 'PASS' -and $wackExitCode -eq 0) { 'passed' } else { 'failed' }
        $report.wack.detail = [ordered]@{ overallResult = $overallResult; exitCode = $wackExitCode; candidateUnsignedSha256 = $unsignedHash; testedCopySha256 = $report.package.sha256TestSigned; runAfterCleanLifecycle = $true }
        Write-ValidationReport
    } else {
        $report.wack.result = 'unavailable'
        $report.wack.detail = 'Lifecycle workflow only: appcert.exe is not installed in this hosted image. This run is not WACK evidence and cannot close the roadmap WACK gate.'
        Write-Output $report.wack.detail
    }
    if ($report.wack.result -eq 'failed') { throw 'WACK failed against the exact test-signed candidate package; see retained WACK report and logs.' }

    Revoke-TemporaryAccess
    if ($script:cleanupErrors.Count -gt 0) { throw ($script:cleanupErrors -join ' ') }
    $report.cleanup.repositoryAclRestored = $true

    $profileEntry = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$userSid'" -ErrorAction SilentlyContinue
    if ($profileEntry) {
        $profilePath = [System.IO.Path]::GetFullPath([string]$profileEntry.LocalPath)
        $usersRoot = [System.IO.Path]::GetFullPath((Join-Path $env:SystemDrive 'Users')).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if ($profileEntry.Loaded) { throw 'Temporary standard-user profile remains loaded; refusing to remove it.' }
        if (-not $profilePath.StartsWith($usersRoot, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $profilePath) -ne $userName -or $profileEntry.Special) {
            throw "Refusing to remove unexpected standard-user profile path: $profilePath."
        }
        Remove-CimInstance -InputObject $profileEntry
        if (Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$userSid'" -ErrorAction SilentlyContinue) { throw 'Temporary standard-user profile remains after cleanup.' }
    }
    $report.cleanup.temporaryProfileRemoved = $true
    Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
    if (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue) { throw 'Temporary standard-user account remains after cleanup.' }
    $accountCreated = $false
    $report.cleanup.temporaryUserRemoved = $true
    if ($certificateCreated) {
        Write-LifecyclePhase 'Removing temporary signer from all test certificate stores.'
        Invoke-NativeCommand -FilePath $pwshPath -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $certificateStoreHelper, '-Operation', 'RemoveTemporaryCertificate', '-Thumbprint', $certThumbprint) -LogPath (Join-Path $logRoot 'remove-temporary-signing-certificate.log') -TimeoutSeconds 120
        $certificateCreated = $false
        $machineTrustInstalled = $false
    }
    $report.cleanup.signingCertificateRemoved = $true

    $report.status = 'passed'
} catch {
    $report.status = 'failed'
    $report.failure = [ordered]@{ message = $_.Exception.Message; category = $_.CategoryInfo.Category.ToString(); script = $_.InvocationInfo.ScriptName; line = $_.InvocationInfo.ScriptLineNumber }
    throw
} finally {
    if ($childExited) {
        if ($accountCreated) {
            try {
                Revoke-TemporaryAccess
                if ($script:cleanupErrors.Count -gt 0) { throw ($script:cleanupErrors -join ' ') }
                $profileEntry = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$userSid'" -ErrorAction SilentlyContinue
                if ($profileEntry) {
                    $profilePath = [System.IO.Path]::GetFullPath([string]$profileEntry.LocalPath)
                    $usersRoot = [System.IO.Path]::GetFullPath((Join-Path $env:SystemDrive 'Users')).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
                    if ($profileEntry.Loaded -or -not $profilePath.StartsWith($usersRoot, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $profilePath) -ne $userName -or $profileEntry.Special) {
                        throw "Refusing to remove unexpected or loaded standard-user profile: $profilePath."
                    }
                    Remove-CimInstance -InputObject $profileEntry
                    if (Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$userSid'" -ErrorAction SilentlyContinue) { throw 'Temporary user profile remains after cleanup.' }
                    $report.cleanup.temporaryProfileRemoved = $true
                } else { $report.cleanup.temporaryProfileRemoved = $true }
                Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
                if (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue) { throw 'Temporary standard-user account remains after cleanup.' }
                $report.cleanup.temporaryUserRemoved = $true
                $accountCreated = $false
            } catch { $cleanupErrors.Add("Temporary account/profile cleanup failed: $($_.Exception.Message)") }
        }
    } else {
        $cleanupErrors.Add('The standard-user process tree did not stop; retained its profile and ACLs for hosted-runner teardown.')
    }

    if ($certThumbprint) {
        try {
            Write-LifecyclePhase 'Removing temporary signer from all test certificate stores.'
            Invoke-NativeCommand -FilePath $pwshPath -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $certificateStoreHelper, '-Operation', 'RemoveTemporaryCertificate', '-Thumbprint', $certThumbprint) -LogPath (Join-Path $logRoot 'remove-temporary-signing-certificate.log') -TimeoutSeconds 120
            $report.cleanup.signingCertificateRemoved = $true
            $machineTrustInstalled = $false
        } catch {
            $report.cleanup.signingCertificateRemoved = $false
            $cleanupErrors.Add("Test-certificate trust cleanup failed: $($_.Exception.Message)")
        }
    }
    if (-not $childExited -or ($accountCreated -and -not $report.cleanup.temporaryProfileRemoved)) {
        $report.cleanup.signingCertificateRemoved = $false
    }
    if (Test-Path -LiteralPath $msixBuildRoot) {
        try {
            $targetMsixRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'target\msix')).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
            $resolvedBuildRoot = [System.IO.Path]::GetFullPath($msixBuildRoot)
            if (-not $resolvedBuildRoot.StartsWith($targetMsixRoot, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path -Leaf $resolvedBuildRoot).StartsWith('lifecycle-', [System.StringComparison]::Ordinal)) {
                throw "Refusing to remove an unexpected MSIX lifecycle output path: $resolvedBuildRoot."
            }
            Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force -ErrorAction Stop
        } catch { $cleanupErrors.Add("Isolated MSIX build output cleanup failed: $($_.Exception.Message)") }
    }
    if ($null -eq $previousMsixAppBinary) { Remove-Item Env:CONTEXTPICK_MSIX_APP_BINARY -ErrorAction SilentlyContinue }
    else { $env:CONTEXTPICK_MSIX_APP_BINARY = $previousMsixAppBinary }
    if ($null -eq $previousRunnerTemp) { Remove-Item Env:RUNNER_TEMP -ErrorAction SilentlyContinue }
    else { $env:RUNNER_TEMP = $previousRunnerTemp }
    if (Test-Path -LiteralPath $privateRoot) {
        try {
            Remove-Item -LiteralPath $privateRoot -Recurse -Force -ErrorAction Stop
            $report.cleanup.privateSigningKeyRemoved = -not (Test-Path -LiteralPath $privateRoot)
            if (-not $report.cleanup.privateSigningKeyRemoved) { $cleanupErrors.Add('Temporary private signing key directory remains after cleanup.') }
        } catch { $cleanupErrors.Add("Temporary private signing key cleanup failed: $($_.Exception.Message)") }
    } else {
        $report.cleanup.privateSigningKeyRemoved = $true
    }
    if ($machineTrustInstalled) {
        $cleanupErrors.Add('Runner-only signer trust was installed but its cleanup did not complete.')
    }
    if ($securePassword) { $securePassword.Dispose() }
    $pfxPassword = $null
    $passwordString = $null
    $credential = $null
    if ($cleanupErrors.Count -gt 0) {
        $report.status = 'failed'
        $report.cleanup.errors = @($cleanupErrors)
    }
    $report.generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    Write-ValidationReport
}

if ($report.status -ne 'passed') { throw 'MSIX Windows 11 lifecycle did not pass; see lifecycle-evidence.json and retained logs.' }
Write-Output "Clean Windows 11 25H2+ x64 MSIX lifecycle passed under a standard user. Candidate SHA-256: $unsignedHash"
