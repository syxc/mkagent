# Pi-durable coding agent 需求对照

本表逐行对应[能力规格](coding-capabilities-spec.md)和[实施计划](durable-coding-agent-plan.md)的 MkAgent 保留清单。它记录当前实现与验收证据，不改变需求。状态使用“已实现且验证”“已实现待验证”“待实现”“外部环境受阻”四类；“已实现且验证”限于证据栏注明的提交和行为，不代表最新工作树、全部插件或平台均已通过。部分流程已通过而本阶段必需检查尚未完成时，整行保留待验证状态。

2026-11-06 用户明确本次重点为已有功能的架构优化：优先公开包引用和薄外部适配，减少复制源码及内部修改。“功能基本实现”是待核实判断，先严格修正文档并查漏补缺，再核对实现、证据和包替代方式，随后落实，顺序见[跟进清单](coding-follow-up.md)。下表保留功能和插件回归基线，不将历史未覆盖项自动扩展为新的功能工程。

独立 SDK 输入采集修正为 `a1790ed`，普通产品分叉修正为 `4e29c34`；读取与审批边界修正为 `61fac5d`，PowerShell 产品接线为 `57bbaf5`，定向验收为 `a41e6b5`。可视验收随后发现并修正确认框焦点和 NEW setup 历史，分别提交为 `9965789`、`640aca6`。后者的完整仓库主批次为 436 份文件、5096 项通过、11 项跳过、0 失败，后续 35 份串行与隔离文件全部通过，CI、lint 与来源审计通过。干净构建的搬迁产物已通过选定 WebUI 流程；固定生成和独立消费者沿用 `a41e6b5` 的未改动层证据。本批另完成 macOS Desktop 选定流程、真实 PowerShell 和独立 SDK 的 PTY TUI 验收，并修复 Electron 子包构建入口。随后补验未签名 macOS .app/ZIP 和隔离 ad-hoc 原生副本。完整兼容和其他平台仍有未验收项。

## 架构与交付约束

| 要求 | 状态 | 实现与证据 |
|---|---|---|
| 产品主体的 Coding 能力及分层装配 | 已实现待验证 | 已有 CodingHost、AgentSession 与 durable binding。当前重点是公开包复用、宿主边界及维护成本核对；不以普通 profile 是否使用 AgentSession 或原生投影单独判定完成。 |
| pi-durable 为唯一执行调度内核 | 已实现且验证 | 普通 profile 使用 GenerationTask，coding 使用 `pi.coding.session/run/tool`；原生 Agent facade、嵌套调用和边界恢复通过实际 Harness 与固定原版行为对照。不同产品模式不要求相同任务类型。 |
| 允许按需引用 pi-agent-core，禁止生产依赖完整 pi-coding-agent | 已实现且验证 | 当前 coding 包使用独立 Pi 1.5.0 包和本地固定源码闭包；core 的公开协议类型和 `streamProxy` 已替代源码副本，没有生产整包依赖，也没有另启旧 Agent loop。 |
| 既定插件契约整体验收 | 已实现待验证 | 已有官方插件、17 个原版行为场景和实际产品证据；架构调整须按 F4 验证受影响契约，选定交互不扩大为任意插件或平台组合的结论。 |
| 尽量减少源码移植与升级适配 | 已实现待验证 | 公开包复用、策略外移和共享转发已减少部分差异；F1 清点、F2 包替代、F3 薄适配和必要例外核对是本次主线。来源追溯不作为维护目标已经满足的证明。 |
| 独立 coding 模块及公开入口 | 已实现且验证 | `@mkagent/pi-durable-coding` 不依赖 MkAgent shared、server 或 UI。`a41e6b5` 干净 checkout 的独立消费者覆盖六个运行时入口及 rpc-ui 类型入口，声明与运行检查均通过。 |
| 固定来源、许可与可复现转换 | 已实现待验证 | Pi v1.5.0 固定提交、MIT 许可、248 份运行时源码和 9 项资源，另有 27 项辅助与兼容源码、6 项原样测试夹具及 7 个共享转发入口。辅助层生成检查通过；本轮仅核对获准文件的运行时清单变化，受限凭据源码未读取，完整运行时生成检查未重跑。分类见[精简架构](coding-architecture.md)。 |
| 普通模式资源隔离与 coding 项目信任 | 已实现且验证 | `resourcePolicy` 与执行选择分离；普通 profile 和 `host-only` 不自动发现原生资源，项目执行在导入前取得宿主决定。参见 `host-resources.test.ts`、`host-project-resources.test.ts` 和真实产品信任用例。 |

