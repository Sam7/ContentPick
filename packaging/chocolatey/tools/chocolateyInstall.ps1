$ErrorActionPreference = 'Stop'

# Candidate only: the future GitHub Release URL is not yet public.
$packageArgs = @{
    packageName    = 'contextpick'
    fileType       = 'exe'
    silentArgs     = '/S'
    url64bit       = 'https://github.com/Sam7/ContentPick/releases/download/v0.1.0/ContextPick_0.1.0_x64-setup.exe'
    checksum64     = 'C6781E0C9393B8D11F924CC57DE595FB75FCD7EEA9670D95D5B9137C43EC52BD'
    checksumType64 = 'sha256'
    validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
