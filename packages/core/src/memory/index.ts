import {
  candidateFingerprint,
  type BottleneckKind,
  type Candidate,
  type FailureMemoryEntry,
  type LoggerPort,
  type MemoryPort,
  type Verification,
} from '@yuki-byte18/shared';

/**
 * 记忆层（README §10）。
 *
 * M5 只落地**写入**这一半：验证失败时把「什么改法在什么问题上失败过」记下来。
 * 读取那一半（planner 召回并据此剔除候选 / 调整置信度）已经在 M3 的
 * `Planner.applyMemory` 里实现 —— 也就是说，只要这里开始写，
 * 下一轮运行就会自动不再提案同一类失败改动。
 *
 * 存储实现（SQLite / Postgres）属于 M6；本模块只依赖 `MemoryPort`。
 */

export interface RecordFailureInput {
  memory: MemoryPort;
  candidate: Candidate;
  project: string;
  /** 失败原因（门禁给出的可读理由，来自 `gate.failedRules`） */
  failureReason: string;
  /** 技术栈；不传时从项目画像推断 */
  techStack?: string;
  logger?: LoggerPort;
  now?: () => Date;
}

/**
 * 把一次验证失败写进失败记忆。
 *
 * 三件事刻意为之：
 *
 * 1. **指纹用 `candidateFingerprint`（瓶颈类型 + 改动类型），不含文件路径与候选 id。**
 *    `src/a.png` 与 `src/b.png` 上「转 WebP 失败」往往是同一个原因；
 *    按路径记指纹会让经验无法迁移，按 id 记则跨不了 run。
 * 2. **一个候选跨多个瓶颈时，逐个 kind 各记一条。**
 *    召回是按 `BottleneckKind` 过滤的（见 `MemoryPort.recallCandidates`），
 *    只记主要 kind 会让另一个问题上的同类改动继续被提案。
 * 3. **写失败不影响验证结论。** 记忆是**优化手段**，不是门禁的一部分；
 *    数据库写不进去不该让一次已经完成的回滚变成"失败"。
 */
export async function recordFailure(input: RecordFailureInput): Promise<FailureMemoryEntry[]> {
  const { memory, candidate, project, failureReason } = input;
  const now = input.now ?? (() => new Date());
  const failedAt = now().toISOString();
  const fingerprint = candidateFingerprint(candidate);
  const techStack = input.techStack ?? (await resolveTechStack(memory, project));
  const kinds = distinctKinds(candidate);

  const entries: FailureMemoryEntry[] = [];

  if (kinds.length === 0) {
    /**
     * `CandidateSchema.bottleneckKinds` 没要求非空，所以这里可能真的拿到空数组。
     *
     * 此时**不写**，而不是退而求其次编一个 kind：召回是按 kind 过滤的
     * （见 `MemoryPort.recallCandidates`），随便填一个会让那个 kind 上的
     * 合法改动也被当成"以前失败过"而永久不再被提案 —— 一条错误的记忆
     * 比没有记忆危险得多。
     */
    input.logger?.warn('候选没有瓶颈类型，跳过失败记忆写入', { candidateId: candidate.id });
    return entries;
  }

  try {
    for (const bottleneckKind of kinds) {
      const entry: FailureMemoryEntry = {
        id: `fail_${candidate.id}_${bottleneckKind}`,
        candidateFingerprint: fingerprint,
        bottleneckKind,
        failureReason,
        project,
        techStack,
        failedAt,
      };
      await memory.saveFailure(entry);
      entries.push(entry);
    }

    input.logger?.debug('已写入失败记忆', {
      candidateId: candidate.id,
      fingerprint,
      kinds,
    });
  } catch (err) {
    // 故意吞掉：记忆写失败是"少了一条经验"，不是"这次验证不可信"
    input.logger?.warn('写入失败记忆失败', {
      candidateId: candidate.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return entries;
}

/**
 * 从一次验证记录里抽出失败原因。
 *
 * 优先用 `failedRules`（门禁逐条给出的判据），它比 `status` 有信息量得多：
 * `rolled_back` 只说明"没保留"，而
 * `收益 0.4 < min_gain 5` 直接说明了差在哪。
 */
export function failureReasonOf(verification: Verification): string {
  const rules = verification.gate.failedRules;
  if (rules.length === 0) return `验证未通过（status=${verification.status}）`;
  return rules.join('；');
}

/** 技术栈：项目画像里有就用，没有就 'unknown'（与 planner 的口径一致） */
export async function resolveTechStack(memory: MemoryPort, project: string): Promise<string> {
  try {
    const profile = await memory.getProfile(project);
    return profile?.techStack ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function distinctKinds(candidate: Candidate): BottleneckKind[] {
  return [...new Set(candidate.bottleneckKinds)];
}
