# Pi-durable 遗留修复与验收

历史范围说明：本文记录下列基线上的 L1 至 L3 修复及 2026-11-02 验收。下文的状态、执行授权、测试结果与限制只适用于当时，不代表本轮授权或当前架构。后续迁移目标与限制以[能力规格](coding-capabilities-spec.md)和[实施计划](durable-coding-agent-plan.md)为准；历史失败与未验证边界仍保留。

当前背景（2026-11-08）：MkAgent 从 `pi-coding-agent` 迁向功能已较完整的 `pi-durable`，在 durable 之上补齐 Coding 能力和 Pi 插件生态，保持 MkAgent 全部既有功能完整正常。先采用 durable 内置能力，再用独立 Pi 官方 SDK 的公开 API；只有具体缺口得到论证后才保留薄适配或必要源码。允许按需引用 `pi-agent-core`，生产不得依赖或加载完整 `pi-coding-agent` 包。旧内核依赖禁令以现行规格为准；宿主侧只做必要接线适配，既有整体架构、职责和功能约束继续保留。第三方资源替换、删行数和复制原版 CLI 的完整源码闭包均不是迁移目标；当前自有任务桥仍须按真实契约审查。

基线：`20fb16d6711e264356356e5b3b104c4d4a58f09d`。
实施阶段状态：三项修复和必要联合验证已完成，独立 diff 复核未发现可证实的新缺陷；来源审计仍受本机缺失 Craft 参考仓库阻塞。实施阶段仅修改工作区；后续提交和推送按用户单独授权执行。

## 范围与验收

| 编号 | 问题 | 完成条件 |
|---|---|---|
| L1 | durable `run_end` 提前关闭宿主交互轮次 | steer/followUp 的后继运行结束后才完成宿主队列；普通文本、工具、retry/abort 有回归覆盖，不用微任务或固定延时推测空闲 |
| L2 | MiniMax CN 请求 ID 被当作目录 ID 重新查找 | 保留目录身份及完整模型能力，发送请求时保持 CN ID 兼容；init、set_model、runtime 更新及 ephemeral 使用一致规则，模型缺失返回错误 |
| L3 | runtime 隔离测试结束后持久化 rename ENOENT | 先可靠复现并判定是 teardown 未等待还是原子写冲突，再修复责任方；检查实际输出无 ENOENT，不吞异常或 sleep |

三项分别先加入持久回归测试，记录未修复代码上的失败，再修改并验证通过。测试使用临时 `CONFIG_DIR`、合成凭据、本地或脚本 provider，不读取真实 HOME 配置或调用外部模型。保留 MCP/codemode 契约、pi-agent-core/pi-ai 兼容依赖及 NOTICE，不恢复 pi-coding-agent。

## 联合验证

完成后运行 pi-agent-server 全套、相关宿主队列/模型/持久化测试、runtime 隔离测试、`typecheck:all` 和 `server:build:subprocess`。按项目要求运行其他检查，分别记录通过、失败及外部基线缺失。构建后检查当前产物，不能用旧 bundle 作为修复证据。

## 实施证据

### L3：持久化排空

根因已由单写者确定性复现：timer 直接调用 `write()`，没有进入 `writeInProgress`；写入开始后又会先移除 pending 条目。旧 `flushAll()` 仅等待 pending，因此在真实 rename 尚未执行时返回，测试删除 workspace 后 rename 报 ENOENT。并发原子写不是本次复现的必要条件。

修复使 timer 与显式 flush 共用每个会话的串行写入链，先登记 Promise 再让出执行；pending 为空时仍等待 active 写入，`flushAll()` 排空两者。runtime 测试在重启及删除临时目录前等待该屏障，并隔离 HOME。

| 阶段 | 命令 | 结果 |
|---|---|---|
| RED | `bun test packages/shared/tests/persistence-queue.test.ts` | exit 1，3 pass / 2 fail，8 assertions；实际 stderr 包含真实 rename ENOENT |
| GREEN | `bun test packages/shared/tests/persistence-queue.test.ts packages/shared/src/sessions/__tests__/persistence-queue.test.ts` | 连续 6 轮 exit 0，每轮 9 pass / 0 fail，21 assertions，ENOENT 0 |
| GREEN | `bun test ./packages/server-core/src/sessions/pi-0153-runtime.isolated.ts` | 连续 3 轮 exit 0，每轮 1 pass / 0 fail，35 assertions，ENOENT 0 |

