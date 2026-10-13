import { z } from 'zod';
import { ADAPTER_IDS, DEVICES } from '../types/common.js';
import { METRIC_NAMES, METRIC_UNITS, RATINGS } from '../types/metric.js';

/**
 * schema 与类型一一对应，但**类型由 schema 反推**（`z.infer`），
 * 因此不存在「改了类型忘了改校验」的可能。
 */
export const AdapterIdSchema = z.enum(ADAPTER_IDS);
export const DeviceSchema = z.enum(DEVICES);
export const MetricNameSchema = z.enum(METRIC_NAMES);
export const MetricUnitSchema = z.enum(METRIC_UNITS);
export const RatingSchema = z.enum(RATINGS);

export const MetricSchema = z.object({
  name: MetricNameSchema,
  value: z.number().finite(),
  unit: MetricUnitSchema,
  rating: RatingSchema,
  score: z.number().min(0).max(100),
  route: z.string().min(1),
  device: DeviceSchema,
  source: AdapterIdSchema,
  collectedAt: z.string().min(1),
});

/** adapter 产出的未打分样本 */
export const MetricSampleSchema = z.object({
  name: MetricNameSchema,
  value: z.number().finite(),
});

export const MetricDeltaSchema = z.object({
  name: MetricNameSchema,
  baseline: z.number().finite().nullable(),
  current: z.number().finite(),
  delta: z.number().finite().nullable(),
  deltaPercent: z.number().finite().nullable(),
  baselineScore: z.number().nullable(),
  currentScore: z.number(),
  scoreDelta: z.number().nullable(),
});

export const MetricListSchema = z.array(MetricSchema);
