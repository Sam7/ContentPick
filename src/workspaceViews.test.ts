import { describe, expect, it } from 'vitest';
import type { Entry } from './bridge';
import { projectEntries } from './workspaceViews';

const entries: Entry[] = [
  { path: 'src', kind: 'directory', size: 0, selected: false, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: true },
  { path: 'src/keep', kind: 'directory', size: 0, selected: false, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: true },
  { path: 'src/keep/selected.ts', kind: 'file', size: 8, selected: true, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: false },
  { path: 'src/keep/filtered.ts', kind: 'file', size: 8, selected: false, forceIncluded: false, gitIgnored: false, reason: 'custom exclude', enumerated: true, partial: false },
  { path: 'src/build', kind: 'directory', size: 0, selected: false, forceIncluded: false, gitIgnored: true, reason: 'gitignore: build/', enumerated: false, partial: false },
  { path: 'src/build/forced.ts', kind: 'file', size: 8, selected: true, forceIncluded: true, gitIgnored: false, reason: 'force included', enumerated: true, partial: false },
  { path: 'custom.ts', kind: 'file', size: 8, selected: false, forceIncluded: false, gitIgnored: false, reason: 'custom include', enumerated: true, partial: false },
];

describe('workspace file views', () => {
  it('keeps All as the original index and selected files with their existing ancestors', () => {
    expect(projectEntries(entries, 'all')).toBe(entries);
    expect(projectEntries(entries, 'selected').map((entry) => entry.path)).toEqual([
      'src', 'src/keep', 'src/keep/selected.ts', 'src/build', 'src/build/forced.ts',
    ]);
  });

  it('shows Git-ignored entries and their existing ancestors without custom exclusions', () => {
    expect(projectEntries(entries, 'ignored').map((entry) => entry.path)).toEqual(['src', 'src/build']);
  });

  it('returns no rows for empty projections', () => {
    expect(projectEntries([], 'selected')).toEqual([]);
    expect(projectEntries([], 'ignored')).toEqual([]);
    expect(projectEntries(entries.map((entry) => ({ ...entry, selected: false })), 'selected')).toEqual([]);
    expect(projectEntries(entries.map((entry) => ({ ...entry, gitIgnored: false })), 'ignored')).toEqual([]);
  });
});
