# 内核迁移审查问题修复规格

历史范围说明：本文记录下列基线上的 R1 至 R8 修复及 2026-11-02 集成验收。下文的状态、执行授权、测试结果与限制只适用于当时，不代表本轮授权或当前架构。后续迁移目标与限制以[能力规格](coding-capabilities-spec.md)和[实施计划](durable-coding-agent-plan.md)为准；历史失败与未验证边界仍保留。

当前背景（2026-11-08）：MkAgent 从 `pi-coding-agent` 迁向功能已较完整的 `pi-durable`，在 durable 之上补齐 Coding 能力和 Pi 插件生态，保持 MkAgent 全部既有功能完整正常。先采用 durable 内置能力，再用独立 Pi 官方 SDK 的公开 API；只有具体缺口得到论证后才保留薄适配或必要源码。允许按需引用 `pi-agent-core`，生产不得依赖或加载完整 `pi-coding-agent` 包。旧依赖禁令、宿主零改动要求和功能缩水许可不再约束本轮实现。第三方资源替换、删行数和复制原版 CLI 的完整源码闭包均不是迁移目标；当前自有任务桥仍须按真实契约审查。

基线：`57923f2c5c049c139cfd7a0435dea40ea2a1c658`。
状态：R1-R8 已按顺序完成，联合独立复核通过，已集成主工作区并通过下述约定验收。根据用户后续授权，按修复边界原子提交，不推送。
范围：本次审查确认的六项代码问题，以及缓存测试环境依赖、图片生成文档矛盾。保持已有工具、会话迁移、分支、导入导出和缓存预热功能，不删除功能规避问题。实施与验收阶段不提交、不推送；后续提交按用户另行授权执行。不调用真实模型或外部下载服务。

## 1. 执行顺序与交付规则

| 顺序 | 编号 | 优先级 | 问题 |
|---|---|---|---|
| 1 | R1 | P1 | 分支预检恢复活动 JSONL 父库，造成数据损坏 |
| 2 | R2 | P1 | 分支副本恢复并执行截止点之后的父任务 |
| 3 | R3 | P2 | 导出跟随 durable-store 根符号链接 |
| 4 | R4 | P2 | 工具取消后仍下载和安装二进制 |
| 5 | R5 | P2 | 失败或取消的预热响应漏记实际用量 |
| 6 | R6 | P2 | 内核关闭未等待预热用量入账 |
| 7 | R7 | P2 | 缓存测试受外部 retention 环境影响 |
| 8 | R8 | P3 | 中英文 README 错称不支持图片生成 |

按 R1 至 R8 串行实施，每项先建立能在未修复代码上失败的回归测试，再修复并执行该项验收。文档项使用事实核对和文本检查。每完成一项，报告修改内容、验证结果和未覆盖部分；不把下一项未完成的问题算入当前项成功证明。

为避免主工作区半成品，可在独立 worktree 实施；主会话维护本规格、逐项复核并在全部修复通过后集成。不得改写用户已有改动。实现发现必须调整方案时，先更新本规格并说明理由，不能降低验收标准。

## 2. R1：保护活动 JSONL 父库

- 优先级：P1，数据损坏风险。
- 问题描述：`migrateParentStore()` 调用 `openDurableStorage()` 时，JSONL storage 的 recovery 已经可能截断另一个写者尚未提交标记的 sidecar。随后检查任务状态不能撤销该损坏。
- 修复目标：分支预检对已有 durable 父库不执行 recovery，不修改父库内容；未打开过的 legacy 会话仍可迁移并分支，部分迁移仍可在子副本补全。
- 具体修改方案：在打开 storage 前识别已存在的 durable backend，已有库直接交由分支快照路径处理。保留只有 legacy transcript、没有 durable backend 时的转换路径。复用 `kernel.open()` 已有的子副本 `migrateLegacySession()`，不要用 `id-map.json` 是否存在判断迁移是否完整。更新过时注释及受此行为影响的测试。
- 影响范围：`packages/pi-agent-server/src/migrate.ts`、`migrate.test.ts`、分支相关 `kernel.e2e.test.ts`；必要时调整 `kernel.ts` 的子副本迁移调用。不改存储格式。
- 验收标准：
  - R1-A：在真实 JSONL commit 的 sidecar 写入后、main marker 写入前暂停写者，运行分支预检，sidecar 字节不变；释放写者后父库可重新打开且新提交仍在。
  - R1-B：父库为 SQLite 或 JSONL、迁移完整或不完整时，预检不恢复父任务、不改写父库；子副本能补全所需迁移及锚点映射。
  - R1-C：纯 legacy 分支、迁移中断恢复、旧锚点解析相关既有测试继续通过。

