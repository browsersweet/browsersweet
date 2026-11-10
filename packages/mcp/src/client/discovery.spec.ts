import {
  chmodSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoveryPathProblem,
  ensurePrivateDir,
  type PathStat,
} from '../host/fs-security.js';
import { isProcessAlive, readTrustedRecords } from '../host/records.js';
import { checkHosts, nodeDoctorDeps } from '../install/doctor.js';
import { nodeInstallContext } from '../install/context.js';
import { RUN_DIR_ENV } from '../paths.js';
import type { HostRecord } from '../protocol/socket.js';
import {
  TEST_EXTENSION_ID,
  shortTempDir,
} from '../test-support/fake-extension.js';
import { DiscoveryPool } from './pool.js';

/*
 * The client must only trust discovery records in directories it owns: another local user can
 * pre-create `/tmp/browsersweet-<uid>` (Linux) or `/tmp/browsersweet` (macOS without TMPDIR)
 * and point our agent at their socket. Tests can't chown, so a foreign owner is simulated by
 * injecting `lstat` results or a different expected uid; modes and symlinks are real.
 */

const posix = process.platform !== 'win32';
const uid = process.getuid?.() ?? 0;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function stat(
  kind: 'dir' | 'file' | 'socket' | 'link',
  mode: number,
  owner = uid,
): PathStat {
  return {
    uid: owner,
    mode,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSocket: () => kind === 'socket',
    isSymbolicLink: () => kind === 'link',
  };
}

/** Real `lstat`, except `target` reports another user as its owner. */
function foreignOwner(target: string) {
  return (p: string): PathStat => {
    const real = lstatSync(p);
    if (p !== target) return real;
    return {
      uid: uid + 1,
      mode: real.mode,
      isDirectory: () => real.isDirectory(),
      isFile: () => real.isFile(),
      isSocket: () => real.isSocket(),
      isSymbolicLink: () => real.isSymbolicLink(),
    };
  };
}

describe('discoveryPathProblem', () => {
  it('accepts what a host creates', () => {
    expect(discoveryPathProblem(stat('dir', 0o700), 'directory', uid)).toBe(
      undefined,
    );
    expect(discoveryPathProblem(stat('file', 0o600), 'record', uid)).toBe(
      undefined,
    );
    expect(discoveryPathProblem(stat('socket', 0o600), 'socket', uid)).toBe(
      undefined,
    );
  });

  it("rejects another user's directory, record or socket", () => {
    const other = uid + 1;
    expect(
      discoveryPathProblem(stat('dir', 0o700, other), 'directory', uid),
    ).toBe(`is owned by uid ${other}, not ${uid}`);
    expect(
      discoveryPathProblem(stat('file', 0o600, other), 'record', uid),
    ).toMatch(/owned by uid/);
    expect(
      discoveryPathProblem(stat('socket', 0o600, other), 'socket', uid),
    ).toMatch(/owned by uid/);
  });

  it('rejects loose modes, symlinks and the wrong kind of file', () => {
    expect(discoveryPathProblem(stat('dir', 0o777), 'directory', uid)).toBe(
      'is mode 777; expected 700',
    );
    expect(discoveryPathProblem(stat('dir', 0o750), 'directory', uid)).toMatch(
      /mode 750/,
    );
    expect(discoveryPathProblem(stat('file', 0o666), 'record', uid)).toMatch(
      /world writable/,
    );
    expect(discoveryPathProblem(stat('file', 0o620), 'record', uid)).toMatch(
      /group or world writable/,
    );
    // Readable by others is a token leak, not a trust problem; the host writes 0600 anyway.
    expect(discoveryPathProblem(stat('file', 0o644), 'record', uid)).toBe(
      undefined,
    );
    for (const kind of ['directory', 'record', 'socket'] as const) {
      expect(discoveryPathProblem(stat('link', 0o777), kind, uid)).toBe(
        'is a symlink',
      );
    }
    expect(discoveryPathProblem(stat('file', 0o700), 'directory', uid)).toBe(
      'is not a directory',
    );
    expect(discoveryPathProblem(stat('dir', 0o600), 'record', uid)).toBe(
      'is not a regular file',
    );
    expect(discoveryPathProblem(stat('file', 0o600), 'socket', uid)).toBe(
      'is not a socket',
    );
  });

  it('skips the owner check without a uid', () => {
    expect(
      discoveryPathProblem(stat('dir', 0o700, 1234), 'directory', undefined),
    ).toBe(undefined);
  });
});

describe('isProcessAlive', () => {
  it('counts our processes, not other users’ (EPERM)', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12_345)).toBe(false);
    // pid 1 belongs to root: EPERM for anyone else.
    if (posix && uid !== 0) expect(isProcessAlive(1)).toBe(false);
  });
});

interface Spoof {
  readonly dir: string;
  readonly endpoint: string;
  readonly recordFile: string;
  readonly connections: () => number;
}

