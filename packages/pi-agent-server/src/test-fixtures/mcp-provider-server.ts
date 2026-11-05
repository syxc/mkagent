/** A stateless local MCP server that checks fixture provider tokens without retaining them. */
export function startProviderMcpServer(expectedToken: () => string) {
  const requests: Array<{ method: string; authorized: boolean }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const message: unknown = await request.json();
      if (typeof message !== 'object' || !message || !('method' in message) || typeof message.method !== 'string') {
        return new Response(null, { status: 400 });
      }
      const authorized = request.headers.get('authorization') === `Bearer ${expectedToken()}`;
      requests.push({ method: message.method, authorized });
      if (!authorized) return new Response(null, { status: 401 });
      if (!('id' in message)) return new Response(null, { status: 202 });
      const result = message.method === 'initialize' ? {
        protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'fixture-provider', version: '1.0' },
      } : message.method === 'tools/list' ? {
        tools: [{ name: 'hello', description: 'Return a fixture greeting',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
      } : { content: [{ type: 'text', text: 'fixture provider greeting' }] };
      return Response.json({ jsonrpc: '2.0', id: message.id, result });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, requests, close: () => server.stop(true) };
}
