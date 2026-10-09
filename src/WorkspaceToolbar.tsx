import brandLogoUrl from '../docs/design/ContextPickLogo.svg?url';
import { IconFolderOpen, IconHome, IconRefresh } from '@tabler/icons-react';
import { UiIcon } from './UiIcon';

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
      <div className="brand-lockup"><img className="brand-logo" src={brandLogoUrl} alt="ContextPick" /></div>
      <div className="workspace-location" role="group" aria-label="Current workspace">
        <span className="location-icon"><UiIcon icon={IconHome} /></span>
        <span className={root ? 'workspace-path' : 'workspace-path workspace-empty'} title={root ?? 'No folder open'}>{root ?? 'No folder open'}</span>
      </div>
      <div className="workspace-actions">
        <button className="button button-secondary" onClick={onRefresh} disabled={refreshDisabled}>
          <UiIcon icon={IconRefresh} size={16} /> Refresh
        </button>
        <button className="button button-primary" onClick={onOpen} disabled={openDisabled}>
          <UiIcon icon={IconFolderOpen} size={16} /> {root ? 'Change folder' : 'Open folder'}
        </button>
      </div>
    </header>
  );
}