## 3. R2：隔离分支历史与父会话活动任务

- 优先级：P1，意外执行与额外模型消费风险。
- 问题描述：复制完整 store 后，`openStore()` 调用 `harness.resume()`，父会话未完成的任务和排队输入进入子进程调度；历史 fork 截止点不会撤销这些任务。
- 修复目标：创建分支只继承指定历史，不继承父会话的执行队列；没有新输入时不调用模型或工具，重开分支亦如此。父会话继续运行不受影响。
- 具体修改方案：区分正常恢复与首次分支初始化。在分支副本尚未启动调度时，使用 SDK 的非调度存储或事务接口终结继承的可运行任务、撤回未处理 submissions，并处理相应运行态文档；随后完成迁移、锚点 fork 和 watch 附着，再启用调度。不得仅把 `resume()` 后移后就保留父任务，也不得调用会隐式调度的取消接口。普通会话恢复仍保留原有恢复语义，不用全局禁用 resume 修复。
- 影响范围：`packages/pi-agent-server/src/kernel.ts`、对应分支和恢复测试；必要的最小存储辅助逻辑。核对 `SessionManager.createSession()` 调用边界，但不改变用户 API。
- 验收标准：
  - R2-A：真实 SQLite/Harness，父会话第二轮仍活动时分支到第一轮锚点；子会话在没有输入时模型调用数和工具执行数均为零。
  - R2-B：父会话有排队输入或待执行工具时，子副本及其重开不会执行继承工作。
  - R2-C：子会话提交新输入后可正常完成模型和工具循环，其模型上下文不含截止点之后的父输入；父会话可正常完成原任务。
  - R2-D：正常非分支的中断恢复、已存在分支重开、无效锚点回滚和 pending 标记保护测试通过。

## 4. R3：拒绝会话外的 durable-store 链接

- 优先级：P2，跨会话数据泄露风险。
- 问题描述：特殊导出路径直接读取 `durable-store`，只检查子项是否普通文件，未检查根目录本身是否 symlink，绕开通用收集器的链接排除规则。
- 修复目标：符号链接或非目录 store 不得进入导出，导出不能包含链接目标的会话外内容。
- 具体修改方案：在 durable 导出入口对根路径执行 `lstat`，拒绝 symlink 和非目录；确保 serializer 对正常链接、悬空链接和异常格式均失败关闭，不静默输出缺失历史的成功 bundle。保持现有子文件限制、快照及密码脱敏逻辑。
- 影响范围：`packages/shared/src/sessions/bundle.ts`、`durable-bundle.ts`、`sessions/__tests__/bundle.test.ts`。
- 验收标准：
  - R3-A：指向合成外部 JSONL/SQLite store 的根 symlink 导出返回失败，外部标记不进入任何 bundle。
  - R3-B：悬空 symlink、根普通文件、内部 symlink 均拒绝；没有 durable store 的普通旧会话仍可导出。
  - R3-C：普通 JSONL、SQLite/WAL 导出与密码脱敏、导入恢复测试通过。

## 5. R4：将二进制获取纳入工具取消生命周期

