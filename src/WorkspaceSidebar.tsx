import { IconAdjustmentsHorizontal, IconChevronLeft, IconChevronRight, IconCircleCheck, IconCircleDashed, IconLayoutList, IconSettings } from '@tabler/icons-react';
import { UiIcon } from './UiIcon';
import type { WorkspaceFileView } from './workspaceViews';

type WorkspaceSidebarProps = {
  collapsed: boolean;
  view: WorkspaceFileView;
  settingsOpen: boolean;
  filtersOpen: boolean;
  allItems: number;
  selectedFiles: number;
  ignoredFiles: number;
  unbrowsedIgnoredFolders: number;
  indexLoading: boolean;
  incomplete: boolean;
  onToggleCollapsed: () => void;
  onViewChange: (view: WorkspaceFileView) => void;
  onFilters: () => void;
  onSettings: () => void;
};

export function WorkspaceSidebar({
  collapsed,
  view,
  settingsOpen,
  filtersOpen,
  allItems,
  selectedFiles,
  ignoredFiles,
  unbrowsedIgnoredFolders,
  indexLoading,
  incomplete,
  onToggleCollapsed,
  onViewChange,
  onFilters,
  onSettings,
}: WorkspaceSidebarProps) {
  const selectedLabel = `${incomplete ? 'At least ' : ''}${selectedFiles} files`;
  const ignoredDetail = [
    `${ignoredFiles} known files`,
    unbrowsedIgnoredFolders ? `${unbrowsedIgnoredFolders} folders not browsed` : '',
    indexLoading ? 'Loading index…' : '',
  ].filter(Boolean).join(' · ');

  return (
    <aside className={`workspace-sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Workspace navigation">
      <div className="sidebar-heading">
        {!collapsed && <span>Workspace</span>}
        <button
          className="sidebar-collapse"
          type="button"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapsed}
        ><UiIcon icon={collapsed ? IconChevronRight : IconChevronLeft} size={17} /></button>
      </div>
      <nav className="sidebar-nav" aria-label="Workspace views">
        <div className="sidebar-group-label">{!collapsed && 'FILES'}</div>
        <button className={`sidebar-item${view === 'all' && !settingsOpen ? ' is-active' : ''}`} type="button" aria-label="All" aria-pressed={view === 'all' && !settingsOpen} title={collapsed ? 'All files' : undefined} onClick={() => onViewChange('all')}>
          <span className="sidebar-icon"><UiIcon icon={IconLayoutList} /></span><span className="sidebar-text">All</span>{!collapsed && <small>{allItems} items</small>}
        </button>
        <button className={`sidebar-item${view === 'selected' && !settingsOpen ? ' is-active' : ''}`} type="button" aria-label="Selected" aria-pressed={view === 'selected' && !settingsOpen} title={collapsed ? 'Selected files' : undefined} onClick={() => onViewChange('selected')}>
          <span className="sidebar-icon"><UiIcon icon={IconCircleCheck} /></span><span className="sidebar-text">Selected</span>{!collapsed && <small>{selectedLabel}</small>}
        </button>
        <button className={`sidebar-item${view === 'ignored' && !settingsOpen ? ' is-active' : ''}`} type="button" aria-label="Ignored" aria-pressed={view === 'ignored' && !settingsOpen} title={collapsed ? 'Git-ignored files' : undefined} onClick={() => onViewChange('ignored')}>
          <span className="sidebar-icon"><UiIcon icon={IconCircleDashed} /></span><span className="sidebar-text">Ignored</span>{!collapsed && <small>{ignoredDetail}</small>}
        </button>
      </nav>
      <section className="sidebar-tools" aria-label="Workspace tools">
        <div className="sidebar-group-label sidebar-tools-label">{!collapsed && 'TOOLS'}</div>
        <button className={`sidebar-item${filtersOpen ? ' is-active' : ''}`} type="button" aria-label="Filters" aria-controls={filtersOpen ? 'workspace-filters' : undefined} aria-expanded={filtersOpen} title={collapsed ? 'Filters' : undefined} onClick={onFilters}>
          <span className="sidebar-icon"><UiIcon icon={IconAdjustmentsHorizontal} /></span><span className="sidebar-text">Filters</span>
        </button>
        <button className={`sidebar-item${settingsOpen ? ' is-active' : ''}`} type="button" aria-label="Settings" aria-pressed={settingsOpen} title={collapsed ? 'Settings' : undefined} onClick={onSettings}>
          <span className="sidebar-icon"><UiIcon icon={IconSettings} /></span><span className="sidebar-text">Settings</span>
        </button>
      </section>
      {!collapsed && (unbrowsedIgnoredFolders > 0 || indexLoading || incomplete) && (
        <p className="sidebar-note">
          {indexLoading && <span>More workspace items are loading. </span>}
          {unbrowsedIgnoredFolders > 0 && <span>Ignored folder totals include known files only. </span>}
          {!indexLoading && incomplete && <span>Scan results may be partial.</span>}
        </p>
      )}
    </aside>
  );
}
