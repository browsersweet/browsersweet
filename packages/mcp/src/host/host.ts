import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { JsonChannel } from '../native/channel.js';
import {
  ChunkAssembler,
  ChunkError,
  ChunkMessage,
  encodeForWire,
} from '../protocol/chunking.js';
import type { BridgeError } from '../protocol/common.js';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  MAX_CALL_TIMEOUT_MS,
  MAX_IN_FLIGHT_CALLS,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  NATIVE_INBOUND_MAX_BYTES,
  NATIVE_MESSAGE_MAX_BYTES,
  SOCKET_CLIENT_MAX_FRAME_BYTES,
  SOCKET_MAX_FRAME_BYTES,
} from '../protocol/constants.js';
import {
  EVENTS,
  ExtensionToHostMessage,
  type HelloMessage,
  type ClientSummary,
  type HostToExtensionMessage,
  isChunk,
  MAX_STATUS_CLIENTS,
  negotiateProtocol,
  parseMessage,
  type ToolsResultMessage,
} from '../protocol/native.js';
import {
  ClientToHostMessage,
  type HostRecord,
  type HostState,
  type HostToClientMessage,
  type McpClientInfo,
} from '../protocol/socket.js';
import { RESERVED_TOOL_NAMES } from '../protocol/tools.js';
import type { Caller } from './caller.js';
import { writePrivateFile } from './fs-security.js';
import { sweepStaleRecords } from './records.js';
import { pipePath } from './windows.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string) => void;

export interface BridgeHostOptions {
  /** Native messaging stdin/stdout. */
  readonly input: Readable;
  readonly output: Writable;
  /** Verified caller (see `verifyCaller`). */
  readonly caller: Caller;
  /** Private directory for the socket and the discovery record. */
  readonly runDir: string;
  readonly platform: NodeJS.Platform;
  /** Windows pipe name prefix (`pipePrefix(sid)`). Required on win32. */
  readonly pipePrefix?: string;
  readonly version: string;
  readonly helloTimeoutMs?: number;
  readonly clientHelloTimeoutMs?: number;
  readonly maxClients?: number;
  readonly log?: Logger;
  readonly now?: () => number;
}

interface ClientSession {
  readonly socket: Socket;
  readonly channel: JsonChannel;
  authed: boolean;
  helloTimer: NodeJS.Timeout | undefined;
  /** Set on authentication. */
  identity?: SessionIdentity;
}

interface SessionIdentity {
  readonly id: string;
  readonly connectedAt: number;
  /** From `client.hello`. */
  readonly client: { readonly name: string; readonly version: string };
  /** From `client.hello.mcpClient` or `client.info`. */
  mcpClient?: McpClientInfo;
}

interface PendingCall {
  readonly session: ClientSession;
  readonly clientId: string;
  readonly timer: NodeJS.Timeout;
}

const noopLog: Logger = () => undefined;

/**
 * Host mode: the relay between one browser profile's extension (native messaging on stdio) and
 * any number of local MCP clients (a per-user Unix socket or named pipe). It never listens on TCP.
 *
 * Lifecycle: wait for the extension's `hello` → ack → listen and write the discovery record →
 * relay → when stdin ends (the extension disconnected or the browser quit), remove the socket and
 * record and emit `closed`.
 */
export class BridgeHost extends EventEmitter {
  private readonly extension: JsonChannel;
  private readonly assembler = new ChunkAssembler();
  private readonly sessions = new Set<ClientSession>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly startedAt: number;
  private state: HostState | undefined;
  private server: Server | undefined;
  private recordFile: string | undefined;
  private endpointPath: string | undefined;
  private token = '';
  private callSeq = 0;
  private closing = false;
  private helloTimer: NodeJS.Timeout | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  readonly ready: Promise<void>;
  readonly closed: Promise<string>;

