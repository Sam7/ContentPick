import { test, expect } from './native.fixture';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('capture Microsoft Store screenshots from the installed app and checked-out repository', async ({ native }) => {
  test.skip(!process.env.CONTEXTPICK_NATIVE_STORE_LISTING_ROOT, 'Store listing captures require the explicit real-repository fixture.');
  const { page } = native;
  const assetDirectory = path.join(tmpdir(), 'contextpick-store-listing-assets');
  await mkdir(assetDirectory, { recursive: true });
  await native.resizeWindow(1536, 1024);
  await expect(page.locator('.panel-heading p').first()).toContainText('items discovered');
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Expand src', exact: true }).click();
  await page.getByRole('button', { name: 'Preview src/App.tsx' }).click();
  await expect(page.getByText('export function App')).toBeVisible();
  await page.screenshot({ path: path.join(assetDirectory, '01-workspace-and-preview.png') });

  await page.getByRole('button', { name: 'Selected', exact: true }).click();
  await expect(page.locator('.metric-primary strong')).not.toHaveText('0');
  await page.screenshot({ path: path.join(assetDirectory, '02-selected-files.png') });

  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Filter settings' })).toBeVisible();
  await page.getByRole('radio', { name: 'Selected extensions' }).check();
  await page.getByRole('checkbox', { name: '.tsx', exact: true }).check();
  await page.getByRole('checkbox', { name: '.ts', exact: true }).check();
  await page.getByRole('checkbox', { name: '.rs', exact: true }).check();
  await expect(page.locator('.filter-update-status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy context' })).toBeEnabled();
  await page.screenshot({ path: path.join(assetDirectory, '03-extension-filters.png') });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy context' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
  await page.screenshot({ path: path.join(assetDirectory, '04-export-settings.png') });
});
