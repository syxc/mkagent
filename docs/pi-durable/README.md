# Pi-durable coding agent 内核文档

pi-durable 内核已接入，`pi-durable coding agent` 的 Coding 能力和插件契约已有实现及历史证据，完整程度须先核实。当前重点是架构优化：优先引用独立公开包，公开接口不足时采用薄外部适配，仅保留必要源码移植，减少上游 SDK 升级时的适配工作。MkAgent 现有功能保持完整，`pi-agent-core` 可以按需引用，禁止生产直接依赖完整 `pi-coding-agent` 包。

先按用户要求严格修正文档并查漏补缺，再按[架构优化跟进](coding-follow-up.md)落实。实施计划和能力规格保留目标与契约，验收记录区分已实现、待修正和待验证；发现偏离时及时纠正任务、文档及实现。历史规格保留第一次内核切换时的约束及证据，不再把当时禁止 `pi-agent-core` 的要求作为当前限制。

| 文档 | 内容 |
|---|---|
| [架构优化跟进](coding-follow-up.md) | 按用户最新澄清核实包复用、薄适配、必要例外及改动影响 |
| [需求与验收对照](coding-acceptance.md) | 已有功能和插件证据、适用版本及未验证范围 |
| [Coding agent 精简架构](coding-architecture.md) | 执行链路、上游包依赖、源码移植清单及 MkAgent 自有适配边界 |
| [Durable coding agent 实施计划](durable-coding-agent-plan.md) | 用户澄清后的目标、职责边界、产品保留清单、逐项修正顺序及验收条件 |
| [Coding 能力与插件兼容规格](coding-capabilities-spec.md) | 固定上游基线、依赖规则、能力清单和宿主契约 |
| [Coding 验证与剩余工作](coding-validation.md) | `4776fe1` 的验证证据、当前实现状态及未完成项 |
| [内核切换执行规格](kernel-durable-switch-spec.md) | 原始设计、当前实现差异及内核升级回归清单 |
| [内核迁移审查问题修复规格](kernel-migration-review-fix-spec.md) | R1 至 R8 修复边界与最终集成验收 |
| [首页建议与 Web 可用性修复执行规格](starter-web-repair-spec.md) | 两个首页入口的故障确认、Web 实际验证及修复验收 |
| [Pi-durable 遗留修复与验收](kernel-legacy-fix-spec.md) | 宿主交互完成边界、MiniMax CN 模型身份及持久化清理竞态 |
| [功能与稳定性修复执行规格](functional-stability-remediation-spec.md) | 本轮 12 项问题、端点残留风险、原子修复分组及逐项验收账本 |

通用系统架构仍见 [英文架构文档](../architecture.md)、[中文架构文档](../zh/architecture.md) 和 [架构图](../architecture.html)。产品裁剪与上游同步的历史资料分别保留在 `docs/migration/`、`docs/sync/`。
