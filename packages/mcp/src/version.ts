import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** The package root: the directory holding `package.json` and `dist/` (or `src/` in dev). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

let cached: string | undefined;

/** This package's version, read from its package.json at runtime. */
export function packageVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(packageRoot(), 'package.json'), 'utf8'),
    ) as { version?: unknown };
    cached = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
