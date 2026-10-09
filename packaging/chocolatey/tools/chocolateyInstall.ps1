$ErrorActionPreference = 'Stop'

# Candidate only: the future GitHub Release URL is not yet public.
$packageArgs = @{
    packageName    = 'contextpick'
    fileType       = 'exe'
    silentArgs     = '/S'
    url64bit       = 'https://github.com/Sam7/ContentPick/releases/download/v0.1.0/ContextPick_0.1.0_x64-setup.exe'
    checksum64     = '3B909396F5FDFF5509372E258C9588F04813ACD1578FB341A6F1A032EFD3C235'
    checksumType64 = 'sha256'
    validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
