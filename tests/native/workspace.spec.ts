import { test, expect } from './native.fixture';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function setClipboard(text: string): Promise<void> {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Set-Clipboard -Value $value`], { windowsHide: true, timeout: 10_000 });
}

async function readClipboard(): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], { windowsHide: true, timeout: 10_000 });
  return stdout.replace(/[\r\n]+$/, '');
}

async function completeNativeDialog(title: string, text?: string, confirmKeys = '{ENTER}'): Promise<void> {
  const titleBase64 = Buffer.from(title, 'utf8').toString('base64');
  const escapedText = Array.from(text ?? '', (character) => '+^%~(){}[]'.includes(character) ? `{${character}}` : character).join('');
  const sendBase64 = Buffer.from(escapedText, 'utf8').toString('base64');
  const confirmBase64 = Buffer.from(confirmKeys, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ContextPickNativeDialog {
  public static IntPtr FoundWindow;
  public static uint FoundProcess;
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  public delegate bool EnumChildProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint Type; public INPUT_UNION Data; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT_UNION {
    [FieldOffset(0)] public MOUSEINPUT Mouse;
    [FieldOffset(0)] public KEYBDINPUT Keyboard;
    [FieldOffset(0)] public HARDWAREINPUT Hardware;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int Dx; public int Dy; public uint MouseData; public uint Flags; public uint Time; public IntPtr ExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort VirtualKey; public ushort ScanCode; public uint Flags; public uint Time; public IntPtr ExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint Message; public ushort ParameterLow; public ushort ParameterHigh; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${titleBase64}'))
$send = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${sendBase64}'))
$confirmation = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${confirmBase64}'))
$deadline = [DateTime]::UtcNow.AddSeconds(12)
$fixturePrefix = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'contextpick-native-playwright-'))
$dialog = [IntPtr]::Zero
$dialogProcess = [uint32]0
$actual = ''
do {
  $found = [ContextPickNativeDialog+EnumWindowsProc] {
    param($window, $parameter)
    $windowBuffer = [Text.StringBuilder]::new(512)
    [void][ContextPickNativeDialog]::GetWindowText($window, $windowBuffer, $windowBuffer.Capacity)
    if ($windowBuffer.ToString().IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $true }
    $owner = [uint32]0
    [void][ContextPickNativeDialog]::GetWindowThreadProcessId($window, [ref]$owner)
    $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -ieq 'contextpick' -and [IO.Path]::GetFullPath($process.Path).StartsWith($fixturePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      [ContextPickNativeDialog]::FoundWindow = $window
      [ContextPickNativeDialog]::FoundProcess = $owner
      return $false
    }
    return $true
  }
  [void][ContextPickNativeDialog]::EnumWindows($found, [IntPtr]::Zero)
  $dialog = [ContextPickNativeDialog]::FoundWindow
  $dialogProcess = [ContextPickNativeDialog]::FoundProcess
  if ($dialog -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if ($dialog -eq [IntPtr]::Zero) { throw "Could not find app-owned native dialog '$expected'." }
[void][ContextPickNativeDialog]::ShowWindowAsync($dialog, 9)
$setResult = [ContextPickNativeDialog]::SetForegroundWindow($dialog)
if ([ContextPickNativeDialog]::GetForegroundWindow() -ne $dialog) {
  $inputs = [ContextPickNativeDialog+INPUT[]]::new(2)
  $inputSize = [Runtime.InteropServices.Marshal]::SizeOf([type][ContextPickNativeDialog+INPUT])
  $inputs[0].Type = 1; $inputs[0].Data.Keyboard.VirtualKey = 0x12
  $inputs[1].Type = 1; $inputs[1].Data.Keyboard.VirtualKey = 0x12; $inputs[1].Data.Keyboard.Flags = 0x0002
  $sent = [ContextPickNativeDialog]::SendInput(2, $inputs, $inputSize)
  if ($sent -ne 2) {
    $keyUp = [ContextPickNativeDialog+INPUT]::new()
    $keyUp.Type = 1; $keyUp.Data.Keyboard.VirtualKey = 0x12; $keyUp.Data.Keyboard.Flags = 0x0002
    [void][ContextPickNativeDialog]::SendInput(1, [ContextPickNativeDialog+INPUT[]]@($keyUp), $inputSize)
    throw "SendInput accepted $sent of 2 Alt events; refusing to send dialog input."
  }
  $setResult = [ContextPickNativeDialog]::SetForegroundWindow($dialog)
} else { $sent = 0 }
Start-Sleep -Milliseconds 150
$foreground = [ContextPickNativeDialog]::GetForegroundWindow()
$foregroundPid = [uint32]0
[void][ContextPickNativeDialog]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
$buffer = [Text.StringBuilder]::new(512)
[void][ContextPickNativeDialog]::GetWindowText($foreground, $buffer, $buffer.Capacity)
$actual = $buffer.ToString()
if ($foreground -ne $dialog -or $foregroundPid -ne $dialogProcess -or $actual.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw "Refusing to send keys: dialog HWND=$dialog PID=$dialogProcess; foreground HWND=$foreground PID=$foregroundPid title='$actual'; SetForegroundWindow=$setResult SendInput=$sent." }
$window = $dialog
if ($send.Length -gt 0) {
  [Windows.Forms.SendKeys]::SendWait('^a')
  [Windows.Forms.SendKeys]::SendWait($send)
}
if ($confirmation -eq 'UIA:OK') {
  $controls = [System.Collections.Generic.List[object]]::new()
  $callback = [ContextPickNativeDialog+EnumChildProc] {
    param($child, $parameter)
    $childBuffer = [Text.StringBuilder]::new(256)
    [void][ContextPickNativeDialog]::GetWindowText($child, $childBuffer, $childBuffer.Capacity)
    $label = $childBuffer.ToString()
    if ($label.Length -gt 0) { $controls.Add([pscustomobject]@{ Handle = $child; Label = $label }) }
    return $true
  }
  [void][ContextPickNativeDialog]::EnumChildWindows($window, $callback, [IntPtr]::Zero)
  $button = $controls | Where-Object { $_.Label -eq 'OK' } | Select-Object -First 1
  if ($null -eq $button) { throw "The '$expected' dialog buttons were: $($controls.Label -join ', ')." }
  [void][ContextPickNativeDialog]::SendMessage($button.Handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
} else {
  [Windows.Forms.SendKeys]::SendWait($confirmation)
}
`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
}

