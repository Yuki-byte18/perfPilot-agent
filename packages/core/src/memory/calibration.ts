import {
  candidateFingerprint,
  type Candidate,
  type CandidateLibraryEntry,
  type MetricName,
} from '@yuki-byte18/shared';

/**
 * 用**真实验证收益**校准 planner 的 `expectedGain`（M4 留下的标定遗留）。
 *
 * ## 为什么需要它
 *
 * 规则库里的 `expectedGain` 是人估的：`TRANSFER_SIZE × 0.6`、`IMAGE_SIZE × 0.4`。
 * M4 的真实运行里，`开启 Brotli 压缩` 与 `配置静态资源长缓存` 因此被判成
 * "收益 4 分 / 8 分，不值得自动化" —— 而那两张表在方案库里本来就躺着
 * **同一个改动在这个项目上的真实收益**。
 *
 * 不知道真实收益时，保守估计是对的；有真实收益却还按估计走，就是浪费数据。
 *
 * ## 三条克制
 *
 * 1. **样本不够就不动。** 少于 `MIN_SAMPLES` 次成功验证时保持原估计 ——
 *    拿一两次结果去改估计，只是把噪声写进了规则库。
 * 2. **混合而不是替换。** 取「估计值」与「实测中位数」的中间值：
 *    单次实测受环境影响很大，而估计里含有人对这条规则的理解。
 * 3. **限幅。** 缩放系数夹在 0.25x - 4x：真实收益可以是估计的两三倍
 *    （那就是"估保守了"），但不该出现 20 倍的偏差 —— 那更可能是
 *    单位搞错了（比如 ms 与 s），把它写进估计只会让错误传播下去。
 */

/** 至少要有这么多次成功验证才敢动估计 */
export const MIN_SAMPLES = 3;

/** 缩放系数的上下限：超过这个范围更像单位错误，而不是估计偏差 */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

export interface CalibratedEstimate {
  /** 校准后的 expectedGain */
  expectedGain: Partial<Record<MetricName, number>>;
  /** 每个指标实际用到的样本数与缩放系数，进日志便于解释"为什么数字变了" */
  adjustments: Array<{ metric: MetricName; samples: number; scale: number }>;
}

/**
 * 校准单个候选的 `expectedGain`。
 *
 * 只认**成功**且同指纹的样本：失败的改动没有"收益"可言，
 * 而不同指纹的样本不是同一件事（这正是指纹存在的意义）。
 */
export function calibrateExpectedGain(
  candidate: Candidate,
  library: readonly CandidateLibraryEntry[],
): CalibratedEstimate {
  const fingerprint = candidateFingerprint(candidate);

  const samples = library.filter(
    (entry) =>
      entry.succeeded &&
      entry.actualGainByMetric !== undefined &&
      candidateFingerprint(entry.candidate) === fingerprint,
  );

  if (samples.length < MIN_SAMPLES) {
    return { expectedGain: candidate.expectedGain, adjustments: [] };
  }

  const expectedGain: Partial<Record<MetricName, number>> = { ...candidate.expectedGain };
  const adjustments: CalibratedEstimate['adjustments'] = [];

  for (const [name, estimated] of Object.entries(candidate.expectedGain)) {
    if (typeof estimated !== 'number' || estimated === 0) continue;

    const observed = samples
      .map((entry) => Math.abs(entry.actualGainByMetric?.[name] ?? 0))
      .filter((value) => value > 0);

    if (observed.length < MIN_SAMPLES) continue;

    const median = medianOf(observed);
    // 实测与估计的比值；估计偏低时 > 1，说明"估保守了"
    const rawScale = median / Math.abs(estimated);
    const scale = clamp(rawScale, MIN_SCALE, MAX_SCALE);

    // 混合：估计值 50% + 实测中位数 50%（缩放系数等价于按比例混合）
    const blended = (Math.abs(estimated) * (1 + scale)) / 2;
    expectedGain[name as MetricName] = Math.round(blended);

    adjustments.push({ metric: name as MetricName, samples: observed.length, scale: round2(scale) });
  }

  return { expectedGain, adjustments };
}

/**
 * 批量校准。
 *
 * 返回**新数组**而不是原地改：planner 的候选要进快照测试，
 * 原地修改会让"同一份输入得到不同输出"这种问题变得极难查。
 */
export function calibrateCandidates(
  candidates: readonly Candidate[],
  library: readonly CandidateLibraryEntry[],
): { candidates: Candidate[]; calibrated: number } {
  if (library.length === 0) return { candidates: [...candidates], calibrated: 0 };

  let calibrated = 0;

  const next = candidates.map((candidate) => {
    const result = calibrateExpectedGain(candidate, library);
    if (result.adjustments.length === 0) return candidate;

    calibrated += 1;
    return { ...candidate, expectedGain: result.expectedGain };
  });

  return { candidates: next, calibrated };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  const left = sorted[middle - 1] ?? 0;
  const right = sorted[middle] ?? 0;
  return (left + right) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
