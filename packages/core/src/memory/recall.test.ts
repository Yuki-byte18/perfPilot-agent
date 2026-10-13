import { describe, expect, it } from 'vitest';
import {
  createInMemoryMemory,
  type Candidate,
  type CandidateLibraryEntry,
  type MemoryPort,
} from '@yuki-byte18/shared';
import { recallAndAdjust } from './recall.js';
import { candidateFixture } from '../fixtures/index.js';

/**
 * 记忆召回与置信度调整（M6 验收 3/4）。
 *
 * 用 memory 实现跑，不需要真实数据库（验收 5）—— 这一组验的是**逻辑**，
 * 存储能不能存是 adapters 那一侧的事。
 */

const project = 'demo';
const techStack = 'vite+react';

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return candidateFixture({
    id: 'cand_1',
    confidence: 0.8,
    bottleneckKinds: ['CACHE_MISS'],
    ...overrides,
  });
}

function libraryEntry(
  overrides: Partial<CandidateLibraryEntry> = {},
): CandidateLibraryEntry {
  return {
    id: 'lib_1',
    bottleneckKind: 'CACHE_MISS',
    candidate: candidate({ id: 'lib_cand' }),
    actualGain: 10,
    succeeded: true,
    project,
    techStack,
    createdAt: '2026-01-17T14:25:30.000Z',
    ...overrides,
  };
}

const failure = (fingerprint: string, overrides: Record<string, unknown> = {}) => ({
  id: `fail_${fingerprint}`,
  candidateFingerprint: fingerprint,
  bottleneckKind: 'CACHE_MISS' as const,
  failureReason: '收益 0.4 < min_gain 5',
  project,
  techStack,
  failedAt: '2026-01-17T14:25:30.000Z',
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────
// 验收 3：planner 消费召回结果调整 confidence
// ─────────────────────────────────────────────────────────────────────

describe('M6 验收 3 — 召回结果调整置信度', () => {
  it('没有历史时不改动置信度', async () => {
    const memory = createInMemoryMemory();
    const outcome = await recallAndAdjust({
      memory,
      candidates: [candidate()],
      project,
      techStack,
    });

    expect(outcome.candidates[0]?.confidence).toBe(0.8);
  });

  it('成功过的方案抬升置信度，失败过的压低它（且方向不对称）', async () => {
    const successMemory = createInMemoryMemory();
    await successMemory.saveCandidate(libraryEntry());
    const lifted = await recallAndAdjust({
      memory: successMemory,
      candidates: [candidate()],
      project,
      techStack,
    });

    const failureMemory = createInMemoryMemory();
    await failureMemory.saveFailure(
      // 指纹与候选不同，否则会被直接剔除（那是验收 4 的事）
      failure('别的指纹'),
    );
    // 失败记忆一定会命中 hasFailedFailure 吗？不会 —— 指纹不同就只参与失败率统计
    const lowered = await recallAndAdjust({
      memory: failureMemory,
      candidates: [candidate()],
      project,
      techStack,
    });

    expect(lifted.candidates[0]?.confidence).toBeGreaterThan(0.8);
    expect(lowered.candidates[0]?.confidence).toBeLessThan(0.8);
    // 失败的惩罚重于一两次成功的奖励（β > α）
    expect(0.8 - (lowered.candidates[0]?.confidence ?? 0)).toBeGreaterThan(
      (lifted.candidates[0]?.confidence ?? 0) - 0.8,
    );
  });

  it('调整结果被夹在 0-1 之间，不越界', async () => {
    const memory = createInMemoryMemory();
    for (let i = 0; i < 20; i += 1) {
      await memory.saveCandidate(libraryEntry({ id: `lib_${i}` }));
    }

    const high = await recallAndAdjust({
      memory,
      candidates: [candidate({ confidence: 0.99 })],
      project,
      techStack,
    });
    expect(high.candidates[0]?.confidence).toBeLessThanOrEqual(1);

    const low = await recallAndAdjust({
      memory,
      candidates: [candidate({ confidence: 0.01 })],
      project,
      techStack,
    });
    expect(low.candidates[0]?.confidence).toBeGreaterThanOrEqual(0);
  });

  it('同一份输入两次调用结果完全一致（决策可复现的前提）', async () => {
    const memory = createInMemoryMemory();
    await memory.saveCandidate(libraryEntry());

    const input = { memory, candidates: [candidate()], project, techStack };
    const first = await recallAndAdjust(input);
    const second = await recallAndAdjust(input);

    expect(second.candidates).toEqual(first.candidates);
  });

  it('recalledFrom 只挂同类型问题的历史方案', async () => {
    const memory = createInMemoryMemory();
    await memory.saveCandidate(libraryEntry({ id: 'same_kind', bottleneckKind: 'CACHE_MISS' }));
    await memory.saveCandidate(
      libraryEntry({ id: 'other_kind', bottleneckKind: 'LARGE_JS_BUNDLE' }),
    );

    const outcome = await recallAndAdjust({
      memory,
      candidates: [candidate({ bottleneckKinds: ['CACHE_MISS'] })],
      project,
      techStack,
    });

    expect(outcome.candidates[0]?.recalledFrom).toEqual(['same_kind']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 4：曾失败的候选不再被提案
// ─────────────────────────────────────────────────────────────────────

describe('M6 验收 4 — 失败记忆生效', () => {
  it('同上下文下曾失败的候选被剔除，其余的照常提案', async () => {
    const memory = createInMemoryMemory();
    const failing = candidate({ id: 'cand_bad' });
    const fine = candidate({ id: 'cand_ok', bottleneckKinds: ['LARGE_JS_BUNDLE'] });

    // 指纹算法必须与 planner 用的是同一个 —— 不一致的话记忆永远是空的
    const { candidateFingerprint } = await import('@yuki-byte18/shared');
    await memory.saveFailure(failure(candidateFingerprint(failing)));

    const outcome = await recallAndAdjust({
      memory,
      candidates: [failing, fine],
      project,
      techStack,
    });

    expect(outcome.candidates.map((c) => c.id)).toEqual(['cand_ok']);
    expect(outcome.suppressed).toEqual([
      { candidateId: 'cand_bad', fingerprint: candidateFingerprint(failing) },
    ]);
  });

  it('别的项目失败过，不影响本项目', async () => {
    const memory = createInMemoryMemory();
    const target = candidate();
    const { candidateFingerprint } = await import('@yuki-byte18/shared');
    await memory.saveFailure(failure(candidateFingerprint(target), { project: 'other' }));

    const outcome = await recallAndAdjust({
      memory,
      candidates: [target],
      project,
      techStack,
    });

    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.suppressed).toEqual([]);
  });

  it('候选为空时不查库，直接返回空（避免无谓 IO）', async () => {
    let called = false;
    const memory: MemoryPort = {
      ...createInMemoryMemory(),
      async recallCandidates() {
        called = true;
        return { byProject: [], byKind: [], byTechStack: [], failures: [] };
      },
    };

    const outcome = await recallAndAdjust({ memory, candidates: [], project, techStack });

    expect(outcome.candidates).toEqual([]);
    expect(called).toBe(false);
  });
});
