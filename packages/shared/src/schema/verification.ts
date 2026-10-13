import { z } from 'zod';
import { CHECK_KINDS } from '../types/verification.js';
import { ToolRouteSchema } from './decision.js';
import { MetricDeltaSchema, MetricNameSchema } from './metric.js';

export const CheckKindSchema = z.enum(CHECK_KINDS);

export const VerificationCheckSchema = z
  .object({
    kind: CheckKindSchema,
    passed: z.boolean(),
    /**
     * 该项检查是否被跳过（项目没定义这个 script）。
     * 默认 false 是为了让 M5 之前落盘的验证记录仍然能被读回来。
     */
    skipped: z.boolean().default(false),
    durationMs: z.number().int().min(0),
    output: z.string().nullable(),
  })
  .strict();

export const GateResultSchema = z
  .object({
    passed: z.boolean(),
    gainOk: z.boolean(),
    regressionOk: z.boolean(),
    errorsOk: z.boolean(),
    failedRules: z.array(z.string().min(1)),
  })
  .strict();

const gainShape = Object.fromEntries(
  MetricNameSchema.options.map((name) => [name, z.number().finite()]),
);

const NewErrorSchema = z
  .object({
    type: z.string().min(1),
    message: z.string().min(1),
    count: z.number().int().positive(),
  })
  .strict();

const GitResultSchema = z
  .object({
    baseRef: z.string().min(1),
    resultRef: z.string().min(1).nullable(),
    reverted: z.boolean(),
  })
  .strict();

export const VerificationSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    candidateId: z.string().min(1),
    status: z.enum(['kept', 'rolled_back']),
    route: ToolRouteSchema,
    checks: z.array(VerificationCheckSchema),
    deltas: z.array(MetricDeltaSchema),
    gain: z.object(gainShape).partial().strict(),
    regressions: z.array(MetricDeltaSchema),
    newErrors: z.array(NewErrorSchema),
    gate: GateResultSchema,
    patchRef: z.string().min(1).nullable(),
    git: GitResultSchema.nullable(),
    decidedBy: z.enum(['auto', 'human']),
    verifiedAt: z.string().min(1),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────
// 类型由 schema 反推 —— 全项目唯一的验证类型来源
// ─────────────────────────────────────────────────────────────────────

export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;
export type GateResult = z.infer<typeof GateResultSchema>;
export type Verification = z.infer<typeof VerificationSchema>;

