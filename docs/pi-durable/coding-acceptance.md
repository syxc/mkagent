# Pi-durable coding agent 需求与纠偏验收对照

本表对应[能力规格](coding-capabilities-spec.md)和[实施计划](durable-coding-agent-plan.md)。第一次将 Pi coding agent 直接换成 durable 后，出现 Coding 能力和插件生态缺口。2026-11-08 用户补充明确：以切换前的 MkAgent 为行为和接入边界参照，保留 Pi coding agent 的 Coding 层及插件契约，尝试将其底层执行基座换成 pi-durable。MkAgent 既有整体架构、宿主职责、后续有效功能与数据保持；文档纠偏已提交于 `552b938`，后续已实施宿主工具的公开 ToolTask、请求执行的本地 SDK 扩展、插件 edit 参数及 core 默认转换复用，并删除确认的重复实现和未使用宿主源码。2026-11-09 用户批准生产使用公开 Coding SDK。此前把维护登记视为整体完成的判断过宽，F0 至 F6 已重新打开；AgentSession 主链已接入公开 SDK 并通过定向验证，剩余源码删除和整体验收继续推进，状态见下表。

执行侧优先用 durable 内置实现，其余所需能力优先引用独立 Pi 官方 SDK，再做必要薄适配及有具体缺口依据的源码处理。此前大量复制和改造上游源码造成的升级维护风险属于本次验收范围：Coding 和 durable 更新时，核对工作应主要集中在 SDK 契约和少量必要适配。正式发布接口、仓内补丁和源码生成分开记账，第三方资源去重及源码可复现不能代替这一要求。

功能状态使用“已实现且验证”“已实现待验证”“待实现”“外部环境受阻”；其中“已实现且验证”仅限注明的版本和路径。本次架构纠偏另记待核对、待实施及验证状态，不能用历史功能通过来关闭架构问题。详细命令、失败修正和证据版本见[验证记录](coding-validation.md)，顺序见[纠偏跟进](coding-follow-up.md)。

## 架构与交付约束

