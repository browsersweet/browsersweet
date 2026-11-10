#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { BrowserKey } from './install/browsers.js';
import { packageVersion } from './version.js';

/*
 * `browsersweet-mcp`: one binary, several modes. Modes are imported lazily so host mode (started
 * by the browser from the copied runtime) never loads the MCP SDK.
 */

const HELP = `browsersweet-mcp — Browser Sweet's local MCP bridge

Usage:
  browsersweet-mcp [serve]          Run the MCP server on stdio (what MCP clients launch)
  browsersweet-mcp install --extension-id <id> [--extension-id <id>…] [--browser <name>…]
                          [--manifest-dir <dir>] [--dry-run]
                                    Register the native messaging host with your browsers
  browsersweet-mcp uninstall [--browser <name>…] [--manifest-dir <dir>] [--dry-run]
                                    Remove it again
  browsersweet-mcp doctor [--browser <name>…] [--manifest-dir <dir>]
                                    Check the installation and connected browsers
  browsersweet-mcp config           Print MCP client configuration
  browsersweet-mcp extension-id <base64 public key>
                                    The Chromium extension id for a manifest "key"
  browsersweet-mcp host …           Native messaging host (browsers start this; not for humans)

Browsers: chrome, chrome-for-testing, chromium, edge, brave, vivaldi, arc, firefox
(default: every one detected).
--manifest-dir writes (removes, checks) the host manifest in <dir> instead of the browsers'
own NativeMessagingHosts folders, e.g. for a browser with a custom user data dir or for tests.
Pass --browser firefox with it for a Firefox manifest.
Extension ids: Chromium ids are 32 letters a–p; Firefox ids look like name@domain.

Everything stays on this computer: no network requests, no TCP ports.`;

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const err = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

/** `--browser` values as keys, or `undefined` (after printing why) if one is unknown. */
async function browserKeys(
  names: readonly string[] | undefined,
): Promise<BrowserKey[] | undefined> {
  const { parseBrowserKey } = await import('./install/browsers.js');
  const browsers: BrowserKey[] = [];
  for (const name of names ?? []) {
    const key = parseBrowserKey(name);
    if (!key) {
      err(`Unknown browser "${name}".`);
      return undefined;
    }
    browsers.push(key);
  }
  return browsers;
}

function manifestDirOption(value: string | undefined): {
  manifestDir?: string;
} {
  return value === undefined ? {} : { manifestDir: path.resolve(value) };
}

