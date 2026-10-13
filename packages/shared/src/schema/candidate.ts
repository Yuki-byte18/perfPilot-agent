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

const CandidateObjectSchema = z
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
  .strict();

export const CandidateSchema = CandidateObjectSchema
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

/**
 * LLM 输出的候选**草稿**：只要求模型给得出、且**该由它决定**的那部分。
 *
 * 与 `CandidateSchema` 的差别就是下面 `omit` 掉的那些字段，但这一点很关键：
 * `id` / `runId` / `promptVersion` / `origin` 是我们自己盖的章，`recalledFrom`
 * 来自记忆层，`bottleneckKinds` 能从 `bottleneckIds` 反查 —— 让模型去猜这些，
 * 结果是**每一条候选都被 schema 拒掉**：花了钱、零产出，而报错信息里
 * 只会说"runId: Required"，看不出是我们问错了。
 *
 * 反过来，凡是只有模型才知道的（改什么、为什么、多大把握、可不可逆），
 * 一个字段都不放宽 —— 补齐之后仍然要过一遍完整的 `CandidateSchema`，
 * 那时跨字段约束（例如"不可逆只能是 C 类"）才生效。
 */
const LlmCandidateShape = CandidateObjectSchema.omit({
  id: true,
  runId: true,
  origin: true,
  ruleId: true,
  promptVersion: true,
  recalledFrom: true,
  bottleneckKinds: true,
}).shape;

/**
 * 未知字段**丢弃而不报错**。
 *
 * 候选本身是 strict 的（多一个字段就说明有 bug），但 LLM 的输出不能用这个标准：
 * 它经常把 prompt 里的字段原样回抄（`id`、`runId`…），或者多写一句 `notes`。
 * 为这种无害的多余字段丢掉一整条**已经付过钱**的候选，是纯粹的浪费。
 * 因此这里用 zod 的默认行为（strip）：多余的键被丢掉，其余照常解析。
 * 补齐之后仍要过一遍完整的 `CandidateSchema` —— **那一遍是 strict 的**。
 */
export const LlmCandidateSchema = z.object(LlmCandidateShape);

export type LlmCandidateDraft = z.infer<typeof LlmCandidateSchema>;

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

