import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cleanupTestPath = fileURLToPath(new URL('./test-installed-standard-user-cleanup.ps1', import.meta.url));
const cleanupScriptPath = fileURLToPath(new URL('./test-installed-standard-user.ps1', import.meta.url));
const installerScriptPath = fileURLToPath(new URL('./test-installed.ps1', import.meta.url));

test('installer cleanup passes /L as one icacls argument', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-File', cleanupTestPath, '-SourcePath', cleanupScriptPath], {
    encoding: 'utf8',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PowerShell cleanup regression failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
});

test('process baseline cleanup accepts an empty pre-existing process snapshot', async () => {
  const source = await readFile(cleanupScriptPath, 'utf8');
  assert.match(source, /\[AllowEmptyCollection\(\)\]\s*\[object\[\]\]\$ProcessBaseline/);
  const installerSource = await readFile(installerScriptPath, 'utf8');
  assert.match(installerSource, /\[AllowEmptyCollection\(\)\]\s*\[object\[\]\]\$ProcessBaseline/);
});

test('standard-user Corepack cache is prewarmed by the runner and read-only for the disposable account', async () => {
  const source = await readFile(cleanupScriptPath, 'utf8');
  assert.match(source, /\$env:COREPACK_HOME = \$corepackDir[\s\S]*?corepack\.cmd[\s\S]*?pnpm --version/);
  assert.match(source, /Grant-TemporaryAccess -Path \$corepackDir -Rights 'RX' -Inheritable -Recursive/);
  assert.doesNotMatch(source, /Grant-TemporaryAccess -Path \$corepackDir -Rights 'M'/);
});

test('Playwright artifacts regain runner ownership only inside the verified output subtree', async () => {
  const source = await readFile(cleanupScriptPath, 'utf8');
  assert.match(source, /function Restore-RunnerOwnershipOfSmokeArtifacts/);
  assert.match(source, /Refusing to restore ownership outside the dedicated smoke output directory/);
  assert.match(source, /\$entries = @\(\(Get-Item[^\n]+\)\) \+ @\(Get-ChildItem[^\n]+-Recurse\)/);
  assert.match(source, /FileAttributes\]::ReparsePoint/);
  assert.match(source, /icacls\.exe \$resultsFullPath \/setowner "\*\$runnerSid" \/T \/C \/Q \/L/);
  assert.match(source, /Restore-RunnerOwnershipOfSmokeArtifacts[\s\S]*?Revoke-TemporaryAccess/);
});

test('NSIS temp cleanup removes only an owned and idle uninstaller from the isolated temp directory', async () => {
  const source = await readFile(cleanupScriptPath, 'utf8');
  assert.match(source, /function Remove-NsisTemporaryUninstaller/);
  assert.match(source, /-Filter '~nsu\*\.tmp'/);
  assert.match(source, /Refusing to remove NSIS temporary directory with unexpected contents/);
  assert.match(source, /running NSIS temporary uninstaller/);
  assert.match(source, /Remove-NsisTemporaryUninstaller -TemporaryDirectory \$tempDir/);
});
