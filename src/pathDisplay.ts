const EXTENDED_UNC_PREFIX = '\\\\?\\UNC\\';
const EXTENDED_PATH_PREFIX = '\\\\?\\';

/** Formats canonical Windows paths for people without changing paths used by the bridge. */
export function displayPath(path: string): string {
  if (path.slice(0, EXTENDED_UNC_PREFIX.length).toUpperCase() === EXTENDED_UNC_PREFIX.toUpperCase()) {
    return `\\\\${path.slice(EXTENDED_UNC_PREFIX.length)}`;
  }

  if (path.startsWith(EXTENDED_PATH_PREFIX)) {
    const withoutPrefix = path.slice(EXTENDED_PATH_PREFIX.length);
    if (/^[A-Za-z]:\\/.test(withoutPrefix)) return withoutPrefix;
  }

  return path;
}
