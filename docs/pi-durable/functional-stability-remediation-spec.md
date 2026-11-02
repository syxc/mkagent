# 功能与稳定性修复执行规格

状态：FS-01–FS-13 修复已提交；C10 验收部分受阻，详见第 8 节。
初稿日期：2026-11-02。最后验收：2026-11-03。
基线：`416835e`，`dev/pi-durable`。

## 1. 目标与授权

将本轮功能与稳定性检查的 12 项问题逐项修复，以可重跑的回归检查作为完成依据。端点环境变量残留作为 FS-13，先验证再修复。允许按完整问题分组进行原子提交；不推送、不发布。

保留 Pi Durable 路线及现有 MCP/codemode 能力。修改限于已发现问题及必要的同类调用链，不新增运行时依赖、不展开无关重构。既有规格保留其历史基线，本规格记录本轮增量。

## 2. 执行边界

- 保留已有及并发工作；每次提交前检查状态和暂存差异，不覆盖或隐藏用户文件。
- 测试使用临时 HOME、`CONFIG_DIR=$HOME/.mkagent` 和凭据/代理白名单环境。本地 provider、受控 fetch 和本地 MCP fixture 不消耗真实模型配额。
- 不改变用户配置、用户浏览器空间，或停止原有 `127.0.0.1:9100` 服务。只关闭本轮创建的测试服务和页面。
- 先加能暴露错误行为的回归并观察失败，再修复并观察通过。正常对照必须证明没有因空结果或未执行目标路径而通过。
- 分支、迁移、导出须保持原会话完整。临时副本和测试库可重建，真实会话不能作为修复试验对象。
- 打包验收须证明采用产物资源；源码资源回退、跳过用例、构建成功均不能代替实际运行验收。

## 3. 问题与完成契约

证据等级：运行复现表示真实宿主、子进程或浏览器已到达目标路径；函数/Mock 表示受控函数边界已复现；静态表示仍需验证。检查基线有 4550 pass、11 skip、0 fail；这些结果不作为修复后验收。

| ID | 原报告 | 优先级 / 证据 | 完成契约 |
|---|---|---|---|
| FS-01 | 1 | P1 / 运行复现 | 内核首次打开期间收到停止后，不提交此前等待的 prompt/steer；只追加不停止时，追加内容被消费。停止后新输入仍可完成。 |
| FS-02 | 2 | P1 / 运行复现 | 请求分支必须具有可解析的截止锚点；缺失或无效时明确拒绝，不留下子会话或执行父会话后续任务。有效锚点保持原行为。 |
| FS-03 | 3 | P1 / 源码与 Mock | 手动处理有限次 HTTP 重定向，每次请求前校验目标 URL；私网、非法协议、循环及超限明确失败，正常相对/绝对公网跳转仍可读取。 |
| FS-04 | 4 | P2 / 函数探针 | exposure 精确覆盖仅接受自有属性；constructor/toString/__proto__ 遵守 hidden，不能注册、发现或调用。正常 direct/deferred/codemode 保持可用。 |
| FS-05 | 5 | P2 / 运行复现 | 运行配置更新先构建并验证候选，再发布；失败保留之前可用的配置、模型目录和宿主状态；较旧的并发更新不能覆盖新更新。 |
| FS-06 | 6 | P2 / 运行复现 | 替换模型目录后，辅助模型必须仍可解析；保留仍有效的显式选择，无效旧选择改为当前连接可用模型。主对话和辅助查询均成功。 |
| FS-07 | 7 | P2 / 运行复现 | 分支复制被保留消息所需的会话文件，并将引用指向子会话；原文件不变，复制失败不留下可见的半成品分支。 |
| FS-08 | 8 | P2 / 运行复现 | 导入附件后将源会话内的文件引用重映射到新目录；删除源会话后仍可读取附件、缩略图和转换文件。无关外部路径不能被前缀误替换。 |
| FS-09 | 9 | P2 / 合成旧格式运行复现 | 未经首次打开迁移的旧会话导出导入后，可继续使用原模型上下文；保留旧记录顺序/树形历史，拒绝不安全路径，沿用浏览器密码脱敏边界。 |
| FS-10 | 10 | P2 / Mock | 工具调用的取消信号贯穿 fetch、读取及保存检查；取消后不写下载文件、不返回成功。同类 web_search 不因取消启动后备搜索。 |
| FS-11 | 11 | P2 / 运行复现 | headless bundle 不因构建机源码目录仍存在而进入源码模式；从仓库外启动仍采用产物资源。关键资源缺失应明确失败，不能回退到源码。 |
| FS-12 | 12 | P3 / 运行复现 | 端口 0 自动绑定后，WebUI 配置返回实际监听端口；固定端口、显式 public WebSocket URL 和 TLS 行为保持可用。 |
| FS-13 | 静态风险 | P2 / 本地环境复现 | 用无外网测试确认管理过的 Azure/Cloudflare 端点变量在 URL 清空、失效或切换后不会残留；随后修复并验证正常端点切换。 |

