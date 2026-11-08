# Pi-durable coding agent 内核文档

MkAgent 第一次将 Pi coding agent 直接换成 pi-durable 后，发现 Coding 能力不足且无法复用原插件生态。当前方向是以切换前的 MkAgent 为行为和接入边界参照，保留 Pi coding agent 的 Coding 层与插件契约，尝试将其底层执行基座换成 pi-durable。对 MkAgent 而言，使用的仍是 Pi coding agent 的能力与接口；本地名称为 `pi-durable coding agent`。后续有效功能、修复和已有数据继续保留。

2026-11-08 用户补充明确，本次返工须纠正此前大量复制和改造 Pi 源码、未优先引用可复用 SDK 的做法，减少 Coding 和 durable 每次更新时逐文件维护的风险。先修正关键文档，再落实必要内核适配。执行侧先用 durable 内置实现，其余所需能力优先引用独立 Pi 官方 SDK，再补薄适配，最后才处理有具体缺口依据的源码或补丁。MkAgent 整体架构和宿主职责保持；完整 `pi-coding-agent` 包的现行生产依赖限制不构成复制整套 Coding SDK 的理由。

以[能力规格](coding-capabilities-spec.md)确定需求，以[实施计划](durable-coding-agent-plan.md)和[纠偏跟进](coding-follow-up.md)安排工作。当前 AgentSession、自有任务状态机和完整 SDK 源码闭包属于待审查的实现选择；已有测试、来源哈希及第三方资源去重不单独证明迁移纠偏完成。Pi 正式发布 API 与仓内补丁新增的接口分开记录。

| 文档 | 用途与适用范围 |
|---|---|
| [Coding 能力与插件兼容规格](coding-capabilities-spec.md) | 当前需求、Pi 官方 SDK 复用顺序、能力清单及产品和插件契约 |
| [Durable coding agent 实施计划](durable-coding-agent-plan.md) | 迁移背景、职责、文档先行的执行顺序、功能保留清单和完成条件 |
| [迁移纠偏跟进](coding-follow-up.md) | F0 至 F6 当前任务、官方执行主链核对、必要适配和影响验证 |
| [Coding agent 架构记录](coding-architecture.md) | 当前执行链、发布依赖、仓内补丁、源码移植及宿主边界；不将现状定为目标 |
| [需求与验收对照](coding-acceptance.md) | 逐项功能证据和本次架构纠偏状态，注明证据版本及未验证范围 |
| [Coding 验证与剩余工作](coding-validation.md) | 历次检查、失败修正和限制；保留当时证据，不代替当前规格 |
| [内核切换执行规格](kernel-durable-switch-spec.md) | 第一次切换的历史设计、实现差异及回归线索，旧依赖和能力限制已被当前规格取代 |
| [内核迁移审查问题修复规格](kernel-migration-review-fix-spec.md) | 历史 R1 至 R8 修复边界与集成验收 |
| [首页建议与 Web 可用性修复执行规格](starter-web-repair-spec.md) | 历史首页入口、Web 故障及修复证据 |
| [Pi-durable 遗留修复与验收](kernel-legacy-fix-spec.md) | 历史交互完成、模型身份及持久化竞态修复 |
| [功能与稳定性修复执行规格](functional-stability-remediation-spec.md) | 历史 12 项问题及修复账本，具体功能保证继续用于回归 |

历史规格保留原日期和检查结果，仅与现行规格冲突的内核依赖或接入条款被替代，既有分层、职责和安全约束继续有效。内核接入调整须保留现有权限、取消、错误、持久化、恢复和公开插件行为。

通用系统架构见[英文架构文档](../architecture.md)、[中文架构文档](../zh/architecture.md)和[架构图](../architecture.html)。产品裁剪与上游同步的历史资料位于 `docs/migration/`、`docs/sync/`，不扩大或缩减本次 Coding 迁移目标。
