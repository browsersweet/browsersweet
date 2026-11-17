import type { SupportedPlatform } from '../paths.js';

export const MCP_SERVER_NAME = 'browsersweet';
export const PACKAGE_NAME = '@browsersweet/mcp';

const serverJson = (): string =>
  JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: { command: 'npx', args: ['-y', PACKAGE_NAME] },
      },
    },
    null,
    2,
  );

export function claudeDesktopConfigPath(platform: SupportedPlatform): string {
  switch (platform) {
    case 'darwin':
      return '~/Library/Application Support/Claude/claude_desktop_config.json';
    case 'win32':
      return '%APPDATA%\\Claude\\claude_desktop_config.json';
    case 'linux':
      return '~/.config/Claude/claude_desktop_config.json';
  }
}

/** MCP client configuration, as printed after `install` and by `config`. */
export function mcpConfigSnippets(platform: SupportedPlatform): string {
  return [
    'Claude Code:',
    `  claude mcp add ${MCP_SERVER_NAME} -- npx -y ${PACKAGE_NAME}`,
    '',
    `Claude Desktop (${claudeDesktopConfigPath(platform)}):`,
    indent(serverJson()),
    '',
    'Cursor (~/.cursor/mcp.json, or .cursor/mcp.json in a project):',
    indent(serverJson()),
    '',
    'Other MCP clients: run `npx -y @browsersweet/mcp` as a stdio server.',
  ].join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
