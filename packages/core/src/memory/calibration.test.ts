import { describe, expect, it } from 'vitest';
import type { Candidate, CandidateLibraryEntry } from '@yuki-byte18/shared';
import { candidateFingerprint, createInMemoryMemory } from '@yuki-byte18/shared';
import { MAX_SCALE, MIN_SAMPLES, calibrateCandidates, calibrateExpectedGain } from './calibration.js';
import { recallAndAdjust } from './recall.js';
import { candidateFixture } from '../fixtures/index.js';

/**
 * 用真实验证收益校准 `expectedGain`（M4 的标定遗留）。
 *
 * M4 的真实运行里，`开启 Brotli 压缩`（收益 4）与 `配置静态资源长缓存`（收益 8）
 * 被判成"不值得自动化"。当时的结论是：**要改应该用真实验证收益反哺 planner，
 * 而不是把阈值调松**。这一组验的就是那个反哺机制。
 */

const candidate = (overrides: Partial<Candidate> = {}): Candidate =>
  candidateFixture({
    id: 'cand_1',
    changes: [
      { type: 'asset', file: 'assets/hero.png', operation: 'compress', params: { quality: 80 } },
    ],
    expectedGain: { IMAGE_SIZE: 100_000 },
    bottleneckKinds: ['OVERSIZED_IMAGE'],
    ...overrides,
  });

/** 一条"这个改法在本项目上真的拿到了 X 收益"的历史 */
function sample(
  actualImageSizeGain: number,
  overrides: Partial<CandidateLibraryEntry> = {},
): CandidateLibraryEntry {
  return {
    id: `lib_${Math.abs(actualImageSizeGain)}`,
    bottleneckKind: 'OVERSIZED_IMAGE',
    candidate: candidate(),
    actualGain: 12,
    actualGainByMetric: { IMAGE_SIZE: actualImageSizeGain },
    succeeded: true,
    project: 'demo',
    techStack: 'vite+react',
    createdAt: '2026-01-17T14:25:30.000Z',
    ...overrides,
  };
}

/** 旧数据：写库时还没有 `actualGainByMetric` 这一列 */
function legacySample(): CandidateLibraryEntry {
  const { actualGainByMetric: _dropped, ...rest } = sample(-100_000);
  void _dropped;
  return rest;
}

describe('样本不足时不动估计', () => {
  it('没有历史 → 原样返回', () => {
    const result = calibrateExpectedGain(candidate(), []);

    expect(result.expectedGain).toEqual({ IMAGE_SIZE: 100_000 });
    expect(result.adjustments).toEqual([]);
  });

  it(`少于 ${MIN_SAMPLES} 次成功验证 → 保持原估计（拿一两次结果改估计只是把噪声写进去）`, () => {
    const result = calibrateExpectedGain(candidate(), [sample(-500_000), sample(-600_000)]);

    expect(result.expectedGain).toEqual({ IMAGE_SIZE: 100_000 });
    expect(result.adjustments).toEqual([]);
  });

  it('失败的样本不算（失败的改动没有"收益"可言）', () => {
    const result = calibrateExpectedGain(candidate(), [
      sample(-500_000, { succeeded: false }),
      sample(-500_000, { succeeded: false }),
      sample(-500_000, { succeeded: false }),
    ]);

    expect(result.adjustments).toEqual([]);
  });

  it('不同指纹的样本不算（那本来就不是同一件事）', () => {
    const other = sample(-500_000);
    const result = calibrateExpectedGain(candidate(), [
      { ...other, id: 'a', candidate: candidate({ changes: [{ type: 'config', file: 'x.json', key: 'k', before: null, after: 1 }] }) },
      { ...other, id: 'b', candidate: candidate({ changes: [{ type: 'config', file: 'x.json', key: 'k', before: null, after: 1 }] }) },
      { ...other, id: 'c', candidate: candidate({ changes: [{ type: 'config', file: 'x.json', key: 'k', before: null, after: 1 }] }) },
    ]);

    expect(result.adjustments).toEqual([]);
  });

  it('没有逐指标原始收益的旧数据不参与（不能拿分数当原始量用）', () => {
    const result = calibrateExpectedGain(candidate(), [legacySample(), legacySample(), legacySample()]);

    expect(result.adjustments).toEqual([]);
  });
});

