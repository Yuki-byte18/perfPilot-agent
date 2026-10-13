import { describe, expect, it } from 'vitest';
import {
  candidateFingerprint,
  createFakeCheckRunner,
  createInMemoryMemory,
  createNullErrorScan,
  createNullGit,
  type CheckRunnerPort,
  type ErrorScanPort,
  type GitPort,
  type MemoryPort,
  type Metric,
} from '@yuki-byte18/shared';
import { DEFAULT_CHECK_KINDS, Verifier } from './index.js';
import { candidateFixture, configFixture, metric } from '../fixtures/index.js';
import { createMemoryRunStore, type MemoryRunStore } from '../storage/memory-run-store.js';
import { createSilentLogger } from '../logger/index.js';

/**
 * M5 验收 3/4/5/6：
 * - 四项检查结果写入 `checks`
 * - 门禁公式 `gain ≥ min_gain && worstRegression ≤ max_regression && newErrors ≤ max_new_errors`
 * - **每条保留路径都有对应的回滚测试**
 * - 失败原因写入失败记忆
 */

const silent = createSilentLogger();

/** 记录调用序列的 git 替身：断言「确实回滚了」，而不只是 status 字段写着 rolled_back */
function recordingGit(): GitPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    ...createNullGit(),
    calls,
    async currentRef() {
      calls.push('currentRef');
      return 'base-ref';
    },
    async resetHard(ref: string) {
      calls.push(`resetHard:${ref}`);
    },
    async commit() {
      calls.push('commit');
      return 'result-ref';
    },
  };
}

interface HarnessOptions {
  config?: Record<string, unknown>;
  checks?: CheckRunnerPort;
  git?: GitPort;
  errorScan?: ErrorScanPort;
  /** recollect 返回的「改动后」指标 */
  metrics?: Metric[];
  /** recollect 抛错 */
  recollectThrows?: string;
  /** 带上失败记忆 */
  memory?: MemoryPort;
}

interface Harness {
  store: MemoryRunStore;
  git: GitPort & { calls: string[] };
  memory: MemoryPort | null;
  /** 已绑定 recollect 的验证入口 —— 省去每个用例重复拼装输入 */
  verify: (baseline: readonly Metric[], baseRef?: string) => ReturnType<Verifier['verify']>;
}

function harness(options: HarnessOptions = {}): Harness {
  const store = createMemoryRunStore();
  const git = options.git ?? recordingGit();
  const memory = options.memory ?? null;

  const verifier = new Verifier({
    config: configFixture(options.config ?? {}),
    checkRunner: options.checks ?? createFakeCheckRunner(true),
    git,
    errorScan: options.errorScan ?? createNullErrorScan(),
    store,
    logger: silent,
    memory,
    projectRoot: '/repo',
  });

  const recollect = async (): Promise<Metric[]> => {
    if (options.recollectThrows !== undefined) throw new Error(options.recollectThrows);
    return options.metrics ?? [];
  };

  return {
    store,
    git: git as GitPort & { calls: string[] },
    memory,
    verify: (baseline, baseRef = 'base-ref') =>
      verifier.verify({
        runId: 'run_1',
        candidate: candidateFixture(),
        route: 'config-editor',
        baselineMetrics: baseline,
        baseRef,
        startedAtIso: '2026-01-17T14:25:30.000Z',
        recollect,
      }),
  };
}

// LCP 3500ms → 分数 66.7；2000ms → 100。差 ≈ +33，远超 min_gain 5
const BIG_GAIN: readonly Metric[] = [metric('LCP', 3500)];
const IMPROVED: readonly Metric[] = [metric('LCP', 2000)];
// 只快 60ms：分数变化 < 5，收益不达标
const TINY_GAIN: readonly Metric[] = [metric('LCP', 2560)];
const BARELY_MOVED: readonly Metric[] = [metric('LCP', 2500)];

// ─────────────────────────────────────────────────────────────────────
// 验收 4：门禁公式
// ─────────────────────────────────────────────────────────────────────

