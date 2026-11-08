# Pi-durable coding agent 内核文档

MkAgent 原先以 Pi coding agent 为底座，第一次内核切换已采用 pi-durable。pi-durable 本身已有较完整的执行、工具、存储和恢复能力；本次为它补齐 Coding 能力和 Pi 插件生态，形成 `pi-durable coding agent`，同时保持 MkAgent 上层功能完整且正常。

2026-11-08 用户要求全面纠正迁移中的偏差，先修正文档，再逐项落实架构、代码和测试。每项能力依次选择：pi-durable 内置实现、独立 Pi 官方 SDK 的公开 API、必要的外部薄适配、经具体缺口论证的源码移植或补丁。`pi-agent-core` 可以按需引用，生产禁止依赖完整 `pi-coding-agent` 包。

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

历史规格保留原日期和检查结果，其中的旧 `pi-agent-core` 禁令、功能差异和实现步骤不构成当前要求。架构调整仍须保留现有权限、取消、错误、持久化、恢复和公开插件行为。

通用系统架构见[英文架构文档](../architecture.md)、[中文架构文档](../zh/architecture.md)和[架构图](../architecture.html)。产品裁剪与上游同步的历史资料位于 `docs/migration/`、`docs/sync/`，不扩大或缩减本次 Coding 迁移目标。
