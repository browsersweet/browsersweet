/**
 * `@browsersweet/mcp/protocol`: the wire protocol between the Browser Sweet extension, the
 * native messaging host and the MCP client mode. Isomorphic (zod + web globals only).
 * See PROTOCOL.md in the package.
 */
export * from './constants.js';
export * from './common.js';
export * from './chunking.js';
export * from './tools.js';
export * from './native.js';
export * from './socket.js';
export * from './workspace.js';
