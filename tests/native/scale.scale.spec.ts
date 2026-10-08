import { platform, release } from 'node:os';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './native.fixture';

test.use({ nativeScale: true });

test('native WebView2 scales to 20k source files, prunes 100k ignored files, and reconciles refresh cancellation', async ({ native }, testInfo) => {
  test.setTimeout(900_000);
  const tailPath = 'src/source-19999.ts';
  const page = native.page;
  const search = page.getByRole('textbox', { name: 'Search files' });
  const summary = page.locator('.panel-heading p').first();
  const timingsMs = [native.startupMs];

  await expect(summary).toHaveText('20004 items discovered', { timeout: 120_000 });
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
  await expect(page.getByRole('button', { name: 'Copy context' })).toBeEnabled();
  await expect(page.locator('.workspace-path')).toHaveCount(1);
  await expect(page.locator('.workspace-path')).toContainText(path.basename(native.root));
  await expect(summary).toHaveText('20004 items discovered', { timeout: 120_000 });
  await expect(page.getByRole('status')).toContainText('Cancellation requested.');
  await expect(summary).toHaveText('20004 items discovered');
  await search.fill('zz-refresh-cancel-marker.ts');
  await expect(page.getByRole('button', { name: 'Preview zz-refresh-cancel-marker.ts' })).toHaveCount(0);
  await search.clear();
  await unlink(cancellationMarker);
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
    suite: 'M3.1 Windows WebView2 scale evidence',
    generatedAt: new Date().toISOString(),
    host: { platform: platform(), release: release(), architecture: process.arch },
    fixture: { sourceFiles: 20_000, ignoredFiles: 100_000, discoveredEntries: 20_004, ignoredDirectory: 'ignored-scale' },
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
