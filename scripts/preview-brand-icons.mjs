import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createIconSvg } from './brand-assets.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tempPath = await mkdtemp(join(tmpdir(), 'contextpick-brand-preview-'));
const tauriCliPath = join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const brandSvg = await readFile(join(repoRoot, 'docs', 'design', 'ContextPickLogo.svg'), 'utf8');
const iconSource = join(tempPath, 'contextpick-icon.svg');
const sizeOutput = join(tempPath, 'sizes');

try {
  await writeFile(iconSource, createIconSvg(brandSvg), 'utf8');
  const generated = spawnSync(process.execPath, [tauriCliPath, 'icon', iconSource, '--png', '16,24,32,48,64,128', '--output', sizeOutput], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (generated.error) throw generated.error;
  if (generated.status !== 0) throw new Error(`Tauri preview icon generation exited with ${generated.status ?? 'no status'}`);

  const tiles = await Promise.all([16, 24, 32, 48, 64, 128].map(async (size) => {
    const png = await readFile(join(sizeOutput, `${size}x${size}.png`));
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    return `<figure><div class="icon-box"><img src="${dataUrl}" width="${size}" height="${size}" alt="${size} pixel application icon"></div><figcaption>${size} × ${size}</figcaption></figure>`;
  }));
  const brandDataUrl = `data:image/svg+xml;base64,${Buffer.from(brandSvg).toString('base64')}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:26px 32px;background:#eef1f2;color:#18252b;font:16px/1.4 "Segoe UI",sans-serif}
    h1{margin:0 0 4px;font-size:22px}p{margin:0 0 18px;color:#59666c;font-size:13px}
    h2{margin:0 0 12px;font-size:15px}.panel{padding:16px 18px;margin:0 0 14px;border-radius:10px;background:#fff}
    .lockup{display:flex;align-items:center;justify-content:center;height:164px;overflow:hidden;background:#fff;border:1px solid #d6dfe1;border-radius:8px}
    .lockup img{width:760px;height:auto}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}
    figure{margin:0;text-align:center}figcaption{padding-top:6px;font-size:12px;font-variant-numeric:tabular-nums}
    .icon-box{height:142px;display:flex;align-items:center;justify-content:center;border-radius:7px;background:#fff;border:1px solid #d6dfe1}
    .dark{background:#182b31;color:#f4f8f7}.dark .icon-box{background:#101c22;border-color:#30434a}
    .dark figcaption{color:#e3ebe9}
  </style></head><body><h1>ContextPick brand assets</h1><p>SVG lockup and Tauri-generated icon source, shown on light and dark surfaces.</p>
    <section class="panel"><h2>Wordmark lockup</h2><div class="lockup"><img src="${brandDataUrl}" alt="ContextPick logo"></div></section>
    <section class="panel"><h2>Light surface</h2><div class="grid">${tiles.join('')}</div></section>
    <section class="panel dark"><h2>Dark surface</h2><div class="grid">${tiles.join('')}</div></section>
  </body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1220, height: 760 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: join(repoRoot, 'docs', 'testing', '2026-10-10-brand-assets.png'), fullPage: true });
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempPath, { recursive: true, force: true });
}
