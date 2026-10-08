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

    expect(screen.getByRole('heading', { name: 'Select code. Export context.' })).toBeInTheDocument();
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

  it('keeps the empty workspace on picker cancellation', async () => {
    const user = userEvent.setup();
    const bridge = createBrowserBridge({ cancelPicker: true });
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(screen.getByText('No folder open')).toBeInTheDocument();
  });

  it('cancels a pending workspace restore and ignores its late result', async () => {
    const user = userEvent.setup();
    const restoreDeferred = deferred<Awaited<ReturnType<ReturnType<typeof createBrowserBridge>['restore_workspace']>>>();
    const base = createBrowserBridge();
    let cancelRequested = false;
    const bridge = {
      ...base,
      restore_workspace: () => restoreDeferred.promise,
      cancel_operation: async () => { cancelRequested = true; },
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
    expect(await screen.findByRole('status')).toHaveTextContent('Export ready');
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

  it('resets all selection intent separately from resetting a path override', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));
    expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset selections' }));
    expect(await screen.findByText('3', { selector: 'strong' })).toBeInTheDocument();
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

  it('offers an explicit cancel action for a running export', async () => {
    const user = userEvent.setup();
    const exportDeferred = deferred<{ destination: string; bytes: number; files: number }>();
    let cancelRequested = false;
    const bridge = {
      ...createBrowserBridge(),
      export_markdown: () => exportDeferred.promise,
      cancel_operation: async () => { cancelRequested = true; },
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
      forceIncluded: false, reason: null, enumerated: true, partial: false,
    }));
    const largeWorkspace: WorkspaceView = {
      root: '/workspace/large', generation: 1, entries, selectedCount: 0, estimatedBytes: 0, incomplete: false, diagnostics: [],
      policy: { gitignore: true, includeExtensions: [], excludeExtensions: [], includePaths: [], excludePaths: [] },
    };
    const bridge = { ...createBrowserBridge(), choose_workspace: async () => largeWorkspace };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    const tree = screen.getByRole('tree', { name: 'Workspace files' });
    await waitFor(() => expect(tree.querySelectorAll('[role="treeitem"]').length).toBeLessThan(40));
    expect(within(tree).getByText('file-00000.ts')).toBeInTheDocument();
    const focusedRow = within(tree).getByRole('button', { name: 'Preview file-00000.ts' });
    focusedRow.focus();

    tree.scrollTop = 319_900;
    fireEvent.scroll(tree);
    await waitFor(() => expect(within(tree).getByText('file-09999.ts')).toBeInTheDocument());
    expect(tree.querySelectorAll('[role="treeitem"]').length).toBeLessThan(40);
    expect(within(tree).getByRole('button', { name: 'Preview file-00000.ts' })).toBeInTheDocument();
    expect(document.activeElement).toBe(focusedRow);
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
    const savedPolicy: FilterPolicy = { gitignore: false, includeExtensions: ['.md'], excludeExtensions: ['.png'], includePaths: ['docs/**'], excludePaths: ['dist/**'] };
    const nextPolicy: FilterPolicy = { gitignore: true, includeExtensions: ['.rs'], excludeExtensions: ['.tmp'], includePaths: ['core/**'], excludePaths: ['build/**'] };
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
    expect(screen.getByLabelText('Exclude extensions')).toHaveValue('.png');

    await user.clear(includeExtensions);
    await user.type(includeExtensions, '.tsx');
    await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));
    expect(includeExtensions).toHaveValue('.tsx');
    expect(screen.getByLabelText('Exclude paths')).toHaveValue('dist/**');

    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(await screen.findByRole('textbox', { name: 'Include extensions' })).toHaveValue('.tsx');
    expect(screen.getByLabelText('Exclude extensions')).toHaveValue('.png');
    expect(screen.getByLabelText('Include paths')).toHaveValue('docs/**');
    expect(screen.getByLabelText('Exclude paths')).toHaveValue('dist/**');

    await user.click(screen.getByRole('button', { name: 'Change folder' }));
    expect(await screen.findByText('/workspace/next')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Respect .gitignore' })).toBeChecked();
    expect(screen.getByLabelText('Include extensions')).toHaveValue('.rs');
    expect(screen.getByLabelText('Exclude extensions')).toHaveValue('.tmp');
    expect(screen.getByLabelText('Include paths')).toHaveValue('core/**');
    expect(screen.getByLabelText('Exclude paths')).toHaveValue('build/**');
  });
});