重试退避 → 追加输入 → 停止 → 新输入作为集成对照。旧检查中该组合的新输入已恢复，宿主也有主动结束队列与重置状态，不将缺少单个协议事件等同新的确定故障。

## 4. 实施分组与回归

| 分组 | 项目 / 主要模块 | 必须覆盖的回归与依赖 | 提交主题 |
|---|---|---|---|
| C0 | 本规格、目录导航 | 规格包含所有原问题和覆盖限制 | `docs(kernel): specify functional stability remediation` |
| C1 | FS-01；pi-agent-server index、bundle smoke | 冷启动 prompt/steer/abort 的顺序；初始化尚未完成即停止；取消后的新请求；复用现有 bundled 离线 fixture | `fix(kernel): retain controls across lazy startup` |
| C2 | FS-02；SessionManager、kernel、branch tests | 缺锚点/无效锚点失败且无副作用；正常 durable 和旧格式锚点仍截断上下文 | `fix(sessions): reject branches without a cutoff` |
| C3 | FS-03、FS-10；web-fetch、search provider 链 | 正常取回、逐跳校验、跳转上限、下载上限；请求/读流/保存前取消；取消不触发搜索降级 | `fix(tools): validate redirects and propagate cancellation` |
| C4 | FS-04；MCP policy、visibility tests | 特殊名策略红绿；本地 MCP 连接注册/发现对照；正常曝光模式不变 | `fix(mcp): ignore inherited exposure overrides` |
| C5 | FS-05、FS-06、FS-13；runtime config、mini model、endpoint env、宿主 | 更新失败后旧主/辅助模型可继续；成功替换后新主/辅助查询；并发与首次打开期间更新；端点残留验证 | `fix(models): publish runtime updates transactionally` |
| C6 | FS-07、FS-08；session file transport、SessionManager | 分支文件存在；导入后移除源目录仍可读；路径边界、原会话保护和失败回滚；依赖 C2 | `fix(sessions): preserve portable session file references` |
| C7 | FS-09；bundle collector、legacy import/migration | 未迁移旧格式导出导入继续对话；浏览器密码不出包；链接/非法记录失败；普通 durable 包仍可用；依赖 C6 | `fix(sessions): retain legacy context in portable bundles` |
| C8 | FS-11；runtime root detection、build tests | 源码模式对照；真实 bundle 在源码存在时保持打包模式；产物目录外运行与缺包反例 | `fix(server): detect bundled runtime paths correctly` |
| C9 | FS-12；server bootstrap、WebUI smoke | 真实端口 0 的已认证 /api/config 与 WebSocket 连接；固定/public URL/TLS 单测对照 | `fix(webui): advertise the bound RPC port` |
| C10 | 整体验收、来源清单、本文结果 | 下面的总体验收与测试资源关闭；只更新本轮触及文件的来源记录 | `docs(kernel): record remediation validation` |

各组完成条件为：原因明确、回归先失败后通过、相关检查通过、差异审阅完成，再提交。若局部源码必须联动，可调整分组并在账本说明，不能把部分修复标记完成。

## 5. 总体验收

在隔离环境依次运行并保存结果摘要：

1. 每组最窄的相关测试；内核变动覆盖真实 bundle 协议，文件迁移覆盖实际磁盘文件。
2. `bun run test`。
3. `bun run validate:ci`。
4. `bun run server:build:subprocess`、`bun run cli:build`、`bun run electron:build`。
5. `bun run scripts/build-server.ts --output=<temporary-output>`，在仓库外使用该产物完成 WebUI 登录、消息回复、刷新恢复，确认资源来自产物。
6. `bun run lint:electron`、`bun run lint:shared`、`bun run lint:ui` 与 `git diff --check`。
7. `bun run lint`、`bun run audit:craft-reuse`。原内核基线使用本仓库 `main`（本轮确认于 `6e8ebc4`），按需在隔离目录对照。来源审计清单另固定 Craft 上游提交 `8df01c5d0ac73c35add5954e6f190ce038d35845`；必须区分功能基线与来源基线，不能替换后声称原来源审计通过，也不擅自下载参考仓库。
8. 本地 provider 下并发会话隔离、有效锚点分支、失败后恢复、导出导入与重试取消对照。

