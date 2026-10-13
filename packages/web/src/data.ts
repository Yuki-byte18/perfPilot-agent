import type {
  Bottleneck,
  Candidate,
  Decision,
  Metric,
  MetricDelta,
  MetricName,
  MetricSeries,
  RunRecord,
  RunSummary,
  StageRecord,
  Verification,
} from '@yuki-byte18/shared';
import type { RunDetail } from './api.js';

/**
 * 报告页的视图模型，全部由**纯函数**从 API 数据算出来。
 *
 * 抽成纯函数的理由不是"分层好看"，而是**这是唯一能测的部分**：
 * 组件渲染要靠 DOM 环境，而"时间线顺序对不对、概览数字算没算错"
 * 这些真正会出错的地方，用纯函数测既快又准。
 *
 * 注意这里**没有**趋势聚合：跨 run 的指标序列由服务端算好
 * （`core/trends`），前端只渲染。原因见 `api.ts` 里 `loadSeries` 的说明。
 *
 * ## 为什么这里有一份 shared 的"复制品"
 *
 * `web` 对 `@yuki-byte18/shared` 只有 **type-only** 依赖（硬约束 3），
 * 因此 `METRIC_SPECS` / `isLowerBetter` / `formatValue` 这些**值**拿不到。
 * 指标方向、单位格式化因此必须在这里再写一遍 —— 代价是两处要一起改，
 * 收益是报告页的产物体积不跟着后端类型走。
 */

// ─────────────────────────────────────────────────────────────────────
// 指标元信息（展示层副本）
// ─────────────────────────────────────────────────────────────────────

/**
 * 指标方向。`shared` 里 `HIGHER_IS_BETTER` 目前是**空集**（所有性能指标
 * 都是越小越好），但仍然写成一个表而不是硬编码 `<`：
 * 一旦出现"越大越好"的指标（比如覆盖率），这里改一行就够了。
 */
const HIGHER_IS_BETTER: ReadonlySet<MetricName> = new Set<MetricName>([]);

export function isLowerBetter(name: MetricName): boolean {
  return !HIGHER_IS_BETTER.has(name);
}

/** 一句话说明这个指标在测什么。报告页不假定读者知道 INP 是什么 */
const METRIC_HINT: Partial<Record<MetricName, string>> = {
  LCP: '最大内容绘制：首屏最大元素出现的时间',
  FCP: '首次内容绘制：第一个像素出现的时间',
  INP: '交互到下一次绘制：点击后的响应延迟',
  CLS: '累计布局偏移：页面元素意外移动的程度',
  TBT: '总阻塞时间：主线程被长任务占住的总时长',
  TTFB: '首字节时间：服务器开始响应的速度',
  SI: '速度指数：首屏内容填充的可视速度',
  JS_SIZE: 'JS 产物体积',
  CSS_SIZE: 'CSS 产物体积',
  IMAGE_SIZE: '图片产物体积',
  TRANSFER_SIZE: '网络传输总量',
  REQUEST_COUNT: '请求数量',
  DUPLICATE_DEPS: '重复依赖',
  UNUSED_DEPS: '未被使用的依赖',
};

export function metricHint(name: MetricName): string | null {
  return METRIC_HINT[name] ?? null;
}