| 要求 | 本次纠偏状态 | 实际依据及剩余工作 |
|---|---|---|
| 文档先行 | 按已批准的公开 SDK 边界更新 | 旧 24 份文档纠偏及后续维护登记保留原时点。现行文档解除整包生产依赖禁令，并重新打开主链接线和实际源码删除任务 |
| MkAgent 继续使用 Pi Coding 层，durable 替换其执行基座 | 主链替换进行中 | `b77c4a2645d3` 的 worker 直接使用 Coding SDK，作为原始行为和接入参照。公开 AgentSession 管理会话生命周期，durable 子类绑定执行、接纳和恢复；生产恢复组合 43 项测试通过，含原始输入身份、旧请求和队列、事务拒绝及 SQLite/JSONL 冷恢复 |
| pi-durable 为执行底座 | 工具执行已委托，请求已接入本地 SDK 扩展 | 普通 profile 使用 GenerationTask；coding 主链仍由五种 `pi.coding.*` v1 调度。宿主执行使用公开 ToolTask，请求/partial 使用仓内新增 GenerationResponseTask 并复用 streamResponse。Native 保留插件交付、工具轮次和收尾，SDK receipt、journal 与下一 checkpoint 同事务提交；保留职责的 API 缺口和退出条件已登记 |
| durable 内置能力优先，再用其他 Pi 官方公开 SDK | 基础、设置、包管理、主题、快捷键、注册表、会话存储、资源、插件加载、模型运行时及 runner/types/exec、AgentSession、HTML 和工具转换已替换，整体未完成 | 生产文件和 shell 工厂、images、codemode、tool-search 已用 durable；宿主执行委托公开 ToolTask。Coding SDK 1.5.0 提供基础 helper、设置、包管理、Theme、KeybindingsManager、ModelRegistry、完整 MCP 模块、SessionManager 和资源加载算法，累计删除二十五份 TypeScript 实现及六份转发；历史主题切片另删除两份主题 JSON、旧转换脚本和 highlight.js 直接依赖，插件切片另删除七份 loader、helper 和包装文件，共 1179 行；ModelRuntime 切片再删除九份运行时源码、旧转换脚本和一份转发，共 2986 行；runner/types/exec 切片再删除三份完整实现、两份转发和旧转换脚本，共六文件、4101 行；AgentSession 切片另删除十七份会话、helper、工具包装、HTML 资源和转换文件，其余源码继续核对和删除 |
| 允许公开 Coding SDK 生产依赖，不启动原版 CLI | 已获用户批准并接入上述 SDK 能力 | 用户于 2026-11-09 解除此前整包禁令，执行基座仍用 durable。Coding 补丁覆盖三十个物理文件，补现有契约导出、宿主包策略、公共 runtime 构造声明、会话投影及 legacy 工厂接点、资源策略和插件函数注入、插件 importer/cache 隔离和目录选项、默认完整主题校验及 worker 资源定位、实时宿主模型与共用凭据绑定和 composer 结构声明、实例级 runner 主题/提示词注入、replay 类型及现有 runner/types/exec 根导出，不使用私有 subpath 或复制完整算法；会话可选执行及接纳接点、工具元数据和 Symbol 描述符、图片 worker 安全、sleep 清理及 HTML/ZIP 导出和资源定位另有窄补丁；core 四文件、Coding 三十文件和 durable 30 文件共 64 份输出，分别核对缺口及退出条件 |
| 保留 Pi Coding 层，仅适配执行基座及必要宿主差异 | 已收窄，保留能力的边界已登记 | 除原版 CLI 与 24 份独占源码外，现排除 InteractiveMode、runPrintMode、runRpcMode、专用 options 和三个实现文件。两个入口在生成遍历前排除；RPC client/协议、JSON events、Theme、CustomEditor、renderer/UI 和会话/插件生命周期保留。双包名插件验证实际着色、editor 输入和 renderer；RPC、宿主 UI、声明及 bundle 通过。直接使用三种模式的外部消费者会失去这些导出，须改用自有宿主。args 的 parser/thinking 保留，RpcClient 仍需显式 cliPath。上述宿主范围删除不计作官方 SDK 覆盖 |
| 兼容逻辑尽量薄 | 已处理确认的重复和宿主残留 | 两个完整 loader 已删除，SDK 承担 runtime、注册事务、factory、缓存与发现，宿主只绑定模块映射、转译和目录。cache 按稳定 importer 隔离，保留 clear/cwd/generation 失效。Native 默认转换及对应补丁字段已删除，105 行 Agent 门面直接使用发布版 core；两个可变默认对象保留。反射断言没有已确认的产品调用方，不能作为保留理由。本地主题与快捷键已交给 SDK 并删除对应实现，其余例外按能力和退出条件复评 |
| 上游升级主要核对 SDK 契约与必要适配 | 未完成 | [SDK 维护清单](coding-sdk-maintenance.md)记录具体接点，但 141 份 src/pi 源码仍待逐职责核对替换，不能统称必要适配。维护登记、来源可复现和测试通过均不能代替实际源码删除 |
| MkAgent 上层与插件不回归 | AgentSession 定向检查通过，复核发现已修复，图片专项独立复查未发现新增缺陷 | 当前会话与工具组合 15 项、107 个断言，生产恢复 43 项、313 个断言，worker 完整组合 26 项、103 个断言及两项类型检查通过；首次工具标记丢失和项目相对图片 worker 两项失败均已修复，原回归保留。独立复核另发现嵌套调用绕过 durable、内部消息投影带回宿主元数据两项新增回归，已增加可选执行和投影接点并通过真实失败场景；provider 请求此前也已移除元数据，transcript/journal 身份保持。复查另确认 SDK 图片加载器与现有随包 Photon 不匹配，发布时可静默丢图；现通过可选 processImage 绑定既有共享处理器，屏蔽构建机 Photon 的搬迁回归及完整 bundle 26 项通过。此前 runner/types/exec 切片 161 项定向测试、831 个断言和两项类型检查通过；全新消费者的 3 项 SDK-only runner/exec 测试、24 个断言及公开类型检查通过。worker 完整组合为 25 项通过、图像项默认 5 秒超时；图像项随后在 15 秒预算内单项通过，未改仓库超时。独立复核首次因连接超时中断；新的只读复核未确认相对 `0c69e9f` 的新增缺陷，独立运行 105 项测试、424 个断言及源码和公开消费端类型检查通过，补丁算法、删除闭包及来源摘要核验通过。此前模型切片的独立复核通过 24 项测试及补充探针；自定义 AuthContext 未传入内部集合的既有缺口仍开放，当前生产未见该自定义接线。模型切片 142 项定向测试、548 个断言、两项类型检查及全新消费者 12 项模型契约和 108 个断言通过。此前插件切片 78 项定向测试、543 个断言、Coding 与 server 类型检查及 worker bundle 26 项、103 个断言通过。覆盖 SDK 默认、native/legacy cache 隔离、late import、stale/rollback、双包名与转译及资源信任/reload；全新安装的插件探针通过。独立复核 11 组行为探针通过，发现的七条来源清单残留已修正并通过完整审计。此前切片保留各自证据。旧全仓测试及 CI 不算新 AgentSession 主链验证；权限、取消、错误、持久化、恢复和公开插件契约继续保留 |
| 存量数据及任务兼容 | 已验证本次工具和请求替换，保留旧恢复边界 | 五种 `pi.coding.*` 仍为 v1；旧工具 checkpoint 保持原恢复路径，新 SDK 文档覆盖 safe/unsafe 策略变化、已完成结果与工具移除后的 SIGKILL 恢复。请求已覆盖 SDK receipt、事件接受和 journal 原子提交的 SIGKILL 边界。旧 generation/tool checkpoint 和 summary 的已完成响应、不确定请求及取消契约保留；未来迁移须重验，不自动重发不安全副作用 |
| 独立模块和消费者 | 历史验证通过，按接口变化重验 | coding 包不依赖 MkAgent shared/server/UI；`a41e6b5` 独立消费者覆盖六个运行时入口和 rpc-ui 类型。后续入口调整须同步声明、调用方及实际消费者 |
| 来源与许可 | AgentSession 来源及最终补丁的冻结检查通过 | 完整 runtime check 覆盖 145 份 TypeScript（141 份 src/pi 和 4 个门面）、0 项资源；辅助清单为 9 项来源和 18 个共享入口。固定 Craft v0.15.6 审计覆盖 2137 份文件。全新 HOME/cache 的 hoisted 冻结安装覆盖 11 个 workspace，lock 未变；修复复核问题后重新进行全新冻结安装，64 份 core/Coding/durable 补丁产物、公开 processImage 类型、15 项会话及工具测试和屏蔽构建依赖的搬迁图片测试通过。首次类型探针误用 SDK 元数据类型，修正后复用安装通过。此前冻结检查保留各自时点，不以数量或哈希证明源码必要性 |
| profile 与信任隔离 | 历史验证通过，持续保留 | 普通 profile/host-only 不自动加载环境 Pi 资源；项目执行导入前经过宿主决定，工具继续走既有审批 |

