/** Use SDK configuration algorithms; the server owns its credential and exposure policy. */
export {
  LIST_MCP_RESOURCES_TOOL, LIST_MCP_RESOURCE_TEMPLATES_TOOL, READ_MCP_RESOURCE_TOOL,
  getMcpToolExposure, mcpNamespace, validateMcpServerConfig,
} from '@earendil-works/pi-coding-agent';
export type {
  McpExposure, McpHttpServerConfig, McpServerConfig, McpServerEntry, McpStdioServerConfig,
} from '@earendil-works/pi-coding-agent';
