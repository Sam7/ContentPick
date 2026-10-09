import { expect, test } from '@playwright/test';

function relativeLuminance(color: string): number {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map((value) => Number(value) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Unsupported computed color: ${color}`);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

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

test('preview splitter supports bounded keyboard and pointer resizing and preserves width across collapse', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  await page.getByRole('button', { name: 'Preview README.md' }).click();
  const splitter = page.getByRole('separator', { name: 'File preview' });
  await expect(splitter).toHaveAttribute('aria-orientation', 'vertical');
  await expect(splitter).toHaveAttribute('aria-controls', 'file-preview-pane');
  await expect(splitter).toHaveAttribute('aria-valuenow', '32');

  await splitter.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', '34');
  await page.keyboard.press('ArrowRight');
  await expect(splitter).toHaveAttribute('aria-valuenow', '32');
  await page.keyboard.press('ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', '34');
  await expect(splitter).toBeFocused();

  const preview = page.locator('.preview-panel');
  const initialPreviewBounds = await preview.boundingBox();
  expect(initialPreviewBounds).not.toBeNull();
  const bounds = await splitter.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 24);
  await page.mouse.down();
  await page.mouse.move(bounds!.x - 90, bounds!.y + 24);
  await page.mouse.up();
  const resizedWidth = Number(await splitter.getAttribute('aria-valuenow'));
  expect(resizedWidth).toBeGreaterThan(34);
  expect(resizedWidth).toBeLessThanOrEqual(50);
  const resizedPreviewBounds = await preview.boundingBox();
  expect(resizedPreviewBounds).not.toBeNull();
  expect(resizedPreviewBounds!.width).toBeGreaterThan(initialPreviewBounds!.width + 50);
  await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible();
  await expect(page.locator('.export-bar')).toBeVisible();

  await splitter.focus();
  await page.keyboard.press('Enter');
  const restoreByKeyboard = page.getByRole('button', { name: 'Expand preview' });
  await expect(restoreByKeyboard).toBeFocused();
  await expect(page.getByRole('separator', { name: 'File preview' })).toHaveCount(0);
  await expect(page.getByText('# Patchwork')).toHaveCount(0);
  await expect(page.locator('.metric-primary strong')).toHaveText('3');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Collapse preview' })).toBeFocused();
  await expect(page.getByText('# Patchwork')).toBeVisible();
  await expect(page.getByRole('separator', { name: 'File preview' })).toHaveAttribute('aria-valuenow', String(resizedWidth));

  await page.getByRole('button', { name: 'Collapse preview' }).click();
  await expect(page.getByRole('separator', { name: 'File preview' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand preview' }).click();
  await expect(page.getByRole('separator', { name: 'File preview' })).toHaveAttribute('aria-valuenow', String(resizedWidth));
});

test('splitter values match pane width at 721px and 720px while preview and footer stay usable', async ({ page }) => {
  const assertCollapsedPreviewIsReachable = async (viewportWidth: number) => {
    await page.getByRole('button', { name: 'Collapse preview' }).click();
    const previewPanel = page.locator('.preview-panel');
    const restore = page.getByRole('button', { name: 'Expand preview' });
    await expect(restore).toBeInViewport();
    const [workbenchBounds, panelBounds, restoreBounds] = await Promise.all([
      page.locator('.workbench').boundingBox(), previewPanel.boundingBox(), restore.boundingBox(),
    ]);
    expect(workbenchBounds).not.toBeNull();
    expect(panelBounds).not.toBeNull();
    expect(restoreBounds).not.toBeNull();
    expect(panelBounds!.width).toBeGreaterThanOrEqual(44);
    expect(restoreBounds!.width).toBeGreaterThanOrEqual(24);
    expect(restoreBounds!.x).toBeGreaterThanOrEqual(panelBounds!.x);
    expect(restoreBounds!.x + restoreBounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width + 1);
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(workbenchBounds!.x + workbenchBounds!.width + 1);
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(viewportWidth);
    await restore.click();
    await expect(page.getByRole('button', { name: 'Collapse preview' })).toBeVisible();
  };

  await page.setViewportSize({ width: 721, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  const splitter = page.getByRole('separator', { name: 'File preview' });
  const workbench = page.locator('.workbench');
  const preview = page.locator('.preview-panel');
  const previewPercent = async () => {
    const [workbenchBounds, previewBounds] = await Promise.all([workbench.boundingBox(), preview.boundingBox()]);
    expect(workbenchBounds).not.toBeNull();
    expect(previewBounds).not.toBeNull();
    return (previewBounds!.width / workbenchBounds!.width) * 100;
  };

  await splitter.focus();
  await page.keyboard.press('Home');
  await expect(splitter).toHaveAttribute('aria-valuenow', '25');
  expect(Math.abs((await previewPercent()) - 25)).toBeLessThanOrEqual(1);
  const homeWidth = (await preview.boundingBox())!.width;

  await page.keyboard.press('ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', '27');
  expect(Math.abs((await previewPercent()) - 27)).toBeLessThanOrEqual(1);
  expect((await preview.boundingBox())!.width).toBeGreaterThan(homeWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(721);
  await assertCollapsedPreviewIsReachable(721);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await assertCollapsedPreviewIsReachable(721);

  await page.setViewportSize({ width: 720, height: 520 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  const compactSplitter = page.getByRole('separator', { name: 'File preview' });
  await expect(compactSplitter).toBeVisible();
  await compactSplitter.focus();
  await page.keyboard.press('Home');
  await expect(compactSplitter).toHaveAttribute('aria-valuenow', '25');
  await page.keyboard.press('ArrowLeft');
  await expect(compactSplitter).toHaveAttribute('aria-valuenow', '27');
  const compactWorkbench = page.locator('.workbench');
  const compactPreview = page.locator('.preview-panel');
  const [compactWorkbenchBounds, compactPreviewBounds] = await Promise.all([compactWorkbench.boundingBox(), compactPreview.boundingBox()]);
  expect(compactWorkbenchBounds).not.toBeNull();
  expect(compactPreviewBounds).not.toBeNull();
  expect(Math.abs((compactPreviewBounds!.width / compactWorkbenchBounds!.width) * 100 - 27)).toBeLessThanOrEqual(1);
  await assertCollapsedPreviewIsReachable(720);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await assertCollapsedPreviewIsReachable(720);
  await page.getByRole('button', { name: 'Preview README.md' }).click();
  await expect(page.locator('.code-preview')).toBeVisible();
  expect((await page.locator('.code-preview').boundingBox())!.height).toBeGreaterThan(80);
  await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible();
  await expect(page.locator('.export-bar')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(520);
});

test('compact workspace toolbar keeps real workspace actions and estimates visible', async ({ page }) => {
  for (const viewport of [{ width: 1536, height: 1024 }, { width: 1200, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const emptyStateText = await page.evaluate(() => {
      const backgroundFor = (element: Element) => {
        let current: Element | null = element;
        while (current) {
          const background = getComputedStyle(current).backgroundColor;
          const channels = background.match(/[\d.]+/g);
          if (channels && (channels.length < 4 || Number(channels[3]) > 0)) return background;
          current = current.parentElement;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      return Array.from(document.querySelectorAll('.workspace-empty, .file-empty p, .file-empty small')).map((element) => ({
        color: getComputedStyle(element).color,
        background: backgroundFor(element),
      }));
    });
    expect(emptyStateText.length).toBeGreaterThanOrEqual(3);
    for (const item of emptyStateText) expect(contrastRatio(item.color, item.background)).toBeGreaterThanOrEqual(4.5);
    await page.getByRole('button', { name: 'Open folder' }).click();

    const toolbar = page.locator('.workspace-toolbar');
    const toolbarBox = await toolbar.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(toolbarBox!.height).toBeLessThanOrEqual(80);
    await expect(toolbar).toContainText('/workspace/patchwork');
    await expect(toolbar.getByRole('img', { name: 'ContextPick' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await expect(toolbar.getByRole('button', { name: 'Change folder' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Select code. Export context.' })).toHaveCount(0);
    await expect(page.locator('.metrics-strip')).toHaveCount(0);
    await expect(page.locator('.export-bar .metric-primary strong')).toHaveText('3');
    await expect(page.locator('.export-bar')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `test-results/contextpick-shell-${viewport.width}x${viewport.height}.png` });
  }
});

test('sidebar projections, local Settings, and collapsed navigation preserve workspace intent', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  const selectedCount = page.locator('.metric-primary strong');
  const tree = page.getByRole('tree', { name: 'Workspace files' });
  const views = page.getByRole('navigation', { name: 'Workspace views' });

  await expect(views.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/contextpick-m35-3-sidebar-all-open.png' });
  await views.getByRole('button', { name: 'Selected' }).click();
  await expect(selectedCount).toHaveText('3');
  await page.getByRole('button', { name: 'Expand src', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview src/main.ts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview src/main.generated.ts' })).toHaveCount(0);

  await views.getByRole('button', { name: 'Ignored' }).click();
  await expect(tree.getByRole('button', { name: 'Browse ignored files' })).toBeVisible();
  await expect(views).toContainText('1 folders not browsed');
  await expect(selectedCount).toHaveText('3');
  await page.getByRole('button', { name: 'Browse ignored files' }).click();
  await expect(tree.getByText('report.md')).toBeVisible();
  await expect(selectedCount).toHaveText('3');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText(/saved locally on this device/i)).toBeVisible();
  await page.screenshot({ path: 'test-results/contextpick-m35-3-settings.png' });

  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  await collapse.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeFocused();
  await expect(selectedCount).toHaveText('3');
  await page.screenshot({ path: 'test-results/contextpick-m35-3-sidebar-collapsed.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1536);
});

test('filter controls remain in the sidebar and keep readable contrast at supported desktop widths', async ({ page }) => {
  for (const viewport of [{ width: 1536, height: 1024 }, { width: 720, height: 520 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open folder' }).click();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();

    const form = page.getByRole('form', { name: 'Filter settings' });
    await expect(form).toBeVisible();
    expect(await form.evaluate((element) => element.closest('aside') !== null)).toBe(true);
    await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible();
    await expect(page.locator('.export-bar')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    const text = await form.evaluate((element) => {
      const background = getComputedStyle(element).backgroundColor;
      const content = Array.from(element.querySelectorAll('.filter-grid label, .filter-hints small')).map((node) => ({
        color: getComputedStyle(node).color,
        background,
        size: Number.parseFloat(getComputedStyle(node).fontSize),
      }));
      const placeholders = Array.from(element.querySelectorAll('.filter-grid input')).map((input) => ({
        color: getComputedStyle(input, '::placeholder').color,
        background: getComputedStyle(input).backgroundColor,
        size: Number.parseFloat(getComputedStyle(input, '::placeholder').fontSize),
      }));
      return [...content, ...placeholders];
    });
    expect(text.length).toBeGreaterThan(0);
    for (const item of text) {
      expect(contrastRatio(item.color, item.background)).toBeGreaterThanOrEqual(4.5);
      expect(item.size).toBeGreaterThanOrEqual(9);
    }
    if (viewport.width === 720) {
      const apply = form.getByRole('button', { name: 'Apply filters' });
      await apply.scrollIntoViewIfNeeded();
      await expect(apply).toBeInViewport();
    }

    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await expect(page.locator('.preview-empty p')).toBeVisible();
    const emptyPreviewCopy = await page.locator('.preview-empty p').evaluate((element) => ({
      color: getComputedStyle(element).color,
      background: getComputedStyle(element.closest('.preview-panel')!).backgroundColor,
      size: Number.parseFloat(getComputedStyle(element).fontSize),
    }));
    expect(contrastRatio(emptyPreviewCopy.color, emptyPreviewCopy.background)).toBeGreaterThanOrEqual(4.5);
    await page.getByRole('button', { name: 'Preview README.md' }).click();

    const shellText = await page.evaluate(() => {
      const backgroundFor = (element: Element) => {
        let current: Element | null = element;
        while (current) {
          const background = getComputedStyle(current).backgroundColor;
          const channels = background.match(/[\d.]+/g);
          if (channels && (channels.length < 4 || Number(channels[3]) > 0)) return background;
          current = current.parentElement;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const nodes = [
        ...Array.from(document.querySelectorAll('.sidebar-heading, .sidebar-note, .refresh-badge, .scan-badge, .metric small, .token-metric strong, .tree-legend span, .entry-size, .browse-ignored, .reason-label, .partial-label, .readonly-badge, .code-toolbar > span, .truncation-note')).map((element) => ({ label: `Supporting text: ${element.className || element.parentElement?.className || element.textContent}`, element })),
        ...Array.from(document.querySelectorAll('.sidebar-group-label')).map((element) => ({ label: `Sidebar group: ${element.textContent}`, element })),
        ...Array.from(document.querySelectorAll('.sidebar-item small')).map((element) => ({ label: `Sidebar count: ${element.textContent}`, element })),
        { label: 'Preview path', element: document.querySelector('.preview-path') },
        { label: 'Workspace discovery text', element: document.querySelector('.file-panel .panel-heading p') },
      ];
      return nodes.filter((item): item is { label: string; element: Element } => item.element !== null).map(({ label, element }) => ({
        label,
        color: getComputedStyle(element).color,
        background: backgroundFor(element),
        size: Number.parseFloat(getComputedStyle(element).fontSize),
        text: element.textContent?.trim() ?? '',
      }));
    });
    expect(shellText.map((item) => item.label)).toEqual(expect.arrayContaining(['Sidebar group: FILES', 'Sidebar group: TOOLS', 'Preview path', 'Workspace discovery text']));
    expect(shellText.some((item) => item.label.startsWith('Sidebar count:'))).toBe(true);
    expect(shellText.some((item) => item.label.startsWith('Supporting text:'))).toBe(true);
    const lowContrast = shellText.filter((item) => contrastRatio(item.color, item.background) < 4.5)
      .map((item) => ({ label: item.label, text: item.text, color: item.color, background: item.background, ratio: contrastRatio(item.color, item.background) }));
    expect(lowContrast).toEqual([]);
    await page.getByRole('button', { name: 'Settings' }).click();
    const settingsText = await page.locator('.settings-content').evaluate((element) => {
      const backgroundFor = (node: Element) => {
        let current: Element | null = node;
        while (current) {
          const background = getComputedStyle(current).backgroundColor;
          const channels = background.match(/[\d.]+/g);
          if (channels && (channels.length < 4 || Number(channels[3]) > 0)) return background;
          current = current.parentElement;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      return Array.from(element.querySelectorAll('p, .settings-action small')).map((node) => ({
        color: getComputedStyle(node).color,
        background: backgroundFor(node),
      }));
    });
    expect(settingsText.length).toBeGreaterThan(0);
    for (const item of settingsText) expect(contrastRatio(item.color, item.background)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `test-results/contextpick-m35-4-filters-${viewport.width}x${viewport.height}.png` });
  }
});

test('deep preview paths stay bounded while the code view and collapse control remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 520 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  await page.getByRole('button', { name: 'Preview README.md' }).click();
  const details = page.getByRole('group', { name: 'Preview file details' });
  await expect(details).toContainText('Size: 923 bytes');
  await expect(details).toContainText('Included');

  const longPath = `src/${'deep-segment/'.repeat(90)}README.md`;
  const previewPath = page.locator('.preview-path');
  await previewPath.evaluate((element, value) => {
    element.textContent = value;
    element.setAttribute('title', value);
  }, longPath);

  const pathBox = await previewPath.boundingBox();
  const codeBox = await page.locator('.code-preview').boundingBox();
  expect(pathBox).not.toBeNull();
  expect(pathBox!.height).toBeLessThanOrEqual(60);
  expect(codeBox).not.toBeNull();
  expect(codeBox!.height).toBeGreaterThan(80);
  await expect(page.getByRole('button', { name: 'Collapse preview' })).toBeInViewport();
  await expect(page.locator('.export-bar')).toBeInViewport();

  await page.getByRole('button', { name: 'Collapse preview' }).click();
  const restore = page.getByRole('button', { name: 'Expand preview' });
  await expect(restore).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Collapse preview' })).toBeFocused();
  await expect(page.locator('.code-preview')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
});

test('bounded scan diagnostics remain scrollable without collapsing the file tree', async ({ page }) => {
  await page.addInitScript(() => {
    const workspace = {
      root: 'C:/workspace/project', generation: 1,
      entries: [], entryCount: 0, nextOffset: null,
      selectedCount: 0, estimatedBytes: 0,
      policy: { gitignore: true, includeExtensions: [], includePaths: [], excludePaths: [] },
      incomplete: true,
      diagnostics: Array.from({ length: 64 }, (_, index) => `Diagnostic ${index + 1}: a bounded scan detail.`),
    };
    const testWindow = window as typeof window & {
      isTauri: boolean;
      __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown>; transformCallback: () => number };
    };
    testWindow.isTauri = true;
    testWindow.__TAURI_INTERNALS__ = {
      invoke: (command) => command === 'get_watch_status'
        ? Promise.resolve(null)
        : command === 'plugin:event|listen' ? Promise.resolve(1) : Promise.resolve(workspace),
      transformCallback: () => 1,
    };
  });
  await page.setViewportSize({ width: 720, height: 520 });
  await page.goto('/');

  const tree = page.getByRole('tree', { name: 'Workspace files' });
  const diagnostics = page.locator('.diagnostics');
  await expect(diagnostics).toBeVisible();
  const [treeBox, diagnosticSize] = await Promise.all([
    tree.boundingBox(),
    diagnostics.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight })),
  ]);
  expect(treeBox).not.toBeNull();
  expect(treeBox!.height).toBeGreaterThanOrEqual(64);
  expect(diagnosticSize.clientHeight).toBeGreaterThan(0);
  expect(diagnosticSize.scrollHeight).toBeGreaterThan(diagnosticSize.clientHeight);
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
      policy: { gitignore: true, includeExtensions: [], includePaths: [], excludePaths: [] },
      profileCatalog: { root: 'C:/workspace/project', generation: 1, names: [], activeProfile: null },
      incomplete: false, diagnostics: [],
    };
    const watchHealth = {
      root: workspace.root, epoch: 1, revision: 0, state: 'watching', message: null,
    };
    const longCancelError = `Cannot cancel C:/synthetic/${'unbroken-path-segment'.repeat(32)}`;
    const testWindow = window as typeof window & {
      isTauri: boolean;
      __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown>; transformCallback: () => number };
    };
    testWindow.isTauri = true;
    testWindow.__TAURI_INTERNALS__ = {
      invoke: (command) => {
        if (command === 'plugin:event|listen') return Promise.resolve(1);
        if (command === 'get_watch_status') return Promise.resolve(watchHealth);
        if (command === 'restore_workspace') return Promise.resolve(null);
        if (command === 'choose_workspace') return Promise.resolve(workspace);
        if (command === 'export_markdown') return new Promise(() => undefined);
        if (command === 'cancel_operation') return Promise.reject(new Error(longCancelError));
        return Promise.resolve(workspace);
      },
      transformCallback: () => 1,
    };
  });

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder' }).click();
  await expect(page.getByText('Watching', { exact: true })).toBeVisible();
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

test.describe('high-DPI desktop layout', () => {
  test.use({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 2 });

  test('keeps tree, bounded preview controls and footer usable at 2x scale', async ({ page }) => {
    await page.goto('/');
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    await page.getByRole('button', { name: 'Open folder' }).click();
    await page.getByRole('button', { name: 'Preview README.md' }).click();
    await expect(page.getByText('# Patchwork')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Collapse preview' })).toBeInViewport();
    await expect(page.locator('.export-bar')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1536);
    await page.screenshot({ path: 'docs/testing/2026-10-09-m35-high-dpi-browser.png' });

    await page.getByRole('button', { name: 'Collapse preview' }).click();
    const restore = page.getByRole('button', { name: 'Expand preview' });
    await expect(restore).toHaveAttribute('aria-expanded', 'false');
    await expect(restore).toBeFocused();
    await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible();
    await expect(page.locator('.export-bar')).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Collapse preview' })).toBeFocused();
    await expect(page.getByText('# Patchwork')).toBeVisible();
  });
});