describe('估计偏保守时向上校准', () => {
  it('实测收益是估计的两倍 → 上调，但取混合值而不是直接替换', () => {
    // 估计 100KB，实测中位数 200KB → scale 2 → 混合后 150KB
    const result = calibrateExpectedGain(candidate(), [
      sample(-180_000),
      sample(-200_000),
      sample(-220_000),
    ]);

    expect(result.expectedGain.IMAGE_SIZE).toBe(150_000);
    expect(result.adjustments[0]?.samples).toBe(3);
    expect(result.adjustments[0]?.scale).toBe(2);
  });

  it('取的是中位数而不是平均（一次异常不会带偏）', () => {
    // 三个样本：100K / 200K / 900K → 中位数 200K（平均值是 400K）
    const result = calibrateExpectedGain(candidate(), [
      sample(-100_000),
      sample(-200_000),
      sample(-900_000),
    ]);

    // scale = 200K/100K = 2 → 混合 150K
    expect(result.expectedGain.IMAGE_SIZE).toBe(150_000);
  });

  it('估计偏高时向下校准（实测只有估计的一半）', () => {
    const result = calibrateExpectedGain(candidate(), [
      sample(-40_000),
      sample(-50_000),
      sample(-60_000),
    ]);

    // scale = 0.5 → 混合 75K
    expect(result.expectedGain.IMAGE_SIZE).toBe(75_000);
  });

  it('缩放系数有上下限（20 倍偏差更像单位错误，不该写进估计）', () => {
    const huge = calibrateExpectedGain(candidate(), [
      sample(-2_000_000),
      sample(-2_000_000),
      sample(-2_000_000),
    ]);

    expect(huge.adjustments[0]?.scale).toBe(MAX_SCALE);
    // 100K × (1+4)/2 = 250K
    expect(huge.expectedGain.IMAGE_SIZE).toBe(250_000);
  });
});

describe('calibrateCandidates', () => {
  it('返回新数组，不改动入参（planner 的候选要进快照测试）', () => {
    const original = candidate();
    const { candidates, calibrated } = calibrateCandidates([original], [
      sample(-200_000),
      sample(-200_000),
      sample(-200_000),
    ]);

    expect(calibrated).toBe(1);
    expect(candidates[0]?.expectedGain.IMAGE_SIZE).toBe(150_000);
    // 原对象必须没被动过
    expect(original.expectedGain.IMAGE_SIZE).toBe(100_000);
  });

  it('空方案库时直接返回原候选，不做无谓遍历', () => {
    const { candidates, calibrated } = calibrateCandidates([candidate()], []);
    expect(calibrated).toBe(0);
    expect(candidates).toHaveLength(1);
  });

  it('只有部分指标有实测数据时，其余指标保持原估计', () => {
    const multi = candidate({ expectedGain: { IMAGE_SIZE: 100_000, TRANSFER_SIZE: 50_000 } });
    const result = calibrateExpectedGain(multi, [sample(-200_000), sample(-200_000), sample(-200_000)]);

    expect(result.expectedGain.IMAGE_SIZE).toBe(150_000);
    // 没有该指标的实测样本 → 原样保留
    expect(result.expectedGain.TRANSFER_SIZE).toBe(50_000);
    expect(result.adjustments.map((a) => a.metric)).toEqual(['IMAGE_SIZE']);
  });
});

describe('与 recall 串起来', () => {
  it('召回里有足够成功样本时，planner 拿到的 expectedGain 已被校准', async () => {
    const memory = createInMemoryMemory();
    for (const id of ['a', 'b', 'c']) {
      await memory.saveCandidate({ ...sample(-200_000), id: `lib_${id}` });
    }

    const outcome = await recallAndAdjust({
      memory,
      candidates: [candidate()],
      project: 'demo',
      techStack: 'vite+react',
    });

    expect(outcome.candidates[0]?.expectedGain.IMAGE_SIZE).toBe(150_000);
    // 指纹没变，因此失败记忆的判据不受影响
    expect(candidateFingerprint(outcome.candidates[0] ?? candidate())).toBe(
      candidateFingerprint(candidate()),
    );
  });

  it('校准不改变置信度（那是召回率的职责，两件事别混）', async () => {
    const memory = createInMemoryMemory();
    for (const id of ['a', 'b', 'c']) {
      await memory.saveCandidate({ ...sample(-200_000), id: `lib_${id}` });
    }

    const outcome = await recallAndAdjust({
      memory,
      candidates: [candidate({ confidence: 0.8 })],
      project: 'demo',
      techStack: 'vite+react',
    });

    // 3 次成功、0 次失败 → 0.8 + 0.15×1 = 0.95
    expect(outcome.candidates[0]?.confidence).toBe(0.95);
  });
});
