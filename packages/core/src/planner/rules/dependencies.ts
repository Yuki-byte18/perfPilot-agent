import type {
  Bottleneck,
  Candidate,
  MetricName,
  PlannedChange,
} from '@yuki-byte18/shared';
import { buildRuleCandidate, suggestionChange, type PlannerRule } from '../types.js';

/**
 * 构建产物与依赖类规划规则。
 *
 * LARGE_JS_BUNDLE → 代码分割 / 路由懒加载（B 类）
 * DUPLICATE_DEPENDENCY → 去重（A 类，dependency-editor）
 * UNUSED_DEPENDENCY → 移除（A 类，dependency-editor）
 * LEGACY_LIBRARY → moment→dayjs / lodash→lodash-es（A 类，dependency-editor）
 * NO_CODE_SPLITTING → 路由懒加载（B 类）
 * NO_TREE_SHAKING → 开启 Tree Shaking（A 类，config-editor）
 */

function dependencyName(bottleneck: Bottleneck): string | null {
  if (bottleneck.attribution.level === 'dependency') return bottleneck.attribution.name;
  return null;
}

export const deduplicateDependencyRule: PlannerRule = {
  id: 'deduplicate-dependency',
  kind: 'DUPLICATE_DEPENDENCY',
  description: '移除重复依赖',

  plan(bottleneck, ctx): Candidate[] {
    const name = dependencyName(bottleneck);
    if (name === null) return [];

    const change: PlannedChange = {
      type: 'dependency',
      remove: [name],
      reason: `存在多个版本的 ${name}，统一为单一版本`,
    };

    const expectedGain: Partial<Record<MetricName, number>> = {
      JS_SIZE: bottleneck.impact.JS_SIZE ?? 0,
      DUPLICATE_DEPS: 1,
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_dedup`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'deduplicate-dependency',
        class: 'A',
        title: `去重依赖 ${name}`,
        description: `项目中存在多个版本的 ${name}，统一版本可减少 JS 体积`,
        changes: [change],
        expectedGain,
        risk: 'low',
        effort: 'low',
        reversible: true,
      }),
    ];
  },
};

export const removeUnusedDependencyRule: PlannerRule = {
  id: 'remove-unused-dependency',
  kind: 'UNUSED_DEPENDENCY',
  description: '移除未使用的依赖',

  plan(bottleneck, ctx): Candidate[] {
    const name = dependencyName(bottleneck);
    if (name === null) return [];

    const change: PlannedChange = {
      type: 'dependency',
      remove: [name],
      reason: `${name} 未被任何源码引用`,
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_unused`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'remove-unused-dependency',
        class: 'A',
        title: `移除未使用依赖 ${name}`,
        description: `${name} 未被引用，移除以减小安装体积与构建时间`,
        changes: [change],
        expectedGain: { UNUSED_DEPS: 1, JS_SIZE: bottleneck.impact.JS_SIZE ?? 0 },
        risk: 'low',
        effort: 'low',
        reversible: true,
      }),
    ];
  },
};

/**
 * 常见库替换映射。
 *
 * 这些替换是 A 类：API 兼容或有 codemod，最坏情况是回滚。
 */
const LEGACY_REPLACEMENTS: Record<string, { to: string; reason: string }> = {
  moment: { to: 'dayjs', reason: 'dayjs 体积仅 2KB，API 与 moment 高度兼容' },
  lodash: { to: 'lodash-es', reason: 'lodash-es 支持 Tree Shaking，按需导入' },
};