/** A run directory with a listening socket and a record naming it, like a host's (or an attacker's). */
async function spoofHost(
  options: {
    mode?: number;
    socketDir?: string;
    /** What the record says, if not the real socket path. */
    recordEndpoint?: (endpoint: string, dir: string) => string;
  } = {},
): Promise<Spoof> {
  const base = shortTempDir('bsdisc-');
  const dir = path.join(base, 'run');
  ensurePrivateDir(dir);
  const socketDir = options.socketDir ?? dir;
  const endpoint = path.join(socketDir, 'a.sock');
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  const record: HostRecord = {
    v: 1,
    pid: process.pid,
    startedAt: Date.now(),
    endpoint: options.recordEndpoint?.(endpoint, dir) ?? endpoint,
    token: 'f'.repeat(64),
    browser: { name: 'Chrome' },
    profile: { id: 'evil' },
    extension: { id: TEST_EXTENSION_ID, version: '1' },
  };
  const recordFile = path.join(dir, 'aaaaaaaaaaaaaaaa.json');
  writeFileSync(recordFile, JSON.stringify(record), { mode: 0o600 });
  if (options.mode !== undefined) chmodSync(dir, options.mode);
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(base, { recursive: true, force: true });
  });
  return { dir, endpoint, recordFile, connections: () => connections };
}

async function poolConnects(
  dirs: readonly string[],
  options: Partial<ConstructorParameters<typeof DiscoveryPool>[0]> = {},
): Promise<string[]> {
  const logs: string[] = [];
  const pool = new DiscoveryPool({
    dirs: () => dirs,
    clientVersion: 't',
    connectTimeoutMs: 500,
    log: (message) => logs.push(message),
    ...options,
  });
  try {
    expect(await pool.list()).toEqual([]);
  } finally {
    pool.close();
  }
  return logs;
}

describe.skipIf(!posix)('discovery trusts only directories we own', () => {
  it('connects to a record in a private directory (control)', async () => {
    const spoof = await spoofHost();
    expect(readTrustedRecords(spoof.dir).entries).toHaveLength(1);
    // The fake socket hangs up, so no host results, but the client did try.
    const logs = await poolConnects([spoof.dir]);
    expect(spoof.connections()).toBe(1);
    expect(logs.join('\n')).toMatch(/can't connect/);
  });

  it('skips a world-writable (0777) directory without connecting', async () => {
    const spoof = await spoofHost({ mode: 0o777 });
    expect(readTrustedRecords(spoof.dir)).toEqual({
      entries: [],
      rejected: [],
      dirProblem: 'is mode 777; expected 700',
    });
    const logs = await poolConnects([spoof.dir, spoof.dir]);
    expect(spoof.connections()).toBe(0);
    // Logged once, not once per scan.
    expect(logs).toEqual([
      `ignoring ${spoof.dir}: it is mode 777; expected 700`,
    ]);
  });

  it('skips a directory owned by someone else, even at 0700', async () => {
    const spoof = await spoofHost();
    const other = uid + 1;
    const foreignDir = foreignOwner(spoof.dir);
    expect(
      readTrustedRecords(spoof.dir, { lstat: foreignDir }).dirProblem,
    ).toBe(`is owned by uid ${other}, not ${uid}`);
    await poolConnects([spoof.dir], { ownership: { lstat: foreignDir } });
    // Same with the uid we expect changed instead.
    await poolConnects([spoof.dir], { ownership: { uid: other } });
    expect(spoof.connections()).toBe(0);
  });

  it('rejects a record or socket owned by someone else', async () => {
    const spoof = await spoofHost();
    const foreign = foreignOwner;
    const byRecord = readTrustedRecords(spoof.dir, {
      lstat: foreign(spoof.recordFile),
    });
    expect(byRecord.entries).toEqual([]);
    expect(byRecord.rejected).toEqual([
      {
        path: spoof.recordFile,
        reason: `is owned by uid ${uid + 1}, not ${uid}`,
      },
    ]);
    const bySocket = readTrustedRecords(spoof.dir, {
      lstat: foreign(spoof.endpoint),
    });
    expect(bySocket.rejected[0]?.reason).toBe(
      `its socket ${spoof.endpoint} is owned by uid ${uid + 1}, not ${uid}`,
    );
    await poolConnects([spoof.dir], {
      ownership: { lstat: foreign(spoof.endpoint) },
    });
    expect(spoof.connections()).toBe(0);
  });

  it('rejects a group/world-writable record', async () => {
    const spoof = await spoofHost();
    chmodSync(spoof.recordFile, 0o666);
    expect(readTrustedRecords(spoof.dir).rejected).toEqual([
      {
        path: spoof.recordFile,
        reason: 'is mode 666 (group or world writable); expected 600',
      },
    ]);
    await poolConnects([spoof.dir]);
    expect(spoof.connections()).toBe(0);
  });

  it('rejects a symlinked directory, record or socket', async () => {
    const spoof = await spoofHost();
    const base = path.dirname(spoof.dir);

    const linkedDir = path.join(base, 'linked');
    symlinkSync(spoof.dir, linkedDir);
    expect(readTrustedRecords(linkedDir).dirProblem).toBe('is a symlink');

    const recordDir = path.join(base, 'records');
    ensurePrivateDir(recordDir);
    const linkedRecord = path.join(recordDir, 'bbbbbbbbbbbbbbbb.json');
    symlinkSync(spoof.recordFile, linkedRecord);
    expect(readTrustedRecords(recordDir).rejected).toEqual([
      { path: linkedRecord, reason: 'is a symlink' },
    ]);

    // A record in its own directory whose socket is a symlink to the real one.
    const socketDir = path.join(base, 'sockets');
    ensurePrivateDir(socketDir);
    const linkedSocket = path.join(socketDir, 'c.sock');
    symlinkSync(spoof.endpoint, linkedSocket);
    const record = {
      ...(JSON.parse(
        JSON.stringify(readTrustedRecords(spoof.dir).entries[0]?.record),
      ) as HostRecord),
      endpoint: linkedSocket,
    };
    const socketRecord = path.join(socketDir, 'cccccccccccccccc.json');
    writeFileSync(socketRecord, JSON.stringify(record), { mode: 0o600 });
    expect(readTrustedRecords(socketDir).rejected).toEqual([
      {
        path: socketRecord,
        reason: `its socket ${linkedSocket} is a symlink`,
      },
    ]);

    await poolConnects([linkedDir, recordDir, socketDir]);
    expect(spoof.connections()).toBe(0);
  });

  it('rejects a record naming a socket outside its directory', async () => {
    const elsewhere = shortTempDir('bsdisc-');
    cleanups.push(() => rmSync(elsewhere, { recursive: true, force: true }));
    const spoof = await spoofHost({ socketDir: elsewhere });
    const { rejected } = readTrustedRecords(spoof.dir);
    expect(rejected[0]?.reason).toMatch(/names a socket outside/);
    // `..` could walk through a symlink the lexical check doesn't see.
    const dotted = await spoofHost({
      recordEndpoint: (_, dir) => `${dir}/../run/a.sock`,
    });
    expect(readTrustedRecords(dotted.dir).rejected[0]?.reason).toMatch(
      /names a socket outside/,
    );
    await poolConnects([spoof.dir]);
    expect(spoof.connections()).toBe(0);
  });

  it('on Windows, only trusts records that name our named pipes', () => {
    const dir = shortTempDir('bsdisc-');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, 'run'));
    const base: HostRecord = {
      v: 1,
      pid: 1,
      startedAt: 0,
      endpoint: '\\\\.\\pipe\\browsersweet-bridge-S-1-5-21-1-abcdef0123456789',
      token: 'a'.repeat(64),
      browser: { name: 'Chrome' },
      profile: { id: 'p' },
      extension: { id: TEST_EXTENSION_ID, version: '1' },
    };
    writeFileSync(path.join(dir, 'run', 'good.json'), JSON.stringify(base));
    writeFileSync(
      path.join(dir, 'run', 'bad.json'),
      JSON.stringify({ ...base, endpoint: '\\\\.\\pipe\\evil' }),
    );
    const result = readTrustedRecords(path.join(dir, 'run'), {
      platform: 'win32',
    });
    expect(result.entries.map((e) => path.basename(e.file))).toEqual([
      'good.json',
    ]);
    expect(result.rejected[0]?.reason).toMatch(/not a Browser Sweet pipe/);
  });
});

