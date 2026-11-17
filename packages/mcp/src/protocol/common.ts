import { z } from 'zod';
import { MAX_PROTOCOL_INT } from './constants.js';

/** Correlation ids: short, printable, no whitespace. */
export const MessageId = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'invalid message id');

/** Profile ids are minted by the extension (a stable per-install id, e.g. its deviceId ULID). */
export const ProfileId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid profile id');

/** Chromium extension id (32 chars a–p) or a Firefox (gecko) id. */
export const ExtensionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.@{}-]+$/, 'invalid extension id');

export const ProtocolVersion = z.int().min(1).max(MAX_PROTOCOL_INT);

/**
 * Error codes. Unknown codes are allowed (receivers treat them like `internal`), so the
 * extension can add codes without a protocol bump.
 */
export const ERROR_CODES = [
  /** No tool with that name in this profile. */
  'unknown_tool',
  /** Arguments failed the tool's input schema. */
  'invalid_arguments',
  /** The tool needs a permission the user hasn't granted (e.g. site access for `get_page_text`). */
  'permission_required',
  /** The thing asked for (tab, Space, entry) doesn't exist. */
  'not_found',
  /** The call ran past its `timeoutMs`. */
  'timeout',
  /** The call was cancelled (`tools.cancel`, client gone). */
  'cancelled',
  /** Too many in-flight calls. */
  'busy',
  /** A payload broke a size limit. */
  'too_large',
  /** The browser/extension isn't connected, or the flag was turned off. */
  'unavailable',
  /** Message failed validation. */
  'invalid_message',
  /** Protocol versions don't overlap. */
  'protocol_unsupported',
  /** Socket client failed the token check. */
  'unauthorized',
  /** The user disconnected this MCP client in the extension (`clients.disconnect`). */
  'disconnected',
  'internal',
] as const;
export type KnownErrorCode = (typeof ERROR_CODES)[number];

export const BridgeError = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().max(4096),
});
export type BridgeError = z.infer<typeof BridgeError>;

/** Arguments are always a JSON object. */
export const ToolArguments = z.record(z.string(), z.unknown());
export type ToolArguments = z.infer<typeof ToolArguments>;

/** UTF-8 byte length of a string, without Node's Buffer. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** UTF-8 byte length of a value's JSON. */
export function jsonByteLength(value: unknown): number {
  return utf8Length(JSON.stringify(value) ?? '');
}
