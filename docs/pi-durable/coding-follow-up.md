# Durable coding agent 迁移纠偏跟进

更新日期：2026-11-09。纠偏代码起点：`cb0311f`；工具切片已提交于 `62ed325`，请求切片已提交于 `456241a`，后续 SDK 接线状态见下文。`f4f9f26`、`8b1c98f` 及后续各批检查保留各自的功能证据，不能替代本次纠偏验收。

MkAgent 第一次将 Pi coding agent 直接换成 pi-durable 后，发现 Coding 能力不足且无法复用原插件生态。当前以切换前 `b77c4a2645d3` 的 MkAgent 为行为和接入边界参照，保留 Pi Coding 层及插件契约，尝试把其底层执行基座换成 durable。保留 `cb0311f` 及后续已确认的功能、修复与存量数据；这不授权回退 Git 或恢复旧依赖。

此前大量复制和改造 Pi 源码，使 Coding 和 durable 的上游升级可能转成逐文件对照维护。本次须优先引用可复用官方 SDK，将本地维护范围收窄到必要执行接线和具体缺口。先按补充目标核对文档，再依照[能力规格](coding-capabilities-spec.md)和[实施计划](durable-coding-agent-plan.md)落实 F1 至 F6。MkAgent 既有整体架构保持，宿主侧只做必要契约适配。[架构记录](coding-architecture.md)描述当前代码，[需求对照](coding-acceptance.md)区分功能证据和纠偏状态，[验证记录](coding-validation.md)保留各批检查。

## 目标与约束

每项能力依次采用：pi-durable 已发布内置实现、独立 Pi 官方 SDK 的公开 API、必要的外部薄适配、经具体缺口论证的源码移植或补丁。`pi-agent-core` 可以按需引用；生产不依赖完整 `pi-coding-agent` 包，也不运行独立于 durable 的上游 Agent loop。

“独立公开包”在本次优先级中指 Pi 官方 SDK。第三方库可以满足具体依赖需求，但资源文件替换、版本整理及删行数不能替代内核迁移纠偏。已经完成且正确的改动保留原结果，后续优先处理执行主链和 Coding 补足边界。

使用同一个 Harness 不足以证明复用了内置执行逻辑。自定义状态机、完整 Native SDK 闭包、原版 CLI 和旧测试预期均须接受需求核对。不同签名或一次直接转发失败也不足以证明整块源码必要。

按产品行为和公开插件契约判断兼容。权限、取消、错误、持久化、输入身份和恢复保证必须保留。对象原型、getter 顺序和私有阶段名等差异，只有存在实际调用方或公开契约时才成为保留条件。普通和 coding profile 的提示词、工具与资源隔离继续有效，内部任务类型及 AgentSession 使用范围由实现决定。

Pi 正式发布的公开 API 与仓内补丁分开记账。通过补丁新增导出、参数或执行接点属于本地 SDK 修改，需要单独说明必要性和升级工作，不能仅因调用形式变成包导入就记为完成官方 SDK 复用。

## 处理顺序

| 顺序 | 编号 | 工作 | 当前状态与通过条件 |
|---|---|---|---|
| 0 | F0 | 全面纠正文档 | 此前三批在 `1314a2b`、`56d0f46`、`301598c` 完成各自核对；本批 Pi Coding 层、切换前参照及升级维护条件补充亦已完成链接、标点和独立语义复核，结果单列于验证记录 |
| 1 | F1 | 按需求核对官方能力与实际执行链 | 先还原原始 MkAgent/Coding 接入契约，再核对当前 SDK 如何保留 Coding 层并接入 durable；发布 API、仓内扩展与源码例外分别记录 |
| 2 | F2 | 优先复用官方内核和 SDK | 宿主工具委托公开 ToolTask phases/abort；请求与 partial 已接入仓内新增 GenerationResponseTask，直接复用 SDK streamResponse。工具轮次与收尾已记录发布接口的写入和结算耦合，保留必要交付适配；普通 AgentTool 已经同一 ToolTask 桥执行，插件 edit 参数转换已直接使用公开 SDK 并删除副本。summary/session 的具体缺口已记录；发布 API 与本地扩展分开记账 |
| 3 | F3 | 收窄兼容代码和源码范围 | 已排除原版 CLI 的 `main`/`MainOptions` 及 24 份独占源码；保留程序化运行模式和插件组件。两个 loader 已共用 runtime、注册和 factory 生命周期，保留模块映射、缓存及目录策略。剩余任务桥、Coding 源码和依赖补丁继续逐项列明 SDK 缺口、适配范围、退出条件及升级检查 |
| 4 | F4 | 修正测试并验证实际行为 | 先区分行为契约与实现断言，再按改动验证产品、插件、文件操作、权限、取消和恢复 |
| 5 | F5 | 同步来源、依赖和可复现产物 | 当前运行时清单为 224 份 TypeScript、7 项资源；辅助清单为 12 项来源和 28 个共享入口，数量不作为目标 |
| 6 | F6 | 汇总架构、升级及功能验收 | 文档、实际代码、测试和证据一致；确认的重复实现已处理，例外有具体依据，未完成项明确记录 |

