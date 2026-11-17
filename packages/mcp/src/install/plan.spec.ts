import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { modeOf } from '../host/fs-security.js';
import type { SupportedPlatform } from '../paths.js';
import { shortTempDir } from '../test-support/fake-extension.js';
import { applyPlan, nodeApplyIo, type ApplyIo } from './apply.js';
import { extensionIdFromKey, classifyExtensionId } from './extension-id.js';
import { posixLauncher, shellQuote, windowsLauncher } from './launcher.js';
import { type BrowserKey, parseBrowserKey } from './browsers.js';
import { checkInstall, nodeDoctorDeps } from './doctor.js';
import {
  type Action,
  type InstallContext,
  installLayout,
  planInstall,
  planUninstall,
  UsageError,
} from './plan.js';
import { mcpConfigSnippets } from './snippets.js';

const CHROMIUM_ID = 'aaaabbbbccccddddeeeeffffgggghhhh';
const GECKO_ID = 'bridge@browsersweet.com';

function context(
  platform: SupportedPlatform,
  existing: string[] = [],
  overrides: Partial<InstallContext> = {},
): InstallContext {
  const home =
    platform === 'win32'
      ? 'C:\\Users\\me'
      : platform === 'darwin'
        ? '/Users/me'
        : '/home/me';
  const env: Record<string, string> =
    platform === 'win32'
      ? {
          LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
          APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        }
      : {};
  return {
    platform,
    homedir: home,
    env,
    tmpdir: '/tmp',
    uid: 501,
    exists: (p) => existing.includes(p),
    nodePath:
      platform === 'win32'
        ? 'C:\\Program Files\\nodejs\\node.exe'
        : '/usr/local/bin/node',
    packageRoot: platform === 'win32' ? 'C:\\npx\\mcp' : '/npx/mcp',
    version: '9.9.9',
    resolvePackageDir: (name) =>
      name === 'zod'
        ? platform === 'win32'
          ? 'C:\\npx\\zod'
          : '/npx/zod'
        : undefined,
    ...overrides,
  };
}

const writes = (actions: Action[]) =>
  Object.fromEntries(
    actions.flatMap((a) => (a.kind === 'write' ? [[a.path, a.content]] : [])),
  );

