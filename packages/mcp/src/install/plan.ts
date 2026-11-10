import { NATIVE_HOST_NAME } from '../protocol/constants.js';
import {
  bridgeConfigPath,
  bridgeDir,
  type PathEnv,
  pathFor,
} from '../paths.js';
import type { BridgeConfig } from '../host/caller.js';
import {
  BROWSER_KEYS,
  BROWSER_NAMES,
  type BrowserKey,
  type BrowserFamily,
  type BrowserLocation,
  MANIFEST_FILE,
  browserLocation,
  familyOf,
} from './browsers.js';
import { classifyExtensionId } from './extension-id.js';
import { posixLauncher, windowsLauncher } from './launcher.js';

/** Everything `install`/`uninstall` reads from the machine, injectable for tests. */
export interface InstallContext extends PathEnv {
  readonly exists: (path: string) => boolean;
  /** Absolute node binary the launcher runs (`process.execPath`). */
  readonly nodePath: string;
  /** The package directory (holds `dist/` and `package.json`). */
  readonly packageRoot: string;
  readonly version: string;
  /** Directory of an installed dependency, to copy into the host runtime. */
  readonly resolvePackageDir: (name: string) => string | undefined;
}

export type Action =
  | { readonly kind: 'mkdir'; readonly path: string; readonly mode?: number }
  | {
      readonly kind: 'write';
      readonly path: string;
      readonly content: string;
      readonly mode: number;
      /** Print the content in --dry-run. */
      readonly show?: boolean;
    }
  | { readonly kind: 'copy'; readonly from: string; readonly to: string }
  | { readonly kind: 'remove'; readonly path: string }
  /** `reg.exe` arguments. `optional` failures (deleting a missing key) are ignored. */
  | {
      readonly kind: 'reg';
      readonly args: readonly string[];
      readonly optional?: boolean;
    };

export interface BrowserOutcome {
  readonly key: BrowserKey;
  readonly name: string;
  readonly status: 'install' | 'remove' | 'skip';
  readonly reason?: string;
  readonly manifestPath?: string;
  readonly registryKeys?: readonly string[];
}

export interface Plan {
  readonly actions: Action[];
  readonly browsers: BrowserOutcome[];
  readonly notes: string[];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Runtime dependencies of the host (everything else in the package is client-only). */
export const HOST_RUNTIME_DEPENDENCIES = ['zod', 'tslib'] as const;

export interface InstallLayout {
  readonly bridgeDir: string;
  readonly runtimeDir: string;
  readonly cliPath: string;
  readonly launcherPath: string;
  readonly configPath: string;
  /** Windows: where the manifests live (the registry points at them). */
  readonly windowsManifest: { chromium: string; firefox: string };
}

export function installLayout(pe: PathEnv): InstallLayout {
  const p = pathFor(pe.platform);
  const dir = bridgeDir(pe);
  const runtimeDir = p.join(dir, 'runtime');
  return {
    bridgeDir: dir,
    runtimeDir,
    cliPath: p.join(runtimeDir, 'dist', 'cli.js'),
    launcherPath: p.join(
      dir,
      pe.platform === 'win32'
        ? 'browsersweet-bridge.cmd'
        : 'browsersweet-bridge',
    ),
    configPath: bridgeConfigPath(pe),
    windowsManifest: {
      chromium: p.join(dir, 'manifests', 'chromium', MANIFEST_FILE),
      firefox: p.join(dir, 'manifests', 'firefox', MANIFEST_FILE),
    },
  };
}

export interface ChromiumManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}
export interface FirefoxManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_extensions: string[];
}

const DESCRIPTION = 'Browser Sweet bridge for local MCP clients';

export function chromiumManifest(
  launcherPath: string,
  ids: readonly string[],
): ChromiumManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: DESCRIPTION,
    path: launcherPath,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
}

export function firefoxManifest(
  launcherPath: string,
  ids: readonly string[],
): FirefoxManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: DESCRIPTION,
    path: launcherPath,
    type: 'stdio',
    allowed_extensions: [...ids],
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface InstallOptions {
  readonly extensionIds: readonly string[];
  /** Limit to these browsers (installs even if not detected). Default: detected ones. */
  readonly browsers?: readonly BrowserKey[];
  /**
   * Write the manifest into this absolute directory instead of the browsers' own (tests, a
   * browser started with a custom user data dir). No registry changes on Windows.
   */
  readonly manifestDir?: string;
}