describe('M5 验收 4 — 门禁公式', () => {
  it('四项全过 → 保留（status=kept）', async () => {
    const h = harness({ metrics: [...IMPROVED] });
    const { verification, kept } = await h.verify(BIG_GAIN);

    expect(kept).toBe(true);
    expect(verification.status).toBe('kept');
    expect(verification.gate.passed).toBe(true);
    expect(verification.gate.gainOk).toBe(true);
    expect(verification.gate.failedRules).toEqual([]);
    expect(h.git.calls).toContain('commit');
    expect(h.git.calls.some((c) => c.startsWith('resetHard'))).toBe(false);
  });

  it('收益不足 → 回滚，failedRules 说明差在哪', async () => {
    const h = harness({ metrics: [...TINY_GAIN] });
    const { verification, kept } = await h.verify(BARELY_MOVED);

    expect(kept).toBe(false);
    expect(verification.gate.gainOk).toBe(false);
    expect(verification.gate.failedRules.join(' ')).toContain('min_gain');
    expect(h.git.calls).toContain('resetHard:base-ref');
  });

  it('单项回归超阈值 → 回滚（即使总收益为正）', async () => {
    const h = harness({
      // LCP 大幅改善（分数 +33.3），CLS 从 0.05 掉到 0.15（分数 −16.7）。
      // 总收益 +16.7 是正的、远超 min_gain，但 CLS 单项倒退超过 max_regression 2
      metrics: [metric('LCP', 2000), metric('CLS', 0.15)],
    });

    const { verification, kept } = await h.verify([metric('LCP', 3500), metric('CLS', 0.05)]);

    expect(kept).toBe(false);
    expect(verification.gate.gainOk).toBe(true); // 总收益够
    expect(verification.gate.regressionOk).toBe(false); // 但单项崩了
    expect(verification.gate.failedRules.join(' ')).toContain('max_regression');
  });

  it('检查失败 → 回滚（即使指标明显变好）', async () => {
    const h = harness({ checks: createFakeCheckRunner(false), metrics: [...IMPROVED] });
    const { verification, kept } = await h.verify(BIG_GAIN);

    expect(kept).toBe(false);
    expect(verification.gate.gainOk).toBe(true);
    expect(verification.gate.failedRules.join(' ')).toContain('检查未通过');
    expect(h.git.calls).toContain('resetHard:base-ref');
  });

  it('引入新错误 → 回滚（max_new_errors 默认 0）', async () => {
    const h = harness({
      metrics: [...IMPROVED],
      errorScan: {
        async scan() {
          return [{ type: 'TypeError', message: 'x is not a function', count: 3 }];
        },
      },
    });

    const { verification, kept } = await h.verify(BIG_GAIN);

    expect(kept).toBe(false);
    expect(verification.gate.errorsOk).toBe(false);
    expect(verification.newErrors).toHaveLength(1);
    expect(verification.gate.failedRules.join(' ')).toContain('max_new_errors');
  });

  it('阈值来自配置：把 min_gain 提到 50，同样的改动就不再达标', async () => {
    const h = harness({
      config: {
        decision: {
          thresholds: {
            min_gain: 50,
            max_regression: 2,
            max_new_errors: 0,
            apply_score: 30,
            confirm_score: 10,
          },
        },
      },
      metrics: [...IMPROVED],
    });

    const { verification, kept } = await h.verify(BIG_GAIN);

    // +33 分是真实收益，但配置要求 50
    expect(verification.gate.gainOk).toBe(false);
    expect(kept).toBe(false);
  });

  it('检查抛异常按失败算，不让验证整体崩掉', async () => {
    const throwing: CheckRunnerPort = {
      async run(kind) {
        if (kind === 'e2e') throw new Error('浏览器起不来');
        return { kind, passed: true, durationMs: 1, output: 'ok' };
      },
    };

    const h = harness({ checks: throwing, metrics: [...IMPROVED] });
    const { verification, kept } = await h.verify(BIG_GAIN);

    const e2e = verification.checks.find((c) => c.kind === 'e2e');
    expect(e2e?.passed).toBe(false);
    expect(e2e?.output).toContain('浏览器起不来');
    expect(kept).toBe(false);
  });

  it('重采集抛异常 → 该项检查失败并回滚', async () => {
    const h = harness({ recollectThrows: '采集器超时' });
    const { verification, kept } = await h.verify(BIG_GAIN);

    expect(kept).toBe(false);
    const recollect = verification.checks.find((c) => c.kind === 'recollect');
    expect(recollect?.passed).toBe(false);
    expect(recollect?.output).toContain('采集器超时');
  });

  it('重采集返回空 → 同样回滚，并说明原因', async () => {
    const h = harness({ metrics: [] });
    const { verification, kept } = await h.verify(BIG_GAIN);

    expect(kept).toBe(false);
    expect(verification.checks.find((c) => c.kind === 'recollect')?.output).toContain(
      '未产出任何指标',
    );
  });

  it('错误扫描连不上 → 按「不知道」处理，不放行', async () => {
    /**
     * 这是回归测试：早先 `failedChecks` 在 error-scan 之前就算完了，
     * 于是扫描失败时 `newErrors` 为空、门禁把「无法判断」当成「没有新错误」而放行。
     */
    const h = harness({
      metrics: [...IMPROVED],
      errorScan: {
        async scan() {
          throw new Error('sentry 未配置');
        },
      },
    });

    const { verification, kept } = await h.verify(BIG_GAIN);
    const scan = verification.checks.find((c) => c.kind === 'error-scan');

    expect(scan?.passed).toBe(false);
    expect(scan?.output).toContain('sentry 未配置');
    expect(kept).toBe(false);
    expect(verification.gate.failedRules.join(' ')).toContain('error-scan');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 5：每条保留路径都有对应的回滚测试
// ─────────────────────────────────────────────────────────────────────

describe('M5 验收 5 — 回滚路径覆盖', () => {
  /**
   * 「每条保留路径都有对应的回滚测试」落实为：
   * 每一种**可以否决**的条件都有一条用例走到它，并且断言
   * **工作区确实回到了基线 ref**（而不只是 `status` 字段写着 `rolled_back`）。
   *
   * 四个否决条件（检查 / 收益 / 回归 / 新错误）逐一覆盖，
   * 外加「重采集拿不到数据」这条事实上的第五条。
   */
  const rollbackCases: Array<{ name: string; options: HarnessOptions; baseline: Metric[] }> = [
    {
      name: '检查失败',
      options: { checks: createFakeCheckRunner(false), metrics: [...IMPROVED] },
      baseline: [...BIG_GAIN],
    },
    { name: '收益不足', options: { metrics: [...TINY_GAIN] }, baseline: [...BARELY_MOVED] },
    {
      name: '单项回归',
      options: { metrics: [metric('LCP', 2000), metric('CLS', 0.15)] },
      baseline: [metric('LCP', 3500), metric('CLS', 0.05)],
    },
    {
      name: '新增错误',
      options: {
        metrics: [...IMPROVED],
        errorScan: {
          async scan() {
            return [{ type: 'E', message: 'm', count: 1 }];
          },
        },
      },
      baseline: [...BIG_GAIN],
    },
    { name: '重采集为空', options: { metrics: [] }, baseline: [...BIG_GAIN] },
  ];

  it.each(rollbackCases)('$name → 执行 resetHard 回到基线 ref', async ({ options, baseline }) => {
    const h = harness(options);
    const { verification, kept } = await h.verify(baseline);

    expect(kept).toBe(false);
    expect(verification.status).toBe('rolled_back');
    // 关键断言：真的回滚了
    expect(h.git.calls).toContain('resetHard:base-ref');
    // 未通过就不该留下提交
    expect(h.git.calls).not.toContain('commit');
    // 且说明了为什么
    expect(verification.gate.failedRules.length).toBeGreaterThan(0);
  });

  it('回滚失败时如实记录（reverted=false），不谎报成功', async () => {
    const failingGit: GitPort = {
      ...createNullGit(),
      async resetHard() {
        throw new Error('工作区被占用');
      },
    };

    const h = harness({ git: failingGit, metrics: [...TINY_GAIN] });
    const { verification, kept } = await h.verify(BARELY_MOVED);

    expect(kept).toBe(false);
    expect(verification.git?.reverted).toBe(false);
  });

  it('提交失败不影响「保留」这个结论，resultRef 记 null', async () => {
    const failingGit: GitPort = {
      ...createNullGit(),
      async commit() {
        throw new Error('没有 git 仓库');
      },
    };

    const h = harness({ git: failingGit, metrics: [...IMPROVED] });
    const { verification, kept } = await h.verify(BIG_GAIN);

    expect(kept).toBe(true);
    expect(verification.git).toMatchObject({ resultRef: null, reverted: false });
  });

  it('保留时 resultRef 有值、reverted=false；回滚时 resultRef=null、reverted=true', async () => {
    const kept = await harness({ metrics: [...IMPROVED] }).verify(BIG_GAIN);
    expect(kept.verification.git).toMatchObject({ resultRef: 'result-ref', reverted: false });

    const rolled = await harness({ metrics: [...TINY_GAIN] }).verify(BARELY_MOVED);
    expect(rolled.verification.git).toMatchObject({ resultRef: null, reverted: true });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 3：检查结果写入 checks
// ─────────────────────────────────────────────────────────────────────

describe('M5 验收 3 — 检查结果写入 checks', () => {
  it('默认跑 单测 / 类型检查 / lint / E2E，外加重采集与错误扫描', async () => {
    const { verification } = await harness({ metrics: [...IMPROVED] }).verify(BIG_GAIN);

    const kinds = verification.checks.map((c) => c.kind);
    for (const kind of DEFAULT_CHECK_KINDS) expect(kinds).toContain(kind);
    expect(kinds).toContain('recollect');
    expect(kinds).toContain('error-scan');
  });

  it('检查通过时 output 为 null；失败时记录输出摘要', async () => {
    const ok = await harness({ metrics: [...IMPROVED] }).verify(BIG_GAIN);
    const okCodeChecks = ok.verification.checks.filter((c) =>
      (DEFAULT_CHECK_KINDS as readonly string[]).includes(c.kind),
    );
    expect(okCodeChecks.every((c) => c.output === null)).toBe(true);

    const bad = await harness({
      checks: createFakeCheckRunner(false),
      metrics: [...IMPROVED],
    }).verify(BIG_GAIN);
    expect(bad.verification.checks.filter((c) => !c.passed).every((c) => c.output !== null)).toBe(
      true,
    );
  });

  it('项目里没有的检查记为 skipped（既不算失败，也要留下说明）', async () => {
    /**
     * 很多前端项目没有 E2E。把它当失败会让每次优化都回滚；
     * 当通过则会在验证记录里留下一条假证据。只能如实标成"跳过"。
     */
    const skipping: CheckRunnerPort = {
      async run(kind) {
        if (kind === 'e2e') {
          return {
            kind,
            passed: true,
            skipped: true,
            durationMs: 0,
            output: 'package.json 未定义 `e2e` 脚本，跳过该项检查',
          };
        }
        return { kind, passed: true, durationMs: 1, output: 'ok' };
      },
    };

    const { verification, kept } = await harness({ checks: skipping, metrics: [...IMPROVED] }).verify(
      BIG_GAIN,
    );
    const e2e = verification.checks.find((c) => c.kind === 'e2e');

    expect(e2e?.skipped).toBe(true);
    // 跳过不是失败：不该因此回滚
    expect(kept).toBe(true);
    // 但必须留下"为什么跳过"
    expect(e2e?.output).toContain('未定义');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 报告数据 + 验收 6：失败记忆
// ─────────────────────────────────────────────────────────────────────

describe('Verifier — 报告数据完整性', () => {
  it('deltas / regressions / gain 三者一致', async () => {
    const h = harness({ metrics: [metric('LCP', 2000), metric('CLS', 0.15)] });
    const { verification } = await h.verify([metric('LCP', 3500), metric('CLS', 0.05)]);

    expect(verification.deltas).toHaveLength(2);
    expect(verification.regressions.map((d) => d.name)).toEqual(['CLS']);
    expect(verification.regressions.every((d) => (d.scoreDelta ?? 0) < 0)).toBe(true);
    // gain 记的是「原始值变化」，统一口径为「正 = 改善」，只收录真正变了的指标
    expect(verification.gain.LCP).toBe(1500); // 3500ms → 2000ms
    expect(verification.gain.CLS).toBeCloseTo(-0.1, 5); // 0.05 → 0.15 = 变差
    // 总收益为正（LCP +33.3 抵消 CLS −16.7），但单项回归仍然被单独盯住
    expect(verification.gate.gainOk).toBe(true);
    expect(verification.gate.regressionOk).toBe(false);
  });

  it('无基线可比时不编造收益', async () => {
    // 基线只有 LCP，改动后多了 INP —— INP 没有可比基线
    const h = harness({ metrics: [metric('LCP', 2000), metric('INP', 100)] });
    const { verification } = await h.verify(BIG_GAIN);

    const inp = verification.deltas.find((d) => d.name === 'INP');
    expect(inp?.scoreDelta).toBeNull();
    expect(verification.gain.INP).toBeUndefined();
  });

  it('验证记录落盘，含 failedRules 与实际收益', async () => {
    const h = harness({ metrics: [...TINY_GAIN] });
    await h.verify(BARELY_MOVED);

    const saved = (await h.store.loadJson('run_1', 'verifications/cand_1.json')) as Record<
      string,
      unknown
    > | null;

    expect(saved).not.toBeNull();
    expect(saved?.['status']).toBe('rolled_back');
    const gate = saved?.['gate'] as { failedRules: string[] };
    expect(gate.failedRules.length).toBeGreaterThan(0);
    expect(saved?.['gain']).toBeDefined();
    expect(saved?.['deltas']).toBeDefined();
    expect(saved?.['patchRef']).toBe('patches/cand_1.patch');
  });
});

describe('M5 验收 6 — 失败原因写入失败记忆', () => {
  it('回滚的候选写进失败记忆，理由是门禁给出的判据', async () => {
    const memory = createInMemoryMemory();
    const h = harness({ metrics: [...TINY_GAIN], memory });
    await h.verify(BARELY_MOVED);

    const failures = await memory.listFailures('demo', 10);
    expect(failures).toHaveLength(1);

    const failure = failures[0];
    expect(failure?.candidateFingerprint).toBe(candidateFingerprint(candidateFixture()));
    expect(failure?.bottleneckKind).toBe('CACHE_MISS');
    // 理由必须是"差在哪"，而不是一句"没通过"
    expect(failure?.failureReason).toContain('min_gain');
    expect(failure?.project).toBe('demo');
  });

  it('保留的候选不写失败记忆', async () => {
    const memory = createInMemoryMemory();
    const h = harness({ metrics: [...IMPROVED], memory });
    await h.verify(BIG_GAIN);

    expect(await memory.listFailures('demo', 10)).toEqual([]);
  });

  it('没有记忆端口时验证照常完成（记忆是优化手段，不是门禁的一部分）', async () => {
    const h = harness({ metrics: [...TINY_GAIN] });
    const { verification, kept } = await h.verify(BARELY_MOVED);

    expect(kept).toBe(false);
    expect(verification.status).toBe('rolled_back');
  });

  it('记忆写失败不影响验证结论', async () => {
    const broken: MemoryPort = {
      ...createInMemoryMemory(),
      async saveFailure() {
        throw new Error('数据库只读');
      },
    };

    const h = harness({ metrics: [...TINY_GAIN], memory: broken });
    const { verification, kept } = await h.verify(BARELY_MOVED);

    expect(kept).toBe(false);
    expect(verification.status).toBe('rolled_back');
    expect(verification.gate.failedRules.length).toBeGreaterThan(0);
  });

  it('跨多个瓶颈的候选逐个 kind 各记一条（召回是按 kind 过滤的）', async () => {
    const memory = createInMemoryMemory();
    const store = createMemoryRunStore();
    const verifier = new Verifier({
      config: configFixture(),
      checkRunner: createFakeCheckRunner(true),
      git: recordingGit(),
      errorScan: createNullErrorScan(),
      store,
      logger: silent,
      memory,
      projectRoot: '/repo',
    });

    await verifier.verify({
      runId: 'run_1',
      candidate: candidateFixture({
        bottleneckKinds: ['OVERSIZED_IMAGE', 'UNCOMPRESSED_IMAGE'],
      }),
      route: 'asset-processor',
      baselineMetrics: BARELY_MOVED,
      baseRef: 'base-ref',
      startedAtIso: '2026-01-17T14:25:30.000Z',
      recollect: async () => [...TINY_GAIN],
    });

    const failures = await memory.listFailures('demo', 10);
    expect(failures.map((f) => f.bottleneckKind).sort()).toEqual([
      'OVERSIZED_IMAGE',
      'UNCOMPRESSED_IMAGE',
    ]);
    // 同一个候选的指纹一致，才能被 planner 按指纹整条拦下
    expect(new Set(failures.map((f) => f.candidateFingerprint)).size).toBe(1);
  });

  it('写进记忆后，planner 的「不再提案」判据能命中它', async () => {
    // 这一条把 M5 的写入端与 M3 的读取端接在一起：
    // 指纹算法若在两边长得不一样，记忆就永远是空的
    const memory = createInMemoryMemory();
    const h = harness({ metrics: [...TINY_GAIN], memory });
    await h.verify(BARELY_MOVED);

    const fingerprint = candidateFingerprint(candidateFixture());
    expect(await memory.hasFailedFailure(fingerprint, 'demo')).toBe(true);
    // 换一个项目就不该命中（经验按项目隔离）
    expect(await memory.hasFailedFailure(fingerprint, 'other')).toBe(false);
  });
});
