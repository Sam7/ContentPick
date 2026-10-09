import { statSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function normalizeFileTimestamps(filePaths, epochSeconds) {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0 || !Number.isFinite(new Date(epochSeconds * 1000).getTime())) {
    throw new TypeError('SOURCE_DATE_EPOCH must be a non-negative integer within the supported date range.');
  }
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new TypeError('At least one bundle input file is required.');
  }

  const inputs = filePaths.map((filePath) => {
    const absolutePath = resolve(filePath);
    let stats;
    try {
      stats = statSync(absolutePath);
    } catch (error) {
      throw new Error(`Expected a regular file for bundle input: ${absolutePath}`, { cause: error });
    }
    if (!stats.isFile()) throw new Error(`Expected a regular file for bundle input: ${absolutePath}`);
    return absolutePath;
  });

  const timestamp = new Date(epochSeconds * 1000);
  for (const filePath of inputs) utimesSync(filePath, timestamp, timestamp);
}

function runCli(args) {
  const [rawEpoch, ...files] = args;
  if (!rawEpoch || files.length === 0) {
    throw new Error('Usage: node scripts/normalize-bundle-inputs.mjs <SOURCE_DATE_EPOCH> <file> [file ...]');
  }
  normalizeFileTimestamps(files, Number(rawEpoch));
  console.log(`Normalized timestamps for ${files.length} bundle inputs to SOURCE_DATE_EPOCH ${rawEpoch}.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
