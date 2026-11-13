# 上游同步

MkAgent 的架构、UI 与运行时继承自 [Craft Agents OSS](https://github.com/craft-ai-agents/craft-agents-oss)。本文定义在 Lite 边界内吸收新 Craft 变更的工作流。

Craft 同步与当前内核迁移分别确定范围。内核按 [Coding 能力规格](../pi-durable/coding-capabilities-spec.md)和[实施计划](../pi-durable/durable-coding-agent-plan.md)执行：先 durable 内置，再独立 Pi 官方 SDK 公开 API，必要兼容最后，保持 MkAgent 功能。Craft 来源与 UI 复用规则不要求移植完整 Pi coding 运行时或 CLI。根目录、shared 和 server-core 声明 `pi-ai 1.1.0`，coding 和 agent-server 使用 Pi `1.5.0`。`sync/` 验证文件保留各发布版本的输入和结果，不冻结当前内核依赖，也不授权删除现有能力。

## 当前基线

| 项 | 值 |
|---|---|
| 仓库 | `craft-ai-agents/craft-agents-oss` |
| Tag | `v0.15.6` |
| Commit | `8df01c5d0ac73c35add5954e6f190ce038d35845` |

## 最近一次上游评估

| 项 | 值 |
|---|---|
| 评估日期 | `2026-10-26` |
| 上游 Tag | `v0.15.6` |
| 上游 Commit | `8df01c5d0ac73c35add5954e6f190ce038d35845` |

MkAgent 0.2.6 **仅同步 v0.15.5 → v0.15.6**。[逐路径清单](../sync/0.15.6-inventory.json)覆盖全部 93 个改动路径；[验证记录](../sync/0.15.6-validation.md)区分自动化、真实 Pi 链路与界面 fixture。

Coding 会话新增 `pr_status`、`pr_bind`、`pr_unbind`、`pr_set_auto_merge`。状态优先复用 header 快照，其他会话只读缓存；绑定先验证，`gh pr create` 后自动绑定额外 PR。自动合并只在用户明确要求时改变，使用仓库允许的方法。Pi 注册、执行入口及 Explore 权限均保留模式过滤。

多 PR 卡片组合当前分支与 pinned PR，支持 tabs、溢出 +N、左右键、紧急状态、复制链接与 Unpin。pinned PR 的修复提示明确使用已有 worktree、新 worktree 或独立 clone，保留当前目录分支及未提交内容。Auto 仅适用于本分支 PR，由用户主动开启；应用运行且计算机唤醒时每五分钟检查可信 owner/member/collaborator 的新评审反馈，过滤自己的回复。服务端调度独立于窗口，记录去重游标、重启恢复，停用/删除/退出时清理；异步查询返回后重新核实权限、开关与实际 checkout。评论视为不可信数据，不因评论执行命令或打开链接，不扩大 push/comment/merge/auto-merge 授权。

本机仓库递归四层搜索，跳过 node_modules、Library、隐藏目录及工作区数据，遇仓库停止、避免 symlink 循环，合并 worktree/bare 仓库；两秒总预算覆盖遍历与 Git 查询，支持 ~ 路径。已开始会话切换 Coding mode 立即创建新会话，后台总结，首条消息最多等待 30 秒，顺序队列、取消、失败、超时、删除与迟到总结均隔离。

2026-10-26 的同步保留了 MkAgent 品牌、本地配置、Pi 1.1.0，以及 v0.15.4/0.15.5 和此前全部已同步能力。Claude 配置转发修复当时按段评估：Pi 已整包传递配置、使用 SDK 图片缩放和既有 compaction/context 计量，并新增回归验证，未恢复 Claude SDK。该批仍排除 Sources/MCP OAuth relay、Pages、Projects/conductor、Automations 产品、公开分享、labels/custom statuses 和 messaging，Decision/Guarded 继续暂缓；PR Auto review fix 属于该批明确接入的 Coding 功能。这些是当次发布事实，不要求当前全部 Pi 依赖维持 1.1.0。

```bash
# 仅操作独立的临时参考副本，已有参考目录保持只读。
git clone --no-checkout https://github.com/craft-ai-agents/craft-agents-oss.git /tmp/craft-v0156
git -C /tmp/craft-v0156 fetch origin refs/tags/v0.15.6
git -C /tmp/craft-v0156 checkout --detach 8df01c5d0ac73c35add5954e6f190ce038d35845
export CRAFT_AGENT_SOURCE=/tmp/craft-v0156
```

UI 同步、测试覆盖分类和来源复用检查共用此参考副本。脚本优先使用 `CRAFT_AGENT_SOURCE`；未设置时，依次查找相对于 MkAgent 仓库根目录的 `../craft-agents-oss` 和 `../../agents/craft-agents-oss`。变量为空会报错。路径必须指向 Git checkout 根目录，HEAD 必须匹配 `scripts/craft-source-overrides.json#baselineCommit`，且 renderer 目录必须存在。准备完成后，参考副本保持干净、只读。

在 MkAgent 仓库中运行：

```bash
bun run lint
bun run audit:craft-reuse
```

`bun run lint` 包含 UI 同步、测试覆盖分类与 Electron/shared/UI ESLint。`bun run audit:craft-reuse` 单独检查来源哈希和已审阅差异。两者均不属于 `validate:ci`。

当上游发布值得评估的新 tag 时:

1. 记录新 tag 与 commit:`git -C ../craft-agents-oss rev-parse HEAD && git -C ../craft-agents-oss describe --tags --always`。
2. 把 commit 加到本文件的 "当前基线" 表中。
3. 用新 commit 重新跑下面的步骤。

MkAgent 工作期间,参考 checkout(`../craft-agents-oss`、`../echo`、`../xagent`)保持只读。

## 同步流程

```text
  ┌──────────────────────────────────────────────────────────────────┐
  │ 1. 锁基线                                                          │
  │    git -C "$CRAFT_AGENT_SOURCE" checkout <commit>                  │
  │    git -C "$CRAFT_AGENT_SOURCE" status --short   # 必须干净          │
  │                                                                  │
  │ 2. 更新 audit                                                      │
  │    bun run audit:craft-reuse                                      │
  │       期望:所有差异均已审阅并登记                            │
  │    bun run lint:craft-test-coverage                              │
  │       期望:无解释缺失 = 0                                         │
  │                                                                  │
  │ 3. 逐文件接入上游变更                                              │
  │    每个改动 same-path 文件的 upstream commit:                     │
  │      classify:  STRICT_REUSE  |  LITE_SEAM  |  REMOVED_FEATURE    │
  │      STRICT_REUSE:   原样取文件,刷新哈希                          │
  │      LITE_SEAM:      手工合并,保留 MkAgent 定制缝                  │
  │      REMOVED_FEATURE: 不要导入,在 seam 里写明原因                 │
  │                                                                  │
  │ 4. 评估仅上游存在的新功能                                          │
  │      适配 MkAgent 范围 → mkagent migration-review issue           │
  │      不在范围       → 保持 MkAgent Lite                            │
  │                                                                  │
  │ 5. 校验                                                            │
  │    bun run typecheck:all                                          │
  │    bun run lint                                                   │
  │    bun run validate:ci                                            │
  │    bun run audit:craft-reuse    # 合并后哈希仍稳定                │
  │    bun run test                                                    │
  │    bun run electron:build                                         │
  │    bun run webui:build                                            │
  │    bun run cli:build                                              │
  │    bun run server:build:subprocess                                │
  │                                                                  │
  │ 6. 对全新 config dir 做 GUI smoke                                  │
  │    rm -rf /tmp/mkagent-smoke && CONFIG_DIR=/tmp/mkagent-smoke \│
  │       bun run electron:dist:dev:mac                              │
  │    + headless smoke: bun run server:dev:webui                     │
  └──────────────────────────────────────────────────────────────────┘
```

## 文件 seam 分类

| 类别 | 规则 | 校验方式 |
|---|---|---|
| `STRICT_REUSE` | 同相对路径,只有机械差异(scope、URL 协议、配置根、品牌字符串) | `audit:craft-reuse` 归一化后逐字一致 |
| `LITE_SEAM` | 同相对路径,但已删除对应排除功能的分支,或接到 MkAgent 专用接口 | 人工语义审 + 定向 unit/integration 测试 + typecheck |
| `REMOVED_FEATURE` | 因对应的产品能力已删除,整个文件从 MkAgent 中移除 | 路径、call site、build closure 与 `lint:craft-test-coverage` 标签 |

接入上游独有功能时,先过一遍 Lite 问题;只挑选适配 Lite 边界的功能。

## 覆盖清单

两份源真值文件记录哪些 MkAgent 文件相对 Craft 偏离:

- `scripts/craft-source-overrides.json`(跟踪所有 `apps/`、`packages/` 源文件)
- `scripts/craft-ui-overrides.json`（renderer 范围内已审阅的子集）

每次同步后,**必须**重新生成并审阅。`audit:craft-reuse` 通过的前提是偏离合理,而**不是**只为了通过检查去 bump 哈希。

## 不允许同步的内容

- Claude Agent SDK backend 与 `claude-agent-sdk*` 包；保留的 Claude OAuth 必须继续通过 Pi
- GitHub Copilot、通用 / Sources OAuth 及其 SDK
- 外部 messaging gateway 与 worker
- Craft Sources 产品界面、独立 MCP server 与 bridge server workspace；保留 durable MCP 客户端及所需的 Coding 项目 MCP 接入
- Craft 的 `gen_image` 工具和独立图片生成 UI；保留在配置兼容图片模型与凭据后通过 codemode 调用 `models.generateImages()` 的能力
- 公开分享、Viewer app
- 产品 Automations 与 scheduler UI
- Sources API / Settings UI、会话 labels、用户自定义 status
- WhatsApp worker

排除范围限于这些 Craft 产品功能，不禁止 Pi 插件模型 provider 授权、Coding MCP OAuth 或其他必需内核能力。当前范围见[差异对比](./comparison-with-craft.md)和 [Coding 能力规格](../pi-durable/coding-capabilities-spec.md)；[迁移归档](../migration/README.md)保留早期删除决定。

## 故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| `Craft reference check failed` | 参考目录缺失、路径无效、checkout 不完整或 HEAD 错误 | 按上文准备独立参考副本，并将 `CRAFT_AGENT_SOURCE` 设为固定提交的 checkout 根目录 |
| `audit:craft-reuse` 报一个文件意外失配 | seam 修改后忘了刷新覆盖哈希 | 重新生成 `scripts/craft-source-overrides.json`,接受前再审一下差异 |
| `lint:craft-test-coverage` 出现 "missing" 标签 | 上游 test 移动 / 新增但没归类 | 在 `scripts/check-craft-test-coverage.ts` 中更新 seam 分类 |
| 同步后 `apps/electron/src/main` 单独报类型错 | 上游引入了新的环境变量或平台辅助 | 确认它能跨过 Lite seam,在提交前记录在文档中 |
| 打包后 renderer asset 404 | 新增上游 asset 但没更新 `scripts/copy-assets.ts` | 把 asset 加到 copy list 并重新构建 |
| `electron:build` 成功,但 `MkAgent Helper` 缺少某个 plugin | 确认 `appId` 是 `app.mkagent.desktop` 且 `extraResources` 只用 `@mkagent/*` 域 | 检查 `apps/electron/electron-builder.yml` |
