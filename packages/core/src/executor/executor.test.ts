import { describe, expect, it } from 'vitest';
import type { Candidate, Decision, ExecutionContext, Executor, ExecutorRegistry } from '@yuki-byte18/shared';
import { ExecutorOrchestrator } from './index.js';
import { createMemoryRunStore } from '../storage/memory-run-store.js';
import { createSilentLogger } from '../logger/index.js';

/**
 * 执行编排。
 *
 * ## 这个文件是补出来的
 *
 * 编排器此前**没有测试**（覆盖率 67%），而它正好是两个真实事故的发生地：
 *
 * 1. B 类（待人工确认）候选的资产改动会被真写盘，而它不进验证 —— 文件没人回滚
 * 2. 工作区不干净时守卫说"拒绝应用改动"，execute 却照样把图片写进了工作区
 *
 * 两次都是**同一件事**：执行器写了盘，而下游没人负责撤销。
 * 因此这一组的核心断言不是"返回了什么"，而是**"到底有没有写文件"**。
 */

const candidate = (id: string, overrides: Partial<Candidate> = {}): Candidate => ({
  id,
  runId: 'run_1',
  bottleneckIds: ['bn_1'],
  class: 'A',
  title: `方案 ${id}`,
  description: 'x',
  origin: 'rule',
  ruleId: 'r1',
  promptVersion: null,
  changes: [{ type: 'config', file: 'a.json', key: 'k', before: null, after: 1 }],
  expectedGain: {},
  confidence: 0.8,
  risk: 'low',
  effort: 'low',
  reversible: true,
  recalledFrom: [],
  bottleneckKinds: ['CACHE_MISS'],
  ...overrides,
});

const decision = (candidateId: string, verdict: Decision['verdict']): Decision => ({
  id: `dec_${candidateId}`,
  runId: 'run_1',
  candidateId,
  verdict,
  route: 'config-editor',
  score: 42,
  utility: { expectedGain: 55, confidence: 0.9, cost: 4, risk: 2 },
  riskLevel: 'low',
  reasons: ['规则库命中'],
  thresholds: { minGain: 5, maxRegression: 2, maxNewErrors: 0, applyScore: 30, confirmScore: 10 },
  decidedAt: '2026-01-17T14:25:30.000Z',
});

/** 记录"写没写文件"，并允许按需抛错 */
function harness(options: { throws?: boolean; produceNothing?: boolean } = {}) {
  const written: string[] = [];
  const contexts: ExecutionContext[] = [];

  const executor: Executor = {
    route: 'asset-processor',
    canHandle: () => true,
    async execute(cand, ctx) {
      contexts.push(ctx);
      if (options.throws === true) throw new Error('sharp 崩了');

      // 模拟资产执行器：有 writeFile 就写盘，并如实报告 applied
      if (ctx.writeFile !== undefined) {
        await ctx.writeFile('assets/hero.jpg', Buffer.from([1, 2]));
        written.push('assets/hero.jpg');
      }

      if (options.produceNothing === true) {
        return { candidateId: cand.id, route: 'asset-processor', patch: '', applied: false, files: [], summary: '没有可处理的资产' };
      }

      return {
        candidateId: cand.id,
        route: 'asset-processor',
        patch: '',
        applied: ctx.writeFile !== undefined,
        files: ['assets/hero.jpg'],
        summary: ctx.writeFile === undefined ? '未写入，仅评估' : '已写入工作区',
      };
    },
  };

  const registry: ExecutorRegistry = { all: () => [executor], forCandidate: () => executor };
  const store = createMemoryRunStore();

  const orchestrator = new ExecutorOrchestrator({
    registry,
    store,
    logger: createSilentLogger(),
    createContext: () => ({
      projectRoot: '/repo',
      readFile: async () => null,
      writeFile: async () => undefined,
    }),
  });

  return { orchestrator, store, written, contexts };
}

