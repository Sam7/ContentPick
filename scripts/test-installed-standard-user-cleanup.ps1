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
$otherPath = 'C:\runner-temp\contextpick-candidate'
$script:aclPaths.Add($outputRoot)
$script:aclPaths.Add($otherPath)
Revoke-TemporaryAccess

if ($script:cleanupErrors.Count -ne 0) { throw ($script:cleanupErrors -join [Environment]::NewLine) }
$findCalls = @($script:icaclsCalls | Where-Object { $_ -contains '/findsid' })
if ($findCalls.Count -ne 2) { throw "Expected two SID verification calls, got $($findCalls.Count)." }
$resetCalls = @($script:icaclsCalls | Where-Object { $_ -contains '/reset' })
if ($resetCalls.Count -ne 2) { throw "Expected two output-root ACL resets, got $($resetCalls.Count)." }
$rootResetCall = @($resetCalls[0])
$childResetCall = @($resetCalls[1])
if (@($rootResetCall | Where-Object { $_ -eq $outputRoot }).Count -ne 1 -or @($rootResetCall | Where-Object { $_ -eq '/T' }).Count -ne 0) {
    throw 'The output-root inheritable ACL must be reset before recursively resetting its contents.'
}
if (@($rootResetCall | Where-Object { $_ -eq '/L' }).Count -ne 1) {
    throw 'The output-root ACL reset must preserve reparse-point safety with one /L argument.'
}
if (@($childResetCall | Where-Object { $_ -eq $outputRoot }).Count -ne 1 -or @($childResetCall | Where-Object { $_ -eq '/T' }).Count -ne 1) {
    throw 'The recursive output-root ACL reset must follow the root reset.'
}
if (@($childResetCall | Where-Object { $_ -eq '/L' }).Count -ne 1) {
    throw 'The recursive output-root ACL reset must preserve reparse-point safety with one /L argument.'
}
$rootFindCall = @($findCalls[0])
$otherFindCall = @($findCalls[1])
if (@($rootFindCall | Where-Object { $_ -eq '/L' }).Count -ne 1) {
    throw 'The output-root SID verification must pass /L as one argument.'
}
if (@($rootFindCall | Where-Object { $_ -eq '/' -or $_ -eq 'L' }).Count -ne 0) {
    throw 'The output-root SID verification split /L into separate arguments.'
}
if (@($otherFindCall | Where-Object { $_ -eq '/L' -or $_ -eq '/' -or $_ -eq 'L' }).Count -ne 0) {
    throw 'The non-output-root SID verification must not pass /L.'
}
Write-Output 'Revoke-TemporaryAccess resets the inheritable output-root ACL first and preserves /L as one icacls argument.'
