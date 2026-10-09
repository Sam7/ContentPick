import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { normalizeFileTimestamps } from './normalize-bundle-inputs.mjs';

let tempDirectory;

afterEach(() => {
  if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
  tempDirectory = undefined;
});

test('normalizes every regular input file to the requested epoch', () => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'contextpick-bundle-inputs-'));
  const files = [join(tempDirectory, 'app.exe'), join(tempDirectory, 'license.txt')];
  files.forEach((file, index) => {
    writeFileSync(file, `input ${index}`);
    utimesSync(file, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  });
  const originalContents = files.map((file) => readFileSync(file, 'utf8'));
  const epochSeconds = 1_700_000_000;

  normalizeFileTimestamps(files, epochSeconds);

  assert.deepEqual(files.map((file) => Math.round(statSync(file).mtimeMs / 1000)), [epochSeconds, epochSeconds]);
  assert.deepEqual(files.map((file) => readFileSync(file, 'utf8')), originalContents);
});

test('rejects an invalid epoch before changing input timestamps', () => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'contextpick-bundle-inputs-'));
  const file = join(tempDirectory, 'app.exe');
  writeFileSync(file, 'app');
  const originalMtime = statSync(file).mtimeMs;

  assert.throws(() => normalizeFileTimestamps([file], Number.NaN), /epoch/i);
  assert.equal(statSync(file).mtimeMs, originalMtime);
});

test('validates all input files before changing any timestamps', () => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'contextpick-bundle-inputs-'));
  const existingFile = join(tempDirectory, 'app.exe');
  writeFileSync(existingFile, 'app');
  const originalMtime = statSync(existingFile).mtimeMs;

  assert.throws(() => normalizeFileTimestamps([existingFile, join(tempDirectory, 'missing.txt')], 1_700_000_000), /regular file/i);
  assert.equal(statSync(existingFile).mtimeMs, originalMtime);
});
