import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createIconSvg } from './brand-assets.mjs';

const brandUrl = new URL('../docs/design/ContextPickLogo.svg', import.meta.url);

test('authoritative ContextPick lockup is vector artwork with a distinct mark and wordmark', async () => {
  const brand = await readFile(brandUrl, 'utf8');

  assert.match(brand, /<g\b[^>]*id="icon"/);
  assert.match(brand, /viewBox="0 0 1536 1024"/);
  assert.match(brand, /<path\b/);
  assert.doesNotMatch(brand, /<image\b|data:image\/|<text\b|@font-face|font-family=/i);
});

test('generated icon source reuses the authoritative mark without the wordmark', async () => {
  const brand = await readFile(brandUrl, 'utf8');
  const icon = createIconSvg(brand);
  const mark = brand.match(/<g\b(?=[^>]*\bid="icon")[^>]*>[\s\S]*?<\/g>/)?.[0];

  assert.ok(mark);
  assert.match(icon, /width="256" height="256" viewBox="0 0 330 330"/);
  assert.ok(icon.includes(mark));
  assert.doesNotMatch(icon, /<text\b|<image\b|CONTEXT\s*PICK/i);
  assert.equal(await readFile(new URL('../src-tauri/icons/mark.svg', import.meta.url), 'utf8'), icon, 'checked-in vector icon must match the current source');
});

test('branding consumers and generation pipeline reference only the authoritative SVG', async () => {
  for (const relative of ['../src/WorkspaceToolbar.tsx', './generate-brand-icons.mjs', './preview-brand-icons.mjs']) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /ContextPickLogo\.svg/);
    assert.doesNotMatch(source, /contextpick-brand\.svg/);
  }
});

test('generated Windows and macOS icons are configured and have expected dimensions', async () => {
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const expectedIcons = ['icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png', 'icons/icon.icns', 'icons/icon.ico'];

  assert.deepEqual(config.bundle.icon, expectedIcons);

  for (const [name, size] of [['32x32.png', 32], ['64x64.png', 64], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 512]]) {
    const png = await readFile(new URL(`../src-tauri/icons/${name}`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${name} PNG signature`);
    assert.equal(png.readUInt32BE(16), size, `${name} width`);
    assert.equal(png.readUInt32BE(20), size, `${name} height`);
  }

  assert.equal(await readFile(new URL('../src-tauri/icons/icon.icns', import.meta.url)).then((file) => file.subarray(0, 4).toString('ascii')), 'icns');
  assert.equal(await readFile(new URL('../src-tauri/icons/icon.ico', import.meta.url)).then((file) => file.readUInt16LE(0)), 0);
  const ico = await readFile(new URL('../src-tauri/icons/icon.ico', import.meta.url));
  const icoCount = ico.readUInt16LE(4);
  const icoSizes = new Set(Array.from({ length: icoCount }, (_, index) => ico[6 + index * 16] || 256));
  for (const size of [16, 24, 32, 48, 64, 256]) assert.ok(icoSizes.has(size), `icon.ico includes ${size} px`);
});
