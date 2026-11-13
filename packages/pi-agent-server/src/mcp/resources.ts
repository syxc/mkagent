/** Bind SDK resource tools to durable execution and visibility. */
import { createMcpResourceToolDefinitions as sdkResources } from '@mkagent/coding-runtime/mcp-tools';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import { toDurableVisibility } from './tools.ts';

export { LIST_MCP_RESOURCE_TEMPLATES_TOOL, LIST_MCP_RESOURCES_TOOL, READ_MCP_RESOURCE_TOOL } from './mcp-servers.ts';
export { isMcpAppResource } from '@mkagent/coding-runtime/mcp-tools';
export type McpResourceToolOptions = Parameters<typeof sdkResources>[0];

export function createMcpResourceToolDefinitions(options: McpResourceToolOptions): ToolRegistration[] {
  const visibility = toDurableVisibility(options.exposure);
  return sdkResources(options).map(definition => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    structuredOutputSchema: definition.outputSchema,
    ...visibility,
    async execute(args, api, context) {
      const result = await definition.execute(api.callId, args as Record<string, unknown> | undefined, context.abortSignal);
      return {
        output: result.content,
        details: result.details as unknown as JsonValue,
        structuredOutput: result.structuredContent as JsonValue,
      };
    },
  }));
}
