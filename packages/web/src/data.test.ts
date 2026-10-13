import { describe, expect, it } from 'vitest';
import type { Candidate, Decision, Metric, MetricSeries, Verification } from '@yuki-byte18/shared';
import {
  buildCollection,
  buildHeadline,
  buildMetricRows,
  buildOverview,
  buildStages,
  buildTimeline,
  formatMetric,
  groupRuns,
  toTrendViews,
} from './data.js';
import type { RunDetail } from './api.js';

/**
 * 报告页的视图模型（M8 验收 1）。
 *
 * 这一组测的是**纯函数**，不是组件渲染：时间线顺序错乱、半截记录被吞掉、
 * 概览数字算错 —— 这些才是会出错的地方，而它们全都在这里。
 *
 * **趋势的聚合不在这里**（那是 `core/trends` 的职责，由服务端算好）：
 * 这一层只做展示需要的派生，比如"变化是改善还是劣化"。
 */

const metric = (name: Metric['name'], value: number, source = 'lighthouse'): Metric => ({
  name,
  value,
  unit: 'ms',
  rating: value > 4000 ? 'poor' : value > 2500 ? 'needs-improvement' : 'good',
  score: value > 4000 ? 30 : value > 2500 ? 70 : 100,
  route: '/',
  device: 'mobile',
  source: source as Metric['source'],
  collectedAt: '2026-01-17T14:25:30.000Z',
});

const candidate = (id: string, overrides: Partial<Candidate> = {}): Candidate => ({
  id,
  runId: 'run_1',
  bottleneckIds: ['bn_1'],
  class: 'A',
  title: `方案 ${id}`,
  description: '说明',
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

function detail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    run: {
      schemaVersion: 1,
      id: 'run_1',
      project: 'demo',
      route: '/',
      device: 'mobile',
      url: 'https://staging.example.com',
      status: 'success',
      startedAt: '2026-01-17T14:25:30.000Z',
      finishedAt: '2026-01-17T14:25:31.000Z',
      durationMs: 1000,
      perfpilotVersion: '0.1.0',
      stages: [],
      metrics: [metric('LCP', 2800)],
      baseline: null,
      deltas: [],
      warnings: [],
      artifacts: [],
      llmCostUsd: 0,
    },
    diagnosis: null,
    candidates: [],
    decisions: [],
    executions: [],
    verifications: [],
    ...overrides,
  };
}

const series = (overrides: Partial<MetricSeries> = {}): MetricSeries => ({
  name: 'LCP',
  points: [
    { runId: 'run_a', startedAt: '2026-01-17T10:00:00.000Z', value: 3500, score: 67, rating: 'needs-improvement', source: 'lighthouse' },
    { runId: 'run_b', startedAt: '2026-01-18T10:00:00.000Z', value: 2000, score: 100, rating: 'good', source: 'lighthouse' },
  ],
  change: -1500,
  changePercent: -42.86,
  sourceChanged: false,
  enoughData: true,
  ...overrides,
});

describe('M8 验收 1 — 趋势的展示派生', () => {
  it('数值变小对性能指标是改善（方向搞反会把劣化写成改善）', () => {
    const [improved] = toTrendViews([series({ change: -1500 })]);
    expect(improved?.improved).toBe(true);

    const [worse] = toTrendViews([series({ change: 1500 })]);
    expect(worse?.improved).toBe(false);
  });

  it('算不出变化量时方向也是 null，不猜', () => {
    const [unknown] = toTrendViews([series({ change: null, enoughData: false })]);
    expect(unknown?.improved).toBeNull();
  });

  it('来源变化的信息原样透传给视图', () => {
    const [view] = toTrendViews([series({ change: null, sourceChanged: true })]);
    expect(view?.sourceChanged).toBe(true);
  });

  it('排序与数据点原样保留（聚合是 core 的事，这一层不该重排）', () => {
    const views = toTrendViews([series({ name: 'LCP' }), series({ name: 'TBT' })]);
    expect(views.map((v) => v.name)).toEqual(['LCP', 'TBT']);
    expect(views[0]?.points).toHaveLength(2);
  });
});

