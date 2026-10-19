param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath
)

$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath $SourcePath -Raw
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Could not parse cleanup source: $($parseErrors[0].Message)" }
$cleanupFunction = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Revoke-TemporaryAccess'
}, $true)
if (-not $cleanupFunction) { throw 'Revoke-TemporaryAccess was not found.' }
Invoke-Expression $cleanupFunction.Extent.Text
$grantFunction = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Grant-TemporaryAccess'
}, $true)
if (-not $grantFunction) { throw 'Grant-TemporaryAccess was not found.' }
Invoke-Expression $grantFunction.Extent.Text

$script:icaclsCalls = [System.Collections.Generic.List[object]]::new()
function icacls.exe {
    $script:icaclsCalls.Add(@($args))
    if ($args -contains '/findsid') {
        Write-Output 'No files with a matching SID was found.'
        Write-Output 'Successfully processed 1 files; Failed processing 0 files.'
        $global:LASTEXITCODE = 1332
    } else {
        $global:LASTEXITCODE = 0
    }
}

$script:userSid = 'S-1-5-21-123-456-789-1001'
$script:aclPaths = [System.Collections.Generic.List[string]]::new()
$script:cleanupErrors = [System.Collections.Generic.List[string]]::new()
$outputRoot = 'C:\runner-temp\contextpick-standard-user-smoke'
$resultsDir = Join-Path $outputRoot 'playwright'
$tempDir = Join-Path $outputRoot 'temp'
$corepackDir = Join-Path $outputRoot 'corepack'
$repoRoot = 'C:\runner\repo'
Grant-TemporaryAccess -Path $outputRoot -Rights 'M'
Grant-TemporaryAccess -Path $resultsDir -Rights 'M' -Inheritable
Grant-TemporaryAccess -Path $tempDir -Rights 'M' -Inheritable
Grant-TemporaryAccess -Path $corepackDir -Rights 'M' -Inheritable
Grant-TemporaryAccess -Path $repoRoot -Rights 'RX' -Inheritable -Recursive
$grantCalls = @($script:icaclsCalls | Where-Object { $_ -contains '/grant' })
if ($grantCalls.Count -ne 5) { throw "Expected five temporary-access grant calls, got $($grantCalls.Count)." }
if (@($grantCalls[0] | Where-Object { $_ -eq $outputRoot }).Count -ne 1 -or @($grantCalls[0] | Where-Object { $_ -eq '/T' -or $_ -match '\(OI\)\(CI\)' }).Count -ne 0) {
    throw 'The disposable output-root grant must apply only to the root directory.'
}
if (@($grantCalls[0] | Where-Object { $_ -eq "*$script:userSid`:(M)" }).Count -ne 1) {
    throw 'The output-root grant must give the temporary user modify access without inheritance.'
}
foreach ($scratchPath in @($resultsDir, $tempDir, $corepackDir)) {
    $scratchGrant = @($grantCalls | Where-Object { $_ -contains $scratchPath })
    if ($scratchGrant.Count -ne 1 -or @($scratchGrant[0] | Where-Object { $_ -eq "*$script:userSid`:(OI)(CI)(M)" }).Count -ne 1 -or @($scratchGrant[0] | Where-Object { $_ -eq '/T' }).Count -ne 0) {
        throw "The inheritable write grant must be scoped to scratch directory $scratchPath."
    }
}
if (@($grantCalls[4] | Where-Object { $_ -eq $repoRoot }).Count -ne 1 -or @($grantCalls[4] | Where-Object { $_ -eq '/T' }).Count -ne 1) {
    throw 'The read-only repository grant must recursively cover pre-existing files.'
}
$script:aclPaths = [System.Collections.Generic.List[string]]::new()
$script:cleanupErrors = [System.Collections.Generic.List[string]]::new()
$otherPath = 'C:\runner-temp\contextpick-candidate'
$script:aclPaths.Add($outputRoot)
$script:aclPaths.Add($resultsDir)
$script:aclPaths.Add($tempDir)
$script:aclPaths.Add($corepackDir)
$script:aclPaths.Add($otherPath)
Revoke-TemporaryAccess

