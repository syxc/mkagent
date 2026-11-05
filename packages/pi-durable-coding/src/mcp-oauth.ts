/** Fixed upstream MCP authorization without the CLI or its execution loop. */
export {
  McpOAuthCredentialStore, McpSignInCancelledError, createMcpAuthProvider, signInMcpServer,
} from './pi/extensions/mcp/oauth.ts';
export type {
  McpAuthProvider, McpOAuthServerStore, McpOAuthSettings, McpSignInPrompt,
} from './pi/extensions/mcp/oauth.ts';
export { FileAuthStorageBackend, InMemoryAuthStorageBackend } from './pi/core/auth-storage.ts';
export type { McpOAuthConfig } from './pi/core/mcp-servers.ts';
export { McpOAuthAuthorizationRequiredError } from '@earendil-works/pi-mcp/oauth';
export type { OAuthChallenge } from '@earendil-works/pi-mcp/oauth';
