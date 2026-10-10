import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storeIdentityName = 'DotSam.ContextPick';
const minimumWindowsVersion = [10, 0, 26200, 0];
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

function packageVersion(appVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(appVersion);
  if (!match) throw new Error(`ContextPick version must be stable three-part semver; got ${appVersion}.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major >= 65535 || minor > 65535 || patch > 65535) throw new Error(`ContextPick version exceeds MSIX version limits: ${appVersion}.`);
  // MSIX major versions cannot be zero; map semver major 0 to package major 1.
  return `${major + 1}.${minor}.${patch}.0`;
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

async function findWebView2Loader(root) {
  const bundledLoader = path.join(root, 'target/release/WebView2Loader.dll');
  const buildRoots = [
    path.join(root, 'target/x86_64-pc-windows-msvc/release/build'),
    path.join(root, 'target/release/build'),
  ];
  const cargoOutputs = [];
  for (const buildRoot of buildRoots) {
    let entries;
    try {
      entries = await readdir(buildRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('webview2-com-sys-')) continue;
      const candidate = path.join(buildRoot, entry.name, 'out/x64/WebView2Loader.dll');
      try {
        const info = await lstat(candidate);
        if (info.isFile() && !info.isSymbolicLink()) cargoOutputs.push(candidate);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  const candidates = [...cargoOutputs];
  try {
    const info = await lstat(bundledLoader);
    if (info.isFile() && !info.isSymbolicLink()) candidates.push(bundledLoader);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (candidates.length > 0) {
    const digests = new Map();
    for (const candidate of candidates) {
      const digest = createHash('sha256').update(await readFile(candidate)).digest('hex');
      if (!digests.has(digest)) digests.set(digest, candidate);
    }
    if (digests.size !== 1) throw new Error(`Multiple different x64 WebView2 loader outputs were found: ${candidates.join(', ')}.`);
    // Prefer the cross-target Cargo output when available; the root copy may be
    // stale from an earlier build, so it is only accepted after hash equality.
    return cargoOutputs[0] ?? bundledLoader;
  }

  throw new Error('The x64 WebView2 loader was not found in the Cargo build outputs or target/release bundle directory.');
}

export async function prepareMsixLayout({ root = repoRoot, outputDir, env = process.env, platform = process.platform }) {
  if (platform !== 'win32') throw new Error('MSIX packages must be prepared on Windows.');
  if (!outputDir) throw new Error('Provide an output directory under target/msix.');
  const targetRoot = path.resolve(root, 'target', 'msix');
  const resolvedOutput = path.resolve(outputDir);
  if (!resolvedOutput.startsWith(`${targetRoot}${path.sep}`)) throw new Error(`MSIX staging output must be inside ${targetRoot}.`);
  const maxVersionTested = requireWindowsVersion(env.CONTEXTPICK_MSIX_MAX_VERSION_TESTED, 'CONTEXTPICK_MSIX_MAX_VERSION_TESTED');
  if (compareVersions(minimumWindowsVersion, maxVersionTested) > 0) {
    throw new Error('Windows 11 25H2 minimum version cannot be greater than CONTEXTPICK_MSIX_MAX_VERSION_TESTED.');
  }
  await ensureNoReparsePoints(path.resolve(root), resolvedOutput);
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const template = await readFile(path.join(root, 'packaging/msix/Package.appxmanifest.template.xml'), 'utf8');
  const replacements = {
    PACKAGE_VERSION: packageVersion(config.version),
    MIN_VERSION: minimumWindowsVersion.join('.'),
    MAX_VERSION_TESTED: maxVersionTested.join('.'),
  };
  let manifest = template;
  for (const [key, value] of Object.entries(replacements)) manifest = manifest.replaceAll(`{{${key}}}`, value);
  if (/\{\{[A-Z_]+\}\}/.test(manifest)) throw new Error('MSIX manifest has unresolved template values.');

  await rm(resolvedOutput, { recursive: true, force: true });
  await mkdir(resolvedOutput, { recursive: true });
  for (const [source, destination] of sourceFiles) {
    if (destination === 'WebView2Loader.dll') continue;
    const sourcePath = path.join(root, source);
    const destinationPath = path.join(resolvedOutput, destination);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
  await copyFile(await findWebView2Loader(root), path.join(resolvedOutput, 'WebView2Loader.dll'));
  await writeFile(path.join(resolvedOutput, 'Package.appxmanifest'), manifest, 'utf8');
  return { outputDir: resolvedOutput, packageVersion: replacements.PACKAGE_VERSION, identityName: storeIdentityName };
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
