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
    expect(status).toHaveTextContent('Export ready');
    expect(status).toBeVisible();
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
    expect(screen.getByText('Use <none> to select files with no extension.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(submittedPolicies.at(-1)?.includeExtensions).toEqual(['']);

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('textbox', { name: 'Include extensions' })).toHaveValue('<none>');
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
      { path: 'first.ts', kind: 'file', size: 1, selected: true, forceIncluded: false, reason: null, enumerated: true, partial: false },
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
    const oldView = { ...(await base.choose_workspace())!, entries: [{ path: 'old-first.ts', kind: 'file' as const, size: 1, selected: true, forceIncluded: false, reason: null, enumerated: true, partial: false }], entryCount: 2, nextOffset: 1 };
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
    const policyB: FilterPolicy = { gitignore: false, includeExtensions: ['.b'], excludeExtensions: [], includePaths: ['b/**'], excludePaths: [] };
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
    await user.click(screen.getByRole('button', { name: 'Close filters' }));
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
      forceIncluded: false, reason: null, enumerated: true, partial: false,
    }));
    const largeWorkspace: WorkspaceView = {
      root: '/workspace/large', generation: 1, entries, entryCount: entries.length, nextOffset: null, selectedCount: 0, estimatedBytes: 0, incomplete: false, diagnostics: [],
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
