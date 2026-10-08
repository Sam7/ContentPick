import brandLogoUrl from '../docs/design/contextpick-brand.svg?url';

type WorkspaceToolbarProps = {
  root: string | null;
  refreshDisabled: boolean;
  openDisabled: boolean;
  onRefresh: () => void;
  onOpen: () => void;
};

export function WorkspaceToolbar({
  root,
  refreshDisabled,
  openDisabled,
  onRefresh,
  onOpen,
}: WorkspaceToolbarProps) {
  return (
    <header className="topbar workspace-toolbar" aria-label="Workspace toolbar">
      <img className="brand-logo" src={brandLogoUrl} alt="ContextPick" />
      <div className="workspace-location" role="group" aria-label="Current workspace">
        <span className="location-icon" aria-hidden="true">⌂</span>
        <span className={root ? 'workspace-path' : 'workspace-path workspace-empty'} title={root ?? 'No folder open'}>{root ?? 'No folder open'}</span>
      </div>
      <div className="workspace-actions">
        <button className="button button-secondary" onClick={onRefresh} disabled={refreshDisabled}>
          <span aria-hidden="true">↻</span> Refresh
        </button>
        <button className="button button-primary" onClick={onOpen} disabled={openDisabled}>
          <span aria-hidden="true">＋</span> {root ? 'Change folder' : 'Open folder'}
        </button>
      </div>
    </header>
  );
}
