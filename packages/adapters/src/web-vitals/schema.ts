import { z } from 'zod';

/**
 * Web Vitals 上报负载。
 *
 * 形态对齐 `web-vitals` npm 包的 `onLCP / onCLS / onINP` 回调输出，
 * 同时容忍两种常见写法：`{ LCP: 2800 }` 与 `{ LCP: { value: 2800 } }`。
 * 后者是包的原生形态（还带 attribution），前者是简化上报端点常见的形态。
 */
const VitalSchema = z.union([
  z.number(),
  z.object({ value: z.number() }).passthrough(),
  z.null(),
]);

export const WebVitalsReportSchema = z
  .object({
    url: z.string().optional(),
    route: z.string().optional(),
    collectedAt: z.string().optional(),
    device: z.string().optional(),
    /** 键为指标名；不认识的键会被忽略而不是报错 */
    metrics: z.record(z.string(), VitalSchema),
  })
  .passthrough();

export type WebVitalsReport = z.infer<typeof WebVitalsReportSchema>;
