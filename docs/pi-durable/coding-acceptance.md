# Pi-durable coding agent 需求与纠偏验收对照

本表对应[能力规格](coding-capabilities-spec.md)和[实施计划](durable-coding-agent-plan.md)。第一次将 Pi coding agent 直接换成 durable 后，出现 Coding 能力和插件生态缺口。2026-11-08 用户补充明确：以切换前的 MkAgent 为行为和接入边界参照，保留 Pi coding agent 的 Coding 层及插件契约，尝试将其底层执行基座换成 pi-durable。MkAgent 既有整体架构、宿主职责、后续有效功能与数据保持；文档纠偏已提交于 `552b938`，当前已实施宿主工具的公开 ToolTask、请求执行的本地 SDK 扩展及插件 edit 参数的公开 SDK 复用切片，其余纠偏继续推进。

执行侧优先用 durable 内置实现，其余所需能力优先引用独立 Pi 官方 SDK，再做必要薄适配及有具体缺口依据的源码处理。此前大量复制和改造上游源码造成的升级维护风险属于本次验收范围：Coding 和 durable 更新时，核对工作应主要集中在 SDK 契约和少量必要适配。正式发布接口、仓内补丁和源码生成分开记账，第三方资源去重及源码可复现不能代替这一要求。

功能状态使用“已实现且验证”“已实现待验证”“待实现”“外部环境受阻”；其中“已实现且验证”仅限注明的版本和路径。本次架构纠偏另记待核对、待实施及验证状态，不能用历史功能通过来关闭架构问题。详细命令、失败修正和证据版本见[验证记录](coding-validation.md)，顺序见[纠偏跟进](coding-follow-up.md)。

## 架构与交付约束

| 要求 | 本次纠偏状态 | 实际依据及剩余工作 |
|---|---|---|
| 文档先行 | 本批补充校正与复核已完成 | 此前三批证据限定于 `1314a2b`、`56d0f46` 和 `301598c`；本批 24 份文档增加 Pi Coding 层目标、切换前参照和升级维护条件，链接、标点及独立语义复核结果单列于验证记录。F1 至 F3 继续开放 |
| MkAgent 继续使用 Pi Coding 层，durable 替换其执行基座 | 目标已明确，首个工具切片已接入 | `b77c4a2645d3` 的 worker 直接使用 Coding SDK，作为原始行为和接入参照；当前宿主及公开 Agent/runToolCall 的普通工具均使用 Pi 1.5.0 的公开 ToolTask phases/abort，其他 SDK 接线继续核对，保留后续有效功能和数据 |
| pi-durable 为执行底座 | 工具执行已委托，请求已接入本地 SDK 扩展 | 普通 profile 使用 GenerationTask；coding 主链仍由五种 `pi.coding.*` v1 调度。宿主执行使用公开 ToolTask，请求/partial 使用仓内新增 GenerationResponseTask 并复用 streamResponse。Native 保留插件交付、工具轮次和收尾，SDK receipt、journal 与下一 checkpoint 同事务提交；其余职责继续评估 |
| 内置能力优先，再用独立 Pi 官方 SDK | 部分已实现，继续纠偏 | 生产工具工厂、images、codemode、tool-search 已用 durable；本轮另将宿主执行委托公开 ToolTask 并删除旧嵌套调用副本。SDK 根路径、插件工厂和其余任务分别核查，不能把工具切片等同于整个适配包已符合原则 |
| 允许 pi-agent-core，禁止完整 pi-coding-agent 生产依赖 | 已有依赖符合，补丁待核对 | 独立 core 已使用；八个操作导出和 Agent 注入由四文件仓内补丁增加。durable 的 Coding hooks 和其他扩展也须作为本地修改评估，不能写成未修改发布包的能力 |
| 保留 Pi Coding 层，仅适配执行基座及必要宿主差异 | 已收窄启动器范围，其余继续核对 | 排除原版 CLI 的 `main`/`MainOptions` 及 24 份独占源码；MkAgent 使用 `CodingHost/createAgentSession`，程序化运行模式和插件组件保留。该删除不代表这些文件已被官方 SDK 替换，也不证明剩余源码全部必要 |
| 兼容逻辑尽量薄 | 已共用 loader 生命周期，其余继续核对 | 两个 loader 的 runtime、注册 API 和 factory 接受/回滚共用本地实现，旧产物由 631 行减至 235 行；模块映射、缓存和目录策略独立。其余按确认的契约记录候选发布 API、缺口、适配、升级和恢复影响，局部原版对照不构成整块永久保留依据 |
| 上游升级主要核对 SDK 契约与必要适配 | 待实施和验证 | 合并检查源码副本、生成转换及依赖补丁；每项例外有具体缺口、退出条件和 Coding/durable 升级检查。不能把逐文件改造完整闭包作为常规升级方式，也不承诺当前已能只改版本号升级 |
| MkAgent 上层与插件不回归 | 历史行为有证据，按实际改动重验 | 下列能力和产品清单继续有效；不能为减少源码削减权限、取消、错误处理、持久化、恢复或已确认公开插件行为 |
| 存量数据及任务兼容 | 工具切片已验证，其他替换待实施 | 五种 `pi.coding.*` 仍为 v1；旧工具 checkpoint 保持原恢复路径，新 SDK 文档覆盖 safe/unsafe 策略变化、已完成结果与工具移除后的 SIGKILL 恢复。其余 generation/tool checkpoint 及 summary 的已完成响应、不确定请求和取消继续纳入后续接线验证，不自动重发不安全副作用。 |
| 独立模块和消费者 | 历史验证通过，按接口变化重验 | coding 包不依赖 MkAgent shared/server/UI；`a41e6b5` 独立消费者覆盖六个运行时入口和 rpc-ui 类型。后续入口调整须同步声明、调用方及实际消费者 |
| 来源与许可 | 已同步本批范围，完整重生成未重跑 | 当前清单为 224 份 TypeScript、7 项资源，`cb0311f` 的 `248/7` 保留历史时点；辅助为 12 项来源和 28 个共享入口。本批两个 loader 的固定上游定向转换通过，共享声明的缺失和重复拒绝检查通过，清单摘要已同步；数量、哈希和局部复现不证明架构最小或功能完整 |
| profile 与信任隔离 | 历史验证通过，持续保留 | 普通 profile/host-only 不自动加载环境 Pi 资源；项目执行导入前经过宿主决定，工具继续走既有审批 |

