import type { AdapterId, Device } from './common.js';

/**
 * 指标名。运行时数组 → 编译期联合类型，zod schema 与诊断规则共用同一份来源。
 */
export const METRIC_NAMES = [
  // Core Web Vitals
  'LCP',
  'CLS',
  'INP',
  // 其它实验室指标
  'FCP',
  'TTFB',
  'TBT',
  'SI',
  // 体积与资源类
  'JS_SIZE',
  'CSS_SIZE',
  'IMAGE_SIZE',
  'TRANSFER_SIZE',
  'REQUEST_COUNT',
  'DUPLICATE_DEPS',
  'UNUSED_DEPS',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/**
 * 指标是否「越小越好」。
 *
 * 趋势与差值的方向判断都靠它：LCP 从 3500 降到 2000 是**改善**，
 * 光看数字变化的正负会把方向搞反 —— 而搞反之后报告**看起来很合理**：
 * 一次真实的性能劣化会被写成"改善 1500ms"。
 *
 * 目前 14 个指标全部是越小越好（性能指标的常态），因此这里是一个显式集合
 * 而不是 `Record<MetricName, boolean>`：将来真出现"越大越好"的指标
 * （比如自定义的可用性评分），把名字从这里移出去即可，测试会指出漏改的地方。
 */
export const HIGHER_IS_BETTER = new Set<MetricName>([]);

/** 指标是否越小越好 */
export function isLowerBetter(name: MetricName): boolean {
  return !HIGHER_IS_BETTER.has(name);
}

export const METRIC_UNITS = ['ms', 'score', 'byte', 'count'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export const RATINGS = ['good', 'needs-improvement', 'poor'] as const;
export type Rating = (typeof RATINGS)[number];

/**
 * 适配器产出的**未打分**样本：只有名字和值。
 *
 * 刻意不让 adapter 产出 `Metric`：`unit` / `rating` / `score` 由规格表加项目阈值唯一决定，
 * 如果每个 adapter 各自算一遍，迟早出现两个 adapter 对同一指标给出不同 rating。
 * 打分统一在 core/collector 完成，阈值覆盖也就在那一个地方生效。
 */
export interface MetricSample {
  name: MetricName;
  value: number;
}

export interface Metric {
  name: MetricName;
  value: number;
  unit: MetricUnit;
  rating: Rating;
  /** 归一化到 0-100，越大越好。统一打分尺度，供收益计算与门禁使用 */
  score: number;
  route: string;
  device: Device;
  /** 产出该指标的 adapter，便于追溯数据来源 */
  source: AdapterId;
  collectedAt: string;
}

/**
 * 指标变化。所有差值字段均已按「正 = 改善」统一方向，
 * 无论原始指标是「越小越好」还是「越大越好」。
 */
export interface MetricDelta {
  name: MetricName;
  baseline: number | null;
  current: number;
  /** 正 = 改善，负 = 回归，单位与指标一致 */
  delta: number | null;
  /** 正 = 改善，负 = 回归，百分比 */
  deltaPercent: number | null;
  baselineScore: number | null;
  currentScore: number;
  /** 正 = 改善，负 = 回归，纯分数差。门禁与决策用这个字段 */
  scoreDelta: number | null;
}
