import { createToolSearchText, createToolSearchTool, rankToolSearchDocuments, DEFAULT_TOOL_SEARCH_LIMIT, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
export { DEFAULT_TOOL_SEARCH_LIMIT, TOOL_SEARCH_TOOL_NAME, tokenizeToolSearch as tokenize } from "@earendil-works/pi-durable/tool-search";
export const TOOL_SEARCH_DESCRIPTION = createToolSearchTool().description;
/**
 * Tool discovery: a BM25 ranker over tool metadata, shared by `searchTools()` in codemode scripts and
 * the optional `tool_search` tool.
 *
 * `tool_search` searches tools that are not declared to
 * the model (`codemode` and `deferred` exposure) and loads the matches, so they are declared for the
 * next model call. Loading goes through the active tool set, so it is recorded in the transcript
 * like any other tool change and survives `/tree`, resume, and fork on that branch.
 */

import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
	ToolNamespace,
} from "@earendil-works/pi-coding-agent";

/** A tool as the ranker sees it: its name and the texts built by {@link createToolSearchDocument}. */
export interface ToolSearchDocument {
	name: string;
	/** Description, schema descriptions, and property names. */
	text: string;
	/** Name, description, and instructions of the tool's namespace. */
	namespaceText?: string;
}

export interface ToolSearchMatch {
	name: string;
	score: number;
}

/** Ranks tools for a query. BM25 today; a hybrid ranker with embeddings can replace it. */
export interface ToolRanker {
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

/**
 * Search text of a tool: the description and the schema descriptions and property names, and
 * separately the namespace name, description, and instructions. The ranker reads the name from `name`.
 */
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const namespaceText = namespace
		? [namespace.name, namespace.description ?? "", namespace.instructions ?? ""].join(" ")
		: "";
	return { name: tool.name, text: createToolSearchText(tool), namespaceText };
}

/**
 * Okapi BM25 over the description, with the name and the namespace as separate fields:
 * - a tool that matches more of the query's terms, in any field, ranks above one that matches
 *   fewer, whatever their scores: for `screenshot window`, a tool whose description has both words
 *   beats `window`, whose name has one;
 * - a query term in the name scores more than any number of mentions in the description;
 * - a tool whose whole local name is in the query (`app` in `peekaboo app` for
 *   `mcp__peekaboo__app`) gets a bonus worth one more match of every query term, so among tools
 *   matching as many terms it mostly wins over tools that only mention the words;
 * - a query that is exactly a tool's name ranks that tool first, before coverage.
 *
 * The description alone is length-normalized, so a long name or long namespace instructions do
 * not lower a tool's score. Ties keep document order.
 */
export class Bm25Ranker implements ToolRanker {
	private readonly k1: number;
	private readonly b: number;

	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}

	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		return rankToolSearchDocuments(query, documents, limit, { k1: this.k1, b: this.b });
	}
}

export const toolSearchSchema = Type.Object({
	query: Type.String({ description: "Search query for deferred tools." }),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` }),
	),
});

export type ToolSearchInput = Static<typeof toolSearchSchema>;

export interface ToolSearchResultTool {
	name: string;
	description: string;
}

export interface ToolSearchToolDetails {
	/** Tools loaded by this call. */
	loaded: string[];
}

export interface ToolSearchToolOptions {
	/**
	 * The session's tools. `tool_search` searches the tools that are not declared to the model and
	 * activates the matches. Without it, the tool finds nothing. An `ExtensionAPI` fits.
	 */
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}

/** Whether `tool_search` can load a tool with this exposure. */
function isSearchable(exposure: ToolExposure): boolean {
	return exposure === "codemode" || exposure === "deferred";
}

/**
 * Rank the searchable tools that are not active yet and activate the matches, so the next model
 * call declares them. Activation is recorded in the transcript like any tool change.
 */
function searchAndLoad(
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	query: string,
	limit: number,
): ToolSearchResultTool[] {
	const active = tools.getActiveTools();
	const candidates = tools.getAllTools().filter((tool) => isSearchable(tool.exposure) && !active.includes(tool.name));
	const documents = candidates.map((tool) => createToolSearchDocument(tool, tool.namespace));
	const matches = new Bm25Ranker().rank(query, documents, limit);
	if (matches.length > 0) tools.setActiveTools([...active, ...matches.map((match) => match.name)]);
	return matches.map((match) => ({
		name: match.name,
		description: candidates.find((tool) => tool.name === match.name)?.description ?? "",
	}));
}

export function createToolSearchToolDefinition(
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		parameters: toolSearchSchema,
		// Searching is not something scripts need; it changes what the model sees.
		exposure: "model-only",
		// A query can match any tool that is not declared yet.
		reachesTools: () => "all",
		async execute(_toolCallId, { query, limit }) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			const tools = options.tools ? searchAndLoad(options.tools, query, max) : [];
			const text =
				tools.length === 0
					? "No matching tools found."
					: `Loaded ${tools.length} tool${tools.length === 1 ? "" : "s"}. They are available from your next call:\n${tools
							.map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0]}`)
							.join("\n")}`;
			return { content: [{ type: "text", text }], details: { loaded: tools.map((tool) => tool.name) } };
		},
	};
}
