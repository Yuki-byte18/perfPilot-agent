import { describe, expect, it } from 'vitest';
import { Pipeline, type PipelineDeps } from './index.js';
import { Diagnoser } from '../diagnoser/index.js';
import { Planner } from '../planner/index.js';
import { DecisionEngine } from '../decision/index.js';
import { ExecutorOrchestrator } from '../executor/index.js';
import { Verifier } from '../verifier/index.js';
import {
  createFakeCheckRunner,
  createNullErrorScan,
  createNullGit,
  createNullLlm,
  createUnifiedDiff,
  type GitPort,
  type Metric,
} from '@yuki-byte18/shared';
import { createMemoryRunStore } from '../storage/memory-run-store.js';
import { createSilentLogger } from '../logger/index.js';
import { createReporters } from '../reporter/index.js';
import { createMemoryLogger } from '../logger/index.js';
import { fakeCollector, configFixture, metric, runFixture } from '../fixtures/index.js';
import { bundleArtifact, jsChunk } from '../fixtures/artifacts.js';

/**
 * core 自己的测试只覆盖到「采集端口」这一层。
 *
 * 真实 adapter 的解析逻辑由 adapters 包的单测覆盖，两边合起来的端到端验证在
 * cli 包 —— 那里才是 adapters 与 core 的合法汇合点
 * （core 不得 import 具体 adapter，硬约束 4，由 eslint 边界规则强制）。
 */
interface HarnessOptions {
  deps?: Partial<PipelineDeps>;
  preloadedRuns?: ReturnType<typeof runFixture>[];
}

function harness(options: HarnessOptions = {}) {
  const store = createMemoryRunStore();
  for (const run of options.preloadedRuns ?? []) {
    store.runs.set(run.id, run);
  }

  const logger = createMemoryLogger();
  const pipeline = new Pipeline({
    config: configFixture(),
    collectors: [],
    reporters: createReporters(['markdown', 'json']),
    store,
    logger,
    version: '0.1.0',
    clock: () => new Date('2026-01-17T14:25:30.000Z'),
    runId: 'run_20260117T142530_test01',
    // 默认注入诊断器与方案生成器，与生产路径一致；
    // 单独测「未注入」的降级行为时显式传 diagnoser: null / planner: null
    diagnoser: new Diagnoser({ config: configFixture(), logger }),
    planner: new Planner({ config: configFixture(), llm: createNullLlm(), memory: null, logger }),
    decider: new DecisionEngine({ config: configFixture(), logger }),
    ...options.deps,
  });

  return { pipeline, store, logger };
}

