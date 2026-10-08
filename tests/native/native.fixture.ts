import { test as base, expect } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';

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
};

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

async function stopTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
  } catch {
    // The process may have exited between checking exitCode and taskkill.
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
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

type NativeFixtures = { native: NativeSession };

export const test = base.extend<NativeFixtures>({
  native: async ({ playwright }, runTest, testInfo) => {
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
    let cleanupViolation: string | undefined;

    const stop = async () => {
      await browser?.close().catch(() => undefined);
      browser = undefined;
      page = undefined;
      if (child) await stopTree(child);
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
        await makeSyntheticWorkspace(root);
        const preferences = { version: 1, recentRoot: root, workspaces: {} };
        await writeFile(path.join(config, 'settings.json'), JSON.stringify(preferences), 'utf8');
        await launch();
      }
      await runTest({ root, get page() { if (!page) throw new Error('Native page is not running.'); return page; }, get startupMs() { return startupMs; }, launch, stop });
    } finally {
      await stop();
      const resolved = await realpath(ownedDir).catch(() => '');
      const withinTemp = resolved.startsWith(`${tempRoot}${path.sep}`);
      const ownedPrefix = path.basename(resolved).startsWith('contextpick-native-playwright-');
      if (withinTemp && ownedPrefix && resolved === canonicalOwnedDir) {
        await rm(canonicalOwnedDir, { recursive: true, force: true });
      } else {
        cleanupViolation = `Refusing to remove unexpected native test directory: ${resolved}`;
      }
    }
    if (cleanupViolation) throw new Error(cleanupViolation);
  },
});

export { expect };
