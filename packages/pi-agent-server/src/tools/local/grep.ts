/**
 * grep tool.
 *
 * Vendored 1:1 from @earendil-works/pi-coding-agent 1.1.0 core/tools/grep.js —
 * behavior must stay identical. Adapted to the durable `ToolRegistration`
 * shape: TUI renderers and the operations injection (used only by upstream's
 * own tests) are dropped, and the binary resolves from PATH instead of
 * ensureTool's GitHub download.
 */
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Type } from 'typebox';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { resolveToCwd } from './path-utils.ts';
import { resolveRipgrep } from './tool-binaries.ts';
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from './truncate.ts';

const DEFAULT_LIMIT = 100;

const grepSchema = Type.Object({
  pattern: Type.String({ description: 'Search pattern (regex or literal string)' }),
  path: Type.Optional(Type.String({ description: 'Directory or file to search (default: current directory)' })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search (default: false)' })),
  literal: Type.Optional(Type.Boolean({ description: 'Treat pattern as literal string instead of regex (default: false)' })),
  context: Type.Optional(Type.Number({ description: 'Number of lines to show before and after each match (default: 0)' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of matches to return (default: 100)' })),
});

interface RipgrepMatchEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

export function createGrepTool(cwd: string): ToolRegistration<typeof grepSchema> {
  return defineTool({
    name: 'grep',
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: grepSchema,
    async execute({ pattern, path: searchDir, glob, ignoreCase, literal, context: contextOption, limit }, _api, context) {
      const signal = context.abortSignal ?? undefined;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Operation aborted'));
          return;
        }
        let settled = false;
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };
        (async () => {
          try {
            const rgPath = resolveRipgrep();
            if (!rgPath) {
              settle(() => reject(new Error('ripgrep (rg) is not available on PATH')));
              return;
            }
            const searchPath = resolveToCwd(searchDir || '.', cwd);
            let isDirectory: boolean;
            try {
              isDirectory = (await fsStat(searchPath)).isDirectory();
            } catch {
              settle(() => reject(new Error(`Path not found: ${searchPath}`)));
              return;
            }
            const contextValue = contextOption && contextOption > 0 ? contextOption : 0;
            const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
            const formatPath = (filePath: string) => {
              if (isDirectory) {
                const relative = path.relative(searchPath, filePath);
                if (relative && !relative.startsWith('..')) {
                  return relative.replace(/\\/g, '/');
                }
              }
              return path.basename(filePath);
            };
            const fileCache = new Map<string, string[]>();
            const getFileLines = async (filePath: string): Promise<string[]> => {
              let lines = fileCache.get(filePath);
              if (!lines) {
                try {
                  const content = await fsReadFile(filePath, 'utf-8');
                  lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
                } catch {
                  lines = [];
                }
                fileCache.set(filePath, lines);
              }
              return lines;
            };
            const args = ['--json', '--line-number', '--color=never', '--hidden'];
            if (ignoreCase) args.push('--ignore-case');
            if (literal) args.push('--fixed-strings');
            if (glob) args.push('--glob', glob);
            args.push('--', pattern, searchPath);
            const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const rl = createInterface({ input: child.stdout });
            let stderr = '';
            let matchCount = 0;
            let matchLimitReached = false;
            let linesTruncated = false;
            let aborted = false;
            let killedDueToLimit = false;
            const outputLines: string[] = [];
            const cleanup = () => {
              rl.close();
              signal?.removeEventListener('abort', onAbort);
            };
            const stopChild = (dueToLimit = false) => {
              if (!child.killed) {
                killedDueToLimit = dueToLimit;
                child.kill();
              }
            };
            const onAbort = () => {
              aborted = true;
              stopChild();
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            child.stderr?.on('data', (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
              const relativePath = formatPath(filePath);
              const lines = await getFileLines(filePath);
              if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
              const block: string[] = [];
              const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
              const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
              for (let current = start; current <= end; current++) {
                const lineText = lines[current - 1] ?? '';
                const sanitized = lineText.replace(/\r/g, '');
                const isMatchLine = current === lineNumber;
                // Truncate long lines so grep output stays compact.
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                if (wasTruncated) linesTruncated = true;
                if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
                else block.push(`${relativePath}-${current}- ${truncatedText}`);
              }
              return block;
            };
            // Collect matches during streaming, then format them after rg exits.
            const matches: Array<{ filePath: string; lineNumber: number; lineText: string | undefined }> = [];
            rl.on('line', (line: string) => {
              if (!line.trim() || matchCount >= effectiveLimit) return;
              let event: RipgrepMatchEvent;
              try {
                event = JSON.parse(line) as RipgrepMatchEvent;
              } catch {
                return;
              }
              if (event.type === 'match') {
                matchCount++;
                const filePath = event.data?.path?.text;
                const lineNumber = event.data?.line_number;
                const lineText = event.data?.lines?.text;
                if (filePath && typeof lineNumber === 'number') matches.push({ filePath, lineNumber, lineText });
                if (matchCount >= effectiveLimit) {
                  matchLimitReached = true;
                  stopChild(true);
                }
              }
            });
            child.on('error', (error: Error) => {
              cleanup();
              settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
            });
            child.on('close', async (code: number | null) => {
              cleanup();
              if (aborted) {
                settle(() => reject(new Error('Operation aborted')));
                return;
              }
              if (!killedDueToLimit && code !== 0 && code !== 1) {
                const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
                settle(() => reject(new Error(errorMsg)));
                return;
              }
              if (matchCount === 0) {
                settle(() => resolve({ output: [{ type: 'text' as const, text: 'No matches found' }] }));
                return;
              }
              // Format matches after streaming finishes so custom readFile() backends can be async.
              for (const match of matches) {
                if (contextValue === 0 && match.lineText !== undefined) {
                  const relativePath = formatPath(match.filePath);
                  const sanitized = match.lineText
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '')
                    .replace(/\n$/, '');
                  const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                  if (wasTruncated) linesTruncated = true;
                  outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
                } else {
                  const block = await formatBlock(match.filePath, match.lineNumber);
                  outputLines.push(...block);
                }
              }
              const rawOutput = outputLines.join('\n');
              // Apply byte truncation. There is no line limit here because the match limit already capped rows.
              const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
              let output = truncation.content;
              const details: Record<string, unknown> = {};
              // Build actionable notices for truncation and match limits.
              const notices: string[] = [];
              if (matchLimitReached) {
                notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
                details.matchLimitReached = effectiveLimit;
              }
              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
              }
              if (linesTruncated) {
                notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
                details.linesTruncated = true;
              }
              if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
              settle(() => resolve({
                output: [{ type: 'text' as const, text: output }],
                ...(Object.keys(details).length > 0 ? { details: details as never } : {}),
              }));
            });
          } catch (err) {
            settle(() => reject(err));
          }
        })();
      });
    },
  });
}
