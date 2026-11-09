# MkAgent 文档（中文）

本目录是 MkAgent 用户文档的中文译本，与 [`docs/`](../) 下的英文文档一一对应。MkAgent 基于 [Craft Agents OSS](https://github.com/craft-ai-agents/craft-agents-oss) 派生，当前选择性同步基线为 [`v0.15.6`](./upstream-sync.md)。当前运行时只有 Pi：agent 内核（`@earendil-works/pi-durable`）在独立 Bun 子进程中运行，Electron、WebUI、CLI 与 headless server 共用同一套 RPC 合约。内核从 agent 目录中的 `mcp.json` 加载 MCP 服务器配置。MkAgent 支持 API key、OpenAI/Anthropic 兼容端点、Ollama，以及保留的 ChatGPT Plus / Claude Pro/Max 订阅流程。不包含 Claude Agent SDK、GitHub Copilot、外部消息、产品 Automations、Projects/Kanban、Craft 的 Sources 界面或 Viewer/公开分享。启用 codemode 且有兼容的图片模型和凭据时，MkAgent 可调用 `models.generateImages()` 生成图片。没有独立的图片生成界面。

## 文档导航

第一次直接改用 `pi-durable` 后出现了 Coding 与 Pi 插件缺口。本次保留 MkAgent 所用的 Pi coding agent 层，尝试将其执行基座换成 durable。以原始 MkAgent/Coding 接入为行为参照，保留后续有效功能与已有数据。优先复用官方 SDK，减少以后 Coding 和 durable 更新时逐文件维护源码的责任。先采用 durable 内置能力，再用独立 Pi 官方 SDK 的公开 API；只有具体缺口得到论证后才保留薄适配或必要源码。允许按需引用 `pi-agent-core` 和 `pi-coding-agent` 的公开 SDK，不启动原版 CLI；SDK 覆盖后删除对应源码和多余直接依赖，只保留有具体缺口依据的适配。第三方资源替换、删行数和复制原版 CLI 的完整源码闭包均不是迁移目标。当前工作以[能力规格](../pi-durable/coding-capabilities-spec.md)和[实施计划](../pi-durable/durable-coding-agent-plan.md)为准，取代早期迁移限制。

| 主题 | 文档 |
| --- | --- |
| 整体架构 | [architecture.md](./architecture.md) |
| Pi-durable 内核规格与验收 | [pi-durable/README.md](../pi-durable/README.md) |
| 附件 | [attachments.md](./attachments.md) |
| Browser 面板 | [browser.md](./browser.md) |
| 命令行 | [cli.md](./cli.md) |
| 连接与模型 | [connections.md](./connections.md) |
| 与 Craft Agents 的当前差异对比（含安装包体积） | [comparison-with-craft.md](./comparison-with-craft.md) |
| 数据目录 | [data-directory.md](./data-directory.md) |
| 开发环境 | [development.md](./development.md) |
| 文档工具 | [document-tools.md](./document-tools.md) |
| 功能矩阵 | [featues.md](./featues.md) |
| 网络代理 | [network-proxy.md](./network-proxy.md) |
| Ollama | [ollama.md](./ollama.md) |
| 权限 | [permissions.md](./permissions.md) |
| 发布、更新与遥测 | [releases.md](./releases.md) |
| 会话 | [sessions.md](./sessions.md) |
| Skills | [skills.md](./skills.md) |
| 测试 | [testing.md](./testing.md) |
| 上游同步 | [upstream-sync.md](./upstream-sync.md) |
| Workspace | [workspaces.md](./workspaces.md) |

首次使用建议先读 [development.md](./development.md)，再阅读 [connections.md](./connections.md)、[permissions.md](./permissions.md) 与 [sessions.md](./sessions.md)。`migration/` 是实现归档目录，其中的计划和审计快照均为历史记录，除非章节明确说明当前代码状态。

## 翻译约定

- 保留英文品牌、命令、代码块、文件路径与配置项字面量；解释性段落译为中文。
- "Lite" 在叙述中译为"精简版"或"精简发行版"；在产品名、配置名、文件名和代码上下文中保留英文。
- "Craft Agent" 与 "Craft" 视上下文保留或译为"上游 Craft"。
- 命令、文件名、JSON 字段、协议头、变量名以英文为准，方便直接复制执行。
- 如发现中文文档与英文原文不一致，请以英文原文为准并提交修订。
