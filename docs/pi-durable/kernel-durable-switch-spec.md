# 内核切换执行规格：pi-coding-agent → pi-durable

状态：内核切换已落地，正在对照本地 `main` 复核功能兼容性（2026-11-01，分支 `dev/pi-durable`）。落地结果见 §8；与规格的差异以 §8 为准。
范围：`packages/pi-agent-server` 子进程内核替换；宿主协议与宿主侧代码零改动。

## 1. 目标与验收条件

把 mkagent 的 agent 内核从 `@earendil-works/pi-coding-agent` 1.1.0（`createAgentSession` 运行时）切换到 `@earendil-works/pi-durable` 1.4.0（Harness 运行时），功能保持不变，切换对宿主与 UI 无感。

验收条件（可判定）：

1. `bun run typecheck:all` 通过；`packages/pi-agent-server` 无 `pi-coding-agent`/`pi-agent-core` 运行时依赖（类型依赖亦清零）。
2. `packages/pi-agent-server` 现有测试改写后全部通过；根 `bun run test:shared:all` 不回归（宿主侧零改动应保持绿色）。
3. `packages/pi-agent-server` 可构建子进程产物（`bun run server:build:subprocess`）。
4. 旧格式会话（pi-coding-agent JSONL）在新内核下可恢复：迁移转换器有覆盖该路径的测试（构造 fixture 断言转换后的 durable entries 与 id 映射）。
5. 新内核事件流在单元层覆盖：用 stub provider + 内存存储驱动一次「输入 → 助手回复 → 工具调用 → 结束」运行，断言合成出的 `AgentSessionEvent` 序列与旧内核语义一致（message_update 增量、message_end、tool_execution_start/end、turn_end、agent_end、context_usage）。
6. 宿主侧（`packages/shared/src/agent/`、`packages/server-core`、`packages/server`、apps）diff 为零。

## 2. 切换前现状与原始设计

§2 描述切换前的 `main`，§3–§7 保留切换时的原始设计与实施计划，不代表当前实现。当前实现及仍待核验的差异见 §8。

### 2.1 内核边界

`packages/pi-agent-server/src/index.ts`（1973 行）是一个 stdio JSONL 子进程：

- 入站协议 `InboundMessage`：init、prompt、register_tools、tool_execute_response、pre_tool_use_response、abort、mini_completion、llm_query、cancel_ephemeral_query、ensure_session_ready、set_model、set_thinking_level、compact、set_auto_compaction、update_runtime_config、steer、token_update、stop_background_task、shutdown。
- 出站协议 `OutboundMessage`：ready、event（转发 `AgentSessionEvent` + 注入 `context_usage`/`pi_turn_anchor`）、pre_tool_use_request、tool_execute_request、session_tool_completed、mini_completion_result、llm_query_result、ensure_session_ready_result、compact_result、set_auto_compaction_result、update_runtime_config_result、session_id_update、oauth_credential_update、error、background_task_event。
- 内核调用面：`createAgentSession`（会话创建/恢复/分支）、`session.prompt/steer/abort/compact/setModel/setThinkingLevel/setAutoCompactionEnabled/dispose/subscribe`、`session.getContextUsage/settingsManager/getContextUsage`、`PiSessionManager.{continueRecent,inMemory,forkFrom,branch}`、`createReadToolDefinition` 等 7 个内置工具定义、`PiModelRuntime/PiModelRegistry`（模型注册/解析/凭据）。
- 辅助模块：`session-settings`（重试/压缩策略）、`system-prompt-override`（before_agent_start 覆盖系统提示词）、`context-usage`（上下文占用读取）、`compaction-wait`（压缩竞态规避）、`model-resolution`/`pick-mini-model`/`custom-endpoint-models`（模型解析）、`adapt-credential`（凭据适配）、`background-shell`（后台 bash）、`ephemeral-query-lifecycle`（临时查询取消）。

### 2.2 宿主依赖的事件词汇