既有源码对照、图像和 codemode 共享及 core 门面改动保留[架构记录](coding-architecture.md)和验证账本中的证据。宿主工具执行已委托官方 ToolTask 并删除旧嵌套副本；请求执行与 partial 已接入仓内新增 GenerationResponseTask。工具轮次与收尾的发布接口缺口已按实际写入和结算职责记录，未新增补丁；插件 edit 参数转换已直接复用公开 SDK 并删除副本。公开 Agent/runToolCall 的普通 AgentTool 也已委托同一个 SDK 桥，保留权限改参、取消与最终参数回执；AgentSession 转换不再丢失桥接标记。summary 并发进度隔离已有回归，session/summary 按已登记的 API 缺口和退出条件保留，公开接口满足条件时再评估替换。最终独立验收确认本轮复用与代码收窄可以验收，并要求补齐生产搜索及包管理登记；主线程已补齐并核对实际入口与现有回归。上述结论仅适用于此前切片；F1 至 F3 的整体完成判断已撤回，公开 SDK 主链接线、必要适配收窄和实际源码删除继续推进。

## 能力规格逐行对照

下表保留截至 `cb0311f` 前各批行为证据。主要产品基线为 `a41e6b5`、`9965789`、`640aca6`，后续 `8b1c98f` 及源码共享批次范围见验证记录。`62ed325` 工具切片的定向行为、恢复、类型和构建检查单列于验证记录，当时未重跑全仓及下表所有历史组合；旧全仓结果保留其版本，新增 SDK 后未重跑全仓，不算新主链验收。各行“已实现且验证”不代表当前所有插件、平台或组合通过。

