import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const launcher = await readFile(new URL('./run-filtered-token-process.ps1', import.meta.url), 'utf8');
const smoke = await readFile(new URL('./test-installed-standard-user.ps1', import.meta.url), 'utf8');
const lifecycle = await readFile(new URL('./test-installed.ps1', import.meta.url), 'utf8');

test('filtered-token launcher fails closed unless it receives a linked UAC limited token', () => {
  assert.match(launcher, /TokenLinkedTokenInfo/);
  assert.match(launcher, /TokenElevationTypeFull/);
  assert.match(launcher, /TokenElevationTypeLimited/);
  assert.match(launcher, /DuplicateTokenEx\(linkedToken/);
  assert.match(launcher, /CreateProcessWithTokenW/);
  assert.match(launcher, /integrity != MediumIntegrityRid/);
  assert.match(launcher, /tokenSession != currentSession/);
  assert.match(launcher, /!interactive/);
  assert.match(launcher, /environmentBlock\[environmentBlock\.Length - 1\] != '\\0'/);
  assert.doesNotMatch(launcher, /CreateProcessWithLogonW/);
});

test('installed smoke preserves runner identity and captures app processes after launch', () => {
  assert.match(smoke, /Start-ContextPickFilteredTokenProcess/);
  assert.match(smoke, /launch\.Token\.UserSid -ne \$runnerSid/);
  assert.match(smoke, /launch\.Token\.SessionId -ne \$sessionId/);
  assert.match(smoke, /Save-LaunchDiagnostics -StartedAtUtc/);
  assert.match(smoke, /same-session app processes running/);
  assert.match(smoke, /runner profile already contains ContextPick/i);
  assert.doesNotMatch(smoke, /CreateProcessWithLogonW|New-LocalUser|Remove-LocalUser|icacls\.exe.*\/(?:grant|remove:g)/);
  assert.match(lifecycle, /standard, non-elevated user token/);
});