安全边界的运行检查使用受控本地服务或 fetch，不连接真实内网服务。测试日志不能包含真实密钥或用户数据。构建和自动测试通过不代表真实 OAuth、跨平台安装和长期压力已通过。

## 6. 执行账本

| 分组 | 状态 | 红 → 绿 / 运行证据 | 提交 |
|---|---|---|---|
| C0 | completed | 规格覆盖 FS-01–FS-13；导航已登记 | `61ec6ed` |
| C1 | completed | 新增 3 个冷启动回归在修复前均失败；修复后 bundle smoke 18 pass、0 fail；子进程 typecheck 通过。接收时取消代际覆盖初始化排队，打开内核后再次校验；steer 等待已有打开操作。 | `57e950f` |
| C2 | completed | 宿主及真实内核缺锚点回归修复前均失败；修复后 branching + kernel e2e 147 pass、0 fail。宿主在创建会话前拒绝缺锚点，内核在复制父库前拒绝；SQLite/JSONL 父库不变，正常及 legacy 截断、无效锚点重试通过。旧的无锚点全量复制用例已改为明确拒绝，已有子库恢复仍可用。 | `9242bad` |
| C3 | completed | 红测记录 5 项失败，旧版挂起读流不响应取消，红测由 15 秒命令上限终止。修复后 fetch + search 52 pass、0 fail；子进程 typecheck 通过。独立复核发现生产动态包装器遗漏第三个参数；补充真实 bundle 红测，确认取消后请求仍未中止，再修复转发；bundle/search 66 pass、0 fail。逐跳校验且最多 5 次跳转；请求、读流、保存边界取消及 50MB 上限已覆盖。搜索 4 个 provider 均传递信号，重试、模型切换及 DDG 降级在取消后停止；正常降级仍通过。DNS 校验与连接之间原有 TOCTOU 限制仍存在。 | `0c7c25c`；`9e4013b` |
| C4 | completed | 函数策略和真实 MCP fixture 两项回归先失败，后 visibility 7 pass、0 fail，typecheck 通过。特殊名不再继承 Object 原型；自有精确/通配覆盖仍生效，无效 exposure 关闭曝光；hidden 工具不注册，正常工具可调用，direct/deferred/codemode 对照通过。同类 alias 读取随后经过合法 exposure 校验，不会注册非法可见性。 | `020dcc8` |
| C5 | completed | 初始 6 项红测及复核补充的 2 项红测均已运行失败；修复后 runtime/bundle/endpoint/host/compaction 92 pass、0 fail，完整 kernel e2e 146 pass、0 fail，最终 typecheck:all 通过。独立候选目录复用本次 init 的凭据存储，验收后串行发布；新输入等候提交，工具响应、取消和辅助查询不受阻。旧候选不能覆盖新提交，较新的用户模型选择保持顺序；无效更新保留主/辅助模型及宿主实例。mini 必须仍属于有效自定义目录，端点仅清除已管理键。首次打开、OAuth 轮换、SAVE 队列、前缀及有无 auth 对照通过。 | `32a5fba` |
| C6 | completed | 原版 3 项附件/导入/符号链接回归均失败；修复后 session transport/persistence/bundle 81 pass、0 fail，既有 session-branching 另 1 pass，typecheck:all 通过。复核发现显示层之外的模型路径遗漏，新增 5 项真实 kernel 红测后修复，history/migration/bundle/transport 281 pass、0 fail，最终 validate:ci 通过。SQLite、JSONL 和 legacy 模型内容及 replacement edits 均可移植；只修改私有副本，保留 ID、锚点、顺序和 document delta。分支在截止后收集模型上下文独有文件，重复的同内容显示附件可复用，后续专属文件不复制。删除源目录后两个导入和重开子会话仍可用；同 bundle 不被修改。旧 v1 兼容自有 header 或已打包附件证明的源目录；链接、遍历、失败回滚、Windows、引号及路径边界对照通过。部分迁移、inactive anchor 与父库不变的 8 项组合通过。 | `73aedea`；`36f7538` |
| C7 | completed | 初始 10 项及内容块复核补充的 5 项回归均已观察失败；修复后 legacy 迁移/导出/真实内核 32 pass、0 fail。全差异复核另发现 edit 目标只有存在性校验，补充 usage、TUI、edit-of-edit、跨分支目标 4 项红测后收紧规则，legacy/附件模型上下文 40 pass、0 fail；最终 bundle 78 pass、0 fail，validate:ci 通过。正常替换和省略仍可迁移。同步导出只收集最新普通 transcript，复用浏览器密码脱敏和最终残留秘密检查，不写源文件或提前创建 durable store。真实 provider 请求保留原用户/助手上下文，inactive anchor 仍可分支；较旧 transcript 不混入。拒绝坏 JSON、非法树/消息块及链接；按角色校验 text/image/thinking/toolCall，也覆盖 custom_message 和 context_edit。Windows 旧包跨目录源根识别的路径/transport 10 pass；模型历史附件验证见 C6。 | `9aec364`；`a28621b`；`6dc5cd9` |
| C8 | completed | 实际 Bun bundle 红测显示源码目录被识别为 source、产物路径被丢弃；改用运行文件的 import.meta.url，CommonJS 保留 __dirname 兼容路径。修复后 runtime/resolver/launcher 20 pass、0 fail，最终 typecheck:all 通过。完整 headless 构建成功，真实产物 launcher 在仓库外、源码仍存在时完成登录及配置读取，无源码回退；删除 fixture 的 Pi 资源后不再解析到任何源码替身。C9 的端口 0 问题在此产物中仍可复现，单独修复。 | `b66e7a2` |
| C9 | completed | 真实端口 0 服务的认证 /api/config 回归先失败（返回 ws://127.0.0.1:0）；修复后与实际绑定端口一致，并使用返回地址成功完成 WebSocket 握手。绑定回调在监听后同步发布端口，WebUI 每次请求读取当前值。server smoke + WebUI HTTP 15 pass、0 fail，typecheck:all 通过；固定端口、public URL、TLS 协议及代理头对照保持通过。 | `e300585` |
| C10 | blocked | 检查已执行并记录：validate:ci、最终构建、WebUI/CLI 产物验收、17 个隔离测试文件和独立 lint 通过。普通测试组 4399 pass、11 skip、1 watcher fail；Craft 外部 checkout 缺失，组合 lint 与来源审计失败。47 个本轮代码/测试文件哈希一致，固定来源基线未变。分支回滚夹具补足 C2 的必要锚点，单独及隔离组均通过。详细命令、证据和剩余边界见第 8 节，不能宣称整体验收全绿。 | `74c756e`；`docs(kernel): record remediation validation` |

