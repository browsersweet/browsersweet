import { z } from 'zod';
import {
  CHUNK_DATA_MAX_CHARS,
  CHUNK_SET_TTL_MS,
  CHUNK_THRESHOLD_BYTES,
  MAX_ASSEMBLED_CHARS,
  MAX_CHUNKS,
  MAX_PENDING_CHUNK_SETS,
} from './constants.js';
import { utf8Length } from './common.js';

/**
 * One slice of a large message's JSON text. Concatenating `data` for `seq` 0..total-1 gives the
 * original message's JSON. Applies in both directions on the native messaging link.
 */
export const ChunkMessage = z.object({
  type: z.literal('chunk'),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  seq: z
    .int()
    .min(0)
    .max(MAX_CHUNKS - 1),
  total: z.int().min(2).max(MAX_CHUNKS),
  data: z.string().max(CHUNK_DATA_MAX_CHARS),
});
export type ChunkMessage = z.infer<typeof ChunkMessage>;

export class ChunkError extends Error {
  constructor(
    readonly code: 'too_large' | 'invalid_message',
    message: string,
  ) {
    super(message);
    this.name = 'ChunkError';
  }
}

export interface EncodeOptions {
  /** Chunk when the JSON is larger than this many UTF-8 bytes. */
  readonly thresholdBytes?: number;
  /** Code units per chunk. */
  readonly chunkChars?: number;
  /** Chunk-set id; random by default. */
  readonly id?: string;
}

function randomChunkId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Messages to send for `message`: `[message]` when it's small, otherwise `chunk` messages.
 * Slices never split a surrogate pair, so each chunk is valid UTF-16 and survives the browser's
 * JSON serialization.
 */
export function encodeForWire<T extends object>(
  message: T,
  options: EncodeOptions = {},
): (T | ChunkMessage)[] {
  const threshold = options.thresholdBytes ?? CHUNK_THRESHOLD_BYTES;
  const chunkChars = Math.min(
    options.chunkChars ?? CHUNK_DATA_MAX_CHARS,
    CHUNK_DATA_MAX_CHARS,
  );
  const json = JSON.stringify(message);
  if (utf8Length(json) <= threshold) return [message];
  if (json.length > MAX_ASSEMBLED_CHARS) {
    throw new ChunkError(
      'too_large',
      `message is ${json.length} chars; the limit is ${MAX_ASSEMBLED_CHARS}`,
    );
  }
  const slices: string[] = [];
  let start = 0;
  while (start < json.length) {
    let end = Math.min(start + chunkChars, json.length);
    if (end < json.length && isHighSurrogate(json.charCodeAt(end - 1))) end--;
    slices.push(json.slice(start, end));
    start = end;
  }
  if (slices.length > MAX_CHUNKS) {
    throw new ChunkError('too_large', `message needs ${slices.length} chunks`);
  }
  const id = options.id ?? randomChunkId();
  return slices.map((data, seq) => ({
    type: 'chunk' as const,
    id,
    seq,
    total: slices.length,
    data,
  }));
}

interface PendingSet {
  readonly total: number;
  readonly parts: (string | undefined)[];
  received: number;
  chars: number;
  readonly startedAt: number;
}

export interface AssemblerLimits {
  readonly maxChars?: number;
  readonly maxPending?: number;
  readonly ttlMs?: number;
}

/**
 * Reassembles `chunk` messages. `push` returns the parsed (unvalidated) message once a set is
 * complete; callers validate it like any other message. Throws `ChunkError` on a broken set and
 * drops that set.
 */
export class ChunkAssembler {
  private readonly sets = new Map<string, PendingSet>();
  private readonly maxChars: number;
  private readonly maxPending: number;
  private readonly ttlMs: number;

  constructor(limits: AssemblerLimits = {}) {
    this.maxChars = limits.maxChars ?? MAX_ASSEMBLED_CHARS;
    this.maxPending = limits.maxPending ?? MAX_PENDING_CHUNK_SETS;
    this.ttlMs = limits.ttlMs ?? CHUNK_SET_TTL_MS;
  }

  get pending(): number {
    return this.sets.size;
  }

  /** Drop sets older than the TTL. */
  sweep(now = Date.now()): void {
    for (const [id, set] of this.sets) {
      if (now - set.startedAt > this.ttlMs) this.sets.delete(id);
    }
  }

  push(
    chunk: ChunkMessage,
    now = Date.now(),
  ): { done: true; message: unknown } | { done: false } {
    this.sweep(now);
    let set = this.sets.get(chunk.id);
    if (!set) {
      if (this.sets.size >= this.maxPending) {
        throw new ChunkError('too_large', 'too many incomplete chunk sets');
      }
      set = {
        total: chunk.total,
        parts: new Array<string | undefined>(chunk.total),
        received: 0,
        chars: 0,
        startedAt: now,
      };
      this.sets.set(chunk.id, set);
    }
    const fail = (code: ChunkError['code'], message: string): never => {
      this.sets.delete(chunk.id);
      throw new ChunkError(code, message);
    };
    if (chunk.total !== set.total) {
      fail('invalid_message', `chunk ${chunk.id}: total changed`);
    }
    if (chunk.seq >= set.total) {
      fail('invalid_message', `chunk ${chunk.id}: seq out of range`);
    }
    if (set.parts[chunk.seq] !== undefined) {
      fail('invalid_message', `chunk ${chunk.id}: duplicate seq ${chunk.seq}`);
    }
    set.chars += chunk.data.length;
    if (set.chars > this.maxChars) {
      fail('too_large', `chunk ${chunk.id}: message exceeds ${this.maxChars}`);
    }
    set.parts[chunk.seq] = chunk.data;
    set.received++;
    if (set.received < set.total) return { done: false };
    this.sets.delete(chunk.id);
    try {
      return { done: true, message: JSON.parse(set.parts.join('')) };
    } catch {
      throw new ChunkError(
        'invalid_message',
        `chunk ${chunk.id}: reassembled text is not JSON`,
      );
    }
  }
}
