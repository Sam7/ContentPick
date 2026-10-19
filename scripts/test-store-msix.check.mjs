import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile(new URL('./test-store-msix.ps1', import.meta.url), 'utf8');

test('MSIX lifecycle uses a linked filtered token and preserves the runner account and profile', async () => {
  const helper = await readFile(new URL('./run-filtered-token-process.ps1', import.meta.url), 'utf8');
  const standardUserScript = await readFile(new URL('./test-store-msix-standard-user.ps1', import.meta.url), 'utf8');
  assert.match(script, /run-filtered-token-process\.ps1/);
  assert.match(script, /Start-ContextPickFilteredTokenProcess/);
  assert.match(script, /testTokenMode = 'UAC linked filtered token'/);
  assert.match(script, /filteredTokenReport\.token\.sid -ne \$runnerSid/);
  assert.match(script, /filteredTokenReport\.token\.sessionId/);
  assert.match(script, /filteredTokenReport\.token\.integrityRid/);
  assert.match(script, /runnerProfilePreserved = \$true/);
  assert.match(script, /filtered-token-lifecycle\.json/);
  assert.match(standardUserScript, /mode = 'UAC linked filtered token'/);
  assert.match(standardUserScript, /scope = 'fresh hosted runner profile under linked filtered token'/);
  assert.doesNotMatch(script + helper, /CreateProcessWithLogonW|New-LocalUser|Remove-LocalUser|Grant-TemporaryAccess|Revoke-TemporaryAccess|icacls\.exe.*\/(?:grant|remove:g)/);
});

test('standard-user Playwright failures capture effective package access before execution', async () => {
  const standardUserScript = await readFile(new URL('./test-store-msix-standard-user.ps1', import.meta.url), 'utf8');
  assert.match(standardUserScript, /function Write-PlaywrightPackageAccessDiagnostics/);
  assert.match(standardUserScript, /node_modules\\@playwright\\test\\package\.json/);
  assert.match(standardUserScript, /icacls\.exe \$path/);
  assert.match(standardUserScript, /fsutil\.exe hardlink list/);
  assert.match(standardUserScript, /\[System\.IO\.File\]::OpenRead\(\$manifestPath\)/);
  assert.match(standardUserScript, /readFileSync\(process\.argv\[1\], 'utf8'\)/);
  assert.match(standardUserScript, /\n\s*Write-PlaywrightPackageAccessDiagnostics\s*\n[\s\S]*?Invoke-NativeCommand -FilePath 'corepack'/);
});

