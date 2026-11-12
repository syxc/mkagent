/** Preserve execution ownership and declaration metadata through the SDK's tool conversions. */
export function codingToolPolicy(source: string, declarations: boolean): string {
  let body = source;
  const edit = (before: string, after: string) => {
    if (body.split(before).length !== 2) throw new Error('Published tool wrapper boundary changed: ' + before);
    body = body.replace(before, after);
  };
  const metadata = ['exposure', 'namespace', 'annotations', 'reachesTools', 'defaultActive', 'promptSnippet', 'promptGuidelines'];
  const shape = `Pick<ToolDefinition<any>, ${metadata.map(name => JSON.stringify(name)).join(' | ')}>`;
  if (declarations) {
    edit('): AgentTool<any, TDetails>;', `): AgentTool<any, TDetails> & ${shape};`);
    edit('(tool: AgentTool<any>): ToolDefinition<any, unknown>;', `(tool: AgentTool<any> & ${shape}): ToolDefinition<any, unknown>;`);
    return body;
  }
  for (const value of ['definition', 'tool']) {
    edit(`    return {\n        name: ${value}.name,`, `    return Object.defineProperties({\n        name: ${value}.name,`);
    edit(`        executionMode: ${value}.executionMode,`, `        executionMode: ${value}.executionMode,\n`
      + ['replay', ...metadata].map(name => `        ${name}: ${value}.${name},`).join('\n'));
    const execute = value === 'definition'
      ? '        execute: (toolCallId, params, signal, onUpdate, ctx) => definition.execute(toolCallId, params, signal, onUpdate, ctx ?? ctxFactory?.(toolCallId, signal)),'
      : '        execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),';
    edit(execute + '\n    };', execute + `\n    }, Object.fromEntries(Object.getOwnPropertySymbols(${value}).map(key => [key, Object.getOwnPropertyDescriptor(${value}, key)])));`);
  }
  return body;
}
