import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIconSvg } from './brand-assets.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const brandPath = join(repoRoot, 'docs', 'design', 'contextpick-brand.svg');
const tauriCliPath = join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const iconOutput = join(repoRoot, 'src-tauri', 'icons');
const tempPath = await mkdtemp(join(tmpdir(), 'contextpick-brand-'));

try {
  const brandSvg = await readFile(brandPath, 'utf8');
  const iconSource = join(tempPath, 'contextpick-icon.svg');
  await writeFile(iconSource, createIconSvg(brandSvg), 'utf8');

  const result = spawnSync(process.execPath, [tauriCliPath, 'icon', iconSource, '--output', iconOutput], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Tauri icon generation exited with ${result.status ?? 'no status'}`);
} finally {
  await rm(tempPath, { recursive: true, force: true });
}