`packages/shared/src/agent/backend/pi/event-adapter.ts` 消费（durable 侧必须原样合成）：

| 事件 | 语义 | 关键字段 |
|---|---|---|
| `agent_start` | 一次 run 开始（含重试后的续跑） | — |
| `agent_end {willRetry}` | run 结束；`willRetry:true` 时适配器保持队列等待 auto_retry | `messages`、`willRetry` |
| `turn_start`/`turn_end` | 单次模型响应边界 | `turn_end.message/toolResults` |
| `message_update` | 流式增量 | `assistantMessageEvent:{type:'text_delta',delta}` |
| `message_end` | 消息落定（含失败：`stopReason:'error'`+`errorMessage`） | `message:{role,content,stopReason,usage,id}` |
| `tool_execution_start` | 工具调用开始 | `toolCallId,toolName,args` |
| `tool_execution_update` | 工具运行输出流 | `partialResult:{content:[{type:'text',text}]}` |
| `tool_execution_end` | 工具调用结束 | `toolCallId,toolName,result,isError` |
| `compaction_start/end` | 压缩开始/结束 | `reason`、`result:{summary,firstKeptEntryId,tokensBefore,estimatedTokensAfter}`、`aborted,willRetry,errorMessage` |
| `auto_retry_start/end` | SDK 级重试调度 | `attempt,maxAttempts,delayMs,errorMessage` |
| `queue_update`/`agent_settled`/`entry_appended` | 适配器忽略 | — |
| 注入 `context_usage` | 上下文占用 | `PiContextUsagePayload.contextUsage/compactionSettings` |
| 注入 `pi_turn_anchor` | 分支锚点 | `sdkMessageId,sdkTurnAnchor`（= SDK 叶子 entry id） |

`contextUsage` 形状：`{tokens, contextWindow, percent?}`；`compactionSettings`：`{enabled, reserveTokens}`。`tokens` 取自最近一次助手消息 usage（input+cacheRead+cacheWrite+output 口径，见 `contextFromPi`）。

### 2.3 宿主侧其他契约点

- 会话持久化目录：`<sessionPath>/.pi-sessions/*.jsonl`（pi-coding-agent SessionManager 私有格式）；分支 = fork 父会话文件 + 可选 `branch(anchorId)` 截断；锚点由 `pi_turn_anchor` 事件持久化在宿主元数据。
- `register_tools` 后靠 `toolsChanged` 标记在下一次 prompt 前整体重建会话。
- 权限走 `pre_tool_use_request` 握手（allow/block/modify），由工具 execute 包装层发起。
- 临时查询（`llm_query`/`mini_completion`）= 一次性 ephemeral session（无工具、系统提示词覆盖、独立重试预算）。

## 3. 目标内核与版本矩阵

`@earendil-works/pi-durable` 1.4.0（上游仍标注 Experimental）：

- 核心抽象：`Harness.open(storage, {models, registry, settings, env})`、`harness.root(context)`、`conversation.submit({type:'input',content})`（`whenBusy:'steer'|'followUp'`、`whenIdle:'reject'`）、`conversation.watch()`（提交式视图 + 100ms 部分提交）、`conversation.compact(instructions)`、`conversation.abort()`、`conversation.configure({...})`、`conversation.fork(entryId)`、`registry.install(extension)`（运行中可换装）、扩展（tools/sections/hooks/wraps/tasks）、TypeBox 工具、`beforeTool/afterTool` 钩子、durable settings（retry/compaction/steeringMode/followUpMode/stream）。
- 存储：`openNodeJsonlStorage(dir)`（纯可移植实现，无 node:sqlite 依赖，适配 Bun 子进程）。
- 依赖：`pi-ai@1.4.0`、`chord@1.4.0`、`pi-codemode@1.4.0`、`pi-telemetry@1.4.0`、TypeBox。

