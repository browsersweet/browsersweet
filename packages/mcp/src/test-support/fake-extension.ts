import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { JsonChannel } from '../native/channel.js';
import {
  ChunkAssembler,
  ChunkMessage,
  encodeForWire,
} from '../protocol/chunking.js';
import {
  NATIVE_INBOUND_MAX_BYTES,
  NATIVE_MESSAGE_MAX_BYTES,
  PROTOCOL_VERSION,
} from '../protocol/constants.js';
import {
  type ExtensionToHostMessage,
  HostToExtensionMessage,
  isChunk,
  type ToolsCallMessage,
} from '../protocol/native.js';
import type { ToolDescriptor, ToolResult } from '../protocol/tools.js';

export const TEST_EXTENSION_ID = 'aaaabbbbccccddddeeeeffffgggghhhh';
export const TEST_ORIGIN = `chrome-extension://${TEST_EXTENSION_ID}/`;

export type ToolHandler = (
  args: Record<string, unknown>,
  call: ToolsCallMessage,
) =>
  | ToolResult
  | { error: { code: string; message: string } }
  | Promise<ToolResult | { error: { code: string; message: string } }>
  /** Never answer. */
  | 'hang';

export interface FakeExtensionOptions {
  readonly profileId?: string;
  readonly profileLabel?: string;
  readonly browser?: string;
  readonly extensionId?: string;
  readonly focused?: boolean;
  readonly tools?: ToolDescriptor[];
  readonly handlers?: Record<string, ToolHandler>;
}

/**
 * The extension's end of native messaging, for tests: speaks the protocol over a stream pair
 * (the host's stdin/stdout), answering `tools.call` from `handlers`.
 */
export class FakeExtension {
  readonly received: HostToExtensionMessage[] = [];
  /** Raw frames (before reassembly), to check chunk sizes. */
  readonly rawFrames: unknown[] = [];
  private readonly channel: JsonChannel;
  private readonly assembler = new ChunkAssembler();
  private readonly waiters: {
    match: (m: HostToExtensionMessage) => boolean;
    resolve: (m: HostToExtensionMessage) => void;
  }[] = [];
  ended = false;

  constructor(
    toHost: Writable,
    fromHost: Readable,
    readonly options: FakeExtensionOptions = {},
  ) {
    this.channel = new JsonChannel(
      fromHost,
      toHost,
      {
        onMessage: (value) => this.onValue(value),
        onError: (error) => {
          throw error;
        },
        onEnd: () => {
          this.ended = true;
        },
      },
      {
        // The browser's view: it accepts ≤ 1 MiB from the host.
        maxInboundBytes: NATIVE_MESSAGE_MAX_BYTES,
        maxOutboundBytes: NATIVE_INBOUND_MAX_BYTES,
      },
    );
  }

  send(message: ExtensionToHostMessage | Record<string, unknown>): void {
    for (const part of encodeForWire(message)) this.channel.send(part);
  }

  hello(): void {
    this.send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      extension: {
        id: this.options.extensionId ?? TEST_EXTENSION_ID,
        version: '1.2.3',
      },
      browser: { name: this.options.browser ?? 'Chrome', version: '150' },
      profile: {
        id: this.options.profileId ?? 'profile-a',
        ...(this.options.profileLabel
          ? { label: this.options.profileLabel }
          : {}),
      },
      ...(this.options.focused ? { focused: true } : {}),
    });
  }

  sendTools(tools: ToolDescriptor[] = this.options.tools ?? []): void {
    this.send({ type: 'tools.list', tools });
  }

  waitFor(
    match: (m: HostToExtensionMessage) => boolean,
  ): Promise<HostToExtensionMessage> {
    const found = this.received.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  private onValue(value: unknown): void {
    this.rawFrames.push(value);
    let message: unknown = value;
    if (isChunk(value)) {
      const done = this.assembler.push(ChunkMessage.parse(value));
      if (!done.done) return;
      message = done.message;
    }
    const parsed = HostToExtensionMessage.parse(message);
    this.received.push(parsed);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(parsed)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(parsed);
      }
    }
    if (parsed.type === 'tools.call') void this.answer(parsed);
    if (parsed.type === 'ping') this.send({ type: 'pong', id: parsed.id });
  }

  private async answer(call: ToolsCallMessage): Promise<void> {
    const handler = this.options.handlers?.[call.name];
    if (!handler) {
      this.send({
        type: 'tools.result',
        id: call.id,
        error: { code: 'unknown_tool', message: `no tool ${call.name}` },
      });
      return;
    }
    const outcome = await handler(call.arguments, call);
    if (outcome === 'hang') return;
    if ('error' in outcome && outcome.error) {
      this.send({ type: 'tools.result', id: call.id, error: outcome.error });
    } else {
      this.send({
        type: 'tools.result',
        id: call.id,
        result: outcome as ToolResult,
      });
    }
  }

  close(): void {
    this.channel.detach();
  }
}

export const SAMPLE_TOOLS: ToolDescriptor[] = [
  {
    name: 'list_spaces',
    title: 'List Spaces',
    description: 'List the Spaces.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_page_text',
    description: 'Read page text.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'integer' } },
      required: ['tabId'],
    },
    annotations: { readOnlyHint: true, untrustedOutput: true },
  },
];

/** A short temp directory (Unix socket paths are capped near 104 bytes). */
export function shortTempDir(prefix = 'bsmcp-'): string {
  const base = tmpdir().length <= 60 ? tmpdir() : '/tmp';
  return mkdtempSync(path.join(base, prefix));
}

export function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting'));
      } else setTimeout(tick, 10);
    };
    tick();
  });
}
