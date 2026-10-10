$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)] [string]$FilePath,
        [Parameter(Mandatory = $true)] [string[]]$ArgumentList,
        [Parameter(Mandatory = $true)] [string]$LogPath
    )

    Write-Output "Running: $FilePath"
    & $FilePath @ArgumentList 2>&1 | Tee-Object -FilePath $LogPath
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "Command failed with exit code $exitCode; see $LogPath." }
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
    Invoke-NativeCommand -FilePath $SignToolPath -ArgumentList @('sign', '/fd', 'SHA256', '/f', $PfxPath, '/p', $Password, $PackagePath) -LogPath "$LogPrefix-sign.log"
    Invoke-NativeCommand -FilePath $SignToolPath -ArgumentList @('verify', '/pa', '/v', $PackagePath) -LogPath "$LogPrefix-verify.log"
}

function Grant-TemporaryAccess {
    param([Parameter(Mandatory = $true)] [string]$Path, [Parameter(Mandatory = $true)] [string]$Rights)
    & icacls.exe $Path /grant "*$script:userSid`:(OI)(CI)($Rights)" /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not grant temporary $Rights access to $Path (icacls exit $LASTEXITCODE)." }
    $script:aclPaths.Add($Path)
}

function Revoke-TemporaryAccess {
    foreach ($path in $script:aclPaths) {
        & icacls.exe $path /remove:g "*$script:userSid" /T /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { $script:cleanupErrors.Add("Could not remove temporary standard-user access from $path (icacls exit $LASTEXITCODE).") }
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

function Wait-ForProcessTreeExit {
    param([Parameter(Mandatory = $true)] [int]$RootProcessId, [Parameter(Mandatory = $true)] [int]$TimeoutSeconds)
    $known = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($processId in (Get-ProcessTreeIds -RootProcessId $RootProcessId)) { $null = $known.Add($processId) }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $running = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId)
        if (-not ($running | Where-Object { $known.Contains([int]$_.ProcessId) })) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$resultRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp 'contextpick-msix-validation'))
$privateRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp ('contextpick-msix-private-' + [Guid]::NewGuid().ToString('N'))))
$runnerTempPrefix = $runnerTemp.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resultRoot.StartsWith($runnerTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'MSIX lifecycle evidence must remain below the dedicated GitHub runner temp directory.'
}
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Store-identity MSIX signing and installation are restricted to an ephemeral GitHub-hosted Windows runner.'
}
if (-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The hosted runner must be elevated only to provision the disposable standard-user test account.'
}
if (Test-Path -LiteralPath $resultRoot) { throw "Refusing to reuse an existing lifecycle evidence directory: $resultRoot." }
$null = New-Item -ItemType Directory -Path $resultRoot
$reportPath = Join-Path $resultRoot 'lifecycle-evidence.json'
$logRoot = Join-Path $resultRoot 'logs'
$null = New-Item -ItemType Directory -Path $logRoot

$identityName = 'DotSam.ContextPick'
$publisher = 'CN=9CF819D8-048A-42F9-91C4-E85E76577891'
$minimumBuild = 26200
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
$candidateUnsigned = Join-Path $repoRoot "target\msix\ContextPick-$appVersionText.msix"
$upgradeUnsigned = Join-Path $repoRoot 'target\msix\ContextPick-upgrade-test.msix'
$candidateSigned = Join-Path $resultRoot "ContextPick-$appVersionText-test-signed.msix"
$upgradeSigned = Join-Path $resultRoot 'ContextPick-upgrade-test-signed.msix'
$candidateEvidence = Join-Path $resultRoot "ContextPick-$appVersionText.msix"
$pfxPath = Join-Path $privateRoot 'runner-only-test-signing.pfx'
$cerPath = Join-Path $resultRoot 'runner-only-test-signing.cer'
$pfxPassword = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))
$pfxSecurePassword = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
$certificateCreated = $false
$machineTrustInstalled = $false
$childExited = $true
$accountCreated = $false
$script:userSid = $null
$script:aclPaths = [System.Collections.Generic.List[string]]::new()
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
$report = [ordered]@{
    status = 'in_progress'
    runner = [ordered]@{ environment = $env:RUNNER_ENVIRONMENT; image = $env:ImageOS; imageVersion = $env:ImageVersion; architecture = $hostArchitecture; windowsVersion = $hostVersion; minimumBuild = $minimumBuild; buildTokenElevated = $true; testTokenElevated = $null }
    package = [ordered]@{ identity = $identityName; publisher = $publisher; architecture = 'x64'; appVersion = $appVersionText; version = $packageVersion; sha256Unsigned = $null; sha256TestSigned = $null; sha256UpgradeUnsigned = $null; sha256UpgradeTestSigned = $null }
    wack = [ordered]@{ result = 'pending'; reportPath = $null; detail = $null }
    standardUser = $null
    cleanup = [ordered]@{ temporaryUserRemoved = $false; temporaryProfileRemoved = $false; repositoryAclRestored = $false; signingCertificateRemoved = $false; privateSigningKeyRemoved = $false }
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    failure = $null
}
Write-ValidationReport