describe('M8 验收 1 — 时间线（候选 → 决策 → 执行 → 验证）', () => {
  const baseDecision: Decision = {
    id: 'dec_1',
    runId: 'run_1',
    candidateId: 'cand_1',
    verdict: 'apply',
    route: 'config-editor',
    score: 42,
    utility: { expectedGain: 55, confidence: 0.9, cost: 4, risk: 2 },
    riskLevel: 'low',
    reasons: ['规则库命中'],
    thresholds: { minGain: 5, maxRegression: 2, maxNewErrors: 0, applyScore: 30, confirmScore: 10 },
    decidedAt: '2026-01-17T14:25:30.000Z',
  };

  it('验证通过 → kept，带上实际收益', () => {
    const verification: Verification = {
      id: 'ver_1',
      runId: 'run_1',
      candidateId: 'cand_1',
      status: 'kept',
      route: 'config-editor',
      checks: [],
      deltas: [],
      gain: { LCP: -1500 },
      regressions: [],
      newErrors: [],
      gate: { passed: true, gainOk: true, regressionOk: true, errorsOk: true, failedRules: [] },
      patchRef: null,
      git: { baseRef: 'ref_base_12345678', resultRef: 'ref_kept_87654321', reverted: false },
      decidedBy: 'auto',
      verifiedAt: '2026-01-17T14:25:35.000Z',
    };

    const entry = buildTimeline(
      detail({
        candidates: [candidate('cand_1')],
        decisions: [baseDecision],
        verifications: [verification],
      }),
    )[0];

    expect(entry?.status).toBe('kept');
    expect(entry?.gain).toEqual({ LCP: -1500 });
    expect(entry?.note).toContain('已保留');
  });

  it('回滚 → rolled_back，并把未通过原因带出来', () => {
    const verification: Verification = {
      id: 'ver_1',
      runId: 'run_1',
      candidateId: 'cand_1',
      status: 'rolled_back',
      route: 'config-editor',
      checks: [],
      deltas: [],
      gain: {},
      regressions: [],
      newErrors: [],
      gate: {
        passed: false,
        gainOk: false,
        regressionOk: true,
        errorsOk: true,
        failedRules: ['收益 0.4 < min_gain 5'],
      },
      patchRef: null,
      git: { baseRef: 'ref_base_12345678', resultRef: null, reverted: true },
      decidedBy: 'auto',
      verifiedAt: '2026-01-17T14:25:35.000Z',
    };

    const entry = buildTimeline(
      detail({
        candidates: [candidate('cand_1')],
        decisions: [baseDecision],
        verifications: [verification],
      }),
    )[0];

    expect(entry?.status).toBe('rolled_back');
    // 只显示"回滚了"是不够的，必须说清差在哪
    expect(entry?.failedRules).toEqual(['收益 0.4 < min_gain 5']);
    expect(entry?.note).toContain('已回滚');
  });

  it('以候选为主体：没有决策的候选也会出现在时间线上', () => {
    // 方案阶段之后链路中断 —— 这类"半截记录"最容易被实现漏掉，而它正是要给人看的
    const entries = buildTimeline(detail({ candidates: [candidate('cand_orphan')] }));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('pending');
    expect(entries[0]?.note).toContain('尚未裁决');
  });

  it('B 类已产出补丁 → 待人工确认；未产出 → 仅建议', () => {
    const confirmDecision: Decision = { ...baseDecision, verdict: 'confirm' };

    const withPatch = buildTimeline(
      detail({
        candidates: [candidate('cand_1')],
        decisions: [confirmDecision],
        executions: [
          {
            candidateId: 'cand_1',
            route: 'config-editor',
            patch: 'diff',
            applied: false,
            files: ['a.json'],
            summary: '',
          },
        ],
      }),
    )[0];

    const withoutPatch = buildTimeline(
      detail({ candidates: [candidate('cand_1')], decisions: [confirmDecision] }),
    )[0];

    expect(withPatch?.note).toContain('等待人工确认');
    expect(withoutPatch?.status).toBe('suggested');
  });

  it('被拒绝的候选带上理由（"为什么没做"和"做了什么"一样重要）', () => {
    const rejected: Decision = { ...baseDecision, verdict: 'reject', reasons: ['收益低于阈值'] };

    const entry = buildTimeline(
      detail({ candidates: [candidate('cand_1')], decisions: [rejected] }),
    )[0];

    expect(entry?.status).toBe('rejected');
    expect(entry?.note).toContain('收益低于阈值');
  });
});

