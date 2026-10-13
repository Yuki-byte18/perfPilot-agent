import type { Candidate } from '../schema/candidate.js';

/**
 * 失败记忆指纹。
 *
 * 「同一类瓶颈 + 同一类改动」视为同一个方案 —— 记忆层用它判断
 * 「这个改法以前在类似问题上失败过吗」，从而阻止重复提案（README §10）。
 *
 * 刻意**不用候选 id**：id 每次都不同，而失败经验要能跨 run 复用。
 * 也刻意**不含具体文件路径**：`src/a.png` 与 `src/b.png` 上的「转 WebP 失败」
 * 往往是同一个原因（比如构建链不支持），按路径取指纹会让经验无法迁移。
 */
export function candidateFingerprint(
  candidate: Pick<Candidate, 'bottleneckKinds' | 'changes'>,
): string {
  const changeTypes = candidate.changes.map((c) => c.type).sort().join(',');
  return `${[...candidate.bottleneckKinds].sort().join('|')}|${changeTypes}`;
}
