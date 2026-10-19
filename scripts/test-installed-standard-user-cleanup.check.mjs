import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const launcher = await readFile(new URL('./run-restricted-token-process.ps1', import.meta.url), 'utf8');
const smoke = await readFile(new URL('./test-installed-standard-user.ps1', import.meta.url), 'utf8');
const lifecycle = await readFile(new URL('./test-installed.ps1', import.meta.url), 'utf8');
const nativePreflight = await readFile(new URL('./test-restricted-native-process.ps1', import.meta.url), 'utf8');

test('restricted-token launcher preserves the runner logon while removing admin rights', () => {
  assert.match(launcher, /CreateRestrictedToken/);
  assert.match(launcher, /DisableMaxPrivilege/);
  assert.match(launcher, /LuaToken/);
  assert.match(launcher, /DisableMaxPrivilege \| LuaToken/);
  assert.match(launcher, /AdministratorsSid/);
  assert.match(launcher, /SetTokenInformation\(restrictedToken, TokenIntegrityLevelInfo/);
  assert.match(launcher, /CreateProcessAsUserW/);
  assert.match(launcher, /InspectRestrictedToken/);
  assert.match(launcher, /CreatedByCreateRestrictedToken = true/);
  assert.match(launcher, /if \(elevated\) throw/);
  assert.match(launcher, /GetAuthenticationId/);
  assert.match(launcher, /GetLogonSid/);
  assert.match(launcher, /GetCurrentDesktopName/);
  assert.match(launcher, /integrity != MediumIntegrityRid/);
  assert.match(launcher, /tokenSession != currentSession/);
  assert.match(launcher, /!interactive/);
  assert.match(launcher, /environmentBlock\[environmentBlock\.Length - 1\] != '\\0'/);
  assert.doesNotMatch(launcher, /CreateProcessWithLogonW|CreateProcessWithTokenW/);
});

test('installed smoke preserves runner identity and captures app processes after launch', () => {
  assert.match(smoke, /Start-ContextPickRestrictedTokenProcess/);
  assert.match(smoke, /launch\.Token\.UserSid -ne \$runnerSid/);
  assert.match(smoke, /launch\.Token\.SessionId -ne \$sessionId/);
  assert.match(smoke, /Save-LaunchDiagnostics -StartedAtUtc/);
  assert.match(smoke, /same-session app processes running/);
  assert.match(smoke, /runner profile already contains ContextPick/i);
  assert.doesNotMatch(smoke, /CreateProcessWithLogonW|New-LocalUser|Remove-LocalUser|icacls\.exe.*\/(?:grant|remove:g)/);
  assert.match(lifecycle, /standard, non-elevated user token/);
});

test('restricted-token native process preflight captures the original Win32 launch error before toolchain detection', () => {
  const preflightCall = lifecycle.indexOf('Test-RestrictedNativeProcessStart');
  const toolchainDetection = lifecycle.indexOf(". (Join-Path $repoRoot 'scripts/env.ps1')");
  assert.ok(preflightCall >= 0 && preflightCall < toolchainDetection);
  assert.match(nativePreflight, /SystemDirectory[\s\S]*?whoami\.exe/);
  assert.match(nativePreflight, /UseShellExecute = \$false/);
  assert.match(nativePreflight, /RedirectStandardOutput = \$true/);
  assert.match(nativePreflight, /RedirectStandardError = \$true/);
  assert.match(nativePreflight, /NativeErrorCode/);
  assert.match(nativePreflight, /WaitForExit\(10000\)/);
});
