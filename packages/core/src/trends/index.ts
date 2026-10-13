import type { Metric, MetricName, MetricSeries, RunRecord, TrendPoint } from '@yuki-byte18/shared';

/**
 * 跨 run 的指标趋势（M8 验收 1 的「跨 run」那一半）。
 *
 * ## 为什么算在 core 而不是前端
 *
 * 报告页只能 type-only 引用 `@yuki-byte18/shared`（硬约束 3），拿不到 core 的
 * 任何实现。趋势要么在前端算（那就得把 N 个 run 的完整指标全拉过去），
 * 要么在服务端算好再给一个形状。选后者：
 *
 * - 一次请求就够，页面不用等 N+1 个响应
 * - 算错一次只错在一个地方，而且能被单测钉住
 * - 「来源变了就不给变化量」这条判断属于**测量正确性**，和 core 里
 *   `computeDelta` 的 `isComparable` 是同一条原则，不该在下游再实现一遍
 *
 * ## 三个刻意的行为
 *
 * 1. **时间升序**：左旧右新是所有人的直觉，倒序画出来的"上升"会被读反。
 * 2. **来源变过就不给变化量**：Lighthouse 换成 web-vitals 之后，
 *    LCP 从 3500 变成 3200 不代表变快了 —— 那是两把尺子。
 * 3. **`enoughData` 显式给出来**：一个点画不出趋势，
 *    前端据此显示"只有一个数据点"，而不是画一条看起来像"持平"的直线。
 */

export interface BuildSeriesOptions {
  /** 最多回溯多少个 run，默认 30 */
  limit?: number;
  /** 只取某一类指标的序列（不传则全部） */
  names?: readonly MetricName[];
}

/**
 * 把若干次 run 折成「每个指标一条时间线」。
 *
 * 入参是完整的 `RunRecord`（含 metrics），不是 `RunSummary` ——
 * 时间线需要每个点的值，而摘要里只有数量。
 */
export function buildMetricSeries(
  runs: readonly RunRecord[],
  options: BuildSeriesOptions = {},
): MetricSeries[] {
  const limit = options.limit ?? 30;

  // 先按时间升序排，再取最近的 limit 个：先截断再排序会取到"最早的 N 个"
  const ordered = [...runs]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(-Math.max(1, limit));

  const byName = new Map<MetricName, TrendPoint[]>();

  for (const run of ordered) {
    for (const metric of run.metrics) {
      if (options.names !== undefined && !options.names.includes(metric.name)) continue;

      const points = byName.get(metric.name) ?? [];
      points.push(toPoint(run, metric));
      byName.set(metric.name, points);
    }
  }

  const series: MetricSeries[] = [];
  for (const [name, points] of byName) {
    series.push(toSeries(name, points));
  }

  return sortSeries(series);
}

function toPoint(run: RunRecord, metric: Metric): TrendPoint {
  return {
    runId: run.id,
    startedAt: run.startedAt,
    value: metric.value,
    score: metric.score,
    rating: metric.rating,
    source: metric.source,
  };
}

function toSeries(name: MetricName, points: TrendPoint[]): MetricSeries {
  const first = points[0];
  const last = points[points.length - 1];
  const sources = new Set(points.map((p) => p.source));
  const sourceChanged = sources.size > 1;

  /**
   * 变化量只在「两个点、同源、且不是同一个点」时给。
   *
   * 注意 `first !== last` 比的是引用：只有一个数据点时它们指向同一个对象，
   * 变化量理应是 0 而不是 null —— 但"0 变化"和"算不出来"在 UI 上是两回事，
   * 因此改成按 `points.length >= 2` 判断，语义更直白。
   */
  const comparable = points.length >= 2 && first !== undefined && last !== undefined && !sourceChanged;

  const change = comparable ? round(last.value - first.value, 4) : null;
  const changePercent =
    comparable && first.value !== 0 ? round((last.value - first.value) / Math.abs(first.value) * 100, 2) : null;

  return {
    name,
    points,
    change,
    changePercent,
    sourceChanged,
    enoughData: points.length >= 2,
  };
}

/** 核心指标优先（LCP / CLS / INP），其余按字母 —— 与报告其它部分的排序口径一致 */
const PRIORITY: readonly MetricName[] = ['LCP', 'CLS', 'INP'];

function sortSeries(series: MetricSeries[]): MetricSeries[] {
  return series.sort((a, b) => {
    const ai = PRIORITY.indexOf(a.name);
    const bi = PRIORITY.indexOf(b.name);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.name.localeCompare(b.name);
  });
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
