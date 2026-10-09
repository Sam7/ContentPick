import { test, expect } from './native.fixture';

test.beforeAll(() => {
  expect(process.env.CONTEXTPICK_NATIVE_EXECUTABLE, 'Point CONTEXTPICK_NATIVE_EXECUTABLE at the installed ContextPick executable.').toBeTruthy();
  expect(process.env.CONTEXTPICK_NATIVE_CONFIG_DIR, 'Point CONTEXTPICK_NATIVE_CONFIG_DIR at a confirmed disposable app config directory.').toBeTruthy();
});

test('installed app restores and previews a disposable workspace', async ({ native }) => {
  const page = native.page;

  await expect(page.locator('.workspace-path')).toContainText('workspace');
  await expect(page.locator('.panel-heading p').first()).toHaveText('605 items discovered');
  await page.getByRole('button', { name: 'Preview README.md' }).click();
  await expect(page.getByText('# Native fixture')).toBeVisible();
});
