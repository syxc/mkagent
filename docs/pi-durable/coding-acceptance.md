# Pi-durable coding agent 需求对照

本表逐行对应[能力规格](coding-capabilities-spec.md)和[实施计划](durable-coding-agent-plan.md)的 MkAgent 保留清单。它记录当前实现与验收证据，不改变需求。状态使用“已实现且验证”“已实现待验证”“待实现”“外部环境受阻”四类；部分流程已通过而必要组合尚未检查时，整行保留待验证状态。

独立 SDK 输入采集修正为 `a1790ed`，普通产品分叉修正为 `4e29c34`；读取与审批边界修正为 `61fac5d`，PowerShell 产品接线为 `57bbaf5`，定向验收为 `a41e6b5`。该代码的完整仓库主批次为 436 份文件、5096 项通过、11 项跳过、0 失败，后续 35 份串行与隔离文件全部通过。CI、lint、来源审计、固定生成、干净构建、独立消费者和搬迁 headless 产品流程均通过；浏览器与其他平台验收尚未完成，不能据此声明整体完成。

## 架构与交付约束

| 要求 | 状态 | 实现与证据 |
|---|---|---|
| pi-durable 为唯一执行调度内核 | 已实现且验证 | 普通 profile 使用 GenerationTask，coding 使用 `pi.coding.session/run/tool`；原生 Agent facade、嵌套调用和边界恢复通过实际 Harness 与固定原版行为对照。不同产品模式不要求相同任务类型。 |
| 允许按需引用 pi-agent-core，禁止生产依赖完整 pi-coding-agent | 已实现且验证 | 当前 coding 包使用独立 Pi 1.5.0 包和本地固定源码闭包；没有生产整包依赖，也没有另启旧 Agent loop。未使用 core 是当前实现选择。 |
| 独立 coding 模块及公开入口 | 已实现且验证 | `@mkagent/pi-durable-coding` 不依赖 MkAgent shared、server 或 UI。`a41e6b5` 干净 checkout 的独立消费者覆盖六个运行时入口及 rpc-ui 类型入口，声明与运行检查均通过。 |
| 固定来源、许可与可复现转换 | 已实现且验证 | Pi v1.5.0 固定提交、MIT 许可、250 份运行时源码和 9 项资源，另有 40 份公开 fixture。两套生成检查通过。 |
| 普通模式资源隔离与 coding 项目信任 | 已实现且验证 | `resourcePolicy` 与执行选择分离；普通 profile 和 `host-only` 不自动发现原生资源，项目执行在导入前取得宿主决定。参见 `host-resources.test.ts`、`host-project-resources.test.ts` 和真实产品信任用例。 |

## 能力规格逐行对照

下表沿用规格中的能力名称，Baseline 列只描述迁移前状态。测试路径相对于仓库根；详细命令、次数与失败修正见实施账本。

