/**
 * Creates a `web_search` durable tool registration backed by the given search provider.
 *
 * The tool name is always `web_search` regardless of the underlying provider,
 * so the model doesn't need to know which backend is used.
 */

import { num, obj, opt, str } from '@earendil-works/pi-schema';
import { defineTool } from '@earendil-works/pi-durable';
import type { WebSearchProvider, WebSearchResult } from './types.ts';
import { DDGSearchProvider } from './providers/ddg.ts';

const schema = obj({
  query: str({ description: 'The search query' }),
  count: opt(
    num({
      description: 'Max results (1-10, default 5)',
      minimum: 1,
      maximum: 10,
    }),
  ),
}, { open: true });

function formatResults(
  query: string,
  providerName: string,
  results: WebSearchResult[],
  note?: string,
) {
  const formatted = results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`,
    )
    .join('\n\n');

  const noteText = note ? `${note}\n\n` : '';

  return {
    output: [
      {
        type: 'text' as const,
        text: `${noteText}Search results for "${query}" (via ${providerName}):\n\n${formatted}`,
      },
    ],
    details: {},
  };
}

function formatErrorSnippet(message: string, max = 180): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  if (!compact) return 'unknown error';
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export function createSearchTool(
  provider: WebSearchProvider,
  fallbackProvider: WebSearchProvider = new DDGSearchProvider(),
) {
  return defineTool({
    name: 'web_search',
    description:
      'Search the web for current information. Returns titles, URLs, and snippets. Use for current information, documentation lookups, or fact-checking.',
    parameters: schema,
    async execute(params, _api, context) {
      const { query } = params;
      const count = Math.max(1, Math.min(10, params.count ?? 5));
      const signal = context?.abortSignal ?? undefined;
      signal?.throwIfAborted();

      try {
        const results = await provider.search(query, count, signal);
        signal?.throwIfAborted();
        return formatResults(query, provider.name, results);
      } catch (err) {
        signal?.throwIfAborted();
        const primaryMsg = err instanceof Error ? err.message : String(err);

        const canFallback = provider.name !== fallbackProvider.name;
        if (canFallback) {
          try {
            const fallbackResults = await fallbackProvider.search(query, count, signal);
            signal?.throwIfAborted();
            return formatResults(
              query,
              fallbackProvider.name,
              fallbackResults,
              `Primary search provider (${provider.name}) failed (${formatErrorSnippet(primaryMsg)}), automatically fell back to ${fallbackProvider.name}.`,
            );
          } catch (fallbackErr) {
            signal?.throwIfAborted();
            const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            return {
              output: [
                {
                  type: 'text' as const,
                  text: `Search failed for "${query}": primary (${provider.name}) failed with "${formatErrorSnippet(primaryMsg, 400)}"; fallback (${fallbackProvider.name}) failed with "${formatErrorSnippet(fallbackMsg, 400)}"`,
                },
              ],
              details: {},
              isError: true,
            };
          }
        }

        return {
          output: [
            {
              type: 'text' as const,
              text: `Search failed for "${query}": ${formatErrorSnippet(primaryMsg, 400)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
}
