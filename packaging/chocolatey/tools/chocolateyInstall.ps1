$ErrorActionPreference = 'Stop'

# Candidate only: the installer is public, but the package has not been submitted or verified.
$packageArgs = @{
    packageName    = 'contextpick'
    fileType       = 'exe'
    silentArgs     = '/S'
    url64bit       = 'https://github.com/Sam7/ContentPick/releases/download/v0.1.0/ContextPick_0.1.0_x64-setup.exe'
    checksum64     = 'A372927F82057D62219A0EA6EE487F9FA282D2E7BDA90DA66566CAE7BCE7B6F9'
    checksumType64 = 'sha256'
    validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
