/** Keep the host's durable state and tool boundaries reproducible from pinned native sources. */
function edit(source: string, before: string, after: string): string {
  if (!source.includes(before)) throw new Error('Pinned native session boundary changed: ' + before);
  return source.replace(before, after);
}

export function portNativeMessages(source: string): string {
  const body = edit(source, 'export function convertToLlm(messages: AgentMessage[]): Message[] {',
    'export function convertToLlm(\n\tmessages: AgentMessage[],\n\toptions: { preserveHostMetadata?: boolean } = {},\n): Message[] {');
  return edit(body, '\t\t\t\tcase "toolResult":\n\t\t\t\t\treturn m;',
    '\t\t\t\tcase "toolResult":\n\t\t\t\t\t// Legacy projections require the original object for identity-based reconciliation.\n\t\t\t\t\t// Native model context excludes host metadata by default.\n\t\t\t\t\tif (!options.preserveHostMetadata && ("hostMessageId" in m || "hostUserInput" in m)) {\n\t\t\t\t\t\tconst message = { ...m };\n\t\t\t\t\t\tReflect.deleteProperty(message, "hostMessageId");\n\t\t\t\t\t\tReflect.deleteProperty(message, "hostUserInput");\n\t\t\t\t\t\treturn message;\n\t\t\t\t\t}\n\t\t\t\t\treturn m;');
}
