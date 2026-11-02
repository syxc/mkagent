# 功能与稳定性修复执行规格

状态：执行中。
日期：2026-11-02。
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
| FS-13 | 静态风险 | P2 / 待验证 | 用无外网测试确认管理过的 Azure/Cloudflare 端点变量在 URL 清空、失效或切换后不会残留；随后修复并验证正常端点切换。 |

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
7. `bun run lint`、`bun run audit:craft-reuse`。已知缺少 Craft 参考仓库会阻塞同步、覆盖率对照和来源审计；可完成独立检查，不得跳过后宣称总 lint 通过，也不擅自下载参考仓库。
8. 本地 provider 下并发会话隔离、有效锚点分支、失败后恢复、导出导入与重试取消对照。

安全边界的运行检查使用受控本地服务或 fetch，不连接真实内网服务。测试日志不能包含真实密钥或用户数据。构建和自动测试通过不代表真实 OAuth、跨平台安装和长期压力已通过。

## 6. 执行账本

| 分组 | 状态 | 红 → 绿 / 运行证据 | 提交 |
|---|---|---|---|
| C0 | completed | 规格覆盖 FS-01–FS-13；导航已登记 | `61ec6ed` |
| C1 | completed | 新增 3 个冷启动回归在修复前均失败；修复后 bundle smoke 18 pass、0 fail；子进程 typecheck 通过。接收时取消代际覆盖初始化排队，打开内核后再次校验；steer 等待已有打开操作。 | `57e950f` |
| C2 | completed | 宿主及真实内核缺锚点回归修复前均失败；修复后 branching + kernel e2e 147 pass、0 fail。宿主在创建会话前拒绝缺锚点，内核在复制父库前拒绝；SQLite/JSONL 父库不变，正常及 legacy 截断、无效锚点重试通过。旧的无锚点全量复制用例已改为明确拒绝，已有子库恢复仍可用。 | `fix(sessions): reject branches without a cutoff` |
| C3 | pending | — | — |
| C4 | pending | — | — |
| C5 | pending | — | — |
| C6 | pending | — | — |
| C7 | pending | — | — |
| C8 | pending | — | — |
| C9 | pending | — | — |
| C10 | pending | — | — |

## 7. 已知阻塞与交付限制

- Craft 参考仓库缺失是检查环境阻塞，不等于业务回归；当前独立 lint 基线为 0 error、106 warning，不借本轮清理无关警告。
- 真实模型、OAuth、外部 MCP、跨平台发布及长期 soak 需要对应环境和授权；本轮不使用真实凭据或付费配额。
- 当前 headless 基线的 WebUI 成功伴随源码资源回退；只有 C8 完成后的独立产物检查才能提升该覆盖结论。
- 最终交付列出实际完成项、失败与受阻检查、未覆盖范围、原子提交及剩余风险。没有执行的检查不得标记完成。