| Capability | 功能状态 | 实际证据与范围 |
|---|---|---|
| read/write/edit/bash | 已实现且验证 | 生产使用官方 durable 工具，`coding-host.e2e.test.ts` 和 bundled worker 检查文件操作与审批；既有工具回归覆盖失败、超时和取消。插件工厂的兼容源码另行核查。 |
| grep/find/ls | 已实现且验证 | `search-output.test.ts` 实际运行 rg/fd/ls，覆盖 Unicode、隐藏文件、ignore、限制、空结果和路径错误；取消有隔离用例。实机平台为 macOS arm64。 |
| Images and long output | 已实现且验证 | Photon 共享、真实图片 worker、PNG/BMP 与离线资源有对照；`coding-output.e2e.test.ts` 检查完整 UTF-8 spill、窗口和重开后的读取。 |
| PowerShell | 已实现且验证 | coding profile deferred 工具经显式激活和宿主审批执行；macOS PowerShell 7.6.9 实机检查拒绝、批准、中文、非零退出、超时及取消。Windows 未验收。 |
| Permissions and metadata | 已实现且验证 | 宿主 allow/deny/改参、动态目录、嵌套调用和拒绝时零工具副作用有实际用例；受信任 Node 插件仍有进程能力。 |
| Project instructions | 已实现且验证 | global/ancestor/cwd/override、linked worktree、来源保留和 reload 有资源及真实 host 检查；宿主只发现路径，避免重复注入。 |
| SYSTEM/APPEND files | 已实现且验证 | `host-resources.test.ts` 和 `coding-host-prompt.e2e.test.ts` 验证优先级、撤销信任及 hook 前的宿主提示词更新。 |
| Native skills | 已实现且验证 | 真实 loader、显式路径、manifest、collision、disable-model-invocation 和产品 `/skill:` 展开有证据。 |
| Skill activation | 已实现且验证 | `61fac5d` 后只把审批成功的前台读取计为 prerequisites；双模式 worker 覆盖失败、拒绝、shell 隐藏失败、相对路径和重定向，strict browser 不降级。 |
| Prompt templates | 已实现且验证 | `resources.test.ts` 和真实 PiAgent 检查 quoting、defaults、slices、collision、原始输入、未知命令和 transform。 |
| Extensions: tools | 已实现且验证 | 原样公开插件和宿主用例覆盖注册、schema、结构化结果、进度、嵌套、审批和取消；两个 loader 的 Bun 元数据及 reload 有回归。 |
| Extensions: commands/input | 已实现且验证 | 实际产品与 shared UI 检查命令优先级、transform/handled、reload、follow-up 和稳定输入身份；固定参考含 17 个行为场景。 |
| Extensions: events | 已实现且验证 | 固定原版参考对照 run/turn/message/tool/settlement 的顺序和效果；真实 SIGKILL 检查不确定回调恢复。 |
| Extensions: context | 已实现且验证 | before-start、context transform、cache warming 和 durable drafts 有回归；混合 instructions 经 reload 与 hooks 到达模型请求。 |
| Extensions: state | 已实现且验证 | entries、labels、名称清空、原始身份、完整树、fork 和冷恢复有 journal 及产品证据。 |
| Extensions: models | 已实现且验证 | provider、virtual model、model/thinking、动态目录、reload/reopen 和本地合成授权有证据；secret 遮罩只有 DOM 属性证据。 |
| Extensions: session control | 已实现且验证 | 产品 owner 执行 new/fork/tree/switch/parent/name，取消及不支持参数明确失败；`640aca6` 修复 setup 输入身份与目标 hook 前的严格回执。 |
| Extensions: UI | 已实现且验证 | 选定 WebUI/Desktop 流程覆盖 dialog、草稿、widget、树、NEW、焦点、信任和冷历史；SDK PTY 只证明选定 TUI 宿主行为。 |
| Local package resources | 已实现且验证 | manifest、filters、来源诊断、已安装资源离线加载和扩展追加资源有覆盖；发现时不导入未信任模块。 |
| npm/git package management | 已实现且验证 | 显式 `/packages` 经本地 npm/git fixture 验证安装、移除、更新、失败和关闭等待；打开项目及 reload 不隐式下载。 |
| Project MCP | 已实现且验证 | `.pi/mcp.json` 和 `.mkagent/mcp.json` 共用宿主信任，拒绝项目凭据路由，撤销后关闭连接并移除工具。 |
| MCP OAuth | 已实现且验证 | 本地服务验证显式授权、PKCE、scope、轮换、跨进程锁、取消和 worker 生命周期；选定 WebUI 回环及登出工具撤销通过。 |
| Codemode/tool search | 已实现且验证 | 真实 durable 目录覆盖插件/MCP、deferred、移除和 exposure；内置执行共享有任务与 journal 用例，SDK TUI manager 结果不代替工具执行。 |
| Retry/steer/follow-up/compaction | 已实现且验证 | 真实 Harness、接受队列、重复文本、重试、取消、压缩设置和提交边界有回归；摘要通过 durable task 调度。 |
| Resume/branch/usage/export | 已实现且验证 | SQLite/JSONL 恢复、完整树、普通 cutoff、输入、用量、导入导出及搬迁 HTML 有证据；来源与实际适配范围分别记账。 |
| CLI/JSONL/Desktop/WebUI | 已实现待验证 | bundled JSONL、认证 WebSocket、macOS 搬迁包及选定 WebUI/Desktop 通过；正式签名公证安装、系统协议和 Windows 未验收。MkAgent CLI 不因 SDK TUI 夹具增加新界面。 |
| Themes/shortcuts/editor/renderers | 已实现且验证 | macOS 独立 SDK PTY 检查 regular/fullscreen、主题、快捷键、CustomEditor、renderer、overlay、reload 及尺寸；不等于全部 TUI 插件或原版 CLI 成为产品需求。 |

