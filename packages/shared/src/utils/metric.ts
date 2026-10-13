import type { AdapterId, Device } from '../types/common.js';
import type {
  Metric,
  MetricDelta,
  MetricName,
  MetricUnit,
  Rating,
} from '../types/metric.js';
import type { MetricThresholdsOverride } from '../schema/config.js';

export interface MetricSpec {
  unit: MetricUnit;
  direction: 'lower-is-better' | 'higher-is-better';
  /** 默认阈值：good 边界与 poor 边界，口径同 Web Vitals */
  good: number;
  poor: number;
  /** 报告展示的小数位 */
  precision: number;
}

/**
 * 指标规格表。阈值取自 Web Vitals 官方建议（2024 口径），
 * 体积类指标取「中等规模 SPA 的合理上限」，并可在 `.perfpilot.yml` 的
 * `baseline.metrics` 中逐项覆盖。
 */
export const METRIC_SPECS: Record<MetricName, MetricSpec> = {
  LCP: { unit: 'ms', direction: 'lower-is-better', good: 2500, poor: 4000, precision: 0 },
  INP: { unit: 'ms', direction: 'lower-is-better', good: 200, poor: 500, precision: 0 },
  CLS: { unit: 'score', direction: 'lower-is-better', good: 0.1, poor: 0.25, precision: 3 },
  FCP: { unit: 'ms', direction: 'lower-is-better', good: 1800, poor: 3000, precision: 0 },
  TTFB: { unit: 'ms', direction: 'lower-is-better', good: 800, poor: 1800, precision: 0 },
  TBT: { unit: 'ms', direction: 'lower-is-better', good: 200, poor: 600, precision: 0 },
  SI: { unit: 'ms', direction: 'lower-is-better', good: 3400, poor: 5800, precision: 0 },
  JS_SIZE: { unit: 'byte', direction: 'lower-is-better', good: 300_000, poor: 500_000, precision: 0 },
  CSS_SIZE: { unit: 'byte', direction: 'lower-is-better', good: 100_000, poor: 250_000, precision: 0 },
  IMAGE_SIZE: {
    unit: 'byte',
    direction: 'lower-is-better',
    good: 500_000,
    poor: 1_500_000,
    precision: 0,
  },
  TRANSFER_SIZE: {
    unit: 'byte',
    direction: 'lower-is-better',
    good: 1_000_000,
    poor: 3_000_000,
    precision: 0,
  },
  REQUEST_COUNT: {
    unit: 'count',
    direction: 'lower-is-better',
    good: 50,
    poor: 100,
    precision: 0,
  },
  DUPLICATE_DEPS: {
    unit: 'count',
    direction: 'lower-is-better',
    good: 0,
    poor: 5,
    precision: 0,
  },
  UNUSED_DEPS: { unit: 'count', direction: 'lower-is-better', good: 0, poor: 5, precision: 0 },
};

/** 分数区间：good 以内满分，good→poor 线性降到 50，poor 之后再线性降到 0 */
export const SCORE_MAX = 100;
export const SCORE_AT_POOR = 50;
export const SCORE_MIN = 0;

/**
 * 每个指标的**唯一数据来源优先级**。
 *
 * 这是质量门禁能成立的前提：基线与本次运行必须用同一个来源测量，
 * 否则「LCP 从 lighthouse 换成 web-vitals」会被误判成性能变化。
 * 多个 adapter 都能产出同一指标时，取优先级最高的那个；
 * 若走到了非首选来源，collector 会记一条 warning，让报告读者知道测量条件变了。
 */
export const METRIC_SOURCE_PRIORITY: Record<MetricName, readonly AdapterId[]> = {
  // 实验室指标以 Lighthouse 为准：标准化、可复现，适合做门禁
  LCP: ['lighthouse', 'web-vitals'],
  CLS: ['lighthouse', 'web-vitals'],
  FCP: ['lighthouse', 'web-vitals'],
  TTFB: ['lighthouse', 'har', 'web-vitals'],
  // 阻塞时间：Lighthouse 直接给 TBT；没有 Lighthouse 时用 Chrome trace 自己算
  TBT: ['lighthouse', 'trace'],
  SI: ['lighthouse'],
  TRANSFER_SIZE: ['lighthouse', 'har', 'web-vitals'],
  REQUEST_COUNT: ['lighthouse', 'har'],
  // INP 是交互延迟，Lighthouse 实验室环境测不准，以真实加载过程中的观测为准
  INP: ['web-vitals', 'lighthouse'],
  // 体积类以构建产物为准确来源（量的是「产物多大」），HAR 兜底（量的是「这次传了多少」）。
  // 两者口径不同，所以 HAR 只在前者缺席时使用，并且会触发 fallback 告警。
  JS_SIZE: ['bundle-analyzer', 'har'],
  CSS_SIZE: ['bundle-analyzer', 'har'],
  IMAGE_SIZE: ['bundle-analyzer', 'har'],
  DUPLICATE_DEPS: ['bundle-analyzer'],
  UNUSED_DEPS: ['bundle-analyzer'],
};


const EPSILON = 1e-9;

/**
 * 解析指标规格：项目配置里的 `warning` / `error` 覆盖默认 good / poor 边界。
 * `warning` = good 边界，`error` = poor 边界。
 */
export function resolveSpec(
  name: MetricName,
  overrides?: MetricThresholdsOverride | undefined,
): MetricSpec {
  const base = METRIC_SPECS[name];
  const override = overrides?.[name];
  if (!override) return base;
  return { ...base, good: override.warning, poor: override.error };
}

interface Normalized {
  value: number;
  good: number;
  poor: number;
}

