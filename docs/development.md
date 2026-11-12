# Development

This page summarizes how to set up an MkAgent development environment and which commands match which release artifact.

## Requirements

| Tool | Version | Why |
|---|---|---|
| Bun | 1.3.14+ | Workspace, runtime, builds (`bun.lock`) |
| Node | ≥ 18 | Fallback runtime for Node-based tools |
| Python | 3.12 | Document-tool smoke tests |
| `uv` | latest compatible for development; `0.10.6` in desktop release builds | Runs document-tool smoke tests and prepares assets; packaged artifacts bundle their target-platform binary |
| Git | any modern version | `pre-commit`-style checks via husky are opt-in |

`bun` is the only workspace linker; npm/yarn are not used to install dependencies because `bun.lock` is the source of truth.

## First-time setup

```bash
git clone https://github.com/MkThingsHQ/mkagent.git
cd mkagent
bun install --frozen-lockfile
bun run validate:dev
```

If you have to add or upgrade a dependency, edit the appropriate `package.json`, run `bun install` (without `--frozen-lockfile`) to refresh `bun.lock`, and re-run `bun install --frozen-lockfile` to confirm deterministic resolution.

## Workspace layout

```text
apps/
  electron/    # Electron desktop (main, preload, renderer, Browser pane)
  webui/       # Loads the same renderer through a browser adapter
  cli/         # RPC CLI (`run`, `session`, `workspace`, `send`, ...)
packages/
  core/                # Stable DTOs, AgentEvent, error codes
  shared/              # Config, credentials, prompts, Skills, theme, i18n
  ui/                  # React primitives, markdown/code/doc renderers
  server-core/         # Transport, RPC, SessionManager, runtime
  server/              # Headless MKAGENT_SERVER_TOKEN server
  pi-agent-server/     # Pi-durable subprocess (Bun, JSONL on stdio)
  coding-runtime/   # Coding capabilities and Pi plugin compatibility
  session-tools-core/  # Plan / Skill / mini LLM / browser / session info / list
docs/                  # English-language documentation
docs/zh/               # Chinese translation
scripts/               # Dev / build / lint / audit
docs/migration/        # Migration plan, audit, UI history
```

`apps/online-docs` is intentionally outside the workspace globs.

For kernel changes, follow the [Coding capability specification](./pi-durable/coding-capabilities-spec.md) and [implementation plan](./pi-durable/durable-coding-agent-plan.md). Keep the Pi Coding layer used by MkAgent and attempt to replace its execution base with durable. Prefer reusable SDKs to reduce source-by-source upgrade work. Reuse durable built-ins, then independent official Pi SDK public APIs, before adding compatibility code. The root, shared and server-core packages declare `pi-ai 1.1.0`; the coding and agent-server packages use Pi `1.5.0`. Check repository patches separately from published APIs. Craft UI source rules do not require a complete Pi coding runtime or CLI source port.

## Common commands

| Goal | Command |
|---|---|
| Install dependencies (CI-mode) | `bun install --frozen-lockfile` |
| Reinstall dependencies | `bun install --force` |
| Run Electron in dev (vite + electron) | `bun run electron:dev` |
| Build and start Electron | `bun run electron:start` |
| Start the WebUI and backend with hot module replacement | `bun run webui:dev` |
| Start the headless server with the built WebUI | `bun run server:dev:webui` |
| Production headless server (WebUI bundled, Pi built) | `bun run server:prod` |
| Build the CLI binary | `bun run cli:build` (output: `apps/cli/dist/mkagent`) |
| Build the Pi subprocess | `bun run server:build:subprocess` |
| Build a dev-signed macOS arm64 .app | `bun run electron:dist:dev:mac` |
| Run all unit + isolated tests | `bun run test` |
| Check all package types, selected shared tests, and document-tool smoke tests | `bun run validate:dev` |
| Run validate:dev and i18n parity, usage, and sort checks | `bun run validate:ci` |
| Run Craft checks and Electron/shared/UI ESLint | `bun run lint` |
| Audit MkAgent ↔ Craft reuse | `bun run audit:craft-reuse` |
| Audit Craft renderer reuse and Lite boundaries | `bun run lint:craft-ui-sync` |
| Audit Craft test coverage | `bun run lint:craft-test-coverage` |
| Lint English/Chinese locale parity | `bun run lint:i18n:parity` |
| Sort locales | `bun run sort-locales` (check-only: `bun run lint:i18n:sorted`) |

`validate:ci` does not run the full `bun run test` suite, ESLint, or Craft audits. Run those commands separately.

Before you run `bun run lint` or a Craft audit, prepare an independent reference checkout at the pinned commit and set `CRAFT_AGENT_SOURCE` to its root. See [upstream synchronization](./upstream-sync.md) for the clone commands, current baseline, and reference checks.

