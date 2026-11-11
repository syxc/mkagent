/** Fixed upstream MCP authorization without the CLI or its execution loop. */
export {
  McpOAuthCredentialStore, McpSignInCancelledError, createMcpAuthProvider, signInMcpServer,
} from '@earendil-works/pi-coding-agent';
export type {
  McpAuthProvider, McpOAuthServerStore, McpOAuthSettings, McpSignInPrompt,
} from '@earendil-works/pi-coding-agent';
export { FileAuthStorageBackend, InMemoryAuthStorageBackend } from '@earendil-works/pi-coding-agent';
export type { McpOAuthConfig } from '@earendil-works/pi-coding-agent';
export { McpOAuthAuthorizationRequiredError } from '@earendil-works/pi-mcp/oauth';
export type { OAuthChallenge } from '@earendil-works/pi-mcp/oauth';
