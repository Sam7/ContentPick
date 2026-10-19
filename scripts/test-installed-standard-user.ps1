param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.4') { throw 'PowerShell 7.4 or newer is required.' }
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'The filtered-token installer smoke is reserved for a GitHub-hosted Windows runner.'
}
if (-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The hosted runner must be elevated to install the filtered-token launcher prerequisites.'
}

. (Join-Path $PSScriptRoot 'run-filtered-token-process.ps1')

function ConvertTo-PowerShellLiteral {
    param([Parameter(Mandatory = $true)] [AllowEmptyString()] [string]$Value)
    "'" + $Value.Replace("'", "''") + "'"
}

function Get-ProcessTreeSnapshot {
    param([Parameter(Mandatory = $true)] [int]$RootProcessId)
    $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate, SessionId)
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    $null = $owned.Add($RootProcessId)
    do {
        $changed = $false
        foreach ($item in $all) {
            if ($owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)) { $changed = $true }
        }
    } while ($changed)
    @($all | Where-Object { $owned.Contains([int]$_.ProcessId) } | ForEach-Object {
        $ownerSid = $null
        try {
            $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop
            if ($owner.ReturnValue -eq 0) { $ownerSid = [string]$owner.Sid }
        } catch { }
        $commandLine = [string]$_.CommandLine
        $debugPort = $null
        if ($commandLine -match '--remote-debugging-port=(\d+)') { $debugPort = [int]$Matches[1] }
        $windowHandle = $null
        $windowTitle = $null
        try {
            $process = Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
            $windowHandle = [string]$process.MainWindowHandle
            $windowTitle = [string]$process.MainWindowTitle
        } catch { }
        [pscustomobject]@{
            processId = [int]$_.ProcessId
            parentProcessId = [int]$_.ParentProcessId
            name = [string]$_.Name
            sessionId = [int]$_.SessionId
            ownerSid = $ownerSid
            executableName = if ($_.ExecutablePath) { [System.IO.Path]::GetFileName([string]$_.ExecutablePath) } else { $null }
            creationTimeUtc = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
            debugPort = $debugPort
            windowHandle = $windowHandle
            windowTitle = $windowTitle
        }
    })
}

function Wait-ForProcessTreeExit {
    param([Parameter(Mandatory = $true)] [int]$RootProcessId, [Parameter(Mandatory = $true)] [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $ownedIds = [System.Collections.Generic.HashSet[int]]::new()
    $null = $ownedIds.Add($RootProcessId)
    do {
        $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId)
        do {
            $changed = $false
            foreach ($item in $all) {
                if ($ownedIds.Contains([int]$item.ParentProcessId) -and $ownedIds.Add([int]$item.ProcessId)) { $changed = $true }
            }
        } while ($changed)
        if (-not ($all | Where-Object { $ownedIds.Contains([int]$_.ProcessId) })) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Save-LaunchDiagnostics {
    param(
        [Parameter(Mandatory = $true)] [DateTime]$StartedAtUtc,
        [Parameter(Mandatory = $true)] [string]$UserSid,
        [Parameter(Mandatory = $true)] [int]$SessionId,
        [Parameter(Mandatory = $true)] [string]$Path
    )
    $items = [System.Collections.Generic.List[object]]::new()
    foreach ($item in @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate, SessionId)) {
        if ([int]$item.SessionId -ne $SessionId -or -not $item.CreationDate -or $item.CreationDate.ToUniversalTime() -lt $StartedAtUtc) { continue }
        if ([string]$item.Name -notin @('contextpick.exe', 'msedgewebview2.exe')) { continue }
        try {
            $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid -ErrorAction Stop
            if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $UserSid) { continue }
        } catch { continue }
        $command = [string]$item.CommandLine
        $port = $null
        if ($command -match '--remote-debugging-port=(\d+)') { $port = [int]$Matches[1] }
        $listeners = @()
        if ($port) {
            $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $item.ProcessId } | ForEach-Object { [pscustomobject]@{ address = $_.LocalAddress; port = $_.LocalPort } })
        }
        $windowHandle = $null
        try { $windowHandle = [string](Get-Process -Id ([int]$item.ProcessId) -ErrorAction Stop).MainWindowHandle } catch { }
        $items.Add([pscustomobject]@{
            processId = [int]$item.ProcessId
            parentProcessId = [int]$item.ParentProcessId
            name = [string]$item.Name
            sessionId = [int]$item.SessionId
            ownerSid = [string]$owner.Sid
            executableName = if ($item.ExecutablePath) { [System.IO.Path]::GetFileName([string]$item.ExecutablePath) } else { $null }
            creationTimeUtc = $item.CreationDate.ToUniversalTime().ToString('o')
            debugPort = $port
            listeners = $listeners
            windowHandle = $windowHandle
        })
    }
    $document = [ordered]@{
        capturedAtUtc = [DateTime]::UtcNow.ToString('o')
        testStartedAtUtc = $StartedAtUtc.ToString('o')
        runnerSid = $UserSid
        sessionId = $SessionId
        appProcesses = @($items)
        appOutputLog = [System.IO.Path]::GetFileName($stdoutPath)
    }
    [System.IO.File]::WriteAllText($Path, ($document | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    return @($items)
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installer = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $InstallerPath).Path)
$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$candidateRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp 'contextpick-candidate'))
$candidatePrefix = $candidateRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $installer.StartsWith($candidatePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installer must be inside this run dedicated candidate directory.'
}

