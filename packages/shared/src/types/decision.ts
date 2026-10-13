import type { RiskLevel } from './candidate.js';

/**
 * 决策结论（README §9.3）。
 *
 * - apply：全自动执行（A 类）
 * - confirm：生成 patch 待人工确认（B 类）
 * - suggest：仅建议，不产出 patch（C 类）
 * - reject：不做（收益太低 / 风险太高 / 不在白名单）
 *
 * 顺序即优先级：apply > confirm > suggest > reject。
 */
export const VERDICTS = ['apply', 'confirm', 'suggest', 'reject'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Jev 工具路由（README §9.2）。
 *
 * 决策层同时决定「这件事交给谁做」：
 * - ast-rewriter：ts-morph 改写 JS/TS 语法树
 * - asset-processor：sharp 处理图片/字体等二进制资产
 * - config-editor：结构化改写构建/框架配置
 * - dependency-editor：package.json 依赖增删改
 * - manual：C 类 / 不可逆，只出建议不执行
 */
export const TOOL_ROUTES = [
  'ast-rewriter',
  'asset-processor',
  'config-editor',
  'dependency-editor',
  'manual',
] as const;
export type ToolRoute = (typeof TOOL_ROUTES)[number];

/**
 * Jev 效用的四项分量（README §9.1）。
 *
 * 每一项都是 0-100 或 0-1 的归一化值，便于单独测试与解释。
 * 最终 utility = expectedGain × confidence − cost − λ × risk。
 */
export interface UtilityBreakdown {
  /** Σ w_m × gainNorm_m，归一化到 0-100 */
  expectedGain: number;
  /** 0-1，候选置信度（含记忆召回调整） */
  confidence: number;
  /** 0-100：改动面 × effort × 可逆性折扣 */
  cost: number;
  /** 0-100：class 权重 × 改动文件数 × 是否触碰核心路径 */
  risk: number;
}

/**
 * 决策阈值快照。
 *
 * **必须写进 Decision**：同一份输入永远得到同一份决策，
 * 这是 CI 里敢开自动化的前提。历史决策要能复现，
 * 靠的就是这份阈值快照 —— 即使后来配置改了，旧决策的结论依然可解释。
 *
 * 命名特意带 `Snapshot`：配置文件里的 `decision.thresholds`（snake_case，
 * 由 `schema/config.ts` 反推出 `DecisionThresholdsConfig`）是**配置源**，
 * 这里是它被采纳后的**留痕**。两者形状不同（camelCase）、语义不同，
 * 用同一个名字会让「拿配置去比历史决策」变成一件容易搞错的事。
 */
export interface DecisionThresholdSnapshot {
  /** 最小收益（归一化分数），低于此值不保留 */
  minGain: number;
  /** 允许的最大回归（分数） */
  maxRegression: number;
  /** 新增错误数上限 */
  maxNewErrors: number;
  /** utility ≥ 此值 → apply */
  applyScore: number;
  /** utility ≥ 此值 → confirm（须 ≤ applyScore） */
  confirmScore: number;
}

/**
 * 决策记录。
 *
 * `core/decision` 是全项目**唯一的决策入口**，executor 与 planner 都无权决定「改不改」。
 * 决策模块是纯函数、确定性、**禁止调用 LLM**（硬约束 7）。
 */
export interface Decision {
  id: string;
  runId: string;
  candidateId: string;
  verdict: Verdict;
  route: ToolRoute;
  /** Jev 效用值，越大越值得做（可正可负） */
  score: number;
  utility: UtilityBreakdown;
  riskLevel: RiskLevel;
  /** 决策理由，必须可解释（进报告、进 MR 评论） */
  reasons: string[];
  thresholds: DecisionThresholdSnapshot;
  decidedAt: string;
}