describe('Pipeline — 线性编排', () => {
  it('阶段顺序与 README §3 的链路一致', async () => {
    const { pipeline } = harness({
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    const stages = Object.fromEntries(run.stages.map((s) => [s.name, s]));

    // 已实现：全部 ok
    expect(stages.collect?.status).toBe('ok');
    expect(stages.compare?.status).toBe('ok');
    expect(stages.diagnose?.status).toBe('ok');
    expect(stages.plan?.status).toBe('ok');
    expect(stages.report?.status).toBe('ok');

    // 八段一个不少，顺序与 README §3 一致
    expect(run.stages.map((s) => s.name)).toEqual([
      'collect',
      'compare',
      'diagnose',
      'plan',
      'decide',
      'execute',
      'verify',
      'report',
    ]);

    // 这一轮没有 apply 裁决（LCP 3000ms 诊断不出瓶颈），因此执行/验证如实标 skipped，
    // 而不是"假装跑过"
    expect(stages.execute?.status).toBe('skipped');
    expect(stages.verify?.status).toBe('skipped');
    // 连"为什么没跑"都要能看懂：不能只写一句"未注入"
    expect(stages.verify?.note).toBeTruthy();
  });

  it('没有候选时 decide 标 skipped 并说明原因（不是「没注入」）', async () => {
    const { pipeline } = harness({
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })],
      },
    });

    // 这个 fixture 的 LCP 3000ms 不触发任何诊断规则 → 0 瓶颈 → 0 候选
    const { run } = await pipeline.run({ route: '/' });
    const stages = Object.fromEntries(run.stages.map((s) => [s.name, s]));

    expect(stages.decide?.status).toBe('skipped');
    expect(stages.decide?.note).toBe('没有候选可裁决');
  });

  it('有候选时 decide 阶段真正执行，并把决策落盘', async () => {
    const logger = createSilentLogger();

    // 用真实的构建产物触发 LARGE_JS_BUNDLE —— 诊断规则读的是**产物**而不是
    // JS_SIZE 指标，喂指标不会产出瓶颈。
    const collectors = [
      fakeCollector({
        id: 'bundle-analyzer',
        artifacts: [bundleArtifact({ files: [jsChunk('assets/index.js', 900_000)], modules: [] })],
      }),
    ];

    const forced = new Planner({
      config: configFixture(),
      llm: createNullLlm(),
      memory: null,
      logger,
      rules: [
        {
          id: 'test-rule',
          kind: 'LARGE_JS_BUNDLE',
          description: '测试用',
          plan: (bottleneck, ctx) => [
            {
              id: `cand_${bottleneck.id}`,
              runId: ctx.runId,
              bottleneckIds: [bottleneck.id],
              class: 'A',
              title: '拆分 chunk',
              description: '按路由拆分',
              origin: 'rule',
              ruleId: 'test-rule',
              promptVersion: null,
              changes: [{ type: 'config', file: 'vite.config.ts', key: 'k', before: null, after: 1 }],
              expectedGain: { JS_SIZE: 300_000 },
              confidence: 0.9,
              risk: 'low',
              effort: 'low',
              reversible: true,
              recalledFrom: [],
              bottleneckKinds: ['LARGE_JS_BUNDLE'],
            },
          ],
        },
      ],
    });

    const store = createMemoryRunStore();
    const pipeline = new Pipeline({
      config: configFixture(),
      collectors,
      reporters: createReporters(['markdown']),
      store,
      logger,
      version: '0.1.0',
      runId: 'run_decide',
      diagnoser: new Diagnoser({ config: configFixture(), logger }),
      planner: forced,
      decider: new DecisionEngine({ config: configFixture(), logger }),
    });

    const { run, decisions, candidates } = await pipeline.run({ route: '/' });
    const stages = Object.fromEntries(run.stages.map((s) => [s.name, s]));

    expect(candidates.length).toBeGreaterThan(0);
    expect(stages.decide?.status).toBe('ok');
    expect(stages.decide?.note).toContain('裁决');
    expect(decisions.length).toBe(candidates.length);

    // 通过端口 API 断言落盘，而不是摸实现内部结构 ——
    // 文件实现与内存实现的内部表示不同，端口才是契约。
    const saved = await store.loadJson('run_decide', 'decisions.json');
    expect(Array.isArray(saved)).toBe(true);
    expect((saved as unknown[]).length).toBe(decisions.length);
  });

  it('未注入方案生成器时 plan 阶段标 skipped，但诊断与报告照常', async () => {
    const { pipeline } = harness({
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })],
        planner: null,
      },
    });

    const { run, candidates } = await pipeline.run({ route: '/' });
    const stages = Object.fromEntries(run.stages.map((s) => [s.name, s]));

    expect(stages.plan?.status).toBe('skipped');
    expect(stages.plan?.note).toContain('未注入方案生成器');
    expect(stages.diagnose?.status).toBe('ok');
    expect(stages.report?.status).toBe('ok');
    expect(candidates).toEqual([]);
  });

  it('未注入诊断器时 diagnose 阶段标 skipped，但报告照常产出', async () => {
    const { pipeline } = harness({
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })],
        diagnoser: null,
      },
    });

    const { run, diagnosis } = await pipeline.run({ route: '/' });
    const stages = Object.fromEntries(run.stages.map((s) => [s.name, s]));

    expect(stages.diagnose?.status).toBe('skipped');
    expect(stages.diagnose?.note).toContain('未注入诊断器');
    expect(stages.report?.status).toBe('ok');
    expect(diagnosis).toBeNull();
  });

  it('阶段顺序与 README §3 的链路一致', async () => {
    const { pipeline } = harness({
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(run.stages.map((s) => s.name)).toEqual([
      'collect',
      'compare',
      'diagnose',
      'plan',
      'decide',
      'execute',
      'verify',
      'report',
    ]);
  });

  it('记录 run 元信息并保留告警', async () => {
    const { pipeline, store } = harness({
      deps: {
        collectors: [
          fakeCollector({ id: 'lighthouse', collectThrows: true }),
          fakeCollector({ id: 'bundle-analyzer', samples: [{ name: 'JS_SIZE', value: 300_000 }] }),
        ],
      },
    });

    const { run, saved, reportPaths } = await pipeline.run({ route: '/dashboard', device: 'desktop' });

    expect(run.id).toBe('run_20260117T142530_test01');
    expect(run.route).toBe('/dashboard');
    expect(run.device).toBe('desktop');
    expect(run.status).toBe('partial');
    expect(run.warnings).toHaveLength(1);
    expect(run.warnings[0]?.adapter).toBe('lighthouse');
    expect(reportPaths).toHaveLength(2);
    expect(store.runs.has(run.id)).toBe(true);
    expect(saved.dir).toContain(run.id);
  });
});

