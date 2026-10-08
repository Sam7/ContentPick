import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { ContextPickBridge, Entry, ExportResult, FilterPolicy, Preview, SelectionIntent, WorkspaceView } from './bridge';
import { ProjectTree } from './ProjectTree';
import { formatBytes } from './format';
import './app.css';

type AppProps = { bridge: ContextPickBridge; fixtureMode?: boolean };

function parentDirectories(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
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

export function App({ bridge, fixtureMode = false }: AppProps) {
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: Preview } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policy, setPolicy] = useState<FilterPolicy>({ gitignore: true, includeExtensions: [], excludeExtensions: [], includePaths: [], excludePaths: [] });
  const policyDirty = useRef(false);
  const [busy, setBusy] = useState<string | null>('restore');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [actionPath, setActionPath] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const workspaceRequestId = useRef(0);
  const previewRequestId = useRef(0);
  const busyRequestId = useRef(0);
  const cancellationEpoch = useRef(0);
  const restorePromise = useRef<Promise<WorkspaceView | null> | null>(null);

  const visibleEntries = useMemo(() => {
    if (!workspace) return [];
    const normalisedQuery = query.trim().toLocaleLowerCase();
    return workspace.entries.filter((entry) => {
      if (normalisedQuery && !entry.path.toLocaleLowerCase().includes(normalisedQuery)) return false;
      return parentDirectories(entry.path).every((parent) => expanded.has(parent));
    });
  }, [expanded, query, workspace]);

  useEffect(() => {
    const requestId = ++workspaceRequestId.current;
    const busyId = ++busyRequestId.current;
    let active = true;
    restorePromise.current ??= Promise.resolve().then(() => bridge.restore_workspace());
    void restorePromise.current.then((restored) => {
      if (!active || requestId !== workspaceRequestId.current || !restored) return;
      setWorkspace((current) => current && current.root === restored.root && current.generation > restored.generation ? current : restored);
      setPolicy(restored.policy);
      policyDirty.current = false;
      setPreview(null);
      setExpanded(new Set());
    }).catch((cause: unknown) => {
      if (!active || requestId !== workspaceRequestId.current) return;
      setError(errorMessage(cause, 'Could not restore the last workspace.'));
    }).finally(() => {
      if (active && busyRequestId.current === busyId) setBusy(null);
    });
    return () => {
      active = false;
      if (workspaceRequestId.current === requestId) workspaceRequestId.current += 1;
    };
  }, [bridge]);

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
    if (hydratePolicy) {
      setPolicy(result.policy);
      policyDirty.current = false;
    }
    if (!workspace || workspace.root !== result.root || workspace.generation !== result.generation) {
      previewRequestId.current += 1;
      setPreview(null);
    }
    setWorkspace(result);
  }

  function openWorkspace() {
    const requestId = ++workspaceRequestId.current;
    void runCommand('open', () => bridge.choose_workspace(), (result) => {
      if (!result) return;
      commitWorkspace(result, true);
      setExpanded(new Set());
      setQuery('');
    }, () => requestId === workspaceRequestId.current);
  }

  function refresh() {
    const requestId = ++workspaceRequestId.current;
    void runCommand('refresh', () => bridge.refresh_workspace(), commitWorkspace, () => requestId === workspaceRequestId.current);
  }

  function browseIgnored(path: string) {
    const requestId = ++workspaceRequestId.current;
    void runCommand('browse', () => bridge.browse_ignored({ path }), (result) => {
      commitWorkspace(result);
      setExpanded((current) => new Set(current).add(path));
      setStatus(`Browsing ignored folder: ${path}`);
    }, () => requestId === workspaceRequestId.current);
  }

  function previewFile(path: string) {
    const requestId = ++previewRequestId.current;
    void runCommand('preview', () => bridge.preview_file({ path }), (content) => setPreview({ path, content }), () => requestId === previewRequestId.current);
  }

  function setIntent(path: string, intent: SelectionIntent) {
    const requestId = ++workspaceRequestId.current;
    void runCommand('selection', () => bridge.set_intent({ path, intent }), commitWorkspace, () => requestId === workspaceRequestId.current);
    setActionPath(null);
  }

  function resetSelections() {
    const requestId = ++workspaceRequestId.current;
    void runCommand('selection', () => bridge.reset_selections(), (result) => {
      commitWorkspace(result);
      setStatus('Selections reset to defaults.');
    }, () => requestId === workspaceRequestId.current);
  }

  function submitPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestId = ++workspaceRequestId.current;
    void runCommand('policy', () => bridge.set_policy({ policy }), (result) => commitWorkspace(result, true), () => requestId === workspaceRequestId.current);
    setPolicyOpen(false);
  }

  function exportContent(copied: boolean) {
    if (!workspace) return;
    void runCommand(copied ? 'copy' : 'export', () => copied ? bridge.copy_markdown() : bridge.export_markdown(), (result) => {
      if (result) setStatus(exportSummary(result, copied));
    });
  }

  async function cancelOperation() {
    setCancelling(true);
    try {
      await bridge.cancel_operation();
      cancellationEpoch.current += 1;
      if (['restore', 'open', 'refresh', 'browse', 'selection', 'policy'].includes(busy ?? '')) workspaceRequestId.current += 1;
      if (busy === 'preview') previewRequestId.current += 1;
      busyRequestId.current += 1;
      setBusy(null);
      setStatus('Cancellation requested.');
    } catch (cause) {
      setError(errorMessage(cause, 'Could not cancel the current operation.'));
    } finally {
      setCancelling(false);
    }
  }

  function updateTextPolicy(field: 'includeExtensions' | 'excludeExtensions' | 'includePaths' | 'excludePaths', event: ChangeEvent<HTMLInputElement>) {
    policyDirty.current = true;
    setPolicy((current) => ({ ...current, [field]: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) }));
  }

  function toggleExpanded(entry: Entry) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="ContextPick home">
          <span className="brand-mark" aria-hidden="true">C</span>
          <span>ContextPick</span>
        </a>
        <div className="topbar-actions">
          <span className="offline-label"><span className="offline-dot" />Local and private</span>
          <button className="button button-secondary" onClick={() => setPolicyOpen((open) => !open)} aria-expanded={policyOpen}>
            <span aria-hidden="true">☷</span> Filters
          </button>
        </div>
      </header>

      {fixtureMode && <div className="fixture-banner" role="note"><span>Browser fixture mode</span><span>Sample responses · no files are read</span></div>}

      <section className="workspace-bar" aria-label="Workspace">
        <div className="workspace-location">
          <span className="location-icon" aria-hidden="true">⌂</span>
          <div>
            <div className="eyebrow">WORKSPACE</div>
            {workspace ? <div className="workspace-path">{workspace.root}</div> : <div className="workspace-empty">No folder open</div>}
          </div>
        </div>
        <div className="workspace-actions">
          {workspace && <button className="button button-secondary" onClick={refresh} disabled={busy !== null}><span aria-hidden="true">↻</span> Refresh</button>}
          <button className="button button-primary" onClick={openWorkspace} disabled={busy === 'open'}>
            <span aria-hidden="true">＋</span> {workspace ? 'Change folder' : 'Open folder'}
          </button>
        </div>
      </section>

      {policyOpen && <form className="filter-panel" onSubmit={submitPolicy} aria-label="Filter settings">
        <div className="filter-heading"><div><div className="eyebrow">INCLUSION RULES</div><h2>Choose what is eligible</h2></div><button type="button" className="icon-button" aria-label="Close filters" onClick={() => setPolicyOpen(false)}>×</button></div>
        <label className="toggle-line"><input type="checkbox" checked={policy.gitignore} onChange={(event) => { policyDirty.current = true; setPolicy((current) => ({ ...current, gitignore: event.target.checked })); }} /> Respect .gitignore</label>
        <div className="filter-grid">
          <label>Include extensions <input value={policy.includeExtensions.join(', ')} onChange={(event) => updateTextPolicy('includeExtensions', event)} placeholder=".ts, .tsx, .md" /></label>
          <label>Exclude extensions <input value={policy.excludeExtensions.join(', ')} onChange={(event) => updateTextPolicy('excludeExtensions', event)} placeholder=".snap, .lock" /></label>
          <label>Include paths <input value={policy.includePaths.join(', ')} onChange={(event) => updateTextPolicy('includePaths', event)} placeholder="src/**, docs/**" /></label>
          <label>Exclude paths <input value={policy.excludePaths.join(', ')} onChange={(event) => updateTextPolicy('excludePaths', event)} placeholder="**/__tests__/**" /></label>
        </div>
        <div className="filter-footer"><span>Rules are evaluated by the workspace engine.</span><button className="button button-primary" type="submit" disabled={!workspace || busy !== null}>Apply filters</button></div>
      </form>}

      <section className="intro-row">
        <div><div className="eyebrow">YOUR PROJECT, READY FOR AI</div><h1>Select code. Export context.</h1><p>Pick the files that matter. Get clean, shareable context in seconds.</p></div>
        <div className="privacy-note"><span aria-hidden="true">◈</span><span><strong>Stays on your device</strong><small>No uploads. No account. No telemetry.</small></span></div>
      </section>

      <section className="metrics-strip" aria-label="Selection estimates">
        <div className="metric metric-primary"><span className="metric-icon" aria-hidden="true">✳</span><span><strong>{workspace ? workspace.selectedCount : '—'}</strong><small>Selected files</small></span></div>
        <div className="metric"><span className="metric-icon" aria-hidden="true">↗</span><span><strong>{workspace ? `≈ ${formatBytes(workspace.estimatedBytes)}` : '—'}</strong><small>Estimated export size</small></span></div>
        <div className="metric token-metric"><span className="metric-icon" aria-hidden="true">▤</span><span><strong>Unavailable</strong><small>Token estimate</small></span><span className="info-tip" title="A local tokenizer is not available yet." aria-label="A local tokenizer is not available yet">i</span></div>
      </section>

      <section className="workbench" aria-label="Project files and preview">
        <section className="panel file-panel" aria-label="Project files">
          <div className="panel-heading"><div><h2>Project files</h2><p>{workspace ? workspace.entries.length + ' items discovered' : 'Open a folder to get started'}</p></div><div className="scan-statuses">{workspace && <><span className="refresh-badge" title="Automatic file watching is not available yet. Refresh after changing files.">↻ Manual refresh</span><button className="reset-selection-button" onClick={resetSelections} disabled={busy !== null}>Reset selections</button></>}{workspace?.incomplete && <span className="scan-badge"><span className="scan-dot" /> Partial scan</span>}</div></div>
          {workspace ? <>
            <label className="search-box"><span aria-hidden="true">⌕</span><span className="sr-only">Search files</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files and folders" /></label>
            <ProjectTree entries={visibleEntries} expanded={expanded} actionPath={actionPath} busy={busy !== null} query={query}
              onExpand={toggleExpanded} onBrowse={browseIgnored} onPreview={previewFile} onIntent={setIntent} onAction={setActionPath} />
            <div className="tree-legend"><span><i className="legend-dot selected-dot" /> Included</span><span><i className="legend-dot muted-dot" /> Filtered</span><span><i className="legend-dot override-dot" /> Force included</span></div>
            {workspace.diagnostics.length > 0 && <ul className="diagnostics">{workspace.diagnostics.map((item) => <li key={item}>{item}</li>)}</ul>}
          </> : <div className="file-empty"><div className="empty-illustration" aria-hidden="true"><span>⌘</span><i>＋</i></div><h3>Start with a local folder</h3><p>ContextPick reads your project on this device and keeps your source files untouched.</p><button className="button button-primary" onClick={openWorkspace}>Choose a folder <span aria-hidden="true">→</span></button><small>Works offline · your code stays private</small></div>}
        </section>

        <section className="panel preview-panel" aria-label="File preview">
          <div className="panel-heading preview-heading"><div><h2>Preview</h2><p>{preview ? preview.path : 'Read-only file preview'}</p></div>{preview && <span className="readonly-badge"><span aria-hidden="true">◉</span> Read only</span>}</div>
          {preview ? <div className="code-preview"><div className="code-toolbar"><span><i className="code-dot" />{preview.path.split('.').pop()}</span><span>{preview.content.truncated ? 'Preview truncated' : 'UTF-8 text'}</span></div><pre><code>{preview.content.text}</code></pre>{preview.content.truncated && <div className="truncation-note">Preview is capped. Export includes the full eligible file.</div>}</div> : <div className="preview-empty"><div className="preview-placeholder" aria-hidden="true"><span>‹›</span><i /><i /><i /><i /><i /></div><h3>{workspace ? 'Select a text file to preview' : 'Your preview appears here'}</h3><p>{workspace ? 'Choose a file from the tree to inspect its contents.' : 'Open a folder, then select a file to see its contents before export.'}</p></div>}
        </section>
      </section>

      <footer className="export-bar">
        <div className="export-caption"><span className="export-icon" aria-hidden="true">⇧</span><span><strong>Ready to share</strong><small>Markdown · Stable file order · Safe code fences</small></span></div>
        <div className="export-actions">
          {['restore', 'open', 'refresh', 'browse', 'export', 'copy'].includes(busy ?? '') && <button className="button button-secondary cancel-button" onClick={cancelOperation} disabled={cancelling}>{cancelling ? 'Cancelling…' : 'Cancel operation'}</button>}
          <button className="button button-secondary" onClick={() => exportContent(true)} disabled={!workspace || workspace.selectedCount === 0 || busy !== null}><span aria-hidden="true">▢</span> Copy context</button>
          <button className="button button-primary export-button" onClick={() => exportContent(false)} disabled={!workspace || workspace.selectedCount === 0 || busy !== null}>{busy === 'export' ? 'Preparing…' : 'Export Markdown'} <span aria-hidden="true">→</span></button>
        </div>
      </footer>

      <div className="live-region" aria-live="polite" role="status">{status || (busy ? `${busy === 'preview' ? 'Loading preview' : 'Working'}…` : '')}</div>
      {error && <div className="error-toast" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    </main>
  );
}
