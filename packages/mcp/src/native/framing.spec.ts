import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonChannel } from './channel.js';
import {
  FrameDecoder,
  FrameError,
  encodeFrame,
  encodeJsonFrame,
  parseJsonFrame,
} from './framing.js';

describe('native messaging framing', () => {
  it('prefixes a 4-byte little-endian length', () => {
    const frame = encodeFrame('{"a":1}', 1024);
    expect(frame.readUInt32LE(0)).toBe(7);
    expect([...frame.subarray(0, 4)]).toEqual([7, 0, 0, 0]);
    expect(frame.subarray(4).toString()).toBe('{"a":1}');
  });

  it('counts UTF-8 bytes, not characters', () => {
    const frame = encodeJsonFrame({ t: 'é🙂' }, 1024);
    const body = Buffer.from(JSON.stringify({ t: 'é🙂' }), 'utf8');
    expect(frame.readUInt32LE(0)).toBe(body.length);
  });

  it('enforces the outbound cap (1 MiB for host → extension)', () => {
    const max = 1024 * 1024;
    expect(() => encodeFrame('x'.repeat(max), max)).not.toThrow();
    expect(() => encodeFrame('x'.repeat(max + 1), max)).toThrow(FrameError);
  });

  it('decodes frames split at every byte boundary', () => {
    const messages = [{ a: 1 }, { b: 'two' }, { c: [3, 'ü'] }];
    const stream = Buffer.concat(messages.map((m) => encodeJsonFrame(m, 1e6)));
    for (let split = 1; split < stream.length; split++) {
      const decoder = new FrameDecoder(1e6);
      const frames = [
        ...decoder.push(stream.subarray(0, split)),
        ...decoder.push(stream.subarray(split)),
      ];
      expect(frames.map(parseJsonFrame)).toEqual(messages);
      expect(decoder.pendingBytes).toBe(0);
    }
  });

  it('decodes byte-by-byte delivery and several frames per chunk', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({ i }));
    const stream = Buffer.concat(messages.map((m) => encodeJsonFrame(m, 1e6)));
    const decoder = new FrameDecoder(1e6);
    const frames: Buffer[] = [];
    for (const byte of stream)
      frames.push(...decoder.push(Buffer.from([byte])));
    expect(frames.map(parseJsonFrame)).toEqual(messages);
    expect(new FrameDecoder(1e6).push(stream).map(parseJsonFrame)).toEqual(
      messages,
    );
  });

  it('rejects oversized and empty frames before buffering the body', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(2048, 0);
    const decoder = new FrameDecoder(1024);
    expect(() => decoder.push(header)).toThrow(/limit is 1024/);
    // Poisoned afterwards.
    expect(() => decoder.push(Buffer.from('x'))).toThrow(FrameError);
    expect(() => new FrameDecoder(10).push(Buffer.alloc(4))).toThrow(
      /zero-length/,
    );
  });

  it('JsonChannel reports invalid JSON and stops', () => {
    const input = new PassThrough();
    const seen: unknown[] = [];
    const errors: Error[] = [];
    new JsonChannel(
      input,
      new PassThrough(),
      {
        onMessage: (v) => seen.push(v),
        onError: (e) => errors.push(e),
        onEnd: () => undefined,
      },
      { maxInboundBytes: 1024, maxOutboundBytes: 1024 },
    );
    input.write(encodeJsonFrame({ ok: true }, 1024));
    input.write(encodeFrame('{nope', 1024));
    input.write(encodeJsonFrame({ after: true }, 1024));
    expect(seen).toEqual([{ ok: true }]);
    expect(errors[0]?.message).toMatch(/not valid JSON/);
  });
});
