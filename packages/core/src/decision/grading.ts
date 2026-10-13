import type {
  Candidate,
  DecisionThresholdSnapshot,
  OptimizationConfig,
  OptimizationClass,
  PerfPilotConfig,
  Verdict,
} from '@yuki-byte18/shared';

/**
 * 裁决与白名单门禁。
 *
 * 纯函数：不含 LLM、不含 IO、不含随机数（硬约束 7）。
 */

/** reject 的下界：utility 低于此值不做任何动作 */
export const DEFAULT_REJECT_FLOOR = 0;

/**
 * 白名单门禁。
 *
 * 配置里的三个列表（`auto_fix` / `manual_confirm` / `suggest_only`）
 * 声明了「哪些瓶颈允许走到哪一级自动化」。这里做两件事：
 *
 * 1. **完全没出现的 kind → 拒绝**。用户没把它列进任何列表，说明还没想好，
 *    那就不要自作主张。
 * 2. **出现在更低一级的列表里 → 降级**。例如 kind 只在 `suggest_only` 里，
 *    而规划器给了个 A 类候选：按用户的意思降到 C 类，而不是照旧自动执行。
 *
 * `configured` 为空时**不做门禁**：默认配置下三个列表都是空数组，
 * 若把「空」解读为「什么都不允许」，开箱即用会变成一条建议都不给。
 * 「没配置」与「配了但没包含」是两回事。
 */
export interface AllowlistResult {
  allowed: boolean;
  /** 允许的最高级别；null 表示被拒绝 */
  maxClass: OptimizationClass | null;
  reason: string;
}

export function checkAllowlist(
  candidate: Pick<Candidate, 'class' | 'bottleneckKinds'>,
  optimization: OptimizationConfig,
): AllowlistResult {
  const lists: Array<[OptimizationClass, readonly string[]]> = [
    ['A', optimization.auto_fix],
    ['B', optimization.manual_confirm],
    ['C', optimization.suggest_only],
  ];

  const configured = lists.flatMap(([, kinds]) => kinds);
  if (configured.length === 0) {
    return { allowed: true, maxClass: candidate.class, reason: '未配置白名单，不做限制' };
  }

  // 找出该候选覆盖的瓶颈在哪些列表里出现过
  const perKind: OptimizationClass[] = candidate.bottleneckKinds.map((kind) => {
    for (const [klass, kinds] of lists) {
      if (kinds.includes(kind)) return klass;
    }
    return 'C'; // 不在任何列表里，按最保守处理，下面统一拒绝
  });

  const missing = candidate.bottleneckKinds.filter((kind) => !configured.includes(kind));
  if (missing.length > 0) {
    return {
      allowed: false,
      maxClass: null,
      reason: `瓶颈 ${missing.join('、')} 不在 optimization 的任何白名单里`,
    };
  }

  // 取最保守的那个级别（A 最激进、C 最保守）
  const order: OptimizationClass[] = ['A', 'B', 'C'];
  const mostConservative = perKind.reduce((acc, k) =>
    order.indexOf(k) > order.indexOf(acc) ? k : acc,
  );

  if (order.indexOf(mostConservative) > order.indexOf(candidate.class)) {
    return {
      allowed: true,
      maxClass: mostConservative,
      reason: `候选为 ${candidate.class} 类，但白名单只允许到 ${mostConservative} 类，已降级`,
    };
  }

  return { allowed: true, maxClass: candidate.class, reason: '白名单允许当前级别' };
}

/** 分级 → 允许的裁决集合。A 级候选可以在分数不够时退而求其次 */
const VERDICT_ORDER: readonly Verdict[] = ['apply', 'confirm', 'suggest', 'reject'];

export interface GradeInput {
  utility: number;
  klass: OptimizationClass;
  thresholds: DecisionThresholdSnapshot;
  /** 白名单允许的最高级别；null 表示被白名单拒绝 */
  maxClass: OptimizationClass | null;
  /** 仅用于生成可读理由 */
  bottleneckKinds?: readonly string[];
}

export interface GradeResult {
  verdict: Verdict;
  reasons: string[];
}

/**
 * A/B/C ↔ apply/confirm/suggest 的映射（README §9.3）。
 *
 * ```
 * A 类：utility ≥ applyScore → apply；≥ confirmScore → confirm；否则 reject
 * B 类：utility ≥ confirmScore → confirm；否则 reject
 * C 类：utility > rejectFloor → suggest；否则 reject
 * ```
 *
 * **级别是天花板，分数是地板**：一个 A 类候选只有分数真的够高才自动执行，
 * 分数不够就降到「生成 patch 等人确认」，而不是「因为是 A 类所以照做」。
 * 反过来，C 类永远不会升格成 confirm —— 用户明确说了这类只出建议。
 */
export function grade(input: GradeInput): GradeResult {
  const { utility, klass, thresholds, maxClass } = input;
  const reasons: string[] = [];

  if (maxClass === null) {
    return { verdict: 'reject', reasons: ['白名单未覆盖，拒绝'] };
  }

  // 白名单降级后的实际级别
  const order: OptimizationClass[] = ['A', 'B', 'C'];
  const effective = order.indexOf(maxClass) > order.indexOf(klass) ? maxClass : klass;
  if (effective !== klass) {
    reasons.push(`白名单将 ${klass} 类降级为 ${effective} 类`);
  }

  reasons.push(
    `utility=${utility}（apply ≥ ${thresholds.applyScore}，confirm ≥ ${thresholds.confirmScore}）`,
  );

  if (effective === 'C') {
    if (utility > DEFAULT_REJECT_FLOOR) {
      reasons.push('C 类仅建议，不产出 patch');
      return { verdict: 'suggest', reasons };
    }
    reasons.push('utility 未超过拒绝下界');
    return { verdict: 'reject', reasons };
  }

  if (effective === 'B') {
    if (utility >= thresholds.confirmScore) {
      reasons.push('B 类生成 patch，等待人工确认');
      return { verdict: 'confirm', reasons };
    }
    reasons.push(`utility 低于 confirm 阈值 ${thresholds.confirmScore}`);
    return { verdict: 'reject', reasons };
  }

  // A 类
  if (utility >= thresholds.applyScore) {
    reasons.push('A 类且分数达标，全自动执行');
    return { verdict: 'apply', reasons };
  }
  if (utility >= thresholds.confirmScore) {
    reasons.push(`A 类但 utility 低于 apply 阈值 ${thresholds.applyScore}，降为待确认`);
    return { verdict: 'confirm', reasons };
  }

  reasons.push(`utility 低于 confirm 阈值 ${thresholds.confirmScore}`);
  return { verdict: 'reject', reasons };
}

/** 从配置抽出写进 Decision 的阈值快照 */
export function thresholdsFromConfig(config: PerfPilotConfig): DecisionThresholdSnapshot {
  const t = config.decision.thresholds;
  return {
    minGain: t.min_gain,
    maxRegression: t.max_regression,
    maxNewErrors: t.max_new_errors,
    applyScore: t.apply_score,
    confirmScore: t.confirm_score,
  };
}

export { VERDICT_ORDER };