- 优先级：P2，取消失效及取消后写入风险。
- 问题描述：`grep`/`find` 的取消信号未传入 resolver 和下载器。取消后 grep 仍等待网络，find 虽返回但后台继续下载、解压及安装。
- 修复目标：取消中断版本查询、下载和流读取；已取消调用不能发布二进制，不影响正常缓存、PATH、bundled fallback 或离线模式。
- 具体修改方案：把可选 `AbortSignal` 从工具传至 resolver、manager、版本查询和下载；复用 `fetchWithRetry` 的 caller cancellation。处理流读取取消、监听器释放和临时目录清理；解压及 rename 发布前再次检查信号。取消不得被“工具不可用”的回退吞掉。若存在共享下载，只在确有实现时明确其调用者归属，不新增无需求的共享管理层。
- 影响范围：`tools/local/grep.ts`、`find.ts`、`tool-binaries.ts`、必要的 `management-http.ts` 调用边界及 `tool-binaries.test.ts`。
- 验收标准：
  - R4-A：fake fetch 在版本查询或下载阶段等待，取消后 fetch signal 被中止，grep/find 均及时结束。
  - R4-B：下载 body 被暂停时取消，读取结束、临时文件清理、目标 bin 不存在；取消后释放原 gate 仍不能安装。
  - R4-C：未取消的 fake archive 正常安装；缓存、PATH、bundled rg、PI_OFFLINE 和现有平台解压测试通过。

## 6. R5：完整记录预热响应用量

- 优先级：P2，用量账本不完整。
- 问题描述：预热返回 `error` 或 `aborted` 时，在写 UsageDoc 和 `mkagent.usage` 前提前返回，忽略已经取得的非零 usage。
- 修复目标：有实际用量的响应，无论结束原因，均准确且只记录一次；不为尚未返回用量的请求凭空计费。
- 具体修改方案：将账本更新置于结束原因判断之前，复用现有汇总结构，保留失败预热不干扰主会话的行为。使用返回值中的 usage，不估算已经取消但未返回的用量。
- 影响范围：`cache-warmer.ts`、针对该模块的回归测试；必要时复用 kernel 测试 provider。
- 验收标准：
  - R5-A：相同非零 usage 的 stop/error/aborted 响应，UsageDoc 与用量 entry 均准确记录一次。
  - R5-B：无响应的异常不产生虚构消费；零用量不增加费用。
  - R5-C：正常预热、累计费用、取消后不再次调度的行为不回归。

## 7. R6：关闭前完成预热收尾

- 优先级：P2，关闭竞态导致用量丢失。
- 问题描述：`stop()` 只取消当前 controller；Harness 先关闭，迟到响应的账本提交失败被吞掉。
- 修复目标：在途预热，包括被新 capture 替换的旧请求，在内核关闭前完成取消及已返回用量的持久化；不继续发起预热。
- 具体修改方案：跟踪实际在途 refresh Promise；区分同步停止调度与异步等待收尾，关闭时先停止、取消并等待所有在途请求，再关闭 Harness。普通 capture/stop 不阻塞主对话；不要只等待 current，因为它可能已被替换。失败收尾不得留下未处理 rejection。
- 影响范围：`cache-warmer.ts`、`kernel.close()`、相关生命周期测试；核对 re-init 调用 close 的路径。
- 验收标准：
  - R6-A：真实 SQLite，预热在途时 close，确认 signal 已 abort，释放有 usage 的迟到响应后 close 才结束；重开账本能读到该用量且不重复。
  - R6-B：被新请求替换的旧 refresh 也被等待；关闭期间不再发送新预热请求。
  - R6-C：无在途请求、请求失败、反复 stop/close 的正常收尾不悬挂、不产生未处理 rejection；主对话和手动压缩关闭测试通过。

## 8. R7：隔离缓存测试环境

