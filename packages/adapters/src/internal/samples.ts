import type { MetricName, MetricSample } from '@yuki-byte18/shared';

/**
 * 构造未打分样本。
 *
 * 唯一的规则：**非有限值不产出样本**。
 * 采集侧出现 NaN / Infinity 时，如果拿 0 顶替，LCP=0ms 会被打满分，
 * 于是一次彻底失败的采集会被伪装成性能优异 —— 这是性能工具最危险的失效模式。
 * 宁可少一个指标（报告里显示为「未采集」），也不要一个错误的指标。
 */
export function sample(
  name: MetricName,
  value: number | null | undefined,
): MetricSample | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return { name, value };
}

/** 批量构造，自动丢弃不可用项 */
export function samples(
  entries: ReadonlyArray<readonly [MetricName, number | null | undefined]>,
): MetricSample[] {
  const out: MetricSample[] = [];
  for (const [name, value] of entries) {
    const built = sample(name, value);
    if (built) out.push(built);
  }
  return out;
}
