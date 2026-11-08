# Architecture

MkAgent is a Bun monorepo with three clients sharing one authenticated WebSocket RPC protocol. Only the `pi` agent backend is registered. The agent kernel runs on `@earendil-works/pi-durable` in a dedicated Bun subprocess. `pi-ai` and `chord` provide lower-level APIs.

## Kernel migration

MkAgent moved from `pi-coding-agent` to `pi-durable`, which already provides execution, tools, storage, and recovery. Current work adds Coding features and the Pi plugin ecosystem while keeping all existing MkAgent features. Use durable built-ins first, then public APIs from separate official Pi SDK packages. Add a thin adapter or retain source only for a demonstrated gap. `pi-agent-core` is allowed; production must not depend on or load the full `pi-coding-agent` package. Replacing third-party assets, reducing line counts, and copying all source reachable from the original CLI are not migration goals. The [capability spec](pi-durable/coding-capabilities-spec.md) and [implementation plan](pi-durable/durable-coding-agent-plan.md) define current goals. They replace earlier dependency bans, rules that forbid host changes, and permission to cut features.

The current normal profile uses durable's `GenerationTask`. The coding profile follows `CodingHost → AgentSession → DurableLoopBinding → pi.coding.*`. This describes the current implementation. Each custom task bridge still needs review against actual Coding and public plugin contracts; this chain is not a fixed target architecture.

Published Pi APIs and local SDK extensions must be tracked separately. `pi-agent-core` uses a four-file repository patch for eight operation exports and Agent execution injection. The durable `codingPrepare`, `codingStream`, and `codingBoundary` hooks also come from repository patches. These interfaces are not published Pi APIs. Their need and upgrade cost still require review. Independent tests can use a fixed original `pi-coding-agent` package as a behavior oracle.

The root and `packages/shared` use `pi-ai 1.1.0`. The Pi dependencies in `packages/pi-durable-coding` and `packages/pi-agent-server` use `1.5.0`. These are separate dependency boundaries.

## Layered topology

```text
+-----------------------------------------------------------+
| apps/electron       apps/webui         apps/cli           |
|   Electron             Browser            RPC client       |
|   (Browser pane,       adapter (loads    (connects to      |
|   Sentry, auto-        the same React    running server    |
|   update, IPC)         app via header    or spawns a        |
|        \                  handshake)      one-shot server)  |
+---------|----------------|--------------------|-------------+
          v                v                    v
   Browser adapter  ──>  preload Client API  ──> RPC client
                          (window.MkAgent)         (rpc-client.ts)
                                                       |
                                                WebSocket (wss://)
                                                       v
+-----------------------------------------------------------+
| packages/server-core                                      |
|   transport (WS server + JWT) / SessionManager /           |
|   handlers / services / webui (HTTP+sessions) /            |
|   model-fetchers / sessions                               |
+---------|---------------------------------------|
          v                                       |
   packages/server (headless `MKAGENT_SERVER_TOKEN` server)
          v                                       |
+-----------------------------------------------------------+
| packages/shared                                           |
|   config / credentials / prompts / Skills /               |
|   workspaces / views / theme / i18n / AgentEvent /         |
|   backend registry (only `pi`)                            |
+-----------------------------------------------------------+
          |
          v
+-----------------------------------------------------------+
| packages/pi-agent-server                                  |
|   Bun subprocess, JSONL on stdio, talks to Pi SDK         |
+-----------------------------------------------------------+
          v
+-----------------------------------------------------------+
| packages/ui            packages/session-tools-core        |
|   React primitives,    LLM-backed session tools            |
|   markdown/doc         (plan, skill, mermaid,             |
|   renderers, IPC,      convert, mini LLM, browser,         |
|   settings pages       session info/list, etc.)           |
+-----------------------------------------------------------+
```

All three clients operate the same workspace and JSONL sessions; there is no client-specific storage.

## Apps

- `apps/electron` embeds the local server, exposes the Client API through preload, and owns windows, Browser panes, proxy integration, auto-update, and Sentry.
- `apps/webui` loads the same React application through a browser adapter. The headless server serves its static files and the authenticated attachment endpoint.
- `apps/cli` uses the same RPC methods and can connect to an existing server or start a temporary local instance for `run`.

