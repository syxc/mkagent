/** Run real native commands with in-memory credentials and a failing model transport. */
import { join } from 'node:path';
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Agent } from '../../src/agent-runtime.ts';
import { createHostResources } from '../../src/host-resources.ts';
import { AgentSession } from '../../src/native-agent-session.ts';
import { emitSessionShutdownEvent } from '@earendil-works/pi-coding-agent';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';

export async function openPackageSession(root: string, projectTrusted = true) {
  const notifications: Array<{ message: string; type: string }> = [];
  const errors: unknown[] = [];
  const resources = createHostResources({
    cwd: join(root, 'project'), agentDir: join(root, 'agent'), projectTrusted,
  });
  await resources.resourceLoader.reload();
  const credentials = ModelRuntime.createCredentials(new InMemoryCredentialStore());
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  const modelRuntime = await ModelRuntime.bind({ models: () => models, credentials });
  const session = new AgentSession({
    agent: new Agent({ streamFn: () => { throw new Error('Unexpected model request'); } }),
    sessionManager: SessionManager.inMemory(join(root, 'project')), cwd: join(root, 'project'),
    ...resources, modelRuntime, baseToolsOverride: {},
  });
  await session.bindExtensions({
    mode: 'print',
    uiContext: { ...session.extensionRunner.getUIContext(),
      notify: (message, type = 'info') => notifications.push({ message, type }) },
    commandContextActions: {
      waitForIdle: async () => {},
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: () => session.reload(),
    },
    onError: error => errors.push(error),
  });
  return {
    ...resources, session, notifications, errors,
    close: async () => {
      await emitSessionShutdownEvent(session.extensionRunner, { type: 'session_shutdown', reason: 'exit' });
      session.dispose();
    },
  };
}

if (import.meta.main) {
  const runtime = await openPackageSession(process.argv[2]!);
  try {
    await runtime.session.prompt('/packages install npm:fixture-pkg');
    process.stdout.write(`${JSON.stringify({ notifications: runtime.notifications, errors: runtime.errors })}\n`);
  } finally {
    await runtime.close();
  }
}
