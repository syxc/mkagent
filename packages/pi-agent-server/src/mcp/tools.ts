/**
 * Adapts MCP tools to durable tool registrations.
 *
 * Results map onto pi's model-facing content (text and images). Text over 20KB keeps its start and
 * end with the middle cut out, like Codex does, and the full text is saved to a temp file the model
 * can read. Binary resources other than images are saved to temp files too, and resource links name
 * the `read_mcp_resource` tool. Codemode scripts receive the whole `CallToolResult` without `_meta`
 * (`content` blocks as sent by the server, `structuredContent`, `isError`), never truncated: it is
 * the tool's `structuredContent`, and every MCP tool declares a `CallToolResult` output schema. MCP
 * errors (`isError`) are error results for the model, but scripts still resolve to the result.
 *
 * Vendored from @earendil-works/pi-coding-agent 1.1.0 extensions/mcp/tools.js — behavior must stay
 * identical. Deviations: the pi-tui renderers are dropped (mkagent's UI renders tool calls its own
 * way), and the registration shape is durable's `ToolRegistration` instead of the coding agent's
 * `ToolDefinition` (no `label`/`annotations` fields there; visibility maps to `callers`/`deferred`).
 */
import { createHash } from 'node:crypto';
import { toLlmContent, type CallToolResult, type Tool as McpTool } from '@earendil-works/pi-mcp';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import type { Context, JsonValue } from '@earendil-works/chord';
import { READ_MCP_RESOURCE_TOOL, type McpExposure } from './mcp-servers.ts';
import { formatSize, truncateMiddle } from '../tools/local/truncate.ts';
import { writeOutputFile } from './output-files.ts';
import type { McpServerConnection } from './runtime.ts';

/** Model-facing text of an MCP result beyond this is cut in the middle. */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

export function saveToTempFile(data: string | Uint8Array, extension: string): Promise<string> {
  return writeOutputFile('pi-mcp', extension, data);
}

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. Like Codex,
 * everything but `[A-Za-z0-9_]` becomes `_`, so the name is also the identifier codemode scripts
 * call it by. `isTaken` reports names used by a different MCP tool: sanitizing can map two tools to
 * one name (`a-b` and `a_b`), which then get the hash suffix.
 */
export function createMcpToolName(server: string, tool: string, isTaken: (name: string) => boolean = () => false): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_');
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n');
}

/**
 * Output schema of every MCP tool: the `CallToolResult` scripts receive, with the tool's own output
 * schema as `structuredContent`. Codemode detects this shape to render `CallToolResult<T>`
 * declarations.
 */
export function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      content: { type: 'array', items: { type: 'object' } },
      ...(structuredContentSchema ? { structuredContent: structuredContentSchema } : {}),
      isError: { type: 'boolean' },
      _meta: { type: 'object' },
    },
    required: ['content'],
  };
}

/**
 * Keep model-facing text within {@link MCP_OUTPUT_MAX_BYTES}. Longer text becomes one text block in
 * Codex's truncation format, followed by the path of the file with the full text; images follow it.
 */
