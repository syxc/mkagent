/** Bind Coding SDK MCP results to durable registrations and host progress. */
import type { Tool as McpTool } from '@earendil-works/pi-mcp';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import type { Context, JsonValue } from '@earendil-works/chord';
import { convertMcpResult, createMcpResultSchema, toModelContent } from '@mkagent/coding-runtime/mcp-tools';
import type { McpExposure } from './mcp-servers.ts';
import type { McpServerConnection } from './runtime.ts';

export {
  MCP_OUTPUT_MAX_BYTES, convertMcpResult, createMcpResultSchema, createMcpToolName,
  limitMcpContent, saveToTempFile, toModelContent,
} from '@mkagent/coding-runtime/mcp-tools';
export type LlmBlock = Awaited<ReturnType<typeof toModelContent>>[number];
export type McpResultConversion = Awaited<ReturnType<typeof convertMcpResult>>;

/** Tool schemas must be objects; some providers also require `properties`. */
function toParameters(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schema,
    type: schema.type ?? 'object',
    ...(schema.properties === undefined ? { properties: {} } : {}),
  };
}

/** Keep hidden and codemode-only tools outside the durable model loadout. */
export function toDurableVisibility(exposure: McpExposure): Pick<ToolRegistration, 'callers' | 'deferred'> {
  switch (exposure) {
    case 'direct':
      return {};
    case 'deferred':
      return { deferred: true };
    case 'codemode':
      return { callers: ['tools'] };
    case 'hidden':
      return { callers: [] };
  }
}

export interface McpToolDefinitionOptions {
  server: string;
  tool: McpTool;
  name: string;
  exposure: McpExposure;
  timeoutMs: number | undefined;
  /** Resolves the live connection at execution time, so reconnects and withdrawals apply. */
  getClient: () => Promise<McpServerConnection>;
  readableResources?: () => boolean;
}

export function createMcpToolDefinition(options: McpToolDefinitionOptions): ToolRegistration {
  const { server, tool } = options;
  const title = tool.title ?? tool.annotations?.title;
  const description = tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`;
  return {
    name: options.name,
    description,
    parameters: toParameters(tool.inputSchema),
    structuredOutputSchema: createMcpResultSchema(tool.outputSchema),
    ...toDurableVisibility(options.exposure),
    async execute(args, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
      const client = await options.getClient();
      const result = await client.callTool(tool.name, (args ?? {}) as Record<string, unknown>, {
        signal: context.abortSignal,
        timeoutMs: options.timeoutMs,
        onProgress: progress => {
          const total = progress.total === undefined ? '' : `/${progress.total}`;
          const text = progress.message ?? `Progress ${progress.progress}${total}`;
          api.output(text);
        },
      });
      const converted = await convertMcpResult(server, tool.name, result, {
        readableResources: options.readableResources?.(),
      });
      const output: ToolResultMessage['content'] = converted.content;
      return {
        output,
        structuredOutput: converted.structuredContent as unknown as JsonValue,
        ...(converted.isError ? { isError: true } : {}),
        details: { ...converted.details },
      };
    },
  };
}
