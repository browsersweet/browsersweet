import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { HostRecord } from '../protocol/socket.js';

/** Is a process alive? (EPERM means it exists but isn't ours.) */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
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
