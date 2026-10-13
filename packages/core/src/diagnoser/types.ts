import type {
  Attribution,
  BaselineRef,
  BottleneckKind,
  Evidence,
  Metric,
  MetricDelta,
  MetricName,
  MetricThresholdsOverride,
  PerfPilotConfig,
  RawArtifact,
  SourceMapPort,
} from '@yuki-byte18/shared';

/**
 * 规则看到的全部上下文。
 *
 * 刻意**不给规则访问 store / logger / 网络**：诊断必须是纯计算 ——
 * 同样的 run 重跑诊断，必须得到同样的瓶颈列表。任何 IO 都通过
 * `sourceMap` 这一个受控端口进来（它也只在需要时读 .map 文件）。
 */
export interface RuleContext {
  metrics: readonly Metric[];
  deltas: readonly MetricDelta[];
  artifacts: readonly RawArtifact[];
  baseline: BaselineRef | null;
  config: PerfPilotConfig;
  /** Source Map 解析；未配置时为 null，规则需据此降级 */
  sourceMap: SourceMapPort | null;
  /** 项目级阈值覆盖 */
  thresholds: MetricThresholdsOverride;
}

/** 便捷取值：规则里几乎每条都要看某个指标在不在、值是多少 */
export function metricOf(ctx: RuleContext, name: MetricName): Metric | undefined {
  return ctx.metrics.find((m) => m.name === name);
}

export function metricValue(ctx: RuleContext, name: MetricName): number | null {
  return metricOf(ctx, name)?.value ?? null;
}

/**
 * 单条规则命中的一次「检测」。
 *
 * 检测还不是瓶颈：同一个根因可能被命中很多次（12 张超标图片），
 * 由 `mergeDetections` 合并成一条带 `occurrences` 的 Bottleneck。
 */
export interface Detection {
  /**
   * 合并键。`kind` 相同且 `mergeKey` 相同的检测会被合并成一条瓶颈，
   * 因此规则要按**可操作主体**给键：同目录下的图片一组、同一个包一组，
   * 而不是每张图一个键。
   */
  mergeKey: string;
  title: string;
  /** 0-100 */
  severity: number;
  impact: Partial<Record<MetricName, number>>;
  attribution: Attribution;
  evidence: Evidence[];
  /** 0-1 */
  confidence: number;
}

export interface DiagnosticRule {
  /** 稳定标识，进报告与配置白名单；改名即视为新规则 */
  id: string;
  kind: BottleneckKind;
  /** 一句话说明这条规则在找什么，用于 `perfpilot diagnose --explain` 与文档 */
  description: string;
  detect(ctx: RuleContext): Promise<Detection[]> | Detection[];
}

/**
 * 严重度曲线：在「刚好越线」与「确实很糟」之间做对数插值。
 *
 * `threshold` → 0 分，`severe` → 100 分，中间按对数上升。
 *
 * 为什么不用 `实测 / 阈值` 直接取对数：那样每条规则的曲线由它的阈值决定，
 * 而阈值的语义各不相同 —— 「文本资源至少 10KB 才值得压缩」里的 10KB 是
 * **最低可讨论线**，「单 chunk 超过 250KB 该拆」里的 250KB 是**决策线**。
 * 拿 10KB 当分母，一个 180KB 的文档算出 ratio=18、分数直接顶满 100，
 * 于是缓存缺失、未压缩、大图全都显示「100 分」——严重度就失去了区分能力，
 * 报告变成一堆并列的满分项。
 *
 * 显式给出每条规则的 `severe` 基准后，分数才反映「离最坏情况还有多远」。
 */
export function severityBetween(value: number, threshold: number, severe: number): number {
  if (!Number.isFinite(value) || value <= threshold) return 0;
  if (severe <= threshold) return 100;

  const ratio = value / threshold;
  const severeRatio = severe / threshold;
  const score = (Math.log2(ratio) / Math.log2(severeRatio)) * 100;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 合并后的严重度：出现次数越多越严重，但对数衰减，避免直接顶满 */
export function severityWithOccurrences(baseSeverity: number, occurrences: number): number {
  if (occurrences <= 1) return baseSeverity;
  return Math.max(0, Math.min(100, Math.round(baseSeverity + 4 * Math.log2(occurrences))));
}
