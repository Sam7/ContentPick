import { useCallback, useMemo, useRef } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { Entry, SelectionIntent } from './bridge';
import { formatBytes } from './format';

type ProjectTreeProps = {
  entries: Entry[];
  expanded: Set<string>;
  actionPath: string | null;
  busy: boolean;
  query: string;
  onExpand: (entry: Entry) => void;
  onBrowse: (path: string) => void;
  onPreview: (path: string) => void;
  onIntent: (path: string, intent: SelectionIntent) => void;
  onAction: (path: string) => void;
};

export function ProjectTree({ entries, expanded, actionPath, busy, query, onExpand, onBrowse, onPreview, onIntent, onAction }: ProjectTreeProps) {
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
            <TreeRow entry={entry} index={item.index} setSize={entries.length} expanded={expanded.has(entry.path)} actionOpen={actionPath === entry.path} busy={busy}
              onExpand={() => onExpand(entry)} onBrowse={() => onBrowse(entry.path)} onPreview={() => onPreview(entry.path)} onIntent={(intent) => onIntent(entry.path, intent)} onAction={() => onAction(entry.path)} />
          </div>;
        })}
      </div>}
  </div>;
}

type TreeRowProps = { entry: Entry; index: number; setSize: number; expanded: boolean; actionOpen: boolean; busy: boolean; onExpand: () => void; onBrowse: () => void; onPreview: () => void; onIntent: (intent: SelectionIntent) => void; onAction: () => void };

function TreeRow({ entry, index, setSize, expanded, actionOpen, busy, onExpand, onBrowse, onPreview, onIntent, onAction }: TreeRowProps) {
  const isDirectory = entry.kind === 'directory';
  const needsBrowse = isDirectory && !entry.enumerated && entry.reason !== null;
  const disabled = entry.kind === 'blocked' || busy;
  const checkbox = <input aria-label={`Select ${entry.path}`} type="checkbox" checked={entry.selected} disabled={disabled} ref={(element) => { if (element) element.indeterminate = entry.partial; }} onChange={(event) => onIntent(event.target.checked ? 'include' : 'exclude')} />;
  return <div className={`tree-row ${entry.selected ? 'is-selected' : ''} ${entry.reason ? 'is-muted' : ''}`} role="treeitem" aria-level={entry.path.split('/').length} aria-posinset={index + 1} aria-setsize={setSize} aria-expanded={isDirectory && !needsBrowse ? expanded : undefined}>
    {isDirectory && !needsBrowse ? <button className="disclosure" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${entry.path}`} onClick={onExpand}>{expanded ? '⌄' : '›'}</button> : <span className="disclosure-spacer" />}
    {checkbox}
    <button className="entry-main" aria-label={entry.kind === 'file' ? `Preview ${entry.path}` : undefined} onClick={onPreview} disabled={entry.kind !== 'file'}>
      <span className={`file-glyph ${isDirectory ? 'folder-glyph' : entry.kind === 'blocked' ? 'blocked-glyph' : ''}`} aria-hidden="true">{isDirectory ? '▰' : entry.kind === 'blocked' ? '⊘' : '◇'}</span>
      <span className="entry-name">{entry.path.split('/').at(-1)}</span>
      {entry.forceIncluded && <span className="override-pill">Override</span>}
      {entry.partial && <span className="partial-label">Partial</span>}
      {entry.reason && <span className="reason-label" title={entry.reason}>{entry.reason}</span>}
    </button>
    {entry.kind === 'file' && <span className="entry-size">{formatBytes(entry.size)}</span>}
    {needsBrowse && <button className="browse-ignored" onClick={onBrowse} disabled={busy}>Browse ignored files</button>}
    <div className="row-menu-wrap"><button className="row-menu" aria-label={`More actions for ${entry.path}`} aria-expanded={actionOpen} onClick={onAction}>•••</button>
      {actionOpen && <div className="row-menu-popover" role="group" aria-label={`${entry.path} selection actions`}>
        <button onClick={() => onIntent('forceInclude')} disabled={disabled}>Force include</button>
        <button onClick={() => onIntent('forceExclude')} disabled={disabled}>Force exclude</button>
        <button onClick={() => onIntent(null)} disabled={disabled}>Reset override</button>
      </div>}
    </div>
  </div>;
}
