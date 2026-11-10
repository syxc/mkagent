# Pi-durable coding agent 实施计划

状态：2026-11-09 按用户纠正重新打开 F0 至 F6 整体验收。此前 SDK 替换、工具和请求切片、主题及宿主清理的验证保留各自证据，但未达到删除大规模 Coding 源码的原始目标。用户现已明确允许生产使用 `pi-coding-agent` 的公开 SDK；以公开 AgentSession 构造函数可注入外部 Agent 的实际结果为起点推进替换，durable 执行、输入持久化和恢复已通过 AgentSession 新接线的定向验证，其余源码与整体验收继续开放。当前进度见[纠偏跟进](coding-follow-up.md)，未完成前不统一推送。运行时代码起点为 `cb0311f`；本文的既有提交、D0 至 D6 及后续批次账本保留原适用时点。

MkAgent 原先使用 Pi coding agent，第一次直接换成 pi-durable 后，发现 Coding 能力不足且不能复用 Pi coding agent 的插件生态。当前方向是以切换前的 MkAgent 为产品行为和接入边界参照，保留 Pi coding agent 的 Coding 层与插件契约，尝试将其底层执行基座换成 pi-durable。对 MkAgent 而言，使用的仍是 Pi coding agent 的能力与接口，执行、存储和恢复由 durable 承担。

此前实现大量复制和改造 Pi 源码，未先充分复用可用的官方 SDK，导致上游 Coding 和 durable 更新时可能需要逐文件对照适配。本次返工须减少这部分长期维护责任：durable 已有能力优先使用 durable，其余使用 Pi 官方 SDK 的公开 API，本地只留必要适配。用户于 2026-11-09 解除完整 `pi-coding-agent` 生产依赖禁令，允许使用其公开 SDK，不启动原版 CLI。SDK 覆盖后实际删除对应源码和多余直接依赖，不保留并行实现，不把整块复制实现移入补丁。

本次范围是 agent 内核切换及必要兼容接入。MkAgent 既有客户端/服务端分层、Pi backend 与子进程边界、宿主会话/权限/凭据职责、RPC/UI 契约和产品持久化行为保持。宿主侧只做经确认的内核或插件契约所需的最小适配，不重划上层职责或重做已正常工作的模块。

[能力规格](coding-capabilities-spec.md)定义需求，[纠偏跟进](coding-follow-up.md)定义 F0 至 F6 顺序，[架构记录](coding-architecture.md)描述实际代码，[SDK 维护清单](coding-sdk-maintenance.md)登记发布能力、本地补丁和适配的缺口、恢复、退出条件及升级检查。[需求对照](coding-acceptance.md)和[验证记录](coding-validation.md)区分实现、历史证据和待验项。AgentSession、自有任务种类和剩余源码均按实际契约及 API 缺口登记；原版 CLI 与三种模式宿主已排除。不能从旧文档、现有测试或来源可达图反推必须保留的需求。

`2c2b98a` 后的包管理切片已将宿主命令、资源发现和 legacy 包管理入口接入公开 Coding SDK DefaultPackageManager，删除本地包管理器及无调用的 output guard、Git helper 和两份转发。包管理主体算法由发布包提供，仓内补丁只增加必要的宿主策略、目录、作用域、协议输出和安装任务排空接点。该切片通过 focused 51 项、两项类型检查、worker bundle 26 项、完整来源检查及 hoisted 冻结安装。`e20bb1a` 后的主题与快捷键切片统一使用公开 SDK Theme、KeybindingsManager 及主题资源，删除九份 TypeScript、两份 JSON 和旧转换脚本，并移除 highlight.js 直接依赖。SDK 窄补丁只补现有导出、默认完整校验和 worker 主题路径。该主题切片时 runtime 为 177 份 TypeScript、4 项资源，其中 src/pi 为 173 份；focused 72 项、两项类型检查、worker bundle 26 项、完整来源检查及全新 hoisted 安装的 45 份补丁核验通过。`05d63dc` 后的注册表切片改用 SDK ModelRegistry 和完整 MCP 模块，删除两份实现及旧 MCP 转发；补丁只补根导出和公共 runtime 构造声明，不改执行 JS。该注册表切片时 runtime 为 175 份 TypeScript、4 项资源，其中 src/pi 为 171 份。66 项定向测试、454 个断言、两项类型检查、26 项 bundle 测试、完整来源检查及全新 hoisted 安装的 46 份补丁核验通过；独立定向复核未发现确定缺陷，覆盖范围及检索限制见验证记录。`4cc709a` 后的 SessionManager 切片删除 2057 行本地实现和旧转换分支，改用 SDK 的存储、树及投影算法；补丁只增加投影回调、可继承及 detached 工厂和目录钩子。执行及公开声明 token 对照一致。该 SessionManager 切片时 runtime 为 174 份 TypeScript、4 项资源，其中 src/pi 为 170 份；112 项定向测试、680 个断言、两项类型检查、26 项 bundle 测试、完整来源检查、全新安装 48 份补丁核验及固定 Craft 审计通过，独立定向复核未发现确定缺陷。`df732f7` 后的 ResourceLoader 切片再删除 1361 行本地资源、context 和去重实现，三个创建入口共用 SDK 类，补丁仅加宿主策略及插件函数注入。完整算法 token 对照一致。该 ResourceLoader 切片时 runtime 为 173 份 TypeScript、4 项资源，其中 src/pi 为 169 份；70 项定向测试、423 个断言、两项类型检查、26 项 bundle 测试、完整来源检查、全新冻结安装 50 份补丁核验及固定 Craft 审计通过，资源切片独立复核未发现确定新增缺陷，并确认插件 loader 的十项声明与 SDK 一致，当时建议的模块导入窄钩子现已落实。`354f3cb` 后的插件 loader 切片将注册事务、factory 生命周期、缓存、批量加载和发现交给 SDK，删除两个完整 loader、Jiti 和 manifest helper、旧转发及资源包装，共七份文件、1179 行。宿主只绑定 native/legacy 模块表、Jiti 转译和目录；SDK 窄补丁新增 importer 和项目目录选项，并按稳定 importer 隔离 cache，保留原有 cwd/generation 失效及默认导入分支。该插件切片时 runtime 为 169 份 TypeScript、4 项资源，其中 src/pi 为 165 份；辅助来源为 9 项、共享入口为 21 个。78 项定向测试、543 个断言、两项类型检查、26 项 worker bundle 测试及 103 个断言通过；完整来源与补丁 check、全新 hoisted 冻结安装的 52 份补丁核验及固定 Craft 的 2164 文件审计通过。独立复核的 11 组探针通过，未确认运行时回归；七条删除文件的来源清单残留已修正并通过完整审计。ModelRuntime、插件 runner/types 和 AgentSession 主链继续开放。不能据此关闭 F0 至 F6。

`0c69e9f` 的 ModelRuntime 切片直接使用公开 SDK 类、provider composition、virtual routing、凭据串行操作及模型存储，删除九份运行时源码、旧转换脚本和一份转发，共十一文件、2986 行。SDK 窄补丁增加实时宿主 Models 绑定与共用临时凭据入口：扩展 overlay 保留在独立内存集合，宿主 refresh 仍使用原集合和目录存储，迟到检查不能恢复旧宿主快照，默认 SDK create 路径保留；composer 仅收窄结构类型。该模型切片时 runtime 为 160 份 TypeScript、4 项资源，其中 src/pi 为 156 份；辅助来源为 9 项、共享入口为 20 个。142 项定向测试、548 个断言及两项类型检查通过；worker 完整组合通过 25 项，一项图像测试超过默认 5 秒后，以 15 秒预算单项复跑通过，未修改仓库测试超时。完整来源与补丁 check、全新 hoisted 冻结安装的 55 份补丁核验、12 项模型契约及固定 Craft 的 2154 文件审计通过。独立复核未确认新增回归；24 项测试、补充确定性探针、85 个成员对照和公开消费端类型检查通过。复现的自定义 AuthContext 未传入内部集合问题在替换前已存在，当前生产未见该自定义接线，作为既有契约缺口保留跟进；该时点 legacy NativeModelRegistry 的结构适配、插件 runner/types 和 AgentSession 主链仍开放。

`0c69e9f` 后的 runner/types/exec 切片使用公开 SDK ExtensionRunner、插件类型、defineTool 和 execCommand，删除完整 runner、types、exec 实现、两份转发及旧转换脚本，共六文件、4101 行。SDK 补丁只增加实例级 theme/prompt 注入、可选 replay 声明和现有模块根导出，显式保留 KeybindingsManager 值导出；事件、生命周期和命令执行算法继续由 SDK 提供。legacy 薄绑定保留 headless theme 与宿主文档提示词，Native 会话显式注入原提示词构建器，默认 SDK 构造保持。该 runner 切片时 runtime 为 157 份 TypeScript、4 项资源，其中 src/pi 为 153 份；辅助来源为 9 项、共享入口为 18 个。161 项定向测试、831 个断言、两项类型检查和完整来源及补丁 check 通过。worker 完整组合为 25 项通过、图像项默认 5 秒超时；该项随后在 15 秒预算内通过，未改仓库超时。全新 HOME/cache 的 hoisted 冻结安装覆盖 11 个 workspace，lock 未变，58 份补丁产物与已测试安装一致，Coding 为 24 份；SDK-only runner/exec 的 3 项测试、24 个断言及公开消费端类型检查通过，固定 Craft 审计覆盖 2150 文件。独立复核首次因连接超时中断；新的只读复核未确认相对 `0c69e9f` 的新增缺陷，独立运行 105 项测试、424 个断言及源码和公开消费端类型检查通过，并核验补丁算法、403 路径的删除闭包及来源摘要。该 runner 切片时 AgentSession 生产生命周期、原子输入接纳、取消和冷恢复仍开放；后续接线见下段，剩余源码替换及 F0 至 F6 继续开放。

`5a72c8a` 后的 AgentSession 切片将完整会话生命周期、工具注册、插件输入与 HTML 导出交给公开 Coding SDK。`native-agent-session.ts` 仅绑定 durable 结算、输入持久化、journal 身份、summary 和兼容快照；无接点时 SDK 保持原执行循环。旧完整会话类、退出闭包的 helper、工具包装实现、四份 HTML 资源和旧输入转换脚本共十七文件已删除，ZIP writer、sleep 和工具转换也改用 SDK，fflate 直接依赖移除。SDK 窄补丁增加可选执行与接纳接点，工具转换保留声明元数据和 Symbol 描述符，图片 worker 只用模块路径或进程内回退。该 AgentSession 切片时 runtime 为 145 份 TypeScript，其中 src/pi 为 141 份、门面为 4 份，资源为 0；辅助来源为 9 项、共享入口为 18 个。Coding 补丁为 30 份物理输出，与 core 4 份、durable 30 份合计 64 份。生产恢复组合通过 43 项测试、313 个断言，worker 完整组合通过 26 项、103 个断言，两项类型检查通过；会话与工具组合通过 15 项、107 个断言。修复复核问题后的全新 hoisted 冻结安装核验 64 份产物，公开类型和同一 15 项测试通过，lock 未变；固定 Craft 审计覆盖 2137 文件。首次 follow-up 超时由 SDK 转换丢失宿主执行标记引起，图片 canary 失败由 SDK 项目相对 worker 路径引起，两项原回归修复后通过。最终类型探针曾误用 namespace 和 exposure 类型，按公开类型修正后复用安装通过。独立复核确认嵌套工具绕过 durable 和内部模型投影带回宿主元数据两项新增回归；现通过可选 runToolCall、convertToLlm 接点修复，默认 SDK 路径保留。父子 durable 任务、边界与 provider 投影、transcript 和 journal 元数据回归通过；实际 provider 请求在修复前也已清理。独立复查另确认发布图片未沿用共享 Photon，构建目录缺失时会静默丢图；现通过可选 processImage 绑定既有处理器，屏蔽构建依赖的搬迁图片回归、15 项会话工具、26 项 bundle、类型和全新冻结检查通过。图片专项独立复查未发现可确认的新增缺陷；复查方重跑搬迁图片用例通过，并核对十一份相关文件和三十份补丁产物，结论仅覆盖该修复。剩余源码与 F0 至 F6 整体验收继续开放，AuthContext 既有缺口保留跟进。