function selectBrowsers(
  ctx: InstallContext,
  requested: readonly BrowserKey[] | undefined,
): { selected: BrowserLocation[]; outcomes: BrowserOutcome[] } {
  const selected: BrowserLocation[] = [];
  const outcomes: BrowserOutcome[] = [];
  const keys = requested?.length ? requested : BROWSER_KEYS;
  for (const key of keys) {
    const location = browserLocation(key, ctx);
    const name = BROWSER_NAMES[key];
    if (!location) {
      if (requested?.length) {
        outcomes.push({
          key,
          name,
          status: 'skip',
          reason: `not supported on ${ctx.platform}`,
        });
      }
      continue;
    }
    if (!requested?.length && !ctx.exists(location.detectPath)) continue;
    selected.push(location);
  }
  return { selected, outcomes };
}

/**
 * The one browser family a `--manifest-dir` manifest is for: that of the named browsers, else
 * `fallback`.
 */
export function manifestDirFamily(
  browsers: readonly BrowserKey[] | undefined,
  fallback: BrowserFamily,
): BrowserFamily {
  const families = new Set((browsers ?? []).map(familyOf));
  if (families.size > 1) {
    throw new UsageError(
      '--manifest-dir holds one manifest: name browsers of one family (Chromium-based or Firefox), not both.',
    );
  }
  return [...families][0] ?? fallback;
}

/** The outcome line for a `--manifest-dir` manifest. */
function customDirOutcome(
  browsers: readonly BrowserKey[] | undefined,
  family: BrowserFamily,
): { key: BrowserKey; name: string } {
  const key = browsers?.[0] ?? (family === 'firefox' ? 'firefox' : 'chrome');
  const label = browsers?.length
    ? browsers.map((b) => BROWSER_NAMES[b]).join(', ')
    : family === 'firefox'
      ? 'Firefox'
      : 'Chromium browsers';
  return { key, name: `${label} (custom manifest directory)` };
}

function requireAbsolute(ctx: InstallContext, dir: string): void {
  if (!pathFor(ctx.platform).isAbsolute(dir)) {
    throw new UsageError(`--manifest-dir must be an absolute path: ${dir}`);
  }
}

/** Detected (or named) browsers that have an id of their family. Skips go into `browsers`. */
function selectInstallable(
  ctx: InstallContext,
  requested: readonly BrowserKey[] | undefined,
  chromiumIds: readonly string[],
  geckoIds: readonly string[],
  browsers: BrowserOutcome[],
): BrowserLocation[] {
  const { selected, outcomes } = selectBrowsers(ctx, requested);
  browsers.push(...outcomes);
  const installable = selected.filter((location) => {
    const family = familyOf(location.key);
    const ids = family === 'firefox' ? geckoIds : chromiumIds;
    if (ids.length > 0) return true;
    browsers.push({
      key: location.key,
      name: BROWSER_NAMES[location.key],
      status: 'skip',
      reason:
        family === 'firefox'
          ? 'no Firefox extension id (pass --extension-id <name@domain>)'
          : 'no Chromium extension id (pass --extension-id <32 letters a–p>)',
    });
    return false;
  });
  if (installable.length === 0) {
    throw new UsageError(
      selected.length === 0 && outcomes.length === 0
        ? `no supported browser found. Pass --browser <${BROWSER_KEYS.join('|')}>, or --manifest-dir <dir>.`
        : `nothing to install: ${browsers.map((b) => `${b.name}: ${b.reason}`).join('; ')}`,
    );
  }
  return installable;
}

/**
 * The host runtime (a private copy of dist + the host's dependencies, so the manifest keeps
 * working after the npx cache is cleared), the allow-list and the launcher.
 */