try {
    if ($hostArchitecture -ne 'Arm64') { throw "Expected a Windows 11 ARM64 runner; actual OS architecture is $hostArchitecture." }
    if ($osBuild -lt $minimumBuild) { throw "Windows build $osBuild is below the Store package minimum $minimumBuild." }
    if ($existingPackages.Count -ne 0 -or $existingPackagesAllUsers.Count -ne 0) { throw "A prior $identityName package exists on this runner; refusing to replace it." }
    if (Test-Path -LiteralPath $candidateUnsigned) { throw "Candidate path already exists; refusing to reuse stale MSIX input: $candidateUnsigned." }
    if (Test-Path -LiteralPath $upgradeUnsigned) { throw "Upgrade test path already exists; refusing to reuse stale input: $upgradeUnsigned." }

    Write-Output "Hosted Windows: $hostVersion ($hostArchitecture), runner image $($env:ImageOS) $($env:ImageVersion)."
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
        $inputRelease = Join-Path $repoRoot 'target\release'
        $null = New-Item -ItemType Directory -Force -Path $inputRelease
        # MSVC no-bundle builds place WebView2Loader.dll under the Cargo build
        # output directory. The MSIX preparer resolves and validates it there.
        foreach ($fileName in @('contextpick.exe')) {
            $source = Join-Path $targetRelease $fileName
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "x64 release build output is missing: $source." }
            Copy-Item -LiteralPath $source -Destination (Join-Path $inputRelease $fileName)
        }
        Invoke-NativeCommand -FilePath 'node' -ArgumentList @('scripts/prepare-msix.mjs') -LogPath (Join-Path $logRoot 'prepare-msix.log')
        Invoke-NativeCommand -FilePath 'npm' -ArgumentList @('exec', '--yes', '--package=@microsoft/winappcli@0.7.1', '--', 'winapp', 'package', 'target/msix/package-layout', '--no-sign', '--output', $candidateUnsigned) -LogPath (Join-Path $logRoot 'package-msix.log')
    } finally { Pop-Location }

    if (-not (Test-Path -LiteralPath $candidateUnsigned -PathType Leaf)) { throw 'The Store-identity candidate MSIX was not created.' }
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
    Write-Output "Unsigned Store candidate: $unsignedHash ($($report.package.sizeBytes) bytes)."

    $upgradeLayout = Join-Path $repoRoot 'target\msix\upgrade-test-layout'
    Copy-Item -LiteralPath (Join-Path $repoRoot 'target\msix\package-layout') -Destination $upgradeLayout -Recurse
    $upgradeManifestPath = Join-Path $upgradeLayout 'Package.appxmanifest'
    [xml]$upgradeManifest = Get-Content -LiteralPath $upgradeManifestPath -Raw
    $identityNode = $upgradeManifest.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']")
    if (-not $identityNode) { throw 'Could not locate the MSIX Identity element in the upgrade package layout.' }
    $identityNode.SetAttribute('Version', $upgradeVersion)
    $upgradeManifest.Save($upgradeManifestPath)
    Push-Location $repoRoot
    try {
        Invoke-NativeCommand -FilePath 'npm' -ArgumentList @('exec', '--yes', '--package=@microsoft/winappcli@0.7.1', '--', 'winapp', 'package', 'target/msix/upgrade-test-layout', '--no-sign', '--output', $upgradeUnsigned) -LogPath (Join-Path $logRoot 'package-upgrade-msix.log')
    } finally { Pop-Location }
    if (-not (Test-Path -LiteralPath $upgradeUnsigned -PathType Leaf)) { throw 'The higher-version upgrade test MSIX was not created.' }
    $upgradeIdentity = Get-MsixIdentity -PackagePath $upgradeUnsigned
    if ($upgradeIdentity.Name -ne $identityName -or $upgradeIdentity.Publisher -cne $publisher -or $upgradeIdentity.Version -ne $upgradeVersion -or $upgradeIdentity.ProcessorArchitecture -notmatch 'x64') {
        throw "Upgrade package identity mismatch: $($upgradeIdentity | ConvertTo-Json -Compress)."
    }
    $report.package.sha256UpgradeUnsigned = (Get-FileHash -LiteralPath $upgradeUnsigned -Algorithm SHA256).Hash.ToLowerInvariant()
    Copy-Item -LiteralPath $upgradeUnsigned -Destination (Join-Path $resultRoot (Split-Path -Leaf $upgradeUnsigned))

    $testCertificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $publisher -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter ([DateTime]::UtcNow.AddDays(2))
    $certificateCreated = $true
    $certThumbprint = $testCertificate.Thumbprint
    if ($testCertificate.Subject -cne $publisher) { throw "Test-signing certificate subject mismatch: $($testCertificate.Subject)." }
    if (Test-Path -LiteralPath "Cert:\LocalMachine\TrustedPeople\$certThumbprint") { throw 'Refusing to reuse an existing machine-level test signer trust entry.' }
    $null = New-Item -ItemType Directory -Path $privateRoot
    Export-PfxCertificate -Cert $testCertificate -FilePath $pfxPath -Password $pfxSecurePassword | Out-Null
    Export-Certificate -Cert $testCertificate -FilePath $cerPath | Out-Null
    $report.signing = [ordered]@{ subject = $testCertificate.Subject; thumbprint = $certThumbprint; temporaryStores = @('Build-user CurrentUser My', 'Build-user CurrentUser Root (signature verification only; removed before standard-user install)', 'Standard-user CurrentUser TrustedPeople', 'LocalMachine TrustedPeople (added only after clean install)'); privateKeyRetainedOnlyInRunner = $true }

    Copy-Item -LiteralPath $candidateUnsigned -Destination $candidateSigned
    Copy-Item -LiteralPath $upgradeUnsigned -Destination $upgradeSigned
    $signTool = Get-SignToolPath
    if (Test-Path -LiteralPath "Cert:\CurrentUser\Root\$certThumbprint") { throw 'Refusing to reuse an existing build-user test signer root trust entry.' }
    Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
    Sign-TestPackage -PackagePath $candidateSigned -SignToolPath $signTool -PfxPath $pfxPath -Password $pfxPassword -LogPrefix (Join-Path $logRoot 'candidate')
    Sign-TestPackage -PackagePath $upgradeSigned -SignToolPath $signTool -PfxPath $pfxPath -Password $pfxPassword -LogPrefix (Join-Path $logRoot 'upgrade')
    Remove-Item -LiteralPath "Cert:\CurrentUser\Root\$certThumbprint" -ErrorAction Stop
    if (Test-Path -LiteralPath "Cert:\CurrentUser\Root\$certThumbprint") { throw 'Build-user test signer root trust remains before standard-user installation.' }
    $report.package.sha256TestSigned = (Get-FileHash -LiteralPath $candidateSigned -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.package.sha256UpgradeTestSigned = (Get-FileHash -LiteralPath $upgradeSigned -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-ValidationReport

    $userSid = $null
    $userPasswordBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    $passwordString = 'Cp1!' + [Convert]::ToBase64String($userPasswordBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [Array]::Clear($userPasswordBytes, 0, $userPasswordBytes.Length)
    $securePassword = ConvertTo-SecureString -String $passwordString -AsPlainText -Force
    $null = New-LocalUser -Name $userName -Password $securePassword -Description 'Temporary ContextPick Store MSIX lifecycle account'
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
    $viteCache = Join-Path $repoRoot 'node_modules\.vite'
    $null = New-Item -ItemType Directory -Path $viteCache -Force
    Grant-TemporaryAccess -Path $repoRoot -Rights 'RX'
    Grant-TemporaryAccess -Path $resultRoot -Rights 'M'
    Grant-TemporaryAccess -Path $viteCache -Rights 'M'
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
    $systemDriveRoot = [System.IO.Path]::GetPathRoot($systemRoot)
    $systemDrive = $systemDriveRoot.TrimEnd('\')
    $environmentOverrides = @{
        ALLUSERSPROFILE = Join-Path $systemDriveRoot 'ProgramData'
        APPDATA = Join-Path $userProfile 'AppData\Roaming'
        CI = 'true'
        COMPUTERNAME = $env:COMPUTERNAME
        COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
        COREPACK_HOME = Join-Path $resultRoot 'corepack'
        GITHUB_ACTIONS = 'true'
        GITHUB_WORKSPACE = $repoRoot
        HOMEDRIVE = $systemDrive
        HOMEPATH = $userProfile.Substring($systemDrive.Length)
        LOCALAPPDATA = Join-Path $userProfile 'AppData\Local'
        PATH = "$nodeHome;$pnpmHome;$PSHOME;$systemRoot\System32;$systemRoot"
        PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
        PNPM_HOME = $pnpmHome
        PROCESSOR_ARCHITECTURE = 'ARM64'
        ProgramData = Join-Path $systemDriveRoot 'ProgramData'
        ProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
        'ProgramFiles(x86)' = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
        ProgramW6432 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
        PUBLIC = Join-Path $systemDriveRoot 'Users\Public'
        RUNNER_ENVIRONMENT = 'github-hosted'
        RUNNER_OS = 'Windows'
        RUNNER_TEMP = $runnerTemp
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

    $child = Start-Process -FilePath $pwshPath -ArgumentList $childArguments -Credential $credential -LoadUserProfile -Environment $environment -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    if (-not $child.WaitForExit(55 * 60 * 1000)) {
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
    $report.runner.testTokenElevated = $standardUserReport.token.isElevated
    if ($standardUserReport.status -ne 'passed' -or $standardUserReport.token.isElevated -ne $false) {
        throw 'The MSIX lifecycle did not pass under a verified non-elevated standard-user token.'
    }

    # The first-install evidence must precede both machine-level signer trust and WACK,
    # which can stage/retain package state. The temporary user's own trust was scoped
    # to CurrentUser\TrustedPeople and removed by its helper before returning.
    $report.cleanFirstInstall = [ordered]@{
        packageRegistrationsForAllUsersBeforeInstall = $existingPackagesAllUsers.Count
        buildUserRootTrustPresentBeforeInstall = $false
        machineSignerTrustPresentBeforeInstall = $false
        lifecycleCompletedBeforeMachineSignerTrust = $true
        lifecycleCompletedBeforeWack = $true
    }
    Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
    $machineTrustInstalled = $true

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
        foreach ($storePath in @('Cert:\CurrentUser\My', 'Cert:\CurrentUser\Root', 'Cert:\LocalMachine\TrustedPeople')) {
            $certificatePath = Join-Path $storePath $certThumbprint
            if (Test-Path -LiteralPath $certificatePath) { Remove-Item -LiteralPath $certificatePath -ErrorAction Stop }
        }
        $certificateCreated = $false
        $machineTrustInstalled = $false
    }
    $report.cleanup.signingCertificateRemoved = (@(Get-ChildItem -Path 'Cert:\CurrentUser\My', 'Cert:\CurrentUser\Root', 'Cert:\CurrentUser\TrustedPeople', 'Cert:\LocalMachine\TrustedPeople' | Where-Object Thumbprint -eq $certThumbprint).Count -eq 0)
    if (-not $report.cleanup.signingCertificateRemoved) { throw 'Runner-only test signing certificate remains in the build-user certificate stores.' }

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

    if ($certificateCreated -and $certThumbprint) {
        foreach ($storePath in @('Cert:\CurrentUser\My', 'Cert:\CurrentUser\Root')) {
            try { Remove-Item -LiteralPath (Join-Path $storePath $certThumbprint) -ErrorAction SilentlyContinue } catch { $cleanupErrors.Add("Build-user certificate cleanup failed in ${storePath}: $($_.Exception.Message)") }
        }
        $report.cleanup.signingCertificateRemoved = $false
        try {
            Remove-Item -LiteralPath "Cert:\LocalMachine\TrustedPeople\$certThumbprint" -ErrorAction SilentlyContinue
            $remainingCertificates = @(Get-ChildItem -Path 'Cert:\CurrentUser\My', 'Cert:\CurrentUser\Root', 'Cert:\LocalMachine\TrustedPeople' | Where-Object Thumbprint -eq $certThumbprint)
            $report.cleanup.signingCertificateRemoved = ($remainingCertificates.Count -eq 0)
            if (-not $report.cleanup.signingCertificateRemoved) { $cleanupErrors.Add('Runner-only test signing certificate remains in a certificate store.') }
            $machineTrustInstalled = $false
        } catch { $cleanupErrors.Add("Test-certificate trust cleanup failed: $($_.Exception.Message)") }
    }
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
    if ($pfxSecurePassword) { $pfxSecurePassword.Dispose() }
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
