import { createInterface } from 'node:readline';

let changed = false;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result: unknown;
  switch (message.method) {
    case 'initialize':
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'test-dynamic', version: '1.0' } };
      break;
    case 'tools/list':
      result = { tools: [changed ? { name: 'goodbye' } : { name: 'hello' }, { name: 'trigger' }].map(tool => ({ ...tool, inputSchema: { type: 'object', properties: {} } })) };
      break;
    case 'tools/call':
      result = { content: [{ type: 'text', text: 'updated' }] };
      if (message.params.name === 'trigger') changed = true;
      break;
    default:
      result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  if (message.method === 'tools/call' && message.params.name === 'trigger') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`);
  }
}
