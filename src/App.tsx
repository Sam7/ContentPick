import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { IconAlertTriangle, IconArrowRight, IconChevronLeft, IconChevronRight, IconCode, IconCopy, IconEye, IconFileExport, IconFileText, IconFolderOpen, IconHash, IconInfoCircle, IconPlus, IconSearch, IconSettings, IconX } from '@tabler/icons-react';
import type { ContextPickBridge, Entry, ExportDestinationView, ExportResult, FilterPolicy, Preview, ProfileCatalog, SelectionIntent, SensitiveWarningSummary, TokenEstimate, WatchHealth, WorkspacePage, WorkspaceView } from './bridge';
import { ProjectTree } from './ProjectTree';
import { WorkspaceToolbar } from './WorkspaceToolbar';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { WorkspaceFilters } from './WorkspaceFilters';
import { formatBytes } from './format';
import { UiIcon } from './UiIcon';
import { projectEntries, type WorkspaceFileView } from './workspaceViews';
import './app.css';

type AppProps = { bridge: ContextPickBridge; fixtureMode?: boolean };
type TokenEstimateDisplay = {
  root: string;
  generation: number;
  selectedCount: number;
  requestId: string;
  state: 'calculating' | 'unavailable' | 'ready';
  estimate?: TokenEstimate;
};
type SensitivePrompt = {
  ticket: string;
  kind: 'copy' | 'export';
  summary: SensitiveWarningSummary;
  root: string;
  generation: number;
  trigger: HTMLElement | null;
};
const DEFAULT_FILTER_POLICY: FilterPolicy = {
  gitignore: true,
  includeMode: 'allText',
  includeExtensions: [],
  includePaths: [],
  excludePaths: [],
};

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

function isOutputStatus(status: string): boolean {
  return status.startsWith('Copied ·')
    || status.startsWith('Export ready ·')
    || status === 'Copy cancelled.'
    || status === 'Export cancelled.';
}