- 优先级：P2，验收门禁不稳定。
- 问题描述：缓存 fixture 仅声明 short TTL，但会继承宿主 `PI_CACHE_RETENTION=long`，导致同一提交在不同环境产生不同测试结果。
- 修复目标：测试显式控制所依赖的 retention，执行结束恢复原环境；不修改产品默认行为。
- 具体修改方案：在缓存测试 fixture 内固定适用的 retention，或让 fixture 明确覆盖 short/long；所有环境修改在 finally/afterEach 恢复。不得依赖开发者手动更改 shell 环境。
- 影响范围：`kernel.e2e.test.ts` 的缓存 fixture 与新增缓存测试。
- 验收标准：R7-A：从外部设置 short、long 和未设置三种环境运行缓存相关测试，结果均通过；显式产品 long/none 行为测试不被隐藏或删除。

## 9. R8：同步图片生成能力说明

- 优先级：P3，文档矛盾。
- 问题描述：中英文 README 仍将图片生成列为缺失能力，与已暴露的 codemode `models.generateImages()` 及 architecture 文档不符。
- 修复目标：中英文明确同一能力边界，不声称已有独立图片生成 UI。
- 具体修改方案：调整两处 README 的否定表述，说明启用 codemode 且有兼容图片模型及凭据时可调用图片生成；核对 architecture 和 comparison 的相关表述。同时校正 R2 复核发现的 kernel 顶部迁移时机注释，更新原迁移规格中受 R1、R2、R5、R6 改动影响的落地说明，不改历史设计段落。
- 影响范围：`docs/README.md`、`docs/zh/README.md`、`docs/pi-durable/kernel-durable-switch-spec.md` 的落地说明，以及 `kernel.ts` 顶部注释。此补充只同步本次修复直接涉及的事实，不扩展功能。
- 验收标准：R8-A：中英文语义一致，与注册代码及 architecture 说明一致，不保留本次涉及的相互矛盾描述。

## 10. 最终验收

全部问题完成后，在集成后的同一工作树执行：

1. 按 R1-A 至 R8-A 的清单逐项核对测试和证据，不用类型检查代替运行时测试。
2. `bun run typecheck:all`、`bun run test:shared:all`。
3. pi-agent-server 全测试及受影响 shared bundle、宿主事件和进程生命周期测试；遵守仓库测试隔离要求。网络阻断 fixture 只允许本地 mock，不使用真实 provider、凭据或下载服务。
4. 对完整修复 diff 做独立复核，复核发现的问题修正后重新执行受影响验收。
5. 同步 `scripts/craft-source-overrides.json` 的任务内文件 hash 和来源理由，运行可用的来源审计、测试覆盖检查及 `git diff --check`。
6. 输出逐项通过、失败或阻塞的验收表，列明未执行层级。真实 Electron、跨平台最终发布包和真实 provider 不在本次验收承诺内；不得据离线测试宣称这些层级已经通过。

## 11. 实施与验收记录

本节由主会话维护。局部通过不等于最终集成验收通过。

### R1

- 修改：`migrate.ts` 在打开 storage 前识别已有 JSONL/SQLite backend，已有父库不再进入 recovery。删去已不需要的父库迁移补写逻辑；子副本仍使用现有迁移入口补全。
- 回归：`migrate.test.ts` 增加真实 sidecar-before-marker gate，以及 16 项 backend、迁移完整度、任务状态和 id-map 状态组合；`kernel.e2e.test.ts` 覆盖 8 项子副本迁移与锚点场景。
- 红绿验证：未修复实现分别产生 14 项迁移测试失败和 6 项分支测试失败；修复后迁移 35 项、相关 kernel 25 项通过，包类型检查通过。主会话另跑 17 项父库保护检查，全部通过。
- 证据：`/tmp/mkagent-r1-evidence-MMoSRE/`；主会话日志 `/tmp/mkagent-r1-master-tests.log`。
- 状态：R1-A、R1-B、R1-C 通过局部、独立复核及最终集成验收。

### R2

