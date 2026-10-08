param(
    [Parameter(Position = 0)]
    [ValidateSet('all', 'typecheck', 'test', 'lint', 'build', 'e2e', 'fmt', 'clippy', 'native-check', 'native-build')]
    [string]$Check = 'all'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $Command $($Arguments -join ' ')"
    }
}

function Invoke-Pnpm {
    param([string[]]$Arguments)
    $corepack = Join-Path 'C:\Program Files\nodejs' 'corepack.cmd'
    if (Test-Path -LiteralPath $corepack) {
        Invoke-Checked $corepack (@('pnpm') + $Arguments)
    } else {
        $pnpm = Get-Command 'pnpm' -ErrorAction SilentlyContinue
        if (-not $pnpm) { throw 'Neither Corepack nor pnpm is available on PATH.' }
        Invoke-Checked $pnpm.Source $Arguments
    }
}

$frontendChecks = @('typecheck', 'test', 'lint', 'build')
$rustChecks = @('fmt', 'test', 'clippy')

if ($Check -eq 'all' -or $Check -in $frontendChecks) {
    $selected = if ($Check -eq 'all') { $frontendChecks } else { @($Check) }
    foreach ($name in $selected) { Invoke-Pnpm @('run', $name) }
}
if ($Check -eq 'e2e') {
    Invoke-Pnpm @('run', 'test:e2e')
}
if ($Check -eq 'all' -or $Check -in $rustChecks) {
    $selected = if ($Check -eq 'all') { $rustChecks } else { @($Check) }
    foreach ($name in $selected) {
        switch ($name) {
            'fmt' { Invoke-Checked 'cargo' @('fmt', '--all', '--', '--check') }
            'test' { Invoke-Checked 'cargo' @('test', '--workspace') }
            'clippy' { Invoke-Checked 'cargo' @('clippy', '--workspace', '--all-targets', '--', '-D', 'warnings') }
        }
    }
}
if ($Check -eq 'native-check') { Invoke-Checked 'cargo' @('check', '--workspace') }
if ($Check -eq 'native-build') { Invoke-Checked 'cargo' @('build', '--workspace') }
