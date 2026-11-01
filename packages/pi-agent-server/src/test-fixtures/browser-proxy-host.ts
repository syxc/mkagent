import { createInterface } from 'node:readline';
import { PiAgent } from '../../../shared/src/agent/pi-agent.ts';
import { registerSessionScopedToolCallbacks } from '../../../shared/src/agent/session-scoped-tool-callback-registry.ts';
import type { BrowserPaneFns } from '../../../shared/src/agent/browser-tools.ts';

const sessionId = 'completed-proxy-browser';
let focused = '';
const inputResult = () => ({ browserInput: focused === '@e2' ? 'password' as const : 'ordinary' as const });
registerSessionScopedToolCallbacks(sessionId, { browserPaneFns: {
  fill: async (ref: string) => { focused = ref; return inputResult(); },
  type: async () => inputResult(), setClipboard: async () => {}, sendKey: async () => inputResult(),
  evaluate: async () => ({ url: 'https://example.test', title: 'Fixture', activeElementTag: 'input', activeElementIsPassword: focused === '@e2' }),
} as unknown as BrowserPaneFns });

// Use the production RPC adapter without constructor-side configuration, credentials, or subprocess setup.
const host = Object.create(PiAgent.prototype) as PiAgent;
Object.assign(host, {
  _sessionId: sessionId,
  _agentProfile: 'default',
  prerequisiteManager: { checkPrerequisites: () => ({ allowed: true }) },
  debug: () => {},
  send: (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n'),
});
const rpc = host as unknown as { handleToolExecuteRequest(request: unknown): Promise<void> };
for await (const line of createInterface({ input: process.stdin })) {
  await rpc.handleToolExecuteRequest(JSON.parse(line));
}
