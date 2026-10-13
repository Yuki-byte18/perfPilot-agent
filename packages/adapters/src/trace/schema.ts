import { z } from 'zod';

/**
 * Chrome trace 的容错 schema。
 *
 * trace 有两种导出形态，都要认：
 * - `{ "traceEvents": [...] }` —— DevTools Performance 面板导出
 * - `[...]` —— 裸事件数组，部分工具（如 trace-viewer 脚本）产出这种
 *
 * 事件字段：`ph` 是 phase（`X` = 有耗时的完整事件），`ts` 单位是**微秒**，
 * `dur` 同样是微秒。转成毫秒是 runner 的职责，规则层只看到毫秒。
 */
const TraceEventSchema = z
  .object({
    name: z.string().optional(),
    cat: z.string().optional(),
    ph: z.string().optional(),
    ts: z.number().optional(),
    dur: z.number().optional(),
    pid: z.number().optional(),
    tid: z.number().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const TraceFileSchema = z.union([
  z.object({ traceEvents: z.array(TraceEventSchema).default([]) }).passthrough(),
  z.array(TraceEventSchema),
]);

export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type TraceFile = z.infer<typeof TraceFileSchema>;