/** 统一到「越小越好」空间，让打分函数只需处理一种方向 */
function normalize(value: number, spec: MetricSpec): Normalized {
  if (spec.direction === 'lower-is-better') {
    return { value, good: spec.good, poor: spec.poor };
  }
  return { value: -value, good: -spec.good, poor: -spec.poor };
}

/**
 * 指标打分，输出 0-100，越大越好。分段线性、单调、可解释 ——
 * 刻意不用 Lighthouse 的对数正态拟合：那个曲线需要按指标单独调参，
 * 而这里需要的是「任意指标都能同尺度比较」，可解释性优先于绝对精度。
 */
export function scoreMetric(value: number, spec: MetricSpec): number {
  if (!Number.isFinite(value)) return SCORE_MIN;

  const { value: v, good, poor } = normalize(value, spec);

  if (v <= good) return SCORE_MAX;

  // 退化情形：good 与 poor 重合，只能二值判断
  if (Math.abs(poor - good) < EPSILON) return SCORE_MIN;

  if (v <= poor) {
    return SCORE_MAX - (SCORE_MAX - SCORE_AT_POOR) * ((v - good) / (poor - good));
  }

  // poor 之后继续跌破到 0：以 poor 的绝对值作为衰减尺度
  const decayScale = Math.max(Math.abs(poor), EPSILON);
  return Math.max(SCORE_MIN, SCORE_AT_POOR - SCORE_AT_POOR * ((v - poor) / decayScale));
}

export function rateMetric(value: number, spec: MetricSpec): Rating {
  const { value: v, good, poor } = normalize(value, spec);
  if (v <= good) return 'good';
  if (v <= poor) return 'needs-improvement';
  return 'poor';
}

export interface BuildMetricArgs {
  name: MetricName;
  value: number;
  route: string;
  device: Device;
  source: AdapterId;
  collectedAt: string;
  overrides?: MetricThresholdsOverride | undefined;
}

/** 唯一构造 Metric 的入口，保证 score / rating / unit 与规格表一致 */
export function buildMetric(args: BuildMetricArgs): Metric {
  const spec = resolveSpec(args.name, args.overrides);
  return {
    name: args.name,
    value: args.value,
    unit: spec.unit,
    rating: rateMetric(args.value, spec),
    score: round(scoreMetric(args.value, spec), 2),
    route: args.route,
    device: args.device,
    source: args.source,
    collectedAt: args.collectedAt,
  };
}

/**
 * 计算单个指标的基线差异。
 *
 * 所有差值字段统一为「正 = 改善」：对 lower-is-better 指标，
 * delta = baseline - current；这样无论指标方向如何，上层判据都只需写 `> 0`。
 */
export function computeDelta(
  current: Metric,
  baseline: Metric | null,
  overrides?: MetricThresholdsOverride | undefined,
): MetricDelta {
  if (!baseline || !isComparable(current, baseline)) {
    return {
      name: current.name,
      baseline: baseline?.value ?? null,
      current: current.value,
      delta: null,
      deltaPercent: null,
      baselineScore: baseline?.score ?? null,
      currentScore: current.score,
      scoreDelta: null,
    };
  }

  const spec = resolveSpec(current.name, overrides);
  const sign = spec.direction === 'lower-is-better' ? 1 : -1;
  const delta = sign * (baseline.value - current.value);
  const deltaPercent =
    Math.abs(baseline.value) < EPSILON ? null : (delta / Math.abs(baseline.value)) * 100;

  return {
    name: current.name,
    baseline: baseline.value,
    current: current.value,
    delta: round(delta, 4),
    deltaPercent: deltaPercent === null ? null : round(deltaPercent, 2),
    baselineScore: baseline.score,
    currentScore: current.score,
    scoreDelta: round(current.score - baseline.score, 2),
  };
}

/**
 * 两次测量是否来自同一个 adapter。
 *
 * 跨来源的数字不可比：Lighthouse 的 LCP 与 web-vitals 的 LCP 是两种测量口径，
 * 直接相减得到的「回归」可能纯粹是换了工具造成的。
 */
export function isComparable(current: Metric, baseline: Metric): boolean {
  return current.source === baseline.source;
}

/** 找出本次与基线之间「换了测量来源」的指标，供上层显式告知用户 */
export function sourceChanges(
  current: readonly Metric[],
  baseline: readonly Metric[],
): Array<{ name: MetricName; from: AdapterId; to: AdapterId }> {
  const byName = new Map<MetricName, Metric>();
  for (const m of baseline) byName.set(m.name, m);

  const changes: Array<{ name: MetricName; from: AdapterId; to: AdapterId }> = [];
  for (const m of current) {
    const previous = byName.get(m.name);
    if (previous !== undefined && previous.source !== m.source) {
      changes.push({ name: m.name, from: previous.source, to: m.source });
    }
  }
  return changes;
}

/** 按当前指标集合逐个对齐基线；基线缺失的指标不编造数字，delta 保持 null */
export function computeDeltas(
  current: readonly Metric[],
  baseline: readonly Metric[],
  overrides?: MetricThresholdsOverride | undefined,
): MetricDelta[] {
  const byName = new Map<MetricName, Metric>();
  for (const m of baseline) byName.set(m.name, m);

  return current.map((m) => computeDelta(m, byName.get(m.name) ?? null, overrides));
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 按指标名排序，保证同一批指标的落盘顺序稳定（快照测试与 diff 友好） */
export function sortMetrics(metrics: readonly Metric[]): Metric[] {
  return [...metrics].sort((a, b) => a.name.localeCompare(b.name));
}