function runtimeActions(
  ctx: InstallContext,
  layout: InstallLayout,
  chromiumIds: readonly string[],
  geckoIds: readonly string[],
): Action[] {
  const p = pathFor(ctx.platform);
  const actions: Action[] = [];
  actions.push({ kind: 'remove', path: layout.runtimeDir });
  actions.push({ kind: 'mkdir', path: layout.runtimeDir, mode: 0o700 });
  actions.push({
    kind: 'copy',
    from: p.join(ctx.packageRoot, 'dist'),
    to: p.join(layout.runtimeDir, 'dist'),
  });
  actions.push({
    kind: 'write',
    path: p.join(layout.runtimeDir, 'package.json'),
    content: json({
      name: '@browsersweet/mcp-host-runtime',
      version: ctx.version,
      private: true,
      type: 'module',
    }),
    mode: 0o644,
  });
  for (const dependency of HOST_RUNTIME_DEPENDENCIES) {
    const dir = ctx.resolvePackageDir(dependency);
    if (!dir) {
      if (dependency === 'zod') {
        throw new UsageError(`can't find the ${dependency} package to copy`);
      }
      continue;
    }
    actions.push({
      kind: 'copy',
      from: dir,
      to: p.join(layout.runtimeDir, 'node_modules', dependency),
    });
  }

  const config: BridgeConfig = {
    v: 1,
    allowedOrigins: chromiumIds.map((id) => `chrome-extension://${id}/`),
    allowedFirefoxExtensions: [...geckoIds],
  };
  actions.push({
    kind: 'write',
    path: layout.configPath,
    content: json(config),
    mode: 0o600,
    show: true,
  });
  const launcher =
    ctx.platform === 'win32'
      ? windowsLauncher(ctx.nodePath, layout.cliPath, layout.configPath)
      : posixLauncher(ctx.nodePath, layout.cliPath, layout.configPath);
  actions.push({
    kind: 'write',
    path: layout.launcherPath,
    content: launcher,
    mode: 0o755,
    show: true,
  });
  return actions;
}

/** What `install` will do. Pure: reads the machine only through `ctx`. */
export function planInstall(
  ctx: InstallContext,
  options: InstallOptions,
): Plan {
  const p = pathFor(ctx.platform);
  const chromiumIds: string[] = [];
  const geckoIds: string[] = [];
  for (const id of options.extensionIds) {
    const kind = classifyExtensionId(id);
    if (kind === 'chromium') chromiumIds.push(id);
    else if (kind === 'firefox') geckoIds.push(id);
    else {
      throw new UsageError(
        `"${id}" is not an extension id (Chromium: 32 letters a–p; Firefox: name@domain or {uuid})`,
      );
    }
  }
  if (chromiumIds.length === 0 && geckoIds.length === 0) {
    throw new UsageError(
      'pass --extension-id <id> (the Browser Sweet extension id shown in Settings → Labs → Agent integration). Store ids are not published yet.',
    );
  }

  const layout = installLayout(ctx);
  const notes: string[] = [];
  const browsers: BrowserOutcome[] = [];
  const manifestFor = (family: BrowserFamily) =>
    family === 'firefox'
      ? firefoxManifest(layout.launcherPath, geckoIds)
      : chromiumManifest(layout.launcherPath, chromiumIds);

  if (options.manifestDir !== undefined) {
    const dir = options.manifestDir;
    requireAbsolute(ctx, dir);
    const family = manifestDirFamily(
      options.browsers,
      chromiumIds.length > 0 ? 'chromium' : 'firefox',
    );
    if ((family === 'firefox' ? geckoIds : chromiumIds).length === 0) {
      throw new UsageError(
        family === 'firefox'
          ? 'no Firefox extension id for --manifest-dir (pass --extension-id <name@domain>)'
          : 'no Chromium extension id for --manifest-dir (pass --extension-id <32 letters a–p>)',
      );
    }
    const manifestPath = p.join(dir, MANIFEST_FILE);
    const actions = runtimeActions(ctx, layout, chromiumIds, geckoIds);
    actions.push({ kind: 'mkdir', path: dir });
    actions.push({
      kind: 'write',
      path: manifestPath,
      content: json(manifestFor(family)),
      mode: 0o644,
      show: true,
    });
    browsers.push({
      ...customDirOutcome(options.browsers, family),
      status: 'install',
      manifestPath,
    });
    if (ctx.platform === 'win32') {
      notes.push(
        `Windows browsers find hosts through the registry, not a directory: point a NativeMessagingHosts\\${NATIVE_HOST_NAME} key at ${manifestPath} to use it.`,
      );
    }
    return { actions, browsers, notes };
  }

  const installable = selectInstallable(
    ctx,
    options.browsers,
    chromiumIds,
    geckoIds,
    browsers,
  );
  const actions = runtimeActions(ctx, layout, chromiumIds, geckoIds);

  if (ctx.platform === 'win32') {
    const written = new Set<string>();
    const keysDone = new Set<string>();
    for (const location of installable) {
      const family = familyOf(location.key);
      const manifestPath = layout.windowsManifest[family];
      if (!written.has(manifestPath)) {
        written.add(manifestPath);
        actions.push({ kind: 'mkdir', path: p.dirname(manifestPath) });
        actions.push({
          kind: 'write',
          path: manifestPath,
          content: json(manifestFor(family)),
          mode: 0o644,
          show: true,
        });
      }
      const registryKeys = (location.registryKeys ?? []).filter(
        (key) => !keysDone.has(key),
      );
      for (const key of registryKeys) {
        keysDone.add(key);
        actions.push({
          kind: 'reg',
          args: ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
        });
      }
      browsers.push({
        key: location.key,
        name: BROWSER_NAMES[location.key],
        status: 'install',
        manifestPath,
        registryKeys: location.registryKeys ?? [],
      });
    }
  } else {
    for (const location of installable) {
      const dir = location.manifestDir as string;
      const manifestPath = p.join(dir, MANIFEST_FILE);
      actions.push({ kind: 'mkdir', path: dir });
      actions.push({
        kind: 'write',
        path: manifestPath,
        content: json(manifestFor(familyOf(location.key))),
        mode: 0o644,
        show: true,
      });
      browsers.push({
        key: location.key,
        name: BROWSER_NAMES[location.key],
        status: 'install',
        manifestPath,
      });
    }
  }
  if (geckoIds.length > 0 && chromiumIds.length === 0) {
    notes.push('Only a Firefox id was given; Chromium browsers were skipped.');
  }
  return { actions, browsers, notes };
}

