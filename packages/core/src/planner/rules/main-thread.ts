import type { Candidate, PlannedChange } from '@yuki-byte18/shared';
import { buildRuleCandidate, suggestionChange, type PlannerRule } from '../types.js';

/**
 * 主线程与布局类规划规则。
 *
 * LONG_MAIN_THREAD_TASK → 虚拟列表 / debounce（B 类，改渲染逻辑）
 * CLS_SHIFT_SOURCE → 仅建议（C 类，可能涉及布局重构）
 *
 * 这些涉及运行时语义改动，不敢全自动，需要人工确认。
 */

export const longTaskVirtualListRule: PlannerRule = {
  id: 'long-task-virtual-list',
  kind: 'LONG_MAIN_THREAD_TASK',
  description: '长列表使用虚拟滚动',

  plan(bottleneck, ctx): Candidate[] {
    const attr = bottleneck.attribution;

    // 先把归因收窄到「能落到具体代码位置」的两类：
    // component（DOM 选择器）与 source（源码 file:line）。
    // 写成显式的两步收窄而不是一个复合布尔量 —— TS 无法从
    // `const isListLike = level === 'component' && ...` 反推出
    // 「else 分支的 level 一定是 source」，那样访问 .file 会报错。
    if (attr.level !== 'component' && attr.level !== 'source') return [];

    // component 级只在看起来像列表时才建议虚拟滚动；
    // source 级说明已经精确定位到某行代码，直接给出建议让人判断。
    if (attr.level === 'component' && !/list|table|grid|virtual/i.test(attr.name)) return [];

    const target = attr.level === 'component' ? attr.name : `${attr.file}:${attr.line}`;

    const change: PlannedChange = {
      type: 'ast',
      file: attr.level === 'source' ? attr.file : 'src/components/List.tsx',
      node: 'list-render',
      description: `将 ${target} 改为虚拟滚动（只渲染可视区域）`,
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_virtuallist`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'long-task-virtual-list',
        class: 'B',
        title: `为长列表引入虚拟滚动`,
        description: `渲染大量 DOM 节点阻塞主线程。目标：${target}。改虚拟列表后只渲染可视区域。`,
        changes: [change],
        expectedGain: { TBT: bottleneck.impact.TBT ?? 100, INP: bottleneck.impact.INP ?? 50 },
        risk: 'medium',
        effort: 'medium',
        reversible: true,
      }),
    ];
  },
};

export const clsShiftSuggestionRule: PlannerRule = {
  id: 'cls-shift-suggestion',
  kind: 'CLS_SHIFT_SOURCE',
  description: 'CLS 偏移源建议（仅建议）',

  plan(bottleneck, ctx): Candidate[] {
    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_cls`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'cls-shift-suggestion',
        class: 'C',
        title: '布局偏移需人工评估',
        description: '检测到 CLS 偏移源，建议检查动态内容插入、图片尺寸、字体加载。具体修复需人工评估布局结构。',
        changes: [suggestionChange('cls-review', bottleneck.title)],
        expectedGain: { CLS: bottleneck.impact.CLS ?? 0.05 },
        risk: 'high',
        effort: 'high',
        reversible: false,
      }),
    ];
  },
};