原 runtime 在本次修复前的单轮运行未出现 ENOENT；确定性回归通过暂停真实 rename 证明排空契约缺陷。测试保留 `broken.heic` 的预期解码错误输出，没有以吞异常取得通过。原始证据暂存 `/tmp/mkagent-task3-persistence-evidence.txt`。

### L1：宿主交互完成边界

已安装 durable 的 `harness/events.js` 在输入身份变化时会同帧依次产生旧 `run_end` 和新 `run_start`。旧 kernel 无条件将前者转成 `agent_end`，宿主 `PiAgent` 因此关闭 EventQueue，后继文本在交互完成后才到达。

修复根据原始 watch 帧和提交状态区分 run 与宿主交互：同帧存在后继时跳过旧终止事件；异步用量/压缩协调完成后再次检查后继帧；等待正在提交的输入，并跟踪已接受但尚未出现在 watch 中的输入。后继 run 不重复发送 `agent_start`。生产逻辑没有使用微任务或固定延时推测空闲。

新增 10 项回归使用真实 `PiEventAdapter` 与 `EventQueue`，覆盖 steer/followUp × text/tool × 完成/abort，以及结束处理中已提交和仍在提交的 followUp。

- 首次 RED：`CONFIG_DIR=<fresh-temp> bun test ./packages/pi-agent-server/src/kernel.e2e.test.ts --test-name-pattern 'keeps the host queue open'`，exit 1，1 pass / 3 fail，7 assertions。
- 晚到输入 RED：同命令使用 pattern `'keeps a late followUp'`，exit 1，0 pass / 1 fail，1 assertion。
- 最终 GREEN：pattern `'keeps the host queue open|keeps a late followUp|retry|retries|abort|cancel|delivers completion'`，exit 0，34 pass / 0 fail，175 assertions。

### L2：目录身份与请求 ID

`resolvePiModel()` 曾把 MiniMax CN 完整模型的 ID 改为裸请求 ID，`resolveModelRef()` 再将其保存为 provider/modelId；durable 随后按该 ID 查目录时找不到模型。修复保留目录 ID，由每次创建 runtime 时安装的 provider dispatch 仅在 `stream`/`streamSimple` 发请求时转换 ID，其余模型元数据完整保留。durable 的二次查找能取得完整定义，ephemeral 使用相同分发规则。

初始模型不可解析时明确失败，失败的 `set_model` 通过已有通用错误协议返回；提交 prompt/steer 与 setModel 均验证当前目录，避免模型消失后空完成。协议子进程回归覆盖 init、set_model、runtime 更新及 ephemeral，使用内存假 provider 和阻断外部 fetch 的精简环境。

- 目录身份 RED：`bun test packages/pi-agent-server/src/model-resolution.test.ts`，exit 1，27 pass / 1 fail；预期目录 ID，实际得到裸 ID。
- 不可用模型 RED：kernel e2e 的 `'rejects an unavailable model'` 用例，exit 1，0 pass / 1 fail；旧 setModel 错误地成功返回。
- 协议 RED：新增 MiniMax 协议用例等待错误响应超时，证明旧 set_model catch 只写日志；补充已有 `type: 'error'` 消息后，该用例 exit 0，1 pass / 0 fail，6 assertions。
- 最终 GREEN：`CONFIG_DIR=<fresh-temp> bun test packages/pi-agent-server/src/model-resolution.test.ts packages/pi-agent-server/src/model-runtime.test.ts packages/pi-agent-server/src/kernel.e2e.test.ts -t 'resolvePiModel|isDenied|isModel|OAuth|custom endpoint model catalogs|MiniMax|rejects an unavailable model'`，exit 0，34 pass / 0 fail，86 assertions；package typecheck exit 0。

### 文档一致性

已将 `paths.ts` 顶注释从 `MKAGENT_CONFIG_DIR` 更正为代码实际读取的 `CONFIG_DIR`，并移除未经实现支持的自动编号脚本说明；配置契约未变。原切换规格把每个 run 结束对应宿主完成，已在当前实现差异表补充后继交互和模型目录身份的准确语义。首页修复规格中的历史配置注释问题已注明后续修正。

### 联合验证（2026-11-02）