describe('M8 验收 1 — 概览数字', () => {
  it('分别统计回归 / 改善 / 保留 / 回滚 / 待确认', () => {
    const base = detail();
    const overview = buildOverview({
      ...base,
      run: {
        ...base.run,
        deltas: [
          {
            name: 'LCP',
            baseline: 2000,
            current: 3500,
            delta: -1500,
            deltaPercent: -75,
            baselineScore: 100,
            currentScore: 67,
            scoreDelta: -33,
          },
          {
            name: 'CLS',
            baseline: 0.2,
            current: 0.05,
            delta: 0.15,
            deltaPercent: 75,
            baselineScore: 60,
            currentScore: 100,
            scoreDelta: 40,
          },
          // 没有基线 → 不可比，不计入任何一边
          {
            name: 'INP',
            baseline: null,
            current: 150,
            delta: null,
            deltaPercent: null,
            baselineScore: null,
            currentScore: 100,
            scoreDelta: null,
          },
        ],
      },
      diagnosis: {
        id: 'diag_1',
        runId: 'run_1',
        project: 'demo',
        route: '/',
        device: 'mobile',
        baselineRef: null,
        metrics: [],
        baselineMetrics: [],
        deltas: [],
        regressions: [],
        bottlenecks: [
          {
            id: 'bn_1',
            runId: 'run_1',
            kind: 'OVERSIZED_IMAGE',
            title: '图片过大',
            severity: 70,
            impact: { IMAGE_SIZE: 900_000 },
            attribution: {
              level: 'resource',
              url: 'https://x.example.com/a.png',
              size: 900_000,
              contentType: 'image/png',
            },
            evidence: [],
            confidence: 0.9,
            occurrences: 1,
            source: 'rule',
          },
        ],
        summary: '',
        ruleSetVersion: 'm2.1.0',
        createdAt: '2026-01-17T14:25:30.000Z',
      },
    });

    expect(overview.regressionCount).toBe(1);
    expect(overview.improvedCount).toBe(1);
    expect(overview.bottleneckCount).toBe(1);
    expect(overview.keptCount).toBe(0);
  });
});

/**
 * 第二轮（"看不出提升了啥"）新增的展示层逻辑。
 *
 * 这一组守的是**读报告的人会不会被误导**：指标从表里消失、"没测到"被写成
 * "没问题"、劣化被排到看不见的地方、三个路由的历史混成一张图。
 * 它们都不会抛异常，只会让报告说得不清楚 —— 而不清楚就等于没做。
 */