export const replaceLegacyLibraryRule: PlannerRule = {
  id: 'replace-legacy-library',
  kind: 'LEGACY_LIBRARY',
  description: '将旧式库替换为现代轻量替代',

  plan(bottleneck, ctx): Candidate[] {
    const name = dependencyName(bottleneck);
    if (name === null) return [];

    const replacement = LEGACY_REPLACEMENTS[name];
    if (replacement === undefined) return [];

    const change: PlannedChange = {
      type: 'dependency',
      replace: { from: name, to: replacement.to },
      reason: replacement.reason,
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_legacy`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'replace-legacy-library',
        class: 'A',
        title: `${name} → ${replacement.to}`,
        description: replacement.reason,
        changes: [change],
        expectedGain: { JS_SIZE: bottleneck.impact.JS_SIZE ?? 0 },
        risk: 'low',
        effort: 'medium',
        reversible: true,
      }),
    ];
  },
};

/**
 * 首屏 JS 延迟执行的折算系数：每 KB 约 1.5ms 主线程时间。
 *
 * 这是**经验值**（中低端移动设备上解析+执行 1KB 压缩 JS 的量级），不是测量结果。
 * 用它而不是"抄瓶颈的 impact"，理由见下面这条规则的注释。
 */
const MS_PER_KB_DEFERRED = 1.5;
/** 折算时最多考虑多少 KB 的首屏 JS：再多也不该按线性外推 */
const MAX_DEFERRED_KB = 800;

function estimateLcpGainMs(deferredBytes: number): number {
  return Math.round(Math.min(deferredBytes / 1024, MAX_DEFERRED_KB) * MS_PER_KB_DEFERRED);
}

/**
 * NO_CODE_SPLITTING → 路由级代码分割（B 类）。
 *
 * ## 收益口径（第二轮改过）
 *
 * 早先 `expectedGain` 直接抄了瓶颈的 `impact.JS_SIZE`（"总量能省 40%"）。
 * 那是**做不到的**：路由分割不减少 JS 总量 —— 该下载的代码一个字节都没少，
 * 它减少的是**首屏需要解析与执行的那部分**，也就是 LCP / FCP 的阻塞源。
 * 拿总量当收益，用户做完会发现 JS_SIZE 一动不动。
 *
 * 因此改为声明在 LCP / FCP 上，并把 `confidence` 从规则的默认 0.9 降到 0.6：
 * 这个数字是**折算出来的估计**，不是量出来的，效用模型该按"不太确定"权衡它。
 *
 * ## 目标文件
 *
 * 规划阶段拿不到文件系统，只能给最可能的位置；真正的核实由执行器完成 ——
 * 它会按一组约定名（`src/router/index.ts`、`src/routes.ts`……）去找路由表，
 * 全找不到就如实记为"需要人工"，绝不改一个碰巧存在的文件。
 */
export const codeSplittingRule: PlannerRule = {
  id: 'code-splitting',
  kind: 'NO_CODE_SPLITTING',
  description: '引入路由级代码分割（把静态路由组件改成动态 import）',

  plan(bottleneck, ctx): Candidate[] {
    const deferredBytes = bottleneck.impact.JS_SIZE ?? 0;
    const estimate = estimateLcpGainMs(deferredBytes);

    const change: PlannedChange = {
      type: 'ast',
      file: 'src/router/index.ts',
      node: 'lazy-route-component',
      description: '把路由表里的静态组件引用改成 () => import(...)',
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_split`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'code-splitting',
        class: 'B',
        title: '路由级代码分割',
        description:
          '首屏只加载当前路由需要的代码，其余路由按需拉取 —— 减少首帧前要解析与执行的 JS。' +
          '**不会减少 JS 总量**，改善的是 LCP / FCP。会自动删掉因此不再被用到的静态 import' +
          '（留着的话模块仍会被打进首屏，等于白改）。改动会改变加载时序，因此需要人工确认。',
        changes: [change],
        expectedGain:
          estimate === 0
            ? {}
            : {
                // 折算自"首屏可延迟的 JS 字节数"，是估计而非测量
                LCP: estimate,
                FCP: estimate,
              },
        confidence: 0.6,
        risk: 'medium',
        effort: 'medium',
        reversible: true,
      }),
    ];
  },
};

/**
 * `manualChunks` —— **只出建议，不产出 patch**。
 *
 * 这条规则曾经是 B 类候选，`expectedGain` 直接抄了瓶颈的 `impact.JS_SIZE`
 * （= 该 chunk 超出预算的部分），于是报告里写着"预期节省 436KB"。
 * 那个数字**在任何实现下都不可能兑现**：`manualChunks` 只是把模块分到不同
 * chunk 里，拆前拆后的 JS_SIZE（全部 JS 之和）完全相等。它真正改善的是
 * **缓存命中**与**并行加载**，而这两件事本项目一个都不测量。
 *
 * 真实后果比"数字不准"更糟：候选按"省 436KB"排在最前面，用户照着改完，
 * 指标一动不动 —— 从此不再相信这份报告。宁可只给一条说清楚限制的建议。
 *
 * 另外，早先的 `after` 写死了 `vendor: ['react','react-dom']` /
 * `lib: ['lodash-es','dayjs']`，而规划阶段**拿不到项目的依赖清单**
 * （`PlannerContext` 里没有它），在 Vue 项目上会写进一份引用不存在包的配置。
 */
export const largeBundleSplitRule: PlannerRule = {
  id: 'large-bundle-split',
  kind: 'LARGE_JS_BUNDLE',
  description: '把 vendor 拆成独立 chunk（改善缓存与并行加载）',

  plan(bottleneck, ctx): Candidate[] {
    const change = suggestionChange(
      'vite.manualChunks',
      '在 build.rollupOptions.output 下加 manualChunks(id) { if (id.includes("node_modules")) return "vendor"; }',
    );

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_manualchunks`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'large-bundle-split',
        class: 'C',
        // 关键限制写进标题：报告的方案表只渲染标题与收益，不渲染 description
        title: '把 vendor 拆成独立 chunk（不减总大小，只改善缓存）',
        description:
          '把 node_modules 拆到独立的 vendor chunk：应用代码改动时 vendor 不再一起失效，回访只需重新下载应用那一份。' +
          '注意：**不会减少总字节数**（JS_SIZE 拆前拆后相等），本项目也没有测量缓存命中，' +
          '因此这条只作建议、不自动应用，也不会给出预期收益数字。',
        changes: [change],
        // 刻意留空：没有任何被测量的指标会因此变好。填数字就是编造
        expectedGain: {},
        risk: 'low',
        effort: 'low',
        reversible: true,
      }),
    ];
  },
};

export const enableTreeShakingRule: PlannerRule = {
  id: 'enable-tree-shaking',
  kind: 'NO_TREE_SHAKING',
  description: '开启 Tree Shaking',

  plan(bottleneck, ctx): Candidate[] {
    const change: PlannedChange = {
      type: 'config',
      file: 'package.json',
      key: 'sideEffects',
      before: true,
      after: false,
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_treeshake`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'enable-tree-shaking',
        class: 'A',
        title: '声明 sideEffects 启用 Tree Shaking',
        description: '在 package.json 中声明 sideEffects: false，让打包器移除未使用的导出',
        changes: [change],
        expectedGain: { JS_SIZE: bottleneck.impact.JS_SIZE ?? 0 },
        risk: 'low',
        effort: 'low',
        reversible: true,
      }),
    ];
  },
};
