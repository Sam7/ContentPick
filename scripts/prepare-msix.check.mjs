import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareMsixLayout } from './prepare-msix.mjs';

const files = [
  'target/release/contextpick.exe',
  'target/release/WebView2Loader.dll',
  'LICENSE',
  'docs/design/ATTRIBUTION.md',
  'licenses/generated/frontend.txt',
  'licenses/generated/rust.html',
  'src-tauri/icons/StoreLogo.png',
  'src-tauri/icons/Square150x150Logo.png',
  'src-tauri/icons/Square44x44Logo.png',
];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'contextpick-msix-'));
  for (const file of files) {
    const source = path.join(root, file);
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, `synthetic:${file}`);
  }
  await writeFile(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.9.1' }));
  await mkdir(path.join(root, 'packaging/msix'), { recursive: true });
  await copyFile(path.join(repoRoot, 'packaging/msix/Package.appxmanifest.template.xml'), path.join(root, 'packaging/msix/Package.appxmanifest.template.xml'));
  return root;
}

const versionEnv = { CONTEXTPICK_MSIX_MAX_VERSION_TESTED: '10.0.26200.9457' };
const prepare = (root, outputDir, env = versionEnv) => prepareMsixLayout({ root, outputDir, env, platform: 'win32' });

test('prepares a complete MSIX package layout with reserved Store identity and monotonic four-part version', async () => {
  const root = await fixture();
  const outputDir = path.join(root, 'target/msix/staging');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'stale-package-content.txt'), 'old');
  try {
    const result = await prepare(root, outputDir);
    assert.equal(result.packageVersion, '1.9.1.0');
    assert.equal(result.identityName, 'DotSam.ContextPick');
    const manifest = await readFile(path.join(outputDir, 'Package.appxmanifest'), 'utf8');
    assert.match(manifest, /Name="DotSam\.ContextPick"\s+Publisher="CN=9CF819D8-048A-42F9-91C4-E85E76577891"\s+Version="1\.9\.1\.0"/);
    assert.match(manifest, /<PublisherDisplayName>DotSam<\/PublisherDisplayName>/);
    assert.match(manifest, /MinVersion="10\.0\.26200\.0" MaxVersionTested="10\.0\.26200\.9457"/);
    assert.doesNotMatch(manifest, /\{\{[A-Z_]+\}\}/);
    for (const destination of ['contextpick.exe', 'WebView2Loader.dll', 'licenses/LICENSE', 'licenses/ATTRIBUTION.md', 'licenses/frontend.txt', 'licenses/rust.html', 'Assets/StoreLogo.png', 'Assets/Square150x150Logo.png', 'Assets/Square44x44Logo.png']) {
      assert.equal(await readFile(path.join(outputDir, destination), 'utf8').then((value) => value.startsWith('synthetic:')), true, `${destination} should be staged`);
    }
    await assert.rejects(readFile(path.join(outputDir, 'stale-package-content.txt')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pins the reserved identity and Windows 11 25H2 minimum, requiring a tested maximum', async () => {
  const root = await fixture();
  try {
    await assert.rejects(prepare(root, path.join(root, 'target/msix/staging'), {}), /CONTEXTPICK_MSIX_MAX_VERSION_TESTED/);
    await assert.rejects(prepare(root, path.join(root, 'target/msix/staging'), { ...versionEnv, CONTEXTPICK_MSIX_MAX_VERSION_TESTED: '' }), /CONTEXTPICK_MSIX_MAX_VERSION_TESTED/);
    await assert.rejects(prepare(root, path.join(root, 'target/msix/staging'), { ...versionEnv, CONTEXTPICK_MSIX_MAX_VERSION_TESTED: '999999.0.0.0' }), /four Windows version components/);
    await assert.rejects(prepare(root, path.join(root, 'target/msix/staging'), { ...versionEnv, CONTEXTPICK_MSIX_MAX_VERSION_TESTED: '10.0.26100.9457' }), /cannot be greater/);
    await assert.rejects(prepare(root, path.join(root, 'target/outside')), /must be inside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a staging path redirected outside target by a symlink or junction', async () => {
  const root = await fixture();
  const target = path.join(root, 'target');
  const outside = path.join(root, 'outside');
  await mkdir(target, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    try {
      await symlink(outside, path.join(target, 'msix'), 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
      throw error;
    }
    await assert.rejects(prepare(root, path.join(target, 'msix/staging')), /symbolic link or junction/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a missing packaging input instead of emitting an incomplete layout', async () => {
  const root = await fixture();
  try {
    await rm(path.join(root, 'src-tauri/icons/Square44x44Logo.png'));
    await assert.rejects(prepare(root, path.join(root, 'target/msix/staging')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects app versions that cannot safely map to the Store package version', async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.9.0-beta.1' }));
    await assert.rejects(prepare(root, path.join(root, 'target/msix/staging')), /stable three-part semver/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
