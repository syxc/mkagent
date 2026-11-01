let calls = 0;
let refreshCalls = 0;

const fakeToken = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.fixture`;

// The provider prefers WebSocket before falling back to fetch.
globalThis.WebSocket = class {
  constructor() { throw new Error('TEST_WEBSOCKET_BLOCKED'); }
} as unknown as typeof WebSocket;

globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === 'auth.openai.com' && url.pathname === '/oauth/token') {
    refreshCalls++;
    if (process.env.TEST_DELAY_OAUTH_REFRESH) {
      process.stderr.write('TEST_OAUTH_REFRESH_STARTED\n');
      await Bun.sleep(400);
      process.stderr.write('TEST_OAUTH_REFRESH_FINISHED\n');
    }
    return Response.json({ access_token: fakeToken, refresh_token: 'fake-rotated-refresh', expires_in: 3600 });
  }
  if (url.hostname === 'chatgpt.com') {
    throw new Error(refreshCalls > 1 ? 'TEST_OAUTH_REFRESHED_TWICE' : 'TEST_OAUTH_FIRST_REQUEST');
  }
  if (url.hostname !== 'fake-provider.test') throw new Error(`OFFLINE_FETCH_BLOCKED: ${request.url}`);
  const body = await request.json() as { model?: string; tools?: Array<{ function?: { name?: string } }> };
  if (process.env.TEST_EXPECT_MODEL && body.model !== process.env.TEST_EXPECT_MODEL) throw new Error('TEST_WRONG_MODEL');
  if (!body.tools?.some(tool => tool.function?.name === 'codemode')) throw new Error('codemode was not offered');
  const delta = calls++ === 0
    ? { tool_calls: [{ index: 0, id: 'code-mcp', type: 'function', function: {
      name: 'codemode', arguments: JSON.stringify({ code: 'text(await tools.mcp__test__hello({})); try { await models.generateImages(null, { input: [{ type: "text", text: "fixture" }] }); } catch (_) {}' }),
    } }] }
    : { content: 'done' };
  const chunk = { id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}, { preconnect() {} }) as typeof globalThis.fetch;
