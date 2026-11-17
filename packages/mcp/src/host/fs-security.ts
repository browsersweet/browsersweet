import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

export class InsecurePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecurePathError';
  }
}

/**
 * Create (or check) a directory only this user can enter: a real directory (not a symlink),
 * owned by us, mode 0700. Refuses rather than repairs a directory someone else owns, so a
 * pre-created `/tmp/browsersweet-<uid>` can't capture our socket. No-op checks on Windows,
 * where the directory lives in the user's profile and inherits its ACL.
 */
export function ensurePrivateDir(
  dir: string,
  platform = process.platform,
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return;
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new InsecurePathError(`${dir} is not a directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new InsecurePathError(
      `${dir} is owned by uid ${stat.uid}, not ${uid}`,
    );
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** The parts of `fs.Stats` the ownership checks read, so tests can inject them. */
export interface PathStat {
  readonly uid: number;
  readonly mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
}

/** What a discovery path is supposed to be. */
export type DiscoveryPathKind = 'directory' | 'record' | 'socket';

/**
 * Why a discovery path (run directory, record file or socket) must not be trusted, or
 * `undefined` when it's fine. The client and `doctor` call this before reading a record or
 * connecting, so a directory another local user pre-created (e.g. `/tmp/browsersweet-<uid>`)
 * can't point us at their socket:
 *   - nothing may be a symlink (stats come from `lstat`);
 *   - everything must be owned by `uid` (skipped when the platform has no uid);
 *   - the directory must be 0700-ish (no group/other bits), a record not group/world-writable.
 * Windows isn't checked here: the directory is under %LOCALAPPDATA% (the profile's ACL) and the
 * endpoint is a named pipe; see `windows.ts`.
 */
export function discoveryPathProblem(
  stat: PathStat,
  kind: DiscoveryPathKind,
  uid: number | undefined,
): string | undefined {
  if (stat.isSymbolicLink()) return 'is a symlink';
  if (kind === 'directory' && !stat.isDirectory()) {
    return 'is not a directory';
  }
  if (kind === 'record' && !stat.isFile()) return 'is not a regular file';
  if (kind === 'socket' && !stat.isSocket()) return 'is not a socket';
  if (uid !== undefined && stat.uid !== uid) {
    return `is owned by uid ${stat.uid}, not ${uid}`;
  }
  const mode = stat.mode & 0o777;
  if (kind === 'directory' && (mode & 0o077) !== 0) {
    return `is mode ${mode.toString(8)}; expected 700`;
  }
  if (kind === 'record' && (mode & 0o022) !== 0) {
    return `is mode ${mode.toString(8)} (group or world writable); expected 600`;
  }
  return undefined;
}

/** How the client checks discovery paths. Defaults to this process (`lstatSync`, `getuid`). */
export interface OwnershipCheck {
  readonly platform?: NodeJS.Platform;
  /** Expected owner; `undefined` skips the owner check (no uid on this platform). */
  readonly uid?: number;
  readonly lstat?: (p: string) => PathStat;
}

export interface ResolvedOwnershipCheck {
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
  readonly lstat: (p: string) => PathStat;
}

export function resolveOwnershipCheck(
  check: OwnershipCheck = {},
): ResolvedOwnershipCheck {
  return {
    platform: check.platform ?? process.platform,
    uid: 'uid' in check ? check.uid : process.getuid?.(),
    lstat: check.lstat ?? lstatSync,
  };
}

/** Write a file readable only by us, atomically (temp file + rename). */
export function writePrivateFile(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Mode bits of a path (POSIX), for checks and tests. */
export function modeOf(p: string): number {
  return lstatSync(p).mode & 0o777;
}