describe('Pipeline — 落盘', () => {
  it('run.json 与两份报告都写入 run 目录', async () => {
    const { pipeline, store } = harness({
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    const reports = store.reports.get(run.id) ?? [];

    expect(reports.map((r) => r.filename).sort()).toEqual(['report.json', 'report.md']);
    expect(reports.find((r) => r.format === 'markdown')?.content).toContain('# PerfPilot 性能报告');
    expect(JSON.parse(reports.find((r) => r.format === 'json')?.content ?? '{}')).toMatchObject({
      id: run.id,
      route: '/',
    });
  });

  it('原始产物落盘，供 M2 下钻取证', async () => {
    const { pipeline, store } = harness({
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(store.artifacts.get(run.id)).toHaveLength(1);
  });

  it('指标排序稳定，落盘内容可 diff', async () => {
    const { pipeline } = harness({
      deps: {
        collectors: [
          fakeCollector({
            id: 'lighthouse',
            samples: [
              { name: 'TBT', value: 300 },
              { name: 'LCP', value: 3000 },
              { name: 'CLS', value: 0.1 },
            ],
          }),
        ],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(run.metrics.map((m) => m.name)).toEqual(['CLS', 'LCP', 'TBT']);
  });
});

describe('Pipeline — 基线对比', () => {
  it('无历史时不编造基线，delta 全为 null', async () => {
    const { pipeline } = harness({
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(run.baseline).toBeNull();
    expect(run.deltas[0]?.scoreDelta).toBeNull();
    expect(run.stages.find((s) => s.name === 'compare')?.note).toContain('无可用基线');
  });

  it('命中最近一次成功运行作为基线，并算出回归', async () => {
    const { pipeline } = harness({
      preloadedRuns: [runFixture({ metrics: [metric('LCP', 2000)] })],
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 5000 }] })],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(run.baseline?.runId).toBe('run_20260117T142530_aaaaaa');
    expect(run.deltas[0]?.scoreDelta).toBeLessThan(0);
    expect(run.deltas[0]?.delta).toBe(-3000);
  });

  it('降级运行（status=partial）**可以**当基线（M7 修正）', async () => {
    /**
     * 这条在 M1 时的断言是 `baseline === null`，M7 接 CI 门禁时改掉了。
     *
     * 原规则「只有 success 的 run 能当基线」，顾虑是"拿降级采集的结果做基准
     * 会让下一次的改善变成测量误差"。但 `partial` 的含义只是**有来源没参与**
     * （项目没有 HAR / trace / web-vitals 上报），并不说明拿到的数字不可信 ——
     * 而绝大多数真实项目都有可选来源缺失，于是永远拿不到基线，
     * "这次改动让性能变差了吗"这个核心能力直接失效。
     *
     * 跨口径比较的风险由 `isComparable` 按**单个指标**兜住：测量来源变了
     * 就置空 `scoreDelta`。粒度更细，也不误伤。
     */
    const { pipeline } = harness({
      preloadedRuns: [runFixture({ status: 'partial', metrics: [metric('LCP', 2000)] })],
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 5000 }] })],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(run.baseline?.runId).toBe('run_20260117T142530_aaaaaa');
    // 2000ms → 5000ms，确实是回归
    expect(run.deltas[0]?.scoreDelta).toBeLessThan(0);
  });

  it('一个指标都没采到的运行不能当基线', async () => {
    const { pipeline } = harness({
      preloadedRuns: [runFixture({ status: 'failed', metrics: [] })],
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 5000 }] })],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(run.baseline).toBeNull();
  });

  it('不同路由的历史不会被拿来当基线', async () => {
    const { pipeline } = harness({
      preloadedRuns: [runFixture({ route: '/other', metrics: [metric('LCP', 2000)] })],
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 5000 }] })],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(run.baseline).toBeNull();
  });

  it('显式指定 runId 作为基线', async () => {
    const { pipeline } = harness({
      preloadedRuns: [
        runFixture({ id: 'run_old', metrics: [metric('LCP', 1000)] }),
        runFixture({ id: 'run_new', startedAt: '2026-01-17T15:00:00.000Z', metrics: [metric('LCP', 9000)] }),
      ],
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })],
      },
    });

    const { run } = await pipeline.run({ route: '/', baselineRef: 'run_old' });
    expect(run.baseline?.runId).toBe('run_old');
    expect(run.deltas[0]?.baseline).toBe(1000);
  });
});

