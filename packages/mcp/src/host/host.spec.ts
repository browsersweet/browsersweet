import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { HostConnection } from '../client/connection.js';
import {
  encodeJsonFrame,
  FrameDecoder,
  parseJsonFrame,
} from '../native/framing.js';
import { encodeForWire } from '../protocol/chunking.js';
import type {
  HostStatusMessage,
  HostToExtensionMessage,
} from '../protocol/native.js';
import { fitsSocket } from '../paths.js';
import { HostRecord } from '../protocol/socket.js';
import {
  FakeExtension,
  SAMPLE_TOOLS,
  TEST_ORIGIN,
  TEST_EXTENSION_ID,
  shortTempDir,
  until,
  type FakeExtensionOptions,
} from '../test-support/fake-extension.js';
import { ensurePrivateDir, InsecurePathError, modeOf } from './fs-security.js';
import { BridgeHost } from './host.js';
import { readRecords, sweepStaleRecords } from './records.js';

const posix = process.platform !== 'win32';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function startHost(
  ext: FakeExtensionOptions = {},
  hostOptions: Partial<ConstructorParameters<typeof BridgeHost>[0]> = {},
) {
  const runDir = path.join(shortTempDir(), 'run');
  ensurePrivateDir(runDir);
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const host = new BridgeHost({
    input: toHost,
    output: fromHost,
    caller: {
      kind: 'chromium',
      origin: TEST_ORIGIN,
      extensionId: TEST_EXTENSION_ID,
    },
    runDir,
    platform: process.platform,
    version: '0.0.0-test',
    ...hostOptions,
  });
  const extension = new FakeExtension(toHost, fromHost, {
    tools: SAMPLE_TOOLS,
    ...ext,
  });
  cleanups.push(async () => {
    await host.close('test done');
    rmSync(path.dirname(runDir), { recursive: true, force: true });
  });
  extension.hello();
  extension.sendTools();
  await host.ready;
  const [entry] = readRecords(runDir);
  if (!entry) throw new Error('no record');
  return { host, extension, runDir, record: entry.record, toHost };
}

async function connectClient(record: HostRecord) {
  const connection = await HostConnection.connect(record, {
    clientVersion: 'test',
  });
  cleanups.push(() => connection.close());
  await until(() => connection.state.tools.length > 0);
  return connection;
}

