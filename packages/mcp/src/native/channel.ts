import type { Readable, Writable } from 'node:stream';
import {
  FrameDecoder,
  FrameError,
  encodeJsonFrame,
  parseJsonFrame,
} from './framing.js';

export interface JsonChannelHandlers {
  /** One decoded JSON value per frame (not yet validated). */
  readonly onMessage: (value: unknown) => void;
  /** Framing or JSON error. The channel stops reading; close the connection. */
  readonly onError: (error: Error) => void;
  /** The readable side ended or closed. */
  readonly onEnd: () => void;
}

export interface JsonChannelOptions {
  readonly maxInboundBytes: number;
  readonly maxOutboundBytes: number;
}

/** Length-prefixed JSON over a readable/writable pair (stdio or a socket). */
export class JsonChannel {
  private readonly decoder: FrameDecoder;
  private ended = false;
  private readonly onData = (data: Buffer): void => {
    if (this.ended) return;
    let frames: Buffer[];
    try {
      frames = this.decoder.push(data);
    } catch (error) {
      this.fail(error as Error);
      return;
    }
    for (const frame of frames) {
      let value: unknown;
      try {
        value = parseJsonFrame(frame);
      } catch (error) {
        this.fail(error as FrameError);
        return;
      }
      this.handlers.onMessage(value);
      if (this.ended) return;
    }
  };
  private readonly onClose = (): void => this.end();

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: JsonChannelHandlers,
    private readonly options: JsonChannelOptions,
  ) {
    this.decoder = new FrameDecoder(options.maxInboundBytes);
    input.on('data', this.onData);
    input.on('end', this.onClose);
    input.on('close', this.onClose);
    input.on('error', this.onClose);
  }

  /** Send one value. Throws `FrameError` if it's over the outbound limit. */
  send(value: unknown): void {
    if (this.ended) return;
    this.output.write(encodeJsonFrame(value, this.options.maxOutboundBytes));
  }

  get closed(): boolean {
    return this.ended;
  }

  /** Stop reading. Doesn't close the underlying streams. */
  detach(): void {
    this.ended = true;
    this.input.off('data', this.onData);
    this.input.off('end', this.onClose);
    this.input.off('close', this.onClose);
    this.input.off('error', this.onClose);
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.detach();
    this.handlers.onError(error);
  }

  private end(): void {
    if (this.ended) return;
    this.detach();
    this.handlers.onEnd();
  }
}
