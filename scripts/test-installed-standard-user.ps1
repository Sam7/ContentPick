param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'

function Grant-TemporaryAccess {
    param(
        [Parameter(Mandatory = $true)] [string]$Path,
        [Parameter(Mandatory = $true)] [string]$Rights
    )

    & icacls.exe $Path /grant "*$script:userSid`:(OI)(CI)($Rights)" /T /Q
    if ($LASTEXITCODE -ne 0) { throw "Could not grant temporary $Rights access to $Path (icacls exit $LASTEXITCODE)." }
    $script:aclPaths.Add($Path)
}

function Revoke-TemporaryAccess {
    foreach ($path in $script:aclPaths) {
        & icacls.exe $path /remove:g "*$script:userSid" /T /Q
        if ($LASTEXITCODE -ne 0) {
            $script:cleanupErrors.Add("Could not remove temporary smoke-user access from $path (icacls exit $LASTEXITCODE).")
            continue
        }

        $remainingEntries = @(& icacls.exe $path /findsid "*$script:userSid" /T /C /Q 2>&1)
        $noMatchingSid = $LASTEXITCODE -eq 1332 -and @($remainingEntries | Where-Object { $_ -match '^No files with a matching SID was found\.?$' }).Count -gt 0
        if ($LASTEXITCODE -ne 0 -and -not $noMatchingSid) {
            $script:cleanupErrors.Add("Could not verify removal of the temporary smoke-user SID from $path (icacls exit $LASTEXITCODE).")
        } elseif (-not $noMatchingSid -and $remainingEntries.Count -gt 0) {
            $script:cleanupErrors.Add("Temporary smoke-user access remains on ${path}: $($remainingEntries -join ' | ')")
        }
    }
}

function ConvertTo-PowerShellLiteral {
    param([Parameter(Mandatory = $true)] [string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Wait-ForProcessTreeExit {
    param(
        [Parameter(Mandatory = $true)] [int]$RootProcessId,
        [Parameter(Mandatory = $true)] [int]$TimeoutSeconds
    )

    $knownProcessIds = [System.Collections.Generic.HashSet[int]]::new()
    $null = $knownProcessIds.Add($RootProcessId)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId)
        do {
            $changed = $false
            foreach ($process in $processes) {
                if ($knownProcessIds.Contains([int]$process.ParentProcessId) -and $knownProcessIds.Add([int]$process.ProcessId)) {
                    $changed = $true
                }
            }
        } while ($changed)

        if (-not ($processes | Where-Object { $knownProcessIds.Contains([int]$_.ProcessId) })) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    return $false
}

if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required.' }
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'The temporary standard-user installer smoke is reserved for a GitHub-hosted Windows runner.'
}
if (-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The hosted Windows runner must be elevated to create and remove its temporary standard user.'
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installer = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $InstallerPath).Path)
$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$candidateRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp 'contextpick-candidate'))
$candidatePrefix = $candidateRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $installer.StartsWith($candidatePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installer must be inside this run dedicated candidate directory.'
}

$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp 'contextpick-standard-user-smoke'))
$outputPrefix = $runnerTemp.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The smoke output directory must remain under RUNNER_TEMP.'
}
if (Test-Path -LiteralPath $outputRoot) { throw 'The dedicated standard-user smoke output directory already exists.' }
$null = New-Item -ItemType Directory -Path $outputRoot
$resultsDir = Join-Path $outputRoot 'playwright'
$null = New-Item -ItemType Directory -Path $resultsDir
$tempDir = Join-Path $outputRoot 'temp'
$null = New-Item -ItemType Directory -Path $tempDir
$corepackDir = Join-Path $outputRoot 'corepack'
$null = New-Item -ItemType Directory -Path $corepackDir
$stdoutPath = Join-Path $outputRoot 'smoke.stdout.txt'
$stderrPath = Join-Path $outputRoot 'smoke.stderr.txt'

$script:aclPaths = [System.Collections.Generic.List[string]]::new()
$script:cleanupErrors = [System.Collections.Generic.List[string]]::new()
$script:userSid = $null
$userName = 'cpSmoke' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$accountCreated = $false
$childExited = $true
$passwordString = $null
$securePassword = $null
$child = $null
$smokeFailure = $null

