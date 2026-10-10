import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { IconBan, IconChevronDown, IconChevronRight, IconDotsVertical, IconFileText, IconFolder, IconFolderOpen } from '@tabler/icons-react';
import type { Entry, SelectionIntent } from './bridge';
import { formatBytes } from './format';
import { UiIcon } from './UiIcon';

type ProjectTreeProps = {
  entries: Entry[];
  expanded: Set<string>;
  actionPath: string | null;
  busy: boolean;
  previewDisabled: boolean;
  query: string;
  onExpand: (entry: Entry) => void;
  onBrowse: (path: string) => void;
  onPreview: (path: string) => void;
  onIntent: (path: string, intent: SelectionIntent) => void;
  onAction: (path: string | null) => void;
};

export function ProjectTree({ entries, expanded, actionPath, busy, previewDisabled, query, onExpand, onBrowse, onPreview, onIntent, onAction }: ProjectTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocusPath = useRef<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const entryIndexes = useMemo(() => new Map(entries.map((entry, index) => [entry.path, index])), [entries]);
  const siblingPositions = useMemo(() => {
    const siblingsByParent = new Map<string, string[]>();
    for (const entry of entries) {
      const separator = entry.path.lastIndexOf('/');
      const parent = separator < 0 ? '' : entry.path.slice(0, separator);
      const siblings = siblingsByParent.get(parent) ?? [];
      siblings.push(entry.path);
      siblingsByParent.set(parent, siblings);
    }
    const positions = new Map<string, { position: number; size: number }>();
    for (const siblings of siblingsByParent.values()) {
      siblings.forEach((path, index) => positions.set(path, { position: index + 1, size: siblings.length }));
    }
    return positions;
  }, [entries]);
  const activeIndex = activePath === null ? undefined : entryIndexes.get(activePath);
  const tabStopIndex = activeIndex ?? 0;
  const tabStopPath = entries[tabStopIndex]?.path ?? null;
  const getItemKey = useCallback((index: number) => entries[index]?.path ?? index, [entries]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range);
    const focusedIndex = tabStopPath === null ? undefined : entryIndexes.get(tabStopPath);
    if (focusedIndex === undefined || indexes.includes(focusedIndex)) return indexes;
    return [...indexes, focusedIndex].sort((left, right) => left - right);
  }, [entryIndexes, tabStopPath]);
  // TanStack Virtual exposes an imperative instance; direct reads are part of its documented usage.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    getItemKey,
    overscan: 8,
    initialRect: { width: 720, height: 224 },
    rangeExtractor,
    useFlushSync: false,
  });
  const items = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    if (entries.length === 0) {
      if (activePath !== null) setActivePath(null);
    } else if (activeIndex === undefined) {
      setActivePath(entries[0]?.path ?? null);
    }
  }, [activeIndex, activePath, entries]);

  useLayoutEffect(() => {
    const path = pendingFocusPath.current;
    if (path === null) return;
    const index = entryIndexes.get(path);
    if (index === undefined) {
      pendingFocusPath.current = null;
      return;
    }
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"] [role="treeitem"]`);
    if (!row) return;
    pendingFocusPath.current = null;
    row.focus({ preventScroll: true });
  }, [entryIndexes, items]);

  const focusEntry = useCallback((index: number) => {
    const entry = entries[index];
    if (!entry) return;
    if (entry.path === activePath) {
      pendingFocusPath.current = null;
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"] [role="treeitem"]`);
      virtualizer.scrollToIndex(index, { align: 'auto' });
      row?.focus({ preventScroll: true });
      return;
    }
    pendingFocusPath.current = entry.path;
    setActivePath(entry.path);
    virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [activePath, entries, virtualizer]);

  const handleTreeItemKeyDown = useCallback((entry: Entry, index: number, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const isRowFocus = event.target === event.currentTarget;
    let targetIndex: number | undefined;
    switch (event.key) {
      case 'ArrowDown': targetIndex = Math.min(entries.length - 1, index + 1); break;
      case 'ArrowUp': targetIndex = Math.max(0, index - 1); break;
      case 'Home': targetIndex = 0; break;
      case 'End': targetIndex = entries.length - 1; break;
      case 'ArrowRight': {
        const child = entries[index + 1];
        if (entry.kind === 'directory' && (expanded.has(entry.path) || (query.trim() && child?.path.startsWith(`${entry.path}/`)))) {
          if (child?.path.startsWith(`${entry.path}/`)) targetIndex = index + 1;
        } else if (entry.kind === 'directory' && entry.enumerated && !query.trim()) {
          onExpand(entry);
        } else if (entry.kind === 'directory' && !entry.enumerated && entry.reason !== null && !busy && !previewDisabled) {
          onBrowse(entry.path);
        }
        break;
      }
      case 'ArrowLeft': {
        if (entry.kind === 'directory' && expanded.has(entry.path) && !query.trim()) {
          onExpand(entry);
        } else {
          const separator = entry.path.lastIndexOf('/');
          const parent = separator < 0 ? undefined : entry.path.slice(0, separator);
          if (parent !== undefined) targetIndex = entryIndexes.get(parent);
        }
        break;
      }
      case 'Enter':
        if (!isRowFocus) return;
        if (entry.kind === 'file' && !previewDisabled) onPreview(entry.path);
        else if (entry.kind === 'directory' && !entry.enumerated && entry.reason !== null && !busy && !previewDisabled) onBrowse(entry.path);
        else if (entry.kind === 'directory') onExpand(entry);
        break;
      case 'F10':
        if (!event.shiftKey || !isRowFocus) return;
        onAction(actionPath === entry.path ? null : entry.path);
        break;
      case 'ContextMenu':
        if (!isRowFocus) return;
        onAction(actionPath === entry.path ? null : entry.path);
        break;
      case ' ':
        if (!isRowFocus) return;
        if (!busy && entry.kind !== 'blocked') onIntent(entry.path, entry.selected ? 'exclude' : 'include');
        break;
      default: return;
    }
    event.preventDefault();
    if (targetIndex !== undefined) focusEntry(targetIndex);
  }, [actionPath, busy, entries, entryIndexes, expanded, focusEntry, onAction, onBrowse, onExpand, onIntent, onPreview, previewDisabled, query]);

  return <div className="tree" role="tree" aria-label="Workspace files" aria-multiselectable="true" ref={scrollRef}>
    {entries.length === 0
      ? <div className="empty-tree">No files match “{query}”.</div>
      : <div className="tree-virtual-spacer" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {items.map((item) => {
          const entry = entries[item.index];
          if (!entry) return null;
          const siblingPosition = siblingPositions.get(entry.path);
          return <div key={item.key} className="tree-virtual-row" role="none" data-index={item.index}
            style={{ height: `${item.size}px`, transform: `translateY(${item.start}px)` }}>
            <TreeRow entry={entry} tabStop={entry.path === tabStopPath}
              posInSet={siblingPosition?.position ?? 1} setSize={siblingPosition?.size ?? 1} expanded={expanded.has(entry.path)}
              searchRevealed={query.trim().length > 0 && entry.kind === 'directory' && entries.some((candidate) => candidate.path.startsWith(`${entry.path}/`))}
              actionOpen={actionPath === entry.path} busy={busy} previewDisabled={previewDisabled}
              onExpand={() => onExpand(entry)} onBrowse={() => onBrowse(entry.path)} onPreview={() => onPreview(entry.path)} onIntent={(intent) => onIntent(entry.path, intent)} onAction={() => onAction(actionPath === entry.path ? null : entry.path)}
              onFocus={() => setActivePath(entry.path)} onKeyDown={(event) => handleTreeItemKeyDown(entry, item.index, event)} />
          </div>;
        })}
      </div>}
  </div>;
}