describe('Pipeline — 失败路径', () => {
  it('全部 adapter 失败时抛出，不产出「零指标绿灯」', async () => {
    const { pipeline, store, logger } = harness({
      deps: {
        collectors: [
          fakeCollector({ id: 'lighthouse', collectThrows: true }),
          fakeCollector({ id: 'web-vitals', collectThrows: true }),
        ],
      },
    });

    await expect(pipeline.run({ route: '/' })).rejects.toThrow();
    expect(store.runs.size).toBe(0);
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true);
  });

  it('有样本但零指标时状态为 failed，而不是 success', async () => {
    const { pipeline } = harness({
      deps: { collectors: [fakeCollector({ id: 'lighthouse', samples: [] })] },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(run.status).toBe('failed');
  });

  it('报告渲染失败不影响 run 落盘，只记 warning', async () => {
    const { pipeline, store } = harness({
      deps: {
        collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })],
        reporters: [
          {
            format: 'markdown',
            render: () => {
              throw new Error('模板炸了');
            },
          },
        ],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(run.warnings.some((w) => w.code === 'REPORT_FAILED')).toBe(true);
    expect(run.stages.find((s) => s.name === 'report')?.status).toBe('failed');
    expect(store.runs.has(run.id)).toBe(true);
  });
});

describe('Pipeline — 告警级别与运行状态', () => {
  it('干净的运行没有任何告警，状态为 success', async () => {
    const { pipeline } = harness({
      deps: {
        collectors: [
          // LCP 的首选来源就是 lighthouse，正好命中，不产生来源告警
          fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] }),
        ],
      },
    });

    const { run } = await pipeline.run({ route: '/' });
    expect(run.warnings).toEqual([]);
    expect(run.status).toBe('success');
  });

  it('degraded 级告警把运行标为 partial，但它仍可作为基线', async () => {
    const first = harness({
      deps: {
        collectors: [
          fakeCollector({ id: 'lighthouse', collectThrows: true }),
          fakeCollector({ id: 'web-vitals', samples: [{ name: 'INP', value: 100 }] }),
        ],
      },
    });

    const { run } = await first.pipeline.run({ route: '/' });
    expect(run.status).toBe('partial');
    expect(run.warnings.every((w) => w.severity === 'degraded')).toBe(true);

    const second = new Pipeline({
      config: configFixture(),
      collectors: [
        fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] }),
        fakeCollector({ id: 'web-vitals', samples: [{ name: 'INP', value: 100 }] }),
      ],
      reporters: createReporters(['markdown']),
      store: first.store,
      logger: createSilentLogger(),
      version: '0.1.0',
      runId: 'run_after_partial',
    });

    const after = await second.run({ route: '/' });
    /**
     * 能当基线，但**拿它没有的那一项没法比**。
     *
     * 这一轮之前 Lighthouse 崩了，所以基线里只有 INP；本轮拿到了 LCP，
     * 而 LCP 在基线里不存在 → `scoreDelta` 为 null（不编造数字）。
     * INP 两边都有且同源 → 正常比较。
     *
     * 这就是把"能不能比"的判据从整次运行收到单个指标带来的效果：
     * 一次降级运行不会让后续全部失去基线，也不会拿缺失的指标去比。
     */
    expect(after.run.baseline?.runId).toBe(run.id);
    expect(after.run.deltas.find((d) => d.name === 'LCP')?.scoreDelta).toBeNull();
    expect(after.run.deltas.find((d) => d.name === 'INP')?.scoreDelta).not.toBeNull();
  });

  it('与基线测量来源不一致时不给差值，并记 METRIC_SOURCE_CHANGED（info 级）', async () => {
    const store = createMemoryRunStore();
    store.runs.set(
      'run_prev',
      runFixture({ id: 'run_prev', metrics: [metric('INP', 300, { source: 'lighthouse' })] }),
    );

    const pipeline = new Pipeline({
      config: configFixture(),
      collectors: [fakeCollector({ id: 'web-vitals', samples: [{ name: 'INP', value: 150 }] })],
      reporters: createReporters(['markdown']),
      store,
      logger: createSilentLogger(),
      version: '0.1.0',
      runId: 'run_source_changed',
    });

    const { run } = await pipeline.run({ route: '/' });
    const change = run.warnings.find((w) => w.code === 'METRIC_SOURCE_CHANGED');

    expect(change?.severity).toBe('info');
    expect(change?.message).toContain('lighthouse');
    expect(change?.message).toContain('web-vitals');
    // 150ms 看着比 300ms 快，但那是换了测量工具 —— 必须拒绝给出这个结论
    expect(run.deltas.find((d) => d.name === 'INP')?.scoreDelta).toBeNull();
    expect(run.status).toBe('success');
  });
});

