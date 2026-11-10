import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePackageDir } from './install/context.js';
import { applyPlan, nodeApplyIo } from './install/apply.js';
import {
  installLayout,
  planInstall,
  type InstallContext,
} from './install/plan.js';
import { currentPlatform, RUN_DIR_ENV } from './paths.js';
import {
  FakeExtension,
  SAMPLE_TOOLS,
  TEST_ORIGIN,
  shortTempDir,
  until,
} from './test-support/fake-extension.js';

/*
 * End to end, with real processes: `install` into a temporary home, then start the generated
 * launcher the way a browser would (origin on argv, native messaging on stdio) with a fake
 * extension on the other end, and drive `browsersweet-mcp serve` through the MCP SDK client.
 * The host runs from the copied runtime, which has no MCP SDK, so this also proves host mode
 * doesn't load it. Needs `dist/` (the Nx test target depends on build).
 */

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(packageDir, 'dist', 'cli.js');
const posix = process.platform !== 'win32';

describe.skipIf(!posix)(
  'integration: browser → host → socket → MCP client',
  () => {
    let home: string;
    let runDir: string;
    let launcher: string;
    const children: ChildProcessWithoutNullStreams[] = [];

    beforeAll(async () => {
      if (!existsSync(cli)) {
        throw new Error(
          `${cli} is missing: run \`nx build browsersweet-mcp\` first`,
        );
      }
      home = shortTempDir('bsint-');
      runDir = path.join(home, 'run');
      const ctx: InstallContext = {
        platform: currentPlatform(),
        homedir: home,
        env: {},
        tmpdir: home,
        uid: process.getuid?.(),
        exists: existsSync,
        nodePath: process.execPath,
        packageRoot: packageDir,
        version: '0.0.0-int',
        resolvePackageDir,
      };
      const plan = planInstall(ctx, {
        extensionIds: [TEST_ORIGIN.slice('chrome-extension://'.length, -1)],
        browsers: ['chrome'],
      });
      expect(await applyPlan(plan, nodeApplyIo())).toEqual([]);
      launcher = installLayout(ctx).launcherPath;
    });

    afterAll(() => {
      for (const child of children) child.kill();
      rmSync(home, { recursive: true, force: true });
    });

    function startHost(args: string[]) {
      const child = spawn(launcher, args, {
        env: { ...process.env, [RUN_DIR_ENV]: runDir },
        stdio: 'pipe',
      });
      children.push(child);
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += String(d)));
      const exited = new Promise<number | null>((resolve) =>
        child.once('exit', (code) => resolve(code)),
      );
      return { child, exited, stderr: () => stderr };
    }

    it('refuses an origin that is not allowed', async () => {
      const { exited, stderr } = startHost([
        'chrome-extension://ppppoooonnnnmmmmllllkkkkjjjjiiii/',
      ]);
      expect(await exited).toBe(1);
      expect(stderr()).toMatch(/not allowed/);
    });

    it('serves tools from the extension to an MCP client', async () => {
      const { child, exited, stderr } = startHost([
        TEST_ORIGIN,
        '--parent-window=0',
      ]);
      const extension = new FakeExtension(child.stdin, child.stdout, {
        profileLabel: 'Work',
        focused: true,
        tools: SAMPLE_TOOLS,
        handlers: {
          list_spaces: () => ({
            data: {
              spaces: [{ id: 's1', name: 'Work', keptCount: 4, tabCount: 9 }],
            },
          }),
          get_page_text: (args) => ({
            data: { tabId: args['tabId'], length: 1_200_000, truncated: false },
            content: [
              {
                type: 'text',
                text: 'p'.repeat(1_200_000),
                untrusted: true,
                source: { url: 'https://example.com/' },
              },
            ],
          }),
        },
      });
      extension.hello();
      await extension.waitFor((m) => m.type === 'hello.ack');
      extension.sendTools();
      await until(() => {
        try {
          return readdirSync(runDir).some((f) => f.endsWith('.json'));
        } catch {
          return false;
        }
      }).catch(() => {
        throw new Error(`host never listened. stderr:\n${stderr()}`);
      });

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cli],
        env: {
          ...(process.env as Record<string, string>),
          [RUN_DIR_ENV]: runDir,
        },
        stderr: 'pipe',
      });
      const mcp = new Client({ name: 'integration', version: '1' });
      await mcp.connect(transport);
      try {
        const { tools } = await mcp.listTools();
        expect(tools.map((t) => t.name)).toEqual([
          'list_browser_profiles',
          'list_spaces',
          'get_page_text',
        ]);
        const spaces = await mcp.callTool({
          name: 'list_spaces',
          arguments: {},
        });
        expect(spaces.isError).toBeFalsy();
        expect(
          JSON.parse((spaces.content as { text: string }[])[0]?.text ?? ''),
        ).toEqual({
          spaces: [{ id: 's1', name: 'Work', keptCount: 4, tabCount: 9 }],
        });
        // > 1 MB of page text: chunked by the extension, reassembled by the host.
        const page = await mcp.callTool({
          name: 'get_page_text',
          arguments: { tabId: 5, profile: 'Work' },
        });
        const blocks = page.content as { text: string }[];
        expect(blocks[1]?.text).toMatch(
          /^UNTRUSTED CONTENT from <https:\/\/example.com\/>/,
        );
        expect(blocks[1]?.text.length).toBeGreaterThan(1_200_000);
        const profiles = await mcp.callTool({
          name: 'list_browser_profiles',
          arguments: {},
        });
        expect((profiles.content as { text: string }[])[0]?.text).toContain(
          '"label": "Work"',
        );
      } finally {
        await mcp.close();
      }

      // The browser closes the port: the host cleans up and exits.
      child.stdin.end();
      expect(await exited).toBe(0);
      expect(readdirSync(runDir)).toEqual([]);
    });
  },
);
