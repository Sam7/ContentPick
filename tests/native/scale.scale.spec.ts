import { platform, release } from 'node:os';
import { rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './native.fixture';

test.use({ nativeScale: true });

test('native WebView2 scales to 20k source files, prunes 100k ignored files, and reconciles refresh cancellation', async ({ native }, testInfo) => {
  test.setTimeout(900_000);
  const tailPath = 'src/source-19999.ts';
  const page = native.page;
  const search = page.getByRole('textbox', { name: 'Search files' });
  const summary = page.locator('.panel-heading p').first();
  const tokenMetric = page.locator('.token-metric strong');
  const timingsMs = [native.startupMs];

  await expect(summary).toHaveText('20004 items discovered', { timeout: 120_000 });
  const tokenStatusAtNativeReady = await tokenMetric.textContent();
  expect(tokenStatusAtNativeReady, 'the 20k-file estimate must still be running when native readiness is reported').toBe('Calculating…');
  const tokenWaitStartedAt = Date.now();
  const countBeforeProjection = await page.locator('.metric-primary strong').textContent();
  const tree = page.getByRole('tree', { name: 'Workspace files' });
  const views = page.getByRole('navigation', { name: 'Workspace views' });
  const responsiveActionStartedAt = Date.now();
  await views.getByRole('button', { name: 'Selected' }).click();
  await expect(tree.getByText('src', { exact: true })).toBeVisible();
  expect(await tokenMetric.textContent(), 'the count should remain active while the Selected view responds').toBe('Calculating…');
  const responsiveActionMs = Date.now() - responsiveActionStartedAt;
  expect(responsiveActionMs).toBeLessThan(5_000);
  await expect(page.locator('.metric-primary strong')).toHaveText(countBeforeProjection ?? '');
  await views.getByRole('button', { name: 'Ignored' }).click();
  await expect(tree.getByRole('button', { name: 'Browse ignored files' })).toBeVisible();
  await expect(views).toContainText('1 folders not browsed');
  await expect(page.locator('.metric-primary strong')).toHaveText(countBeforeProjection ?? '');
  await views.getByRole('button', { name: 'All' }).click();

  await expect(page.getByRole('button', { name: `Preview ${tailPath}` })).toHaveCount(0);
  await search.fill('source-19999.ts');
  const tail = page.getByRole('button', { name: `Preview ${tailPath}` });
  await expect(tail).toBeVisible();
  await tail.click();
  await expect(page.getByText('export const value19999 = 19999;')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('native-scale-tail-preview.png'), fullPage: true });
  await search.fill('ignored-99999.ts');
  await expect(page.getByRole('button', { name: 'Preview ignored-scale/ignored-99999.ts' })).toHaveCount(0);
  await expect(summary).toHaveText('20004 items discovered');
  await page.screenshot({ path: testInfo.outputPath('native-scale-ignored-pruned.png'), fullPage: true });

  await expect(tokenMetric).toHaveText(/^≈ [\d,]+$/, { timeout: 120_000 });
  const tokenReadyWaitAfterNativeMs = Date.now() - tokenWaitStartedAt;
  const tokenGeneration = Number(await page.locator('.workbench').getAttribute('data-workspace-generation'));
  const tokenCacheProbe = await page.evaluate(async ({ generation, requestId }) => {
    const internals = (window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<{
        files: number; reusedFiles: number; computedFiles: number; tokenizerId: string;
      }> };
    }).__TAURI_INTERNALS__;
    if (!internals) throw new Error('Native Tauri command bridge is unavailable.');
    return internals.invoke('estimate_tokens', { generation, requestId });
  }, { generation: tokenGeneration, requestId: `${Date.now() + 60_000}:1` });
  expect(tokenCacheProbe.files).toBeGreaterThanOrEqual(20_000);
  expect(tokenCacheProbe.reusedFiles).toBe(tokenCacheProbe.files);
  expect(tokenCacheProbe.computedFiles).toBe(0);
  expect(tokenCacheProbe.tokenizerId).toBe('o200k_base');

  const churnDirectory = path.join(native.root, 'ignored-scale');
  const churnFiles = Array.from({ length: 64 }, (_, index) => path.join(churnDirectory, `watcher-churn-${index}.ts`));
  const churnGeneration = Number(await page.locator('.workbench').getAttribute('data-workspace-generation'));
  const watcherChurnStartedAt = Date.now();
  await Promise.all(churnFiles.map((file, index) => writeFile(file, `export const churn${index} = ${index};\n`, 'utf8')));
  await Promise.all(churnFiles.map((file, index) => writeFile(file, `export const churn${index} = ${index + 1};\n`, 'utf8')));
  const renamedChurnFile = path.join(churnDirectory, 'watcher-churn-renamed.ts');
  await rename(churnFiles[0], renamedChurnFile);
  await Promise.all(churnFiles.slice(1).map((file) => unlink(file)));
  await unlink(renamedChurnFile);
  await writeFile(path.join(native.root, '.gitignore'), '/.gitignore\n/ignored-scale/\n/never-used/\n', 'utf8');
  await expect.poll(async () => Number(await page.locator('.workbench').getAttribute('data-workspace-generation')), { timeout: 120_000 }).toBeGreaterThan(churnGeneration);
  await expect(page.getByText('Watching', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(summary).toHaveText('20004 items discovered');
  await expect(tokenMetric).toHaveText(/^≈ [\d,]+$/, { timeout: 120_000 });
  const watcherChurnElapsedMs = Date.now() - watcherChurnStartedAt;
  const churnGenerationAfter = Number(await page.locator('.workbench').getAttribute('data-workspace-generation'));
  const churnCacheProbe = await page.evaluate(async ({ generation, requestId }) => {
    const internals = (window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<{
        files: number; reusedFiles: number; computedFiles: number; tokenizerId: string;
      }> };
    }).__TAURI_INTERNALS__;
    if (!internals) throw new Error('Native Tauri command bridge is unavailable.');
    return internals.invoke('estimate_tokens', { generation, requestId });
  }, { generation: churnGenerationAfter, requestId: `${Date.now() + 60_000}:2` });
  expect(churnCacheProbe.files).toBe(tokenCacheProbe.files);
  expect(churnCacheProbe.reusedFiles).toBe(churnCacheProbe.files);
  expect(churnCacheProbe.computedFiles).toBe(0);
  expect(churnCacheProbe.tokenizerId).toBe('o200k_base');

  await search.clear();
  const selectedCount = page.locator('.metric-primary strong');
  const selectedBeforeKeyboard = await selectedCount.textContent();
  await page.getByRole('button', { name: 'Expand src' }).click();
  await search.fill('source-');
  const firstFile = page.getByRole('button', { name: 'Preview src/source-00000.ts' });
  await expect(firstFile).toBeVisible();
  await firstFile.focus();
  const focusedTreeItem = page.locator('[role="treeitem"]:focus .entry-name');
  await page.keyboard.press('End');
  await expect(focusedTreeItem).toHaveText('source-19999.ts');
  await page.keyboard.press('Home');
  await expect(focusedTreeItem).toHaveText('src');
  await expect(selectedCount).toHaveText(selectedBeforeKeyboard ?? '');
  await page.screenshot({ path: testInfo.outputPath('native-scale-keyboard-focus.png'), fullPage: true });
  await page.keyboard.press('Shift+F10');
  const treeActions = page.getByRole('group', { name: 'src selection actions' });
  await expect(treeActions.getByRole('button', { name: 'Force include' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'More actions for src', exact: true })).toBeFocused();
  await expect(selectedCount).toHaveText(selectedBeforeKeyboard ?? '');
  const firstFilePath = 'src/source-00000.ts';
  const firstFileRow = firstFile.locator('xpath=ancestor::*[@role="treeitem"]');
  const firstFileActions = page.getByRole('group', { name: `${firstFilePath} selection actions` });
  const firstFileActionTrigger = page.getByRole('button', { name: `More actions for ${firstFilePath}`, exact: true });
  await firstFileRow.focus();
  await page.keyboard.press('Shift+F10');
  await expect(firstFileActions.getByRole('button', { name: 'Force include' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(firstFileActions).toHaveCount(0);
  await expect(firstFileActionTrigger).toBeFocused();
  await expect(firstFileRow.locator('.override-pill')).toHaveText('Override');
  await expect(selectedCount).toHaveText(selectedBeforeKeyboard ?? '');

  await search.clear();
  const cancellationMarker = path.join(native.root, 'zz-refresh-cancel-marker.ts');
  await writeFile(cancellationMarker, 'export const cancellationMarker = true;\n', 'utf8');
  await page.getByRole('button', { name: 'Refresh' }).click();
  const cancel = page.getByRole('button', { name: 'Cancel operation' });
  await expect(cancel).toBeVisible({ timeout: 30_000 });
  await cancel.click();
  await expect(cancel).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Copy context' })).toBeDisabled();
  await expect(tokenMetric).toHaveText('Stale');
  await expect(page.locator('.workspace-path')).toHaveCount(1);
  await expect(page.locator('.workspace-path')).toContainText(path.basename(native.root));
  await expect(page.getByRole('status')).toContainText('Cancellation requested.');
  await unlink(cancellationMarker);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Watching', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Copy context' })).toBeEnabled();
  await expect(summary).toHaveText('20004 items discovered', { timeout: 120_000 });
  await search.fill('zz-refresh-cancel-marker.ts');
  await expect(page.getByRole('button', { name: 'Preview zz-refresh-cancel-marker.ts' })).toHaveCount(0);
  await search.clear();
  await search.fill('source-19999.ts');
  await expect(page.getByRole('button', { name: `Preview ${tailPath}` })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('native-scale-after-cancel.png'), fullPage: true });

  for (let index = 1; index < 3; index += 1) {
    const relaunched = await native.launch();
    timingsMs.push(native.startupMs);
    await expect(relaunched.locator('.panel-heading p').first()).toHaveText('20004 items discovered', { timeout: 120_000 });
    await relaunched.screenshot({ path: testInfo.outputPath(`native-scale-launch-${index + 1}.png`), fullPage: true });
  }

  const memory = await native.memoryReport();
  expect(memory.samples, 'The process-tree sampler must collect successful Windows snapshots').toBeGreaterThan(0);
  expect(memory.peakProcessCount, 'The sample must include the WebView2 descendants').toBeGreaterThan(1);
  expect(memory.peakWorkingSetBytes).toBeGreaterThan(0);
  const report = {
    suite: 'Windows WebView2 native scale evidence',
    generatedAt: new Date().toISOString(),
    host: { platform: platform(), release: release(), architecture: process.arch },
    fixture: { sourceFiles: 20_000, ignoredFiles: 100_000, discoveredEntries: 20_004, ignoredDirectory: 'ignored-scale' },
    tokenEstimate: {
      model: tokenCacheProbe.tokenizerId,
      selectedFiles: tokenCacheProbe.files,
      computedFilesOnWarmProbe: tokenCacheProbe.computedFiles,
      reusedFilesOnWarmProbe: tokenCacheProbe.reusedFiles,
      waitAfterNativeReadyMs: tokenReadyWaitAfterNativeMs,
      responsiveActionMs,
      statusDuringNativeReadinessAction: tokenStatusAtNativeReady,
      statusAtNativeReady: tokenStatusAtNativeReady,
      limitations: 'The wait is measured from Playwright attaching after native workspace readiness, not from the first token read. The direct probe runs after the UI estimate and measures warm-cache reuse.'
    },
    watcherChurn: {
      createdAndModifiedInIgnored100kTree: churnFiles.length,
      renamedAndDeleted: true,
      updatedGitignore: true,
      elapsedMs: watcherChurnElapsedMs,
      workspaceGenerationBefore: churnGeneration,
      workspaceGenerationAfter: churnGenerationAfter,
      selectedFiles: churnCacheProbe.files,
      computedFilesAfterChurn: churnCacheProbe.computedFiles,
      reusedFilesAfterChurn: churnCacheProbe.reusedFiles,
    },
    launchToReadyMs: timingsMs,
    processTreeMemory: { ...memory, peakWorkingSetMiB: Number((memory.peakWorkingSetBytes / 1024 / 1024).toFixed(1)) },
    limitations: [
      'Launch-to-ready ends after the actual WebView2 UI has loaded all available IPC pages and the workspace controls are ready; values are local debug-build observations.',
      'Working set sampling uses Windows CIM once per second; child links require a matching parent PID and non-earlier creation time, the launched root PID/path/creation time stay pinned, and the Tauri process plus those descendants are summed. Overlapping queries are skipped and brief peaks between successful samples can be missed.',
      'The three startup timings are one first launch and two repeated launches using the same workspace, OS cache and WebView2 profile; they are not cold-start comparisons.',
      'The fixture uses synthetic small text files on this host; results do not represent arbitrary project content or other Windows machines.',
      'The report is written only after the test reaches completion; a failed or interrupted run may not produce it.',
    ],
  };
  const reportPath = testInfo.outputPath('native-scale-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(testInfo.outputPath('native-scale-report.txt'), [
    report.suite,
    `Host: Windows ${report.host.release} / ${report.host.architecture}`,
    `Launch-to-ready (first, repeated 2/3; ms): ${timingsMs.join(', ')}`,
    `Process-tree working set peak: ${report.processTreeMemory.peakWorkingSetMiB} MiB (${memory.peakProcessCount} processes; ${memory.samples} successful samples)`,
    `Sampling: ${memory.method}`,
    `Limitations: ${report.limitations.join(' ')}`,
  ].join('\n') + '\n', 'utf8');
  console.log(`Native scale launch-to-ready timings: ${timingsMs.join(', ')} ms; process-tree peak ${report.processTreeMemory.peakWorkingSetMiB} MiB from ${memory.samples} samples.`);
});