## 能力规格逐行对照

下表沿用规格中的能力名称，规格的 Baseline 列只描述迁移前状态。测试路径相对于仓库根；详细命令、次数与失败修正见实施账本。

| Capability | 状态 | 实际证据与剩余工作 |
|---|---|---|
| read/write/edit/bash | 已实现且验证 | `packages/pi-agent-server/src/coding-host.e2e.test.ts` 与 bundled worker 运行实际插件工具、宿主审批和文件操作；既有 durable 工具回归覆盖失败、超时与取消。 |
| grep/find/ls | 已实现且验证 | `search-output.test.ts` 实际运行 rg/fd/ls，覆盖 Unicode、隐藏文件、ignore、上下文、限制、空结果与路径错误；取消另有 20 项隔离用例。实际平台为 macOS arm64，跨平台结果单独记录。 |
| Images and long output | 已实现且验证 | 两套 WASM、PNG、BMP、图片引用、fork remap 与 HTML 导出已有证据；`coding-output.e2e.test.ts` 经 durable host 检查完整 UTF-8 spill、尾部窗口、重开后的路径与 read 窗口。最新搬迁产物另行验证。 |
| PowerShell | 已实现且验证 | coding profile 的 deferred 工具可由原生插件显式激活，执行经 durable 和宿主审批。macOS arm64 的真实 PowerShell 7.6.9 产品用例为 1 项、51 项断言，覆盖 Ask 拒绝与批准、中文输出和文件、exit 7、超时、Explore 拒绝及取消，超时与取消的进程均退出且没有延迟写入。替身的 20 项断言另计。Windows 实机仍未验收。 |
| Permissions and metadata | 已实现且验证 | 宿主 allow、deny、修改参数、嵌套调用与动态目录已有实际工具证据，拒绝时没有相应工具副作用。受信任 Node 插件不是沙箱。 |
| Project instructions | 已实现且验证 | 原生 global、ancestor、cwd、override 和 linked worktree 已有资源用例；真实 coding host 验证混合来源、reload、同内容不同文件的来源保留。宿主发现只列路径，不重复注入正文。 |
| SYSTEM/APPEND files | 已实现且验证 | `host-resources.test.ts` 验证 precedence、source metadata 和撤销信任，`coding-host-prompt.e2e.test.ts` 验证延后更新的宿主提示词在插件 hook 前生效。 |
| Native skills | 已实现且验证 | 真实 native loader、显式路径、manifest、collision 和 disable-model-invocation 有覆盖；真实产品 `/skill:` 展开保持原始 input 与宿主前缀。 |
| Skill activation | 已实现且验证 | 原生 skill 命令、MkAgent mention discovery 和 prerequisites 保留。已修正提前登记：仅审批后的同一前台调用成功结束才计读取；真实双模式 worker 覆盖失败 Read、隐藏失败的 shell、相对 Read、cat、fd 3 与 stdin 重定向及拒绝审批，共 2 项、132 项断言。skill 的有界降级保留，strict browser 不降级。 |
| Prompt templates | 已实现且验证 | `resources.test.ts` 检查 quoting、空参数、defaults、slices 和 collision；实际 PiAgent 检查原始输入、未知命令及 transform。 |
| Extensions: tools | 已实现且验证 | 原样公开插件与宿主工具集成覆盖注册、schema、结构化输出、进度、嵌套、审批和取消。两个加载入口的元数据回归验证 Bun `import.meta.dir/path/file`、标准 metadata、计算属性、中文嵌套模块、相邻资源、旧缓存和重复加载，8 项含堆栈格式化用例通过。 |
| Extensions: commands/input | 已实现且验证 | 实际产品与 shared UI 用例覆盖命令优先级、transform、handled、reload、follow-up 与稳定输入身份；独立 SDK oracle 的 17 个场景通过。 |
| Extensions: events | 已实现且验证 | 固定原版 oracle 比较 run、turn、message、tool 与 settlement 的顺序及实际效果；真实 SIGKILL 检查不确定回调的恢复。 |
| Extensions: context | 已实现且验证 | before-start、context transform、cache warming 和 durable draft 已验证；混合 instructions 经 reload 和两类 hook 后到达实际模型请求。 |
| Extensions: state | 已实现且验证 | 自定义 entries、labels、名称清空、原始身份、完整树、分叉和冷恢复有 journal 及真实产品证据。 |
| Extensions: models | 已实现且验证 | 注册 provider、virtual model、model/thinking、目录替换、reload、reopen、OAuth/API key 登录与退出已有公开接口和真实产品验证。隔离 WebUI 的合成 provider 验证 secret 输入为 password、获得焦点、关闭自动完成和拼写检查，提交后不在页面回显；遮罩仅有 DOM 证据，不计为截图验收。 |
| Extensions: session control | 已实现且验证 | 产品 owner 执行 new/fork/tree/switch/parent/name，取消和未支持的参数明确失败；完整原生 fork 与普通 cutoff fork 分别验证。`640aca6` 为 setup 新增 user 行保存原始身份，并在目标 hooks 前等待严格产品回执；真实产品、冷 worker 和最新 WebUI 刷新均保留 setup 与 callback 消息。 |
| Extensions: UI | 已实现且验证 | WebUI 已验证输入、多行编辑、选择、确认、键盘、草稿、树导航、NEW、刷新和多面板焦点，另补实际项目信任的拒绝与批准选择及截图；批准前项目扩展和两类 MCP 均未加载，批准后加载成功。Desktop 已验证仅会话信任、两类项目 MCP、Escape 取消及冷重开历史。独立 SDK 的真实 PTY 覆盖 regular/fullscreen 原生组件及 MCP manager 的选定操作，结果不扩展为全部插件兼容。 |
| Local package resources | 已实现且验证 | 原生 manifest、filters、来源诊断、离线已安装资源和扩展加载后追加资源有覆盖；发现阶段不导入未信任模块。 |
| npm/git package management | 已实现且验证 | 显式 `/packages` 通过原生 package manager 和本地 npm/git fixture 验证安装、移除、更新、scope、失败与关闭等待。发现或 reload 不隐式安装。 |
| Project MCP | 已实现且验证 | `.pi/mcp.json` 与 `.mkagent/mcp.json` 共用宿主信任，拒绝项目凭据路由，撤销后关闭连接并移除工具；实际产品信任用例通过。 |
| MCP OAuth | 已实现且验证 | 显式登录、PKCE、scope 升级、轮换、跨进程锁、取消及真实 worker 生命周期已有证据。最新搬迁产物的 WebUI 已实际点击本地授权链接，在同一任务的 popup 完成回环，登录后动态出现工具，登出后移除；再次登录按 Escape 清理表单和链接，未新增令牌请求。 |
| Codemode/tool search | 已实现且验证 | 实际 durable 目录覆盖动态插件与 MCP 工具、deferred discovery、移除与 exposure 变化。固定上游 RPC `/mcp` 只有状态和授权操作，启停与 exposure 编辑在原生 TUI manager。本批实际 PTY 验证 manager 的重新连接、direct/deferred 切换、禁用与启用，以及配置保存和进程退出；该 TUI 夹具关闭工具调用，执行证据仍来自产品用例。 |
| Retry/steer/follow-up/compaction | 已实现且验证 | 实际 Harness、接受队列、重复文本、重试期限、取消、压缩设置与提交边界有回归；摘要由 durable task 调度。 |
| Resume/branch/usage/export | 已实现且验证 | SQLite/JSONL 恢复、产品完整树、普通 cutoff、原始输入、用量、归档导入导出和搬迁 HTML 资源有证据；分叉发布修正已通过完整仓库回归。 |
| CLI/JSONL/Desktop/WebUI | 已实现待验证 | bundled JSONL、认证 WebSocket、macOS arm64 干净搬迁包与选定 WebUI 流程已有证据。Electron 39.2.7 的正式 main/server/worker/renderer 通过 Desktop 选定流程。另完成未签名 .app/ZIP、worker 新鲜度及包内资源检查，并在带隔离 bootstrap 的 ad-hoc 原生副本验证信任、MCP、确认取消和冷重开，回复 ID 保持不变。正式签名公证安装、系统协议和 Windows 仍未验收。SDK TUI 的结果不代表 MkAgent CLI 新增终端界面。 |
| Themes/shortcuts/editor/renderers | 已实现且验证 | macOS 的独立 SDK 宿主实际运行 ProcessTerminal、InteractiveMode 和 durable binding，regular/fullscreen 均完成。覆盖主题、快捷键、CustomEditor、折叠与展开的 renderer、header/footer、overlay、reload 和两种终端尺寸，截图已检查。仅 SDK TUI，工具关闭且单 journal owner；不计为 MkAgent CLI 产品接线或全部 TUI 插件验收。 |

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
| 产品入口 | 已实现待验证 | 搬迁 headless 协议为 0 次模型请求，先前选定 WebUI 为 5 次。前批 Desktop 为 1 次、真实 PowerShell 为 11 次、SDK TUI 的 regular/fullscreen/MCP manager 为 2/1/1 次，WebUI 项目信任为 2 次。原生发布包补验为 2 次，自动标题和实际对话各 1 次；被排除的旧资源候选包另有 1 次请求。全部使用本地确定性模型。Windows、正式签名公证安装和系统协议仍未验收。 |