describe('ExecutorOrchestrator — 哪些裁决会被执行', () => {
  it('apply 与 confirm 都执行（B 类的价值就是"有补丁可看"）', async () => {
    const { orchestrator } = harness();

    const outcome = await orchestrator.execute({
      runId: 'run_1',
      candidates: [candidate('c1'), candidate('c2')],
      decisions: [decision('c1', 'apply'), decision('c2', 'confirm')],
    });

    expect(outcome.results.map((r) => r.candidateId)).toEqual(['c1', 'c2']);
  });

  it('suggest / reject 不执行（C 类只出建议）', async () => {
    const { orchestrator } = harness();

    const outcome = await orchestrator.execute({
      runId: 'run_1',
      candidates: [candidate('c1'), candidate('c2')],
      decisions: [decision('c1', 'suggest'), decision('c2', 'reject')],
    });

    expect(outcome.results).toEqual([]);
  });

  it('找不到候选 / 没有执行器 / 无改动 → 记进 skipped 并说明原因', async () => {
    const { orchestrator } = harness({ produceNothing: true });

    const outcome = await orchestrator.execute({
      runId: 'run_1',
      candidates: [candidate('c1')],
      decisions: [decision('c1', 'apply'), decision('c_missing', 'apply')],
    });

    expect(outcome.results).toEqual([]);
    const reasons = outcome.skipped.map((s) => s.reason);
    expect(reasons).toContain('找不到对应的候选');
    expect(reasons).toContain('没有可处理的资产');
  });

  it('单个候选执行抛错不影响其余候选', async () => {
    const { orchestrator } = harness({ throws: true });

    const outcome = await orchestrator.execute({
      runId: 'run_1',
      candidates: [candidate('c1'), candidate('c2')],
      decisions: [decision('c1', 'apply'), decision('c2', 'apply')],
    });

    expect(outcome.results).toEqual([]);
    expect(outcome.skipped).toHaveLength(2);
    expect(outcome.skipped.every((s) => s.reason.includes('sharp 崩了'))).toBe(true);
  });

  it('补丁落盘（人工确认与审计都靠它）', async () => {
    const { orchestrator, store } = harness({ produceNothing: true });
    // 这个替身产不出补丁，因此只断言"没有补丁时不写 patch"
    await orchestrator.execute({
      runId: 'run_1',
      candidates: [candidate('c1')],
      decisions: [decision('c1', 'apply')],
    });

    expect(store.patches.get('run_1')).toBeUndefined();
  });
});

describe('ExecutorOrchestrator — 谁可以碰工作区', () => {
  it('apply 候选可以写盘（正常路径）', async () => {
    const { orchestrator, written } = harness();

    const outcome = await orchestrator.execute({
      runId: 'run_1',
      candidates: [candidate('c1')],
      decisions: [decision('c1', 'apply')],
    });

    expect(written).toEqual(['assets/hero.jpg']);
    expect(outcome.results[0]?.applied).toBe(true);
  });

  it('**confirm 候选拿不到 writeFile**：它不进验证，写下的文件没人回滚', async () => {
    const { orchestrator, written } = harness();

    const outcome = await orchestrator.execute({
      runId: 'run_1',
      candidates: [candidate('c1')],
      decisions: [decision('c1', 'confirm')],
    });

    expect(written).toEqual([]);
    expect(outcome.results[0]?.applied).toBe(false);
    // 仍然产出评估结果 —— 人需要知道"能省多少"
    expect(outcome.results[0]?.summary).toContain('未写入');
  });

  it('**allowWrite: false 时 apply 候选也拿不到 writeFile**（守卫不通过）', async () => {
    /**
     * 这是一次真实事故的回归测试：
     * 守卫判断出"工作区不干净，拒绝自动应用改动"，而 execute 照样把压缩后的图片
     * 写进了工作区 —— verify 随后跳过，于是那份改动**没人验、也没人回滚**，
     * 而报告里写着"拒绝自动应用改动"。
     */
    const { orchestrator, written } = harness();

    const outcome = await orchestrator.execute({
      runId: 'run_1',
      candidates: [candidate('c1')],
      decisions: [decision('c1', 'apply')],
      allowWrite: false,
    });

    // 核心断言：一个字节都没写
    expect(written).toEqual([]);
    expect(outcome.results[0]?.applied).toBe(false);
    // 但补丁/评估照常产出，人还能手动用
    expect(outcome.results[0]?.files).toEqual(['assets/hero.jpg']);
  });

  it('allowWrite 不传时默认允许（既有调用方不受影响）', async () => {
    const { orchestrator, written } = harness();

    await orchestrator.execute({
      runId: 'run_1',
      candidates: [candidate('c1')],
      decisions: [decision('c1', 'apply')],
    });

    expect(written).toHaveLength(1);
  });
});
