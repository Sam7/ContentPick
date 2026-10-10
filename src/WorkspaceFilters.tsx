export type FilterDrafts = {
  includeExtensions: string;
  includePaths: string;
  excludePaths: string;
};
type FilterField = keyof FilterDrafts;

type WorkspaceFiltersProps = {
  gitignore: boolean;
  drafts: FilterDrafts;
  disabled: boolean;
  updateState: 'idle' | 'pending' | 'failed';
  onGitignoreChange: (enabled: boolean) => void;
  onTextChange: (field: FilterField, value: string) => void;
  onReset: () => void;
};

export function WorkspaceFilters({
  gitignore,
  drafts,
  disabled,
  updateState,
  onGitignoreChange,
  onTextChange,
  onReset,
}: WorkspaceFiltersProps) {
  return (
    <section id="workspace-filters" className="workspace-filter-editor" aria-label="Filter settings">
      <label className="filter-toggle"><input type="checkbox" checked={gitignore} disabled={disabled} onChange={(event) => onGitignoreChange(event.target.checked)} /> Respect .gitignore</label>
      <div className="filter-grid">
        <label>Include extensions <input aria-describedby="extensionless-hint" value={drafts.includeExtensions} disabled={disabled} onChange={(event) => onTextChange('includeExtensions', event.target.value)} placeholder=".ts, .tsx, .md" /></label>
        <label>Include paths <input value={drafts.includePaths} disabled={disabled} onChange={(event) => onTextChange('includePaths', event.target.value)} placeholder="src/**, docs/**" /></label>
        <label>Exclude paths <input aria-describedby="exclude-paths-hint" value={drafts.excludePaths} disabled={disabled} onChange={(event) => onTextChange('excludePaths', event.target.value)} placeholder="**/__tests__/**" /></label>
      </div>
      <div className="filter-hints">
        <small id="extensionless-hint">Use &lt;none&gt; to include files with no extension.</small>
        <small id="exclude-paths-hint">Imported file rules appear here as <code>file-ext:…</code>.</small>
      </div>
      {updateState === 'pending' && <p className="filter-update-status" role="status">Updating selection and estimates…</p>}
      {updateState === 'failed' && <p className="filter-update-status is-failed" role="status">Filter update failed. Review the error message and edit a filter to retry.</p>}
      <div className="filter-actions">
        <button type="button" className="button button-secondary" onClick={onReset} disabled={disabled}>Reset filters</button>
      </div>
    </section>
  );
}