## Shared packages

- `packages/server-core` owns transport, handlers, `SessionManager`, and platform-neutral services. Subpackages: `bootstrap/`, `domain/`, `handlers/`, `model-fetchers/`, `runtime/`, `services/`, `sessions/`, `transport/`, `utils/`, `webui/`.
- `packages/shared` owns protocol DTOs (`@mkagent/shared/protocol`), config, credentials, Skills, prompts, the backend registry, workspace storage, and the Pi client.
- `packages/pi-agent-server` runs the agent kernel on `@earendil-works/pi-durable` in a separate Bun subprocess (`packages/pi-agent-server/dist/index.js`) and communicates through JSONL. Production uses durable's tools and images APIs for read/write/edit/bash and optional PowerShell, plus its codemode and tool-search extensions. The official pi-mcp client reads `mcp.json` in the agent directory; pi-codemode supplies the sandbox. Local grep/find/ls remain adapted from pi-coding-agent 1.1.0 and require review under the migration policy above. The same SDK boundary is used in development and packaged builds; `bun run server:build:subprocess` produces the bundle.
- `packages/ui` and `packages/session-tools-core` provide shared rendering and session-level tools. They are platform-neutral: Electron, WebUI, and CLI reuse them.

## Backend registry

Only the `pi` backend is registered. Custom endpoints (`openai-completions`, `anthropic-messages`) and Ollama are connection variants executed through Pi rather than separate backends. The registry is initialized by `registerPiModelResolver(...)` inside `packages/server/src/index.ts` and `apps/electron/src/main`.

## Auth handshake

1. The server binds on `MKAGENT_RPC_HOST:MKAGENT_RPC_PORT` (default `127.0.0.1:9100`).
2. The bearer token is read from `MKAGENT_SERVER_TOKEN` (Electron generates one automatically on launch; the headless server requires it to be passed in).
3. The token is exchanged for a short-lived JWT used on every subsequent WebSocket frame (`@mkagent/server-core/webui`).
4. WebUI and CLI additionally support `MKAGENT_WEBUI_PASSWORD` (falls back to `MKAGENT_SERVER_TOKEN`) and an optional `MKAGENT_TLS_CA` for TLS pinning.
5. The handshake binds a workspace id; later RPC commands are scoped to that workspace and only see its sessions, Skills, permissions, and Views.

## Subprocess boundary

The Pi subprocess is isolated from the main process:

```text
main process (Bun)
  └─ spawns: bun packages/pi-agent-server/dist/index.js
              ↕ JSONL on stdio (one JSON object per turn event)
              Pi SDK ↔ provider (HTTPS)
```

Abort, model switching, thinking-level change, permission responses, and session resume are all routed through the same JSONL stream. Pi recovery files are stored under `~/.mkagent/workspaces/<slug>/sessions/<id>/`.

## Packaging surface

- Desktop app: macOS arm64 / x64 (DMG + ZIP), Windows x64 (NSIS), Linux x64 (AppImage). Build entry: `bun run electron:dist[:dev][:mac|:win|:linux]`.
- Headless server: per-platform compiled Bun archive; build with `bun run scripts/build-server.ts`.
- CLI: `bun run cli:build` produces `dist/mkagent`.
- Pi subprocess: `bun run server:build:subprocess` produces `packages/pi-agent-server/dist/index.js`.

The main `MkThingsHQ/mkagent` repository publishes DMG/ZIP/NSIS/AppImage assets, headless-server archives, a Bun CLI archive, manifests, blockmaps, checksums, and release notes in GitHub Releases. `electron-updater` reads the public manifests and never embeds a GitHub token in the client.

## What is intentionally absent

Craft Agents bundles broad OAuth and Sources integrations, a Slack/Teams/Lark messaging gateway, a WhatsApp worker backed by Baileys, a session MCP server, a bridge MCP server, and an `apps/viewer` Electron app for public sharing. MkAgent retains only the ChatGPT and Claude LLM OAuth flows from that surface; the other components remain absent. MkAgent exposes image generation through codemode's `models.generateImages()` when an image model and credentials are available. See [`comparison-with-craft.md`](./comparison-with-craft.md) for an evidence-backed side-by-side and the resulting installer-size delta.