每项改动完成必要验证后再处理下一项。历史未验证平台不自动扩展为本批工作，也不能用于豁免已经确认缺失的必需功能。

## F1 架构与依赖清点

先核对切换前 MkAgent 如何使用 Coding SDK 及必须保留的行为，再检查当前生产调用和 SDK 能力。记录所需行为、实际调用方、发布 API、仓内补丁、缺口及下一步；SDK 执行器接入是否可行须有证据，不能从当前源码目录反推需求。原始 `b77c4a2645d3` 的 1.1.0 依赖仅供行为和接入对照，当前 SDK 候选继续用固定 Pi 1.5.0。

| 范围 | 核对内容 |
|---|---|
| 执行主链 | `DurableKernel → CodingHost → AgentSession → DurableLoopBinding → pi.coding.*` 中哪些请求、工具轮次及收尾逻辑可由官方执行器承担 |
| 工具 | 生产 read/write/edit/bash/PowerShell 已使用 durable 工厂；单独评估插件公开工具工厂和本地 grep/find/ls，不能混为一套未复用实现 |
| 插件与资源 | 公开注册、事件、上下文、会话、模型、资源和 UI 契约需要哪些能力；哪些仅由完整源码闭包带入 |
| 持久化与恢复 | 必须保留哪些已接受输入、任务身份、工具结果、分支和不确定副作用边界；官方事务接口能承接哪些部分 |
| SDK 导出与 CLI | MkAgent 产品入口、插件可复用组件和原版 Pi 启动器/运行模式分别有哪些调用；不默认全留或全删 |
| 依赖补丁 | 区分发布 API 和新增导出；评估原包、外部适配及当前补丁，包含升级和存量数据迁移成本 |
| 测试 | 哪些断言覆盖真实产品或插件行为，哪些只固定当前私有布局、生成目录和调用细节 |

