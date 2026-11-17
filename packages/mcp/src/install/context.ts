import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defaultPathEnv } from '../paths.js';
import { packageRoot, packageVersion } from '../version.js';
import type { InstallContext } from './plan.js';

/** Find an installed package's directory from this module's location. */
export function resolvePackageDir(name: string): string | undefined {
  const require = createRequire(import.meta.url);
  try {
    return path.dirname(realpathSync(require.resolve(`${name}/package.json`)));
  } catch {
    // Packages that don't export ./package.json: walk up from the entry point.
  }
  try {
    let dir = path.dirname(realpathSync(require.resolve(name)));
    for (;;) {
      const manifest = path.join(dir, 'package.json');
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: string;
        };
        if (pkg.name === name) return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

export function nodeInstallContext(): InstallContext {
  return {
    ...defaultPathEnv(),
    exists: existsSync,
    nodePath: process.execPath,
    packageRoot: packageRoot(),
    version: packageVersion(),
    resolvePackageDir,
  };
}
