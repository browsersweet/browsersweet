import type { ToolArguments } from '../protocol/common.js';
import type { HostState } from '../protocol/socket.js';
import { isProcessAlive, readRecords } from '../host/records.js';
import { HostConnection, type ToolCallOutcome } from './connection.js';

/** A connected browser profile, as the MCP server sees it. */
export interface HostHandle {
  /** Stable while connected (the record file). */
  readonly key: string;
  readonly state: HostState;
  call(
    name: string,
    args: ToolArguments,
    timeoutMs?: number,
  ): Promise<ToolCallOutcome>;
}

export interface HostSource {
  /** Connected hosts (rescanning first). One per profile. */
  list(): Promise<readonly HostHandle[]>;
  /** Called when hosts come or go, or a host's state (tools, focus) changes. */
  onChange(listener: () => void): () => void;
  close(): void;
}

export interface DiscoveryPoolOptions {
  /** Socket directories to scan (`runDirCandidates`). */
  readonly dirs: () => readonly string[];
  readonly clientVersion: string;
  readonly isAlive?: (pid: number) => boolean;
  readonly connectTimeoutMs?: number;
  /** Don't retry a record that failed to connect for this long. */
  readonly retryAfterMs?: number;
  readonly log?: (message: string) => void;
}

/** Finds running hosts through their discovery records and keeps a connection to each. */
export class DiscoveryPool implements HostSource {
  private readonly connections = new Map<string, HostConnection>();
  private readonly failed = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private refreshing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: DiscoveryPoolOptions) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rescan every `intervalMs` so new browsers show up without a call. */
  startPolling(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  async list(): Promise<readonly HostHandle[]> {
    await this.refresh();
    return this.handles();
  }

  /** Live connections, newest host per profile. */
  handles(): HostHandle[] {
    const byProfile = new Map<string, HostConnection>();
    for (const connection of this.connections.values()) {
      if (connection.closed) continue;
      const id = connection.state.profile.id;
      const existing = byProfile.get(id);
      if (!existing || existing.state.startedAt < connection.state.startedAt) {
        byProfile.set(id, connection);
      }
    }
    return [...byProfile.entries()].map(([, connection]) => ({
      key: connectionKey(connection),
      get state() {
        return connection.state;
      },
      call: (name, args, timeoutMs) => connection.call(name, args, timeoutMs),
    }));
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.refreshing ??= this.scan().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }

  private async scan(): Promise<void> {
    const alive = this.options.isAlive ?? isProcessAlive;
    const now = Date.now();
    const seen = new Set<string>();
    const attempts: Promise<void>[] = [];
    for (const dir of this.options.dirs()) {
      for (const { file, record } of readRecords(dir)) {
        seen.add(file);
        if (this.connections.has(file)) continue;
        if (!alive(record.pid)) continue;
        const failedAt = this.failed.get(file);
        if (
          failedAt !== undefined &&
          now - failedAt < (this.options.retryAfterMs ?? 5_000)
        ) {
          continue;
        }
        attempts.push(
          HostConnection.connect(record, {
            clientVersion: this.options.clientVersion,
            ...(this.options.connectTimeoutMs
              ? { timeoutMs: this.options.connectTimeoutMs }
              : {}),
          }).then(
            (connection) => {
              if (this.closed) {
                connection.close();
                return;
              }
              this.failed.delete(file);
              this.connections.set(file, connection);
              connection.on('state', () => this.changed());
              connection.on('close', () => {
                if (this.connections.get(file) === connection) {
                  this.connections.delete(file);
                  this.changed();
                }
              });
              this.changed();
            },
            (error: Error) => {
              this.failed.set(file, Date.now());
              this.options.log?.(
                `can't connect to ${record.endpoint}: ${error.message}`,
              );
            },
          ),
        );
      }
    }
    // Records that vanished: the host is shutting down.
    for (const [file, connection] of this.connections) {
      if (!seen.has(file)) {
        this.connections.delete(file);
        connection.close();
        this.changed();
      }
    }
    for (const file of this.failed.keys()) {
      if (!seen.has(file)) this.failed.delete(file);
    }
    await Promise.all(attempts);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

function connectionKey(connection: HostConnection): string {
  return `${connection.record.endpoint}`;
}