describe('BridgeHost', () => {
  it('acks the hello, listens and writes a private discovery record', async () => {
    const { extension, runDir, record } = await startHost();
    const ack = await extension.waitFor((m) => m.type === 'hello.ack');
    expect(ack).toMatchObject({ type: 'hello.ack', protocolVersion: 1 });
    expect(record.profile.id).toBe('profile-a');
    expect(record.endpoint.startsWith(runDir)).toBe(posix);
    if (posix) {
      expect(modeOf(runDir)).toBe(0o700);
      expect(lstatSync(record.endpoint).isSocket()).toBe(true);
      expect(modeOf(record.endpoint)).toBe(0o600);
      const recordFile = readdirSync(runDir).find((f) => f.endsWith('.json'));
      expect(modeOf(path.join(runDir, recordFile as string))).toBe(0o600);
    }
  });

  it('relays tool calls between a socket client and the extension', async () => {
    const { record } = await startHost({
      handlers: {
        list_spaces: (args) => ({
          data: {
            spaces: [{ id: 's1', name: 'Work', keptCount: 1, tabCount: 2 }],
          },
          content: [{ type: 'text', text: JSON.stringify(args) }],
        }),
      },
    });
    const client = await connectClient(record);
    expect(client.state.tools.map((t) => t.name)).toEqual([
      'list_spaces',
      'get_page_text',
    ]);
    const outcome = await client.call('list_spaces', { q: 1 });
    expect(outcome.result?.data).toEqual({
      spaces: [{ id: 's1', name: 'Work', keptCount: 1, tabCount: 2 }],
    });
    expect(outcome.result?.content?.[0]).toMatchObject({ text: '{"q":1}' });
    const unknown = await client.call('nope', {});
    expect(unknown.error?.code).toBe('unknown_tool');
  });

  it('reassembles chunked results and chunks big calls under 1 MiB', async () => {
    const text = 'é'.repeat(1_500_000);
    const { record, extension } = await startHost({
      handlers: {
        get_page_text: (args) => ({
          content: [{ type: 'text', text, untrusted: true }],
          data: { echoed: (args['blob'] as string).length },
        }),
      },
    });
    const client = await connectClient(record);
    const blob = 'x'.repeat(200_000);
    const outcome = await client.call('get_page_text', { blob });
    expect(outcome.result?.content?.[0]).toMatchObject({ text });
    expect(outcome.result?.data).toEqual({ echoed: 200_000 });
    for (const frame of extension.rawFrames) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(
        1024 * 1024,
      );
    }
  });

  it('times out calls and cancels them in the extension', async () => {
    const { record, extension } = await startHost({
      handlers: { list_spaces: () => 'hang' },
    });
    const client = await connectClient(record);
    const outcome = await client.call('list_spaces', {}, 50);
    expect(outcome.error?.code).toBe('timeout');
    await extension.waitFor((m) => m.type === 'tools.cancel');
  });

  it('forwards events and tracks focus', async () => {
    const { record, extension } = await startHost();
    const client = await connectClient(record);
    expect(client.state.lastFocusedAt).toBeUndefined();
    const events: unknown[] = [];
    client.on('event', (e) => events.push(e));
    extension.send({ type: 'event', event: 'profile.focused' });
    extension.send({ type: 'event', event: 'handoffs.changed' });
    await until(() => events.length === 2);
    expect(client.state.lastFocusedAt).toBeTypeOf('number');
  });

  it('reports the client count to the extension', async () => {
    const { record, extension } = await startHost();
    const client = await connectClient(record);
    await extension.waitFor((m) => m.type === 'host.status' && m.clients === 1);
    client.close();
    await until(() =>
      extension.received.some(
        (m) => m.type === 'host.status' && m.clients === 0,
      ),
    );
  });

  it('names connected clients in host.status, keeping the count', async () => {
    const { record, extension } = await startHost();
    const status = (n: number) => (m: HostToExtensionMessage) =>
      m.type === 'host.status' && m.clients === n;
    const early = await HostConnection.connect(record, {
      clientVersion: '0.1.0',
    });
    cleanups.push(() => early.close());
    const first = (await extension.waitFor(status(1))) as HostStatusMessage;
    expect(first.clientList).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{12}$/),
        name: '@browsersweet/mcp',
        version: '0.1.0',
        connectedAt: expect.any(Number),
      },
    ]);
    // The MCP initialize arrives after the socket connected.
    early.setMcpClient({ name: 'claude-code', version: '2.1.0' });
    await extension.waitFor(
      (m) =>
        m.type === 'host.status' && m.clientList?.[0]?.name === 'claude-code',
    );
    const second = await HostConnection.connect(record, {
      clientVersion: '0.1.0',
      mcpClient: { name: 'cursor', version: '1.0' },
    });
    cleanups.push(() => second.close());
    const both = (await extension.waitFor(status(2))) as HostStatusMessage;
    expect(both.clientList?.map((c) => [c.name, c.version])).toEqual([
      ['claude-code', '2.1.0'],
      ['cursor', '1.0'],
    ]);
  });

  it('disconnects one client when the extension asks', async () => {
    const { record, extension, host } = await startHost();
    const keep = await connectClient(record);
    const drop = await HostConnection.connect(record, {
      clientVersion: 't',
      mcpClient: { name: 'rogue-agent', version: '1' },
    });
    cleanups.push(() => drop.close());
    await until(() => host.clients.length === 2);
    const target = host.clients.find((c) => c.name === 'rogue-agent');
    const closed = new Promise((r) => drop.once('close', r));
    extension.send({ type: 'clients.disconnect', clientId: target?.id ?? '' });
    await closed;
    expect(drop.disconnectedByUser).toBe(true);
    await extension.waitFor(
      (m) =>
        m.type === 'host.status' &&
        m.clients === 1 &&
        m.clientList?.[0]?.name !== 'rogue-agent',
    );
    expect(keep.closed).toBe(false);
    // Unknown ids are ignored.
    extension.send({ type: 'clients.disconnect', clientId: 'nobody' });
    expect((await keep.call('nope', {})).error?.code).toBe('unknown_tool');
  });

  it('relays images and chunks them past the 1 MiB cap', async () => {
    const data = Buffer.alloc(1_000_000, 7).toString('base64');
    const { record } = await startHost({
      handlers: {
        get_page_text: () => ({
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data,
              untrusted: true,
            },
            { type: 'from.the.future', anything: 1 },
          ],
        }),
      },
    });
    const client = await connectClient(record);
    const outcome = await client.call('get_page_text', {});
    expect(outcome.result?.content?.[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data,
    });
    expect(outcome.result?.content?.[1]).toMatchObject({
      type: 'from.the.future',
    });
    // What the extension sent: chunks, each under Chrome's cap.
    const parts = encodeForWire({
      type: 'tools.result',
      id: 'h1',
      result: { content: [{ type: 'image', mimeType: 'image/png', data }] },
    });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(1024 * 1024);
    }
  });

  it('says nothing to a client without the token, and drops it', async () => {
    const { record } = await startHost();
    const socket = connect(record.endpoint);
    cleanups.push(() => void socket.destroy());
    const received: Buffer[] = [];
    socket.on('data', (d) => received.push(d));
    await new Promise((r) => socket.once('connect', r));
    socket.write(
      encodeJsonFrame(
        {
          type: 'client.hello',
          protocolVersion: 1,
          token: '0'.repeat(64),
          client: { name: 'x', version: '1' },
        },
        1e6,
      ),
    );
    await new Promise((r) => socket.once('close', r));
    expect(received).toEqual([]);
  });

  it('drops clients that never say hello', async () => {
    const { record } = await startHost({}, { clientHelloTimeoutMs: 50 });
    const socket = connect(record.endpoint);
    cleanups.push(() => void socket.destroy());
    await new Promise((r) => socket.once('close', r));
  });

  it('answers ping on an authenticated socket', async () => {
    const { record } = await startHost();
    const socket = connect(record.endpoint);
    cleanups.push(() => void socket.destroy());
    const decoder = new FrameDecoder(40e6);
    const messages: { type: string }[] = [];
    socket.on('data', (d) =>
      decoder
        .push(d)
        .forEach((f) => messages.push(parseJsonFrame(f) as { type: string })),
    );
    await new Promise((r) => socket.once('connect', r));
    socket.write(
      encodeJsonFrame(
        {
          type: 'client.hello',
          protocolVersion: 1,
          token: record.token,
          client: { name: 'x', version: '1' },
        },
        1e6,
      ),
    );
    socket.write(encodeJsonFrame({ type: 'ping', id: 'p1' }, 1e6));
    await until(() => messages.some((m) => m.type === 'pong'));
    expect(messages[0]?.type).toBe('host.hello');
  });

  it('refuses a hello from a different extension than the browser launched', async () => {
    const runDir = path.join(shortTempDir(), 'run');
    ensurePrivateDir(runDir);
    const toHost = new PassThrough();
    const fromHost = new PassThrough();
    const host = new BridgeHost({
      input: toHost,
      output: fromHost,
      caller: {
        kind: 'chromium',
        origin: TEST_ORIGIN,
        extensionId: TEST_EXTENSION_ID,
      },
      runDir,
      platform: process.platform,
      version: 't',
    });
    const ext = new FakeExtension(toHost, fromHost, {
      extensionId: 'ppppoooonnnnmmmmllllkkkkjjjjiiii',
    });
    ext.hello();
    expect(await host.closed).toMatch(/mismatch/);
    expect(readdirSync(runDir)).toEqual([]);
    rmSync(path.dirname(runDir), { recursive: true, force: true });
  });

  it('ignores everything before hello and gives up without one', async () => {
    const runDir = path.join(shortTempDir(), 'run');
    ensurePrivateDir(runDir);
    const toHost = new PassThrough();
    const host = new BridgeHost({
      input: toHost,
      output: new PassThrough(),
      caller: {
        kind: 'chromium',
        origin: TEST_ORIGIN,
        extensionId: TEST_EXTENSION_ID,
      },
      runDir,
      platform: process.platform,
      version: 't',
      helloTimeoutMs: 50,
    });
    toHost.write(encodeJsonFrame({ type: 'tools.list', tools: [] }, 1e6));
    expect(await host.closed).toMatch(/no hello/);
    rmSync(path.dirname(runDir), { recursive: true, force: true });
  });

  it('removes its socket and record when the extension disconnects', async () => {
    const { host, runDir, record, toHost } = await startHost();
    const client = await connectClient(record);
    toHost.end();
    await host.closed;
    expect(readdirSync(runDir)).toEqual([]);
    await until(() => client.closed);
    expect(existsSync(record.endpoint)).toBe(false);
  });
});

