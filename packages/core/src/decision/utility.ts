import {
  resolveSpec,
  type Candidate,
  type MetricName,
  type MetricThresholdsOverride,
  type MetricWeightsOverride,
  type UtilityBreakdown,
} from '@yuki-byte18/shared';

/**
 * Jev 效用模型的四项分量。
 *
 * 本模块是**纯函数集合**：没有 IO、没有 LLM、没有随机数。
 * 同一份输入永远得到同一份输出 —— 这是 CI 里敢开自动化的前提（M4 验收标准 1）。
 */

/**
 * 默认指标权重（README §9.1）。
 *
 * LCP 0.35 / INP 0.25 / CLS 0.25 是 Core Web Vitals 的三项，合计 0.85；
 * 体积类合计 0.15。权重和归一到 1，保证 expectedGain 落在 0-100。
 *
 * 为什么 Core Web Vitals 占绝对多数：它们是**用户可感知**的指标。
 * 体积再小，如果 LCP 依然是 4 秒，用户还是觉得慢。
 */
export const DEFAULT_METRIC_WEIGHTS: Record<MetricName, number> = {
  // Core Web Vitals —— 合计 0.85
  LCP: 0.35,
  INP: 0.25,
  CLS: 0.25,
  // 其余实验室指标 —— 不单独计权（它们是 CWV 的成因，不是结论）
  FCP: 0,
  TTFB: 0,
  TBT: 0,
  SI: 0,
  // 体积类 —— 合计 0.15
  JS_SIZE: 0.06,
  CSS_SIZE: 0.02,
  IMAGE_SIZE: 0.04,
  TRANSFER_SIZE: 0.03,
  // 计数类不给权重：它们是症状描述，收益难以量化到单一数值
  REQUEST_COUNT: 0,
  DUPLICATE_DEPS: 0,
  UNUSED_DEPS: 0,
};

/**
 * 改动面与投入对应的成本分量。
 *
 * 刻度刻意压小：整条效用式的量纲是「归一化收益分」，而日常改动的
 * 归一化收益本来就在个位数到几十之间。成本若按 0-100 铺开，
 * 一个改一个文件的简单改动就要扣掉 15 分，任何收益都填不平这个坑。
 */
const EFFORT_COST = { low: 1, medium: 4, high: 8 } as const;
/** 每多碰一个文件增加的成本，以及上限 */
const COST_PER_FILE = 2;
const MAX_SURFACE_COST = 12;

/** 分级对应的基础风险 */
const CLASS_RISK = { A: 2, B: 6, C: 12 } as const;
/** 每多碰一个文件的风险放大，以及不可逆的放大倍数 */
const RISK_PER_FILE = 0.15;
const IRREVERSIBLE_RISK_FACTOR = 1.5;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 把「预期节省的原始单位」归一化成 0-100 的分数收益。
 *
 * 用该指标的 `(poor - good)` 跨度作分母：省下 300ms 的 LCP
 * （good=2500 / poor=4000，跨度 1500ms）等于 20 分。
 *
 * 刻意不用 `saving / current`：那样一个本来就很小的指标会得到虚高的收益
 * —— LCP 从 300ms 省 100ms 是 33%，但它本来就已经远超标准，改进没有意义。
 * 用跨度作分母，「离标准有多远」这个信息才被正确表达。
 */
export function normalizeGain(
  name: MetricName,
  saving: number,
  overrides?: MetricThresholdsOverride | undefined,
): number {
  if (!Number.isFinite(saving) || saving <= 0) return 0;

  const spec = resolveSpec(name, overrides);
  const span = spec.poor - spec.good;
  // 跨度为零或负（配置写反了）时无法归一化，记 0 而不是给一个假的满分
  if (span <= 0) return 0;

  return clamp((saving / span) * 100, 0, 100);
}

/**
 * expectedGain：候选所涉指标归一化收益的**加权平均**，0-100。
 *
 * ```
 * expectedGain = Σ_m w_m × gainNorm_m / Σ_m w_m
 * ```
 *
 * **为什么要除以 Σw 而不是直接加权求和。** 最初写成 `Σ w_m × gainNorm_m`，
 * 结果在真实数据上全线崩溃：图片体积权重 0.04，一张 900KB 的图转 WebP 省 80KB
 * 只算出 `0.04 × 8 ≈ 0.3` 分收益，而成本与风险是两位数，utility 恒为负 ——
 * **没有任何候选能通过阈值，整套决策形同虚设**。
 *
 * 根因是权重被用错了地方：权重要回答的是「哪个指标的改进更值钱」，
 * 用于在**多个候选之间**排序；而不是让「只影响次要指标的候选」整体缩水。
 * 一个只优化图片体积的候选，不该因为没有顺带优化 LCP 就被判成不值得做。
 *
 * 取加权平均后：只碰 IMAGE_SIZE 的候选按它在 IMAGE_SIZE 上的完成度计分；
 * 同时碰 LCP 与体积的候选则被高权重那一项主导 —— 权重的作用保留，
 * 而量纲与 cost / risk 对齐了。
 */