describe('install plan: macOS', () => {
  const support = '/Users/me/Library/Application Support';
  const ctx = context('darwin', [
    `${support}/Google/Chrome`,
    `${support}/Arc/User Data`,
    `${support}/Firefox`,
  ]);

  it('writes a manifest per detected Chromium browser pointing at the launcher', () => {
    const plan = planInstall(ctx, { extensionIds: [CHROMIUM_ID] });
    const files = writes(plan.actions);
    const launcher = `${support}/BrowserSweet/bridge/browsersweet-bridge`;
    const chrome = `${support}/Google/Chrome/NativeMessagingHosts/com.browsersweet.bridge.json`;
    const arc = `${support}/Arc/User Data/NativeMessagingHosts/com.browsersweet.bridge.json`;
    expect(JSON.parse(files[chrome] as string)).toEqual({
      name: 'com.browsersweet.bridge',
      description: 'Browser Sweet bridge for local MCP clients',
      path: launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${CHROMIUM_ID}/`],
    });
    expect(files[arc]).toBe(files[chrome]);
    expect(Object.keys(files).some((f) => f.includes('Edge'))).toBe(false);
    expect(plan.browsers.find((b) => b.key === 'firefox')).toMatchObject({
      status: 'skip',
    });
    expect(files[launcher]).toContain(
      `exec '/usr/local/bin/node' '${support}/BrowserSweet/bridge/runtime/dist/cli.js' host --config`,
    );
    expect(
      JSON.parse(files[`${support}/BrowserSweet/bridge/config.json`] as string),
    ).toEqual({
      v: 1,
      allowedOrigins: [`chrome-extension://${CHROMIUM_ID}/`],
      allowedFirefoxExtensions: [],
    });
  });

  it('copies the host runtime with zod, and sets modes', () => {
    const plan = planInstall(ctx, { extensionIds: [CHROMIUM_ID] });
    const runtime = `${support}/BrowserSweet/bridge/runtime`;
    expect(plan.actions).toContainEqual({
      kind: 'copy',
      from: '/npx/mcp/dist',
      to: `${runtime}/dist`,
    });
    expect(plan.actions).toContainEqual({
      kind: 'copy',
      from: '/npx/zod',
      to: `${runtime}/node_modules/zod`,
    });
    const modes = Object.fromEntries(
      plan.actions.flatMap((a) =>
        a.kind === 'write' ? [[path.basename(a.path), a.mode]] : [],
      ),
    );
    expect(modes['config.json']).toBe(0o600);
    expect(modes['browsersweet-bridge']).toBe(0o755);
  });

  it('uses allowed_extensions with the gecko id for Firefox', () => {
    const plan = planInstall(ctx, { extensionIds: [CHROMIUM_ID, GECKO_ID] });
    const firefox = writes(plan.actions)[
      `${support}/Mozilla/NativeMessagingHosts/com.browsersweet.bridge.json`
    ];
    expect(JSON.parse(firefox as string)).toMatchObject({
      name: 'com.browsersweet.bridge',
      type: 'stdio',
      allowed_extensions: [GECKO_ID],
    });
    expect(JSON.parse(firefox as string)).not.toHaveProperty('allowed_origins');
  });

  it('installs for an explicitly named browser even if not detected', () => {
    const plan = planInstall(ctx, {
      extensionIds: [CHROMIUM_ID],
      browsers: ['edge'],
    });
    expect(plan.browsers.map((b) => [b.key, b.status])).toEqual([
      ['edge', 'install'],
    ]);
  });

  it('requires an extension id, and a valid one', () => {
    expect(() => planInstall(ctx, { extensionIds: [] })).toThrow(UsageError);
    expect(() => planInstall(ctx, { extensionIds: ['nope'] })).toThrow(
      /not an extension id/,
    );
  });

  it('fails clearly when no browser is found', () => {
    expect(() =>
      planInstall(context('darwin'), { extensionIds: [CHROMIUM_ID] }),
    ).toThrow(/no supported browser/);
  });
});

describe('install plan: Linux', () => {
  it('uses ~/.config (or XDG_CONFIG_HOME) and ~/.mozilla', () => {
    const ctx = context(
      'linux',
      [
        '/home/me/.config/google-chrome',
        '/home/me/.mozilla',
        '/xdg/BraveSoftware/Brave-Browser',
      ],
      {
        env: {},
      },
    );
    const plan = planInstall(ctx, { extensionIds: [CHROMIUM_ID, GECKO_ID] });
    const files = writes(plan.actions);
    expect(
      files[
        '/home/me/.config/google-chrome/NativeMessagingHosts/com.browsersweet.bridge.json'
      ],
    ).toBeDefined();
    expect(
      files[
        '/home/me/.mozilla/native-messaging-hosts/com.browsersweet.bridge.json'
      ],
    ).toBeDefined();
    expect(
      files['/home/me/.local/share/browsersweet/bridge/browsersweet-bridge'],
    ).toBeDefined();

    const xdg = context('linux', ['/xdg/BraveSoftware/Brave-Browser'], {
      env: { XDG_CONFIG_HOME: '/xdg' },
    });
    expect(
      planInstall(xdg, { extensionIds: [CHROMIUM_ID] }).browsers.map(
        (b) => b.manifestPath,
      ),
    ).toEqual([
      '/xdg/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.browsersweet.bridge.json',
    ]);
  });

  it('has no Arc', () => {
    const plan = planInstall(context('linux', ['/home/me/.config/chromium']), {
      extensionIds: [CHROMIUM_ID],
      browsers: ['arc', 'chromium'],
    });
    expect(plan.browsers.find((b) => b.key === 'arc')).toMatchObject({
      status: 'skip',
    });
  });
});

