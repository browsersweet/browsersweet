import { z } from 'zod';
import { MAX_CALL_TIMEOUT_MS } from './constants.js';
import { BridgeError, MessageId, ProtocolVersion } from './common.js';
import {
  BrowserInfo,
  ErrorMessage,
  EventMessage,
  ExtensionInfo,
  PingMessage,
  PongMessage,
  ProfileInfo,
} from './native.js';
import {
  BoundedToolArguments,
  ToolDescriptorList,
  ToolName,
  ToolResult,
} from './tools.js';

/*
 * Messages on the local socket (host ↔ MCP client mode). Same 4-byte length-prefixed JSON
 * framing as native messaging, no chunking. Internal to this package, but documented in
 * PROTOCOL.md so other local tools can speak it.
 */

/** What a host knows about its browser profile. */
export const HostState = z.object({
  pid: z.int(),
  /** Epoch ms. */
  startedAt: z.number(),
  hostVersion: z.string().max(64),
  protocolVersion: ProtocolVersion,
  extension: ExtensionInfo,
  browser: BrowserInfo,
  profile: ProfileInfo,
  /** Epoch ms of the last `profile.focused` (or a focused `hello`). */
  lastFocusedAt: z.number().optional(),
  tools: ToolDescriptorList,
});
export type HostState = z.infer<typeof HostState>;

/** The discovery record a host writes next to its socket (`<id>.json`, mode 0600). */
export const HostRecord = z.object({
  v: z.literal(1),
  pid: z.int(),
  startedAt: z.number(),
  /** Unix socket path or Windows named pipe path. */
  endpoint: z.string().min(1).max(1024),
  /** 64 hex chars. Clients present it in `client.hello`. */
  token: z.string().regex(/^[0-9a-f]{64}$/),
  browser: BrowserInfo,
  profile: ProfileInfo,
  extension: ExtensionInfo,
});
export type HostRecord = z.infer<typeof HostRecord>;

// Client → host

export const ClientHelloMessage = z.object({
  type: z.literal('client.hello'),
  protocolVersion: ProtocolVersion,
  minProtocolVersion: ProtocolVersion.optional(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  client: z.object({
    name: z.string().max(64),
    version: z.string().max(64),
  }),
});
export type ClientHelloMessage = z.infer<typeof ClientHelloMessage>;

export const ClientToolsCallMessage = z.object({
  type: z.literal('tools.call'),
  id: MessageId,
  name: ToolName,
  arguments: BoundedToolArguments,
  timeoutMs: z.int().min(1).max(MAX_CALL_TIMEOUT_MS).optional(),
});
export type ClientToolsCallMessage = z.infer<typeof ClientToolsCallMessage>;

export const ClientToHostMessage = z.discriminatedUnion('type', [
  ClientHelloMessage,
  ClientToolsCallMessage,
  PingMessage,
  PongMessage,
]);
export type ClientToHostMessage = z.infer<typeof ClientToHostMessage>;

// Host → client

export const HostHelloMessage = z.object({
  type: z.literal('host.hello'),
  protocolVersion: ProtocolVersion,
  state: HostState,
});

export const HostStateMessage = z.object({
  type: z.literal('host.state'),
  state: HostState,
});

export const SocketToolsResultMessage = z
  .object({
    type: z.literal('tools.result'),
    id: MessageId,
    result: ToolResult.optional(),
    error: BridgeError.optional(),
  })
  .refine((m) => (m.result === undefined) !== (m.error === undefined), {
    message: 'tools.result needs exactly one of result or error',
  });
export type SocketToolsResultMessage = z.infer<typeof SocketToolsResultMessage>;

export const HostToClientMessage = z.discriminatedUnion('type', [
  HostHelloMessage,
  HostStateMessage,
  SocketToolsResultMessage,
  EventMessage,
  PingMessage,
  PongMessage,
  ErrorMessage,
]);
export type HostToClientMessage = z.infer<typeof HostToClientMessage>;
