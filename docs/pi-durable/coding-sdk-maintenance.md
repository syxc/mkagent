# Coding SDK 维护边界与升级清单

更新日期：2026-11-09。本文按当前能力和调用链登记维护责任，供 F1、F3、F6 核对。原始接入参照为 `b77c4a2645d3`，SDK 候选固定 Pi 1.5.0。需求见[能力规格](coding-capabilities-spec.md)，具体实现和候选 API 对照见[架构记录](coding-architecture.md)，检查结果见[验证记录](coding-validation.md)。

MkAgent 保留 Pi Coding 层和公开插件契约，执行、事务、存储和恢复优先交给 durable。评估顺序是 durable 发布能力、其他 Pi 官方 SDK 的公开 API、必要的外部适配。用户于 2026-11-09 明确允许生产使用完整 `pi-coding-agent` 包的公开 SDK，不启动原版 CLI。SDK 覆盖后必须删除对应源码和多余直接依赖，不保留并行实现，也不将完整复制实现移入补丁。补丁新增的导出或执行接点均属于本地修改。

F1、F3、F6 已重新打开。此前维护登记和来源检查不能证明保留源码必要，也未达到删除大规模 Coding 源码的目标。首批公开 SDK 替换已删除四份实现和三份转发，设置切片再删除 manager、schema 和 defaults 三份实现；包管理切片删除 manager、output guard、Git helper 三份实现及两份转发。主题与快捷键切片再删除九份 TypeScript、两份主题 JSON 和旧主题转换脚本，并移除 highlight.js 直接依赖。注册表切片再删除 ModelRegistry、MCP 模块两份实现和一份转发。SessionManager 切片再删除 2057 行本地存储实现及旧转换分支。ResourceLoader 切片再删除资源类和 context、去重辅助实现，共 1361 行。当前运行时清单为 173 份 TypeScript、4 项资源，其中 src/pi 为 169 份；主链替换尚未完成。下表是待复评的适配边界，不是全部源码的保留许可。此前主题、权限和固定 Craft 审计的结果保留各自时点，具体历史见验证记录。

## 已直接使用的发布能力