版本策略：pi-durable 及其 pi-ai 1.4.0 依赖仅进入 `packages/pi-agent-server` 子进程 bundle（bun build 单文件自包含）；宿主各包保持 1.1.0 精确 pin 不动。根 `package.json` 的 `overrides` 块删除（它会把 1.4.0 全局压回 1.1.0），各工作区包已用精确版本号 pin，无漂移风险。

上游没有「coding agent 跑在 durable 上」的参考实现（pi TUI 仍是 pi-agent-core），本次属于早期采用，上游 API 可能无通知变更——升级 durable 版本时以本规格的映射表为回归清单。

## 4. 架构设计

### 4.1 切换边界

只改 `packages/pi-agent-server` 内部实现。JSONL 协议消息与字段不变；宿主（`shared/pi-agent.ts`、`server-core/SessionManager`、apps）零改动。

子进程内新结构：

```
src/index.ts            协议层保留：消息路由、JSONL I/O、后台 shell、call_llm 回环服务
src/kernel.ts           新增：Harness 生命周期、会话创建/恢复/迁移、事件合成（watch → AgentSessionEvent）
src/model-runtime.ts    重写：pi-ai 1.4.0 Models、凭据 store、custom-endpoint provider 注册、模型解析
src/ephemeral.ts        重写：llm_query/mini_completion 直连 pi-ai 流式调用（不经 durable）
src/migrate.ts          新增：pi-coding-agent JSONL → durable 存储转换器 + id 映射
src/tools/builtin.ts    新增：grep/find/ls 工具（自 pi-coding-agent 1.1.0 dist 移植到 durable defineTool）
src/tools/wrap.ts       新增：工具包装（权限握手、mkagent 元数据、大响应摘要、后台 bash）
```

删除：`session-settings.ts`、`system-prompt-override.ts`、`context-usage.ts`、`compaction-wait.ts`（durable 内建压缩调度，无竞态面）、`agent-dir.ts`（durable 无磁盘扩展发现，隔离自动成立；后台任务目录路径逻辑并入 kernel）。保留：`background-shell.ts`、`ephemeral-query-lifecycle.ts`、`mkagent-metadata-schema.ts`、`provider-endpoint-env.ts`、`web-fetch.ts`、`tools/search/*`、`pick-mini-model.ts`（重定向到 1.4.0 模型对象）。

### 4.2 会话与 Harness

一个子进程 = 一个 Harness = 一个主会话：

- 存储：`openNodeJsonlStorage(<sessionPath>/durable-store/)`。首开时若该目录不存在且 `.pi-sessions/*.jsonl` 存在 → 迁移（见 §6）。
- `Harness.open(storage, { models, registry, settings, env }, BACKGROUND_CONTEXT)`：
  - `models`：`createModels()`（pi-ai 1.4.0）+ custom-endpoint provider 注册（§5.1）。
  - `registry`：`createRegistry()`，依次 install：`CodingTools`（read/write/edit/bash）、`MkAgentBuiltinTools`（grep/find/ls）、`MkAgentWebTools`（search/web_fetch）、`MkAgentSystemPrompt`（section）、`MkAgentPermissionHook`（beforeTool）、代理工具扩展（register_tools 到达时 install，同名替换；不再需要 `toolsChanged` 会话重建）。
  - `settings`（活对象，getter 实时读）：
    - `retry: {enabled:true, maxRetries:4, baseDelayMs:2000, maxAgentDelayMs:60000}`（对齐 `MKAGENT_PI_RETRY_SETTINGS`）；
    - `stream: {maxRetries:2, maxRetryDelayMs:60000}`（对齐 provider 级重试）；
    - `steeringMode:'all'`、`followUpMode:'all'`（对齐旧 SDK steeringMode:'all'）；
    - `compaction: {enabled:<live flag>, reserveTokens:<max(16384, contextWindow − autoCompactWindow)>, keepRecentTokens/backgroundTokens 取 durable 默认}`；
    - `progress` 取默认（100ms 部分提交即流式粒度）。
  - `env`: `NodeExecutionEnv`，`cwd` 跟随会话 agent 的 cwd。
