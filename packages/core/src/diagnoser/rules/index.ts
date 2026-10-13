import type { DiagnosticRule } from '../types.js';
import { oversizedImageRule, uncompressedImageRule } from './images.js';
import {
  cacheMissRule,
  excessiveRequestsRule,
  missingPreloadRule,
  noCompressionRule,
  renderBlockingRule,
} from './network.js';
import {
  duplicateDependencyRule,
  largeJsBundleRule,
  legacyLibraryRule,
  noCodeSplittingRule,
} from './bundle.js';
import { clsShiftSourceRule, longMainThreadTaskRule } from './main-thread.js';

/**
 * 内置规则集。
 *
 * 顺序不影响结果（瓶颈最终按 severity 排序），但会影响**同分时的稳定性**，
 * 因此保持固定顺序，并在合并阶段用标题做最终 tiebreak。
 *
 * 规则集版本随内容变化 —— 历史诊断要能解释「为什么同一份数据这次多报了一条」，
 * 所以版本号写进 Diagnosis。
 */
export const BUILTIN_RULES: readonly DiagnosticRule[] = [
  // 图片
  oversizedImageRule,
  uncompressedImageRule,
  // 网络
  renderBlockingRule,
  noCompressionRule,
  excessiveRequestsRule,
  cacheMissRule,
  missingPreloadRule,
  // 构建产物
  largeJsBundleRule,
  duplicateDependencyRule,
  legacyLibraryRule,
  noCodeSplittingRule,
  // 主线程与布局
  longMainThreadTaskRule,
  clsShiftSourceRule,
];

/** 规则集版本。任何规则的新增/修改/删除都要改这里 */
export const RULE_SET_VERSION = 'm2.1.0';

export {
  oversizedImageRule,
  uncompressedImageRule,
  renderBlockingRule,
  noCompressionRule,
  excessiveRequestsRule,
  cacheMissRule,
  missingPreloadRule,
  largeJsBundleRule,
  duplicateDependencyRule,
  legacyLibraryRule,
  noCodeSplittingRule,
  longMainThreadTaskRule,
  clsShiftSourceRule,
};
