import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createBrowserBridge, type FilterPolicy, type WorkspaceView } from './bridge';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(() => cleanup());

describe('ContextPick workspace UI', () => {
  it('opens a synthetic workspace and exposes a bounded file preview', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);

    expect(screen.getByLabelText('Workspace toolbar')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'ContextPick' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Select code. Export context.' })).not.toBeInTheDocument();
    expect(screen.getByText('No folder open')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    expect(screen.getByTitle('Automatic file watching is not available yet. Refresh after changing files.')).toBeInTheDocument();
    const rootRows = Array.from(screen.getByRole('tree', { name: 'Workspace files' }).querySelectorAll('[role="treeitem"][aria-level="1"] .entry-name')).map((node) => node.textContent);
    expect(rootRows).toEqual(['src', 'assets', 'dist', 'README.md']);
    await user.click(screen.getByRole('button', { name: 'Preview README.md' }));
    expect(await screen.findByText(/^# Patchwork/)).toBeInTheDocument();
    expect(screen.getByText('Token estimate')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('shows exact preview size and the current effective inclusion state, then reports unavailable metadata', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const initial = (await base.choose_workspace())!;
    const excluded: WorkspaceView = {
      ...initial,
      entries: initial.entries.map((entry) => entry.path === 'README.md' ? { ...entry, selected: false } : entry),
      selectedCount: 2,
      estimatedBytes: 5317,
    };
    const missingEntry: WorkspaceView = {
      ...excluded,
      entries: excluded.entries.filter((entry) => entry.path !== 'README.md'),
      entryCount: excluded.entryCount - 1,
    };
    const bridge = {
      ...base,
      set_intent: async () => excluded,
      refresh_workspace: async () => missingEntry,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(await screen.findByRole('button', { name: 'Preview README.md' }));

    const details = screen.getByRole('group', { name: 'Preview file details' });
    expect(within(details).getByText('Size: 923 bytes')).toBeInTheDocument();
    expect(within(details).getByText('Included')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));
    expect(await within(details).findByText('Not included')).toBeInTheDocument();
    expect(within(details).getByText('Size: 923 bytes')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await within(details).findByText('Size unavailable')).toBeInTheDocument();
    expect(within(details).getByText('Inclusion unavailable')).toBeInTheDocument();
  });

  it('collapses and restores the preview without changing selection or losing focus', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(await screen.findByRole('button', { name: 'Preview README.md' }));
    expect(await screen.findByText(/^# Patchwork/)).toBeInTheDocument();

    const collapse = screen.getByRole('button', { name: 'Collapse preview' });
    await user.click(collapse);
    const restore = screen.getByRole('button', { name: 'Expand preview' });
    expect(restore).toHaveAttribute('aria-expanded', 'false');
    expect(restore).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Project files and preview' })).toHaveClass('preview-collapsed');
    expect(screen.queryByText(/^# Patchwork/)).not.toBeInTheDocument();
    expect(screen.getByText('3', { selector: '.metric-primary strong' })).toBeInTheDocument();
    expect(screen.getByRole('tree', { name: 'Workspace files' })).toBeInTheDocument();

    await user.keyboard('{Enter}');
    const expanded = screen.getByRole('button', { name: 'Collapse preview' });
    expect(expanded).toHaveAttribute('aria-expanded', 'true');
    expect(expanded).toHaveFocus();
    expect(await screen.findByText(/^# Patchwork/)).toBeInTheDocument();
    expect(screen.getByText('3', { selector: '.metric-primary strong' })).toBeInTheDocument();
  });

  it('resizes the preview with bounded keyboard-operable splitter and preserves its width when collapsed', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Preview README.md' }));

    const splitter = screen.getByRole('separator', { name: 'File preview' });
    expect(splitter).toHaveAttribute('aria-orientation', 'vertical');
    expect(splitter).toHaveAttribute('aria-controls', 'file-preview-pane');
    expect(Number(splitter.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(25);
    expect(Number(splitter.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(50);
    splitter.focus();
    const initialWidth = Number(splitter.getAttribute('aria-valuenow'));

    await user.keyboard('{ArrowLeft}');
    const expandedWidth = Number(splitter.getAttribute('aria-valuenow'));
    expect(expandedWidth).toBeGreaterThan(initialWidth);
    expect(splitter).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(Number(splitter.getAttribute('aria-valuenow'))).toBe(initialWidth);
    await user.keyboard('{End}');
    expect(Number(splitter.getAttribute('aria-valuenow'))).toBe(50);

    splitter.focus();
    await user.keyboard('{Enter}');
    const restoreByKeyboard = screen.getByRole('button', { name: 'Expand preview' });
    expect(restoreByKeyboard).toHaveFocus();
    expect(screen.queryByRole('separator', { name: 'File preview' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^# Patchwork/)).not.toBeInTheDocument();
    expect(screen.getByText('3', { selector: '.metric-primary strong' })).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Collapse preview' })).toHaveFocus();
    expect(await screen.findByText(/^# Patchwork/)).toBeInTheDocument();
    expect(Number(screen.getByRole('separator', { name: 'File preview' }).getAttribute('aria-valuenow'))).toBe(50);
    expect(screen.getByText('3', { selector: '.metric-primary strong' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse preview' }));
    expect(screen.queryByRole('separator', { name: 'File preview' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand preview' }));
    expect(Number(screen.getByRole('separator', { name: 'File preview' }).getAttribute('aria-valuenow'))).toBe(50);
  });

  it('keeps the empty workspace on picker cancellation', async () => {
    const user = userEvent.setup();
    const bridge = createBrowserBridge({ cancelPicker: true });
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(screen.getByText('No folder open')).toBeInTheDocument();
  });

  it('keeps the current workspace and selection when the toolbar folder change is cancelled', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    let choices = 0;
    const bridge = {
      ...base,
      choose_workspace: async () => ++choices === 1 ? base.choose_workspace() : null,
    };
    render(<App bridge={bridge} />);

    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await screen.findByText('/workspace/patchwork');
    await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));
    expect(screen.getByText('2', { selector: '.metric-primary strong' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Change folder' }));
    expect(screen.getByText('/workspace/patchwork')).toBeInTheDocument();
    expect(screen.getByText('2', { selector: '.metric-primary strong' })).toBeInTheDocument();
    expect(choices).toBe(2);
  });

  it('cancels a pending workspace restore and ignores its late result', async () => {
    const user = userEvent.setup();
    const restoreDeferred = deferred<Awaited<ReturnType<ReturnType<typeof createBrowserBridge>['restore_workspace']>>>();
    const base = createBrowserBridge();
    let cancelRequested = false;
    const bridge = {
      ...base,
      restore_workspace: () => restoreDeferred.promise,
      cancel_operation: async () => { cancelRequested = true; return null; },
    };
    render(<App bridge={bridge} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel operation' }));
    expect(cancelRequested).toBe(true);
    restoreDeferred.resolve(await base.choose_workspace());
    await waitFor(() => expect(screen.getByText('No folder open')).toBeInTheDocument());
    expect(screen.queryByText('/workspace/patchwork')).not.toBeInTheDocument();
  });

  it('shows a recovery error when saved workspace settings cannot be restored', async () => {
    const bridge = {
      ...createBrowserBridge(),
      restore_workspace: async () => { throw new Error('Settings are corrupt. Reset settings to recover.'); },
    };
    render(<App bridge={bridge} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reset settings to recover');
    expect(screen.getByText('No folder open')).toBeInTheDocument();
  });

  it('reports successful export outcomes', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(await screen.findByRole('button', { name: 'Export Markdown' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Export ready · 3 files · 6.2 KB · /workspace/patchwork/context.md');
    expect(status).toBeVisible();
  });

  it('updates footer estimates from accepted policy and selection results and disables empty exports', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const initial = (await base.choose_workspace())!;
    const filtered: WorkspaceView = {
      ...initial,
      entries: initial.entries.map((entry) => ({ ...entry, selected: entry.path === 'README.md' })),
      selectedCount: 1,
      estimatedBytes: 923,
    };
    const empty: WorkspaceView = {
      ...filtered,
      entries: filtered.entries.map((entry) => ({ ...entry, selected: false })),
      selectedCount: 0,
      estimatedBytes: 0,
    };
    const bridge = {
      ...base,
      set_policy: async ({ policy }: { policy: FilterPolicy }) => ({ ...filtered, policy }),
      set_intent: async () => empty,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));

    const estimates = screen.getByRole('group', { name: 'Selection estimates' });
    expect(within(estimates).getByText('3', { selector: 'strong' })).toBeInTheDocument();
    expect(within(estimates).getByText('≈ 6.2 KB')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.type(screen.getByRole('textbox', { name: 'Include extensions' }), '.md');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(within(estimates).getByText('1', { selector: 'strong' })).toBeInTheDocument();
    expect(within(estimates).getByText('≈ 923 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));

    expect(within(estimates).getByText('0', { selector: 'strong' })).toBeInTheDocument();
    expect(within(estimates).getByText('≈ 0 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(within(estimates).getByText('Unavailable')).toBeInTheDocument();
  });

  it('reflects workspace-engine selection responses and force include markers', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));
    expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand src' }));
    await user.click(screen.getByRole('button', { name: 'More actions for src/main.generated.ts' }));
    await user.click(screen.getByRole('button', { name: 'Force include' }));
    expect(screen.getByText('Override')).toBeInTheDocument();
    expect(screen.getByText('4', { selector: 'strong' })).toBeInTheDocument();
  });

  it('toggles the focused tree item from the keyboard and exposes its checked state', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const intents: { path: string; intent: string | null }[] = [];
    const bridge = {
      ...base,
      set_intent: async ({ path, intent }: { path: string; intent: string | null }) => {
        intents.push({ path, intent });
        return (await base.choose_workspace())!;
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));

    const preview = screen.getByRole('button', { name: 'Preview README.md' });
    const row = preview.closest<HTMLElement>('[role="treeitem"]')!;
    expect(row).toHaveAttribute('aria-checked', 'true');
    row.focus();
    expect(row).toHaveFocus();
    await user.keyboard(' ');

    await waitFor(() => expect(intents).toEqual([{ path: 'README.md', intent: 'exclude' }]));
  });

  it('does not start a keyboard preview while another operation disables preview', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const exportRequest = deferred<{ bytes: number; files: number; destination: string } | null>();
    const previews: string[] = [];
    const bridge = {
      ...base,
      export_markdown: () => exportRequest.promise,
      preview_file: async ({ path }: { path: string }) => {
        previews.push(path);
        return { text: '# preview', truncated: false };
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Export Markdown' }));
    const row = screen.getByRole('button', { name: 'Preview README.md' }).closest<HTMLElement>('[role="treeitem"]')!;
    row.focus();
    await user.keyboard('{Enter}');

    expect(previews).toEqual([]);
    exportRequest.resolve({ bytes: 12, files: 1, destination: 'context.md' });
    expect(await screen.findByRole('status')).toHaveTextContent('Export ready');
  });

  it('does not start ignored-folder browsing from Enter or Right while another operation is busy', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const refreshRequest = deferred<WorkspaceView>();
    const browsed: string[] = [];
    const bridge = {
      ...base,
      refresh_workspace: () => refreshRequest.promise,
      browse_ignored: async ({ path }: { path: string }) => {
        browsed.push(path);
        return (await base.browse_ignored({ path }))!;
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const row = screen.getByText('dist', { exact: true }).closest<HTMLElement>('[role="treeitem"]')!;
    row.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowRight}');

    expect(browsed).toEqual([]);
    refreshRequest.resolve((await base.refresh_workspace())!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });

  it('resets all selection intent separately from resetting a path override', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));
    expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Reset selections' }));
    expect(await screen.findByText('3', { selector: 'strong' })).toBeInTheDocument();
  });

  it('switches file projections without mutating selection or changing export contents', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const intentChanges: unknown[] = [];
    const policyChanges: unknown[] = [];
    let copyCount = 0;
    const bridge = {
      ...base,
      set_intent: async (args: Parameters<typeof base.set_intent>[0]) => { intentChanges.push(args); return (await base.choose_workspace())!; },
      set_policy: async (args: Parameters<typeof base.set_policy>[0]) => { policyChanges.push(args); return (await base.choose_workspace())!; },
      copy_markdown: async () => { copyCount += 1; return { destination: 'clipboard', bytes: 6240, files: 3 }; },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    const tree = screen.getByRole('tree', { name: 'Workspace files' });

    await user.click(screen.getByRole('button', { name: 'Selected' }));
    expect(tree.querySelectorAll('[role="treeitem"][aria-level="1"] .entry-name')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Expand src' }));
    expect(await screen.findByRole('button', { name: 'Preview src/main.ts' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview src/main.generated.ts' })).not.toBeInTheDocument();
    const search = screen.getByRole('textbox', { name: 'Search files' });
    await user.type(search, 'main.generated');
    expect(screen.queryByRole('button', { name: 'Preview src/main.generated.ts' })).not.toBeInTheDocument();
    await user.clear(search);

    await user.click(screen.getByRole('button', { name: 'Ignored' }));
    expect(screen.getByRole('button', { name: 'Browse ignored files' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview README.md' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy context' }));
    expect(copyCount).toBe(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Copied · 3 files · 6.2 KB');
    expect(intentChanges).toEqual([]);
    expect(policyChanges).toEqual([]);
  });

  it('collapses the sidebar accessibly and explains local settings before resetting selections', async () => {
    const user = userEvent.setup();
    const resetCalls: number[] = [];
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      reset_selections: async () => { resetCalls.push(1); return (await base.choose_workspace())!; },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
    collapse.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText(/saved locally on this device/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset selections' }));
    expect(resetCalls).toHaveLength(1);
  });

  it('reopens collapsed filters on the first click and preserves unsubmitted drafts', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.type(screen.getByRole('textbox', { name: 'Include extensions' }), '.rs');

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    const collapsedFilters = screen.getByRole('button', { name: 'Filters' });
    expect(collapsedFilters).toHaveAttribute('aria-expanded', 'false');
    collapsedFilters.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Filter settings' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Include extensions' })).toHaveValue('.rs');
    expect(screen.getByRole('form', { name: 'Filter settings' }).closest('aside')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('form', { name: 'Filter settings' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Include extensions' })).toHaveValue('.rs');
  });

  it('only enumerates an ignored folder after the explicit browse command', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(screen.getByRole('button', { name: 'Browse ignored files' })).toBeInTheDocument();
    expect(screen.queryByText('report.md')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Browse ignored files' }));
    expect(await screen.findByText('report.md')).toBeInTheDocument();
  });

  it('reveals nested search matches without changing expansion or selection', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));

    const search = screen.getByRole('textbox', { name: 'Search files' });
    expect(screen.queryByRole('button', { name: 'Preview src/components/Picker.tsx' })).not.toBeInTheDocument();
    const selectedCount = screen.getByText('3', { selector: '.metric-primary strong' });

    await user.type(search, 'Picker');
    expect(await screen.findByRole('button', { name: 'Preview src/components/Picker.tsx' })).toBeInTheDocument();
    const tree = screen.getByRole('tree', { name: 'Workspace files' });
    expect(tree.querySelector('[role="treeitem"][aria-level="1"]')).toHaveAttribute('aria-expanded', 'true');
    expect(tree.querySelector('[role="treeitem"][aria-level="2"]')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Collapse src' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Collapse src/components' })).toBeDisabled();
    expect(selectedCount).toHaveTextContent('3');

    await user.clear(search);
    expect(screen.queryByRole('button', { name: 'Preview src/components/Picker.tsx' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand src' })).toBeInTheDocument();
    expect(selectedCount).toHaveTextContent('3');
  });

  it('submits and restores the extensionless extension sentinel', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const submittedPolicies: FilterPolicy[] = [];
    const bridge = {
      ...base,
      set_policy: async ({ policy }: { policy: FilterPolicy }) => {
        submittedPolicies.push(structuredClone(policy));
        const workspace = await base.choose_workspace();
        return { ...workspace!, policy: structuredClone(policy) };
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));

    const includeExtensions = screen.getByRole('textbox', { name: 'Include extensions' });
    await user.type(includeExtensions, '<none>');
    expect(screen.getByText('Use <none> to include files with no extension.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(submittedPolicies.at(-1)?.includeExtensions).toEqual(['']);

    expect(screen.getByRole('textbox', { name: 'Include extensions' })).toHaveValue('<none>');
  });

  it('offers include extensions and resets filters without resetting selection intent', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const initial = await base.choose_workspace();
    const submittedPolicies: FilterPolicy[] = [];
    let resetSelectionsCalls = 0;
    const bridge = {
      ...base,
      choose_workspace: async () => initial,
      reset_selections: async () => {
        resetSelectionsCalls += 1;
        return initial!;
      },
      set_policy: async ({ policy }: { policy: FilterPolicy }) => {
        submittedPolicies.push(structuredClone(policy));
        return { ...initial!, policy: structuredClone(policy) };
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));

    const filterForm = screen.getByRole('form', { name: 'Filter settings' });
    expect(filterForm.closest('aside')).toBeInTheDocument();
    expect(screen.getByRole('tree', { name: 'Workspace files' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /exclude extensions/i })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Include extensions' }), '.rs');
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));

    expect(submittedPolicies).toEqual([{ gitignore: true, includeExtensions: [], includePaths: [], excludePaths: [] }]);
    expect(resetSelectionsCalls).toBe(0);
    expect(screen.getByRole('textbox', { name: 'Include extensions' })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Select README.md' })).toBeChecked();
  });

  it('keeps a trailing separator while typing multiple extension filters', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const submittedPolicies: FilterPolicy[] = [];
    const bridge = {
      ...base,
      set_policy: async ({ policy }: { policy: FilterPolicy }) => {
        submittedPolicies.push(structuredClone(policy));
        const workspace = await base.choose_workspace();
        return { ...workspace!, policy: structuredClone(policy) };
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));

    const includeExtensions = screen.getByRole('textbox', { name: 'Include extensions' });
    await user.type(includeExtensions, 'rs, ts');
    expect(includeExtensions).toHaveValue('rs, ts');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(submittedPolicies.at(-1)?.includeExtensions).toEqual(['rs', 'ts']);
  });

  it('shows the first workspace page immediately and appends later pages in order', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const pageOne = deferred<{ root: string; generation: number; offset: number; entries: WorkspaceView['entries']; nextOffset: number | null }>();
    const pageTwo = deferred<{ root: string; generation: number; offset: number; entries: WorkspaceView['entries']; nextOffset: number | null }>();
    const firstEntries: WorkspaceView['entries'] = [
      { path: 'first.ts', kind: 'file', size: 1, selected: true, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: false },
    ];
    const bridge = {
      ...base,
      choose_workspace: async () => ({ ...(await base.choose_workspace())!, entries: firstEntries, entryCount: 3, nextOffset: 1 }),
      workspace_page: async ({ offset }: { generation: number; offset: number }) => offset === 1 ? pageOne.promise : pageTwo.promise,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));

    const firstPreview = await screen.findByRole('button', { name: 'Preview first.ts' });
    expect(firstPreview).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel operation' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('1 of 3 items loaded');
    expect(within(screen.getByRole('region', { name: 'Project files' })).getByText('1 of 3 items loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview second.ts' })).not.toBeInTheDocument();
    pageOne.resolve({ root: '/workspace/patchwork', generation: 1, offset: 1, entries: [{ ...firstEntries[0]!, path: 'second.ts' }], nextOffset: 2 });
    expect(await screen.findByRole('button', { name: 'Preview second.ts' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 items loaded');
    pageTwo.resolve({ root: '/workspace/patchwork', generation: 1, offset: 2, entries: [{ ...firstEntries[0]!, path: 'third.ts' }], nextOffset: null });
    expect(await screen.findByRole('button', { name: 'Preview third.ts' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Project files' })).getByText('3 items discovered')).toBeInTheDocument();
    await waitFor(() => expect(firstPreview).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Cancel operation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
  });

  it('ignores a late workspace page after cancellation and opening a new root', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const latePage = deferred<{ root: string; generation: number; offset: number; entries: WorkspaceView['entries']; nextOffset: number | null }>();
    const oldView = { ...(await base.choose_workspace())!, entries: [{ path: 'old-first.ts', kind: 'file' as const, size: 1, selected: true, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: false }], entryCount: 2, nextOffset: 1 };
    const newView = { ...oldView, root: '/workspace/new', entries: [{ ...oldView.entries[0]!, path: 'new.ts' }], entryCount: 1, nextOffset: null };
    let chooseCount = 0;
    const bridge = {
      ...base,
      choose_workspace: async () => ++chooseCount === 1 ? oldView : newView,
      workspace_page: async () => latePage.promise,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByRole('button', { name: 'Preview old-first.ts' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Cancel operation' }));
    await user.click(await screen.findByRole('button', { name: 'Change folder' }));
    expect(await screen.findByText('/workspace/new')).toBeInTheDocument();
    latePage.resolve({ root: '/workspace/patchwork', generation: 1, offset: 1, entries: [{ ...oldView.entries[0]!, path: 'old-late.ts' }], nextOffset: null });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Preview old-late.ts' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Preview new.ts' })).toBeInTheDocument();
  });

  it('blocks folder changes until cancellation is acknowledged and rejects the late page', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const original = await base.choose_workspace();
    const oldWorkspace = { ...original!, root: '/workspace/old', entries: [{ ...original!.entries[1]!, path: 'old.ts' }], entryCount: 1, nextOffset: null };
    const refreshFirst = { ...oldWorkspace, generation: 2, entries: [{ ...oldWorkspace.entries[0]!, path: 'refresh-first.ts' }], entryCount: 2, nextOffset: 1 };
    const latePage = deferred<{ root: string; generation: number; offset: number; entries: WorkspaceView['entries']; nextOffset: number | null }>();
    const nextChoice = deferred<WorkspaceView | null>();
    const cancelAck = deferred<WorkspaceView | null>();
    let chooseCalls = 0;
    let pageCalls = 0;
    let cancelCalls = 0;
    const bridge = {
      ...base,
      choose_workspace: () => ++chooseCalls === 1 ? Promise.resolve(oldWorkspace) : nextChoice.promise,
      refresh_workspace: async () => refreshFirst,
      workspace_page: () => { pageCalls += 1; return latePage.promise; },
      cancel_operation: () => { cancelCalls += 1; return cancelAck.promise; },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(pageCalls).toBe(1));
    await user.click(await screen.findByRole('button', { name: 'Cancel operation' }));
    await waitFor(() => expect(cancelCalls).toBe(1));

    const changeFolder = screen.getByRole('button', { name: 'Change folder' });
    expect(changeFolder).toBeDisabled();
    await user.click(changeFolder);
    expect(chooseCalls).toBe(1);

    cancelAck.resolve(oldWorkspace);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Cancellation requested'));
    await user.click(screen.getByRole('button', { name: 'Change folder' }));
    expect(chooseCalls).toBe(2);
    const nextWorkspace = { ...oldWorkspace, root: '/workspace/new', entries: [{ ...oldWorkspace.entries[0]!, path: 'new.ts' }] };
    nextChoice.resolve(nextWorkspace);
    expect(await screen.findByText('/workspace/new')).toBeInTheDocument();
    latePage.resolve({ root: '/workspace/old', generation: 2, offset: 1, entries: [{ ...oldWorkspace.entries[0]!, path: 'late-old.ts' }], nextOffset: null });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Preview late-old.ts' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Preview new.ts' })).toBeInTheDocument();
  });

  it('uses the authoritative workspace returned by cancellation over a late folder response', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const initial = await base.choose_workspace();
    const oldWorkspace = { ...initial!, root: '/workspace/a', entries: [{ ...initial!.entries[1]!, path: 'a.ts' }], entryCount: 1, nextOffset: null };
    const pendingChoose = deferred<WorkspaceView | null>();
    const policyB: FilterPolicy = { gitignore: false, includeExtensions: ['.b'], includePaths: ['b/**'], excludePaths: [] };
    const authoritative = {
      ...oldWorkspace,
      root: '/workspace/backend-b', generation: 3,
      policy: policyB,
      entries: [{ ...oldWorkspace.entries[0]!, path: 'b-first.ts' }], entryCount: 2, nextOffset: 1,
    };
    let chooseCalls = 0;
    let exportDestination = '';
    const bridge = {
      ...base,
      choose_workspace: () => ++chooseCalls === 1 ? Promise.resolve(oldWorkspace) : pendingChoose.promise,
      cancel_operation: async () => authoritative,
      workspace_page: async ({ generation, offset }: { generation: number; offset: number }) => ({
        root: '/workspace/backend-b', generation, offset,
        entries: [{ ...authoritative.entries[0]!, path: 'b-second.ts' }], nextOffset: null,
      }),
      export_markdown: async () => {
        exportDestination = '/workspace/backend-b/context.md';
        return { destination: exportDestination, bytes: 12, files: 2 };
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/a')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.type(screen.getByRole('textbox', { name: 'Include paths' }), 'a/**');
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const search = screen.getByRole('textbox', { name: 'Search files' });
    await user.type(search, 'a.ts');
    expect(search).toHaveValue('a.ts');
    await user.click(screen.getByRole('button', { name: 'Change folder' }));
    expect(chooseCalls).toBe(2);
    await user.click(await screen.findByRole('button', { name: 'Cancel operation' }));
    expect(await screen.findByText('/workspace/backend-b')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Preview b-second.ts' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search files' })).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('checkbox', { name: 'Respect .gitignore' })).not.toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Include extensions' })).toHaveValue('.b');
    expect(screen.getByRole('textbox', { name: 'Include paths' })).toHaveValue('b/**');

    pendingChoose.resolve({ ...oldWorkspace, root: '/workspace/backend-b', generation: 2, entries: [{ ...oldWorkspace.entries[0]!, path: 'late-choose.ts' }] });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Preview late-choose.ts' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Export Markdown' }));
    expect(await screen.findByRole('status')).toHaveTextContent('/workspace/backend-b/context.md');
    expect(exportDestination).toBe('/workspace/backend-b/context.md');
  });

  it('marks workspace stale after cancellation failure until a refresh succeeds', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      export_markdown: () => new Promise<{ destination: string; bytes: number; files: number }>(() => undefined),
      cancel_operation: async () => { throw new Error('Cancellation did not finish.'); },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(await screen.findByRole('button', { name: 'Export Markdown' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel operation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation did not finish');
    expect(screen.getByRole('status')).toHaveTextContent('Refresh or choose a folder');
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select README.md' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled());
    expect(screen.getByRole('checkbox', { name: 'Select README.md' })).toBeEnabled();
  });

  it('keeps the authoritative root usable when a later cancellation page fails', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const current = await base.choose_workspace();
    const authoritative = { ...current!, root: '/workspace/current', generation: 4, entries: [current!.entries[1]!], entryCount: 2, nextOffset: 1 };
    const bridge = {
      ...base,
      export_markdown: () => new Promise<{ destination: string; bytes: number; files: number }>(() => undefined),
      cancel_operation: async () => authoritative,
      workspace_page: async ({ generation, offset }: { generation: number; offset: number }) => ({
        root: authoritative.root, generation, offset: offset + 1, entries: [current!.entries[2]!], nextOffset: null,
      }),
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(await screen.findByRole('button', { name: 'Export Markdown' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel operation' }));
    expect(await screen.findByText('/workspace/current')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('requested page');
    expect(screen.getByRole('status')).toHaveTextContent('workspace is current');
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
  });

  it('rejects malformed workspace page metadata visibly without appending it', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const initial = await base.choose_workspace();
    const firstEntry = { ...initial!.entries[0]!, path: 'first.ts', kind: 'file' as const };
    const bridge = {
      ...base,
      choose_workspace: async () => ({ ...initial!, entries: [firstEntry], entryCount: 2, nextOffset: 1 }),
      workspace_page: async () => ({ root: initial!.root, generation: initial!.generation, offset: 77, entries: [{ ...firstEntry, path: 'bad-page.ts' }], nextOffset: null }),
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/page/i);
    expect(screen.getByRole('button', { name: 'Preview first.ts' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview bad-page.ts' })).not.toBeInTheDocument();
  });

  it('offers an explicit cancel action for a running export', async () => {
    const user = userEvent.setup();
    const exportDeferred = deferred<{ destination: string; bytes: number; files: number }>();
    let cancelRequested = false;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      export_markdown: () => exportDeferred.promise,
      cancel_operation: async () => { cancelRequested = true; return await base.choose_workspace(); },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(await screen.findByRole('button', { name: 'Export Markdown' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel operation' }));
    expect(cancelRequested).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Cancellation requested');
    exportDeferred.resolve({ destination: '/workspace/patchwork/context.md', bytes: 12, files: 1 });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Cancellation requested'));
  });

  it('surfaces command errors without hiding the workspace', async () => {
    const user = userEvent.setup();
    const bridge = createBrowserBridge({ failExport: true });
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(await screen.findByRole('button', { name: 'Export Markdown' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('fixture export failed');
    expect(screen.getByText('/workspace/patchwork')).toBeInTheDocument();
  });

  it('ignores an older preview response after a newer file has been selected', async () => {
    const user = userEvent.setup();
    const oldPreview = deferred<{ text: string; truncated: boolean }>();
    const newPreview = deferred<{ text: string; truncated: boolean }>();
    const bridge = {
      ...createBrowserBridge(),
      preview_file: ({ path }: { path: string }) => path === 'README.md' ? oldPreview.promise : newPreview.promise,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Preview README.md' }));
    await user.click(screen.getByRole('button', { name: 'Expand src' }));
    await user.click(screen.getByRole('button', { name: 'Preview src/main.ts' }));

    newPreview.resolve({ text: 'newer source', truncated: false });
    expect(await screen.findByText('newer source')).toBeInTheDocument();
    oldPreview.resolve({ text: 'stale source', truncated: false });
    expect(await screen.findByText('newer source')).toBeInTheDocument();
    expect(screen.queryByText('stale source')).not.toBeInTheDocument();
  });

  it('does not let an older workspace response replace a later folder choice', async () => {
    const user = userEvent.setup();
    const staleRefresh = deferred<Awaited<ReturnType<ReturnType<typeof createBrowserBridge>['refresh_workspace']>>>();
    const base = createBrowserBridge();
    let chooseCount = 0;
    const bridge = {
      ...base,
      choose_workspace: async () => {
        chooseCount += 1;
        const view = await base.choose_workspace();
        return view && chooseCount > 1 ? { ...view, root: '/workspace/new-folder' } : view;
      },
      refresh_workspace: () => staleRefresh.promise,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await screen.findByText('/workspace/patchwork');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('button', { name: 'Change folder' }));
    await screen.findByText('/workspace/new-folder');
    staleRefresh.resolve({ ...(await base.choose_workspace())!, root: '/workspace/patchwork', generation: 2 });
    expect(await screen.findByText('/workspace/new-folder')).toBeInTheDocument();
    expect(screen.queryByText('/workspace/patchwork')).not.toBeInTheDocument();
  });

  it('renders a bounded tree DOM for ten thousand entries and scrolls to later files', async () => {
    const user = userEvent.setup();
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      path: `file-${String(index).padStart(5, '0')}.ts`, kind: 'file' as const, size: 16, selected: false,
      forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: false,
    }));
    const largeWorkspace: WorkspaceView = {
      root: '/workspace/large', generation: 1, entries, entryCount: entries.length, nextOffset: null, selectedCount: 0, estimatedBytes: 0, incomplete: false, diagnostics: [],
      policy: { gitignore: true, includeExtensions: [], includePaths: [], excludePaths: [] },
    };
    const bridge = { ...createBrowserBridge(), choose_workspace: async () => largeWorkspace };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    const tree = screen.getByRole('tree', { name: 'Workspace files' });
    await waitFor(() => expect(tree.querySelectorAll('[role="treeitem"]').length).toBeLessThan(40));
    expect(within(tree).getByText('file-00000.ts')).toBeInTheDocument();
    expect(tree.querySelector('[role="treeitem"]')).toHaveAttribute('tabindex', '0');
    const focusedRow = within(tree).getByRole('button', { name: 'Preview file-00000.ts' });
    focusedRow.focus();

    tree.scrollTop = 319_900;
    fireEvent.scroll(tree);
    await waitFor(() => expect(within(tree).getByText('file-09999.ts')).toBeInTheDocument());
    expect(tree.querySelectorAll('[role="treeitem"]').length).toBeLessThan(40);
    expect(within(tree).getByRole('button', { name: 'Preview file-00000.ts' })).toBeInTheDocument();
    expect(document.activeElement).toBe(focusedRow);

    await user.keyboard('{End}');
    await waitFor(() => expect(tree.querySelector('[role="treeitem"]:focus .entry-name')).toHaveTextContent('file-09999.ts'));
    await user.keyboard('{Home}');
    await waitFor(() => expect(tree.querySelector('[role="treeitem"]:focus .entry-name')).toHaveTextContent('file-00000.ts'));

    await user.keyboard('{ArrowUp}');
    const search = screen.getByRole('textbox', { name: 'Search files' });
    search.focus();
    fireEvent.change(search, { target: { value: 'file-' } });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it('shows string errors returned by native commands', async () => {
    const user = userEvent.setup();
    const bridge = { ...createBrowserBridge(), export_markdown: async () => { throw 'Native export rejected'; } };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(await screen.findByRole('button', { name: 'Export Markdown' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Native export rejected');
  });

  it('hydrates saved policy on folder open and keeps edits until Apply is accepted', async () => {
    const user = userEvent.setup();
    const savedPolicy: FilterPolicy = { gitignore: false, includeExtensions: ['.md'], includePaths: ['docs/**'], excludePaths: ['dist/**'] };
    const nextPolicy: FilterPolicy = { gitignore: true, includeExtensions: ['.rs'], includePaths: ['core/**'], excludePaths: ['build/**'] };
    const base = createBrowserBridge();
    const initial = { ...(await base.choose_workspace())!, policy: savedPolicy };
    let folderChoice = 0;
    const bridge = {
      ...base,
      choose_workspace: async () => {
        folderChoice += 1;
        return folderChoice === 1 ? initial : { ...initial, root: '/workspace/next', policy: nextPolicy };
      },
      set_intent: async () => initial,
      set_policy: async ({ policy }: { policy: FilterPolicy }) => ({ ...initial, policy }),
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('checkbox', { name: 'Respect .gitignore' })).not.toBeChecked();
    const includeExtensions = screen.getByLabelText('Include extensions');
    expect(includeExtensions).toHaveValue('.md');
    expect(screen.queryByLabelText('Exclude extensions')).not.toBeInTheDocument();

    await user.clear(includeExtensions);
    await user.type(includeExtensions, '.tsx');
    await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));
    expect(includeExtensions).toHaveValue('.tsx');
    expect(screen.getByLabelText('Exclude paths')).toHaveValue('dist/**');

    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByRole('textbox', { name: 'Include extensions' })).toHaveValue('.tsx');
    expect(screen.getByLabelText('Include paths')).toHaveValue('docs/**');
    expect(screen.getByLabelText('Exclude paths')).toHaveValue('dist/**');

    await user.click(screen.getByRole('button', { name: 'Change folder' }));
    expect(await screen.findByText('/workspace/next')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Respect .gitignore' })).toBeChecked();
    expect(screen.getByLabelText('Include extensions')).toHaveValue('.rs');
    expect(screen.getByLabelText('Include paths')).toHaveValue('core/**');
    expect(screen.getByLabelText('Exclude paths')).toHaveValue('build/**');
  });
});
