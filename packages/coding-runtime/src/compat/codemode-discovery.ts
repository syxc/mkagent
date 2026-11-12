import type { AgentTool } from "@earendil-works/pi-coding-agent";
import { renderToolSample, toCodemodeIdentifier, type CodemodeTool, type CodemodeGlobal } from "@earendil-works/pi-durable/codemode";
import type { ToolNamespace } from "@earendil-works/pi-coding-agent";
import { rankToolSearchDocuments, DEFAULT_TOOL_SEARCH_LIMIT } from "@earendil-works/pi-durable/tool-search";
import { createToolSearchDocument } from "../native-tool-search.ts";
import { toCodemodeDeclaration, type CodemodeToolOptions } from "../native-codemode.ts";

/**
 * Whether `query` names the namespace: its name or one of its aliases, as written or as the same
 * script identifier (`dev-radius` and `dev_radius` are both `dev_radius`).
 */
function isNamespaceName(namespace: ToolNamespace, query: string): boolean {
	const queryId = toCodemodeIdentifier(query);
	return [namespace.name, ...(namespace.aliases ?? [])].some(
		(name) => name === query || toCodemodeIdentifier(name) === queryId,
	);
}

/**
 * `searchTools()`, `describeTool()`, and `describeNamespace()`: ranked search and lookup over the
 * script's nested tools and their namespaces.
 */
export function createNativeCodemodeDiscovery(
	tools: readonly AgentTool<any>[],
	options: CodemodeToolOptions,
): {
	declarations: ReadonlyMap<string, Omit<CodemodeTool, "execute">>;
	samples: ReadonlyMap<string, string>;
	globals: CodemodeGlobal[];
} {
	const guidelines = options.getToolGuidelines?.();
	const declarations = new Map(tools.map(tool => [tool.name, toCodemodeDeclaration(tool, guidelines?.get(tool.name))]));
	const samples = new Map([...declarations].map(([name, declaration]) => [name, renderToolSample(declaration)]));
	const entry = (name: string) => ({ name: toCodemodeIdentifier(name), description: samples.get(name) ?? "" });
	const globals: CodemodeGlobal[] = [
		{
			name: "searchTools",
			spread: true,
			execute: async (args) => {
				const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
					throw new Error("searchTools() limit must be a positive integer");
				}
				const namespace = searchOptions?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
					throw new Error("searchTools() namespace must be a string");
				}
				const documents = tools.flatMap((tool) => {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (namespace && (!toolNamespace || !isNamespaceName(toolNamespace, namespace))) return [];
					return [createToolSearchDocument(tool, toolNamespace)];
				});
				return rankToolSearchDocuments(query, documents, limit).map((match) => entry(match.name));
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: async (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = tools.find(
					(candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
				);
				return tool ? samples.get(tool.name) : undefined;
			},
		},
		{
			name: "describeNamespace",
			spread: true,
			execute: async (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
				let namespace: ToolNamespace | undefined;
				const names: string[] = [];
				for (const tool of tools) {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (!toolNamespace || !isNamespaceName(toolNamespace, name)) continue;
					namespace ??= toolNamespace;
					names.push(toCodemodeIdentifier(tool.name));
				}
				if (!namespace) return undefined;
				return {
					name: namespace.name,
					...(namespace.description ? { description: namespace.description } : {}),
					...(namespace.instructions ? { instructions: namespace.instructions } : {}),
					tools: names,
				};
			},
		},
	];
	return { declarations, samples, globals };
}