describe('Pipeline — 端到端（fixture 驱动，零网络）', () => {
  it('三个 adapter 的产物经仲裁、打分、对比后产出可读报告', async () => {
    const store = createMemoryRunStore();
    store.runs.set(
      'run_prev',
      runFixture({
        id: 'run_prev',
        metrics: [
          metric('LCP', 2900),
          metric('CLS', 0.15),
          metric('JS_SIZE', 480_000, { source: 'bundle-analyzer', unit: 'byte' }),
        ],
      }),
    );

    // 只覆盖采集边界：core 不 import 具体 adapter（硬约束 4），
    // 真实 adapter 的解析逻辑由 adapters 包自己的单测覆盖，
    // 两边合起来由 cli 包的 e2e 测试端到端验证。
    const collectors = [
      fakeCollector({
        id: 'lighthouse',
        samples: [
          { name: 'LCP', value: 3800 },
          { name: 'CLS', value: 0.18 },
          { name: 'TBT', value: 480 },
        ],
      }),
      fakeCollector({ id: 'web-vitals', samples: [{ name: 'INP', value: 240 }] }),
      fakeCollector({ id: 'bundle-analyzer', samples: [{ name: 'JS_SIZE', value: 620_000 }] }),
    ];

    const pipeline = new Pipeline({
      config: configFixture(),
      collectors,
      reporters: createReporters(['markdown', 'json']),
      store,
      logger: createSilentLogger(),
      version: '0.1.0',
      clock: () => new Date('2026-01-17T14:25:30.000Z'),
      runId: 'run_e2e',
    });

    const { run, reportPaths } = await pipeline.run({ route: '/' });
    const markdown =
      (store.reports.get(run.id) ?? []).find((r) => r.format === 'markdown')?.content ?? '';

    const byName = Object.fromEntries(run.metrics.map((m) => [m.name, m]));
    expect(run.metrics).toHaveLength(5);
    expect(byName.INP?.source).toBe('web-vitals');
    expect(byName.JS_SIZE?.source).toBe('bundle-analyzer');

    // LCP 从 2900 → 3800，回归
    expect(run.deltas.find((d) => d.name === 'LCP')?.scoreDelta).toBeLessThan(0);
    expect(run.baseline?.runId).toBe('run_prev');
    // INP 无基线 → 不编造数字
    expect(run.deltas.find((d) => d.name === 'INP')?.scoreDelta).toBeNull();

    expect(markdown).toContain('# PerfPilot 性能报告 — demo');
    expect(markdown).toContain('## ⚠️ 回归指标');
    expect(markdown).toContain('`web-vitals`');
    expect(reportPaths).toHaveLength(2);
    expect(run.warnings).toEqual([]);
    expect(run.status).toBe('success');
  });
});

// ─────────────────────────────────────────────────────────────────────
// M5：run() 里的 execute / verify 两段
// ─────────────────────────────────────────────────────────────────────

/**
 * 这一组用**真实的** `ExecutorOrchestrator` 与 `Verifier`，只把 IO 换成替身
 * （内存文件系统、假 git、假检查运行器）。因此它验的是流水线里真实的
 * 应用 → 验证 → 保留/回滚顺序，而不是一条被 mock 掉的调用链。
 *
 * 真实 git 仓库上的闭环在 cli 包（`m5-loop.test.ts`）—— 那里才能断言
 * "工作区真的干净"，因为 core 不允许 import 具体 adapter。
 */
