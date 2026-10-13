import { z } from 'zod';
import { TOOL_ROUTES, VERDICTS } from '../types/decision.js';
import { RiskLevelSchema } from './candidate.js';

export const VerdictSchema = z.enum(VERDICTS);
export const ToolRouteSchema = z.enum(TOOL_ROUTES);

export const UtilityBreakdownSchema = z
  .object({
    expectedGain: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1),
    cost: z.number().min(0).max(100),
    risk: z.number().min(0).max(100),
  })
  .strict();

/**
 * 阈值快照的 schema。
 *
 * 名字带 `Snapshot` 是为了与 `schema/config.ts` 里的配置源
 * `DecisionThresholdsSchema`（snake_case）区分开 —— 两者形状与语义都不同。
 */
export const DecisionThresholdSnapshotSchema = z
  .object({
    minGain: z.number().min(0),
    maxRegression: z.number().min(0),
    maxNewErrors: z.number().int().min(0),
    applyScore: z.number(),
    confirmScore: z.number(),
  })
  .strict()
  .refine((t) => t.confirmScore <= t.applyScore, {
    message: 'confirmScore 必须 ≤ applyScore，否则裁决区间会重叠',
  });

export const DecisionSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    candidateId: z.string().min(1),
    verdict: VerdictSchema,
    route: ToolRouteSchema,
    score: z.number().finite(),
    utility: UtilityBreakdownSchema,
    riskLevel: RiskLevelSchema,
    reasons: z.array(z.string().min(1)),
    thresholds: DecisionThresholdSnapshotSchema,
    decidedAt: z.string().min(1),
  })
  .strict();

/** 决策数组：`perfpilot fix` 从 `decisions.json` 读回来时要过一遍（外部输入） */
export const DecisionListSchema = z.array(DecisionSchema);
