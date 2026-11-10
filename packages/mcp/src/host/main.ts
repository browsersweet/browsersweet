import { existsSync } from 'node:fs';
import { bridgeConfigPath, defaultPathEnv, primaryRunDir } from '../paths.js';
import { packageVersion } from '../version.js';
import {
  type BridgeConfig,
  parseCallerArgs,
  readBridgeConfig,
  verifyCaller,
} from './caller.js';
import { ensurePrivateDir } from './fs-security.js';
import { BridgeHost, type Logger } from './host.js';
import { currentUserSid, pipePrefix } from './windows.js';

/** Host logs go to stderr (Chrome shows them with --enable-logging). stdout is the protocol. */
export function stderrLogger(prefix: string): Logger {
  const debug = Boolean(process.env['BROWSERSWEET_MCP_DEBUG']);
  return (level, message) => {
    if (level === 'debug' && !debug) return;
    process.stderr.write(`[${prefix}] ${level}: ${message}\n`);
  };
}

export interface HostArgs {
  readonly configPath?: string;
  /** What the browser appended: the caller origin, `--parent-window=…`, Firefox's args. */
  readonly browserArgs: string[];
}

/** `host [--config <file>] [--] <browser args…>` */
export function parseHostArgs(args: readonly string[]): HostArgs {
  const browserArgs: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--') {
      browserArgs.push(...args.slice(i + 1));
      break;
    }
    if (arg === '--config') {
      configPath = args[++i];
      continue;
    }
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
      continue;
    }
    browserArgs.push(arg);
  }
  return { ...(configPath ? { configPath } : {}), browserArgs };
}

/**
 * Host mode entry. Started by the browser through the launcher `install` wrote. Returns the exit
 * code once the extension disconnects.
 */
export async function runHost(args: readonly string[]): Promise<number> {
  const log = stderrLogger('browsersweet-mcp host');
  const pe = defaultPathEnv();
  const { configPath = bridgeConfigPath(pe), browserArgs } =
    parseHostArgs(args);

  let config: BridgeConfig;
  try {
    config = readBridgeConfig(configPath);
  } catch (error) {
    log(
      'error',
      `can't read ${configPath} (${(error as Error).message}). Run \`npx @browsersweet/mcp install --extension-id <id>\`.`,
    );
    return 1;
  }
  const caller = parseCallerArgs(browserArgs);
  const check = verifyCaller(caller, config);
  if (!check.ok || !caller) {
    log('error', `refusing to start: ${check.ok ? 'no caller' : check.reason}`);
    return 1;
  }

  const runDir = primaryRunDir(pe, existsSync);
  if (!runDir) {
    log('error', 'no usable socket directory');
    return 1;
  }
  try {
    ensurePrivateDir(runDir, pe.platform);
  } catch (error) {
    log('error', (error as Error).message);
    return 1;
  }

  const host = new BridgeHost({
    input: process.stdin,
    output: process.stdout,
    caller,
    runDir,
    platform: pe.platform,
    ...(pe.platform === 'win32'
      ? { pipePrefix: pipePrefix(currentUserSid()) }
      : {}),
    version: packageVersion(),
    log,
  });
  process.on('exit', () => host.cleanupSync());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => void host.close(signal));
  }
  await host.closed;
  return 0;
}