| Capability | 状态 | 实际证据与剩余工作 |
|---|---|---|
| read/write/edit/bash | 已实现且验证 | `packages/pi-agent-server/src/coding-host.e2e.test.ts` 与 bundled worker 运行实际插件工具、宿主审批和文件操作；既有 durable 工具回归覆盖失败、超时与取消。 |
| grep/find/ls | 已实现且验证 | `search-output.test.ts` 实际运行 rg/fd/ls，覆盖 Unicode、隐藏文件、ignore、上下文、限制、空结果与路径错误；取消另有 20 项隔离用例。实际平台为 macOS arm64，跨平台结果单独记录。 |
| Images and long output | 已实现且验证 | 两套 WASM、PNG、BMP、图片引用、fork remap 与 HTML 导出已有证据；`coding-output.e2e.test.ts` 经 durable host 检查完整 UTF-8 spill、尾部窗口、重开后的路径与 read 窗口。最新搬迁产物另行验证。 |
| PowerShell | 外部环境受阻 | 已补 coding profile 的 deferred 命名工具，原生插件可显式激活；工具仍由 durable 调度并经宿主审批，Ask 逐次确认，Explore 拒绝。真实 worker 加本地进程替身验证发现、拒绝无启动、批准后的参数与 UTF-8 输出，共 20 项断言；当前没有 `pwsh`，不能将替身结果计为真实 PowerShell 或 Windows 执行通过。 |
| Permissions and metadata | 已实现且验证 | 宿主 allow、deny、修改参数、嵌套调用与动态目录已有实际工具证据，拒绝时没有相应工具副作用。受信任 Node 插件不是沙箱。 |
| Project instructions | 已实现且验证 | 原生 global、ancestor、cwd、override 和 linked worktree 已有资源用例；真实 coding host 验证混合来源、reload、同内容不同文件的来源保留。宿主发现只列路径，不重复注入正文。 |
| SYSTEM/APPEND files | 已实现且验证 | `host-resources.test.ts` 验证 precedence、source metadata 和撤销信任，`coding-host-prompt.e2e.test.ts` 验证延后更新的宿主提示词在插件 hook 前生效。 |
| Native skills | 已实现且验证 | 真实 native loader、显式路径、manifest、collision 和 disable-model-invocation 有覆盖；真实产品 `/skill:` 展开保持原始 input 与宿主前缀。 |
| Skill activation | 已实现且验证 | 原生 skill 命令、MkAgent mention discovery 和 prerequisites 保留。已修正提前登记：仅审批后的同一前台调用成功结束才计读取；真实双模式 worker 覆盖失败 Read、隐藏失败的 shell、相对 Read、cat、fd 3 与 stdin 重定向及拒绝审批，共 2 项、132 项断言。skill 的有界降级保留，strict browser 不降级。 |
| Prompt templates | 已实现且验证 | `resources.test.ts` 检查 quoting、空参数、defaults、slices 和 collision；实际 PiAgent 检查原始输入、未知命令及 transform。 |
| Extensions: tools | 已实现且验证 | 原样公开插件与宿主工具集成覆盖注册、schema、结构化输出、进度、嵌套、审批和取消。 |
| Extensions: commands/input | 已实现且验证 | 实际产品与 shared UI 用例覆盖命令优先级、transform、handled、reload、follow-up 与稳定输入身份；独立 SDK oracle 的 17 个场景通过。 |
| Extensions: events | 已实现且验证 | 固定原版 oracle 比较 run、turn、message、tool 与 settlement 的顺序及实际效果；真实 SIGKILL 检查不确定回调的恢复。 |
| Extensions: context | 已实现且验证 | before-start、context transform、cache warming 和 durable draft 已验证；混合 instructions 经 reload 和两类 hook 后到达实际模型请求。 |
| Extensions: state | 已实现且验证 | 自定义 entries、labels、名称清空、原始身份、完整树、分叉和冷恢复有 journal 及真实产品证据。 |
| Extensions: models | 已实现且验证 | 注册 provider、virtual model、model/thinking、目录替换、reload、reopen、OAuth/API key 登录与退出已有公开接口和真实产品验证。密码框显示另列浏览器验收。 |
| Extensions: session control | 已实现且验证 | 产品 owner 执行 new/fork/tree/switch/parent/name，取消和未支持的参数明确失败；完整原生 fork 与普通 cutoff fork 分别验证，后者本批补齐初始化回执。 |
| Extensions: UI | 外部环境受阻 | 真实产品 UI 协议覆盖 dialog、状态、widget、标题、草稿和迟到回答；原授权浏览器空间缺失，完整 WebUI 与 Desktop 可视验收未完成。 |
| Local package resources | 已实现且验证 | 原生 manifest、filters、来源诊断、离线已安装资源和扩展加载后追加资源有覆盖；发现阶段不导入未信任模块。 |
| npm/git package management | 已实现且验证 | 显式 `/packages` 通过原生 package manager 和本地 npm/git fixture 验证安装、移除、更新、scope、失败与关闭等待。发现或 reload 不隐式安装。 |
| Project MCP | 已实现且验证 | `.pi/mcp.json` 与 `.mkagent/mcp.json` 共用宿主信任，拒绝项目凭据路由，撤销后关闭连接并移除工具；实际产品信任用例通过。 |
| MCP OAuth | 外部环境受阻 | 显式登录、PKCE、scope 升级、轮换、跨进程锁、取消及真实 worker 生命周期已有证据；浏览器中的链接、输入和键盘流程仍待验收。 |
| Codemode/tool search | 已实现且验证 | 实际 durable 目录覆盖动态插件与 MCP 工具、deferred discovery、移除与 exposure 变化。已对照固定上游：RPC `/mcp` 只有状态和授权操作，启停与 exposure 编辑在原生 TUI manager；终端界面兼容单列环境边界。 |
| Retry/steer/follow-up/compaction | 已实现且验证 | 实际 Harness、接受队列、重复文本、重试期限、取消、压缩设置与提交边界有回归；摘要由 durable task 调度。 |
| Resume/branch/usage/export | 已实现且验证 | SQLite/JSONL 恢复、产品完整树、普通 cutoff、原始输入、用量、归档导入导出和搬迁 HTML 资源有证据；分叉发布修正已通过完整仓库回归。 |
| CLI/JSONL/Desktop/WebUI | 外部环境受阻 | bundled JSONL 与最新 macOS arm64 headless 的认证 WebSocket 产品入口已执行；`a41e6b5` 干净构建与压缩包搬迁通过，完整 Desktop/WebUI 交互受浏览器授权空间缺失阻塞。 |
| Themes/shortcuts/editor/renderers | 外部环境受阻 | 原生资源与接口保留，RPC 支持按固定契约映射；终端组件依赖 TUI host，不能将源码存在或 print/RPC 模式的取消默认值计为 TUI 交互验收。 |

