import {
  adjustConfidenceByRecall,
  candidateFingerprint,
  type Candidate,
  type LoggerPort,
  type MemoryPort,
  type RecallResult,
} from '@yuki-byte18/shared';
import { calibrateCandidates } from './calibration.js';

/**
 * 记忆召回与置信度调整（README §10、M6 验收 3/4）。
 *
 * 这段逻辑原先长在 `Planner.applyMemory` 里。抽出来的理由不是"分层好看"，
 * 而是**它有两个独立职责**：查记忆、按记忆改写候选。混在规划器里时，
 * 想验证"失败过的候选不再被提案"就必须构造一整个 Planner（规则库、LLM 端口、
 * 诊断对象……），于是这条最该被钉死的规则反而最不容易测。
 */

export interface RecallInput {
  memory: MemoryPort;
  candidates: readonly Candidate[];
  project: string;
  techStack: string;
  /** 召回条数上限，默认 20 */
  limit?: number;
  logger?: LoggerPort;
}

export interface RecallOutcome {
  /** 剔除失败指纹、并调整过置信度的候选 */
  candidates: Candidate[];
  recall: RecallResult;
  /** 因为命中失败记忆而被剔除的候选 */
  suppressed: Array<{ candidateId: string; fingerprint: string }>;
}

/**
 * 召回 + 调整。
 *
 * 三个确定性保证（M6 验收 3 要求"调整逻辑有确定性测试"）：
 *
 * 1. **纯由输入决定**：同一份记忆 + 同一批候选 → 同一份输出，无时间、无随机。
 * 2. **置信度调整只走 `adjustConfidenceByRecall`**：那是 shared 里的纯函数，
 *    有独立测试。这里不另写一套权重。
 * 3. **剔除是按指纹做的**，不是按 id —— 指纹跨 run 稳定，id 不稳定。
 *    这正是失败记忆能跨次生效的原因。
 */
export async function recallAndAdjust(input: RecallInput): Promise<RecallOutcome> {
  const { memory, candidates, project, techStack } = input;
  const limit = input.limit ?? 20;

  if (candidates.length === 0) {
    return {
      candidates: [],
      recall: { byProject: [], byKind: [], byTechStack: [], failures: [] },
      suppressed: [],
    };
  }

  const recall = await memory.recallCandidates({
    project,
    bottleneckKinds: [...new Set(candidates.flatMap((c) => c.bottleneckKinds))],
    techStack,
    limit,
  });

  const adjusted: Candidate[] = [];
  const suppressed: RecallOutcome['suppressed'] = [];

  for (const candidate of candidates) {
    const fingerprint = candidateFingerprint(candidate);

    /**
     * 失败记忆优先于一切：这个改法在当前上下文里失败过，就不再提案。
     *
     * 判据用 `hasFailedFailure`（按项目 + 指纹查）而不是从 `recall.failures`
     * 里找：召回结果受 `limit` 限制，候选一多就可能被截断 ——
     * 那样"曾经失败过"会随着项目变大而悄悄失效。
     */
    if (await memory.hasFailedFailure(fingerprint, project)) {
      suppressed.push({ candidateId: candidate.id, fingerprint });
      input.logger?.debug('候选命中失败记忆，不再提案', {
        candidateId: candidate.id,
        fingerprint,
      });
      continue;
    }

    adjusted.push({
      ...candidate,
      // 三位小数：报告与快照都要稳定，浮点尾巴会让「同输入同输出」失效
      confidence: round3(adjustConfidenceByRecall(candidate.confidence, recall)),
      // 只记「与本候选同类问题」的历史方案：把别的瓶颈的召回 id 挂上来，
      // 报告里会显示成"参考了一个跟它无关的方案"
      recalledFrom: recall.byProject
        .filter((entry) => candidate.bottleneckKinds.includes(entry.bottleneckKind))
        .map((entry) => entry.id)
        .slice(0, 3),
    });
  }

  /**
   * 用真实验证收益校准 `expectedGain`（M4 的标定遗留）。
   *
   * 放在这里而不是 planner 的规则里：规则只该负责"这个改法能做什么"，
   * "在这个项目上通常能拿到多少收益"是**记忆**才知道的事。
   */
  const { candidates: calibrated, calibrated: count } = calibrateCandidates(adjusted, [
    ...recall.byProject,
    ...recall.byKind,
    ...recall.byTechStack,
  ]);

  if (count > 0) {
    input.logger?.info('已用真实验证收益校准预期收益', { candidates: count });
  }

  return { candidates: calibrated, recall, suppressed };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