/** 按单位格式化：LCP 880ms 与 CLS 0.12 都该看得清 */
export function formatMetric(value: number | null, unit: Metric['unit'] | null): string {
  if (value === null) return '—';

  switch (unit) {
    case 'ms':
      return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
    case 'byte':
      if (Math.abs(value) >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
      if (Math.abs(value) >= 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${Math.round(value)} B`;
    case 'score':
      return value.toFixed(3);
    case 'count':
      return String(Math.round(value));
    default:
      return formatNumber(value);
  }
}

/** 大数字与小数用不同精度 */
export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** 带正负号的差值：Δ 的正负是给人看的，不能只给绝对值 */
export function formatDelta(value: number | null, unit: Metric['unit'] | null): string {
  if (value === null) return '—';
  if (value === 0) return '0';
  const sign = value > 0 ? '+' : '−';
  return `${sign}${formatMetric(Math.abs(value), unit)}`;
}

// ─────────────────────────────────────────────────────────────────────
// 指标行：当前值 / 基线 / 变化 / 分数
// ─────────────────────────────────────────────────────────────────────

export type ChangeKind = 'improved' | 'regressed' | 'flat' | 'unknown';

export interface MetricRow {
  name: MetricName;
  unit: Metric['unit'] | null;
  hint: string | null;
  current: number | null;
  baseline: number | null;
  delta: number | null;
  deltaPercent: number | null;
  score: number | null;
  baselineScore: number | null;
  scoreDelta: number | null;
  rating: Metric['rating'] | null;
  source: Metric['source'] | null;
  lowerIsBetter: boolean;
  /** 改善 / 劣化 / 持平 / 不可比 */
  change: ChangeKind;
}

/**
 * 把 metrics 与 deltas 拼成一行行的对比表。
 *
 * 依据的是**并集**而不是只看 metrics：基线里有、这次没有的指标同样要列出来 ——
 * "上一轮测到了、这一轮没测到"是必须让人看见的信息，直接从表里消失
 * 就等于把"没测"读成了"没问题"。
 */
export function buildMetricRows(run: RunRecord): MetricRow[] {
  const metricOf = new Map(run.metrics.map((m) => [m.name, m]));
  const deltaOf = new Map(run.deltas.map((d) => [d.name, d]));
  const baselineOf = new Map((run.baseline?.metrics ?? []).map((m) => [m.name, m]));

  const names = new Set<MetricName>([
    ...metricOf.keys(),
    ...deltaOf.keys(),
    ...baselineOf.keys(),
  ]);

  const rows = [...names].map((name): MetricRow => {
    const metric = metricOf.get(name) ?? null;
    const delta = deltaOf.get(name) ?? null;
    const baseline = baselineOf.get(name) ?? null;

    const current = metric?.value ?? delta?.current ?? null;
    const baselineValue = baseline?.value ?? delta?.baseline ?? null;
    const lowerIsBetter = isLowerBetter(name);

    return {
      name,
      unit: metric?.unit ?? baseline?.unit ?? null,
      hint: metricHint(name),
      current,
      baseline: baselineValue,
      delta: delta?.delta ?? (current !== null && baselineValue !== null ? current - baselineValue : null),
      deltaPercent: delta?.deltaPercent ?? null,
      score: metric?.score ?? delta?.currentScore ?? null,
      baselineScore: delta?.baselineScore ?? baseline?.score ?? null,
      scoreDelta: delta?.scoreDelta ?? null,
      rating: metric?.rating ?? null,
      source: metric?.source ?? baseline?.source ?? null,
      lowerIsBetter,
      change: classify(delta, current, baselineValue),
    };
  });

  /**
   * 排序：先按"有没有问题"（劣化 > 改善 > 持平），再按分数升序。
   * 报告的第一屏应该是最该看的东西，而不是指标名的字母序。
   */
  const weight: Record<ChangeKind, number> = { regressed: 0, improved: 1, flat: 2, unknown: 3 };
  return rows.sort(
    (a, b) => weight[a.change] - weight[b.change] || (a.score ?? 101) - (b.score ?? 101),
  );
}

/**
 * 改善还是劣化。
 *
 * **只看 `scoreDelta` 的符号**，不看数值本身变大还是变小：
 * 分数已经把方向编码进去了（LCP 变小 → 分数变高），再去比一次数值方向
 * 等于把同一件事判断两遍，而两处判断迟早会不一致。
 */
function classify(
  delta: MetricDelta | null,
  current: number | null,
  baseline: number | null,
): ChangeKind {
  if (delta === null || delta.scoreDelta === null || current === null || baseline === null) {
    return 'unknown';
  }
  if (delta.scoreDelta === 0) return 'flat';
  return delta.scoreDelta > 0 ? 'improved' : 'regressed';
}

// ─────────────────────────────────────────────────────────────────────
// 趋势：只做展示层需要的派生，不做聚合
// ─────────────────────────────────────────────────────────────────────

/**
 * 趋势的展示形态。
 *
 * `MetricSeries` 已经带了 `change` / `sourceChanged` / `enoughData`，
 * 这里只补一个**方向**：数值变大是好事还是坏事，取决于指标。
 * 方向判断放在展示层，是因为它是"怎么画"的问题，不是"测到了什么"的问题。
 */
export interface TrendView {
  name: MetricSeries['name'];
  points: MetricSeries['points'];
  change: number | null;
  changePercent: number | null;
  sourceChanged: boolean;
  enoughData: boolean;
  /** 越大越好 / 越小越好 */
  betterDirection: 'up' | 'down';
  /** 变化是改善还是劣化；无法判断时为 null */
  improved: boolean | null;
  /** 最新一个数据点的原始值与单位（画图之外的文字信息） */
  latest: number | null;
  earliest: number | null;
  unit: Metric['unit'] | null;
  hint: string | null;
  /** 最小值 / 最大值，画折线时的刻度 */
  min: number | null;
  max: number | null;
}

export function toTrendViews(series: readonly MetricSeries[]): TrendView[] {
  return series.map((s) => {
    const betterDirection: 'up' | 'down' = isLowerBetter(s.name) ? 'down' : 'up';
    const improved =
      s.change === null ? null : betterDirection === 'down' ? s.change < 0 : s.change > 0;

    const values = s.points.map((p) => p.value);

    return {
      name: s.name,
      points: s.points,
      change: s.change,
      changePercent: s.changePercent,
      sourceChanged: s.sourceChanged,
      enoughData: s.enoughData,
      betterDirection,
      improved,
      latest: values.length === 0 ? null : (values[values.length - 1] ?? null),
      earliest: values.length === 0 ? null : (values[0] ?? null),
      // 趋势接口不带单位，从指标名推断：报告页只有这几类单位
      unit: unitOf(s.name),
      hint: metricHint(s.name),
      min: values.length === 0 ? null : Math.min(...values),
      max: values.length === 0 ? null : Math.max(...values),
    };
  });
}

function unitOf(name: MetricName): Metric['unit'] {
  if (name.endsWith('_SIZE')) return 'byte';
  if (name === 'CLS') return 'score';
  if (name === 'REQUEST_COUNT' || name.endsWith('_DEPS')) return 'count';
  return 'ms';
}

// ─────────────────────────────────────────────────────────────────────
// 时间线（候选 → 决策 → 执行 → 验证）
// ─────────────────────────────────────────────────────────────────────

export type TimelineStatus = 'kept' | 'rolled_back' | 'pending' | 'suggested' | 'rejected' | 'failed';

export interface TimelineEntry {
  candidateId: string;
  title: string;
  description: string;
  /** 优化分级 A / B / C */
  class: Candidate['class'];
  route: Decision['route'] | null;
  verdict: Decision['verdict'] | null;
  score: number | null;
  status: TimelineStatus;
  /** 实际收益（指标名 → 变化量），验证过才有 */
  gain: Record<string, number>;
  /** 声明的预期收益（指标名 → 节省量） */
  expectedGain: Record<string, number>;
  /** 未通过的原因 */
  failedRules: string[];
  /** 一句话说明当前处于哪一步 */
  note: string;
  /** 补丁正文；没产出时为空串 */
  patch: string;
  /** 执行器的自述（"压缩后节省 1.0 MB" 这类） */
  executionSummary: string | null;
  /** 补丁涉及的文件 */
  files: string[];
  /** 决策理由（"为什么这么判"） */
  reasons: string[];
  /** 验证跑过的检查 */
  checks: Verification['checks'];
  /** 改动描述（要改哪个文件的哪个键） */
  changes: Candidate['changes'];
  risk: Candidate['risk'];
  effort: Candidate['effort'];
  confidence: number;
}

/**
 * 把候选 / 决策 / 执行 / 验证拼成一条时间线。
 *
 * **以候选为主体**，而不是以决策或验证为主体：候选是这条链路的起点，
 * 一个候选可能没有决策（规划阶段之后就断了），也可能有决策但没被验证
 * （B 类待人工确认，或没有 git 端口）。以别的实体为主体，这些"半截"的记录
 * 会凭空消失 —— 而它们恰恰是要给人看的东西。
 */
export function buildTimeline(detail: RunDetail): TimelineEntry[] {
  const decisionOf = new Map(detail.decisions.map((d) => [d.candidateId, d]));
  const executionOf = new Map(detail.executions.map((e) => [e.candidateId, e]));
  const verificationOf = new Map(detail.verifications.map((v) => [v.candidateId, v]));

  return detail.candidates.map((candidate) => {
    const decision = decisionOf.get(candidate.id) ?? null;
    const execution = executionOf.get(candidate.id) ?? null;
    const verification = verificationOf.get(candidate.id) ?? null;

    return {
      candidateId: candidate.id,
      title: candidate.title,
      description: candidate.description,
      class: candidate.class,
      route: decision?.route ?? null,
      verdict: decision?.verdict ?? null,
      score: decision?.score ?? null,
      expectedGain: numbersOnly(candidate.expectedGain),
      patch: execution?.patch ?? '',
      executionSummary: execution?.summary ?? null,
      files: execution?.files ?? [],
      reasons: decision?.reasons ?? [],
      checks: verification?.checks ?? [],
      changes: candidate.changes,
      risk: candidate.risk,
      effort: candidate.effort,
      confidence: candidate.confidence,
      ...describeStage(decision, execution !== null, verification),
    };
  });
}

function numbersOnly(source: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

/** 当前走到哪一步、为什么停在这里 */
function describeStage(
  decision: Decision | null,
  executed: boolean,
  verification: Verification | null,
): Pick<TimelineEntry, 'status' | 'gain' | 'failedRules' | 'note'> {
  if (verification !== null) {
    const gain: Record<string, number> = {};
    for (const [name, value] of Object.entries(verification.gain)) {
      if (typeof value === 'number') gain[name] = value;
    }

    return {
      status: verification.status,
      gain,
      failedRules: verification.gate.failedRules,
      note:
        verification.status === 'kept'
          ? `验证通过，改动已保留${verification.git?.resultRef === null || verification.git === null ? '' : `（${verification.git.resultRef.slice(0, 8)}）`}`
          : `未通过门禁，已回滚到 ${verification.git?.baseRef.slice(0, 8) ?? '基线'}`,
    };
  }

  if (decision === null) {
    return { status: 'pending', gain: {}, failedRules: [], note: '尚未裁决（方案阶段之后中断）' };
  }

  switch (decision.verdict) {
    case 'reject':
      return {
        status: 'rejected',
        gain: {},
        failedRules: [],
        note: `不值得做：${decision.reasons.slice(-1).join('') || '收益低于阈值'}`,
      };
    case 'suggest':
      return { status: 'suggested', gain: {}, failedRules: [], note: '仅建议，不产出补丁' };
    case 'confirm':
      return {
        status: executed ? 'pending' : 'suggested',
        gain: {},
        failedRules: [],
        note: executed ? '已生成补丁，等待人工确认' : '待人工确认（未产出补丁）',
      };
    case 'apply':
      return {
        status: 'pending',
        gain: {},
        failedRules: [],
        note: executed ? '已应用，等待验证' : '计划自动执行，但本次未产出补丁',
      };
    default:
      return { status: 'pending', gain: {}, failedRules: [], note: '未知裁决' };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 阶段视图（采集 → … → 报告）
// ─────────────────────────────────────────────────────────────────────

export interface StageView {
  name: StageRecord['name'];
  label: string;
  status: StageRecord['status'];
  durationMs: number;
  note: string | null;
}

const STAGE_LABEL: Partial<Record<StageRecord['name'], string>> = {
  collect: '采集',
  compare: '对比基线',
  diagnose: '诊断',
  plan: '方案生成',
  decide: '决策',
  execute: '执行',
  verify: '验证',
  report: '报告',
};

/**
 * 流水线阶段。
 *
 * 这一段回答的是"这次到底跑到哪一步了"：报告里最容易被误读的是
 * `execute` 与 `verify` 两段 —— 它们 **skipped** 时看起来像"没问题"，
 * 而真相往往是"这次根本没做"。因此备注要原样带出来。
 */
export function buildStages(run: RunRecord): StageView[] {
  return run.stages.map((stage) => ({
    name: stage.name,
    label: STAGE_LABEL[stage.name] ?? stage.name,
    status: stage.status,
    durationMs: stage.durationMs,
    note: stage.note,
  }));
}

// ─────────────────────────────────────────────────────────────────────
// 采集来源状态
// ─────────────────────────────────────────────────────────────────────

export type SourceState = 'ok' | 'unavailable' | 'failed' | 'idle';

export interface SourceStatus {
  adapter: string;
  state: SourceState;
  metricCount: number;
  artifacts: number;
  message: string | null;
}

export interface CollectionView {
  sources: SourceStatus[];
  metricCount: number;
  okSources: number;
  unavailableSources: number;
  failedSources: number;
  /** 采集告警，按严重度分组 */
  degraded: RunRecord['warnings'];
  info: RunRecord['warnings'];
}

/**
 * 数据目录：这一轮的数据是谁给的、谁没给。
 *
 * **不能只看"指标有 11 项"就以为万事大吉**：五个来源里四个不可用时，
 * 报告同样能凑出十几项指标，但 LCP 这类实验室指标可能整块缺失。
 * 来源清单因此必须是独立的一块，而不是藏在告警列表里。
 *
 * 来源清单由数据**推导**（指标的 source ∪ 产物的 adapter ∪ 告警的 adapter），
 * 不在前端写死那五个 id —— 写死意味着以后新增一个适配器，报告页要跟着改。
 */
export function buildCollection(detail: RunDetail): CollectionView {
  const { run } = detail;
  const metricCountOf = new Map<string, number>();
  for (const metric of run.metrics) {
    metricCountOf.set(metric.source, (metricCountOf.get(metric.source) ?? 0) + 1);
  }

  const artifactCountOf = new Map<string, number>();
  for (const artifact of run.artifacts) {
    artifactCountOf.set(artifact.adapter, (artifactCountOf.get(artifact.adapter) ?? 0) + 1);
  }

  const unsupportedCodes = new Set([
    'ADAPTER_UNAVAILABLE',
    'ADAPTER_FAILED',
    'ADAPTER_OUTPUT_INVALID',
  ]);
  const warningOf = new Map<string, RunRecord['warnings'][number]>();
  for (const warning of run.warnings) {
    if (warning.adapter === null || !unsupportedCodes.has(warning.code)) continue;
    // 一个来源可能有多条告警，保留最严重的那条（failed 优先于 unavailable）
    const existing = warningOf.get(warning.adapter);
    if (existing === undefined || warning.code !== 'ADAPTER_UNAVAILABLE') {
      warningOf.set(warning.adapter, warning);
    }
  }

  const adapters = new Set<string>([
    ...metricCountOf.keys(),
    ...artifactCountOf.keys(),
    ...warningOf.keys(),
  ]);

  const sources = [...adapters]
    .map((adapter): SourceStatus => {
      const warning = warningOf.get(adapter) ?? null;
      const metrics = metricCountOf.get(adapter) ?? 0;
      const artifacts = artifactCountOf.get(adapter) ?? 0;

      let state: SourceState = 'idle';
      if (warning !== null && warning.code !== 'ADAPTER_UNAVAILABLE') state = 'failed';
      else if (warning !== null) state = 'unavailable';
      else if (metrics > 0 || artifacts > 0) state = 'ok';

      return { adapter, state, metricCount: metrics, artifacts, message: warning?.message ?? null };
    })
    // 有数据的排前面，然后是未安装的，最后是失败的 —— 最该看的是"有问题"的那些
    .sort((a, b) => rank(a.state) - rank(b.state) || a.adapter.localeCompare(b.adapter));

  return {
    sources,
    metricCount: run.metrics.length,
    okSources: sources.filter((s) => s.state === 'ok').length,
    unavailableSources: sources.filter((s) => s.state === 'unavailable').length,
    failedSources: sources.filter((s) => s.state === 'failed').length,
    degraded: run.warnings.filter((w) => w.severity === 'degraded'),
    info: run.warnings.filter((w) => w.severity !== 'degraded'),
  };
}

function rank(state: SourceState): number {
  switch (state) {
    case 'failed':
      return 0;
    case 'unavailable':
      return 1;
    case 'ok':
      return 2;
    default:
      return 3;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 概览数字 + 一句话结论
// ─────────────────────────────────────────────────────────────────────

export interface RunOverview {
  regressionCount: number;
  improvedCount: number;
  bottleneckCount: number;
  keptCount: number;
  rolledBackCount: number;
  /** 需要人工确认的候选数 */
  needsConfirmation: number;
  /** 采集到的指标数 */
  metricCount: number;
  /** 参与对比的指标数（有基线的） */
  comparableCount: number;
  /** 产出了补丁的候选数 */
  patchCount: number;
}

export function buildOverview(detail: RunDetail): RunOverview {
  const comparable = detail.run.deltas.filter((d) => d.scoreDelta !== null);

  return {
    regressionCount: comparable.filter((d) => (d.scoreDelta ?? 0) < 0).length,
    improvedCount: comparable.filter((d) => (d.scoreDelta ?? 0) > 0).length,
    bottleneckCount: detail.diagnosis?.bottlenecks.length ?? 0,
    keptCount: detail.verifications.filter((v) => v.status === 'kept').length,
    rolledBackCount: detail.verifications.filter((v) => v.status === 'rolled_back').length,
    needsConfirmation: detail.decisions.filter((d) => d.verdict === 'confirm').length,
    metricCount: detail.run.metrics.length,
    comparableCount: comparable.length,
    patchCount: detail.executions.filter((e) => e.patch !== '' || e.files.length > 0).length,
  };
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface Headline {
  tone: Tone;
  /** 一句话：这一轮到底怎么样 */
  text: string;
  /** 支撑这句话的几条事实 */
  facts: string[];
}

/**
 * 一句话结论。
 *
 * 报告页最容易犯的错是**把一堆数字丢给用户自己判断**。用户打开页面时
 * 想知道的是"比上次好还是差、有没有东西被改了、我需不需要做点什么"。
 * 这句话就是这三件事的合并回答，下面的所有区块都是它的证据。
 *
 * 语气刻意保守：**没采到数据绝不说成"没问题"**（这条原则从采集层
 * 一路贯穿到报告页）。
 */
export function buildHeadline(detail: RunDetail): Headline {
  const overview = buildOverview(detail);
  const collection = buildCollection(detail);
  const facts: string[] = [
    `采集到 ${overview.metricCount} 项指标（${collection.okSources} 个来源可用）`,
  ];

  if (overview.bottleneckCount > 0) facts.push(`${overview.bottleneckCount} 个瓶颈`);
  if (overview.patchCount > 0) facts.push(`${overview.patchCount} 个候选产出了补丁`);
  if (overview.keptCount > 0) facts.push(`保留 ${overview.keptCount} 个改动`);
  if (overview.rolledBackCount > 0) facts.push(`回滚 ${overview.rolledBackCount} 个改动`);
  if (overview.needsConfirmation > 0) facts.push(`${overview.needsConfirmation} 个候选等待人工确认`);

  if (overview.metricCount === 0) {
    return {
      tone: 'bad',
      text: '这一轮一条指标都没采到 —— 报告里的"0 个瓶颈"不代表页面没问题，只代表这次没测到。',
      facts,
    };
  }

  if (overview.rolledBackCount > 0) {
    return {
      tone: 'warn',
      text: `有 ${overview.rolledBackCount} 个改动没通过验证，已自动回滚（工作区保持原样）。`,
      facts,
    };
  }

  if (overview.keptCount > 0) {
    return {
      tone: 'good',
      text: `保留了 ${overview.keptCount} 个改动，这些改动通过了验证并被记入仓库历史。`,
      facts,
    };
  }

  if (overview.regressionCount > 0) {
    return {
      tone: 'bad',
      text: `比基线有 ${overview.regressionCount} 项指标回归，另有 ${overview.improvedCount} 项改善。`,
      facts,
    };
  }

  if (overview.comparableCount > 0) {
    return {
      tone: overview.improvedCount > 0 ? 'good' : 'neutral',
      text:
        overview.improvedCount > 0
          ? `比基线改善 ${overview.improvedCount} 项指标，没有回归。`
          : `与基线相比没有变化（${overview.comparableCount} 项可比指标全部持平）。`,
      facts,
    };
  }

  const unavailable = collection.unavailableSources;
  return {
    tone: unavailable > 0 ? 'warn' : 'neutral',
    text:
      unavailable > 0
        ? `这是首次运行（没有基线可比），且有 ${unavailable} 个数据来源不可用 —— 这次的结果只能当作起点。`
        : '这是首次运行：还没有基线，因此"有没有变好"要等下一次才有答案。',
    facts,
  };
}

/**
 * 归因与影响量的可读化。
 *
 * 与 `core` 里的同名函数是**两套实现** —— 那一份在 core，而前端只能 type-only
 * 引用 shared，用不了它。因此这里必须自己写一遍，并且守住同一条规则：
 * **给不出来的就说给不出来**。component 级归因的 file/line 经常是 null，
 * 此时显示选择器，而不是编一个行号。
 */
export function describeAttribution(attribution: Bottleneck['attribution']): string {
  switch (attribution.level) {
    case 'source':
      return attribution.line === null ? attribution.file : `${attribution.file}:${attribution.line}`;
    case 'dependency':
      return `${attribution.name}${attribution.version === null ? '' : `@${attribution.version}`}`;
    case 'resource':
      return shortUrl(attribution.url);
    case 'component':
      return attribution.file === null ? attribution.name : `${attribution.name} (${attribution.file})`;
    case 'config':
      return attribution.key === null ? attribution.file : `${attribution.file} → ${attribution.key}`;
    default:
      return '—';
  }
}

/** 影响量：指标名 + 按该指标单位格式化后的数值 */
export function describeImpact(
  impact: Bottleneck['impact'],
): Array<{ name: string; text: string; value: number }> {
  const items: Array<{ name: string; text: string; value: number }> = [];

  for (const [name, value] of Object.entries(impact)) {
    // 值为 0 的项不显示：它既不是影响，也会把真正的影响挤下去
    if (typeof value !== 'number' || value === 0) continue;
    items.push({ name, value, text: formatMetricValue(name as MetricName, value) });
  }

  return items;
}

/** 按指标名推断单位再格式化（影响量只带指标名，不带单位） */
export function formatMetricValue(name: MetricName, value: number): string {
  return formatMetric(value, unitOf(name));
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.pathname;
  } catch {
    return url;
  }
}

/** 状态 → 展示用标签与颜色类名。集中在一处，免得每个组件各写一套 */
export const STATUS_LABEL: Record<TimelineStatus, string> = {
  kept: '已保留',
  rolled_back: '已回滚',
  pending: '进行中',
  suggested: '仅建议',
  rejected: '未执行',
  failed: '失败',
};

export const RATING_LABEL: Record<Metric['rating'], string> = {
  good: '良好',
  'needs-improvement': '待改进',
  poor: '差',
};

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  improved: '改善',
  regressed: '劣化',
  flat: '持平',
  unknown: '不可比',
};

export const RUN_STATUS_LABEL: Record<RunRecord['status'], string> = {
  success: '全部成功',
  partial: '部分成功',
  failed: '采集失败',
};

// ─────────────────────────────────────────────────────────────────────
// run 列表（选择器）
// ─────────────────────────────────────────────────────────────────────

export interface RunGroup {
  key: string;
  route: string;
  device: string;
  runs: RunSummary[];
  /** 该组最近一次运行的开始时间 */
  latest: string;
}

/**
 * 按「路由 + 设备」分组。
 *
 * 一个 run 记录是**一个路由在一个设备上**的一次运行，因此"最近一次运行"
 * 这个说法本身就有歧义：三个路由就有三个"最近一次"。选择器按组展示，
 * 用户才能看清自己要看的是哪一条。
 *
 * 每组默认只保留最近 10 条：历史会被无限追加，而 `<select>` 里塞进几百个
 * 选项之后，"找昨天那次运行"比翻日志还慢。看更早的用 `history` 命令或直接读
 * `.perfpilot/runs/`。
 */
export function groupRuns(summaries: readonly RunSummary[], limitPerGroup = 10): RunGroup[] {
  const groups = new Map<string, RunGroup>();

  for (const summary of [...summaries].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    const key = `${summary.route}|${summary.device}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        key,
        route: summary.route,
        device: summary.device,
        runs: [summary],
        latest: summary.startedAt,
      });
      continue;
    }
    if (group.runs.length < limitPerGroup) group.runs.push(summary);
  }

  return [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest));
}

/** 把 run 记录变成选择器里的一行文字 */
export function describeRun(summary: RunSummary): string {
  const time = new Date(summary.startedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${time} · ${RUN_STATUS_LABEL[summary.status]} · ${summary.metricCount} 项指标`;
}
