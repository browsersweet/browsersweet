/**
 * `@browsersweet/mcp`: Browser Sweet's local MCP bridge. Most people use the CLI
 * (`npx @browsersweet/mcp install`, then `npx @browsersweet/mcp` as an MCP server); these exports
 * are for embedding and tests. The wire protocol is at `@browsersweet/mcp/protocol`.
 */
export {
  BridgeHost,
  type BridgeHostOptions,
  type Logger,
} from './host/host.js';
export { runHost } from './host/main.js';
export {
  createBridgeServer,
  runClient,
  NOT_CONNECTED_MESSAGE,
} from './client/server.js';
export {
  DiscoveryPool,
  type HostHandle,
  type HostSource,
} from './client/pool.js';
export { HostConnection } from './client/connection.js';
export { wrapUntrusted } from './client/untrusted.js';
export {
  planInstall,
  planUninstall,
  type InstallContext,
  type Plan,
} from './install/plan.js';
export { extensionIdFromKey } from './install/extension-id.js';
export { FrameDecoder, encodeFrame } from './native/framing.js';