$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp 'contextpick-filtered-token-smoke'))
$runnerTempPrefix = $runnerTemp.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($runnerTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Smoke output must remain under RUNNER_TEMP.' }
if (Test-Path -LiteralPath $outputRoot) { throw 'The dedicated installer smoke output directory already exists.' }
$null = New-Item -ItemType Directory -Path $outputRoot
$resultsDir = Join-Path $outputRoot 'playwright'
$null = New-Item -ItemType Directory -Path $resultsDir
$corepackDir = Join-Path $outputRoot 'corepack'
$null = New-Item -ItemType Directory -Path $corepackDir
$stdoutPath = Join-Path $outputRoot 'filtered-token-smoke.log'
$bootstrapPath = Join-Path $outputRoot 'filtered-token-smoke-bootstrap.ps1'
$diagnosticsPath = Join-Path $outputRoot 'launch-diagnostics.json'
$runnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$appData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$existingConfig = Join-Path $appData 'dev.contextpick.desktop'
$existingInstall = Join-Path $localAppData 'ContextPick'
if (Test-Path -LiteralPath $existingConfig) { throw "Runner profile already contains ContextPick settings: $existingConfig." }
if (Test-Path -LiteralPath $existingInstall) { throw "Runner profile already contains a ContextPick installation: $existingInstall." }
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$existingRegistrations = @(Get-ChildItem -LiteralPath $uninstallKey -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'ContextPick*' })
if ($existingRegistrations.Count -gt 0) { throw 'Runner profile already has a ContextPick uninstall registration.' }

