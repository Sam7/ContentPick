import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createBrowserBridge, type FilterPolicy, type TokenEstimate, type WatchHealth, type WorkspaceView } from './bridge';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(() => cleanup());

describe('ContextPick workspace UI', () => {
  it('opens a synthetic workspace and exposes a bounded file preview', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} fixtureMode />);

    expect(screen.getByLabelText('Workspace toolbar')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'ContextPick' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Select code. Export context.' })).not.toBeInTheDocument();
    expect(screen.getByText('No folder open')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    expect(screen.getByTitle('Automatic file watching is unavailable in this browser fixture. Refresh after changing files.')).toBeInTheDocument();
    const rootRows = Array.from(screen.getByRole('tree', { name: 'Workspace files' }).querySelectorAll('[role="treeitem"][aria-level="1"] .entry-name')).map((node) => node.textContent);
    expect(rootRows).toEqual(['src', 'assets', 'dist', 'README.md']);
    await user.click(screen.getByRole('button', { name: 'Preview README.md' }));
    expect(await screen.findByText(/^# Patchwork/)).toBeInTheDocument();
    expect(await screen.findByText('≈ 1,234')).toBeInTheDocument();
    expect(screen.getByText('o200k_base · approximate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approximate local o200k_base count; file sections are counted independently.' })).toBeInTheDocument();
  });

  it('keeps output blocked after refresh until watcher listener registration recovers', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const watching: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    let subscriptions = 0;
    const bridge = {
      ...base,
      get_watch_status: async () => watching,
      on_watch_status: async () => {
        subscriptions += 1;
        if (subscriptions < 3) throw new Error('watch listener unavailable');
        return () => {};
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));

    expect(await screen.findByText('Status unavailable')).toBeInTheDocument();
    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(subscriptions).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(subscriptions).toBe(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled());
  });

  it('keeps output blocked for a newly selected root until its watcher is verified', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const first = await base.choose_workspace();
    const second = { ...first!, root: '/workspace/second', generation: 2 };
    const firstHealth: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    const secondHealth: WatchHealth = { root: '/workspace/second', epoch: 2, revision: 1, state: 'watching', message: null };
    const secondSubscription = deferred<() => void>();
    let choices = 0;
    let subscriptions = 0;
    const bridge = {
      ...base,
      choose_workspace: async () => ++choices === 1 ? first : second,
      on_watch_status: async () => {
        subscriptions += 1;
        if (subscriptions === 2) return secondSubscription.promise;
        return () => {};
      },
      get_watch_status: async () => choices < 2 ? firstHealth : secondHealth,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Change folder' }));
    expect(await screen.findByText('/workspace/second')).toBeInTheDocument();
    await waitFor(() => expect(subscriptions).toBe(2));
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByText('Stale')).toBeInTheDocument();

    await act(async () => secondSubscription.resolve(() => {}));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled());
  });

  it('blocks output when the initial watcher status is missing', async () => {
    const user = userEvent.setup();
    const bridge = {
      ...createBrowserBridge(),
      get_watch_status: async () => null,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));

    expect(await screen.findByText('Status unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('keeps workspace actions responsive and hides a late estimate when the watcher becomes stale', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const pending = deferred<TokenEstimate>();
    const requests: { generation: number; requestId: string }[] = [];
    const cancelled: { generation: number; requestId: string }[] = [];
    let notify!: (health: WatchHealth) => void;
    const watching: WatchHealth = { root: '/workspace/patchwork', epoch: 3, revision: 1, state: 'watching', message: null };
    const bridge = {
      ...base,
      get_watch_status: async () => watching,
      on_watch_status: async (handler: (health: WatchHealth) => void) => { notify = handler; return () => {}; },
      estimate_tokens: (args: { generation: number; requestId: string }) => { requests.push(args); return pending.promise; },
      cancel_token_estimate: async (args: { generation: number; requestId: string }) => { cancelled.push(args); },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(screen.getByText('Calculating…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy context' })).toBeEnabled());
    await waitFor(() => expect(notify).toBeTypeOf('function'));

    act(() => notify({ ...watching, revision: 2, state: 'stale', message: 'Files changed.' }));
    expect(await screen.findByText('Stale')).toBeInTheDocument();
    await waitFor(() => expect(cancelled).toContainEqual(requests[0]));
    await act(async () => pending.resolve({
      requestId: requests[0].requestId,
      generation: requests[0].generation,
      tokens: 8_765,
      files: 3,
      reusedFiles: 0,
      computedFiles: 3,
      tokenizerId: 'o200k_base',
    }));
    expect(screen.queryByText('≈ 8,765')).not.toBeInTheDocument();
    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('ignores out-of-order token responses after selection changes', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const pending: ReturnType<typeof deferred<TokenEstimate>>[] = [];
    const requests: { generation: number; requestId: string }[] = [];
    const bridge = {
      ...base,
      estimate_tokens: (args: { generation: number; requestId: string }) => {
        requests.push(args);
        const next = deferred<TokenEstimate>();
        pending.push(next);
        return next.promise;
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await user.click(await screen.findByRole('checkbox', { name: 'Select README.md' }));
    await waitFor(() => expect(requests).toHaveLength(2));

    await act(async () => pending[1].resolve({
      requestId: requests[1].requestId, generation: requests[1].generation,
      tokens: 4_321, files: 2, reusedFiles: 1, computedFiles: 1, tokenizerId: 'o200k_base',
    }));
    expect(await screen.findByText('≈ 4,321')).toBeInTheDocument();
    await act(async () => pending[0].resolve({
      requestId: requests[0].requestId, generation: requests[0].generation,
      tokens: 9_999, files: 3, reusedFiles: 0, computedFiles: 3, tokenizerId: 'o200k_base',
    }));
    expect(screen.getByText('≈ 4,321')).toBeInTheDocument();
    expect(screen.queryByText('≈ 9,999')).not.toBeInTheDocument();
  });

  it('marks a mismatched token response unavailable instead of calculating forever', async () => {
    const user = userEvent.setup();
    const bridge = {
      ...createBrowserBridge(),
      estimate_tokens: async () => ({
        requestId: 'wrong-request', generation: 0, tokens: 1, files: 1,
        reusedFiles: 0, computedFiles: 1, tokenizerId: 'o200k_base',
      }),
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));

    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Calculating…')).not.toBeInTheDocument();
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

  it('marks the matching workspace stale on watcher changes and refresh restores actions', async () => {
    const user = userEvent.setup();
    let notify!: (health: WatchHealth) => void;
    let refreshed = false;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => ({ root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching' as const, message: null }),
      on_watch_status: async (handler: (health: WatchHealth) => void) => { notify = handler; return () => {}; },
      refresh_workspace: async () => {
        refreshed = true;
        const result = await base.refresh_workspace();
        notify({ root: '/workspace/patchwork', epoch: 1, revision: 3, state: 'watching', message: null });
        return result;
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    notify({ root: '/workspace/patchwork', epoch: 1, revision: 2, state: 'stale', message: 'Files changed on disk.' });
    expect(await screen.findByText('Files changed')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Files changed on disk.');
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select README.md' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(refreshed).toBe(true));
    expect(await screen.findByRole('button', { name: 'Export Markdown' })).toBeEnabled();
  });

  it('automatically debounces a watcher invalidation into an authoritative refresh', async () => {
    const user = userEvent.setup();
    let notify!: (health: WatchHealth) => void;
    let health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    let refreshCount = 0;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => health,
      on_watch_status: async (handler: (health: WatchHealth) => void) => { notify = handler; return () => {}; },
      refresh_workspace: async () => {
        refreshCount += 1;
        health = { ...health, revision: 3, state: 'watching', message: null };
        return await base.refresh_workspace();
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    expect(await screen.findByText('Watching')).toBeInTheDocument();

    notify({ ...health, revision: 2, state: 'stale', message: 'Files changed on disk.' });
    expect(await screen.findByText('Files changed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    await waitFor(() => expect(refreshCount).toBe(1), { timeout: 3_000 });
    expect(await screen.findByText('Watching')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
  });

  it('revalidates once after returning focus and coalesces repeated focus loss into one refresh', async () => {
    const user = userEvent.setup();
    let notify!: (health: WatchHealth) => void;
    let regainFocus!: () => void;
    let health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    let revalidationCount = 0;
    let refreshCount = 0;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => health,
      on_watch_status: async (handler: (next: WatchHealth) => void) => { notify = handler; return () => {}; },
      on_window_focus: async (handler: () => void) => { regainFocus = handler; return () => {}; },
      request_focus_reconcile: async (root: string) => {
        expect(root).toBe('/workspace/patchwork');
        revalidationCount += 1;
        health = { ...health, revision: health.revision + 1, state: 'stale', message: 'Workspace revalidation requested.' };
        notify(health);
        return health;
      },
      refresh_workspace: async () => {
        refreshCount += 1;
        health = { ...health, revision: health.revision + 1, state: 'watching', message: null };
        return await base.refresh_workspace();
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    expect(await screen.findByText('Watching')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Search files' }), 'README');
    expect(revalidationCount).toBe(0);
    expect(refreshCount).toBe(0);

    await act(async () => { regainFocus(); regainFocus(); regainFocus(); });

    await waitFor(() => expect(revalidationCount).toBe(3));
    await waitFor(() => expect(refreshCount).toBe(1), { timeout: 3_000 });
    expect(await screen.findByText('Watching')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select README.md' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
  });

  it('defers focus-triggered revalidation until an active output operation settles', async () => {
    const user = userEvent.setup();
    const pendingCopy = deferred<{ destination: string; bytes: number; files: number }>();
    let notify!: (health: WatchHealth) => void;
    let regainFocus!: () => void;
    let health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    let revalidationCount = 0;
    let refreshCount = 0;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => health,
      on_watch_status: async (handler: (next: WatchHealth) => void) => { notify = handler; return () => {}; },
      on_window_focus: async (handler: () => void) => { regainFocus = handler; return () => {}; },
      copy_markdown: () => pendingCopy.promise,
      request_focus_reconcile: async () => {
        revalidationCount += 1;
        health = { ...health, revision: health.revision + 1, state: 'stale', message: 'Workspace revalidation requested.' };
        notify(health);
        return health;
      },
      refresh_workspace: async () => {
        refreshCount += 1;
        health = { ...health, revision: health.revision + 1, state: 'watching', message: null };
        return await base.refresh_workspace();
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy context' }));
    expect(await screen.findByRole('button', { name: 'Cancel operation' })).toBeInTheDocument();

    await act(async () => { regainFocus(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled());
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(revalidationCount).toBe(0);
    expect(refreshCount).toBe(0);

    pendingCopy.resolve({ destination: 'clipboard', bytes: 12, files: 1 });
    await waitFor(() => expect(revalidationCount).toBe(1));
    await waitFor(() => expect(refreshCount).toBe(1), { timeout: 3_000 });
    expect(await screen.findByText('Watching')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
  });

  it('keeps confirmed export valid while native destination dialogs hold focus', async () => {
    const user = userEvent.setup();
    const pendingExport = deferred<{ destination: string; bytes: number; files: number } | null>();
    let notify!: (health: WatchHealth) => void;
    let regainFocus!: () => void;
    let health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    let revalidationCount = 0;
    let refreshCount = 0;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => health,
      on_watch_status: async (handler: (next: WatchHealth) => void) => { notify = handler; return () => {}; },
      on_window_focus: async (handler: () => void) => { regainFocus = handler; return () => {}; },
      export_markdown: async () => ({
        confirmationRequired: true as const,
        ticket: 'native-dialog-ticket',
        summary: { total: 1, omitted: 0, warnings: [{ path: '.env', category: 'environmentFile' as const }] },
      }),
      confirm_sensitive_output: () => pendingExport.promise,
      request_focus_reconcile: async () => {
        revalidationCount += 1;
        health = { ...health, revision: health.revision + 1, state: 'stale', message: 'Workspace revalidation requested.' };
        notify(health);
        return health;
      },
      refresh_workspace: async () => {
        refreshCount += 1;
        health = { ...health, revision: health.revision + 1, state: 'watching', message: null };
        return await base.refresh_workspace();
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export Markdown' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Export' }));
    expect(await screen.findByRole('button', { name: 'Cancel operation' })).toBeInTheDocument();

    await act(async () => { regainFocus(); });
    await waitFor(() => expect(screen.getByRole('button', { name: /Preparing/ })).toBeDisabled());
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(revalidationCount).toBe(0);
    expect(refreshCount).toBe(0);

    pendingExport.resolve({ destination: '/workspace/patchwork/context.md', bytes: 16, files: 1 });
    await waitFor(() => expect(revalidationCount).toBe(1));
    await waitFor(() => expect(refreshCount).toBe(1), { timeout: 3_000 });
    expect(screen.getByRole('status')).toHaveTextContent('Export ready · 1 files · 16 B · /workspace/patchwork/context.md');
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
  });

  it.each([
    ['missing', async (): Promise<WatchHealth | null> => null],
    ['failed', async (): Promise<WatchHealth | null> => { throw new Error('Focus status request failed.'); }],
  ])('keeps the workspace unavailable when focus status is %s', async (_case, requestFocusReconcile) => {
    const user = userEvent.setup();
    let regainFocus!: () => void;
    const health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => health,
      on_window_focus: async (handler: () => void) => { regainFocus = handler; return () => {}; },
      request_focus_reconcile: requestFocusReconcile,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();

    await act(async () => { regainFocus(); });

    expect(await screen.findByText('Status unavailable', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    if (_case === 'failed') await expect(screen.findByRole('alert')).resolves.toHaveTextContent('Focus status request failed.');
  });

  it('keeps the workspace unavailable when status cannot be read after refresh', async () => {
    const user = userEvent.setup();
    const health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    let statusCalls = 0;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => ++statusCalls === 1 ? health : null,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Status unavailable', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
  });

  it('keeps actions disabled when a watching event races a missing focus status response', async () => {
    const user = userEvent.setup();
    const focusResponse = deferred<WatchHealth | null>();
    let notify!: (health: WatchHealth) => void;
    let regainFocus!: () => void;
    const health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => health,
      on_watch_status: async (handler: (next: WatchHealth) => void) => { notify = handler; return () => {}; },
      on_window_focus: async (handler: () => void) => { regainFocus = handler; return () => {}; },
      request_focus_reconcile: () => focusResponse.promise,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    await act(async () => { regainFocus(); });
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();

    await act(async () => { notify({ ...health, revision: 2, state: 'watching', message: null }); });
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
    await act(async () => { focusResponse.resolve(null); });

    expect(await screen.findByText('Status unavailable', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
  });

  it('keeps actions disabled when a watching event races a missing status response after refresh', async () => {
    const user = userEvent.setup();
    const statusResponse = deferred<WatchHealth | null>();
    let notify!: (health: WatchHealth) => void;
    let statusCalls = 0;
    const health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => ++statusCalls === 1 ? health : statusResponse.promise,
      on_watch_status: async (handler: (next: WatchHealth) => void) => { notify = handler; return () => {}; },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(statusCalls).toBe(2));

    await act(async () => {
      notify({ ...health, revision: 2, state: 'watching', message: null });
      statusResponse.resolve(null);
    });

    expect(await screen.findByText('Status unavailable', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('defers automatic refresh until pending copy, export, and workspace work settles', async () => {
    const base = createBrowserBridge();
    const excludedWorkspace = await base.set_intent({ path: 'README.md', intent: 'exclude' });

    for (const operation of ['copy', 'export', 'workspace'] as const) {
      const user = userEvent.setup();
      const pendingCopy = deferred<{ destination: string; bytes: number; files: number }>();
      const pendingExport = deferred<{ destination: string; bytes: number; files: number }>();
      const pendingWorkspace = deferred<WorkspaceView>();
      let notify!: (health: WatchHealth) => void;
      let health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
      let refreshCount = 0;
      const bridge = {
        ...base,
        get_watch_status: async () => health,
        on_watch_status: async (handler: (next: WatchHealth) => void) => { notify = handler; return () => {}; },
        copy_markdown: () => pendingCopy.promise,
        export_markdown: () => pendingExport.promise,
        set_intent: () => pendingWorkspace.promise,
        refresh_workspace: async () => {
          refreshCount += 1;
          health = { ...health, revision: 3, state: 'watching', message: null };
          return await base.refresh_workspace();
        },
      };
      render(<App bridge={bridge} />);
      await user.click(screen.getByRole('button', { name: 'Open folder' }));
      expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
      expect(await screen.findByText('Watching')).toBeInTheDocument();

      if (operation === 'copy') await user.click(screen.getByRole('button', { name: 'Copy context' }));
      else if (operation === 'export') await user.click(screen.getByRole('button', { name: 'Export Markdown' }));
      else await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));
      if (operation === 'workspace') await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Select README.md' })).toBeDisabled());
      else expect(await screen.findByRole('button', { name: 'Cancel operation' })).toBeInTheDocument();

      notify({ ...health, revision: 2, state: 'stale', message: 'Files changed while work was active.' });
      expect(await screen.findByText('Files changed')).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(refreshCount).toBe(0);

      if (operation === 'copy') pendingCopy.resolve({ destination: 'clipboard', bytes: 12, files: 1 });
      else if (operation === 'export') pendingExport.resolve({ destination: 'context.md', bytes: 12, files: 1 });
      else pendingWorkspace.resolve(excludedWorkspace);

      await waitFor(() => expect(refreshCount).toBe(1), { timeout: 3_000 });
      expect(await screen.findByText('Watching')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy context' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
      cleanup();
    }
  });

  it('keeps a failed automatic refresh stale and does not retry the same watcher revision', async () => {
    const user = userEvent.setup();
    let notify!: (health: WatchHealth) => void;
    const health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    let refreshCount = 0;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => health,
      on_watch_status: async (handler: (next: WatchHealth) => void) => { notify = handler; return () => {}; },
      refresh_workspace: async () => {
        refreshCount += 1;
        throw new Error('automatic refresh failed');
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    expect(await screen.findByText('Watching')).toBeInTheDocument();

    notify({ ...health, revision: 2, state: 'stale', message: 'Files changed on disk.' });
    expect(await screen.findByText('Files changed')).toBeInTheDocument();
    await waitFor(() => expect(refreshCount).toBe(1), { timeout: 3_000 });
    expect(await screen.findByRole('alert')).toHaveTextContent('automatic refresh failed');
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(refreshCount).toBe(1);
    expect(screen.getByText('Files changed')).toBeInTheDocument();
  });

  it('coalesces newer watcher revisions during auto refresh into one follow-up refresh', async () => {
    const user = userEvent.setup();
    const firstRefresh = deferred<WorkspaceView>();
    const followUpRefresh = deferred<WorkspaceView>();
    let notify!: (health: WatchHealth) => void;
    let health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    let refreshCount = 0;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => health,
      on_watch_status: async (handler: (next: WatchHealth) => void) => { notify = handler; return () => {}; },
      refresh_workspace: () => {
        refreshCount += 1;
        return refreshCount === 1 ? firstRefresh.promise : followUpRefresh.promise;
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    expect(await screen.findByText('Watching')).toBeInTheDocument();

    health = { ...health, revision: 2, state: 'stale', message: 'First change.' };
    notify(health);
    await waitFor(() => expect(refreshCount).toBe(1), { timeout: 3_000 });

    health = { ...health, revision: 3, message: 'Second change during refresh.' };
    notify(health);
    health = { ...health, revision: 4, message: 'Third change during refresh.' };
    notify(health);
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();

    firstRefresh.resolve(await base.refresh_workspace());
    await waitFor(() => expect(refreshCount).toBe(2), { timeout: 3_000 });

    health = { ...health, revision: 5, state: 'watching', message: null };
    followUpRefresh.resolve(await base.refresh_workspace());
    expect(await screen.findByText('Watching')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
    expect(refreshCount).toBe(2);
  });

  it('does not treat a successful scan as fresh while watcher health remains at the same stale revision', async () => {
    const user = userEvent.setup();
    let notify!: (health: WatchHealth) => void;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => ({ root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching' as const, message: null }),
      on_watch_status: async (handler: (health: WatchHealth) => void) => { notify = handler; return () => {}; },
      refresh_workspace: async () => await base.refresh_workspace(),
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    notify({ root: '/workspace/patchwork', epoch: 1, revision: 2, state: 'stale', message: 'A newer edit is still pending.' });
    expect(await screen.findByText('Files changed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('A newer edit is still pending.');
  });

  it('trusts the authoritative fresh status when a pre-scan stale event arrives during refresh', async () => {
    const user = userEvent.setup();
    const refresh = deferred<WorkspaceView>();
    let currentHealth: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    let notify!: (health: WatchHealth) => void;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => currentHealth,
      on_watch_status: async (handler: (health: WatchHealth) => void) => { notify = handler; return () => {}; },
      refresh_workspace: () => refresh.promise,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    currentHealth = { ...currentHealth, revision: 2, state: 'stale', message: 'The scan is reconciling this change.' };
    notify(currentHealth);
    currentHealth = { ...currentHealth, revision: 3, state: 'watching', message: null };
    refresh.resolve(await base.refresh_workspace());

    expect(await screen.findByRole('button', { name: 'Export Markdown' })).toBeEnabled();
    expect(screen.getByText('Watching', { exact: true })).toBeInTheDocument();
  });

  it('ignores watcher status for another root and older watcher epochs', async () => {
    const user = userEvent.setup();
    let notify!: (health: WatchHealth) => void;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => ({ root: '/workspace/patchwork', epoch: 4, revision: 1, state: 'watching' as const, message: null }),
      on_watch_status: async (handler: (health: WatchHealth) => void) => { notify = handler; return () => {}; },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    notify({ root: '/workspace/other', epoch: 5, revision: 2, state: 'stale', message: 'Other root changed.' });
    notify({ root: '/workspace/patchwork', epoch: 3, revision: 2, state: 'stale', message: 'Old watcher activation.' });
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
    expect(screen.queryByText('Files changed')).not.toBeInTheDocument();
  });

  it('does not let an older same-epoch status snapshot overwrite a newer dirty event', async () => {
    const user = userEvent.setup();
    const snapshot = deferred<WatchHealth | null>();
    const queryStarted = deferred<void>();
    let notify!: (health: WatchHealth) => void;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: () => { queryStarted.resolve(); return snapshot.promise; },
      on_watch_status: async (handler: (health: WatchHealth) => void) => { notify = handler; return () => {}; },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    await queryStarted.promise;

    notify({ root: '/workspace/patchwork', epoch: 1, revision: 2, state: 'stale', message: 'Files changed after the snapshot.' });
    snapshot.resolve({ root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null });

    expect(await screen.findByText('Files changed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('retains a new-root watcher event received before its catch-up snapshot', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const firstWorkspace = await base.choose_workspace();
    const secondWorkspace = { ...firstWorkspace!, root: '/workspace/second', generation: 2 };
    let chooseCount = 0;
    let listenerCount = 0;
    let health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    const bridge = {
      ...base,
      choose_workspace: async () => {
        chooseCount += 1;
        if (chooseCount === 1) return firstWorkspace;
        health = { root: '/workspace/second', epoch: 2, revision: 1, state: 'stale', message: 'The new workspace has pending changes.' };
        return secondWorkspace;
      },
      get_watch_status: async () => health,
      on_watch_status: async (handler: (health: WatchHealth) => void) => {
        listenerCount += 1;
        if (listenerCount === 2) handler(health);
        return () => {};
      },
      refresh_workspace: async () => ({ ...secondWorkspace, generation: 3 }),
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change folder' }));
    expect(await screen.findByText('/workspace/second')).toBeInTheDocument();
    expect(await screen.findByText('Files changed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('keeps a cancelled operation stale when watcher invalidation arrives before its snapshot', async () => {
    const user = userEvent.setup();
    const cancellation = deferred<WorkspaceView | null>();
    let notify!: (health: WatchHealth) => void;
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      get_watch_status: async () => ({ root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching' as const, message: null }),
      on_watch_status: async (handler: (health: WatchHealth) => void) => { notify = handler; return () => {}; },
      export_markdown: () => new Promise<{ destination: string; bytes: number; files: number }>(() => undefined),
      cancel_operation: () => cancellation.promise,
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('/workspace/patchwork')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export Markdown' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel operation' }));
    notify({ root: '/workspace/patchwork', epoch: 1, revision: 2, state: 'stale', message: 'Files changed during cancellation.' });
    cancellation.resolve(await base.choose_workspace());

    expect(await screen.findByText('Files changed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
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
    await user.click(screen.getByRole('radio', { name: 'Selected extensions' }));
    await user.click(screen.getByRole('checkbox', { name: '.md' }));
    await waitFor(() => expect(within(estimates).getByText('1', { selector: 'strong' })).toBeInTheDocument());
    expect(within(estimates).getByText('≈ 923 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));

    expect(within(estimates).getByText('0', { selector: 'strong' })).toBeInTheDocument();
    expect(within(estimates).getByText('≈ 0 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy context' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
    expect(within(estimates).getByText('≈ 0')).toBeInTheDocument();
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

  it('shows saved selection profiles in local workspace settings', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    expect(await screen.findByRole('heading', { name: 'Selection profiles' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Saved profile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load profile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as profile' })).toBeInTheDocument();
  });

  it('loads, updates, renames, deletes, and creates saved selection profiles', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const profile = screen.getByRole('combobox', { name: 'Saved profile' });

    expect(screen.getByText('Rust', { selector: 'strong' })).toBeInTheDocument();
    await user.selectOptions(profile, 'Documentation');
    await user.click(screen.getByRole('button', { name: 'Load profile' }));
    expect(await screen.findByText('Documentation', { selector: 'strong' })).toBeInTheDocument();

    await user.selectOptions(profile, 'Rust');
    await user.click(screen.getByRole('button', { name: 'Update profile' }));
    expect(await screen.findByText('Rust', { selector: 'strong' })).toBeInTheDocument();

    await user.selectOptions(profile, 'Documentation');
    const rename = screen.getByRole('textbox', { name: 'Rename selected profile' });
    await user.clear(rename);
    await user.type(rename, 'Guides');
    await user.click(screen.getByRole('button', { name: 'Rename profile' }));
    await waitFor(() => expect(profile).toHaveValue('Guides'));
    expect(screen.getByRole('option', { name: 'Guides' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete profile' }));
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Guides' })).not.toBeInTheDocument());

    await user.type(screen.getByRole('textbox', { name: 'New profile name' }), 'Notes');
    await user.click(screen.getByRole('button', { name: 'Save as profile' }));
    expect(await screen.findByText('Notes', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Notes' })).toBeInTheDocument();
  });

  it('keeps a pending filter edit alive when loading a saved profile fails', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    let policyCalls = 0;
    const bridge = {
      ...base,
      set_policy: async (args: Parameters<typeof base.set_policy>[0]) => {
        policyCalls += 1;
        return base.set_policy(args);
      },
      load_profile: async () => { throw new Error('Profile could not be loaded.'); },
    };
    render(<App bridge={bridge} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Saved profile' }), 'Documentation');
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(screen.getByRole('checkbox', { name: 'Respect .gitignore' }));
    expect(await screen.findByText('Updating selection and estimates…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Load profile' }));
    expect(await screen.findByText('Profile could not be loaded.')).toBeInTheDocument();
    await waitFor(() => expect(policyCalls).toBe(1), { timeout: 2_000 });
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await waitFor(() => expect(screen.queryByText('Updating selection and estimates…')).not.toBeInTheDocument());
  });

  it('preserves the preview and tree search while loading a profile', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Preview README.md' }));
    expect(await screen.findByText(/^# Patchwork/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand src' }));
    await user.type(screen.getByRole('textbox', { name: 'Search files' }), 'main.ts');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Saved profile' }), 'Documentation');
    await user.click(screen.getByRole('button', { name: 'Load profile' }));

    expect(await screen.findByText(/^# Patchwork/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('textbox', { name: 'Search files' })).toHaveValue('main.ts');
    expect(screen.getByRole('button', { name: 'Preview src/main.ts' })).toBeInTheDocument();
  });

  it('shows Custom when edits diverge from saved profile snapshots', async () => {
    const user = userEvent.setup();
    render(<App bridge={createBrowserBridge()} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select README.md' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    expect(await screen.findByText('Custom', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Rust' })).toBeInTheDocument();
  });

  it('surfaces profile persistence errors without changing the visible catalog', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      create_profile: async () => { throw new Error('Profile storage is unavailable.'); },
    };
    render(<App bridge={bridge} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.type(screen.getByRole('textbox', { name: 'New profile name' }), 'Local notes');
    await user.click(screen.getByRole('button', { name: 'Save as profile' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Profile storage is unavailable.');
    expect(screen.queryByRole('option', { name: 'Local notes' })).not.toBeInTheDocument();
    expect(screen.getByText('Rust', { selector: 'strong' })).toBeInTheDocument();
  });

  it('reopens collapsed filters on the first click and preserves its current policy', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      set_policy: async ({ policy }: { policy: FilterPolicy }) => ({ ...(await base.choose_workspace())!, policy }),
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(screen.getByRole('radio', { name: 'Selected extensions' }));
    await user.click(screen.getByRole('checkbox', { name: '.rs' }));

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    const collapsedFilters = screen.getByRole('button', { name: 'Filters' });
    expect(collapsedFilters).toHaveAttribute('aria-expanded', 'false');
    collapsedFilters.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    const editor = screen.getByRole('region', { name: 'Filter settings' });
    expect(editor).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Selected extensions' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '.rs' })).toBeChecked();
    expect(editor.closest('aside')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('region', { name: 'Filter settings' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '.rs' })).toBeChecked();
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

  it('submits the extensionless choice in Selected extensions mode', async () => {
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

    await user.click(screen.getByRole('radio', { name: 'Selected extensions' }));
    await user.click(screen.getByRole('checkbox', { name: 'No extension' }));
    await waitFor(() => expect(submittedPolicies.at(-1)).toMatchObject({ includeMode: 'selectedExtensions', includeExtensions: [''] }));
    expect(screen.getByRole('checkbox', { name: 'No extension' })).toBeChecked();
  });

  it('shows filters in the main pane and applies edits automatically without resetting selection intent', async () => {
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

    const filterEditor = screen.getByRole('region', { name: 'Filter settings' });
    expect(filterEditor.closest('aside')).not.toBeInTheDocument();
    expect(filterEditor.closest('.file-panel')).toHaveAttribute('aria-label', 'Filter editor');
    expect(screen.queryByRole('button', { name: 'Apply filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tree', { name: 'Workspace files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /extension/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Selected extensions' }));
    expect(screen.getByText('No extensions selected, so no files are eligible.')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '.rs' }));
    await waitFor(() => expect(submittedPolicies.at(-1)).toMatchObject({ includeMode: 'selectedExtensions', includeExtensions: ['.rs'] }));
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(submittedPolicies.at(-1)).toEqual({ gitignore: true, includeMode: 'allText', includeExtensions: [], includePaths: [], excludePaths: [] }));
    expect(submittedPolicies).toHaveLength(2);
    expect(resetSelectionsCalls).toBe(0);
    expect(screen.getByRole('radio', { name: 'All text' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('checkbox', { name: 'Select README.md' })).toBeChecked();
  });

  it('supports selecting a compact set of common extension choices', async () => {
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

    await user.click(screen.getByRole('radio', { name: 'Selected extensions' }));
    await user.click(screen.getByRole('checkbox', { name: '.rs' }));
    await user.click(screen.getByRole('checkbox', { name: '.ts' }));
    await waitFor(() => expect(submittedPolicies.at(-1)).toMatchObject({ includeMode: 'selectedExtensions', includeExtensions: ['.rs', '.ts'] }));
    expect(screen.getByRole('group', { name: 'Text inclusion' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /path/i })).not.toBeInTheDocument();
  });

  it('does not let a pending filter debounce supersede a folder change', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const initial = (await base.choose_workspace())!;
    const nextWorkspace = deferred<WorkspaceView | null>();
    const submittedPolicies: FilterPolicy[] = [];
    let chooseCalls = 0;
    const bridge = {
      ...base,
      choose_workspace: async () => {
        chooseCalls += 1;
        return chooseCalls === 1 ? initial : nextWorkspace.promise;
      },
      set_policy: async ({ policy }: { policy: FilterPolicy }) => {
        submittedPolicies.push(structuredClone(policy));
        return { ...initial, policy };
      },
    };
    render(<App bridge={bridge} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(screen.getByRole('radio', { name: 'Selected extensions' }));
    await user.click(screen.getByRole('checkbox', { name: '.rs' }));
    await user.click(screen.getByRole('button', { name: 'Change folder' }));

    nextWorkspace.resolve({ ...initial, root: '/workspace/next' });
    expect(await screen.findByText('/workspace/next')).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 350)); });
    expect(submittedPolicies).toEqual([]);
  });

  it('shows pending and failed filter updates without claiming the policy was applied', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    let rejectPolicy!: (cause: Error) => void;
    let policyStarted = false;
    const bridge = {
      ...base,
      set_policy: () => new Promise<WorkspaceView>((_resolve, reject) => { policyStarted = true; rejectPolicy = reject; }),
    };
    render(<App bridge={bridge} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(screen.getByRole('radio', { name: 'Selected extensions' }));
    await user.click(screen.getByRole('checkbox', { name: '.rs' }));

    expect(await screen.findByText('Updating selection and estimates…')).toBeInTheDocument();
    await waitFor(() => expect(policyStarted).toBe(true));
    await act(async () => { rejectPolicy(new Error('Invalid extension pattern')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid extension pattern');
    expect(screen.getByText('Filter update failed. Review the error message and edit a filter to retry.')).toBeInTheDocument();
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
    const policyB: FilterPolicy = { gitignore: false, includeMode: 'selectedExtensions', includeExtensions: ['.b'], includePaths: [], excludePaths: [] };
    const authoritative = {
      ...oldWorkspace,
      root: '/workspace/backend-b', generation: 3,
      policy: policyB,
      entries: [{ ...oldWorkspace.entries[0]!, path: 'b-first.ts' }], entryCount: 2, nextOffset: 1,
    };
    let chooseCalls = 0;
    let watchRoot = '/workspace/patchwork';
    let watchEpoch = 0;
    let exportDestination = '';
    const bridge = {
      ...base,
      choose_workspace: () => {
        chooseCalls += 1;
        if (chooseCalls !== 1) return pendingChoose.promise;
        watchRoot = oldWorkspace.root;
        watchEpoch += 1;
        return Promise.resolve(oldWorkspace);
      },
      get_watch_status: async () => ({ root: watchRoot, epoch: watchEpoch, revision: 1, state: 'watching' as const, message: null }),
      cancel_operation: async () => {
        watchRoot = authoritative.root;
        watchEpoch += 1;
        return authoritative;
      },
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
    await user.click(screen.getByRole('radio', { name: 'Selected extensions' }));
    await user.click(screen.getByRole('checkbox', { name: '.rs' }));
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
    expect(screen.getByRole('checkbox', { name: '.b' })).toBeChecked();
    expect(screen.queryByRole('textbox', { name: /path/i })).not.toBeInTheDocument();

    pendingChoose.resolve({ ...oldWorkspace, root: '/workspace/backend-b', generation: 2, entries: [{ ...oldWorkspace.entries[0]!, path: 'late-choose.ts' }] });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Preview late-choose.ts' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Export Markdown' }));
    expect(await screen.findByRole('status')).toHaveTextContent('/workspace/backend-b/context.md');
    expect(exportDestination).toBe('/workspace/backend-b/context.md');
  });

  it('marks workspace stale after cancellation failure until a refresh succeeds', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    const bridge = {
      ...base,
      get_watch_status: async () => health,
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
    let activeRoot = '/workspace/patchwork';
    const bridge = {
      ...base,
      export_markdown: () => new Promise<{ destination: string; bytes: number; files: number }>(() => undefined),
      get_watch_status: async () => ({ root: activeRoot, epoch: activeRoot === '/workspace/current' ? 2 : 1, revision: 1, state: 'watching' as const, message: null }),
      cancel_operation: async () => { activeRoot = authoritative.root; return authoritative; },
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeEnabled());
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
      policy: { gitignore: true, includeMode: 'allText', includeExtensions: [], includePaths: [], excludePaths: [] },
      profileCatalog: { root: '/workspace/large', generation: 1, names: [], activeProfile: null },
    };
    const bridge = {
      ...createBrowserBridge(),
      choose_workspace: async () => largeWorkspace,
      get_watch_status: async () => ({ root: largeWorkspace.root, epoch: 2, revision: 1, state: 'watching' as const, message: null }),
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    const tree = screen.getByRole('tree', { name: 'Workspace files' });
    await waitFor(() => expect(screen.getByText('Watching', { exact: true })).toBeInTheDocument());
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

  it.each([
    ['Copy context', 'copy_markdown', 'Cancel Copy', 'Confirm Copy'],
    ['Export Markdown', 'export_markdown', 'Cancel Export', 'Confirm Export'],
  ] as const)('%s requires explicit confirmation when selected names look sensitive', async (buttonName, command, cancelName, confirmName) => {
    const user = userEvent.setup();
    const ticket = `ticket-${command}`;
    const response = {
      confirmationRequired: true as const,
      ticket,
      summary: {
        total: 3,
        omitted: 2,
        warnings: [{ path: 'config/.env.local', category: 'environmentFile' as const }],
      },
    };
    const cancelled: string[] = [];
    const confirmed: string[] = [];
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      [command]: async () => response,
      cancel_sensitive_output: async ({ ticket: value }: { ticket: string }) => { cancelled.push(value); return true; },
      confirm_sensitive_output: async ({ ticket: value }: { ticket: string }) => {
        confirmed.push(value);
        return { destination: 'clipboard', bytes: 16, files: 1 };
      },
    };
    render(<App bridge={bridge} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: buttonName }));

    const dialog = await screen.findByRole('alertdialog', { name: /potentially sensitive files/i });
    expect(within(dialog).getByText('config/.env.local')).toBeInTheDocument();
    expect(within(dialog).getByText('Environment file')).toBeInTheDocument();
    expect(within(dialog).getByText(/3 selected files have names commonly used for sensitive material/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 more flagged files will also be included/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: cancelName })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: confirmName })).toBeInTheDocument();
    expect(within(dialog).getByText(/file contents are not scanned/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: cancelName }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(cancelled).toEqual([ticket]);
    expect(confirmed).toEqual([]);
  });

  it.each([
    ['Copy context', 'copy_markdown', 'Confirm Copy', 'Copied · 1 files · 16 B'],
    ['Export Markdown', 'export_markdown', 'Confirm Export', 'Export ready · 1 files · 16 B · /workspace/patchwork/context.md'],
  ] as const)('publishes only after the user chooses %s confirmation', async (buttonName, command, confirmName, resultStatus) => {
    const user = userEvent.setup();
    const ticket = `ticket-${command}`;
    const confirmed: string[] = [];
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      [command]: async () => ({
        confirmationRequired: true as const,
        ticket,
        summary: { total: 1, omitted: 0, warnings: [{ path: '.aws/credentials', category: 'credentialFile' as const }] },
      }),
      confirm_sensitive_output: async ({ ticket: value }: { ticket: string }) => {
        confirmed.push(value);
        return { destination: '/workspace/patchwork/context.md', bytes: 16, files: 1 };
      },
    };
    render(<App bridge={bridge} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: buttonName }));
    const dialog = await screen.findByRole('alertdialog');
    expect(confirmed).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: confirmName }));

    expect(await screen.findByText(resultStatus)).toBeInTheDocument();
    expect(confirmed).toEqual([ticket]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: buttonName })).toHaveFocus();
  });

  it('reports a dismissed Save As dialog after sensitive Export confirmation', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      export_markdown: async () => ({
        confirmationRequired: true as const,
        ticket: 'cancelled-export-ticket',
        summary: { total: 1, omitted: 0, warnings: [{ path: '.env', category: 'environmentFile' as const }] },
      }),
      confirm_sensitive_output: async () => null,
    };
    render(<App bridge={bridge} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    const exportButton = screen.getByRole('button', { name: 'Export Markdown' });
    await user.click(exportButton);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Export' }));

    expect(await screen.findByText('Export cancelled.')).toBeInTheDocument();
    expect(exportButton).toHaveFocus();
  });

  it('keeps confirmed output feedback when a native dialog returns focus to the app', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    const focusResponse = deferred<WatchHealth | null>();
    let regainFocus: (() => void) | undefined;
    let revalidationRequested = false;
    const health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    const bridge = {
      ...base,
      get_watch_status: async () => health,
      on_window_focus: async (handler: () => void) => { regainFocus = handler; return () => {}; },
      request_focus_reconcile: async () => { revalidationRequested = true; return focusResponse.promise; },
      export_markdown: async () => ({
        confirmationRequired: true as const,
        ticket: 'focus-return-ticket',
        summary: { total: 1, omitted: 0, warnings: [{ path: '.env', category: 'environmentFile' as const }] },
      }),
      confirm_sensitive_output: async () => ({ destination: '/workspace/patchwork/context.md', bytes: 16, files: 1 }),
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Export Markdown' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Export' }));
    const result = 'Export ready · 1 files · 16 B · /workspace/patchwork/context.md';
    expect(await screen.findByText(result)).toBeInTheDocument();

    await act(async () => { regainFocus?.(); });
    await waitFor(() => expect(revalidationRequested).toBe(true));
    await act(async () => { focusResponse.resolve({ ...health, revision: 2 }); });

    expect(screen.getByRole('status')).toHaveTextContent(result);
  });

  it('keeps the export result visible when focus revalidation cannot read watcher status', async () => {
    const user = userEvent.setup();
    const base = createBrowserBridge();
    let regainFocus: (() => void) | undefined;
    const health: WatchHealth = { root: '/workspace/patchwork', epoch: 1, revision: 1, state: 'watching', message: null };
    const bridge = {
      ...base,
      get_watch_status: async () => health,
      on_window_focus: async (handler: () => void) => { regainFocus = handler; return () => {}; },
      request_focus_reconcile: async () => null,
      export_markdown: async () => ({
        confirmationRequired: true as const,
        ticket: 'focus-unavailable-ticket',
        summary: { total: 1, omitted: 0, warnings: [{ path: '.env', category: 'environmentFile' as const }] },
      }),
      confirm_sensitive_output: async () => ({ destination: '/workspace/patchwork/context.md', bytes: 16, files: 1 }),
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Export Markdown' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Export' }));
    const result = 'Export ready · 1 files · 16 B · /workspace/patchwork/context.md';
    expect(await screen.findByText(result)).toBeInTheDocument();

    await act(async () => { regainFocus?.(); });

    expect(screen.getByRole('status')).toHaveTextContent(`${result} · Workspace status unavailable. Refresh before continuing.`);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export Markdown' })).toBeDisabled();
  });

  it('traps focus in the sensitive warning and restores it after Escape cancellation', async () => {
    const user = userEvent.setup();
    let cancelled = '';
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      copy_markdown: async () => ({
        confirmationRequired: true as const,
        ticket: 'keyboard-ticket',
        summary: { total: 1, omitted: 0, warnings: [{ path: '.env', category: 'environmentFile' as const }] },
      }),
      cancel_sensitive_output: async ({ ticket }: { ticket: string }) => { cancelled = ticket; return true; },
    };
    render(<App bridge={bridge} fixtureMode />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    const copyButton = screen.getByRole('button', { name: 'Copy context' });
    await user.click(copyButton);
    const dialog = await screen.findByRole('alertdialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel Copy' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm Copy' });

    expect(cancel).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(confirm).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(cancel).toHaveFocus();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(copyButton).toHaveFocus();
    expect(cancelled).toBe('keyboard-ticket');
  });

  it('cancels the pending ticket when the authoritative watcher becomes stale', async () => {
    const user = userEvent.setup();
    let notify: ((health: WatchHealth) => void) | undefined;
    const cancelled: string[] = [];
    const base = createBrowserBridge();
    const bridge = {
      ...base,
      on_watch_status: async (handler: (health: WatchHealth) => void) => { notify = handler; return () => {}; },
      copy_markdown: async () => ({
        confirmationRequired: true as const,
        ticket: 'stale-watch-ticket',
        summary: { total: 1, omitted: 0, warnings: [{ path: '.env', category: 'environmentFile' as const }] },
      }),
      cancel_sensitive_output: async ({ ticket }: { ticket: string }) => { cancelled.push(ticket); return true; },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Copy context' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(notify).toBeDefined();

    act(() => notify?.({
      root: '/workspace/patchwork',
      epoch: 1,
      revision: 2,
      state: 'stale',
      message: 'Files changed. Refresh before continuing.',
    }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(cancelled).toEqual(['stale-watch-ticket']);
  });

  it('hydrates saved policy on folder open and applies edits after a debounce', async () => {
    const user = userEvent.setup();
    const savedPolicy: FilterPolicy = { gitignore: false, includeMode: 'selectedExtensions', includeExtensions: ['.md'], includePaths: [], excludePaths: [] };
    const nextPolicy: FilterPolicy = { gitignore: true, includeMode: 'selectedExtensions', includeExtensions: ['.rs'], includePaths: [], excludePaths: [] };
    const base = createBrowserBridge();
    const initial = { ...(await base.choose_workspace())!, policy: savedPolicy };
    let folderChoice = 0;
    const appliedPolicies: FilterPolicy[] = [];
    const bridge = {
      ...base,
      choose_workspace: async () => {
        folderChoice += 1;
        return folderChoice === 1 ? initial : { ...initial, root: '/workspace/next', policy: nextPolicy };
      },
      set_intent: async () => initial,
      set_policy: async ({ policy }: { policy: FilterPolicy }) => {
        appliedPolicies.push(structuredClone(policy));
        return { ...initial, policy };
      },
    };
    render(<App bridge={bridge} />);
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('checkbox', { name: 'Respect .gitignore' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Selected extensions' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '.md' })).toBeChecked();
    expect(screen.queryByRole('textbox', { name: /path/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: '.md' }));
    await user.click(screen.getByRole('checkbox', { name: '.tsx' }));
    expect(appliedPolicies).toHaveLength(0);
    await waitFor(() => expect(appliedPolicies.at(-1)?.includeExtensions).toEqual(['.tsx']));
    expect(screen.getByRole('checkbox', { name: '.tsx' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Change folder' }));
    expect(await screen.findByText('/workspace/next')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Respect .gitignore' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '.rs' })).toBeChecked();
    expect(screen.queryByRole('textbox', { name: /path/i })).not.toBeInTheDocument();
  });
});
