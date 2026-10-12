import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile(new URL('./test-store-msix.ps1', import.meta.url), 'utf8');

test('standard-user access avoids recursively granting the entire checkout', () => {
  assert.doesNotMatch(script, /Grant-TemporaryAccess\s+-Path\s+\$repoRoot\s+-Rights\s+'RX'\s+-Recursive/i);
  assert.doesNotMatch(script, /Join-Path\s+\$repoRoot\s+'node_modules\.vite'/i);
  assert.match(script, /if \(\$Recursive\) \{\s*& icacls\.exe \$Path \/grant[\s\S]*?\/T \/L \/Q \| Out-Null\s*\}/);
  assert.match(script, /if \(\$entry\.Recursive\) \{\s*\$arguments \+= @\('\/T', '\/L'\)\s*\}/);

  assert.match(script, /foreach \(\$relativeDirectory in @\('node_modules', 'src', 'tests\\native', 'scripts'\)\)\s*\{\s*Grant-TemporaryAccess -Path \(Join-Path \$repoRoot \$relativeDirectory\) -Rights 'RX' -Recursive/s);
  assert.match(script, /foreach \(\$relativeFile in @\('index\.html', 'package\.json', 'pnpm-lock\.yaml', 'playwright\.native\.config\.ts', 'vite\.config\.ts', 'tsconfig\.json', 'tsconfig\.app\.json', 'tsconfig\.node\.json'\)\)\s*\{\s*Grant-TemporaryAccess -Path \(Join-Path \$repoRoot \$relativeFile\) -Rights 'RX'/s);
});

test('standard-user access follows declared Playwright dependencies inside node_modules', () => {
  assert.match(script, /Get-Item -LiteralPath \(Join-Path \$repoRoot 'node_modules\\@playwright\\test'\) -Force/);
  assert.match(script, /Attributes -band \[IO\.FileAttributes\]::ReparsePoint/);
  assert.match(script, /\$playwrightPackageTarget = \[string\]\$playwrightPackageLink\.Target/);
  assert.match(script, /\$playwrightPackageTarget = \[IO\.Path\]::GetFullPath\(\$playwrightPackageTarget\)/);
  assert.match(script, /playwrightPackageTarget\.StartsWith\(\$nodeModulesPrefix/);
  assert.match(script, /while \(\$playwrightTargetAncestor\.StartsWith\(\$nodeModulesPrefix[\s\S]*?Get-Item -LiteralPath \$playwrightTargetAncestor -Force[\s\S]*?ReparsePoint[\s\S]*?throw/);
  assert.match(script, /ConvertFrom-Json/);
  assert.match(script, /function Get-ManifestDependencyNames \{/);
  assert.match(script, /foreach \(\$dependencyName in \(Get-ManifestDependencyNames \$playwrightPackageManifestData\)\)/);
  assert.match(script, /Join-Path \$playwrightDependencySearchPath \(Join-Path 'node_modules' \$dependencyName\)/);
  assert.match(script, /playwrightDependencySearchPath\.StartsWith\(\$repositoryPrefix/);
  assert.match(script, /playwrightPackageQueue\.Enqueue\(\$playwrightDependencyPath\)/);
  assert.match(script, /ResolveLinkTarget\(\$true\)/);
  assert.match(script, /playwrightDependencyPath[\s\S]*?StartsWith\(\$nodeModulesPrefix[\s\S]*?throw/);
  assert.match(script, /HashSet\[string\][\s\S]*?OrdinalIgnoreCase/);
  assert.match(script, /while \(\$playwrightPackageQueue\.Count -gt 0\)[\s\S]*?Get-ChildItem -LiteralPath \$playwrightDirectory/);
  assert.match(script, /if \(\$playwrightItem\.Name -eq 'node_modules'\) \{ continue \}/);
  assert.match(script, /playwrightPackageDirectories\.Add\(\$playwrightDirectory\)[\s\S]*?playwrightPackageFiles\.Add\(\$playwrightItemPath\)/);
  assert.match(script, /foreach \(\$playwrightPackageDirectory in \$playwrightPackageDirectories\)\s*\{\s*Grant-TemporaryAccess -Path \$playwrightPackageDirectory -Rights 'RX'/);
  assert.match(script, /foreach \(\$playwrightPackageFile in \$playwrightPackageFiles\)\s*\{\s*Grant-TemporaryAccess -Path \$playwrightPackageFile -Rights 'RX'/);
  assert.doesNotMatch(script, /Grant-TemporaryAccess -Path \$playwrightPackageTarget -Rights 'RX' -Recursive/);
});

test('Playwright dependency enumeration handles absent, null, empty, and populated manifest sections', { skip: process.platform !== 'win32' }, async () => {
  const helper = script.match(/function Get-ManifestDependencyNames \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, 'production dependency enumeration helper should exist');
  const powershell = spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `${helper}\n$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest; @('{}', '{"dependencies":null}', '{"dependencies":{}}', '{"dependencies":{"playwright":"1.63.0"}}') | ForEach-Object { $manifest = ConvertFrom-Json $_; ,@(Get-ManifestDependencyNames $manifest) } | ConvertTo-Json -Compress -Depth 4`,
  ], { encoding: 'utf8' });
  assert.equal(powershell.status, 0, powershell.stderr || powershell.stdout);
  assert.deepEqual(JSON.parse(powershell.stdout.trim()), [[], [], [], ['playwright']]);
});

test('standard-user writable state stays in runner evidence folders', () => {
  for (const relativePath of [
    'corepack',
    'standard-user-temp',
    'playwright-results',
    'screenshots',
    'vite-cache',
  ]) {
    assert.ok(script.includes(`Join-Path $resultRoot '${relativePath}'`), `missing isolated writable path ${relativePath}`);
  }

  assert.doesNotMatch(script, /Grant-TemporaryAccess\s+-Path\s+\$resultRoot\s+-Rights\s+'M'/i);
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

test('checkout-root access does not inherit and report permissions target an existing file', () => {
  assert.match(script, /\$inheritance\s*=\s*if\s*\(\$Recursive\s+-and\s+\(Test-Path -LiteralPath \$Path -PathType Container\)\)/i);
  assert.match(script, /\$script:aclPaths\s*=\s*\[System\.Collections\.Generic\.List\[object\]\]::new\(\)/);
  assert.match(script, /New-Item -ItemType File -Path \$standardUserReportPath -Force/);
  assert.ok(script.indexOf('New-Item -ItemType File -Path $standardUserReportPath -Force') < script.indexOf('Grant-TemporaryAccess -Path $standardUserReportPath -Rights \'M\''));
});

test('failure-path cleanup records restored repository ACLs only after successful revocation', () => {
  const finallyBlock = script.slice(script.lastIndexOf('} finally {'));
  assert.match(finallyBlock, /Revoke-TemporaryAccess\s+if \(\$script:cleanupErrors\.Count -gt 0\) \{ throw[\s\S]*?\$report\.cleanup\.repositoryAclRestored = \$true/);
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

test('certificate cleanup evidence stays false when the temporary-user profile is retained', () => {
  assert.match(script, /if \(-not \$childExited -or \(\$accountCreated -and -not \$report\.cleanup\.temporaryProfileRemoved\)\) \{\s*\$report\.cleanup\.signingCertificateRemoved = \$false/);
});

test('temporary account description respects the Windows local-account length limit', () => {
  const description = script.match(/-Description '([^']+)'/)?.[1];
  assert.ok(description, 'temporary local account should have an explicit description');
  assert.ok(description.length <= 48, `description length ${description.length} exceeds 48 characters`);
});

test('standard-user MSIX install uses only temporary machine TrustedPeople trust', async () => {
  const standardUserScript = await readFile(new URL('./test-store-msix-standard-user.ps1', import.meta.url), 'utf8');
  const trustAdded = script.indexOf("-Operation', 'AddMachineTrustedPeople'");
  const userLifecycle = script.indexOf("Write-LifecyclePhase 'Starting installed-app lifecycle under the disposable standard user.'");
  const trustRemoved = script.indexOf("-Operation', 'RemoveTemporaryCertificate'");
  assert.ok(trustAdded >= 0 && trustAdded < userLifecycle, 'install trust must exist before first package deployment');
  assert.ok(trustRemoved > userLifecycle, 'trust must be removed after the standard-user lifecycle');
  assert.match(standardUserScript, /trustScope = 'LocalMachine TrustedPeople/);
  assert.doesNotMatch(standardUserScript, /Import-Certificate/);
  assert.doesNotMatch(standardUserScript, /Remove-Item[^\r\n]*Cert:\\CurrentUser\\TrustedPeople/);
  assert.match(standardUserScript, /certificateAbsentFromStandardUserMyStore/);
  assert.match(standardUserScript, /Get-ChildItem -Path 'Cert:\\CurrentUser\\My'/);
  assert.doesNotMatch(standardUserScript, /Cert:\\CurrentUser\\(?:Root|TrustedPeople)/);
  assert.match(standardUserScript, /no signer was imported into standard-user stores, and the elevated parent performs machine trust cleanup/i);
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