- `harness.root(context)` 惰性建根会话；会话 id = durable conversation id（UUIDv7，重开不变）→ `session_id_update`。
- 系统提示词：原计划通过 `section('mkagent-system-prompt', () => hostPrompt)` 替代 `before_agent_start` 覆盖；单独使用 section 无法替换迁移历史中的系统消息，实际实现见 §8.1。

### 4.3 模型运行时（pi-ai 1.4.0）

- 凭据：`InMemoryCredentialStore`（1.4.0）+ 现有 `OAuthSyncCredentialStore` 模式（seed + modify 时外发 `oauth_credential_update`）。
- custom-endpoint：用 pi-ai 1.4.0 的 `models.setProvider(Provider)` 注册（`registerCustomEndpointModels` 重写为 1.4.0 Provider 构造，复用 `custom-endpoint-models.ts` 的模型定义构建逻辑）。
- 模型解析：`resolvePiModel(registry, model, provider, preferCustom)` 重写为对 `models`（`Model` 对象按 provider+id 查找）的解析；`pi/<provider>/<id>` 前缀、`toPiProviderId` 映射、兼容性校验逻辑不变。
- 会话内模型切换：`root.configure({model:{provider, modelId}})`；thinking level：`root.configure({thinkingLevel})`（`THINKING_TO_PI` 映射复用）。
- 认证提供方 env（`applyProviderEndpointEnv`）与 `token_update` 语义保持。

### 4.4 事件合成（kernel.ts 核心）

`root.watch(BACKGROUND_CONTEXT)` 附着视图，diff 前后视图合成事件（附着点之后的变化才转发，避免重放历史）：

| durable 状态变化 | 合成事件 |
|---|---|
| `pi.live.run` 出现 | `agent_start` + `turn_start`（每轮 generation 前） |
| `pi.live.generation.message` 部分文本增长 | `message_update {assistantMessageEvent:{type:'text_delta',delta}}`（diff 出后缀增量） |
| `pi.assistant` entry 落定 | `message_end {message:<AssistantMessage 形状>}`；无 toolCall → `turn_end`；随后 `pi_turn_anchor {sdkMessageId, sdkTurnAnchor:<entryId>}` |
| `pi.live.tools[]` 新增 slot | `tool_execution_start {toolCallId:<callId>, toolName, args}` |
| slot.output 增长 | `tool_execution_update {partialResult:{content:[{type:'text',text}]}}` |
| slot.done / toolResult entry | `tool_execution_end {toolCallId, toolName, result, isError}` |
| `pi.live.compactions[]` 新增 | `compaction_start {reason:<trigger 映射>}` |
| compaction 完成（`pi.compaction` entry） | `compaction_end {reason, result:{summary,firstKeptEntryId,tokensBefore,estimatedTokensAfter}, aborted:false, willRetry:false}`；失败 → `errorMessage` |
| `pi.live.generation.retry` 出现 | `auto_retry_start {attempt,maxAttempts,delayMs,errorMessage}`（配合 `agent_end {willRetry:true}`） |
| retry 到期再跑 | `agent_start`（适配器 retry 状态机 `backoff → recovering`） |
| `pi.live.run` 消失（有 answer） | `agent_end {messages:[], willRetry:false}` |
| `pi.live.runFailure` | 先合成 `message_end {stopReason:'error', errorMessage:detail}`（`model_error` 等有 detail 的情形），再 `agent_end {willRetry:false}`；`aborted` → 仅 `agent_end` |
| 每次 assistant entry / compaction | `context_usage {contextUsage:{tokens:<input+cacheRead+cacheWrite+output>, contextWindow, percent}, compactionSettings:{enabled,reserveTokens}}` |

message_end 的 `message` 字段按 pi-ai 1.1.0 `AssistantMessage` 结构化形状合成（role/content/stopReason/usage/model 等，从 durable entry 的 `model[0]` 与 usage 投影）；宿主适配器按结构消费，不依赖模块同一性。`event.message.usage.cost.total` 由 pi-ai 1.4.0 usage 投影。