联合验证先构建当前 subprocess，再执行测试。所有子进程使用临时 HOME/CONFIG_DIR 并移除真实凭据相关环境变量；本地 provider、脚本 provider 或网络拦截提供模型替身。

| 命令 | 首轮结果 |
|---|---|
| `bun run server:build:subprocess` | exit 0 |
| `bun test ./packages/pi-agent-server/src` | exit 1，411 pass / 1 fail，25 文件；失败是 bundle 测试的旧文本锚点 |
| `bun test ./packages/pi-agent-server/src/tools/local/tool-binaries-cancellation.isolated.ts` | exit 0，20 pass / 0 fail |
| `bun test ./packages/shared/src/agent/__tests__/event-queue.test.ts ./packages/shared/src/agent/__tests__/pi-event-adapter.test.ts ./packages/shared/src/agent/__tests__/pi-agent-error-handling.test.ts ./packages/shared/src/sessions/__tests__/persistence-queue.test.ts ./packages/shared/tests/persistence-queue.test.ts` | exit 0，103 pass / 0 fail，5 文件 |
| `bun test ./packages/shared/src/agent/__tests__/pi-conversation-flow.integration.test.ts` | exit 0，4 pass / 0 fail |
| `bun test ./packages/server-core/src/sessions/pi-0153-runtime.isolated.ts` | exit 0，1 pass / 0 fail，35 assertions；ENOENT 0，PersistenceQueue 写入错误 0 |
| `bun run test` | exit 1，4320 pass / 11 skip / 6 fail，355 文件；一项旧 bundle 锚点和五项验证环境配置路径不一致 |
| `bun run validate:ci` | exit 0；包含 `typecheck:all`、shared 61 项、文档工具 20 项和三项 i18n 检查 |
| `bun run electron:build` | exit 0 |
| `bun run lint:electron`、`bun run lint:shared`、`bun run lint:ui` | 各 exit 0，0 errors；分别有 94、2、10 warnings |

准备阶段第一次单独运行 `bun run test:doc-tools` 被外层 55s 超时终止（SIGTERM，无退出码）；随后完整重跑 exit 0，20 tests，11.452s，且后续 `validate:ci` 中再次通过。已检查没有残留该 unittest 进程。

首轮暴露的 bundle 测试使用生成变量名和 `try` 相邻文本定位暂停点；模型解析移入 try 后，该锚点不再成立。已改为匹配 open 调用，并在最后一项 runtime 更新到达配置边界后释放明确的 Promise 屏障，移除原 400ms 延时。定向验证 exit 0，1 pass / 0 fail，9 assertions。

五项缓存失败来自外层验证把 `CONFIG_DIR` 设置为临时 `HOME/config`，而该旧测试固定写入临时 `HOME/.mkagent/config.json`。将外层 `CONFIG_DIR` 对齐到同一个隔离的 `.mkagent` 后，该文件 20 项全部通过，exit 0；没有修改无关产品逻辑或测试。server 全套重跑 exit 0，412 pass / 0 fail，25 文件（211.38s）；完整 `bun run test` 重跑也已完成，exit 0：普通组 4326 pass / 11 skip / 0 fail，355 文件，后续 17 组隔离测试全部通过，合计 4550 pass / 11 skip / 0 fail（296.388s）。

`bun run lint`、`bun run audit:craft-reuse`、`bun run lint:craft-test-coverage` 和单独的 `bun run lint:craft-ui-sync` 均 exit 1：本机缺少 `/Users/syxc/projects/vendor/craft-agents-oss`，无法执行上游对照。独立执行三个 ESLint 命令均通过。本次 12 个变更源码/测试文件的本地 hash/reason 核对通过，但不能替代缺失参考仓库的来源审计。

构建产物 `packages/pi-agent-server/dist/index.js` 已检查包含 `pendingInputs`、`acceptedInputs`、MiniMax 请求转换及 `set_model_error`，配套 codemode worker、QuickJS wasm 与 Photon wasm 存在。完整构建及测试结束后复核最终 hash。

未覆盖真实 MiniMax 服务、真实 OAuth、Electron 交互及跨平台发布包；没有重装已删除的 pi-coding-agent。

### 中断后续验（2026-11-02，16:22 +08:00 起）

