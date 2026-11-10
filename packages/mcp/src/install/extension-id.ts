import { createHash } from 'node:crypto';
import { CHROMIUM_ID, GECKO_ID } from '../host/caller.js';

export type IdKind = 'chromium' | 'firefox';

/** Chromium ids are 32 letters a–p; anything shaped like `name@domain` or `{uuid}` is Firefox's. */
export function classifyExtensionId(id: string): IdKind | undefined {
  if (CHROMIUM_ID.test(id)) return 'chromium';
  if (GECKO_ID.test(id)) return 'firefox';
  return undefined;
}

/**
 * The Chromium extension id for a manifest `key` (base64 DER SubjectPublicKeyInfo): the first
 * 128 bits of its SHA-256, each hex digit mapped 0–f → a–p. A dev build that sets `key` gets
 * this id on every machine.
 */
export function extensionIdFromKey(base64Key: string): string {
  const der = Buffer.from(base64Key.replace(/\s+/g, ''), 'base64');
  if (der.length < 32) throw new Error('that is not a base64 public key');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
    .join('');
}