`prompt` 消息：`root.submit({type:'input', content:<string|blocks>})`（images 以 pi-ai `ImageContent` blocks 并入 content）；`followUp` 排队语义由 durable inbox 天然提供（`whenBusy` 默认 followUp），替换旧 SDK `streamingBehavior:'followUp'`。

`steer`：`root.submit({type:'input', content, whenBusy:'steer'})`；idle 时等价普通输入（`whenIdle` 不设 reject）。

`abort`：`root.abort()`；同时拒绝 pending 权限请求、清 prefetch 缓存（现状逻辑保留）。

`compact`：`root.compact(customInstructions)` → `harness.waitForTask` → `compact_result`（summary/firstKeptEntryId/tokensBefore 从 compaction entry 投影；`estimatedTokensAfter` 由压缩后 entry usage 估算）。

`set_auto_compaction`：写活 settings 的 `compaction.enabled` 标志。

`ensure_session_ready`：确保 Harness + root 就绪并回 `session_id_update`。

`resume`：子进程重启后 `harness.resume()`；attach watch 先于 resume，恢复运行产生的新 entries 正常进入事件流。读侧辅助打开（跨存储分支）用 `readOnly:true`。

### 4.5 工具体系

- 内置 coding 工具：durable `CodingTools`（read/write/edit/bash，环境经 `NodeExecutionEnv`）；`read` 图片行为由 durable 内建（无 Photon 处理器时直发限额内 PNG/JPEG/GIF/WebP）。
- grep/find/ls：从 `pi-coding-agent@1.1.0` dist 源移植为 durable `defineTool`（TypeBox 参数、`replay:'safe'`、`api.output` 流式输出），行为对齐 1.1.0（rg/fs 同实现思路）。
- 代理工具：`register_tools` → 动态 install 扩展；`parameters` 直接使用宿主 JSON Schema（TypeBox 兼容）；`promptSnippet` 派生逻辑保留；`isError` 结果语义保留（`proxyToolResult` 等价物）。`call_llm` 投机预取逻辑保留。
- 权限：`hook(ToolTask, {beforeTool})` 异步等待 `pre_tool_use_request` 握手；`block → {block:reason}`；`modify → {arguments}`。mkagent 元数据字段（`_intent` 等）继续经 `allowMkAgentMetadataProperties` 进 schema。
- 大响应摘要：包装 execute，`estimateTokens > tokenLimitFor(contextWindow)` 时走 `runMiniCompletion` 摘要（现状逻辑，输入源改从 tool result 文本取）。
- 后台 bash：同名 bash 工具（后 install 覆盖 CodingTools 的 bash）拦截 `run_in_background`，经 `BackgroundShells.start` + `env.exec(['bash','-c',command])` 执行，信号桥 `withAbortSignal(taskSignal, context)`；`bash_execution_update` 事件由 BackgroundShells 现状通道外发。

### 4.6 临时查询

`llm_query`/`mini_completion` 不再创建 ephemeral AgentSession：直接用 pi-ai 1.4.0 `models` 的流式接口发单条 user 消息（system = 覆盖提示词，tools=[]，重试预算 = `MKAGENT_PI_EPHEMERAL_RETRY_SETTINGS`）。取消、deadline（`MKAGENT_PI_EPHEMERAL_QUERY_DEADLINE_MS`）、mini 模型回退（`pickProviderAppropriateMiniModel`/`getDefaultSummarizationModel`）逻辑保留。`call_llm` 回环 HTTP 服务保留。

### 4.7 上下文占用

以 watch 视图为源：最近 assistant usage 投影 `tokens`（pi-ai usage：input+cacheRead+cacheWrite+output 口径与 `contextFromPi` 对齐，实现时以 `contextFromPi` 现行公式为准），`contextWindow` 取当前模型；`compactionSettings` 投影活 settings。`context-usage.ts` 的 `readContextUsage/deferContextUsage` 删除，等价逻辑入 kernel 事件合成。

