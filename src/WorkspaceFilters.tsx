import type { FormEvent } from 'react';
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
  onGitignoreChange: (enabled: boolean) => void;
  onTextChange: (field: FilterField, value: string) => void;
  onReset: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function WorkspaceFilters({
  gitignore,
  drafts,
  disabled,
  onGitignoreChange,
  onTextChange,
  onReset,
  onSubmit,
}: WorkspaceFiltersProps) {
  return (
    <form id="workspace-filters" className="sidebar-filter-form" onSubmit={onSubmit} aria-label="Filter settings">
      <label className="filter-toggle"><input type="checkbox" checked={gitignore} onChange={(event) => onGitignoreChange(event.target.checked)} /> Respect .gitignore</label>
      <div className="filter-grid">
        <label>Include extensions <input aria-describedby="extensionless-hint" value={drafts.includeExtensions} onChange={(event) => onTextChange('includeExtensions', event.target.value)} placeholder=".ts, .tsx, .md" /></label>
        <label>Include paths <input value={drafts.includePaths} onChange={(event) => onTextChange('includePaths', event.target.value)} placeholder="src/**, docs/**" /></label>
        <label>Exclude paths <input aria-describedby="exclude-paths-hint" value={drafts.excludePaths} onChange={(event) => onTextChange('excludePaths', event.target.value)} placeholder="**/__tests__/**" /></label>
      </div>
      <div className="filter-hints">
        <small id="extensionless-hint">Use &lt;none&gt; to include files with no extension.</small>
        <small id="exclude-paths-hint">Imported file rules appear here as <code>file-ext:…</code>.</small>
      </div>
      <div className="filter-actions">
        <button type="button" className="button button-secondary" onClick={onReset} disabled={disabled}>Reset filters</button>
        <button className="button button-primary" type="submit" disabled={disabled}>Apply filters</button>
      </div>
    </form>
  );
}