- 修改：`kernel.ts` 对首次分支副本先清理继承执行队列，再打开 Harness；迁移、fork、watch 和配置完成后才 resume。新增 53 行 `storage/branch-storage.ts`，通过 Storage 原子提交终结所有非终态任务、撤回排队输入并退休运行态文档，不执行任务或 abort handler。
- 回归：`kernel.e2e.test.ts` 新增 SQLite/JSONL 的活动 generation、排队输入、运行和待执行工具、跨分页任务、重开分支与普通恢复对照。
- 红绿验证：10 项新增检查在旧实现上为 8 项失败、2 项普通恢复对照通过；修复后相关 kernel 35 项、迁移 35 项通过，包类型检查通过。主会话另跑新增 10 项，全部通过。
- 证据：`/tmp/mkagent-r2-evidence-M8OZ3V/`；主会话日志 `/tmp/mkagent-r2-master-tests.log`。
- 状态：R2-A、R2-B、R2-C、R2-D 通过局部、独立复核及最终集成验收。
- 文档核对：原 `kernel.ts` 顶部注释误称 legacy 转换在打开 store 前发生，实际普通路径使用已打开的 Harness。R8 已修正该注释，并在原迁移规格 §8 明确实际时机。

### R3

- 修改：`durable-bundle.ts` 在入口用 lstat 拒绝根 symlink 和非目录；`bundle.ts` 不再用会跟随链接的 existsSync 跳过检查，悬空链接也失败关闭。
- 回归：真实 JSONL/SQLite 外部目标可直接导出的阳性对照，根链接、悬空根链接、普通文件和内部链接拒绝，以及普通 legacy 导出。
- 红绿验证：新增检查在修复前为 3 项失败、6 项通过；修复后完整 bundle 61 项、kernel 导出 7 项通过，两包类型检查通过。主会话已审阅完整修改及测试断言。
- 证据：`/tmp/mkagent-r3-evidence-h8895A/`。
- 状态：R3-A、R3-B、R3-C 通过局部、联合独立复核及最终集成验收。

### R4

- 修改：grep/find 将调用方 AbortSignal 传至 resolver、manager、版本查询和下载；下载 reader 同时受取消和总超时控制，释放监听器并清理临时文件，解压和发布前再次检查取消。不改变 fetchWithRetry 的 API 或重试策略。
- 回归：新增自动被仓库 runner 发现的 `tool-binaries-cancellation.isolated.ts`，隔离 resolver spy；覆盖请求、body、取消后 gate 释放、发布前取消、未取消安装和本地路径对照。
- 红绿验证：未修复实现为 18 项失败；最终 20 项取消测试、24 项 manager 测试、8 项工具回归通过，包类型检查通过。主会话另跑 20 项取消测试，全部通过。
- 证据：`/tmp/mkagent-r4-evidence-Bh27ay/`；主会话日志 `/tmp/mkagent-r4-master-tests.log`。
- 状态：R4-A、R4-B、R4-C 通过局部、联合独立复核及最终集成验收。现有解压器为同步执行，本项保证下载取消及发布前检查，不新增同步解压进程抢占机制。

### R5

- 修改：`cache-warmer.ts` 移除 error/aborted 的提前返回，使返回的实际 usage 进入同一原子账本提交；首次模型桶使用 Draft 支持的普通赋值，避免 Object.defineProperty 使真实事务回滚。后者由新桶阳性对照发现，属于本项同一账本写入路径的必要修复，不改变调度策略。
- 回归：新增 `cache-warmer.test.ts`，使用真实 SQLite/JSONL 和 UsageDoc，覆盖新旧模型桶、三类结束原因、全部用量字段、零费用、无响应异常、累计持久化和取消后迟到响应。
- 红绿验证：修复前 18 项失败、6 项对照通过；修复后 24 项账本测试、2 项内核缓存测试通过，包与新测试文件类型检查通过。主会话另跑 24 项账本测试，全部通过。
- 证据：`/tmp/mkagent-r5-evidence-IIbTh2/`；主会话日志 `/tmp/mkagent-r5-master-tests.log`。
- 状态：R5-A、R5-B、R5-C 通过局部、联合独立复核及最终集成验收；关闭等待由 R6 完成。

### R6