| 能力与调用方 | 当前接线 | 升级时验证 |
|---|---|---|
| 普通 profile 执行 | worker 使用发布的 GenerationTask、Harness 和 Storage | 普通 profile 的资源隔离、权限、输入、取消及恢复 |
| Coding 基础契约 | event bus、diagnostics、frontmatter 和 file mutation queue 使用公开 Coding SDK 根导出，已删除四份实现和三份转发 | SDK 实现身份、CRLF/BOM、插件事件及 edit/write 共用队列；生成器不得重新复制已替代模块 |
| Coding 设置 | SettingsManager、storage、类型、schema、defaults 和 merge 复用发布实现；四文件仅导出补丁补齐根入口，三份本地实现已删除 | SDK 类身份、host-only/未信任隔离、profile、自定义 storage、reload/flush、工具修饰符及 legacy 开放类型 |
| Coding 包管理 | 宿主命令、资源发现及 legacy adapter 使用公开 DefaultPackageManager；本地 2,940 行 manager、两个孤立 helper 及两份转发已删除，semver、hosted-git-info 和后者类型不再是直接依赖 | SDK 类身份、无隐式安装、temporary/global npm/HOME skills 策略、`.pi`/`.tau`、scope/trust、严格 flush、stderr 及 shutdown 排空；新增策略接点见下表 |
| Coding 主题与快捷键 | Theme、完整 schema、system 配色、高亮、HTML 颜色及 KeybindingsManager 使用公开 SDK；本地九份源码、两份 JSON、旧转换脚本和 highlight.js 直接依赖已删除 | 双包名共享类及 singleton、56 项 token/slot、fallback/ANSI、完整文件校验、90 项键配置与迁移；worker 从 SDK 复制主题 JSON，SDK 定位搬迁资源 |
| Coding 模型与 MCP 注册表 | ModelRegistry 和完整 MCP server 模块使用发布实现，删除两份本地实现及旧 MCP 转发；legacy 只保留结构化构造薄适配 | SDK 类身份、host Models 更换、auth、provider overlay、MCP 配置校验与注销所有权；ModelRuntime 迁移仍开放 |
| Coding 会话存储 | SessionManager、解析、迁移、树和投影使用发布实现，删除 2057 行本地实现及旧转换规则；legacy durable 投影及目录 guard 保留在外层 | SDK 类身份、历史 JSONL、子类与 detached 工厂、投影回调、双重 compaction、context edit、append 失败回滚及 journal 事务；AgentSession 主链仍开放 |
| Coding 资源加载 | 三个创建入口使用同一 SDK DefaultResourceLoader，context 与 prompt 去重使用 SDK 现有算法；资源类及两个辅助实现已删除，宿主只注入已有插件函数 | 信任前后两阶段、host-only、SYSTEM/APPEND、无隐式安装/HOME 扫描、来源和碰撞、reload、双包名插件及转译；插件 loader/runner 的 SDK 替换仍开放 |
| Coding 工具 effect | `host-tool-task.ts` 在真实 `pi.coding.tool` owner 下委托公开 ToolTask phases/abort；`wrapAgentTool` 和普通 AgentTool 入口共用该桥 | SDK replay、嵌套任务及会话清理、进度、取消、完整结果、最终参数回执和 journal 同事务提交 |
| 生产文件和 shell 工具 | worker `tools/builtin.ts` 使用 durable read/write/edit/bash、PowerShell 和 images 工厂 | 临时文件读写、审批拒绝零副作用、改参、取消、长输出与图片 |
| 插件 edit 参数准备 | Native edit 工厂调用公开 `createEditTool().prepareArguments`，已删除转换副本 | 新旧参数形状、混合输入、原始参数不变及权限后的最终参数 |
| Agent 状态和默认转换 | `durable-agent.ts` 继承 CoreAgent；状态、事件归约、取消、等待和默认消息转换来自发布实现 | Agent 事件、异步 converter、steer/follow-up、队列身份和冷恢复；执行注入仍需下节补丁 |
| 协议及基础算法 | core 协议与 streamProxy、pi-ai 模型/请求/usage、pi-mcp 协议、pi-tui 组件与颜色、pi-codemode 沙箱、chord 上下文与输出 | 实际解析版本、类型声明、插件别名、取消及生产调用；不要误用根目录 pi-ai 1.1.0 作为 Coding 1.5.0 的对照 |

ToolTask 桥保留 Native 首次准备和权限、`afterToolCall`、插件事件、完整 content/images/details/structuredContent/control、usage 及 journal 交付。发布 ToolTask 不直接承接这些 Coding 契约。退出条件是公开委托接口能保留完整结果与同事务回执；达到后替换 runtime/document 适配，不改变真实 owner 或创建第二套根工具任务。既有 safe/unsafe、SIGKILL、失败 owned cleanup 和工具移除恢复回归是迁移检查入口。

## 本地 SDK 补丁

根 `patchedDependencies` 登记 core、Coding 和 durable 三份补丁。物理文件数为 core 4 个、Coding 16 个、durable 30 个，共 50 个，JS 与声明分别计数。逻辑职责可能共用文件，不能将逻辑组重复相加。