既有源码对照、图像和 codemode 共享及 core 门面改动保留[架构记录](coding-architecture.md)和验证账本中的证据。宿主工具执行已委托官方 ToolTask 并删除旧嵌套副本；请求执行与 partial 已接入仓内新增 GenerationResponseTask。工具轮次与收尾的发布接口缺口已按实际写入和结算职责记录，未新增补丁；插件 edit 参数转换已直接复用公开 SDK 并删除副本。公开 Agent/runToolCall 的普通 AgentTool 也已委托同一个 SDK 桥，保留权限改参、取消与最终参数回执；AgentSession 转换不再丢失桥接标记。summary 并发进度隔离已有回归，session/summary 的 API 缺口及退出条件已记录，尚未替换这些任务。完整 Coding 闭包继续核对，未证明整套桥永久必要。F1 至 F3 继续开放。

## 能力规格逐行对照

下表保留截至 `cb0311f` 前各批行为证据。主要产品基线为 `a41e6b5`、`9965789`、`640aca6`，后续 `8b1c98f` 及源码共享批次范围见验证记录。本轮 ToolTask 的定向行为、恢复、类型和构建检查单列于验证记录，未重跑全仓及下表所有历史组合；各行“已实现且验证”不代表当前所有插件、平台或组合通过。

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

文档校正已提交，宿主工具与请求切片已完成各自的定向验证；工具轮次和收尾已记录发布接口缺口，edit 参数副本已删除并验证公开 SDK 接线。后续按已记录的 API 缺口继续 session/summary 替代与 Coding 闭包的必要性核对；公开 Agent/runToolCall 的普通工具已复用 SDK，低层自供执行函数的 task fixture 不属于此保证。每项架构改动同时迁移调用方、数据和测试，以真实行为验证，而非只检查函数转发或文件哈希。既有读取确认、PowerShell、setup 历史、分支发布和作用域修复不得因换实现回退。

当前 `224/7` 只是源码清单。已排除 CLI 启动器，原 `248/7` 保留为历史时点。既有 SDK、插件、图像和资源对照的范围及未验项仍见验证账本；`theme-tokens.ts` 的首段读取被工具策略拒绝，完整 token 表未逐项核实，不绕过该限制。

历史浏览器任务 7 和 8 已各自关闭，不构成本次新访问授权。Windows、正式签名公证、系统协议和其他 TUI 组合保留其证据缺口，不能借文档修订记为完成。文档本批的链接、一致性、标点及独立复核结果单独记录，产品和全仓旧结果不算本批重跑。