interface M5HarnessOptions {
  /** recollect 返回的「改动后」指标；null 表示不注入重采集实现 */
  after?: Metric[] | null;
  /** 是否注入 git */
  withGit?: boolean;
  /** 工作区是否干净 */
  clean?: boolean;
  /** 注入执行编排（默认注入，用内存文件系统 + config-editor 的真实实现） */
  withExecutor?: boolean;
}

/** 一份够用的「配置改动」候选：目标是 JSON 文件，config-editor 能稳定产出补丁 */
function m5Harness(options: M5HarnessOptions = {}) {
  const logger = createSilentLogger();
  const store = createMemoryRunStore();
  const files = new Map<string, string>([
    ['tsconfig.json', `${JSON.stringify({ compilerOptions: { target: 'ES2019' } }, null, 2)}\n`],
  ]);

  const calls: string[] = [];

  const git: GitPort = {
    ...createNullGit(),
    async isClean() {
      calls.push('isClean');
      return options.clean ?? true;
    },
    async currentRef() {
      calls.push('currentRef');
      return 'ref-base';
    },
    async applyPatch() {
      calls.push('applyPatch');
      return true;
    },
    async commit() {
      calls.push('commit');
      return 'ref-kept';
    },
    async resetHard(ref: string) {
      calls.push(`resetHard:${ref}`);
    },
  };

  // 真实执行编排：注册表是假的，执行器是 config-editor 的真实实现
  const executor =
    options.withExecutor === false
      ? null
      : new ExecutorOrchestrator({
          registry: {
            all: () => [],
            forCandidate: () => ({
              route: 'config-editor',
              canHandle: () => true,
              execute: async (candidate) => {
                const before = files.get('tsconfig.json') ?? '';
                const after = `${JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 2)}\n`;
                const patch = createUnifiedDiff('tsconfig.json', before, after);
                return {
                  candidateId: candidate.id,
                  route: 'config-editor',
                  patch: patch?.patch ?? '',
                  applied: false,
                  files: ['tsconfig.json'],
                  summary: '改动 1 个文件',
                };
              },
            }),
          },
          store,
          logger,
          createContext: () => ({
            projectRoot: '/repo',
            readFile: async (path) => files.get(path) ?? null,
            readBinary: async () => null,
            writeFile: async (path, content) => {
              files.set(path, String(content));
            },
          }),
        });

  const verifier = new Verifier({
    config: configFixture(),
    checkRunner: createFakeCheckRunner(true),
    git,
    errorScan: createNullErrorScan(),
    store,
    logger,
    projectRoot: '/repo',
  });

  const pipeline = new Pipeline({
    config: configFixture(),
    // 和「有候选时 decide 阶段真正执行」同一个配方：诊断规则读的是**构建产物**，
    // 只有指标是产不出瓶颈的（因此也产不出候选）
    collectors: [
      fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] }),
      fakeCollector({
        id: 'bundle-analyzer',
        artifacts: [bundleArtifact({ files: [jsChunk('assets/index.js', 900_000)], modules: [] })],
      }),
    ],
    reporters: createReporters(['markdown']),
    store,
    logger,
    version: '0.1.0',
    clock: () => new Date('2026-01-17T14:25:30.000Z'),
    runId: 'run_m5',
    diagnoser: new Diagnoser({ config: configFixture(), logger }),
    planner: forcedConfigPlanner(),
    decider: new DecisionEngine({ config: configFixture(), logger }),
    executor,
    verifier,
    ...(options.withGit === false ? {} : { git }),
    ...(options.after === null
      ? {}
      : { recollect: async () => options.after ?? [metric('LCP', 2000)] }),
  });

  return { pipeline, store, calls, files };
}

/** 逼出一个 A 类「改配置」候选：utility 远高于 apply_score，因此必然被自动执行 */
function forcedConfigPlanner(): Planner {
  return new Planner({
    config: configFixture(),
    llm: createNullLlm(),
    memory: null,
    logger: createSilentLogger(),
    rules: [
      {
        id: 'test-config-rule',
        kind: 'LARGE_JS_BUNDLE',
        description: '测试用：改编译目标',
        plan: (bottleneck, ctx) => [
          {
            id: `cand_${bottleneck.id}`,
            runId: ctx.runId,
            bottleneckIds: [bottleneck.id],
            class: 'A',
            title: '把编译目标提升到 ES2022',
            description: '减少降级语法转换',
            origin: 'rule',
            ruleId: 'test-config-rule',
            promptVersion: null,
            changes: [
              {
                type: 'config',
                file: 'tsconfig.json',
                key: 'compilerOptions.target',
                before: 'ES2019',
                after: 'ES2022',
              },
            ],
            // 收益给足，保证 utility ≥ apply_score（30）
            expectedGain: { LCP: 2000, JS_SIZE: 200_000 },
            confidence: 0.95,
            risk: 'low',
            effort: 'low',
            reversible: true,
            recalledFrom: [],
            bottleneckKinds: ['LARGE_JS_BUNDLE'],
          },
        ],
      },
    ],
  });
}