type TreeRowProps = { entry: Entry; tabStop: boolean; posInSet: number; setSize: number; expanded: boolean; searchRevealed: boolean; actionOpen: boolean; busy: boolean; previewDisabled: boolean; onExpand: () => void; onBrowse: () => void; onPreview: () => void; onIntent: (intent: SelectionIntent) => void; onAction: () => void; onFocus: () => void; onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void };

function TreeRow({ entry, tabStop, posInSet, setSize, expanded, searchRevealed, actionOpen, busy, previewDisabled, onExpand, onBrowse, onPreview, onIntent, onAction, onFocus, onKeyDown }: TreeRowProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const isDirectory = entry.kind === 'directory';
  const depth = entry.path.split('/').length;
  const visualDepth = Math.min(depth - 1, 6);
  const needsBrowse = isDirectory && !entry.enumerated && entry.reason !== null;
  const folderSizeUnknown = isDirectory && entry.sizePartial && entry.size === 0;
  const sizeTitle = entry.sizePartial
    ? `At least ${entry.size} bytes of discovered file content; ignored or unscanned descendants may add more.`
    : `${entry.size} bytes of logical file content.`;
  const sizeAccessibleLabel = folderSizeUnknown
    ? 'Folder size unknown because some contents have not been scanned'
    : `${entry.sizePartial ? 'At least ' : ''}${formatBytes(entry.size)}${entry.sizePartial ? ', partial folder size' : isDirectory ? ' folder content size' : ''}`;
  const disabled = entry.kind === 'blocked' || busy;
  const checkbox = <input aria-label={`Select ${entry.path}`} type="checkbox" tabIndex={-1} checked={entry.selected} disabled={disabled} ref={(element) => { if (element) element.indeterminate = entry.partial; }} onChange={(event) => onIntent(event.target.checked ? 'include' : 'exclude')} />;
  const applyIntent = (intent: SelectionIntent) => {
    onIntent(intent);
    triggerRef.current?.focus({ preventScroll: true });
  };
  const displayedExpanded = expanded || searchRevealed;
  useLayoutEffect(() => {
    if (actionOpen && position) popoverRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [actionOpen, position]);
  useLayoutEffect(() => {
    if (!actionOpen) return;
    let anchorPosition: { top: number; left: number } | null = null;
    const place = () => {
      const trigger = triggerRef.current;
      const menu = popoverRef.current;
      if (!trigger || !menu) return;
      const anchor = trigger.getBoundingClientRect();
      anchorPosition = { top: anchor.top, left: anchor.left };
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const margin = 8;
      const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
      const dock = document.querySelector<HTMLElement>('.bottom-dock');
      const dockTop = dock?.getBoundingClientRect().top ?? window.innerHeight;
      const below = anchor.bottom + 4;
      const above = anchor.top - height - 4;
      const top = below + height <= dockTop - margin ? below : above >= margin ? above : Math.max(margin, Math.min(below, window.innerHeight - height - margin));
      setPosition({ top, left });
    };
    place();
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) onAction();
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onAction();
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    const closeOnScroll = () => {
      const trigger = triggerRef.current;
      if (!trigger || !anchorPosition) return onAction();
      const current = trigger.getBoundingClientRect();
      if (current.top !== anchorPosition.top || current.left !== anchorPosition.left) onAction();
    };
    const closeOnResize = () => onAction();
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnKey);
    document.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnKey);
      document.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [actionOpen, onAction]);
  return <><div className={`tree-row ${entry.selected ? 'is-selected' : ''} ${entry.reason ? 'is-muted' : ''}`} style={{ '--tree-depth': visualDepth } as CSSProperties} role="treeitem" tabIndex={tabStop ? 0 : -1} aria-keyshortcuts="Shift+F10" aria-level={depth} aria-posinset={posInSet} aria-setsize={setSize} aria-checked={entry.partial ? 'mixed' : entry.selected} aria-expanded={isDirectory && !needsBrowse ? displayedExpanded : undefined} onKeyDownCapture={onKeyDown} onFocusCapture={onFocus}>
    {visualDepth > 0 && <span className="tree-indent-guides" aria-hidden="true" />}
    {isDirectory && !needsBrowse ? <button className="disclosure" tabIndex={-1} aria-label={`${displayedExpanded ? 'Collapse' : 'Expand'} ${entry.path}`} onClick={onExpand} disabled={searchRevealed} title={searchRevealed ? 'Search is temporarily revealing matching descendants.' : undefined}><UiIcon icon={displayedExpanded ? IconChevronDown : IconChevronRight} size={16} /></button> : <span className="disclosure-spacer" />}
    {checkbox}
    <button className="entry-main" tabIndex={-1} aria-label={entry.kind === 'file' ? `Preview ${entry.path}` : undefined} onClick={onPreview} disabled={entry.kind !== 'file' || previewDisabled}>
      <span className={`file-glyph ${isDirectory ? 'folder-glyph' : entry.kind === 'blocked' ? 'blocked-glyph' : ''}`}><UiIcon icon={isDirectory ? IconFolder : entry.kind === 'blocked' ? IconBan : IconFileText} size={15} /></span>
      <span className="entry-name">{entry.path.split('/').at(-1)}</span>
      {entry.forceIncluded && <span className="override-pill">Override</span>}
      {entry.partial && <span className="partial-label">Partial</span>}
      {entry.reason && <span className="reason-label" title={entry.reason}>{entry.reason}</span>}
    </button>
    {(isDirectory || entry.kind === 'file') && <span className={`entry-size${isDirectory ? ' folder-size' : ''}${folderSizeUnknown ? ' size-unknown' : ''}`} title={sizeTitle} aria-label={sizeAccessibleLabel}>
      {folderSizeUnknown ? '?' : <>{entry.sizePartial ? '≥ ' : ''}{formatBytes(entry.size)}</>}
    </span>}
    {needsBrowse && <button className="browse-ignored" tabIndex={-1} aria-label="Browse ignored files" title="Browse ignored files" onClick={onBrowse} disabled={busy}><UiIcon icon={IconFolderOpen} size={15} /><span className="browse-ignored-label">Browse ignored files</span></button>}
    <div className="row-menu-wrap"><button ref={triggerRef} className="row-menu" tabIndex={-1} aria-label={`More actions for ${entry.path}`} aria-expanded={actionOpen} onClick={onAction}><UiIcon icon={IconDotsVertical} size={17} /></button>
    </div>
  </div>{actionOpen && createPortal(<div ref={popoverRef} className="row-menu-popover" role="group" aria-label={`${entry.path} selection actions`} style={position ? { top: position.top, left: position.left } : { visibility: 'hidden' }}>
    <button onClick={() => applyIntent('forceInclude')} disabled={disabled}>Force include</button>
    <button onClick={() => applyIntent('forceExclude')} disabled={disabled}>Force exclude</button>
    <button onClick={() => applyIntent(null)} disabled={disabled}>Reset override</button>
  </div>, document.body)}</>;
}