## 后续验收

成功读取 prerequisites 和 PowerShell 产品接线的缺口已修复并定向验证。搜索、长输出、混合 instructions 与原生 MCP 的 RPC 契约已经核对；TUI 环境边界保留在对应能力行，不扩展为全部插件兼容的结论。

原授权空间 6 缺失是早期阻塞。用户随后明确授权任务 `mkagent-durable-coding-visual-d6-20261104`，编号为 7，仅用该任务完成前批可视流程并关闭。后续用户又明确授权唯一新任务 `mkagent-durable-coding-trust-20261106`，编号为 8，完成 WebUI 项目信任补验。两者均按名称与归属操作，分别恰一次调用 `finish({keep:[]})`，任务服务均已退出，没有借用其他旧空间或真实 WebUI。

当前证据及产物摘要见实施计划的 macOS 实际验收、WebUI 项目信任和 Desktop 发布包补充记录。未签名 .app/ZIP 和隔离 ad-hoc 原生副本已有结果；Windows、正式签名公证安装及系统协议仍是历史未验范围。此前 D3.6、D4 与 D6 的进行中记录保留原适用时点，本轮门槛按 F1 至 F6 单独判定。平台和发布检查先确认是否受本次改动影响，再确定必要验证，不以全部历史平台结果作为本轮完成条件。SDK TUI 仅覆盖选定交互，仍有会话控制等未验组合；Bun/Jiti 的常用文件元数据边界已用两个真实加载入口修正。密码遮罩维持 DOM 证据，未重试被拒截图；新增截图只包含项目信任和隔离原生历史界面。

macOS 已执行真实 PowerShell 验收。Windows 后续先运行 `pwsh --version`，若只有系统 PowerShell 则运行 `powershell -NoProfile -Command '$PSVersionTable.PSVersion'`。在隔离 coding 会话中由显式插件激活 `powershell`，再经本地确定性模型检查中文输出、非零退出、超时与取消，以及审批前无文件副作用和批准后真实执行。
