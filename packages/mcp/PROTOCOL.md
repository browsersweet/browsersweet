# Browser Sweet bridge protocol (v1)

How the Browser Sweet extension, the native messaging host and the MCP client mode of `@browsersweet/mcp` talk to each other. The zod schemas in `src/protocol/` are the source of truth; import them from `@browsersweet/mcp/protocol` (zod and web globals only, so they work in a service worker).

```
MCP client ──stdio (MCP)──▶ browsersweet-mcp (client mode)
                                │  per-user Unix socket / named pipe   ← "socket link" (§4)
                                ▼
                            browsersweet-mcp host (one per browser profile)
                                │  native messaging (stdio)            ← "native link" (§2–3)
                                ▼
                            Browser Sweet extension (service worker)
```

## 1. Basics

- **Host name:** `com.browsersweet.bridge` (`NATIVE_HOST_NAME`). The extension calls `chrome.runtime.connectNative('com.browsersweet.bridge')` (Firefox: `browser.runtime.connectNative`) and keeps the port open while the Labs flag is on. An open port keeps the MV3 service worker alive.
- **Version:** `PROTOCOL_VERSION = 1`. Peers exchange `[min, max]` and use the highest common version. Bump it only for incompatible changes. New optional fields, new message types, new event names and new error codes are not breaking: **receivers ignore unknown message types and strip unknown fields.**
- **Messages** are JSON objects with a `type`. Ids (`id`) match `^[A-Za-z0-9_.:-]{1,64}$`. Profile ids match `^[A-Za-z0-9_-]{1,64}$`. Tool names are snake_case `^[a-z][a-z0-9_]{0,63}$` (the registry's `toMcpToolName`).
- **Errors** are `{ code, message }`. Codes: `unknown_tool`, `invalid_arguments`, `permission_required`, `not_found`, `timeout`, `cancelled`, `busy`, `too_large`, `unavailable`, `invalid_message`, `protocol_unsupported`, `unauthorized`, `disconnected`, `internal`. Unknown codes are treated like `internal`.

## 2. Native link: extension ↔ host

The browser frames messages (4-byte little-endian length + UTF-8 JSON); the extension just uses `port.postMessage(obj)`.

### Handshake

1. The browser starts the host with the caller on argv (Chromium: `chrome-extension://<id>/`, Firefox: `<manifest path> <extension id>`). The host refuses ids not in its config.
2. **Extension → host `hello`** (must be first; anything earlier is ignored; no hello within 10 s and the host exits):

   ```json
   {
     "type": "hello",
     "protocolVersion": 1,
     "minProtocolVersion": 1,
     "extension": { "id": "<runtime.id>", "version": "<manifest version>" },
     "browser": { "name": "Chrome", "version": "150" },
     "profile": {
       "id": "<stable per-install id, e.g. the deviceId ULID>",
       "label": "Work"
     },
     "focused": true
   }
   ```

   `extension.id` must equal the id the browser launched the host for. `profile.label` is optional and user-facing; agents can pass it as `profile`. `focused` says a window of this profile has focus now.

3. **Host → extension `hello.ack`** `{ type, protocolVersion, host: { version, platform } }`. On a version or id mismatch the host sends `error` (`protocol_unsupported` / `unauthorized`) and exits instead.
4. **Extension → host `tools.list`** `{ type: 'tools.list', tools: ToolDescriptor[] }` right after the ack, and again whenever the list changes (flag toggled, permission granted). At most 128 tools. Names in `RESERVED_TOOL_NAMES` (`list_browser_profiles`) are dropped.

```ts
ToolDescriptor = {
  name: string;               // snake_case
  title?: string;
  description: string;        // ≤ 4096 chars
  inputSchema: JSONSchema;    // type: "object", ≤ 64 KB; the registry's inputJsonSchema
  annotations?: { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint?,
                  untrustedOutput?: boolean };   // true: the client labels all output untrusted
}
```

Don't define a `profile` property: the client adds it to every tool and strips it before forwarding.

### Calls

- **Host → extension `tools.call`** `{ type, id, name, arguments, timeoutMs }`. `arguments` is an object (≤ 256 KB). `timeoutMs` ≤ 120 000 (default 30 000). Validate `arguments` against the tool's schema (`invalid_arguments` on failure).
- **Extension → host `tools.result`** `{ type, id, result }` or `{ type, id, error }`, exactly one of the two, same `id`.

```ts
ToolResult = {
  data?: unknown;                 // the structured answer (see §5), rendered as JSON
  content?: (TextPart | ImagePart)[];              // ≤ 256 parts
}
TextPart  = { type: 'text'; text: string;
              untrusted?: boolean;                 // web content: page text, selections
              source?: { url?, title?, tabId? } }
ImagePart = { type: 'image'; mimeType: 'image/png' | 'image/jpeg';
              data: string;                        // base64, standard alphabet, padded
              untrusted?: boolean;                 // e.g. a capture of a web page
              source?: { url?, title?, tabId? } }
```

- The MCP client maps `TextPart` to MCP text content and `ImagePart` to MCP image content. Untrusted images get a text notice right before them (an image can't be fenced like text).
- Images make big messages; `encodeForWire` chunks them like anything else (see Chunking), and the whole result must still fit in 32 Mi characters of JSON.
- **Receivers skip content parts whose `type` they don't know** (a lowercase name), so new part types aren't breaking. Parts of a known type must still be valid. `ImagePart` is new in `@browsersweet/mcp` 0.1.0: hosts older than that (`hello.ack.host.version` < 0.1.0) reject a result containing one, so check the host version before sending images. (No 0.0.x release was published to npm.)

- **Host → extension `tools.cancel`** `{ type, id }`: the caller gave up (timeout, client left). Best effort; a late `tools.result` is ignored.
- At most 32 calls are in flight per host; more get `busy`.

### Other messages

| Direction  | Message                                         | Meaning                                                                                                                                                                                          |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ext → host | `{ type: 'event', event, data? }`               | `profile.focused` (a window of this profile gained focus; drives the default profile), `handoffs.changed` (Send to agent / revoke). Forwarded to MCP clients. Names: `^[a-z][a-z0-9_.-]{0,63}$`. |
| host → ext | `{ type: 'host.status', clients, clientList? }` | The connected MCP clients, for the Labs status indicator. Sent when a client connects, disconnects or reports its identity. See [Connected clients](#connected-clients).                         |
| ext → host | `{ type: 'clients.disconnect', clientId }`      | Disconnect one MCP client (the user clicked "Disconnect"). See [Connected clients](#connected-clients).                                                                                          |
| both       | `{ type: 'ping', id }` / `{ type: 'pong', id }` | Liveness. Answer a ping with a pong.                                                                                                                                                             |
| both       | `{ type: 'error', error }`                      | A notice (e.g. the extension is about to disconnect because the flag was turned off).                                                                                                            |

### Connected clients

`host.status` always has `clients`, the number of connected MCP clients. Hosts from `@browsersweet/mcp` 0.1.0 on also send `clientList` (in connection order, `clientList.length === clients`):

```ts
clientList?: {
  id: string;          // host-assigned, unique for the host's lifetime; pass it to clients.disconnect
  name: string;        // the MCP client's clientInfo.name from `initialize`, e.g. "claude-code"
  version: string;     // its clientInfo.version
  connectedAt: number; // epoch ms
}[];                   // ≤ 64 entries
```

- `name`/`version` come from the MCP `initialize` request, which can arrive after the socket connected; until then (and for local tools that aren't MCP clients) they are the socket client's own, e.g. `@browsersweet/mcp`. The host sends a new `host.status` when they change. `name` is written by whatever program connected: show it as text, don't trust it.
- **`{ type: 'clients.disconnect', clientId }`** asks the host to close that client's socket. The host first sends it an `error` with code `disconnected`; clients from this package then don't reconnect to that host. A new host (the extension reconnects its port, e.g. Agent integration is turned off and on) accepts them again. Unknown ids are ignored. Any same-user program can still connect with the token (see the README's threat model), so this is a convenience, not an access control.
- Both are additive. Extensions that only read `clients` keep working (`clientList` is stripped like any unknown field), and a host that doesn't send `clientList` predates `clients.disconnect` and ignores it as an unknown type. So: offer "Disconnect" only for hosts that send `clientList`.

### Chunking (both directions)

Chrome caps a host → extension message at 1 MiB, and big page text or captures flow the other way. Rule: **if a message's UTF-8 JSON exceeds 900 000 bytes, send it as `chunk` messages** (`encodeForWire(message)` does this):

```json
{
  "type": "chunk",
  "id": "<set id>",
  "seq": 0,
  "total": 5,
  "data": "<slice of the JSON text>"
}
```

- `data` is a slice of `JSON.stringify(message)` of at most 262 144 UTF-16 code units, never splitting a surrogate pair. Concatenating `data` for `seq` 0…total−1 and parsing gives the original message, which is then validated as usual.
- Limits: `total` 2–128, reassembled text ≤ 32 Mi code units, ≤ 8 incomplete sets per receiver, an incomplete set is dropped after 30 s. Duplicates, inconsistent `total` or out-of-range `seq` drop the set. `ChunkAssembler` implements the receiving side.
- Frames from the extension larger than 4 MiB are rejected (and close the link), so always chunk.

### Lifetime

The host lives exactly as long as the port. When the extension disconnects (or the browser quits) the host removes its socket and exits. Reconnect with backoff; if `connectNative` fails with "native messaging host not found", show "not installed" and the install command.

## 3. What the extension must do

1. Request the optional `nativeMessaging` permission when Labs → Agent integration is turned on; register nothing while it's off.
2. Connect, send `hello`, wait for `hello.ack`, send `tools.list` (from `mcpTools(registry)`; add `annotations.untrustedOutput: true` to `get_page_text`).
3. Answer `tools.call` by dispatching the registry command with `source: 'mcp'`; return `{ data }` per §5; put page text in a `content` part with `untrusted: true` and `source`; return `permission_required` when site access is missing.
4. Send `event: profile.focused` on `windows.onFocusChanged` (not `WINDOW_ID_NONE`) and `handoffs.changed` when handoffs change.
5. Chunk outgoing messages with `encodeForWire`, reassemble incoming `chunk`s with `ChunkAssembler`.
6. Show connection state from the port and `host.status`, including who is connected (`clientList`), and offer to disconnect one with `clients.disconnect`.
7. Have a stable id: the dev build sets a manifest `key` (see the README), and store ids are passed to `install --extension-id`.

## 4. Socket link: host ↔ MCP client mode

Internal to this package, documented for other local tools.

- **Where:** one socket per host, i.e. per browser profile, named `<16 hex>.sock`, next to a discovery record `<16 hex>.json` (mode 0600) in a private directory (mode 0700, owned by the user): `$XDG_RUNTIME_DIR/browsersweet` on Linux (fallbacks `/run/user/<uid>/browsersweet`, `/tmp/browsersweet-<uid>`), `~/Library/Application Support/BrowserSweet/run` on macOS (fallback `$TMPDIR/browsersweet` when the path is too long for a socket), `%LOCALAPPDATA%\BrowserSweet\run` on Windows with a named pipe `\\.\pipe\browsersweet-bridge-<SID>-<16 hex>`. `BROWSERSWEET_MCP_RUN_DIR` overrides the directory.
- **Trust:** the host refuses a run directory it doesn't own (`ensurePrivateDir`). Clients MUST check before reading a record or connecting, since `/tmp` fallbacks can be pre-created by another local user: the directory is not a symlink, is owned by the client's uid and has no group/other permission bits; each record file is not a symlink, owned by the uid and not group/world-writable; the record's `endpoint` is directly inside that directory (no `..`) and is a socket owned by the uid, not a symlink. Skip anything else. A `pid` that answers `kill(pid, 0)` with EPERM belongs to another user and is never a live host. On Windows the directory is under the profile's `%LOCALAPPDATA%` (its ACL keeps other users out) and `endpoint` must be a `\\.\pipe\browsersweet-bridge-…` pipe. `readTrustedRecords` implements this; `doctor` reports violations as failures.
- **Record:** `{ v: 1, pid, startedAt, endpoint, token, browser, profile, extension }`. `token` is 32 random bytes (hex).
- **Framing:** the same 4-byte little-endian length prefix; no chunking (frames ≤ 1 MiB client → host, ≤ 40 MiB host → client).
- **Handshake:** the client sends `client.hello { protocolVersion, minProtocolVersion?, token, client: { name, version }, mcpClient?: { name, version } }` within 5 s. `client` is the socket client itself; `mcpClient` is the MCP client it serves (`clientInfo` from `initialize`), when known. If it learns it later, it sends `client.info { mcpClient }` (hosts before 0.1.0 ignore it). These become `host.status.clientList` entries. A wrong token, or anything else first, closes the connection **without the host writing a byte**. The host answers `host.hello { protocolVersion, state }`.
- `HostState = { pid, startedAt, hostVersion, protocolVersion, extension, browser, profile, lastFocusedAt?, tools }`, re-sent as `host.state` whenever tools or focus change.
- Calls: client `tools.call { id, name, arguments, timeoutMs? }` → host `tools.result { id, result | error }`. The host re-numbers ids toward the extension, enforces the timeout (answers `timeout` and sends `tools.cancel`), and answers `unavailable` if the browser disconnects mid-call. Events are forwarded as `event`. `ping`/`pong` as above.

## 5. v1 tool results (`data`)

Shapes in `src/protocol/workspace.ts` (all extra fields allowed):

| Tool             | Suggested input                                | `data`                                                                                                                                                                           |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_spaces`    | `{}`                                           | `{ spaces: SpaceInfo[], activeSpaceId? }`; `SpaceInfo = { id, name, color?, emoji?, keptCount, tabCount }`                                                                       |
| `get_kept_tree`  | `{ spaceId? }`                                 | `{ space: { id, name }, favorites: KeptItemNode[], tree: KeptNode[] }`; items `{ type: 'item', id, title, url, open, tabId? }`, folders `{ type: 'folder', id, name, children }` |
| `list_tabs`      | `{ spaceId?, windowId? }`                      | `{ tabs: TabInfo[] }`; `TabInfo = { tabId, windowId, url?, title?, kind: 'kept'\|'favorite'\|'today', spaceId?, active, pinned?, audible?, discarded?, openedAt?, siteAccess? }` |
| `get_active_tab` | `{}`                                           | `{ tab?: TabInfo }`: the active tab of the **last-focused normal window** of the focused profile (see below)                                                                     |
| `search_archive` | `{ query?, since?, until?, spaceId?, limit? }` | `{ entries: { id, url, title, archivedAt, reason, space? }[], truncated? }`, newest first                                                                                        |
| `get_handoffs`   | `{}`                                           | `{ handoffs: { id, kind: 'tab'\|'selection'\|'capture'\|'space'\|'folder', title, createdAt, url?, text?, items? }[] }`                                                          |
| `get_page_text`  | `{ tabId? }`                                   | `{ tabId, url?, title?, length, truncated }` + the text as an untrusted `content` part                                                                                           |

**`get_active_tab`** answers with the active tab in the profile's last-focused normal window (`chrome.windows.getLastFocused({ windowTypes: ['normal'] })`), whether or not the browser has focus now: an agent usually runs in a terminal or another app, so the browser is rarely focused when it asks. `tab` is absent only when the profile has no normal window (popups, app and devtools windows don't count). Which profile answers is the client's usual default, the most recently focused one (`profile.focused`, §2).

Times are epoch milliseconds. The client always labels `get_page_text` and `get_handoffs` output as untrusted, whatever the extension sends.

## 6. Compatibility notes

- **0.1.0** (protocol 1, additive): `host.status.clientList` and `clients.disconnect`; `client.hello.mcpClient` and `client.info` on the socket; the `disconnected` error code; `ImagePart` and skipping unknown content part types; `get_active_tab` uses the last-focused normal window instead of requiring focus.
- Each addition is optional and ignored by older peers, so `PROTOCOL_VERSION` stays 1. The exception to watch is `ImagePart` toward a pre-0.1.0 host (see §2, Calls).