describe.skipIf(!posix)('doctor', () => {
  it('fails on a loose run directory and never connects to it', async () => {
    const spoof = await spoofHost({ mode: 0o777 });
    const ctx = { ...nodeInstallContext(), env: { [RUN_DIR_ENV]: spoof.dir } };
    const checks = await checkHosts(ctx, nodeDoctorDeps, 't');
    expect(checks[0]).toEqual({
      level: 'fail',
      message: `${spoof.dir} is mode 777; expected 700. The MCP server ignores it; if you didn't create it, another user may have, so remove it.`,
    });
    expect(spoof.connections()).toBe(0);
  });

  it('fails on a directory owned by someone else, not just a loose mode', async () => {
    const spoof = await spoofHost();
    const ctx = { ...nodeInstallContext(), env: { [RUN_DIR_ENV]: spoof.dir } };
    const checks = await checkHosts(
      ctx,
      { ...nodeDoctorDeps, ownership: { uid: uid + 1 } },
      't',
    );
    expect(checks[0]?.level).toBe('fail');
    expect(checks[0]?.message).toMatch(
      new RegExp(`owned by uid ${uid}, not ${uid + 1}`),
    );
    expect(spoof.connections()).toBe(0);
  });

  it('fails on a rejected record', async () => {
    const spoof = await spoofHost();
    chmodSync(spoof.recordFile, 0o666);
    const ctx = { ...nodeInstallContext(), env: { [RUN_DIR_ENV]: spoof.dir } };
    const checks = await checkHosts(ctx, nodeDoctorDeps, 't');
    expect(checks[0]).toMatchObject({ level: 'fail' });
    expect(checks[0]?.message).toContain(spoof.recordFile);
    expect(spoof.connections()).toBe(0);
  });
});
