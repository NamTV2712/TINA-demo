#!/usr/bin/env node
// Check the import closure that build.mjs actually ships. Legacy capture source and its tests
// remain in the repository, but are not part of the viewer-only extension package.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const deps = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
const builtins = new Set(builtinModules);
const pending = ['src/viewer.ts', 'src/viewer-background.ts'].map(file => resolve(root, file));
const scanned = new Set();
const violations = [];

function resolveRelative(from, specifier) {
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), `${base}.js`].find(path => existsSync(path) && statSync(path).isFile());
}

while (pending.length) {
  const file = pending.pop();
  if (scanned.has(file)) continue;
  scanned.add(file);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1] || match[2];
    if (specifier.startsWith('.')) {
      const target = resolveRelative(file, specifier);
      if (target) pending.push(target);
      else violations.push(`${file} → unresolved ${specifier}`);
      continue;
    }
    const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    const scoped = bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0];
    if (!builtins.has(bare) && !builtins.has(scoped) && !deps.has(specifier) && !deps.has(bare) && !deps.has(scoped))
      violations.push(`${file} → ${specifier}`);
  }
}

if (violations.length) {
  console.error('❌ ISOLATION VIOLATION in shipped extension code:\n  ' + violations.join('\n  '));
  process.exit(1);
}
console.log(`✅ ISOLATION VERIFIED — ${scanned.size} shipped TypeScript files have only local, builtin, or declared imports.`);