## MkAgent 保留清单逐行对照

| 范围 | 状态 | 实际证据与剩余工作 |
|---|---|---|
| 会话与流式交互 | 已实现且验证 | Kernel、事件队列及默认 profile 的真实 PiAgent 测试覆盖创建、继续、排队、steer、follow-up、重试、取消与完成。 |
| 历史与持久化 | 已实现且验证 | SQLite/JSONL 崩溃恢复、严格产品回执、原始 submission 身份、完整树和普通分叉、归档及文件引用已有证据；本批分叉发布保护有先红后绿检查。 |
| 模型与凭据 | 已实现且验证 | provider 与 virtual model、目录及端点更新、model/thinking、凭据刷新、mini completion 与原生交互登录均有定向和产品证据。 |
| 权限与工具 | 已实现且验证 | 宿主 allow/deny/modified arguments、代理和会话工具、动态目录、嵌套、进度与取消均保留；PR 工具通过真实 subprocess 和本地替身执行。 |
| MCP 与浏览器 | 已实现且验证 | 既有 MCP、codemode、tool search、默认 profile 的浏览器工具与脱敏回归保留。测试使用本地协议替身，不访问用户的真实浏览器空间或代理。 |
| 后台工作 | 已实现且验证 | 后台 shell、停止归属、完成通知、handoff 和跨 worker generation 保留源会话身份；普通与 coding 的实际协议用例均有覆盖。 |
| 上下文 | 已实现且验证 | 宿主 prompt、原生资源隔离、压缩阈值、cache 与 usage 有覆盖；本批实际模型请求验证混合 instructions 来源，真实双模式 worker 验证成功读取后的 prerequisites。 |
| 产品入口 | 外部环境受阻 | 最新干净产物的 headless 启动、health、认证 WebSocket、原生插件命令、dialog、迟到回复拒绝、名称与历史持久化通过，模型请求为 0；完整可视验收未完成。Windows/PowerShell 不能由 macOS 的构建结果替代。 |

## 后续验收

成功读取 prerequisites 和 PowerShell 产品接线的缺口已修复并定向验证。搜索、长输出、混合 instructions 与原生 MCP 的 RPC 契约已经核对；TUI 环境边界保留在对应能力行，不扩展为全部插件兼容的结论。

干净产物、独立消费者、全仓回归与必需检查已完成。接下来处理隔离 WebUI 的 dialog、密码框、焦点、键盘、草稿、树导航、历史和 NEW。再次检查原授权空间 6 仍返回 `task space not found: 6`；可视步骤需要可用且明确授权的浏览器空间，不得借用空间 7 或真实 WebUI。

PowerShell 实机验收先运行 `pwsh --version`，Windows 若只有系统 PowerShell 则运行 `powershell -NoProfile -Command '$PSVersionTable.PSVersion'`。在隔离 coding 会话中由显式插件调用 `pi.setActiveTools([...pi.getActiveTools(), 'powershell'])`，再经本地确定性模型调用该工具，检查中文输出、非零退出、超时与取消；Ask 拒绝时任务临时文件不得生成，批准后才可生成。该步骤尚未执行。