## MkAgent 保留清单逐行对照

| 范围 | 功能状态 | 既有行为证据与本次要求 |
|---|---|---|
| 会话与流式交互 | 已实现且验证 | Kernel、事件队列及真实 PiAgent 覆盖创建、继续、排队、steer/follow-up、重试、取消和完成；执行器调整后重验受影响路径。 |
| 历史与持久化 | 已实现且验证 | SQLite/JSONL 崩溃、严格产品回执、submission 身份、分支及文件传输有证据；迁移保持数据与已接受工作。 |
| 模型与凭据 | 已实现且验证 | provider、目录/端点更新、thinking、刷新、mini completion 与本地授权有定向及产品验证。 |
| 权限与工具 | 已实现且验证 | allow/deny/改参、代理/会话工具、动态目录、嵌套、进度、取消及真实 subprocess 路径保持。 |
| MCP 与浏览器 | 已实现且验证 | MCP、codemode、tool-search、默认 profile 浏览器与脱敏回归保持；测试使用本地替身，不访问真实浏览器空间或代理。 |
| 后台工作 | 已实现且验证 | 后台 shell、停止归属、通知、handoff 和跨 worker generation 保留源会话身份。 |
| 上下文 | 已实现且验证 | 宿主 prompt、资源隔离、压缩、cache/usage、混合 instructions 和成功读取 prerequisites 保持。 |
| 产品入口 | 已实现待验证 | 选定 macOS headless/WebUI/Desktop 和离线资源已有历史证据；其他平台和正式发布检查按实际改动影响决定，不扩大旧结果。 |

## 后续验收

文档校正及宿主工具、请求、edit 参数、普通工具和 core 默认转换的复用保留各自验证证据。AgentSession 主链接线和本切片源码删除已通过定向验证，session/summary 必要接点继续按实际缺口登记，其余源码收敛和整体验收仍是本轮未完成任务，不能因已登记缺口而关闭。公开 Agent/runToolCall 的普通工具已复用 SDK，低层自供执行函数的 task fixture 不属于此保证。未来架构改动须同时迁移调用方、数据和测试，以真实行为验证。既有读取确认、PowerShell、setup 历史、分支发布和作用域修复不得因换实现回退。

`e2213c8` 的历史 `196/6` 清单包含 192 份 src/pi 源码和 4 个门面；首批 SDK 替换后为 `192/6`，其中 src/pi 为 188 份。已排除 CLI、三种模式宿主及前述私有组件和 helper；该历史切片删除没有调用或公开导出的 renderer barrel，并收窄终端颜色求解器。公开主题的 56 个名称、49/7 前景背景和 5 项 fallback 已核实，文件入口完整 schema 校验的缺口已修复。83 项主题、HTML、生成和资源回归、声明构建、声明消费者、26 项 worker bundle 测试、完整来源 check 与固定 Craft 审计通过。全局精确例外使本地和固定上游主题源码的正常 Read 成功，其余 token 和凭据保护保留；先前项目 allow 未生效的历史见[权限与主题验证](coding-validation.md#theme-contract-and-complete-source-after-6240ed9)。全仓检查和最终独立验收按实际结果记账，旧数量与失败记录保留原时点。

历史浏览器任务 7 和 8 已各自关闭，不构成本次新访问授权。Windows、正式签名公证、系统协议和其他 TUI 组合保留其证据缺口，不能借文档修订记为完成。文档本批的链接、一致性、标点及独立复核结果单独记录，产品和全仓旧结果不算本批重跑。
