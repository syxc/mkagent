/** Exercise native prompt image processing with a local provider, in source and relocated bundles. */
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createAssistantMessageEventStream, createModels, createProvider, InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { createAgentSession, createHostResources, createReadTool, ModelRuntime, SessionManager } from '@mkagent/coding-runtime/native';
import { response } from '../../../coding-runtime/test/fixtures/durable-harness.ts';

const cwd = process.cwd();
const agentDir = join(cwd, 'agent');
mkdirSync(agentDir, { recursive: true });
const model: Model<'faux'> = {
  id: 'image', name: 'image', api: 'faux', provider: 'faux', baseUrl: 'http://unused.invalid',
  reasoning: false, input: ['text', 'image'], contextWindow: 100_000, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
let images = 0;
const models = createModels();
models.setProvider(createProvider({
  id: 'faux', models: [model], auth: { apiKey: { name: 'Synthetic', resolve: async () => ({ auth: {} }) } },
  api: { faux: {
    stream: () => { throw new Error('Unexpected full stream'); },
    streamSimple: (_model, request) => {
      images = request.messages.flatMap(message => message.role === 'user' && typeof message.content !== 'string'
        ? message.content.filter(part => part.type === 'image') : []).length;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: response('image received') }));
      return stream;
    },
  } },
}));
const resources = createHostResources({
  cwd, agentDir, disabledBuiltinExtensions: ['codemode', 'tool-search', 'mcp'],
  globalSettings: { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' },
});
await resources.resourceLoader.reload();
const modelRuntime = await ModelRuntime.bind({
  models: () => models, credentials: ModelRuntime.createCredentials(new InMemoryCredentialStore()),
});
const { session } = await createAgentSession({
  ...resources, cwd, agentDir, modelRuntime, model, sessionManager: SessionManager.create(cwd, join(cwd, 'history')),
  baseToolsOverride: {}, tools: [],
});
try {
  await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
  await session.prompt('Describe the image', { images: [{
    type: 'image', mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  }] });
  const imagePath = join(cwd, 'read-image.png');
  writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const read = await createReadTool(cwd).execute('read-image', { path: imagePath });
  const readImages = read.content.filter(part => part.type === 'image').length;
  const exported = process.argv.includes('--export')
    ? await session.exportToHtml(join(cwd, 'session.html')) : undefined;
  process.stdout.write(JSON.stringify({ images, readImages, exported: exported ? readFileSync(exported, 'utf8').includes('<!DOCTYPE html>') : undefined }));
} finally {
  session.dispose();
  await session.agent.durable.close();
}
