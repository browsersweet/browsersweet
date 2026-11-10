import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { HostRecord } from '../protocol/socket.js';
import {
  discoveryPathProblem,
  type OwnershipCheck,
  resolveOwnershipCheck,
} from './fs-security.js';

/**
 * Is one of our processes alive at `pid`? EPERM means a process exists but belongs to another
 * user, which is never a host of ours (hosts run as us), so it counts as gone.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RecordEntry {
  readonly file: string;
  readonly record: HostRecord;
}

/** Valid discovery records in a run directory. Missing directory → none. */
export function readRecords(dir: string): RecordEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: RecordEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const parsed = HostRecord.safeParse(
        JSON.parse(readFileSync(file, 'utf8')),
      );
      if (parsed.success) entries.push({ file, record: parsed.data });
    } catch {
      // Unreadable or half-written; skip.
    }
  }
  return entries;
}

export interface RejectedPath {
  readonly path: string;
  readonly reason: string;
}

export interface TrustedRecords {
  readonly entries: RecordEntry[];
  /** Set when the directory itself fails the ownership check; nothing in it was read. */
  readonly dirProblem?: string;
  /** Records skipped because the record or its socket failed the ownership check. */
  readonly rejected: RejectedPath[];
}

/** Windows hosts publish named pipes only (`windows.ts`). */
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\browsersweet-bridge-';

function isInside(dir: string, endpoint: string): boolean {
  return (
    !endpoint.split(/[\\/]/).includes('..') &&
    path.resolve(path.dirname(endpoint)) === path.resolve(dir)
  );
}

/**
 * Discovery records the client may act on: like `readRecords`, but only from a run directory we
 * own (not a symlink, no group/other access), only record files we own that aren't group/world
 * writable and aren't symlinks, and only when the socket the record names sits in that same
 * directory and is a socket we own. Everything else is skipped and reported, so a directory
 * another local user created (e.g. `/tmp/browsersweet-<uid>` on Linux) can't send our agent to
 * their socket. Missing directory → none.
 *
 * On Windows the run directory is in the user's profile (%LOCALAPPDATA%, whose ACL keeps other
 * users out) and `lstat` reports no owner or meaningful mode, so only the endpoint's shape is
 * checked: it must be one of our named pipes.
 */
export function readTrustedRecords(
  dir: string,
  check: OwnershipCheck = {},
): TrustedRecords {
  const { platform, uid, lstat } = resolveOwnershipCheck(check);
  const rejected: RejectedPath[] = [];
  if (platform === 'win32') {
    const entries = readRecords(dir).filter(({ file, record }) => {
      if (record.endpoint.startsWith(WINDOWS_PIPE_PREFIX)) return true;
      rejected.push({
        path: file,
        reason: `names ${record.endpoint}, which is not a Browser Sweet pipe`,
      });
      return false;
    });
    return { entries, rejected };
  }
  try {
    const problem = discoveryPathProblem(lstat(dir), 'directory', uid);
    if (problem) return { entries: [], rejected, dirProblem: problem };
  } catch {
    return { entries: [], rejected };
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { entries: [], rejected };
  }
  const entries: RecordEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let record: HostRecord;
    try {
      const problem = discoveryPathProblem(lstat(file), 'record', uid);
      if (problem) {
        rejected.push({ path: file, reason: problem });
        continue;
      }
      const parsed = HostRecord.safeParse(
        JSON.parse(readFileSync(file, 'utf8')),
      );
      if (!parsed.success) continue;
      record = parsed.data;
    } catch {
      // Gone, unreadable or half-written; skip.
      continue;
    }
    if (!isInside(dir, record.endpoint)) {
      rejected.push({
        path: file,
        reason: `names a socket outside ${dir} (${record.endpoint})`,
      });
      continue;
    }
    let socketProblem: string | undefined;
    try {
      socketProblem = discoveryPathProblem(
        lstat(record.endpoint),
        'socket',
        uid,
      );
    } catch {
      // No socket: the host is gone or shutting down. Not an attack, just not usable.
      continue;
    }
    if (socketProblem) {
      rejected.push({
        path: file,
        reason: `its socket ${record.endpoint} ${socketProblem}`,
      });
      continue;
    }
    entries.push({ file, record });
  }
  return { entries, rejected };
}

/**
 * Remove records (and their sockets) left by hosts that died without cleaning up. Garbage files
 * older than a minute go too. Returns the removed record files.
 */
export function sweepStaleRecords(
  dir: string,
  alive: (pid: number) => boolean = isProcessAlive,
  now = Date.now(),
): string[] {
  const removed: string[] = [];
  const valid = new Set<string>();
  for (const { file, record } of readRecords(dir)) {
    valid.add(file);
    if (alive(record.pid)) continue;
    rmSync(file, { force: true });
    if (
      path.dirname(record.endpoint) === dir &&
      record.endpoint.endsWith('.sock')
    ) {
      rmSync(record.endpoint, { force: true });
    }
    removed.push(file);
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
    if (valid.has(file)) continue;
    try {
      if (now - statSync(file).mtimeMs > 60_000) {
        rmSync(file, { force: true });
        removed.push(file);
      }
    } catch {
      // Gone already.
    }
  }
  return removed;
}
