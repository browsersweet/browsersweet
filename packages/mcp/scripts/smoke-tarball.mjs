// Installs a packed @browsersweet/mcp tarball into an empty project and checks it the way users run it:
// the CLI reports this package's version, and an MCP client over stdio connects, lists the tools and
// gets an answer from list_browser_profiles (no browser is connected, so the answer says how to set
// one up). Runs on whichever Node runs it; CI uses it for every Node version the package supports.
//
//   node packages/mcp/scripts/smoke-tarball.mjs <path to browsersweet-mcp-<version>.tgz>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tarball = process.argv[2] && path.resolve(process.argv[2]);
if (!tarball) {
  console.error('Usage: smoke-tarball.mjs <tarball>');
  process.exit(1);
}
const expected = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const dir = mkdtempSync(path.join(tmpdir(), 'browsersweet-mcp-smoke-'));
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

try {
  writeFileSync(
    path.join(dir, 'package.json'),
    '{ "private": true, "type": "module" }\n',
  );
  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    tarball,
  ]);

  const cli = path.join(dir, 'node_modules/@browsersweet/mcp/dist/cli.js');
  const version = run(process.execPath, [cli, '--version']).trim();
  if (version !== expected)
    throw new Error(`--version printed ${version}, expected ${expected}`);

  // The client lives in the temp project so it resolves the SDK the package installed.
  writeFileSync(
    path.join(dir, 'client.mjs'),
    `import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({ command: process.execPath, args: [${JSON.stringify(cli)}, 'serve'] });
const client = new Client({ name: 'smoke-tarball', version: '0' });
await client.connect(transport);
const server = client.getServerVersion();
const { tools } = await client.listTools();
if (!tools.some((tool) => tool.name === 'list_browser_profiles')) throw new Error('list_browser_profiles is missing');
const result = await client.callTool({ name: 'list_browser_profiles', arguments: {} });
if (!result.content?.length) throw new Error('list_browser_profiles returned no content');
await client.close();
console.log(\`\${server.name} \${server.version}: \${tools.length} tools\`);
`,
  );
  const handshake = run(process.execPath, ['client.mjs']).trim();
  console.log(
    `Node ${process.versions.node}: --version ${version}; MCP ${handshake}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