## 5. 持久化与迁移

### 5.1 存储布局

```
<sessionPath>/durable-store/       durable JSONL 存储（新）
<sessionPath>/.pi-sessions/        旧 pi-coding-agent 会话文件（只读遗留）
<sessionPath>/durable-store/id-map.json   旧 entry id → durable entry id 映射（迁移/分支时写）
```

打开顺序：`durable-store` 存在 → 直接 `Harness.open`；否则 `.pi-sessions/*.jsonl` 存在 → 转换器迁移 → 再开；都没有 → 全新 root。

### 5.2 转换器（migrate.ts）

输入：pi-coding-agent 1.1.0 SessionManager JSONL（SessionEntry 流）。输出：durable entries（UserEntry/AssistantEntry/ToolResultEntry/CompactionEntry/SystemEntry 草稿序列）+ id 映射。规则：

- 顺序保序追加；assistant 消息按 pi-ai 1.4.0 结构投影（content blocks/usage/stopReason 兼容映射，1.1→1.4 差异在转换器内归一）。
- 旧 compaction entry → durable `pi.compaction` entry；旧 custom/metadata entry → 跳过（记日志），不伪造模型可见内容。
- 转换在一次 `commit` 内完成；`id-map.json` 在提交后原子写出。迁移失败的会话：报 `error`（`code:'session_migrate_failed'`），不静默降级为空会话。

### 5.3 分支

`branchFromSessionPath`：

- 父为新格式（有 durable-store）：子进程打开父存储 `readOnly:true` Harness，读根会话 entries（截到锚点）→ 写入子存储；锚点解析失败（无此 entry）→ 回退到父末尾并记日志。
- 父为旧格式：先按 §5.2 把父转换到子存储（不落 id-map 到父目录，映射随子存储写）。
- `branchFromSdkTurnId`（宿主持有的旧锚点）经 id-map 解析；查不到 → 回退父末尾。
- 分支后的锚点一律发 durable entry id，宿主从此积累新锚点。

## 6. 原设计中记录的行为差异

本节保留原设计记录，不视为接受这些差异；实际状态见 §8。

1. 流式粒度从 token 级 delta 变为 durable 100ms 部分提交的文本增量（UI 观感差异极小；`progress.partialIntervalMs` 可调）。
2. 本节原记录的缓存预热缺失属于待修复的 `main` 功能差异；durable generation 任务内部负责重试，`auto_retry_*` 事件由内核合成。
3. `abort` 在 durable 下同时撤回排队输入；与旧 SDK 的队列语义仍需核对。
4. `register_tools` 不再重建会话，改为运行中 install 扩展（下一次请求生效，语义等价且更平滑）。
5. 上游 durable 为 Experimental（README 明示 API 可能无通知变更）。
6. durable JSONL 存储把历史全量驻留内存（与旧 SessionManager 行为一致，长会话内存特征不变；后续可切 SQLite）。

## 7. 实施步骤

1. 依赖与构建：`pi-agent-server/package.json` 增 `@earendil-works/pi-durable@1.4.0`、`@earendil-works/pi-ai@1.4.0`，移除 pi-coding-agent/pi-agent-core；根 `package.json` 删 `overrides`；`bun install` 刷新锁文件。
2. `model-runtime.ts`（模型/凭据/自定义端点/解析）+ 单测。
3. `ephemeral.ts` + 单测（取消、回退）。
4. `tools/builtin.ts`（grep/find/ls 移植）+ `tools/wrap.ts`（权限/元数据/摘要/后台 bash）。
5. `kernel.ts`（Harness、事件合成、compact/model/thinking/auto-compact 处理）。
6. `migrate.ts`（转换器 + fixture 测试）。
7. `index.ts` 收编：协议路由指向 kernel/ephemeral，删除废弃模块与过时测试。
8. 事件合成端到端单测（stub provider + MemoryStorage 路径）；bundle 构建烟测更新。
9. 全量验证：`typecheck:all`、`test:shared:all`、pi-agent-server 测试、`server:build:subprocess`。