续验先检查 `git status`、diff 与实际日志，复用上轮已落地补丁，没有覆盖用户 `.gitignore`。上一轮联合验证的 `/tmp/mkagent-legacy-validation-UC667e/results.jsonl` 已记录完整退出码；`all-tests-retest.log` 和 `pi-agent-server-retest.log` 均晚于最后一次源码/测试修改。因此上述全套结果是复用证据，不是本轮重新运行；本轮另执行以下当前工作区验证，全部真实退出，没有超时：

| 命令/范围 | 本轮结果 |
|---|---|
| `bun run server:build:subprocess` | exit 0，0.266s；保留既有 dist，更新 subprocess 产物 |
| `bun run typecheck:all` | exit 0，43.645s |
| `bun test ./packages/pi-agent-server/src/model-resolution.test.ts ./packages/pi-agent-server/src/model-runtime.test.ts ./packages/pi-agent-server/src/kernel.e2e.test.ts -t 'keeps the host queue open\|keeps a late followUp\|retry\|retries\|abort\|cancel\|delivers completion\|resolvePiModel\|isDenied\|isModel\|OAuth\|custom endpoint model catalogs\|MiniMax\|rejects an unavailable model'` | exit 0，68 pass / 0 fail，3 文件，68.748s |
| 宿主 EventQueue、PiEventAdapter、PiAgent 错误处理及两组持久化测试（联合验证表同一命令） | exit 0，103 pass / 0 fail，5 文件，0.416s |
| `bun test ./packages/shared/src/agent/__tests__/pi-conversation-flow.integration.test.ts` | exit 0，4 pass / 0 fail，3.386s |
| `bun test ./packages/server-core/src/sessions/pi-0153-runtime.isolated.ts` | exit 0，1 pass / 0 fail，2.693s；实际输出 ENOENT 0，PersistenceQueue 写入错误 0 |

本轮以新的临时 HOME/CONFIG_DIR 隔离环境，清除凭据相关环境变量，使用本地/脚本替身，没有调用真实模型。每项验证上限为 180s，runtime 为 90s；执行器等到子进程退出后才记录 exit/signal。所有本轮输出均无 ENOENT 或 PersistenceQueue 写入错误。

再次核对 12 个变更源码/测试文件与 `craft-source-overrides.json` 的 SHA-256/reason，全部匹配；`git diff --check` 通过。当前 bundle 包含输入提交跟踪、MiniMax 请求兼容和 `set_model_error`，codemode worker、QuickJS wasm 与 Photon wasm 齐全；旧 pi-coding-agent 未恢复。Craft 上游参考仓库缺失仍是来源审计的外部阻塞。

独立 diff 复核未发现可证实的新缺陷。复核方另起的三个文件测试在 60s 无结果时被终止，不作为通过或失败证据；动态证据使用上述实际完成的主线程运行。保留两个未测组合：失败的 runtime 更新移除旧 custom-endpoint 后，不先修正配置而直接继续 prompt；retry backoff 中追加输入、abort/恢复后再开始新交互的连续组合。已有测试分别覆盖 runtime 失败显式返回、合法更新恢复，以及 retry、后继输入、abort，但不据此声称这些组合已验证。

### 提交前验证（2026-11-02，19:52 +08:00 起）

按后续用户授权拆分提交并推送，排除已有 `.gitignore` 修改。本轮重新核对 12 个源码/测试文件的 SHA-256，全部与 overrides 相符；原始全套重测日志存在且晚于最后源码修改，4550 pass / 11 skip 为复用证据。本轮使用临时 HOME/CONFIG_DIR、清除凭据环境变量，重新执行两组持久化测试（9 pass）、上述内核/模型定向测试（68 pass）及 runtime 隔离测试（1 pass），均 exit 0，输出无 ENOENT 或 PersistenceQueue 写入错误；`git diff --check` 通过。为核验原子提交的中间版本，另将模型修复的暂存内容导出为独立快照，模型定向测试 exit 0，34 pass / 0 fail。

提交复核提出了运行期间失败的 runtime 更新移除当前模型后，再发送 followUp 的组合风险。源码追查显示宿主 `SessionManager.performRuntimeRefresh()` 在 `agent.isProcessing()` 时直接返回，且更新失败会拒绝等待，因此该顺序尚未证明可由正常宿主路径触发。直接 JSONL 协议组合未动态验证，保留上述边界，不作为已覆盖结论。Craft 来源审计仍因参考仓库缺失而未完成；没有为推送克隆仓库或更改配置。
