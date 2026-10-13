# @yuki-byte18/core

引擎本体：**线性八段流水线**、决策层与报告渲染。它只认识 `shared` 里的端口，不认识任何具体工具（硬约束 4）。

```
collect → compare(diagnose) → plan → decide → execute → verify → keep/rollback → report
```

| 目录 | 做什么 |
| --- | --- |
| `pipeline/` | 把八段串起来，每段产出一条 `StageRecord`（连"为什么跳过"也要说清） |
| `collector/` `diagnoser/` | 采集归并、规则诊断；`diagnoser/agent.ts` 是 LLM 诊断 Agent（有上限、必须带证据） |
| `planner/` `decision/` | 候选规划与期望值裁决：`utility = 期望收益 × 置信度 − 成本 − 风险` |
| `executor/` `verifier/` `gate/` | 执行编排、验证与回滚、门禁判定 |
| `llm/` | **唯一的 LLM 出口**：prompt 版本、预算控制、失败降级 |
| `reporter/` | Markdown / JSON / HTML 三种报告 |

## 两条不能破的规则

1. **决策层不导入 `core/llm`**（硬约束 7）。诊断错得起 —— 它是给人看的、带证据、可复核；决策错不起 —— 它要被机器执行，必须可复现。
2. **LLM 始终是可选项。** `provider: none` 时零调用、零成本；`ai` SDK 是懒加载的可选依赖，装不上就自动退化成"仅规则库"，并在报告里写明原因。

## 安装

一般不需要单独安装：它是 `@yuki-byte18/cli` 的依赖。

## 许可

MIT