| 补丁组 | 产品或插件契约、发布 API 缺口 | 当前最小接点及退出条件 | 恢复与升级检查 |
|---|---|---|---|
| Coding settings：4 文件，根入口与 settings-manager 的 JS/d.ts | 发布根已有 SettingsManager，但未转出 storage、完整类型及 defaults；现有 deepMergeSettings 未导出 | 只转出现有契约并补声明，不改算法、锁或生命周期；删除本地 manager、schema、defaults 和旧生成转换。发布根完整提供这些契约后撤除补丁 | `patch-coding-sdk.ts` 和 `CODING-PATCH.json` 固定全部十六个物理文件的原始及目标摘要，设置组占其中四个；核对 trust、profile、strict flush、legacy merge、声明、实际安装和 worker bundle |
| Coding package policy：与上行共用根入口，另改 package-manager 的 JS/d.ts | 发布包管理器缺少宿主禁止隐式刷新、global npm、HOME skills 的选项，以及项目目录、更新作用域、missing 回调与并发失败排空契约 | `coding-package-policy.ts` 只增加策略及生命周期接点，包解析、扫描、版本及安装算法仍用发布实现。公开等效选项可用后撤除补丁 | 两层并发均先等待已启动 installer，再报告失败；核对结构化 settings、离线回调、skip 诊断、`.pi`/`.tau`、信任、stderr 和 shutdown。包管理组占十六个物理文件中的六个，不重复计算根入口 |
| Coding theme/keybindings：共用根入口，另改 theme 与 schema 的 JS/d.ts 及 config.js | 发布根缺少完整键配置与主题契约，宿主不启动安装 validator 的原版 CLI；发布资源定位也不含 worker 的 coding-assets/theme | 根转出现有导出，theme 默认使用 SDK 自身完整 validator，config 优先查 worker 主题目录。主题求解、schema、高亮和键配置算法不变；发布相同导出、默认校验及资源接点后撤除补丁 | 核对 KeybindingsManager 值/类型、双包名共享 singleton、56 个 token/slot、完整校验、COLORFGBG、HTML、90 项键定义和搬迁资源；Coding 共十六个文件，不将共用根入口重复计数 |
| Coding model/MCP registry：共用根入口，另改 model-registry.d.ts | 发布根缺少 MCP 完整模块导出；ModelRegistry 构造参数绑定有私有字段的 SDK ModelRuntime，而执行只用公共操作 | 根转出现有模块；构造声明改为 Pick<ModelRuntime, keyof ModelRuntime>，执行 JS 不变。公开根导出及结构化构造契约提供后撤除补丁 | 核对所有导出、宿主动态模型及 auth、legacy duck runtime、MCP 所有权及配置校验；本组涉及三个文件，其中两个根入口与其他组共用 |
| Coding session policy：共用根入口，另改 session-manager 的 JS/d.ts | 发布会话算法没有 durable 投影回调，private 构造及固定工厂/目录不保留 legacy 子类与 detached 调用契约 | coding-session-policy.ts 只增加 context 选择、逐项及最终投影回调、protected 构造和目录/app name 钩子；工厂保留接收类及 detached fallback。发布等效接点后撤除补丁，不复制解析、迁移、树或文件算法 | 完整执行及公开声明 token 对照；核对原生默认投影、legacy durable edit/compaction、JSONL 迁移、目录 guard、工厂身份和落盘失败回滚；本组涉及四文件，两个根入口与其他组共用 |
| Coding resource policy：共用根入口，另改 resource-loader 的 JS/d.ts | 发布类未暴露宿主 missing/package 策略、额外包来源、trust 后 prompt 路径、context 信任 guard 和插件函数注入；独立去重绑定未公开 | coding-resource-policy.ts 只加上述接点并转出现有无实例状态的去重方法；算法保持发布实现。公开等效接点后撤除补丁 | 完整算法 token 对照、SDK 默认与宿主注入、inline factory、trust 撤销、prompt、context、skip 诊断和 reload；本组涉及四文件，两个根入口共用，不增加任务版本 |
| core：4 文件，`agent-loop` 与 `agent` 的 JS/d.ts | Coding 请求、参数准备和结果交付需要原操作；发布根未导出八个操作，Agent 也未开放 durable backend/恢复所需接点 | 导出八个既有操作，补 AgentExecution、queue snapshot 和 protected lifecycle 接点；Native 仅保留 Agent 门面及独立可变默认对象。公开 backend/恢复协议和操作出现后撤除对应补丁 | 不复制另一套 Agent 类或 loop；检查默认模型/usage/identity 的实际影响、恢复消息、队列与异步事件。默认 converter 字段已撤除 |
| durable harness/root：6 文件 | 已准备请求须独立返回响应，再让插件 `message_end` 和 journal 接纳；发布 GenerationTask 同时分类、写 assistant、创建工具及结算 inbox。旧本地 v4 checkpoint 也不能由发布 v2 读取 | 新增 GenerationResponseTask v1，共用 SDK streamResponse/partial writer；旧 Coding hooks 和阶段仅供受支持旧入口/快照。独立响应接口可承接事件及事务后移除新扩展，旧阶段在迁移或安全结算验证后移除 | 核对 started 重入不重发、partial drain、generation 槽清理、唯一 assistant、receipt/journal/checkpoint 原子性，以及 v4、LoopInput.resume 和已接受 child |
| durable codemode：8 文件 | Native 分支 store、工具审批、字符串调用 ID、实时行、用量及 worker 释放策略不由原公开工厂完整承接 | VM、模型执行和输出由内置实现承担；增加 store、lease、prepareCall、发现覆盖、调用观察及结果投影选项。公开等效选项可用时撤除对应补丁 | replay module 保持版本 3；验证 store 与 run.start/run.result 同事务、调用 key/owner、别名变化、取消、worker 退出后释放和 usage 去重 |
| durable env/node：2 文件 | Native 同步 shell 选择、退出码和组停止策略不能直接由公开 exec 替代；所需三个既有 helper 未公开 | 仅导出 getBashShellConfig、killProcessTree、waitForChildProcess，算法正文不变。发布这些 API 后撤除导出补丁 | 无新增任务 schema；检查输出空闲窗口、继承管道、监听器、macOS 组停止与 Windows spawn 策略 |
| durable images：4 文件 | Native EXIF 容错、Photon 对象、MIME 窗口及编码质量/大小策略不同，完整工厂适配仍需保留外层契约 | 共用 EXIF、像素转置、MIME 头解析和编码缩小核心，增加有限选项和导出。公开低层 API 覆盖这些策略后撤除补丁 | 无新增任务 schema；运行原版和 SDK 默认结果、图片 worker、对象释放、离线单 WASM 与搬迁资源检查 |
| durable search/tool-search：6 文件 | Native namespace 字段和启用接口需要分数、可配置 k1/b 及 schema 元数据文本；发布工厂不能返回全部所需中间结果 | 导出原分词、元数据文本和共用 BM25 ranker；内置工具保持默认参数。公开相应核心后撤除导出/参数补丁 | 无新增任务 schema；核对默认排序、分数、namespace/deferred、目录移除及会话启用 |
| durable tools：4 文件 | Native edit 预览和读取路径需要既有 diff 与候选算法，但发布包未公开这些 helper | tools/index、tools/path-utils 的 JS/d.ts 导出九个 edit-diff 函数及 readPathVariants，保留 Native NFD、BOM、权限和预览策略。发布相应 helper 后撤除补丁 | 无新增任务 schema；验证原版 diff、真实文件预览、截图空格/NFD/引号、探测顺序和取消 |

