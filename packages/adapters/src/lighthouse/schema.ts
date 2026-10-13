import { z } from 'zod';

/**
 * Lighthouse 结果的**容错** schema。
 *
 * Lighthouse 的完整 JSON 有几千个字段、且跨版本变动频繁，给它写全量 schema 既不现实也无意义。
 * 这里的策略是：只声明我们真正读取的字段并全部设为可选，其余 `.passthrough()` 放行。
 * 这样既能拿到类型安全的读取路径，又不会因为 Lighthouse 升级加了个字段就整条链路挂掉。
 *
 * 代价是「字段缺失」不报错。因此 parse 侧对每个指标单独判空 —— 缺就是缺，
 * 宁可不产出该指标，也不拿 0 冒充测量值。
 */
/**
 * 刻意放行 NaN。
 *
 * zod 的 `z.number()` 会拒绝 NaN，但 Lighthouse 在页面加载失败等情况下确实会写出
 * `numericValue: NaN`。如果让校验在这一步就抛错，一个坏掉的审计项会把整个
 * Lighthouse 来源判为「输出不可解析」，其余几十个正常指标全部丢失。
 *
 * 放行之后由 `extractLighthouseMetrics` 的 `Number.isFinite` 逐个过滤：
 * 坏掉的那一项变成「该指标未采集」，其余照常。
 */
const NumericValueSchema = z.union([z.number(), z.nan()]);

const AuditSchema = z
  .object({
    numericValue: NumericValueSchema.optional(),
    score: z.number().nullable().optional(),
  })
  .passthrough();

const ResourceSummaryItemSchema = z
  .object({
    resourceType: z.string(),
    /** 解码后体积（未压缩），衡量 bundle 真实大小用这个 */
    resourceSize: z.number().optional(),
    /** 网络传输体积（压缩后），衡量用户下载量用这个 */
    transferSize: z.number().optional(),
    requestCount: z.number().optional(),
  })
  .passthrough();

const AuditsSchema = z
  .object({
    'largest-contentful-paint': AuditSchema.optional(),
    'cumulative-layout-shift': AuditSchema.optional(),
    'total-blocking-time': AuditSchema.optional(),
    'first-contentful-paint': AuditSchema.optional(),
    'speed-index': AuditSchema.optional(),
    'server-response-time': AuditSchema.optional(),
    'total-byte-weight': AuditSchema.optional(),
    // INP 在 Lighthouse 12+ 是实验性审计；名字随版本变动过，两种都认
    'experimental-interaction-to-next-paint': AuditSchema.optional(),
    'interaction-to-next-paint': AuditSchema.optional(),
    'resource-summary': z
      .object({ details: z.object({ items: z.array(ResourceSummaryItemSchema) }).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const LighthouseResultSchema = z
  .object({
    lighthouseVersion: z.string().optional(),
    finalUrl: z.string().optional(),
    fetchTime: z.string().optional(),
    configSettings: z.object({ formFactor: z.string().optional() }).passthrough().optional(),
    audits: AuditsSchema,
  })
  .passthrough();

export type LighthouseResult = z.infer<typeof LighthouseResultSchema>;
export type LighthouseAudits = LighthouseResult['audits'];
export type ResourceSummaryItem = z.infer<typeof ResourceSummaryItemSchema>;
