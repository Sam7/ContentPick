import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { ContextPickBridge, Entry, ExportResult, FilterPolicy, Preview, SelectionIntent, WorkspacePage, WorkspaceView } from './bridge';
import { ProjectTree } from './ProjectTree';
import { WorkspaceToolbar } from './WorkspaceToolbar';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { WorkspaceFilters, type FilterDrafts } from './WorkspaceFilters';
import { formatBytes } from './format';
import { projectEntries, type WorkspaceFileView } from './workspaceViews';
import './app.css';

type AppProps = { bridge: ContextPickBridge; fixtureMode?: boolean };
const DEFAULT_FILTER_POLICY: FilterPolicy = {
  gitignore: true,
  includeExtensions: [],
  includePaths: [],
  excludePaths: [],
};

function parentDirectories(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

function displayExtensions(extensions: string[]): string {
  return extensions.map((extension) => extension === '' ? '<none>' : extension).join(', ');
}

function draftsFromPolicy(policy: FilterPolicy): FilterDrafts {
  return {
    includeExtensions: displayExtensions(policy.includeExtensions),
    includePaths: policy.includePaths.join(', '),
    excludePaths: policy.excludePaths.join(', '),
  };
}

function errorMessage(cause: unknown, fallback: string): string {
  if (typeof cause === 'string') return cause;
  return cause instanceof Error ? cause.message : fallback;
}

function exportSummary(result: ExportResult, copied: boolean): string {
  const action = copied ? 'Copied' : 'Export ready';
  const destination = !copied && result.destination ? ` · ${result.destination}` : '';
  return `${action} · ${result.files} files · ${formatBytes(result.bytes)}${destination}`;
}

function validateInitialWorkspace(view: WorkspaceView): void {
  if (!Number.isSafeInteger(view.entryCount) || view.entryCount < 0 || !Array.isArray(view.entries) || view.entries.length > view.entryCount) {
    throw new Error('Workspace page metadata is invalid.');
  }
  if (view.nextOffset === null) {
    if (view.entries.length !== view.entryCount) throw new Error('Workspace page metadata is invalid.');
  } else if (!Number.isSafeInteger(view.nextOffset) || view.nextOffset !== view.entries.length || view.nextOffset <= 0 || view.nextOffset >= view.entryCount) {
    throw new Error('Workspace page metadata is invalid.');
  }
}

function validateWorkspacePage(initial: WorkspaceView, page: WorkspacePage, expectedOffset: number, loaded: number): void {
  if (page.root !== initial.root || page.generation !== initial.generation || page.offset !== expectedOffset || !Array.isArray(page.entries)) {
    throw new Error('Workspace page response did not match the requested page.');
  }
  const nextLoaded = loaded + page.entries.length;
  if (nextLoaded > initial.entryCount) throw new Error('Workspace page contains too many entries.');
  if (page.nextOffset === null) {
    if (nextLoaded !== initial.entryCount) throw new Error('Workspace page ended before all entries were loaded.');
  } else if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset !== nextLoaded || page.nextOffset <= expectedOffset || page.nextOffset >= initial.entryCount) {
    throw new Error('Workspace page did not make valid progress.');
  }
}

