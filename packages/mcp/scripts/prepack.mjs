// npm and yalc pack files with the modes they have on disk. Built under a strict umask (077), the
// tarball would ship files only their owner can read and a bin that isn't executable. Normalize:
// directories and bins 0755, everything else 0644.
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const bins = new Set(
  Object.values(
    typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {}),
  ).map((bin) => path.resolve(root, bin)),
);

function fix(target) {
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      chmodSync(full, 0o755);
      fix(full);
    } else if (entry.isFile()) {
      chmodSync(full, bins.has(full) ? 0o755 : 0o644);
    }
  }
}

if (!existsSync(path.join(root, 'dist'))) {
  throw new Error('dist/ is missing: run `nx build browsersweet-mcp` first');
}
chmodSync(path.join(root, 'dist'), 0o755);
fix(path.join(root, 'dist'));
for (const file of [
  'package.json',
  'README.md',
  'PROTOCOL.md',
  'CHANGELOG.md',
  'LICENSE',
]) {
  if (existsSync(path.join(root, file))) {
    chmodSync(path.join(root, file), 0o644);
  }
}
for (const bin of bins) {
  if (!existsSync(bin)) throw new Error(`bin ${bin} is missing`);
  if (!readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')) {
    throw new Error(`bin ${bin} has no node shebang`);
  }
}
