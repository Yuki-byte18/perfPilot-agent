/**
 * 候选方案的**运行时枚举**。
 *
 * `Candidate` / `PlannedChange` 这两个对象类型由 `schema/candidate.ts`
 * 用 `z.infer` 反推 —— 原因见 `types/bottleneck.ts` 顶部的说明。
 */

/**
 * 优化分级（README §8）。
 *
 * 三个级别不是修辞，而是对应三种不同的落地策略：
 * - A：全自动，决策层直接 apply → 执行 → 验证 → 达标即保留
 * - B：半自动，生成 patch 后等人工确认（CI 里不自动合入）
 * - C：仅建议，只出现在报告与 MR 评论里，不产出 patch
 *
 * 分级由三个可量化维度决定（reversible × changeSurface × semanticRisk），
 * 详见 `core/decision` 的分级函数。
 */
export const OPTIMIZATION_CLASSES = ['A', 'B', 'C'] as const;
export type OptimizationClass = (typeof OPTIMIZATION_CLASSES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * 候选的来源。
 *
 * - `rule`：确定性规则库命中，置信度默认 ≥ 0.9
 * - `llm`：LLM 生成，置信度默认 ≤ 0.75，且必须经过 schema 校验
 */
export const CANDIDATE_ORIGINS = ['rule', 'llm'] as const;
export type CandidateOrigin = (typeof CANDIDATE_ORIGINS)[number];

/**
 * 计划改动的四种类型。
 *
 * 四类对应四种 `ToolRoute`（README §9.2）：
 * - ast → ast-rewriter（ts-morph）
 * - asset → asset-processor（sharp）
 * - config → config-editor
 * - dependency → dependency-editor
 *
 * 每类只带执行器需要的最小信息：执行器拿到 `PlannedChange` 就知道改哪里、怎么改，
 * 不需要回头去查 Candidate 的其它字段。
 */
export const PLANNED_CHANGE_TYPES = ['ast', 'asset', 'config', 'dependency'] as const;
export type PlannedChangeType = (typeof PLANNED_CHANGE_TYPES)[number];