if ($script:cleanupErrors.Count -ne 0) { throw ($script:cleanupErrors -join [Environment]::NewLine) }
$findCalls = @($script:icaclsCalls | Where-Object { $_ -contains '/findsid' })
if ($findCalls.Count -ne 2) { throw "Expected the final output-root verification and one unrelated path verification, got $($findCalls.Count)." }
$resetCalls = @($script:icaclsCalls | Where-Object { $_ -contains '/reset' })
if ($resetCalls.Count -ne 7) { throw "Expected root and scratch-directory ACL resets, got $($resetCalls.Count)." }
$outputSweepCalls = @($script:icaclsCalls | Where-Object { $_ -contains '/remove:g' -and $_ -contains $outputRoot })
if ($outputSweepCalls.Count -ne 1) { throw "Expected one recursive output-tree SID cleanup sweep, got $($outputSweepCalls.Count)." }
$outputSweep = @($outputSweepCalls[0])
if (@($outputSweep | Where-Object { $_ -eq "*$script:userSid" }).Count -ne 1 -or @($outputSweep | Where-Object { $_ -eq '/T' }).Count -ne 1 -or @($outputSweep | Where-Object { $_ -eq '/L' }).Count -ne 1) {
    throw 'The output-tree SID cleanup sweep must remove only the temporary SID recursively and preserve reparse-point safety.'
}
$outputSweepIndex = -1
$outputFindIndex = -1
for ($callIndex = 0; $callIndex -lt $script:icaclsCalls.Count; $callIndex++) {
    $call = @($script:icaclsCalls[$callIndex])
    if ($call -contains '/remove:g' -and $call -contains $outputRoot) { $outputSweepIndex = $callIndex }
    if ($call -contains '/findsid' -and $call -contains $outputRoot) { $outputFindIndex = $callIndex }
}
if ($outputSweepIndex -lt 0 -or $outputFindIndex -le $outputSweepIndex) {
    throw 'The output-tree SID verification must run after its recursive cleanup sweep.'
}
$rootResetCall = @($resetCalls[0])
if (@($rootResetCall | Where-Object { $_ -eq $outputRoot }).Count -ne 1 -or @($rootResetCall | Where-Object { $_ -eq '/T' }).Count -ne 0) {
    throw 'The output-root direct ACL must be reset before its scratch directories.'
}
if (@($rootResetCall | Where-Object { $_ -eq '/L' }).Count -ne 1) {
    throw 'The output-root ACL reset must preserve reparse-point safety with one /L argument.'
}
foreach ($scratchIndex in 0..2) {
    $scratchPath = @($resultsDir, $tempDir, $corepackDir)[$scratchIndex]
    $rootResetIndex = 1 + ($scratchIndex * 2)
    $recursiveResetIndex = $rootResetIndex + 1
    $scratchRootReset = @($resetCalls[$rootResetIndex])
    $scratchTreeReset = @($resetCalls[$recursiveResetIndex])
    if (@($scratchRootReset | Where-Object { $_ -eq $scratchPath }).Count -ne 1 -or @($scratchRootReset | Where-Object { $_ -eq '/T' }).Count -ne 0) {
        throw "Scratch ACL for $scratchPath must reset before its descendants."
    }
    if (@($scratchTreeReset | Where-Object { $_ -eq $scratchPath }).Count -ne 1 -or @($scratchTreeReset | Where-Object { $_ -eq '/T' }).Count -ne 1) {
        throw "Recursive scratch ACL reset for $scratchPath must follow its root reset."
    }
    if (@($scratchTreeReset | Where-Object { $_ -eq '/L' }).Count -ne 1) {
        throw "Recursive scratch ACL reset for $scratchPath must preserve reparse-point safety with one /L argument."
    }
}
$otherFindCall = @($findCalls[0])
$rootFindCall = @($findCalls[1])
if (@($rootFindCall | Where-Object { $_ -eq '/L' }).Count -ne 1) {
    throw 'The output-root SID verification must pass /L as one argument.'
}
if (@($rootFindCall | Where-Object { $_ -eq '/' -or $_ -eq 'L' }).Count -ne 0) {
    throw 'The output-root SID verification split /L into separate arguments.'
}
if (@($otherFindCall | Where-Object { $_ -eq '/L' -or $_ -eq '/' -or $_ -eq 'L' }).Count -ne 0) {
    throw 'The non-output-root SID verification must not pass /L.'
}
Write-Output 'Temporary write grants are scoped to scratch directories; cleanup resets them before verifying the output tree and preserves /L as one icacls argument.'