当前独立核查确认四类任务桥已使用官方 scheduler、task ownership、commit 和等待接口，同时仍有与 GenerationTask/ToolTask 同类的本地状态转换。`62ed325` 已将宿主工具执行、输出、嵌套 admission、replay 和清理交给原包公开 ToolTask phases/abort，删除旧嵌套调用副本；Native 保留完整结果、插件事件及 journal。请求切片现通过仓内新增 GenerationResponseTask 复用 SDK streamResponse 和 partial writer，保留 Native `message_end` 及唯一 transcript writer，并原子提交 SDK receipt、journal 和下一 checkpoint。它属于本地 SDK 扩展，不能记作未修改发布 API。工具轮次与收尾已核对固定发布源码及产品工具 wrapper：SDK 阶段同时写消息、接纳工具、应用 inbox 并转交下一任务，不能直接代替 Native 交付与 journal；具体边界和退出条件见[架构记录](coding-architecture.md#工具轮次与收尾的-sdk-边界)。这些职责未新增 SDK 补丁。公开 Agent/runToolCall 的普通 AgentTool 现已复用同一个 SDK 桥，AgentSession 的工具转换保留桥接标记；低层 task fixture 不自动纳入这一入口保证。session/summary 的具体保留边界见架构记录，完整 Coding 闭包继续核对，F1 至 F3 尚未完成。

既有 `codingPrepare`、`codingStream`、`codingBoundary` 是仓内 durable 补丁接点。未修改 Pi 1.5.0 的 `pi.generation` 为 v2，本地补丁升为 v4；`pi.tool` 为 v3。codemode 的 replay module 另由 2 升为 3，不与任务或文档 schema 版本混写。主链替代或补丁撤除须显式处理这些状态与日志，具体对照见架构记录。核查安装包可说明当前能力与缺口，不能将其当作未修改发布包的能力。旧阶段与 `LoopInput.resume` 仍有恢复调用方，替换时需显式迁移。存量任务清单包括 `pi.coding.{session,run,call,tool,summary}` 五种 v1；summary 的压缩、分支总结和 bug report 已完成结果、不确定请求禁止重发及取消语义须一并纳入恢复验证。

完成条件：形成按能力划分的可执行替代项及必要例外；未核实项保持开放。上游未单独发布 Coding SDK、源码可达或哈希一致，都不能证明完整闭包必须保留。

## F2 内置能力与公开包复用

优先检查 GenerationTask、ToolTask、hooks、输入、存储和恢复，随后检查 Coding 层缺失的资源、插件和会话能力。能由内置实现完成的生命周期与算法继续交给 SDK；宿主权限和协议转换保留在外层。

生产 `tools/builtin.ts` 已从 durable `/tools` 创建 read/write/edit/bash 和可选 PowerShell，并使用 `/images`。`tools/codemode.ts` 和宿主入口已安装 durable codemode、tool-search。`CodingHost` 通过 `baseToolsOverride` 接收这些工具，后续工作以这条实际接线为起点。

首个切片的 SDK checkpoint、完整 Native 结果和 SDK failure 由同一 `pi.coding.tool` owner 的文档保存，未改 task kind/version 或依赖补丁。真实 SIGKILL 回归覆盖 Native/SDK 已记录与当前策略的共同限制，以及 SDK 结果已持久化、Native outcome 尚未提交时的恢复；工具移除后仍交付已完成结果。独立复核发现的策略绕过、并发串参及重复执行、已结束 API 写入已修正并补回归。SDK failure 随真实 owner 的 failed outcome 交给官方 scheduler，普通 owned tasks 和 owned conversations 内的任务也取消并等待，失败回执恢复同样覆盖。外部信号和 scheduler abort 均检查嵌套 cleanup 的等待及进度槽清理。详细通过数量和范围见验证记录。请求切片已完成 Native `message_end` 改写、唯一 transcript writer 与 SDK receipt/journal/checkpoint 原子提交的接线；三种真实 SIGKILL 检查请求、事件交付及响应接受后的恢复，两种取消均清理 generation 槽。工具轮次与收尾的缺口已按实际 SDK 写入和结算职责记录。插件 edit 参数转换直接使用已发布的 `createEditTool().prepareArguments`，没有新增补丁；转换副本已删除，Native 文件执行及渲染保留。公开 Agent/runToolCall 的普通工具现已委托同一 ToolTask 桥。独立复核发现的 admission 取消窗口、权限改参后的重复校验及崩溃后的最终参数丢失均已修正；最终参数随 SDK 结果原子保存，旧回执缺字段时回退已接受参数。产品回归另发现 AgentSession 转换丢失桥接标记，现已同步转换和生成规则，避免重复接纳。summary 并发不覆盖主 generation 进度已有回归；summary/session 的具体缺口及退出条件见[架构记录](coding-architecture.md#summary-与-session-的-sdk-边界)。后续继续核对完整 Coding 闭包、导出与补丁。

pi-ai 的模型和请求、pi-agent-core 的协议和可复用状态操作、pi-tui 的终端组件、pi-mcp 的协议、pi-codemode 的沙箱按实际公开接口复用。当前部分 core 操作及 Agent 注入依赖四文件补丁，durable 也有仓内补丁；两者均须保留例外说明，不记成无补丁的 SDK 能力。

历史辅助函数、图像和 codemode 的共享结果见[验证记录](coding-validation.md)。Marked 与 Highlight.js 的 browser 资源替换是第三方资源去重，不属于 Pi 官方 SDK 复用的验收证据，也不作为下一批主线。

完成条件：确认可由官方实现承担的职责已经交还 SDK；调用方和功能验证同步迁移，没有为了引用包而在补丁里复制另一套实现。

## F3 薄适配与必要例外

必要例外至少说明：具体产品或公开插件行为、候选发布 API、实际缺口、薄适配结果、剩余源码或补丁、恢复兼容、退出条件及下一次 Coding/durable 升级所需检查。源码、生成转换和依赖补丁合计评估，不能靠改变代码所在位置减少账面数量。已有对照中的每一个行为差异先判定是否属于需求。

| 优先范围 | 下一步与保留条件 |
|---|---|
| 请求与工具状态机 | 先尝试官方任务和 hooks 的组合方案；仅对必要的 Coding 事件、原始工具结果和事务差异保留兼容逻辑 |
| Session/journal | 保留插件可见树、标识、提交回执、分支及恢复语义，内部布局可以调整；不把全部私有方法当作契约 |
| 工具双入口 | 区分已复用的生产工具与插件工厂；根据实际文件操作、权限、并发写入和取消保证判断差异 |
| SDK 入口及生成范围 | 根据已确认的导出契约生成必要闭包；原版 CLI、run modes 和插件组件分别核对，收窄前确认调用和替代入口 |
| SDK 补丁 | 优先移除可由发布 API 或外部适配承担的修改；历史 checkpoint 和旧 SDK 调用须有迁移或兼容路径 |
| 辅助副本 | 在主链方向确定后处理真实重复，收益按整体维护量判断，不以单函数删行数决定优先级 |

SDK 入口已完成一项范围收窄：排除原版 Pi CLI 的 `main`/`MainOptions` 及 24 份仅由启动器引入的源码，共 6757 行。MkAgent 使用 `CodingHost/createAgentSession`，保留 `InteractiveMode`、print/rpc、插件 UI 组件和 MCP/codemode/tool-search 工厂；Llama 管理扩展只由已移除的 CLI 内置集合引入。生成器在遍历前去掉启动器导出，防止再次复制该闭包。Native loader 两个包名的消费者及宿主定向回归通过，详细范围见验证记录。此处是删除不需要的启动器实现，不记作官方 SDK 覆盖；仓内未发现调用也不证明所有外部插件都未使用该入口。剩余 Coding 源码及补丁继续核对。

两个 loader 的 runtime、注册 API 和 factory 接受/回滚已改为同一份实现。旧生成产物移除五个函数正文，从 631 行减至 235 行；两套模块映射、缓存和目录发现继续独立。原先以私有初始化状态为由保留整份 loader 的解释已修正。此项属于本地同源去重，不计为正式 SDK 新增能力，源码文件计数不变。退出条件和升级核对见架构记录，双入口行为与定向复现见验证记录。

默认消息转换也已直接复用发布版 `CoreAgent`，删除 Native `defaultConvertToLlm`、生成器提取和 core 补丁中的默认字段，Agent 门面由 115 行减至 105 行。两个可变默认对象仍保留，不能仅凭对象身份断言证明其必要性。70 项 Agent、工具、恢复和宿主回归、全仓 CI、声明构建及独立 frozen 消费者的 Bun/Node 各 7 项检查通过；完整测试入口的最终结果见验证记录。Proxy、构造函数参数个数及 getter 顺序没有确认的产品调用方，不作为执行分叉的保留条件。summary 只有进度隔离回归，未确认产品并发启动多个 summary；旧 runtime 的必要范围限定为受支持快照的识别、迁移或安全结算。

两项独立源码复核现已完成。执行侧确认的默认转换副本已在 `bbdf61e` 删除；Coding 侧未确认新的、可由 pristine Pi 1.5.0 独立 SDK 完整替换的实现。工具工厂、同步会话树、compaction hooks 和 renderer 生命周期的具体差异可以作为相应适配的依据，不能扩大为整份文件或完整 SDK 必须保留。资源发现、模型和 MCP 也只保留实际装配策略；经仓内补丁共享的 helper 继续与发布 API 分账。`InteractiveMode`、print/rpc 及 CLI 辅助闭包的用途边界尚未整体证明，F1/F3 不关闭。

复核发现的 `RpcClient` 启动假设已修正：调用方须显式提供 `cliPath`，缺少入口时在 spawn 前清楚拒绝；原“搜索 dist/cli.js”的错误注释已删除。显式入口、JSONL 请求、启动与请求失败及停止由本地子进程验证，Bun 和 Node 各通过 4 项；六项定向检查保护用例、声明构建和单文件来源复现通过。没有恢复完整 CLI 或新增 SDK 补丁，完整测试与其失败记录仍见验证账本。

继续核对确认 args 模块中的 `printHelp`、`normalizeSessionName` 和三个专用导入仅服务于已移除的启动器，现已删除；公开 `parseArgs` 和模型解析的 thinking 校验保留。71 项 helper、模型及插件回归、参数和 thinking 的实际调用检查、声明构建及单文件来源复现通过，三个改动文件的来源摘要已同步。这是启动器残留清理，不计为官方 SDK 替换；文件清单仍为 `224/7`，其余程序化模式的必要边界继续开放。

已有保留对照仍可用于定位 BOM、输出、取消、图像、压缩、模型、renderer 等行为差异。它们是指定版本和所选契约下的证据，不能直接关闭整类必要性核查。完整 token 表未核实，`theme-tokens.ts` 的工具拒绝不绕过；该限制不阻止其他范围推进。

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

用户已撤销旧源码禁读，`runtime-credentials.ts` 也已完成正文核查；早期路径拒绝和局部检查保留历史时点。`theme-tokens.ts` 的当前工具拒绝仍须遵守。不得通过副本、换工具或委派绕过。

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
