import { describe, expect, it } from 'vitest';
import { displayPath } from './pathDisplay';

describe('displayPath', () => {
  it('hides the Windows extended-length prefix on drive paths', () => {
    expect(displayPath(String.raw`\\?\C:\Users\sam\Project`)).toBe(String.raw`C:\Users\sam\Project`);
  });

  it('converts extended UNC paths to their familiar network form', () => {
    expect(displayPath(String.raw`\\?\UNC\server\share\Project`)).toBe(String.raw`\\server\share\Project`);
  });

  it('leaves ordinary Windows, POSIX and device paths unchanged', () => {
    for (const path of [String.raw`D:\Projects\demo`, '/home/sam/project', String.raw`\\.\pipe\service`]) {
      expect(displayPath(path)).toBe(path);
    }
  });
});