## Web development

Start the WebUI and backend together:

```bash
bun run webui:dev
```

This command builds the WebUI and Pi subprocess, then starts the backend and Vite. Wait until the backend is ready, then open `http://localhost:5175`. API and WebSocket requests go to the backend on port `9100` by default. Both processes inherit `MKAGENT_RPC_PORT` when you set it. If either process exits, the command stops the other process too.

Stop any earlier WebUI development command with `Ctrl+C` before you run this command. If port `5175` is occupied, startup fails instead of stopping the process that owns it.

To use the built WebUI without Vite or hot module replacement, run `bun run server:dev:webui` and open `http://localhost:9100` after the server is ready.

A Vite error such as `connect ECONNREFUSED 127.0.0.1:9100` means that the backend is not accepting connections. Check the `[server]` output for a startup error and confirm the backend port.

## Isolate the config directory

The configuration root defaults to `~/.mkagent` but can be redirected for parallel development or isolated tests:

```bash
CONFIG_DIR=/tmp/mkagent-dev bun run server:dev:webui
```

`CONFIG_DIR` is read once at module-load (`packages/shared/src/config/paths.ts`) and influences every downstream path (workspaces, credentials, logs, tool icons). Tests inject the env var explicitly; they do not create files in `$HOME`.

## Useful environment variables

| Variable | Default | Effect |
|---|---|---|
| `CONFIG_DIR` | `~/.mkagent` | Override the configuration root (also called the "data directory") |
| `CRAFT_AGENT_SOURCE` | `../craft-agents-oss`, then `../../agents/craft-agents-oss` | Craft reference checkout root for lint and audits; HEAD must match `scripts/craft-source-overrides.json#baselineCommit` |
| `MKAGENT_SERVER_TOKEN` | — | Required bearer token for headless server RPC auth |
| `MKAGENT_RPC_HOST` / `MKAGENT_RPC_PORT` | `127.0.0.1` / `9100` | Server bind address / port |
| `MKAGENT_RPC_TLS_CERT` / `_KEY` / `_CA` | — | Enable `wss://` with PEM-encoded cert/key; CA is optional |
| `MKAGENT_HEALTH_PORT` | `0` (off) | Bind a sidecar HTTP health endpoint |
| `MKAGENT_APP_ROOT` | repo root (dev) | Where the server reads bundled assets |
| `MKAGENT_RESOURCES_PATH` | same as app root | Override the resources directory |
| `MKAGENT_BUNDLED_ASSETS_ROOT` | unset | Dev-only override that points the headless server at `apps/electron` resources |
| `MKAGENT_IS_PACKAGED` | `false` | Set to `true` inside production builds |
| `MKAGENT_VERSION` | `package.json#version` | Override the reported server version |
| `MKAGENT_DEBUG` | unset | Enable extra debug logging |
| `MKAGENT_WEBUI_DIR` | unset | Enable WebUI assets on the RPC port |
| `MKAGENT_WEBUI_PASSWORD` / `_SECURE_COOKIE` / `_WS_URL` | unset | WebUI login password, cookie `Secure` flag override, and browser-side `ws://` URL |
| `MKAGENT_PI_MODEL_API` | unset | Interceptor-level Pi model hint |
| `MKAGENT_UV` / `MKAGENT_BUN` / `MKAGENT_NODE` | unset | Override script runtimes; packaged launchers normally inject absolute bundled paths, while development may fall back to PATH |
| `MKAGENT_DEV_RUNTIME` | unset | Set to `1` to skip code-signing during local packaging |
| `SENTRY_ELECTRON_INGEST_URL` | empty (inert) | Required to enable Sentry uploads in the Electron app |
| `MKAGENT_SERVER_URL` / `MKAGENT_TLS_CA` | unset | CLI connection options |
| `MKAGENT_WORKSPACE` | `default` | CLI workspace override |
| `LLM_API_KEY` / provider env var | unset | CLI self-contained `run` API credential |

## Conventions

- Reuse existing package boundaries and naming before adding new abstractions.
- Reference checkouts (`craft-agents-oss`, `echo`, `xagent`) are read-only; never commit changes to them.
- Every module change ships with its tests and a documentation update.
- Run `git diff --check` before commit and confirm the changed files are only what you intended.

## Clean-worktree validation pattern

When working on a detached or fresh worktree, dependencies are not hoisted by default:

```bash
bun install --force --frozen-lockfile
bun run validate:ci
```

This runs the current `validate:ci` checks without a GUI. Run `bun run test`, `bun run lint`, and `bun run audit:craft-reuse` separately. The [migration archive](./migration/migration-features.md) records earlier validation results.