describe('install plan: Windows', () => {
  const local = 'C:\\Users\\me\\AppData\\Local';
  const ctx = context('win32', [
    `${local}\\Google\\Chrome\\User Data`,
    `${local}\\Microsoft\\Edge\\User Data`,
    `${local}\\BraveSoftware\\Brave-Browser\\User Data`,
    'C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox',
  ]);

  it('writes one manifest per family and registry keys via reg.exe', () => {
    const plan = planInstall(ctx, { extensionIds: [CHROMIUM_ID, GECKO_ID] });
    const bridge = `${local}\\BrowserSweet\\bridge`;
    const chromiumManifest = `${bridge}\\manifests\\chromium\\com.browsersweet.bridge.json`;
    const firefoxManifest = `${bridge}\\manifests\\firefox\\com.browsersweet.bridge.json`;
    const files = writes(plan.actions);
    expect(JSON.parse(files[chromiumManifest] as string)).toMatchObject({
      path: `${bridge}\\browsersweet-bridge.cmd`,
      allowed_origins: [`chrome-extension://${CHROMIUM_ID}/`],
    });
    expect(JSON.parse(files[firefoxManifest] as string)).toMatchObject({
      allowed_extensions: [GECKO_ID],
    });
    const reg = plan.actions.filter((a) => a.kind === 'reg').map((a) => a.args);
    expect(reg).toEqual([
      [
        'add',
        'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.browsersweet.bridge',
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        chromiumManifest,
        '/f',
      ],
      [
        'add',
        'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.browsersweet.bridge',
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        chromiumManifest,
        '/f',
      ],
      [
        'add',
        'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.browsersweet.bridge',
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        chromiumManifest,
        '/f',
      ],
      [
        'add',
        'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.browsersweet.bridge',
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        firefoxManifest,
        '/f',
      ],
    ]);
    expect(files[`${bridge}\\browsersweet-bridge.cmd`]).toBe(
      [
        '@echo off',
        'rem Browser Sweet native messaging host launcher.',
        'rem Generated by `browsersweet-mcp install`; re-run install to update, `uninstall` to remove.',
        `"C:\\Program Files\\nodejs\\node.exe" "${bridge}\\runtime\\dist\\cli.js" host --config "${bridge}\\config.json" -- %*`,
        '',
      ].join('\r\n'),
    );
  });

  it('uninstall deletes the keys (tolerating missing ones) and the bridge directory', async () => {
    const plan = planUninstall(ctx);
    const reg = plan.actions.filter((a) => a.kind === 'reg');
    expect(
      reg.every(
        (a) => a.kind === 'reg' && a.args[0] === 'delete' && a.optional,
      ),
    ).toBe(true);
    expect(
      new Set(reg.map((a) => (a.kind === 'reg' ? a.args[1] : ''))).size,
    ).toBe(reg.length);
    expect(plan.actions.at(-1)).toEqual({
      kind: 'remove',
      path: `${local}\\BrowserSweet\\bridge`,
    });

    // Dry-run-style application with a recording io: a failing optional delete doesn't stop it.
    const done: string[] = [];
    const io: ApplyIo = {
      mkdir: () => undefined,
      writeFile: () => undefined,
      copy: () => undefined,
      remove: (p) => void done.push(`rm ${p}`),
      reg: async (args) => {
        done.push(`reg ${args.join(' ')}`);
        throw new Error(
          'ERROR: The system was unable to find the specified registry key',
        );
      },
    };
    expect(await applyPlan(plan, io)).toEqual([]);
    expect(done.at(-1)).toBe(`rm ${local}\\BrowserSweet\\bridge`);
  });

  it("refuses paths a .cmd can't quote", () => {
    expect(() => windowsLauncher('C:\\a%b\\node.exe', 'c', 'd')).toThrow(
      /can't write/,
    );
  });
});

