import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile(new URL('./test-store-msix.ps1', import.meta.url), 'utf8');

test('standard-user access avoids recursively granting the entire checkout', () => {
  assert.doesNotMatch(script, /Grant-TemporaryAccess\s+-Path\s+\$repoRoot\s+-Rights\s+'RX'\s+-Recursive/i);
  assert.doesNotMatch(script, /Join-Path\s+\$repoRoot\s+'node_modules\.vite'/i);

  assert.match(script, /foreach \(\$relativeDirectory in @\('node_modules', 'src', 'tests\\native', 'scripts'\)\)\s*\{\s*Grant-TemporaryAccess -Path \(Join-Path \$repoRoot \$relativeDirectory\) -Rights 'RX' -Recursive/s);
  assert.match(script, /foreach \(\$relativeFile in @\('index\.html', 'package\.json', 'pnpm-lock\.yaml', 'playwright\.native\.config\.ts', 'vite\.config\.ts', 'tsconfig\.json', 'tsconfig\.app\.json', 'tsconfig\.node\.json'\)\)\s*\{\s*Grant-TemporaryAccess -Path \(Join-Path \$repoRoot \$relativeFile\) -Rights 'RX'/s);
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

test('checkout-root access does not inherit and report permissions target an existing file', () => {
  assert.match(script, /\$inheritance\s*=\s*if\s*\(\$Recursive\s+-and\s+\(Test-Path -LiteralPath \$Path -PathType Container\)\)/i);
  assert.match(script, /\$script:aclPaths\s*=\s*\[System\.Collections\.Generic\.List\[object\]\]::new\(\)/);
  assert.match(script, /New-Item -ItemType File -Path \$standardUserReportPath -Force/);
  assert.ok(script.indexOf('New-Item -ItemType File -Path $standardUserReportPath -Force') < script.indexOf('Grant-TemporaryAccess -Path $standardUserReportPath -Rights \'M\''));
});

test('test-signing certificate generation is bounded, code-signing scoped, and cleanup tracked', async () => {
  const helper = await readFile(new URL('./create-msix-test-certificate.ps1', import.meta.url), 'utf8').catch(() => '');

  assert.doesNotMatch(script, /New-SelfSignedCertificate/i);
  assert.match(script, /create-msix-test-certificate\.ps1[\s\S]*?-TimeoutSeconds 120/);
  assert.ok(script.includes('$certificateCreated = $true'));
  assert.match(script, /if \(\$certThumbprint\) \{[\s\S]*?Build-user certificate cleanup failed/);
  assert.match(helper, /CertificateRequest/);
  assert.match(helper, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.match(helper, /CONTEXTPICK_TEST_CERT_PFX_PASSWORD/);
  assert.doesNotMatch(helper, /PersistKeySet|X509Certificate2\]::new\(\$PfxPath/i);
  assert.match(helper, /X509Certificate2\]::new\(\$CerPath\)/);
});

test('post-certificate store and signing phases are observable and bounded', () => {
  assert.match(script, /Write-LifecyclePhase 'Validating temporary signing certificate\./);
  assert.match(script, /Write-LifecyclePhase 'Locating Windows SDK SignTool\./);
  assert.match(script, /Write-LifecyclePhase 'Installing temporary build-user root trust\.'/);
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
  assert.match(script, /Test-Path[^\r\n]*Cert:\\CurrentUser\\Root[\s\S]*?Invoke-NativeCommand[\s\S]*?-TimeoutSeconds 120/);
  assert.match(script, /Import-Certificate -FilePath[\s\S]*?-ErrorAction Stop/);
});

test('local lifecycle fallback is an explicit Windows 11 x64 opt-in', async () => {
  const standardUserScript = await readFile(new URL('./test-store-msix-standard-user.ps1', import.meta.url), 'utf8');
  assert.match(script, /param\(\s*\[switch\]\$AllowLocalWin11X64/);
  assert.match(script, /AllowLocalWin11X64[\s\S]*?hostArchitecture -ne 'X64'[\s\S]*?osBuild -lt \$minimumBuild/s);
  assert.match(script, /RUNNER_ENVIRONMENT = \$executionEnvironment/);
  assert.match(standardUserScript, /CONTEXTPICK_LOCAL_MSIX_FALLBACK -eq '1'/);
  assert.match(standardUserScript, /RUNNER_ENVIRONMENT -eq 'local-admin-fallback'/);
});
