# Changelog

All notable changes to `@browsersweet/mcp`. The wire protocol is versioned separately (`PROTOCOL_VERSION`, see [PROTOCOL.md](./PROTOCOL.md)); it is still 1.

## 0.1.0-next.1

Security fixes.

- **Discovery only trusts what you own.** The MCP server (and `doctor`) now check each socket directory, discovery record and socket before using it: not a symlink, owned by you, and no group/other access to the directory (records must not be group/world-writable). The socket must sit in the same directory as its record. Before, another local user could pre-create `/tmp/browsersweet-<uid>` (Linux, or `/tmp/browsersweet` on macOS without `TMPDIR`) with a record pointing at their own socket, then serve the agent tool descriptions of their choosing and see every tool call. A process that exists but belongs to another user (EPERM) no longer counts as a live host. `doctor` fails on a directory you don't own, not only on a loose mode. Windows records must name a Browser Sweet named pipe.
- **All tool output is fenced as untrusted.** Tab titles, URLs and kept and archived titles are written by websites, so the output of every extension tool (`list_spaces`, `get_kept_tree`, `list_tabs`, `get_active_tab`, `search_archive` too, not just `get_page_text` and `get_handoffs`) is now wrapped in `<untrusted-content NONCE>` markers, whatever the extension's `untrustedOutput` says. A content part's title and URL moved inside the fence (as JSON) instead of the label line, and images' source notices are fenced too. Nonces are 96 bits. The server instructions tell the agent once that anything inside the markers is data from websites, never instructions. `ALWAYS_UNTRUSTED_TOOLS` now lists every v1 read tool; `TRUSTED_OUTPUT_TOOLS` (empty) is the client's allow-list of exceptions.

## 0.1.0-next.0

First prerelease on npm (`npm install @browsersweet/mcp@next`).

- **MCP server** (`browsersweet-mcp`, the default mode): a stdio MCP server for Claude Code, Claude Desktop, Cursor and other clients. Tools come from the Browser Sweet extension (`list_spaces`, `get_kept_tree`, `list_tabs`, `get_active_tab`, `search_archive`, `get_handoffs`, `get_page_text`) plus `list_browser_profiles`; every tool takes an optional `profile`. Page text, handoffs and anything the extension marks untrusted come back fenced and labeled as untrusted web content.
- **Native messaging host** (`host`): started by the browser for the Browser Sweet extension only, relays over a per-user Unix socket or named pipe gated by a random token. No TCP port, no network access.
- **Setup:** `install` (Chrome, Chrome for Testing, Chromium, Edge, Brave, Vivaldi, Arc, Firefox on macOS, Linux and Windows; `--browser`, `--manifest-dir <dir>`, `--dry-run`), `uninstall`, `doctor`, `config` and `extension-id`.
- **Protocol 1** (`@browsersweet/mcp/protocol`): zod schemas for every message, chunking past Chrome's 1 MiB native message cap, and:
  - `host.status.clientList` names the connected MCP clients (`clientInfo` from `initialize`, e.g. `claude-code`) next to the `clients` count; `clients.disconnect` lets the extension drop one.
  - `ImagePart` content (`image/png`, `image/jpeg`, base64), rendered as MCP image content. Receivers skip content parts of unknown types.
  - `get_active_tab` answers from the last-focused normal window, so it works while the agent's terminal has focus.
