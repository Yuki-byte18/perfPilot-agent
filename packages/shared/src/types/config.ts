/**
 * 配置层里**需要独立存在**的少量类型。
 *
 * `PerfPilotConfig` 及其子结构**不在这里**：它们由 `schema/config.ts` 用 `z.infer` 反推
 * （README §7「类型用 z.infer 反推，不手写两遍」）。
 *
 * 这不是洁癖。手写接口与 zod 推断类型在 `exactOptionalPropertyTypes: true` 下并不等价：
 * zod 的可选字段类型是 `T | undefined`，而手写的 `prop?: T` 在该开关下表示
 * 「要么不存在，要么是 T」——两者不互相赋值。写两遍的必然结果是编译不过，
 * 或者关掉 exactOptionalPropertyTypes 把严格性让掉。
 */

/** 报告格式。运行时数组 → 编译期联合类型，与 METRIC_NAMES 同一套写法 */
export const REPORT_FORMATS = ['markdown', 'html', 'json'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