async function install(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      'extension-id': { type: 'string', multiple: true },
      browser: { type: 'string', multiple: true },
      'manifest-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  });
  const { planInstall, describeAction, UsageError } =
    await import('./install/plan.js');
  const { applyPlan, nodeApplyIo } = await import('./install/apply.js');
  const { nodeInstallContext } = await import('./install/context.js');
  const { mcpConfigSnippets } = await import('./install/snippets.js');
  const ctx = nodeInstallContext();
  const browsers = await browserKeys(values.browser);
  if (!browsers) return 2;
  let plan;
  try {
    plan = planInstall(ctx, {
      extensionIds: values['extension-id'] ?? [],
      browsers,
      ...manifestDirOption(values['manifest-dir']),
    });
  } catch (error) {
    if (error instanceof UsageError) {
      err(`install: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const dryRun = values['dry-run'] === true;
  if (dryRun) {
    out('Dry run: nothing will be written.\n');
    for (const action of plan.actions) {
      out(`  ${describeAction(action)}`);
      if (action.kind === 'write' && action.show) {
        out(
          action.content
            .trimEnd()
            .split(/\r?\n/)
            .map((line) => `      ${line}`)
            .join('\n'),
        );
      }
    }
    out('');
  } else {
    const errors = await applyPlan(plan, nodeApplyIo(ctx.platform));
    if (errors.length) {
      for (const message of errors) err(`install failed: ${message}`);
      return 1;
    }
  }
  for (const browser of plan.browsers) {
    const where = browser.registryKeys?.length
      ? `${browser.manifestPath} (registry: ${browser.registryKeys.join(', ')})`
      : browser.manifestPath;
    out(
      browser.status === 'install'
        ? `${dryRun ? 'Would install' : 'Installed'} for ${browser.name}: ${where}`
        : `Skipped ${browser.name}: ${browser.reason}`,
    );
  }
  for (const note of plan.notes) out(note);
  out(
    `\nNext: in Browser Sweet, turn on Settings → Labs → Agent integration, then add the MCP server to your client:\n`,
  );
  out(mcpConfigSnippets(ctx.platform));
  return 0;
}

async function uninstall(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      browser: { type: 'string', multiple: true },
      'manifest-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  });
  const { planUninstall, describeAction, UsageError } =
    await import('./install/plan.js');
  const { applyPlan, nodeApplyIo } = await import('./install/apply.js');
  const { nodeInstallContext } = await import('./install/context.js');
  const ctx = nodeInstallContext();
  const browsers = await browserKeys(values.browser);
  if (!browsers) return 2;
  let plan;
  try {
    plan = planUninstall(ctx, {
      browsers,
      ...manifestDirOption(values['manifest-dir']),
    });
  } catch (error) {
    if (error instanceof UsageError) {
      err(`uninstall: ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (values['dry-run']) {
    out('Dry run: nothing will be removed.\n');
    for (const action of plan.actions) out(`  ${describeAction(action)}`);
  } else {
    const errors = await applyPlan(plan, nodeApplyIo(ctx.platform));
    if (errors.length) {
      for (const message of errors) err(`uninstall failed: ${message}`);
      return 1;
    }
    for (const browser of plan.browsers) out(`Removed for ${browser.name}`);
  }
  for (const note of plan.notes) out(note);
  out('Remove "browsersweet" from your MCP client configuration too.');
  return 0;
}

async function doctor(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      browser: { type: 'string', multiple: true },
      'manifest-dir': { type: 'string' },
    },
    strict: true,
  });
  const { checkInstall, checkHosts, formatChecks, nodeDoctorDeps } =
    await import('./install/doctor.js');
  const { nodeInstallContext } = await import('./install/context.js');
  const ctx = nodeInstallContext();
  const browsers = await browserKeys(values.browser);
  if (!browsers) return 2;
  const checks = [
    ...checkInstall(ctx, nodeDoctorDeps, {
      browsers,
      ...manifestDirOption(values['manifest-dir']),
    }),
    ...(await checkHosts(ctx, nodeDoctorDeps, packageVersion())),
  ];
  out(formatChecks(checks));
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // Browsers that point a manifest straight at this file pass the caller as the first argument.
  if (command?.startsWith('chrome-extension://')) {
    const { runHost } = await import('./host/main.js');
    return runHost(argv);
  }
  switch (command) {
    case undefined:
    case 'serve': {
      const { runClient } = await import('./client/server.js');
      await runClient();
      return -1;
    }
    case 'host': {
      const { runHost } = await import('./host/main.js');
      return runHost(rest);
    }
    case 'install':
      return install(rest);
    case 'uninstall':
      return uninstall(rest);
    case 'doctor':
      return doctor(rest);
    case 'config': {
      const { mcpConfigSnippets } = await import('./install/snippets.js');
      const { currentPlatform } = await import('./paths.js');
      out(mcpConfigSnippets(currentPlatform()));
      return 0;
    }
    case 'extension-id': {
      const { extensionIdFromKey } = await import('./install/extension-id.js');
      if (!rest[0]) {
        err('usage: browsersweet-mcp extension-id <base64 public key>');
        return 2;
      }
      out(extensionIdFromKey(rest[0]));
      return 0;
    }
    case '--version':
    case '-v':
      out(packageVersion());
      return 0;
    case '--help':
    case '-h':
    case 'help':
      out(HELP);
      return 0;
    default:
      err(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    // -1: a long-running mode (the MCP server) that exits when its transport closes.
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    err(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  },
);
