import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const licenseFilesById = {
  MIT: ['LICENSE-MIT', 'LICENSE'],
  'Apache-2.0': ['LICENSE-APACHE-2.0', 'LICENSE-APACHE'],
};

function getPnpmReport() {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'corepack';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'corepack pnpm licenses list --prod --json']
    : ['pnpm', 'licenses', 'list', '--prod', '--json'];
  const stdout = execFileSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

function expressionLicenseIds(expression) {
  if (typeof expression !== 'string' || expression.length === 0) {
    throw new Error('A production package has no license expression.');
  }

  const ids = expression.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [];
  const unsupported = ids.filter((id) => !['AND', 'OR', 'WITH'].includes(id) && !licenseFilesById[id]);
  if (unsupported.length > 0) {
    throw new Error(`Unmapped license identifier(s) in "${expression}": ${unsupported.join(', ')}`);
  }
  if (ids.length === 0) throw new Error(`Could not parse license expression "${expression}".`);
  return [...new Set(ids.filter((id) => !['AND', 'OR', 'WITH'].includes(id)))];
}

function readPackage(packagePath, expectedName, expectedVersions, expectedExpression) {
  const metadata = JSON.parse(readFileSync(path.join(packagePath, 'package.json'), 'utf8'));
  if (metadata.name !== expectedName) {
    throw new Error(`pnpm path mismatch: expected ${expectedName}, found ${metadata.name} at ${packagePath}`);
  }
  if (!expectedVersions.includes(metadata.version)) {
    throw new Error(`${expectedName} ${metadata.version} is absent from pnpm's version list.`);
  }
  const expression = typeof metadata.license === 'string' ? metadata.license : undefined;
  if (expression !== expectedExpression) {
    throw new Error(`${expectedName}@${metadata.version}: package.json license "${expression}" differs from pnpm report "${expectedExpression}".`);
  }

  const texts = expressionLicenseIds(expression).map((id) => {
    const file = licenseFilesById[id].find((candidate) => {
      try {
        return readFileSync(path.join(packagePath, candidate), 'utf8').length > 0;
      } catch {
        return false;
      }
    });
    if (!file) throw new Error(`${expectedName}@${metadata.version}: no packaged text found for ${id}.`);
    return { id, file, text: readFileSync(path.join(packagePath, file), 'utf8').trimEnd() };
  });

  return { name: metadata.name, version: metadata.version, expression, texts };
}

function collectPackages(report) {
  const packages = new Map();
  for (const [expression, entries] of Object.entries(report)) {
    for (const entry of entries) {
      const versions = entry.versions ?? [];
      const paths = entry.paths ?? [];
      if (versions.length === 0 || paths.length === 0) {
        throw new Error(`${entry.name} has no resolved production package path/version.`);
      }
      for (const packagePath of paths) {
        const dependency = readPackage(packagePath, entry.name, versions, expression);
        packages.set(`${dependency.name}@${dependency.version}`, dependency);
      }
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function render(packages) {
  if (packages.length === 0) throw new Error('The production dependency graph is empty.');
  const output = [
    'ContextPick frontend third-party notices',
    'Generated from `corepack pnpm licenses list --prod --json` and the installed package license files.',
    'The declared SPDX expression is preserved for each package; every listed branch has its corresponding packaged text below.',
    '',
  ];

  for (const dependency of packages) {
    output.push(`${dependency.name} ${dependency.version}`, `Declared license: ${dependency.expression}`, '');
    for (const license of dependency.texts) {
      output.push(`--- ${license.id} (${license.file}) ---`, license.text, '');
    }
  }
  return `${output.join('\n').trimEnd()}\n`;
}

try {
  const output = render(collectPackages(getPnpmReport()));
  const outputPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated', 'frontend.txt');
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output, 'utf8');
  process.stdout.write(`Wrote ${path.relative(process.cwd(), outputPath)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