try {
    $randomBytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
    $passwordString = 'Aa1!' + [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [Array]::Clear($randomBytes, 0, $randomBytes.Length)
    $securePassword = ConvertTo-SecureString -String $passwordString -AsPlainText -Force

    $null = New-LocalUser -Name $userName -Password $securePassword -Description 'Temporary ContextPick hosted installer smoke account'
    $accountCreated = $true
    $localUser = Get-LocalUser -Name $userName
    $script:userSid = $localUser.SID.Value
    $accountName = "$env:COMPUTERNAME\$userName"
    $credential = [PSCredential]::new($accountName, $securePassword)

    $adminGroup = Get-LocalGroup -SID 'S-1-5-32-544'
    $adminSids = @(Get-LocalGroupMember -Group $adminGroup | ForEach-Object { $_.SID.Value })
    if ($adminSids -contains $script:userSid) { throw 'The temporary smoke account must not belong to Administrators.' }

    Write-Output "Temporary standard test account: $accountName ($($script:userSid))"
    Grant-TemporaryAccess -Path $repoRoot -Rights 'RX'
    Grant-TemporaryAccess -Path $candidateRoot -Rights 'RX'
    Grant-TemporaryAccess -Path $outputRoot -Rights 'M'

    $nodeCommand = Get-Command node.exe -ErrorAction Stop | Select-Object -First 1
    $nodeHome = Split-Path -Parent $nodeCommand.Source
    Grant-TemporaryAccess -Path $nodeHome -Rights 'RX'

    $testScript = Join-Path $PSScriptRoot 'test-installed.ps1'
    $bootstrap = @(
        '$env:CONTEXTPICK_PLAYWRIGHT_OUTPUT_DIR = ' + (ConvertTo-PowerShellLiteral $resultsDir),
        '$env:COREPACK_HOME = ' + (ConvertTo-PowerShellLiteral $corepackDir),
        "`$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'",
        "`$env:CI = 'true'",
        '& ' + (ConvertTo-PowerShellLiteral $testScript) + ' -InstallerPath ' + (ConvertTo-PowerShellLiteral $installer),
        'exit $LASTEXITCODE'
    ) -join "`n"
    $parseTokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseInput($bootstrap, [ref]$parseTokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw "Could not parse the standard-user smoke bootstrap: $($parseErrors[0].Message)" }
    $encodedBootstrap = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
    $pwshPath = (Get-Process -Id $PID).Path
    $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot', 'Machine')
    $environment = @{
        CI = 'true'
        CONTEXTPICK_PLAYWRIGHT_OUTPUT_DIR = $resultsDir
        COREPACK_HOME = $corepackDir
        COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
        GITHUB_ACTIONS = 'true'
        RUNNER_ENVIRONMENT = 'github-hosted'
        RUNNER_OS = 'Windows'
        PATH = "$nodeHome;$PSHOME;$systemRoot\System32;$systemRoot"
        TEMP = $tempDir
        TMP = $tempDir
    }

    $child = Start-Process -FilePath $pwshPath `
        -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', $encodedBootstrap) `
        -Credential $credential -LoadUserProfile -UseNewEnvironment -Environment $environment `
        -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

    if (-not $child.WaitForExit(30 * 60 * 1000)) {
        $childExited = $false
        try {
            $child.Kill($true)
            if (-not $child.WaitForExit(10000) -or -not (Wait-ForProcessTreeExit -RootProcessId $child.Id -TimeoutSeconds 10)) {
                throw 'The timed-out standard-user smoke process tree did not stop.'
            }
            $childExited = $true
        } catch {
            throw "Standard-user smoke exceeded 30 minutes and its process tree could not be confirmed stopped: $_"
        }
        throw 'Standard-user smoke exceeded its 30-minute timeout.'
    }

    $child.Refresh()
    $childExited = $false
    if (-not (Wait-ForProcessTreeExit -RootProcessId $child.Id -TimeoutSeconds 10)) {
        throw 'The standard-user smoke process exited while a descendant process was still running.'
    }
    $childExited = $true
    if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath }
    if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath | ForEach-Object { Write-Warning $_ } }
    if ($child.ExitCode -ne 0) { throw "Standard-user installer lifecycle failed with exit code $($child.ExitCode)." }
} catch {
    $smokeFailure = $_
} finally {
    if ($childExited) {
        if ($script:userSid) { Revoke-TemporaryAccess }
        if ($accountCreated) {
            try {
                $userProfile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$script:userSid'" -ErrorAction SilentlyContinue
                if ($userProfile) {
                    $profilePath = [System.IO.Path]::GetFullPath([string]$userProfile.LocalPath)
                    $usersRoot = [System.IO.Path]::GetFullPath((Join-Path $env:SystemDrive 'Users')).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
                    if ($userProfile.Loaded) { throw 'The temporary test profile remains loaded; preserving it for runner teardown.' }
                    if (-not $profilePath.StartsWith($usersRoot, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $profilePath) -ne $userName -or $userProfile.Special) {
                        throw "Refusing to remove unexpected test profile path: $profilePath"
                    }
                    Remove-CimInstance -InputObject $userProfile
                    if (Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$script:userSid'" -ErrorAction SilentlyContinue) {
                        throw 'The temporary test profile still exists after removal.'
                    }
                }
                Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
                if (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue) {
                    throw 'The temporary smoke account still exists after removal.'
                }
            } catch {
                $script:cleanupErrors.Add("Could not fully remove the temporary smoke account/profile: $_")
            }
        }
    } else {
        $script:cleanupErrors.Add('Preserved the temporary account and permissions because a timed-out process tree could not be confirmed stopped; the hosted runner must be discarded.')
    }

    if ($securePassword) { $securePassword.Dispose() }
    $passwordString = $null
    $credential = $null
}

if ($script:cleanupErrors.Count -gt 0) {
    $script:cleanupErrors | ForEach-Object { Write-Error $_ -ErrorAction Continue }
    throw 'Standard-user smoke cleanup did not complete; see cleanup errors above.'
}
if ($smokeFailure) { throw $smokeFailure.Exception }
Write-Output 'The clean-profile installer, installed-app Playwright smoke, uninstall, and temporary-account cleanup all passed.'
