import { expect, test } from '@playwright/test';

test('browser fixture supports opening a workspace, preview and export', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Browser fixture mode')).toBeVisible();
  await page.getByRole('button', { name: 'Open folder' }).click();
  await expect(page.getByText('/workspace/patchwork')).toBeVisible();
  await page.getByRole('button', { name: 'Browse ignored files' }).click();
  await expect(page.getByText('report.md')).toBeVisible();
  await page.getByRole('button', { name: 'Preview README.md' }).click();
  await expect(page.getByText('# Patchwork')).toBeVisible();
  await page.getByRole('button', { name: 'Export Markdown' }).click();
  await expect(page.getByRole('status')).toContainText('Export ready');
});

test('search narrows the visible tree without changing the selection count', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  await page.getByRole('textbox', { name: 'Search files' }).fill('README');
  await expect(page.getByRole('button', { name: 'Preview README.md' })).toBeVisible();
  await expect(page.getByText('3', { exact: true }).first()).toBeVisible();
});

test('keeps export controls visible at a compact desktop size', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  const exportButton = page.getByRole('button', { name: 'Export Markdown' });
  await expect(exportButton).toBeInViewport();
  const footer = await page.locator('.export-bar').boundingBox();
  expect(footer).not.toBeNull();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(800);
  await page.screenshot({ path: 'test-results/contextpick-1200x800.png' });

  await page.setViewportSize({ width: 720, height: 520 });
  await expect(exportButton).toBeInViewport();
  const compactFooter = await page.locator('.export-bar').boundingBox();
  expect(compactFooter).not.toBeNull();
  expect(compactFooter!.y + compactFooter!.height).toBeLessThanOrEqual(520);
  await page.screenshot({ path: 'test-results/contextpick-720x520.png' });
});
