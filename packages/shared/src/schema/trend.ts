import { z } from 'zod';
import { METRIC_NAMES, RATINGS } from '../types/metric.js';
import { AdapterIdSchema } from './metric.js';

/**
 * 跨 run 指标序列的 schema。
 *
 * `TrendPoint` / `MetricSeries`（`types/trend.ts`）是**服务端算、前端画**的契约：
 * `web` 只能 type-only 引用 shared，因此它拿到的是这个形状的 JSON ——
 * 也就是**未经前端自己校验的外部输入**。校验不是多余的礼节。
 *
 * 这里用 `z.infer` 反推类型并与手写类型并排导出，测试会断言两者一致 ——
 * 手写一份 + 校验一份的写法只有在"它们可能不一致"时才安全，
 * 而"可能不一致"正是需要测试盯着的地方。
 */

export const TrendPointSchema = z
  .object({
    runId: z.string().min(1),
    startedAt: z.string().min(1),
    value: z.number().finite(),
    score: z.number().min(0).max(100),
    rating: z.enum(RATINGS),
    source: AdapterIdSchema,
  })
  .strict();

export const MetricSeriesSchema = z
  .object({
    name: z.enum(METRIC_NAMES),
    points: z.array(TrendPointSchema),
    change: z.number().finite().nullable(),
    changePercent: z.number().finite().nullable(),
    sourceChanged: z.boolean(),
    enoughData: z.boolean(),
  })
  .strict();

/** `GET /api/metrics` 的响应 */
export const MetricSeriesResponseSchema = z
  .object({ series: z.array(MetricSeriesSchema) })
  .strict();

export type TrendPointParsed = z.infer<typeof TrendPointSchema>;
export type MetricSeriesParsed = z.infer<typeof MetricSeriesSchema>;