完整 durable 补丁由 `patch-generation-response.ts` 重建并重放，`DURABLE-PATCH.json` 记录 30 个文件的原始和目标摘要。历史 `patch-durable.ts` 仅处理四个 harness 文件，不能覆盖现行完整补丁。升级须用 pristine 依赖核对完整重放，再检查独立消费者实际解析的补丁产物和声明；只测试已有修改的 node_modules 不足以验收。

`731728a` 的全部 workspace 冻结依赖安装已在全新缓存和公开 registry 下通过。新安装中 durable 的 30 个输出符合清单，core 的 4 个输出与已测试安装一致；Coding 和 worker 的三个核心 Pi 包均解析到 1.5.0，根 pi-ai 仍为 1.1.0。安装禁用 scripts，未复制运行时源码或验证新安装中的导入及产品构建，不能据此关闭完整来源检查。

新增 Coding SDK 依赖后的冻结安装也已通过：全新 HOME/cache、公开 registry、禁用 scripts，11 个 workspace 共安装 2,826 个包，lock 未变。从实际 Coding workspace 导入的 SDK 版本为 1.5.0，event bus 和 frontmatter 检查通过，34 个 core/durable 补丁产物与已测试安装一致。首次检查脚本从项目根目录导入而失败，修正消费位置后复用安装完成检查；没有重装或改写 lock。该结果不代表新生产会话、恢复或产品构建已验证。该检查未带入 bunfig.toml，未验证项目使用的 hoisted 布局。