  constructor(private readonly options: BridgeHostOptions) {
    super();
    this.log = options.log ?? noopLog;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Callers may only await `closed`; don't let a failed start become an unhandled rejection.
    this.ready.catch(() => undefined);
    this.closed = new Promise((resolve) => this.once('closed', resolve));
    this.extension = new JsonChannel(
      options.input,
      options.output,
      {
        onMessage: (value) => this.onExtensionValue(value),
        onError: (error) => {
          this.log('error', `native messaging: ${error.message}`);
          void this.close(`native messaging error: ${error.message}`);
        },
        onEnd: () => void this.close('extension disconnected'),
      },
      {
        maxInboundBytes: NATIVE_INBOUND_MAX_BYTES,
        maxOutboundBytes: NATIVE_MESSAGE_MAX_BYTES,
      },
    );
    this.helloTimer = setTimeout(
      () => void this.close('no hello from the extension'),
      options.helloTimeoutMs ?? 10_000,
    );
  }

  /** The socket path or pipe name, once listening. */
  get endpoint(): string | undefined {
    return this.endpointPath;
  }

  get record(): string | undefined {
    return this.recordFile;
  }

  get clientCount(): number {
    return [...this.sessions].filter((s) => s.authed).length;
  }

  /** Authenticated clients, oldest first (what `host.status.clientList` carries). */
  get clients(): ClientSummary[] {
    const list: ClientSummary[] = [];
    for (const session of this.sessions) {
      const identity = session.identity;
      if (!session.authed || !identity) continue;
      const who = identity.mcpClient ?? identity.client;
      list.push({
        id: identity.id,
        name: who.name,
        version: who.version,
        connectedAt: identity.connectedAt,
      });
    }
    return list
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .slice(0, MAX_STATUS_CLIENTS);
  }