export async function limitMcpContent(
  content: LlmBlock[],
  saveOutput: typeof saveToTempFile = saveToTempFile,
): Promise<{ content: LlmBlock[]; fullOutputPath?: string }> {
  const combined = textOf(content);
  const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
  if (!truncation.truncated) return { content };
  let fullOutputPath: string | undefined;
  let where: string;
  try {
    fullOutputPath = await saveOutput(combined, '.txt');
    where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`;
  } catch (error) {
    where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
  }
  const tokens = Math.ceil(truncation.totalBytes / 4);
  const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`;
  return {
    content: [{ type: 'text', text }, ...content.filter(block => block.type === 'image')],
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}

/** Model-facing content block: text and base64 images, as `@earendil-works/pi-mcp` maps them. */
export type LlmBlock = ReturnType<typeof toLlmContent>[number];

/** File extension for a saved binary resource: the one its URI ends in, else `.bin`. */
function extensionOf(uri: string): string {
  const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
  return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? '.bin';
}

/** Blobs of these types are shown as text. */
function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const type = mimeType.split(';')[0]!.trim().toLowerCase();
  return type.startsWith('text/') || type === 'application/json' || type.endsWith('+json') || type.endsWith('+xml');
}

interface ContentOptions {
  readableResources?: boolean;
  saveOutput?: typeof saveToTempFile;
}

/** Model-facing content of one block of `server`'s result. */
async function blockToContent(server: string, block: CallToolResult['content'][number], options: ContentOptions): Promise<LlmBlock[]> {
  if (block.type === 'resource_link') {
    const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
    const read = options.readableResources ? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${server}")` : '';
    const description = block.description ? `: ${block.description}` : '';
    return [
      {
        type: 'text',
        text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(', ')})` : ''}${description}${read}]`,
      },
    ];
  }
  if (block.type === 'resource' && 'blob' in block.resource && !block.resource.mimeType?.startsWith('image/')) {
    const { uri, mimeType, blob } = block.resource;
    const data = Buffer.from(blob, 'base64');
    if (isTextMimeType(mimeType)) return [{ type: 'text', text: data.toString('utf8') }];
    const kind = `${mimeType ?? 'unknown type'}, ${formatSize(data.length)}`;
    try {
      const path = await (options.saveOutput ?? saveToTempFile)(data, extensionOf(uri));
      return [{ type: 'text', text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [{ type: 'text', text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` }];
    }
  }
  return toLlmContent({ content: [block] });
}

/** Model-facing content of `server`'s content blocks, before the output limit. */
export async function toModelContent(server: string, blocks: CallToolResult['content'], options: ContentOptions = {}): Promise<LlmBlock[]> {
  return (await Promise.all(blocks.map(block => blockToContent(server, block, options)))).flat();
}

export interface McpResultConversion {
  content: LlmBlock[];
  details: { server: string; tool: string; fullOutputPath?: string };
  structuredContent: Record<string, unknown>;
  isError?: true;
}

/** Convert an MCP result. `isError` results become error results that keep the structured result. */
export async function convertMcpResult(
  server: string,
  tool: string,
  result: CallToolResult,
  options: ContentOptions = {},
): Promise<McpResultConversion> {
  // Without content blocks, toLlmContent falls back to the structured content as JSON.
  const converted = result.content.length > 0 ? await toModelContent(server, result.content, options) : toLlmContent(result);
  if (result.isError && textOf(converted) === '') {
    converted.push({ type: 'text', text: `MCP tool ${server}/${tool} returned an error` });
  }
  const { content, fullOutputPath } = await limitMcpContent(converted, options.saveOutput);
  const { _meta: _ignored, ...scriptResult } = result;
  return {
    content,
    details: { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
    structuredContent: scriptResult,
    ...(result.isError ? { isError: true } : {}),
  };
}

/**
 * Tool input schemas must be objects. MCP servers may omit `type`, and some providers reject object
 * schemas without `properties`.
 */
function toParameters(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schema,
    type: schema.type ?? 'object',
    ...(schema.properties === undefined ? { properties: {} } : {}),
  };
}

/**
 * Model visibility of an MCP exposure, as durable's `ToolRegistration` expresses it: `direct` tools
 * are offered to the model; `codemode` tools are callable by scripts but never offered, and only
 * they are declared in the namespace section; `hidden` tools are unreachable, and the loader does
 * not register them (the empty `callers` keeps one built directly unreachable too); `deferred`
 * tools are callable by scripts and become model-visible only after `tool_search` loads them. The
 * harness builds that search list from model-callable tools, so `deferred` must not restrict
 * `callers`.
 */
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
  const registration: ToolRegistration = {
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
        details: converted.details,
      };
    },
  };
  return registration;
}