- 修改：`CacheWarmer` 跟踪所有在途 refresh Promise，close 同步停止接收和调度后等待收尾；`kernel.close()` 同时取消手动压缩并等待预热完成，随后才关闭 Harness。普通 stop/capture 不等待旧请求。
- 回归：新增 `cache-warmer-lifecycle.test.ts`，覆盖当前与替换请求、validation/commit 阶段、关闭期间新 capture、异常 rejection、空闲和重复关闭；用真实 SQLite/JSONL 重开核对费用和 entry 不重复。
- 红绿验证：最终测试对旧实现为 8 项失败、2 项对照通过；修复后缓存 34 项、关闭相关内核 7 项通过，包与新增测试类型检查通过。主会话另跑 10 项生命周期测试，全部通过。
- 证据：`/tmp/mkagent-r6-evidence-IKKm71/`；主会话日志 `/tmp/mkagent-r6-master-tests.log`。
- 状态：R6-A、R6-B、R6-C 通过局部、联合独立复核及最终集成验收。收尾依赖 provider、validation 和存储 Promise 最终结束；不以任意超时丢弃迟到用量，永久不结束的依赖仍会阻塞 close。

### R7

- 修改：原内核缓存 fixture 同时提供 short/long TTL；账本测试新增显式 long-only 及 none 行为检查，不修改生产默认值，不修改 process.env。
- 红绿验证：原 fixture 在外部 long 环境失败；修复后 short、long、未设置三种环境各 40 项缓存相关检查通过，包与测试类型检查通过，其他修复文件校验保持不变。
- 证据：`/tmp/mkagent-r7-evidence-u3Dshy/`。
- 状态：R7-A 通过三种环境矩阵、联合独立复核及最终集成验收。

### R8

- 修改：中英文 README 统一为启用 codemode 且有兼容图片模型和凭据时可调用 models.generateImages，没有独立图片生成 UI。原迁移规格 §8 同步分支清理、父库保护、预热记账与关闭收尾，kernel 顶部迁移注释与实际时机一致；历史设计和功能代码不变。
- 验证：16 项文本事实核验、2 项 mock 权限检查、类型检查、标点检查与 diff 检查通过。主会话已核对 README 差异和完整 §8。
- 证据：`/tmp/mkagent-r8-evidence-lVNFVN/`。
- 状态：R8-A 通过文本事实核对、联合独立复核及最终集成核对。

## 12. 最终集成验收（2026-11-02）

联合独立复核一轮通过，没有追加修复项。主会话确认 19 个实现文件与已复核工作树逐字节一致后集成；来源清单只更新任务内 12 个已有文件的 hash 和必要理由，新增 4 个文件的来源说明。最终只追加验收文档，不再改动功能代码。实现分支和 worktree 保留供用户验收；验收完成时没有提交、推送或覆盖原有改动。用户随后授权按 R1-R8 拆分原子提交，每项同时维护对应的来源记录。

完整命令及日志：`/tmp/mkagent-final-acceptance-5HFppt/`。以下通过数只统计最终成功的门禁，不重复累计局部测试、失败尝试或网络守卫自检。

| 门禁 | 最终结果 | 日志 |
|---|---|---|
| 全仓 `typecheck:all` | 通过 | `01-typecheck-all.log` |
| `test:shared:all` | 61 项通过 | `02-test-shared-all.log` |
| pi-agent-server 普通测试，含构建 bundle 和进程生命周期 | 398 项通过，25 个文件 | `03-pi-agent-server-ordinary.log` |
| 二进制取消隔离测试 | 20 项通过 | `05-tool-binaries-cancellation-corrected.log` |
| shared bundle 与受影响 agent 测试 | 74 项通过 | `06-shared-targeted.log` |
| 独立进程的 conversation flow | 4 项通过 | `13-retry-conversation-flow.log` |
| 独立进程的 coding runtime | 1 项通过 | `14-retry-coding-runtime.log` |
| 来源审计 | 通过，1,591 个文件，上游 HEAD 与清单基线一致 | `09-audit-craft-reuse.log` |
| Craft 保留测试覆盖检查 | 通过 | `10-lint-craft-test-coverage.log` |
| diff 空白检查 | 通过；验收文档更新后再检查 | `11-git-diff-check.log`、`final-document-check.log` |

