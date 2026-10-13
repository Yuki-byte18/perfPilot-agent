import { z } from 'zod';
import {
  CANDIDATE_ORIGINS,
  EFFORTS,
  OPTIMIZATION_CLASSES,
  PLANNED_CHANGE_TYPES,
  RISK_LEVELS,
} from '../types/candidate.js';
import { MetricNameSchema } from './metric.js';
import { BottleneckKindSchema } from './bottleneck.js';

export const OptimizationClassSchema = z.enum(OPTIMIZATION_CLASSES);
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export const EffortSchema = z.enum(EFFORTS);
export const CandidateOriginSchema = z.enum(CANDIDATE_ORIGINS);

/**
 * PlannedChange 用 discriminated union：四类各有必填字段，缺一个就拒绝。
 *
 * 这与 AttributionSchema 同一套写法 —— 改动描述是执行器的唯一输入，
 * 一个 `{ type: 'ast' }` 却没有 file 的改动，执行器无从下手。
 */
export const PlannedChangeSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ast'),
      file: z.string().min(1),
      node: z.string().min(1),
      description: z.string().min(1),
      before: z.string().optional(),
      after: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('asset'),
      file: z.string().min(1),
      operation: z.enum(['convert-webp', 'compress', 'resize']),
      params: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      type: z.literal('config'),
      file: z.string().min(1),
      key: z.string().min(1),
      before: z.unknown(),
      after: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('dependency'),
      remove: z.array(z.string().min(1)).optional(),
      replace: z
        .object({ from: z.string().min(1), to: z.string().min(1) })
        .strict()
        .optional(),
      reason: z.string().min(1),
    })
    .strict(),
]);

const expectedGainShape = Object.fromEntries(
  MetricNameSchema.options.map((name) => [name, z.number().finite()]),
);

export const CandidateSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    bottleneckIds: z.array(z.string().min(1)).min(1),
    class: OptimizationClassSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    origin: CandidateOriginSchema,
    ruleId: z.string().min(1).nullable(),
    promptVersion: z.string().min(1).nullable(),
    changes: z.array(PlannedChangeSchema).min(1),
    expectedGain: z.object(expectedGainShape).partial().strict(),
    confidence: z.number().min(0).max(1),
    risk: RiskLevelSchema,
    effort: EffortSchema,
    reversible: z.boolean(),
    recalledFrom: z.array(z.string().min(1)),
    bottleneckKinds: z.array(BottleneckKindSchema),
  })
  .strict()
  /**
   * 跨字段约束：
   * 1. origin=rule 时 ruleId 必填；origin=llm 时 promptVersion 必填
   * 2. reversible=false 时 class 必须是 C（不可逆的候选只能建议，不能执行）
   */
  .refine((c) => (c.origin === 'rule' ? c.ruleId !== null : c.promptVersion !== null), {
    message: 'rule 来源必须有 ruleId；llm 来源必须有 promptVersion',
    path: ['origin'],
  })
  .refine((c) => (c.reversible === false ? c.class === 'C' : true), {
    message: '不可逆的候选只能是 C 类（仅建议）',
    path: ['reversible'],
  });

export const PLANNED_CHANGE_TYPES_SCHEMA = z.enum(PLANNED_CHANGE_TYPES);

/**
 * 候选数组。
 *
 * 落盘的 `candidates.json` 要用它校验回来 —— 那是**外部输入**
 * （用户可以手改，也可以被别的工具覆盖），不能直接 `as Candidate[]`。
 * 定义在这里而不是 core：`zod` 只在 shared / adapters 里出现（硬约束 3）。
 */
export const CandidateListSchema = z.array(CandidateSchema);

// ─────────────────────────────────────────────────────────────────────
// 类型由 schema 反推 —— 全项目唯一的候选类型来源
// ─────────────────────────────────────────────────────────────────────

export type PlannedChange = z.infer<typeof PlannedChangeSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;

