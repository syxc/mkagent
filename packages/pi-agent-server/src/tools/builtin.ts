/**
 * Builtin tool set for the durable kernel.
 *
 * `read`/`write`/`edit`/`bash` come from durable's `coding-tools` extension
 * (env-backed, abort-aware, output windows). `grep`/`find`/`ls` have no
 * durable equivalent: their pi-coding-agent 1.1.0 implementations are vendored
 * 1:1 under `local/` and exported as durable tools here.
 */
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { createFindTool } from './local/find.ts';
import { createGrepTool } from './local/grep.ts';
import { createLsTool } from './local/ls.ts';

/**
 * All builtin coding tools, unwrapped. The caller wraps them with permission
 * hooks and registers them on the kernel extension.
 */
export function createBuiltinTools(cwd: string): ToolRegistration[] {
  return [
    ...(CodingTools.tools ?? []),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}
