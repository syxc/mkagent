/** Bind durable search metadata and ranking while the SDK owns activation and presentation. */
import {
  createToolSearchExtension as sdkExtension, createToolSearchToolDefinition as sdkDefinition,
  type ToolInfo, type ToolNamespace, type ToolSearchDependencies, type ToolSearchToolOptions,
} from '@earendil-works/pi-coding-agent';
import { createToolSearchText, rankToolSearchDocuments } from '@earendil-works/pi-durable/tool-search';

export function createToolSearchDocument(
  tool: Pick<ToolInfo, 'name' | 'description' | 'parameters'>, namespace?: ToolNamespace,
) {
  const namespaceText = namespace
    ? [namespace.name, namespace.description ?? '', namespace.instructions ?? ''].join(' ')
    : '';
  return { name: tool.name, text: createToolSearchText(tool), namespaceText };
}

const dependencies: ToolSearchDependencies = {
  createDocument: createToolSearchDocument, rank: rankToolSearchDocuments,
};

export function createToolSearchToolDefinition(options?: ToolSearchToolOptions): ReturnType<typeof sdkDefinition> {
  return sdkDefinition(options, dependencies);
}
export function createToolSearchExtension(): ReturnType<typeof sdkExtension> {
  return sdkExtension(dependencies);
}
