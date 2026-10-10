import type { FilterPolicy } from './bridge';

type ExtensionGroup = { label: string; extensions: string[] };

const EXTENSION_GROUPS: ExtensionGroup[] = [
  { label: 'Code', extensions: ['.rs', '.py', '.ts', '.tsx', '.js', '.jsx', '.go', '.java', '.cs', '.cpp', '.c', '.rb', '.php', '.swift', '.kt'] },
  { label: 'Web & data', extensions: ['.html', '.css', '.json', '.jsonc', '.sql', '.xml', '.csv'] },
  { label: 'Docs & config', extensions: ['.md', '.mdx', '.txt', '.rst', '.yaml', '.yml', '.toml', '.ini'] },
  { label: 'Build & scripts', extensions: ['.sh', '.ps1', '.bat', '.make', '.dockerignore'] },
];
const CATALOG_EXTENSIONS = new Set(EXTENSION_GROUPS.flatMap((group) => group.extensions));

function normalizeExtension(extension: string): string {
  if (!extension.trim()) return '';
  const suffix = extension.trim().replace(/^\.+/, '');
  return suffix ? `.${suffix.toLocaleLowerCase()}` : '';
}

type WorkspaceFiltersProps = {
  gitignore: boolean;
  includeMode: FilterPolicy['includeMode'];
  includeExtensions: string[];
  disabled: boolean;
  updateState: 'idle' | 'pending' | 'failed';
  onGitignoreChange: (enabled: boolean) => void;
  onModeChange: (mode: FilterPolicy['includeMode']) => void;
  onExtensionChange: (extension: string, included: boolean) => void;
  onReset: () => void;
};

export function WorkspaceFilters({
  gitignore,
  includeMode,
  includeExtensions,
  disabled,
  updateState,
  onGitignoreChange,
  onModeChange,
  onExtensionChange,
  onReset,
}: WorkspaceFiltersProps) {
  const additionalExtensions = [...new Set(includeExtensions.map(normalizeExtension))]
    .filter((extension) => extension && !CATALOG_EXTENSIONS.has(extension))
    .sort((left, right) => left.localeCompare(right));
  return (
    <section id="workspace-filters" className="workspace-filter-editor" aria-label="Filter settings">
      <label className="filter-toggle"><input type="checkbox" checked={gitignore} disabled={disabled} onChange={(event) => onGitignoreChange(event.target.checked)} /> Respect .gitignore</label>
      <fieldset className="inclusion-mode" aria-label="Text inclusion">
        <legend>Text files</legend>
        <label><input type="radio" name="include-mode" value="allText" checked={includeMode === 'allText'} disabled={disabled} onChange={() => onModeChange('allText')} /> All text</label>
        <label><input type="radio" name="include-mode" value="selectedExtensions" checked={includeMode === 'selectedExtensions'} disabled={disabled} onChange={() => onModeChange('selectedExtensions')} /> Selected extensions</label>
      </fieldset>
      {includeMode === 'selectedExtensions' && <div className="extension-picker" aria-label="Choose file extensions">
        {EXTENSION_GROUPS.map((group) => <fieldset className="extension-group" key={group.label}>
          <legend>{group.label}</legend>
          <div className="extension-options">
            {group.extensions.map((extension) => <label className="extension-option" key={extension}>
              <input type="checkbox" value={extension} checked={includeExtensions.some((selected) => normalizeExtension(selected) === extension)} disabled={disabled} onChange={(event) => onExtensionChange(extension, event.target.checked)} />
              <span>{extension}</span>
            </label>)}
          </div>
        </fieldset>)}
        <fieldset className="extension-group extension-special-group">
          <legend>Special files</legend>
          <div className="extension-options">
            <label className="extension-option"><input type="checkbox" value="" checked={includeExtensions.includes('')} disabled={disabled} onChange={(event) => onExtensionChange('', event.target.checked)} /><span>No extension</span></label>
          </div>
        </fieldset>
        {additionalExtensions.length > 0 && <fieldset className="extension-group extension-special-group">
          <legend>Other saved extensions</legend>
          <div className="extension-options">
            {additionalExtensions.map((extension) => <label className="extension-option" key={extension}>
              <input type="checkbox" value={extension} checked={includeExtensions.some((selected) => normalizeExtension(selected) === extension)} disabled={disabled} onChange={(event) => onExtensionChange(extension, event.target.checked)} />
              <span>{extension}</span>
            </label>)}
          </div>
        </fieldset>}
      </div>}
      {includeMode === 'selectedExtensions' && includeExtensions.length === 0 && <small className="filter-hint">No extensions selected, so no files are eligible.</small>}
      {updateState === 'pending' && <p className="filter-update-status" role="status">Updating selection and estimates…</p>}
      {updateState === 'failed' && <p className="filter-update-status is-failed" role="status">Filter update failed. Review the error message and edit a filter to retry.</p>}
      <div className="filter-actions">
        <button type="button" className="button button-secondary" onClick={onReset} disabled={disabled}>Reset filters</button>
      </div>
    </section>
  );
}