describe('launchers', () => {
  it('quotes POSIX paths safely', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(posixLauncher('/n', "/a b/it's", '/c')).toContain(
      `exec '/n' '/a b/it'\\''s' host --config '/c' -- "$@"`,
    );
  });
});

describe('extension ids', () => {
  it('classifies ids', () => {
    expect(classifyExtensionId(CHROMIUM_ID)).toBe('chromium');
    expect(classifyExtensionId(GECKO_ID)).toBe('firefox');
    expect(classifyExtensionId('{12345678-1234-1234-1234-123456789abc}')).toBe(
      'firefox',
    );
    expect(classifyExtensionId('zzz')).toBeUndefined();
  });

  it('derives the Chromium id from a manifest key', () => {
    const key = Buffer.alloc(294, 7).toString('base64');
    const id = extensionIdFromKey(key);
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(extensionIdFromKey(key)).toBe(id);
  });
});

describe('snippets', () => {
  it('prints Claude Code, Claude Desktop and Cursor config', () => {
    const text = mcpConfigSnippets('darwin');
    expect(text).toContain(
      'claude mcp add browsersweet -- npx -y @browsersweet/mcp',
    );
    expect(text).toContain('claude_desktop_config.json');
    expect(text).toContain('.cursor/mcp.json');
  });
});

describe.skipIf(process.platform === 'win32')(
  'install + uninstall on a real filesystem',
  () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0))
        rmSync(d, { recursive: true, force: true });
    });

    it('writes files with the right modes and removes them again', async () => {
      const home = shortTempDir();
      dirs.push(home);
      const pkg = path.join(home, 'pkg');
      mkdirSync(path.join(pkg, 'dist'), { recursive: true });
      writeFileSync(path.join(pkg, 'dist', 'cli.js'), '');
      writeFileSync(path.join(pkg, 'dist', 'cli.d.ts'), '');
      const zod = path.join(home, 'zod');
      mkdirSync(zod);
      writeFileSync(path.join(zod, 'package.json'), '{}');
      const chrome = path.join(home, '.config', 'google-chrome');
      mkdirSync(chrome, { recursive: true });
      const ctx = context('linux', [], {
        homedir: home,
        env: {},
        exists: existsSync,
        packageRoot: pkg,
        resolvePackageDir: (name) => (name === 'zod' ? zod : undefined),
      });
      const plan = planInstall(ctx, { extensionIds: [CHROMIUM_ID] });
      expect(await applyPlan(plan, nodeApplyIo('linux'))).toEqual([]);
      const bridge = path.join(
        home,
        '.local',
        'share',
        'browsersweet',
        'bridge',
      );
      expect(modeOf(path.join(bridge, 'browsersweet-bridge'))).toBe(0o755);
      expect(modeOf(path.join(bridge, 'config.json'))).toBe(0o600);
      expect(existsSync(path.join(bridge, 'runtime', 'dist', 'cli.js'))).toBe(
        true,
      );
      expect(existsSync(path.join(bridge, 'runtime', 'dist', 'cli.d.ts'))).toBe(
        false,
      );
      expect(
        existsSync(
          path.join(bridge, 'runtime', 'node_modules', 'zod', 'package.json'),
        ),
      ).toBe(true);
      const manifest = path.join(
        chrome,
        'NativeMessagingHosts',
        'com.browsersweet.bridge.json',
      );
      expect(JSON.parse(readFileSync(manifest, 'utf8')).path).toBe(
        path.join(bridge, 'browsersweet-bridge'),
      );

      const removal = planUninstall(ctx);
      expect(await applyPlan(removal, nodeApplyIo('linux'))).toEqual([]);
      expect(existsSync(manifest)).toBe(false);
      expect(existsSync(bridge)).toBe(false);
      expect(existsSync(chrome)).toBe(true);
    });
  },
);