## 7. 已知阻塞与交付限制

- 用户已指出本仓库 `main` 是未切换内核的版本；本轮已确认该分支存在，不再将原内核参考描述为缺失。来源审计脚本的默认外部路径不存在，且固定的 Craft 上游对象不在当前 Git 对象库；C10 分别记录原内核对照与来源审计的实际结果。当前独立 lint 基线为 0 error、106 warning，不借本轮清理无关警告。
- 真实模型、OAuth、外部 MCP、跨平台发布及长期 soak 需要对应环境和授权；本轮不使用真实凭据或付费配额。
- CommonJS 兼容路径未单独运行验收；Windows 仅执行格式与路径夹具，未进行真实 Windows 安装验收。
- 旧 v1 包若只记录 `~`，且显示层没有任何附件引用可证明源会话目录，模型独有绝对路径无法可靠重定位；不能保证此类历史包删除源后仍可读取。新导出包对模型路径使用会话令牌，不依赖此推断。
- 运行配置候选拒绝已验证可保留旧运行时；真实底层存储损坏、进程退出及已提交但确认丢失的恢复不在此保证内。宿主向子进程传递更新截止时间，等待空闲期间到期会拒绝候选。
- 修复前 headless 基线的 WebUI 成功伴随源码资源回退；C8 和最终 headless 产物均已验证采用产物资源，运行证据见第 8 节。
- 最终交付列出实际完成项、失败与受阻检查、未覆盖范围、原子提交及剩余风险。没有执行的检查不得标记完成。

## 8. 最终验收记录

最后生产源码提交为 `6dc5cd9`。本机临时证据目录为 `/tmp/mkagent-remediation-20261102-q7r4`，日志与测试产物不提交到仓库。构建、自动测试、lint 和测试服务经过 `run-checks.py`，隔离 HOME、CONFIG_DIR、真实凭据和代理；模型请求仅发送到本地 fixture。浏览器仅操作同名专用空间并连接该隔离服务。