$nodeCommand = Get-Command node.exe -ErrorAction Stop | Select-Object -First 1
$nodeHome = Split-Path -Parent $nodeCommand.Source
$pwshPath = (Get-Process -Id $PID).Path
$systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot', 'Machine')
if ([string]::IsNullOrWhiteSpace($systemRoot)) { $systemRoot = $env:SystemRoot }
$windowsPowerShellPath = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0'
$systemDrive = [System.IO.Path]::GetPathRoot($systemRoot).TrimEnd('\')
$corepackPath = Get-Command corepack.cmd -ErrorAction Stop | Select-Object -First 1
$previousCorepackHome = $env:COREPACK_HOME
try {
    $env:COREPACK_HOME = $corepackDir
    & $corepackPath.Source pnpm --version
    if ($LASTEXITCODE -ne 0) { throw "Could not prewarm pinned pnpm (Corepack exit $LASTEXITCODE)." }
} finally {
    if ($null -eq $previousCorepackHome) { Remove-Item Env:COREPACK_HOME -ErrorAction SilentlyContinue }
    else { $env:COREPACK_HOME = $previousCorepackHome }
}

$environment = @{}
$allowedNames = @(
    'ALLUSERSPROFILE', 'APPDATA', 'CI', 'COMSPEC', 'COMPUTERNAME', 'CONTEXTPICK_PLAYWRIGHT_OUTPUT_DIR',
    'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'COREPACK_HOME', 'GITHUB_ACTIONS', 'GITHUB_WORKSPACE', 'HOMEDRIVE',
    'HOMEPATH', 'LOCALAPPDATA', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'ProgramData',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PUBLIC', 'RUNNER_ENVIRONMENT', 'RUNNER_OS',
    'RUNNER_TEMP', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'
)
foreach ($name in $allowedNames) { $environment[$name] = $null }
$environment['ALLUSERSPROFILE'] = Join-Path $systemDrive 'ProgramData'
$environment['APPDATA'] = $appData
$environment['CI'] = 'true'
$environment['COMSPEC'] = Join-Path $systemRoot 'System32\cmd.exe'
$environment['COMPUTERNAME'] = $env:COMPUTERNAME
$environment['CONTEXTPICK_PLAYWRIGHT_OUTPUT_DIR'] = $resultsDir
$environment['COREPACK_ENABLE_DOWNLOAD_PROMPT'] = '0'
$environment['COREPACK_HOME'] = $corepackDir
$environment['GITHUB_ACTIONS'] = 'true'
$environment['GITHUB_WORKSPACE'] = $repoRoot
$environment['HOMEDRIVE'] = $systemDrive
$environment['HOMEPATH'] = $userProfile.Substring($systemDrive.Length)
$environment['LOCALAPPDATA'] = $localAppData
$environment['OS'] = 'Windows_NT'
$environment['PATH'] = "$nodeHome;$PSHOME;$windowsPowerShellPath;$systemRoot\System32;$systemRoot"
$environment['PATHEXT'] = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
$environment['PROCESSOR_ARCHITECTURE'] = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE', 'Machine')
$environment['ProgramData'] = Join-Path $systemDrive 'ProgramData'
$environment['ProgramFiles'] = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$environment['ProgramFiles(x86)'] = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
$environment['ProgramW6432'] = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$environment['PUBLIC'] = Join-Path $systemDrive 'Users\Public'
$environment['RUNNER_ENVIRONMENT'] = 'github-hosted'
$environment['RUNNER_OS'] = 'Windows'
$environment['RUNNER_TEMP'] = $runnerTemp
$environment['SystemDrive'] = $systemDrive
$environment['SystemRoot'] = $systemRoot
$environment['TEMP'] = $env:TEMP
$environment['TMP'] = $env:TMP
$environment['USERDOMAIN'] = $env:USERDOMAIN
$environment['USERNAME'] = $env:USERNAME
$environment['USERPROFILE'] = $userProfile
$environment['WINDIR'] = $systemRoot

$testScript = Join-Path $PSScriptRoot 'test-installed.ps1'
$bootstrapLines = [System.Collections.Generic.List[string]]::new()
$bootstrapLines.Add('$ErrorActionPreference = ''Stop''')
foreach ($entry in $environment.GetEnumerator()) {
    if ($null -ne $entry.Value) {
        $bootstrapLines.Add('[Environment]::SetEnvironmentVariable(' + (ConvertTo-PowerShellLiteral ([string]$entry.Key)) + ', ' + (ConvertTo-PowerShellLiteral ([string]$entry.Value)) + ", 'Process')")
    }
}
$bootstrapLines.Add('try { & ' + (ConvertTo-PowerShellLiteral $testScript) + ' -InstallerPath ' + (ConvertTo-PowerShellLiteral $installer) + ' *> ' + (ConvertTo-PowerShellLiteral $stdoutPath) + '; exit 0 }')
$bootstrapLines.Add('catch { $_ | Out-File -LiteralPath ' + (ConvertTo-PowerShellLiteral $stdoutPath) + ' -Append -Encoding utf8; exit 1 }')
$bootstrap = [string]::Join([Environment]::NewLine, $bootstrapLines)
$parseTokens = $null
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput($bootstrap, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Could not parse filtered-token bootstrap: $($parseErrors[0].Message)" }
[System.IO.File]::WriteAllText($bootstrapPath, $bootstrap, [Text.UTF8Encoding]::new($false))

$startedAtUtc = [DateTime]::UtcNow
$arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $bootstrapPath)
$child = $null
$childExited = $true
try {
$launch = Start-ContextPickFilteredTokenProcess -FilePath $pwshPath -ArgumentList $arguments -WorkingDirectory $repoRoot -Environment $environment
$child = $launch.Process
$childExited = $false
if ($launch.Token.SessionId -ne $sessionId -or $launch.Token.UserSid -ne $runnerSid -or $launch.Token.IsElevated -or $launch.Token.IsAdministrator -or $launch.Token.IntegrityRid -ne 0x2000) {
    throw 'Filtered-token launcher returned a process that does not meet the runner-session identity checks.'
}
$childCim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($child.Id)" -Property ProcessId, SessionId
$childOwner = Invoke-CimMethod -InputObject $childCim -MethodName GetOwnerSid -ErrorAction Stop
if (-not $childCim -or [int]$childCim.SessionId -ne $sessionId -or $childOwner.ReturnValue -ne 0 -or $childOwner.Sid -ne $runnerSid) {
    throw 'Filtered-token PowerShell child did not start as the runner SID in the runner session.'
}

$timeout = [TimeSpan]::FromMinutes(30)
    if (-not $child.WaitForExit([int]$timeout.TotalMilliseconds)) {
        try {
            $child.Kill($true)
            if (-not $child.WaitForExit(10000) -or -not (Wait-ForProcessTreeExit -RootProcessId $child.Id -TimeoutSeconds 15)) {
                throw 'Filtered-token smoke process tree did not stop after timeout.'
            }
        } catch { throw "Filtered-token installed-app smoke timed out and cleanup could not be confirmed: $_" }
        $childExited = $true
        throw 'Filtered-token installed-app smoke exceeded 30 minutes.'
    }
    $child.Refresh()
    if (-not (Wait-ForProcessTreeExit -RootProcessId $child.Id -TimeoutSeconds 15)) { throw 'Filtered-token helper exited while its process descendants remained active.' }
    $childExited = $true
    if ($child.ExitCode -ne 0) { throw "Filtered-token installer smoke failed with exit code $($child.ExitCode)." }
    $remainingAppProcesses = @(Save-LaunchDiagnostics -StartedAtUtc $startedAtUtc -UserSid $runnerSid -SessionId $sessionId -Path $diagnosticsPath)
    if ($remainingAppProcesses.Count -gt 0) { throw "Installed app left same-session app processes running: $(($remainingAppProcesses | ForEach-Object { "$($_.name) PID $($_.processId)" }) -join ', ')." }
    if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath | Write-Output }
    Write-Output "Filtered-token installer smoke passed for runner SID $runnerSid in session $sessionId."
} catch {
    if ($null -ne $child -and -not $childExited) {
        try {
            $child.Refresh()
            if (-not $child.HasExited) { $child.Kill($true) }
            if (-not $child.WaitForExit(10000) -or -not (Wait-ForProcessTreeExit -RootProcessId $child.Id -TimeoutSeconds 15)) { throw 'Child process tree did not stop after validation failure.' }
            $childExited = $true
        } catch { Write-Warning "Could not confirm filtered-token child cleanup: $_" }
    }
    try { Save-LaunchDiagnostics -StartedAtUtc $startedAtUtc -UserSid $runnerSid -SessionId $sessionId -Path $diagnosticsPath } catch { Write-Warning "Could not capture sanitized launch diagnostics: $_" }
    if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath | Write-Output }
    throw
} finally {
    if ($null -ne $child) { $child.Dispose() }
}