/** What `uninstall` will do. */
export function planUninstall(
  ctx: InstallContext,
  options: {
    readonly browsers?: readonly BrowserKey[];
    /** Remove only the manifest in this directory (see `InstallOptions.manifestDir`). */
    readonly manifestDir?: string;
  } = {},
): Plan {
  const layout = installLayout(ctx);
  const actions: Action[] = [];
  const browsers: BrowserOutcome[] = [];
  const notes: string[] = [];
  if (options.manifestDir !== undefined) {
    requireAbsolute(ctx, options.manifestDir);
    const manifestPath = pathFor(ctx.platform).join(
      options.manifestDir,
      MANIFEST_FILE,
    );
    if (ctx.exists(manifestPath)) {
      actions.push({ kind: 'remove', path: manifestPath });
      const family = manifestDirFamily(options.browsers, 'chromium');
      browsers.push({
        ...customDirOutcome(options.browsers, family),
        status: 'remove',
        manifestPath,
      });
    } else {
      notes.push(`No manifest in ${options.manifestDir}.`);
    }
    notes.push(
      `Kept ${layout.bridgeDir} (browsers may use it). Run uninstall without --manifest-dir to remove it.`,
    );
    return { actions, browsers, notes };
  }
  const keys = options.browsers?.length ? options.browsers : BROWSER_KEYS;
  const keysDone = new Set<string>();
  for (const key of keys) {
    const location = browserLocation(key, ctx);
    if (!location) continue;
    if (ctx.platform === 'win32') {
      for (const registryKey of location.registryKeys ?? []) {
        if (keysDone.has(registryKey)) continue;
        keysDone.add(registryKey);
        actions.push({
          kind: 'reg',
          args: ['delete', registryKey, '/f'],
          optional: true,
        });
      }
      browsers.push({
        key,
        name: BROWSER_NAMES[key],
        status: 'remove',
        registryKeys: location.registryKeys ?? [],
      });
      continue;
    }
    const manifestPath = pathFor(ctx.platform).join(
      location.manifestDir as string,
      MANIFEST_FILE,
    );
    if (!ctx.exists(manifestPath)) continue;
    actions.push({ kind: 'remove', path: manifestPath });
    browsers.push({
      key,
      name: BROWSER_NAMES[key],
      status: 'remove',
      manifestPath,
    });
  }
  if (!options.browsers?.length) {
    actions.push({ kind: 'remove', path: layout.bridgeDir });
  } else {
    notes.push(
      `Kept ${layout.bridgeDir} (other browsers may use it). Run uninstall without --browser to remove it.`,
    );
  }
  return { actions, browsers, notes };
}

/** One line per action, for --dry-run and logs. */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'mkdir':
      return `mkdir -p ${action.path}${action.mode ? ` (mode ${action.mode.toString(8)})` : ''}`;
    case 'write':
      return `write ${action.path} (mode ${action.mode.toString(8)})`;
    case 'copy':
      return `copy ${action.from} → ${action.to}`;
    case 'remove':
      return `remove ${action.path}`;
    case 'reg':
      return `reg ${action.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  }
}
