// Helpers for .github/workflows/megamono-release.yml. Every project in nx.json `release.projects` is
// released together on one version (`projectsRelationship: fixed`); private packages are versioned with
// the rest but never published.
//
//   node .github/scripts/release-packages.mjs version
//     Prints the shared version, and fails if the public packages disagree.
//   node .github/scripts/release-packages.mjs notes <version> <out-file>
//     Writes the GitHub release notes: each public package's "## <version>" section from its
//     CHANGELOG.md, under the package's name. Exits 2 when no package has an entry for <version>.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');

function nx(...args) {
  return execFileSync('pnpm', ['exec', 'nx', ...args], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: { ...process.env, NX_DAEMON: 'false' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** The public packages Nx release covers, from nx.json `release.projects`. */
function releasePackages() {
  const nxJson = JSON.parse(
    readFileSync(path.join(workspaceRoot, 'nx.json'), 'utf8'),
  );
  const patterns = [nxJson.release?.projects ?? []].flat();
  if (patterns.length === 0)
    throw new Error('nx.json has no release.projects.');
  const names = JSON.parse(
    nx('show', 'projects', '--json', `--projects=${patterns.join(',')}`),
  );
  const packages = names.map((project) => {
    const { root } = JSON.parse(nx('show', 'project', project, '--json'));
    const manifest = JSON.parse(
      readFileSync(path.join(workspaceRoot, root, 'package.json'), 'utf8'),
    );
    return {
      project,
      root,
      name: manifest.name,
      version: manifest.version,
      private: manifest.private === true,
    };
  });
  const published = packages.filter((pkg) => !pkg.private);
  if (published.length === 0)
    throw new Error(
      `No public package matches release.projects (${patterns.join(', ')}).`,
    );
  return published.sort((a, b) => a.name.localeCompare(b.name));
}

function sharedVersion(packages) {
  const versions = new Set(packages.map((pkg) => pkg.version));
  if (versions.size !== 1) {
    const list = packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ');
    throw new Error(`The release packages must share one version: ${list}.`);
  }
  return [...versions][0];
}

/** The lines under `## <version>` up to the next `## ` heading, trimmed. */
function changelogSection(root, version) {
  const file = path.join(workspaceRoot, root, 'CHANGELOG.md');
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith('## '),
  );
  const section = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
  return section || undefined;
}

const [command, ...args] = process.argv.slice(2);
try {
  const packages = releasePackages();
  if (command === 'version') {
    console.log(sharedVersion(packages));
  } else if (command === 'notes') {
    const [version, outFile] = args;
    if (!version || !outFile)
      throw new Error('Usage: notes <version> <out-file>');
    let entries = 0;
    const parts = packages.map((pkg) => {
      const section = changelogSection(pkg.root, version);
      if (section) entries += 1;
      return `## ${pkg.name}\n\n${section ?? `No changes in ${version}.`}`;
    });
    writeFileSync(outFile, `${parts.join('\n\n')}\n`);
    console.log(
      `${entries} of ${packages.length} package changelogs have a "## ${version}" entry.`,
    );
    if (entries === 0) process.exit(2);
  } else {
    throw new Error(
      'Usage: release-packages.mjs version | notes <version> <out-file>',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
