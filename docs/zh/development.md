# 开发环境

本节汇总如何搭建 MkAgent 的开发环境,以及每个 release 产物对应的命令。

## 依赖要求

| 工具 | 版本 | 用途 |
|---|---|---|
| Bun | 1.3.14+ | workspace、runtime、构建(`bun.lock`) |
| Node | ≥ 18 | Node 工具的备用运行时 |
| Python | 3.12 | 文档工具 smoke 测试 |
| `uv` | 开发期使用兼容的最新版本；Desktop release 内置 `0.10.6` | 运行文档工具 smoke test 和准备构建资源；打包产物会内置目标平台二进制 |
| Git | 任意现代版本 | 可选启用 husky pre-commit |

`bun` 是唯一的 workspace linker;不通过 npm / yarn 安装依赖,因为 `bun.lock` 是唯一真值来源。

## 首次配置

```bash
git clone https://github.com/MkThingsHQ/mkagent.git
cd mkagent
bun install --frozen-lockfile
bun run validate:dev
```

如需新增或升级依赖,改对应 `package.json` 后用 `bun install`(不带 `--frozen-lockfile`)刷新 `bun.lock`,再用 `bun install --frozen-lockfile` 校验锁定文件。

## 仓库布局

```text
apps/
  electron/    # Electron desktop(main、preload、renderer、Browser 面板)
  webui/       # 通过浏览器 adapter 加载同一份 renderer
  cli/         # RPC CLI(`run`、`session`、`workspace`、`send` 等)
packages/
  core/                # 稳定 DTO、AgentEvent、错误码
  shared/              # 配置、凭证、提示词、Skills、theme、i18n
  ui/                  # React primitives、markdown/code/doc 渲染
  server-core/         # Transport、RPC、SessionManager、运行时
  server/              # headless `MKAGENT_SERVER_TOKEN` server
  pi-agent-server/     # Pi SDK 子进程(Bun,JSONL on stdio)
  session-tools-core/  # Plan / Skill / mini LLM / browser / session info / list
docs/                  # 英文文档
docs/zh/               # 中文翻译
scripts/               # dev / build / lint / audit
docs/migration/        # 迁移计划、audit、UI 历史
```

`apps/online-docs` 被刻意排除在 workspace glob 之外。

## 常用命令

| 目标 | 命令 |
|---|---|
| 安装依赖(CI 模式) | `bun install --frozen-lockfile` |
| 重新安装依赖 | `bun install --force` |
| 在 dev 模式运行 Electron(vite + electron) | `bun run electron:dev` |
| 构建并启动 Electron | `bun run electron:start` |
| 同时启动 WebUI 热更新开发服务与后端 | `bun run webui:dev` |
| 启动带已构建 WebUI 的 headless server | `bun run server:dev:webui` |
| 生产 headless server(WebUI 已打包、Pi 已构建) | `bun run server:prod` |
| 构建 CLI 二进制 | `bun run cli:build`(输出 `apps/cli/dist/mkagent`) |
| 构建 Pi 子进程 | `bun run server:build:subprocess` |
| 构建 macOS arm64 dev 签名的 .app | `bun run electron:dist:dev:mac` |
| 跑全部 unit + isolated 测试 | `bun run test` |
| 校验所有 package 的类型、指定 shared 测试和文档工具 smoke 测试 | `bun run validate:dev` |
| 运行 validate:dev 与 i18n parity、usage、排序检查 | `bun run validate:ci` |
| 运行 Craft 检查与 Electron/shared/UI ESLint | `bun run lint` |
| 审计 MkAgent ↔ Craft 复用关系 | `bun run audit:craft-reuse` |
| 审计 Craft renderer 复用与 Lite 边界 | `bun run lint:craft-ui-sync` |
| 审计 Craft 测试覆盖率 | `bun run lint:craft-test-coverage` |
| 校验中/英文 locale parity | `bun run lint:i18n:parity` |
| 排序 locales | `bun run sort-locales`(只检查:`bun run lint:i18n:sorted`) |

`validate:ci` 不运行完整的 `bun run test` 套件、ESLint 或 Craft 审计，这些命令需要单独运行。

运行 `bun run lint` 或任一 Craft 审计前，先准备固定提交的独立参考 checkout，并将 `CRAFT_AGENT_SOURCE` 设置为其根目录。克隆命令、当前基线和参考副本检查见[上游同步](./upstream-sync.md)。

## Web 开发

用一条命令启动 WebUI 和后端：

```bash
bun run webui:dev
```

该命令先构建 WebUI 和 Pi 子进程，再同时启动后端与 Vite。等待后端就绪后，打开 `http://localhost:5175`。API 和 WebSocket 请求默认转发到后端的 `9100` 端口；设置 `MKAGENT_RPC_PORT` 时，两个进程会继承同一值。任一进程退出时，整组进程都会停止。

