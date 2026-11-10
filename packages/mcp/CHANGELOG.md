# Changelog

All notable changes to `@browsersweet/mcp`. The wire protocol is versioned separately (`PROTOCOL_VERSION`, see [PROTOCOL.md](./PROTOCOL.md)); it is still 1.

## 0.1.0-next.0

First prerelease on npm (`npm install @browsersweet/mcp@next`).

- **MCP server** (`browsersweet-mcp`, the default mode): a stdio MCP server for Claude Code, Claude Desktop, Cursor and other clients. Tools come from the Browser Sweet extension (`list_spaces`, `get_kept_tree`, `list_tabs`, `get_active_tab`, `search_archive`, `get_handoffs`, `get_page_text`) plus `list_browser_profiles`; every tool takes an optional `profile`. Page text, handoffs and anything the extension marks untrusted come back fenced and labeled as untrusted web content.
- **Native messaging host** (`host`): started by the browser for the Browser Sweet extension only, relays over a per-user Unix socket or named pipe gated by a random token. No TCP port, no network access.
- **Setup:** `install` (Chrome, Chrome for Testing, Chromium, Edge, Brave, Vivaldi, Arc, Firefox on macOS, Linux and Windows; `--browser`, `--manifest-dir <dir>`, `--dry-run`), `uninstall`, `doctor`, `config` and `extension-id`.
- **Protocol 1** (`@browsersweet/mcp/protocol`): zod schemas for every message, chunking past Chrome's 1 MiB native message cap, and:
  - `host.status.clientList` names the connected MCP clients (`clientInfo` from `initialize`, e.g. `claude-code`) next to the `clients` count; `clients.disconnect` lets the extension drop one.
  - `ImagePart` content (`image/png`, `image/jpeg`, base64), rendered as MCP image content. Receivers skip content parts of unknown types.
  - `get_active_tab` answers from the last-focused normal window, so it works while the agent's terminal has focus.
