import { test as base, expect } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { processTreeForRoot, type ProcessSnapshotEntry } from './process-tree';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const builtNativeExe = path.join(repoRoot, 'target', 'debug', 'contextpick.exe');
const tempRoot = await realpath(tmpdir());

type NativeSession = {
  root: string;
  page: Page;
  startupMs: number;
  launch: () => Promise<Page>;
  stop: () => Promise<void>;
  memoryReport: () => Promise<{ method: string; intervalMs: number; samples: number; peakWorkingSetBytes: number; peakProcessCount: number }>;
};

const processTreeMemoryMethod = 'Windows CIM snapshots scheduled once per second; descendants require a matching parent PID and non-earlier creation time, and the launched root PID, path and creation time are pinned. WorkingSetSize is summed for that tree; overlapping queries are skipped. Cleanup validates each PID, creation time and executable path through an opened process handle before termination.';
type ObservedProcess = { processId: number; creationTicks: string; executablePath: string };

function createProcessTreeSampler() {
  const state = { samples: 0, peakWorkingSetBytes: 0, peakProcessCount: 0 };
  const observedProcesses = new Map<number, ObservedProcess>();
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> | undefined;
  let rootPid: number | undefined;
  let rootCreationTicks: string | undefined;
  let executablePath: string | undefined;
  const sample = async (pid: number, expectedExecutablePath: string) => {
    if (pending) return pending;
    pending = (async () => {
      const script = `$items=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,CreationDate,ExecutablePath; $processes=@($items | ForEach-Object { [pscustomobject]@{processId=[int]$_.ProcessId; parentProcessId=[int]$_.ParentProcessId; workingSetBytes=[long]$_.WorkingSetSize; creationTicks=[string]$_.CreationDate.ToUniversalTime().Ticks; executablePath=[string]$_.ExecutablePath} }); [pscustomobject]@{processes=$processes} | ConvertTo-Json -Compress -Depth 4`;
      try {
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8_000, maxBuffer: 1_000_000 });
        const result = JSON.parse(stdout.trim()) as { processes?: ProcessSnapshotEntry | ProcessSnapshotEntry[] };
        if (result.processes !== undefined) {
          const snapshot = Array.isArray(result.processes) ? result.processes : [result.processes];
          const tree = processTreeForRoot(snapshot, pid, expectedExecutablePath, rootCreationTicks);
          if (tree.length === 0) return;
          const root = tree.find((process) => process.processId === pid);
          if (!root) return;
          rootCreationTicks ??= root.creationTicks;
          state.samples += 1;
          const bytes = tree.reduce((sum, process) => sum + process.workingSetBytes, 0);
          state.peakWorkingSetBytes = Math.max(state.peakWorkingSetBytes, bytes);
          state.peakProcessCount = Math.max(state.peakProcessCount, tree.length);
          for (const process of tree) observedProcesses.set(process.processId, process);
        }
      } catch {
        // A process may exit between samples; successful samples remain useful.
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  return {
    start(pid: number, expectedExecutablePath: string) {
      rootPid = pid;
      rootCreationTicks = undefined;
      executablePath = expectedExecutablePath;
      timer = setInterval(() => { void sample(pid, expectedExecutablePath); }, 1_000);
      void sample(pid, expectedExecutablePath);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (rootPid !== undefined && executablePath !== undefined) await sample(rootPid, executablePath);
      await pending;
    },
    processIdentities(): ObservedProcess[] {
      return Array.from(observedProcesses.values());
    },
    async report() {
      await pending;
      return { method: processTreeMemoryMethod, intervalMs: 1_000, samples: state.samples, peakWorkingSetBytes: state.peakWorkingSetBytes, peakProcessCount: state.peakProcessCount };
    },
  };
}

async function availablePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback CDP port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForCdp(port: number, child: ChildProcess): Promise<void> {
  const spawnError = new Promise<never>((_resolve, reject) => child.once('error', reject));
  const readiness = async () => {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`ContextPick exited before WebView2 was ready (code ${child.exitCode}).`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for the app's loopback WebView2 endpoint: ${String(lastError ?? '')}`);
  };
  await Promise.race([readiness(), spawnError]);
}

async function stopTree(child: ChildProcess, observedProcesses: ObservedProcess[], expectedExecutablePath: string): Promise<void> {
  // CIM and Process.StartTime can differ by a few ticks; 1 ms covers conversion precision without matching PID reuse.
  if (child.exitCode === null && observedProcesses.length === 0) {
    throw new Error(`Refusing to terminate unverified native fixture process ${child.pid ?? 'unknown'}.`);
  }
  if (observedProcesses.length > 0) {
    const encodedProcesses = Buffer.from(JSON.stringify(observedProcesses), 'utf8').toString('base64');
    const encodedExecutablePath = Buffer.from(expectedExecutablePath, 'utf8').toString('base64');
    const rootPid = child.pid ?? 0;
    const script = String.raw`
$expected = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedProcesses}')) | ConvertFrom-Json
$expectedExe = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedExecutablePath}'))
$rootPid = ${rootPid}
function Get-VerifiedProcess($expectedProcess) {
  $process = $null
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$expectedProcess.processId)
    $null = $process.Handle # Retain the verified process handle so Kill cannot reopen a reused PID.
    $ticks = [long]$process.StartTime.ToUniversalTime().Ticks
    if ([Math]::Abs($ticks - [long]$expectedProcess.creationTicks) -gt 10000) { $process.Dispose(); return $null }
    $path = $process.MainModule.FileName
    if ([string]::IsNullOrWhiteSpace($path)) {
      if ($process.HasExited) { $process.Dispose(); return $null }
      throw "Unable to verify the executable path for live process $($expectedProcess.processId)."
    }
    if (-not $path.Equals([string]$expectedProcess.executablePath, [System.StringComparison]::OrdinalIgnoreCase)) { $process.Dispose(); return $null }
    if ([int]$expectedProcess.processId -eq $rootPid -and -not $path.Equals($expectedExe, [System.StringComparison]::OrdinalIgnoreCase)) { $process.Dispose(); return $null }
    return $process
  } catch [System.ArgumentException] {
    if ($process) { $process.Dispose() }
    return $null
  } catch {
    $hasExited = $false
    if ($process) { try { $hasExited = $process.HasExited } catch {} }
    if ($process) { $process.Dispose() }
    if ($hasExited) { return $null }
    throw
  }
}
$alive = @()
foreach ($expectedProcess in $expected) {
  $process = Get-VerifiedProcess $expectedProcess
  if ($process) { $alive += [int]$expectedProcess.processId; $process.Dispose() }
}
foreach ($processId in $alive) {
  $expectedProcess = $expected | Where-Object { [int]$_.processId -eq $processId } | Select-Object -First 1
  $process = Get-VerifiedProcess $expectedProcess
  if ($process) { try { $process.Kill() } catch {} finally { $process.Dispose() } }
}
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  $remaining = @()
  foreach ($expectedProcess in $expected) {
    $process = Get-VerifiedProcess $expectedProcess
    if ($process) { $remaining += [int]$expectedProcess.processId; $process.Dispose() }
  }
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
[pscustomobject]@{ remaining = @($remaining) } | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 1_000_000 });
    const result = JSON.parse(stdout.trim()) as { remaining?: number | number[] };
    const remaining = result.remaining === undefined ? [] : Array.isArray(result.remaining) ? result.remaining : [result.remaining];
    if (remaining.length > 0) throw new Error(`Native fixture processes did not exit: ${remaining.join(', ')}.`);
  }
  if (child.exitCode === null) {
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (child.exitCode === null) throw new Error(`ContextPick process ${child.pid ?? 'unknown'} did not exit after termination.`);
}

async function makeSyntheticWorkspace(root: string): Promise<void> {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'dist', 'deep'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '/.gitignore\n/dist/\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), '# Native fixture\n', 'utf8');
  await writeFile(path.join(root, 'src', 'main.rs'), 'fn main() { println!("fixture"); }\n', 'utf8');
  await writeFile(path.join(root, 'dist', 'deep', 'generated.ts'), 'export const ignored = true;\n', 'utf8');
  for (let index = 0; index < 600; index += 1) {
    const name = `file-${String(index).padStart(4, '0')}.ts`;
    await writeFile(path.join(root, 'src', name), `export const value${index} = ${index};\n`, 'utf8');
  }
}

async function makeScaleWorkspace(root: string): Promise<void> {
  const source = path.join(root, 'src');
  const ignored = path.join(root, 'ignored-scale');
  await Promise.all([mkdir(source, { recursive: true }), mkdir(ignored, { recursive: true })]);
  await writeFile(path.join(root, '.gitignore'), '/.gitignore\n/ignored-scale/\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), '# Native scale fixture\n', 'utf8');
  const writeBatch = async (directory: string, prefix: string, count: number, first = 0) => {
    const batchSize = 256;
    for (let start = first; start < count; start += batchSize) {
      const end = Math.min(start + batchSize, count);
      await Promise.all(Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        const name = `${prefix}-${String(index).padStart(5, '0')}.ts`;
        return writeFile(path.join(directory, name), `export const value${index} = ${index};\n`, 'utf8');
      }));
    }
  };
  await Promise.all([writeBatch(source, 'source', 20_000), writeBatch(ignored, 'ignored', 100_000)]);
}

type NativeFixtures = { native: NativeSession; nativeScale: boolean };

export const test = base.extend<NativeFixtures>({
  nativeScale: [false, { option: true }],
  native: async ({ playwright, nativeScale }, runTest, testInfo) => {
    test.skip(process.platform !== 'win32', 'The native WebView2 harness runs on Windows only.');
    const ownedDir = await mkdtemp(path.join(tempRoot, 'contextpick-native-playwright-'));
    const canonicalOwnedDir = await realpath(ownedDir);
    const config = path.join(ownedDir, 'config');
    const root = path.join(ownedDir, 'workspace');
    const webviewProfile = path.join(ownedDir, 'webview2-profile');
    const appDir = path.join(ownedDir, 'app');
    const nativeExe = path.join(appDir, 'contextpick.exe');
    let child: ChildProcess | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    let startupMs = 0;
    const memorySampler = createProcessTreeSampler();
    let cleanupViolation: string | undefined;

    const stop = async () => {
      await browser?.close().catch(() => undefined);
      browser = undefined;
      page = undefined;
      await memorySampler.stop();
      if (child) await stopTree(child, memorySampler.processIdentities(), nativeExe);
      child = undefined;
    };

    const launch = async (): Promise<Page> => {
      if (browser) await stop();
      const port = await availablePort();
      const startedAt = Date.now();
      child = spawn(nativeExe, [], {
        cwd: repoRoot,
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          CONTEXTPICK_CONFIG_DIR: config,
          WEBVIEW2_USER_DATA_FOLDER: webviewProfile,
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
        },
      });
      if (child.pid) memorySampler.start(child.pid, nativeExe);
      await waitForCdp(port, child);
      const connectedBrowser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
      browser = connectedBrowser;
      const context = connectedBrowser.contexts()[0];
      if (!context) throw new Error('The native WebView2 context did not appear.');
      await expect.poll(() => context.pages().length, { timeout: 15_000 }).toBeGreaterThan(0);
      page = context.pages()[0];
      if (!page) throw new Error('The native WebView2 page did not appear.');
      await page.locator('.workspace-path').waitFor({ state: 'visible', timeout: 30_000 });
      await expect(page.locator('.workspace-path')).toContainText(path.basename(ownedDir));
      await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible();
      await expect(page.locator('.panel-heading p').first()).toContainText('items discovered', { timeout: 60_000 });
      if (nativeScale) await expect(page.locator('.panel-heading p').first()).toHaveText('20004 items discovered', { timeout: 120_000 });
      await expect(page.getByRole('button', { name: 'Copy context' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Cancel operation' })).toHaveCount(0);
      startupMs = Date.now() - startedAt;
      await page.screenshot({ path: testInfo.outputPath(`native-${Date.now()}.png`) });
      return page;
    };

    try {
      if (process.platform === 'win32') {
        await Promise.all([mkdir(config), mkdir(root), mkdir(webviewProfile), mkdir(appDir)]);
        await access(builtNativeExe);
        await copyFile(builtNativeExe, nativeExe);
        if (nativeScale) await makeScaleWorkspace(root);
        else await makeSyntheticWorkspace(root);
        const preferences = { version: 1, recentRoot: root, workspaces: {} };
        await writeFile(path.join(config, 'settings.json'), JSON.stringify(preferences), 'utf8');
        await launch();
      }
      await runTest({ root, get page() { if (!page) throw new Error('Native page is not running.'); return page; }, get startupMs() { return startupMs; }, launch, stop, memoryReport: memorySampler.report });
    } finally {
      let stopFailure: string | undefined;
      try {
        await stop();
      } catch (error) {
        stopFailure = error instanceof Error ? error.message : String(error);
      }
      const resolved = await realpath(ownedDir).catch(() => '');
      const withinTemp = resolved.startsWith(`${tempRoot}${path.sep}`);
      const ownedPrefix = path.basename(resolved).startsWith('contextpick-native-playwright-');
      if (!stopFailure && withinTemp && ownedPrefix && resolved === canonicalOwnedDir) {
        await rm(canonicalOwnedDir, { recursive: true, force: true });
      } else {
        cleanupViolation = stopFailure
          ? `Refusing to remove the native test directory because process cleanup failed: ${stopFailure}`
          : `Refusing to remove unexpected native test directory: ${resolved}`;
      }
    }
    if (cleanupViolation) throw new Error(cleanupViolation);
  },
});

export { expect };
