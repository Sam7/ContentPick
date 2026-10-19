import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cleanupTestPath = fileURLToPath(new URL('./test-installed-standard-user-cleanup.ps1', import.meta.url));
const cleanupScriptPath = fileURLToPath(new URL('./test-installed-standard-user.ps1', import.meta.url));

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
});
