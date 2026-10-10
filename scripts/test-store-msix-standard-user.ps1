param(
    [Parameter(Mandatory = $true)] [string]$CandidatePackagePath,
    [Parameter(Mandatory = $true)] [string]$UpgradePackagePath,
    [Parameter(Mandatory = $true)] [string]$TestCertificatePath,
    [Parameter(Mandatory = $true)] [string]$ExpectedPackageVersion,
    [Parameter(Mandatory = $true)] [string]$ExpectedUpgradeVersion,
    [Parameter(Mandatory = $true)] [string]$IdentityName,
    [Parameter(Mandatory = $true)] [string]$Publisher,
    [Parameter(Mandatory = $true)] [string]$EvidenceRoot,
    [Parameter(Mandatory = $true)] [string]$RepositoryRoot
)

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

function Get-WebView2RuntimeInventory {
    $entries = [System.Collections.Generic.List[object]]::new()
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            $base = $null
            $clients = $null
            try {
                $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
                $clients = $base.OpenSubKey('SOFTWARE\Microsoft\EdgeUpdate\Clients')
                if (-not $clients) { continue }
                foreach ($subkeyName in $clients.GetSubKeyNames()) {
                    $client = $null
                    try {
                        $client = $clients.OpenSubKey($subkeyName)
                        if ([string]$client.GetValue('name') -like '*WebView2 Runtime*') {
                            $entries.Add([pscustomobject]@{
                                Hive = $hive.ToString()
                                View = $view.ToString()
                                Name = [string]$client.GetValue('name')
                                Version = [string]$client.GetValue('pv')
                                Location = [string]$client.GetValue('Location')
                            })
                        }
                    } finally { if ($client) { $client.Dispose() } }
                }
            } finally {
                if ($clients) { $clients.Dispose() }
                if ($base) { $base.Dispose() }
            }
        }
    }
    return @($entries)
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

function Write-UserReport {
    $userReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $userReportPath -Encoding utf8
}

$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$evidenceFullPath = [System.IO.Path]::GetFullPath($EvidenceRoot)
$runnerTempPrefix = $runnerTemp.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $evidenceFullPath.StartsWith($runnerTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence directory must remain inside RUNNER_TEMP.' }
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'The Store package user phase must run on the isolated GitHub-hosted Windows runner.' }
if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'MSIX install, app execution, upgrade and uninstall must run under a verified standard-user token.'
}

$repositoryFullPath = [System.IO.Path]::GetFullPath($RepositoryRoot)
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$configDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'dev.contextpick.desktop'
$userReportPath = Join-Path $evidenceFullPath 'standard-user-lifecycle.json'
$logRoot = Join-Path $evidenceFullPath 'logs'
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($TestCertificatePath)
$certThumbprint = $certificate.Thumbprint
$expectedAppDataRoot = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData))
$userReport = [ordered]@{
    status = 'in_progress'
    token = [ordered]@{ name = [Security.Principal.WindowsIdentity]::GetCurrent().Name; sid = $userSid; isElevated = $false; sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId }
    package = [ordered]@{ identity = $IdentityName; publisher = $Publisher; candidateSha256 = (Get-FileHash -LiteralPath $CandidatePackagePath -Algorithm SHA256).Hash.ToLowerInvariant(); candidateVersion = $ExpectedPackageVersion; installedPackageFullName = $null; installedExeSha256 = $null; upgradeSha256 = (Get-FileHash -LiteralPath $UpgradePackagePath -Algorithm SHA256).Hash.ToLowerInvariant() }
    webView2 = [ordered]@{ beforeInstall = @(); afterInstall = @() }
    install = [ordered]@{ result = 'pending'; scope = 'current standard-user profile'; architecture = $null }
    playwright = [ordered]@{ result = 'pending'; command = 'pnpm exec playwright test --config playwright.native.config.ts tests/native/workspace.spec.ts'; exitCode = $null }
    upgrade = [ordered]@{ result = 'pending'; expectedVersion = $ExpectedUpgradeVersion; actualVersion = $null }
    uninstall = [ordered]@{ result = 'pending'; packageRegistrationAbsent = $false; appConfigAbsent = $false; certificateAbsent = $false }
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    failure = $null
}
Write-UserReport