| 检查 | 实际结果 | 本机证据 |
|---|---|---|
| `bun run test` | 360 个普通测试文件，4399 pass、11 skip、1 fail；普通组失败后原脚本未进入隔离组。前一轮用户中断的 SIGTERM 日志不计通过。 | `c10-tests-resumed-final.log`；中断记录 `c10-tests-complete.log` |
| 补跑隔离组 | 使用 `scripts/run-tests.ts` 相同的 `.isolated.ts` 和两个串行测试选择规则，逐文件运行：17 个文件、224 pass、0 fail。不是另一次全量通过。 | `c10-isolated-final.log` |
| `bun run validate:ci` | 通过，含全仓类型检查、共享配置/模型测试、20 项文档工具测试和 i18n 检查。新增遍历变量的类型收窄错误已修复后重跑。 | `c10-validate-corrected.log` |
| 构建 | 最终 Electron main、CLI、完整 headless 构建通过；此前完整 Electron 构建通过。headless 的 copy-assets 每次重新构建 Pi 子进程资源；最终后端更改覆盖在 main 与 Pi 重建中。 | `c10-electron-corrected.log`、`c10-cli-complete.log`、`c10-headless-corrected.log`；此前完整构建 `c10-electron-build.log` |
| CLI → 最终 headless 产物 | 两会话各两轮并发，模型历史互相隔离；锚点分支不含后续轮；导出导入后删除源会话仍能续聊。断言只使用本次新增的 provider 请求。 | `c10-artifact-cli-corrected.log`、`acceptance/cli-artifact-report.json` |
| WebUI → 最终 headless 产物 | 复用测试登录状态，消息回复、真实 read 工具及刷新恢复通过。provider 请求包含前轮助手内容和 `PACKAGED_TOOL_CONTENT`。观察到实际重试状态及 3 次失败请求，点击停止后新请求完成且无残留重试指示；重启服务后历史可见，并进入新模型请求。 | `acceptance/browser-artifact-report.json`、`acceptance/requests.json` |
| 打包资源来源 | 从仓库外启动；只检查本轮服务的后代进程，server 与 Pi 子进程均位于 `headless-final`，未采用仓库源码子进程。 | 本轮进程检查；`c10-acceptance-corrected.log`、`c10-acceptance-restart-final.log` |
| 真实产物重试对照 | 无追加/退避期间追加两组均观察到 auto_retry_start；取消收到终态，新 prompt 发出并获得新回复。报告的五项条件全部断言为真。 | `c10-packaged-retry-final.log`、`retry-final/report.json` |
| 独立 lint | Electron 0 error / 94 warning；shared 0 / 2；UI 0 / 10，合计与原 106 warnings 基线一致。 | `c10-electron-lint-final.log`、`c10-shared-lint-final.log`、`c10-ui-lint-final.log` |
| `bun run lint` / `bun run audit:craft-reuse` | 均失败于缺失的 `/Users/syxc/projects/vendor/craft-agents-oss`，未完成 Craft UI/source 审计。没有下载参考仓库或改写来源基线。 | `c10-lint-final.log`、`c10-craft-audit-final.log` |
| 来源清单局部一致性 | 47 个本轮代码/测试文件的 SHA-256 一致；只更新本轮路径，保留全部旧条目及 pinned baseline。modified 新增 7、更新 21；mkOnly 新增 9、更新 10；deleted 不变。分类仍须由固定上游实测核验，哈希一致不表示来源审计通过。 | `scripts/craft-source-overrides.json`；本轮 scoped hash consistency 检查 |

全量失败位置为 `apps/electron/src/main/handlers/__tests__/session-watcher.test.ts:154`，client A 停止监听后，client B 在已有 2 秒条件等待内未收到通知。另一份 `sessions-watchers.test.ts` 曾单独失败，之后原样复跑 2 pass。两份测试和 `packages/server-core/src/handlers/rpc/sessions.ts` 相对 `416835e` 的差异为零；原生观察探针可收到事件，但未确定全量失败的根因，未把探针通过视作该测试通过。

原内核参考 `main` 确认于 `6e8ebc4`；其隔离目录的覆盖路径检查通过（`c10-main-reference-coverage.log`）。把该目录作为 Craft 来源输入会失败，包括固定基线不匹配（`c10-main-reference-audit.log`），不作为来源审计通过。本轮创建的参考 worktree 已移除。

独立差异复核发现的搜索动态包装器、模型历史附件和 legacy edit 目标遗漏均已补回归并修复；最后新增的校验与类型修正由主线程复核。未把旧差异的独立复核结论扩大为最终整棵树独立复核通过。

浏览器空间 9 已在中断后消失；用户明确批准后以同名重建为 10，仅操作此任务空间，并在验收完成后调用一次 `finish({keep:[]})`。用户空间 7 与原有 9100 服务未操作。

最终测试服务、provider 与 Pi 子进程组已关闭，独立连接检查确认该测试端口拒绝连接（`c10-service-cleanup-final.log`）。保留临时日志与产物供复核，未保留运行中的验收服务。
