import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = [
  ['target/release/contextpick.exe', 'contextpick.exe'],
  ['target/release/WebView2Loader.dll', 'WebView2Loader.dll'],
  ['LICENSE', 'licenses/LICENSE'],
  ['docs/design/ATTRIBUTION.md', 'licenses/ATTRIBUTION.md'],
  ['licenses/generated/frontend.txt', 'licenses/frontend.txt'],
  ['licenses/generated/rust.html', 'licenses/rust.html'],
  ['src-tauri/icons/StoreLogo.png', 'Assets/StoreLogo.png'],
  ['src-tauri/icons/Square150x150Logo.png', 'Assets/Square150x150Logo.png'],
  ['src-tauri/icons/Square44x44Logo.png', 'Assets/Square44x44Logo.png'],
];

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function packageVersion(appVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(appVersion);
  if (!match) throw new Error(`ContextPick version must be stable three-part semver; got ${appVersion}.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major >= 65535 || minor > 65535 || patch > 65535) throw new Error(`ContextPick version exceeds MSIX version limits: ${appVersion}.`);
  // MSIX major versions cannot be zero; map semver major 0 to package major 1.
  return `${major + 1}.${minor}.${patch}.0`;
}

function requireIdentity(env) {
  const identityName = env.CONTEXTPICK_MSIX_IDENTITY_NAME?.trim();
  const publisher = env.CONTEXTPICK_MSIX_PUBLISHER?.trim();
  const publisherDisplayName = env.CONTEXTPICK_MSIX_PUBLISHER_DISPLAY_NAME?.trim();
  if (!identityName || !publisher || !publisherDisplayName) {
    throw new Error('Set CONTEXTPICK_MSIX_IDENTITY_NAME, CONTEXTPICK_MSIX_PUBLISHER, and CONTEXTPICK_MSIX_PUBLISHER_DISPLAY_NAME from the reserved Partner Center identity.');
  }
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identityName)) throw new Error('MSIX identity name must contain 3–50 letters, digits, periods, or hyphens.');
  if ([...publisher].some((character) => character.charCodeAt(0) < 32) || !publisher.includes('=')) throw new Error('MSIX publisher must be a single-line X.500 distinguished name from Partner Center.');
  return { identityName, publisher, publisherDisplayName };
}

function requireWindowsVersion(value, name) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '');
  if (!match) throw new Error(`${name} must be a four-part Windows version, for example 10.0.22000.0.`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part > 65535) || parts[0] === 0) {
    throw new Error(`${name} must use four Windows version components from 0 to 65535, with a nonzero major version.`);
  }
  return parts;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

async function ensureNoReparsePoints(targetRoot, outputDir) {
  const relative = path.relative(targetRoot, outputDir);
  let current = targetRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`MSIX staging path cannot contain a symbolic link or junction: ${current}.`);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

export async function prepareMsixLayout({ root = repoRoot, outputDir, env = process.env, platform = process.platform }) {
  if (platform !== 'win32') throw new Error('MSIX packages must be prepared on Windows.');
  if (!outputDir) throw new Error('Provide an output directory under target/msix.');
  const targetRoot = path.resolve(root, 'target', 'msix');
  const resolvedOutput = path.resolve(outputDir);
  if (!resolvedOutput.startsWith(`${targetRoot}${path.sep}`)) throw new Error(`MSIX staging output must be inside ${targetRoot}.`);
  const identity = requireIdentity(env);
  const minVersion = requireWindowsVersion(env.CONTEXTPICK_MSIX_MIN_VERSION, 'CONTEXTPICK_MSIX_MIN_VERSION');
  const maxVersionTested = requireWindowsVersion(env.CONTEXTPICK_MSIX_MAX_VERSION_TESTED, 'CONTEXTPICK_MSIX_MAX_VERSION_TESTED');
  if (compareVersions(minVersion, maxVersionTested) > 0) {
    throw new Error('CONTEXTPICK_MSIX_MIN_VERSION cannot be greater than CONTEXTPICK_MSIX_MAX_VERSION_TESTED.');
  }
  await ensureNoReparsePoints(path.resolve(root), resolvedOutput);
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const template = await readFile(path.join(root, 'packaging/msix/Package.appxmanifest.template.xml'), 'utf8');
  const replacements = {
    IDENTITY_NAME: identity.identityName,
    PUBLISHER: identity.publisher,
    PUBLISHER_DISPLAY_NAME: identity.publisherDisplayName,
    PACKAGE_VERSION: packageVersion(config.version),
    MIN_VERSION: minVersion.join('.'),
    MAX_VERSION_TESTED: maxVersionTested.join('.'),
  };
  let manifest = template;
  for (const [key, value] of Object.entries(replacements)) manifest = manifest.replaceAll(`{{${key}}}`, xmlEscape(value));
  if (/\{\{[A-Z_]+\}\}/.test(manifest)) throw new Error('MSIX manifest has unresolved template values.');

  await rm(resolvedOutput, { recursive: true, force: true });
  await mkdir(resolvedOutput, { recursive: true });
  for (const [source, destination] of sourceFiles) {
    const sourcePath = path.join(root, source);
    const destinationPath = path.join(resolvedOutput, destination);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
  await writeFile(path.join(resolvedOutput, 'Package.appxmanifest'), manifest, 'utf8');
  return { outputDir: resolvedOutput, packageVersion: replacements.PACKAGE_VERSION, identityName: identity.identityName };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outputDir = path.join(repoRoot, 'target', 'msix', 'package-layout');
    const result = await prepareMsixLayout({ outputDir });
    process.stdout.write(`Prepared MSIX layout at ${result.outputDir} (${result.identityName}, ${result.packageVersion}).\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