$certificateImported = $false
$packageInstalled = $false
$failure = $null
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
try {
    if (-not $repositoryFullPath.StartsWith([System.IO.Path]::GetFullPath((Get-Location).Path), [System.StringComparison]::OrdinalIgnoreCase) -and -not (Test-Path -LiteralPath $repositoryFullPath -PathType Container)) {
        throw "Repository root is not accessible to the standard user: $repositoryFullPath."
    }
    if (-not $expectedAppDataRoot.StartsWith([System.IO.Path]::GetFullPath($env:USERPROFILE), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "APPDATA is outside the disposable standard-user profile: $expectedAppDataRoot."
    }
    if (Test-Path -LiteralPath $configDirectory) { throw "Clean standard-user profile already contains ContextPick settings: $configDirectory." }
    if (@(Get-AppxPackage -Name $IdentityName -ErrorAction SilentlyContinue).Count -ne 0) { throw "A prior $IdentityName package is registered for the standard user." }
    foreach ($inputPath in @($CandidatePackagePath, $UpgradePackagePath, $TestCertificatePath)) {
        if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw "Standard-user phase input is missing: $inputPath." }
        $resolved = [System.IO.Path]::GetFullPath($inputPath)
        if (-not $resolved.StartsWith($evidenceFullPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Standard-user input must remain in the dedicated evidence folder: $resolved."
        }
    }

    $candidateIdentity = Get-MsixIdentity -PackagePath $CandidatePackagePath
    $upgradeIdentity = Get-MsixIdentity -PackagePath $UpgradePackagePath
    if ($candidateIdentity.Name -ne $IdentityName -or $candidateIdentity.Publisher -cne $Publisher -or $candidateIdentity.Version -ne $ExpectedPackageVersion -or $candidateIdentity.ProcessorArchitecture -notmatch 'x64') {
        throw 'Candidate MSIX identity, version, publisher, or architecture does not match the expected Store package.'
    }
    if ($upgradeIdentity.Name -ne $IdentityName -or $upgradeIdentity.Publisher -cne $Publisher -or $upgradeIdentity.Version -ne $ExpectedUpgradeVersion -or $upgradeIdentity.ProcessorArchitecture -notmatch 'x64') {
        throw 'Upgrade MSIX identity, version, publisher, or architecture does not match the expected Store package.'
    }
    if ($certificate.Subject -cne $Publisher) { throw "Runner-only test certificate subject mismatch: $($certificate.Subject)." }
    if (Test-Path -LiteralPath "Cert:\CurrentUser\TrustedPeople\$certThumbprint") { throw 'Refusing to reuse an existing test certificate trust entry.' }
    Import-Certificate -FilePath $TestCertificatePath -CertStoreLocation 'Cert:\CurrentUser\TrustedPeople' | Out-Null
    $certificateImported = $true
    $userReport.signing = [ordered]@{ subject = $certificate.Subject; thumbprint = $certThumbprint; trustScope = 'CurrentUser TrustedPeople'; elevatedMachineStoresModified = $false }
    $userReport.webView2.beforeInstall = @(Get-WebView2RuntimeInventory)

    Add-AppxPackage -Path $CandidatePackagePath -ErrorAction Stop
    $packageInstalled = $true
    $installed = @(Get-AppxPackage -Name $IdentityName -ErrorAction Stop)
    if ($installed.Count -ne 1) { throw "Expected exactly one per-user package registration, found $($installed.Count)." }
    if ([string]$installed[0].Architecture -notmatch 'X64') { throw "Installed MSIX architecture is not x64: $($installed[0].Architecture)." }
    if ($installed[0].Version.ToString() -ne $ExpectedPackageVersion) { throw "Installed version mismatch: $($installed[0].Version)." }
    $installedExecutable = Join-Path $installed[0].InstallLocation 'contextpick.exe'
    if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) { throw "Installed package executable is not accessible to the standard user: $installedExecutable." }
    $userReport.install = [ordered]@{ result = 'passed'; scope = 'current standard-user profile'; architecture = [string]$installed[0].Architecture; version = $installed[0].Version.ToString(); packageFullName = $installed[0].PackageFullName; installLocation = $installed[0].InstallLocation }
    $userReport.package.installedPackageFullName = $installed[0].PackageFullName
    $userReport.package.installedExeSha256 = (Get-FileHash -LiteralPath $installedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    $userReport.webView2.afterInstall = @(Get-WebView2RuntimeInventory)
    Write-UserReport

    $env:CONTEXTPICK_NATIVE_EXECUTABLE = $installedExecutable
    $env:CONTEXTPICK_NATIVE_CONFIG_DIR = $configDirectory
    $env:CONTEXTPICK_PLAYWRIGHT_OUTPUT_DIR = Join-Path $evidenceFullPath 'playwright-results'
    $env:CONTEXTPICK_SCREENSHOT_DIR = Join-Path $evidenceFullPath 'screenshots'
    $env:CONTEXTPICK_VITE_CACHE_DIR = Join-Path $evidenceFullPath 'vite-cache'
    Push-Location $repositoryFullPath
    try {
        Invoke-NativeCommand -FilePath 'corepack' -ArgumentList @('pnpm', 'exec', 'playwright', 'test', '--config', 'playwright.native.config.ts', 'tests/native/workspace.spec.ts') -LogPath (Join-Path $logRoot 'installed-playwright.log')
    } finally { Pop-Location }
    if (Test-Path -LiteralPath $configDirectory) { throw "Installed-app Playwright test did not restore its initially absent settings directory: $configDirectory." }
    $running = @(Get-Process -Name 'contextpick' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) { throw 'The installed app process remains active after the Playwright suite.' }
    $userReport.playwright.result = 'passed'
    $userReport.playwright.exitCode = 0
    Write-UserReport

    Add-AppxPackage -Path $UpgradePackagePath -ErrorAction Stop
    $upgraded = @(Get-AppxPackage -Name $IdentityName -ErrorAction Stop)
    if ($upgraded.Count -ne 1 -or $upgraded[0].Version.ToString() -ne $ExpectedUpgradeVersion) {
        throw "MSIX update failed; expected $ExpectedUpgradeVersion, found $($upgraded.Version -join ', ')."
    }
    $userReport.upgrade = [ordered]@{ result = 'passed'; expectedVersion = $ExpectedUpgradeVersion; actualVersion = $upgraded[0].Version.ToString(); packageFullName = $upgraded[0].PackageFullName }
    Write-UserReport

    Remove-AppxPackage -Package $upgraded[0].PackageFullName -ErrorAction Stop
    $packageInstalled = $false
    if (@(Get-AppxPackage -Name $IdentityName -ErrorAction SilentlyContinue).Count -ne 0) { throw 'The per-user Store-identity package remains after uninstall.' }
    if (Test-Path -LiteralPath $configDirectory) { throw "Uninstall left ContextPick settings behind: $configDirectory." }
    $userReport.uninstall.result = 'passed'
    $userReport.uninstall.packageRegistrationAbsent = $true
    $userReport.uninstall.appConfigAbsent = $true
    Write-UserReport

    Remove-Item -LiteralPath "Cert:\CurrentUser\TrustedPeople\$certThumbprint" -ErrorAction Stop
    $certificateImported = $false
    $userReport.uninstall.certificateAbsent = (@(Get-ChildItem -Path 'Cert:\CurrentUser\My', 'Cert:\CurrentUser\TrustedPeople' | Where-Object Thumbprint -eq $certThumbprint).Count -eq 0)
    if (-not $userReport.uninstall.certificateAbsent) { throw 'Runner-only public test certificate remains in the standard-user certificate stores.' }
    $userReport.status = 'passed'
} catch {
    $failure = $_
    $userReport.status = 'failed'
    $userReport.failure = [ordered]@{ message = $_.Exception.Message; category = $_.CategoryInfo.Category.ToString(); script = $_.InvocationInfo.ScriptName; line = $_.InvocationInfo.ScriptLineNumber }
} finally {
    Remove-Item Env:\CONTEXTPICK_NATIVE_EXECUTABLE -ErrorAction SilentlyContinue
    Remove-Item Env:\CONTEXTPICK_NATIVE_CONFIG_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:\CONTEXTPICK_PLAYWRIGHT_OUTPUT_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:\CONTEXTPICK_SCREENSHOT_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:\CONTEXTPICK_VITE_CACHE_DIR -ErrorAction SilentlyContinue

    if ($packageInstalled) {
        try {
            $remaining = @(Get-AppxPackage -Name $IdentityName -ErrorAction SilentlyContinue)
            if ($remaining.Count -eq 1) { Remove-AppxPackage -Package $remaining[0].PackageFullName -ErrorAction Stop }
            if (@(Get-AppxPackage -Name $IdentityName -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Package registration remains after failure cleanup.' }
            $userReport.cleanupPackage = 'Removed the per-user package after failed validation.'
        } catch { $cleanupErrors.Add("Could not remove the per-user package: $($_.Exception.Message)") }
    }
    if ($certificateImported) {
        try {
            Remove-Item -LiteralPath "Cert:\CurrentUser\TrustedPeople\$certThumbprint" -ErrorAction Stop
            if (Test-Path -LiteralPath "Cert:\CurrentUser\TrustedPeople\$certThumbprint") { throw 'TrustedPeople certificate remains after removal.' }
            $userReport.cleanupCertificate = 'Removed the standard-user trust entry after validation.'
            $userReport.uninstall.certificateAbsent = $true
        } catch { $cleanupErrors.Add("Could not remove the standard-user trust entry: $($_.Exception.Message)") }
    }
    if ($cleanupErrors.Count -gt 0) {
        $userReport.status = 'failed'
        $userReport.cleanupErrors = @($cleanupErrors)
    }
    $userReport.generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    Write-UserReport
}

if ($failure) { Write-Error -ErrorRecord $failure }
if ($userReport.status -ne 'passed') { throw 'Standard-user MSIX lifecycle did not pass; see standard-user-lifecycle.json.' }
Write-Output "MSIX install, Playwright behavior, upgrade, uninstall, and test-certificate removal passed as $($userReport.token.name) (non-elevated)."
