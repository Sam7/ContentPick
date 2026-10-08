import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { Entry, SelectionIntent } from './bridge';
import { formatBytes } from './format';

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
  const focusedPath = useRef<string | null>(null);
  const entryIndexes = useMemo(() => new Map(entries.map((entry, index) => [entry.path, index])), [entries]);
  const getItemKey = useCallback((index: number) => entries[index]?.path ?? index, [entries]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range);
    const focusedIndex = focusedPath.current === null ? undefined : entryIndexes.get(focusedPath.current);
    if (focusedIndex === undefined || indexes.includes(focusedIndex)) return indexes;
    return [...indexes, focusedIndex].sort((left, right) => left - right);
  }, [entryIndexes]);
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

  return <div className="tree" role="tree" aria-label="Workspace files" ref={scrollRef}>
    {entries.length === 0
      ? <div className="empty-tree">No files match “{query}”.</div>
      : <div className="tree-virtual-spacer" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {items.map((item) => {
          const entry = entries[item.index];
          if (!entry) return null;
          return <div key={item.key} className="tree-virtual-row" role="none" data-index={item.index}
            onFocusCapture={() => { focusedPath.current = entry.path; }}
            onBlurCapture={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) focusedPath.current = null;
            }}
            style={{ height: `${item.size}px`, transform: `translateY(${item.start}px)` }}>
            <TreeRow entry={entry} index={item.index} setSize={entries.length} expanded={expanded.has(entry.path)}
              searchRevealed={query.trim().length > 0 && entry.kind === 'directory' && entries.some((candidate) => candidate.path.startsWith(`${entry.path}/`))}
              actionOpen={actionPath === entry.path} busy={busy} previewDisabled={previewDisabled}
              onExpand={() => onExpand(entry)} onBrowse={() => onBrowse(entry.path)} onPreview={() => onPreview(entry.path)} onIntent={(intent) => onIntent(entry.path, intent)} onAction={() => onAction(actionPath === entry.path ? null : entry.path)} />
          </div>;
        })}
      </div>}
  </div>;
}

type TreeRowProps = { entry: Entry; index: number; setSize: number; expanded: boolean; searchRevealed: boolean; actionOpen: boolean; busy: boolean; previewDisabled: boolean; onExpand: () => void; onBrowse: () => void; onPreview: () => void; onIntent: (intent: SelectionIntent) => void; onAction: () => void };

function TreeRow({ entry, index, setSize, expanded, searchRevealed, actionOpen, busy, previewDisabled, onExpand, onBrowse, onPreview, onIntent, onAction }: TreeRowProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const isDirectory = entry.kind === 'directory';
  const needsBrowse = isDirectory && !entry.enumerated && entry.reason !== null;
  const disabled = entry.kind === 'blocked' || busy;
  const checkbox = <input aria-label={`Select ${entry.path}`} type="checkbox" checked={entry.selected} disabled={disabled} ref={(element) => { if (element) element.indeterminate = entry.partial; }} onChange={(event) => onIntent(event.target.checked ? 'include' : 'exclude')} />;
  const displayedExpanded = expanded || searchRevealed;
  useLayoutEffect(() => {
    if (actionOpen && position) popoverRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [actionOpen, position]);
  useLayoutEffect(() => {
    if (!actionOpen) return;
    const place = () => {
      const trigger = triggerRef.current;
      const menu = popoverRef.current;
      if (!trigger || !menu) return;
      const anchor = trigger.getBoundingClientRect();
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
    const closeOnViewportChange = () => onAction();
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnKey);
    document.addEventListener('scroll', closeOnViewportChange, true);
    window.addEventListener('resize', closeOnViewportChange);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnKey);
      document.removeEventListener('scroll', closeOnViewportChange, true);
      window.removeEventListener('resize', closeOnViewportChange);
    };
  }, [actionOpen, onAction]);
  return <><div className={`tree-row ${entry.selected ? 'is-selected' : ''} ${entry.reason ? 'is-muted' : ''}`} role="treeitem" aria-level={entry.path.split('/').length} aria-posinset={index + 1} aria-setsize={setSize} aria-expanded={isDirectory && !needsBrowse ? displayedExpanded : undefined}>
    {isDirectory && !needsBrowse ? <button className="disclosure" aria-label={`${displayedExpanded ? 'Collapse' : 'Expand'} ${entry.path}`} onClick={onExpand} disabled={searchRevealed} title={searchRevealed ? 'Search is temporarily revealing matching descendants.' : undefined}>{displayedExpanded ? '⌄' : '›'}</button> : <span className="disclosure-spacer" />}
    {checkbox}
    <button className="entry-main" aria-label={entry.kind === 'file' ? `Preview ${entry.path}` : undefined} onClick={onPreview} disabled={entry.kind !== 'file' || previewDisabled}>
      <span className={`file-glyph ${isDirectory ? 'folder-glyph' : entry.kind === 'blocked' ? 'blocked-glyph' : ''}`} aria-hidden="true">{isDirectory ? '▰' : entry.kind === 'blocked' ? '⊘' : '◇'}</span>
      <span className="entry-name">{entry.path.split('/').at(-1)}</span>
      {entry.forceIncluded && <span className="override-pill">Override</span>}
      {entry.partial && <span className="partial-label">Partial</span>}
      {entry.reason && <span className="reason-label" title={entry.reason}>{entry.reason}</span>}
    </button>
    {entry.kind === 'file' && <span className="entry-size">{formatBytes(entry.size)}</span>}
    {needsBrowse && <button className="browse-ignored" onClick={onBrowse} disabled={busy}>Browse ignored files</button>}
    <div className="row-menu-wrap"><button ref={triggerRef} className="row-menu" aria-label={`More actions for ${entry.path}`} aria-expanded={actionOpen} onClick={onAction}>•••</button>
    </div>
  </div>{actionOpen && createPortal(<div ref={popoverRef} className="row-menu-popover" role="group" aria-label={`${entry.path} selection actions`} style={position ? { top: position.top, left: position.left } : { visibility: 'hidden' }}>
    <button onClick={() => onIntent('forceInclude')} disabled={disabled}>Force include</button>
    <button onClick={() => onIntent('forceExclude')} disabled={disabled}>Force exclude</button>
    <button onClick={() => onIntent(null)} disabled={disabled}>Reset override</button>
  </div>, document.body)}</>;
}
