/**
 * 跨 run 的指标趋势（报告页与 API 共用）。
 *
 * 定义在 shared 是为了让**服务端算、前端画**这条链路有一个共同的形状：
 * `web` 只能 type-only 引用 shared，它拿不到 core 的运行时实现，
 * 因此这个契约必须是类型而不是函数。
 */

import type { Metric, MetricName } from './metric.js';

export interface TrendPoint {
  runId: string;
  startedAt: string;
  value: number;
  score: number;
  rating: Metric['rating'];
  /** 测量来源。来源变过的时间线不能算变化量 */
  source: Metric['source'];
}

export interface MetricSeries {
  name: MetricName;
  /** 按时间**升序**（左旧右新） */
  points: TrendPoint[];
  /**
   * 首尾之差（正 = 数值变大）。**越小越好的指标要靠 `lowerIsBetter` 判断方向**，
   * 这里不做判断 —— 趋势是数据，方向是展示层的事。
   *
   * 以下三种情况为 null：只有一个数据点、测量来源变过、指标本身方向特殊无法计算。
   */
  change: number | null;
  changePercent: number | null;
  /** 时间线上出现过多个测量来源（此时不给变化量） */
  sourceChanged: boolean;
  /** 数据点 ≥ 2 才画得出趋势 */
  enoughData: boolean;
}
