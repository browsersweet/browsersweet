/**
 * Native messaging framing: each message is a 4-byte unsigned length in native byte order
 * (little-endian on every platform browsers ship on) followed by that many bytes of UTF-8 JSON.
 * The socket between host and client uses the same framing.
 */

export const FRAME_HEADER_BYTES = 4;

export class FrameError extends Error {
  constructor(
    readonly code: 'frame_too_large' | 'empty_frame' | 'invalid_json',
    message: string,
  ) {
    super(message);
    this.name = 'FrameError';
  }
}

/** Encode one frame. Throws if the payload is larger than `maxBytes`. */
export function encodeFrame(
  payload: string | Buffer,
  maxBytes: number,
): Buffer {
  const body =
    typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > maxBytes) {
    throw new FrameError(
      'frame_too_large',
      `frame is ${body.length} bytes; the limit is ${maxBytes}`,
    );
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

/** Encode a value as a JSON frame. */
export function encodeJsonFrame(value: unknown, maxBytes: number): Buffer {
  return encodeFrame(JSON.stringify(value), maxBytes);
}

/**
 * Incremental decoder. Feed it whatever the stream hands you (partial headers, partial bodies,
 * several frames at once); it returns complete frame bodies. After an error it is poisoned and
 * the connection should be closed, since the stream position is lost.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private expected: number | undefined;
  private failed: FrameError | undefined;

  constructor(private readonly maxFrameBytes: number) {}

  /** Bytes held while waiting for the rest of a frame. */
  get pendingBytes(): number {
    return this.buffered;
  }

  push(data: Buffer): Buffer[] {
    if (this.failed) throw this.failed;
    if (data.length > 0) {
      this.chunks.push(data);
      this.buffered += data.length;
    }
    const frames: Buffer[] = [];
    for (;;) {
      if (this.expected === undefined) {
        if (this.buffered < FRAME_HEADER_BYTES) break;
        const length = this.take(FRAME_HEADER_BYTES).readUInt32LE(0);
        if (length === 0) {
          this.failed = new FrameError('empty_frame', 'zero-length frame');
          throw this.failed;
        }
        if (length > this.maxFrameBytes) {
          this.failed = new FrameError(
            'frame_too_large',
            `frame is ${length} bytes; the limit is ${this.maxFrameBytes}`,
          );
          throw this.failed;
        }
        this.expected = length;
      }
      if (this.buffered < this.expected) break;
      frames.push(this.take(this.expected));
      this.expected = undefined;
    }
    return frames;
  }

  private take(n: number): Buffer {
    const first = this.chunks[0];
    if (first && first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      if (!chunk) throw new Error('FrameDecoder: buffer underflow');
      const count = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, count);
      offset += count;
      if (count === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }
    this.buffered -= n;
    return out;
  }
}

/** Parse a frame body as JSON. */
export function parseJsonFrame(frame: Buffer): unknown {
  try {
    return JSON.parse(frame.toString('utf8'));
  } catch {
    throw new FrameError('invalid_json', 'frame is not valid JSON');
  }
}