export function App({ bridge, fixtureMode = false }: AppProps) {
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: Preview } | null>(null);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(32);
  const previewDrag = useRef<{ pointerId: number; workbench: HTMLElement } | null>(null);
  const previewToggleRef = useRef<HTMLButtonElement>(null);
  const focusPreviewToggleAfterCollapse = useRef(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [fileView, setFileView] = useState<WorkspaceFileView>('all');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policy, setPolicy] = useState<FilterPolicy>(DEFAULT_FILTER_POLICY);
  const [policyDrafts, setPolicyDrafts] = useState(() => draftsFromPolicy(policy));
  const policyDirty = useRef(false);
  const [busy, setBusy] = useState<string | null>('restore');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [workspaceStale, setWorkspaceStale] = useState(false);
  const [actionPath, setActionPath] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const workspaceRequestId = useRef(0);
  const previewRequestId = useRef(0);
  const busyRequestId = useRef(0);
  const cancellationEpoch = useRef(0);
  const restorePromise = useRef<Promise<WorkspaceView | null> | null>(null);

  useLayoutEffect(() => {
    if (previewCollapsed && focusPreviewToggleAfterCollapse.current) {
      previewToggleRef.current?.focus();
      focusPreviewToggleAfterCollapse.current = false;
    }
  }, [previewCollapsed]);

  const loadWorkspacePages = useCallback(async (initial: WorkspaceView, isCurrent: () => boolean): Promise<void> => {
    validateInitialWorkspace(initial);
    let loaded = initial.entries.length;
    let nextOffset = initial.nextOffset;
    setStatus(nextOffset === null ? '' : `${loaded} of ${initial.entryCount} items loaded`);
    while (nextOffset !== null) {
      const page = await bridge.workspace_page({ generation: initial.generation, offset: nextOffset });
      if (!isCurrent()) return;
      validateWorkspacePage(initial, page, nextOffset, loaded);
      setWorkspace((current) => current && current.root === initial.root && current.generation === initial.generation
        ? { ...current, entries: [...current.entries, ...page.entries], nextOffset: page.nextOffset }
        : current);
      loaded += page.entries.length;
      nextOffset = page.nextOffset;
      setStatus(nextOffset === null ? '' : `${loaded} of ${initial.entryCount} items loaded`);
    }
  }, [bridge]);

  async function runWorkspaceCommand<T extends WorkspaceView | null>(
    name: string,
    action: () => Promise<T>,
    onInitial: (result: T) => void,
    isCurrent: () => boolean = () => true,
  ) {
    const requestId = ++busyRequestId.current;
    const requestEpoch = cancellationEpoch.current;
    const stillCurrent = () => cancellationEpoch.current === requestEpoch && isCurrent();
    setBusy(name);
    setCancelling(false);
    setError('');
    setStatus('');
    try {
      const result = await action();
      if (!stillCurrent()) return;
      if (result) validateInitialWorkspace(result);
      onInitial(result);
      if (result) await loadWorkspacePages(result, stillCurrent);
    } catch (cause) {
      if (stillCurrent()) setError(errorMessage(cause, 'The request could not be completed.'));
    } finally {
      if (busyRequestId.current === requestId) setBusy(null);
    }
  }

  const visibleEntries = useMemo(() => {
    if (!workspace) return [];
    const projected = projectEntries(workspace.entries, fileView);
    const normalisedQuery = query.trim().toLocaleLowerCase();
    if (normalisedQuery) {
      const pathsToReveal = new Set<string>();
      for (const entry of projected) {
        if (!entry.path.toLocaleLowerCase().includes(normalisedQuery)) continue;
        pathsToReveal.add(entry.path);
        parentDirectories(entry.path).forEach((parent) => pathsToReveal.add(parent));
      }
      return projected.filter((entry) => pathsToReveal.has(entry.path));
    }
    return projected.filter((entry) => {
      return parentDirectories(entry.path).every((parent) => expanded.has(parent));
    });
  }, [expanded, fileView, query, workspace]);

  useEffect(() => {
    const requestId = ++workspaceRequestId.current;
    const busyId = ++busyRequestId.current;
    let active = true;
    restorePromise.current ??= Promise.resolve().then(() => bridge.restore_workspace());
    const requestEpoch = cancellationEpoch.current;
    void (async () => {
      const restored = await restorePromise.current;
      if (!active || requestId !== workspaceRequestId.current || !restored) return;
      validateInitialWorkspace(restored);
      setWorkspace((current) => current && current.root === restored.root && current.generation > restored.generation ? current : restored);
      setPolicy(restored.policy);
      setPolicyDrafts(draftsFromPolicy(restored.policy));
      policyDirty.current = false;
      setPreview(null);
      setExpanded(new Set());
      await loadWorkspacePages(restored, () => active && requestId === workspaceRequestId.current && requestEpoch === cancellationEpoch.current);
    })().catch((cause: unknown) => {
      if (!active || requestId !== workspaceRequestId.current) return;
      setError(errorMessage(cause, 'Could not restore the last workspace.'));
    }).finally(() => {
      if (active && busyRequestId.current === busyId) setBusy(null);
    });
    return () => {
      active = false;
      if (workspaceRequestId.current === requestId) workspaceRequestId.current += 1;
    };
  }, [bridge, loadWorkspacePages]);

  async function runCommand<T>(name: string, action: () => Promise<T>, onSuccess: (result: T) => void, isCurrent: () => boolean = () => true) {
    const requestId = ++busyRequestId.current;
    const requestEpoch = cancellationEpoch.current;
    setBusy(name);
    setCancelling(false);
    setError('');
    setStatus('');
    try {
      const result = await action();
      if (cancellationEpoch.current === requestEpoch && isCurrent()) onSuccess(result);
    } catch (cause) {
      if (cancellationEpoch.current === requestEpoch && isCurrent()) setError(errorMessage(cause, 'The request could not be completed.'));
    } finally {
      if (busyRequestId.current === requestId) setBusy(null);
    }
  }

  function commitWorkspace(result: WorkspaceView, hydratePolicy = !policyDirty.current) {
    if (workspace && workspace.root === result.root && result.generation < workspace.generation) return;
    const rootChanged = workspace?.root !== result.root;
    if (hydratePolicy || rootChanged) {
      setPolicy(result.policy);
      setPolicyDrafts(draftsFromPolicy(result.policy));
      policyDirty.current = false;
    }
    if (rootChanged) {
      setExpanded(new Set());
      setQuery('');
      setFileView('all');
      setSettingsOpen(false);
    }
    if (!workspace || workspace.root !== result.root || workspace.generation !== result.generation) {
      previewRequestId.current += 1;
      setPreview(null);
    }
    setWorkspace(result);
    setWorkspaceStale(false);
  }

  function openWorkspace() {
    if (cancelling) return;
    const requestId = ++workspaceRequestId.current;
    void runWorkspaceCommand('open', () => bridge.choose_workspace(), (result) => {
      if (!result) return;
      commitWorkspace(result, true);
      setExpanded(new Set());
      setQuery('');
    }, () => requestId === workspaceRequestId.current);
  }

  function refresh() {
    const requestId = ++workspaceRequestId.current;
    void runWorkspaceCommand('refresh', () => bridge.refresh_workspace(), commitWorkspace, () => requestId === workspaceRequestId.current);
  }

  function browseIgnored(path: string) {
    if (workspaceStale || cancelling) return;
    const requestId = ++workspaceRequestId.current;
    void runWorkspaceCommand('browse', () => bridge.browse_ignored({ path }), (result) => {
      commitWorkspace(result);
      setExpanded((current) => new Set(current).add(path));
      setStatus(`Browsing ignored folder: ${path}`);
    }, () => requestId === workspaceRequestId.current);
  }

  function previewFile(path: string) {
    if (workspaceStale || cancelling) return;
    const requestId = ++previewRequestId.current;
    void runCommand('preview', () => bridge.preview_file({ path }), (content) => setPreview({ path, content }), () => requestId === previewRequestId.current);
  }

  function setIntent(path: string, intent: SelectionIntent) {
    if (workspaceStale || cancelling) return;
    const requestId = ++workspaceRequestId.current;
    void runWorkspaceCommand('selection', () => bridge.set_intent({ path, intent }), commitWorkspace, () => requestId === workspaceRequestId.current);
    setActionPath(null);
  }

  function resetSelections() {
    if (workspaceStale || cancelling) return;
    const requestId = ++workspaceRequestId.current;
    void runWorkspaceCommand('selection', () => bridge.reset_selections(), (result) => {
      commitWorkspace(result);
      setStatus('Selections reset to defaults.');
    }, () => requestId === workspaceRequestId.current);
  }

  function submitPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (workspaceStale || cancelling) return;
    const requestId = ++workspaceRequestId.current;
    void runWorkspaceCommand('policy', () => bridge.set_policy({ policy }), (result) => commitWorkspace(result, true), () => requestId === workspaceRequestId.current);
  }

  function resetFilters() {
    if (!workspace || workspaceStale || cancelling) return;
    const requestId = ++workspaceRequestId.current;
    const policy = { ...DEFAULT_FILTER_POLICY };
    void runWorkspaceCommand('policy', () => bridge.set_policy({ policy }), (result) => {
      commitWorkspace(result, true);
      setStatus('Filters reset to defaults.');
    }, () => requestId === workspaceRequestId.current);
  }

  function toggleSidebar() {
    const nextCollapsed = !sidebarCollapsed;
    setSidebarCollapsed(nextCollapsed);
    if (nextCollapsed) setPolicyOpen(false);
  }

  function exportContent(copied: boolean) {
    if (!workspace || workspaceStale || cancelling) return;
    void runCommand(copied ? 'copy' : 'export', () => copied ? bridge.copy_markdown() : bridge.export_markdown(), (result) => {
      if (result) setStatus(exportSummary(result, copied));
    });
  }

  async function cancelOperation() {
    if (cancelling) return;
    cancellationEpoch.current += 1;
    workspaceRequestId.current += 1;
    previewRequestId.current += 1;
    const cancelRequestId = ++busyRequestId.current;
    const stillCurrent = () => busyRequestId.current === cancelRequestId;
    setCancelling(true);
    setError('');
    setStatus('Waiting for cancellation to finish…');
    let authoritativeWorkspaceCommitted = false;
    try {
      const authoritativeWorkspace = await bridge.cancel_operation();
      if (!stillCurrent()) return;
      if (authoritativeWorkspace) {
        validateInitialWorkspace(authoritativeWorkspace);
        commitWorkspace(authoritativeWorkspace);
        authoritativeWorkspaceCommitted = true;
        setExpanded(new Set());
        await loadWorkspacePages(authoritativeWorkspace, stillCurrent);
      } else {
        setWorkspace(null);
        setPreview(null);
        setWorkspaceStale(false);
        authoritativeWorkspaceCommitted = true;
      }
      if (!stillCurrent()) return;
      setStatus('Cancellation requested.');
    } catch (cause) {
      if (stillCurrent()) {
        if (authoritativeWorkspaceCommitted) {
          setStatus('The workspace is current, but some entries did not load. Refresh to retry.');
        } else {
          setWorkspaceStale(true);
          setStatus('Workspace may be out of date. Refresh or choose a folder before continuing.');
        }
        setError(errorMessage(cause, 'Could not cancel the current operation.'));
      }
    } finally {
      if (stillCurrent()) {
        setCancelling(false);
        setBusy(null);
      }
    }
  }

  function updateTextPolicy(field: 'includeExtensions' | 'includePaths' | 'excludePaths', draft: string) {
    policyDirty.current = true;
    setPolicyDrafts((current) => ({ ...current, [field]: draft }));
    const values = draft
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => field === 'includeExtensions' && value.toLocaleLowerCase() === '<none>' ? '' : value);
    setPolicy((current) => ({ ...current, [field]: values }));
  }

  function toggleExpanded(entry: Entry) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }

  function changeFileView(view: WorkspaceFileView) {
    setFileView(view);
    setSettingsOpen(false);
    setPolicyOpen(false);
  }

  function resizePreview(width: number) {
    setPreviewWidth(Math.max(25, Math.min(50, Math.round(width))));
  }

  function handleSplitterKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 5 : 2;
    if (event.key === 'ArrowLeft') resizePreview(previewWidth + step);
    else if (event.key === 'ArrowRight') resizePreview(previewWidth - step);
    else if (event.key === 'Home') resizePreview(25);
    else if (event.key === 'End') resizePreview(50);
    else if (event.key === 'Enter') {
      focusPreviewToggleAfterCollapse.current = true;
      setPreviewCollapsed(true);
    }
    else return;
    event.preventDefault();
  }

  function handleSplitterPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const workbench = event.currentTarget.parentElement;
    if (!workbench) return;
    previewDrag.current = { pointerId: event.pointerId, workbench };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handleSplitterPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = previewDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = drag.workbench.getBoundingClientRect();
    if (bounds.width <= 0) return;
    resizePreview(((bounds.right - event.clientX) / bounds.width) * 100);
  }

  function finishSplitterPointer(event: PointerEvent<HTMLDivElement>) {
    if (previewDrag.current?.pointerId === event.pointerId) previewDrag.current = null;
  }

  const ignoredFileCount = workspace?.entries.filter((entry) => entry.kind === 'file' && entry.gitIgnored).length ?? 0;
  const unbrowsedIgnoredFolders = workspace?.entries.filter((entry) => entry.kind === 'directory' && entry.gitIgnored && !entry.enumerated).length ?? 0;
  const indexLoading = Boolean(workspace && workspace.entries.length < workspace.entryCount);
  const previewEntry = workspace?.entries.find((entry) => entry.path === preview?.path && entry.kind === 'file') ?? null;
  const previewSizeLabel = previewEntry ? `Size: ${new Intl.NumberFormat('en-US').format(previewEntry.size)} bytes` : 'Size unavailable';
  const previewInclusionLabel = previewEntry ? (previewEntry.selected ? 'Included' : 'Not included') : 'Inclusion unavailable';

  return (
    <main className="app-shell">
      <WorkspaceToolbar
        root={workspace?.root ?? null}
        refreshDisabled={!workspace || busy !== null || cancelling}
        openDisabled={busy === 'open' || cancelling}
        onRefresh={refresh}
        onOpen={openWorkspace}
      />

      {fixtureMode && <div className="fixture-banner" role="note"><span>Browser fixture mode</span><span>Sample responses · no files are read</span></div>}

      <section className={`workbench${workspace ? ' has-workspace' : ''}${workspace && !sidebarCollapsed ? ' has-sidebar' : ''}${workspace && sidebarCollapsed ? ' sidebar-collapsed' : ''}${previewCollapsed ? ' preview-collapsed' : ''}`} style={workspace ? { '--preview-width': `${previewWidth}%` } as CSSProperties : undefined} aria-label="Project files and preview">
        {workspace && <WorkspaceSidebar
          collapsed={sidebarCollapsed}
          view={fileView}
          settingsOpen={settingsOpen}
          filtersOpen={policyOpen && !sidebarCollapsed}
          allItems={workspace.entryCount}
          selectedFiles={workspace.selectedCount}
          ignoredFiles={ignoredFileCount}
          unbrowsedIgnoredFolders={unbrowsedIgnoredFolders}
          indexLoading={indexLoading}
          incomplete={workspace.incomplete}
          onToggleCollapsed={toggleSidebar}
          onViewChange={changeFileView}
          onFilters={() => {
            setSettingsOpen(false);
            if (sidebarCollapsed) {
              setSidebarCollapsed(false);
              setPolicyOpen(true);
            } else {
              setPolicyOpen((open) => !open);
            }
          }}
          onSettings={() => { setPolicyOpen(false); setSettingsOpen((open) => !open); }}
        >{policyOpen && <WorkspaceFilters
          gitignore={policy.gitignore}
          drafts={policyDrafts}
          disabled={!workspace || workspaceStale || busy !== null || cancelling}
          onGitignoreChange={(enabled) => { policyDirty.current = true; setPolicy((current) => ({ ...current, gitignore: enabled })); }}
          onTextChange={updateTextPolicy}
          onReset={resetFilters}
          onSubmit={submitPolicy}
        />}</WorkspaceSidebar>}
        <section className="panel file-panel" aria-label="Project files">
          <div className="panel-heading"><div><h2>{settingsOpen ? 'Settings' : fileView === 'selected' ? 'Selected files' : fileView === 'ignored' ? 'Git-ignored files' : 'Project files'}</h2><p>{workspace ? indexLoading ? `${workspace.entries.length} of ${workspace.entryCount} items loaded` : `${workspace.entryCount} items discovered` : 'Open a folder to get started'}</p></div><div className="scan-statuses">{workspace && !settingsOpen && <><span className="refresh-badge" title="Automatic file watching is not available yet. Refresh after changing files.">↻ Manual refresh</span></>}{workspace?.incomplete && <span className="scan-badge"><span className="scan-dot" /> Partial scan</span>}</div></div>
          {workspace ? settingsOpen ? <section className="settings-content" aria-label="Settings">
            <div className="settings-icon" aria-hidden="true">⚙</div>
            <h3>Local workspace settings</h3>
            <p>Workspace path, filters, and file selection choices are saved locally on this device.</p>
            <div className="settings-action">
              <div><strong>Reset selections</strong><small>Clear saved file and folder choices. Your filters stay in place.</small></div>
              <button className="button button-secondary" onClick={resetSelections} disabled={busy !== null || workspaceStale || cancelling}>Reset selections</button>
            </div>
          </section> : <>
            <label className="search-box"><span aria-hidden="true">⌕</span><span className="sr-only">Search files</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files and folders" /></label>
            <ProjectTree entries={visibleEntries} expanded={expanded} actionPath={actionPath} busy={busy !== null || workspaceStale} previewDisabled={workspaceStale || cancelling || (busy !== null && busy !== 'preview')} query={query}
              onExpand={toggleExpanded} onBrowse={browseIgnored} onPreview={previewFile} onIntent={setIntent} onAction={setActionPath} />
            <div className="tree-legend"><span><i className="legend-dot selected-dot" /> Included</span><span><i className="legend-dot muted-dot" /> Filtered</span><span><i className="legend-dot override-dot" /> Force included</span></div>
            {workspace.diagnostics.length > 0 && <ul className="diagnostics">{workspace.diagnostics.map((item) => <li key={item}>{item}</li>)}</ul>}
          </> : <div className="file-empty"><div className="empty-illustration" aria-hidden="true"><span>⌘</span><i>＋</i></div><h3>Start with a local folder</h3><p>ContextPick reads your project on this device and keeps your source files untouched.</p><button className="button button-primary" onClick={openWorkspace} disabled={cancelling}>Choose a folder <span aria-hidden="true">→</span></button><small>Works offline · your code stays private</small></div>}
        </section>

        {workspace && !previewCollapsed && <div
          className="preview-splitter"
          role="separator"
          aria-label="File preview"
          aria-controls="file-preview-pane"
          aria-orientation="vertical"
          aria-valuemin={25}
          aria-valuemax={50}
          aria-valuenow={previewWidth}
          aria-valuetext={`${previewWidth}% preview width`}
          tabIndex={0}
          onKeyDown={handleSplitterKeyDown}
          onPointerDown={handleSplitterPointerDown}
          onPointerMove={handleSplitterPointerMove}
          onPointerUp={finishSplitterPointer}
          onPointerCancel={finishSplitterPointer}
        />}

        <section id="file-preview-pane" className={`panel preview-panel${previewCollapsed ? ' is-collapsed' : ''}`} aria-label="File preview">
          <div className={`panel-heading preview-heading${previewCollapsed ? ' is-collapsed' : ''}`}>
            {!previewCollapsed && <div className="preview-title"><h2>Preview</h2><p className="preview-path" title={preview?.path}>{preview ? preview.path : 'Read-only file preview'}</p>{preview && <div className="preview-metadata" role="group" aria-label="Preview file details"><span className="preview-file-size">{previewSizeLabel}</span><span className={`preview-inclusion${previewEntry?.selected ? ' is-included' : ''}`}>{previewInclusionLabel}</span></div>}</div>}
            {previewCollapsed && <span className="preview-collapsed-label">Preview</span>}
            <div className="preview-heading-actions">
              {!previewCollapsed && preview && <span className="readonly-badge"><span aria-hidden="true">◉</span> Read only</span>}
              <button ref={previewToggleRef} className="preview-toggle" type="button" aria-label={previewCollapsed ? 'Expand preview' : 'Collapse preview'} aria-expanded={!previewCollapsed} onClick={() => setPreviewCollapsed((collapsed) => !collapsed)}><span aria-hidden="true">{previewCollapsed ? '‹' : '›'}</span></button>
            </div>
          </div>
          {!previewCollapsed && (preview ? <div className="code-preview"><div className="code-toolbar"><span><i className="code-dot" />{preview.path.split('.').pop()}</span><span>{preview.content.truncated ? 'Preview truncated' : 'UTF-8 text'}</span></div><pre><code>{preview.content.text}</code></pre>{preview.content.truncated && <div className="truncation-note">Preview is capped. Export includes the full eligible file.</div>}</div> : <div className="preview-empty"><div className="preview-placeholder" aria-hidden="true"><span>‹›</span><i /><i /><i /><i /><i /></div><h3>{workspace ? 'Select a text file to preview' : 'Your preview appears here'}</h3><p>{workspace ? 'Choose a file from the tree to inspect its contents.' : 'Open a folder, then select a file to see its contents before export.'}</p></div>)}
        </section>
      </section>

      <div className="bottom-dock">
        <div className="dock-notices">
          <div className="live-region" aria-live="polite" role="status">{status || (busy ? `${busy === 'preview' ? 'Loading preview' : 'Working'}…` : '')}</div>
          {error && <div className="error-toast" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        </div>
        <footer className="export-bar">
          <div className="footer-metrics" role="group" aria-label="Selection estimates">
            <div className="metric metric-primary"><span className="metric-icon" aria-hidden="true">✳</span><span><strong>{workspace ? workspace.selectedCount : '—'}</strong><small>Selected files</small></span></div>
            <div className="metric"><span className="metric-icon" aria-hidden="true">↗</span><span><strong>{workspace ? `≈ ${formatBytes(workspace.estimatedBytes)}` : '—'}</strong><small>Estimated export size</small></span></div>
            <div className="metric token-metric"><span className="metric-icon" aria-hidden="true">▤</span><span><strong>Unavailable</strong><small>Token estimate</small></span><span className="info-tip" title="A local tokenizer is not available yet." aria-label="A local tokenizer is not available yet">i</span></div>
          </div>
          <div className="export-actions">
            {['restore', 'open', 'refresh', 'browse', 'export', 'copy'].includes(busy ?? '') && <button className="button button-secondary cancel-button" onClick={cancelOperation} disabled={cancelling}>{cancelling ? 'Cancelling…' : 'Cancel operation'}</button>}
            <button className="button button-secondary" onClick={() => exportContent(true)} disabled={!workspace || workspaceStale || workspace.selectedCount === 0 || busy !== null || cancelling}><span aria-hidden="true">▢</span> Copy context</button>
            <button className="button button-primary export-button" onClick={() => exportContent(false)} disabled={!workspace || workspaceStale || workspace.selectedCount === 0 || busy !== null || cancelling}>{busy === 'export' ? 'Preparing…' : 'Export Markdown'} <span aria-hidden="true">→</span></button>
          </div>
        </footer>
      </div>
    </main>
  );
}
