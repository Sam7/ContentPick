import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const targets = {
  'windows-x64': 'x86_64-pc-windows-msvc',
  'macos-x64': 'x86_64-apple-darwin',
  'macos-arm64': 'aarch64-apple-darwin',
};
const [targetName, ...extraArgs] = process.argv.slice(2);
if (!targets[targetName] || extraArgs.length > 0) {
  console.error(`Usage: node scripts/prepare-rust-notice.mjs <${Object.keys(targets).join('|')}>`);
  process.exit(2);
}

const localTool = path.join(repoRoot, '.tools', 'license-audit', 'bin', process.platform === 'win32' ? 'cargo-about.exe' : 'cargo-about');
const cargoAbout = process.env.CARGO_ABOUT_BIN || (existsSync(localTool) ? localTool : 'cargo-about');
const versionResult = spawnSync(cargoAbout, ['--version'], { cwd: repoRoot, encoding: 'utf8' });
if (versionResult.error) throw versionResult.error;
if (versionResult.status !== 0) process.exit(versionResult.status ?? 1);
const version = `${versionResult.stdout || ''}${versionResult.stderr || ''}`.trim();
if (version !== 'cargo-about 0.9.2') throw new Error(`Expected cargo-about 0.9.2, found: ${version || 'no version output'}`);
console.log(version);
const run = (args) => {
  const result = spawnSync(cargoAbout, args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const report = path.join(repoRoot, 'licenses', 'generated', `rust-${targetName}.html`);
run([
  'generate',
  '--workspace',
  '--locked',
  '--fail',
  '--target',
  targets[targetName],
  '--config',
  'licenses/about.toml',
  '--output-file',
  path.relative(repoRoot, report),
  'licenses/about.hbs',
]);

if (!existsSync(report) || statSync(report).size === 0) {
  throw new Error(`cargo-about did not produce a nonempty report for ${targetName}.`);
}
copyFileSync(report, path.join(repoRoot, 'licenses', 'generated', 'rust.html'));
