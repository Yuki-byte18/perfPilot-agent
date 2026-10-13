/**
 * 全项目共用的基础标识类型。
 *
 * 这里是唯一用 `as const` 数组同时产出「运行时枚举」与「编译期联合类型」的地方，
 * 避免类型与运行时校验两处各写一遍、日久失同步。
 */

/** 外部工具适配器标识 */
export const ADAPTER_IDS = [
  'lighthouse',
  'web-vitals',
  'bundle-analyzer',
  'har',
  'trace',
  'playwright',
  'source-map',
  'git',
  'github',
  'gitlab',
  'sentry',
] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

/**
 * 已实现的适配器。
 *
 * 注意 `source-map` 不在采集器列表里：它不是 `CollectorPort`，
 * 而是诊断阶段按需查询的 `SourceMapPort`（见 `shared/ports/source-map.ts`）。
 * 采集器是「跑工具产出产物」，source map 是「拿产物位置换源码位置」，
 * 两者的调用时机与次数完全不同，硬塞进一条流水线只会白读一堆用不到的 map。
 */
export const IMPLEMENTED_COLLECTOR_IDS = [
  'lighthouse',
  'web-vitals',
  'bundle-analyzer',
  'har',
  'trace',
] as const satisfies readonly AdapterId[];

export type Device = 'mobile' | 'desktop';
export const DEVICES = ['mobile', 'desktop'] as const satisfies readonly Device[];
