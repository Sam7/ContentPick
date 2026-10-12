param(
    [Parameter(Mandatory = $true)] [string]$Subject,
    [Parameter(Mandatory = $true)] [string]$PfxPath,
    [Parameter(Mandatory = $true)] [string]$CerPath,
    [Parameter(Mandatory = $true)] [string]$ThumbprintPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$password = $env:CONTEXTPICK_TEST_CERT_PFX_PASSWORD
if ([string]::IsNullOrWhiteSpace($password)) { throw 'The temporary PFX password was not provided through the process environment.' }

$rsa = [Security.Cryptography.RSA]::Create(2048)
$certificate = $null
$publicCertificate = $null
$store = $null
try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        $Subject,
        $rsa,
        [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
        $true
    ))
    $ekuOids = [Security.Cryptography.OidCollection]::new()
    $null = $ekuOids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3', 'Code Signing'))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($ekuOids, $true))

    $notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
    $notAfter = [DateTimeOffset]::UtcNow.AddDays(2)
    $certificate = $request.CreateSelfSigned($notBefore, $notAfter)
    if ($certificate.Subject -cne $Subject) { throw "Generated certificate subject mismatch: $($certificate.Subject)." }

    $pfxDirectory = Split-Path -Parent $PfxPath
    $cerDirectory = Split-Path -Parent $CerPath
    $thumbprintDirectory = Split-Path -Parent $ThumbprintPath
    foreach ($directory in @($pfxDirectory, $cerDirectory, $thumbprintDirectory) | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "Certificate output directory does not exist: $directory." }
    }

    # Record cleanup identity before importing into the store so a timed-out caller
    # can still remove the certificate if the store operation was interrupted.
    [IO.File]::WriteAllText($ThumbprintPath, $certificate.Thumbprint, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllBytes($PfxPath, $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password))
    [IO.File]::WriteAllBytes($CerPath, $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))

    $publicCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($CerPath)
    if ($publicCertificate.Thumbprint -cne $certificate.Thumbprint -or $publicCertificate.HasPrivateKey) {
        throw 'Imported public test-signing certificate identity unexpectedly contains a private key.'
    }

    $store = [Security.Cryptography.X509Certificates.X509Store]::new('My', [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    if (@($store.Certificates | Where-Object Thumbprint -eq $certificate.Thumbprint).Count -ne 0) {
        throw 'Refusing to reuse a certificate already present in CurrentUser My.'
    }
    $store.Add($publicCertificate)
    Write-Output "Created temporary code-signing certificate $($certificate.Thumbprint)."
} finally {
    if ($store) { $store.Close(); $store.Dispose() }
    if ($publicCertificate) { $publicCertificate.Dispose() }
    if ($certificate) { $certificate.Dispose() }
    $rsa.Dispose()
    $password = $null
}
