import type { Entry } from './bridge';

export type WorkspaceFileView = 'all' | 'selected' | 'ignored';

function parentDirectories(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

export function projectEntries(entries: Entry[], view: WorkspaceFileView): Entry[] {
  if (view === 'all') return entries;

  const indexedPaths = new Map(entries.map((entry) => [entry.path, entry]));
  const includedPaths = new Set<string>();
  const matchesView = view === 'selected'
    ? (entry: Entry) => entry.kind === 'file' && entry.selected
    : (entry: Entry) => entry.gitIgnored;

  for (const entry of entries) {
    if (!matchesView(entry)) continue;
    includedPaths.add(entry.path);
    for (const parent of parentDirectories(entry.path)) {
      if (indexedPaths.get(parent)?.kind === 'directory') includedPaths.add(parent);
    }
  }

  return entries.filter((entry) => includedPaths.has(entry.path));
}