describe('M5 — run() 的执行与验证两段', () => {
  it('apply 裁决 → 产出补丁、应用、验证通过、提交保留', async () => {
    const { pipeline, store, calls } = m5Harness({ after: [metric('LCP', 2000)] });
    const outcome = await pipeline.run({ route: '/' });
    const stages = Object.fromEntries(outcome.run.stages.map((s) => [s.name, s]));

    expect(outcome.decisions[0]?.verdict).toBe('apply');
    expect(stages.execute?.status).toBe('ok');
    expect(stages.verify?.status).toBe('ok');

    expect(outcome.executions).toHaveLength(1);
    expect(outcome.executions[0]?.patch).toContain('tsconfig.json');
    // 执行器只产出补丁：applied 必须是 false，应用发生在验证阶段
    expect(outcome.executions[0]?.applied).toBe(false);
    expect(calls).toContain('applyPatch');

    expect(outcome.verifications).toHaveLength(1);
    expect(outcome.verifications[0]?.status).toBe('kept');
    expect(calls).toContain('commit');
    expect(calls.some((c) => c.startsWith('resetHard'))).toBe(false);

    // 补丁落盘（报告与人工确认都靠它）：内存实现是 candidateId → patch 的映射
    const candidateId = outcome.candidates[0]?.id ?? '';
    expect(store.patches.get('run_m5')?.[candidateId]).toContain('tsconfig.json');

    const markdown = (store.reports.get('run_m5') ?? [])[0]?.content ?? '';
    expect(markdown).toContain('## 🔧 执行与验证');
    expect(markdown).toContain('kept');
  });

  it('指标没达标 → 回滚到基线 ref，报告里写明原因', async () => {
    // 3000ms → 3100ms：略微变慢
    const { pipeline, calls, store } = m5Harness({ after: [metric('LCP', 3100)] });
    const outcome = await pipeline.run({ route: '/' });

    expect(outcome.verifications[0]?.status).toBe('rolled_back');
    expect(calls).toContain('resetHard:ref-base');
    expect(calls).not.toContain('commit');

    const markdown = (store.reports.get('run_m5') ?? [])[0]?.content ?? '';
    expect(markdown).toContain('rolled_back');
    expect(markdown).toContain('min_gain');
  });

  it('未注入 git → 一个补丁都不应用（无法保证回滚就不改）', async () => {
    const { pipeline, calls } = m5Harness({ withGit: false });
    const outcome = await pipeline.run({ route: '/' });
    const stages = Object.fromEntries(outcome.run.stages.map((s) => [s.name, s]));

    // 补丁照常产出
    expect(outcome.executions).toHaveLength(1);
    // 但没应用、没验证
    expect(calls).not.toContain('applyPatch');
    expect(outcome.verifications).toEqual([]);
    expect(stages.verify?.status).toBe('skipped');
    expect(stages.verify?.note).toContain('git');
  });

  it('没有重采集实现 → 同样不应用（拿不到改动后的指标就无法验证）', async () => {
    const { pipeline, calls } = m5Harness({ after: null });
    const outcome = await pipeline.run({ route: '/' });
    const stages = Object.fromEntries(outcome.run.stages.map((s) => [s.name, s]));

    expect(calls).not.toContain('applyPatch');
    expect(outcome.verifications).toEqual([]);
    expect(stages.verify?.note).toContain('重采集');
  });

  it('工作区不干净 → 拒绝应用，并给出降级告警', async () => {
    const { pipeline, calls } = m5Harness({ clean: false });
    const outcome = await pipeline.run({ route: '/' });

    expect(calls).not.toContain('applyPatch');
    expect(outcome.verifications).toEqual([]);
    expect(outcome.run.warnings.map((w) => w.code)).toContain('WORKTREE_DIRTY');
    // 内容变动使状态降级为 partial，而不是悄悄当作成功
    expect(outcome.run.status).toBe('partial');
  });
});
