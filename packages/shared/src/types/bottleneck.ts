/**
 * 瓶颈相关的**运行时枚举**。
 *
 * 对象类型（`Attribution` / `Evidence` / `Bottleneck`）**不在这里** ——
 * 它们由 `schema/bottleneck.ts` 用 `z.infer` 反推。
 *
 * 为什么必须这样：手写接口与 zod 推断类型在 `exactOptionalPropertyTypes: true`
 * 下并不等价。zod 的 `.optional()` 推出 `T | undefined`，而手写的 `prop?: T`
 * 在该开关下表示「要么不存在、要么是 T」，两者不互相赋值；
 * `z.unknown()` 更是会推出**可选字段**。这个坑在本项目里已经踩过三次
 * （`PerfPilotConfig`、`PackageJsonSnapshot`、`PlannedChange` / `Evidence`），
 * 唯一的根治办法是让类型只有一个来源。
 */

/**
 * 瓶颈种类。运行时数组 → 编译期联合类型，诊断规则的 `kind` 与配置白名单
 * （`optimization.auto_fix` 等）共用同一份来源。
 */
export const BOTTLENECK_KINDS = [
  // 图片
  'OVERSIZED_IMAGE',
  'UNCOMPRESSED_IMAGE',
  'MISSING_DIMENSIONS',
  // 加载与渲染阻塞
  'RENDER_BLOCKING_RESOURCE',
  'MISSING_PRELOAD',
  'WEBFONT_BLOCKING',
  'FONT_FLASH',
  // JS 体积与依赖
  'LARGE_JS_BUNDLE',
  'DUPLICATE_DEPENDENCY',
  'UNUSED_DEPENDENCY',
  'LEGACY_LIBRARY',
  'NO_CODE_SPLITTING',
  'NO_TREE_SHAKING',
  // 主线程与布局
  'LONG_MAIN_THREAD_TASK',
  'CLS_SHIFT_SOURCE',
  // 网络
  'EXCESSIVE_REQUESTS',
  'NO_COMPRESSION',
  'CACHE_MISS',
] as const;

export type BottleneckKind = (typeof BOTTLENECK_KINDS)[number];

/**
 * 归因层级。
 *
 * 五类不是随便分的，而是对应五种不同的修复入口：
 * resource → 换资源 / 改 CDN；dependency → 换版本 / 去重；
 * source → 改哪一行代码；component → 改哪个组件；config → 改哪个配置项。
 */
export const ATTRIBUTION_LEVELS = [
  'resource',
  'dependency',
  'source',
  'component',
  'config',
] as const;

export type AttributionLevel = (typeof ATTRIBUTION_LEVELS)[number];

/** 证据种类。原始载荷原样保留，供人工复核与报告展开 */
export const EVIDENCE_KINDS = [
  'har-entry',
  'trace-event',
  'bundle-chunk',
  'lighthouse-audit',
  'web-vitals-attribution',
  'source-map',
  'project-config',
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
