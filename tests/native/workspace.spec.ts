import { test, expect } from './native.fixture';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  await page.getByRole('button', { name: 'More actions for dist/deep/generated.ts' }).click();
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
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-4-native-filters.png') });
  await page.setViewportSize({ width: 720, height: 520 });
  await expect(filters).toBeVisible();
  await expect(page.locator('.export-bar')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-4-native-filters-720x520.png') });
  const apply = filters.getByRole('button', { name: 'Apply filters' });
  await apply.scrollIntoViewIfNeeded();
  await expect(apply).toBeInViewport();
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-4-native-filters-720x520-scrolled.png') });

  const settings = await native.readSettings();
  expect(settings.version).toBe(2);
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
  await screenshot('2026-10-09-m35-3-native-sidebar-all-open.png');

  await views.getByRole('button', { name: 'Selected' }).click();
  await expect(selectedCount).toHaveText('602');
  await page.getByRole('button', { name: 'Expand src', exact: true }).click();
  await screenshot('2026-10-09-m35-3-native-sidebar-selected.png');
  const search = page.getByRole('textbox', { name: 'Search files' });
  await search.fill('main.rs');
  await expect(page.getByRole('button', { name: 'Preview src/main.rs' })).toBeVisible();
  await search.clear();

  await views.getByRole('button', { name: 'Ignored' }).click();
  await expect(page.getByRole('button', { name: 'Browse ignored files' })).toBeVisible();
  await expect(views).toContainText('1 folders not browsed');
  await expect(selectedCount).toHaveText('602');
  await screenshot('2026-10-09-m35-3-native-sidebar-ignored-open.png');

  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  await collapse.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeFocused();
  await screenshot('2026-10-09-m35-3-native-sidebar-ignored-collapsed.png');

  await page.setViewportSize({ width: 720, height: 520 });
  await expect(page.locator('.export-bar')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
  await screenshot('2026-10-09-m35-3-native-sidebar-minimum-collapsed.png');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  await screenshot('2026-10-09-m35-3-native-sidebar-minimum-open.png');
  await expect(selectedCount).toHaveText('602');
});

test('native preview collapses accessibly and restores long-path content without changing selection', async ({ native }) => {
  const { page } = native;
  const segmentA = `deep-${'a'.repeat(42)}`;
  const segmentB = `nested-${'b'.repeat(42)}`;
  const relativePath = `src/${segmentA}/${segmentB}/long-preview.ts`;
  const absolutePath = path.join(native.root, 'src', segmentA, segmentB, 'long-preview.ts');
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, 'export const longPath = true;\n', 'utf8');
  await page.getByRole('button', { name: 'Refresh' }).click();

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
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-5-native-preview-collapsed.png') });

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
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-5-native-preview-collapsed-720x520-sidebar-collapsed.png') });
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand preview' })).toBeVisible();
  await expect(page.getByRole('separator', { name: 'File preview' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-5-native-preview-collapsed-720x520.png') });

  await page.getByRole('button', { name: 'Expand preview' }).focus();
  await page.keyboard.press('Enter');
  const collapse = page.getByRole('button', { name: 'Collapse preview' });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(collapse).toBeFocused();
  await expect(collapse).toBeInViewport();
  await expect(page.getByText('export const longPath = true;')).toBeVisible();
  expect(await page.locator('.preview-panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
  await expect(page.locator('.metric-primary strong')).toHaveText('603');
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-5-native-preview-720x520.png') });
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
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../../docs/testing/2026-10-09-m35-6-native-copy-error.png') });
});
