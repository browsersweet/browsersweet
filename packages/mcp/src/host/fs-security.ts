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
