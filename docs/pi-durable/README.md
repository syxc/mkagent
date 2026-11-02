# Pi-durable 内核文档

本目录统一管理 pi-durable 内核切换产生的执行规格、修复规格和验收记录。各规格保留其基线与历史设计，当前实现以相应落地及验收章节为准。

| 文档 | 内容 |
|---|---|
| [内核切换执行规格](kernel-durable-switch-spec.md) | 原始设计、当前实现差异及内核升级回归清单 |
| [内核迁移审查问题修复规格](kernel-migration-review-fix-spec.md) | R1–R8 修复边界与最终集成验收 |
| [首页建议与 Web 可用性修复执行规格](starter-web-repair-spec.md) | 两个首页入口的故障确认、Web 实际验证及修复验收 |
| [Pi-durable 遗留修复与验收](kernel-legacy-fix-spec.md) | 宿主交互完成边界、MiniMax CN 模型身份及持久化清理竞态 |

通用系统架构仍见 [英文架构文档](../architecture.md)、[中文架构文档](../zh/architecture.md) 和 [架构图](../architecture.html)。产品裁剪与上游同步的历史资料分别保留在 `docs/migration/`、`docs/sync/`。
