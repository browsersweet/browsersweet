import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { JsonChannel } from '../native/channel.js';
import type { BridgeError, ToolArguments } from '../protocol/common.js';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SOCKET_CLIENT_MAX_FRAME_BYTES,
  SOCKET_MAX_FRAME_BYTES,
} from '../protocol/constants.js';
import { parseMessage, type EventMessage } from '../protocol/native.js';
import {
  HostToClientMessage,
  type ClientToHostMessage,
  type HostRecord,
  type HostState,
  type McpClientInfo,
} from '../protocol/socket.js';
import type { ToolResult } from '../protocol/tools.js';

export interface ToolCallOutcome {
  readonly result?: ToolResult;
  readonly error?: BridgeError;
}

export interface ConnectOptions {
  readonly clientName?: string;
  readonly clientVersion: string;
  /** The MCP client this process serves, if known yet (see `setMcpClient`). */
  readonly mcpClient?: McpClientInfo;
  readonly timeoutMs?: number;
}

interface Pending {
  readonly resolve: (outcome: ToolCallOutcome) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * One authenticated connection to a host's socket. Emits `state` (HostState), `event`
 * (EventMessage) and `close`.
 */
export class HostConnection extends EventEmitter {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private ended = false;
  private currentState: HostState;
  private mcpClient: McpClientInfo | undefined;
  /** The user disconnected this client in the extension; don't reconnect to this host. */
  disconnectedByUser = false;

  private constructor(
    readonly record: HostRecord,
    private readonly socket: Socket,
    private readonly channel: JsonChannel,
    state: HostState,
  ) {
    super();
    this.currentState = state;
  }

  get state(): HostState {
    return this.currentState;
  }

  get closed(): boolean {
    return this.ended;
  }

  static connect(
    record: HostRecord,
    options: ConnectOptions,
  ): Promise<HostConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect(record.endpoint);
      let connection: HostConnection | undefined;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error(`timed out connecting to ${record.endpoint}`)),
        options.timeoutMs ?? 2_000,
      );
      const channel = new JsonChannel(
        socket,
        socket,
        {
          onMessage: (value) => {
            if (connection) {
              connection.onValue(value);
              return;
            }
            const parsed = parseMessage(HostToClientMessage, value);
            if (!parsed.ok) {
              fail(new Error(`invalid message from host: ${parsed.error}`));
              return;
            }
            const message = parsed.message;
            if (message.type === 'error') {
              fail(
                new Error(`${message.error.code}: ${message.error.message}`),
              );
              return;
            }
            if (message.type !== 'host.hello') return;
            settled = true;
            clearTimeout(timer);
            connection = new HostConnection(
              record,
              socket,
              channel,
              message.state,
            );
            connection.mcpClient = options.mcpClient;
            resolve(connection);
          },
          onError: (error) => {
            if (connection) connection.shutdown();
            else fail(error);
          },
          onEnd: () => {
            if (connection) connection.shutdown();
            else fail(new Error('host closed the connection'));
          },
        },
        {
          maxInboundBytes: SOCKET_MAX_FRAME_BYTES,
          maxOutboundBytes: SOCKET_CLIENT_MAX_FRAME_BYTES,
        },
      );
      socket.once('error', (error) => {
        if (connection) connection.shutdown();
        else fail(error);
      });
      socket.once('connect', () => {
        const hello: ClientToHostMessage = {
          type: 'client.hello',
          protocolVersion: PROTOCOL_VERSION,
          token: record.token,
          client: {
            name: options.clientName ?? '@browsersweet/mcp',
            version: options.clientVersion,
          },
          ...(options.mcpClient ? { mcpClient: options.mcpClient } : {}),
        };
        channel.send(hello);
      });
    });
  }

  /** Call a tool. Never rejects: failures come back as `{ error }`. */
  call(
    name: string,
    args: ToolArguments,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<ToolCallOutcome> {
    if (this.ended) {
      return Promise.resolve({
        error: { code: 'unavailable', message: 'the browser disconnected' },
      });
    }
    const id = `m${++this.seq}`;
    return new Promise((resolve) => {
      // The host times out first; this only covers a host that stops answering.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          error: {
            code: 'timeout',
            message: `no answer from the browser within ${timeoutMs} ms`,
          },
        });
      }, timeoutMs + 2_000);
      this.pending.set(id, { resolve, timer });
      try {
        this.channel.send({
          type: 'tools.call',
          id,
          name,
          arguments: args,
          timeoutMs,
        } satisfies ClientToHostMessage);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          error: { code: 'too_large', message: (error as Error).message },
        });
      }
    });
  }

  /** Tell the host which MCP client this is (for the extension's status). Sent on change only. */
  setMcpClient(info: McpClientInfo): void {
    if (this.ended) return;
    if (
      this.mcpClient?.name === info.name &&
      this.mcpClient.version === info.version
    ) {
      return;
    }
    this.mcpClient = info;
    this.channel.send({
      type: 'client.info',
      mcpClient: info,
    } satisfies ClientToHostMessage);
  }

  close(): void {
    this.shutdown();
  }

  private onValue(value: unknown): void {
    const parsed = parseMessage(HostToClientMessage, value);
    if (!parsed.ok) return;
    const message = parsed.message;
    switch (message.type) {
      case 'host.state':
        this.currentState = message.state;
        this.emit('state', message.state);
        return;
      case 'tools.result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(
          message.error
            ? { error: message.error }
            : { result: message.result ?? {} },
        );
        return;
      }
      case 'event':
        this.emit('event', message satisfies EventMessage);
        return;
      case 'ping':
        this.channel.send({ type: 'pong', id: message.id });
        return;
      case 'error':
        // The host closes the socket right after this notice.
        if (message.error.code === 'disconnected') {
          this.disconnectedByUser = true;
        }
        return;
      default:
        return;
    }
  }

  private shutdown(): void {
    if (this.ended) return;
    this.ended = true;
    this.channel.detach();
    this.socket.destroy();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        error: { code: 'unavailable', message: 'the browser disconnected' },
      });
      this.pending.delete(id);
    }
    this.emit('close');
  }
}
