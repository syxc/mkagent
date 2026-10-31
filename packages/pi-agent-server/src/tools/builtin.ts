/**
 * Builtin tool set for the durable kernel.
 *
 * `read`/`write`/`edit`/`bash` come from durable's `coding-tools` extension
 * (env-backed, abort-aware, output windows). `grep`/`find`/`ls` have no
 * durable equivalent, so their pi-coding-agent 1.1.0 implementations are
 * adapted to `ToolRegistration`: behavior-identical local implementations,
 * reused verbatim instead of reimplemented.
 */
import type { ToolRegistration } from '@earendil-works/pi-durable';
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent';
import {
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { defineTool } from '@earendil-works/pi-durable';

/** pi-coding-agent 1.1.0 tool results carry `{content, details?, isError?}`. */
function toDurableResult(result: AgentToolResult<unknown>) {
  return {
    output: result.content,
    ...(result.isError ? { isError: true } : {}),
    ...(result.details !== undefined ? { details: result.details as never } : {}),
  };
}

/** Adapt one pi-coding-agent tool definition to a durable tool registration. */
export function adaptToolDefinition(def: ToolDefinition<any, any>, cwd: string): ToolRegistration {
  return defineTool({
    name: def.name,
    description: def.description,
    parameters: def.parameters as never,
    execute: async (args, api, context) => {
      const result = await def.execute(
        api.callId,
        args,
        context.abortSignal ?? undefined,
        undefined,
        // The only ctx use in grep/find/ls is the optional `ctx?.cwd` fallback.
        { cwd } as never,
      );
      return toDurableResult(result);
    },
  });
}

/**
 * All builtin coding tools, unwrapped. The caller wraps them with permission
 * hooks and registers them on the kernel extension.
 */
export function createBuiltinTools(cwd: string): ToolRegistration[] {
  const codingTools = CodingTools.tools ?? [];
  return [
    ...codingTools,
    adaptToolDefinition(createGrepToolDefinition(cwd), cwd),
    adaptToolDefinition(createFindToolDefinition(cwd), cwd),
    adaptToolDefinition(createLsToolDefinition(cwd), cwd),
  ];
}
