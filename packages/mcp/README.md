# @browsersweet/mcp

Let local AI agents (Claude Code, Claude Desktop, Cursor and other MCP clients) read your [Browser Sweet](https://browsersweet.com) workspace: Spaces, Kept, Today tabs, the Archive and what you hand off with **Send to agent**.

It's a small MCP server that talks to the Browser Sweet extension through the browser's native messaging. Everything stays on your computer.

> Agent integration is a **Labs** feature in Browser Sweet and is off by default.

## Install

1. In Browser Sweet, open **Settings → Labs** and turn on **Agent integration**. It shows your extension id and the command below.
2. Register the bridge with your browsers:

   ```sh
   npx @browsersweet/mcp install --extension-id <id>
   ```

   This finds Chrome, Chromium, Edge, Brave, Vivaldi, Arc and Firefox and writes a native messaging manifest for each. Use `--browser chrome` (repeatable) to pick browsers, and `--dry-run` to see exactly what would be written. For Firefox, pass its extension id too (it looks like `name@domain`).

3. Add the MCP server to your client:

   - **Claude Code:** `claude mcp add browsersweet -- npx -y @browsersweet/mcp`
   - **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows) and **Cursor** (`~/.cursor/mcp.json`):

     ```json
     {
       "mcpServers": {
         "browsersweet": {
           "command": "npx",
           "args": ["-y", "@browsersweet/mcp"]
         }
       }
     }
     ```

`npx @browsersweet/mcp config` prints these again. Check everything with `npx @browsersweet/mcp doctor`. Remove it all with `npx @browsersweet/mcp uninstall` (then remove the entry from your MCP client).

### What `install` writes

|         | Manifest(s)                                                                                                                                                                                                                   | Bridge files                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| macOS   | `~/Library/Application Support/<browser>/NativeMessagingHosts/com.browsersweet.bridge.json` (Chrome: `Google/Chrome`, Edge: `Microsoft Edge`, Brave: `BraveSoftware/Brave-Browser`, Arc: `Arc/User Data`, Firefox: `Mozilla`) | `~/Library/Application Support/BrowserSweet/bridge/` |
| Linux   | `~/.config/<browser>/NativeMessagingHosts/` (`google-chrome`, `chromium`, `microsoft-edge`, `BraveSoftware/Brave-Browser`, `vivaldi`; honors `XDG_CONFIG_HOME`), Firefox: `~/.mozilla/native-messaging-hosts/`                | `~/.local/share/browsersweet/bridge/`                |
| Windows | `%LOCALAPPDATA%\BrowserSweet\bridge\manifests\…`, registered under `HKCU\Software\<vendor>\<browser>\NativeMessagingHosts\com.browsersweet.bridge` with `reg.exe` (Brave and Vivaldi also get Chrome's key)                   | `%LOCALAPPDATA%\BrowserSweet\bridge\`                |

The bridge folder holds a copy of the host runtime (so it keeps working after the npx cache is cleared), `config.json` (the allowed extension ids, mode 0600) and a launcher script (`browsersweet-bridge` or `.cmd`) that runs it with the absolute path of the Node that ran `install`. If you remove or upgrade that Node, run `install` again.

## Tools

| Tool                           | What it does                                        |
| ------------------------------ | --------------------------------------------------- |
| `list_spaces`                  | Your Spaces with kept and open tab counts           |
| `get_kept_tree`                | A Space's Kept folders and links, and Favorites     |
| `list_tabs` / `get_active_tab` | Open tabs and the one you're looking at (see below) |
| `search_archive`               | Auto-archived tabs by text and date                 |
| `get_handoffs`                 | What you sent with **Send to agent**                |
| `get_page_text`                | Text of a tab you've granted site access to         |
| `list_browser_profiles`        | Connected browser profiles                          |

`get_active_tab` returns the active tab of the browser window you used last, even while you're typing in a terminal and the browser doesn't have focus. It comes back empty only when that browser profile has no normal window open.

The tool list comes from the extension, so it follows your extension version. Every tool takes an optional `profile` (an id, label or browser name from `list_browser_profiles`); without it the most recently focused browser profile answers. If no browser is connected, tools return an error telling you to turn on Labs → Agent integration.

## Privacy and security

- **Nothing leaves your machine.** No network requests, no accounts, no telemetry. Data goes from the extension to your MCP client over local pipes only.
- **Read-only in v1.** No tool can open, close, change or click anything. (Proposals the agent makes in later versions need your approval in the side panel.)
- **Page text is untrusted.** Web pages can contain text written to manipulate AI agents. `get_page_text` and handoff results are wrapped in a labeled block with a random marker and flagged as untrusted, so the agent treats them as data. Tab titles and URLs are also written by websites; treat them the same way.
- **You can see who's connected.** Browser Sweet's Labs panel lists the connected MCP clients by the name they give (e.g. `claude-code`) and can disconnect one. A disconnected client stays away until Agent integration reconnects.
- **No TCP port.** Web pages can't reach the bridge. The browser only starts the host for the Browser Sweet extension ids listed in its manifest, and the host checks the caller again against `config.json`.

### Threat model

- **The socket.** Each browser profile's host listens on a Unix socket in a directory only you can open (mode 0700; the socket is 0600), or on Windows a named pipe whose name includes your user SID and a random id. Clients must present a random token from a discovery file in that private directory before the host sends anything; on Windows this compensates for named pipes' default ACL, which lets other users open a pipe read-only.
- **Same-user processes are trusted.** Any program running as you can read the token and connect, just as it could launch the MCP server itself or read your browser profile. That's the same trust boundary as the MCP client, and why the tools are read-only.
- **Prompt injection** from page content is mitigated by labeling, not prevented; review what an agent proposes to do with what it read.

## Troubleshooting

- `npx @browsersweet/mcp doctor` checks Node, the runtime, the launcher, each browser's manifest and which profiles are connected.
- Host logs go to the browser's stderr (Chrome: start it with `--enable-logging=stderr`). Set `BROWSERSWEET_MCP_DEBUG=1` for more.
- Using nvm or Volta and Claude Desktop can't find `npx`? Put the absolute path of `npx` in `command`.

## For extension developers

- The wire protocol is in [PROTOCOL.md](./PROTOCOL.md); schemas and helpers (`encodeForWire`, `ChunkAssembler`, the message schemas) are exported from `@browsersweet/mcp/protocol` and run in a service worker.
- **Stable dev id:** native messaging matches exact extension ids, and an unpacked build's id changes with its path unless the manifest has a `key`. Generate one once and keep it out of the store build:

  ```sh
  openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out bridge-dev.pem
  openssl rsa -in bridge-dev.pem -pubout -outform DER | openssl base64 -A   # → manifest "key"
  npx @browsersweet/mcp extension-id "<that base64>"                      # → the id
  npx @browsersweet/mcp install --extension-id <the id>
  ```

  Store builds don't set `key`; pass the store ids (Chrome Web Store, Edge Add-ons, and the Firefox gecko id) to `install` once they exist.

## Development

`nx build browsersweet-mcp`, `nx test browsersweet-mcp` (builds first: the integration test runs the real CLI), `nx lint browsersweet-mcp`, `nx typecheck browsersweet-mcp`.

MIT licensed.
