/** Isolate a real worker, native OAuth config, and a model endpoint that rejects every request. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { FileAuthStorageBackend, McpOAuthCredentialStore } from '@mkagent/pi-durable-coding/mcp-oauth';

export interface OAuthWorkerFrame {
  type: string;
  id?: string;
  method?: string;
  title?: string;
  widgetKey?: string;
  widgetLines?: string[];
  uiEpoch?: string;
  accepted?: boolean;
  released?: boolean;
  ownerSessionId?: string;
  runtimeGeneration?: number;
}

interface OAuthWorker {
  credentials: McpOAuthCredentialStore;
  exited: Promise<number | null>;
  frames: OAuthWorkerFrame[];
  modelRequests(): number;
  send(message: object): void;
  init(ownerSessionId: string, runtimeGeneration: number): void;
  waitFor(match: (frame: OAuthWorkerFrame) => boolean): Promise<OAuthWorkerFrame>;
}

export async function withOAuthWorker(url: string, run: (worker: OAuthWorker) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'mcp-worker-owner-'));
  const agentDir = join(root, 'pi');
  const home = join(root, 'home');
  mkdirSync(agentDir); mkdirSync(home);
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { issues: { url, exposure: 'direct' } } }));
  writeFileSync(join(agentDir, 'settings.json'), '{"cacheWarming":"off","compaction":{"enabled":false}}');
  let modelRequests = 0;
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    modelRequests++;
    return new Response('Unexpected model request', { status: 500 });
  } });
  const child = spawn(process.execPath, [join(import.meta.dir, '../index.ts')], {
    cwd: resolve(import.meta.dir, '../../../..'), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, CONFIG_DIR: join(root, 'config'),
      CRAFT_CONFIG_DIR: join(root, 'config'), PI_CODING_AGENT_DIR: agentDir },
  });
  const exited = new Promise<number | null>(resolve => child.once('close', resolve));
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4096); });
  const reader = createInterface({ input: child.stdout });
  const frames: OAuthWorkerFrame[] = [];
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  reader.on('line', line => {
    const frame: OAuthWorkerFrame = JSON.parse(line);
    frames.push(frame);
    // This protocol fixture supplies the host receipt; SessionManager persistence is tested separately.
    if (frame.type === 'native_history_commit') child.stdin.write(JSON.stringify({
      type: 'native_history_receipt', id: frame.id, success: true,
      ownerSessionId: frame.ownerSessionId, runtimeGeneration: frame.runtimeGeneration,
    }) + '\n');
    for (const listener of [...listeners]) listener();
  });
  const waitFor = (match: (frame: OAuthWorkerFrame) => boolean) => new Promise<OAuthWorkerFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      timers.delete(timer); listeners.delete(check);
      const received = frames.map(frame => ({ type: frame.type, method: frame.method, title: frame.title,
        id: frame.id, keys: Object.keys(frame) }));
      reject(new Error(`OAuth worker timed out: ${stderr}\nFrames: ${JSON.stringify(received)}`));
    }, 5000);
    const check = () => {
      const frame = frames.find(match);
      if (frame) { clearTimeout(timer); timers.delete(timer); listeners.delete(check); resolve(frame); }
    };
    timers.add(timer); listeners.add(check); check();
  });
  const send = (message: object) => { child.stdin.write(JSON.stringify(message) + '\n'); };
  try {
    await run({
      credentials: new McpOAuthCredentialStore(new FileAuthStorageBackend(join(agentDir, 'mcp-auth.json')), agentDir),
      exited, frames, modelRequests: () => modelRequests, send, waitFor,
      init(ownerSessionId, runtimeGeneration) {
        send({
          type: 'init', ownerSessionId, runtimeGeneration, sessionId: ownerSessionId, extensionUIAvailable: true,
          agentProfile: 'coding', codingResources: { agentDir, resourcePolicy: 'native' },
          apiKey: '', authType: 'none', providerType: 'pi_compat', model: 'oauth-local', thinkingLevel: 'off',
          cwd: root, workspaceRootPath: root, workspaceId: 'oauth-owner', workingDirectory: root,
          sessionPath: join(root, 'sessions', ownerSessionId), plansFolderPath: join(root, 'plans'),
          baseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
          customEndpoint: { api: 'openai-completions' }, customModels: [{ id: 'oauth-local', contextWindow: 100_000 }],
        });
      },
    });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    child.stdin.end();
    const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(deadline); }
    reader.close(); endpoint.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}
