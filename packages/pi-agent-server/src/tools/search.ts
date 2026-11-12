/** Use the Coding SDK for search and the existing bridge for durable registrations. */
import { readFile, stat } from 'node:fs/promises';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { agentToolToHost, createFindTool, createGrepTool, createLsTool } from '@mkagent/coding-runtime/native';
import { resolveFd, resolveRipgrep } from './local/tool-binaries.ts';

export function createSearchTools(cwd: string): ToolRegistration[] {
  const factories = [
    (signal?: AbortSignal) => createGrepTool(cwd, {
      ensureTool: () => resolveRipgrep(signal),
      operations: {
        isDirectory: async path => (await stat(path)).isDirectory(),
        // Preserve the product tool's CR-only line splitting for context output.
        readFile: async path => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
      },
    }),
    (signal?: AbortSignal) => createFindTool(cwd, {
      ensureTool: () => resolveFd(undefined, signal),
    }),
    () => createLsTool(cwd),
  ];
  return factories.map((create): ToolRegistration => ({
    ...agentToolToHost(create()),
    // Bind the resolver to this call so concurrent calls keep their own signal.
    execute: (args, api, context) => agentToolToHost(create(context.abortSignal ?? undefined)).execute(args, api, context),
  }));
}
