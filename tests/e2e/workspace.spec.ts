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
  const status = page.getByRole('status');
  await expect(status).toContainText('Export ready');
  await expect(status).toBeVisible();
  await expect.poll(async () => (await status.boundingBox())?.height ?? 0).toBeGreaterThan(20);
});

test('search narrows the visible tree without changing the selection count', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  await page.getByRole('textbox', { name: 'Search files' }).fill('README');
  await expect(page.getByRole('button', { name: 'Preview README.md' })).toBeVisible();
  await expect(page.getByText('3', { exact: true }).first()).toBeVisible();
});

test('search reveals nested paths and clearing it restores collapsed ancestors', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  const search = page.getByRole('textbox', { name: 'Search files' });
  const selectedCount = page.locator('.metric-primary strong');
  await expect(selectedCount).toHaveText('3');
  await expect(page.getByRole('button', { name: 'Preview src/components/Picker.tsx' })).toHaveCount(0);

  await search.fill('Picker');
  await expect(page.getByRole('button', { name: 'Preview src/components/Picker.tsx' })).toBeVisible();
  await expect(page.getByRole('treeitem').filter({ has: page.getByText('src', { exact: true }) }).first()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('treeitem').filter({ has: page.getByText('components', { exact: true }) }).first()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Collapse src', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Collapse src/components' })).toBeDisabled();
  await expect(selectedCount).toHaveText('3');

  await search.clear();
  await expect(page.getByRole('button', { name: 'Preview src/components/Picker.tsx' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand src', exact: true })).toBeVisible();
  await expect(selectedCount).toHaveText('3');
});

test('file tree supports arrow-key navigation and keeps the active virtual row in view', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  const tree = page.getByRole('tree', { name: 'Workspace files' });
  const selectedCount = page.locator('.metric-primary strong');
  await expect(tree).toHaveAttribute('aria-multiselectable', 'true');
  const source = tree.getByRole('treeitem').filter({ has: page.getByText('src', { exact: true }) }).first();

  await expect(source).toHaveAttribute('tabindex', '0');
  await expect(source).toHaveAttribute('aria-checked', 'true');
  await expect(source).toHaveAttribute('aria-posinset', '1');
  await expect(source).toHaveAttribute('aria-setsize', '4');
  await source.focus();
  await page.keyboard.press('ArrowRight');
  await expect(source).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  const activeItem = tree.locator('[role="treeitem"]:focus');
  await expect(activeItem.locator('.entry-name')).toHaveText('main.ts');
  await expect(activeItem).toHaveAttribute('aria-level', '2');
  await expect(activeItem).toHaveAttribute('aria-posinset', '1');
  await expect(activeItem).toHaveAttribute('aria-setsize', '3');
  await expect(selectedCount).toHaveText('3');
  await page.keyboard.press('ArrowLeft');
  await expect(activeItem.locator('.entry-name')).toHaveText('src');
  await page.keyboard.press('ArrowLeft');
  await expect(source).toHaveAttribute('aria-expanded', 'false');

  const ignored = tree.getByRole('treeitem').filter({ has: page.getByText('dist', { exact: true }) }).first();
  await expect(ignored).toHaveAttribute('aria-checked', 'false');
  await ignored.focus();
  await page.keyboard.press('ArrowRight');
  await expect(ignored).toHaveAttribute('aria-expanded', 'true');
  await expect(tree.getByText('report.md')).toBeVisible();
  await expect(selectedCount).toHaveText('3');

  const readme = tree.getByRole('treeitem').filter({ has: page.getByText('README.md', { exact: true }) }).first();
  await readme.focus();
  await page.keyboard.press('Space');
  await expect(readme).toHaveAttribute('aria-checked', 'false');
  await expect(selectedCount).toHaveText('2');
});

