import { z } from 'zod';
import { ATTRIBUTION_LEVELS, BOTTLENECK_KINDS, EVIDENCE_KINDS } from '../types/bottleneck.js';
import { MetricNameSchema } from './metric.js';

export const BottleneckKindSchema = z.enum(BOTTLENECK_KINDS);
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

/**
 * 归因用 discriminated union：五类各有必填字段，缺一个就拒绝。
 *
 * 这一点很重要 —— 归因是这个项目的核心产出，一个 `{ level: 'resource' }`
 * 却没有 url 的归因，等于没说「去哪里改」。
 */
export const AttributionSchema = z.discriminatedUnion('level', [
  z
    .object({
      level: z.literal('resource'),
      url: z.string().min(1),
      size: z.number().min(0),
      contentType: z.string(),
    })
    .strict(),
  z
    .object({
      level: z.literal('dependency'),
      name: z.string().min(1),
      version: z.string().nullable(),
      size: z.number().min(0),
    })
    .strict(),
  z
    .object({
      level: z.literal('source'),
      file: z.string().min(1),
      line: z.number().int().positive(),
      column: z.number().int().min(0).nullable(),
      component: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      level: z.literal('component'),
      name: z.string().min(1),
      // 允许 null：Web Vitals 的 DOM 归因只给得出选择器，给不出源码位置
      file: z.string().min(1).nullable(),
      line: z.number().int().positive().nullable(),
      renderCount: z.number().int().min(0).nullable(),
    })
    .strict(),
  z
    .object({
      level: z.literal('config'),
      file: z.string().min(1),
      key: z.string().min(1),
    })
    .strict(),
]);

export const EvidenceSchema = z.object({
  kind: EvidenceKindSchema,
  payload: z.unknown(),
  description: z.string().min(1),
});

const impactShape = Object.fromEntries(
  MetricNameSchema.options.map((name) => [name, z.number().finite()]),
);

export const BottleneckSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  kind: BottleneckKindSchema,
  title: z.string().min(1),
  severity: z.number().min(0).max(100),
  impact: z.object(impactShape).partial().strict(),
  attribution: AttributionSchema,
  evidence: z.array(EvidenceSchema),
  confidence: z.number().min(0).max(1),
  occurrences: z.number().int().positive(),
  /**
   * 这条结论是谁给的：确定性规则，还是诊断 agent（LLM）。
   *
   * 默认 `rule` 是为了让 LLM 之前落盘的记录仍然能读回来（`.default()` 只在
   * 字段缺失时生效）。有了这个字段，报告才能把"规则算出来的"和
   * "LLM 看出来的"分开摆 —— 两者的可信度不一样，混在一起就是骗人。
   */
  source: z.enum(['rule', 'llm']).default('rule'),
});

export const ATTRIBUTION_LEVELS_SCHEMA = z.enum(ATTRIBUTION_LEVELS);

/**
 * 诊断 agent 的**输出形状**（LLM 必须按这个 JSON 结构回答）。
 *
 * 与 `BottleneckSchema` 的差异是刻意的：
 *
 * - 不要 `id` / `runId` / `occurrences` / `source`：那些是**我们的记账**，
 *   LLM 不该编，编了也不该被采信（由 core/llm 盖章）
 * - 多一个 `refines`：指向它正在**复核**的那条规则结论 id。
 *   没有这个字段，LLM 就只能"另提一条"，报告里会出现两条说同一件事的结论
 * - `evidence` 强制至少一条：**没有证据的结论无法复核**，
 *   等于让一个不可验证的说法进报告。这是这一层最重要的闸门
 */
export const LlmFindingSchema = BottleneckSchema.omit({
  id: true,
  runId: true,
  occurrences: true,
  source: true,
}).extend({
  evidence: z.array(EvidenceSchema).min(1),
  refines: z.string().min(1).optional(),
});

// ─────────────────────────────────────────────────────────────────────
// 类型由 schema 反推 —— 全项目唯一的瓶颈类型来源
// ─────────────────────────────────────────────────────────────────────

export type Attribution = z.infer<typeof AttributionSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Bottleneck = z.infer<typeof BottleneckSchema>;
/** LLM 原始输出的一条结论（未经我们盖章） */
export type LlmFindingDraft = z.infer<typeof LlmFindingSchema>;