每步的完成判据即该模块单测 + typecheck 局部通过；步骤 8 是验收条件 5 的落点。

## 8. 落地记录（as-built，2026-11-01）

分支 `dev/pi-durable`，规格（b77c4a2）之后的提交：e4b75c2（内核切换）、1341518（e2e 与迁移测试）、1e69596（SQLite 存储）、369244d（shared 类型 vendor）、436b789（工具链补齐）、d5bd7c9（独立审查修复）。宿主协议保持兼容；`packages/shared` 增加 vendored 类型与 exports 子路径，并调整事件适配和会话导出。

以下迁移、分支与缓存说明已按本次修复更新并集成主工作区（2026-11-02）。逐项结果见 [内核迁移修复验收记录](kernel-migration-review-fix-spec.md#12-最终集成验收2026-11-02)。

### 8.1 与规格的差异

| 项 | 规格 | 实际 |
|---|---|---|
| 存储 | 统一 `openNodeJsonlStorage`（§5.1） | 新会话与迁移会话默认 SQLite（`bun:sqlite` facade，`src/storage/durable-storage.ts`，upstream README 推荐长会话用 SQLite）；已存在 JSONL store 的会话保持 JSONL（sidecar 不可机械转换） |
| 会话重建 | 删除 `toolsChanged` 重建，改运行中 install（§6.4） | `register_tools` 和 MCP 工具变化通过替换当前注册表发布，不重新打开会话 |
| 会话标识 | 使用 durable conversation id（§4.2） | 对外 session id 存于 `durable-store/session-id.txt`；fork 后的 conversation id 存于 `durable-store/conversation-id.txt`，供恢复及后续分支使用 |
| 权限与图片 | 使用 `beforeTool`；图片不经 Photon（§4.5） | 工具 `execute` 包装负责权限握手；图片通过 durable 的 Photon 处理器转换和缩放。codemode 模型调用也经过宿主权限握手 |
| 上下文与压缩 | 根据最近 usage 和压缩 entry 投影（§4.4、§4.7） | 根据当前会话视图计算最近有效 assistant usage 和后续消息；压缩后没有新 usage 时占用为未知。手动压缩检查任务结果并按压缩后的消息估算；摘要排队时，结束事件等待摘要写入或提交失败 |
| 分支 | 只读父存储并逐条复制；锚点不可用时回退（§5.3） | 使用 durable store 副本创建 fork，SQLite 通过快照复制。首次副本在 `Harness.open()` 前通过 Storage 原子终结继承的非终态任务，将 queued/placed submissions 结算为 `unanswered`，并清理运行态文档。迁移、锚点 fork、watch 附着和配置完成后才调用 `resume()`；普通恢复仍调用 `resume()`。锚点不可解析时报错，不回退父会话末尾。`.durable-branch-pending` 标记未完成的复制，残留标记会阻止直接打开 |
| 旧会话迁移 | 打开存储前转换；旧父会话只转换到子存储（§5.1、§5.3） | 普通会话在打开 Harness 后调用 `migrateLegacySession()`。迁移预检 `migrateParentStore()` 不打开或补写已有 SQLite/JSONL 父库，只有无 durable backend 的纯 legacy 父会话才原地转换。子副本在打开 Harness 后补全所需迁移与 `id-map.json`，再解析锚点 |
| 系统提示词 | 通过 `section` 替代旧的强制覆盖（§4.2） | 保留 `section`；宿主提供提示词时，`GenerationTask.beforeRequest` 将请求中的系统消息投影为一条当前宿主提示词，并保留当前工具声明。历史记录不变，缓存预热使用同一份投影后的消息 |
| 缓存预热 | main 聊天使用 `streaming`，临时查询关闭 | 主会话通过 generation hook 保留最新请求，在运行未结束时按缓存寿命和预计费用预热。所有已返回响应（含 `error`、`aborted`）的实际 usage 在同一提交写入 `UsageDoc` 和 `mkagent.usage`，无响应异常不虚构用量。关闭立即停止接收和调度、取消当前预热，等待全部在途 refresh（含被替换请求及校验、入账阶段）收尾后再关闭 Harness。普通 `stop()`/`capture()` 不等待旧请求。临时查询不启用 |
| 会话导出 | 未规划 | SQLite 以 `VACUUM INTO` 生成快照，在副本中脱敏后再次 `VACUUM`；JSONL 检查文件变化、提交标记及 sidecar 引用后在副本中脱敏。无法识别格式或无法确认安全时拒绝导出；原数据库的 WAL 和 SHM 文件不打包。Bun 和 Electron 分别加载各自的 SQLite 模块 |
| `agent-dir.ts` | 删除（§4.1） | 保留（MCP 配置定位需要） |
| 依赖矩阵（§3） | pi-durable + pi-ai 1.4.0 | 另加 `pi-codemode` 1.4.0（codemode sandbox）与 `pi-mcp` 1.1.0（MCP 客户端），均为 pi-agent-server 直接依赖 |
| MCP | 未规划 | 新增：官方 pi-mcp 客户端 + 根据 pi-coding-agent 1.1.0 `extensions/mcp` 适配的粘合层（`src/mcp/`）。加载 `<agentDir>/mcp.json`，默认启用；宿主未提供 agentDir 时使用会话目录下的 `.pi-agent`。OAuth 登录未搬；项目级 `.mkagent/mcp.json` 未接线；服务器通知工具列表变更时替换当前注册表。TUI/CLI 渲染层未搬 |
| codemode | 未规划 | 新增：durable 官方 `createCodemodeExtension` + pi-codemode Node sandbox，默认启用（mcp.json `autoEnableCodemode: false` 可关）；kernel 新增扩展槽位，同时安装 `tool_search`（deferred 工具发现） |
| rg/fd 获取 | Pi bin 缓存、PATH、官方二进制下载 | 两者均保留缓存、PATH 与下载；rg 在下载前额外检查应用内 `@vscode/ripgrep`，`PI_OFFLINE` 阻止下载 |

### 8.2 实际文件面（对 §4.1 的修正）

- 新增：`src/mcp/`（9 文件）、`src/tools/local/`（grep/find/ls/path-utils/truncate/tool-binaries）、`src/tools/codemode.ts`、`src/cache-warmer.ts`、`src/storage/durable-storage.ts`、`src/storage/branch-storage.ts`；shared 侧 `agent-session-events.ts`（AgentSessionEvent 及 SessionEntry 闭包 1:1 vendor，经 `@mkagent/shared/agent/pi-events` 导出）。
- 改 durable 工具契约（`execute(args, api, context)` → `{output, structuredOutput?, isError?, details?}`）：web-fetch、search、background-shell、builtin；kernel 增加扩展槽位。
- 删除：`session-settings.ts`、`system-prompt-override.ts`、`context-usage.ts`、`compaction-wait.ts`（按 §4.1 计划），以及 shared 的 `pi-retry-sdk-integration.test.ts`（被测对象已不存在）。

### 8.3 验证与遗留

本次完整修复通过一轮联合独立复核。集成后的 `bun run typecheck:all`、`bun run test:shared:all`、pi-agent-server 全部普通测试及取消隔离测试、受影响 shared 与宿主集成测试通过，最终运行时门禁共 558 项；来源审计、保留测试覆盖及 diff 检查通过。命令和证据见上述验收记录。未验证真实 provider、真实 Electron 或跨平台最终发布包；本地 bundle 烟测不替代这些层级。

预热关闭等待 provider、校验和存储 Promise 结束。永久不结束的依赖仍可能阻塞关闭。

升级 durable 版本时：§4.4 事件合成映射表与 §8.1 差异表共同构成回归清单。