function withWatcherStatus(status: string, nextWatchMessage: string, previousWatchMessage: string | null): string {
  if (!isOutputStatus(status)) return nextWatchMessage;
  const previousSuffix = previousWatchMessage ? ` · ${previousWatchMessage}` : '';
  const baseStatus = previousSuffix && status.endsWith(previousSuffix)
    ? status.slice(0, -previousSuffix.length)
    : status;
  return `${baseStatus} · ${nextWatchMessage}`;
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
  const [tokenEstimate, setTokenEstimate] = useState<TokenEstimateDisplay | null>(null);
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
  const [selectedProfileName, setSelectedProfileName] = useState('');
  const [exportDestination, setExportDestination] = useState<ExportDestinationView>({
    settings: { enabled: false, folder: null, alwaysOverwrite: false },
    targetPath: null,
    replacesExisting: false,
    overwriteAllowed: true,
  });
  const [newProfileName, setNewProfileName] = useState('');
  const [renameProfileName, setRenameProfileName] = useState('');
  const [policy, setPolicy] = useState<FilterPolicy>(DEFAULT_FILTER_POLICY);
  const [policyUpdateState, setPolicyUpdateState] = useState<'idle' | 'pending' | 'failed'>('idle');
  const policyDirty = useRef(false);
  const policyDebounceTimer = useRef<number | null>(null);
  const policyRevision = useRef(0);
  const [hasUnappliedPolicy, setHasUnappliedPolicy] = useState(false);
  const [busy, setBusyState] = useState<string | null>('restore');
  const busyOperation = useRef<string | null>('restore');
  const workspaceStaleRef = useRef(false);
  const cancellingRef = useRef(false);
  const setBusy = useCallback((value: string | null) => {
    busyOperation.current = value;
    setBusyState(value);
  }, []);
  const [status, setStatusState] = useState('');
  const statusText = useRef('');
  const watcherStatus = useRef<string | null>(null);
  const setStatus = useCallback((value: string) => {
    statusText.current = value;
    setStatusState(value);
  }, []);
  const [error, setError] = useState('');
  const [workspaceStale, setWorkspaceStale] = useState(false);
  const [watchHealth, setWatchHealth] = useState<WatchHealth | null>(null);
  const [watchStatusUnavailable, setWatchStatusUnavailable] = useState(false);
  const watchStatusUnavailableRef = useRef(false);
  const [watchListenerUnavailable, setWatchListenerUnavailable] = useState(false);
  const [watchSubscriptionAttempt, setWatchSubscriptionAttempt] = useState(0);
  const [actionPath, setActionPath] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [sensitivePrompt, setSensitivePrompt] = useState<SensitivePrompt | null>(null);
  const sensitivePromptRef = useRef<SensitivePrompt | null>(null);
  const sensitiveDialogRef = useRef<HTMLDivElement>(null);
  const sensitiveCancelRef = useRef<HTMLButtonElement>(null);
  const sensitiveConfirmRef = useRef<HTMLButtonElement>(null);
  const cancelOperationButtonRef = useRef<HTMLButtonElement>(null);
  const pendingOutputFocusReturn = useRef<HTMLElement | null>(null);
  const estimateRoot = workspace?.root;
  const estimateGeneration = workspace?.generation;
  const estimateSelectedCount = workspace?.selectedCount;
  const profileCatalog = workspace?.profileCatalog;
  const activeWorkspaceRoot = workspace?.root;
  const exportTargetHint = exportDestination.settings.enabled && exportDestination.targetPath
    ? exportDestination.settings.alwaysOverwrite && !exportDestination.overwriteAllowed
      ? `Cannot replace ${exportDestination.targetPath}: the export folder is inside this workspace. Choose a folder outside it or turn off overwrite to protect source files.`
      : exportDestination.settings.alwaysOverwrite
      ? `Each click replaces ${exportDestination.targetPath}.`
      : `Exports to ${exportDestination.targetPath}; later exports will add a numbered filename.`
    : null;
  const workspaceRequestId = useRef(0);
  const tokenEstimateSequence = useRef(0);
  const activeTokenEstimateRequest = useRef<string | null>(null);
  const previewRequestId = useRef(0);
  const busyRequestId = useRef(0);
  const cancellationEpoch = useRef(0);
  const restorePromise = useRef<Promise<WorkspaceView | null> | null>(null);
  const watchEpoch = useRef(0);
  const watchHealthRevision = useRef(0);
  const watchRevision = useRef(0);
  const dirtyWatchRevision = useRef(0);
  const watchHealthRef = useRef<WatchHealth | null>(null);
  const watchListenerUnavailableRef = useRef(false);
  const activeRoot = useRef<string | null>(null);
  const pendingFocusReconcileRoot = useRef<string | null>(null);
  const focusReconcileRequest = useRef<(root: string) => void>(() => {});
  const autoRefreshAttempt = useRef({ epoch: 0, revision: 0 });
  const refreshRequest = useRef<() => void>(() => {});
  const watcherVerified = fixtureMode || Boolean(
    workspace
    && !workspaceStale
    && !watchStatusUnavailable
    && !watchListenerUnavailable
    && watchHealth?.root === workspace.root
    && watchHealth.state === 'watching',
  );

  const setSensitivePromptState = useCallback((prompt: SensitivePrompt | null) => {
    sensitivePromptRef.current = prompt;
    setSensitivePrompt(prompt);
  }, []);

  const closeSensitivePrompt = useCallback((cancelTicket: boolean) => {
    const prompt = sensitivePromptRef.current;
    if (!prompt) return;
    setSensitivePromptState(null);
    if (cancelTicket) void bridge.cancel_sensitive_output({ ticket: prompt.ticket }).catch(() => {});
    prompt.trigger?.focus();
  }, [bridge, setSensitivePromptState]);

  const sensitiveSnapshotCurrent = useCallback((prompt: SensitivePrompt) => {
    if (!workspace || workspace.root !== prompt.root || workspace.generation !== prompt.generation || workspaceStale) return false;
    if (fixtureMode) return true;
    const health = watchHealthRef.current;
    return !watchStatusUnavailableRef.current
      && !watchListenerUnavailableRef.current
      && health?.root === prompt.root
      && health.state === 'watching';
  }, [fixtureMode, workspace, workspaceStale]);

  useLayoutEffect(() => {
    if (sensitivePrompt) sensitiveCancelRef.current?.focus();
  }, [sensitivePrompt]);

  useLayoutEffect(() => {
    const trigger = pendingOutputFocusReturn.current;
    if (!trigger) return;
    if (busy === 'copy' || busy === 'export') {
      cancelOperationButtonRef.current?.focus();
    } else if (busy === null) {
      if (trigger.isConnected && !(trigger instanceof HTMLButtonElement && trigger.disabled)) trigger.focus();
      pendingOutputFocusReturn.current = null;
    }
  }, [busy]);

  useEffect(() => {
    const prompt = sensitivePromptRef.current;
    if (prompt && !sensitiveSnapshotCurrent(prompt)) closeSensitivePrompt(true);
  }, [closeSensitivePrompt, sensitiveSnapshotCurrent]);

  useEffect(() => () => {
    const prompt = sensitivePromptRef.current;
    if (prompt) void bridge.cancel_sensitive_output({ ticket: prompt.ticket }).catch(() => {});
  }, [bridge]);

  useEffect(() => () => {
    if (policyDebounceTimer.current !== null) window.clearTimeout(policyDebounceTimer.current);
  }, []);

  useEffect(() => { workspaceStaleRef.current = workspaceStale; }, [workspaceStale]);
  useEffect(() => { cancellingRef.current = cancelling; }, [cancelling]);

  const updateWatchHealth = useCallback((health: WatchHealth, listenerVerified = false) => {
    if (health.root !== activeRoot.current || health.epoch < watchEpoch.current) return;
    if (health.epoch === watchEpoch.current && health.revision <= watchHealthRevision.current) {
      if (listenerVerified && watchHealthRef.current?.root === health.root && watchHealthRef.current.state === health.state) {
        watchListenerUnavailableRef.current = false;
        setWatchListenerUnavailable(false);
        watchStatusUnavailableRef.current = false;
        setWatchStatusUnavailable(false);
        setWorkspaceStale(health.state !== 'watching');
      }
      return;
    }
    watchEpoch.current = health.epoch;
    watchHealthRevision.current = health.revision;
    watchRevision.current += 1;
    if (health.state !== 'watching') dirtyWatchRevision.current += 1;
    watchHealthRef.current = health;
    setWatchHealth(health);
    watchStatusUnavailableRef.current = false;
    setWatchStatusUnavailable(false);
    if (listenerVerified) {
      watchListenerUnavailableRef.current = false;
      setWatchListenerUnavailable(false);
    }
    setWorkspaceStale(health.state !== 'watching' || watchListenerUnavailableRef.current);
    const nextWatchMessage = health.message ?? (health.state === 'watching' ? 'Watching workspace files.' : health.state === 'stale' ? 'Files changed. Refresh before continuing.' : 'Watcher unavailable. Refresh before continuing.');
    const previousWatchMessage = watcherStatus.current;
    watcherStatus.current = nextWatchMessage;
    if (busyOperation.current === null) {
      if (health.state === 'watching') {
        if (isOutputStatus(statusText.current) && previousWatchMessage) {
          const suffix = ` · ${previousWatchMessage}`;
          if (statusText.current.endsWith(suffix)) setStatus(statusText.current.slice(0, -suffix.length));
        } else if (statusText.current === previousWatchMessage) {
          setStatus('');
        }
      } else if (isOutputStatus(statusText.current)) {
        setStatus(withWatcherStatus(statusText.current, nextWatchMessage, previousWatchMessage));
      } else {
        setStatus(nextWatchMessage);
      }
    }
  }, [setStatus]);

  useEffect(() => {
    const root = workspace?.root ?? null;
    activeRoot.current = root;
    if (fixtureMode || !root) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    if (watchHealthRef.current?.root !== root && !watchListenerUnavailableRef.current) {
      watchListenerUnavailableRef.current = true;
      setWatchListenerUnavailable(true);
      setWorkspaceStale(true);
    }
    const markStatusUnavailable = () => {
      if (!active) return;
      watchStatusUnavailableRef.current = true;
      setWatchStatusUnavailable(true);
      setWorkspaceStale(true);
      setStatus('Workspace status unavailable. Refresh before continuing.');
    };
    const markListenerUnavailable = () => {
      if (!active) return;
      watchListenerUnavailableRef.current = true;
      setWatchListenerUnavailable(true);
      markStatusUnavailable();
    };
    void bridge.on_watch_status((health) => { if (active) updateWatchHealth(health, true); }).then((dispose) => {
      if (!active) {
        dispose();
        return;
      }
      unlisten = dispose;
      watchListenerUnavailableRef.current = false;
      setWatchListenerUnavailable(false);
      return bridge.get_watch_status().then((health) => {
        if (!active) return;
        if (health) updateWatchHealth(health);
        else markStatusUnavailable();
      }).catch(markStatusUnavailable);
    }).catch(markListenerUnavailable);
    return () => { active = false; unlisten?.(); };
  }, [bridge, fixtureMode, setStatus, updateWatchHealth, watchSubscriptionAttempt, workspace?.root]);

  useEffect(() => {
    const root = workspace?.root;
    if (fixtureMode || !root) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const reconcileFocus = () => {
      if (!active || activeRoot.current !== root) return;
      setWorkspaceStale(true);
      if (!isOutputStatus(statusText.current)) setStatus('Revalidating workspace after focus…');
      void bridge.request_focus_reconcile(root).then((health) => {
        if (!active || activeRoot.current !== root) return;
        if (health) {
          watchStatusUnavailableRef.current = false;
          setWatchStatusUnavailable(false);
          updateWatchHealth(health);
        } else {
          watchStatusUnavailableRef.current = true;
          setWatchStatusUnavailable(true);
          setWorkspaceStale(true);
          const message = 'Workspace status unavailable. Refresh before continuing.';
          const previousWatchMessage = watcherStatus.current;
          watcherStatus.current = message;
          setStatus(withWatcherStatus(statusText.current, message, previousWatchMessage));
        }
      }).catch((cause: unknown) => {
        if (!active || activeRoot.current !== root) return;
        watchStatusUnavailableRef.current = true;
        setWatchStatusUnavailable(true);
        setWorkspaceStale(true);
        setError(errorMessage(cause, 'Workspace status could not be verified.'));
        const message = 'Workspace status unavailable. Refresh before continuing.';
        const previousWatchMessage = watcherStatus.current;
        watcherStatus.current = message;
        setStatus(withWatcherStatus(statusText.current, message, previousWatchMessage));
      });
    };
    const requestFocusReconcile = (requestedRoot: string) => {
      if (requestedRoot === root) reconcileFocus();
    };
    focusReconcileRequest.current = requestFocusReconcile;
    const handleFocus = () => {
      if (!active || activeRoot.current !== root) return;
      if (busyOperation.current === 'copy' || busyOperation.current === 'export') {
        pendingFocusReconcileRoot.current = root;
        setWorkspaceStale(true);
        if (!isOutputStatus(statusText.current)) setStatus('Workspace revalidation pending until output finishes…');
        return;
      }
      reconcileFocus();
    };
    void bridge.on_window_focus(handleFocus).then((dispose) => {
      if (!active) dispose();
      else unlisten = dispose;
    }).catch(() => {
      if (!active || activeRoot.current !== root) return;
      setWorkspaceStale(true);
      watchStatusUnavailableRef.current = true;
      setWatchStatusUnavailable(true);
      setStatus('Window focus recovery is unavailable. Refresh before continuing.');
    });
    return () => {
      active = false;
      unlisten?.();
      if (focusReconcileRequest.current === requestFocusReconcile) focusReconcileRequest.current = () => {};
    };
  }, [bridge, fixtureMode, setStatus, updateWatchHealth, workspace?.root]);

  useEffect(() => {
    if (busy === 'copy' || busy === 'export') return;
    const root = pendingFocusReconcileRoot.current;
    if (!root) return;
    pendingFocusReconcileRoot.current = null;
    focusReconcileRequest.current(root);
  }, [busy]);

  useEffect(() => {
    if (!estimateRoot || estimateGeneration === undefined || estimateSelectedCount === undefined) return;
    const root = estimateRoot;
    const generation = estimateGeneration;
    const selectedCount = estimateSelectedCount;
    const watcherIsStale = !fixtureMode && !watcherVerified;
    if (watcherIsStale) return;
    if (selectedCount === 0) return;

    const requestId = `${Date.now()}:${++tokenEstimateSequence.current}`;
    activeTokenEstimateRequest.current = requestId;
    setTokenEstimate({ root, generation, selectedCount, requestId, state: 'calculating' });
    void bridge.estimate_tokens({ generation, requestId }).then((estimate) => {
      if (activeTokenEstimateRequest.current !== requestId) return;
      if (estimate.requestId !== requestId || estimate.generation !== generation) {
        setTokenEstimate({ root, generation, selectedCount, requestId, state: 'unavailable' });
        return;
      }
      setTokenEstimate({ root, generation, selectedCount, requestId, state: 'ready', estimate });
    }).catch(() => {
      if (activeTokenEstimateRequest.current !== requestId) return;
      setTokenEstimate({ root, generation, selectedCount, requestId, state: 'unavailable' });
    });

    return () => {
      if (activeTokenEstimateRequest.current === requestId) activeTokenEstimateRequest.current = null;
      void bridge.cancel_token_estimate({ generation, requestId }).catch(() => {});
    };
  }, [bridge, estimateGeneration, estimateRoot, estimateSelectedCount, fixtureMode, watcherVerified]);

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
    if (!isOutputStatus(statusText.current)) setStatus(nextOffset === null ? '' : `${loaded} of ${initial.entryCount} items loaded`);
    while (nextOffset !== null) {
      const page = await bridge.workspace_page({ generation: initial.generation, offset: nextOffset });
      if (!isCurrent()) return;
      validateWorkspacePage(initial, page, nextOffset, loaded);
      setWorkspace((current) => current && current.root === initial.root && current.generation === initial.generation
        ? { ...current, entries: [...current.entries, ...page.entries], nextOffset: page.nextOffset }
        : current);
      loaded += page.entries.length;
      nextOffset = page.nextOffset;
      if (!isOutputStatus(statusText.current)) setStatus(nextOffset === null ? '' : `${loaded} of ${initial.entryCount} items loaded`);
    }
  }, [bridge, setStatus]);

  async function runWorkspaceCommand<T extends WorkspaceView | null>(
    name: string,
    action: () => Promise<T>,
    onInitial: (result: T) => void,
    isCurrent: () => boolean = () => true,
  ) {
    const requestId = ++busyRequestId.current;
    const requestEpoch = cancellationEpoch.current;
    const startingWatchRevision = watchRevision.current;
    const startingDirtyWatchRevision = dirtyWatchRevision.current;
    let statusUnavailableAfterRefresh = false;
    const stillCurrent = () => cancellationEpoch.current === requestEpoch && isCurrent();
    setBusy(name);
    setCancelling(false);
    setError('');
    if (name !== 'refresh' || !isOutputStatus(statusText.current)) {
      setStatus('');
    } else if (watcherStatus.current) {
      const suffix = ` · ${watcherStatus.current}`;
      if (statusText.current.endsWith(suffix)) setStatus(statusText.current.slice(0, -suffix.length));
    }
    try {
      const result = await action();
      if (!stillCurrent()) return;
      if (result) validateInitialWorkspace(result);
      if (result && name === 'refresh' && !fixtureMode) {
        const health = await bridge.get_watch_status().catch(() => null);
        if (!stillCurrent()) return;
        if (health) {
          watchStatusUnavailableRef.current = false;
          setWatchStatusUnavailable(false);
          updateWatchHealth(health);
        }
        else {
          statusUnavailableAfterRefresh = true;
          setWorkspaceStale(true);
          watchStatusUnavailableRef.current = true;
          setWatchStatusUnavailable(true);
          setStatus('Watcher status unavailable. Refresh before continuing.');
        }
      }
      onInitial(result);
      if (statusUnavailableAfterRefresh) setWorkspaceStale(true);
      if (result && watchRevision.current !== startingWatchRevision) {
        const health = watchHealthRef.current;
        setWorkspaceStale(statusUnavailableAfterRefresh || watchListenerUnavailableRef.current || Boolean(health && health.root === result.root && health.state !== 'watching'));
      }
      if (result && name !== 'refresh' && dirtyWatchRevision.current !== startingDirtyWatchRevision && watchHealthRef.current?.root === result.root) {
        const currentHealth = watchHealthRef.current;
        const staleHealth: WatchHealth = currentHealth.state === 'unavailable' ? currentHealth : {
          ...currentHealth,
          state: 'stale',
          message: 'Files changed during this operation. Refresh again to reconcile.',
        };
        watchHealthRef.current = staleHealth;
        setWatchHealth(staleHealth);
        setWorkspaceStale(true);
        setStatus(staleHealth.message ?? 'Watcher unavailable. Refresh before continuing.');
      }
      if (result) await loadWorkspacePages(result, stillCurrent);
    } catch (cause) {
      if (stillCurrent()) {
        setError(errorMessage(cause, 'The request could not be completed.'));
        if (name === 'policy') setPolicyUpdateState('failed');
      }
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
      setSelectedProfileName(restored.profileCatalog.activeProfile ?? restored.profileCatalog.names[0] ?? '');
      setRenameProfileName(restored.profileCatalog.activeProfile ?? '');
      policyDirty.current = false;
      setHasUnappliedPolicy(false);
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
  }, [bridge, loadWorkspacePages, setBusy]);

  useEffect(() => {
    if (!activeWorkspaceRoot) return;
    let active = true;
    void bridge.get_export_destination().then((result) => {
      if (active) setExportDestination(result);
    }).catch((cause: unknown) => {
      if (active) setError(errorMessage(cause, 'Export destination settings could not be loaded.'));
    });
    return () => { active = false; };
  }, [activeWorkspaceRoot, bridge]);

  async function runCommand<T>(name: string, action: () => Promise<T>, onSuccess: (result: T) => void, isCurrent: () => boolean = () => true, onDiscard?: (result: T) => void) {
    const requestId = ++busyRequestId.current;
    const requestEpoch = cancellationEpoch.current;
    setBusy(name);
    setCancelling(false);
    setError('');
    setStatus('');
    try {
      const result = await action();
      if (cancellationEpoch.current === requestEpoch && isCurrent()) onSuccess(result);
      else onDiscard?.(result);
    } catch (cause) {
      if (cancellationEpoch.current === requestEpoch && isCurrent()) setError(errorMessage(cause, 'The request could not be completed.'));
    } finally {
      if (busyRequestId.current === requestId) setBusy(null);
    }
  }

  function commitWorkspace(result: WorkspaceView, hydratePolicy = !policyDirty.current, preservePreview = false) {
    if (workspace && workspace.root === result.root && result.generation < workspace.generation) return;
    const rootChanged = workspace?.root !== result.root;
    const snapshotChanged = rootChanged || !workspace || workspace.generation !== result.generation;
    if (hydratePolicy || rootChanged) {
      setPolicy(result.policy);
      policyDirty.current = false;
      setHasUnappliedPolicy(false);
      setPolicyUpdateState('idle');
    }
    if (rootChanged) {
      activeRoot.current = result.root;
      watchHealthRef.current = null;
      setWatchHealth(null);
      watchListenerUnavailableRef.current = !fixtureMode;
      setWatchListenerUnavailable(!fixtureMode);
      watchStatusUnavailableRef.current = !fixtureMode;
      setWatchStatusUnavailable(!fixtureMode);
      setExpanded(new Set());
      setQuery('');
      setFileView('all');
      setSettingsOpen(false);
    }
    if (snapshotChanged) {
      setSelectedProfileName(result.profileCatalog.activeProfile ?? result.profileCatalog.names[0] ?? '');
      setRenameProfileName(result.profileCatalog.activeProfile ?? '');
    }
    if (!preservePreview && snapshotChanged) {
      previewRequestId.current += 1;
      setPreview(null);
    }
    setWorkspace(result);
    const health = watchHealthRef.current;
    setWorkspaceStale((rootChanged && !fixtureMode) || watchStatusUnavailableRef.current || watchListenerUnavailableRef.current || (health?.root === result.root && health.state !== 'watching'));
  }

  function changeProfileCatalog(
    action: () => Promise<ProfileCatalog>,
    preferredName: string | null,
    successMessage: string,
  ) {
    if (!workspace || workspaceStale || cancelling || busy !== null) return;
    const { root, generation } = workspace;
    const requestId = ++workspaceRequestId.current;
    void runCommand('profile', action, (catalog) => {
      if (catalog.root !== root || catalog.generation !== generation) return;
      setWorkspace((current) => current && current.root === root && current.generation === generation
        ? { ...current, profileCatalog: catalog }
        : current);
      setSelectedProfileName(preferredName ?? catalog.activeProfile ?? catalog.names[0] ?? '');
      setRenameProfileName(catalog.activeProfile ?? '');
      setStatus(successMessage);
    }, () => requestId === workspaceRequestId.current);
  }

  function createProfile() {
    const name = newProfileName;
    if (!name.trim()) return;
    changeProfileCatalog(() => bridge.create_profile({ name }), name.trim(), 'Profile saved.');
  }

  function updateProfile() {
    if (!selectedProfileName) return;
    changeProfileCatalog(() => bridge.update_profile({ name: selectedProfileName }), selectedProfileName, 'Profile updated.');
  }

  function loadProfile() {
    if (!workspace || !selectedProfileName || workspaceStale || cancelling || busy !== null) return;
    const root = workspace.root;
    const requestId = ++workspaceRequestId.current;
    void runWorkspaceCommand('profile', () => bridge.load_profile({ name: selectedProfileName }), (result) => {
      if (policyDebounceTimer.current !== null) window.clearTimeout(policyDebounceTimer.current);
      policyDebounceTimer.current = null;
      policyRevision.current += 1;
      policyDirty.current = false;
      setHasUnappliedPolicy(false);
      commitWorkspace(result, true, true);
      setStatus(`Loaded profile: ${selectedProfileName}`);
    }, () => requestId === workspaceRequestId.current && workspace?.root === root);
  }

  function renameProfile() {
    if (!selectedProfileName || !renameProfileName.trim()) return;
    const currentName = selectedProfileName;
    const newName = renameProfileName;
    changeProfileCatalog(() => bridge.rename_profile({ currentName, newName }), newName.trim(), 'Profile renamed.');
  }

  function deleteProfile() {
    if (!selectedProfileName) return;
    changeProfileCatalog(
      () => bridge.delete_profile({ name: selectedProfileName }),
      null,
      'Profile deleted.',
    );
  }

  function openWorkspace() {
    if (cancelling || busyOperation.current === 'copy' || busyOperation.current === 'export' || busyOperation.current === 'open') return;
    const requestId = ++workspaceRequestId.current;
    void runWorkspaceCommand('open', () => bridge.choose_workspace(), (result) => {
      if (!result) return;
      commitWorkspace(result, true);
      setExpanded(new Set());
      setQuery('');
    }, () => requestId === workspaceRequestId.current);
  }

  function refresh() {
    const health = watchHealthRef.current;
    if (health?.state === 'stale') {
      autoRefreshAttempt.current = { epoch: health.epoch, revision: health.revision };
    }
    if (watchListenerUnavailableRef.current) setWatchSubscriptionAttempt((attempt) => attempt + 1);
    const requestId = ++workspaceRequestId.current;
    void runWorkspaceCommand('refresh', () => bridge.refresh_workspace(), commitWorkspace, () => requestId === workspaceRequestId.current);
  }

  useEffect(() => {
    refreshRequest.current = refresh;
  });

  useEffect(() => {
    const health = watchHealth;
    const root = workspace?.root;
    if (fixtureMode || !health || !root || health.root !== root || health.state !== 'stale') return;
    if (autoRefreshAttempt.current.epoch !== health.epoch) {
      autoRefreshAttempt.current = { epoch: health.epoch, revision: 0 };
    }
    if (health.revision <= autoRefreshAttempt.current.revision || busy !== null || cancelling) return;

    const epoch = health.epoch;
    const timer = window.setTimeout(() => {
      const latest = watchHealthRef.current;
      if (latest?.root !== root || latest.epoch !== epoch || latest.state !== 'stale') return;
      const attempted = autoRefreshAttempt.current;
      if (attempted.epoch === latest.epoch && attempted.revision >= latest.revision) return;
      autoRefreshAttempt.current = { epoch: latest.epoch, revision: latest.revision };
      refreshRequest.current();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [busy, cancelling, fixtureMode, watchHealth, workspace?.root]);

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

  function queuePolicyUpdate(nextPolicy: FilterPolicy) {
    policyDirty.current = true;
    setHasUnappliedPolicy(true);
    setPolicyUpdateState('pending');
    setError('');
    setPolicy(nextPolicy);
    if (policyDebounceTimer.current !== null) window.clearTimeout(policyDebounceTimer.current);
    const revision = ++policyRevision.current;
    const root = workspace?.root;
    const applyWhenReady = () => {
      if (!root || activeRoot.current !== root || revision !== policyRevision.current) return;
      if (workspaceStaleRef.current || cancellingRef.current || busyOperation.current !== null) {
        policyDebounceTimer.current = window.setTimeout(applyWhenReady, 300);
        return;
      }
      policyDebounceTimer.current = null;
      const requestId = ++workspaceRequestId.current;
      void runWorkspaceCommand('policy', () => bridge.set_policy({ policy: nextPolicy }), (result) => commitWorkspace(result, true), () => requestId === workspaceRequestId.current && revision === policyRevision.current && activeRoot.current === root);
    };
    policyDebounceTimer.current = window.setTimeout(() => {
      applyWhenReady();
    }, 300);
  }

  function resetFilters() {
    if (!workspace || workspaceStale || cancelling) return;
    queuePolicyUpdate({ ...DEFAULT_FILTER_POLICY });
  }

  function toggleSidebar() {
    const nextCollapsed = !sidebarCollapsed;
    setSidebarCollapsed(nextCollapsed);
    if (nextCollapsed) setPolicyOpen(false);
  }

  function chooseExportFolder() {
    if (busy !== null || workspaceStale || cancelling) return;
    void runCommand('settings', () => bridge.choose_export_destination_folder(), (result) => {
      if (result) setExportDestination(result);
    }, () => !workspaceStaleRef.current);
  }

  function updateExportDestinationMode(enabled: boolean, alwaysOverwrite: boolean) {
    if (busy !== null || workspaceStale || cancelling) return;
    void runCommand('settings', () => bridge.set_export_destination_mode({ enabled, alwaysOverwrite }), setExportDestination, () => !workspaceStaleRef.current);
  }

  function exportContent(copied: boolean) {
    if (!workspace || workspaceStale || cancelling) return;
    const kind = copied ? 'copy' : 'export';
    const root = workspace.root;
    const generation = workspace.generation;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void runCommand(kind, () => copied ? bridge.copy_markdown() : bridge.export_markdown(), (result) => {
      if (result && 'confirmationRequired' in result && result.confirmationRequired) {
        const prompt: SensitivePrompt = { ticket: result.ticket, kind, summary: result.summary, root, generation, trigger };
        if (sensitiveSnapshotCurrent(prompt)) {
          setSensitivePromptState(prompt);
        } else {
          void bridge.cancel_sensitive_output({ ticket: result.ticket }).catch(() => {});
          setError('Workspace changed before confirmation. Refresh and start again.');
        }
      } else if (result && !('confirmationRequired' in result) && workspace?.root === root && workspace.generation === generation) {
        setStatus(exportSummary(result, copied));
      }
    }, () => true, (result) => {
      if (result && 'confirmationRequired' in result && result.confirmationRequired) {
        void bridge.cancel_sensitive_output({ ticket: result.ticket }).catch(() => {});
      }
    });
  }

  function confirmSensitiveOutput() {
    const prompt = sensitivePromptRef.current;
    if (!prompt) return;
    if (!sensitiveSnapshotCurrent(prompt)) {
      closeSensitivePrompt(true);
      setError('Workspace changed before confirmation. Refresh and start again.');
      return;
    }
    pendingOutputFocusReturn.current = prompt.trigger;
    closeSensitivePrompt(false);
    void runCommand(prompt.kind, () => bridge.confirm_sensitive_output({ ticket: prompt.ticket }), (result) => {
      if (result && workspace?.root === prompt.root && workspace.generation === prompt.generation) {
        setStatus(exportSummary(result, prompt.kind === 'copy'));
      } else if (result === null && workspace?.root === prompt.root && workspace.generation === prompt.generation) {
        setStatus(prompt.kind === 'export' ? 'Export cancelled.' : 'Copy cancelled.');
      }
    });
  }

  function handleSensitiveDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSensitivePrompt(true);
      return;
    }
    if (event.key !== 'Tab') return;
    const cancel = sensitiveCancelRef.current;
    const confirm = sensitiveConfirmRef.current;
    if (!cancel || !confirm) return;
    if (event.shiftKey && document.activeElement === cancel) {
      event.preventDefault();
      confirm.focus();
    } else if (!event.shiftKey && document.activeElement === confirm) {
      event.preventDefault();
      cancel.focus();
    }
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

  function updateExtensionMode(includeMode: FilterPolicy['includeMode']) {
    queuePolicyUpdate({ ...policy, includeMode, includePaths: [], excludePaths: [] });
  }

  function toggleExtension(extension: string, included: boolean) {
    const normalize = (value: string) => value.trim() ? `.${value.trim().replace(/^\.+/, '').toLocaleLowerCase()}` : '';
    const extensions = new Set(policy.includeExtensions.map(normalize));
    if (included) extensions.add(extension);
    else extensions.delete(extension);
    queuePolicyUpdate({
      ...policy,
      includeMode: 'selectedExtensions',
      includeExtensions: [...extensions].sort((left, right) => left.localeCompare(right)),
      includePaths: [],
      excludePaths: [],
    });
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
  const tokenEstimateStale = Boolean(workspace && !watcherVerified);
  const tokenEstimateMatches = Boolean(workspace && tokenEstimate
    && tokenEstimate.root === workspace.root
    && tokenEstimate.generation === workspace.generation
    && tokenEstimate.selectedCount === workspace.selectedCount);
  const tokenEstimateStatus = !workspace
    ? 'unavailable'
    : tokenEstimateStale
      ? 'stale'
      : workspace.selectedCount === 0
        ? 'ready'
        : !tokenEstimateMatches
          ? 'calculating'
          : tokenEstimate?.state ?? 'calculating';
  const tokenEstimateLabel = tokenEstimateStatus === 'ready'
    ? `≈ ${new Intl.NumberFormat('en-US').format(workspace?.selectedCount === 0 ? 0 : tokenEstimate?.estimate?.tokens ?? 0)}`
    : tokenEstimateStatus === 'calculating' ? 'Calculating…'
      : tokenEstimateStatus === 'stale' ? 'Stale' : 'Unavailable';
  const tokenEstimateDetail = tokenEstimateStatus === 'ready'
    ? `${tokenEstimate?.estimate?.tokenizerId ?? 'o200k_base'} · approximate`
    : 'Token estimate';
  const tokenEstimateTitle = tokenEstimateStatus === 'stale'
    ? 'Token count is hidden until the workspace watcher is current.'
    : tokenEstimateStatus === 'unavailable'
      ? 'A selected file could not be safely counted.'
      : 'Approximate local o200k_base count; file sections are counted independently.';

  return (
    <main className="app-shell">
      <WorkspaceToolbar
        root={workspace?.root ?? null}
        refreshDisabled={!workspace || busy !== null || cancelling}
        openDisabled={busy === 'copy' || busy === 'export' || busy === 'open' || cancelling}
        onRefresh={refresh}
        onOpen={openWorkspace}
      />

      {fixtureMode && <div className="fixture-banner" role="note"><span>Browser fixture mode</span><span>Sample responses · no files are read</span></div>}

        <section className={`workbench${workspace ? ' has-workspace' : ''}${workspace && !sidebarCollapsed ? ' has-sidebar' : ''}${workspace && sidebarCollapsed ? ' sidebar-collapsed' : ''}${previewCollapsed ? ' preview-collapsed' : ''}${policyOpen ? ' is-filtering' : ''}`} data-workspace-generation={workspace?.generation} style={workspace ? { '--preview-width': `${previewWidth}%` } as CSSProperties : undefined} aria-label="Project files and preview">
        {workspace && <WorkspaceSidebar
          collapsed={sidebarCollapsed}
          view={fileView}
          settingsOpen={settingsOpen}
          filtersOpen={policyOpen}
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
        />}
        <section className="panel file-panel" aria-label={policyOpen ? 'Filter editor' : settingsOpen ? 'Workspace settings' : 'Project files'}>
          <div className="panel-heading"><div><h2>{policyOpen ? 'Filters' : settingsOpen ? 'Settings' : fileView === 'selected' ? 'Selected files' : fileView === 'ignored' ? 'Git-ignored files' : 'Project files'}</h2><p>{workspace ? indexLoading ? `${workspace.entries.length} of ${workspace.entryCount} items loaded` : `${workspace.entryCount} items discovered` : 'Open a folder to get started'}</p></div><div className="scan-statuses">{workspace && !settingsOpen && !policyOpen && <><span className="refresh-badge" title={busy === 'refresh' ? 'Revalidating workspace files.' : watchStatusUnavailable || watchListenerUnavailable ? 'Watcher status or notifications could not be verified. Refresh before continuing.' : watchHealth?.root === workspace.root ? watchHealth.message ?? (watchHealth.state === 'watching' ? 'Watching workspace files.' : watchHealth.state === 'stale' ? 'Files changed. Refresh to update the workspace.' : 'Watcher unavailable. Refresh manually to update the workspace.') : 'Automatic file watching is unavailable in this browser fixture. Refresh after changing files.'}>{busy === 'refresh' ? 'Updating' : watchStatusUnavailable || watchListenerUnavailable ? 'Status unavailable' : watchHealth?.root === workspace.root ? watchHealth.state === 'watching' ? 'Watching' : watchHealth.state === 'stale' ? 'Files changed' : 'Watcher unavailable' : 'Manual refresh'}</span></>}{workspace?.incomplete && <span className="scan-badge"><span className="scan-dot" /> Partial scan</span>}</div></div>
          {workspace ? policyOpen ? <WorkspaceFilters
          gitignore={policy.gitignore}
          includeMode={policy.includeMode}
          includeExtensions={policy.includeExtensions}
          disabled={!workspace || workspaceStale || busy !== null || cancelling}
          updateState={policyUpdateState}
          onGitignoreChange={(enabled) => queuePolicyUpdate({ ...policy, gitignore: enabled })}
          onModeChange={updateExtensionMode}
          onExtensionChange={toggleExtension}
          onReset={resetFilters}
          /> : settingsOpen ? <section className="settings-content" aria-label="Settings">
            <div className="settings-icon"><UiIcon icon={IconSettings} /></div>
            <h3>Local workspace settings</h3>
            <p>Workspace path, filters, and file selection choices are saved locally on this device.</p>
            <section className="export-destination-settings" aria-labelledby="export-destination-heading">
              <h3 id="export-destination-heading">Export destination</h3>
              <div className="settings-action">
                <div><strong>Export folder</strong><small>{exportDestination.settings.folder ?? 'Choose where fixed-folder exports should be saved.'}</small></div>
                <button className="button button-secondary" onClick={chooseExportFolder} disabled={busy !== null || workspaceStale || cancelling}>Choose export folder</button>
              </div>
              <label className="settings-check">
                <input type="checkbox" aria-label="Always export to this folder" checked={exportDestination.settings.enabled} onChange={(event) => updateExportDestinationMode(event.target.checked, exportDestination.settings.alwaysOverwrite)} disabled={busy !== null || workspaceStale || cancelling || !exportDestination.settings.folder} />
                <span>Always export to this folder</span>
              </label>
              <label className="settings-check">
                <input type="checkbox" aria-label="Always overwrite this file" checked={exportDestination.settings.alwaysOverwrite} onChange={(event) => updateExportDestinationMode(exportDestination.settings.enabled, event.target.checked)} disabled={!exportDestination.settings.enabled || busy !== null || workspaceStale || cancelling} />
                <span>Always overwrite this file</span>
              </label>
              {exportDestination.settings.enabled && exportDestination.settings.alwaysOverwrite && !exportDestination.overwriteAllowed && <p className="export-destination-warning">Always overwrite requires a folder outside the active workspace. Turn it off to keep numbered exports here.</p>}
              {exportDestination.settings.enabled && exportDestination.targetPath && <p className="export-target-preview">Current target: <code>{exportDestination.targetPath}</code></p>}
            </section>
            <section className="profile-settings" aria-labelledby="profile-settings-heading">
              <h3 id="profile-settings-heading">Selection profiles</h3>
              <p>Save filters and file choices for this workspace. Profiles stay on this device.</p>
              <p className="profile-active" role="status">Active profile: <strong>{profileCatalog?.activeProfile ?? 'Custom'}</strong></p>
              <label className="profile-field">
                <span>Saved profile</span>
                <select aria-label="Saved profile" value={selectedProfileName} onChange={(event) => {
                  const name = event.target.value;
                  setSelectedProfileName(name);
                  setRenameProfileName(name);
                }} disabled={busy !== null || workspaceStale || cancelling}>
                  {profileCatalog?.names.length === 0 && <option value="">No saved profiles</option>}
                  {profileCatalog?.names.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <div className="profile-buttons">
                <button className="button button-secondary" onClick={loadProfile} disabled={!selectedProfileName || !profileCatalog?.names.includes(selectedProfileName) || busy !== null || workspaceStale || cancelling}>Load profile</button>
                <button className="button button-secondary" onClick={updateProfile} disabled={!selectedProfileName || !profileCatalog?.names.includes(selectedProfileName) || busy !== null || workspaceStale || cancelling || hasUnappliedPolicy}>Update profile</button>
              </div>
              {hasUnappliedPolicy && <p className="profile-note">Filter changes are applied automatically. Wait for the update to finish before saving a profile; loading a profile replaces pending filter edits.</p>}
              <label className="profile-field">
                <span>New profile name</span>
                <input value={newProfileName} maxLength={80} onChange={(event) => setNewProfileName(event.target.value)} placeholder="e.g. Documentation" />
              </label>
              <button className="button button-secondary" onClick={createProfile} disabled={!newProfileName.trim() || !profileCatalog || profileCatalog.names.length >= 20 || busy !== null || workspaceStale || cancelling || hasUnappliedPolicy}>Save as profile</button>
              <label className="profile-field">
                <span>Rename selected profile</span>
                <input value={renameProfileName} maxLength={80} onChange={(event) => setRenameProfileName(event.target.value)} disabled={!selectedProfileName} />
              </label>
              <div className="profile-buttons">
                <button className="button button-secondary" onClick={renameProfile} disabled={!selectedProfileName || !renameProfileName.trim() || busy !== null || workspaceStale || cancelling}>Rename profile</button>
                <button className="button button-secondary" onClick={deleteProfile} disabled={!selectedProfileName || !profileCatalog?.names.includes(selectedProfileName) || busy !== null || workspaceStale || cancelling}>Delete profile</button>
              </div>
              <small className="profile-limit">Up to 20 profiles per workspace.</small>
            </section>
            <div className="settings-action">
              <div><strong>Reset selections</strong><small>Clear saved file and folder choices. Your filters stay in place.</small></div>
              <button className="button button-secondary" onClick={resetSelections} disabled={busy !== null || workspaceStale || cancelling}>Reset selections</button>
            </div>
          </section> : <>
            <label className="search-box"><UiIcon icon={IconSearch} size={17} /><span className="sr-only">Search files</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files and folders" /></label>
            <ProjectTree entries={visibleEntries} expanded={expanded} actionPath={actionPath} busy={busy !== null || workspaceStale} previewDisabled={workspaceStale || cancelling || (busy !== null && busy !== 'preview')} query={query}
              onExpand={toggleExpanded} onBrowse={browseIgnored} onPreview={previewFile} onIntent={setIntent} onAction={setActionPath} />
            <div className="tree-legend"><span><i className="legend-dot selected-dot" /> Included</span><span><i className="legend-dot muted-dot" /> Filtered</span><span><i className="legend-dot override-dot" /> Force included</span></div>
            {workspace.diagnostics.length > 0 && <ul className="diagnostics">{workspace.diagnostics.map((item) => <li key={item}>{item}</li>)}</ul>}
          </> : <div className="file-empty"><div className="empty-illustration" aria-hidden="true"><UiIcon icon={IconFolderOpen} size={28} /><span className="empty-add"><UiIcon icon={IconPlus} size={13} /></span></div><h3>Start with a local folder</h3><p>ContextPick reads your project on this device and keeps your source files untouched.</p><button className="button button-primary" onClick={openWorkspace} disabled={cancelling}>Choose a folder <UiIcon icon={IconArrowRight} size={15} /></button><small>Works offline · your code stays private</small></div>}
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
              {!previewCollapsed && preview && <span className="readonly-badge"><UiIcon icon={IconEye} size={14} /> Read only</span>}
              <button ref={previewToggleRef} className="preview-toggle" type="button" aria-label={previewCollapsed ? 'Expand preview' : 'Collapse preview'} aria-expanded={!previewCollapsed} onClick={() => setPreviewCollapsed((collapsed) => !collapsed)}><UiIcon icon={previewCollapsed ? IconChevronLeft : IconChevronRight} /></button>
            </div>
          </div>
          {!previewCollapsed && (preview ? <div className="code-preview"><div className="code-toolbar"><span><i className="code-dot" />{preview.path.split('.').pop()}</span><span>{preview.content.truncated ? 'Preview truncated' : 'UTF-8 text'}</span></div><pre><code>{preview.content.text}</code></pre>{preview.content.truncated && <div className="truncation-note">Preview is capped. Export includes the full eligible file.</div>}</div> : <div className="preview-empty"><div className="preview-placeholder" aria-hidden="true"><UiIcon icon={IconCode} size={27} /><i /><i /><i /><i /><i /></div><h3>{workspace ? 'Select a text file to preview' : 'Your preview appears here'}</h3><p>{workspace ? 'Choose a file from the tree to inspect its contents.' : 'Open a folder, then select a file to see its contents before export.'}</p></div>)}
        </section>
      </section>

      <div className="bottom-dock">
        <div className="dock-notices">
          <div className="live-region" aria-live="polite" role="status">{status || (busy === 'refresh' ? 'Updating workspace…' : workspaceStale ? watchHealth?.message ?? (watchHealth?.state === 'unavailable' ? 'Watcher unavailable. Refresh before continuing.' : 'Files changed. Refresh before continuing.') : '') || (busy ? `${busy === 'preview' ? 'Loading preview' : 'Working'}…` : '')}</div>
          {error && <div className="error-toast" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><UiIcon icon={IconX} size={17} /></button></div>}
        </div>
        <footer className="export-bar">
          <div className="footer-metrics" role="group" aria-label="Selection estimates">
            <div className="metric metric-primary"><span className="metric-icon"><UiIcon icon={IconFileText} /></span><span><strong>{workspace ? workspace.selectedCount : '—'}</strong><small>Selected files</small></span></div>
            <div className="metric"><span className="metric-icon"><UiIcon icon={IconFileExport} /></span><span><strong>{workspace ? `≈ ${formatBytes(workspace.estimatedBytes)}` : '—'}</strong><small>Estimated export size</small></span></div>
            <div className="metric token-metric" aria-live="polite" aria-atomic="true"><span className="metric-icon"><UiIcon icon={IconHash} /></span><span><strong>{tokenEstimateLabel}</strong><small>{tokenEstimateDetail}</small></span><button className="info-tip" type="button" title={tokenEstimateTitle} aria-label={tokenEstimateTitle}><UiIcon icon={IconInfoCircle} size={16} /></button></div>
          </div>
          <div className="export-actions">
            {['restore', 'open', 'refresh', 'browse', 'export', 'copy'].includes(busy ?? '') && <button ref={cancelOperationButtonRef} className="button button-secondary cancel-button" onClick={cancelOperation} disabled={cancelling}>{cancelling ? 'Cancelling…' : 'Cancel operation'}</button>}
            <button className="button button-secondary" onClick={() => exportContent(true)} disabled={!workspace || !watcherVerified || workspaceStale || workspace.selectedCount === 0 || busy !== null || cancelling}><UiIcon icon={IconCopy} size={16} /> Copy context</button>
            <span className="export-button-wrap">
              <button className="button button-primary export-button" onClick={() => exportContent(false)} disabled={!workspace || !watcherVerified || workspaceStale || workspace.selectedCount === 0 || busy !== null || cancelling} aria-describedby={exportTargetHint ? 'export-target-tooltip' : undefined}>{busy === 'export' ? 'Preparing…' : 'Export Markdown'} <UiIcon icon={IconArrowRight} size={16} /></button>
              {exportTargetHint && <span className="export-target-tooltip" role="tooltip" id="export-target-tooltip">{exportTargetHint}</span>}
            </span>
          </div>
        </footer>
      </div>

      {sensitivePrompt && <div className="sensitive-backdrop">
        <div
          className="sensitive-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="sensitive-dialog-title"
          aria-describedby="sensitive-dialog-description"
          ref={sensitiveDialogRef}
          onKeyDown={handleSensitiveDialogKeyDown}
        >
          <span className="sensitive-dialog-icon"><UiIcon icon={IconAlertTriangle} size={19} /></span>
          <h2 id="sensitive-dialog-title">Potentially sensitive files</h2>
          <p id="sensitive-dialog-description">{sensitivePrompt.summary.total} selected files have names commonly used for sensitive material.</p>
          <ul className="sensitive-warning-list">
            {sensitivePrompt.summary.warnings.map((warning) => <li key={`${warning.path}:${warning.category}`}>
              <code>{warning.path}</code>
              <span>{warning.category === 'environmentFile' ? 'Environment file' : warning.category === 'pemMaterial' ? 'PEM material' : warning.category === 'privateKey' ? 'Private key' : 'Credential file'}</span>
            </li>)}
          </ul>
          {sensitivePrompt.summary.omitted > 0 && <p className="sensitive-omission">{sensitivePrompt.summary.omitted} more flagged files will also be included.</p>}
          <p className="sensitive-disclaimer">Warnings use filenames only. File contents are not scanned, and names do not prove a file contains a secret.</p>
          <div className="sensitive-dialog-actions">
            <button ref={sensitiveCancelRef} className="button button-secondary" onClick={() => closeSensitivePrompt(true)}>{sensitivePrompt.kind === 'copy' ? 'Cancel Copy' : 'Cancel Export'}</button>
            <button ref={sensitiveConfirmRef} className="button button-primary" onClick={confirmSensitiveOutput}>{sensitivePrompt.kind === 'copy' ? 'Confirm Copy' : 'Confirm Export'}</button>
          </div>
        </div>
      </div>}
    </main>
  );
}
