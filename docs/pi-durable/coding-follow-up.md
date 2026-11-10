# Durable coding agent 迁移纠偏跟进

更新日期：2026-11-10。纠偏代码起点：`cb0311f`；工具切片已提交于 `62ed325`，请求切片已提交于 `456241a`，后续 SDK 接线状态见下文。`f4f9f26`、`8b1c98f` 及后续各批检查保留各自的功能证据，不能替代本次纠偏验收。

MkAgent 第一次将 Pi coding agent 直接换成 pi-durable 后，发现 Coding 能力不足且无法复用原插件生态。当前以切换前 `b77c4a2645d3` 的 MkAgent 为行为和接入边界参照，保留 Pi Coding 层及插件契约，尝试把其底层执行基座换成 durable。保留 `cb0311f` 及后续已确认的功能、修复与存量数据；这不授权回退 Git 或恢复旧依赖。

此前大量复制和改造 Pi 源码，使 Coding 和 durable 的上游升级可能转成逐文件对照维护。本次须优先引用可复用官方 SDK，将本地维护范围收窄到必要执行接线和具体缺口。先按补充目标核对文档，再依照[能力规格](coding-capabilities-spec.md)和[实施计划](durable-coding-agent-plan.md)落实 F1 至 F6。MkAgent 既有整体架构保持，宿主侧只做必要契约适配。[架构记录](coding-architecture.md)描述当前代码，[需求对照](coding-acceptance.md)区分功能证据和纠偏状态，[验证记录](coding-validation.md)保留各批检查。

## 目标与约束

每项能力依次采用：pi-durable 已发布内置实现、其他 Pi 官方 SDK 的公开 API、必要的外部薄适配。用户于 2026-11-09 明确允许生产使用 `pi-coding-agent` 的公开 SDK，解除此前整包依赖禁令；不启动原版 CLI，执行基座仍为 durable。`pi-agent-core` 可以按需引用。SDK 已覆盖的源码和多余直接依赖必须实际删除，不保留并行副本，也不把完整复制实现移入补丁。

“独立公开包”在本次优先级中指 Pi 官方 SDK。第三方库可以满足具体依赖需求，但资源文件替换、版本整理及删行数不能替代内核迁移纠偏。已经完成且正确的改动保留原结果，后续优先处理执行主链和 Coding 补足边界。

使用同一个 Harness 不足以证明复用了内置执行逻辑。自定义状态机、完整 Native SDK 闭包、原版 CLI 和旧测试预期均须接受需求核对。不同签名或一次直接转发失败也不足以证明整块源码必要。

按产品行为和公开插件契约判断兼容。权限、取消、错误、持久化、输入身份和恢复保证必须保留。对象原型、getter 顺序和私有阶段名等差异，只有存在实际调用方或公开契约时才成为保留条件。普通和 coding profile 的提示词、工具与资源隔离继续有效，内部任务类型及 AgentSession 使用范围由实现决定。

Pi 正式发布的公开 API 与仓内补丁分开记账。通过补丁新增导出、参数或执行接点属于本地 SDK 修改，需要单独说明必要性和升级工作，不能仅因调用形式变成包导入就记为完成官方 SDK 复用。

## 处理顺序

2026-11-09 重新打开整体验收。此前把替换项和保留责任登记完成视为整体完成，未达到删除大规模 Coding 源码的原始目标。已有检查只证明各自提交时点的行为。下面为当前任务状态，后文保留历史切片证据。

| 顺序 | 编号 | 工作 | 当前状态与通过条件 |
|---|---|---|---|
| 0 | F0 | 全面纠正文档 | 进行中。解除与用户目标冲突的整包禁令，纠正公开 AgentSession 构造函数可注入 Agent 的事实，随实际接线同步现行文档 |
| 1 | F1 | 按需求核对官方能力与实际执行链 | 进行中。公开 SDK 组合已实测插件命令、input hook 和 durable Agent 的单次确定性执行；SDK AgentSession 已接入 durable 子类，生产持久化、输入身份及冷恢复定向验证通过，其他职责继续核对 |
| 2 | F2 | 优先复用官方内核和 SDK | 进行中。保留已有 ToolTask 和请求复用结果；将 Coding 主链接入公开 SDK，durable 已有能力优先使用 durable |
| 3 | F3 | 收窄兼容代码和源码范围 | 未完成。以实际删除被 SDK 覆盖的运行时源码和生成转换为验收条件，只保留具有具体缺口依据的适配 |
| 4 | F4 | 修正测试并验证实际行为 | 进行中。新接线的会话、输入接纳、工具取消、持久化、旧会话恢复及 worker 打包定向验证通过，其余受影响路径随源码替换验证；历史测试结果不替代新路径结果 |
| 5 | F5 | 同步来源、依赖和可复现产物 | 进行中。同步生产依赖、lock、声明和 worker 资源，删除已替代源码及登记，禁止生成器重新带回副本 |
| 6 | F6 | 汇总架构、升级及功能验收 | 未完成。新接线、实际源码删除、必要验证和独立复核完成后再验收，全部完成后统一普通推送 |

每项改动完成必要验证后再处理下一项。历史未验证平台不自动扩展为本批工作，也不能用于豁免已经确认缺失的必需功能。

## F1 架构与依赖清点

先核对切换前 MkAgent 如何使用 Coding SDK 及必须保留的行为，再检查当前生产调用和 SDK 能力。记录所需行为、实际调用方、发布 API、仓内补丁、缺口及下一步；SDK 执行器接入是否可行须有证据，不能从当前源码目录反推需求。原始 `b77c4a2645d3` 的 1.1.0 依赖仅供行为和接入对照，当前 SDK 候选继续用固定 Pi 1.5.0。

| 范围 | 核对内容 |
|---|---|
| 执行主链 | `DurableKernel → CodingHost → AgentSession → DurableLoopBinding → pi.coding.*` 中哪些请求、工具轮次及收尾逻辑可由官方执行器承担 |
| 工具 | 生产 read/write/edit/bash/PowerShell 已使用 durable 工厂；插件与生产 grep/find/ls 均已改用 Coding SDK，分别删除六份和三份源码；插件 write 直接使用 Coding SDK，再删除两份源码、288 行；插件 read 通过图片和文档路径薄绑定使用同一 SDK，再删除两份源码、396 行，其余插件工厂继续核对；edit 执行及 renderer 也已交给 SDK，并保留 durable 参数准备，删除四份生成源码及旧转换和无调用路径适配，共六文件、741 行；插件 Bash/PowerShell 工厂也已使用 SDK，再删除执行、输出累积及 renderer 四份源码、874 行 |
| 插件与资源 | 公开注册、事件、上下文、会话、模型、资源和 UI 契约需要哪些能力；哪些仅由完整源码闭包带入 |
| 持久化与恢复 | 必须保留哪些已接受输入、任务身份、工具结果、分支和不确定副作用边界；官方事务接口能承接哪些部分 |
| SDK 导出与 CLI | MkAgent 产品入口、插件可复用组件和原版 Pi 启动器/运行模式分别有哪些调用；不默认全留或全删 |
| 依赖补丁 | 区分发布 API 和新增导出；评估原包、外部适配及当前补丁，包含升级和存量数据迁移成本 |
| 测试 | 哪些断言覆盖真实产品或插件行为，哪些只固定当前私有布局、生成目录和调用细节 |

