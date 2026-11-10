import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { readBridgeConfig } from '../host/caller.js';
import { isProcessAlive, readRecords } from '../host/records.js';
import { runDirCandidates } from '../paths.js';
import { NATIVE_HOST_NAME } from '../protocol/constants.js';
import { DiscoveryPool } from '../client/pool.js';
import { orderByFocus } from '../client/profiles.js';
import {
  BROWSER_KEYS,
  BROWSER_NAMES,
  type BrowserFamily,
  type BrowserKey,
  MANIFEST_FILE,
  browserLocation,
  familyOf,
} from './browsers.js';
import {
  type InstallContext,
  installLayout,
  manifestDirFamily,
  UsageError,
} from './plan.js';
import { pathFor } from '../paths.js';

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';
export interface Check {
  readonly level: CheckLevel;
  readonly message: string;
}

export interface DoctorDeps {
  readonly readFile: (path: string) => string;
  /** POSIX mode bits, or undefined if missing. */
  readonly mode: (path: string) => number | undefined;
  /** `reg query <key> /ve` stdout, or undefined when the key is missing. */
  readonly regQuery: (key: string) => string | undefined;
}

export const nodeDoctorDeps: DoctorDeps = {
  readFile: (p) => readFileSync(p, 'utf8'),
  mode: (p) => {
    try {
      return lstatSync(p).mode & 0o777;
    } catch {
      return undefined;
    }
  },
  regQuery: (key) => {
    try {
      return execFileSync('reg', ['query', key, '/ve'], {
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch {
      return undefined;
    }
  },
};

export interface DoctorOptions {
  /** Only check these browsers (and warn when one has no manifest). Default: every one. */
  readonly browsers?: readonly BrowserKey[];
  /** Check the manifest in this directory instead of the browsers' (see `install --manifest-dir`). */
  readonly manifestDir?: string;
}

/** Problems with a host manifest, or `undefined` when it can't be parsed. */
function manifestProblems(
  text: string,
  family: BrowserFamily,
  launcherPath: string,
): string[] | undefined {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const problems: string[] = [];
  if (manifest['name'] !== NATIVE_HOST_NAME) problems.push('wrong name');
  if (manifest['type'] !== 'stdio') problems.push('type is not stdio');
  if (manifest['path'] !== launcherPath) {
    problems.push(`path is ${String(manifest['path'])}`);
  }
  const allowed =
    family === 'firefox'
      ? manifest['allowed_extensions']
      : manifest['allowed_origins'];
  if (!Array.isArray(allowed) || allowed.length === 0) {
    problems.push('no allowed extensions');
  }
  return problems;
}

/** Static checks: node, runtime, launcher, config, manifests. */
export function checkInstall(
  ctx: InstallContext,
  deps: DoctorDeps,
  options: DoctorOptions = {},
): Check[] {
  const checks: Check[] = [];
  const add = (level: CheckLevel, message: string) =>
    checks.push({ level, message });
  const p = pathFor(ctx.platform);
  const layout = installLayout(ctx);

  const major = Number(process.versions.node.split('.')[0]);
  add(
    major >= 20 ? 'ok' : 'fail',
    `Node ${process.versions.node} at ${ctx.nodePath}${major >= 20 ? '' : ' (needs 20+)'}`,
  );

  if (ctx.exists(layout.cliPath))
    add('ok', `host runtime at ${layout.runtimeDir}`);
  else add('fail', `host runtime missing (${layout.cliPath}); run install`);

  if (!ctx.exists(layout.launcherPath)) {
    add('fail', `launcher missing (${layout.launcherPath}); run install`);
  } else {
    const launcher = deps.readFile(layout.launcherPath);
    const mode = deps.mode(layout.launcherPath);
    if (
      ctx.platform !== 'win32' &&
      mode !== undefined &&
      (mode & 0o111) === 0
    ) {
      add('fail', `launcher ${layout.launcherPath} is not executable`);
    } else {
      add('ok', `launcher ${layout.launcherPath}`);
    }
    const nodeInLauncher = /^(?:exec )?['"]([^'"]+)['"]/m.exec(
      launcher.split(/\r?\n/).find((line) => /(^exec |^")/.test(line)) ?? '',
    )?.[1];
    if (nodeInLauncher && !ctx.exists(nodeInLauncher)) {
      add(
        'fail',
        `the launcher's node (${nodeInLauncher}) no longer exists; re-run install`,
      );
    }
  }

  let chromiumOrigins: string[] = [];
  let geckoIds: string[] = [];
  try {
    const config = readBridgeConfig(layout.configPath);
    chromiumOrigins = config.allowedOrigins;
    geckoIds = config.allowedFirefoxExtensions;
    add(
      'ok',
      `allowed extensions: ${[...chromiumOrigins, ...geckoIds].join(', ') || '(none)'}`,
    );
  } catch {
    add(
      'fail',
      `config missing or invalid (${layout.configPath}); run install`,
    );
  }

  const checkManifest = (
    name: string,
    manifestPath: string,
    family: BrowserFamily,
  ): void => {
    let text: string;
    try {
      text = deps.readFile(manifestPath);
    } catch {
      add('fail', `${name}: can't read ${manifestPath}`);
      return;
    }
    const problems = manifestProblems(text, family, layout.launcherPath);
    if (!problems) add('fail', `${name}: ${manifestPath} is not valid JSON`);
    else {
      add(
        problems.length ? 'fail' : 'ok',
        `${name}: ${manifestPath}${problems.length ? ` (${problems.join('; ')})` : ''}`,
      );
    }
  };

  if (options.manifestDir !== undefined) {
    const manifestPath = p.join(options.manifestDir, MANIFEST_FILE);
    let family: BrowserFamily;
    try {
      family = manifestDirFamily(
        options.browsers,
        chromiumOrigins.length > 0 || geckoIds.length === 0
          ? 'chromium'
          : 'firefox',
      );
    } catch (error) {
      add('fail', (error as UsageError).message);
      return checks;
    }
    if (!ctx.exists(manifestPath)) {
      add(
        'fail',
        `no manifest in ${options.manifestDir}; run install --manifest-dir`,
      );
    } else {
      checkManifest(
        `${family === 'firefox' ? 'Firefox' : 'Chromium'} manifest`,
        manifestPath,
        family,
      );
    }
    return checks;
  }

  const requested = options.browsers?.length ? options.browsers : undefined;
  for (const key of requested ?? BROWSER_KEYS) {
    const location = browserLocation(key, ctx);
    const name = BROWSER_NAMES[key];
    if (!location) {
      if (requested) add('warn', `${name}: not supported on ${ctx.platform}`);
      continue;
    }
    // Named browsers are expected to be set up, detected or not.
    const expected = requested !== undefined || ctx.exists(location.detectPath);
    let manifestPath: string | undefined;
    if (ctx.platform === 'win32') {
      const registryKey = location.registryKeys?.[0];
      const out = registryKey ? deps.regQuery(registryKey) : undefined;
      manifestPath = out ? /REG_SZ\s+(.+)$/m.exec(out)?.[1]?.trim() : undefined;
      if (!manifestPath) {
        if (expected) add('warn', `${name}: not installed (no ${registryKey})`);
        continue;
      }
    } else {
      manifestPath = p.join(location.manifestDir as string, MANIFEST_FILE);
      if (!ctx.exists(manifestPath)) {
        if (expected) {
          add(
            'warn',
            `${name}: ${requested ? 'no manifest' : 'detected, no manifest'}`,
          );
        }
        continue;
      }
    }
    checkManifest(name, manifestPath, familyOf(key));
  }
  return checks;
}

/** Live checks: socket directories and connected profiles. */
export async function checkHosts(
  ctx: InstallContext,
  deps: DoctorDeps,
  clientVersion: string,
): Promise<Check[]> {
  const checks: Check[] = [];
  const dirs = runDirCandidates(ctx);
  for (const dir of dirs) {
    if (!ctx.exists(dir)) continue;
    const mode = deps.mode(dir);
    if (
      ctx.platform !== 'win32' &&
      mode !== undefined &&
      (mode & 0o077) !== 0
    ) {
      checks.push({
        level: 'fail',
        message: `${dir} is mode ${mode.toString(8)}; expected 700`,
      });
    }
    const records = readRecords(dir);
    const stale = records.filter((r) => !isProcessAlive(r.record.pid));
    if (stale.length) {
      checks.push({
        level: 'warn',
        message: `${stale.length} stale socket record(s) in ${dir} (removed when a host next starts)`,
      });
    }
  }
  const pool = new DiscoveryPool({
    dirs: () => dirs,
    clientName: 'browsersweet-mcp doctor',
    clientVersion,
  });
  try {
    const hosts = orderByFocus(await pool.list());
    if (hosts.length === 0) {
      checks.push({
        level: 'warn',
        message:
          'no browser connected. Turn on Settings → Labs → Agent integration in Browser Sweet (the browser must be running).',
      });
    }
    hosts.forEach((host, index) => {
      const { profile, browser, extension, tools } = host.state;
      checks.push({
        level: 'ok',
        message: `connected: ${profile.label ?? profile.id} in ${browser.name} (extension ${extension.version}, ${tools.length} tools)${index === 0 ? ' [default]' : ''}`,
      });
    });
  } finally {
    pool.close();
  }
  return checks;
}

export function formatChecks(checks: readonly Check[]): string {
  const tag: Record<CheckLevel, string> = {
    ok: ' ok ',
    warn: 'warn',
    fail: 'FAIL',
    info: 'info',
  };
  return checks.map((c) => `[${tag[c.level]}] ${c.message}`).join('\n');
}
