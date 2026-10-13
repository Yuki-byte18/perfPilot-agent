# ADR 001：为什么用 Monorepo

- **状态**：已采纳
- **日期**：M1
- **相关**：README §4 架构、硬约束 1/2/3

---

## 背景

PerfPilot 被拆成六个包：`shared` / `adapters` / `core` / `cli` / `server` / `web`。
拆分理由是职责不同、依赖方向不同，但**它们共享同一套类型契约**：

```
Metric · Bottleneck · Diagnosis · Candidate · Decision · Verification · Config
```

这些类型不是"数据结构"，而是**层与层之间的接口**。
`core/diagnoser` 产出 `Bottleneck`，`core/planner` 消费它；`core/decision` 产出 `Decision`，
M5 的 executor 消费它。改一个字段，从产出方到消费方要同时改。

分仓方案下，类型只能靠"发 npm 包 + 升版本 + 各仓分别升级"来同步。对一个还在快速演进、
接口每周都在动的项目，这意味着每次字段调整都要走一遍发布流程。

## 决策

**pnpm workspaces 单仓，六个包全部放在 `packages/` 下。**

依赖方向的约束**不靠仓库边界**（六个包在一个仓里，物理上没有边界），
而是靠 `eslint.config.js` 里的 `@typescript-eslint/no-restricted-imports` 规则在构建期强制。

## 理由

### 1. 类型重构的成本差异是数量级的

M1–M4 期间发生过一次大型类型重构：把 7 个手写接口（`Bottleneck` / `Attribution` /
`Evidence` / `Candidate` / `PlannedChange` / `Diagnosis` / `Verification`）
全部改成由 zod schema 用 `z.infer` 反推，同时把两个纯函数从 `types/` 挪到 `utils/`。

单仓下这是一次提交、一次 `pnpm build` 验证。分仓要动 4 个包、发 4 个版本、
在每个仓里再各跑一次测试。

### 2. 边界规则本来就比仓库边界更严格

分仓带来的"物理隔离"在这里是**多余的**：真正要防的不是"别人 import 我的包"，
而是"`core` 直接 import 了 `lighthouse` 适配器"。这条规则无论单仓分仓都要靠工具强制
（见 ADR 005 的取舍）。既然强制手段一样，分仓只多了运维成本。

### 3. turbo 缓存把"单仓 CI 慢"这个主要缺点压掉了

实测 `pnpm check`（lint + 依赖环检测 + typecheck + 覆盖率）在缓存命中时 100ms 级完成，
全量重跑约 3.5s。这个开销在 6 个包的规模下完全不是问题。

## 取舍

**放弃了**：仓库级的物理隔离。任何人在任何包里都能"不小心" import 另一个包 ——
只能靠 lint 拦住，拦不住就等于没有。

**换来了**：类型契约改一次全局生效；一次 `pnpm check` 覆盖全部六个包；
构建配置（tsconfig / eslint / vitest）只有一份。

**代价明确**：`eslint.config.js` 从"可选项"变成了**架构的一部分**。
它不是风格检查，而是硬约束 2/3/4/5/6/7 的执行者。删掉它，架构声明就退化成文档承诺。