export function computeExpectedGain(
  candidate: Pick<Candidate, 'expectedGain'>,
  weights: MetricWeightsOverride = {},
  overrides?: MetricThresholdsOverride | undefined,
): number {
  let weighted = 0;
  let weightSum = 0;

  for (const [key, saving] of Object.entries(candidate.expectedGain)) {
    if (saving === undefined) continue;
    const name = key as MetricName;
    // 显式配置的权重优先；未配置时用内置默认
    const weight = weights[name] ?? DEFAULT_METRIC_WEIGHTS[name] ?? 0;
    if (weight === 0) continue;

    weighted += weight * normalizeGain(name, saving, overrides);
    weightSum += weight;
  }

  // 只影响零权重指标（如 REQUEST_COUNT）时没有可加权的东西，记 0
  if (weightSum === 0) return 0;

  return clamp(Math.round((weighted / weightSum) * 100) / 100, 0, 100);
}

/**
 * cost：改动面 × 投入，0-100。
 *
 * 只反映「做这件事要花多少功夫」，不反映「做错有多糟」—— 后者是 risk。
 * 两者混在一起会让「改一行但风险高」和「改十个文件但很安全」得到同一个分数，
 * 而它们的处理方式完全不同。
 */
export function computeCost(candidate: Pick<Candidate, 'changes' | 'effort'>): number {
  const files = new Set(candidate.changes.flatMap((c) => ('file' in c ? [c.file] : [])));
  const surface = Math.min(MAX_SURFACE_COST, files.size * COST_PER_FILE);
  return clamp(surface + EFFORT_COST[candidate.effort], 0, 100);
}

/**
 * risk：分级权重 × 改动面 × 可逆性，0-100。
 *
 * 不可逆的改动风险放大 1.5 倍 —— 这类改动一旦出问题只能靠人回滚，
 * 而本项目的自动化前提正是「失败能自动回滚」。
 */
export function computeRisk(
  candidate: Pick<Candidate, 'changes' | 'class' | 'reversible'>,
): number {
  const files = new Set(candidate.changes.flatMap((c) => ('file' in c ? [c.file] : [])));
  const factor = 1 + files.size * RISK_PER_FILE;
  const base = CLASS_RISK[candidate.class] * factor;
  const withReversibility = candidate.reversible ? base : base * IRREVERSIBLE_RISK_FACTOR;

  return clamp(Math.round(withReversibility), 0, 100);
}

export interface UtilityInput {
  candidate: Candidate;
  metricWeights?: MetricWeightsOverride;
  riskAversion?: number;
  thresholds?: MetricThresholdsOverride | undefined;
}

export interface UtilityResult {
  /** Jev 效用值，可正可负。越大越值得做 */
  score: number;
  /** 四项分量一起给出：报告与 MR 评论要能解释「为什么这么判」 */
  breakdown: UtilityBreakdown;
}

/**
 * Jev 效用值（README §9.1）。
 *
 * ```
 * utility = expectedGain × confidence − cost − λ × risk
 * ```
 *
 * `confidence` 是**乘数**而不是加项：一个把握只有 50% 的改动，
 * 它的期望收益本来就该打对折。而 `cost` 与 `risk` 是减项 ——
 * 无论收益多大，该花的功夫和该担的风险都不会因此消失。
 */
export function computeUtility(input: UtilityInput): UtilityResult {
  const { candidate } = input;
  const riskAversion = input.riskAversion ?? 1;

  const breakdown: UtilityBreakdown = {
    expectedGain: computeExpectedGain(candidate, input.metricWeights ?? {}, input.thresholds),
    confidence: clamp(candidate.confidence, 0, 1),
    cost: computeCost(candidate),
    risk: computeRisk(candidate),
  };

  const score =
    Math.round(
      (breakdown.expectedGain * breakdown.confidence -
        breakdown.cost -
        riskAversion * breakdown.risk) *
        100,
    ) / 100;

  return { score, breakdown };
}
