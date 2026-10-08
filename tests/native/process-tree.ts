export type ProcessSnapshotEntry = {
  processId: number;
  parentProcessId: number;
  workingSetBytes: number;
  creationTicks: string;
  executablePath: string;
};

export function processTreeForRoot(
  snapshot: ProcessSnapshotEntry[],
  rootProcessId: number,
  expectedExecutablePath: string,
  expectedRootCreationTicks?: string,
): ProcessSnapshotEntry[] {
  const byParent = new Map<number, ProcessSnapshotEntry[]>();
  const valid = snapshot.filter((entry) =>
    Number.isSafeInteger(entry.processId)
    && Number.isSafeInteger(entry.parentProcessId)
    && Number.isFinite(entry.workingSetBytes)
    && /^\d+$/.test(entry.creationTicks)
    && entry.executablePath.trim() !== '');
  for (const entry of valid) {
    const children = byParent.get(entry.parentProcessId) ?? [];
    children.push(entry);
    byParent.set(entry.parentProcessId, children);
  }

  const root = valid.find((entry) =>
    entry.processId === rootProcessId && entry.executablePath.toLowerCase() === expectedExecutablePath.toLowerCase());
  if (!root) return [];
  if (expectedRootCreationTicks !== undefined && root.creationTicks !== expectedRootCreationTicks) return [];

  const selected = new Map([[root.processId, root]]);
  const pending = [root];
  while (pending.length > 0) {
    const parent = pending.pop();
    if (!parent) continue;
    for (const child of byParent.get(parent.processId) ?? []) {
      if (selected.has(child.processId)) continue;
      if (BigInt(child.creationTicks) < BigInt(parent.creationTicks)) continue;
      selected.set(child.processId, child);
      pending.push(child);
    }
  }
  return [...selected.values()];
}
