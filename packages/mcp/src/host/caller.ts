import { readFileSync } from 'node:fs';
import { z } from 'zod';

/*
 * Who launched the host. Browsers pass the caller on argv:
 *   Chromium: `chrome-extension://<id>/` (+ `--parent-window=<hwnd>` on Windows)
 *   Firefox:  `<path to the host manifest> <extension id>`
 * The browser only launches hosts for ids in the manifest's allow-list; the host checks again
 * against the config `install` wrote (defense in depth: the argv itself isn't a secret).
 */

export const CHROMIUM_ID = /^[a-p]{32}$/;
export const CHROMIUM_ORIGIN = /^chrome-extension:\/\/([a-p]{32})\/$/;
/** `name@domain` or `{uuid}`. */
export const GECKO_ID =
  /^(\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}|[A-Za-z0-9._+-]*@[A-Za-z0-9._-]+)$/;

export type Caller =
  | {
      readonly kind: 'chromium';
      readonly origin: string;
      readonly extensionId: string;
    }
  | {
      readonly kind: 'firefox';
      readonly extensionId: string;
      readonly manifestPath?: string;
    };

/** Find the caller in the browser's argv. Ignores `--parent-window` and other flags. */
export function parseCallerArgs(args: readonly string[]): Caller | undefined {
  const positional = args.filter((arg) => !arg.startsWith('--'));
  for (const arg of positional) {
    const match = CHROMIUM_ORIGIN.exec(arg);
    if (match?.[1]) {
      return { kind: 'chromium', origin: arg, extensionId: match[1] };
    }
  }
  const last = positional[positional.length - 1];
  if (last && GECKO_ID.test(last)) {
    const manifestPath =
      positional.length >= 2 ? positional[positional.length - 2] : undefined;
    return {
      kind: 'firefox',
      extensionId: last,
      ...(manifestPath ? { manifestPath } : {}),
    };
  }
  return undefined;
}

export const BridgeConfig = z.object({
  v: z.literal(1),
  /** `chrome-extension://<id>/` origins. */
  allowedOrigins: z.array(z.string().regex(CHROMIUM_ORIGIN)).default([]),
  /** Firefox (gecko) extension ids. */
  allowedFirefoxExtensions: z.array(z.string().regex(GECKO_ID)).default([]),
});
export type BridgeConfig = z.infer<typeof BridgeConfig>;

export function readBridgeConfig(file: string): BridgeConfig {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return BridgeConfig.parse(raw);
}

export type CallerCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function verifyCaller(
  caller: Caller | undefined,
  config: BridgeConfig,
): CallerCheck {
  if (!caller) {
    return {
      ok: false,
      reason:
        'no caller origin on the command line (expected chrome-extension://<id>/ or a Firefox extension id)',
    };
  }
  if (caller.kind === 'chromium') {
    return config.allowedOrigins.includes(caller.origin)
      ? { ok: true }
      : { ok: false, reason: `origin ${caller.origin} is not allowed` };
  }
  return config.allowedFirefoxExtensions.includes(caller.extensionId)
    ? { ok: true }
    : {
        ok: false,
        reason: `Firefox extension ${caller.extensionId} is not allowed`,
      };
}
