import { z } from 'zod';

/**
 * 产物 payload 的 schema。
 *
 * 这些 schema 同时被两侧使用：
 * - adapter 侧：校验自己产出的 payload（写之前）
 * - core 侧：校验读回来的 payload（用之前）
 *
 * 读回来时再校验一次不是多余：`.perfpilot/runs/` 里的产物可能被手工改过、
 * 可能来自旧版本，诊断规则不该因为一个字段缺失就崩掉整轮诊断。
 */

const NonNegative = z.number().min(0);
/** 可空数值：缺失与 0 是两回事（未知体积 ≠ 0 字节） */
const NullableSize = NonNegative.nullable();

export const HarEntrySchema = z
  .object({
    url: z.string().min(1),
    resourceType: z.string(),
    mimeType: z.string(),
    status: z.number().int(),
    transferSize: NullableSize,
    resourceSize: NullableSize,
    timeMs: NonNegative,
    startMs: NonNegative,
    contentEncoding: z.string().nullable(),
    cacheControl: z.string().nullable(),
    initiatorType: z.string().nullable(),
    fromCache: z.boolean(),
    sameOriginAsDocument: z.boolean(),
    priority: z.string().nullable(),
  })
  .strict();

export const HarPayloadSchema = z
  .object({
    source: z.literal('har'),
    pageUrl: z.string().nullable(),
    entryCount: z.number().int().min(0),
    entries: z.array(HarEntrySchema),
  })
  .strict();

export const TraceFrameSchema = z
  .object({
    functionName: z.string().nullable(),
    url: z.string().nullable(),
    line: z.number().int().positive().nullable(),
    column: z.number().int().min(0).nullable(),
  })
  .strict();

export const TraceLongTaskSchema = z
  .object({
    startMs: NonNegative,
    durationMs: NonNegative,
    topFrame: TraceFrameSchema.nullable(),
    scriptingMs: NonNegative,
    layoutMs: NonNegative,
    styleMs: NonNegative,
  })
  .strict();

export const TracePayloadSchema = z
  .object({
    source: z.literal('trace'),
    totalMs: NonNegative,
    eventCount: z.number().int().min(0),
    longTasks: z.array(TraceLongTaskSchema),
    totals: z
      .object({
        scriptingMs: NonNegative,
        layoutMs: NonNegative,
        styleMs: NonNegative,
      })
      .strict(),
  })
  .strict();

export const BundleFileSchema = z
  .object({ path: z.string().min(1), size: NonNegative })
  .strict();

export const BundleModuleSchema = z
  .object({ name: z.string().min(1), size: NonNegative })
  .strict();

/**
 * package.json 快照。
 *
 * 所有字段都写成 `.nullable().default(null)` 而不是 `.optional()`：
 * optional 会推断出 `T | undefined`，在 `exactOptionalPropertyTypes` 下
 * 与「必填、可为 null」的接口不互相赋值。统一用 `null` 表示「未声明 / 读不到」，
 * 语义也更清楚 —— 缺失和空值是两回事，但都指向「没有这个配置」。
 */
export const PackageJsonSnapshotSchema = z
  .object({
    name: z.string().nullable().default(null),
    // sideEffects 的真实取值域：false / glob 数组 / 未声明
    sideEffects: z.union([z.boolean(), z.array(z.string())]).nullable().default(null),
    dependencies: z.record(z.string(), z.string()).nullable().default(null),
    devDependencies: z.record(z.string(), z.string()).nullable().default(null),
  })
  .strict();

export const BundleScanPayloadSchema = z
  .object({
    distDir: z.string().min(1),
    source: z.enum(['scan', 'stats']),
    files: z.array(BundleFileSchema),
    modules: z.array(BundleModuleSchema).default([]),
    packageJson: PackageJsonSnapshotSchema.nullable().default(null),
  })
  .strict();
