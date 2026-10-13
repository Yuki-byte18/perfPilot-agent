import type { Bottleneck, BottleneckKind } from '@yuki-byte18/shared';
import type { Detection } from './types.js';
import { severityWithOccurrences } from './types.js';

/** 证据条数上限：报告与 MR 评论不需要看 200 条同类证据 */
const MAX_EVIDENCE = 5;

/**
 * 把若干检测按「同一根因」合并成瓶颈。
 *
 * 合并键是 `kind + mergeKey`。用 `mergeKey` 而不是整个 attribution：
 * 12 张超标图片的 attribution 各不相同（url 不同），但它们是一件事
 * ——「这个目录下的图片该统一处理」。合并后：
 *   - `occurrences` 记录实际条数
 *   - `severity` 用对数随条数上升（12 张图和 2 张图不是一回事）
 *   - `attribution` 取**最严重的那一条**作为代表，人点进去先看到最该改的
 *   - `evidence` 保留前几条 + 一条「还有 N 条」的汇总
 *
 * 合并是稳定排序的前提：不合并的话，同一份输入会产出几十条高度相似的瓶颈，
 * 报告无法阅读，后续决策层也会把同一件事重复评分。
 */
export function mergeDetections(
  runId: string,
  kind: BottleneckKind,
  detections: readonly Detection[],
): Bottleneck[] {
  const groups = new Map<string, Detection[]>();

  for (const detection of detections) {
    const key = `${kind}::${detection.mergeKey}`;
    const existing = groups.get(key);
    if (existing) existing.push(detection);
    else groups.set(key, [detection]);
  }

  const bottlenecks: Bottleneck[] = [];

  for (const [key, group] of groups) {
    // 代表项：最严重的那条；同分时取置信度高的，再同分取标题字典序 —— 保证确定性
    const representative = [...group].sort(
      (a, b) => b.severity - a.severity || b.confidence - a.confidence || a.title.localeCompare(b.title),
    )[0];
    if (representative === undefined) continue;

    const occurrences = group.length;
    const severity = severityWithOccurrences(representative.severity, occurrences);

    bottlenecks.push({
      id: bottleneckId(runId, kind, key),
      runId,
      kind,
      title: representative.title,
      severity,
      impact: sumImpact(group),
      attribution: representative.attribution,
      evidence: collectEvidence(group),
      // 合并后的置信度取组内最高：只要有一条证据是硬的，结论就立得住
      confidence: Math.max(...group.map((d) => d.confidence)),
      occurrences,
      // 规则产出的结论：诊断 agent 的结论走另一条路（`diagnoser/agent.ts`）
      source: 'rule',
    });
  }

  // 严重度降序；同分时按置信度降序，再按标题排序 —— 快照测试要求完全确定
  return bottlenecks.sort(
    (a, b) => b.severity - a.severity || b.confidence - a.confidence || a.title.localeCompare(b.title),
  );
}

/**
 * 影响量按指标累加，但**同类问题的收益不能简单相加**。
 *
 * 12 张超标图片的 `JS_SIZE` 累加没问题（各自独立），但 `LCP` 这类指标
 * 累加会得到荒谬的结果（12 × 300ms = 3.6s 的「可节省时间」）。
 * 因此时间类指标取**最大值**，体积类指标取**和**：
 * 修好 12 张图不会让 LCP 减少 12 倍，但确实会减少全部 12 份体积。
 */
function sumImpact(group: readonly Detection[]): Bottleneck['impact'] {
  const additive = new Set(['JS_SIZE', 'CSS_SIZE', 'IMAGE_SIZE', 'TRANSFER_SIZE']);
  const totals: Bottleneck['impact'] = {};

  for (const detection of group) {
    for (const [name, value] of Object.entries(detection.impact)) {
      if (value === undefined) continue;
      const key = name as keyof Bottleneck['impact'];
      const current = totals[key] ?? 0;
      totals[key] = additive.has(name) ? current + value : Math.max(current, value);
    }
  }

  return totals;
}

function collectEvidence(group: readonly Detection[]): Bottleneck['evidence'] {
  const all = group.flatMap((d) => d.evidence);
  if (all.length <= MAX_EVIDENCE) return all;

  const kept = all.slice(0, MAX_EVIDENCE - 1);
  return [
    ...kept,
    {
      kind: 'har-entry',
      payload: { total: all.length, shown: kept.length },
      description: `另有 ${all.length - kept.length} 条同类证据，完整清单见 run.json`,
    },
  ];
}

/**
 * 瓶颈 id。
 *
 * 用 `runId + kind + mergeKey` 的稳定哈希而不是随机数：
 * 同一次 run 重跑诊断必须得到同样的 id（快照测试、MR 评论去重都依赖这一点）。
 */
function bottleneckId(runId: string, kind: BottleneckKind, key: string): string {
  const input = `${runId}|${kind}|${key}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `bn_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
