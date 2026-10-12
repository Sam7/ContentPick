param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('AddMachineRoot', 'RemoveMachineRoot', 'AddMachineTrustedPeople', 'RemoveMachineTrustedPeople', 'RemoveTemporaryCertificate')]
    [string]$Operation,
    [string]$CertificatePath,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{40}$')]
    [string]$Thumbprint,
    [string]$ExpectedSubject
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$certificate = $null
$openedStores = [System.Collections.Generic.List[object]]::new()
try {
    if ($Operation -in @('AddMachineRoot', 'RemoveMachineRoot', 'AddMachineTrustedPeople', 'RemoveMachineTrustedPeople')) {
        if ([string]::IsNullOrWhiteSpace($CertificatePath) -or [string]::IsNullOrWhiteSpace($ExpectedSubject)) {
            throw 'Certificate path and expected subject are required for trust-store changes.'
        }
        Write-Output 'Loading and validating temporary public certificate.'
        [Console]::Out.Flush()
        $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($CertificatePath)
        if ($certificate.Thumbprint -cne $Thumbprint -or $certificate.Subject -cne $ExpectedSubject -or $certificate.HasPrivateKey) {
            throw 'Certificate file identity, subject, or public-only status does not match the expected temporary signer.'
        }
    }

    $storeSpecs = switch ($Operation) {
        'AddMachineRoot' { [pscustomobject]@{ Name = 'Root'; Location = 'LocalMachine'; Action = 'Add' } }
        'RemoveMachineRoot' { [pscustomobject]@{ Name = 'Root'; Location = 'LocalMachine'; Action = 'Remove' } }
        'AddMachineTrustedPeople' { [pscustomobject]@{ Name = 'TrustedPeople'; Location = 'LocalMachine'; Action = 'Add' } }
        'RemoveMachineTrustedPeople' { [pscustomobject]@{ Name = 'TrustedPeople'; Location = 'LocalMachine'; Action = 'Remove' } }
        'RemoveTemporaryCertificate' {
            [pscustomobject]@{ Name = 'My'; Location = 'CurrentUser'; Action = 'Remove' }
            [pscustomobject]@{ Name = 'Root'; Location = 'CurrentUser'; Action = 'Remove' }
            [pscustomobject]@{ Name = 'TrustedPeople'; Location = 'CurrentUser'; Action = 'Remove' }
            [pscustomobject]@{ Name = 'Root'; Location = 'LocalMachine'; Action = 'Remove' }
            [pscustomobject]@{ Name = 'TrustedPeople'; Location = 'LocalMachine'; Action = 'Remove' }
        }
    }

    if ($Operation -eq 'AddMachineRoot') {
        Write-Output 'Opening LocalMachine TrustedPeople for a read-only conflict check.'
        [Console]::Out.Flush()
        $conflictStore = [Security.Cryptography.X509Certificates.X509Store]::new(
            'TrustedPeople',
            [Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
        )
        $conflictStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        $openedStores.Add($conflictStore)
        Write-Output 'Searching LocalMachine TrustedPeople for the temporary signer.'
        [Console]::Out.Flush()
        $conflicts = $conflictStore.Certificates.Find(
            [Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
            $Thumbprint,
            $false
        )
        if ($conflicts.Count -ne 0) { throw 'The temporary signer already exists in LocalMachine TrustedPeople.' }
    } elseif ($Operation -eq 'AddMachineTrustedPeople') {
        Write-Output 'Opening LocalMachine Root for a read-only conflict check.'
        [Console]::Out.Flush()
        $conflictStore = [Security.Cryptography.X509Certificates.X509Store]::new(
            'Root',
            [Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
        )
        $conflictStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        $openedStores.Add($conflictStore)
        $conflicts = $conflictStore.Certificates.Find(
            [Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
            $Thumbprint,
            $false
        )
        if ($conflicts.Count -ne 0) { throw 'The temporary signer already exists in LocalMachine Root.' }
    }

    foreach ($spec in $storeSpecs) {
        $storeName = [string]$spec.Name
        $storeLocation = [Enum]::Parse([Security.Cryptography.X509Certificates.StoreLocation], [string]$spec.Location)
        $storeAction = [string]$spec.Action
        $store = [Security.Cryptography.X509Certificates.X509Store]::new($storeName, $storeLocation)
        Write-Output "Opening $storeLocation $storeName certificate store for $storeAction."
        [Console]::Out.Flush()
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $openedStores.Add($store)
        $matches = $store.Certificates.Find(
            [Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
            $Thumbprint,
            $false
        )

        if ($storeAction -eq 'Add') {
            if ($matches.Count -ne 0) { throw "The temporary signer already exists in $storeLocation $storeName." }
            Write-Output "Adding temporary certificate to $storeLocation $storeName."
            [Console]::Out.Flush()
            $store.Add($certificate)
            $verified = $store.Certificates.Find(
                [Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
                $Thumbprint,
                $false
            )
            if ($verified.Count -ne 1) { throw "The temporary signer was not uniquely added to $storeLocation $storeName." }
        } else {
            foreach ($existing in $matches) { $store.Remove($existing) }
            $remaining = $store.Certificates.Find(
                [Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
                $Thumbprint,
                $false
            )
            if ($remaining.Count -ne 0) { throw "The temporary signer remains in $storeLocation $storeName after removal." }
        }
    }

    Write-Output "Certificate store operation completed: $Operation."
} finally {
    foreach ($store in $openedStores) { $store.Close(); $store.Dispose() }
    if ($certificate) { $certificate.Dispose() }
}
