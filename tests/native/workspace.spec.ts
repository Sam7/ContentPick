import { test, expect } from './native.fixture';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

test('native restore, paging, ignore policy, manual override, copy, and restart use the real workspace', async ({ native }, testInfo) => {
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
  const gitignore = page.getByRole('checkbox', { name: 'Respect .gitignore' });
  await gitignore.uncheck();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(selected).toHaveText('603');
  await page.getByRole('button', { name: 'Filters' }).click();
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
  await page.getByRole('button', { name: 'More actions for dist/deep/generated.ts' }).click();
  await page.getByRole('button', { name: 'Force include' }).click();
  await expect(page.getByText('Override')).toBeVisible();
  await expect(selected).toHaveText('602');
  await page.getByRole('button', { name: 'More actions for dist/deep/generated.ts' }).click();
  await page.getByRole('button', { name: 'Reset override' }).click();
  await expect(selected).toHaveText('601');

  await page.getByRole('button', { name: 'Copy context' }).click();
  await expect(page.getByRole('status')).toContainText(/Copied.*601 files/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('native-copy.png') });

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

test('native copy reports a deleted selected source and never reports success', async ({ native }) => {
  const page = native.page;
  await page.getByRole('textbox', { name: 'Search files' }).fill('main.rs');
  await expect(page.getByRole('button', { name: 'Preview src/main.rs' })).toBeVisible();
  await unlink(path.join(native.root, 'src', 'main.rs'));
  await page.getByRole('button', { name: 'Copy context' }).click();
  await expect(page.getByRole('alert')).toContainText('main.rs');
  await expect(page.locator('.live-region')).not.toContainText('Copied');
  await expect(page.getByRole('alert')).toBeVisible();
});
