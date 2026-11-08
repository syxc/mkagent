# Pi-durable coding agent 需求与纠偏验收对照

本表对应[能力规格](coding-capabilities-spec.md)和[实施计划](durable-coding-agent-plan.md)。2026-11-08 用户要求先全面纠正文档，再逐项落实迁移纠偏：以已有较完整的 pi-durable 为底座，补齐 Coding 能力和 Pi 插件生态，保留 MkAgent 上层功能。

能力选择顺序为 pi-durable 内置实现、独立 Pi 官方 SDK 公开 API、必要薄适配、经具体缺口论证的源码处理。Pi 正式发布接口和仓内补丁分开验收，第三方资源去重不代替官方 SDK 复用。当前完整 Native SDK、自有状态机、原版 CLI 和旧实现测试不自动成为需求。

功能状态使用“已实现且验证”“已实现待验证”“待实现”“外部环境受阻”；其中“已实现且验证”仅限注明的版本和路径。本次架构纠偏另记待核对、待实施及验证状态，不能用历史功能通过来关闭架构问题。详细命令、失败修正和证据版本见[验证记录](coding-validation.md)，顺序见[纠偏跟进](coding-follow-up.md)。

## 架构与交付约束

| 要求 | 本次纠偏状态 | 实际依据及剩余工作 |
|---|---|---|
| 文档先行 | 本批已完成校正与复核 | 20 份文档统一背景与 Pi 官方 SDK 顺序；191 个本地链接、新增文字标点及七份核心文档独立复核通过，HTML 内联脚本静态语法通过。产品测试未在本批重跑，F1 至 F3 继续开放 |
| pi-durable 为执行底座 | 已有实现，职责待核对 | 普通 profile 使用 GenerationTask，coding 使用 `pi.coding.session/run/call/tool`。它们使用同一 scheduler，但本地仍有请求、工具及结束状态机；须优先核对官方执行器接入和必要差异 |
| 内置能力优先，再用独立 Pi 官方 SDK | 部分已实现，继续纠偏 | 生产 read/write/edit/bash/PowerShell、images、codemode、tool-search 已用 durable。SDK 根路径、插件工厂和自有任务分别核查，不能把生产工具已复用等同于整个适配包已符合原则 |
| 允许 pi-agent-core，禁止完整 pi-coding-agent 生产依赖 | 已有依赖符合，补丁待核对 | 独立 core 已使用；八个操作导出和 Agent 注入由四文件仓内补丁增加。durable 的 Coding hooks 和其他扩展也须作为本地修改评估，不能写成未修改发布包的能力 |
| 仅补缺失 Coding 与插件能力 | 待核对和实施 | 从实际产品、公开插件和数据兼容需求推导必要范围；完整 SDK 闭包和原版 CLI 的可达性不证明必要，删除前也须核对调用和替代方式 |
| 兼容逻辑尽量薄 | 待核对和实施 | 按确认的契约记录候选发布 API、缺口、适配、升级和恢复影响。原型、getter 或私有阶段差异先核实需求，局部原版对照不构成整块永久保留依据 |
| MkAgent 上层与插件不回归 | 历史行为有证据，按实际改动重验 | 下列能力和产品清单继续有效；不能为减少源码削减权限、取消、错误处理、持久化、恢复或已确认公开插件行为 |
| 存量数据及任务兼容 | 当前实现有证据，替换方案待验证 | `pi.coding.{session,run,call,tool,summary}` 五种 v1 及历史 generation/tool checkpoint 有实际恢复调用方，须显式迁移或兼容。summary 的压缩/分支/bug report 已完成响应与不确定请求均纳入检查，不自动重发不安全或不确定副作用。 |
| 独立模块和消费者 | 历史验证通过，按接口变化重验 | coding 包不依赖 MkAgent shared/server/UI；`a41e6b5` 独立消费者覆盖六个运行时入口和 rpc-ui 类型。后续入口调整须同步声明、调用方及实际消费者 |
| 来源与许可 | 既有清单可复现，按改动同步 | `cb0311f` 清单为 248 份 TypeScript、7 项资源，辅助为 12 项来源和 28 个共享入口。数量、哈希、冻结安装及来源审计证明各自范围，不证明架构最小或功能完整 |
| profile 与信任隔离 | 历史验证通过，持续保留 | 普通 profile/host-only 不自动加载环境 Pi 资源；项目执行导入前经过宿主决定，工具继续走既有审批 |

既有源码对照、图像和 codemode 共享及 core 门面改动保留[架构记录](coding-architecture.md)和验证账本中的证据。四类任务桥的独立核查尚未给出完成的官方主链替代方案，也未证明整套桥永久必要。F1 至 F3 继续开放。

## 能力规格逐行对照

下表保留截至 `cb0311f` 前各批行为证据。主要产品基线为 `a41e6b5`、`9965789`、`640aca6`，后续 `8b1c98f` 及源码共享批次范围见验证记录。本次文档修订未重跑产品或全仓测试；各行“已实现且验证”不代表当前所有插件、平台或组合通过。

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

先完成本次文档校正，再从官方执行主链和必要 Coding 差异开始落实。每项架构改动同时迁移调用方、数据和测试，以真实行为验证，而非只检查函数转发或文件哈希。既有读取确认、PowerShell、setup 历史、分支发布和作用域修复不得因换实现回退。

当前 `248/7` 只是源码清单。既有 SDK、插件、图像和资源对照的范围及未验项仍见验证账本；`theme-tokens.ts` 的首段读取被工具策略拒绝，完整 token 表未逐项核实，不绕过该限制。

历史浏览器任务 7 和 8 已各自关闭，不构成本次新访问授权。Windows、正式签名公证、系统协议和其他 TUI 组合保留其证据缺口，不能借文档修订记为完成。文档本批的链接、一致性、标点及独立复核结果单独记录，产品和全仓旧结果不算本批重跑。