设置切片另用 hoisted linker、全新 HOME/cache、公开 registry 和禁用 scripts 完成冻结安装：11 个 workspace 安装 1,422 个包，lock 未变，SDK 设置导出、merge 和 trust 检查通过，38 个补丁产物与已测试安装一致，Coding 的四个产物也符合清单。既有安装起初缺少 Coding SDK 的嵌套 pi-ai 1.5.0，普通冻结检查补装六个依赖后通过 focused 34 项、两项类型检查和 worker bundle 26 项；没有使用 force 或删除安装目录。设置替换仍不代表生产会话及恢复已完成。

包管理切片再用全新 HOME/cache、hoisted、公开 registry 和禁用 scripts 完成冻结安装：11 个 workspace 安装 1,421 个包，lock 未变；设置及包策略 smoke 和全部 40 个补丁产物通过，Coding 六文件同时符合清单。focused 51 项、两项类型检查、worker bundle 26 项及完整来源检查通过，独立复核未发现确定缺陷。实际网络安装、Windows 和新生产会话恢复不在此切片验证范围。

主题与快捷键切片的全新 hoisted 冻结安装同样覆盖 11 个 workspace、1,421 个包，lock 未变，禁用 scripts 并使用任务 HOME/cache。全部 45 个补丁产物及 Coding 十一文件清单一致；实际 SDK 导入和搬迁 bundle 均通过完整主题校验与 90 项键配置检查。首个搬迁断言仅因 macOS 路径拼写差异失败，改用 realpath 后复用安装完成核验。focused 72 项、363 个断言、两项类型检查、worker bundle 26 项、103 个断言和完整来源检查通过，固定 Craft 审计为 2,170 份文件；独立复核未发现确定的功能缺陷，schema 模块的旧注释已同步。

注册表切片的全新 hoisted 冻结安装覆盖 11 个 workspace、1421 个包，lock 未变，46 份补丁产物与测试安装一致，Coding 十二文件符合清单。新安装中的 SDK ModelRegistry 与现有宿主 ModelRuntime 组合、动态模型替换、合成 auth 以及 MCP 配置校验和注销所有权检查通过。66 项定向测试、454 个断言、两项类型检查、26 项 bundle 测试及完整来源检查通过；固定 Craft 审计为 2167 文件，独立定向复核未发现确定缺陷，覆盖范围及检索限制见验证记录。本切片不代表 ModelRuntime、资源或会话主链已迁移。

SessionManager 切片的全新 hoisted 冻结安装覆盖 11 个 workspace、1421 个包，lock 未变，48 份补丁产物与测试安装一致，Coding 十四文件符合清单。会话工厂、目录、落盘、投影回调及 append 失败回滚探针通过；112 项定向测试、680 个断言、两项类型检查、26 项 bundle 测试、完整来源及固定 Craft 的 2167 文件审计通过。独立定向复核未发现确定缺陷，确认真实 EEXIST 失败不覆盖旧文件并恢复条目和 leaf。范围与限制见验证记录；AgentSession 主链仍开放。

ResourceLoader 切片的全新 hoisted 冻结安装覆盖 11 个 workspace，lock 未变，50 份补丁产物与测试安装一致，Coding 十六文件符合清单。SDK 默认与宿主注入、信任切换、prompt、context、缺包 skip、factory 和碰撞探针通过。70 项定向测试、423 个断言、两项类型检查、26 项 bundle 测试、完整来源及固定 Craft 的 2166 文件审计通过。初次增量安装缺少 Coding 嵌套 pi-ai 1.5.0，导致导入和类型失败；正常冻结安装补齐六个依赖后通过，未修改功能代码。资源切片独立复核未发现确定新增缺陷；另确认本地插件 loader 的十项声明与 SDK 相同，不能将其完整保留视为必要适配。模块解析和转译的 SDK 导入窄钩子待落实；ModelRuntime、插件及 AgentSession 主链仍开放。

## Coding 层与外部适配

以下按契约登记源码范围，列出的 API 缺口只支持该行职责，不为整个目录或全部私有方法提供保留依据。