describe('报告页 — 指标对比与结论', () => {
  const delta = (
    name: Metric['name'],
    baseline: number,
    current: number,
    scoreDelta: number,
  ): RunDetail['run']['deltas'][number] => ({
    name,
    baseline,
    current,
    delta: current - baseline,
    deltaPercent: baseline === 0 ? null : ((current - baseline) / baseline) * 100,
    baselineScore: 70,
    currentScore: 70 + scoreDelta,
    scoreDelta,
  });

  it('指标行取并集：基线里有、这次没测到的指标同样要列出来', () => {
    const rows = buildMetricRows({
      ...detail().run,
      metrics: [metric('LCP', 2800)],
      // INP 只在基线里 —— 上一轮测到了，这一轮没有
      baseline: {
        ref: 'last-run',
        runId: 'run_prev',
        metrics: [metric('INP', 150)],
      },
      deltas: [],
    });

    expect(rows.map((r) => r.name).sort()).toEqual(['INP', 'LCP']);
    // 没有本次值就是不可比，而不是"持平"
    expect(rows.find((r) => r.name === 'INP')?.change).toBe('unknown');
    expect(rows.find((r) => r.name === 'INP')?.current).toBeNull();
  });

  it('劣化的排在改善之前：报告第一屏应该是最该看的东西', () => {
    const rows = buildMetricRows({
      ...detail().run,
      metrics: [metric('LCP', 2800), metric('CLS', 0.05)],
      baseline: null,
      deltas: [delta('LCP', 2000, 3500, -30), delta('CLS', 0.3, 0.05, 40)],
    });

    expect(rows[0]?.name).toBe('LCP');
    expect(rows[0]?.change).toBe('regressed');
    expect(rows[1]?.change).toBe('improved');
  });

  it('方向只看分数变化：数值变小但分数变低时，判为劣化', () => {
    // 分数是唯一权威：数值方向与好坏在个别指标上可能不同（这条防的是判两遍）
    const rows = buildMetricRows({
      ...detail().run,
      metrics: [metric('LCP', 2000)],
      baseline: null,
      deltas: [delta('LCP', 3500, 2000, -30)],
    });

    expect(rows[0]?.change).toBe('regressed');
  });

  it('一条指标都没采到时，结论说"没测到"而不是"没问题"', () => {
    const headline = buildHeadline(detail({ run: { ...detail().run, metrics: [], deltas: [] } }));

    expect(headline.tone).toBe('bad');
    expect(headline.text).toContain('没采到');
    expect(headline.text).toContain('不代表页面没问题');
  });

  it('有回滚时结论指向回滚，并说明工作区是干净的', () => {
    const base = detail();
    const headline = buildHeadline({
      ...base,
      verifications: [
        {
          id: 'ver_1',
          runId: 'run_1',
          candidateId: 'cand_1',
          status: 'rolled_back',
          route: 'config-editor',
          checks: [],
          deltas: [],
          gain: {},
          regressions: [],
          newErrors: [],
          gate: { passed: false, gainOk: false, regressionOk: true, errorsOk: true, failedRules: [] },
          patchRef: null,
          git: null,
          decidedBy: 'auto',
          verifiedAt: '2026-01-17T14:25:35.000Z',
        },
      ],
    });

    expect(headline.tone).toBe('warn');
    expect(headline.text).toContain('已自动回滚');
  });

  it('来源状态从数据推导：不可用的来源必须出现（否则"指标有 11 项"会掩盖来源缺失）', () => {
    const collection = buildCollection(
      detail({
        run: {
          ...detail().run,
          metrics: [metric('CSS_SIZE', 7000, 'bundle-analyzer')],
          artifacts: [],
          warnings: [
            {
              adapter: 'lighthouse',
              code: 'ADAPTER_UNAVAILABLE',
              severity: 'degraded',
              message: 'lighthouse 不可用',
            },
          ],
        },
      }),
    );

    const byId = new Map(collection.sources.map((s) => [s.adapter, s]));
    // 不可用的来源：只出现在告警里，仍然必须列出来
    expect(byId.get('lighthouse')?.state).toBe('unavailable');
    // 有指标的来源：从 metric.source 推导，不依赖告警
    expect(byId.get('bundle-analyzer')?.state).toBe('ok');
    expect(byId.get('bundle-analyzer')?.metricCount).toBe(1);
    expect(collection.unavailableSources).toBe(1);
    expect(collection.degraded).toHaveLength(1);
  });

  it('阶段备注原样带出：skipped 的 verify 不能被写成"没问题"', () => {
    const stages = buildStages({
      ...detail().run,
      stages: [
        { name: 'collect', status: 'ok', durationMs: 1200, note: '2 个来源成功' },
        { name: 'verify', status: 'skipped', durationMs: 0, note: '工作区不干净，拒绝自动应用改动' },
      ],
    });

    expect(stages.map((s) => s.label)).toEqual(['采集', '验证']);
    expect(stages[1]?.status).toBe('skipped');
    expect(stages[1]?.note).toContain('工作区不干净');
  });

  it('run 列表按路由+设备分组，组内按时间倒序', () => {
    const summary = (
      id: string,
      route: string,
      startedAt: string,
    ): Parameters<typeof groupRuns>[0][number] => ({
      id,
      project: 'demo',
      route,
      device: 'mobile',
      status: 'success',
      startedAt,
      metricCount: 3,
    });

    const groups = groupRuns([
      summary('a', '/', '2026-01-17T10:00:00.000Z'),
      summary('b', '/', '2026-01-18T10:00:00.000Z'),
      summary('c', '/dashboard', '2026-01-17T12:00:00.000Z'),
    ]);

    // 组按"最近一次"排序：/ 组更新，因此在前
    expect(groups.map((g) => g.route)).toEqual(['/', '/dashboard']);
    expect(groups[0]?.runs.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('按单位格式化：ms/s、B/KB/MB 各用各的刻度', () => {
    expect(formatMetric(880, 'ms')).toBe('880 ms');
    expect(formatMetric(2800, 'ms')).toBe('2.80 s');
    expect(formatMetric(693872, 'byte')).toBe('677.6 KB');
    expect(formatMetric(7_265_129, 'byte')).toBe('6.93 MB');
    expect(formatMetric(0.08, 'score')).toBe('0.080');
    expect(formatMetric(null, 'ms')).toBe('—');
  });
});
