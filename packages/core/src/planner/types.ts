import type {
  Bottleneck,
  Candidate,
  MetricName,
  PlannedChange,
  RiskLevel,
  Effort,
  OptimizationClass,
} from '@yuki-byte18/shared';

/**
 * 规划规则的上下文。
 *
 * 与诊断规则的 `RuleContext` 不同：规划阶段已经有了瓶颈结论，
 * 规则只需要把瓶颈「翻译」成候选方案，不需要再看原始产物。
 */
export interface PlannerContext {
  runId: string;
  project: string;
  route: string;
  /** 当前 run 的全部瓶颈（规则可能需要跨瓶颈参考，例如「同时有大图和未压缩」） */
  bottlenecks: readonly Bottleneck[];
}

/**
 * 单条规划规则：输入瓶颈 → 输出候选。
 *
 * 一条瓶颈可能被多条规则命中（例如 OVERSIZED_IMAGE 既可以压缩也可以转 WebP），
 * planner 会合并所有规则的输出并去重。
 */
export interface PlannerRule {
  /** 稳定标识 */
  id: string;
  /** 该规则处理的瓶颈种类 */
  kind: Bottleneck['kind'];
  description: string;
  /** 对单个瓶颈生成候选；无方案时返回空数组 */
  plan(bottleneck: Bottleneck, ctx: PlannerContext): Candidate[];
}

/**
 * 规划规则的公共辅助：构造候选。
 *
 * 所有确定性规则都走这个函数，保证字段齐全、置信度统一（0.9）。
 */
/** C 类「仅建议」也必须带至少一条 PlannedChange，才能过 CandidateSchema.min(1) */
export function suggestionChange(key: string, description: string): PlannedChange {
  return {
    type: 'config',
    file: '.perfpilot/suggestions.md',
    key,
    before: null,
    after: description,
  };
}

export function buildRuleCandidate(input: {
  id: string;
  runId: string;
  bottleneck: Bottleneck;
  ruleId: string;
  class: OptimizationClass;
  title: string;
  description: string;
  changes: PlannedChange[];
  expectedGain: Partial<Record<MetricName, number>>;
  risk: RiskLevel;
  effort: Effort;
  reversible: boolean;
  /**
   * 覆盖默认置信度（0.9）。
   *
   * 规则本身是确定性的，但"这条规则在这个场景能带来多少收益"未必 ——
   * 收益靠**估计**的规则（例如按经验折算 LCP 改善）就该把置信度降下来，
   * 让效用模型按"不太确定"去权衡，而不是让所有规则都自称 90% 有把握。
   */
  confidence?: number;
}): Candidate {
  return {
    id: input.id,
    runId: input.runId,
    bottleneckIds: [input.bottleneck.id],
    class: input.class,
    title: input.title,
    description: input.description,
    origin: 'rule',
    ruleId: input.ruleId,
    promptVersion: null,
    changes: input.changes,
    expectedGain: input.expectedGain,
    // 规则命中的置信度默认 0.9：规则是确定性的，但「这条规则在这个场景适用」仍有不确定性
    confidence: input.confidence ?? 0.9,
    risk: input.risk,
    effort: input.effort,
    reversible: input.reversible,
    recalledFrom: [],
    bottleneckKinds: [input.bottleneck.kind],
  };
}
