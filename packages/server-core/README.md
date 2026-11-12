# @mkagent/server-core

Shared server infrastructure for the MkAgent Desktop, WebUI, CLI and headless server.

## Scope

- WS RPC transport primitives (`server`, `codec`, `types`, `capabilities`)
- Runtime platform contracts (`PlatformServices`) and headless implementation
- Handler dependency contracts and RPC handlers (`src/handlers/`)
- Product sessions and lifecycle orchestration (`src/sessions/SessionManager.ts`)
- Domain services, model fetchers and WebUI hosting
- Reusable headless bootstrap orchestration

The agent kernel runs in `packages/pi-agent-server`, outside this package. Its normal profile uses durable's `GenerationTask`; the current coding profile connects `CodingHost` to `@mkagent/coding-runtime`. The [architecture guide](../../docs/architecture.md) describes the current boundary. The [Coding specification](../../docs/pi-durable/coding-capabilities-spec.md) defines the migration: durable built-ins first, then independent official Pi SDK APIs, with compatibility code only for confirmed gaps. Product sessions, permissions, credentials and transports remain host responsibilities.

## Out of scope

- Electron UI/main-process window management
- Renderer channel maps and generated client API wrappers
- Agent model/tool execution inside the Pi subprocess

Electron supplies platform-specific capabilities through the runtime contracts. Shared session and RPC implementations live in this package.