describe.skipIf(!posix)('socket directory permissions', () => {
  it('creates 0700 and tightens a loose directory we own', () => {
    const base = shortTempDir();
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const dir = path.join(base, 'a', 'run');
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
    const loose = path.join(base, 'loose');
    ensurePrivateDir(loose);
    chmodSync(loose, 0o755);
    ensurePrivateDir(loose);
    expect(modeOf(loose)).toBe(0o700);
  });

  it('refuses a symlink or a file in place of the directory', () => {
    const base = shortTempDir();
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const target = path.join(base, 'target');
    ensurePrivateDir(target);
    const link = path.join(base, 'link');
    symlinkSync(target, link);
    expect(() => ensurePrivateDir(link)).toThrow(InsecurePathError);
    const file = path.join(base, 'file');
    writeFileSync(file, '');
    expect(() => ensurePrivateDir(file)).toThrow();
  });

  it('sweeps records left by dead hosts', () => {
    const dir = shortTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const record: HostRecord = {
      v: 1,
      pid: 999_999,
      startedAt: 0,
      endpoint: path.join(dir, 'dead.sock'),
      token: 'a'.repeat(64),
      browser: { name: 'Chrome' },
      profile: { id: 'p' },
      extension: { id: TEST_EXTENSION_ID, version: '1' },
    };
    writeFileSync(path.join(dir, 'dead.json'), JSON.stringify(record));
    writeFileSync(record.endpoint, '');
    writeFileSync(
      path.join(dir, 'live.json'),
      JSON.stringify({
        ...record,
        pid: process.pid,
        endpoint: path.join(dir, 'live.sock'),
      }),
    );
    const removed = sweepStaleRecords(dir, (pid) => pid === process.pid);
    expect(removed).toEqual([path.join(dir, 'dead.json')]);
    expect(readdirSync(dir).sort()).toEqual(['live.json']);
  });
});

describe('socket directories', () => {
  it('rejects a run directory too long for a Unix socket', () => {
    const pe = {
      platform: 'darwin',
      homedir: '/Users/me',
      env: {},
      tmpdir: '/tmp',
    } as const;
    expect(fitsSocket('/tmp/browsersweet', pe)).toBe(true);
    expect(fitsSocket(`/tmp/${'x'.repeat(90)}`, pe)).toBe(false);
    expect(
      fitsSocket(`C:\\${'x'.repeat(200)}`, { ...pe, platform: 'win32' }),
    ).toBe(true);
  });
});
