/**
 * Constants shared by the host, the client and the extension. Everything in `src/protocol` is
 * isomorphic: it depends only on `zod` and web-standard globals (`TextEncoder`, `crypto`), so the
 * extension can import `@browsersweet/mcp/protocol` directly.
 */

/** Native messaging host name (`chrome.runtime.connectNative(NATIVE_HOST_NAME)`). */
export const NATIVE_HOST_NAME = 'com.browsersweet.bridge';

/** The protocol version this package speaks. Bumped only for incompatible changes. */
export const PROTOCOL_VERSION = 1;
/** The oldest protocol version this package still accepts. */
export const MIN_PROTOCOL_VERSION = 1;

/** Chrome caps a single host → extension native message at 1 MiB. */
export const NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024;
/** Inbound (extension → host) frames larger than this are rejected; big payloads must be chunked. */
export const NATIVE_INBOUND_MAX_BYTES = 4 * 1024 * 1024;
/** Messages whose UTF-8 JSON exceeds this are sent as `chunk` messages instead. */
export const CHUNK_THRESHOLD_BYTES = 900_000;
/**
 * UTF-16 code units of JSON text per chunk. Re-encoded inside a chunk message, one code unit is
 * at most 3 UTF-8 bytes, so a chunk frame stays under 800 KB.
 */
export const CHUNK_DATA_MAX_CHARS = 256 * 1024;
/** Largest reassembled message (in UTF-16 code units of JSON text). */
export const MAX_ASSEMBLED_CHARS = 32 * 1024 * 1024;
/** Most chunks in one set. */
export const MAX_CHUNKS = Math.ceil(MAX_ASSEMBLED_CHARS / CHUNK_DATA_MAX_CHARS);
/** Most incomplete chunk sets a receiver holds at once. */
export const MAX_PENDING_CHUNK_SETS = 8;
/** An incomplete chunk set is dropped after this long. */
export const CHUNK_SET_TTL_MS = 30_000;

/** Socket frames (host ↔ client). No browser cap applies; this only bounds memory. */
export const SOCKET_MAX_FRAME_BYTES = 40 * 1024 * 1024;
/** Client → host socket frames are small (calls only). */
export const SOCKET_CLIENT_MAX_FRAME_BYTES = 1024 * 1024;

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const MAX_CALL_TIMEOUT_MS = 120_000;
/** Most concurrent in-flight tool calls per host. */
export const MAX_IN_FLIGHT_CALLS = 32;
export const MAX_TOOLS = 128;
/** Serialized size limits. */
export const MAX_ARGUMENTS_BYTES = 256 * 1024;
export const MAX_INPUT_SCHEMA_BYTES = 64 * 1024;
/** Upper bound for small protocol integers (versions). */
export const MAX_PROTOCOL_INT = 1_000_000;