describe('Chrome for Testing', () => {
  it('uses its own user data directory on macOS and Linux', () => {
    const mac = planInstall(context('darwin'), {
      extensionIds: [CHROMIUM_ID],
      browsers: ['chrome-for-testing'],
    });
    expect(mac.browsers[0]).toMatchObject({
      name: 'Google Chrome for Testing',
      manifestPath:
        '/Users/me/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.browsersweet.bridge.json',
    });
    const linux = planInstall(
      context('linux', [], { env: { XDG_CONFIG_HOME: '/xdg' } }),
      { extensionIds: [CHROMIUM_ID], browsers: ['chrome-for-testing'] },
    );
    expect(linux.browsers[0]?.manifestPath).toBe(
      '/xdg/google-chrome-for-testing/NativeMessagingHosts/com.browsersweet.bridge.json',
    );
  });

  it("is detected, and shares Chrome's registry key on Windows", () => {
    const local = 'C:\\Users\\me\\AppData\\Local';
    const ctx = context('win32', [
      `${local}\\Google\\Chrome\\User Data`,
      `${local}\\Google\\Chrome for Testing\\User Data`,
    ]);
    const plan = planInstall(ctx, { extensionIds: [CHROMIUM_ID] });
    expect(plan.browsers.map((b) => b.key)).toEqual([
      'chrome',
      'chrome-for-testing',
    ]);
    const regs = plan.actions.filter((a) => a.kind === 'reg');
    expect(regs).toHaveLength(1);
    expect(plan.browsers[1]?.registryKeys).toEqual([
      'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.browsersweet.bridge',
    ]);
  });

  it('parses its names', () => {
    expect(parseBrowserKey('chrome-for-testing')).toBe('chrome-for-testing');
    expect(parseBrowserKey('Chrome for Testing')).toBe('chrome-for-testing');
    expect(parseBrowserKey('cft')).toBe('chrome-for-testing');
  });
});

