import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * @browsersweet/mcp is public: anyone can `npx` it. It must never depend on a private package
 * (Playstack, Megamono, the Browser Sweet extension repo), directly or through a local link.
 * Adding a runtime dependency means adding it here, on purpose.
 */

const ALLOWED_RUNTIME_DEPENDENCIES = [
  '@modelcontextprotocol/sdk',
  'tslib',
  'zod',
];

/** Scopes that are private or internal to Commune Software's other repos. */
const PRIVATE_NAME = /^@(playstack|playstack-pro|megamono|basemarks|commune)\//;

/** Specifiers that only resolve on a developer's machine. */
const LOCAL_SPECIFIER = /^(workspace|file|link|portal):|\.yalc|\.tgz$/;

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
) as Record<string, unknown>;

function deps(field: string): Record<string, string> {
  const value = pkg[field];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, string>)
    : {};
}

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : (parts[0] ?? '');
}

function filesUnder(dir: string, match: (file: string) => boolean): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(match)
    .map((file) => path.join(dir, file));
}

/** Bare module specifiers in static and dynamic imports and re-exports. */
function importedPackages(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      if (isBuiltin(specifier)) continue;
      found.add(packageName(specifier));
    }
  }
  return [...found];
}

describe('public package boundary', () => {
  it('declares only the allowed runtime dependencies', () => {
    for (const field of [
      'dependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const name of Object.keys(deps(field))) {
        expect(ALLOWED_RUNTIME_DEPENDENCIES, `${field} has ${name}`).toContain(
          name,
        );
      }
    }
    expect(pkg['bundleDependencies'] ?? pkg['bundledDependencies']).toBe(
      undefined,
    );
  });

  it('has no private packages or local links anywhere in package.json', () => {
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [name, specifier] of Object.entries(deps(field))) {
        expect(name, `${field}.${name}`).not.toMatch(PRIVATE_NAME);
        expect(specifier, `${field}.${name}`).not.toMatch(LOCAL_SPECIFIER);
      }
    }
  });

  it('imports nothing but Node built-ins and declared dependencies', () => {
    const sources = [
      ...filesUnder(
        path.join(packageDir, 'src'),
        (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
      ).filter((f) => !f.includes(`${path.sep}test-support${path.sep}`)),
      // What actually ships (the Nx test target builds first).
      ...filesUnder(path.join(packageDir, 'dist'), (f) => f.endsWith('.js')),
    ];
    expect(sources.length).toBeGreaterThan(10);
    const undeclared: string[] = [];
    for (const file of sources) {
      for (const name of importedPackages(readFileSync(file, 'utf8'))) {
        if (!ALLOWED_RUNTIME_DEPENDENCIES.includes(name)) {
          undeclared.push(`${path.relative(packageDir, file)}: ${name}`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('catches what it should', () => {
    expect(
      importedPackages(
        "import { x } from '@playstack/core';\nconst y = await import('zod/v4');\nimport 'node:fs';",
      ),
    ).toEqual(['@playstack/core', 'zod']);
    expect('@playstack/core').toMatch(PRIVATE_NAME);
    expect('workspace:*').toMatch(LOCAL_SPECIFIER);
    expect('file:../../.yalc/@playstack/core').toMatch(LOCAL_SPECIFIER);
  });
});