test('selection action popover stays above virtual rows and all actions reach the target at compact size', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 520 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  await page.getByRole('button', { name: 'Expand src', exact: true }).click();

  const openMenu = async () => {
    await page.getByRole('button', { name: 'More actions for src/main.generated.ts' }).click();
    return page.getByRole('group', { name: 'src/main.generated.ts selection actions' });
  };
  await (await openMenu()).getByRole('button', { name: 'Force include' }).click();
  await expect(page.getByText('Override')).toBeVisible();
  await expect(page.locator('.metric-primary strong')).toHaveText('4');

  await (await openMenu()).getByRole('button', { name: 'Force exclude' }).click();
  await expect(page.locator('.metric-primary strong')).toHaveText('3');
  await (await openMenu()).getByRole('button', { name: 'Reset override' }).click();
  await expect(page.locator('.metric-primary strong')).toHaveText('3');
});

test('selection action popover preserves keyboard focus after Escape and selection', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  await page.getByRole('button', { name: 'Expand src', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'More actions for src/main.generated.ts' });
  const menu = page.getByRole('group', { name: 'src/main.generated.ts selection actions' });
  const row = trigger.locator('xpath=ancestor::*[@role="treeitem"]');

  await expect(row.locator('button:not([tabindex="-1"]), input:not([tabindex="-1"])')).toHaveCount(0);
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('button', { name: 'Force include' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('button', { name: 'Force exclude' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await row.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('button', { name: 'Force include' })).toBeFocused();
  const search = page.getByRole('textbox', { name: 'Search files' });
  await search.click();
  await expect(menu).toHaveCount(0);
  await expect(search).toBeFocused();

  await row.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('button', { name: 'Force include' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(row.locator('.override-pill')).toHaveText('Override');
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

test('keeps pending-operation status and cancellation error above the footer at desktop and narrow sizes', async ({ page }) => {
  await page.addInitScript(() => {
    const workspace = {
      root: 'C:/workspace/project', generation: 1,
      entries: [{ path: 'main.ts', kind: 'file', size: 12, selected: true, forceIncluded: false, reason: null, enumerated: true, partial: false }],
      entryCount: 1, nextOffset: null,
      selectedCount: 1, estimatedBytes: 12,
      policy: { gitignore: true, includeExtensions: [], excludeExtensions: [], includePaths: [], excludePaths: [] },
      incomplete: false, diagnostics: [],
    };
    const longCancelError = `Cannot cancel C:/synthetic/${'unbroken-path-segment'.repeat(32)}`;
    const testWindow = window as typeof window & {
      isTauri: boolean;
      __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> };
    };
    testWindow.isTauri = true;
    testWindow.__TAURI_INTERNALS__ = {
      invoke: (command) => {
        if (command === 'restore_workspace') return Promise.resolve(null);
        if (command === 'choose_workspace') return Promise.resolve(workspace);
        if (command === 'export_markdown') return new Promise(() => undefined);
        if (command === 'cancel_operation') return Promise.reject(new Error(longCancelError));
        return Promise.resolve(workspace);
      },
    };
  });

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  await page.getByRole('button', { name: 'Export Markdown' }).click();
  await page.getByRole('button', { name: 'Cancel operation' }).click();
  const status = page.getByRole('status');
  const alert = page.getByRole('alert');
  const footer = page.locator('.export-bar');
  await expect(status).toContainText('Workspace may be out of date');
  await expect(alert).toContainText('Cannot cancel');
  await expect(page.getByRole('button', { name: 'Copy context' })).toBeDisabled();

  for (const viewport of [{ width: 1200, height: 800 }, { width: 520, height: 640 }]) {
    await page.setViewportSize(viewport);
    const [statusBox, alertBox, footerBox] = await Promise.all([status.boundingBox(), alert.boundingBox(), footer.boundingBox()]);
    expect(statusBox).not.toBeNull();
    expect(alertBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(alertBox!.y);
    expect(alertBox!.y + alertBox!.height).toBeLessThanOrEqual(footerBox!.y);
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(viewport.height);
    const dismissBox = await page.getByRole('button', { name: 'Dismiss error' }).boundingBox();
    expect(dismissBox).not.toBeNull();
    expect(dismissBox!.y + dismissBox!.height).toBeLessThanOrEqual(footerBox!.y);
    expect(dismissBox!.x).toBeGreaterThanOrEqual(0);
    expect(dismissBox!.x + dismissBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(dismissBox!.y).toBeGreaterThanOrEqual(0);
  }
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(alert).toHaveCount(0);
});