describe('--manifest-dir', () => {
  const support = '/Users/me/Library/Application Support';
  const ctx = context('darwin', [`${support}/Google/Chrome`]);

  it('writes one manifest there instead of into the browsers', () => {
    const plan = planInstall(ctx, {
      extensionIds: [CHROMIUM_ID, GECKO_ID],
      manifestDir: '/tmp/profile/NativeMessagingHosts',
    });
    const files = writes(plan.actions);
    const manifests = Object.keys(files).filter((f) =>
      f.endsWith('com.browsersweet.bridge.json'),
    );
    expect(manifests).toEqual([
      '/tmp/profile/NativeMessagingHosts/com.browsersweet.bridge.json',
    ]);
    expect(JSON.parse(files[manifests[0] as string] as string)).toMatchObject({
      path: `${support}/BrowserSweet/bridge/browsersweet-bridge`,
      allowed_origins: [`chrome-extension://${CHROMIUM_ID}/`],
    });
    // The runtime, config and launcher are still installed.
    expect(files[`${support}/BrowserSweet/bridge/config.json`]).toBeDefined();
    expect(plan.browsers).toEqual([
      {
        key: 'chrome',
        name: 'Chromium browsers (custom manifest directory)',
        status: 'install',
        manifestPath:
          '/tmp/profile/NativeMessagingHosts/com.browsersweet.bridge.json',
      },
    ]);
  });

  it('writes a Firefox manifest for --browser firefox or a gecko id alone', () => {
    const cases: { extensionIds: string[]; browsers: BrowserKey[] }[] = [
      { extensionIds: [CHROMIUM_ID, GECKO_ID], browsers: ['firefox'] },
      { extensionIds: [GECKO_ID], browsers: [] },
    ];
    for (const options of cases) {
      const plan = planInstall(ctx, { ...options, manifestDir: '/tmp/ff' });
      expect(
        JSON.parse(
          writes(plan.actions)[
            '/tmp/ff/com.browsersweet.bridge.json'
          ] as string,
        ),
      ).toMatchObject({ allowed_extensions: [GECKO_ID] });
    }
  });

  it('rejects relative paths, mixed families and missing ids', () => {
    expect(() =>
      planInstall(ctx, { extensionIds: [CHROMIUM_ID], manifestDir: 'rel' }),
    ).toThrow(/absolute/);
    expect(() =>
      planInstall(ctx, {
        extensionIds: [CHROMIUM_ID, GECKO_ID],
        browsers: ['chrome', 'firefox'],
        manifestDir: '/tmp/x',
      }),
    ).toThrow(UsageError);
    expect(() =>
      planInstall(ctx, {
        extensionIds: [CHROMIUM_ID],
        browsers: ['firefox'],
        manifestDir: '/tmp/x',
      }),
    ).toThrow(/Firefox extension id/);
  });

  it("doesn't touch the registry on Windows", () => {
    const plan = planInstall(context('win32'), {
      extensionIds: [CHROMIUM_ID],
      manifestDir: 'D:\\hosts',
    });
    expect(plan.actions.some((a) => a.kind === 'reg')).toBe(false);
    expect(
      writes(plan.actions)['D:\\hosts\\com.browsersweet.bridge.json'],
    ).toBeDefined();
    expect(plan.notes.join(' ')).toMatch(/registry/);
  });

  it('uninstall removes only that manifest', () => {
    const dir = '/tmp/profile/NativeMessagingHosts';
    const manifest = `${dir}/com.browsersweet.bridge.json`;
    const plan = planUninstall(context('darwin', [manifest]), {
      manifestDir: dir,
    });
    expect(plan.actions).toEqual([{ kind: 'remove', path: manifest }]);
    expect(plan.notes.join(' ')).toMatch(/Kept/);
    expect(
      planUninstall(context('darwin'), { manifestDir: dir }).actions,
    ).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')(
  'install, doctor and uninstall with --manifest-dir in a temp dir',
  () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0))
        rmSync(d, { recursive: true, force: true });
    });

    it('round-trips', async () => {
      const home = shortTempDir();
      dirs.push(home);
      const pkg = path.join(home, 'pkg');
      mkdirSync(path.join(pkg, 'dist'), { recursive: true });
      writeFileSync(path.join(pkg, 'dist', 'cli.js'), '');
      const zod = path.join(home, 'zod');
      mkdirSync(zod);
      writeFileSync(path.join(zod, 'package.json'), '{}');
      const ctx = context('linux', [], {
        homedir: home,
        env: {},
        exists: existsSync,
        packageRoot: pkg,
        nodePath: process.execPath,
        resolvePackageDir: (name) => (name === 'zod' ? zod : undefined),
      });
      const hosts = path.join(home, 'cft-profile', 'NativeMessagingHosts');
      const plan = planInstall(ctx, {
        extensionIds: [CHROMIUM_ID],
        manifestDir: hosts,
      });
      expect(await applyPlan(plan, nodeApplyIo('linux'))).toEqual([]);
      const manifest = path.join(hosts, 'com.browsersweet.bridge.json');
      expect(existsSync(manifest)).toBe(true);

      const doctor = checkInstall(ctx, nodeDoctorDeps, { manifestDir: hosts });
      expect(doctor.filter((c) => c.level === 'fail')).toEqual([]);
      expect(doctor.at(-1)).toEqual({
        level: 'ok',
        message: `Chromium manifest: ${manifest}`,
      });
      // Without --manifest-dir, a named browser with no manifest is a warning.
      expect(
        checkInstall(ctx, nodeDoctorDeps, {
          browsers: ['chrome-for-testing'],
        }).at(-1),
      ).toEqual({
        level: 'warn',
        message: 'Google Chrome for Testing: no manifest',
      });

      const removal = planUninstall(ctx, { manifestDir: hosts });
      expect(await applyPlan(removal, nodeApplyIo('linux'))).toEqual([]);
      expect(existsSync(manifest)).toBe(false);
      expect(existsSync(installLayout(ctx).launcherPath)).toBe(true);
      expect(
        checkInstall(ctx, nodeDoctorDeps, { manifestDir: hosts }).at(-1)?.level,
      ).toBe('fail');
    });
  },
);
