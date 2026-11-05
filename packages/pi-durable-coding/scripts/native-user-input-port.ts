/** Preserve plugin input before native transformations, without changing model-visible messages. */
export function portNativeUserInput(source: string): string {
  let body = 'import { randomUUID } from "node:crypto";\n' + source;
  const edit = (before: string, after: string) => {
    if (!body.includes(before)) throw new Error('Pinned native user input boundary changed: ' + before);
    body = body.replace(before, after);
  };
  edit('\thostMessageId?: string;',
    '\thostMessageId?: string;\n\t/** Original plugin input, retained only for committed product display. */\n\thostUserInput?: { version: 1; content: string | (TextContent | ImageContent)[] };');
  for (const method of ['_startRun', '_prepareRun']) {
    const before = method === '_startRun'
      ? 'private async _startRun(trigger: BeforeAgentStartTrigger, onStarted?: () => void, hostMessageId?: string)'
      : 'private async _prepareRun(trigger: BeforeAgentStartTrigger, hostMessageId?: string)';
    edit(before, before.slice(0, -1) + ', hostUserInput?: PromptOptions["hostUserInput"])');
  }
  edit('this._prepareRun(trigger, hostMessageId)', 'this._prepareRun(trigger, hostMessageId, hostUserInput)');
  edit('preflightResult?.("started"), options?.hostMessageId,',
    'preflightResult?.("started"), options?.hostMessageId, options?.hostUserInput,');
  edit('\t\t\t\t...(hostMessageId ? { hostMessageId } : {}),',
    '\t\t\t\t...(hostMessageId ? { hostMessageId } : {}),\n\t\t\t\t...(hostUserInput ? { hostUserInput } : {}),');
  for (const method of ['Steer', 'FollowUp']) {
    edit(`private async _queue${method}(text: string, images?: ImageContent[], hostMessageId?: string)`,
      `private async _queue${method}(text: string, images?: ImageContent[], hostMessageId?: string, hostUserInput?: PromptOptions["hostUserInput"])`);
    edit(`this._queue${method}(expandedText, currentImages, options?.hostMessageId)`,
      `this._queue${method}(expandedText, currentImages, options?.hostMessageId, options?.hostUserInput)`);
    edit('const message: AgentMessage = { role: "user", content, timestamp: Date.now(), ...(hostMessageId ? { hostMessageId } : {}) };',
      'const message: AgentMessage = { role: "user", content, timestamp: Date.now(), ...(hostMessageId ? { hostMessageId } : {}), ...(hostUserInput ? { hostUserInput } : {}) };');
  }
  edit('\t\t// Normalize content to text string + optional images',
    '\t\tconst hostMessageId = `native-user-${randomUUID()}`;\n\t\tconst hostUserInput = { version: 1 as const, content: structuredClone(content) };\n\t\t// Normalize content to text string + optional images');
  edit('\t\t\timages,\n\t\t\tsource: "extension",',
    '\t\t\timages,\n\t\t\tsource: "extension",\n\t\t\thostMessageId,\n\t\t\thostUserInput,');
  edit('const hostMessageId = targetRecord.hostMessageId;',
    'const hostMessageId = targetRecord.hostMessageId;\n\t\tconst hostUserInput = targetRecord.hostUserInput;');
  edit('else delete targetRecord.hostMessageId;',
    'else delete targetRecord.hostMessageId;\n\t\tif (hostUserInput !== undefined) targetRecord.hostUserInput = hostUserInput;\n\t\telse delete targetRecord.hostUserInput;');
  return body;
}
