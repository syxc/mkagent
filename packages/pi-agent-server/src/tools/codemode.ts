/**
 * The codemode tool for the kernel: pi-durable's built-in code mode extension, bound to the Node
 * sandbox from `@earendil-works/pi-durable/codemode/node`. Scripts call the conversation's callable tools as
 * `tools.<name>(args)`; MCP servers reach them through the namespaces passed here.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Extension } from '@earendil-works/pi-durable';
import { createCodemodeExtension, type CodemodeNamespace } from '@earendil-works/pi-durable/codemode';
import { CodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-durable/codemode/node';

/** Create the codemode extension with the given tool namespaces (MCP servers, if any). */
export function createCodemodeExtensionFor(
  namespaces: readonly CodemodeNamespace[] = [],
  approve?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<Record<string, unknown>>,
): Extension {
  const workerUrl = new URL('./codemode-worker.js', import.meta.url);
  const wasmUrl = new URL('./quickjs.wasm', import.meta.url);
  const sandbox = existsSync(workerUrl) && existsSync(wasmUrl)
    ? new CodemodeSandbox({ workerUrl, wasm: loadQuickJSWasm(fileURLToPath(wasmUrl)) })
    : new CodemodeSandbox();
  const extension = createCodemodeExtension({ sandbox, namespaces });
  if (!approve) return extension;
  return {
    ...extension,
    tools: extension.tools?.map(tool => {
      if (!tool.name.startsWith('pi.codemode.models.')) return tool;
      return {
        ...tool,
        execute: async (args, api, context) => {
          const approved = await approve(tool.name, args as Record<string, unknown>, api.callId);
          return tool.execute(approved, api, context);
        },
      };
    }),
  };
}
