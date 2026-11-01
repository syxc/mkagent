/**
 * ls tool.
 *
 * Vendored 1:1 from @earendil-works/pi-coding-agent 1.1.0 core/tools/ls.js —
 * behavior must stay identical. Adapted to the durable `ToolRegistration`
 * shape: TUI renderers and the operations injection (used only by upstream's
 * own tests) are dropped.
 */
import { readdir as fsReaddir, stat as fsStat } from 'node:fs/promises';
import nodePath from 'node:path';
import { Type } from 'typebox';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { pathExists, resolveToCwd } from './path-utils.ts';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from './truncate.ts';

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: 'Directory to list (default: current directory)' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of entries to return (default: 500)' })),
});

const DEFAULT_LIMIT = 500;

export function createLsTool(cwd: string): ToolRegistration<typeof lsSchema> {
  return defineTool({
    name: 'ls',
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: lsSchema,
    async execute({ path: dirArg, limit }, _api, context) {
      const signal = context.abortSignal ?? undefined;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Operation aborted'));
          return;
        }
        const onAbort = () => reject(new Error('Operation aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        (async () => {
          try {
            const dirPath = resolveToCwd(dirArg || '.', cwd);
            const effectiveLimit = limit ?? DEFAULT_LIMIT;
            // Check if path exists.
            if (!(await pathExists(dirPath))) {
              reject(new Error(`Path not found: ${dirPath}`));
              return;
            }
            // Check if path is a directory.
            const stat = await fsStat(dirPath);
            if (!stat.isDirectory()) {
              reject(new Error(`Not a directory: ${dirPath}`));
              return;
            }
            // Read directory entries.
            let entries: string[];
            try {
              entries = await fsReaddir(dirPath);
            } catch (e) {
              reject(new Error(`Cannot read directory: ${e instanceof Error ? e.message : String(e)}`));
              return;
            }
            // Sort alphabetically, case-insensitive.
            entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            // Format entries with directory indicators.
            const results: string[] = [];
            let entryLimitReached = false;
            for (const entry of entries) {
              if (results.length >= effectiveLimit) {
                entryLimitReached = true;
                break;
              }
              const fullPath = nodePath.join(dirPath, entry);
              let suffix = '';
              try {
                const entryStat = await fsStat(fullPath);
                if (entryStat.isDirectory()) suffix = '/';
              } catch {
                // Skip entries we cannot stat.
                continue;
              }
              results.push(entry + suffix);
            }
            signal?.removeEventListener('abort', onAbort);
            if (results.length === 0) {
              resolve({ output: [{ type: 'text' as const, text: '(empty directory)' }] });
              return;
            }
            const rawOutput = results.join('\n');
            // Apply byte truncation. There is no separate line limit because entry count is already capped.
            const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
            let output = truncation.content;
            const details: Record<string, unknown> = {};
            // Build actionable notices for truncation and entry limits.
            const notices: string[] = [];
            if (entryLimitReached) {
              notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
              details.entryLimitReached = effectiveLimit;
            }
            if (truncation.truncated) {
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
              details.truncation = truncation;
            }
            if (notices.length > 0) {
              output += `\n\n[${notices.join('. ')}]`;
            }
            resolve({
              output: [{ type: 'text' as const, text: output }],
              ...(Object.keys(details).length > 0 ? { details: details as never } : {}),
            });
          } catch (e) {
            signal?.removeEventListener('abort', onAbort);
            reject(e);
          }
        })();
      });
    },
  });
}