运行时测试合计 558 项通过。首次运行存在验证配置错误，均保留原日志而不计作通过：隔离文件需使用 `./` 路径；全阻断 preload 误拦两个宿主套件自建的本地 HTTP mock；另两次重试启动遇到 E2BIG，未真正运行测试。最终两个宿主套件使用 `--preload=/绝对路径` 的临时守卫，仅允许测试创建的明确 loopback origin 并传至子进程，禁止外网、未知本地端口、WebSocket 和重定向，清除代理变量。守卫 7 项自检通过，产品代码及测试断言未改变。

### 逐项结论

| 标准 | 结果 | 验收证据 |
|---|---|---|
| R1-A | 通过 | 真实 JSONL sidecar-before-marker gate；父提交及重开保持完整 |
| R1-B | 通过 | SQLite/JSONL 父库状态矩阵与子副本迁移、锚点测试 |
| R1-C | 通过 | 完整迁移测试及 kernel legacy、恢复和锚点回归 |
| R2-A | 通过 | 真实父会话活动期间创建分支，无子模型或工具调用 |
| R2-B | 通过 | 排队输入、工具及跨分页任务清理，分支重开不执行继承工作 |
| R2-C | 通过 | 子会话新输入与工具循环正常，上下文截止点及父任务完成检查 |
| R2-D | 通过 | 正常恢复、分支重开、无效锚点回滚与 pending 标记检查 |
| R3-A | 通过 | 外部 JSONL/SQLite 根 symlink 导出失败及可导出目标阳性对照 |
| R3-B | 通过 | 悬空根链接、根文件、内部链接拒绝，legacy 导出保留 |
| R3-C | 通过 | bundle 全套、kernel 导出及宿主导入后分支恢复检查 |
| R4-A | 通过 | 两类工具版本查询与下载取消，fetch signal 及及时结束检查 |
| R4-B | 通过 | body gate 取消、清理、迟到释放及发布前取消检查 |
| R4-C | 通过 | fake archive 安装、缓存、PATH、bundled rg、离线和解压对照 |
| R5-A | 通过 | 两类真实存储、新旧模型桶、stop/error/aborted 精确单次入账 |
| R5-B | 通过 | 无响应异常和零用量检查，不增加虚构消费 |
| R5-C | 通过 | 累计持久化、重试策略和取消后不再调度检查 |
| R6-A | 通过 | SQLite/JSONL 迟到响应在 close 前入账，重复重开不重复消费 |
| R6-B | 通过 | 替换请求、validation/commit gates 与关闭期间新 capture 检查 |
| R6-C | 通过 | 失败、空闲、重复关闭、rejection、主对话、压缩和 re-init 检查 |
| R7-A | 通过 | short/long/unset 各 40 项局部检查；集成全套继续通过 |
| R8-A | 通过 | EN/ZH、注册鉴权及实际时机核对；历史设计与当前落地明确区分 |

### 未覆盖层级与剩余边界

- 未验证真实 provider、真实 Electron 和跨平台最终发布包；本地 bundle 构建与离仓目录烟测不替代这些验证。
- R3 拒绝已发现的静态根链接，不宣称解决并发 pathname replacement race。
- R4 保留同步解压，不新增同步子进程抢占；取消检查阻止后续发布。
- R6 依赖外部 Promise 最终结束；永久不结束的依赖可阻塞 close，强制终止不保证迟到用量持久化。
- 已修正的文档不一致包括：README 图片生成缺失表述、kernel 迁移时机注释，以及原迁移规格中分支初始化、父库处理、预热记账与关闭的落地描述。历史设计章节保留，由 §8 明确列出与实现的差异。
