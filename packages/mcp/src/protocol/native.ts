import { z } from 'zod';
import {
  MAX_CALL_TIMEOUT_MS,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from './constants.js';
import {
  BridgeError,
  ExtensionId,
  MessageId,
  ProfileId,
  ProtocolVersion,
} from './common.js';
import {
  BoundedToolArguments,
  ToolDescriptorList,
  ToolName,
  ToolResult,
} from './tools.js';

/*
 * Messages on the native messaging link (extension ↔ host). See PROTOCOL.md.
 */

export const PingMessage = z.object({ type: z.literal('ping'), id: MessageId });
export const PongMessage = z.object({ type: z.literal('pong'), id: MessageId });
export const ErrorMessage = z.object({
  type: z.literal('error'),
  error: BridgeError,
});

/** Event names: dotted lowercase. `profile.focused` and `handoffs.changed` are defined in v1. */
export const EventName = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,63}$/, 'invalid event name');

export const EventMessage = z.object({
  type: z.literal('event'),
  event: EventName,
  data: z.unknown().optional(),
});
export type EventMessage = z.infer<typeof EventMessage>;

/** Known events. */
export const EVENTS = {
  /** A window of this profile gained focus. Drives the client's default profile. */
  profileFocused: 'profile.focused',
  /** The handoffs list changed (sent, revoked). */
  handoffsChanged: 'handoffs.changed',
} as const;

export const BrowserInfo = z.object({
  /** e.g. "Chrome", "Edge", "Brave", "Arc", "Firefox". */
  name: z.string().min(1).max(64),
  version: z.string().max(64).optional(),
});
export type BrowserInfo = z.infer<typeof BrowserInfo>;

export const ProfileInfo = z.object({
  id: ProfileId,
  /** User-facing name, e.g. "Work". Matched case-insensitively by the `profile` argument. */
  label: z.string().min(1).max(128).optional(),
});
export type ProfileInfo = z.infer<typeof ProfileInfo>;

export const ExtensionInfo = z.object({
  id: ExtensionId,
  version: z.string().max(64),
});
export type ExtensionInfo = z.infer<typeof ExtensionInfo>;

// ---------------------------------------------------------------------------------------------
// Extension → host

/** First message on the port. Nothing else is accepted before it. */
export const HelloMessage = z.object({
  type: z.literal('hello'),
  /** The highest protocol version the extension speaks. */
  protocolVersion: ProtocolVersion,
  /** The lowest it accepts; defaults to `protocolVersion`. */
  minProtocolVersion: ProtocolVersion.optional(),
  extension: ExtensionInfo,
  browser: BrowserInfo,
  profile: ProfileInfo,
  /** A window of this profile has focus right now. */
  focused: z.boolean().optional(),
});
export type HelloMessage = z.infer<typeof HelloMessage>;

/** The extension's MCP tools (registry `mcpTools`). Sent after `hello.ack` and on every change. */
export const ToolsListMessage = z.object({
  type: z.literal('tools.list'),
  tools: ToolDescriptorList,
});
export type ToolsListMessage = z.infer<typeof ToolsListMessage>;

/** Answer to `tools.call`, with the same `id`. Exactly one of `result` / `error`. */
export const ToolsResultMessage = z
  .object({
    type: z.literal('tools.result'),
    id: MessageId,
    result: ToolResult.optional(),
    error: BridgeError.optional(),
  })
  .refine((m) => (m.result === undefined) !== (m.error === undefined), {
    message: 'tools.result needs exactly one of result or error',
  });
export type ToolsResultMessage = z.infer<typeof ToolsResultMessage>;

export const ExtensionToHostMessage = z.discriminatedUnion('type', [
  HelloMessage,
  ToolsListMessage,
  ToolsResultMessage,
  EventMessage,
  PingMessage,
  PongMessage,
  ErrorMessage,
]);
export type ExtensionToHostMessage = z.infer<typeof ExtensionToHostMessage>;

// ---------------------------------------------------------------------------------------------
// Host → extension

export const HelloAckMessage = z.object({
  type: z.literal('hello.ack'),
  /** The negotiated version; both sides use it from here on. */
  protocolVersion: ProtocolVersion,
  host: z.object({
    version: z.string().max(64),
    platform: z.string().max(32),
  }),
});
export type HelloAckMessage = z.infer<typeof HelloAckMessage>;

export const ToolsCallMessage = z.object({
  type: z.literal('tools.call'),
  id: MessageId,
  name: ToolName,
  arguments: BoundedToolArguments,
  /** The host answers `timeout` after this; the extension should give up too. */
  timeoutMs: z.int().min(1).max(MAX_CALL_TIMEOUT_MS),
});
export type ToolsCallMessage = z.infer<typeof ToolsCallMessage>;

/** The caller no longer wants the answer (timeout, client gone). Best effort. */
export const ToolsCancelMessage = z.object({
  type: z.literal('tools.cancel'),
  id: MessageId,
});

/** How many MCP clients are connected, for the extension's status indicator. */
export const HostStatusMessage = z.object({
  type: z.literal('host.status'),
  clients: z.int().min(0),
});

export const HostToExtensionMessage = z.discriminatedUnion('type', [
  HelloAckMessage,
  ToolsCallMessage,
  ToolsCancelMessage,
  HostStatusMessage,
  PingMessage,
  PongMessage,
  ErrorMessage,
]);
export type HostToExtensionMessage = z.infer<typeof HostToExtensionMessage>;

// ---------------------------------------------------------------------------------------------

export type ParseResult<T> =
  | { readonly ok: true; readonly message: T }
  /** `unknownType` messages should be ignored (forward compatibility), not treated as errors. */
  | {
      readonly ok: false;
      readonly unknownType: boolean;
      readonly error: string;
    };

const KNOWN = new Set([
  'hello',
  'tools.list',
  'tools.result',
  'event',
  'ping',
  'pong',
  'error',
  'hello.ack',
  'tools.call',
  'tools.cancel',
  'host.status',
  'chunk',
  'client.hello',
  'host.hello',
  'host.state',
]);

/** Validate an incoming message against `schema`, distinguishing unknown types. */
export function parseMessage<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): ParseResult<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, message: parsed.data };
  const type =
    typeof raw === 'object' && raw !== null && 'type' in raw
      ? (raw as { type: unknown }).type
      : undefined;
  return {
    ok: false,
    unknownType: typeof type === 'string' && !KNOWN.has(type),
    error: z.prettifyError(parsed.error),
  };
}

/** Is this a `chunk` message? (Validate with `ChunkMessage` before assembling.) */
export function isChunk(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { type?: unknown }).type === 'chunk'
  );
}

/**
 * Pick the protocol version for a peer offering `[min, max]`, or `undefined` if the ranges
 * don't overlap.
 */
export function negotiateProtocol(
  peerMax: number,
  peerMin: number = peerMax,
  ownMax: number = PROTOCOL_VERSION,
  ownMin: number = MIN_PROTOCOL_VERSION,
): number | undefined {
  const chosen = Math.min(peerMax, ownMax);
  return chosen >= Math.max(peerMin, ownMin) ? chosen : undefined;
}
