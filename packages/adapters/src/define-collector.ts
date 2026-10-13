import type { AdapterId, CollectorPort, MetricSample, RawArtifact, RawRunner } from '@yuki-byte18/shared';

/**
 * adapter 的定义式。把「探活 / 采集 / 解析」三件事固定成同一个形状，
 * 每个具体 adapter 只提供三块零件，不重复写样板。
 */
export interface CollectorDefinition {
  id: AdapterId;
  /** 外部工具是否可用。默认实现为「总是可用」，真实 adapter 覆盖它 */
  probe?: () => Promise<boolean>;
  runner: RawRunner;
  parse: (artifacts: readonly RawArtifact[]) => MetricSample[];
}

/**
 * 把定义包成 `CollectorPort`。
 *
 * 这里没有任何业务逻辑，价值在于**强制了形状**：任何 adapter 都必须能回答
 * 「工具可用吗」「怎么采」「怎么解析成指标」三个问题，
 * 而 core 只认识 `CollectorPort`，永远看不到具体实现（硬约束 4）。
 */
export function defineCollector(definition: CollectorDefinition): CollectorPort {
  const { id, probe, runner, parse } = definition;

  return {
    id,
    isAvailable: probe ?? (async () => true),
    collect: runner,
    toMetrics: parse,
  };
}

/** 从产物里筛出属于本 adapter 的部分，避免跨 adapter 误读 */
export function artifactsOf(
  artifacts: readonly RawArtifact[],
  id: AdapterId,
  kind?: string,
): RawArtifact[] {
  return artifacts.filter((a) => a.adapter === id && (kind === undefined || a.kind === kind));
}

/** 只保留有限数值：采集侧出现 NaN / Infinity 时宁可少一个指标，也不要污染报告 */
export function isUsable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