启动前先用 `Ctrl+C` 结束先前运行的 WebUI 开发命令。若 `5175` 已被占用，启动会明确失败，不会停止占用端口的进程。

如果只需构建好的 WebUI，不需要 Vite 和热更新，可运行 `bun run server:dev:webui`，等待服务就绪后打开 `http://localhost:9100`。

Vite 报 `connect ECONNREFUSED 127.0.0.1:9100` 表示后端没有接受连接。请查看 `[server]` 输出中的启动错误，并确认后端端口。

## 隔离 config 目录

默认配置根目录为 `~/.mkagent`,但为了并行开发或隔离测试可以重定向:

```bash
CONFIG_DIR=/tmp/mkagent-dev bun run server:dev:webui
```

`CONFIG_DIR` 在模块加载时(`packages/shared/src/config/paths.ts`)读一次,所有下游路径(workspaces、credentials、logs、tool icons)都会跟随。测试通过 `CONFIG_DIR` 显式注入,不会在 `$HOME` 下创建文件。

## 常用环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CONFIG_DIR` | `~/.mkagent` | 配置根(也叫数据目录)覆盖入口 |
| `CRAFT_AGENT_SOURCE` | 依次查找 `../craft-agents-oss`、`../../agents/craft-agents-oss` | lint 和审计使用的 Craft 参考 checkout 根目录；HEAD 必须匹配 `scripts/craft-source-overrides.json#baselineCommit` |
| `MKAGENT_SERVER_TOKEN` | — | headless server RPC 鉴权必需的 bearer token |
| `MKAGENT_RPC_HOST` / `MKAGENT_RPC_PORT` | `127.0.0.1` / `9100` | server 绑定地址 / 端口 |
| `MKAGENT_RPC_TLS_CERT` / `_KEY` / `_CA` | — | 启用 `wss://`,使用 PEM 编码的 cert/key;CA 可选 |
| `MKAGENT_HEALTH_PORT` | `0`(关闭) | 绑定 sidecar HTTP health 端点 |
| `MKAGENT_APP_ROOT` | dev 下为 repo 根 | server 读取打包资源的根 |
| `MKAGENT_RESOURCES_PATH` | 同 app root | 覆盖 resources 目录 |
| `MKAGENT_BUNDLED_ASSETS_ROOT` | 不设置 | dev 用覆盖,把 headless server 指向 `apps/electron` resources |
| `MKAGENT_IS_PACKAGED` | `false` | 生产构建内设置为 `true` |
| `MKAGENT_VERSION` | `package.json#version` | 覆盖 server 上报的版本 |
| `MKAGENT_DEBUG` | 不设置 | 启用额外 debug 日志 |
| `MKAGENT_WEBUI_DIR` | 不设置 | 在 RPC 端口上启用 WebUI 资源 |
| `MKAGENT_WEBUI_PASSWORD` / `_SECURE_COOKIE` / `_WS_URL` | 不设置 | WebUI 登录密码、cookie `Secure` 标志覆盖、浏览器侧 `ws://` URL |
| `MKAGENT_PI_MODEL_API` | 不设置 | 给 interceptor 的 Pi 模型提示 |
| `MKAGENT_UV` / `MKAGENT_BUN` / `MKAGENT_NODE` | 不设置 | 覆盖脚本 runtime；打包 launcher 通常注入内置绝对路径，开发期才可回退到 PATH |
| `MKAGENT_DEV_RUNTIME` | 不设置 | 设为 `1` 在本地打包时跳过代码签名 |
| `SENTRY_ELECTRON_INGEST_URL` | 空(不生效) | 启用 Electron Sentry 上报必需 |
| `MKAGENT_SERVER_URL` / `MKAGENT_TLS_CA` | 不设置 | CLI 连接参数 |
| `MKAGENT_WORKSPACE` | `default` | CLI 的 workspace 覆盖 |
| `LLM_API_KEY` / provider 环境变量 | 不设置 | CLI 自包含 `--run` 模式的 API 凭证 |

## 约定

- 添加新抽象之前先复用现有 package 边界和命名。
- 参考 checkout(`craft-agents-oss`、`echo`、`xagent`)只读;不要向它们提交修改。
- 每个模块改动都附带测试与文档更新。
- 提交前跑一次 `git diff --check`,确认改动文件就只是你意图的这些。

## 干净 worktree 校验模式

在 detached / 全新 worktree 下,默认没有 hoisted 依赖:

```bash
bun install --force --frozen-lockfile
bun run validate:ci
```

这一组合运行当前的 `validate:ci` 检查，不启动 GUI。`bun run test`、`bun run lint` 与 `bun run audit:craft-reuse` 需要单独运行。[迁移归档](../migration/migration-features.md)记录了此前的验证结果。
