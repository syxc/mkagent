import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result: unknown;
  switch (message.method) {
    case 'initialize':
      if (process.argv.includes('--slow-initialize')) await Bun.sleep(300);
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1.0' } };
      break;
    case 'tools/list':
      result = { tools: [{ name: 'hello', description: 'Return a greeting', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      break;
    case 'tools/call':
      result = { content: [{ type: 'text', text: 'hello from MCP' }] };
      break;
    default:
      result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
}