test('installed MSIX Playwright checks skip the unused Vite development server', async () => {
  const nativeConfig = await readFile(new URL('../playwright.native.config.ts', import.meta.url), 'utf8');
  assert.match(nativeConfig, /webServer:\s*process\.env\.CONTEXTPICK_NATIVE_EXECUTABLE\?\.trim\(\)\s*\?\s*undefined\s*:/);
  assert.match(nativeConfig, /command: 'corepack pnpm dev:web/);
});

test('installed MSIX fixture activates by AUMID with test-only loopback WebView2 debugging', async () => {
  const standardUserScript = await readFile(new URL('./test-store-msix-standard-user.ps1', import.meta.url), 'utf8');
  const fixture = await readFile(new URL('../tests/native/native.fixture.ts', import.meta.url), 'utf8');

  assert.match(standardUserScript, /Get-AppxPackageManifest -Package \$installed\[0\]/);
  assert.match(standardUserScript, /CONTEXTPICK_NATIVE_AUMID = "\$\(\$installed\[0\]\.PackageFamilyName\)!\$\(\$applicationNode\.GetAttribute\('Id'\)\)"/);
  assert.match(fixture, /if \(appUserModelId\) \{[\s\S]*?activatePackagedApplication\(appUserModelId, nativeExe\)/);
  assert.match(fixture, /CONTEXTPICK_NATIVE_DEBUG_PORT/);
  assert.match(fixture, /IApplicationActivationManager[\s\S]*?public static int ActivateApplication\(string appUserModelId, out uint processId\)[\s\S]*?CoCreateInstance\(ref clsid, IntPtr\.Zero, 0x1, ref iid, out manager\)[\s\S]*?manager\.ActivateApplication\(appUserModelId, "", 0, out processId\)/);
  assert.match(fixture, /\[ContextPickActivation\]::ActivateApplication\(\$env:CONTEXTPICK_NATIVE_AUMID, \[ref\]\$processId\)/);
  assert.doesNotMatch(fixture, /\$manager\.ActivateApplication/);
  assert.match(fixture, /AUMID activation failed \(HRESULT 0x/);
  assert.match(fixture, /owner\.Sid -ne \$identity\.User\.Value/);
  assert.match(fixture, /process\.SessionId -ne \$sessionId/);
  assert.match(fixture, /CONTEXT_PICK_ACTIVATED /);
  assert.match(fixture, /\[Console\]::In\.ReadLine\(\)/);
  assert.match(fixture, /releaseActivationHost\(activationHost\)/);
  assert.match(fixture, /let activationHost: ChildProcess \| undefined/);
  assert.match(fixture, /await expect\(page\.getByRole\('tree', \{ name: 'Workspace files' \}\)\)\.toBeVisible\(\);\s*if \(appUserModelId\) \{ await releaseActivationHost\(activationHost\); activationHost = undefined; \}/);
  assert.match(fixture, /hasCdpListenerInProcessTree\(port, root\)/);
  assert.match(fixture, /LocalAddress -ne '127\.0\.0\.1'/);
  assert.doesNotMatch(fixture, /Software\\Policies\\Microsoft\\Edge\\WebView2/);

  const lifecycleScript = await readFile(new URL('./test-store-msix.ps1', import.meta.url), 'utf8');
  assert.match(lifecycleScript, /additionalBrowserArgs = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-address=127\.0\.0\.1 --remote-debugging-port=\$testWebViewDebugPort"/);
  assert.match(lifecycleScript, /tauri', 'build', '--config', \$testTauriConfigPath/);
  assert.match(lifecycleScript, /tauri', 'build', '--target', 'x86_64-pc-windows-msvc', '--no-bundle'\) -LogPath \(Join-Path \$logRoot 'tauri-x64-store-build\.log'\)/);
  assert.match(lifecycleScript, /\$productionExecutableHash = \(Get-FileHash -LiteralPath \$appBinary -Algorithm SHA256\)\.Hash\.ToLowerInvariant\(\)[\s\S]*?if \(\$productionExecutableHash -eq \$testConfigExecutableHash\)/);
  assert.match(lifecycleScript, /Production Store candidate must remain unsigned/);
  assert.match(lifecycleScript, /sha256Unsigned = \(Get-FileHash -LiteralPath \$storeCandidateUnsigned/);
});

test('test-signing certificate generation is bounded, code-signing scoped, and cleanup tracked', async () => {
  const helper = await readFile(new URL('./create-msix-test-certificate.ps1', import.meta.url), 'utf8').catch(() => '');

  assert.doesNotMatch(script, /New-SelfSignedCertificate/i);
  assert.match(script, /create-msix-test-certificate\.ps1[\s\S]*?-TimeoutSeconds 120/);
  assert.ok(script.includes('$certificateCreated = $true'));
  assert.match(script, /if \(\$certThumbprint\) \{[\s\S]*?RemoveTemporaryCertificate[\s\S]*?-TimeoutSeconds 120/);
  assert.match(helper, /CertificateRequest/);
  assert.match(helper, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.match(helper, /CONTEXTPICK_TEST_CERT_PFX_PASSWORD/);
  assert.doesNotMatch(helper, /PersistKeySet|X509Certificate2\]::new\(\$PfxPath/i);
  assert.match(helper, /X509Certificate2\]::new\(\$CerPath\)/);
});

test('post-certificate store and signing phases are observable and bounded', () => {
  assert.match(script, /Write-LifecyclePhase 'Validating temporary signing certificate\./);
  assert.match(script, /Write-LifecyclePhase 'Locating Windows SDK SignTool\./);
  assert.match(script, /Write-LifecyclePhase 'Installing temporary runner machine-root trust for SignTool verification\.'/);
  assert.match(script, /Write-LifecyclePhase 'Signing and verifying Store candidate and test upgrade packages\.'/);
  assert.match(script, /Invoke-NativeCommand -FilePath \$SignToolPath[\s\S]*?-TimeoutSeconds 180/);
});

test('certificate-provider checks after certificate creation do not run unbounded in the parent', () => {
  const helperFlowStart = script.indexOf("$certificateHelper = Join-Path $PSScriptRoot 'create-msix-test-certificate.ps1'");
  const certificateValidationStart = script.indexOf("Write-LifecyclePhase 'Validating temporary signing certificate.'", helperFlowStart);
  assert.notEqual(helperFlowStart, -1);
  assert.notEqual(certificateValidationStart, -1);
  const postHelper = script.slice(helperFlowStart, certificateValidationStart);
  assert.match(postHelper, /Write-LifecyclePhase 'Reading temporary certificate result for cleanup\.'/);
  assert.doesNotMatch(postHelper, /Test-Path[^\r\n]*Cert:/);
  assert.doesNotMatch(postHelper, /Get-Item[^\r\n]*Cert:/);
  assert.match(script, /manage-msix-test-certificate-store\.ps1[\s\S]*?-TimeoutSeconds 120/);
  assert.doesNotMatch(script, /Import-Certificate/);
});

test('temporary machine-root trust uses a bounded noninteractive X509Store helper', async () => {
  const helper = await readFile(new URL('./manage-msix-test-certificate-store.ps1', import.meta.url), 'utf8');
  assert.match(helper, /ValidateSet\([\s\S]*'AddMachineRoot'[\s\S]*'RemoveMachineRoot'/);
  assert.match(helper, /X509Store\]::new\([\s\S]*?'Root'[\s\S]*?StoreLocation\]::LocalMachine/);
  assert.match(helper, /X509Store\]::new\([\s\S]*?'TrustedPeople'[\s\S]*?StoreLocation\]::LocalMachine/);
  assert.match(helper, /\.Add\(\$certificate\)/);
  assert.match(helper, /\.Remove\(\$existing\)/);
  assert.match(helper, /throw '.*already exists/);
  assert.match(helper, /Certificate store operation completed/);
  const cleanupSpecs = helper.match(/'RemoveTemporaryCertificate'\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
  assert.match(cleanupSpecs, /'My'; Location = 'CurrentUser'; Action = 'Remove'/);
  assert.doesNotMatch(cleanupSpecs, /'Root'; Location = 'CurrentUser'; Action = 'Remove'/);
  assert.doesNotMatch(cleanupSpecs, /'TrustedPeople'; Location = 'CurrentUser'; Action = 'Remove'/);
  assert.match(cleanupSpecs, /'Root'; Location = 'LocalMachine'; Action = 'Remove'/);
  assert.match(cleanupSpecs, /'TrustedPeople'; Location = 'LocalMachine'; Action = 'Remove'/);
  assert.match(helper, /catch\s*\{\s*if \(\$Operation -ne 'RemoveTemporaryCertificate'\) \{ throw \}[\s\S]*?storeErrors\.Add[\s\S]*?finally[\s\S]*?if \(\$storeErrors\.Count -gt 0\)[\s\S]*?throw/);
  assert.doesNotMatch(helper, /Import-Certificate|PromptForChoice|Windows\.Forms/i);
});

test('certificate cleanup is marked incomplete if the filtered-token lifecycle process remains', () => {
  assert.match(script, /if \(-not \$childExited\) \{\s*\$report\.cleanup\.signingCertificateRemoved = \$false/);
});

test('standard-user MSIX install uses only temporary machine TrustedPeople trust', async () => {
  const standardUserScript = await readFile(new URL('./test-store-msix-standard-user.ps1', import.meta.url), 'utf8');
  const trustAdded = script.indexOf("-Operation', 'AddMachineTrustedPeople'");
  const userLifecycle = script.indexOf('Starting MSIX install, activation, upgrade, and uninstall under filtered runner token');
  const trustRemoved = script.indexOf("-Operation', 'RemoveTemporaryCertificate'");
  assert.ok(trustAdded >= 0 && trustAdded < userLifecycle, 'install trust must exist before first package deployment');
  assert.ok(trustRemoved > userLifecycle, 'trust must be removed after the standard-user lifecycle');
  assert.match(standardUserScript, /trustScope = 'LocalMachine TrustedPeople/);
  assert.doesNotMatch(standardUserScript, /Import-Certificate/);
  assert.doesNotMatch(standardUserScript, /Remove-Item[^\r\n]*Cert:\\CurrentUser\\TrustedPeople/);
  assert.match(standardUserScript, /certificateAbsentFromStandardUserMyStore/);
  assert.match(standardUserScript, /Get-ChildItem -Path 'Cert:\\CurrentUser\\My'/);
  assert.doesNotMatch(standardUserScript, /Cert:\\CurrentUser\\(?:Root|TrustedPeople)/);
  assert.match(standardUserScript, /runner profile remains intact/i);
  assert.match(script, /machineTrustedPeoplePresentBeforeInstall = \$true/);
});

test('local lifecycle fallback is an explicit Windows 11 x64 opt-in', async () => {
  const standardUserScript = await readFile(new URL('./test-store-msix-standard-user.ps1', import.meta.url), 'utf8');
  assert.match(script, /param\(\s*\[switch\]\$AllowLocalWin11X64/);
  assert.match(script, /AllowLocalWin11X64[\s\S]*?hostArchitecture -ne 'X64'[\s\S]*?osBuild -lt \$minimumBuild/s);
  assert.match(script, /RUNNER_ENVIRONMENT = \$executionEnvironment/);
  assert.match(standardUserScript, /CONTEXTPICK_LOCAL_MSIX_FALLBACK -eq '1'/);
  assert.match(standardUserScript, /RUNNER_ENVIRONMENT -eq 'local-admin-fallback'/);
});
