import { describe, expect, it } from 'vitest';
import { parseHostArgs } from './main.js';
import { BridgeConfig, parseCallerArgs, verifyCaller } from './caller.js';

const ID = 'aaaabbbbccccddddeeeeffffgggghhhh';
const config = BridgeConfig.parse({
  v: 1,
  allowedOrigins: [`chrome-extension://${ID}/`],
  allowedFirefoxExtensions: ['bridge@browsersweet.com'],
});

describe('caller origin', () => {
  it('reads the Chromium origin, ignoring --parent-window', () => {
    expect(
      parseCallerArgs([`chrome-extension://${ID}/`, '--parent-window=6600']),
    ).toEqual({
      kind: 'chromium',
      origin: `chrome-extension://${ID}/`,
      extensionId: ID,
    });
  });

  it("reads Firefox's manifest path + extension id", () => {
    expect(
      parseCallerArgs([
        '/Users/me/Library/Application Support/Mozilla/NativeMessagingHosts/com.browsersweet.bridge.json',
        'bridge@browsersweet.com',
      ]),
    ).toMatchObject({
      kind: 'firefox',
      extensionId: 'bridge@browsersweet.com',
    });
  });

  it('allows only configured callers', () => {
    expect(
      verifyCaller(parseCallerArgs([`chrome-extension://${ID}/`]), config),
    ).toEqual({
      ok: true,
    });
    const other = 'ppppoooonnnnmmmmllllkkkkjjjjiiii';
    expect(
      verifyCaller(parseCallerArgs([`chrome-extension://${other}/`]), config),
    ).toMatchObject({ ok: false });
    expect(
      verifyCaller(parseCallerArgs(['/x.json', 'evil@example.com']), config),
    ).toMatchObject({ ok: false });
    expect(verifyCaller(parseCallerArgs([]), config)).toMatchObject({
      ok: false,
    });
  });

  it('rejects look-alike origins', () => {
    for (const arg of [
      `chrome-extension://${ID}`,
      `chrome-extension://${ID}/x`,
      `chrome-extension://${ID.toUpperCase()}/`,
      `https://${ID}/`,
      `chrome-extension://${ID}q/`,
    ]) {
      const caller = parseCallerArgs([arg]);
      expect(caller?.kind === 'chromium').toBe(false);
    }
  });

  it('parses host args around the browser args', () => {
    expect(
      parseHostArgs([
        '--config',
        '/c.json',
        '--',
        `chrome-extension://${ID}/`,
        '--parent-window=1',
      ]),
    ).toEqual({
      configPath: '/c.json',
      browserArgs: [`chrome-extension://${ID}/`, '--parent-window=1'],
    });
    expect(parseHostArgs([`chrome-extension://${ID}/`])).toEqual({
      browserArgs: [`chrome-extension://${ID}/`],
    });
  });

  it('rejects bad ids in the config', () => {
    expect(
      BridgeConfig.safeParse({
        v: 1,
        allowedOrigins: ['https://evil.example/'],
      }).success,
    ).toBe(false);
  });
});
