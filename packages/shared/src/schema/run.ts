import { z } from 'zod';
import { STAGE_NAMES, WARNING_SEVERITIES } from '../types/run.js';
import { AdapterIdSchema, DeviceSchema, MetricDeltaSchema, MetricSchema } from './metric.js';

export const StageNameSchema = z.enum(STAGE_NAMES);
export const StageStatusSchema = z.enum(['ok', 'skipped', 'failed']);
export const RunStatusSchema = z.enum(['success', 'partial', 'failed']);

export const StageRecordSchema = z.object({
  name: StageNameSchema,
  status: StageStatusSchema,
  durationMs: z.number().min(0),
  note: z.string().nullable(),
});

export const BaselineRefSchema = z.object({
  ref: z.string().min(1),
  runId: z.string().nullable(),
  metrics: z.array(MetricSchema),
});

export const RunWarningSchema = z.object({
  adapter: AdapterIdSchema.nullable(),
  code: z.string().min(1),
  severity: z.enum(WARNING_SEVERITIES),
  message: z.string().min(1),
});

export const ArtifactRefSchema = z.object({
  adapter: AdapterIdSchema,
  kind: z.string().min(1),
  file: z.string().min(1),
});

export const RunRecordSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string().min(1),
  project: z.string().min(1),
  route: z.string().min(1),
  device: DeviceSchema,
  url: z.string().min(1),
  status: RunStatusSchema,
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().min(0),
  perfpilotVersion: z.string().min(1),
  stages: z.array(StageRecordSchema),
  metrics: z.array(MetricSchema),
  baseline: BaselineRefSchema.nullable(),
  deltas: z.array(MetricDeltaSchema),
  warnings: z.array(RunWarningSchema),
  artifacts: z.array(ArtifactRefSchema),
  /**
   * 本轮 LLM 花费（美元）：诊断 agent + 方案生成之和。
   *
   * 默认 0，让 LLM 之前落盘的记录仍然能读回来。写进 run 记录而不是只留在
   * 内存里，是因为报告页与 MR 评论都要显示它 —— 花了钱就得看得见。
   */
  llmCostUsd: z.number().min(0).default(0),
});

/** 原始产物落盘/读取时的校验：payload 允许任意结构，但外壳必须规范 */
export const RawArtifactSchema = z.object({
  adapter: AdapterIdSchema,
  kind: z.string().min(1),
  payload: z.unknown(),
  collectedAt: z.string().min(1),
  file: z.string().nullable(),
});