| 能力和实际入口 | 候选 API、缺口及当前适配 | 恢复、退出条件和升级检查 |
|---|---|---|
| 工具轮次与收尾：`durable-coding/run-task.ts` | GenerationTask 的接纳、tools、afterTools/finish 同时写 SDK transcript、应用 inbox 并转交后续任务；不能单独返回决定。保留 Native 插件交付、完整工具结果、顺序和 journal，effect 已交 ToolTask | 保留五种 `pi.coding.*` v1 的已接受输入和回执。公开轮次决定/外部结果接口或完整迁移能保留契约时替换；检查 length calls、terminate/handoff、turn/agent_end、steer/follow-up 和不确定交付 |
| Session 与 journal：AgentSession、session-task、session-journal | 公开 AgentSession 支持外部 Agent 注入，SessionManager 已接入公开 SDK 并删除本地完整实现，legacy 投影策略在外层；此前据工厂限制保留整个会话层的理由无效。durable snapshot、输入接纳、事务及旧恢复需要具体适配，Harness ownership/commit/wait 已复用。外层提交真实 child、原生树和产品回执 | 恢复 join 已接受 child，不重做不确定 hooks。上游支持相同输入、树和回执后迁移；检查 fork/tree/switch/new、labels/name、严格存储失败和旧 snapshot |
| Summary 与 compaction：summary-binding/task、Coding compaction 模块 | 发布 CompactionTask 不提供 Native entry usage、split-turn、retained tail、共同祖先、文件跟踪及 before hooks；GenerationResponseTask 也写 conversation 级进度。保留选取策略和独立 summary owner，producer 复用现有 StreamFn.result | requesting intent 先提交，不确定请求不重发，完整响应持久化。任务级隔离或无主进度写入的公开响应 API 可用后替换；检查压缩、分支/bug 摘要、usage、主请求并发进度和 SIGKILL |
| 插件注册与加载：Native loader/runner、旧 loader、virtual-modules | 公开 Coding SDK 已提供注册、loader、runner、会话 context 及 factory 生命周期，须优先复用。双包名映射、缓存隔离与目录策略的实际接口缺口待验证，不能据此保留整个 loader/runner；Jiti 使用公开 transform 接口 | 无新增持久任务版本；公开 Coding loader 可接收模块表、缓存和目录策略后替换。检查成功注册、失败回滚、旧 API/context 失效、reload、import.meta、会话重绑和关闭 |
| 资源、配置和模型：models、host-resources/settings/trust | DefaultResourceLoader 与 SettingsManager 已使用公开 SDK 并删除本地完整实现，宿主信任和资源策略由外层与窄接点承担。公开 SDK 已提供 ModelRuntime，当前宿主动态模型和凭据策略仍须验证组合方式，不能保留整份源码代替接线 | 宿主凭据、信任和 profile 隔离不迁移到插件。公开策略接口覆盖后替换对应层；检查 native/host-only、显式资源、reload/reopen、撤销信任及临时凭据不落盘 |
| 生产 grep/find/ls：worker `createBuiltinTools` → `tools/local/{grep,find,ls}.ts` | 三个工具保留 Coding 1.1.0 的适配，使用 durable defineTool。固定 Pi 1.5.0 的 durable `/tools` 没有相应工厂，公开 Coding SDK 已有搜索工厂，须验证生产入口与插件入口的参数和结果适配，不能仅按函数名视为已替换。保留 Unicode、hidden/ignore、限制、错误和取消行为及 rg/fd 装配 | 无新增持久任务版本，执行仍经宿主权限及 ToolTask。发布工厂或更薄适配覆盖这些行为并减少维护后替换；升级核对 schema、参数、输出和错误，检查二进制下载及子进程取消。现有 [搜索回归](../../packages/pi-agent-server/src/tools/local/search-output.test.ts)和[二进制取消回归](../../packages/pi-agent-server/src/tools/local/tool-binaries-cancellation.isolated.ts)是验收入口；此处版本不随 Coding 1.5.0 自动对齐 |
| 插件工具工厂：Coding core/tools | 生产文件和 shell 已用 durable 工厂；公开插件工厂另有自定义文件操作、BOM、预览、原始字节、取消、edit/write 互锁与 renderer 契约。已共享参数准备、diff、路径、MIME、图片、截断、shell 和等待 | 不因生产工厂已复用而删除插件入口。公开工厂或薄适配能同时保留这些行为且减少维护时替换；检查真实文件、持有队列后取消、未完成写入、原始通道和权限改参 |
| MCP/codemode/tool-search：Coding extension factories | 协议和执行来自官方包；外层保留工具 exposure/namespace、连接替换、失效隐藏、只读重试、资源保存、授权与 Native session 适配；不再保留独立 codemode loop | 上游工厂能接收所需宿主 ports 后撤除装配。检查动态目录、审批、MCP OAuth 取消与锁、store 分支、已完成结果和子任务归属 |
| 公开 UI、Theme、editor 与 HTML：components barrel、export-html | Theme、键配置及其依赖已统一到公开 Coding SDK，本地对应源码和主题资源已删除；默认完整校验由 SDK 自身 schema 承担。CustomEditor、其余组件和 HTML 装配仍待验证共享宿主类型及 renderer 生命周期后替换 | 无新增任务 schema；公开组件及生命周期接口覆盖后替换剩余装配。主题颜色/ANSI、完整校验、HTML 和键迁移已通过受影响验证；后续继续检查双包名插件输入、reload/shutdown 和离线资源 |
| 显式 npm/git 包管理：`createHostPackageExtension` → `DefaultPackageManager.installAndPersist/removeAndPersist/update` | 已接入公开 Coding SDK DefaultPackageManager 并删除本地完整实现。必要宿主适配保留 install/remove/update、user/project scope、项目信任、严格 settings flush、stderr 子进程输出及串行操作；发现不隐式安装，SDK 窄补丁承接策略及排空 | 安装器没有取消契约，shutdown 等待已接受操作，禁止关闭后新操作及 reload。文件修改和设置写入非原子；失败报告文件可能已变，人工核对后重试，不自动重放或宣称回滚。发布接口覆盖新增接点后撤除补丁；升级核对来源/版本、作用域、信任、写入失败恢复、stdout 协议隔离和关闭等待。[现有包管理回归](../../packages/pi-durable-coding/test/host-package-commands.test.ts)覆盖成功、失败、部分失败及上述边界 |
| 旧入口及共享 helper：legacy、upstream | 22 个共享入口复用发布 SDK 或剩余 Native 实现；七份 legacy 策略保留旧目录、投影、runner 依赖及 JavaScript 宽边界。context、prompt 去重已经使用公开 SDK 并删除副本，其他剩余实现继续核对覆盖，不保存第二份算法模板 | 无新增任务 schema，但会话投影影响历史。公开接口可表达旧策略后撤除对应包装；检查两个入口、结构类型、目录/信任默认、同步预览、未提交消息和旧 JSONL |

