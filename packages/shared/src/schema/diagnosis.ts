import { z } from 'zod';
import { DeviceSchema, MetricDeltaSchema, MetricSchema } from './metric.js';
import { BottleneckSchema } from './bottleneck.js';

export const DiagnosisSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  project: z.string().min(1),
  route: z.string().min(1),
  device: DeviceSchema,
  baselineRef: z.string().nullable(),
  metrics: z.array(MetricSchema),
  baselineMetrics: z.array(MetricSchema),
  deltas: z.array(MetricDeltaSchema),
  regressions: z.array(MetricDeltaSchema),
  bottlenecks: z.array(BottleneckSchema),
  summary: z.string(),
  ruleSetVersion: z.string().min(1),
  createdAt: z.string().min(1),
});

// ─────────────────────────────────────────────────────────────────────
// 类型由 schema 反推 —— 全项目唯一的诊断类型来源
// ─────────────────────────────────────────────────────────────────────

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