test('native restore, paging, ignore policy, manual override, copy, and restart use the real workspace', async ({ native }) => {
  let page = native.page;
  console.log(`Native restore to all ${await page.locator('.panel-heading p').first().innerText()} in ${native.startupMs} ms`);
  const selected = page.locator('.metric-primary strong');
  const discovered = page.locator('.panel-heading p').first();
  await expect(discovered).toContainText('items discovered');
  const search = page.getByRole('textbox', { name: 'Search files' });
  await search.fill('file-0599.ts');
  await expect(page.getByRole('button', { name: 'Preview src/file-0599.ts' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Preview src/file-0599.ts' }).click();
  await expect(page.getByText('export const value599 = 599;')).toBeVisible();
  await expect(selected).toHaveText('602');
  await search.clear();

  await page.getByRole('checkbox', { name: 'Select README.md' }).click();
  await expect(selected).toHaveText('601');
  await page.getByRole('button', { name: 'Filters' }).click();
  await native.resizeWindow(1536, 1024);
  await expect(page.getByRole('form', { name: 'Filter settings' })).toBeVisible();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-filters.png') });
  const gitignore = page.getByRole('checkbox', { name: 'Respect .gitignore' });
  await gitignore.uncheck();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(selected).toHaveText('603');
  await gitignore.check();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(selected).toHaveText('601');
  await expect(page.getByRole('checkbox', { name: 'Select README.md' })).not.toBeChecked();

  await search.fill('dist');
  await page.getByRole('button', { name: 'Browse ignored files' }).first().click();
  await search.fill('dist/deep');
  await page.getByRole('button', { name: 'Browse ignored files' }).first().click();
  await search.fill('generated.ts');
  const ignoredFile = page.getByRole('button', { name: 'Preview dist/deep/generated.ts' });
  await expect(ignoredFile).toBeVisible();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-ignored-browsed.png') });
  await page.getByRole('button', { name: 'More actions for dist/deep/generated.ts' }).click();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-row-actions.png') });
  await page.getByRole('button', { name: 'Force include' }).click();
  await expect(page.getByText('Override')).toBeVisible();
  await expect(selected).toHaveText('602');
  await page.getByRole('button', { name: 'More actions for dist/deep/generated.ts' }).click();
  await page.getByRole('button', { name: 'Reset override' }).click();
  await expect(selected).toHaveText('601');

  await page.getByRole('button', { name: 'Copy context' }).click();
  await expect(page.getByRole('status')).toContainText(/Copied · 601 files · \d+(?:\.\d+)? KB/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-6-native-copy.png') });

  await native.stop();
  page = await native.launch();
  await expect(page.locator('.metric-primary strong')).toHaveText('601');
  await page.getByRole('button', { name: 'Filters' }).click();
  await expect(page.getByRole('checkbox', { name: 'Respect .gitignore' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select README.md' })).not.toBeChecked();
  await page.getByRole('textbox', { name: 'Search files' }).fill('file-0599.ts');
  await expect(page.getByRole('button', { name: 'Preview src/file-0599.ts' })).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Search files' }).clear();
  await page.getByRole('button', { name: 'Expand src', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview dist/deep/generated.ts' })).toHaveCount(0);
});

test('native selection profiles load and persist across restart', async ({ native }, testInfo) => {
  let page = native.page;
  const rootBeforeLoad = await page.locator('.workspace-path').getAttribute('title');
  await expect(page.locator('.metric-primary strong')).toHaveText('602');
  const search = page.getByRole('textbox', { name: 'Search files' });
  await search.fill('file-0599.ts');
  await page.getByRole('button', { name: 'Preview src/file-0599.ts' }).click();
  await expect(page.getByText('export const value599 = 599;')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.token-metric strong')).not.toHaveText('Calculating...', { timeout: 10_000 });
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-settings.png') });
  await native.resizeWindow(720, 520);
  await expect(page.locator('.export-bar')).toBeInViewport();
  const settingsHeadingBounds = await page.locator('.file-panel .panel-heading > div:first-child').boundingBox();
  const settingsBodyBounds = await page.locator('.settings-icon').boundingBox();
  expect(settingsHeadingBounds).not.toBeNull();
  expect(settingsBodyBounds).not.toBeNull();
  expect(Math.abs(settingsHeadingBounds!.x - settingsBodyBounds!.x)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-settings-720x520.png') });
  await native.resizeWindow(1536, 1024);
  await page.getByRole('textbox', { name: 'New profile name' }).fill('Baseline');
  await page.getByRole('button', { name: 'Save as profile' }).click();
  await expect(page.locator('.profile-active strong')).toHaveText('Baseline');

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(search).toHaveValue('file-0599.ts');
  await search.clear();
  await page.getByRole('checkbox', { name: 'Select README.md' }).click();
  await expect(page.locator('.metric-primary strong')).toHaveText('601');
  await search.fill('file-0599.ts');
  await page.getByRole('button', { name: 'Preview src/file-0599.ts' }).click();
  await expect(page.getByText('export const value599 = 599;')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('textbox', { name: 'New profile name' }).fill('Reduced');
  await page.getByRole('button', { name: 'Save as profile' }).click();
  const profiles = page.getByRole('combobox', { name: 'Saved profile' });
  await page.screenshot({ path: testInfo.outputPath('profile-settings.png') });
  await profiles.selectOption('Baseline');
  await expect(profiles).toHaveValue('Baseline');
  await page.getByRole('button', { name: 'Load profile' }).click();
  await expect(page.locator('.profile-active strong')).toHaveText('Baseline');
  await expect(page.locator('.metric-primary strong')).toHaveText('602');
  await expect(page.locator('.workspace-path')).toHaveAttribute('title', rootBeforeLoad!);
  await expect(page.getByText('export const value599 = 599;')).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(search).toHaveValue('file-0599.ts');
  await expect(page.getByRole('button', { name: 'Preview src/file-0599.ts' })).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('textbox', { name: 'Rename selected profile' }).fill('Everything');
  await page.getByRole('button', { name: 'Rename profile' }).click();
  await expect(page.locator('.profile-active strong')).toHaveText('Everything');
  await profiles.selectOption('Reduced');
  await page.getByRole('button', { name: 'Delete profile' }).click();
  await expect(profiles.getByRole('option', { name: 'Reduced' })).toHaveCount(0);

  await native.stop();
  page = await native.launch();
  await expect(page.locator('.metric-primary strong')).toHaveText('602');
  await page.getByRole('button', { name: 'Settings' }).click();
  const restoredProfiles = page.getByRole('combobox', { name: 'Saved profile' });
  await expect(restoredProfiles).toHaveValue('Everything');
  await expect(restoredProfiles.getByRole('option')).toHaveCount(1);
  await expect(page.locator('.profile-active strong')).toHaveText('Everything');
});

test('native sensitive-file confirmation gates copy and export and rejects stale selection tickets', async ({ native }) => {
  const { page, root } = native;
  const marker = `SYNTHETIC_CONTEXT_PICK_${Date.now()}`;
  const sensitiveFile = path.join(root, '.env.local');
  const outputFile = path.join(path.dirname(root), 'confirmed-context.md');
  const cancelledOutput = path.join(path.dirname(root), 'cancelled-context.md');
  const sentinelClipboard = 'CONTEXT_PICK_CLIPBOARD_MUST_REMAIN_UNCHANGED';
  await writeFile(sensitiveFile, `${marker}=test-only\n`, 'utf8');
  await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Watching', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.metric-primary strong')).toHaveText('603');
  await expect(page.getByRole('button', { name: 'Preview .env.local' })).toBeVisible();

  await page.setViewportSize({ width: 720, height: 520 });
  await setClipboard(sentinelClipboard);
  await page.getByRole('button', { name: 'Copy context' }).click();
  let dialog = page.getByRole('alertdialog', { name: 'Potentially sensitive files' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('.env.local')).toBeVisible();
  await expect(dialog.getByText('Environment file')).toBeVisible();
  await expect(dialog.getByText(/file contents are not scanned/i)).toBeVisible();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m54-sensitive-confirmation-720x520.png') });
  await dialog.getByRole('button', { name: 'Cancel Copy' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await readClipboard()).toBe(sentinelClipboard);

  await page.getByRole('button', { name: 'Copy context' }).click();
  dialog = page.getByRole('alertdialog', { name: 'Potentially sensitive files' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm Copy' }).click();
  await expect(page.getByRole('status')).toContainText('Copied · 603 files', { timeout: 30_000 });
  expect(await readClipboard()).toContain(`${marker}=test-only`);

  await page.getByRole('button', { name: 'Export Markdown' }).click();
  dialog = page.getByRole('alertdialog', { name: 'Potentially sensitive files' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel Export' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => {
    try { await access(cancelledOutput); return true; } catch { return false; }
  }).toBe(false);

  await writeFile(outputFile, 'PREVIOUS_EXPORT_MUST_SURVIVE_UNTIL_OVERWRITE_CONFIRMATION\n', 'utf8');
  await page.getByRole('button', { name: 'Export Markdown' }).click();
  dialog = page.getByRole('alertdialog', { name: 'Potentially sensitive files' });
  await expect(dialog).toBeVisible();
  expect(await readFile(outputFile, 'utf8')).toContain('PREVIOUS_EXPORT');
  await dialog.getByRole('button', { name: 'Confirm Export' }).click();
  await completeNativeDialog('Save', outputFile);
  await completeNativeDialog('Confirm Save As', undefined, '%y');
  await completeNativeDialog('Confirm overwrite', undefined, 'UIA:OK');
  await expect(page.getByRole('button', { name: 'Cancel operation' })).toHaveCount(0, { timeout: 30_000 });
  const exported = await readFile(outputFile, 'utf8');
  expect(exported).toContain(`${marker}=test-only`);
  expect(exported).not.toContain('PREVIOUS_EXPORT');
  await expect(page.getByRole('status')).toContainText('Export ready · 603 files', { timeout: 30_000 });

  const staleClipboard = 'CONTEXT_PICK_STALE_TICKET_MUST_NOT_COPY';
  await setClipboard(staleClipboard);
  await page.getByRole('button', { name: 'Copy context' }).click();
  dialog = page.getByRole('alertdialog', { name: 'Potentially sensitive files' });
  await expect(dialog).toBeVisible();
  await page.evaluate(async () => {
    const internals = (window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (!internals) throw new Error('Native Tauri command bridge is unavailable.');
    await internals.invoke('set_intent', { path: 'README.md', intent: 'exclude' });
  });
  await dialog.getByRole('button', { name: 'Confirm Copy' }).click();
  await expect(page.getByRole('alert')).toContainText(/expired or was superseded|changed/i);
  expect(await readClipboard()).toBe(staleClipboard);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Watching', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.metric-primary strong')).toHaveText('602');

  await page.getByRole('button', { name: 'Copy context' }).click();
  dialog = page.getByRole('alertdialog', { name: 'Potentially sensitive files' });
  await expect(dialog).toBeVisible();
  await writeFile(path.join(root, 'watcher-change-during-confirmation.ts'), 'export const changed = true;\n', 'utf8');
  await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Watching', { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(await readClipboard()).toBe(staleClipboard);
});

test('native watcher marks changes stale and automatically reconciles create and delete', async ({ native }) => {
  const { page, root } = native;
  const watchedPath = path.join(root, 'src', 'watcher-check.ts');
  const search = page.getByRole('textbox', { name: 'Search files' });
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();

  await writeFile(watchedPath, 'export const watched = true;\n', 'utf8');
  await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('status')).toContainText('Workspace files changed');
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
  await search.fill('watcher-check.ts');
  await expect(page.getByRole('button', { name: 'Preview src/watcher-check.ts' })).toHaveCount(0);

  await expect(page.getByRole('button', { name: 'Preview src/watcher-check.ts' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();

  await unlink(watchedPath);
  await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Preview src/watcher-check.ts' })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
});

test('native token estimates retotal selections, reuse unchanged files, and invalidate only edits', async ({ native }) => {
  const { root } = native;
  let page = native.page;
  const tokenCount = () => page.locator('.token-metric strong');
  const selectedCount = () => page.locator('.metric-primary strong');
  const generation = () => page.locator('.workbench');
  const readEstimate = (requestId: string) => page.evaluate(async (id) => {
    const internals = (window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<{
        tokens: number; files: number; reusedFiles: number; computedFiles: number; tokenizerId: string;
      }> };
    }).__TAURI_INTERNALS__;
    if (!internals) throw new Error('Native Tauri command bridge is unavailable.');
    const currentGeneration = Number(document.querySelector('.workbench')?.getAttribute('data-workspace-generation'));
    return internals.invoke('estimate_tokens', { generation: currentGeneration, requestId: id });
  }, requestId);
  const readyCount = async () => {
    await expect(tokenCount()).toHaveText(/^≈ [\d,]+$/, { timeout: 120_000 });
    return Number((await tokenCount().textContent())?.replace(/[^\d]/g, ''));
  };
  const cacheProof = async (sequence: number, files: number, computedFiles: number) => {
    const estimate = await readEstimate(`${Date.now() + 60_000}:${sequence}`);
    expect(estimate.files).toBe(files);
    expect(estimate.computedFiles).toBe(computedFiles);
    expect(estimate.reusedFiles).toBe(files - computedFiles);
    expect(estimate.tokenizerId).toBe('o200k_base');
    return estimate.tokens;
  };

  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
  await expect(page.locator('.token-metric small')).toHaveText('o200k_base · approximate');
  const initialTokens = await readyCount();
  const initialGeneration = Number(await generation().getAttribute('data-workspace-generation'));
  await cacheProof(1, 602, 0);

  await page.getByRole('checkbox', { name: 'Select README.md' }).click();
  await expect(selectedCount()).toHaveText('601');
  await expect.poll(async () => Number(await generation().getAttribute('data-workspace-generation'))).toBeGreaterThan(initialGeneration);
  await readyCount();
  const withoutReadme = await cacheProof(2, 601, 0);
  expect(withoutReadme).toBeLessThan(initialTokens);

  const addedPath = path.join(root, 'token-cache.md');
  await writeFile(addedPath, '# Cache fixture\n\nFirst version.\n', 'utf8');
  await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Watching', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(selectedCount()).toHaveText('602');
  const afterAddition = await readyCount();
  expect(afterAddition).toBeGreaterThan(withoutReadme);
  await cacheProof(3, 602, 0);

  await writeFile(addedPath, '# Cache fixture changed\n\nA longer second version.\n', 'utf8');
  await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Watching', { exact: true })).toBeVisible({ timeout: 30_000 });
  const afterEdit = await readyCount();
  expect(afterEdit).toBeGreaterThan(afterAddition);
  await cacheProof(4, 602, 0);

  await page.evaluate(async () => {
    const internals = (window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (!internals) throw new Error('Native Tauri command bridge is unavailable.');
    await internals.invoke('debug_fail_watcher');
  });
  await expect(page.getByText('Watcher unavailable', { exact: true })).toBeVisible();
  await expect(tokenCount()).toHaveText('Stale');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
  const beforeRestart = await readyCount();
  await cacheProof(5, 602, 0);

  await native.stop();
  page = await native.launch();
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
  await expect(page.locator('.token-metric small')).toHaveText('o200k_base · approximate');
  const afterRestart = await readyCount();
  expect(afterRestart).toBe(beforeRestart);
  await cacheProof(6, 602, 0);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m45-token-estimate-native.png') });
});

test('native window focus regain revalidates the active workspace exactly once', async ({ native }) => {
  const { page, deactivate, activate } = native;
  const workbench = page.getByRole('region', { name: 'Project files and preview' });
  const initialGeneration = Number(await workbench.getAttribute('data-workspace-generation'));
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();

  const minimized = await deactivate();
  expect(minimized.minimized).toBe(true);
  const restored = await activate();
  expect(restored.minimized).toBe(false);
  await page.bringToFront();

  await expect.poll(async () => Number(await workbench.getAttribute('data-workspace-generation'))).toBe(initialGeneration + 1);
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m4-3-focus-recovered.png') });
});

test('native watcher automatically reconciles a burst of edits, rename intent, and gitignore changes', async ({ native }) => {
  const { page, root } = native;
  const selected = page.locator('.metric-primary strong');
  const search = page.getByRole('textbox', { name: 'Search files' });
  const createdPath = path.join(root, 'src', 'watcher-created.ts');
  const deletedPath = path.join(root, 'src', 'file-0599.ts');
  await search.fill('main.rs');
  const mainFile = page.getByRole('checkbox', { name: 'Select src/main.rs' });
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
  await expect(mainFile).toBeChecked();

  // Persist an exact-path exclusion before moving the file; it must not follow the rename.
  // Selection changes are committed by the native workspace command, so wait on its observable projection.
  await mainFile.click();
  await expect(mainFile).not.toBeChecked();
  await expect(selected).toHaveText('601');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await writeFile(createdPath, 'export const createdDuringBurst = true;\n', 'utf8');
  await writeFile(path.join(root, 'src', 'main.rs'), 'fn main() { println!("modified before rename"); }\n', 'utf8');
  await unlink(deletedPath);
  await rename(path.join(root, 'src', 'main.rs'), path.join(root, 'src', 'renamed.rs'));
  await writeFile(path.join(root, '.gitignore'), '/.gitignore\n/dist/\n/src/file-0000.ts\n', 'utf8');

  await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Copy context' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m4-2-watcher-stale.png') });

  // No manual Refresh: require the watcher-driven reconciliation to reach a fresh snapshot.
  await expect(page.getByText('Watching', { exact: true })).toBeVisible({ timeout: 15_000 });
  await search.fill('renamed.rs');
  const renamedFile = page.getByRole('checkbox', { name: 'Select src/renamed.rs' });
  await expect(renamedFile).toBeVisible({ timeout: 10_000 });
  await expect(renamedFile).toBeChecked();
  await page.getByRole('button', { name: 'Preview src/renamed.rs' }).click();
  await expect(page.getByText('modified before rename')).toBeVisible();
  await search.fill('watcher-created.ts');
  await expect(page.getByRole('checkbox', { name: 'Select src/watcher-created.ts' })).toBeChecked();
  await search.fill('file-0599.ts');
  await expect(page.getByRole('button', { name: 'Preview src/file-0599.ts' })).toHaveCount(0);
  await search.fill('renamed.rs');
  await expect(page.getByRole('button', { name: 'Copy context' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m4-2-watcher-fresh.png') });
  await search.clear();
  await expect(selected).toHaveText('601');

  const views = page.getByRole('navigation', { name: 'Workspace views' });
  await expect(views.getByRole('button', { name: 'Ignored' })).toContainText('2 known files');
  await views.getByRole('button', { name: 'Ignored' }).click();
  await search.fill('.gitignore');
  await expect(page.getByRole('button', { name: 'Preview .gitignore' })).toBeVisible();
  await search.fill('file-0000.ts');
  await expect(page.getByRole('button', { name: 'Preview src/file-0000.ts' })).toBeVisible();
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
});

test('native copy stays pending while a selected source changes, then fails safely and reconciles', async ({ native }) => {
  const { page, root } = native;
  const search = page.getByRole('textbox', { name: 'Search files' });
  await search.fill('main.rs');
  await expect(page.getByRole('button', { name: 'Preview src/main.rs' })).toBeVisible();
  const internals = page.evaluate(async () => {
    const bridge = (window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (!bridge) throw new Error('Native Tauri command bridge is unavailable.');
    await bridge.invoke('debug_arm_copy_barrier');
  });
  await internals;

  try {
    await page.getByRole('button', { name: 'Copy context' }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const bridge = (window as Window & {
        __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<boolean> };
      }).__TAURI_INTERNALS__;
      if (!bridge) throw new Error('Native Tauri command bridge is unavailable.');
      return bridge.invoke('debug_copy_barrier_status');
    })).toBe(true);

    await writeFile(path.join(root, 'src', 'main.rs'), 'fn main() { println!("changed during copy"); }\n', 'utf8');
    await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Cancel operation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Preview src/main.rs' })).toBeVisible();
    await page.waitForTimeout(700);
    await expect(page.getByText('Files changed', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel operation' })).toBeVisible();

    await page.evaluate(() => {
      const samples: string[] = [];
      const timer = window.setInterval(() => {
        const alert = document.querySelector('[role="alert"]')?.textContent?.trim();
        const status = document.querySelector('.live-region')?.textContent?.trim();
        if (alert) samples.push(`alert:${alert}`);
        if (status?.includes('Copied')) samples.push(`status:${status}`);
      }, 10);
      Object.assign(window, { __copyOutcomeSamples: samples, __copyOutcomeTimer: timer });
    });
    await page.evaluate(async () => {
      const bridge = (window as Window & {
        __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      if (!bridge) throw new Error('Native Tauri command bridge is unavailable.');
      await bridge.invoke('debug_release_copy_barrier');
    });
    await expect.poll(() => page.evaluate(() => (window as Window & { __copyOutcomeSamples?: string[] }).__copyOutcomeSamples ?? []))
      .toContainEqual(expect.stringMatching(/^alert:.*(changed|modified|source)/i));
    await expect(page.locator('.live-region')).not.toContainText('Copied');
    expect(await page.evaluate(() => (window as Window & { __copyOutcomeSamples?: string[] }).__copyOutcomeSamples ?? []))
      .not.toEqual(expect.arrayContaining([expect.stringMatching(/^status:.*Copied/)]));
    await expect(page.getByText('Watching', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Preview src/main.rs' }).click();
    await expect(page.getByText('changed during copy')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy context' })).toBeEnabled();
  } finally {
    await page.evaluate(async () => {
      const timer = (window as Window & { __copyOutcomeTimer?: number }).__copyOutcomeTimer;
      if (timer !== undefined) window.clearInterval(timer);
      const bridge = (window as Window & {
        __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      if (bridge) await bridge.invoke('debug_release_copy_barrier').catch(() => undefined);
    }).catch(() => undefined);
  }
});

test('native root switch detaches the old watcher and watches only the new workspace', async ({ native }) => {
  const { page, root } = native;
  const nextRoot = path.join(path.dirname(root), 'workspace-switched');
  await mkdir(nextRoot, { recursive: true });
  await writeFile(path.join(nextRoot, 'NEXT.md'), '# Switched workspace\n', 'utf8');

  await page.evaluate(async (newRoot) => {
    const internals = (window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, string>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (!internals) throw new Error('Native Tauri command bridge is unavailable.');
    await internals.invoke('debug_choose_workspace', { path: newRoot });
  }, nextRoot);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('.workspace-path')).toContainText(path.basename(nextRoot));
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview NEXT.md' })).toBeVisible();

  await writeFile(path.join(root, 'src', 'old-root-change.ts'), 'export const oldRoot = true;\n', 'utf8');
  await page.waitForTimeout(500);
  await expect(page.getByText('Files changed', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();

  await writeFile(path.join(nextRoot, 'new-root-change.ts'), 'export const newRoot = true;\n', 'utf8');
  await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preview new-root-change.ts' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
});

test('native watcher failure reports unavailable and manual refresh recovers', async ({ native }) => {
  const { page } = native;
  await page.evaluate(async () => {
    const internals = (window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (!internals) throw new Error('Native Tauri command bridge is unavailable.');
    await internals.invoke('debug_fail_watcher');
  });

  await expect(page.getByText('Watcher unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Synthetic watcher failure');
  await expect(page.getByRole('button', { name: 'Copy context' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
});

test('native startup migrates version-1 extension exclusions into visible path rules', async ({ native }) => {
  await native.installLegacySettings();
  const page = await native.launch();

  await expect(page.locator('.metric-primary strong')).toHaveText('1');
  await expect(page.getByRole('checkbox', { name: 'Select README.md' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Filters' }).click();
  await expect(page.getByRole('textbox', { name: 'Exclude paths' })).toHaveValue('file-ext:ts');
  await expect(page.getByRole('textbox', { name: /exclude extensions/i })).toHaveCount(0);
  await page.setViewportSize({ width: 1536, height: 1024 });
  const filters = page.getByRole('form', { name: 'Filter settings' });
  await expect(filters).toBeVisible();
  expect(await filters.evaluate((form) => form.closest('aside') !== null)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Project files' })).toBeVisible();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-filter-settings-migrated.png') });
  await page.setViewportSize({ width: 720, height: 520 });
  await expect(filters).toBeVisible();
  await expect(page.locator('.export-bar')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-filter-settings-720x520.png') });
  const apply = filters.getByRole('button', { name: 'Apply filters' });
  await apply.scrollIntoViewIfNeeded();
  await expect(apply).toBeInViewport();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-filter-settings-720x520-scrolled.png') });

  const settings = await native.readSettings();
  expect(settings.version).toBe(3);
  const workspaces = settings.workspaces as Record<string, { policy: Record<string, unknown>; intents: Record<string, string> }>;
  const migrated = workspaces[native.root];
  expect(migrated.policy.excludePaths).toEqual(['file-ext:ts']);
  expect(migrated.policy).not.toHaveProperty('excludeExtensions');
  expect(migrated.intents).toEqual({ 'README.md': 'exclude' });
});

test('native sidebar projections remain truthful and usable at standard and minimum sizes', async ({ native }) => {
  const page = native.page;
  const selectedCount = page.locator('.metric-primary strong');
  const views = page.getByRole('navigation', { name: 'Workspace views' });
  const screenshot = (name: string) => page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing', name) });

  await page.setViewportSize({ width: 1536, height: 1024 });
  await expect(selectedCount).toHaveText('602');
  await screenshot('2026-10-10-design-review-workspace-all.png');

  await views.getByRole('button', { name: 'Selected' }).click();
  await expect(selectedCount).toHaveText('602');
  await page.getByRole('button', { name: 'Expand src', exact: true }).click();
  await screenshot('2026-10-10-design-review-selected.png');
  const search = page.getByRole('textbox', { name: 'Search files' });
  await search.fill('main.rs');
  await expect(page.getByRole('button', { name: 'Preview src/main.rs' })).toBeVisible();
  await search.clear();

  await views.getByRole('button', { name: 'Ignored' }).click();
  await expect(page.getByRole('button', { name: 'Browse ignored files' })).toBeVisible();
  await expect(views).toContainText('1 folders not browsed');
  await expect(selectedCount).toHaveText('602');
  await screenshot('2026-10-10-design-review-ignored.png');

  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  await collapse.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeFocused();
  await screenshot('2026-10-10-design-review-sidebar-collapsed.png');

  await page.setViewportSize({ width: 720, height: 520 });
  await expect(page.locator('.export-bar')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
  await screenshot('2026-10-10-design-review-sidebar-collapsed-720x520.png');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  await screenshot('2026-10-10-design-review-sidebar-open-720x520.png');
  await expect(selectedCount).toHaveText('602');
});

test('native workspace layout adapts when the app window is resized', async ({ native }) => {
  const { page } = native;
  const search = page.getByRole('textbox', { name: 'Search files' });
  await search.fill('file-0599.ts');
  const file = page.getByRole('button', { name: 'Preview src/file-0599.ts' });
  await expect(file).toBeVisible();
  await file.click();
  await expect(page.getByText('export const value599 = 599;')).toBeVisible();
  await search.clear();
  await expect(page.locator('.workspace-actions .ui-icon')).toHaveCount(2);
  await expect(page.locator('.sidebar-icon .ui-icon')).toHaveCount(5);
  await expect(page.locator('.file-glyph .ui-icon').first()).toBeVisible();

  for (const { width, height } of [
    { width: 1536, height: 1024 },
    { width: 1200, height: 800 },
    { width: 960, height: 640 },
    { width: 720, height: 520 },
  ]) {
    await native.resizeWindow(width, height);
    await expect.poll(() => page.evaluate((targetWidth) => Math.abs(window.innerWidth - targetWidth), width)).toBeLessThan(60);
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing layout element: ${selector}`);
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      const style = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing styled element: ${selector}`);
        return getComputedStyle(element);
      };
      const estimateValue = document.querySelector('.metric:nth-child(2) strong');
      if (!estimateValue) throw new Error('Missing estimated export size.');
      const sidebarElement = document.querySelector('.workspace-sidebar');
      const handleElement = document.querySelector('.preview-splitter');
      if (!sidebarElement || !handleElement) throw new Error('Missing sidebar or preview splitter.');
      const estimateValueStyle = getComputedStyle(estimateValue);
      const estimateValueLines = estimateValue.getBoundingClientRect().height / Number.parseFloat(estimateValueStyle.lineHeight);
      const distName = Array.from(document.querySelectorAll('.entry-name')).find((element) => element.textContent === 'dist');
      if (!distName) throw new Error('Missing visible ignored-folder name.');
      const gitignoreName = Array.from(document.querySelectorAll('.entry-name')).find((element) => element.textContent === '.gitignore');
      if (!gitignoreName) throw new Error('Missing visible gitignore filename.');
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        shell: rect('.app-shell'),
        logo: rect('.brand-lockup'),
        fileHeadingContent: rect('.file-panel .panel-heading > div:first-child'),
        fileSearch: rect('.search-box'),
        sidebar: rect('.workspace-sidebar'),
        sidebarOverflow: sidebarElement.scrollHeight - sidebarElement.clientHeight,
        workbench: rect('.workbench'),
        tree: rect('.file-panel'),
        treeHeading: rect('.file-panel .panel-heading'),
        preview: rect('.preview-panel'),
        previewTitle: rect('.preview-title'),
        previewCard: rect('.code-preview'),
        splitter: rect('.preview-splitter'),
        splitterGripWidth: Number.parseFloat(getComputedStyle(handleElement, '::before').width),
        footer: rect('.export-bar'),
        metrics: rect('.footer-metrics'),
        actions: rect('.export-actions'),
        estimateValueLines,
        distNameClipped: distName.scrollWidth > distName.clientWidth,
        gitignoreNameClipped: gitignoreName.scrollWidth > gitignoreName.clientWidth,
        browseButton: rect('.browse-ignored'),
        browseIcon: rect('.browse-ignored .ui-icon'),
        browseLabelVisible: style('.browse-ignored-label').display !== 'none',
        browseAccessibleName: document.querySelector('.browse-ignored')?.getAttribute('aria-label'),
        shellRadius: style('.panel').borderRadius,
        sidebarRadius: style('.workspace-sidebar').borderRadius,
        footerRadius: style('.export-bar').borderRadius,
      };
    });

    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight);
    expect(Math.abs(layout.logo.left - layout.sidebar.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.fileHeadingContent.left - layout.fileSearch.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.previewTitle.left - layout.previewCard.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.footer.left - layout.sidebar.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.footer.right - layout.preview.right)).toBeLessThanOrEqual(1);
    expect(layout.workbench.bottom).toBeLessThanOrEqual(layout.footer.top);
    expect(layout.metrics.right).toBeLessThanOrEqual(layout.actions.left);
    expect(layout.metrics.left).toBeGreaterThanOrEqual(layout.footer.left);
    expect(layout.actions.right).toBeLessThanOrEqual(layout.footer.right);
    expect(layout.estimateValueLines).toBeLessThanOrEqual(1.1);
    expect(layout.distNameClipped).toBe(false);
    if (width <= 760) expect(layout.gitignoreNameClipped).toBe(false);
    expect(layout.browseButton.height).toBeLessThanOrEqual(34);
    expect(Math.abs((layout.browseIcon.top + layout.browseIcon.bottom) / 2 - (layout.browseButton.top + layout.browseButton.bottom) / 2)).toBeLessThanOrEqual(1);
    expect(layout.browseAccessibleName).toBe('Browse ignored files');
    if (width <= 840) expect(layout.browseLabelVisible).toBe(false);
    expect(layout.sidebar.width).toBeGreaterThanOrEqual(145);
    expect(layout.sidebarOverflow).toBeLessThanOrEqual(1);
    if (width <= 840) expect(layout.treeHeading.height).toBeLessThanOrEqual(62);
    expect(layout.splitter.width).toBeGreaterThanOrEqual(14);
    expect(layout.splitterGripWidth).toBeGreaterThanOrEqual(3);
    expect(Number.parseFloat(layout.shellRadius)).toBeLessThanOrEqual(4);
    expect(Number.parseFloat(layout.sidebarRadius)).toBeLessThanOrEqual(4);
    expect(Number.parseFloat(layout.footerRadius)).toBeLessThanOrEqual(4);
    expect(layout.tree.width).toBeGreaterThan(200);
    expect(layout.preview.width).toBeGreaterThan(150);
    expect(layout.footer.left).toBeGreaterThanOrEqual(0);
    expect(layout.footer.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.footer.bottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
    await expect(page.locator('.live-region')).toBeEmpty();
    await expect(page.locator('.refresh-badge')).toHaveText('Watching');
    await page.screenshot({ path: path.resolve(import.meta.dirname, `../../docs/testing/2026-10-10-window-resize-${width}x${height}.png`) });
  }
});

test('native preview collapses accessibly and restores long-path content without changing selection', async ({ native }) => {
  const { page } = native;
  const segmentA = `deep-${'a'.repeat(42)}`;
  const segmentB = `nested-${'b'.repeat(42)}`;
  const relativePath = `src/${segmentA}/${segmentB}/long-preview.ts`;
  const absolutePath = path.join(native.root, 'src', segmentA, segmentB, 'long-preview.ts');
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, 'export const longPath = true;\n', 'utf8');
  await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('textbox', { name: 'Search files' }).fill(relativePath);
  await expect(page.getByRole('button', { name: `Preview src/${segmentA}/${segmentB}/long-preview.ts` })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1536, height: 1024 });
  const splitter = page.getByRole('separator', { name: 'File preview' });
  const previewPanel = page.locator('#file-preview-pane');
  await expect(splitter).toHaveAttribute('aria-controls', 'file-preview-pane');
  await expect(splitter).toHaveAttribute('aria-valuenow', '32');
  const initialDivider = await splitter.boundingBox();
  const initialPreviewWidth = await previewPanel.evaluate((panel) => panel.getBoundingClientRect().width);
  expect(initialDivider).not.toBeNull();

  await splitter.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', '34');
  const widenedDivider = await splitter.boundingBox();
  const widenedPreviewWidth = await previewPanel.evaluate((panel) => panel.getBoundingClientRect().width);
  expect(widenedDivider!.x).toBeLessThan(initialDivider!.x);
  expect(widenedPreviewWidth).toBeGreaterThan(initialPreviewWidth);
  await expect(splitter).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(splitter).toHaveAttribute('aria-valuenow', '32');
  await page.keyboard.press('End');
  await expect(splitter).toHaveAttribute('aria-valuenow', '50');
  await page.keyboard.press('Home');
  await expect(splitter).toHaveAttribute('aria-valuenow', '25');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', '32');

  const splitterBounds = await splitter.boundingBox();
  expect(splitterBounds).not.toBeNull();
  await page.mouse.move(splitterBounds!.x + splitterBounds!.width / 2, splitterBounds!.y + 24);
  await page.mouse.down();
  await page.mouse.move(splitterBounds!.x - 40, splitterBounds!.y + 24);
  await page.mouse.up();
  let draggedWidth = Number(await splitter.getAttribute('aria-valuenow'));
  expect(draggedWidth).toBeGreaterThan(32);
  expect(draggedWidth).toBeLessThanOrEqual(50);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-5-native-preview-resizable.png') });

  const search = page.getByRole('textbox', { name: 'Search files' });
  await search.fill('long-preview.ts');
  const file = page.getByRole('button', { name: `Preview ${relativePath}` });
  await expect(file).toBeVisible();
  await file.click();
  await expect(page.getByText('export const longPath = true;')).toBeVisible();
  const previewDetails = page.getByRole('group', { name: 'Preview file details' });
  await expect(previewDetails).toContainText(`Size: ${Buffer.byteLength('export const longPath = true;\n', 'utf8')} bytes`);
  await expect(previewDetails).toContainText('Included');
  const longFileSelection = page.getByRole('checkbox', { name: `Select ${relativePath}` });
  await expect(longFileSelection).toBeChecked();
  await longFileSelection.click();
  await expect(longFileSelection).not.toBeChecked();
  await file.click();
  await expect(previewDetails).toContainText('Not included');
  await longFileSelection.click();
  await expect(longFileSelection).toBeChecked();
  await file.click();
  await expect(previewDetails).toContainText('Included');
  expect(await page.locator('.preview-panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
  await expect(page.locator('.metric-primary strong')).toHaveText('603');
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-5-native-preview-long-path.png') });
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.locator('.export-bar')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1200);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-5-native-preview-1200x800.png') });

  const views = page.getByRole('navigation', { name: 'Workspace views' });
  await views.getByRole('button', { name: 'Selected' }).click();
  await expect(page.getByRole('button', { name: `Preview ${relativePath}` })).toBeVisible();
  await expect(page.locator('.metric-primary strong')).toHaveText('603');
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-5-native-preview-selected.png') });
  await search.clear();
  await views.getByRole('button', { name: 'Ignored' }).click();
  await expect(views).toContainText('1 folders not browsed');
  await search.fill('dist');
  await page.getByRole('button', { name: 'Browse ignored files' }).first().click();
  await search.fill('dist/deep');
  await page.getByRole('button', { name: 'Browse ignored files' }).first().click();
  await search.fill('generated.ts');
  await expect(page.getByRole('button', { name: 'Preview dist/deep/generated.ts' })).toBeVisible();
  await expect(page.locator('.metric-primary strong')).toHaveText('603');
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-5-native-preview-ignored.png') });
  await views.getByRole('button', { name: 'All' }).click();
  await search.fill('long-preview.ts');
  const longFile = page.getByRole('button', { name: `Preview ${relativePath}` });
  await expect(longFile).toBeVisible();
  await longFile.click();
  await expect(page.getByText('export const longPath = true;')).toBeVisible();

  await page.setViewportSize({ width: 720, height: 520 });
  const narrowSplitter = page.getByRole('separator', { name: 'File preview' });
  await expect(narrowSplitter).toBeVisible();
  await expect(previewDetails).toBeVisible();
  await narrowSplitter.focus();
  await page.keyboard.press('Home');
  await expect(narrowSplitter).toHaveAttribute('aria-valuenow', '25');
  const minPreviewPercent = await page.evaluate(() => {
    const workbench = document.querySelector('.workbench')!.getBoundingClientRect();
    const preview = document.querySelector('.preview-panel')!.getBoundingClientRect();
    return (preview.width / workbench.width) * 100;
  });
  expect(Math.abs(minPreviewPercent - 25)).toBeLessThanOrEqual(1);
  const homePreviewWidth = await page.locator('.preview-panel').evaluate((panel) => panel.getBoundingClientRect().width);
  await page.keyboard.press('ArrowLeft');
  await expect(narrowSplitter).toHaveAttribute('aria-valuenow', '27');
  const widerPreviewWidth = await page.locator('.preview-panel').evaluate((panel) => panel.getBoundingClientRect().width);
  expect(widerPreviewWidth).toBeGreaterThan(homePreviewWidth);
  expect(await page.locator('.code-preview').evaluate((panel) => panel.getBoundingClientRect().height)).toBeGreaterThan(80);
  await expect(page.locator('.export-bar')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-5-native-preview-resizable-720x520.png') });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(narrowSplitter).toHaveAttribute('aria-valuenow', '32');
  draggedWidth = Number(await narrowSplitter.getAttribute('aria-valuenow'));
  await page.setViewportSize({ width: 1536, height: 1024 });

  await splitter.focus();
  await page.keyboard.press('Enter');
  const restoreFromSplitter = page.getByRole('button', { name: 'Expand preview' });
  await expect(restoreFromSplitter).toBeFocused();
  await expect(page.getByText('export const longPath = true;')).toHaveCount(0);
  await expect(page.locator('.metric-primary strong')).toHaveText('603');
  await page.keyboard.press('Enter');
  const restoredCollapse = page.getByRole('button', { name: 'Collapse preview' });
  await expect(restoredCollapse).toBeFocused();
  await expect(page.getByRole('separator', { name: 'File preview' })).toHaveAttribute('aria-valuenow', String(draggedWidth));
  await expect(page.getByText('export const longPath = true;')).toBeVisible();
  await expect(page.locator('.metric-primary strong')).toHaveText('603');

  await page.getByRole('button', { name: 'Collapse preview' }).click();
  const expand = page.getByRole('button', { name: 'Expand preview' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(expand).toBeFocused();
  await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible();
  await expect(page.locator('.metric-primary strong')).toHaveText('603');
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-preview-collapsed.png') });

  await page.setViewportSize({ width: 720, height: 520 });
  await expect(page.locator('.export-bar')).toBeInViewport();
  const assertNativeCollapsedPreviewIsReachable = async () => {
    const panel = page.locator('.preview-panel');
    const restore = page.getByRole('button', { name: 'Expand preview' });
    await expect(restore).toBeInViewport();
    const [workbenchBounds, panelBounds, restoreBounds] = await Promise.all([
      page.locator('.workbench').boundingBox(), panel.boundingBox(), restore.boundingBox(),
    ]);
    expect(workbenchBounds).not.toBeNull();
    expect(panelBounds).not.toBeNull();
    expect(restoreBounds).not.toBeNull();
    expect(panelBounds!.width).toBeGreaterThanOrEqual(44);
    expect(restoreBounds!.width).toBeGreaterThanOrEqual(24);
    expect(restoreBounds!.x).toBeGreaterThanOrEqual(panelBounds!.x);
    expect(restoreBounds!.x + restoreBounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width + 1);
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(workbenchBounds!.x + workbenchBounds!.width + 1);
    await restore.click();
    await expect(page.getByRole('separator', { name: 'File preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Collapse preview' }).click();
    await expect(restore).toBeFocused();
  };

  await assertNativeCollapsedPreviewIsReachable();
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await assertNativeCollapsedPreviewIsReachable();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-preview-sidebar-collapsed-720x520.png') });
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand preview' })).toBeVisible();
  await expect(page.getByRole('separator', { name: 'File preview' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-preview-collapsed-720x520.png') });

  await page.getByRole('button', { name: 'Expand preview' }).focus();
  await page.keyboard.press('Enter');
  const collapse = page.getByRole('button', { name: 'Collapse preview' });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(collapse).toBeFocused();
  await expect(collapse).toBeInViewport();
  await expect(page.getByText('export const longPath = true;')).toBeVisible();
  expect(await page.locator('.preview-panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
  await expect(page.locator('.metric-primary strong')).toHaveText('603');
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-10-design-review-preview-open-720x520.png') });
});

test('native watcher reconciles a deleted source before allowing copy again', async ({ native }) => {
  const page = native.page;
  await page.getByRole('textbox', { name: 'Search files' }).fill('main.rs');
  await expect(page.getByRole('button', { name: 'Preview src/main.rs' })).toBeVisible();
  await unlink(path.join(native.root, 'src', 'main.rs'));
  await expect(page.getByText('Files changed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Copy context' })).toBeDisabled();
  await expect(page.locator('.live-region')).not.toContainText('Copied');
  await expect(page.getByRole('button', { name: 'Preview src/main.rs' })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
  await expect(page.locator('.metric-primary strong')).toHaveText('601');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m4-1-deleted-source-reconciled.png') });
});