`a567bf4` 后的搜索切片使用公开 Coding SDK 的 grep/find/ls 工厂和 renderer，删除六份本地源码、1044 行。durable 1.5.0 未提供这三种工厂；宿主只为 grep/find 绑定现有二进制解析与离线安装策略，ls 直接使用 SDK。该搜索切片时 runtime 为 139 份 TypeScript，其中 src/pi 为 135 份、门面为 4 份，无资源；辅助来源 9 项、共享入口 18 个，core/Coding/durable 补丁共 68 份，Coding 占 34 份。独立复核确认 options 展开丢失自定义 operations；主线程先复现再修复，最终搜索 21 项、54 个断言及公开类型通过。其他回归、冻结安装、来源审计和失败修正见[搜索验证](coding-validation.md#search-sdk-boundary-after-a567bf4)。`c032e05` 后的生产搜索切片进一步删除三份工具实现、545 行，由 27 行装配通过既有 agentToolToHost 连接同一 SDK，保留产品二进制策略、每调用取消信号和 CR 换行语义。搜索与管理器 33 项、取消 22 项、桥接与元数据 20 项、bundle 26 项及 Coding/server 类型检查通过；两处多余 null 转换引起的类型失败已修正，详细时点见[生产搜索验证](coding-validation.md#production-search-sdk-boundary-after-c032e05)。其余源码收敛和 F0 至 F6 继续开放。

`1765fd7` 后的插件 write 切片直接引用公开 Coding SDK 工厂、options 和类型，删除 write 与 renderer 两份源码、288 行，没有新增运行时包装或 SDK 补丁。生产 write 继续使用 durable；插件入口保留自定义 operations、ctx.cwd、原始字节、错误、在途取消及与 edit 共用队列。该 write 切片时 runtime 为 137 份 TypeScript，其中 src/pi 为 133 份、门面为 4 份，资源为 0；辅助来源、共享入口和 68 份补丁输出不变。349 项相关测试、827 个断言、26 项 bundle、103 个断言、Coding/server 类型和完整 runtime check 通过。来源、文档及独立复核的实际状态见[write 验证](coding-validation.md#write-sdk-boundary-after-1765fd7)，其余源码和 F0 至 F6 继续开放。

`7596356` 后的插件 read 切片再删除工厂和 renderer 两份源码、396 行，读取、分页、取消、结构化输出与展示由公开 Coding SDK 承担。薄工厂只绑定共享图片处理、durable MIME 和宿主文档路径，SDK 仅增加可选依赖接点；生产 read 继续使用 durable。该 read 切片时 runtime 为 135 份 TypeScript，其中 src/pi 为 131 份、门面为 4 份，无资源；辅助来源 9 项、共享入口 18 个，补丁输出为 core 4、Coding 38、durable 30，共 72 份。954 项 read 相关测试、20 项路径组合、26 项 bundle、Coding/server 类型、完整 runtime 与最终补丁 check 通过。失败修正、冻结刷新、来源和独立复核范围见[read 验证](coding-validation.md#read-sdk-boundary-after-7596356)，其余源码及 F0 至 F6 继续开放。

`cfefb9b` 后的插件 edit 切片删除执行、renderer、预览及路径 helper 四份生成源码、旧 diff 转换和无调用路径适配，共六文件、741 行。20 行薄适配通过公开 Coding SDK 工厂保留插件执行与展示，参数准备和公开 diff 继续优先使用 durable；没有新增 SDK 补丁。该 edit 切片时 runtime 为 131 份 TypeScript，其中 src/pi 为 127 份、门面为 4 份，无资源；辅助来源 9 项、共享入口 18 个及 72 份补丁输出不变。383 项 edit 相关测试、36 项 read/path、26 项 bundle、Coding/server 类型、完整 runtime check 通过。独立复核通过 419 项测试和 14 项补充探针，未确认运行时回归；退役类型夹具的两处 TS2339 已通过删除该 10 行夹具处理，并重验 Coding 类型。最终固定 Craft 审计覆盖 2126 文件并通过，六份文档的标点和 130 个本地链接检查通过，范围见[edit 验证](coding-validation.md#edit-sdk-boundary-after-cfefb9b)。该时点旧 durable helper 补丁、其余源码及 F0 至 F6 继续收窄和验收。

`2951fe6` 后的 helper 切片撤除七个低层 diff 导出及 readPathVariants，恢复两个路径文件的发布原文，durable 补丁由 30 份降为 28 份，总输出由 72 份降为 70 份。保留两个公开 diff 函数的 216 项历史结果，删除无适配消费者的私有归一化测试。两个既有安装冻结刷新后 lock 不变，327 项工具回归、26 项 bundle、Coding/server 类型和完整补丁重放通过，共 768 个断言；来源更新四项、移除一项，固定 Craft 审计覆盖 2125 文件。独立复核及限制见[helper 验证](coding-validation.md#durable-tool-patch-cleanup-after-2951fe6)。该 helper 切片时仍有 127 份 src/pi 源码需要逐职责核对；F0 至 F6 未关闭。

`145dd49` 后的插件 shell 切片删除 Bash、PowerShell、输出累积器及 renderer 四份源码、874 行，公开 Coding SDK 承担执行与展示，42 行薄绑定只注入既有宿主进程策略。SDK 可选依赖保留原 options、PowerShell 延迟 operations 和默认分支；生产 shell 继续优先使用 durable。该 shell 切片时 runtime 为 127 份 TypeScript，其中 src/pi 为 123 份、门面为 4 份，无资源；辅助来源 9 项、共享入口 18 个，补丁为 core 4、Coding 42、durable 28，共 74 份。134 项测试、568 个断言、Coding/server 类型、完整补丁重放、两处冻结刷新和生成检查通过，lock 未变。独立复核发现的两个公开工厂声明 TS2742 已用公开 ReturnType 修复，根工程及 hoisted 工程实际声明生成和 server 类型重验通过。来源登记更新八项、移除四项并新增三项，固定 Craft 审计覆盖 2124 文件。SDK 内部默认会话及交互 executeBash 仍使用自身工厂，其宿主策略覆盖保留核对；验证及独立复核边界见[shell 验证](coding-validation.md#public-sdk-shell-factories-after-145dd49)。剩余源码、AuthContext 既有缺口和 F0 至 F6 继续开放。

`d581616` 后的 codemode 切片再删除五份源码、653 行，公开 Coding SDK 承担工具描述、声明、loadout、grammar、renderer 和工厂，32 行薄绑定只注入已有 durable 执行器。沙箱、worker 及 source/declarations helper 改从 durable 公开入口取得，两个 workspace 的直接 pi-codemode 依赖删除，官方 SDK 内部的传递依赖保留。该 codemode 切片时 runtime 为 122 份 TypeScript，其中 src/pi 118 份、门面 4 份，无资源；辅助来源 9 项、共享入口 18 个，core 4、Coding 46、durable 33 共 83 份补丁输出。169 项测试、774 个断言、Coding/server 类型、根与 hoisted 布局实际声明、完整生成与补丁重放检查通过，两个既有安装冻结刷新及产物核对通过；lock 仅删除两条直接依赖。来源登记更新 31 项、移除 5 项并新增 4 项，固定 Craft 审计覆盖 2123 文件。独立复核未确认本次替换引入的新增缺陷，Bun 安装问题、旧导出保留及验证范围见[codemode 验证](coding-validation.md#public-sdk-codemode-factories-after-d581616)。其余源码与 F0 至 F6 未完成。

`f02db2e` 后的 UI 切片再删除组件及退出闭包的 41 份源码、8885 行，公开 Coding SDK 承担组件、CustomEditor 和 renderer 生命周期。25 行绑定只覆写共享 PNG 注册，MCP 类只增加已有根导出。该 UI 切片时 runtime 为 81 份 TypeScript（src/pi 77、门面 4）、0 项资源，辅助来源 9 项、共享入口 18 个；core 4、Coding 48、durable 33 共 85 份补丁输出。根工程定向 42 项、257 个断言通过，hoisted 相关 80 项、453 个断言及 UI 协议 19 项、82 个断言通过；两布局 Coding 声明通过，hoisted 的 server 类型和构建通过，根工程依赖布局失败如实保留。完整生成、补丁重放、冻结刷新及 hash 检查通过，lock 未变；来源更新 11 项、移除 41 项并新增 4 项，固定 Craft 审计覆盖 2086 文件。独立复核未确认新增缺陷，范围见[UI 验证](coding-validation.md#public-sdk-ui-components-after-f02db2e)。该时点 image-convert 既有算法副本、其余源码和 F0 至 F6 继续开放。

`9bd4b1e` 后的图片切片删除 89 行转换与注册副本，公开 Coding SDK 承担原算法和实例级注册状态；12 行绑定只注入共享 Photon 与 durable 方向处理。该图片转换切片时 runtime 为 80 份 TypeScript（src/pi 76、门面 4）、0 项资源，辅助来源 9 项、共享入口 18 个；core 4、Coding 50、durable 33 共 87 份补丁输出。根工程 136 项、817 个断言及 hoisted 26 项 bundle、105 个断言通过，hoisted 17 项是布局对照，不重复累加。根声明 TS2742 修正后，两布局实际声明及 hoisted server 类型通过。来源更新 9 项、移除 1 项并新增 3 项，固定 Craft 审计覆盖 2088 文件；两处冻结安装、完整 runtime check、补丁重放与 hash 核验通过，lock 未变。失败修正及复核状态见[图片转换验证](coding-validation.md#public-sdk-image-converters-after-9bd4b1e)；该时点其余 76 份 src/pi、image-process/resize、AuthContext 及 F0 至 F6 继续开放。

`48aa826` 后的图片处理切片将格式归一化、转换与尺寸提示、omission、worker 通信和回退交给公开 Coding SDK，删除 process、resize、worker 及退出闭包的三份转发，共六份 runtime、284 行；另删除 39 行退役生成测试及对应生成规则。12 行 native-image-process 只绑定共享转换器、durable 编码策略和明确宿主模块 URL，SDK 新增两个可选依赖工厂及 worker 模块入口，默认 API 保留。该图片处理切片时 runtime 为 74 份 TypeScript（src/pi 70、门面 4）、0 项资源，辅助来源 9 项、共享入口 18 个；core 4、Coding 54、durable 33 共 91 份补丁输出。根工程 132 项、808 个断言，hoisted 对照 23 项、257 个断言及 bundle 26 项、105 个断言通过；Coding 类型、两布局实际声明、hoisted server 类型与构建通过。来源更新 18 项、移除 7 项并新增 4 项，固定 Craft 审计覆盖 2085 文件并通过；两布局冻结安装、pristine 重放和 hash 核验通过，lock 未变。安装准备被时限中断后的安全续接、独立复核状态及验证范围见[图片处理验证](coding-validation.md#public-sdk-image-processing-after-48aa826)。该时点其余 70 份 src/pi、AuthContext 既有缺口及 F0 至 F6 继续开放。

`8b00984` 后的用量、来源与计时切片使用 Coding SDK 已有 usage-totals、source-info 和 timings，删除三份完整实现、228 行及两份兼容转发、4 行。补丁只增加已有根导出，六份 helper JS/声明与 pristine SDK 一致，没有新增本地包装或依赖；durable 继续负责回执和用量账本，宿主资源与信任策略保留。该用量、来源与计时切片时 runtime 为 71 份 TypeScript（src/pi 67、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；core 4、Coding 54、durable 33 共 91 份补丁输出。35 项直接断言、hoisted 39 项资源/插件测试和 26 项 bundle、Coding 类型、两布局声明及 hoisted server 类型与构建通过。根工程测试为 30 通过、1 项类型消费者因根依赖入口缺失失败，同一未改夹具在 hoisted 通过；不将原失败记为通过。两布局冻结安装、hash、完整生成与 pristine 重放通过，lock 未变；来源更新 17 项、移除 5 项，固定 Craft 审计覆盖 2080 文件并通过。独立复核状态及范围见[用量、来源与计时验证](coding-validation.md#public-sdk-usage-source-and-timing-helpers-after-8b00984)；该时点其余 67 份 src/pi、AuthContext 既有缺口及 F0 至 F6 继续开放。

`c6227a6` 后的资源发现切片使用公开 Coding SDK 的 skills 与 prompt templates，删除两份完整算法及旧目录转换脚本，共三文件、849 行。两个薄绑定共 19 行，只保留 Native 安装目录和 agentDir 默认值，legacy 继续固定 `.pi` 并拒绝缺少 agentDir；SDK 只增加可选项目目录参数及现有根导出，扫描、ignore、诊断、来源与展开算法保持。直接 ignore 依赖及 lock 中对应 workspace 声明已删除，传递依赖保留。该资源发现切片时 runtime 为 69 份 TypeScript（src/pi 65、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；core 4、Coding 58、durable 33 共 95 份补丁输出。41 项直接断言、hoisted 38 项资源/插件测试和 26 项 bundle、Coding 类型、两布局声明及 hoisted server 类型与构建通过。根首轮 26 项通过、7 项失败，隔离环境修正后包管理 10 项与 RPC 4 项单独通过，原失败记录保留。两布局冻结安装、全部 Coding/durable hash、完整生成与 pristine 重放通过；来源更新 17 项、移除 3 项并新增 2 项，固定 Craft 审计覆盖 2079 文件并通过。独立复核状态及范围见[skills 与模板验证](coding-validation.md#public-sdk-skill-and-prompt-discovery-after-c6227a6)。该时点其余 65 份 src/pi、AuthContext 既有缺口及 F0 至 F6 继续开放。

`dc64ddc` 后的系统提示词切片使用公开 Coding SDK 的构建、normalize、diff 和渲染算法，删除 228 行完整本地模块；旧 30 行 legacy 路径替换与构建逻辑缩为 5 行绑定，新增 6 行 Native 绑定，两者共 11 行。SDK 只增加文档 getter 的实例工厂及现有根导出，Native 安装路径、legacy v1.5.0 URL 与 SDK 默认路径分别保留，算法正文不变。该系统提示词切片时 runtime 为 68 份 TypeScript（src/pi 64、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；core 4、Coding 60、durable 33 共 97 份补丁输出。13 组输入的 142 项差分断言、根工程 28 项测试和 220 个断言、hoisted 43 项插件与恢复测试和 422 个断言、26 项 bundle 和 105 个断言通过，Coding 类型、两布局声明及 hoisted server 类型与构建通过。首轮临时参考模块无法解析 pi-ai，原失败收据保留；仅修正探针依赖路径后单独补验通过。两布局冻结安装、全部 Coding/durable hash、完整生成与 pristine 重放通过，lock 未变；来源更新 13 项、移除 1 项并新增 1 项，固定 Craft 审计覆盖 2079 文件并通过。独立复核状态及范围见[系统提示词验证](coding-validation.md#public-sdk-system-prompt-builders-after-dc64ddc)。该时点其余 64 份 src/pi、AuthContext 既有缺口及 F0 至 F6 继续开放。

`f6a1c6f` 后的 compaction 切片使用公开 Coding SDK 的上下文估算、裁剪、压缩、分支总结和序列化算法，原四文件共 1662 行的本地闭包缩为一行 SDK 转发，三个文件实际删除，共净减 1661 行本地生产源码。SDK 只补两个既有估算函数和返回类型 ContextUsageEstimate 的根导出，内部三个算法模块的 JS/声明六文件保持 pristine，没有新增物理补丁输出。durable summary task 继续负责真实 owner、请求 intent、取消、回执和禁止不确定重发。当前 runtime 为 65 份 TypeScript（src/pi 61、门面 4）、0 项资源，辅助来源 9 项、共享入口 16 个；core 4、Coding 60、durable 33 共 97 份补丁输出。383 项差分断言和 20 组摘要调用、根工程 51 项测试、hoisted 66 项行为测试及 26 项 bundle 通过；Coding 类型、两布局声明及 hoisted server 类型与构建通过。首次声明和类型消费者出现 TS2742，补齐公开返回类型后仅补验两项失败检查，原失败保留。两布局冻结安装、全部 Coding/durable hash、完整生成与 pristine 重放通过，lock 未变；来源更新 14 项、移除 3 项且无新增，固定 Craft 审计覆盖 2076 文件并通过。Read/Edit 规则拒绝 legacy/context-tokens.js，因此保留其既有调用路径的一行转发；这是权限阻塞下的临时残留，不是 SDK API 缺口，也未绕过拒绝。独立复核状态、隔离夹具保留和验证范围见[compaction 验证](coding-validation.md#public-sdk-compaction-after-f6a1c6f)。其余 61 份 src/pi、临时兼容入口、AuthContext 既有缺口及 F0 至 F6 继续开放。

## 目标与名称

迁移以保留 Pi Coding 层、替换其执行基座为目标，本地名称为 `pi-durable coding agent`，简称 `durable coding agent`。原始行为与接入参照为 `b77c4a2645d3`：它是第一次运行时切换 `e4b75c2` 的父提交，worker 仍直接使用 `pi-coding-agent@1.1.0` SDK。当前 SDK 核查继续固定 Pi 1.5.0，产品保留范围包含 `cb0311f` 及后续有效改动；这些版本分别服务于行为对照、SDK 选型与防止回归，不要求退回旧代码或旧依赖。

验收检查 Pi Coding 能力与公开插件契约是否保留，底层执行、存储和恢复是否交给 durable，官方 SDK 是否实际复用，以及 MkAgent 产品行为和存量数据是否兼容。来源可复现、相同 Harness 和历史测试数量各自只能证明其检查范围。

完成条件包括：已确认的重复职责和必需功能缺口已处理，剩余源码与补丁有具体缺口、退出条件及升级检查；后续 Coding/durable 更新主要核对公开 SDK 契约和必要适配，不再默认逐文件改造完整 Coding 闭包。文档、代码和实际验证须一致。未核实项明确开放，不承诺只改版本号就能升级，也不为理论最低维护成本无限迭代。

## 依赖与执行职责

| 组成 | 职责与约束 |
|---|---|
| pi-durable | 优先使用已发布的执行、工具、输入、任务所有权、事务、存储、取消及恢复实现；自定义任务仍需核对是否重复这些职责。 |
| Coding 层及执行适配 | 保留 Pi coding agent 的 Coding 能力与公开插件契约，优先引用官方 SDK；仅对接入 durable 仍缺失的行为做必要适配。 |
| pi-agent-core 等独立 Pi 官方 SDK | 按需引用公开类型、协议和可复用实现。引用后执行仍由 durable 管理；仓内补丁新增的 API 单独作为例外。 |
| pi-coding-agent 公开 SDK | 用户已允许作为生产直接依赖，复用其公开 Coding API，不启动原版 CLI；以必要适配接入 durable 并删除被替代的源码。 |
| MkAgent 宿主 | 继续负责产品会话、权限、模型凭据、工具目录、MCP、浏览器、传输和界面。 |

pi-durable 已发布 codemode、tool-search、tools、images 及完整 Harness/任务/存储接口，应先核对其已有实现和扩展点，再选择其他 Pi 官方 SDK。当前 `pi.coding.*` 虽由官方 scheduler 执行，仍含本地请求与工具状态机，属于首批纠偏重点。

对每个确需适配的范围，记录真实契约、候选发布 API、实际缺口、最小适配、调用方和验证。原型、getter、私有阶段或完整 CLI 的旧断言须先核实需求；不能为了通过旧测试扩大兼容。确认必要的源码固定到 Pi v1.5.0 提交 `f9a26365568127461c47a07a37dcb42c140a3ac5`，保留来源、许可和生成检查。当前 root `patchedDependencies` 的 core、Coding 和 durable 修改须单独审查，补丁新增接口不计为 Pi 原包已发布能力。

宿主已安装上述四类内置模块，并通过工具桥接向 coding profile 提供工具。SDK 搜索、codemode 输出及 Native codemode 执行现已共用 durable；原 Native 执行循环已删除。外层保留发现元数据、字符串调用 ID、分支 store、沙箱名额和 Native 工具管道。取消和等待 helper 引用 Pi 官方包。完整 SDK 源码闭包的必要性仍未核实，不能据此宣称整个 SDK 已去重。

`62ed325` 完成首个执行切片：宿主工具交给公开 ToolTask phases/abort，删除 `host-tool-nested.ts`。SDK checkpoint 和完整 Native 结果在原 `pi.coding.tool` owner 下持久化，旧 v1 checkpoint 保持恢复路径。专项覆盖策略限制、已完成和失败回执、工具移除、owned cleanup、并发身份及 API 关闭。Native 保留审批、hooks、事件与 journal，工具切片未新增补丁或改变任务版本。

后续请求切片已接入仓内新增的 `GenerationResponseTask` v1，直接复用 SDK 的 `streamResponse` 与 partial 写入。发布版 `GenerationTask.request` 会继续分类和写消息，不能独立返回响应；新任务提供这一明确出口，保留原 `GenerationTask` v4 和所有 `pi.coding.*` v1。Native `message_end` 完成后才决定工具 calls，SDK receipt、唯一 assistant entry 和下一 checkpoint 同事务提交。不确定 request/event 不重发，取消与恢复均清理 SDK generation 槽。新任务属于本地 SDK 修改，退出条件和升级检查见架构记录；不能记为未修改发布 API。完整 30 文件补丁已有真实重放和冻结消费者核对。工具轮次与收尾已核对：发布 SDK 阶段同时写 assistant、创建工具、应用 inbox 和转交下一请求，没有独立返回轮次决定的出口。当前保留 Native 交付与 journal 适配，未新增轮次补丁，退出条件见架构记录。另已删除插件 edit 的参数转换副本，直接使用公开 `createEditTool().prepareArguments`；后续 edit 切片也已将文件执行、预览和 renderer 交给公开 Coding SDK。公开 Agent/runToolCall 的普通 AgentTool 现已接入同一个 ToolTask 桥，已桥接工具和 AgentSession 往返转换避免重复包装。Native 保留首次参数验证和权限改参；effect 前检查取消，最终参数与完整 SDK 回执原子保存，旧回执缺字段时回退已接受参数。summary 的并发与主 generation 进度隔离已固定，session/summary 的候选 API、具体缺口和退出条件见架构记录；未改变其运行时任务。此前核对未充分评估完整 Coding 包的公开 SDK，不能据此关闭 F1 至 F3。现按已授权的公开 SDK 重新接线，并以实际删除源码和行为验证验收。

SDK 入口范围已继续收窄：此前排除原版 Pi CLI 的 `main`/`MainOptions` 及 24 份独占源码；`5662422` 后的限定复核再确认三种模式宿主不属于原始 MkAgent 接入或必需插件契约。现排除 `InteractiveMode`、`runPrintMode`、`runRpcMode` 和前两者专用 options，删除三个实现文件。生成器在遍历根入口和 modes barrel 前应用同样排除。保留 `RpcClient`/options、协议和 JSON events、Theme、CustomEditor、renderer/UI、ExtensionMode、AgentSessionRuntime 及 MCP/codemode/tool-search 工厂；产品仍通过 `CodingHost/createAgentSession` 装配。直接使用三种模式的外部消费者须迁移到自己的宿主。该切片时完整生成清单为 196 份 TypeScript、6 项资源；最新范围见架构记录，数量本身不证明保留范围最小。`06d1346` 后又从内部组件 barrel 排除没有包根导出和保留调用的首次设置、终端模型筛选及信任选择三个组件并删除实现；生成器在依赖遍历前应用同样排除，公开模型选择器和宿主信任处理保留。双包名真实插件、RPC client、宿主 UI、worker bundle、声明及局部来源检查的结果见验证记录。该删除不计作官方 SDK 完整覆盖，也不证明所有剩余辅助源码必要。

模式切片已提交于 `b10b881`。其后删除无剩余调用、未从根导出的终端 `/bug` 界面及只供该界面使用的上传 helper，同步移除两项来源记录。已有入口排除已切断这条依赖，不新增生成规则；保留 `AgentSession.summarizeForBugReport()`、核心摘要和 durable summary 任务。宿主实际摘要与插件回归 11 项及声明构建通过，不调用上传服务或真实 provider。此项删除不需要的宿主范围，不记作官方 SDK 替代。

`/bug` 切片已提交于 `d913008`。后续删除无剩余调用、未从包入口导出的 `session-share.ts`、`chat-viewport.ts`、`tui-renderer.ts` 和 `program-status-reporter.ts`，分别移除终端分享和宿主装配，来源清单同步减少四项；不删除公开消息/工具 renderer。外部编辑器、模型搜索与目录刷新仍被组件使用，继续保留。插件及宿主 UI 的 29 项回归、声明构建和独立 `./native` 声明消费者通过，没有执行分享上传或账号检查；此项不计为 SDK 替代或完整闭包核验。

`20cb6e8` 后又删除 15 份没有剩余调用和公开导出的启动器、终端私有源码，包含认证/版本/changelog、缓存浪费展示、剪贴板图片、主题控制器和八份私有组件；彩蛋延迟入口与实现一并删除。公告图片和 `grok-mermaid` 随之移除，生成器与 worker 不再收集交互图片目录。公开组件及 MkAgent 自有剪贴板、用量逻辑保留。86 项定向测试、声明构建、独立声明消费者和 26 项 bundle 测试通过，完整仓库结果见验证记录；不将清理未使用宿主记为 SDK 覆盖。

两个扩展 loader 在历史切片中先共用本地 runtime、注册 API 和 factory 接受/回滚，旧产物由 631 行减至 235 行。后续 `354f3cb` 后的切片已将这些职责及缓存、批量加载和发现交给公开 Coding SDK，并删除两个完整 loader；宿主只保留模块导入、转译和目录绑定。原有双入口隔离、失败回滚、旧 API 失效、reload 与信任契约通过新路径验证。任务版本和 checkpoint 不变，补丁接点和退出条件见 SDK 维护清单。

Agent 默认消息转换现直接使用发布版 `CoreAgent`；Native 函数、生成器提取及 core 补丁中的默认字段已删除，门面由 115 行减至 105 行。模型和 usage 两个可变默认对象继续保留，其必要性不由反射测试推定。70 项定向回归、全仓 CI、声明构建和独立冻结消费者的 Bun/Node 各 7 项检查通过，完整入口的最终范围见验证记录。执行桥的保留条件也已收窄：Proxy、参数个数和 getter 顺序没有已确认的产品调用方；summary 进度隔离测试不证明实际并发调用；旧 runtime 只按受支持快照的识别、迁移或安全结算评估。其余 Coding 源码复核和完整来源检查仍按 F1 至 F6 推进。

两项独立复核已完成，没有确认新的 pristine Pi 1.5.0 SDK 完整替代项；这不足以将所有剩余源码归入必要例外。已修正具体的 RpcClient 缺陷：本包没有 CLI 启动器，调用方须提供 cliPath，缺省时在创建子进程前拒绝；原“搜索 dist/cli.js”注释与实现不一致也已修正。显式入口及 JSONL 请求、错误、停止的本地进程夹具在 Bun/Node 各通过 4 项，声明、定向来源复现及六项生成保护用例通过。三种程序化模式和 CLI helper 的已确认排除项现已落实；其余辅助范围继续按实际用途核对，发布 API 与仓内补丁 helper 分开记账。

args 模块的启动器残留也已收窄：删除无剩余调用、未从公开根导出的 `printHelp`、`normalizeSessionName` 及三个专用导入。`parseArgs` 和模型解析的 thinking 校验继续保留；71 项 helper、模型及插件回归、参数和后缀实际检查、声明构建与固定来源单文件复现通过，来源清单已同步。此项不计作官方 SDK 替代；三种模式的后续限定排除已实施，剩余辅助边界和 F1 至 F6 的完整验收尚未关闭。

主题切片已核实全部 56 项名称、49 项前景、7 项背景和 5 项 fallback，保留公开 Theme、vars、schema 与 HTML 契约。资源加载入口现直接使用既有 validator，修复没有 CLI 安装接点时接受不完整主题的问题。无调用的终端回报状态及求解器已删除，system-theme 由 655 行收窄到 123 行，indexed 配色、dim、COLORFGBG 和自定义主题保持。完整生成另确认 renderer barrel 不在闭包且无公开调用，现删除并增加残留源码检查。83 项定向回归、声明构建、声明消费者、26 项 worker bundle 测试、完整运行时 check 和固定 Craft 审计通过；全仓检查和最终独立验收结果见验证记录。这些主题和宿主清理不计为 SDK 新增覆盖。

以下至“产品模式与资源策略”之前的对照是既有实现摘要，详细时点和结果见[验证记录](coding-validation.md)。其中通过补丁共享的算法不等于原包公开能力，辅助替换和第三方库结果不代替本次执行主链验收。

Native 子进程等待也已共用 durable，只保留退出码和无写盘回调的薄适配。替换前后真实入口均通过 18 项、142 个断言，七文件组合通过 128 项、898 个断言；单文件来源复现和 5 个类型根检查通过。24 文件补丁在干净重放和独立缓存冻结安装后逐字节一致，Bun 与 Node 消费者各通过 21 项、155 个断言。进程启动保留既有跨平台策略，完整 SDK、真实 Windows 和产品入口仍在未验证范围内。

Native shell 也已共享 Bash 传参和进程树清理，外层保留同步查找及 macOS 停止策略。替换前后各通过 18 项、34 个断言；八文件组合通过 146 项、932 个断言，10 个明确类型根无诊断。全新缓存的离线冻结消费者核对 24 个补丁文件及 9 份源码、测试和元数据，Bun 与 Node 各通过相同测试正文的 18 项、34 个断言。信号与 Windows 命令均由替身截获，实际平台行为和完整 SDK 仍未验证。

早期 Native 同步与异步读取路径曾共用 durable 候选生成器，保留原有顺序和重复探测；durable 默认入口仍全量生成并去重。替换前后各通过 20 项、74 个断言，24 组内核旧结果及 5 组真实文件对照一致，7 个明确类型根无诊断。九文件组合通过 166 项、1006 个断言；独立缓存冻结消费者核对 28 个补丁文件、12 份 Native 文件和 46 份运行时源文件，Bun 与 Node 各通过 38 项、108 个断言。完整 SDK 和产品入口仍未验证。

早期 ZIP 切片将文件记录和目录交给独立 `fflate` 包，压缩与 CRC 继续用 Node 标准库。工具 ZIP 解包已交给 `JSZip`，外层只保留目录、普通文件和错误适配。写入端的重复条目及最大经典条目数通过标准读取器核对；解包端按 JSZip 的规范化规则保留最后同名条目，只检查保留条目的路径及类型。Native 安装源码在显式宿主中验证 DEFLATE、查找优先级、安装和失败清理。定向生成及最小依赖安装已通过，真实 Windows 发布包及全仓安装未通过完整验证。访问边界偏差见[跟进清单](coding-follow-up.md)，该批当时保持 F1/F3 和完整验收开放。AgentSession 切片现已用 Coding SDK writer 替代本地 writer，移除 fflate 直接依赖，安全的 JSZip 解包适配保留；本次结果以文首及现行跟进状态为准。

store 适配的 journal 前置已完成：重复 flush 按事务草稿中的 nonce 跳过同阶段已准备的前缀，保留回滚重试和真正并发 replace 的拒绝语义。Native codemode 现已接入该事务边界，真实 journal 验证 store 条目与 `run.result` 同批提交，存储拒绝时均不发布。普通 callback 的外部副作用仍不属于 durable 事务。

当前依赖补丁具备 store、沙箱租约、输出策略、发现覆盖、异步准备、调用观察和结果投影接点。Native 与官方两种父 owner 的用量检查、真实 Native 工具任务的参数修改、拒绝及结果 hooks 已通过。同一 owner 的中断重跑覆盖完成回执、旧拒绝及工具别名变化，不等于进程崩溃恢复验收。EXIF 元数据、像素转置、编码缩小循环及 MIME 头部检测也已共用 durable，保留 Native Photon 对象、元数据规则和尺寸、质量及结果策略，以及未识别时的 `null` 和 4100 字节文件读取窗口。131 个方向样本与旧入口一致，Native 和原包默认工厂各有 17 组旧结果基线；同步 PNG 核心经 14 组薄包装对照后保留公开 Photon 调用，终端注册与发布布局仍未验证。该图像阶段的两种离线 frozen install 核对 22 个补丁文件，各通过 84 项测试、648 个断言；补丁首行的完整正文摘要用于更新旧 Bun 缓存，回归检查约束摘要一致。完整产品及插件加载检查仍受限。

ANSI 标准匹配现已引用无传递依赖的 `ansi-regex@6.2.2`，仅补齐私有 CSI，原生流式策略保留原文。独立冻结消费者保留新旧两版依赖，Bun 和 Node 各通过 30 项、183 个断言，最新 ANSI 与图像组合通过 107 项、743 个断言。完整终端入口未运行，具体证据见验证记录。

当前已引用 core 的公开协议类型和 `streamProxy`，移除对应生成副本；消息声明合并保留在公开 core 模块上。宿主压缩窗口通过公开设置方法的外部包装实现，原生 `SettingsManager` 不再带宿主阈值补丁。包管理、消息、模型、设置、会话、runner、token 及资源算法已共用实现，七份旧接口策略单独维护，生成器只生成转发。可选目录、投影和 runner 依赖参数保留原生默认值；结构类型与旧 JavaScript 宽边界由严格消费者回归覆盖。28 份文件直接使用公开 core 类型，内部执行导入改写由 31 份收敛为 3 份。公开 `AgentSessionConfig.agent` 已支持外部 Agent 注入，原先将工厂限制推广为整个 SDK 限制的判断有误。用户已允许完整 Coding 包的公开 SDK 生产依赖，F1/F3 按真实删除与接线重新验收，AgentSession 新接线的定向恢复已验证，剩余替换继续推进。F4/F5 的早期完整生成、来源审计、CI、产品构建及分批回归已在 `8b1c98f` 完成，不替代新接线验证。下列及此前各批次的未验证范围保留为当时记录，最新数量、收益和证据见验证记录。

现有包名 `@mkagent/pi-durable-coding`、插件导入标识和持久化任务身份用于兼容现有调用与数据。不得仅为命名而改写；实现替换确需改变任务时，提供明确版本和迁移路径，不能静默丢弃旧 checkpoint。

## 产品模式与资源策略

普通模式和 coding 模式保留既有产品差异，包括工具可见性、宿主提示词和权限规则。是否采用相同的内部任务类型，由职责和维护成本决定，不能用条件分支数量判断是否满足目标。

产品主体以 durable coding agent 为底座，Coding 层和宿主层按职责装配。AgentSession、内部任务类型和原生投影的适用范围属于实现选择，应由具体能力、插件契约和产品行为决定；普通 profile 使用 GenerationTask 本身不是缺陷证据。

运行时集成与资源加载策略必须分开。普通会话原有的 Pi 资源隔离继续有效，不能因为接入新运行时就自动读取环境中的 Pi 设置、扩展、skills 或 SYSTEM 文件。Coding 资源按显式配置和宿主信任加载，项目文件不能自行授予执行权限。

宿主模型、凭据、压缩设置和系统提示词继续生效。原生设置合成不得覆盖 MkAgent 已有的权限边界或把不同 profile 的配置混在一起。

## MkAgent 功能保留清单

| 范围 | 必须保留的行为 | 验收入口 |
|---|---|---|
| 会话与流式交互 | 创建、继续、队列、steer、follow-up、重试、取消、完成边界、错误显示 | Kernel 与宿主事件队列集成测试 |
| 历史与持久化 | 恢复、分支、fork、消息和文件引用、用量、原始 submission 身份 | SQLite/JSONL 恢复、分支和文件传输测试 |
| 模型与凭据 | Provider、目录更新、自定义端点、模型切换、thinking、凭据刷新、临时模型查询 | 模型与协议子进程测试 |
| 权限与工具 | Allow、deny、修改参数、代理和会话工具、动态目录、嵌套调用、进度和取消 | 宿主审批与工具集成测试 |
| MCP 与浏览器 | 现有连接和工具、codemode、tool search、敏感输入处理、断开和重载 | MCP、浏览器脱敏及默认 profile 回归 |
| 后台工作 | 后台 shell、任务状态、取消、完成通知和关联会话 | 后台任务与宿主协议测试 |
| 上下文 | 宿主提示词、instructions、skills、压缩阈值、缓存与用量一致性 | 上下文、压缩、prompt 和 profile 隔离测试 |
| 产品入口 | Desktop、WebUI、CLI、headless 的会话交互及必要资源 | 隔离产品流程、协议、构建和打包检查 |

这份表用于组织验证，不删减现有产品功能。仓库完整测试清单和既有功能文档继续作为回归范围。

## Pi 能力与插件验收

能力总表见 [能力规格](coding-capabilities-spec.md)。逐项记录四种状态：已实现且验证、已实现待验证、待实现、外部环境受阻。缺失实现不能写成平台测试缺失，暂时不支持也不能自动成为验收豁免。

| API 组 | 完成条件 |
|---|---|
| 资源与输入 | Instructions、SYSTEM/APPEND、skills、prompt templates、包资源和命令展开遵循固定上游语义及宿主信任策略。 |
| 工具与事件 | 不修改插件源码即可注册和实际调用，schema、结构化结果、嵌套、顺序、审批、进度、取消和错误语义正确。 |
| 上下文与状态 | Context transform、自定义消息、entries、labels、分支状态和恢复在 durable 提交边界保持一致。 |
| 模型 | Provider、virtual model、选择、thinking、凭据和 reload/reopen 持续可用。 |
| 会话操作 | 插件的会话新建、fork、tree/navigation、switch 等操作由产品会话所有者正确执行；不以空实现或假成功替代。 |
| 插件交互 | 命令、输入、编辑器和 UI API 对接实际宿主能力。依赖终端组件的插件单独记录执行环境和行为验证，不将源码存在计为产品兼容。 |
| MCP 与授权 | 保留现有 MkAgent MCP，同时接通原生项目资源所需的宿主信任和交互授权路径；用本地替身验证，不使用真实账户。 |
| 文件与输出 | 实际读取、编辑、shell、图片、长输出、HTML 导出和打包资源可用，保持宿主审批。 |

兼容基线为固定 Pi v1.5.0。跨版本插件接口必须有明确映射和对应行为证据，不能推断所有历史插件均兼容。

## 按顺序执行的修正项

本次按[纠偏跟进](coding-follow-up.md)的 F0 至 F6 执行：文档校正、能力与主链核对、官方 SDK 接入、必要适配收窄、行为验证、来源同步和最终验收。执行主链及 Coding 边界先于辅助函数、第三方资源和版本整理。

| 当前步骤 | 交付与通过条件 |
|---|---|
| 文档先行 | 所有相关文档统一背景、官方 SDK 顺序和职责；区分需求、当前实现与历史证据，完成链接、一致性、标点及独立复核 |
| 官方主链接入 | 先对照原始 MkAgent/Coding 接入边界，再核对未修改发布包的 GenerationTask、ToolTask、hooks、事务、输入与恢复，尝试将其接到保留的 Pi Coding 层；必要差异须有证据 |
| Coding 与源码边界 | 优先引用可复用 SDK，按产品和公开插件契约核对剩余资源、会话、工具、UI 组件及导出；原版 CLI 和完整闭包不默认全留或全删 |
| 升级维护 | 对合计的源码副本、生成转换与补丁记录缺口、退出条件、受影响接口及 Coding/durable 升级检查；常规升级不以逐文件改造完整 Coding 闭包为路径 |
| 数据兼容 | 明确 `pi.coding.{session,run,call,tool,summary}` 五种 v1 与历史 generation/tool checkpoint 的兼容及迁移，保护输入和分支身份；summary 的已完成响应、不确定请求禁止重发与取消一并验证。 |
| 测试和实现同步 | 真实文件、shell、权限、插件和恢复验证；调整固化私有实现的断言，同时保留全部已确认行为保证 |
| 最终验收 | 按影响完成仓库检查、独立消费者和产物验证，来源/补丁/文档与实际代码一致，剩余项和升级工作清楚可核对 |

每项先记录需求和通过条件，再修改并运行相应验证。缺口证据不足时继续核查，不以重复测试代替功能推进。下表及其后的 D0 至 D6 是历史工作顺序和分批证据，不能覆盖本次计划，也不要求重新实施已经满足契约的功能。

| 编号 | 修正项 | 具体工作与通过条件 | 当前状态 |
|---|---|---|---|
| D0 | 校正文档与目标 | 统一名称，允许按需引用 core，明确产品保留范围、执行职责和验收账本；历史规格注明适用范围。 | 历史文档批次已完成；本次校准及查漏补缺为 F1 前置步骤，F6 负责实施后的最终同步 |
| D1 | 运行时与资源策略 | 解耦 AgentSession 接入和资源加载，确认普通与 coding profile 均通过运行时契约；保留普通模式资源隔离、提示词、工具与压缩设置，并覆盖既有会话恢复。 | 既有接入和资源隔离已有完成证据；当前装配核对见 F1 |
| D2 | MkAgent 主链路 | 按保留清单检查模型、审批、代理/会话工具、MCP、浏览器、后台任务、持久化、分支和传输；修复发现的缺口，运行相关产品集成和完整仓库回归。 | 已有回归证据；后续实际改动按 F4 验证 |
| D3 | 插件会话与交互 | 补齐由产品会话所有者执行的原生会话操作和插件交互适配；每个 API 组用未修改插件驱动实际效果，检查 reload、取消和恢复。 | 已有主要实现及证据；架构改动影响按 F4 验证 |
| D4 | 原生资源与授权 | 补齐项目资源的信任入口、MCP 交互授权和显式包管理路径；继续保持禁止隐式安装及未授权项目执行。 | 主要路径已有证据；架构改动影响按 F4 验证 |
| D5 | 打包与产品验收 | 检查独立包消费者、来源、许可、资源和产物搬迁，在隔离环境运行实际产品入口；区分构建通过、功能通过和平台受阻。 | macOS 构建、协议、选定 WebUI 与 Desktop、未签名 .app/ZIP 和隔离 ad-hoc 原生副本完成；正式签名公证安装、系统协议和其他平台待验收 |
| D6 | 最终需求对照 | 将本文、能力总表、实现、测试与未解决项逐条对应；全部必需项有结果后才声明完成，记录最终本地提交。 | 2026-11-09 已重新打开 F0 至 F6。完成 SDK 主链替换、源码删除、必要验证及独立复核后再验收；原子提交及统一推送按用户授权执行 |

D1 的已知风险是把原生会话开关直接设为始终启用：它会连带加载普通会话以前隔离的 Pi 资源。现有 `kernel.e2e.test.ts` 的默认 profile 隔离用例是保留契约，不能通过改掉该预期来消除失败。

D2 的最小入口包括 `pi-conversation-flow.integration.test.ts`、`pi-permission-sync.test.ts`、`session-branching.test.ts` 和 `session-file-transport.test.ts`，并结合 `scripts/run-tests.ts` 的完整测试发现及隔离规则。实际运行时使用仓库绝对路径和隔离环境。

## 历史执行账本

本节至“验证与完成规则”前的 D0 至 D6、可视验收和平台记录均保留原时点。历史“当前”“本轮”“下一步”和“待完成”不表示本次纠偏的状态；现行任务见上文和 F0 至 F6。历史检查中的“40 份公开 fixture”实际是 `UPSTREAM.json` 的 34 项辅助/兼容源码和 6 项原样测试夹具，并非 40 个测试夹具。

早期公开包复用、设置策略外移和插件兼容检查如下：

| 项目 | 实现与证据 |
|---|---|
| 公开包和宿主策略 | core 类型及代理改为公开引用；宿主设置包装覆盖原生文件和 profile 两条路径。真实 host 的压缩窗口、模型切换、reload 和不持久化策略，连同资源用例为 18 项、163 个断言通过；durable Agent 和原生任务另有 16 项、75 个断言通过。 |
| 插件元数据 | 两个实际加载入口先复现 Bun 元数据取到 Jiti data URL；公开 transform 参数向 Babel 插件传入源文件名，并隔离不含插件配置的旧磁盘缓存。8 项、24 个断言通过，覆盖中文嵌套模块、相邻资源、计算与可选属性、重复加载及宿主或插件设置的堆栈格式函数。 |
| 本轮完整回归范围 | coding 与 worker 合跑在 300 秒处终止，日志为 829 项通过、0 失败。扣除最后一个未完成文件已通过的 9 项，前 73 份文件为 820 项；补跑该文件及后续 10 份文件，151 项、974 个断言通过，共覆盖 84 份文件、971 项。合跑本身不算成功命令，本轮未运行全仓测试。 |
| 原版及产品检查 | 固定原版的 17 个行为场景全部通过，未修改插件参考契约为 28 次 UI 效果、4 次本地回复并回到 idle。实际产品插件为 1 项、65 个断言，coding/default 流程为 1 项、43 个断言，默认对话为 4 项、22 个断言，均通过；当前 worker 构建通过。 |
| 必需检查与复核 | `validate:ci` 通过，包含全仓类型检查。Lint 首次因未设置隔离 Craft 参考路径而退出，指定既有固定镜像后通过，0 错误、107 项既有警告。中英文标点和 diff 检查通过。独立只读复核未发现高置信问题，但未取得完整 Git diff 或执行测试；主线程补审生产补丁并完成上述验证。 |
| 来源核对边界 | 辅助层生成及 `--check` 已通过。运行时清单移除两项公开包替代记录，按获准文件核对 messages 和 settings 的产物哈希并更新依赖；Craft 来源登记同步本轮改动及新增、删除文件。未读取受限凭据源码，因此本轮不运行完整运行时生成检查及会读取该文件的全量 Craft 审计，不将局部哈希核对写成完整复现。 |

| 项目 | 实现与证据 |
|---|---|
| D0 | 文档基线已提交为 `f7a33eb`，当前四份能力及计划文档的标点检查、diff 检查通过。历史规格新增适用范围说明。 |
| D1 资源策略 | `HostResourceOptions.resourcePolicy` 与协议支持 `native`、`host-only`。后者隔离自动发现的 Pi 设置、扩展、skills、prompts、themes、context 和 SYSTEM 文件，保留宿主显式资源及设置存储端口。普通模式继续使用现有 durable GenerationTask，不因任务类型不同判为架构缺陷。 |
| D1 行为检查 | 新用例先复现环境扩展被执行，修正后资源测试 9 项通过。原生宿主集成用例通过，覆盖未修改的 hello 插件、宿主审批修改参数和关闭后恢复工具历史。 |
| D1 完整检查 | 文档基线 `f7a33eb` 后的 D1 工作树：coding/server 回归 771 项通过、0 失败，`validate:ci` 通过。Lint 为 0 错误、106 警告。隔离 Craft 审计和固定上游生成检查通过，仍为 249 份源码和 9 项资源。 |
| D2 首轮回归 | 主批次 387 份测试文件中，4718 项通过、11 项跳过、13 项失败，并有 1 项加载错误，退出状态为 1。主批次失败，后续串行和隔离阶段尚未运行。失败涉及配置夹具和插件转译后的 RPC 初始化；后续检查另发现后台预热用量缺口。 |
| D2 配置与插件 | 配置夹具改为使用生产代码的 `CONFIG_FILE`，20 项通过。Jiti 首次 Babel 转译会安装全局栈处理器；同步预初始化绕过磁盘缓存，并恢复 Bun 的宿主格式函数及栈深度。两套加载器的 6 项隔离回归覆盖已有转译缓存、宿主格式函数和插件主动修改；连同原有插件及产品 RPC 用例，共 20 项通过。Coding 与 host 类型检查、两套固定源码生成检查通过。 |
| D2 后台预热 | 已复现定时器继承结束的 journal phase 后，用量写入失败且错误被吞掉。当前工作树把后台请求放入独立 phase，收到 durable 提交回执后才发布实际提交的 entry 并安排下次预热。新增 7 项用例覆盖存储可见性、等待和关闭期间提交失败、前台模型运行与预热提交交错、提交前状态、取消网络请求及 append 失败；其中 5 项先失败后通过。连同原有 3 项用量和压缩用例，共 10 项通过。其他可读原生模块的定时器用于超时、进程、输出或界面刷新，没有发现额外 journal 写入；凭据模块按既定访问限制未读取。 |
| D2 第二轮回归 | 主批次 389 份文件中，4745 项通过、11 项跳过、0 失败；后续真实 Pi 子进程用例因宿主系统提示词丢失而失败，完整命令退出 1，剩余隔离阶段未执行。该轮的 `validate:ci` 通过，lint 为 0 错误、106 警告；这些结果只证明当时工作树。 |
| D2 宿主提示词 | 产品协议在打开会话后发送系统提示词，原生 `AgentSession` 却缓存启动时提示词。两种资源策略的新增用例均先失败，固定来源转换在 `before_agent_start` 前重新构建当前提示词后均通过，覆盖首次延后设置、后续替换、清空、原生 SYSTEM 隔离和工具保留。连同原有宿主用例为 8 项通过。重新构建子进程产物后，真实产品用例 1 项、38 个断言通过，包含 coding 工具、fork、导入、后台交接和重启。全部 18 份串行与隔离文件随后通过。真实产品用例现会先构建当前子进程，避免旧 dist 掩盖源码状态或干净 CI 缺少产物。 |
| D2 最终回归 | 隔离环境运行 `bun run test`，退出 0。主批次 390 份文件为 4747 项通过、11 项跳过、0 失败；18 份串行与隔离文件再通过 231 项，合计 4978 项通过。最新 `validate:ci`、lint、两套上游生成检查及隔离 Craft 来源审计通过，lint 保留 106 项警告。产品回归夹具加入构建前置步骤后，server-core 类型检查和真实子进程用例另行通过。 |
| D2 独立复核 | 源码审查与准确暂存 diff 均已覆盖 19 个文件，未发现 D2 新增的高置信度缺陷。固定上游的取消或错误预热响应可能丢弃已返回用量，属于既有行为；本轮成功预热的提交回执与生命周期修复没有改变该分支，后续不能据此声称全部预热失败用量都已覆盖。 |
| D2 提交 | 本地提交 `bb84aa5` 保存上述实现、回归和来源记录，提交后工作树干净。 |
| D3.1 传输抽取 | `6a437ef` 中的 `PiWorkerConnection` 接管进程 I/O，绑定按产品 session ID 和 generation 校验；初次绑定保留既有无标记协议，转交后拒绝无法确认归属的消息。真实本地进程用例覆盖同 PID 绑定切换、旧 lease、迟到包和伪造归属。Pi 客户端 13 份文件共 161 项通过，另有默认对话 4 项、真实 coding 产品流程 1 项通过。Shared 类型、lint 和来源审计通过，lint 仍为 106 项警告。当时尚未接通产品层 adoption、后台归属保留和会话操作握手，D3.1 与 D3 继续进行。 |
| D3.1 归属与后台 | JSONL 命令和响应携带产品 ID 与 generation；每次调用捕获归属，kernel 事件和后台完成事件保留创建时的归属。后台注册表校验停止调用者，重绑后的旧 lease 仅能停止已登记任务，并接收其完成通知和待决停止回复；前台旧包、未知任务及无匹配请求的回复不进入目标会话。终态与超时清理登记，物理进程退出通知前台及仍有后台任务的所有者。产品 owner adoption 和插件会话替换握手仍未接通。 |
| D3.1 归属验收 | 2 项登记表和 2 项连接保留用例先失败后通过。登记表共 3 项、连接共 5 项通过；真实 worker 协议在普通与 coding 模式共 4 项通过，包含两个会话的模型请求及历史隔离、旧前台拒绝，以及真实 shell 在前台重新初始化后仍运行、目标停止失败、源停止成功、完成通知归源、目标继续对话。Pi 客户端 13 份文件共 164 项通过。服务端首轮在 180 秒终止时已通过 397 项；完整重跑 41 份文件、606 项通过、0 失败，随后新增的双模式协议用例 4 项通过。重新构建 worker 后，默认产品集成 4 项、coding 产品流程 1 项及 38 个断言通过。Server 与 Shared 类型检查通过；lint 为 0 错误、106 项警告。 |
| D3.1 复核修正 | 11 份文件的源码复核发现：旧 scope 的排队压缩被跳过时没有释放登记，目标复用同一 ID 会被误判为重复请求。两个模式的真实 worker 均先复现无回复及重复 ID 诊断；按控制器身份清理后，协议用例共 6 项通过。另有原有重新初始化与压缩取消用例 6 项通过，Server 类型检查通过。压缩的正常完成、拒绝和排队跳过三个出口均保留控制器身份检查，避免清除后来的同 ID 请求。前述 606 项全目录回归对应本次修正前的工作树，修正后执行上述相关用例。 |
| D3.2 原生 UI | 固定上游 RPC request/response 类型生成独立叶子文件，shared 通过正式工作区依赖引用公开类型。worker 为每次原生会话建立 UI epoch，校验 dialog、响应类型和选项；保留空串、false 与取消的区别。响应和 availability 绕过初始化等待，startup hook 可交互。停止、reload、关闭释放待决交互；暂停时仍可发布状态、widget 和标题清理，已关闭 binding 拒绝迟到更新。 |
| D3.2 产品与 renderer | SessionManager 按产品会话、真实 client ID、订阅 lease 和 UI epoch 管理交互，等待 worker 接受回执。工作区切换、断连及初始化期间迟到的 attach 均撤销旧订阅。两端共用 renderer 接通弹窗、通知、状态、文本 widget、显示标题和草稿；工具审批优先，保留尚未提交的插件输入。标题不写入持久名称，文本更新保留附件，草稿加载按字段合并并保留清空操作。 |
| D3.2 输入与完成 | 原生命令、input hook、skill 和 template 使用原始输入，模型消息继续携带宿主前缀。本地命令不消费 branch/handoff 上下文，插件触发模型的回合等待真实完成。`prompt_result` 和错误回执匹配输入 ID；错误释放完成等待并保留下一回合的宿主上下文。 |
| D3.2 回归修正 | 真实 PiAgent 复现启动 UI 停止后仍执行原命令或请求模型，独立 turn epoch 阻止迟到发送；测试用额外 worker 往返检查实际副作用。另有取消后的状态清理、工作区旧订阅、延迟 attach 及 renderer 移除会话后仍发送草稿事件，均保留先失败后通过的用例。浏览器探针还复现并修正组合输入期间 Escape 误取消弹窗。 |
| D3.2 二次复核 | 真实 FreeFormInput 与 ActionRegistry 组件夹具复现旧 debounce 覆盖插件草稿，以及 Tab 被区域导航截获。外部替换现在同步取消旧 timer，并通过按会话筛选的 restore 事件处理等值空文本；表单接入 dialog 范围。另复现 Shift+Tab 修改权限模式，快捷键现在排除打开的 dialog。两种草稿替换、后续正常输入，以及 select、input、editor 的正反向 Tab 顺序均通过浏览器检查；快捷键用例先为 1 项通过、1 项失败，修正后连同既有 context 用例共 5 项通过。末轮只读复核未发现新增高置信度缺陷。 |
| D3.2 定向证据 | 原生 kernel UI 18 项、79 个断言通过；真实 PiAgent 10 项、88 个断言通过；UI owner 与工作区 handler 9 项、41 个断言通过；renderer 租约和草稿 18 项、41 个断言通过。真实 WebSocket、产品 owner、客户端 bridge、PiAgent 与原生 worker 联调用例 2 项、15 个断言通过。浏览器组件夹具覆盖多行编辑、审批期间保留输入、空输入与空选项、取消、停止、组合输入 Escape、上下 widget 位置和上述键盘修正；完整 Desktop/WebUI 应用中的可视流程仍待 D3.6 验收。 |
| D3.2 全仓与产物 | `bun run test` 退出状态为 0：主批次 399 份文件、4811 项通过、11 项跳过，20 份串行及隔离用例另有 243 项通过，共 5054 项通过、0 失败。`validate:ci` 通过；lint 为 0 错误、107 项警告，renderer 来源检查为 320 份规范化一致、138 份 override、458 份文件。固定上游生成检查为 250 份源码和 9 项资源；屏蔽 coding 生成声明后，shared 类型检查为 0 diagnostics，仅引入 RPC UI 叶子类型。隔离 Craft 来源审计通过。macOS arm64 headless 包构建、许可及资源检查、启动器、随机端口 health 和认证 WebSocket 握手通过；Vite 仍报告较大的 chunk。 |
| D3.2 产品 factory | 完整回归后，另在实际 SessionManager 产品用例中补入 backend factory 断言。隔离 HOME 的原生用户插件在 startup 和本地命令中交互，确认 `hasUI`、宿主工具、空文本及 false 回复，处理状态正常结束，模型请求为 0；扩展后的产品文件共 1 项、43 个断言通过，server-core 类型检查通过。该测试不替代 D4 的项目资源信任接线。D3.2 实现与复核完成，D3.3 至 D3.6 及 D3 整体验收尚未完成。 |
| D3.3 持久化前置 | 写入队列新增 `persist(snapshot)`，与普通保存共用按会话串行的 writer，严格回执在文件替换成功后返回，失败则拒绝。替换不再先删除旧文件，失败时恢复元数据签名。普通 `flush` 保留原有容错行为，不能作为会话转交的持久化确认。产品 `createSession` 等待最终记录的严格回执，失败时清理 runtime、UI owner 和新建记录，不发送成功事件。 |
| D3.3 前置验证 | rename 失败丢失旧记录、产品创建错误返回成功两个用例均先失败后通过。独立复核发现快照提前入队后，取消不能阻止尚未开始的保存；确定性用例先复现已删除会话被重建，修正后普通保存跳过取消操作，严格回执明确拒绝，后续新保存仍可完成。两套既有队列测试及新增隔离用例共 17 项、46 个断言通过；产品创建隔离用例 1 项、8 个断言通过；既有创建、分支、交接和消息确认用例 13 项通过。shared、server-core 类型检查通过，shared lint 为 0 错误、2 项既有警告。发起客户端归属、产品会话替换握手及 D3.3 整体验收尚未完成。 |
| D3.3 前置复核 | 修正后的队列与产品创建路径经独立静态复核，未发现新增高置信度缺陷。扩大相关回归至 42 份文件，992 项通过、11 项跳过、0 失败，新增隔离用例另有 9 项通过；隔离 Craft 来源审计为 2050 份文件，通过。全仓回归在约 107 秒时收到 SIGTERM，未产生最终汇总，不能沿用 D3.2 的结果声称本轮全仓通过。已初始化分支的写入失败回滚尚未动态验证；同步 `writeSessionJsonl` 仍有先删除再替换的既有写法，检索仅发现测试调用，本轮未改动。 |
| D3.3 输入归属前置 | `abf4714` 保存持久化前置修正。随后工作树将产品消息 ID 传入 chat、redirect 和 worker 独立的 `inputId`，每次 prompt 保持不同 RPC ID。真实重复产品 ID 用例曾复现相关 ID 重用，分离后原生 PiAgent 联调 11 项、97 个断言通过。产品 owner 保留真实 RPC caller，重放不重新登记；完成后清除普通归属，可释放租约允许事务跨源收尾，断连、工作区变更、取消、删除及 cleanup 仍使对应租约失效。已完成输入未清除也经实际队列用例先复现。归属尚未用于产品会话替换，握手及定向导航仍待实现与验收。 |
| D3.3 输入复核 | 独立静态复核覆盖 11 个实现及测试文件，发现空闲源的 Stop 提前返回，未撤销跨收尾租约；真实队列用例先复现，撤销移到 processing 判断前后通过，复核确认 P2 修正且未发现其他新增高置信度问题。末轮定向用例 18 项、81 个断言通过；扩大产品与 RPC 回归为 144 项、418 个断言通过，共享 agent 为 571 项、1394 个断言通过。输入接线期间实际 coding factory 为 1 项、43 个断言通过；末轮 `validate:ci` 通过，shared lint 为 0 错误、2 项既有警告。隔离 Craft 来源审计包含新增归属模块及测试，共 2052 份文件，通过。本轮未重跑完整 `bun run test`。独立 reviewer 仅做源码静态复核，没有独立读取 git diff 或运行测试；上述执行证据来自主代理。 |
| D3.3 NEW 握手 | 本地提交 `f88f857` 保存 NEW 转交前置，接通真实 SessionManager、PiAgent 和 worker 的 prepare、源关闭、目标激活、绑定、提交及完成握手。原命令协程保留 setup 与 withSession 闭包，提交前不运行目标 startup 或回调。目标取得独立发布回执后可脱离源存活；源可另起 worker，再次转交或删除，旧目标仍可运行。fork、switch 和带 parentSession 的 new 仍在源关闭前明确拒绝，依赖 D3.4 的稳定路径和锚点，D3.3 尚未整体完成。 |
| D3.3 运行中隔离 | 加载中的 release 等待 kernel 与 MCP 清理后确认；callback listener 捕获每次 owner 的 scope，撤销时销毁旧 socket，并在请求体、附件、查询及响应边界检查归属。旧 startup 失败不能清理新连接，源后台任务继续按旧 lease 路由。延迟 Request 的合成错误曾写入新 owner，隔离用例先失败后通过；补充无源目录场景后，实际子进程内 15 个断言通过，父进程另校验退出状态。 |
| D3.3 产品证据 | 真实产品链首次为 1 项、37 个断言通过，覆盖同 PID 转交、源另起 worker、定向 caller 导航、setup 和 withSession、目标续谈、实际目标 HTTP 回调、源 Stop、源连续转交、删除源后两个目标继续，以及 startup 发起 NEW。完整回归后又补入同一物理 worker 连续转交两次，扩展夹具为 1 项、47 个断言通过。产品协调与持久化用例 34 项、269 个断言通过。异常收尾原先先发布再保存目标，两种写入故障用例均先失败；修正后正常与异常发布都等待独立回执。测试中空数组比较会忽略 undefined 元素，已实际验证并将发布次数改为长度断言。 |
| D3.3 复核与界限 | worker 的独立静态复核没有发现高置信度缺陷，覆盖加载、释放、MCP、callback 和 activation；未独立取得 git diff 或重跑测试。各加载失败与 release 交错、查询中释放和端口复用仍缺少定向故障证据。Renderer 同步安装目标快照并按当前焦点处理导航。用户授权新建独立浏览器空间后，真实 WebUI 的 NEW 跳转和目标消息显示通过；文件门控延迟期间切到另一面板后，目标完成未抢占焦点，右侧草稿保留，另一客户端仍停留在源会话。完整 Desktop 可视及其他插件交互仍待 D3.6。 |
| D3.3 当前回归 | 首次全仓检查在 240 秒时限终止，无最终结果。增加时限后，主批次 405 份文件为 4876 项通过、11 项跳过、1 项失败，退出 1，后续隔离阶段未运行。失败测试只监视通用 send，漏掉按 lease 发送的 startup 控制；改为读取真实子进程收到的命令后，压缩文件 34 项、101 个断言通过。异常发布修正后的完整 `bun run test` 退出 0：主批次 405 份文件为 4879 项通过、11 项跳过，25 份串行及隔离文件另有 269 项通过，共 5148 项通过、0 失败。`validate:ci`、WebUI 构建及 2065 份文件的隔离 Craft 审计通过；更新 renderer 来源清单后，lint 为 0 错误、107 项警告。固定移植包自 `d5350f4` 未变，当前 git diff 已确认，沿用该提交的 250 份源码、9 项资源生成检查证据。 |
| D3.4 快照前置 | journal 新增 detached committed snapshot、回执订阅与事务内产品消息关联，保存完整树、活动 leaf、名称及 native/durable/product 身份，支持一个产品 ID 关联多个 native entry。阶段内改动、拒绝的写入及抛错的 observer 均不泄露候选状态。首轮三项失败确认首次嵌套关联写在普通对象上；隔离探针验证 durable draft 赋值会复制对象，改为经 draft 字段写入后通过。快照与既有 journal 共 21 项、150 个断言通过；包目录共 180 项、1212 个断言通过，包类型检查通过。该提交仅提供公共快照和关联边界，宿主关联接线、原生文件投影及 fork/switch 当时尚未完成。 |
| D3.4 原生投影 | 已提交快照串行生成固定 JSONL 与 manifest，manifest 最后原子替换；保留完整树、非末尾 leaf、原始 entry ID 和三方关联。proxy 暴露固定路径但不启动 native 文件 writer。用例覆盖 staged 改动不可见、篡改后重建、manifest 替换失败及 child 目录 symlink 拒绝。投影错误不改变 durable receipt，也不重跑回调；产品可信登记见下方前置实现。 |
| D3.4 关闭故障 | 投影故障关闭用例先失败后通过，确认 SDK、listener、journal 和 store 均释放。独立复核另发现 reload 保留已关闭 host，以及恢复任务拒绝后跳过 shutdown hook；两个确定性用例均先失败后通过。当前关闭会排空任务再执行 hook，reload 失败会移除旧 host，后续输入经同一 reload 屏障重开 native host。恢复交错用例使用受控 recovery 边界，没有模拟进程崩溃。 |
| D3.4 输入关联 | worker 的独立 inputId 进入原生普通输入、steer 和 follow-up admission，并与 native entry 在同一次 journal 事务关联；handled 命令不伪造 user entry。独立复核发现 message_end 完整替换会丢身份、provider context 会携带宿主字段；新增断言实际复现后，移植转换保留替换前身份并在统一 LLM 转换边界剥离该字段。真实 worker 夹具验证三种输入、重复文本、插件 transform 和完整替换、重开后关联保持，模型请求仅访问本地替身。两个输入文件共 21 项、152 个断言通过；server 类型及生成声明通过。fork/switch、parentSession、名称同步与 D3.4 整体验收继续进行。 |
| D3.4 投影回归 | 首次 coding/host 全目录检查在 240 秒上限处终止，无最终汇总；延长时限后，64 份文件、848 项测试通过，0 失败。投影前置的 `validate:ci`、lint、固定生成检查和隔离 Craft 来源审计通过；lint 为 0 错误、107 项警告，来源清单覆盖 2070 份文件，并补齐上一笔快照提交的四处清单漏项。这些结果对应投影前置，当时尚未接线的产品登记不在该结论内。投影前置已提交为 `83ef885`。 |
| D3.4 产品登记前置 | 当前 worker 的 committed 投影通过活跃 lease 和 native ready 身份校验后登记，产品仅保存固定身份、规范路径和摘要字段，省略完整 entry 映射。登记与 owner 回执在同一会话串行链内构造快照，严格替换成功后更新内存，普通保存等待已受理的元数据写入。缺失路由及 `flushAllSessions()` 提前返回均有先红后绿证据。登记 4 项、15 个断言，worker/owner 36 项、244 个断言，产品 owner 14 项、154 个断言通过；真实产品 NEW 链路 1 项、57 个断言核对源和目标的磁盘 manifest、摘要、持久化引用及 SDK 身份。会话与共享存储 36 份文件、265 项回归通过。首次 CI 因测试夹具的 version 字段扩大为 number 而未通过，显式标注引用类型后 `validate:ci` 通过；lint 为 0 错误、107 项警告，隔离来源审计覆盖 2072 份文件。独立源码复核未见高置信度缺陷，但未独立核验 Git 或执行测试；主线程复核了完整生产补丁并执行上述检查。后续 fork/switch 仍须验证物理路径、摘要和可信产品登记，当前尚未开放。 |
| D3.4 fork kernel 前置 | 新增独立的完整树分叉路径，普通产品分叉仍按 durable cutoff 截断。在目标副本内追加 durable marker，再从该边界分叉，包含最后一条 native entry 之后的文档回执，也支持没有 entry 的源。journal 在同一事务内分配目标 header、映射文件引用并选择准确 leaf，保留全部原始 entry ID、label、产品关联和非活动分支附件。已提交树加载时跳过 SDK 初始化元数据，避免改变空 root 或元数据 leaf。 |
| D3.4 fork kernel 定向证据 | 新 kernel 文件的 6 项用例先因缺少旧 cutoff anchor 失败，接线后又实际发现 journal 附件路径未映射及 SDK 改变空 root，两处修正后通过。SQLite、JSONL 的完整树、附件、重开、缺失 leaf、非活动分支 symlink 拒绝和冷进程 SIGKILL 恢复共 12 项、156 个断言通过；拒绝路径核对源 store 和原生投影字节不变。journal 的身份、完整树和映射事务回滚用例通过，两个相关包类型检查通过。独立静态复核未发现高置信度问题，没有独立核验 Git 或执行测试；后加的冷进程与拒绝测试由主线程验证。首次既有 kernel 回归在 60 秒限时终止，没有最终汇总；增加时限后，coding 包、新增 fork 文件、既有 coding host 和 kernel 共 21 份文件、363 项、3402 个断言通过，0 失败，耗时约 219 秒。`validate:ci`、lint、固定上游 250 份源码和 9 项资源的生成检查、2075 份文件的隔离来源审计通过；lint 为 0 错误、107 项既有警告。本轮未运行全仓 `bun run test`。产品 owner 接线、可信物理路径验证、switch、parentSession 和名称同步仍待完成，原生 fork/switch 入口继续拒绝。 |
| D3.4 只读来源前置 | 新增产品侧只读解析器，以已登记引用、产品 ID、native ID 和固定路径核对物理目录、文件句柄身份、文件版本、manifest 与 JSONL 摘要。解析完整树、原始 entry ID、前序 parent、durable/product 关联和准确 leaf，保留无名称与显式清空的区别。before 仅接受 user entry，at 按 entry ID 定位，内部支持 null root，不按重复文本猜身份。没有开启 SDK writer，尚未接入生产 owner。 |
| D3.4 只读来源证据 | 新能力的 21 项、33 个断言通过，覆盖只读字节和修改时间、引用不一致、六类目录或文件 symlink、重算摘要后的坏树与映射、截断文件、header、空树及空名称。真实产品 NEW 夹具核对源和目标的实际 worker 投影，显式文件路径运行后为 1 项、65 个断言通过；首次筛选命令没有匹配测试，不计为通过。独立静态复核未发现高置信度缺陷，没有独立核验 Git 或执行测试。宿主仍须取得工作区归属与操作锁、核对忙或删除状态、拒绝重复身份，并在源关闭后复核；上述测试不构成任意并发文件系统攻击的完整证明。产品 fork/switch、parentSession 和名称同步继续实施。 |
| D3.4 只读来源检查 | `validate:ci` 退出 0，包含更新后夹具的 server-core 类型检查。lint 为 0 错误、107 项既有警告，隔离 Craft 来源审计覆盖 2077 份文件，中文标点检查通过。本轮未改动固定上游生成层，沿用 `e964d3b` 的生成检查；未运行全仓 `bun run test`。 |
| D3.4 产品归档前置 | 产品 JSONL 正文与两种 writer 保存活动和归档行；延迟加载后改名保存、文件迁移及 bundle v2 保留归档。DTO 只暴露活动产品行，隐藏原生历史缓存。普通产品分叉保留原 cutoff 行为，清除源树派生缓存。分区器优先精确产品关联，仅以唯一调用和唯一后代结果推导工具归属；消费后的精确关联解除输入的临时源限制。没有增加执行树或从归档恢复队列。 |
| D3.4 产品归档证据 | 共享会话目录 8 份文件、103 项、243 个断言通过；真实产品延迟加载与导入导出为 2 项、15 个断言，包含保留源排队命令且不入队。普通分叉 1 项、12 个断言，owner 恢复 14 项、154 个断言，真实 worker NEW 1 项、65 个断言通过。独立静态复核指出消费后残留源归属；主线程复现后修正。主线程另实际复现普通分叉带入过期缓存，以及多结果、重复调用 ID 和精确关联被推导扩大，均先失败后通过。复核没有独立核验 Git 或执行测试。其他路径重映射处理 legacy/native entry 或完整树，不复制产品定位缓存。 |
| D3.4 产品归档界限 | 当前证据覆盖产品行、普通附件和既有 NEW 转交，没有验证原生执行树的 bundle 迁移。分区器尚未接入生产 owner，不能据此声称产品 native fork/switch 已完成；两者继续拒绝。源关闭后的可信投影与实际复制 journal 的一致性、parentSession 和名称同步仍待后续实现。 |
| D3.4 产品归档检查 | 最终 `validate:ci` 退出 0，lint 为 0 错误、107 项既有警告；隔离 Craft 来源审计覆盖 2080 份文件，中文标点检查通过。固定上游及 kernel 没有改动，当前 diff 已核对，沿用 `e964d3b` 的生成检查。本轮未运行全仓 `bun run test`。 |
| D3.4 关闭后副本前置 | kernel 原生 fork 必须携带关闭后引用，在路径改写、继承任务处理和 Harness 打开前验证复制的 journal。公开读取接口检查完整树、owner、版本、leaf 与 durable 映射可见性，复用投影编码核对身份和摘要。目标已有 durable store 或旧 transcript 时明确拒绝，所有原生 fork 均须经过复制与验证。产品关闭 ACK 接线仍待后续完成。 |
| D3.4 关闭后副本证据 | SQLite、JSONL 的 store 替换和伪造摘要共 4 项用例先失败后通过。独立静态复核指出旧 transcript 目标会绕过验证，主线程另以合法及伪造引用的 4 项用例复现并修正，拒绝时未调用 startup。完整树、连续 fork、错 conversation 标记、伪造来源路径及冷进程恢复共 24 项、268 个断言通过。journal、投影和真实 host 集成共 22 份文件、231 项、1631 个断言通过；另筛选普通 kernel 分叉、旧历史、附件和恢复用例，38 项、360 个断言通过。 |
| D3.4 关闭后副本检查 | 修正旁路后的 `validate:ci` 退出 0，lint 为 0 错误、107 项既有警告，隔离 Craft 来源审计覆盖 2083 份文件。首次服务类型检查误用引用缺失 base 配置的遗留 tsconfig，改用包内 CI typecheck 命令后通过，未修改遗留配置。未改固定上游生成层，沿用 `e964d3b` 的生成检查；本轮未运行全仓 `bun run test`。复核仅静态覆盖，没有独立执行测试或核验 Git；产品 fork/switch 继续拒绝。 |
| D3.4 产品 fork | 已接通 prepare、source closed、target bound 三道严格产品引用校验。产品独立推导并核对 leaf、durable 锚点和 selectedText，关闭后允许合法 shutdown 追加，拒绝改写已准备的历史。激活前归档源产品行，复制完整活动与非活动附件；目标严格保存完整分区和最终名称，再经既有双边提交、独立发布回执与回调授权流程发布。此前“产品 native fork 继续拒绝”是前置阶段的状态，现已完成这一接线。 |
| D3.4 产品 fork 证据 | proof、owner 和 JSONL parser 共 50 项、195 个断言通过；元数据登记文件的 5 项、21 个断言包含严格 IO 期间的新输入和消息更新。真实产品加 bundled worker 在 SQLite、JSONL 上通过 1 项、66 个断言，覆盖完整树、非活动产品附件、shutdown 追加及清空名称、同 PID 回调、连续 fork、删除源和中间目标后冷 worker 续谈。既有 NEW 独立进程用例为 1 项、65 个断言通过。 |
| D3.4 命令完成修正 | 已复现 `agent_end` 早于 `agent_settled` 时，上一轮的 streaming 标志压住纯 handled 命令的完成回执。直接删除判断又会提前结束命令本轮发起的模型，新增断言实际发现该回归。现按原有 action scope 跟踪本轮前台 actions，handled 命令等待它们结束，再独立确认完成，不加入上一轮或后台工作。命令、原样扩展和 worker owner 共 15 项、129 个断言通过，包含受控旧 streaming 标志及模型命令收到本轮 settled 后才完成。该标志用例模拟条件，不声称复现了完整调度交错。 |
| D3.4 检查与限制 | 最终 `validate:ci` 退出 0，隔离 Craft 来源审计覆盖 2088 份文件。Lint 为 0 错误、107 项既有警告；固定上游生成层没有改动。取消、reload 和输入身份另有 21 项、96 个断言通过。本轮没有运行全仓 `bun run test`。首次 CI 因新增 parser 测试的字面量类型被拓宽而失败，补充显式类型后通过。两份 `.isolated.ts` 误放在同一进程时 NEW 用例因配置缓存而失败，按独立进程重跑通过；不将合跑结果算作通过。 |
| D3.4 产品 fork 复核 | 独立静态复核覆盖 fork proof、产品 owner 与 SessionManager 接线，以及本轮 host action scope 和 kernel 完成边界，未发现高置信阻断问题。复核核对了相关测试源码，没有独立运行测试；上述运行结果由主线程取得。 |
| D3.4 fork 阶段边界 | 普通完成事件后投影文件与异步产品登记可以暂时不同步；fork 的三道严格回执单独构成屏障，冷续谈用例不据此声称普通完成已同步登记。独立静态分析另提出 release 与 fork 关闭可能互等，尚无运行复现，本轮记账并停止扩展排查。可信来源仍要求工作区所有者、操作锁与关闭后复核，不声称防住任意目录交换。此行记录 fork 提交时的边界，switch 后续实现见下项。 |
| D3.4 产品 switch | 只预留同工作区内路径和身份唯一、可信且空闲的既有目标。源关闭后才释放目标旧 writer，并等待最终投影的产品保存回执。关闭后核对原树前缀，允许 shutdown 合法追加；恢复 Harness 前核对目标 journal，绑定后再核对完整树、身份、leaf、名称和映射。沿用双边提交、独立发布回执及原协程回调，不新建产品会话。失败或恢复不隐藏、删除既有目标。 |
| D3.4 switch 证据 | proof、owner 和 fork 四份文件共 50 项、197 个断言通过；worker owner 为 18 项、133 个断言。产品 owner 恢复为 16 项、170 个断言，含未提交与已提交的 switch 记录恢复，保留目标及文件且不重放回调。真实产品加 bundled worker 在 SQLite、JSONL 上共 1 项、132 个断言通过，覆盖完整目标历史、名称、同 PID 转交、实际忙碌模型拒绝、激活失败保留旧目标 writer、源重启后再次切换，以及切换目标与 fork 会话分别冷续谈。模型仅访问本地替身。 |
| D3.4 switch 释放修正 | 新测试实际复现 worker 已确认释放后，投影保存拒绝导致旧绑定未清除。清理移入确认释放后的 finally，保存错误仍向调用方传播，后续可重启目标。等待最终回执及失败清理两个用例一红一绿起步，修正后均通过；无关闭新增投影时仍等待该 lease 最后的登记。检索确认该回执只有一处等待路径。 |
| D3.4 switch 检查 | `validate:ci` 退出 0；新增恢复用例的 server-core 类型检查通过。该窄检查首次因隔离脚本固定工作目录而误读根 tsconfig，使用显式 project 路径后通过。Lint 为 0 错误、107 项既有警告，隔离来源审计覆盖 2090 份文件。独立静态复核没有发现高置信阻断问题，未取得逐行 Git diff 或独立运行测试；主线程核对了生产补丁并执行上述验证。固定上游生成层未变，本轮未运行全仓 `bun run test`。 |
| D3.4 switch 后续 | 带 parentSession 的 new、全局名称同步及 D3.5 后续工作继续实施。普通完成后的异步登记界限及未证实的关闭互等问题沿用上方记账，本轮不扩展。 |
| D3.4 parentSession | 已接通带父来源的新建。复用同工作区、路径与身份唯一的可信登记校验，支持当前源或其他已登记会话。目标记录产品父 ID，journal header 保存稳定原生父路径；目标激活明确清除 fork/resume 配置，不复制父 store 或消息。kernel 拒绝已有 store、旧 transcript 及冲突恢复参数，目标绑定要求独立身份、正确父路径和空消息历史。父引用记录 prepare 时刻的来源关系，父历史可以继续演进。 |
| D3.4 parentSession 证据 | 真实产品夹具扩展至 1 项、196 个断言通过。SQLite、JSONL 来源均覆盖当前源及其他已登记父会话，插件 setup 直接检查空历史和父路径，模型上下文不含父消息；两个新目标分别冷 worker 续谈后保持身份与独立历史。未登记的相对路径在源关闭前拒绝，未创建目标且原 worker 保留。跨包类型检查及既有 owner/fork 用例通过。全局名称同步继续实施。 |
| D3.4 parentSession 检查 | `validate:ci` 退出 0；原生命令与握手 9 项、62 个断言，产品协调 owner/fork 26 项、162 个断言通过。Lint 为 0 错误、107 项既有警告，隔离来源审计覆盖 2090 份文件。主线程核对全部生产补丁，未进行独立复核；固定生成层未变，本轮未运行全仓 `bun run test`。 |
| D3.4 名称同步 | 从 committed 完整树派生名称及是否存在 `session_info`，经当前 worker、lease、ready 和 native 身份校验后，与产品引用一起严格保存，再广播 `name_changed`。回执的 `hasName` 不进入 v1 manifest，保持旧摘要兼容；未设置名称保留产品标题，显式清空保存空字符串。旧 revision 不回退，相同 revision 可补齐未同步名称。 |
| D3.4 产品改名 | coding 会话经作用域 RPC 写入同一 journal，保存产品回执后才返回；尚未启动及冷 worker 可打开后改名，不调用模型。元数据操作复用既有 journal phase 与 Harness 提交，可与流式生成并行。会话替换时拒绝改名，待决改名使 switch 目标保持忙碌。自动标题保留插件命名及清空，并将后续原生标题写回 journal。 |
| D3.4 名称证据 | 注册问题先红后绿；注册 8 项、40 个断言及投影 5 项、28 个断言通过，覆盖先保存后广播、失败不更新内存或广播、相同 revision 补齐、显式清空及非活动分支上的全局名称。真实产品双存储夹具为 1 项、224 个断言，通过首次启动前清空、插件命名、产品改名、流式期间改名，以及 journal 已提交而产品保存失败后的冷 worker 补齐；改名不产生模型请求。owner 三份文件共 44 项、295 个断言通过。 |
| D3.4 名称复核修正 | 独立静态复核指出未启动会话仍走旧产品改名，以及自动标题覆盖等待严格保存的手动改名。两个定向用例实际失败后修正：所有 coding 改名均经过 journal，名称意图在受理时递增内存版本，自动标题提交前检查版本；该版本不持久化。复核未独立取得 Git diff 或运行测试，修正与验证由主线程完成。首次标题、手动改名和重新生成标题的相关入口已核对。 |
| D3.4 名称检查 | `validate:ci` 退出 0，末轮 server-core 类型检查通过。Lint 为 0 错误、107 项既有警告，隔离 Craft 来源审计覆盖 2090 份文件，中文标点检查通过。主线程核对生产补丁并修正上述复核问题。固定上游生成层未改动，本轮未运行全仓 `bun run test`。D3.4 已完成，继续 D3.5。 |
| D3.5 摘要前置 | 原生 compaction、branch summary 和 bug report 的模型请求通过 `pi.coding.summary` 执行。task 保存模型身份、摘要上下文、允许的选项及完整响应用量；原模型对象、认证、动态 endpoint 和其他请求选项仅留在当前请求闭包。session 内摘要经当前 runtime 的提交和等待创建所属 child，其他摘要归 conversation。 |
| D3.5 摘要恢复 | 请求前提交 `requesting`，成功或错误响应保存完整用量。SIGKILL 后，执行中的请求及失去当前调用闭包的已受理请求明确中断，不自动请求模型；已提交结果可重读。原生摘要和插件回调的协程不持久化，不能据此声称会自动应用摘要或恢复导航。取消等待实际请求退出；取消期间的用量沿用 D2 已知界限。 |
| D3.5 摘要证据 | 三个真实进程 SIGKILL 用例覆盖已受理、请求中和响应已提交，前两项先复现重复请求后通过。coding 包和真实 host 摘要共 205 项、1315 个断言通过，含动态模型参数、错误用量、取消、生命周期归属，以及真实 compaction 的历史和 turn 前缀两次摘要、bug report、branch summary 和原生 editorText 返回。固定上游生成检查和 coding、host 类型检查通过。产品树导航、活动历史重分区和 D3.5 整体验收尚未完成。 |
| D3.5 摘要复核与检查 | 独立静态复核指出持久化 abort 阻塞时，用户取消不能立即通知模型。确定性用例先失败后通过，当前请求合并原始 signal 和 task signal，保留 durable abort 及等待；检索确认本次新增绑定仅这一处替换 provider signal。复核未运行测试，修正和验证由主线程完成。`validate:ci` 通过，复核修正后 coding 类型与上述 205 项再次通过。Lint 为 0 错误、107 项既有警告，隔离来源审计覆盖 2096 份文件，中文标点通过。本轮未运行全仓 `bun run test`。 |
| D3.5 产品树导航 | 原生导航复用已移植的 before/tree hooks、摘要、label 及 editorText；活动 leaf 与 `treeRevision` 在同一次 journal 事务内提交。投影携带该边界，产品按完整树及原有关联重分区活动和归档消息，严格保存后广播完整会话快照，插件继续执行前等待当前 worker scope 的独立回执。editorText 保留原生消息全文，只作为 API 返回值，不自动改写草稿。 |
| D3.5 产品恢复 | journal 是导航结果的权威。产品保存失败不发成功回执；后续冷 worker 从 committed 投影补齐产品历史，不重放中断的插件回调。已知归档消息的 anchor 和顺序保留，首次归类的未关联产品行依照此前产品 leaf 锚定。fork 清除继承的导航边界，目标通过既有 fork 历史分区初始化。 |
| D3.5 产品证据 | 真实产品 SQLite、JSONL 夹具共 1 项、290 个断言通过，覆盖返回用户消息的 editorText、活动和归档互转、取消、同 leaf、无效目标、摘要、冷续谈、产品保存故障和冷修复；事件断言直接读取已保存文件。coding journal 与投影共 209 项、1334 个断言通过，含导航边界的原子回执、拒绝提交和 JSONL 恢复。完整仓库回归仍留待 D5、D6。 |
| D3.5 产品复核与检查 | 独立静态复核未发现高置信度缺陷，但未取得完整 Git diff，也未独立运行测试；主线程补读本批生产补丁。`validate:ci` 通过，首轮新增夹具的两处隐式参数类型错误已修正；真实 host 摘要另有 1 项、10 个断言通过。Lint 为 0 错误、107 项既有警告，2097 份文件的隔离 Craft 来源审计与中文标点检查通过。固定上游生成层未改动，本轮未运行全仓测试或可视产品流程。D3.5 已完成，继续 D3.6。 |
| D3.6 原样插件基线 | 已固定原样 `rpc-demo`、`confirm-destructive`、`session-name`，新增两端共用的标准会话插件。真实产品 SessionManager 与 bundled worker 通过 1 项、35 个断言，覆盖输入、多行编辑、草稿、危险 shell 拒绝、NEW/fork/switch 的取消与成功、回调、树导航、reload 和冷 worker 后继续命名。模型只访问随机端口上的本地确定性替身，未运行可视浏览器流程。 |
| D3.6 原生参考基线 | 独立 Pi v1.5.0 安装通过相同四个插件的命令与会话操作，记录 28 次 UI 效果，准确消费 4 次本地模型回复并到达 idle。无 UI 的危险工具验证直接调用原生 hook，不计作实际 shell 执行。参考夹具保留自己的模型传输，以免原生 reload 的全局 provider 重置移除测试替身。 |
| D3.6 插件输入投影 | 已先复现插件 `sendUserMessage` 进入 journal 却缺少产品用户行。固定来源转换现在为插件输入生成稳定产品 ID，并在 input hook 变换及图片规范化前保存版本化原文；prompt、steer、follow-up 和恢复队列保留该标记，发送模型前剥离宿主元数据。产品只从可信完整树中的显式标记和精确 journal 关联补行，不用文本推断身份，保留多行原文、图片、活动分支及归档。 |
| D3.6 输入顺序与回执 | 每个投影等待产品严格保存后才写下一个 revision，assistant 开始前等待用户行落盘及广播。失败冻结后续文件覆盖，显式重建或冷 worker 可幂等补齐。替换目标的初始回执延迟至 target bound，避免加载与绑定互等；回执固定使用 kernel 创建时的 owner scope。普通输入沿用已有产品行及 hidden 等属性。 |
| D3.6 输入证据 | 真实产品插件夹具为 1 项、65 个断言通过，覆盖 NEW、fork、switch 回调各一用户行、用户事件早于回复、多行原文与 input hook 变换、重复文本、隐藏产品消息、插件 steer 与 follow-up、纯图和多图，以及 fork 后附件 ID、路径重映射及字节。移除一条产品行但保留同一 reference 后，仅启动冷 worker 即恢复原 ID，模型请求数不变。 |
| D3.6 停止与失败恢复 | 停止曾取消正在等待的已提交历史回执，导致后续插件输入失败；真实产品用例先红后绿，现在停止执行不撤销该保存。投影失败后，内核已关闭却返回未释放，也经既有产品回归复现。关闭回执现在分别表达释放结果与投影错误，产品释放已关闭 lease 并继续向调用方报告错误，未确认释放仍保留绑定。SQLite、JSONL 的产品 fork、switch、名称及树恢复回归为 1 项、381 个断言通过；释放、投影及输入文件用例共 30 项、201 个断言通过。 |
| D3.6 输入恢复界限 | 完全冷的 `getSession()` 不启动 worker，不能据此声称打开会话即补齐；当前证据仅覆盖显式启动 worker。旧记录若没有原始输入标记，不凭空重建未知原文。图片文件检查拒绝符号链接、冲突字节和无效目录，并可重试补回缺失文件；仍依赖可信工作区及操作锁，不声称抵御任意目录交换。并发、故障及可视产品验收继续按 D3.6 补齐。 |
| D3.6 输入检查 | 最终 `validate:ci` 退出 0，coding 包为 205 项、1309 个断言，真实 host 的 hooks、提示词及输入身份为 11 项、114 个断言，产品登记为 9 项、48 个断言，均通过。两套固定上游生成检查通过，运行时仍为 250 份源码和 9 项资源；隔离 Craft 来源审计覆盖 2108 份文件，lint 为 0 错误、107 项既有警告，中文标点检查通过。此前合跑命令中的一个 host 文件名不存在，Bun 忽略该路径；205 项只计 coding 包，11 项 host 另用真实文件路径验证。本轮未运行全仓 `bun run test`。 |
| D3.6 输入复核 | 独立静态复核覆盖输入身份、分支、图片、并发回执及释放边界，发现 workspace 尾部分隔符导致图片路径被错误截取。新增用例实际先失败，改用 `relative()` 后，标准、尾部分隔符、重复分隔符及末尾点路径的图片与重试身份检查通过；检索仅发现该处同形切片。修正后再次通过 `validate:ci` 及上述 30 项定向用例。复核未运行测试或取得完整 Git diff；主线程核对本批全部生产补丁与四个新增文件，不将其称为全面审计。 |
| D3.6 早期可视阻塞 | 当时原授权浏览器空间 6 及任务名均已不存在，没有借用其他空间或真实 WebUI。用户随后明确授权新任务，选定 WebUI 验收及修复见最新可视验收记录；原空间缺失不再作为当前阻塞。D3.6 继续进行。 |
| D3.6 基线检查 | `validate:ci`、两套固定上游生成检查和 17 项既有原生行为对照通过。Lint 为 0 错误、107 项既有警告，隔离 Craft 来源审计覆盖 2104 份文件，中文标点检查通过。本轮未运行全仓 `bun run test`。独立静态复核确认两端使用相同插件，指出夹具初始化失败会绕过清理，现按资源创建顺序登记清理，使复制、服务启动和导入失败也会释放已有资源并恢复隔离环境。复核未执行测试，修正和验证由主线程完成。 |

## D3 实施顺序

产品层协调会话替换，发起插件的 worker 保留进程并接管目标会话。`setup/withSession` 在该进程内执行，收到真实目标 manager 和 context。源产品会话保留自己的历史、存储和后台任务；目标使用自己的配置、审批和工具回调。所有执行仍经过 pi-durable。

| 步骤 | 实现与验收 |
|---|---|
| D3.1 连接与归属 | 从 `PiAgent` 抽取 worker 连接，保留启动、错误、关闭和重启契约。产品 ID、runtime generation 和 operation ID 用于路由、去重及拒绝迟到响应；验证前台转交时源后台任务仍归源。 |
| D3.2 插件交互 | 复用原生 RPC UI 契约和共享 renderer，接通 select、confirm、input、editor、通知、状态、文本 widget、标题及草稿。保留取消与空字符串的区别，响应绕过初始化等待，停止、reload 和关闭释放待决交互。 |
| D3.3 会话替换 | 产品 owner 执行 new、fork、switch 的准备、激活和完成握手；准确运行 before、shutdown、start 和本地回调。记录恢复阶段，避免双 writer、重复产品会话及任意闭包自动重放。 |
| D3.4 原生路径与命名 | 从已提交 journal 生成稳定原生 JSONL 和映射，保留完整树、活动 leaf、原始 entry ID、产品消息关联、label 及附件；支持准确 before/at fork 锚点与可信 switch。名称含清空操作，在提交回执后与产品列表同步。 |
| D3.5 树导航 | 将原生摘要生成移入 durable task，复用 D3.4 的活动 leaf、产品消息映射和完整树，接通导航、取消及 editorText 语义。 |
| D3.6 行为验收 | 原样运行固定上游 rpc-demo、confirm-destructive、session-name 及两端共用的标准插件夹具，检查回调、审批、后台任务、reload、重启和故障恢复，再运行隔离产品交互。 |

Web 与 RPC 的交互能力按固定上游 RPC 契约实现。自定义终端组件、raw terminal input、header/footer factory 等保留 TUI 环境边界。D4 继续负责项目资源信任与 MCP 授权业务接线。

### D3.3 握手与输入生命周期

产品消息 ID 使用独立的 `inputId` 贯穿 worker，RPC 请求 ID 每次重新生成。产品 owner 只从真实 RPC caller 登记输入归属，重放不重新登记。普通输入完成后清除归属，排队输入保留至自身处理结束。会话替换事务取得可释放的归属租约，允许源回合先收尾；断连、工作区切换、取消或会话删除仍立即使相应租约失效。客户端信息只保存在内存中，不进入会话文件。

会话替换保留原命令协程和本地闭包，产品与 worker 按以下顺序握手。回复只解除协程等待，不通过初始化队列代替协程关闭自身 host。

| 阶段 | 约束 |
|---|---|
| prepare | 原命令内运行 before hook，校验路径与锚点。产品锁住源操作；new/fork 创建未发布目标，switch 只预留同工作区中身份与路径已验证的空闲既有目标。取得对应 prepared 记录的严格持久化回执后回复；尚不释放目标 writer。 |
| source closed | 原协程关闭源 host、journal 与 store，保留物理进程和源后台任务。产品结束源 generator，保存最终源记录，源队列暂不启动。 |
| activate | 同一物理连接以更高 generation 绑定目标，应用目标自己的配置、权限、工具、MCP、cwd、UI 与 store。尚不运行本地回调。 |
| target bound | worker 确认目标 native 身份，产品严格保存目标 committed、源 committed，再取得目标独立发布回执。随后发布目标、向仍有效的发起者导航并授予回调执行机会。异常收尾发布错误目标也须先取得独立回执。 |
| finished | new 的原协程在目标 action scope 内按 `setup → refreshContext → rebind/session_start → withSession` 执行固定上游语义，完成必要 drain 与 flush。没有 chat generator 的目标也须完成事件、用量、processing、listener 和队列收尾。 |

源记录保存事务阶段和回调授权状态，目标在发布前保存未发布 marker。尚未独立发布的目标恢复时依据源记录发布或回滚；取得独立发布回执的目标可在源删除或开始下一次事务后恢复。旧事务收尾仅在源仍存在且 transaction ID 匹配时更新源记录，不能重建已删除源或覆盖下一事务。仅删除本事务新建且未提交的记录。凭据、进程、lease、Promise 和闭包不持久化，重启不重放任意闭包。物理连接统一管理进程寿命，释放一个会话的绑定不能终止其他会话的前台或后台任务。

当前原生 manager 来自内存，switch 的成功路径依赖 D3.4 的稳定 native JSONL 与产品映射；准确 fork 同样依赖提交后的锚点投影。缺失路径或锚点时须在源关闭前明确失败，不能冒充成功或退化为空分支。这些失败边界不构成完整 fork、switch 验收。

### D3.4 投影与操作边界

journal 是唯一权威。已提交快照包含 header、完整 entries、活动 leaf、revision、native/durable ID 映射和产品消息关联；回执到达前不发布候选状态。固定原生路径为产品会话目录中的 `native-session/session.jsonl`，配套 `meta/native-session.json` 保存身份、映射、leaf、revision 和摘要。原生 proxy 只暴露这些路径，不开启第二个文件 writer；宿主恢复仍使用 journal。原生 JSONL 没有独立 leaf 字段，不能重排 entries 或制造 entry 来伪装活动分支。投影失败只触发重建，不重跑已提交回调。

fork 在目标 durable 事务中复制完整已提交树并选择准确 before/at leaf，重新分配目标 header 身份，保留原始 entry ID、parent anchors、非活动分支及其附件。null leaf 明确表示活动空根。固定 Pi 的分支文件只抽取活动路径并重建 labels，本任务保留完整树及原始身份，须在行为对照中记录该差异。`new(parentSession)` 只记录可信来源关系，目标历史保持空。

kernel 的完整树分叉在目标副本中创建 durable marker，以纳入文档单独提交的最后状态；该 marker 不进入 native entries。journal 的分叉映射不得改变 entry ID、parentId 或类型。宿主使用 journal revision 判断是否需要 SDK 初始化元数据，已提交的空树与空 root 在重开时保持原样。普通 cutoff 分叉仍保留截断语义。

switch 仅解析同工作区已登记且身份、revision、摘要一致的规范路径，拒绝忙、删除中、越界、缺失或重复身份的目标。源关闭后才释放目标旧 writer 并激活。owner 记录区分新建与既有目标；switch 失败或重启不能删除、隐藏或重新创建既有目标。shutdown/start 的来源与目标路径使用稳定原生路径。

产品消息关联与原生 entry 在同一次 durable 事务中保存，支持一个产品 ID 对应多个 native entry，不用重复文本推断身份。名称从已提交快照派生，空字符串保留清空语义；严格保存产品记录后再广播，重启补齐尚未同步的 committed revision。依次实现并验证公共快照、原子投影、fork、switch、parentSession 和名称同步，再进入 D3.5。

完整 native fork 保留所有产品消息元数据及其文件。产品 JSONL 正文区分活动与归档行，header 的数量、预览和最后消息只反映活动分支；同步保存、队列保存、延迟加载及导出导入均须保留归档。产品行的稳定顺序与归属仅用于展示，不建立另一棵执行树，也不从归档重建输入队列。携带该历史的 bundle 使用新版格式，旧接收端明确拒绝，避免静默丢失归档。

活动产品行依据已验证的 native parent 链、精确产品 ID 及无歧义的工具调用 ID 派生。已有精确产品关联不由工具 ID 扩展；工具推导须同时具有唯一调用与唯一后代结果。旧 error、plan 或自定义行缺少精确关联时，只能固定到首次建立该历史时的已验证当前 leaf，返回该 leaf 或后代时恢复展示，不能声称恢复了未知的历史位置。null 保留根部归属。未产生 native entry 的源控制命令按真实 inputId 标记源归属，在 fork 目标中归档；未消费输入保留源归属，不因复制或导航再次调度。消费完成且取得精确 native 关联后，解除该输入的临时源归属。

普通产品分叉继续复制截至所选消息的转录与 Pi 恢复元数据，不继承完整树归档及源树派生的定位缓存，避免截断后的树引用已经排除的 leaf。后续需要原生归属时，依据目标自己的已验证树重新派生。

产品 fork 的关闭 ACK 须携带最终投影引用，并等待产品严格保存后再激活目标。复制后的 store 在路径改写、Harness 打开、继承任务处理和恢复前，须通过公开只读接口解析 journal，校验版本、owner、完整树、leaf、名称与映射，并以投影共用编码核对已登记摘要。不得调用会初始化或迁移状态的 `NativeSessionJournal.open()` 来验算副本。随后还须验证 durable 映射在所选 conversation 中可见，以及原生 envelope 的 ID、parentId 和 type；连续 fork 可能只改写 journal 的文件路径，不能要求旧 envelope 的全部 data 与当前 journal 相等。该检查不声称证明整个 store 的逐字节身份或任意目录交换安全。

原生 fork 只接受全新目标历史，不能因目标存在旧 transcript 而退化为 resume，也不能跳过源复制与验证。验证只对副本打开存储适配器，公开 journal 解析本身不写入；适配器初始化和关闭可能改变副本元数据，不视为物理文件只读。

产品 owner 在 prepare 阶段严格登记引用，读取可信完整树，独立推导并逐字段核对 worker 的 native leaf、durable 锚点及 selectedText。源关闭后允许 shutdown 合法追加 entry 和名称，但原有 entry 与 durable 映射保持不变。最终引用严格保存并结束源 generator 后，再复制全部产品活动、归档行及其文件。目标绑定后严格登记新引用，验证新 native 身份、源父路径、准确 leaf、完整重映射树及原始映射，再保存双边提交和独立发布回执。

## D4 项目资源信任

coding profile 在项目资源或 MCP 启动前，通过固定原生 loader 只加载可信全局扩展及显式宿主扩展，执行其 `project_trust` hook，再检查原生 `ProjectTrustStore`、全局默认策略及产品 UI 选择。项目 settings 不能自行授权。取消不保存决定；没有可用 UI 且没有既有批准时拒绝项目资源。明确选择仅本会话时，决定保留至该 kernel 结束，持久拒绝可在 reload 时覆盖本会话批准。没有需批准资源时的默认结果不缓存为批准，后续新增资源仍须检查。

同一次决定控制 `.pi` 原生资源、`.pi/mcp.json` 与 `.mkagent/mcp.json`。仅存在 `.mkagent/mcp.json` 也会触发检查。原生和既有宿主 MCP 配置按作用域合并，同作用域内保留宿主配置优先；两种项目 URL 均不能指定宿主凭据 provider。普通 profile 和 `host-only` 不发现原生 MCP 配置。

kernel 持有原生资源，首次启动复用信任预加载结果，后续 reload 重新加载资源并刷新 MCP。撤销信任会先关闭旧连接并移除项目工具，再保留允许的全局连接。新建、切换及重开 kernel 重新取得自己的决定，不将仅本会话的批准写入持久 store。资源加载继续跳过缺失包，不隐式安装。

| 验证 | 实际结果 |
|---|---|
| 资源、UI、MCP 与 coding 回归 | 定向合跑 248 项测试、1520 项断言通过，覆盖信任前不执行项目代码、取消与 headless 默认、全局 hook、持久决定、配置优先级和资源 reload。 |
| reload 回归 | 新用例先复现预加载插件在 reload 后仍为旧版本，随后验证新版本实际执行；产品资源由 kernel 持有，每次重载重新加载。 |
| 真实产品入口 | `native-project-trust.isolated.ts` 经 SessionManager、PiAgent、bundled worker 与 UI 协议验证批准、撤销、两种项目 MCP 及旧连接关闭，1 项测试、25 项断言通过，模型请求为 0。另覆盖恢复批准，以及 codemode 随配置重新启用和关闭。 |
| 既有插件 | 未修改上游插件产品用例重新运行，1 项测试、65 项断言通过。 |
| 静态复核 | 独立复核指出项目关闭 codemode 后，撤销信任可能使全局 MCP 使用仅供 codemode 调用的 exposure，但 kernel 没有安装 codemode。真实产品用例先失败，再验证 registry 与原生工具声明随配置同步启用及关闭。复核未取得完整 Git diff，也未执行测试；修正及验证由主线程完成。 |
| 必需检查 | `validate:ci`、两套固定上游生成检查通过。Lint 为 0 错误、107 项既有警告，隔离 Craft 来源审计覆盖 2112 份文件，中文标点检查通过。 |

项目信任提交未包含 MCP 交互 OAuth 和显式包管理命令，后续 OAuth 接线见下一节。该提交未运行全仓 `bun run test`。额外 kernel 合跑因 150 秒命令上限被中止，没有取得完整结果，不将中止的运行计为通过。

## D4 MCP OAuth 接线

本批采用原生 `/mcp` 命令约定，在 coding 模式提供状态、`login`、`logout` 与 `reconnect`，缺少服务名时通过已有 RPC select 选择。自动连接、工具执行、reload 和恢复只发送已有令牌或刷新，不发起交互登录。401 保留需要授权的连接，不注册失效工具；显式登录成功后重连并更新 durable 工具和 codemode 目录。

授权、PKCE、回环回调、粘贴完整回跳、DCR/CIMD、state/path/issuer 校验及刷新锁复用固定 Pi v1.5.0 源码，通过独立 `mcp-oauth` 入口公开。宿主 MCP 依赖对齐 1.5.0。实际安装存在两份同版本模块，初测复现 `instanceof` 漏判，现从授权实现所在入口公开同一个异常类，不依赖模块去重。

凭据写入显式 agentDir 的 `mcp-auth.json`，按服务名与 URL 隔离。Stop、UI 失效、reload、重建和所有者释放先取消并等待本所有者的交互操作。退出开始即停止本连接发放令牌及启动刷新，等待本连接已开始的刷新保存，再取得跨进程刷新锁删除凭据；交互登录也在该锁内读取及更新 grant、client 和 PKCE 状态。生成转换给原生锁增加可取消等待，自动刷新保留原有等待与保存行为。连接关闭也等待令牌轮换保存。OAuth 仅向 HTTPS 或回环 HTTP 资源发送令牌，匿名远程 HTTP 不绑定 OAuth provider。授权 URL 由 widget 展示，独占一行的 HTTP(S) 链接复用已有平台 URL 打开能力。

| 验证 | 实际结果 |
|---|---|
| 连接与授权 | 14 项测试、69 项断言通过，覆盖 401 不自动登录、实际 PKCE 回调、并发刷新、服务名及 URL 隔离、错误 state/path/issuer、对话框出现前取消、退出时令牌拒绝、关闭等待轮换保存及新 store 重开。另覆盖非回环 HTTP 的 OAuth 令牌拒绝、原生 `clientRegistration: "auto"`、跨实例登录轮换、锁等待取消，以及刷新响应已到达后取消仍保存轮换结果。显式 Authorization 和 provider 配置不进入 OAuth store。 |
| 独立进程 | 两个实际 Bun 子进程共用隔离 store：刷新进程取得锁并暂存真实令牌响应，退出进程等待，刷新保存完成后才删除凭据，随后重新打开 store 仍无 grant。初次 fixture 因没有关闭 stdin 超时；原始进程探针复现该原因，补充 EOF 后重新通过。 |
| 独立复核 | 只读复核指出远程 HTTP 令牌风险、跨 worker 退出后凭据恢复、交互登录重复刷新及 `auto` 被拒绝四项问题，均经主线程红测复现后修复并转绿。复核没有取得完整 Git diff、复算来源哈希或运行测试；这些验证由主线程完成。能力清单的 Baseline 列保留起始状态，当前验证报告已修正过时的 UI、项目信任及 OAuth 描述。 |
| 真实产品入口 | `native-mcp-oauth.isolated.ts` 经 SessionManager、PiAgent、bundled worker 与实际 UI 协议验证回调、粘贴、取消、Stop、UI 断开重连及插件回调触发 reload，1 项测试、21 项断言通过，模型请求为 0。登录期间第二条产品输入沿用排队语义，不用该路径假称已触发并发 reload。 |
| 既有产品回归 | 项目信任产品用例 1 项、25 项断言，上游原样插件产品用例 1 项、65 项断言，均通过。 |
| 必需检查 | `validate:ci` 退出 0；MCP 与原生 UI 合跑 43 项、221 项断言通过。两套固定上游生成检查通过，运行时仍为 250 份源码与 9 项资源。Lint 为 0 错误、107 项既有警告，隔离 Craft 来源审计覆盖 2119 份文件，中文标点与 `git diff --check` 通过。初次来源审计误将独立维护的 docs 加入 source manifest，移除该条后重新通过。 |

本批未完成可视验收。原浏览器空间缺失，未访问其他空间或真实 WebUI。OAuth 尚需补充 re-init、所有者释放、scope 升级及多进程登录交错的定向故障证据，不能以已复用上游实现替代这些检查。该 OAuth 提交未包含原生插件注册的 MCP 服务接线及 provider 凭据支持，后续进展见下一节。显式包管理仍待实现，D4、D3.6 及 D5-D6 均未整体完成，本批尚未运行全仓 `bun run test`。

## D4 原生插件 MCP 注册

原生 `pi.registerMcpServer()` 和 `pi.unregisterMcpServer()` 在启动、注册变化及下一回合前同步宿主 MCP，继续通过现有 durable 工具执行。配置文件中同名或共享 namespace 的条目优先，即使该配置明确关闭服务。插件声明变化只替换受影响的连接，保留无关配置连接；reload 重新取得注册，关闭时停止接收变化并等待已有连接和队列收尾。

撤下服务先移除工具和资源的可访问连接，再取消并等待该服务的授权操作，随后关闭连接。旧工具和资源闭包也检查当前连接身份，不能在授权清理期间继续发起调用。登录取消会留下原生 discovery、client 或 PKCE 元数据，未保存访问令牌，不以整个 store 为空作为取消条件。

| 验证 | 实际结果 |
|---|---|
| 注册生命周期 | `registrations.test.ts` 8 项测试、42 项断言通过，覆盖配置 namespace 与 disabled 优先、不重启无关连接、动态隐藏与移除、连接中关闭及排队新增取消。 |
| 失败恢复 | 独立静态复核指出首次连接失败仍被缓存为已应用。主线程另复现断开回调失败后同声明不能恢复，以及授权清理期间旧工具和资源仍能访问连接。5 项新增用例先失败后通过；现按实际保留连接判断是否已应用，移除重复的声明缓存。 |
| 同类检查 | MCP 注册模块中的连接声明缓存已移除；工具连接 Map 和资源连接快照两处入口均补充当前连接身份检查。独立复核覆盖六份源码及测试变更，没有执行构建或测试，动态验证由主线程完成。 |
| 真实产品入口 | SessionManager、PiAgent、重新构建的 bundled worker 及实际 UI 协议覆盖启动注册、配置冲突、隐藏、移除、重新添加、reload 和登录中撤下服务，1 项测试、31 项断言通过，模型请求为 0。首次重跑因 Bun 将未加路径前缀的文件名作为筛选器而没有发现测试，改用绝对路径后执行并通过。 |
| 既有产品回归 | 修正后重新运行项目信任及原样上游插件产品用例，分别为 1 项测试、25 项断言，以及 1 项测试、65 项断言，均通过。 |
| 必需检查 | 修正后 MCP 合跑 32 项测试、181 项断言通过；`validate:ci` 退出 0，隔离 Craft 来源审计覆盖 2121 份文件。两套固定上游生成检查通过，运行时仍为 250 份源码和 9 项资源，公开 fixture 为 40 份源码。Lint 为 0 错误、107 项既有警告，中英文标点检查通过。 |

该插件注册提交尚未接通 `auth.provider`，当时明确拒绝该声明，后续接线见下一节。显式包管理、OAuth 其余故障证据及可视验收仍待完成，D4 继续进行中。本批未运行全仓 `bun run test`。

## D4 MCP provider 凭据

全局 MCP 配置及已加载的受信任插件可以按原生 API 声明 `auth.provider`。coding 模式在 `session_start` 绑定当前 `ctx.modelRegistry`，shutdown 时清除绑定；原生绑定前及普通模式使用宿主 models 的公开凭据接口。每次请求重新读取 token，MCP 不保存副本；读取前后检查产品所有者及原生注册表身份，连接关闭后不发放迟到 token。

配置服务先于原生注册表启动，需要凭据的服务在绑定后再连接一次。插件声明则直接使用已绑定的注册表。provider 返回 token 时，固定上游 transport 用它覆盖显式 Authorization header；缺少 provider token 时保留显式 header 的原生行为。provider 401 不进入 MCP OAuth discovery，也不重放工具调用，保留 `needs-auth` 并允许修正凭据后显式重连。

两种项目 MCP 配置仍不能选择宿主 provider；runtime 也不为 project scope 或非回环明文 HTTP 发放 provider token。受信任 Node 插件已经可以执行代码并使用公开 modelRegistry API，其显式 MCP 注册复用同一权限，不将项目配置的声明限制当作插件沙箱。本批提供已有 provider 凭据的读取，插件 provider 自身的交互登录尚未验收。

| 验证 | 实际结果 |
|---|---|
| 凭据与 MCP 回归 | 38 项测试、217 项断言通过。新增用例覆盖全局和插件服务的逐请求 token 更新、原生 header 优先级、OAuth store 隔离、401 不重放、关闭期间迟到 token，以及 project scope 和明文 URL 的凭据拒绝。 |
| 真实产品入口 | `native-mcp-oauth.isolated.ts` 经 SessionManager、PiAgent 和重新构建的 bundled worker 验证插件 provider 启动、全局配置引用插件 provider、轮换、注销、重新注册及 reload，1 项测试、42 项断言通过，模型请求为 0。 |
| 既有产品回归 | 项目信任产品用例 1 项测试、25 项断言，以及原样上游插件产品用例 1 项测试、65 项断言，均重新运行并通过。 |
| 独立复核 | 只读复核覆盖九份源码和测试变更及必要调用链，未发现新增高置信度缺陷。复核未执行测试或构建；header 优先级由主线程对照固定 transport 源码及本地请求结果核实。 |
| 必需检查 | `validate:ci` 退出 0；两套固定上游生成检查通过，仍为 250 份运行时源码、9 项资源和 40 份公开 fixture 源码。隔离 Craft 来源审计覆盖 2123 份文件，lint 为 0 错误、107 项既有警告，中英文标点及 diff 检查通过。 |

provider 凭据提交未包含显式包管理，后续进展见下一节。OAuth 其余故障证据及可视验收仍待完成，D4、D3.6 和 D5-D6 尚未整体完成。本批未运行全仓 `bun run test`。

## D4 显式包管理

原生资源策略提供 `/packages list|install|remove|update [--local] [source]`，默认操作 user scope；`--local` 或 `-l` 选择已信任的 project scope。路径中的空格沿用原生参数引号解析。`host-only` 不注册该命令。宿主选择这个显式入口，复用固定上游 `DefaultPackageManager` 的 npm、git、本地路径、配置写入及依赖脚本语义；资源发现和 reload 继续跳过缺包。

生成转换增加宿主子进程 stderr 策略、update 的可选 scope，以及批量失败后的等待。SDK 未传 options 时仍保留原生双 scope 更新；宿主明确传入 user 或 project，避免默认更新越过用户选择的范围。子进程输出不会进入 worker 的 JSONL stdout。

同一原生 owner 串行执行列出与修改，每次先刷新已保存的 settings 快照，修改后检查 `flush()` 与 `drainErrors()` 才 reload。正常 shutdown 等待已开始的 native 操作完成，包括某个并行更新已失败时仍在运行的任务；关闭期间拒绝新的操作并抑制 reload。原生安装器没有取消契约；文件修改和配置写入不是原子事务，失败会提示文件可能已经变化。该命令不提供崩溃后的自动重放，也不承诺跨进程包操作的原子性。

| 验证 | 实际结果 |
|---|---|
| 原生包管理与资源回归 | 修正后包管理 10 项测试、59 项断言通过。实际 AgentSession 和本地假 npm/git 覆盖安装、更新、移除、scope、拒绝未信任项目、设置写入失败、手动重试、两个 owner 顺序写入、部分失败的关闭等待和独立 JSON 协议进程的 stdout/stderr。资源用例同时包含在下方完整 coding 包回归中。 |
| 发现阶段的负向证据 | 新 git fixture 首次使用单段仓库路径，固定 parser 拒绝后未执行 clone；公开 parser 复现后改为有效 owner/repo。另三处旧 skip 用例也改用有效 URL，并加禁止 subprocess 的断言，确保缺包策略实际受到测试。 |
| 真实产品入口 | 项目信任产品用例加入含空格本地 package 的安装、插件命令执行、移除卸载和未信任项目拒绝。真实 SessionManager、PiAgent 与重新构建的 bundled worker 共 1 项测试、32 项断言通过，模型请求为 0；移除后仍保留原本的本地源目录。 |
| 完整 coding 包回归 | 修正后重新运行整个 `packages/pi-durable-coding`，229 项测试、1429 项断言通过。未运行全仓 `bun run test`。 |
| 既有产品回归 | MCP OAuth 和 provider 用例 1 项测试、42 项断言，以及原样上游插件用例 1 项测试、65 项断言，均重新运行并通过。 |
| 必需检查 | 修正后 `validate:ci`、两套固定生成检查及隔离 Craft 来源审计均重新运行并通过；来源审计覆盖 2126 份文件，lint 为 0 错误、107 项既有警告，中英文标点及 diff 检查通过。 |
| 独立复核与修正 | 只读复核提出两项：原生 `Promise.all` 提前拒绝会遗留正在运行的更新任务；旧 settings 快照会覆盖另一 owner 的顺序保存，或让失败写入的手动重试误报成功。四个用例均先在未修正实现上失败，再在修正后通过。宿主在每次操作前刷新快照，生成转换在两层并发入口等待所有已启动任务结束后再传播失败。 |

显式包管理已提交为 `a3f63d4`。该批次之后的 OAuth 故障证据见下一节，D4 与 D3.6 尚未整体完成。

## D4 OAuth 故障验收

本批只增加行为证据，没有修改生产实现或固定上游 fixture。scope 用例在真实 transport 的 `fetch` 边界为一次工具请求返回 `403 insufficient_scope`，其余 MCP 与 PKCE/DCR 请求继续访问固定本地服务器。拒绝后工具目录清空，不刷新、不自动重放；显式 `/mcp login` 合并既有配置与挑战要求的 scope，重连后由调用者再次执行工具。

| 验证 | 实际结果 |
|---|---|
| scope 升级 | 1 项测试通过，检查一次拒绝、零工具副作用、需要授权状态、显式登录的新 scope，以及调用者再次执行才产生一次副作用。 |
| 两个独立进程登录 | 2 项测试通过。第二个实际 Bun 进程等待第一个交互登录保存 grant，随后刷新已保存凭据，不另开登录页；另一场景等到已调用原生锁的同步信号后取消，确认未取得锁，首个登录仍能完成。两个进程均正常退出，store 的最终轮换值与服务端请求一致。 |
| 真实 worker 生命周期 | 3 项测试、33 项断言通过，覆盖 re-init、所有者释放和 shutdown。迟到回调须在一秒内以 Bun 的 `ConnectionRefused` 拒绝，HTTP 错误或超时不算端口关闭；release 的检查发生在再次初始化之前。新 owner 拒绝旧 UI epoch，继续显示需要授权，模型请求为 0。该夹具提供宿主历史回执，只验证 worker 协议，不替代产品持久化验收。 |
| 夹具修正 | 首次超时包含两处夹具错误：将 RPC 的 `widgetKey/widgetLines` 写成产品投影字段，以及没有回复 `native_history_commit`。结构帧日志确认阻塞边界后补齐协议，全部通过；没有将这些失败记为生产缺陷。 |
| MCP 回归与类型 | 复核修正后的六个新增场景共 89 项断言通过，整个 MCP 目录为 44 项测试、306 项断言通过。worker 和新子进程 fixture 的类型检查通过；`validate:ci` 退出 0。 |
| 独立复核 | 只读复核指出回调 HTTP 错误误计为关闭、再次初始化掩盖 release 清理，以及取消可能早于锁等待三处证据缺口，主线程逐项收紧。独立原始端口探针确认 HTTP 400 会正常返回，关闭后才产生 `ConnectionRefused`，修正后的 MCP 回归全部通过。复核未执行测试或构建。 |
| 产品及必需检查 | 实际 SessionManager、PiAgent 与重新构建 bundled worker 的 MCP 产品用例重新运行，1 项测试、42 项断言通过。两套固定生成检查通过，仍为 250 份运行时源码、9 项资源与 40 份公开 fixture；隔离 Craft 审计覆盖 2131 份文件，lint 为 0 错误、107 项既有警告，中英文标点检查通过。 |

本批之后的原生插件 provider 交互登录见下一节。可视验收仍待完成，D4、D3.6 与 D5-D6 继续进行。本批尚未运行全仓 `bun run test`。

## D4 原生 provider 交互登录

coding 模式提供 `/login [provider]` 和 `/logout [provider]`，通过当前 kernel 的公开 `Models` 接口登录和退出。没有 provider 参数时使用已有 RPC select；同时支持 OAuth 与 API key 的 provider 另选认证方式。原生 provider 对象与兼容 `pi.registerProvider(name, config)` 共用该入口和既有凭据存储，不建立第二个模型注册表或执行调度器。

宿主接通 `AuthInteraction` 的 text、secret、select、manual-code、URL、device-code、info links 和 progress。选择项显示名称与说明，使用唯一序号映射回原始 ID。secret 使用独立的宿主密码输入标记，关闭自动补全、拼写检查和自动大写；回答只走 UI 响应协议，不写入产品消息或插件通知。provider 错误可能包含输入值，宿主仅报告通用失败状态，不回显原始错误。凭据同步失败时提示凭据可能已变化，保留原生存储语义。

Stop、UI 失效、reload、所有者释放、re-init 和 shutdown 与 MCP 授权共用取消、等待入口。单个 manual-code prompt 的取消不等于整个登录取消，允许回调先完成原生流程。成功登录会重新连接引用该 provider 的 MCP 服务；退出先完成原生凭据删除，再关闭这些连接并撤下工具。该同步不重放工具请求。受信任插件仍须遵守取消契约，宿主不把任意 Node 回调当作可强制终止的沙箱。

| 验证 | 实际结果 |
|---|---|
| 原生 host 与 UI | provider 5 项测试与既有 UI 19 项测试合跑通过，共 160 项断言。覆盖重复 label 的 ID 映射、说明、secret 标记、API key、兼容 OAuth、重载后凭据、单 prompt 取消、选择前取消、Stop、断开、无 dialog 回调等待及错误中的 secret。 |
| 真实产品入口 | `native-provider-auth.isolated.ts` 经 SessionManager、PiAgent、重新构建 bundled worker 和实际 UI 协议通过，1 项测试、53 项断言。登录恢复 MCP 工具，reload 保留凭据，退出撤下工具；取消、Stop、断开和插件触发 reload 均拒绝迟到 secret 回答。产品历史与 UI 更新不含合成凭据，模型请求为 0。 |
| 独立复核与修正 | 只读复核指出兼容 provider 在登录和退出后正常重组对象，会被引用检查误判为取消，跳过 MCP 同步。主线程先复现凭据已保存但同步回调缺失，再用稳定的注册声明检查修正；登录与退出回调均通过。复核未运行测试，修正后的动态检查由主线程完成。 |
| 夹具边界 | 首次重载检查失败，因为 host 夹具没有像产品一样复用 `modelCredentialsSource`；补齐公开凭据接口后原生重载检查通过，没有据此修改生产存储。真实产品独立覆盖重载后的登录状态。 |
| 相关回归 | MCP 和两层 UI 传输共 58 项测试、369 项断言，host 模型与目录共 15 项测试、114 项断言，均通过。既有 MCP OAuth、项目信任与原样上游插件三个产品用例分别为 42、32、65 项断言，均重新运行并通过。 |
| 必需检查 | `validate:ci` 与 server 类型检查通过。两套固定生成检查通过，仍为 250 份运行时源码、9 项资源与 40 份公开 fixture。隔离 Craft 来源审计覆盖 2135 份文件，lint 为 0 错误、107 项既有警告，中英文标点及 diff 检查通过。初次 lint 因漏更新独立 UI 来源哈希停止，补齐两层来源登记后重新通过。 |

该批不包含浏览器可视验收，原授权空间仍缺失；密码框的实际显示、焦点及键盘行为仍列入隔离 WebUI 验收。D4、D3.6 与 D5-D6 尚未整体完成，本批尚未运行全仓 `bun run test`。

## D5 干净构建与最终回归

本批先在 `10cac69` 的干净 detached worktree 冻结安装，再检查独立消费者和搬迁后的 headless 入口。以下产物证据对应 `10cac69`，不包含随后发现的 SDK 输入标记与普通产品分叉修正。当时最终提交的产物仍须重新构建，后续结果见最新可视验收记录。

| 验证 | 实际结果 |
|---|---|
| 干净安装与声明 | `bun install --frozen-lockfile --ignore-scripts` 成功安装 1419 个包，coding 声明构建通过。首次 headless 构建因禁用生命周期脚本而缺少 `@vscode/ripgrep/bin/rg`；核对已有 `trustedDependencies` 和该依赖脚本后，在隔离环境执行其 postinstall，取得公开 ripgrep 15.0.1，随后构建通过。没有修改依赖或 lockfile。 |
| 独立消费者 | 使用 `file:` 安装干净 checkout 的 coding 包，root、compat、native、agent、durable、mcp-oauth 六个运行时入口及 rpc-ui 类型入口通过检查。 |
| 搬迁产物 | macOS arm64 压缩包解压至新的任务目录后，许可、两个 WASM、theme、HTML template 和 launcher 检查通过。随机回环端口的 HTTP health 为 200，认证 WebSocket 握手通过。 |
| 实际 headless 产品入口 | 通过搬迁产物的认证 WebSocket 创建会话、执行原生插件命令、答复 dialog、拒绝迟到回答，并检查名称与历史持久化；模型请求为 0。消息 ACK 只确认用户行已保存，名称检查改为等待实际 `session:event complete`，没有扩大 ACK 的含义。 |
| 独立 SDK 行为修正 | 原生对照的 `agent-end-follow-up` 场景先失败：独立 SDK 的 `sendUserMessage` 被无条件添加产品投影字段。原始输入采集现由 `CodingHost` 显式注入，SDK 默认不添加产品标记；固定生成后，原版与 durable 的 17 个场景全部通过，没有修改 oracle 的归一化或断言。 |
| direct-worker 夹具迁移 | 三份旧夹具补齐匹配归属的 `native_history_commit` 回执及必要 scope。worker-scope 为 18 项、137 项断言，kernel 定向用例为 1 项、8 项断言，bundle 为 1 项、6 项断言，均通过。模拟回执只验证协议，不替代产品持久化。 |
| 独立产品夹具迁移 | renderer bridge、shared UI 和 PR 工具夹具直接创建 coding `PiAgent`，须提供明确的 fixture history owner。补齐后分别通过 2、11、1 项测试；回执校验 session 身份，拒绝非预期会话替换。非 coding 的 Anthropic schema 夹具保持原契约。 |
| 普通产品分叉修正 | 全部隔离文件逐项运行时，真实产品用例暴露初始化错序：worker 的首次投影早于新产品会话登记。现先登记内部 owner，再完成预检与最终严格保存；公开列表、读取、输入、事件及活动统计在创建完成前保持未发布。失败先阻止新写入，等待原生写入并取消排队保存，再销毁 backend 和删除记录。 |
| 分叉红绿证据 | 原始 bundled-worker 用例先失败，修正后 1 项、43 项断言通过，包含普通 cutoff 分叉、继承 coding mode、导出导入、导入后再分叉、后台交接与重开。新增 `session-branch-preflight.isolated.ts` 的三个场景共 35 项断言通过，覆盖严格回执、发布前隔离、写入后的失败清理，以及阻塞真实 rename 时等待并取消实际排队保存。 |
| 独立复核 | 只读诊断确认普通 branch API 与原生 `ctx.fork()` 的生命周期不同。只读复核另发现提前登记会暴露未提交分支，主线程先复现后补齐发布保护；故障夹具也补上 cleanup 入口信号及真实排队保存。复核未运行测试或构建。 |

发布保护修正后的完整 `bun run test` 已退出 0：主批次 433 份文件、5084 项通过、11 项跳过、0 失败，后续 33 份串行与隔离文件全部通过。`validate:ci`、隔离 Craft 来源审计及 lint 均退出 0，lint 为 0 错误、107 项警告；两套固定生成检查通过。独立 SDK 修正提交为 `a1790ed`，普通分叉与回执夹具迁移提交为 `4e29c34`。这些结果不包含随后新增的 D6 定向用例，该批结束时最终产物仍须重建。此前主动停止或退出 1 的运行保留为排错记录，不计为通过。

## D6 定向能力核对

`search-output.test.ts` 实际调用本地 rg、fd 与目录工具，检查中文路径和文本、隐藏文件、ignore、上下文、空结果、路径错误与限制提示。`coding-output.e2e.test.ts` 经真实 durable coding host 产生超过窗口的 UTF-8 shell 输出，核对完整 spill 文件、保留尾部、关闭重开后的历史引用，以及 read 的前两行窗口。`coding-host-prompt.e2e.test.ts` 组合宿主文件发现与原生 global、ancestor、cwd instructions，再经 reload、before-start 和 context hook 检查模型实际收到的内容。不同文件即使内容相同也保留各自来源；宿主只列路径，没有再次注入文件正文。三份文件合跑为 7 项、82 项断言通过，server 类型检查通过。

固定上游 `extensions/mcp/index.ts` 的 `/mcp` 在无参数且 `ctx.mode === "tui"` 时打开管理界面，RPC 模式列状态；命令参数只支持 `login`、`logout`、`reconnect`。现有宿主命令覆盖这一 RPC 契约，并提供状态与原生 RPC select。启停与 exposure 的原生交互编辑属于 TUI manager，不是缺失的 RPC 子命令；现有配置、项目信任及插件注册驱动的启停和动态 exposure 已有产品证据。TUI manager 的可视兼容仍随终端组件列为环境边界，不据此宣布全部 TUI 插件已验收。

skill 前置读取发现两个提前登记点：`Read` 的开始事件，以及审批前的 Bash 检查。已将准入与成功确认分离，按 call ID、审批输入及当前 worker 归属关联完成；失败、后台、复杂 shell 和生命周期失效均不登记。普通 kernel 的 orphan 完成事件也明确为错误。原红测 3 项失败，修后通过；独立复核另指出 `cat 3< guide` 仅打开 fd 3，新增红测复现后限制为唯一 stdin 输入重定向。manager 为 68 项、160 项断言通过，真实双模式 worker 为 2 项、132 项断言通过。skill 的一次拒绝后降级保持原行为，strict browser 仍要求成功读取。`.isolated.ts` 由仓库 runner 自动发现，不需要另加显式清单。

PowerShell 核对同时发现真实产品接线缺口：原生 SDK factory 存在，但宿主覆盖工具表没有注册。现只在 coding profile 注册 deferred 工具，由原生插件显式激活，并沿用 durable 工具任务。宿主将其识别为 `PowerShell`，不套用 Bash 语法或记忆键；Explore 拒绝，Ask 每次确认，Allow All 可执行。真实 worker 以任务临时 `pwsh` 进程替身验证发现、拒绝无启动、批准后的 UTF-8 设置及参数，1 项、20 项断言通过；权限用例 11 项、27 项断言通过。当时尚未准备真实 `pwsh`，替身结果不计实机通过；后续 macOS 实机结果见下方记录，Windows 仍未验收。

原浏览器空间缺失是本批当时的阻塞，后续已在用户明确授权的新任务中完成选定 WebUI 验收，见最新可视验收记录。

## 历史代码与产物验证（`a41e6b5`）

本轮本地提交为 `61fac5d`（读取确认与命名 PowerShell 审批）、`57bbaf5`（coding profile 的 PowerShell 接线）和 `a41e6b5`（搜索、长输出、instructions 与需求对照）。没有 push、PR、merge 或对外消息。

| 验证 | 结果 |
|---|---|
| 完整仓库回归 | `bun run test` 退出 0，主批次 436 份文件、5096 项通过、11 项跳过、0 失败；后续 35 份串行与隔离文件全部通过。真实 rg/fd 搜索用例没有跳过。 |
| 必需检查 | `validate:ci`、lint 和隔离 Craft 来源审计均退出 0。Lint 为 0 错误、107 项警告；审计覆盖 2141 份文件。两套固定生成检查仍为 250 份运行时源码、9 项资源及 40 份 fixture。 |
| 干净构建与消费者 | 干净 detached checkout 对齐 `a41e6b5`，冻结安装检查、coding 声明构建及 headless 构建通过。忽略依赖安装脚本后，构建所需 rg 复用同任务已验证的同版本依赖产物。独立 `file:` 消费者的六个运行时入口及 rpc-ui 类型入口通过检查。 |
| 产物搬迁 | macOS arm64 压缩包搬迁后，许可、两个图片 WASM、theme、HTML template、launcher token 生成、随机回环 health 200 及认证 WebSocket 握手通过。压缩包 SHA-256 为 `0b4b01b11fed70f18776c58e7f3cfd9f816b6f17bc51d9a31c0869fd59ab34df`。 |
| 实际产品入口 | 搬迁产物创建会话、执行原生插件命令、答复 dialog、拒绝迟到回答，并保存名称与历史；模型请求为 0。未以这些协议结果替代可视交互。 |
| 红绿与复核 | orphan 结果在未修正的干净源码上为 1 项失败、修正后 1 项通过；同一探针保留成功嵌套结果正例。独立静态复核发现 fd 3 读取误判并经红绿修正，PowerShell 接线复核未发现高置信度缺陷；复核者未运行测试。 |

完整测试首轮命令因 PATH 未加引号而未启动；随后全局设置 `PI_OFFLINE=1` 的运行禁用了本地包替身要验证的显式更新，主动停止且不计通过。最终完整运行移除该全局变量，使用明确的工具路径，通过全部文件。新增成功确认用例使来源覆盖登记从 26 项增至 27 项，已同步静态计数及来源摘要。

日志保留于任务目录的 `d6-verified-repository.log`、`d6-final-ci.log`、`d6-final-lint.log`、`d6-final-audit.log`、`d6-clean-headless.log`、`d6-consumer-runtime.log`、`d6-headless-relocated.log` 和 `d6-headless-product.log`。工作树在三个提交后保持干净。该批结束时原浏览器空间 6 仍不存在，后续授权及验收见下一节；Windows、真实 PowerShell 和终端专属交互仍未验收。D3.6、D4 和 D6 不据此标记整体完成。

## 最新可视验收与修复（`9965789`、`640aca6`）

用户在原空间 6 缺失后明确授权新建任务 `mkagent-durable-coding-visual-d6-20261104`，并确认仅使用这个新任务。它获得编号 7；所有浏览器操作均按该名称恢复并核对归属，没有访问其他旧空间、真实 WebUI、真实 HOME 凭据或付费模型。以下两批均使用任务目录、隔离 HOME/config 和本地确定性服务。

| 验证 | 实际结果 |
|---|---|
| 确认框焦点修复 | `9965789` 修复仅寻找 input 的初始焦点逻辑：确认框没有 input，焦点原来落在 body，Escape 无效；现在在所属面板聚焦时回退到 Cancel。真实 WebUI 修前复现失败，修后验证 Cancel 获得焦点、Escape 取消，以及 Shift+Tab 后 Enter 确认，原样 rpc-demo 的 NEW 确认也通过。没有新增该确认框的专门自动化用例。 |
| 首批 WebUI | 同一隔离任务验证原样 input 的中文输入、自动聚焦及 Enter，多行 editor 的 Enter 换行及 Tab 聚焦 Continue 后 Enter 提交，select 第二项、预填、Escape 取消及未发送中文草稿保留。树导航移除后来消息并返回成功。合成 provider 的 API key 与 OAuth secret 为 password 输入，获得焦点、关闭自动完成与拼写检查，提交后页面不回显；OAuth 的选择、code 和 secret 返回均符合预期，帮助链接带安全的新窗口属性。 |
| 密码证据边界 | 密码截图读取被自动审批拒绝，未重试或绕过。password 类型和其他属性只计 DOM 证据，不声称已人工检查遮罩截图，也不代表请求过真实外部 provider。 |
| NEW setup 根因与修复 | 首批发现 setup 的 `manager.appendMessage(user)` 已进入 journal 和模型上下文，却没有产品输入身份，被严格历史投影过滤。`640aca6` 抽取共同原始输入捕获，仅代理 setup 新增 user 的 append，其余方法绑定真实 manager；`commitSetup()` 在目标 hooks 和 callback 前等待 journal、投影及当前 scope 的严格产品回执，保留旧无标记记录的过滤。 |
| NEW 红绿与恢复 | 产品红测先复现 setup 历史缺失，两种 worker 启动路径先复现 hooks 提前运行。修后 `native-owner-runtime.isolated.ts` 为 1 项、78 个断言，覆盖 setup、callback 顺序、已保存事件、setup-only 无模型请求及冷 worker 后 ID 不变且无重复。18 项 worker 用例通过，含错误 scope 回执拒绝及正确回执才放行；两种存储的产品 fork 回归单独运行通过。 |
| 最新干净产物 | 干净 detached checkout 对齐 `640aca6`，冻结安装及 headless 构建通过，工作树干净。构建复用任务内同版本 `@vscode/ripgrep` 依赖的已验证二进制，实际为 rg 15.0.0。压缩包 `final-headless-visual.tar.gz` 搬迁至新目录，SHA-256 为 `a246541401b6b6b8eec161040aceb985375dfb1f6126a5e09fb3908325dfb172`。 |
| 最新 WebUI 与多面板 | 实际运行该搬迁产物，重新验证确认框键盘行为。NEW 的 setup、callback 及回复均在产品历史可见，刷新仍保留。另在 before-switch hook 暂停 NEW，切至另一面板输入中文草稿后释放：目标发布并完成，另一面板草稿和焦点保持，未聚焦的源面板保持原会话；新目标在列表中，显式打开后消息完整。 |
| 最新 MCP OAuth | `/mcp login issues` 的输入获得焦点，授权链接包含 PKCE S256 和 state。实际点击链接，在同一任务 popup 完成本地回环并显示成功；原表单关闭，`mcp__issues__whoami` 随登录出现、随登出移除。再次登录按 Escape，表单和链接清理且提示取消。最终计数为 2 次注册、1 次授权、1 次令牌请求，第二次取消没有新增令牌请求。 |
| 最新完整回归 | `640aca6` 的 `bun run test` 主批次为 436 份文件、5096 项通过、11 项跳过、0 失败，后续 35 份串行与隔离文件全部通过。`validate:ci`、类型检查、lint 与隔离 Craft 来源审计通过；lint 为 0 错误、107 项警告，审计覆盖 2142 份文件。固定生成层和独立 SDK 未改，沿用 `a41e6b5` 的生成与消费者证据，不计为本批重跑。 |

首批截图保留为 `visual-d6/input.png`、`draft-retained.png` 和 `tree-projection.png`；最新批次为 `visual-final/new-setup.png`、`new-panels.png` 和 `mcp-cancelled.png`，均位于任务目录。旧 NEW 截图不作为 setup 修复的证据。红绿、完整回归与检查日志为 `setup-product-red.log`、`setup-product-green.log`、`setup-worker-red.log`、`setup-worker-green.log`、`setup-fork-green.log`、`setup-final-repository-tests.log`、`setup-final-ci.log`、`setup-final-lint.log`、`setup-final-audit.log` 和 `visual-clean-headless.log`。

最新可视批次共 5 次本地确定性模型请求，与历史 headless 协议批次的 0 请求分开计数。多面板探针曾错误要求未聚焦源面板自动跳转，按现有焦点导航契约修正验收条件后通过；首批夹具跨 NEW 读取旧 context 的失败只记为夹具错误，不计产品失败。单独的 fork 隔离文件与其他文件合跑时曾受配置模块缓存影响，重新按独立进程运行通过，不更改产品断言。

该任务已恰一次完成 `finish({keep:[]})`，随后停止任务服务进程组，收到 SIGTERM 退出回执。该批结束时，项目信任选择的实际 WebUI 画面、Desktop、TUI 专属交互、Windows 和真实 PowerShell 尚未验收。后续进展见下一节，D3.6、D4、D6 仍保留进行中；已通过的选定流程不扩展为全部插件与平台兼容。

## macOS 实际验收记录

本批在原任务目录下新增 `macos-acceptance/`，继续使用隔离 HOME/config、随机回环端口与本地确定性模型。以下结果补充前一节，不把 SDK TUI 计为 MkAgent CLI 的产品界面，也不把 Desktop 流程计为 Windows 结果。D3.6、D4、D6 继续进行。

| 范围 | 实际结果与边界 |
|---|---|
| 真实 PowerShell | 官方 PowerShell 7.6.9 macOS arm64 归档仅解压至任务工具目录，SHA256 为 `a1c7e98ac403da4be5ba75c1c5855af272de7787a91d478c4267466fe58fc1af`。`powershell-real.test.ts` 为 1 项、51 项断言，通过真实 PiAgent coding owner、显式激活、durable 工具与宿主审批执行。Ask 拒绝无文件，批准后真实中文输出和文件、exit 7、超时、Explore 拒绝、取消均通过；超时与取消的真实进程退出，延迟副作用未发生。共 11 次模型请求、5 次审批、26 次产品投影回执。原替身用例单独回归为 1 项、20 项断言。Windows 未验收。 |
| PowerShell 夹具修正 | 新隔离 config 起初未调用 `ensureConfigDir()`，导致启用命令先因缺少 `config-defaults.json` 失败，随后两次调用显示工具未找到。初始化夹具后通过，未把这两次失败误报为产品工具注册缺陷。 |
| 真实 PTY TUI | `tui.ts` 和 `tui-probe.ts` 通过 tuistory 0.12.0 实际运行 ProcessTerminal、InteractiveMode、AgentSession.prompt、durable session/run 和指定 DurableLoopBinding。regular/fullscreen 两个会话均显式完成并关闭，模型请求分别为 2/1。模型为内存 provider，禁止网络请求，工具关闭，只有一个 journal owner。 |
| TUI 交互 | 原样 rpc-demo 与 session-name 加任务插件，验证中文 prompt、输入与 Escape、多行编辑及 Ctrl+J、widget、overlay 的 Escape/Enter、CustomEditor、renderer 的 Ctrl+O 展开、主题、header/footer、reload 和 Alt+J。两种模式按 70×22 与 120×40 调整 PTY 并检查截图。PNG 包含回滚内容，不据其高度声称全部内容适配可见视口。Ctrl+Alt+字母在测试工具编码时丢失 Alt，夹具改用 Alt+J，不改产品。未验 TUI 的 new/fork/resume/import、剪贴板、外部 editor 或真实模型。 |
| 原生 MCP TUI manager | 另开同一 durable SDK 宿主的 PTY 会话，加载固定原生 MCP factory 和任务本地 stdio JSON-RPC 服务，实际操作重新连接、direct→deferred→direct、禁用和启用。配置文件分别保存 exposure 与 enabled，禁用结束首个子进程，启用生成新进程。真实中文 prompt 完成 1 次本地模型请求后正常退出，两个服务进程均有退出记录且 PID 已不存在。截图为 `tui-mcp/exposure-narrow.png`、`reenabled-wide.png`。工具调用保持关闭，deferred 时如实显示没有激活 codemode/tool_search 的诊断，不计为 TUI 中的工具执行或 OAuth 登录验收。 |
| MCP TUI 夹具限制 | 初次启动漏传 PI_OFFLINE，守卫在 runtime 创建前终止。包装插件在 reload 时使用 Bun 的 `import.meta.dir` 触发 jiti 的 NameTooLong，改为显式隔离 agentDir 后加载成功；没有据此修改产品或宣称通用 import.meta 兼容。任务服务起初引用不存在的 SDK，单独启动证实模块缺失后改用 Node 标准库的本地 JSON-RPC 服务。截图历史区仍含早期失败与工具关闭诊断，当前 manager 的 connected 状态、配置及进程记录另行核对。 |
| Electron 构建修复 | `846029f` 修复子包两个独立 esbuild 命令遗漏 `bun:sqlite` external、在两个条件 require 处报错的问题。根项目共用构建器已有正确 external、worker 和 interceptor 构建。子包 `build:main` 改为调用该构建器，`build:main:win` 复用前者，避免参数分叉。旧命令实际失败，新命令与 win 别名在 macOS 均成功，preload 和 renderer 构建成功，实际 Electron 可启动。win 别名通过不表示 Windows 执行通过。共用构建器可能加载仓库 `.env`，已核对隔离 worktree 没有该文件。 |
| Desktop 隔离范围 | 实际运行 Electron 39.2.7、Node 22.21.1 与正式 main/server/worker/renderer。测试 bootstrap 指定独立 home、appData、userData、logs、crashDumps 和任务 shell，禁止全局 URL handler 注册，未验系统协议注册或正式发布安装包。操作只针对任务窗口，未访问真实 WebUI、HOME、凭据、代理或 Craft 目录。 |
| Desktop 项目信任 | 项目设置故意声明 always，仍在导入前显示真实信任提示。批准前只有 global 插件加载，项目插件未加载且 MCP 启动次数为 0。通过真实 React select 的 change 选择仅会话信任，再点击 Continue，项目插件和 `.pi/mcp.json`、`.mkagent/mcp.json` 的两个本地服务加载。冷重开再次询问信任，批准后两类服务各累计启动 2 次，符合仅会话决定。选择使用受限任务 Unix socket 驱动 DOM，并非鼠标选择；实际选择画面已截图检查。 |
| Desktop 交互与历史 | 真实 confirm 获得按钮焦点，Escape 后返回 false。普通输入经本地模型显示回复，冷重开后回复仍在产品历史中，共 1 次模型请求。早期 capturePage 因窗口未置前取得旧帧，不计证据；测试 bootstrap 置前并等待绘制后取得有效信任选择和重开历史截图。 |
| 本批定向检查 | `interceptor-packaging-contract.test.ts` 为 1 项、3 项断言通过。两个构建入口、preload、renderer、diff 检查和 2142 份文件的隔离 Craft 来源审计通过；首次来源审计指出 package.json 摘要未更新，完成实际 diff 复核并更新来源摘要后通过。同类扫描未发现其他直接打包 main 入口的重复命令。另实际重跑 `validate:ci`，含全部类型检查、shared/doc-tools 测试及 i18n 检查，退出 0。完整仓库、lint、固定生成与消费者证据沿用前述未改动层记录，不冒充本批重跑。 |

证据位于任务目录的 `macos-acceptance/`：`powershell-result.json`、`tui-regular/result.json`、`tui-fullscreen/result.json`、`tui-mcp/result.json`、`tui-mcp/server-lifecycle.jsonl`、三个 TUI 目录的 PNG，以及 `desktop/metrics.json`、`desktop/project-trust.png` 和 `desktop/history-reopened.png`。Desktop 窗口已正常退出，任务本地服务已结束，三个 TUI 会话均已关闭；保留夹具、产物和日志用于复核。

该批结束时仍需 WebUI 项目信任专属画面、Windows 和正式 Desktop 发布安装包验收，SDK TUI 也仅覆盖本节列出的组合。原浏览器任务 7 已恰一次关闭，用户限定只用该任务，当时没有自行新建或重新占用；随后取得新任务授权并补验 WebUI，见下一节。密码遮罩仍只有 DOM 证据，未重试此前被拒的截图。

## WebUI 项目信任补充验收

用户明确授权唯一新隔离任务 `mkagent-durable-coding-trust-20261106`，实际编号为 8。只使用该任务的 p1，访问任务搬迁包的随机回环地址，配置、HOME、项目、服务与数据独立放在 `macos-acceptance/webui-trust/`。复用的搬迁包来自 `640aca6`，此后产品运行时未改；`846029f` 只修改 Electron 子包构建入口。

| 实际流程 | 证据 |
|---|---|
| 导入前信任提示 | 全局 ask、项目 settings 故意声明 always。真实 WebUI 仍显示项目信任 select；批准前 global 插件已加载，项目插件未加载，两个项目 MCP 均没有启动，模型请求为 0。 |
| 仅会话拒绝 | 实际选择 Do not trust (this session only)，再点击 Continue。项目插件保持未加载、两个 MCP 均未启动、两个项目命名空间没有工具。宿主原有 6 个会话工具正常保留，共 1 次本地模型请求。 |
| 新会话批准 | 新建真实 coding 会话后仍显示信任选择。选择 Trust (this session only)，再点击 Continue，项目插件加载，`.pi/mcp.json` 与 `.mkagent/mcp.json` 的两个服务各启动 1 次。实际通知 DOM 与工具快照均包含 `mcp__host__hello` 和 `mcp__native__hello`，合计 2 次本地模型请求。 |
| 可视证据 | `deny-selected.png`、`trust-selected.png` 和 `approved-tools.png` 已读取检查。选择项在像素画面中可见；批准后通知存在文字截断，不用该截图证明完整工具名称可读，名称另由通知 DOM 与 `tools.json` 确认。截图前检查没有 password 输入，未触及此前被拒的密码截图目标。 |
| 夹具与观察修正 | 首次路径守卫因 `/tmp` 与 `/private/tmp` 的字符串不同，在产品启动前终止，统一任务路径后启动。初次等待错误要求通知为 TRUST_TOOLS none，忽略了正确保留的宿主会话工具；改按两个项目命名空间核验后通过，无产品补丁。启动日志把 WebUI 地址固定打印为 0.0.0.0，实际用 lsof 核对监听为 127.0.0.1；这是既存日志显示差异，本批没有修改。 |

阶段结果为 `denied-result.json`、`result.json`、`metrics.json` 和 `tools.json`，均位于上述任务目录。任务 8 已恰一次等待 `finish({keep:[]})` 完成，不保留页面；随后只对该夹具服务发送 SIGTERM，收到正常退出回执。该批没有修改产品代码，验证文档通过中文标点和 diff 检查；沿用前述已通过的 CI 与代码层回归。

WebUI 项目信任画面的缺口已关闭。该批结束时，Windows、正式 Desktop 发布安装包及本节以外的 SDK TUI 组合仍未验收。Desktop 发布包后续进展见下一节，D3.6、D4 与 D6 继续保留进行中。

## macOS Desktop 发布包补充验收

本批从 `eaa214f` 的任务 worktree 构建，未修改产品代码。复用任务内已有依赖、Electron 39.2.7 分发和此前已验证的 preload/renderer，未重新冻结安装。main 在构建时设置 `MKAGENT_AUTO_UPDATE_ENABLED=false`，再通过 `electron:build:resources` 同步 worker 和资源，使用正式 electron-builder 配置生成 arm64 .app 与 ZIP。任务配置设置 `mac.identity=null`、`CSC_IDENTITY_AUTO_DISCOVERY=false`、`npmRebuild=false` 和 `--publish never`，不发现签名身份或发布产物。

| 范围 | 实际结果与边界 |
|---|---|
| 构建与资源 | main、资源同步、electron-builder 的 `--dir` 和 ZIP 均退出 0。ZIP 完整性检查通过，13 项关键文件在构建输出、原始 .app、原生副本与 ZIP 中摘要一致，另核对打包 worker 与最新 `packages/pi-agent-server/dist/index.js` 一致。coding-assets 有 9 份文件，Pi MIT 许可和三份 WASM 均在包内。 |
| 原生执行入口 | 副本实际执行 `Contents/MacOS/MkAgent`，进程分别为 33000、36576。运行时 `app.isPackaged=true`、`Boolean(process.defaultApp)=false`，appPath、resourcesPath、Bun 和 uv 均指向副本，未覆盖这些 packaged 路径。包内版本为 Bun 1.3.14、uv 0.13.7 和 rg 15.0.0；没有执行 `build-dmg.sh` 的下载与固定工具版本流程。 |
| 隔离副本 | 保留原始 .app/ZIP 的 `dist/main.cjs` 入口。测试副本改为包内相对 bootstrap，随后调用字节未改的 main；移除副本 URL 声明，抑制协议注册 API，并指定独立 HOME/config、appData、userData、logs、crashDumps 和任务 shell。仅用项目 entitlements 与 ad-hoc 身份签名，深层严格校验在运行前后均通过。 |
| 信任与 MCP | 全局 ask、项目 always。批准前全局插件已加载，项目插件未加载，两个 MCP 与模型请求均为 0。实际 select 选择仅会话信任并点击 Continue 后，项目插件及 `.pi/mcp.json`、`.mkagent/mcp.json` 的服务各启动 1 次，工具快照含 `mcp__native__hello` 与 `mcp__host__hello`。冷重开再次提示，重新批准前启动次数未增加，批准后各累计 2 次。操作由受限任务 socket 驱动 DOM 与键盘。 |
| 对话与冷恢复 | 实际输入经包内 worker 的 coding runtime 返回回复，产品头有有效 nativeSessionProjection。冷重开保持相同 nativeSessionId、投影摘要和唯一 assistant ID，DOM 与截图均保留输入和回复。有效验收共 2 次本地模型请求，自动标题与实际对话各 1 次；冷恢复、再次信任和插件确认没有增加模型请求。 |
| 确认取消 | 首次确认获得按钮焦点，Escape 后关闭；未保留取消通知，不据此断言返回值。冷重开前给测试插件增加结果落盘，再实际打开确认并按 Escape，文件记录 `confirmed=false`，模型请求仍为 2。 |
| 夹具错误修正 | 首次外置配置从根 cwd 解析 afterPack 失败，改在 Electron 项目 cwd 加载。macOS 截断 105 字节 socket 路径，改为任务内短路径。运行时设置自动更新变量无法覆盖构建时 define，改在构建时关闭。原生 bootstrap 的绝对 main 未到达测试入口，改用包内相对入口后启动。初次候选包还漏跑资源同步，staged worker 与新构建摘要不同，原生插件验收失败；补跑资源构建并加新鲜度断言后通过。旧包及其 1 次本地请求不计最终验收。 |
| 构建提示与限制 | 保留 CJS import.meta 警告、缺少 Assets.car 的图标回退、asar 关闭和原始包跳过签名提示。本批没有验证 DMG、正式证书签名、公证、Gatekeeper 安装、系统协议、自动更新、Windows 或全部插件，也没有新增浏览器任务或重试密码截图。 |

最终原始 ZIP 为 `macos-acceptance/desktop-release-final/MkAgent-0.2.6-arm64.zip`，186331171 字节，SHA-256 为 `4293b3c7e7d4d508f8dd9fca814084b0b1ee20afb254be047366447578cdefbc`。测试原生副本位于 `desktop-native-final/`；原始 ZIP 不包含测试 bootstrap，保持未签名。夹具及结果位于 `desktop-release-fixture/`，包括 `final-artifact-result.json`、`native-before-trust.json`、`native-approved.json`、`native-first-turn.json`、`native-reopened.json`、`native-cold-trust.json`、`native-confirm-result.json` 和 `native-final-result.json`。

`native-project-trust.png` 与 `native-history-reopened.png` 已读取检查，冷重开截图前 DOM 的 password 输入数为 0。原生两次运行均正常退出 0，任务本地服务已收到 SIGTERM 退出回执。本批重跑产物与选定原生流程，文档另经中文标点和 diff 检查；CI、全仓回归、lint 与来源审计沿用前述未改动层证据，未冒充本批重跑。D3.6、D4 与 D6 继续进行。

## 验证与完成规则

每个结果记录对应提交或工作树、命令、退出状态、实际触发路径及限制。先核实测试所保护的产品或公开插件契约，再实施 SDK 接入和必要适配；同步受影响调用方和测试。权限、取消、错误传播、接受队列、完整结果及恢复是行为保证，私有状态机和反射布局须有需求依据。

按改动影响执行 coding/host、MkAgent 产品和仓库检查、插件对照、独立消费者及声明/bundle/资源验证。沿用证据和新结果分开记录。仅改文档时运行链接、一致性、标点、diff 及独立文档复核，不重跑无关产品用例，也不将旧 CI 记为本批通过。

以下段落保存 2026-11-08 文档纠偏前的分批检查，包含当时的开放项。以 `cb0311f` 为准的运行时清单为 248 份 TypeScript、7 项资源；9 项和 8 项均属较早阶段。第三方 browser 包结果不属于 Pi 官方 SDK 复用的验收。

用户已撤销本地及锁定上游的源码禁读，并授权在指定目录、正常 HOME 和网络环境执行完整检查。完整运行时生成检查现已通过，覆盖 248 份 TypeScript 和 9 项资源；全量 Craft 审计使用独立固定版本副本。此前工具路径保护拒绝查看 `runtime-credentials.ts`；2026-11-08 续接会话已正常取得正文并核查保留依据，三文件模型与凭据回归为 28 项、136 个断言通过。随后将 HTML 色表及换算交给公开 pi-tui，源码净减 36 行、生成规则增加 30 行，未新增依赖或 SDK 补丁；辅助生成器删除旧路径排除；九个已替换算法正文不再绑定生成摘要，声明及策略常量检查仍保留，37 项新检查在 Bun、Node 下通过，两套完整复现确认产物不变，56 项现有 Native 行为测试通过。最终九文件组合通过 127 项，另有 56 项 Native 行为测试，Node 两份新测试共 51 项通过；完整 CI、lint、SDK 声明和 worker 构建通过。生成器变量分支的 P2 已用三项回归先复现再修正，同一审阅器确认原种类及摘要检查仍生效；最终八个明确类型根、两套复现及 2230 文件 Craft 审计通过。全仓首轮主批 3 项和隔离批 2 项失败，已用合成 RTK 配置和模型列表做对照；完整临时应用配置重跑的主批 6768 项、隔离批 300 项通过，另有 11 项跳过、0 失败，运行器退出 0，首轮失败保留在[验证记录](coding-validation.md)。`8b1c98f` 的 7016 项旧全仓记录、原版插件对照和 Desktop/headless 产品交互保留原范围；旧凭据路径拒绝已解除。最后十个 CLI/TUI helper 的公开接口对照未确认有净维护收益的新替代，十一组内存夹具的 128 项断言通过；theme-tokens 首段读取在当时被工具策略拒绝，完整主题配色表仍未逐项核实，F1/F3 的完整闭包必要性核查保持开放。2026-11-09 的只读诊断在全局配置发现覆盖该文件名的 `Read(*token*)`；历史拒绝不能作为用户明确禁读该源码的证据。同日按用户要求增加项目单文件 Read allow 后，正常读取仍被全局 deny 拒绝。全部 workspace 的隔离冻结依赖安装及 34 份 SDK 补丁产物核对通过，未包含运行时源码或安装脚本；完整主题表、生成和 Craft 审计仍开放，详见[验证记录](coding-validation.md#project-read-rule-and-workspace-install-after-731728a)。

提交 `a2c5fe6` 后，继续将 StringEnum 和 calculateContextTokens 的已替换正文从完整摘要改为精确声明头检查，保留函数种类、export、泛型、参数、返回类型、TypeBox 标记和重复声明保护；模型存储类保留完整摘要。两项正文变更回归先红后绿，生成测试现为 49 项通过，Bun 五文件 80 项、Node 两份可移植文件 63 项通过。完整运行时及辅助复现、2230 文件审计、八个明确类型根和新一轮 CI 通过；生成产物、来源清单及 SDK 补丁未变。规则净增 9 行、回归文件净增 72 行，收益限于解除两项废弃正文的升级哈希耦合，未据此重跑全仓或产品交互。

`ac45375` 后继续删除 HTML 的 Markdown 源码副本，直接声明已有的 `marked@18.0.11`，读取公开包元数据中的 browser 入口。去掉 source map 注释后的 44,640 字节与锁定 Native 完全一致；15 行外部适配及发布资源保持离线导出，模板与 CJK 配置不变。运行时清单现为 248 份 TypeScript、8 项资源，早前 9 项资源的记录保留历史范围。Bun 三文件 73 项、Node 两文件 24 项、完整 server 构建、CI、八个明确类型根及两套来源复现通过；禁止网络和读取 workspace 依赖目录的搬迁产物完成真实 SessionManager 导出与 CJK 渲染。夹具的两次失败及修正见[验证记录](coding-validation.md)。本批未重跑全仓、lint 或产品交互，F1/F3 保持开放。

`f6c44c7` 后继续删除 HTML 的 121,727 字节高亮副本，改用同版本、同字节的官方 `@highlightjs/cdn-assets@11.9.0` browser 资源。现有服务端 `highlight.js@10.7.3` 版本不同，新增包没有运行时依赖，其他锁定版本未变。Markdown 与高亮共用 22 行资源适配，累计删除 166,367 字节副本；生成规则同时保护两条资源读取，打包高亮资源附完整 BSD 许可注释。最新来源为 248 份 TypeScript、7 项资源。Bun 四文件 83 项、Node 三文件 34 项、完整 server 构建、本地 CI、九个明确类型根、两套来源复现及 2231 文件 Craft 审计通过。禁止网络和读取 workspace 依赖目录的搬迁产物完成两条真实 HTML 导出，最终脚本保留 CJK 渲染与 36 种语言；去掉新增许可注释后与原资源基线相同。首个逐字嵌入断言的修正及独立复核结果见[验证记录](coding-validation.md)。本批未重跑全仓、lint、Desktop 或 headless 产品交互，F1/F3 仍开放。

平台或交互环境不能实际运行时，明确列为受阻，并给出可执行的验收步骤。不能用单元或协议测试替代已经要求的产品交互验收，也不能仅因测试受阻就声称功能不存在。

直接在用户指定工作目录验证，不默认另建 worktree、更改主进程 HOME 或启用网络沙箱。测试数据和 config 使用临时夹具，恢复及原版对照测试保留其自身的子进程隔离。不接触真实 WebUI `127.0.0.1:9100`、真实凭据、代理和真实 Craft 参考目录，不使用付费模型。浏览器按用户明确授权的任务名称与归属核对，不能依据旧编号借用其他空间；已关闭的任务 7、8 不再使用。

按既有授权创建本地原子提交；依据最新任务要求，全部任务完成、必要检查通过后再统一普通推送，此前不 push。不创建 PR 或 issue、不 merge、不发对外消息。涉及危险旧 checkpoint 时保留数据并明确诊断，迁移与回退都必须有相应版本和事务边界，不能静默丢弃工作。