  private sendStatus(): void {
    this.sendToExtension({
      type: 'host.status',
      clients: this.clientCount,
      clientList: this.clients,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Extension side

  private sendToExtension(message: HostToExtensionMessage): void {
    try {
      for (const part of encodeForWire(message)) this.extension.send(part);
    } catch (error) {
      this.log('error', `can't send to extension: ${(error as Error).message}`);
    }
  }

  private onExtensionValue(raw: unknown): void {
    if (isChunk(raw)) {
      const chunk = ChunkMessage.safeParse(raw);
      if (!chunk.success) {
        this.log('warn', 'invalid chunk from extension');
        return;
      }
      try {
        const assembled = this.assembler.push(chunk.data, this.now());
        if (assembled.done) this.onExtensionMessage(assembled.message);
      } catch (error) {
        this.log('warn', (error as ChunkError).message);
      }
      return;
    }
    this.onExtensionMessage(raw);
  }

  private onExtensionMessage(raw: unknown): void {
    const parsed = parseMessage(ExtensionToHostMessage, raw);
    if (!parsed.ok) {
      this.log(
        parsed.unknownType ? 'debug' : 'warn',
        `ignored message from extension: ${parsed.error}`,
      );
      return;
    }
    const message = parsed.message;
    if (!this.state && message.type !== 'hello') {
      this.log('warn', `ignored ${message.type} before hello`);
      return;
    }
    switch (message.type) {
      case 'hello':
        if (this.state) {
          this.log('warn', 'ignored a second hello');
          return;
        }
        void this.onHello(message);
        return;
      case 'tools.list':
        this.updateState({
          tools: dedupeTools(
            message.tools.filter((t) => !RESERVED_TOOL_NAMES.includes(t.name)),
          ),
        });
        return;
      case 'tools.result':
        this.onToolResult(message);
        return;
      case 'clients.disconnect':
        this.disconnectClient(message.clientId);
        return;
      case 'event':
        if (message.event === EVENTS.profileFocused) {
          this.updateState({ lastFocusedAt: this.now() });
        }
        this.broadcast(message);
        return;
      case 'ping':
        this.sendToExtension({ type: 'pong', id: message.id });
        return;
      case 'pong':
        return;
      case 'error':
        this.log(
          'warn',
          `extension error ${message.error.code}: ${message.error.message}`,
        );
        return;
    }
  }

  private async onHello(hello: HelloMessage): Promise<void> {
    clearTimeout(this.helloTimer);
    const { caller } = this.options;
    if (hello.extension.id !== caller.extensionId) {
      this.sendToExtension({
        type: 'error',
        error: {
          code: 'unauthorized',
          message: `hello says ${hello.extension.id}, but the browser launched the host for ${caller.extensionId}`,
        },
      });
      await this.close('extension id mismatch');
      return;
    }
    const version = negotiateProtocol(
      hello.protocolVersion,
      hello.minProtocolVersion,
    );
    if (version === undefined) {
      this.sendToExtension({
        type: 'error',
        error: {
          code: 'protocol_unsupported',
          message: `extension speaks ${hello.minProtocolVersion ?? hello.protocolVersion}–${hello.protocolVersion}; this host speaks ${MIN_PROTOCOL_VERSION}–${PROTOCOL_VERSION}`,
        },
      });
      await this.close('protocol mismatch');
      return;
    }
    this.state = {
      pid: process.pid,
      startedAt: this.startedAt,
      hostVersion: this.options.version,
      protocolVersion: version,
      extension: hello.extension,
      browser: hello.browser,
      profile: hello.profile,
      ...(hello.focused ? { lastFocusedAt: this.now() } : {}),
      tools: [],
    };
    this.sendToExtension({
      type: 'hello.ack',
      protocolVersion: version,
      host: { version: this.options.version, platform: this.options.platform },
    });
    try {
      await this.listen();
      this.log(
        'info',
        `listening for ${hello.browser.name} profile ${hello.profile.id} on ${this.endpointPath}`,
      );
      this.readyResolve?.();
    } catch (error) {
      this.log('error', `can't listen: ${(error as Error).message}`);
      this.readyReject?.(error as Error);
      await this.close(`listen failed: ${(error as Error).message}`);
    }
  }

  private onToolResult(message: ToolsResultMessage): void {
    const call = this.pending.get(message.id);
    if (!call) {
      this.log('debug', `late or unknown result ${message.id}`);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(call.timer);
    this.sendToSession(call.session, {
      type: 'tools.result',
      id: call.clientId,
      ...(message.error
        ? { error: message.error }
        : { result: message.result ?? {} }),
    });
  }

  private updateState(patch: Partial<HostState>): void {
    if (!this.state) return;
    this.state = { ...this.state, ...patch };
    this.broadcast({ type: 'host.state', state: this.state });
  }

  // -------------------------------------------------------------------------------------------
  // Socket side

  private async listen(): Promise<void> {
    const { runDir, platform } = this.options;
    const id = randomBytes(8).toString('hex');
    this.token = randomBytes(32).toString('hex');
    // Records (and sockets) of hosts that died without cleaning up.
    sweepStaleRecords(runDir);
    if (platform === 'win32') {
      if (!this.options.pipePrefix) throw new Error('pipePrefix is required');
      this.endpointPath = pipePath(this.options.pipePrefix, id);
    } else {
      this.endpointPath = path.join(runDir, `${id}.sock`);
    }
    const server = createServer({ allowHalfOpen: false }, (socket) =>
      this.accept(socket),
    );
    server.maxConnections = this.options.maxClients ?? 16;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Create the socket 0600 from the start; the directory is already 0700.
      const restoreUmask = setUmask(platform, 0o177);
      try {
        server.listen(this.endpointPath, () => {
          server.off('error', reject);
          resolve();
        });
      } finally {
        restoreUmask();
      }
    });
    server.on('error', (error) =>
      this.log('error', `socket: ${error.message}`),
    );
    if (platform !== 'win32' && this.endpointPath) {
      chmodSync(this.endpointPath, 0o600);
    }
    const state = this.state;
    if (!state || !this.endpointPath) return;
    const record: HostRecord = {
      v: 1,
      pid: state.pid,
      startedAt: state.startedAt,
      endpoint: this.endpointPath,
      token: this.token,
      browser: state.browser,
      profile: state.profile,
      extension: state.extension,
    };
    this.recordFile = path.join(runDir, `${id}.json`);
    writePrivateFile(this.recordFile, JSON.stringify(record));
  }

  private accept(socket: Socket): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    // eslint-disable-next-line prefer-const -- assigned after the channel, referenced in handlers
    let session: ClientSession;
    const channel = new JsonChannel(
      socket,
      socket,
      {
        onMessage: (value) => this.onClientValue(session, value),
        onError: (error) => {
          this.log('warn', `client: ${error.message}`);
          this.dropSession(session);
        },
        onEnd: () => this.dropSession(session),
      },
      {
        maxInboundBytes: SOCKET_CLIENT_MAX_FRAME_BYTES,
        maxOutboundBytes: SOCKET_MAX_FRAME_BYTES,
      },
    );
    session = {
      socket,
      channel,
      authed: false,
      helloTimer: setTimeout(
        () => this.dropSession(session),
        this.options.clientHelloTimeoutMs ?? 5_000,
      ),
    };
    socket.on('error', () => this.dropSession(session));
    this.sessions.add(session);
  }

  private onClientValue(session: ClientSession, raw: unknown): void {
    const parsed = parseMessage(ClientToHostMessage, raw);
    if (!parsed.ok) {
      if (!session.authed) {
        this.dropSession(session);
        return;
      }
      if (parsed.unknownType) return;
      this.sendToSession(session, {
        type: 'error',
        error: { code: 'invalid_message', message: parsed.error },
      });
      return;
    }
    const message = parsed.message;
    if (!session.authed) {
      if (
        message.type !== 'client.hello' ||
        !this.tokenMatches(message.token)
      ) {
        // Nothing is written before authentication.
        this.dropSession(session);
        return;
      }
      const version = negotiateProtocol(
        message.protocolVersion,
        message.minProtocolVersion,
      );
      if (version === undefined || !this.state) {
        this.sendToSession(session, {
          type: 'error',
          error: {
            code: 'protocol_unsupported',
            message: 'no common protocol version',
          },
        });
        this.dropSession(session);
        return;
      }
      clearTimeout(session.helloTimer);
      session.helloTimer = undefined;
      session.authed = true;
      session.identity = {
        id: randomBytes(6).toString('hex'),
        connectedAt: this.now(),
        client: message.client,
        ...(message.mcpClient ? { mcpClient: message.mcpClient } : {}),
      };
      this.sendToSession(session, {
        type: 'host.hello',
        protocolVersion: version,
        state: this.state,
      });
      this.sendStatus();
      return;
    }
    switch (message.type) {
      case 'client.hello':
        return;
      case 'client.info': {
        const identity = session.identity;
        if (!identity) return;
        const current = identity.mcpClient;
        if (
          current?.name === message.mcpClient.name &&
          current.version === message.mcpClient.version
        ) {
          return;
        }
        identity.mcpClient = message.mcpClient;
        this.sendStatus();
        return;
      }
      case 'ping':
        this.sendToSession(session, { type: 'pong', id: message.id });
        return;
      case 'pong':
        return;
      case 'tools.call': {
        const reply = (error: BridgeError): void =>
          this.sendToSession(session, {
            type: 'tools.result',
            id: message.id,
            error,
          });
        if (this.pending.size >= MAX_IN_FLIGHT_CALLS) {
          reply({ code: 'busy', message: 'too many calls in flight' });
          return;
        }
        const timeoutMs = Math.min(
          message.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
          MAX_CALL_TIMEOUT_MS,
        );
        const id = `h${++this.callSeq}`;
        const timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          this.sendToExtension({ type: 'tools.cancel', id });
          reply({
            code: 'timeout',
            message: `the browser didn't answer ${message.name} within ${timeoutMs} ms`,
          });
        }, timeoutMs);
        this.pending.set(id, { session, clientId: message.id, timer });
        this.sendToExtension({
          type: 'tools.call',
          id,
          name: message.name,
          arguments: message.arguments,
          timeoutMs,
        });
        return;
      }
    }
  }

  private tokenMatches(candidate: string): boolean {
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(this.token, 'utf8');
    return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
  }

  private sendToSession(
    session: ClientSession,
    message: HostToClientMessage,
  ): void {
    try {
      session.channel.send(message);
    } catch (error) {
      // Over the socket frame limit: tell the client instead.
      if (message.type === 'tools.result') {
        session.channel.send({
          type: 'tools.result',
          id: message.id,
          error: { code: 'too_large', message: (error as Error).message },
        });
      } else {
        this.log('warn', `can't send to client: ${(error as Error).message}`);
      }
    }
  }

  private broadcast(message: HostToClientMessage): void {
    for (const session of this.sessions) {
      if (session.authed) this.sendToSession(session, message);
    }
  }

  /** The extension asked to disconnect one client (the user clicked "Disconnect"). */
  private disconnectClient(clientId: string): void {
    const session = [...this.sessions].find(
      (s) => s.authed && s.identity?.id === clientId,
    );
    if (!session) {
      this.log('debug', `clients.disconnect: no client ${clientId}`);
      return;
    }
    const who = session.identity?.mcpClient ?? session.identity?.client;
    this.log('info', `disconnecting client ${clientId} (${who?.name ?? '?'})`);
    this.sendToSession(session, {
      type: 'error',
      error: {
        code: 'disconnected',
        message: 'The user disconnected this client in Browser Sweet.',
      },
    });
    this.dropSession(session, { graceful: true });
  }

  /**
   * Forget a client and close its socket. `graceful` flushes what was written (the
   * `disconnected` notice) before closing; otherwise the socket is destroyed at once.
   */
  private dropSession(
    session: ClientSession | undefined,
    { graceful = false }: { graceful?: boolean } = {},
  ): void {
    if (!session || !this.sessions.delete(session)) return;
    clearTimeout(session.helloTimer);
    session.channel.detach();
    if (graceful) {
      session.socket.end();
      setTimeout(() => session.socket.destroy(), 1_000).unref();
    } else {
      session.socket.destroy();
    }
    for (const [id, call] of this.pending) {
      if (call.session !== session) continue;
      clearTimeout(call.timer);
      this.pending.delete(id);
      this.sendToExtension({ type: 'tools.cancel', id });
    }
    if (session.authed && !this.closing) this.sendStatus();
  }

  // -------------------------------------------------------------------------------------------

  /** Remove the socket and record synchronously (for `process.on('exit')`). */
  cleanupSync(): void {
    if (this.recordFile) rmSync(this.recordFile, { force: true });
    if (this.options.platform !== 'win32' && this.endpointPath) {
      rmSync(this.endpointPath, { force: true });
    }
  }

  async close(reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.helloTimer);
    this.log('info', `closing: ${reason}`);
    this.readyReject?.(new Error(reason));
    this.extension.detach();
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      this.sendToSession(call.session, {
        type: 'tools.result',
        id: call.clientId,
        error: { code: 'unavailable', message: 'the browser disconnected' },
      });
      this.pending.delete(id);
    }
    for (const session of [...this.sessions]) {
      session.socket.end();
      this.dropSession(session);
    }
    // Remove the record first so clients stop discovering us.
    this.cleanupSync();
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.emit('closed', reason);
  }
}

function dedupeTools<T extends { name: string }>(tools: readonly T[]): T[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

/** Set the umask for the duration of a synchronous listen. Workers can't, which is fine. */
function setUmask(platform: NodeJS.Platform, mask: number): () => void {
  if (platform === 'win32') return () => undefined;
  try {
    const previous = process.umask(mask);
    return () => process.umask(previous);
  } catch {
    return () => undefined;
  }
}
