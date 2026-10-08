import { describe, expect, it } from 'vitest';
import { processTreeForRoot, type ProcessSnapshotEntry } from './process-tree';

describe('processTreeForRoot', () => {
  it('does not treat older processes with a reused parent PID as descendants', () => {
    const snapshot: ProcessSnapshotEntry[] = [
      { processId: 952, parentProcessId: 400, workingSetBytes: 100, creationTicks: '200', executablePath: 'C:\\app\\contextpick.exe' },
      { processId: 864, parentProcessId: 952, workingSetBytes: 1_000, creationTicks: '100', executablePath: 'C:\\Windows\\csrss.exe' },
      { processId: 1_112, parentProcessId: 952, workingSetBytes: 1_000, creationTicks: '110', executablePath: 'C:\\Windows\\wininit.exe' },
      { processId: 4_200, parentProcessId: 952, workingSetBytes: 200, creationTicks: '210', executablePath: 'C:\\WebView2\\msedgewebview2.exe' },
      { processId: 4_201, parentProcessId: 4_200, workingSetBytes: 300, creationTicks: '220', executablePath: 'C:\\WebView2\\msedgewebview2.exe' },
      { processId: 4_202, parentProcessId: 952, workingSetBytes: 400, creationTicks: '200', executablePath: 'C:\\WebView2\\msedgewebview2.exe' },
    ];

    expect(processTreeForRoot(snapshot, 952, 'c:\\app\\contextpick.exe').map((entry) => entry.processId))
      .toEqual([952, 4_200, 4_202, 4_201]);
  });

  it('returns no tree when the root PID no longer belongs to the expected executable', () => {
    const snapshot: ProcessSnapshotEntry[] = [
      { processId: 952, parentProcessId: 400, workingSetBytes: 100, creationTicks: '200', executablePath: 'C:\\Windows\\services.exe' },
      { processId: 4_200, parentProcessId: 952, workingSetBytes: 200, creationTicks: '210', executablePath: 'C:\\WebView2\\msedgewebview2.exe' },
    ];

    expect(processTreeForRoot(snapshot, 952, 'C:\\app\\contextpick.exe')).toEqual([]);
  });

  it('does not adopt a later process that reuses the launched root PID', () => {
    const snapshot: ProcessSnapshotEntry[] = [
      { processId: 952, parentProcessId: 400, workingSetBytes: 100, creationTicks: '300', executablePath: 'C:\\app\\contextpick.exe' },
      { processId: 4_200, parentProcessId: 952, workingSetBytes: 200, creationTicks: '310', executablePath: 'C:\\WebView2\\msedgewebview2.exe' },
    ];

    expect(processTreeForRoot(snapshot, 952, 'C:\\app\\contextpick.exe', '200')).toEqual([]);
  });
});
