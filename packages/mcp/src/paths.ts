import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

export type SupportedPlatform = 'darwin' | 'linux' | 'win32';

/** Everything path resolution reads from the machine, so tests can inject it. */
export interface PathEnv {
  readonly platform: SupportedPlatform;
  readonly homedir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tmpdir: string;
  /** POSIX uid; undefined on Windows. */
  readonly uid?: number;
}

export function currentPlatform(): SupportedPlatform {
  const platform = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  // Other Unixes behave like Linux for our purposes (XDG paths, Unix sockets).
  return 'linux';
}

export function defaultPathEnv(): PathEnv {
  return {
    platform: currentPlatform(),
    homedir: homedir(),
    env: process.env,
    tmpdir: tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
  };
}

export function pathFor(platform: SupportedPlatform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Overrides the socket directory (tests, unusual setups). Must be absolute. */
export const RUN_DIR_ENV = 'BROWSERSWEET_MCP_RUN_DIR';

/** Unix socket paths are limited to 104 bytes on macOS (108 on Linux), including the NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;
/** `<16 hex>.sock` */
export const SOCKET_NAME_LENGTH = 16 + '.sock'.length;

function windowsLocalAppData(pe: PathEnv): string {
  return (
    pe.env['LOCALAPPDATA'] ?? path.win32.join(pe.homedir, 'AppData', 'Local')
  );
}

/** Where `install` puts the launcher, the config and the host runtime. */
export function bridgeDir(pe: PathEnv): string {
  const p = pathFor(pe.platform);
  switch (pe.platform) {
    case 'darwin':
      return p.join(
        pe.homedir,
        'Library',
        'Application Support',
        'BrowserSweet',
        'bridge',
      );
    case 'win32':
      return p.join(windowsLocalAppData(pe), 'BrowserSweet', 'bridge');
    case 'linux':
      return p.join(
        pe.env['XDG_DATA_HOME'] || p.join(pe.homedir, '.local', 'share'),
        'browsersweet',
        'bridge',
      );
  }
}

/** The host's allow-list of extension ids, written by `install`. */
export function bridgeConfigPath(pe: PathEnv): string {
  return pathFor(pe.platform).join(bridgeDir(pe), 'config.json');
}

/** Is `dir` short enough for `<dir>/<16 hex>.sock`? (Always true on Windows: named pipes.) */
export function fitsSocket(dir: string, pe: PathEnv): boolean {
  if (pe.platform === 'win32') return true;
  return (
    Buffer.byteLength(dir, 'utf8') + 1 + SOCKET_NAME_LENGTH <=
    MAX_SOCKET_PATH_BYTES
  );
}

/**
 * Socket directories, in preference order. The host uses the first usable one; the client scans
 * them all (its environment may differ from the browser's, e.g. no XDG_RUNTIME_DIR over SSH).
 */
export function runDirCandidates(pe: PathEnv): string[] {
  const override = pe.env[RUN_DIR_ENV];
  if (override) return [override];
  const p = pathFor(pe.platform);
  const dirs: string[] = [];
  switch (pe.platform) {
    case 'darwin':
      dirs.push(
        p.join(
          pe.homedir,
          'Library',
          'Application Support',
          'BrowserSweet',
          'run',
        ),
        p.join(pe.tmpdir, 'browsersweet'),
      );
      break;
    case 'linux': {
      const xdg = pe.env['XDG_RUNTIME_DIR'];
      if (xdg) dirs.push(p.join(xdg, 'browsersweet'));
      if (pe.uid !== undefined) {
        dirs.push(p.join('/run/user', String(pe.uid), 'browsersweet'));
      }
      dirs.push(p.join('/tmp', `browsersweet-${pe.uid ?? 'user'}`));
      break;
    }
    case 'win32':
      dirs.push(p.join(windowsLocalAppData(pe), 'BrowserSweet', 'run'));
      break;
  }
  return [...new Set(dirs)].filter((dir) => fitsSocket(dir, pe));
}

/**
 * The host's socket directory: the first candidate whose parent exists (so we never create
 * `/run/user/<uid>` ourselves).
 */
export function primaryRunDir(
  pe: PathEnv,
  exists: (p: string) => boolean,
): string | undefined {
  const p = pathFor(pe.platform);
  const candidates = runDirCandidates(pe);
  if (pe.env[RUN_DIR_ENV]) return candidates[0];
  return candidates.find((dir) => {
    const parent = p.dirname(dir);
    // Application Support and LOCALAPPDATA subfolders may need creating; runtime dirs must exist.
    if (pe.platform === 'darwin' || pe.platform === 'win32') return true;
    if (parent === '/tmp') return true;
    return exists(parent);
  });
}
