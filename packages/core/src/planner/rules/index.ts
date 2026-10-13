import type { PlannerRule } from '../types.js';
import {
  addImageDimensionsRule,
  compressOversizedImageRule,
  convertToWebpRule,
} from './images.js';
import {
  addPreloadRule,
  deferRenderBlockingRule,
  enableCompressionRule,
  excessiveRequestsSuggestionRule,
  fontDisplaySwapRule,
  fontFlashSwapRule,
  setCacheHeadersRule,
} from './network.js';
import {
  codeSplittingRule,
  deduplicateDependencyRule,
  enableTreeShakingRule,
  largeBundleSplitRule,
  removeUnusedDependencyRule,
  replaceLegacyLibraryRule,
} from './dependencies.js';
import { clsShiftSuggestionRule, longTaskVirtualListRule } from './main-thread.js';

/**
 * 内置规划规则集。
 *
 * 与诊断规则集类似，顺序不影响结果（候选最终按决策层评分排序），
 * 但保持固定顺序保证快照测试稳定。
 */
export const BUILTIN_PLANNER_RULES: readonly PlannerRule[] = [
  // 图片
  compressOversizedImageRule,
  convertToWebpRule,
  addImageDimensionsRule,
  // 网络
  addPreloadRule,
  deferRenderBlockingRule,
  fontDisplaySwapRule,
  fontFlashSwapRule,
  enableCompressionRule,
  setCacheHeadersRule,
  excessiveRequestsSuggestionRule,
  // 依赖
  deduplicateDependencyRule,
  removeUnusedDependencyRule,
  replaceLegacyLibraryRule,
  codeSplittingRule,
  largeBundleSplitRule,
  enableTreeShakingRule,
  // 主线程
  longTaskVirtualListRule,
  clsShiftSuggestionRule,
];

/** 规则集版本，随内容变化 */
export const PLANNER_RULE_SET_VERSION = 'm3.0.0';

export {
  compressOversizedImageRule,
  convertToWebpRule,
  addImageDimensionsRule,
  addPreloadRule,
  deferRenderBlockingRule,
  fontDisplaySwapRule,
  fontFlashSwapRule,
  enableCompressionRule,
  setCacheHeadersRule,
  excessiveRequestsSuggestionRule,
  deduplicateDependencyRule,
  removeUnusedDependencyRule,
  replaceLegacyLibraryRule,
  codeSplittingRule,
  largeBundleSplitRule,
  enableTreeShakingRule,
  longTaskVirtualListRule,
  clsShiftSuggestionRule,
};