原版 Pi CLI、三种 run mode 宿主及已核实无调用的私有 helper 不属于上述必要边界。当前不包含终端分享、bug report 上传、终端状态上报、品牌公告/彩蛋、私有 Mermaid 转换器及其依赖。公开插件 renderer 和实际宿主能力不能因同属 interactive 目录而删除。静态零入边检查在允许范围内已无新候选，但不识别所有计算路径，也不等于完整必要性证明。

## 一次升级的完成条件

1. 先核对目标版本发布的 SDK 和扩展点。可直接替代的接口先接线并删除对应源码或补丁，不先为整套来源更新哈希。
2. 依上表按能力检查变更接口及必要适配。未变且未修改的 Coding 源码交给生成器检查；转换锚点失败时定位具体缺口，不默认逐文件手改完整闭包。
3. 明确持久化兼容：发布 GenerationTask v2、本地旧 v4、GenerationResponseTask v1、ToolTask v3、五种 Native v1 和 codemode module v3 分别处理。不得静默丢弃已接受输入、结果或不确定 effect。
4. 在获准读取的来源范围内更新生成、来源、依赖和许可；完整与定向检查分别记账。访问拒绝不通过索引、副本、其他工具或其他 agent 绕过。
5. 按影响验证产品、插件、权限、取消、文件、恢复、声明、独立消费者和 worker/搬迁资源，完成项目要求的仓库检查。记录实际失败和平台缺口，再更新架构与验收状态。

此前独立验收只覆盖既有切片和维护登记，不能作为大规模源码删除目标的整体验收。现在以公开 Coding SDK 的真实组合接线、对应源码删除、必要行为与恢复验证为完成条件。主链替换尚未完成，未确认的缺口不构成保留整个目录的理由。
