import { describe, expect, it } from 'vitest';
import {
  ChunkAssembler,
  ChunkError,
  ChunkMessage,
  encodeForWire,
} from './chunking.js';
import { CHUNK_DATA_MAX_CHARS, NATIVE_MESSAGE_MAX_BYTES } from './constants.js';
import { utf8Length } from './common.js';

const big = (chars: number, unit = 'x') => ({
  type: 'tools.result',
  id: 'r1',
  result: { content: [{ type: 'text', text: unit.repeat(chars) }] },
});

function roundTrip(message: object): unknown {
  const parts = encodeForWire(message);
  const assembler = new ChunkAssembler();
  let out: unknown;
  for (const part of parts) {
    const done = assembler.push(ChunkMessage.parse(part));
    if (done.done) out = done.message;
  }
  return out;
}

describe('chunking', () => {
  it('leaves small messages alone', () => {
    const message = { type: 'ping', id: '1' };
    expect(encodeForWire(message)).toEqual([message]);
  });

  it('splits messages over ~900 KB and reassembles them', () => {
    const message = big(3_000_000);
    const parts = encodeForWire(message);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part).toMatchObject({ type: 'chunk', total: parts.length });
      // Every frame fits Chrome's 1 MiB host → extension cap.
      expect(utf8Length(JSON.stringify(part))).toBeLessThan(
        NATIVE_MESSAGE_MAX_BYTES,
      );
    }
    expect(roundTrip(message)).toEqual(message);
  });

  it('keeps worst-case text (3-byte chars, quotes) under the cap', () => {
    for (const unit of ['€', '"', '\\', '\u0001']) {
      const message = big(CHUNK_DATA_MAX_CHARS * 3, unit);
      const parts = encodeForWire(message);
      for (const part of parts) {
        expect(utf8Length(JSON.stringify(part))).toBeLessThan(
          NATIVE_MESSAGE_MAX_BYTES,
        );
      }
      expect(roundTrip(message)).toEqual(message);
    }
  });

  it('never splits a surrogate pair', () => {
    const message = big(20_000, '🙂');
    const parts = encodeForWire(message, {
      chunkChars: 1001,
      thresholdBytes: 1000,
    });
    expect(parts.length).toBeGreaterThan(10);
    for (const part of parts) {
      const data = (part as ChunkMessage).data;
      const last = data.charCodeAt(data.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    const assembler = new ChunkAssembler();
    const done = parts.map((p) => assembler.push(ChunkMessage.parse(p)));
    expect(done.at(-1)).toEqual({ done: true, message });
  });

  it('reassembles out of order', () => {
    const message = big(2_000_000);
    const parts = encodeForWire(message).reverse();
    const assembler = new ChunkAssembler();
    const results = parts.map((p) => assembler.push(ChunkMessage.parse(p)));
    expect(results.at(-1)).toEqual({ done: true, message });
    expect(assembler.pending).toBe(0);
  });

  it('rejects duplicates, inconsistent totals and oversized sets', () => {
    const a = new ChunkAssembler();
    const chunk = {
      type: 'chunk',
      id: 'c',
      seq: 0,
      total: 3,
      data: '{',
    } as const;
    a.push(chunk);
    expect(() => a.push(chunk)).toThrow(/duplicate/);
    const b = new ChunkAssembler();
    b.push(chunk);
    expect(() => b.push({ ...chunk, seq: 1, total: 4 })).toThrow(/total/);
    const c = new ChunkAssembler({ maxChars: 3 });
    expect(() => c.push({ ...chunk, data: 'abcd' })).toThrow(ChunkError);
  });

  it('caps pending sets and expires stale ones', () => {
    const a = new ChunkAssembler({ maxPending: 2, ttlMs: 1000 });
    const chunk = (id: string) =>
      ({ type: 'chunk', id, seq: 0, total: 2, data: '' }) as const;
    a.push(chunk('a'), 0);
    a.push(chunk('b'), 0);
    expect(() => a.push(chunk('c'), 10)).toThrow(/too many/);
    a.push(chunk('c'), 2000);
    expect(a.pending).toBe(1);
  });

  it('reports non-JSON reassembly', () => {
    const a = new ChunkAssembler();
    a.push({ type: 'chunk', id: 'x', seq: 0, total: 2, data: '{"a"' });
    expect(() =>
      a.push({ type: 'chunk', id: 'x', seq: 1, total: 2, data: ':' }),
    ).toThrow(/not JSON/);
  });

  it('validates chunk messages', () => {
    expect(
      ChunkMessage.safeParse({
        type: 'chunk',
        id: 'bad id',
        seq: 0,
        total: 2,
        data: '',
      }).success,
    ).toBe(false);
    expect(
      ChunkMessage.safeParse({
        type: 'chunk',
        id: 'a',
        seq: 0,
        total: 1,
        data: '',
      }).success,
    ).toBe(false);
  });
});