当前独立核查确认四类任务桥已使用官方 scheduler、task ownership、commit 和等待接口，同时仍有与 GenerationTask/ToolTask 同类的本地状态转换。`62ed325` 已将宿主工具执行、输出、嵌套 admission、replay 和清理交给原包公开 ToolTask phases/abort，删除旧嵌套调用副本；Native 保留完整结果、插件事件及 journal。请求切片现通过仓内新增 GenerationResponseTask 复用 SDK streamResponse 和 partial writer，保留 Native `message_end` 及唯一 transcript writer，并原子提交 SDK receipt、journal 和下一 checkpoint。它属于本地 SDK 扩展，不能记作未修改发布 API。工具轮次与收尾已核对固定发布源码及产品工具 wrapper：SDK 阶段同时写消息、接纳工具、应用 inbox 并转交下一任务，不能直接代替 Native 交付与 journal；具体边界和退出条件见[架构记录](coding-architecture.md#工具轮次与收尾的-sdk-边界)。这些职责未新增 SDK 补丁。公开 Agent/runToolCall 的普通 AgentTool 现已复用同一个 SDK 桥，AgentSession 的工具转换保留桥接标记；低层 task fixture 不自动纳入这一入口保证。session/summary 的具体适配边界见架构记录；此前 F1 至 F3 的能力核对及生产搜索、显式包管理登记仅保留各自时点；AgentSession 主链已通过 SDK 子类接线，剩余源码删除和整体验收继续开放。

既有 `codingPrepare`、`codingStream`、`codingBoundary` 是仓内 durable 补丁接点。未修改 Pi 1.5.0 的 `pi.generation` 为 v2，本地补丁升为 v4；`pi.tool` 为 v3。codemode 的 replay module 另由 2 升为 3，不与任务或文档 schema 版本混写。主链替代或补丁撤除须显式处理这些状态与日志，具体对照见架构记录。核查安装包可说明当前能力与缺口，不能将其当作未修改发布包的能力。旧阶段与 `LoopInput.resume` 仍有恢复调用方，替换时需显式迁移。存量任务清单包括 `pi.coding.{session,run,call,tool,summary}` 五种 v1；summary 的压缩、分支总结和 bug report 已完成结果、不确定请求禁止重发及取消语义须一并纳入恢复验证。

完成条件：形成按能力划分的可执行替代项及必要例外；未核实项保持开放。上游未单独发布 Coding SDK、源码可达或哈希一致，都不能证明完整闭包必须保留。

## F2 内置能力与公开包复用

优先检查 GenerationTask、ToolTask、hooks、输入、存储和恢复，随后检查 Coding 层缺失的资源、插件和会话能力。能由内置实现完成的生命周期与算法继续交给 SDK；宿主权限和协议转换保留在外层。

生产 `tools/builtin.ts` 已从 durable `/tools` 创建 read/write/edit/bash 和可选 PowerShell，并使用 `/images`。`tools/codemode.ts` 和宿主入口已安装 durable codemode、tool-search。`CodingHost` 通过 `baseToolsOverride` 接收这些工具，后续工作以这条实际接线为起点。

首个切片的 SDK checkpoint、完整 Native 结果和 SDK failure 由同一 `pi.coding.tool` owner 的文档保存，未改 task kind/version 或依赖补丁。真实 SIGKILL 回归覆盖 Native/SDK 已记录与当前策略的共同限制，以及 SDK 结果已持久化、Native outcome 尚未提交时的恢复；工具移除后仍交付已完成结果。独立复核发现的策略绕过、并发串参及重复执行、已结束 API 写入已修正并补回归。SDK failure 随真实 owner 的 failed outcome 交给官方 scheduler，普通 owned tasks 和 owned conversations 内的任务也取消并等待，失败回执恢复同样覆盖。外部信号和 scheduler abort 均检查嵌套 cleanup 的等待及进度槽清理。详细通过数量和范围见验证记录。请求切片已完成 Native `message_end` 改写、唯一 transcript writer 与 SDK receipt/journal/checkpoint 原子提交的接线；三种真实 SIGKILL 检查请求、事件交付及响应接受后的恢复，两种取消均清理 generation 槽。工具轮次与收尾的缺口已按实际 SDK 写入和结算职责记录。插件 edit 参数转换直接使用已发布的 `createEditTool().prepareArguments`，没有新增补丁；转换副本已删除，后续 edit 切片也已将文件执行、预览和渲染交给公开 Coding SDK。公开 Agent/runToolCall 的普通工具现已委托同一 ToolTask 桥。独立复核发现的 admission 取消窗口、权限改参后的重复校验及崩溃后的最终参数丢失均已修正；最终参数随 SDK 结果原子保存，旧回执缺字段时回退已接受参数。产品回归另发现 AgentSession 转换丢失桥接标记，现已同步转换和生成规则，避免重复接纳。summary 并发不覆盖主 generation 进度已有回归；summary/session 的具体缺口及退出条件见[架构记录](coding-architecture.md#summary-与-session-的-sdk-边界)。此前完整 Coding 范围、导出与补丁的维护登记不构成整体完成；新接线须优先使用公开 SDK，并实际删除被覆盖源码。

pi-ai 的模型和请求、pi-agent-core 的协议和可复用状态操作、pi-tui 的终端组件、pi-mcp 的协议、pi-codemode 的沙箱按实际公开接口复用。当前部分 core 操作及 Agent 注入依赖四文件补丁，durable 也有仓内补丁；两者均须保留例外说明，不记成无补丁的 SDK 能力。

历史辅助函数、图像和 codemode 的共享结果见[验证记录](coding-validation.md)。`137d6de` 后的设置切片改用 Coding SDK 的 SettingsManager、storage、schema、defaults 和 merge，实现正文由发布包提供；四文件补丁只补根导出和声明。三份本地实现及旧深合并导出转换已删除，宿主信任、profile 覆盖和压缩策略仍由外层适配。`2c2b98a` 后的包管理切片改用公开 DefaultPackageManager，删除 2,940 行本地包管理器及退出闭包的 output guard、Git helper 和两份旧转发，移除 semver、hosted-git-info 及后者类型的直接依赖。SDK 仅增加宿主策略、项目目录、更新作用域、stderr 输出和已启动安装任务排空接点；包解析与安装算法仍由发布包提供。包管理切片时 runtime 为 186 份 TypeScript、6 项资源，其中 src/pi 为 182 份；focused 51 项、两项类型检查、worker bundle 26 项、完整来源检查和全新 hoisted 冻结安装通过，独立复核无确定缺陷。`e20bb1a` 后的主题与快捷键切片改用 SDK Theme、KeybindingsManager 和主题资源，删除九份源码、两份 JSON 和旧转换脚本，移除 highlight.js 直接依赖。SDK 只补现有导出、默认完整校验和 worker 主题路径，不复制算法。该主题切片时 runtime 为 177 份 TypeScript、4 项资源，其中 src/pi 为 173 份；辅助来源仍为 12 项、共享入口为 23 个。focused 72 项、两项类型检查、worker bundle 26 项、完整来源检查、全新 hoisted 安装的 45 份补丁核验及固定 Craft 审计通过；独立复核未发现确定的功能缺陷，schema 模块的旧注释已同步。随后 `05d63dc` 后的注册表切片改用 SDK ModelRegistry 和完整 MCP 模块，删除两份实现及一份旧 MCP 转发；legacy 仅保留结构化构造薄适配。补丁只增加根导出和公共 runtime 构造声明，不改注册表执行 JS。该注册表切片时 runtime 为 175 份 TypeScript、4 项资源，其中 src/pi 为 171 份；辅助来源为 12 项、共享入口为 22 个。focused 66 项、454 个断言、两项类型检查、worker bundle 26 项、完整来源检查、全新 hoisted 安装的 46 份补丁核验及固定 Craft 的 2167 文件审计通过，独立定向复核未发现确定缺陷，覆盖范围及检索限制见验证记录。`4cc709a` 后的 SessionManager 切片改用 SDK 会话存储和投影契约，删除 2057 行本地实现和旧转换分支。SDK 只补投影回调、可继承及 detached 工厂、目录和 app name 钩子，legacy durable 投影仍在外层。完整执行 9047 token 及公开声明 1765 token 对照一致。该 SessionManager 切片时 runtime 为 174 份 TypeScript、4 项资源，其中 src/pi 为 170 份；辅助来源仍为 12 项、共享入口为 22 个。112 项定向测试、680 个断言、两项类型检查、26 项 bundle 测试、完整来源检查、全新 hoisted 安装的 48 份补丁核验和固定 Craft 的 2167 文件审计通过；独立定向复核未发现确定缺陷。`df732f7` 后的 ResourceLoader 切片将三个创建入口接入同一个 SDK 类，删除 1226 行资源类、104 行 context 和 31 行 prompt 去重辅助实现。SDK 只补宿主信任、包策略、trust 后 prompt 路径及插件函数注入，算法由发布包提供；完整 13 项声明、7354 个执行 token 对照一致。该 ResourceLoader 切片时 runtime 为 173 份 TypeScript、4 项资源，其中 src/pi 为 169 份；辅助来源为 10 项、共享入口为 22 个。70 项定向测试、423 个断言、两项类型检查、26 项 bundle 测试、完整来源检查、全新 hoisted 冻结安装的 50 份补丁核验及固定 Craft 的 2166 文件审计通过。资源切片独立复核未发现确定新增缺陷，并确认插件 loader 的十项声明与 SDK 一致，当时建议将模块解析和转译收窄为 SDK 导入钩子，现已落实。`354f3cb` 后的插件 loader 切片将注册事务、factory 生命周期、缓存、批量加载和发现交给 SDK，删除两个完整 loader、Jiti 和 manifest helper、旧转发及资源包装，共七份文件、1179 行。宿主只绑定 native/legacy 模块表、Jiti 转译和目录；SDK 窄补丁新增 importer 和项目目录选项，并按稳定 importer 隔离 cache，保留原有 cwd/generation 失效及默认导入分支。该插件切片时 runtime 为 169 份 TypeScript、4 项资源，其中 src/pi 为 165 份；辅助来源为 9 项、共享入口为 21 个。78 项定向测试、543 个断言、两项类型检查、26 项 worker bundle 测试及 103 个断言通过；完整来源与补丁 check、全新 hoisted 冻结安装的 52 份补丁核验及固定 Craft 的 2164 文件审计通过。独立复核的 11 组探针通过，未确认运行时回归；七条删除文件的来源清单残留已修正并通过完整审计。ModelRuntime、插件 runner/types 和 AgentSession 主链继续开放。Marked 与 Highlight.js 的 browser 资源替换是第三方资源去重，不属于 Pi 官方 SDK 复用的验收证据，也不作为下一批主线。

`0c69e9f` 的 ModelRuntime 切片直接使用公开 SDK 类、provider composition、virtual routing、凭据串行操作及模型存储，删除九份运行时源码、旧转换脚本和一份转发，共十一文件、2986 行。SDK 窄补丁增加实时宿主 Models 绑定与共用临时凭据入口：扩展 overlay 保留在独立内存集合，宿主 refresh 仍使用原集合和目录存储，迟到检查不能恢复旧宿主快照，默认 SDK create 路径保留；composer 仅收窄结构类型。该模型切片时 runtime 为 160 份 TypeScript、4 项资源，其中 src/pi 为 156 份；辅助来源为 9 项、共享入口为 20 个。142 项定向测试、548 个断言及两项类型检查通过；worker 完整组合通过 25 项，一项图像测试超过默认 5 秒后，以 15 秒预算单项复跑通过，未修改仓库测试超时。完整来源与补丁 check、全新 hoisted 冻结安装的 55 份补丁核验、12 项模型契约及固定 Craft 的 2154 文件审计通过。独立复核未确认新增回归；24 项测试、补充确定性探针、85 个成员对照和公开消费端类型检查通过。复现的自定义 AuthContext 未传入内部集合问题在替换前已存在，当前生产未见该自定义接线，作为既有契约缺口保留跟进；该时点 legacy NativeModelRegistry 的结构适配、插件 runner/types 和 AgentSession 主链仍开放。

`0c69e9f` 后的 runner/types/exec 切片使用公开 SDK ExtensionRunner、插件类型、defineTool 和 execCommand，删除完整 runner、types、exec 实现、两份转发及旧转换脚本，共六文件、4101 行。SDK 补丁只增加实例级 theme/prompt 注入、可选 replay 声明和现有模块根导出，显式保留 KeybindingsManager 值导出；事件、生命周期和命令执行算法继续由 SDK 提供。legacy 薄绑定保留 headless theme 与宿主文档提示词，Native 会话显式注入原提示词构建器，默认 SDK 构造保持。该 runner 切片时 runtime 为 157 份 TypeScript、4 项资源，其中 src/pi 为 153 份；辅助来源为 9 项、共享入口为 18 个。161 项定向测试、831 个断言、两项类型检查和完整来源及补丁 check 通过。worker 完整组合为 25 项通过、图像项默认 5 秒超时；该项随后在 15 秒预算内通过，未改仓库超时。全新 HOME/cache 的 hoisted 冻结安装覆盖 11 个 workspace，lock 未变，58 份补丁产物与已测试安装一致，Coding 为 24 份；SDK-only runner/exec 的 3 项测试、24 个断言及公开消费端类型检查通过，固定 Craft 审计覆盖 2150 文件。独立复核首次因连接超时中断；新的只读复核未确认相对 `0c69e9f` 的新增缺陷，独立运行 105 项测试、424 个断言及源码和公开消费端类型检查通过，并核验补丁算法、403 路径的删除闭包及来源摘要。该 runner 切片时 AgentSession 生产生命周期、原子输入接纳、取消和冷恢复仍开放；后续接线见下段，剩余源码替换及 F0 至 F6 继续开放。

`5a72c8a` 后的 AgentSession 切片将完整会话生命周期、工具注册、插件输入与 HTML 导出交给公开 Coding SDK。`native-agent-session.ts` 仅绑定 durable 结算、输入持久化、journal 身份、summary 和兼容快照；无接点时 SDK 保持原执行循环。旧完整会话类、退出闭包的 helper、工具包装实现、四份 HTML 资源和旧输入转换脚本共十七文件已删除，ZIP writer、sleep 和工具转换也改用 SDK，fflate 直接依赖移除。SDK 窄补丁增加可选执行与接纳接点，工具转换保留声明元数据和 Symbol 描述符，图片 worker 只用模块路径或进程内回退。该 AgentSession 切片时 runtime 为 145 份 TypeScript，其中 src/pi 为 141 份、门面为 4 份，资源为 0；辅助来源为 9 项、共享入口为 18 个。Coding 补丁为 30 份物理输出，与 core 4 份、durable 30 份合计 64 份。生产恢复组合通过 43 项测试、313 个断言，worker 完整组合通过 26 项、103 个断言，两项类型检查通过；会话与工具组合通过 15 项、107 个断言。修复复核问题后的全新 hoisted 冻结安装核验 64 份产物，公开类型和同一 15 项测试通过，lock 未变；固定 Craft 审计覆盖 2137 文件。首次 follow-up 超时由 SDK 转换丢失宿主执行标记引起，图片 canary 失败由 SDK 项目相对 worker 路径引起，两项原回归修复后通过。最终类型探针曾误用 namespace 和 exposure 类型，按公开类型修正后复用安装通过。独立复核确认嵌套工具绕过 durable 和内部模型投影带回宿主元数据两项新增回归；现通过可选 runToolCall、convertToLlm 接点修复，默认 SDK 路径保留。父子 durable 任务、边界与 provider 投影、transcript 和 journal 元数据回归通过；实际 provider 请求在修复前也已清理。独立复查另确认发布图片未沿用共享 Photon，构建目录缺失时会静默丢图；现通过可选 processImage 绑定既有处理器，屏蔽构建依赖的搬迁图片回归、15 项会话工具、26 项 bundle、类型和全新冻结检查通过。图片专项独立复查未发现可确认的新增缺陷；复查方重跑搬迁图片用例通过，并核对十一份相关文件和三十份补丁产物，结论仅覆盖该修复。剩余源码与 F0 至 F6 整体验收继续开放，AuthContext 既有缺口保留跟进。

`a567bf4` 后的搜索切片将插件 grep/find/ls 的执行和 renderer 交给公开 Coding SDK，删除六份源码、1044 行。durable 1.5.0 没有这三种工厂；grep/find 的四个薄工厂仅绑定宿主二进制目录、离线策略与安全安装器，ls 直接用 SDK。SDK 补丁只增加可选二进制解析接点、两处 grep 异步等待后的取消检查和现有导出。该搜索切片时 runtime 为 139 份 TypeScript，其中 src/pi 为 135 份、门面为 4 份，资源为 0；辅助来源为 9 项、共享入口为 18 个，补丁输出为 core 4、Coding 34、durable 30，共 68 份。独立复核发现 options 展开丢失继承及不可枚举 operations，主线程以新增测试复现后改为直接读取，21 项搜索测试、54 个断言及公开消费端类型通过；相关 46 项回归、两项类型检查、26 项 bundle、完整来源与补丁检查、冻结安装和固定 Craft 审计的版本与范围见[搜索验证](coding-validation.md#search-sdk-boundary-after-a567bf4)。`c032e05` 后的生产搜索切片也已删除 `tools/local/{grep,find,ls}.ts` 三份实现、545 行，以 27 行装配复用同一 SDK 和既有 durable 工具桥。保留产品解析策略、每调用取消信号和 CR 换行语义，grep 使用 SDK 的 --no-config。搜索与管理器 33 项、下载及并发取消 22 项、桥接与元数据 20 项、worker bundle 26 项和 Coding/server 类型检查通过；首次两处 null 转换类型失败及修正保留[生产搜索验证](coding-validation.md#production-search-sdk-boundary-after-c032e05)。runtime 和补丁清单未变，剩余源码、AuthContext 既有缺口及 F0 至 F6 继续开放。

`1765fd7` 后的插件 write 切片直接引用公开 Coding SDK 的两个 write 工厂、options 和类型，删除本地 write 与 renderer 两份源码、288 行。SDK 已有共享队列、原始错误、取消和展示契约，无需新增包装或补丁；生产 write 继续用 durable。该 write 切片时 runtime 为 137 份 TypeScript，其中 src/pi 为 133 份、门面为 4 份，无资源；辅助来源 9 项、共享入口 18 个和 68 份补丁输出不变。349 项相关测试、827 个断言、26 项 bundle、103 个断言、Coding/server 类型和完整 runtime check 通过；来源、文档及独立复核的实际状态见[write 验证](coding-validation.md#write-sdk-boundary-after-1765fd7)。其余源码、AuthContext 既有缺口及 F0 至 F6 继续开放。

完成条件：确认可由官方实现承担的职责已经交还 SDK；调用方和功能验证同步迁移，没有为了引用包而在补丁里复制另一套实现。

`7596356` 后的插件 read 切片通过公开 Coding SDK 承担读取、分页、取消、结构化输出和 renderer，删除本地工厂与 renderer 两份源码、396 行。宿主薄工厂只绑定共享图片处理、durable MIME 和文档路径；SDK 的可选 processImage 与 getReadmePath 接点保留既有 Photon 和宿主 README 折叠分类，未复制算法。该 read 切片时 runtime 为 135 份 TypeScript，其中 src/pi 为 131 份、门面为 4 份，资源为 0；辅助来源 9 项、共享入口 18 个，补丁为 core 4、Coding 38、durable 30，共 72 份。954 项 read 相关测试、20 项独立路径组合、26 项 bundle、Coding/server 类型、完整 runtime 及最终补丁 check 通过；两处夹具失败、已复现并修正的文档分类回归、两个既有安装的冻结刷新、来源与独立复核状态见[read 验证](coding-validation.md#read-sdk-boundary-after-7596356)。其余源码和 F0 至 F6 继续开放。

`cfefb9b` 后的插件 edit 切片将执行、共享文件队列和 renderer 交给公开 Coding SDK，20 行薄适配只绑定 durable 参数准备并直接转出 durable diff。原始 options 直接传递，保留继承属性、getter 和 operations 接收者；durable 参数准备继续保持冻结输入和已记录参数不变。edit、renderer、预览和路径 helper 四份生成源码共 652 行、旧转换脚本及无调用路径适配均已删除，共六文件、741 行；对应转换与私有测试同步退役，路径行为改由公开工厂验证。该 edit 切片时 runtime 为 131 份 TypeScript，其中 src/pi 为 127 份、门面为 4 份，无资源；辅助来源 9 项、共享入口 18 个及 72 份补丁输出不变。383 项 edit 相关测试、36 项 read/path、26 项 bundle、Coding/server 类型、完整 runtime check 通过。独立复核通过 419 项测试和 14 项补充探针，未确认运行时回归；退役类型夹具的两处 TS2339 已通过删除该 10 行夹具处理，并重验 Coding 类型。最终固定 Craft 审计覆盖 2126 文件并通过，来源登记更新十三项、移除七项并新增两项。六份文档的标点和 130 个本地链接检查通过，范围见[edit 验证](coding-validation.md#edit-sdk-boundary-after-cfefb9b)。该时点旧 durable diff/path helper 补丁的无调用导出仍待收窄；其余源码及 F0 至 F6 保持开放。

`2951fe6` 后的 helper 切片撤除七个低层 diff 导出及 readPathVariants，两个路径文件恢复发布原文，durable 补丁从 30 份降至 28 份，连同 core 4、Coding 38 共 70 份。两个公开 diff 函数保留 216 项历史摘要；无适配消费者的私有归一化测试删除。两个既有安装冻结刷新后 lock 未变，补丁重放、327 项工具测试、26 项 bundle 和 Coding/server 类型检查通过，共 768 个断言。来源登记更新四项、删除一项，固定 Craft 审计覆盖 2125 文件并通过。独立复核及范围见[helper 验证](coding-validation.md#durable-tool-patch-cleanup-after-2951fe6)；127 份 src/pi 源码、AuthContext 既有缺口及 F0 至 F6 继续开放。

## F3 薄适配与必要例外

`145dd49` 后的插件 shell 切片通过公开 Coding SDK 承担 Bash、PowerShell、输出累积和 renderer，删除四份源码、874 行。42 行薄绑定只提供既有 shell 选择、宿主 PATH、durable 等待与终止及共享 detached tracker，原 options 对象直接交给 SDK；SDK 可选 ShellDependencies 保留默认路径和 PowerShell 延迟 operations。该 shell 切片时 runtime 为 127 份 TypeScript，其中 src/pi 为 123 份、门面为 4 份，无资源；辅助来源 9 项、共享入口 18 个，补丁为 core 4、Coding 42、durable 28，共 74 份。主线程 134 项测试、568 个断言及 Coding/server 类型通过，两个既有安装冻结刷新后 lock 未变，完整补丁重放和生成检查通过。独立复核发现两个 definition 工厂推导私有类型导致 TS2742，已补公开 ReturnType 并在根工程和 hoisted 工程实际生成声明通过，server 类型再次通过。来源登记更新八项、删除四项并新增三项，固定 Craft 审计覆盖 2124 文件并通过。SDK 内部默认会话工厂及交互 executeBash 的宿主策略覆盖不能由这些工厂测试证明；具体边界、复核及验证范围见[shell 验证](coding-validation.md#public-sdk-shell-factories-after-145dd49)。其余 123 份 src/pi 源码、AuthContext 既有缺口及 F0 至 F6 继续开放。

`d581616` 后的 codemode 切片将描述、声明、loadout、grammar、renderer 和三个工厂交给公开 Coding SDK，32 行薄绑定只注入既有 durable 执行器；五份本地源码共 653 行及旧转发生成规则已删除。Node 沙箱、worker、源码解析和声明 helper 通过 durable 公开入口取得，两个 workspace 的直接 pi-codemode 依赖已移除，官方包的传递依赖保留。该 codemode 切片时 runtime 为 122 份 TypeScript（src/pi 118、门面 4）、0 项资源，辅助来源仍为 9 项、共享入口 18 个；core 4、Coding 46、durable 33 共 83 份补丁输出。169 项测试、774 个断言、Coding/server 类型、两种布局实际声明生成、完整生成与补丁重放检查通过；两个既有安装冻结刷新后，Coding/durable 摘要符合清单，lock 仅删除两条直接依赖。Bun 1.3.14 新文件目录创建问题通过包根物理模块修复，公开 subpath 保持；原 durable 模型、store、lease 和输出导出已保留。来源登记更新 31 项、移除 5 项并新增 4 项，固定 Craft 审计覆盖 2123 文件并通过。独立复核未确认本次替换引入的新增缺陷，失败修正与验证范围见[codemode 验证](coding-validation.md#public-sdk-codemode-factories-after-d581616)。其余 118 份 src/pi 源码、AuthContext 既有缺口及 F0 至 F6 继续开放。

`f02db2e` 后的 UI 切片使用公开 SDK 组件、CustomEditor 及 renderer 生命周期，删除 41 份源码、8885 行，25 行薄适配只绑定共享 PNG 注册。该 UI 切片时 runtime 为 81 份 TypeScript（src/pi 77、门面 4）、0 项资源，辅助来源 9 项、共享入口 18 个；core 4、Coding 48、durable 33 共 85 份补丁输出。根工程定向 42 项、257 个断言通过，hoisted 相关 80 项、453 个断言及 UI 协议 19 项、82 个断言通过，Coding 两布局声明通过，hoisted 的 server 类型与构建通过。根工程插件/server 的依赖布局失败保留记录，未通过新增依赖掩盖。来源更新 11 项、移除 41 项并新增 4 项，固定 Craft 审计覆盖 2086 文件并通过；独立复核未确认新增缺陷，验证及限制见[UI 验证](coding-validation.md#public-sdk-ui-components-after-f02db2e)。该时点剩余 77 份 src/pi、image-convert 既有算法副本、AuthContext 缺口及 F0 至 F6 继续开放。

`9bd4b1e` 后的图片切片删除 89 行转换与注册副本，公开 Coding SDK 承担原算法和实例级注册状态；12 行绑定只注入共享 Photon 与 durable 方向处理。该图片转换切片时 runtime 为 80 份 TypeScript（src/pi 76、门面 4）、0 项资源，辅助来源 9 项、共享入口 18 个；core 4、Coding 50、durable 33 共 87 份补丁输出。根工程 136 项、817 个断言及 hoisted 26 项 bundle、105 个断言通过，hoisted 17 项是布局对照，不重复累加。根声明 TS2742 修正后，两布局实际声明及 hoisted server 类型通过。来源更新 9 项、移除 1 项并新增 3 项，固定 Craft 审计覆盖 2088 文件；两处冻结安装、完整 runtime check、补丁重放与 hash 核验通过，lock 未变。独立复核未确认新增缺陷；方向回调抛错后的原图释放问题在旧实现和 pristine SDK 中均存在，单列记录。失败修正及复核证据见[图片转换验证](coding-validation.md#public-sdk-image-converters-after-9bd4b1e)；该时点其余 76 份 src/pi、image-process/resize、AuthContext 及 F0 至 F6 继续开放。

`48aa826` 后的图片处理切片将格式归一化、转换与尺寸提示、omission、worker 通信和回退交给公开 Coding SDK，删除 process、resize、worker 及退出闭包的三份转发，共六份 runtime、284 行；另删除 39 行退役生成测试及对应生成规则。12 行 native-image-process 只绑定共享转换器、durable 编码策略和明确宿主模块 URL，SDK 新增两个可选依赖工厂及 worker 模块入口，默认 API 保留。该图片处理切片时 runtime 为 74 份 TypeScript（src/pi 70、门面 4）、0 项资源，辅助来源 9 项、共享入口 18 个；core 4、Coding 54、durable 33 共 91 份补丁输出。根工程 132 项、808 个断言，hoisted 对照 23 项、257 个断言及 bundle 26 项、105 个断言通过；Coding 类型、两布局实际声明、hoisted server 类型与构建通过。来源更新 18 项、移除 7 项并新增 4 项，固定 Craft 审计覆盖 2085 文件并通过；两布局冻结安装、pristine 重放和 hash 核验通过，lock 未变。安装准备被时限中断后的安全续接、独立复核状态及验证范围见[图片处理验证](coding-validation.md#public-sdk-image-processing-after-48aa826)。该时点其余 70 份 src/pi、AuthContext 既有缺口及 F0 至 F6 继续开放。

`8b00984` 后的用量、来源与计时切片使用 Coding SDK 已有 usage-totals、source-info 和 timings，删除三份完整实现、228 行及两份兼容转发、4 行。补丁只增加已有根导出，六份 helper JS/声明与 pristine SDK 一致，没有新增本地包装或依赖；durable 继续负责回执和用量账本，宿主资源与信任策略保留。该用量、来源与计时切片时 runtime 为 71 份 TypeScript（src/pi 67、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；core 4、Coding 54、durable 33 共 91 份补丁输出。35 项直接断言、hoisted 39 项资源/插件测试和 26 项 bundle、Coding 类型、两布局声明及 hoisted server 类型与构建通过。根工程测试为 30 通过、1 项类型消费者因根依赖入口缺失失败，同一未改夹具在 hoisted 通过；不将原失败记为通过。两布局冻结安装、hash、完整生成与 pristine 重放通过，lock 未变；来源更新 17 项、移除 5 项，固定 Craft 审计覆盖 2080 文件并通过。独立复核状态及范围见[用量、来源与计时验证](coding-validation.md#public-sdk-usage-source-and-timing-helpers-after-8b00984)；该时点其余 67 份 src/pi、AuthContext 既有缺口及 F0 至 F6 继续开放。

`c6227a6` 后的资源发现切片使用公开 Coding SDK 的 skills 与 prompt templates，删除两份完整算法及旧目录转换脚本，共三文件、849 行。两个薄绑定共 19 行，只保留 Native 安装目录和 agentDir 默认值，legacy 继续固定 `.pi` 并拒绝缺少 agentDir；SDK 只增加可选项目目录参数及现有根导出，扫描、ignore、诊断、来源与展开算法保持。直接 ignore 依赖及 lock 中对应 workspace 声明已删除，传递依赖保留。该资源发现切片时 runtime 为 69 份 TypeScript（src/pi 65、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；core 4、Coding 58、durable 33 共 95 份补丁输出。41 项直接断言、hoisted 38 项资源/插件测试和 26 项 bundle、Coding 类型、两布局声明及 hoisted server 类型与构建通过。根首轮 26 项通过、7 项失败，隔离环境修正后包管理 10 项与 RPC 4 项单独通过，原失败记录保留。两布局冻结安装、全部 Coding/durable hash、完整生成与 pristine 重放通过；来源更新 17 项、移除 3 项并新增 2 项，固定 Craft 审计覆盖 2079 文件并通过。独立复核状态及范围见[skills 与模板验证](coding-validation.md#public-sdk-skill-and-prompt-discovery-after-c6227a6)。该时点其余 65 份 src/pi、AuthContext 既有缺口及 F0 至 F6 继续开放。

`dc64ddc` 后的系统提示词切片使用公开 Coding SDK 的构建、normalize、diff 和渲染算法，删除 228 行完整本地模块；旧 30 行 legacy 路径替换与构建逻辑缩为 5 行绑定，新增 6 行 Native 绑定，两者共 11 行。SDK 只增加文档 getter 的实例工厂及现有根导出，Native 安装路径、legacy v1.5.0 URL 与 SDK 默认路径分别保留，算法正文不变。该系统提示词切片时 runtime 为 68 份 TypeScript（src/pi 64、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；core 4、Coding 60、durable 33 共 97 份补丁输出。13 组输入的 142 项差分断言、根工程 28 项测试和 220 个断言、hoisted 43 项插件与恢复测试和 422 个断言、26 项 bundle 和 105 个断言通过，Coding 类型、两布局声明及 hoisted server 类型与构建通过。首轮临时参考模块无法解析 pi-ai，原失败收据保留；仅修正探针依赖路径后单独补验通过。两布局冻结安装、全部 Coding/durable hash、完整生成与 pristine 重放通过，lock 未变；来源更新 13 项、移除 1 项并新增 1 项，固定 Craft 审计覆盖 2079 文件并通过。独立复核状态及范围见[系统提示词验证](coding-validation.md#public-sdk-system-prompt-builders-after-dc64ddc)。该时点其余 64 份 src/pi、AuthContext 既有缺口及 F0 至 F6 继续开放。

`f6a1c6f` 后的 compaction 切片使用公开 Coding SDK 的上下文估算、裁剪、压缩、分支总结和序列化算法，原四文件共 1662 行的本地闭包缩为一行 SDK 转发，三个文件实际删除，共净减 1661 行本地生产源码。SDK 只补两个既有估算函数和返回类型 ContextUsageEstimate 的根导出，内部三个算法模块的 JS/声明六文件保持 pristine，没有新增物理补丁输出。durable summary task 继续负责真实 owner、请求 intent、取消、回执和禁止不确定重发。该 compaction 切片时 runtime 为 65 份 TypeScript（src/pi 61、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；core 4、Coding 60、durable 33 共 97 份补丁输出。383 项差分断言和 20 组摘要调用、根工程 51 项测试、hoisted 66 项行为测试及 26 项 bundle 通过；Coding 类型、两布局声明及 hoisted server 类型与构建通过。首次声明和类型消费者出现 TS2742，补齐公开返回类型后仅补验两项失败检查，原失败保留。两布局冻结安装、全部 Coding/durable hash、完整生成与 pristine 重放通过，lock 未变；来源更新 14 项、移除 3 项且无新增，固定 Craft 审计覆盖 2076 文件并通过。Read/Edit 规则拒绝 legacy/context-tokens.js，因此保留其既有调用路径的一行转发；这是权限阻塞下的临时残留，不是 SDK API 缺口，也未绕过拒绝。独立复核状态、隔离夹具保留和验证范围见[compaction 验证](coding-validation.md#public-sdk-compaction-after-f6a1c6f)。该时点其余 61 份 src/pi、临时兼容入口、AuthContext 既有缺口及 F0 至 F6 继续开放。

`fd18f6e` 后的截断切片直接使用公开 Coding SDK，删除 131 行本地模块、80 行 Chord 适配及 61 行退役生成转换，不增加包装。根只补已有 GREP_MAX_LINE_LENGTH、truncateMiddle 和返回类型 MiddleTruncationResult，内部截断 JS/声明保持 pristine。该截断切片时 runtime 为 64 份 TypeScript（src/pi 60、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个，补丁仍为 core 4、Coding 60、durable 33 共 97 份。根工程 916 项、hoisted 63 项集成及 26 项 bundle 测试、Coding 类型、两布局声明、server 类型与构建通过；两布局冻结安装和补丁 hash、完整生成与 pristine 重放通过，依赖和 lock 未变。来源更新 14 项、移除 2 项且无新增，固定 Craft 审计覆盖 2074 文件并通过。独立复核状态及边界见[截断验证](coding-validation.md#public-sdk-truncation-after-fd18f6e)。该时点其余 60 份 src/pi、legacy 权限阻塞及 F0 至 F6 继续开放。

`0a6fda9` 后的工具渲染与输出文件切片直接使用公开 Coding SDK，删除 180 行渲染模块和 34 行输出文件模块，不留包装。根只补三个既有渲染函数和两个文件输出函数，内部四份 JS/声明保持 pristine。该切片时 runtime 为 62 份 TypeScript（src/pi 58、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个，补丁仍为 core 4、Coding 60、durable 33 共 97 份。5561 组候选对照、文件权限与流式错误探针、根工程 33 项、hoisted 72 项集成和 26 项 bundle 测试、类型、两布局声明及 server 构建通过。两布局冻结安装、全部 hash、完整生成与 pristine 重放通过，依赖和 lock 未变。来源更新 10 项、移除 2 项且无新增，固定 Craft 审计覆盖 2072 文件并通过。独立复核状态和验证边界见[工具渲染与输出文件验证](coding-validation.md#public-sdk-rendering-and-output-files-after-0a6fda9)。该时点其余 58 份 src/pi、legacy 权限阻塞及 F0 至 F6 继续开放。

`7a68ca4` 后的 ANSI 切片直接使用公开 Coding SDK，删除 80 行本地模块、5 行正则适配和 37 行生成转换，不留包装，并移除 ansi-regex 直接依赖。根只补两个既有函数导出，内部 JS/声明保持 pristine。该切片时 runtime 为 61 份 TypeScript（src/pi 57、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个，补丁仍为 core 4、Coding 60、durable 33 共 97 份。28592 组结果与异常、179 个流切分对照及两布局定向回归、类型、声明和 worker 构建通过，两布局冻结安装、全部 hash、完整生成与 pristine 重放通过。来源更新 12 项、移除 2 项且无新增，固定 Craft 审计覆盖 2070 文件并通过。独立复核状态和验证边界见[ANSI 验证](coding-validation.md#public-sdk-ansi-after-7a68ca4)。该时点其余 57 份 src/pi、legacy 权限阻塞及 F0 至 F6 继续开放。

`a46f170` 后的调用核对确认，本地 bash-executor 没有运行时调用，仅 RPC 两处引用 BashResult 类型；实际执行由 SDK AgentSession 内部实现承担。现将两处类型改用 SDK 根声明，删除 146 行执行器及 11 行无调用 sanitizer，共 157 行生产源码，不增加包装。根仅补 BashResult 类型导出，撤除 stripAnsi、splitIncompleteAnsiSuffix 和 createOutputFileStream 三个无生产消费者的导出，保留 MCP/codemode 使用的 writeOutputFile；内部执行器、ANSI 与输出文件六份 JS/声明保持 pristine。旧 94 行私有 ANSI 测试退出，真实会话回归覆盖字节切分、清理、记录、取消及错误。该退役切片时 runtime 为 60 份 TypeScript（src/pi 56、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个，补丁仍为 core 4、Coding 60、durable 33 共 97 份。根工程 47 项、hoisted 69 项及 26 项 bundle、类型、两布局声明与 server 构建通过；冻结安装、全部 hash、完整生成与 pristine 重放通过，lock 未变。来源更新 12 项、移除 2 项且无新增，固定 Craft 审计覆盖 2068 文件并通过。独立复核状态及边界见[bash 执行器退役验证](coding-validation.md#unused-bash-executor-retirement-after-a46f170)。该时点其余 56 份 src/pi、默认会话的宿主进程策略、legacy 权限阻塞及 F0 至 F6 继续开放。

`321e121` 后的 MCP 切片直接使用 SDK 根已公开的 createMcpExtension 和配置类型，删除八份 MCP 实现及 open-browser，共九文件、3140 行生产源码，不增加包装。SDK 仅在工厂声明中将 credentials 改为 forServer、tokens、remove 三个公共方法的结构协议，运行时算法不变；两布局类型正反例及 pristine 反证通过。宿主公开 OAuth 门面仍有生产调用，保留原实现、可取消刷新锁和显式生成根，durable codemode 绑定继续使用。该 MCP 切片时 runtime 为 51 份 TypeScript（src/pi 47、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；补丁为 core 4、Coding 61、durable 33 共 98 份。完整生成、pristine 重放、两布局冻结安装与全部 hash、类型、两布局声明及 server 构建通过，lock 未变。根 MCP/边界 4 项、相关 63 项和 26 项 bundle 通过；hoisted 首轮 33 项通过、4 项被断网配置阻断，四项改用仅允许任务本地地址的配置后单独通过。独立六场景差分和 OAuth 锁取消探针通过，未确认新增缺陷。来源更新 8 项、移除 9 项并新增 1 项，固定 Craft 审计覆盖 2060 文件并通过。失败修正及边界见[MCP 工厂验证](coding-validation.md#public-sdk-mcp-factory-after-321e121)。该时点其余 47 份 src/pi、server MCP/output/truncate 副本、默认会话宿主进程策略、legacy 权限阻塞及 F0 至 F6 继续开放。

`3256182` 后的工具搜索切片删除两份本地实现、181 行及专用生成转换，Coding SDK 承担注册、校验、暴露过滤、会话激活和结果组装。26 行 Native 绑定只提供 durable 元数据与排名函数及 namespace 文本；codemode discovery 直接调用 durable 排名，旧 Bm25Ranker 包装删除。完整 durable 工具使用 control.addTools，不能直接替代 Coding 会话启用和 namespace 权重，因此 SDK 工厂仅增加实例级可选依赖；无注入时仍用 SDK 默认路径，不复制完整算法。该工具搜索切片时 runtime 为 49 份 TypeScript（src/pi 45、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；补丁为 core 4、Coding 65、durable 33 共 102 份，只新增四份工具搜索 JS/声明输出。完整生成、pristine 重放、两布局冻结安装与全部 hash、Coding 类型、两布局声明及 server 类型与构建通过，lock 未变。根工程 47 项、hoisted 21 项和 26 项 bundle 通过。来源更新 10 项、移除 2 项并新增 1 项，固定 Craft 审计覆盖 2059 文件并通过。独立复核状态、首次生成匹配失败及限制见[工具搜索验证](coding-validation.md#public-sdk-tool-search-after-3256182)。该时点其余 45 份 src/pi、server MCP/output/truncate 副本、默认会话宿主进程策略、legacy 权限阻塞及 F0 至 F6 继续开放。

`81119cc` 后的模型解析切片删除 689 行 model-resolver 完整副本，不新增运行时包装。CLI 解析、scope 诊断和初始模型选择全部使用 Coding SDK；根补丁只转出已有 findInitialModel，内部解析 JS/声明保持 pristine。该模型解析切片时 runtime 为 48 份 TypeScript（src/pi 44、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；core 4、Coding 65、durable 33 共 102 份补丁输出不变，仅两个共用根输出内容变化。移除 Coding workspace 的 minimatch 直接依赖及 lock 对应条目，SDK 传递依赖保留。完整生成、pristine 重放、两布局冻结安装与全部 hash、11 阶段验证通过；依赖删除后补验两布局安装、21 项根工程测试、12 项 hoisted 测试、Coding 类型及两布局声明通过，既有 26 项 bundle 和 server 类型与构建结果保留。来源最终更新 11 项、移除 1 项且无新增，固定 Craft 审计覆盖 2058 文件并通过。独立复核的 50 个场景、四实现共 200 次调用及两布局声明消费者通过，未确认新增缺陷，范围及限制见[模型解析验证](coding-validation.md#public-sdk-model-resolution-after-81119cc)。该时点其余 44 份 src/pi、server MCP/output/truncate 副本、默认会话宿主进程策略、legacy 权限阻塞及 F0 至 F6 继续开放。

`a1b3712` 后的缓存预热切片删除 465 行 cache-warmer 完整副本及旧源码转换，不新增运行时包装。完整经济判断、TTL、调度和决策继续由 Coding SDK 承担；根补丁公开已有 CacheWarmer，仅增加实例级可选 action 接点。Native 继续传入宿主 backgroundAction 或原有 passthrough，保留新 journal phase、usage 提交后通知、持久化失败停机及取消和关闭等待。未提供 action 的 SDK 默认路径保持 best effort。当前 runtime 为 47 份 TypeScript（src/pi 43、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；core 4、Coding 67、durable 33 共 104 份补丁输出，新增两个缓存预热输出，两个共用根输出内容变化。两布局冻结安装与全部 hash 通过；根工程 31 项、hoisted 22 项及 26 项 bundle、Coding 类型、两布局声明与 server 类型和构建通过。首次根布局测试因新增 SDK 导入归属错误失败，改由 Coding 测试夹具导入后，又暴露 kernel 已使用但未声明的 shared workspace，补齐声明和 lock 后相关检查通过；补验脚本一次范围断言在安装前失败，收窄锚点后执行成功，原失败记录均保留。来源更新 14 项、移除 1 项、新增 1 项，固定 Craft 审计覆盖 2058 文件并通过。独立复核在源码检查与离线差分范围内未确认新增缺陷，73 个通用与 5 个宿主场景的 407 项对比断言、22 个不变函数、8 项哈希及两份最小声明消费者通过；消费者使用 skipLibCheck，真实 journal 并发和回滚不在该探针范围内，后续 workspace 声明与来源文档由父任务另验，范围及限制见[缓存预热验证](coding-validation.md#public-sdk-cache-warming-after-a1b3712)。其余 43 份 src/pi、server MCP/output/truncate 副本、默认会话宿主进程策略、legacy 权限阻塞及 F0 至 F6 继续开放。

必要例外至少说明：具体产品或公开插件行为、候选发布 API、实际缺口、薄适配结果、剩余源码或补丁、恢复兼容、退出条件及下一次 Coding/durable 升级所需检查。源码、生成转换和依赖补丁合计评估，不能靠改变代码所在位置减少账面数量。已有对照中的每一个行为差异先判定是否属于需求。

| 优先范围 | 下一步与保留条件 |
|---|---|
| 请求与工具状态机 | 先尝试官方任务和 hooks 的组合方案；仅对必要的 Coding 事件、原始工具结果和事务差异保留兼容逻辑 |
| Session/journal | 保留插件可见树、标识、提交回执、分支及恢复语义，内部布局可以调整；不把全部私有方法当作契约 |
| 工具双入口 | 区分已复用的生产工具与插件工厂；根据实际文件操作、权限、并发写入和取消保证判断差异 |
| SDK 入口及生成范围 | 根据已确认的导出契约生成必要闭包；原版 CLI、run modes 和插件组件分别核对，收窄前确认调用和替代入口 |
| SDK 补丁 | 优先移除可由发布 API 或外部适配承担的修改；历史 checkpoint 和旧 SDK 调用须有迁移或兼容路径 |
| 辅助副本 | 在主链方向确定后处理真实重复，收益按整体维护量判断，不以单函数删行数决定优先级 |

SDK 入口已先排除原版 Pi CLI 的 `main`/`MainOptions` 及 24 份独占源码，后续限定复核又确认三种模式宿主不属于原始 MkAgent 接入和必需插件契约。现排除 InteractiveMode、runPrintMode、runRpcMode、专用 options，并删除三个实现文件；两个入口在依赖遍历前应用排除。保留 RPC client/协议、JSON events、Theme、CustomEditor、renderer/UI、ExtensionMode、AgentSessionRuntime 和插件生命周期。双包名插件实际着色、editor 输入与 Escape、注册 renderer，以及 RPC、宿主 UI、bundle、声明和局部来源检查通过。直接使用这些模式的外部消费者会失去相应导出，须使用自有宿主。此项删除不需要的模式实现，不计作官方 SDK 覆盖，也不授权批量删除其余辅助依赖。

三种模式切片已提交于 `b10b881`。后续定向核对确认终端 `/bug` 界面没有剩余调用、没有根导出，上传 helper 只由该界面引用。现删除 `modes/interactive/bug-report.ts` 和 `core/bug-report-upload.ts` 及两项来源记录；既有入口排除已切断这些依赖，不新增替代实现。`AgentSession.summarizeForBugReport()`、核心摘要和 durable summary 任务保留，宿主实际调用及插件回归 11 项、声明构建通过。未执行上传或真实 provider 请求；这仍属于不需要的宿主范围删除。

`/bug` 切片已提交于 `d913008`。其后又确认四份终端私有 helper 没有剩余调用，且未从包入口导出，现删除 `session-share.ts`、`chat-viewport.ts`、`tui-renderer.ts` 和 `program-status-reporter.ts`，同步移除四项来源记录。公开消息/工具 renderer 不受这四个宿主装配文件删除影响；外部编辑器、模型搜索和目录刷新仍有组件调用。插件及宿主 UI 的 29 项回归、声明构建与独立 `./native` 声明消费者通过；没有执行分享上传或账号检查，也未完整重算闭包。

`20cb6e8` 后的限定检查继续删除 15 份无剩余调用、未公开导出的私有源码：认证命令、Radius helper、changelog、版本检查、缓存浪费展示、剪贴板图片读取、主题控制器，以及八份条目、品牌、彩蛋、登录菜单和 Mermaid 终端组件。公告专用图片与 `grok-mermaid` 也已移除，生成器和 worker 不再收集交互图片目录。公开组件 barrel、Theme、CustomEditor、RPC 及 MkAgent 自身剪贴板和用量功能保留。86 项定向测试、声明构建、独立声明消费者及 26 项 worker bundle 测试通过；完整仓库结果单列于验证记录。该切片仍是宿主残留清理，不计作官方 SDK 替代。

`06d1346` 后继续核对内部组件 barrel，确认 `FirstTimeSetupComponent`、`ScopedModelsSelectorComponent`、`TrustSelectorComponent` 及其专用类型没有包根导出或保留调用。现从 barrel 排除三项并删除对应实现，生成器在依赖遍历前应用同样排除并保护上游边界。公开模型选择器、Theme、CustomEditor、renderer/UI 和宿主信任处理保留；三个私有文件的直接消费者不属于公开契约保证。87 项定向测试、声明构建、独立声明消费者、26 项 worker bundle 测试和 192 份允许源码的定向复现通过，完整仓库检查及独立复核结果见验证记录。此项仍是未使用宿主界面的范围删除，不计作官方 SDK 替代。

历史切片先将两个 loader 的 runtime、注册 API 和 factory 接受/回滚合为本地同一份实现，旧产物从 631 行减至 235 行。该本地去重不等于 SDK 复用，现已由后续插件 loader 切片替换并删除两个完整 loader。两套模块表、目录和缓存隔离契约通过 SDK 导入选项与宿主薄绑定保留；旧初始化状态不再构成保留完整源码的理由。退出条件和升级核对见架构记录，双入口行为见验证记录。

默认消息转换也已直接复用发布版 `CoreAgent`，删除 Native `defaultConvertToLlm`、生成器提取和 core 补丁中的默认字段，Agent 门面由 115 行减至 105 行。两个可变默认对象仍保留，不能仅凭对象身份断言证明其必要性。70 项 Agent、工具、恢复和宿主回归、全仓 CI、声明构建及独立 frozen 消费者的 Bun/Node 各 7 项检查通过；完整测试入口的最终结果见验证记录。Proxy、构造函数参数个数及 getter 顺序没有确认的产品调用方，不作为执行分叉的保留条件。summary 只有进度隔离回归，未确认产品并发启动多个 summary；旧 runtime 的必要范围限定为受支持快照的识别、迁移或安全结算。

两项独立源码复核现已完成。执行侧确认的默认转换副本已在 `bbdf61e` 删除；Coding 侧未确认新的、可由 pristine Pi 1.5.0 独立 SDK 完整替换的实现。工具工厂、同步会话树、compaction hooks 和 renderer 生命周期的具体差异可以作为相应适配的依据，不能扩大为整份文件或完整 SDK 必须保留。资源发现、模型和 MCP 也只保留实际装配策略；经仓内补丁共享的 helper 继续与发布 API 分账。三种程序化模式及启动器 helper 已在后续切片排除；当时 F1/F3 未整体关闭。本次主题和完整来源核对、最终独立验收及两项维护登记已完成，当前状态以上表为准。

复核发现的 `RpcClient` 启动假设已修正：调用方须显式提供 `cliPath`，缺少入口时在 spawn 前清楚拒绝；原“搜索 dist/cli.js”的错误注释已删除。显式入口、JSONL 请求、启动与请求失败及停止由本地子进程验证，Bun 和 Node 各通过 4 项；六项定向检查保护用例、声明构建和单文件来源复现通过。没有恢复完整 CLI 或新增 SDK 补丁，完整测试与其失败记录仍见验证账本。

继续核对确认 args 模块中的 `printHelp`、`normalizeSessionName` 和三个专用导入仅服务于已移除的启动器，现已删除；公开 `parseArgs` 和模型解析的 thinking 校验保留。71 项 helper、模型及插件回归、参数和 thinking 的实际调用检查、声明构建及单文件来源复现通过，三个改动文件的来源摘要已同步。这是启动器残留清理，不计为官方 SDK 替换；该切片时点的清单为 `224/7`，后续三种模式排除的状态见前文。

已有保留对照用于定位 BOM、输出、取消、图像、压缩、模型和 renderer 的具体契约。此前仅评估独立 Pi 包时，主题表已正常读取并核实：49 项前景、7 项背景和 5 项可选 fallback 仍供公开 Theme、schema 和 HTML 使用。当时保留的完整校验、indexed 配色、dim、COLORFGBG 和自定义主题契约，现由完整 Coding SDK 承接；本地主题、schema、tokens、system-theme 和高亮实现均已删除。历史终端求解器收窄及其验证见验证记录，不再构成保留本地主题源码的理由。

完整生成另确认 `core/tools/renderers/index.ts` 不在实际闭包中，且无保留调用或根导出，现删除该孤立 barrel。生成器的完整 check 会拒绝闭包外残留 TypeScript；定向 check 仍只核对指定文件。主题静态独立复核未发现确定的新缺陷，运行结果和复核范围见验证记录。剩余适配按维护清单中的能力和具体 API 缺口判断，不从文件数量反推必要性。

完成条件：已确认的重复实现和不必要内部修改已处理；每个仍需维护的例外有证据。存量会话和任务保持可读，不静默丢弃 checkpoint，也不自动重复不安全副作用。

## F4 功能与插件回归

测试以[能力规格](coding-capabilities-spec.md)和 MkAgent 保留清单为准。先检查测试是否固化了无依据的完整 CLI、源文件数量、原型或内部阶段，再同步修改测试与调用方。不能为了通过测试削减权限、取消、错误处理、插件能力或恢复保证。

| 改动范围 | 必要验证 |
|---|---|
| 官方执行器接入 | 本地确定性模型、真实工具轮次、顺序/并行结果、终止、重试、steer/follow-up 和收尾 |
| 工具与权限 | 真实临时文件读写编辑和 shell、批准/拒绝/改参、嵌套、进度、取消和零拒绝副作用 |
| 插件 | 原样 TypeScript 插件的注册、事件效果、context、状态、模型、会话控制、reload 和实际宿主 UI |
| 持久化 | SQLite/JSONL 冷恢复、崩溃、不确定副作用、已完成工具不重做、输入和分支身份 |
| 导出与打包 | 独立消费者的实际导入和声明、worker 构建、离线资源及搬迁后产品流程 |

按影响运行必要仓库检查及独立复核。文档改动单独执行链接、一致性和标点检查，不把历史产品通过记作本批重跑。新增测试针对确认的变更、缺陷或验证缺口，不复制 SDK 自身测试。

## F5 来源检查及历史边界

来源清单证明选定源码可追溯和可复现。调整导出范围、源码或补丁时同步生成规则、依赖、许可、清单和受影响产物。完整生成结果与 `--check --file=...` 的局部结果分开记录。

用户已撤销旧源码禁读，`runtime-credentials.ts` 也已完成正文核查；早期路径拒绝和局部检查保留历史时点。2026-11-09 的只读诊断在全局 `~/.claude/settings.json` 的 `permissions.deny` 中发现 `Read(*token*)`，覆盖 `theme-tokens.ts` 文件名。该文件用于主题配色；历史工具拒绝不是用户明确禁读该源码的证据。规则的设置者、设置时间及历史拒绝是否由同一规则触发尚未核实。

同日先按用户要求新增[项目配置](../../.claude/settings.json)，仅允许读取该主题文件；正常 Read 仍被全局 deny 拒绝。之后按用户明确要求修正权限，在全局原 `Read(*token*)` 后加入同一配置源的精确相对路径例外，正常 Read 本地及固定上游源码均成功，其余保护保留。项目 allow 不能覆盖全局 deny；权限历史和例外匹配范围见[本轮验证记录](coding-validation.md#theme-contract-and-complete-source-after-6240ed9)。完整主题核查、来源生成和固定 Craft 审计现已完成。

历史 `731728a` 的全部 workspace manifest、锁文件及两份补丁已在新目录以全新缓存完成 `bun install --frozen-lockfile --ignore-scripts`。12 份 manifest、11 个 workspace 链接和 34 个补丁产物通过核对，锁文件及原项目输入未变。该结果不包含运行时源码、安装脚本、构建或新安装中的运行时导入；旧禁网安装失败记录保留各自范围。具体命令和证据见[验证记录](coding-validation.md#project-read-rule-and-workspace-install-after-731728a)。

Craft 审计使用独立固定 `v0.15.6` 副本，不访问真实 Craft 目录。验证使用任务临时数据、本地确定性模型和随机端口，不访问真实 WebUI `127.0.0.1:9100`、账户或凭据。

## F6 架构与升级验收

按以下条件判断本次纠偏完成：

1. 所有相关指导文档明确保留 Pi Coding 层、尝试替换其执行基座，并区分切换前行为参照、当前 SDK 候选和历史证据。
2. 执行、工具、存储和恢复已优先采用官方实现，Pi Coding 与插件契约保持；必需差异有最小适配和具体缺口依据。
3. 完整公开源码闭包、私有实现细节和旧测试没有被当作额外产品需求。
4. MkAgent 上层功能、公开插件行为和存量数据通过受影响范围的实际验证。
5. 源码、生成转换和补丁的剩余例外有退出条件及升级检查；Coding/durable 常规升级主要核对 SDK 契约与必要适配，不默认逐文件改造完整 Coding 闭包。依赖、来源和打包结果一致，未验证项如实列明。

不承诺已经达到理论上的最低维护成本，也不为寻找微小删行机会无限延长任务。存在已确认的可实施重复项或必需行为缺口时继续处理；证据不足的项目明确开放，不能宣称整体完成。每批可按已有授权本地原子提交，发布和远端写入遵循实际授权。

## 本次回顾记录

此前把“所有普通会话必须使用 AgentSession 并保存原生投影”和“移植完整公开源码闭包”列为实施要求，均已撤回。相应候选运行时代码恢复到 `f4f9f26`，当时实际 coding/default 产品流程为 1 项、43 项断言通过。这只验证了该功能基线。

2026-11-08 再次明确：主任务是 pi-coding-agent 到 pi-durable 的迁移纠偏，优先复用 Pi 官方 SDK。第三方 browser 资源替换和 pi-ai 版本整理不再作为本轮主线。本次文档先行修正完成前，不据上述源码闭包核查直接删除 CLI 或插件 API。

同日补充：MkAgent 保留 Pi coding agent 的 Coding 层，尝试将该层执行基座换成 durable，以切换前的产品行为和接入边界为参照，并保留后续有效功能与数据。此前大量复制源码所造成的逐文件升级维护风险须从 SDK 接入方案纠正；关键文档先落实该目标，再继续 F1。
