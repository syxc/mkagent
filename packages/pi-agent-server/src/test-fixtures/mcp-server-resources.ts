import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result: unknown;
  switch (message.method) {
    case 'initialize':
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'test-resources', version: '1.0' },
      };
      break;
    case 'tools/list':
      result = { tools: (process.argv.includes('--prototype-tools') ? ['hello', 'constructor', 'toString', '__proto__'] : ['hello'])
        .map(name => ({ name, description: 'Return a greeting', inputSchema: { type: 'object', properties: {}, additionalProperties: false } })) };
      break;
    case 'resources/list':
      result = { resources: [] };
      break;
    case 'resources/templates/list':
      result = { resourceTemplates: [] };
      break;
    case 'tools/call':
      result = { content: [{ type: 'text', text: 'hello from MCP' }] };
      break;
    default:
      result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
}
