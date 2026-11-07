import { expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionUIDialog, ExtensionUIUpdate } from '@mkagent/shared/protocol'

it('runs Coding, defaults, frozen settings, forks, background handoffs and restarts through the actual Pi subprocess', async () => {
  const appRoot = resolve(import.meta.dir, '../../../..')
  const build = Bun.spawnSync([process.execPath, 'run', 'server:build:subprocess'], { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(`Pi subprocess build failed: ${build.stderr.toString()}`)
  const root = mkdtempSync(join(tmpdir(), 'mkagent-coding-runtime-'))
  const previous = process.env.CONFIG_DIR
  const previousHome = process.env.HOME
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.CONFIG_DIR = root
  process.env.HOME = join(root, 'home')
  process.env.PI_CODING_AGENT_DIR = join(root, 'home', '.pi', 'agent')
  const wsRoot = join(root, 'workspace')
  const repo = join(root, 'repo with spaces')
  mkdirSync(wsRoot); mkdirSync(repo)
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
  writeFileSync(join(repo, 'AGENTS.md'), 'Fixture convention: preserve fixture rules.')
  writeFileSync(join(repo, 'CLAUDE.md'), 'Additional fixture context.')
  // Project trust is covered separately; discover this explicit user extension in an isolated HOME.
  const nativeExtensions = join(root, 'home', '.pi', 'agent', 'extensions')
  const nativeUIResult = join(root, 'native-ui.json')
  mkdirSync(nativeExtensions, { recursive: true })
  writeFileSync(join(nativeExtensions, '..', 'settings.json'), '{"cacheWarming":"off"}')
  writeFileSync(join(nativeExtensions, 'owner-ui.ts'), `
    import { writeFileSync } from 'node:fs';
    export default function(pi) {
      let startup;
      pi.on('session_start', async (_, ctx) => {
        if (!ctx.hasUI) return;
        startup = { answer: await ctx.ui.input('Factory startup'), hasUI: ctx.hasUI,
          hostTools: pi.getAllTools().some(tool => tool.name === 'mcp__session__SubmitPlan') };
      });
      pi.registerCommand('factory-ui', { handler: async (_, ctx) => {
        const confirmed = await ctx.ui.confirm('Factory command', 'Confirm through the product owner');
        ctx.ui.setStatus('factory', 'ready');
        writeFileSync(${JSON.stringify(nativeUIResult)}, JSON.stringify({ startup, confirmed }));
      } });
    }
  `)
  const workspace = { id: 'ws-coding', name: 'Coding', slug: 'coding', rootPath: wsRoot, createdAt: 1 }
  const requests: any[] = []
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as any
    requests.push(body)
    const content = body.tools?.length ? 'Coding fixture reply.' : 'Handoff summary: preserve fixture goal and completed investigation.'
    return new Response([
      { id: `r${requests.length}`, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
      { id: `r${requests.length}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: `r${requests.length}`, choices: [], usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const connection = { slug: 'fixture', name: 'Fixture', providerType: 'pi_compat', authType: 'none', baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, customEndpoint: { api: 'openai-completions', maxTokens: 16384 }, models: [{ id: 'fixture', contextWindow: 131072 }], defaultModel: 'fixture', createdAt: 1 }
  writeFileSync(join(wsRoot, 'config.json'), JSON.stringify({ ...workspace, updatedAt: 1, defaults: { model: 'fixture', defaultLlmConnection: 'fixture', permissionMode: 'allow-all', thinkingLevel: 'off', workingDirectory: repo, codingMode: true } }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id, activeSessionId: null, defaultLlmConnection: 'fixture', llmConnections: [connection] }))
  const config = await import('@mkagent/shared/config')
  config.ensureConfigDir()
  const { SessionManager, setSessionPlatform } = await import('./SessionManager')
  const { createHeadlessPlatform } = await import('../runtime/platform-headless')
  const { loadSession } = await import('@mkagent/shared/sessions')
  const { registerSettingsHandlers } = await import('../handlers/rpc/settings')
  const { RPC_CHANNELS } = await import('@mkagent/shared/protocol')
  const platform = createHeadlessPlatform(); platform.appRootPath = appRoot; setSessionPlatform(platform)
  let manager = new SessionManager()
  const events: any[] = []
  const startupUI = Promise.withResolvers<ExtensionUIDialog>()
  const commandUI = Promise.withResolvers<ExtensionUIDialog>()
  const waitForUI = async (pending: Promise<ExtensionUIDialog>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Product backend UI timeout')), 10_000)
      })])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await manager.initialize()
    manager.setEventSink((channel, _target, event) => {
      events.push(event)
      if (channel !== RPC_CHANNELS.sessions.EXTENSION_UI_UPDATED) return
      for (const request of (event as ExtensionUIUpdate).snapshot.requests) {
        if (request.title === 'Factory startup') startupUI.resolve(request)
        if (request.title === 'Factory command') commandUI.resolve(request)
      }
    })
    const handlers = new Map<string, any>()
    registerSettingsHandlers({ handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, { platform, sessionManager: manager } as any)
    const uiSession = await manager.createSession(workspace.id, { name: 'Factory UI fixture' })
    await manager.attachExtensionUI(uiSession.id, workspace.id, 'factory-client', 'factory-lease')
    const uiRun = manager.sendMessage(uiSession.id, '/factory-ui')
    void uiRun.catch(() => {})
    const startupRequest = await waitForUI(startupUI.promise)
    expect(await manager.respondToExtensionUI(uiSession.id, workspace.id, 'factory-client', 'factory-lease',
      startupRequest.uiEpoch, { type: 'extension_ui_response', id: startupRequest.id, value: '' })).toBe(true)
    const commandRequest = await waitForUI(commandUI.promise)
    expect(await manager.respondToExtensionUI(uiSession.id, workspace.id, 'factory-client', 'factory-lease',
      commandRequest.uiEpoch, { type: 'extension_ui_response', id: commandRequest.id, confirmed: false })).toBe(true)
    await uiRun
    expect(JSON.parse(readFileSync(nativeUIResult, 'utf8'))).toEqual({
      startup: { answer: '', hasUI: true, hostTools: true }, confirmed: false,
    })
    expect((await manager.getSession(uiSession.id))?.isProcessing).toBe(false)
    expect(requests).toHaveLength(0)
    manager.detachExtensionUI(uiSession.id, 'factory-client', 'factory-lease')
    const session = await manager.createSession(workspace.id)
    expect(session.codingMode).toBe(true)
    expect((await manager.createSession(workspace.id, { codingMode: false })).codingMode).toBeUndefined()
    manager.setSessionCodingMode(session.id, false)
    manager.setSessionCodingMode(session.id, true)
    expect(events.filter(event => event.type === 'coding_mode_changed').map(event => event.codingMode)).toEqual([false, true])
    await manager.sendMessage(session.id, 'Investigate the fixture goal.')
    const codingCall = requests.find(body => body.tools?.length)
    const codingPrompt = codingCall.messages.find((message: any) => message.role === 'system').content
    expect(codingPrompt).toContain('Coding mode')
    const userContext = codingCall.messages.filter((message: any) => message.role === 'user')
      .flatMap((message: any) => typeof message.content === 'string' ? [message.content] : message.content.map((part: any) => part.text ?? '')).join('\n')
    expect(userContext).toContain('permission_mode="allow-all"')
    expect(codingPrompt).toContain('AGENTS.md')
    expect(codingPrompt).toContain('CLAUDE.md')
    expect(codingPrompt).toContain(repo)
    const names = codingCall.tools.map((tool: any) => tool.function.name)
    expect(names).toContain('mcp__session__pr_status')
    expect(names).toContain('mcp__session__pr_bind')
    expect(names).toContain('mcp__session__pr_unbind')
    expect(names).toContain('mcp__session__pr_set_auto_merge')
    expect(names).toContain('mcp__session__SubmitPlan')
    expect(names).toContain('mcp__session__list_background_tasks')
    expect(names).not.toContain('mcp__session__browser_tool')
    expect(names).not.toContain('mcp__session__call_llm')
    expect(names).not.toContain('mcp__session__spawn_session')
    expect(() => manager.setSessionCodingMode(session.id, false)).toThrow('fixed')
    await manager.flushSession(session.id)
    expect(loadSession(wsRoot, session.id)?.codingMode).toBe(true)
    const source = (await manager.getSession(session.id))!
    const reply = source.messages.find(message => message.role === 'assistant')!
    const fork = await manager.createSession(workspace.id, { branchFromSessionId: session.id, branchFromMessageId: reply.id, codingMode: false })
    expect(fork.codingMode).toBe(true)
    await manager.sendMessage(session.id, 'This is after the branch checkpoint.')
    const sourceAfterCheckpoint = (await manager.getSession(session.id))!
    const bundle = await manager.exportSession(session.id, workspace.id)
    expect(bundle).not.toBeNull()
    const imported = await manager.importSession(workspace.id, bundle!, 'fork')
    expect(loadSession(wsRoot, imported.sessionId)?.sdkSessionId).toBeTruthy()
    await manager.sendMessage(imported.sessionId, 'Continue the imported session.')
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('This is after the branch checkpoint.')
    const importedFork = await manager.createSession(workspace.id, { branchFromSessionId: imported.sessionId, branchFromMessageId: reply.id })
    await manager.sendMessage(importedFork.id, 'Continue the imported branch.')
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Investigate the fixture goal.')
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('This is after the branch checkpoint.')
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('Continue the imported session.')
    const next = await manager.continueSessionInNewSession(session.id, false)
    const continued = (await manager.getSession(next.sessionId))!
    expect(continued).toMatchObject({ workingDirectory: repo, model: source.model, llmConnection: source.llmConnection, thinkingLevel: source.thinkingLevel, permissionMode: source.permissionMode, messages: [] })
    expect(continued.codingMode).toBeUndefined()
    expect((await manager.getSession(session.id))?.messages).toEqual(sourceAfterCheckpoint.messages)
    await manager.sendMessage(next.sessionId, 'Use the handoff now.')
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('preserve fixture goal')
    expect(loadSession(wsRoot, next.sessionId)?.transferredSessionSummaryApplied).toBe(true)
    manager.cleanup(); manager = new SessionManager(); await manager.initialize(); manager.setEventSink(() => {})
    expect(manager.getSessions(workspace.id).find(item => item.id === session.id)?.codingMode).toBe(true)
    await manager.sendMessage(next.sessionId, 'Continue fixture.')
    const resumed = requests.at(-1)
    expect(JSON.stringify(resumed.messages).match(/<session_transfer_summary>/g)).toHaveLength(1)
    expect(resumed.messages.find((message: any) => message.role === 'system').content).not.toContain('**Coding mode**')
    expect(resumed.tools.map((tool: any) => tool.function.name)).toContain('mcp__session__call_llm')
    expect(resumed.tools.map((tool: any) => tool.function.name)).not.toContain('mcp__session__pr_status')
    expect(loadSession(wsRoot, next.sessionId)?.transferredSessionSummaryApplied).toBe(true)
    await handlers.get(RPC_CHANNELS.workspace.SETTINGS_UPDATE)({}, workspace.id, 'codingMode', false)
    expect(JSON.parse(readFileSync(join(wsRoot, 'config.json'), 'utf8')).defaults.codingMode).toBeUndefined()
  } finally {
    await manager.flushAllSessions(); manager.cleanup(); endpoint.stop()
    if (previous === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = previous
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
