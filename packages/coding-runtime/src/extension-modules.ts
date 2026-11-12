/** Override the host runtime while leaving plugin modules and importing to the SDK. */
import * as codingAgent from './compat.ts';

function unavailableCore(): never {
  throw new Error('This host runs pi-durable. The pi-agent-core Agent/agentLoop runtime is unavailable.');
}

const agentCore = { Agent: unavailableCore, agentLoop: unavailableCore, agentLoopContinue: unavailableCore };

export function getExtensionModules() {
  return { codingAgent, agentCore };
}
